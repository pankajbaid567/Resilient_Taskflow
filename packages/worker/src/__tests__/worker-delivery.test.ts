import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConsumedMessage } from '@taskflow/queue';
import { PermanentJobError } from '@taskflow/retry';
import {
  JobPriority,
  JobStatus,
  REDIS_JOB_MESSAGE_VERSION,
  WorkerStatus,
  type JobHandlerContext,
} from '@taskflow/types';

import { CancellationError } from '../cancellation-token';
import { HandlerRegistry } from '../handler-registry';
import { Worker } from '../worker';
import { createWorkerConfig } from '../worker-config';
import type { TerminalPersistedEvent, WorkerConfig } from '../worker-config';

const database = vi.hoisted(() => ({
  acquireJobForDelivery: vi.fn(),
  completeJobDelivery: vi.fn(),
  completeCancellation: vi.fn(),
  failJobDelivery: vi.fn(),
  JobCancellationRequestedError: class JobCancellationRequestedError extends Error {},
  registerWorker: vi.fn(),
  releaseJobDelivery: vi.fn(),
  renewJobDeliveryLease: vi.fn(),
  startJobAttempt: vi.fn(),
  updateWorkerHeartbeat: vi.fn(),
  updateWorkerStatus: vi.fn(),
}));

const queue = vi.hoisted(() => ({
  acknowledgeMessage: vi.fn(),
  claimStaleMessages: vi.fn(),
  consumeJobs: vi.fn(),
  createConsumerGroup: vi.fn(),
  quarantineEntry: vi.fn(),
}));

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

const metrics = vi.hoisted(() => ({
  jobStarted: vi.fn(),
  jobWaited: vi.fn(),
  jobSucceeded: vi.fn(),
  jobFailed: vi.fn(),
  jobTimedOut: vi.fn(),
  jobCancelled: vi.fn(),
  runningJobs: vi.fn(),
  heartbeat: vi.fn(),
  leaseRenewed: vi.fn(),
  leaseNotAcquired: vi.fn(),
}));

vi.mock('../metrics', () => ({ workerMetrics: metrics }));
vi.mock('@taskflow/database', () => database);
vi.mock('@taskflow/queue', () => queue);
vi.mock('@taskflow/logger', () => ({
  createWorkerLogger: () => logger,
}));

const workerId = '11111111-1111-4111-8111-111111111111';
const leaseId = '22222222-2222-4222-8222-222222222222';

function job(status: JobStatus = JobStatus.PROCESSING) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    userId: '44444444-4444-4444-8444-444444444444',
    queueId: '55555555-5555-4555-8555-555555555555',
    type: 'test-job',
    payload: { input: 'value' },
    priority: JobPriority.NORMAL,
    status,
    attempts: 1,
    maxAttempts: 3,
    timeoutMs: 1_000,
    scheduledAt: new Date('2026-09-08T10:00:00.000Z'),
    createdAt: new Date('2026-09-08T10:00:00.000Z'),
    startedAt: new Date('2026-09-08T10:00:01.000Z'),
    completedAt: null,
    failedAt: null,
    workerId,
    leaseId,
    leaseExpiresAt: new Date('2099-09-08T10:00:00.000Z'),
    result: null,
    error: null,
    metadata: null,
    tags: [],
    version: 3,
    eventSequence: 4,
  };
}

function successorDelivery() {
  return {
    id: '66666666-6666-4666-8666-666666666666',
    jobId: job().id,
    queueName: 'default',
    attempt: 2,
    availableAt: job().scheduledAt,
    status: 'PENDING',
    redisMessageId: null,
    publishedAt: null,
    claimedBy: null,
    claimedAt: null,
    error: null,
    retryCount: 0,
    createdAt: new Date(),
  };
}

function message(): ConsumedMessage {
  return {
    messageId: '1000-0',
    stream: 'taskflow:queue:default:jobs',
    queue: 'default',
    data: {
      schemaVersion: REDIS_JOB_MESSAGE_VERSION,
      jobId: job().id,
      enqueuedAt: '2026-09-08T10:00:00.000Z',
      attempt: 1,
      queue: 'default',
    },
  };
}

function createTestWorker(
  handler: ReturnType<typeof vi.fn> | undefined,
  config: Partial<WorkerConfig> = {}
): Worker {
  const handlers = new HandlerRegistry();
  if (handler) handlers.register('test-job', handler);

  return new Worker(
    {
      workerId,
      workerName: 'test-worker',
      queues: ['default'],
      concurrency: 1,
      heartbeatIntervalMs: 60_000,
      leaseDurationMs: 60_000,
      leaseRenewalIntervalMs: 50_000,
      pollIntervalMs: 10,
      batchSize: 1,
      shutdownTimeoutMs: 1_000,
      enableStaleRecovery: true,
      staleThresholdMs: 60_000,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 100,
      ...config,
    },
    handlers
  );
}

