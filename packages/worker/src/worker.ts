import os from 'node:os';

import {
  acquireJobForDelivery,
  completeJobDelivery,
  completeCancellation,
  failJobDelivery,
  registerWorker,
  renewJobDeliveryLease,
  startJobAttempt,
  updateWorkerHeartbeat,
  updateWorkerStatus,
} from '@taskflow/database';
import { createWorkerLogger } from '@taskflow/logger';
import {
  acknowledgeMessage,
  claimStaleMessages,
  consumeJobs,
  createConsumerGroup,
  quarantineEntry,
  type ConsumedMessage,
} from '@taskflow/queue';
import {
  JobStatus,
  WorkerStatus,
  type Job,
  type JobHandlerContext,
} from '@taskflow/types';

import { CancellationError, CancellationToken } from './cancellation-token';
import { HandlerRegistry } from './handler-registry';
import { createWorkerConfig, type WorkerConfig } from './worker-config';

export type WorkerState =
  'IDLE' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'STOPPED';

interface ActiveJob {
  jobId: string;
  messageId: string;
  leaseId: string;
  cancellationToken: CancellationToken;
  leaseRenewalTimer?: NodeJS.Timeout;
  stopRenewal?: () => void;
}

export interface WorkerStats {
  totalProcessed: number;
  totalSucceeded: number;
  totalFailed: number;
  currentLoad: number;
  averageDurationMs: number;
}

/**
 * The sole TaskFlow worker runtime. PostgreSQL owns job state and Redis owns
 * delivery. A Redis entry is acknowledged only after PostgreSQL reports a
 * durable terminal state.
 */
export class Worker {
  private readonly config: WorkerConfig;
  private readonly handlers: HandlerRegistry;
  private readonly logger: ReturnType<typeof createWorkerLogger>;
  private readonly activeJobs = new Map<string, ActiveJob>();
  private readonly activeMessages = new Set<string>();
  private readonly handlerPromises = new Set<Promise<void>>();
  private readonly unresolvedReclaims = new Map<string, number>();
  private state: WorkerState = 'IDLE';
  private heartbeatTimer?: NodeJS.Timeout;
  private pollingPromise?: Promise<void>;
  private stats: WorkerStats = {
    totalProcessed: 0,
    totalSucceeded: 0,
    totalFailed: 0,
    currentLoad: 0,
    averageDurationMs: 0,
  };

  constructor(config: Partial<WorkerConfig>, handlers: HandlerRegistry) {
    this.config = createWorkerConfig(config);
    this.handlers = handlers;
    this.logger = createWorkerLogger(this.config.workerId);
  }

  async start(): Promise<void> {
    if (this.state !== 'IDLE') {
      throw new Error(`Cannot start worker in ${this.state} state`);
    }
    this.state = 'STARTING';

    try {
      await registerWorker({
        id: this.config.workerId,
        workerName: this.config.workerName,
        hostname: os.hostname(),
        processId: process.pid,
        concurrency: this.config.concurrency,
        queues: this.config.queues,
        status: 'ACTIVE',
        currentJobCount: 0,
        lastHeartbeatAt: new Date(),
        metadata: { nodeVersion: process.version },
      });

      for (const queue of this.config.queues) {
        await createConsumerGroup(queue);
      }

      this.state = 'RUNNING';
      this.startHeartbeat();
      this.pollingPromise = this.pollLoop();
      this.logger.info('Worker started', {
        queues: this.config.queues,
        concurrency: this.config.concurrency,
      });
    } catch (error) {
      this.state = 'STOPPED';
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'STOPPED' || this.state === 'IDLE') return;
    this.state = 'STOPPING';
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    // Set PostgreSQL status to STOPPING so schedulers and monitors detect graceful shutdown
    await updateWorkerStatus(this.config.workerId, WorkerStatus.STOPPING).catch(
      () => null
    );

    // Cancel all active cancellation tokens and stop lease renewals
    for (const activeJob of this.activeJobs.values()) {
      activeJob.cancellationToken.cancel();
      this.stopLeaseRenewal(activeJob);
    }

    // Wait for in-flight handler promises or shutdown timeout
    const deadline = sleep(this.config.shutdownTimeoutMs);
    const handlersSettled = Promise.allSettled(Array.from(this.handlerPromises));
    await Promise.race([handlersSettled, deadline]);

    await this.pollingPromise?.catch(() => undefined);
    await updateWorkerStatus(this.config.workerId, WorkerStatus.STOPPED).catch(
      () => null
    );
    this.state = 'STOPPED';
  }

