import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConsumedMessage } from '@taskflow/queue';
import {
  JobPriority,
  JobStatus,
  REDIS_JOB_MESSAGE_VERSION,
} from '@taskflow/types';

import { HandlerRegistry } from '../handler-registry';
import { Worker } from '../worker';
import { createWorkerConfig } from '../worker-config';
import type { TerminalPersistedEvent, WorkerConfig } from '../worker-config';

const database = vi.hoisted(() => ({
  acquireJobForDelivery: vi.fn(),
  completeJobDelivery: vi.fn(),
  failJobDelivery: vi.fn(),
  registerWorker: vi.fn(),
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
}));

vi.mock('@taskflow/database', () => database);
vi.mock('@taskflow/queue', () => queue);
vi.mock('@taskflow/logger', () => ({
  createWorkerLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
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
  handler: ReturnType<typeof vi.fn>,
  config: Partial<WorkerConfig> = {}
): Worker {
  const handlers = new HandlerRegistry();
  handlers.register('test-job', handler);

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
    queue.acknowledgeMessage.mockResolvedValue(true);
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

  it('leaves a delivery pending after a retry is durably scheduled', async () => {
    const handler = vi.fn(async () => {
      throw new Error('retry me');
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
    });

    await processMessage(worker, message());

    expect(database.failJobDelivery).toHaveBeenCalledTimes(1);
    expect(queue.acknowledgeMessage).not.toHaveBeenCalled();
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