function processMessage(
  worker: Worker,
  delivery: ConsumedMessage
): Promise<void> {
  return (
    worker as unknown as {
      processMessage(messageToProcess: ConsumedMessage): Promise<void>;
    }
  ).processMessage(delivery);
}

function dispatchMessage(worker: Worker, delivery: ConsumedMessage): void {
  (
    worker as unknown as {
      dispatch(messages: ConsumedMessage[]): void;
    }
  ).dispatch([delivery]);
}

function setWorkerRunning(worker: Worker): void {
  (
    worker as unknown as {
      state: 'RUNNING';
    }
  ).state = 'RUNNING';
}

function cooperativeHandler() {
  return vi.fn(
    async (
      _payload: Record<string, unknown>,
      context: JobHandlerContext
    ): Promise<Record<string, unknown>> =>
      new Promise((_resolve, reject) => {
        context.cancellationToken.onCancellationRequested(() => {
          try {
            context.cancellationToken.throwIfCancellationRequested();
          } catch (error) {
            reject(error);
          }
        });
      })
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe('Worker delivery acknowledgement boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.startJobAttempt.mockResolvedValue({});
    database.renewJobDeliveryLease.mockResolvedValue(job());
    database.updateWorkerHeartbeat.mockResolvedValue({});
    database.updateWorkerStatus.mockResolvedValue({});
    queue.acknowledgeMessage.mockResolvedValue(true);
    queue.claimStaleMessages.mockResolvedValue([]);
    queue.consumeJobs.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [];
    });
    queue.createConsumerGroup.mockResolvedValue(true);
    queue.quarantineEntry.mockResolvedValue(undefined);
  });

  it('acknowledges only after terminal result persistence and the post-commit hook', async () => {
    const handler = vi.fn(async () => ({ output: 'done' }));
    const completion = deferred<ReturnType<typeof job>>();
    const postCommit = deferred<void>();
    const afterTerminalPersist = vi.fn(
      async (_event: TerminalPersistedEvent) => postCommit.promise
    );
    const worker = createTestWorker(handler, { afterTerminalPersist });

    database.acquireJobForDelivery.mockResolvedValue({
      kind: 'ACQUIRED',
      job: job(),
    });
    database.completeJobDelivery.mockReturnValue(completion.promise);

    const processing = processMessage(worker, message());
    await vi.waitFor(() =>
      expect(database.completeJobDelivery).toHaveBeenCalledTimes(1)
    );
    expect(queue.acknowledgeMessage).not.toHaveBeenCalled();

    completion.resolve(job(JobStatus.SUCCEEDED));
    await vi.waitFor(() =>
      expect(afterTerminalPersist).toHaveBeenCalledTimes(1)
    );
    expect(queue.acknowledgeMessage).not.toHaveBeenCalled();

    postCommit.resolve();
    await processing;

    expect(queue.acknowledgeMessage).toHaveBeenCalledWith('default', '1000-0');
  });

  it('acknowledges an already-terminal delivery without executing its handler', async () => {
    const handler = vi.fn(async () => ({ output: 'should-not-run' }));
    const worker = createTestWorker(handler);
    database.acquireJobForDelivery.mockResolvedValue({
      kind: 'TERMINAL',
      job: job(JobStatus.SUCCEEDED),
    });

    await processMessage(worker, message());

    expect(handler).not.toHaveBeenCalled();
    expect(database.startJobAttempt).not.toHaveBeenCalled();
    expect(queue.acknowledgeMessage).toHaveBeenCalledWith('default', '1000-0');
  });

  it('does not acknowledge or execute when lease acquisition throws', async () => {
    const handler = vi.fn(async () => ({ output: 'should-not-run' }));
    const worker = createTestWorker(handler);
    database.acquireJobForDelivery.mockRejectedValue(
      new Error('database temporarily unavailable')
    );

    await expect(processMessage(worker, message())).rejects.toThrow(
      'database temporarily unavailable'
    );
    expect(handler).not.toHaveBeenCalled();
    expect(queue.acknowledgeMessage).not.toHaveBeenCalled();
  });

  it('leaves every nonterminal lease outcome pending', async () => {
    const handler = vi.fn(async () => ({ output: 'should-not-run' }));
    const outcomes = [
      { kind: 'NOT_FOUND' },
      { kind: 'NOT_READY', job: job(JobStatus.RETRY_SCHEDULED) },
      { kind: 'BUSY', job: job(JobStatus.PROCESSING) },
    ];

    for (const outcome of outcomes) {
      vi.clearAllMocks();
      database.acquireJobForDelivery.mockResolvedValue(outcome);
      const worker = createTestWorker(handler);

      await processMessage(worker, message());

      expect(queue.acknowledgeMessage).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it('does not execute or acknowledge when attempt persistence fails', async () => {
    const handler = vi.fn(async () => ({ output: 'should-not-run' }));
    const worker = createTestWorker(handler);
    database.acquireJobForDelivery.mockResolvedValue({
      kind: 'ACQUIRED',
      job: job(),
    });
    database.startJobAttempt.mockRejectedValue(
      new Error('attempt insert failed')
    );

    await expect(processMessage(worker, message())).rejects.toThrow(
      'attempt insert failed'
    );
    expect(handler).not.toHaveBeenCalled();
    expect(queue.acknowledgeMessage).not.toHaveBeenCalled();
  });

  it('treats a handler timeout as a retryable failure, not cancellation', async () => {
    const handler = vi.fn(() => new Promise<Record<string, unknown>>(() => {}));
    const worker = createTestWorker(handler);
    database.acquireJobForDelivery.mockResolvedValue({
      kind: 'ACQUIRED',
      job: { ...job(), timeoutMs: 15 },
    });
    database.failJobDelivery.mockResolvedValue({
      job: job(JobStatus.RETRY_SCHEDULED),
      terminal: false,
      retryDelayMs: 10,
      successorDelivery: successorDelivery(),
    });

    await processMessage(worker, message());

    expect(database.failJobDelivery).toHaveBeenCalledWith(
      job().id,
      workerId,
      leaseId,
      expect.objectContaining({
        name: 'HandlerTimeoutError',
        message: 'Job timeout after 15ms',
      }),
      expect.any(Object)
    );
    expect(database.completeCancellation).not.toHaveBeenCalled();
    expect(queue.acknowledgeMessage).toHaveBeenCalledWith('default', '1000-0');
  });

  it('does not turn an unsolicited handler CancellationError into CANCELLED', async () => {
    const handler = vi.fn(async () => {
      throw new CancellationError('handler stopped itself');
    });
    const worker = createTestWorker(handler);
    database.acquireJobForDelivery.mockResolvedValue({
      kind: 'ACQUIRED',
      job: job(),
    });
    database.failJobDelivery.mockResolvedValue({
      job: job(JobStatus.RETRY_SCHEDULED),
      terminal: false,
      retryDelayMs: 10,
      successorDelivery: successorDelivery(),
    });

    await processMessage(worker, message());

    expect(database.failJobDelivery).toHaveBeenCalledWith(
      job().id,
      workerId,
      leaseId,
      expect.objectContaining({
        name: 'CancellationError',
        message: 'handler stopped itself',
      }),
      expect.any(Object)
    );
    expect(database.completeCancellation).not.toHaveBeenCalled();
    expect(queue.acknowledgeMessage).toHaveBeenCalledWith('default', '1000-0');
  });

  it('persists observed user cancellation before acknowledging Redis', async () => {
    const handler = cooperativeHandler();
    const worker = createTestWorker(handler, {
      leaseDurationMs: 100,
      leaseRenewalIntervalMs: 5,
    });
    setWorkerRunning(worker);
    database.acquireJobForDelivery.mockResolvedValue({
      kind: 'ACQUIRED',
      job: job(),
    });
    database.renewJobDeliveryLease.mockResolvedValue(
      job(JobStatus.CANCEL_REQUESTED)
    );
    database.completeCancellation.mockResolvedValue(job(JobStatus.CANCELLED));

    await processMessage(worker, message());

    expect(database.completeCancellation).toHaveBeenCalledWith(
      job().id,
      workerId,
      leaseId
    );
    expect(queue.acknowledgeMessage).toHaveBeenCalledWith('default', '1000-0');
    expect(
      database.completeCancellation.mock.invocationCallOrder[0]
    ).toBeLessThan(queue.acknowledgeMessage.mock.invocationCallOrder[0]!);
    expect(database.failJobDelivery).not.toHaveBeenCalled();
  });

  it('cancels instead of retrying when a handler fails under an unobserved cancel request', async () => {
    const handler = vi.fn(async () => {
      throw new Error('transient failure');
    });
    const worker = createTestWorker(handler);
    setWorkerRunning(worker);
    database.acquireJobForDelivery.mockResolvedValue({
      kind: 'ACQUIRED',
      job: job(),
    });
    // The user's cancel request landed after the handler started but before
    // the worker's next lease renewal, so only the database knows about it.
    database.failJobDelivery.mockRejectedValue(
      new database.JobCancellationRequestedError('cancel requested')
    );
    database.completeCancellation.mockResolvedValue(job(JobStatus.CANCELLED));

    await processMessage(worker, message());

    expect(database.completeCancellation).toHaveBeenCalledWith(
      job().id,
      workerId,
      leaseId
    );
    expect(queue.acknowledgeMessage).toHaveBeenCalledWith('default', '1000-0');
    expect(
      database.completeCancellation.mock.invocationCallOrder[0]
    ).toBeLessThan(queue.acknowledgeMessage.mock.invocationCallOrder[0]!);
    expect(database.completeJobDelivery).not.toHaveBeenCalled();
  });

  it('leaves the delivery pending after a transient lease-renewal failure', async () => {
    const handler = cooperativeHandler();
    const worker = createTestWorker(handler, {
      leaseDurationMs: 100,
      leaseRenewalIntervalMs: 5,
    });
    setWorkerRunning(worker);
    database.acquireJobForDelivery.mockResolvedValue({
      kind: 'ACQUIRED',
      job: job(),
    });
    database.renewJobDeliveryLease.mockRejectedValue(
      new Error('database temporarily unavailable')
    );

    await processMessage(worker, message());

    expect(database.completeCancellation).not.toHaveBeenCalled();
    expect(database.completeJobDelivery).not.toHaveBeenCalled();
    expect(database.failJobDelivery).not.toHaveBeenCalled();
    expect(queue.acknowledgeMessage).not.toHaveBeenCalled();
  });

  it('acknowledges a failed delivery only after its successor is durable', async () => {
    const handler = vi.fn(async () => {
      throw new Error('retry me');
    });
    const worker = createTestWorker(handler);
    const persistence = deferred<{
      job: ReturnType<typeof job>;
      terminal: false;
      retryDelayMs: number;
      successorDelivery: ReturnType<typeof successorDelivery>;
    }>();
    database.acquireJobForDelivery.mockResolvedValue({
      kind: 'ACQUIRED',
      job: job(),
    });
    database.failJobDelivery.mockReturnValue(persistence.promise);

    const processing = processMessage(worker, message());
    await vi.waitFor(() =>
      expect(database.failJobDelivery).toHaveBeenCalledTimes(1)
    );
    expect(queue.acknowledgeMessage).not.toHaveBeenCalled();

    persistence.resolve({
      job: job(JobStatus.RETRY_SCHEDULED),
      terminal: false,
      retryDelayMs: 10,
      successorDelivery: successorDelivery(),
    });

    await processing;

    expect(database.failJobDelivery).toHaveBeenCalledTimes(1);
    expect(queue.acknowledgeMessage).toHaveBeenCalledWith('default', '1000-0');
    expect(database.failJobDelivery.mock.invocationCallOrder[0]).toBeLessThan(
      queue.acknowledgeMessage.mock.invocationCallOrder[0]!
    );
  });

  it('does not acknowledge when retry persistence fails', async () => {
    const handler = vi.fn(async () => {
      throw new Error('retry me');
    });
    const worker = createTestWorker(handler);
    database.acquireJobForDelivery.mockResolvedValue({
      kind: 'ACQUIRED',
      job: job(),
    });
    database.failJobDelivery.mockRejectedValue(
      new Error('database temporarily unavailable')
    );

    await expect(processMessage(worker, message())).rejects.toThrow(
      'database temporarily unavailable'
    );
    expect(queue.acknowledgeMessage).not.toHaveBeenCalled();
  });

  it('treats a missing handler as a permanent terminal failure', async () => {
    const worker = createTestWorker(undefined);
    database.acquireJobForDelivery.mockResolvedValue({
      kind: 'ACQUIRED',
      job: job(),
    });
    database.failJobDelivery.mockResolvedValue({
      job: job(JobStatus.DEAD_LETTERED),
      terminal: true,
    });

    await processMessage(worker, message());

    expect(database.failJobDelivery).toHaveBeenCalledWith(
      job().id,
      workerId,
      leaseId,
      expect.any(PermanentJobError),
      expect.any(Object)
    );
    expect(queue.acknowledgeMessage).toHaveBeenCalledWith('default', '1000-0');
  });

  it('refuses to acknowledge a nonterminal completion result', async () => {
    const handler = vi.fn(async () => ({ output: 'done' }));
    const worker = createTestWorker(handler);
    database.acquireJobForDelivery.mockResolvedValue({
      kind: 'ACQUIRED',
      job: job(),
    });
    database.completeJobDelivery.mockResolvedValue(job(JobStatus.PROCESSING));

    await expect(processMessage(worker, message())).rejects.toThrow(
      'completion persisted PROCESSING'
    );
    expect(queue.acknowledgeMessage).not.toHaveBeenCalled();
  });

  it('quarantines message after 3 consecutive NOT_FOUND reclaims', async () => {
    const handler = vi.fn();
    const worker = createTestWorker(handler);
    database.acquireJobForDelivery.mockResolvedValue({ kind: 'NOT_FOUND' });

    const msg = message();
    await processMessage(worker, msg);
    expect(queue.quarantineEntry).not.toHaveBeenCalled();

    await processMessage(worker, msg);
    expect(queue.quarantineEntry).not.toHaveBeenCalled();

    await processMessage(worker, msg);
    expect(queue.quarantineEntry).toHaveBeenCalledWith(
      msg.stream,
      msg.messageId,
      'JOB_NOT_FOUND',
      expect.objectContaining({ jobId: msg.data.jobId, attempts: 3 })
    );
  });

  it('uses Redis delivery count to quarantine across worker replacements', async () => {
    const handler = vi.fn();
    const worker = createTestWorker(handler);
    database.acquireJobForDelivery.mockResolvedValue({ kind: 'NOT_FOUND' });
    const msg = { ...message(), deliveryCount: 3 };

    await processMessage(worker, msg);

    expect(queue.quarantineEntry).toHaveBeenCalledWith(
      msg.stream,
      msg.messageId,
      'JOB_NOT_FOUND',
      expect.objectContaining({ attempts: 3 })
    );
  });

  it('keys fallback reclaim counts by stream and message ID', async () => {
    const handler = vi.fn();
    const worker = createTestWorker(handler);
    database.acquireJobForDelivery.mockResolvedValue({ kind: 'NOT_FOUND' });
    const first = message();
    const second = {
      ...message(),
      stream: 'taskflow:queue:other:jobs',
      queue: 'other',
    };

    await processMessage(worker, first);
    await processMessage(worker, first);
    await processMessage(worker, second);

    expect(queue.quarantineEntry).not.toHaveBeenCalled();

    await processMessage(worker, first);
    expect(queue.quarantineEntry).toHaveBeenCalledTimes(1);
    expect(queue.quarantineEntry).toHaveBeenCalledWith(
      first.stream,
      first.messageId,
      'JOB_NOT_FOUND',
      expect.any(Object)
    );
  });

  it('leaves delayed RETRY_SCHEDULED job pending without quarantine', async () => {
    const handler = vi.fn();
    const worker = createTestWorker(handler);
    const retryJob = {
      ...job(JobStatus.RETRY_SCHEDULED),
      scheduledAt: new Date(Date.now() + 60_000),
    };
    database.acquireJobForDelivery.mockResolvedValue({
      kind: 'NOT_READY',
      job: retryJob,
    });

    const msg = message();
    for (let i = 0; i < 5; i++) {
      await processMessage(worker, msg);
    }

    expect(queue.quarantineEntry).not.toHaveBeenCalled();
    expect(queue.acknowledgeMessage).not.toHaveBeenCalled();
  });

  it('never sends CANCEL_REQUESTED through generic quarantine handling', async () => {
    const handler = vi.fn();
    const worker = createTestWorker(handler);
    database.acquireJobForDelivery.mockResolvedValue({
      kind: 'NOT_READY',
      job: job(JobStatus.CANCEL_REQUESTED),
    });

    await processMessage(worker, { ...message(), deliveryCount: 99 });

    expect(queue.quarantineEntry).not.toHaveBeenCalled();
    expect(queue.acknowledgeMessage).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('never quarantines a known nonterminal NOT_READY job', async () => {
    const handler = vi.fn();
    const worker = createTestWorker(handler);
    const stuckJob = {
      ...job(JobStatus.CREATED),
      scheduledAt: new Date(Date.now() - 60_000),
    };
    database.acquireJobForDelivery.mockResolvedValue({
      kind: 'NOT_READY',
      job: stuckJob,
    });

    const msg = message();
    await processMessage(worker, { ...msg, deliveryCount: 99 });

    expect(queue.quarantineEntry).not.toHaveBeenCalled();
    expect(queue.acknowledgeMessage).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('releases a lease acquired while shutdown races acquisition, without starting the handler', async () => {
    const handler = vi.fn(async () => ({ shouldNotRun: true }));
    const worker = createTestWorker(handler);
    setWorkerRunning(worker);
    const acquisition = deferred<{
      kind: 'ACQUIRED';
      job: ReturnType<typeof job>;
    }>();
    database.acquireJobForDelivery.mockReturnValue(acquisition.promise);
    database.releaseJobDelivery.mockResolvedValue(job(JobStatus.QUEUED));

    const processing = processMessage(worker, message());
    await vi.waitFor(() =>
      expect(database.acquireJobForDelivery).toHaveBeenCalledTimes(1)
    );
    await worker.stop();
    acquisition.resolve({ kind: 'ACQUIRED', job: job() });
    await processing;

    expect(database.startJobAttempt).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(database.releaseJobDelivery).toHaveBeenCalledWith(
      job().id,
      workerId,
      leaseId,
      'worker_shutdown'
    );
    // The Redis entry is acknowledged only after the durable release.
    expect(
      database.releaseJobDelivery.mock.invocationCallOrder[0]
    ).toBeLessThan(queue.acknowledgeMessage.mock.invocationCallOrder[0]!);
  });

  it('lets an in-flight handler finish and commit during the shutdown drain window', async () => {
    const handlerDef = deferred<Record<string, unknown>>();
    const handler = vi.fn(async () => handlerDef.promise);
    const worker = createTestWorker(handler, { shutdownTimeoutMs: 2_000 });
    await worker.start();

    database.acquireJobForDelivery.mockResolvedValue({
      kind: 'ACQUIRED',
      job: job(),
    });
    database.startJobAttempt.mockResolvedValue({});
    database.completeJobDelivery.mockResolvedValue(job(JobStatus.SUCCEEDED));

    dispatchMessage(worker, message());
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    const stopping = worker.stop();
    setTimeout(() => handlerDef.resolve({ done: true }), 50);
    await stopping;

    expect(database.completeJobDelivery).toHaveBeenCalledTimes(1);
    expect(database.releaseJobDelivery).not.toHaveBeenCalled();
    expect(queue.acknowledgeMessage).toHaveBeenCalledTimes(1);
    expect(worker.getState()).toBe('STOPPED');
  });

  it('releases the lease of a handler that outlives the drain window instead of letting it expire', async () => {
    const handler = vi.fn(
      (_payload: unknown, context: JobHandlerContext) =>
        new Promise((_, reject) => {
          context.cancellationToken.onCancellationRequested(() =>
            reject(new CancellationError('stopping'))
          );
        })
    );
    const worker = createTestWorker(handler, { shutdownTimeoutMs: 200 });
    await worker.start();

    database.acquireJobForDelivery.mockResolvedValue({
      kind: 'ACQUIRED',
      job: job(),
    });
    database.startJobAttempt.mockResolvedValue({});
    database.releaseJobDelivery.mockResolvedValue(job(JobStatus.QUEUED));

    dispatchMessage(worker, message());
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    await worker.stop();

    expect(database.releaseJobDelivery).toHaveBeenCalledTimes(1);
    expect(database.failJobDelivery).not.toHaveBeenCalled();
    expect(database.completeJobDelivery).not.toHaveBeenCalled();
    expect(queue.acknowledgeMessage).toHaveBeenCalledTimes(1);
    expect(worker.getState()).toBe('STOPPED');
  });

  it('does not become RUNNING when shutdown interrupts startup', async () => {
    const handler = vi.fn(async () => ({ shouldNotRun: true }));
    const worker = createTestWorker(handler);
    const registration = deferred<Record<string, never>>();
    database.registerWorker.mockReturnValue(registration.promise);

    const starting = worker.start();
    await vi.waitFor(() => expect(database.registerWorker).toHaveBeenCalled());
    const stopping = worker.stop();
    registration.resolve({});

    await expect(starting).rejects.toThrow(
      'Worker startup interrupted by shutdown'
    );
    await stopping;

    expect(queue.createConsumerGroup).not.toHaveBeenCalled();
    expect(worker.getState()).toBe('STOPPED');
    expect(worker.isHealthy()).toBe(false);
  });

  it('stop() marks worker STOPPING in database and transitions to STOPPED after handlers settle', async () => {
    const handlerDef = deferred<Record<string, unknown>>();
    const handler = vi.fn(async () => handlerDef.promise);
    const worker = createTestWorker(handler, { shutdownTimeoutMs: 500 });
    await worker.start();

    database.acquireJobForDelivery.mockResolvedValue({
      kind: 'ACQUIRED',
      job: job(),
    });
    database.startJobAttempt.mockResolvedValue({});
    database.completeJobDelivery.mockResolvedValue(job(JobStatus.SUCCEEDED));

    dispatchMessage(worker, message());
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    const stopPromise = worker.stop();

    await vi.waitFor(() =>
      expect(database.updateWorkerStatus).toHaveBeenCalledWith(
        workerId,
        WorkerStatus.STOPPING
      )
    );

    handlerDef.resolve({ done: true });
    await stopPromise;

    expect(database.updateWorkerStatus).toHaveBeenCalledWith(
      workerId,
      WorkerStatus.STOPPED
    );
    expect(worker.getState()).toBe('STOPPED');
  });

  it('bounds shutdown but keeps durable status STOPPING when raw handler execution is unproven', async () => {
    const handler = vi.fn(() => new Promise(() => {})); // Never resolves
    const worker = createTestWorker(handler, { shutdownTimeoutMs: 50 });
    await worker.start();

    database.acquireJobForDelivery.mockResolvedValue({
      kind: 'ACQUIRED',
      job: job(),
    });
    database.startJobAttempt.mockResolvedValue({});

    dispatchMessage(worker, message());
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    const startedAt = Date.now();
    await worker.stop();
    const elapsedMs = Date.now() - startedAt;

    expect(database.updateWorkerStatus).toHaveBeenCalledWith(
      workerId,
      WorkerStatus.STOPPING
    );
    expect(database.updateWorkerStatus).not.toHaveBeenCalledWith(
      workerId,
      WorkerStatus.STOPPED
    );
    expect(elapsedMs).toBeLessThan(500);
    expect(logger.warn).toHaveBeenCalledWith(
      'Worker shutdown deadline reached; drain is incomplete and handler code may still be running',
      expect.objectContaining({ rawHandlers: 1 })
    );
    expect(worker.getState()).toBe('STOPPED_UNCLEAN');
  });
});

describe('Worker metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.startJobAttempt.mockResolvedValue({});
    database.renewJobDeliveryLease.mockResolvedValue(job());
    database.updateWorkerHeartbeat.mockResolvedValue({});
    queue.acknowledgeMessage.mockResolvedValue(true);
  });

  it('records a start, a success, and the running-job gauge going 1 then 0', async () => {
    const worker = createTestWorker(vi.fn(async () => ({ output: 'done' })));
    database.acquireJobForDelivery.mockResolvedValue({
      kind: 'ACQUIRED',
      job: job(),
    });
    database.completeJobDelivery.mockResolvedValue(job(JobStatus.SUCCEEDED));

    await processMessage(worker, message());

    expect(metrics.jobStarted).toHaveBeenCalledWith(
      'default',
      'test-job',
      workerId
    );
    expect(metrics.jobSucceeded).toHaveBeenCalledWith(
      'default',
      'test-job',
      expect.any(Number)
    );
    expect(metrics.runningJobs.mock.calls).toEqual([
      [workerId, 1],
      [workerId, 0],
    ]);
    expect(metrics.jobFailed).not.toHaveBeenCalled();
  });

  it('records how long the job waited between becoming due and starting', async () => {
    const worker = createTestWorker(vi.fn(async () => ({ ok: true })));
    const dueAt = new Date(Date.now() - 4_000);
    database.acquireJobForDelivery.mockResolvedValue({
      kind: 'ACQUIRED',
      job: { ...job(), scheduledAt: dueAt, priority: JobPriority.CRITICAL },
    });
    database.completeJobDelivery.mockResolvedValue(job(JobStatus.SUCCEEDED));

    await processMessage(worker, message());

    expect(metrics.jobWaited).toHaveBeenCalledWith(
      'default',
      'CRITICAL',
      expect.any(Number)
    );
    const waitedMs = metrics.jobWaited.mock.calls[0]![2] as number;
    expect(waitedMs).toBeGreaterThanOrEqual(4_000);
    expect(waitedMs).toBeLessThan(6_000);
  });

  it('records a retried failure with the error class and attempt', async () => {
    const worker = createTestWorker(
      vi.fn(async () => {
        throw new TypeError('boom');
      })
    );
    database.acquireJobForDelivery.mockResolvedValue({
      kind: 'ACQUIRED',
      job: job(),
    });
    database.failJobDelivery.mockResolvedValue({
      job: job(JobStatus.RETRY_SCHEDULED),
      terminal: false,
      retryDelayMs: 10,
      successorDelivery: successorDelivery(),
    });

    await processMessage(worker, message());

    expect(metrics.jobFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: 'default',
        type: 'test-job',
        errorType: 'TypeError',
        attempt: 1,
        terminal: false,
      })
    );
    expect(metrics.jobSucceeded).not.toHaveBeenCalled();
    expect(metrics.jobTimedOut).not.toHaveBeenCalled();
  });

  it('records a timeout as both a timeout and a failure', async () => {
    const worker = createTestWorker(
      vi.fn(() => new Promise<Record<string, unknown>>(() => {}))
    );
    database.acquireJobForDelivery.mockResolvedValue({
      kind: 'ACQUIRED',
      job: { ...job(), timeoutMs: 15 },
    });
    database.failJobDelivery.mockResolvedValue({
      job: job(JobStatus.RETRY_SCHEDULED),
      terminal: false,
      retryDelayMs: 10,
      successorDelivery: successorDelivery(),
    });

    await processMessage(worker, message());

    expect(metrics.jobTimedOut).toHaveBeenCalledWith('default', 'test-job');
    expect(metrics.jobFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorType: 'HandlerTimeoutError' })
    );
  });

  it('labels a permanent terminal failure so it is distinguishable from exhaustion', async () => {
    const worker = createTestWorker(undefined); // no handler registered
    database.acquireJobForDelivery.mockResolvedValue({
      kind: 'ACQUIRED',
      job: job(),
    });
    database.failJobDelivery.mockResolvedValue({
      job: job(JobStatus.DEAD_LETTERED),
      terminal: true,
    });

    await processMessage(worker, message());

    expect(metrics.jobFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: true,
        errorType: 'PermanentJobError',
        deadLetterReason: 'permanent',
      })
    );
  });

  it('labels an exhausted-retries dead letter as max_attempts', async () => {
    const worker = createTestWorker(
      vi.fn(async () => {
        throw new Error('still failing');
      })
    );
    database.acquireJobForDelivery.mockResolvedValue({
      kind: 'ACQUIRED',
      job: job(),
    });
    database.failJobDelivery.mockResolvedValue({
      job: job(JobStatus.DEAD_LETTERED),
      terminal: true,
    });

    await processMessage(worker, message());

    expect(metrics.jobFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: true,
        deadLetterReason: 'max_attempts',
      })
    );
  });

  it('records a cancellation', async () => {
    const worker = createTestWorker(cooperativeHandler(), {
      leaseDurationMs: 100,
      leaseRenewalIntervalMs: 5,
    });
    setWorkerRunning(worker);
    database.acquireJobForDelivery.mockResolvedValue({
      kind: 'ACQUIRED',
      job: job(),
    });
    database.renewJobDeliveryLease.mockResolvedValue(
      job(JobStatus.CANCEL_REQUESTED)
    );
    database.completeCancellation.mockResolvedValue(job(JobStatus.CANCELLED));

    await processMessage(worker, message());

    expect(metrics.jobCancelled).toHaveBeenCalledWith('default', 'test-job');
    expect(metrics.leaseRenewed).toHaveBeenCalledWith(workerId);
  });

  it('counts contention as a lease not acquired, and never as a start', async () => {
    const worker = createTestWorker(vi.fn());
    database.acquireJobForDelivery.mockResolvedValue({
      kind: 'BUSY',
      job: job(),
    });

    await processMessage(worker, message());

    expect(metrics.leaseNotAcquired).toHaveBeenCalledWith(workerId, 'busy');
    expect(metrics.jobStarted).not.toHaveBeenCalled();
  });

  it('never uses a caller-chosen job type as a metric label', async () => {
    // Registered handler is 'test-job'; the job claims an arbitrary type.
    const worker = createTestWorker(vi.fn());
    database.acquireJobForDelivery.mockResolvedValue({
      kind: 'ACQUIRED',
      job: { ...job(), type: 'attacker-chosen-type-1234' },
    });
    database.failJobDelivery.mockResolvedValue({
      job: job(JobStatus.DEAD_LETTERED),
      terminal: true,
    });

    await processMessage(worker, message());

    const labelled = [
      ...metrics.jobStarted.mock.calls.map((call) => call[1]),
      ...metrics.jobFailed.mock.calls.map((call) => call[0].type),
    ];
    expect(labelled.length).toBeGreaterThan(0);
    expect(labelled).not.toContain('attacker-chosen-type-1234');
    expect(new Set(labelled)).toEqual(new Set(['unregistered']));
  });

  it('does not record a start when the attempt cannot be persisted', async () => {
    const worker = createTestWorker(vi.fn());
    database.acquireJobForDelivery.mockResolvedValue({
      kind: 'ACQUIRED',
      job: job(),
    });
    database.startJobAttempt.mockRejectedValue(new Error('db down'));

    await processMessage(worker, message()).catch(() => undefined);

    expect(metrics.jobStarted).not.toHaveBeenCalled();
  });
});

describe('Worker delivery timing configuration', () => {
  it('derives dependent defaults from an overridden lease and concurrency', () => {
    const config = createWorkerConfig({
      workerId,
      leaseDurationMs: 90,
      concurrency: 3,
    });

    expect(config.leaseRenewalIntervalMs).toBe(30);
    expect(config.staleThresholdMs).toBe(90);
    expect(config.batchSize).toBe(3);
  });
});

describe('poll loop capacity', () => {
  type PollInternals = {
    activeMessages: Set<string>;
    pollOnce(): Promise<void>;
    notifySlotFreed(): void;
  };

  it('wakes as soon as a slot frees instead of sleeping a whole poll interval', async () => {
    // A fixed sleep here capped each worker at concurrency / pollIntervalMs
    // jobs per second (20 / 250 ms = 80/s) regardless of handler speed.
    const worker = createTestWorker(undefined, {
      concurrency: 1,
      pollIntervalMs: 60_000,
    });
    const internals = worker as unknown as PollInternals;
    internals.activeMessages.add('busy');

    let settled = false;
    const poll = internals.pollOnce().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);

    internals.activeMessages.delete('busy');
    internals.notifySlotFreed();
    await poll;

    expect(settled).toBe(true);
  });
});