  private startHeartbeat(): void {
    const scheduleNext = () => {
      if (this.state !== 'RUNNING') return;
      this.heartbeatTimer = setTimeout(async () => {
        try {
          await updateWorkerHeartbeat(this.config.workerId, {
            currentJobCount: this.activeJobs.size,
            totalJobsProcessed: this.stats.totalProcessed,
            totalJobsSucceeded: this.stats.totalSucceeded,
            totalJobsFailed: this.stats.totalFailed,
          });
        } catch (error) {
          this.logger.error('Worker heartbeat failed', { error });
        } finally {
          scheduleNext();
        }
      }, this.config.heartbeatIntervalMs);
    };

    void Promise.resolve(
      updateWorkerHeartbeat(this.config.workerId, {
        currentJobCount: this.activeJobs.size,
        totalJobsProcessed: this.stats.totalProcessed,
        totalJobsSucceeded: this.stats.totalSucceeded,
        totalJobsFailed: this.stats.totalFailed,
      })
    )
      .catch((error) => this.logger.error('Worker initial heartbeat failed', { error }))
      .finally(scheduleNext);
  }

  private async pollLoop(): Promise<void> {
    while (this.state === 'RUNNING') {
      try {
        await this.pollOnce();
      } catch (error) {
        this.logger.error('Worker poll failed', { error });
        await sleep(this.config.pollIntervalMs);
      }
    }
  }

  private async pollOnce(): Promise<void> {
    let capacity = this.config.concurrency - this.activeMessages.size;
    if (capacity <= 0) {
      await sleep(this.config.pollIntervalMs);
      return;
    }

    if (this.config.enableStaleRecovery) {
      for (const queue of this.config.queues) {
        if (capacity <= 0) break;
        const reclaimed = await claimStaleMessages(
          queue,
          this.config.workerId,
          this.config.staleThresholdMs,
          capacity
        );
        this.dispatch(reclaimed);
        capacity = this.config.concurrency - this.activeMessages.size;
      }
    }

    if (capacity <= 0) return;
    const messages = await consumeJobs(
      this.config.workerId,
      this.config.queues,
      {
        batchSize: Math.min(capacity, this.config.batchSize),
        blockMs: this.config.pollIntervalMs,
      }
    );
    this.dispatch(messages);
  }

  private dispatch(messages: ConsumedMessage[]): void {
    if (this.state !== 'RUNNING') return;

    for (const message of messages) {
      const deliveryKey = getDeliveryKey(message);
      if (
        this.activeMessages.has(deliveryKey) ||
        this.activeJobs.has(message.data.jobId)
      ) {
        continue;
      }
      if (this.activeMessages.size >= this.config.concurrency) break;

      this.activeMessages.add(deliveryKey);

      let rawHandlerPromise: Promise<unknown> | undefined;

      const promise = (async () => {
        try {
          await this.processMessage(message, (raw) => {
            rawHandlerPromise = raw;
          });
        } catch (error) {
          this.logger.error('Unexpected delivery error', {
            jobId: message.data.jobId,
            messageId: message.messageId,
            error,
          });
        } finally {
          if (rawHandlerPromise) {
            // Retain capacity slot until the underlying asynchronous handler promise settles
            void rawHandlerPromise.finally(() => {
              this.activeMessages.delete(deliveryKey);
            });
          } else {
            this.activeMessages.delete(deliveryKey);
          }
        }
      })();

      this.handlerPromises.add(promise);
      void promise.finally(() => {
        this.handlerPromises.delete(promise);
      });
    }
  }

