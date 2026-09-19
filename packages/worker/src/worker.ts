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
import { PermanentJobError } from '@taskflow/retry';
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
  'IDLE' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'STOPPED' | 'STOPPED_UNCLEAN';

interface ActiveJob {
  jobId: string;
  messageId: string;
  leaseId: string;
  cancellationToken: CancellationToken;
  interruptionReason?: WorkerInterruptionReason;
  interruptHandler?: (reason: WorkerInterruptionReason) => void;
  timeoutError?: HandlerTimeoutError;
  leaseRenewalTimer?: NodeJS.Timeout;
  stopRenewal?: () => void;
}

type WorkerInterruptionReason =
  'LEASE_LOST' | 'LEASE_RENEWAL_FAILED' | 'SHUTDOWN' | 'USER_CANCELLATION';

class HandlerTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Job timeout after ${timeoutMs}ms`);
    this.name = 'HandlerTimeoutError';
  }
}

class HandlerInterruptedError extends Error {
  constructor(readonly reason: WorkerInterruptionReason) {
    super(`Job handler interrupted: ${reason}`);
    this.name = 'HandlerInterruptedError';
  }
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
  private readonly rawHandlerPromises = new Set<Promise<unknown>>();
  private readonly unresolvedReclaims = new Map<string, number>();
  private state: WorkerState = 'IDLE';
  private stopRequested = false;
  private startupSettled?: Promise<void>;
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
    let resolveStartup!: () => void;
    this.startupSettled = new Promise<void>((resolve) => {
      resolveStartup = resolve;
    });

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

      if (this.stopRequested) {
        throw new Error('Worker startup interrupted by shutdown');
      }

      for (const queue of this.config.queues) {
        await createConsumerGroup(queue);
        if (this.stopRequested) {
          throw new Error('Worker startup interrupted by shutdown');
        }
      }

      this.state = 'RUNNING';
      this.startHeartbeat();
      this.pollingPromise = this.pollLoop();
      this.logger.info('Worker started', {
        queues: this.config.queues,
        concurrency: this.config.concurrency,
      });
    } catch (error) {
      if (!this.stopRequested) {
        this.state = 'STOPPED';
      }
      throw error;
    } finally {
      resolveStartup();
    }
  }

  async stop(): Promise<void> {
    if (
      this.state === 'STOPPED' ||
      this.state === 'STOPPED_UNCLEAN' ||
      this.state === 'IDLE'
    ) {
      return;
    }
    this.stopRequested = true;
    this.state = 'STOPPING';
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    const stoppingStatusUpdate = (async () => {
      await this.startupSettled;
      await updateWorkerStatus(this.config.workerId, WorkerStatus.STOPPING);
    })().catch((error: unknown) => {
      this.logger.error('Could not persist STOPPING worker status', { error });
    });

    // Stop lease ownership immediately. Cooperative handlers receive the
    // signal, but a JavaScript promise cannot forcibly terminate arbitrary
    // handler code or external effects already in progress.
    for (const activeJob of this.activeJobs.values()) {
      this.stopLeaseRenewal(activeJob);
      this.interruptActiveJob(activeJob, 'SHUTDOWN');
    }

    let deadlineTimer: NodeJS.Timeout | undefined;
    const drained = (async () => {
      await stoppingStatusUpdate;
      await Promise.allSettled([
        ...Array.from(this.handlerPromises),
        ...Array.from(this.rawHandlerPromises),
      ]);
      await this.pollingPromise?.catch(() => undefined);
      await updateWorkerStatus(this.config.workerId, WorkerStatus.STOPPED);
      return true;
    })();
    const deadline = new Promise<false>((resolve) => {
      deadlineTimer = setTimeout(
        () => resolve(false),
        this.config.shutdownTimeoutMs
      );
    });
    const handlersStopped = await Promise.race([drained, deadline]).catch(
      (error: unknown) => {
        this.logger.error('Worker shutdown drain failed', { error });
        return false;
      }
    );
    if (deadlineTimer) clearTimeout(deadlineTimer);

    if (!handlersStopped) {
      this.state = 'STOPPED_UNCLEAN';
      this.logger.warn(
        'Worker shutdown deadline reached; drain is incomplete and handler code may still be running',
        {
          activeDeliveries: this.activeMessages.size,
          rawHandlers: this.rawHandlerPromises.size,
        }
      );
      // Observe eventual rejection after stop() returns. Keep the durable
      // worker state at STOPPING because raw external effects were not proven
      // to have stopped; a process supervisor may terminate the process.
      void drained
        .then(() => {
          this.state = 'STOPPED';
        })
        .catch((error: unknown) => {
          this.logger.error('Worker background drain failed', { error });
        });
    } else {
      this.state = 'STOPPED';
    }
  }

  private startHeartbeat(): void {
    const scheduleNext = () => {
      if (this.state !== 'RUNNING') return;
      this.heartbeatTimer = setTimeout(async () => {
        try {
          const worker = await updateWorkerHeartbeat(this.config.workerId, {
            currentJobCount: this.activeJobs.size,
            totalJobsProcessed: this.stats.totalProcessed,
            totalJobsSucceeded: this.stats.totalSucceeded,
            totalJobsFailed: this.stats.totalFailed,
          });
          if (worker?.status === WorkerStatus.STOPPING) {
            this.logger.info('Durable worker stop request observed');
            if (this.config.onStopRequested) {
              await this.config.onStopRequested();
            } else {
              await this.stop();
            }
          }
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
      .catch((error) =>
        this.logger.error('Worker initial heartbeat failed', { error })
      )
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

      let rawHandlerStarted = false;

      const promise = (async () => {
        try {
          await this.processMessage(message, (raw) => {
            rawHandlerStarted = true;
            this.rawHandlerPromises.add(raw);
            const releaseCapacity = () => {
              this.rawHandlerPromises.delete(raw);
              this.activeMessages.delete(deliveryKey);
            };
            // Use both settlement branches instead of an ignored finally()
            // promise, which would itself reject when the handler rejected.
            void raw.then(releaseCapacity, releaseCapacity);
          });
        } catch (error) {
          this.logger.error('Unexpected delivery error', {
            jobId: message.data.jobId,
            messageId: message.messageId,
            error,
          });
        } finally {
          if (!rawHandlerStarted) {
            this.activeMessages.delete(deliveryKey);
          }
        }
      })();

      this.handlerPromises.add(promise);
      void promise.then(
        () => this.handlerPromises.delete(promise),
        () => this.handlerPromises.delete(promise)
      );
    }
  }

  private async processMessage(
    message: ConsumedMessage,
    onRawHandlerPromise?: (promise: Promise<unknown>) => void
  ): Promise<void> {
    const { jobId } = message.data;
    await this.config.beforeLease?.(message);

    if (this.stopRequested) {
      return;
    }

    // Database errors deliberately escape this call. The outer handler logs
    // them and the Redis entry remains pending for a later reclaim.
    const lease = await acquireJobForDelivery(
      jobId,
      this.config.workerId,
      this.config.leaseDurationMs
    );

    // stop() can race an in-progress database call. Do not start a handler or
    // renew a newly acquired lease after shutdown has begun; leave the Redis
    // entry pending and let the lease expire for a replacement worker.
    if (this.stopRequested) {
      return;
    }

    if (lease.kind === 'TERMINAL') {
      this.unresolvedReclaims.delete(getDeliveryKey(message));
      assertDurableTerminalStatus(lease.job.status, jobId);
      await acknowledgeMessage(message.queue, message.messageId);
      return;
    }

    if (lease.kind === 'NOT_FOUND') {
      const attempts = this.getDeliveryAttempts(message);
      if (attempts >= 3) {
        this.logger.warn('Quarantining persistent not-found job message', {
          jobId,
          messageId: message.messageId,
          attempts,
        });
        await quarantineEntry(
          message.stream,
          message.messageId,
          'JOB_NOT_FOUND',
          {
            jobId,
            attempts,
          }
        );
        this.unresolvedReclaims.delete(getDeliveryKey(message));
      }
      return;
    }

    if (lease.kind === 'NOT_READY') {
      const { status, scheduledAt } = lease.job;
      const isFuture =
        scheduledAt && new Date(scheduledAt).getTime() > Date.now();

      if (status === JobStatus.RETRY_SCHEDULED && isFuture) {
        // Legitimate delayed retry: leave pending in Redis PEL until due
        return;
      }

      if (status === JobStatus.CREATED && isFuture) {
        // Legitimate delayed scheduled job: leave pending until due
        return;
      }

      if (status === JobStatus.CANCEL_REQUESTED) {
        // Defensive fallback: the database acquisition boundary normally
        // reports an active request as BUSY and recovers an expired request to
        // terminal CANCELLED. Never treat cancellation as poison data.
        return;
      }

      // The database row exists and is nonterminal. Even if its timing/state is
      // unexpected, transport quarantine would XACK the only known delivery
      // and could strand the job. Keep it pending for durable recovery.
      this.logger.warn('Leaving known nonterminal job delivery pending', {
        jobId,
        messageId: message.messageId,
        status,
        scheduledAt,
      });
      return;
    }

    if (lease.kind === 'BUSY') {
      return;
    }

    this.unresolvedReclaims.delete(getDeliveryKey(message));

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

      if (activeJob.interruptionReason === 'USER_CANCELLATION') {
        throw new CancellationError(
          'Job cancellation requested before execution'
        );
      }
      if (activeJob.interruptionReason) {
        return;
      }

      let result: Record<string, unknown>;
      try {
        const rawResult = await this.runHandler(
          lease.job as unknown as Job,
          activeJob,
          onRawHandlerPromise
        );
        if (activeJob.timeoutError) {
          throw activeJob.timeoutError;
        }
        result = normalizeResult(rawResult);
      } catch (error) {
        // A non-user interruption relinquishes this delivery without changing
        // its database state or acknowledging Redis. Recovery is fenced by the
        // current lease expiry.
        if (
          error instanceof HandlerInterruptedError ||
          (activeJob.interruptionReason &&
            activeJob.interruptionReason !== 'USER_CANCELLATION')
        ) {
          return;
        }

        // Cancellation wins only after the worker observed a durable
        // CANCEL_REQUESTED row and the underlying handler has settled.
        if (activeJob.interruptionReason === 'USER_CANCELLATION') {
          throw new CancellationError('Job cancellation requested');
        }

        const failure = await failJobDelivery(
          jobId,
          this.config.workerId,
          leaseId,
          activeJob.timeoutError ?? error,
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
        } else {
          const scheduledAt = new Date(failure.job.scheduledAt).getTime();
          const availableAt = new Date(
            failure.successorDelivery.availableAt
          ).getTime();
          if (
            failure.job.status !== JobStatus.RETRY_SCHEDULED ||
            failure.successorDelivery.status !== 'PENDING' ||
            failure.successorDelivery.attempt !== failure.job.attempts + 1 ||
            availableAt !== scheduledAt
          ) {
            throw new Error(
              `Cannot acknowledge job ${jobId}: retry successor was not durably persisted`
            );
          }
        }
        await acknowledgeMessage(message.queue, message.messageId);
        return;
      }

      if (activeJob.interruptionReason === 'USER_CANCELLATION') {
        throw new CancellationError('Job cancellation requested');
      }
      if (activeJob.interruptionReason) {
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
      // A terminal cancellation requires both a worker-observed durable
      // request and a settled handler. A handler throwing CancellationError
      // on its own is treated by the ordinary failure path above.
      if (
        cancellation instanceof CancellationError &&
        activeJob.interruptionReason === 'USER_CANCELLATION'
      ) {
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
    activeJob: ActiveJob,
    onRawPromise?: (promise: Promise<unknown>) => void
  ): Promise<unknown> {
    const { cancellationToken } = activeJob;
    const handler = this.handlers.get(job.type);
    if (!handler)
      throw new PermanentJobError(
        `No handler registered for job type: ${job.type}`,
        'HANDLER_NOT_REGISTERED'
      );

    const context: JobHandlerContext = {
      job: {
        id: job.id,
        type: job.type,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        metadata: job.metadata as Record<string, unknown> | null,
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

    let timeout: NodeJS.Timeout | undefined;
    let rejectInterruption:
      ((reason: WorkerInterruptionReason) => void) | undefined;
    const interruption = new Promise<never>((_, reject) => {
      rejectInterruption = (reason) => {
        if (reason === 'USER_CANCELLATION') return;
        reject(new HandlerInterruptedError(reason));
      };
    });
    activeJob.interruptHandler = rejectInterruption;

    if (activeJob.interruptionReason === 'USER_CANCELLATION') {
      throw new CancellationError(
        'Job cancellation requested before execution'
      );
    }
    if (activeJob.interruptionReason) {
      throw new HandlerInterruptedError(activeJob.interruptionReason);
    }

    const handlerExecution = handler(job.payload, context);
    onRawPromise?.(handlerExecution);

    try {
      return await Promise.race([
        handlerExecution,
        interruption,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            // Documented timeout behavior:
            // Promise.race does not terminate the underlying JavaScript asynchronous
            // execution of the handler function. Cooperating handlers should periodically
            // check context.cancellationToken.isCancellationRequested.
            // The token is advisory: arbitrary handler SQL and external effects
            // are not fenced by this runtime. Capacity remains occupied until
            // the raw promise settles, and retries may duplicate external work.
            if (activeJob.interruptionReason === 'USER_CANCELLATION') {
              // The raw handler has not settled, so do not claim cancellation
              // completed. Leave the delivery pending for lease-expiry recovery.
              reject(new HandlerInterruptedError('USER_CANCELLATION'));
              return;
            }
            if (activeJob.interruptionReason) {
              reject(new HandlerInterruptedError(activeJob.interruptionReason));
              return;
            }

            activeJob.timeoutError = new HandlerTimeoutError(job.timeoutMs);
            cancellationToken.cancel();
            reject(activeJob.timeoutError);
          }, job.timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      activeJob.interruptHandler = undefined;
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
            this.interruptActiveJob(activeJob, 'LEASE_LOST');
            return;
          }

          if (renewed.status === JobStatus.CANCEL_REQUESTED) {
            this.logger.info('Cancellation detected on lease renewal', {
              jobId: activeJob.jobId,
            });
            this.interruptActiveJob(activeJob, 'USER_CANCELLATION');
          }
        } catch (error) {
          this.logger.error('Lease renewal failed', {
            jobId: activeJob.jobId,
            error,
          });
          this.interruptActiveJob(activeJob, 'LEASE_RENEWAL_FAILED');
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

  private interruptActiveJob(
    activeJob: ActiveJob,
    reason: WorkerInterruptionReason
  ): void {
    if (!activeJob.interruptionReason) {
      activeJob.interruptionReason = reason;
    }
    activeJob.cancellationToken.cancel();
    activeJob.interruptHandler?.(activeJob.interruptionReason);
  }

  private getDeliveryAttempts(message: ConsumedMessage): number {
    if (message.deliveryCount !== undefined) {
      return message.deliveryCount;
    }

    const deliveryKey = getDeliveryKey(message);
    const attempts = (this.unresolvedReclaims.get(deliveryKey) ?? 0) + 1;
    this.unresolvedReclaims.set(deliveryKey, attempts);
    return attempts;
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