  private async processMessage(
    message: ConsumedMessage,
    onRawHandlerPromise?: (promise: Promise<unknown>) => void
  ): Promise<void> {
    const { jobId } = message.data;
    await this.config.beforeLease?.(message);

    // Database errors deliberately escape this call. The outer handler logs
    // them and the Redis entry remains pending for a later reclaim.
    const lease = await acquireJobForDelivery(
      jobId,
      this.config.workerId,
      this.config.leaseDurationMs
    );

    if (lease.kind === 'TERMINAL') {
      this.unresolvedReclaims.delete(message.messageId);
      assertDurableTerminalStatus(lease.job.status, jobId);
      await acknowledgeMessage(message.queue, message.messageId);
      return;
    }

    if (lease.kind === 'NOT_FOUND') {
      const attempts = (this.unresolvedReclaims.get(message.messageId) ?? 0) + 1;
      this.unresolvedReclaims.set(message.messageId, attempts);
      if (attempts >= 3) {
        this.logger.warn('Quarantining persistent not-found job message', {
          jobId,
          messageId: message.messageId,
          attempts,
        });
        await quarantineEntry(message.stream, message.messageId, 'JOB_NOT_FOUND', {
          jobId,
          attempts,
        });
        this.unresolvedReclaims.delete(message.messageId);
      }
      return;
    }

    if (lease.kind === 'NOT_READY') {
      const { status, scheduledAt } = lease.job;
      const isFuture = scheduledAt && new Date(scheduledAt).getTime() > Date.now();

      if (status === JobStatus.RETRY_SCHEDULED && isFuture) {
        // Legitimate delayed retry: leave pending in Redis PEL until due
        return;
      }

      if (status === JobStatus.CREATED && isFuture) {
        // Legitimate delayed scheduled job: leave pending until due
        return;
      }

      // If not due to a future schedule, track reclaims and quarantine if stuck
      const attempts = (this.unresolvedReclaims.get(message.messageId) ?? 0) + 1;
      this.unresolvedReclaims.set(message.messageId, attempts);
      if (attempts >= 3) {
        this.logger.warn('Quarantining stuck not-ready job message', {
          jobId,
          messageId: message.messageId,
          status,
          attempts,
        });
        await quarantineEntry(message.stream, message.messageId, `NOT_READY_${status}`, {
          jobId,
          status,
          attempts,
        });
        this.unresolvedReclaims.delete(message.messageId);
      }
      return;
    }

    if (lease.kind === 'BUSY') {
      return;
    }

    this.unresolvedReclaims.delete(message.messageId);

    const leaseId = lease.job.leaseId;
    if (!leaseId) throw new Error(`Acquired job ${jobId} without a lease ID`);

    const activeJob: ActiveJob = {
      jobId,
      messageId: message.messageId,
      leaseId,
      cancellationToken: new CancellationToken(),
    };
    this.activeJobs.set(jobId, activeJob);
    this.startLeaseRenewal(activeJob);
    const startedAt = Date.now();

    try {
      // This insert is the exact handler-execution boundary. If it cannot be
      // persisted, no handler or external effect is invoked.
      await startJobAttempt(jobId, this.config.workerId, leaseId);

      let result: Record<string, unknown>;
      try {
        result = normalizeResult(
          await this.runHandler(
            lease.job as unknown as Job,
            activeJob.cancellationToken,
            onRawHandlerPromise
          )
        );
      } catch (error) {
        if (error instanceof CancellationError) throw error;

        const failure = await failJobDelivery(
          jobId,
          this.config.workerId,
          leaseId,
          serializeError(error),
          {
            baseDelayMs: this.config.retryBaseDelayMs,
            maxDelayMs: this.config.retryMaxDelayMs,
          }
        );

        this.updateStats(false, Date.now() - startedAt);
        if (failure.terminal) {
          if (failure.job.status !== JobStatus.DEAD_LETTERED) {
            throw new Error(
              `Cannot acknowledge job ${jobId}: terminal failure persisted ${failure.job.status}`
            );
          }
          await this.config.afterTerminalPersist?.({
            jobId,
            status: JobStatus.DEAD_LETTERED,
            message,
          });
          await acknowledgeMessage(message.queue, message.messageId);
        }
        return;
      }

      const completed = await completeJobDelivery(
        jobId,
        this.config.workerId,
        leaseId,
        result
      );
      if (completed.status !== JobStatus.SUCCEEDED) {
        throw new Error(
          `Cannot acknowledge job ${jobId}: completion persisted ${completed.status}`
        );
      }
      this.updateStats(true, Date.now() - startedAt);
      await this.config.afterTerminalPersist?.({
        jobId,
        status: completed.status as JobStatus,
        message,
      });
      await acknowledgeMessage(message.queue, message.messageId);
    } catch (cancellation) {
      // CancellationError means the handler cooperated with cancellation
      // (or the lease renewal detected CANCEL_REQUESTED and fired the token).
      // Persist the terminal CANCELLED state and XACK so downstream workers
      // do not re-deliver this message unnecessarily.
      if (cancellation instanceof CancellationError) {
        try {
          await completeCancellation(jobId, this.config.workerId, leaseId);
          this.logger.info('Job cancelled', { jobId });
        } catch (persistError) {
          // If we lost the lease (e.g., it expired during handler teardown),
          // leave the message pending. The replacement worker will see CANCELLED
          // or CANCEL_REQUESTED and handle it via acquireJobForDelivery.
          this.logger.error('Could not persist cancellation', {
            jobId,
            error: persistError,
          });
          return;
        }
        await acknowledgeMessage(message.queue, message.messageId);
        return;
      }
      throw cancellation;
    } finally {
      this.stopLeaseRenewal(activeJob);
      this.activeJobs.delete(jobId);
    }
  }

  private async runHandler(
    job: Job,
    cancellationToken: CancellationToken,
    onRawPromise?: (promise: Promise<unknown>) => void
  ): Promise<unknown> {
    const handler = this.handlers.get(job.type);
    if (!handler)
      throw new Error(`No handler registered for job type: ${job.type}`);

    const context: JobHandlerContext = {
      job: {
        id: job.id,
        type: job.type,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
      },
      cancellationToken: {
        get isCancellationRequested() {
          return cancellationToken.isCancellationRequested;
        },
        throwIfCancellationRequested: () =>
          cancellationToken.throwIfCancellationRequested(),
        onCancellationRequested: (callback) =>
          cancellationToken.onCancellationRequested(callback),
      },
    };

    const handlerExecution = handler(job.payload, context);
    onRawPromise?.(handlerExecution);

    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        handlerExecution,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            // Documented timeout behavior:
            // Promise.race does not terminate the underlying JavaScript asynchronous
            // execution of the handler function. Cooperating handlers should periodically
            // check context.cancellationToken.isCancellationRequested.
            // If a handler continues running after timeout and attempts external effects,
            // lease renewal has stopped and the cancellation token has fired, causing
            // database effects to be rejected at the fencing/lease boundary.
            // On timeout: if CANCEL_REQUESTED is already set, honour the cancellation
            // rather than triggering a retry path.
            cancellationToken.cancel();
            reject(
              cancellationToken.isCancellationRequested
                ? new CancellationError('Job cancelled (timeout during cancellation)')
                : new Error(`Job timeout after ${job.timeoutMs}ms`)
            );
          }, job.timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private startLeaseRenewal(activeJob: ActiveJob): void {
    let stopped = false;
    activeJob.stopRenewal = () => {
      stopped = true;
      if (activeJob.leaseRenewalTimer) {
        clearTimeout(activeJob.leaseRenewalTimer);
        activeJob.leaseRenewalTimer = undefined;
      }
    };

    const scheduleNext = () => {
      if (stopped || this.state !== 'RUNNING') return;
      activeJob.leaseRenewalTimer = setTimeout(async () => {
        if (stopped) return;
        try {
          const renewed = await renewJobDeliveryLease(
            activeJob.jobId,
            this.config.workerId,
            activeJob.leaseId,
            this.config.leaseDurationMs
          );

          if (!renewed) {
            // Lease lost (expired or revoked) — cancel the handler
            activeJob.cancellationToken.cancel();
            return;
          }

          if (renewed.status === JobStatus.CANCEL_REQUESTED) {
            this.logger.info('Cancellation detected on lease renewal', {
              jobId: activeJob.jobId,
            });
            activeJob.cancellationToken.cancel();
          }
        } catch (error) {
          this.logger.error('Lease renewal failed', {
            jobId: activeJob.jobId,
            error,
          });
          activeJob.cancellationToken.cancel();
        } finally {
          scheduleNext();
        }
      }, this.config.leaseRenewalIntervalMs);
    };

    scheduleNext();
  }

  private stopLeaseRenewal(activeJob: ActiveJob): void {
    activeJob.stopRenewal?.();
    if (activeJob.leaseRenewalTimer) {
      clearTimeout(activeJob.leaseRenewalTimer);
      activeJob.leaseRenewalTimer = undefined;
    }
  }

  private updateStats(success: boolean, durationMs: number): void {
    this.stats.totalProcessed += 1;
    if (success) this.stats.totalSucceeded += 1;
    else this.stats.totalFailed += 1;
    this.stats.averageDurationMs =
      (this.stats.averageDurationMs * (this.stats.totalProcessed - 1) +
        durationMs) /
      this.stats.totalProcessed;
    this.stats.currentLoad = this.activeJobs.size / this.config.concurrency;
  }

  getState(): WorkerState {
    return this.state;
  }

  getStats(): WorkerStats {
    return {
      ...this.stats,
      currentLoad: this.activeJobs.size / this.config.concurrency,
    };
  }

  getActiveJobCount(): number {
    return this.activeJobs.size;
  }

  isHealthy(): boolean {
    return this.state === 'RUNNING';
  }
}

function normalizeResult(result: unknown): Record<string, unknown> {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return { value: result ?? null };
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { message: String(error) };
}

function assertDurableTerminalStatus(status: string, jobId: string): void {
  if (
    status !== JobStatus.SUCCEEDED &&
    status !== JobStatus.CANCELLED &&
    status !== JobStatus.DEAD_LETTERED
  ) {
    throw new Error(
      `Cannot acknowledge job ${jobId}: lease outcome reported non-terminal ${status}`
    );
  }
}

function getDeliveryKey(message: ConsumedMessage): string {
  return `${message.stream}\u0000${message.messageId}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createWorker(
  config: Partial<WorkerConfig>,
  handlers: HandlerRegistry
): Worker {
  return new Worker(config, handlers);
}
