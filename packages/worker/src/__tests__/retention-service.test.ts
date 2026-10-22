import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@taskflow/database', () => ({
  runDatabaseRetention: vi.fn(),
  listQueues: vi.fn(),
}));

vi.mock('@taskflow/queue', () => ({
  trimStream: vi.fn(),
}));

vi.mock('@taskflow/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { listQueues, runDatabaseRetention } from '@taskflow/database';
import { trimStream } from '@taskflow/queue';

import { executeFullRetention } from '../retention-service';

describe('RetentionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runDatabaseRetention).mockResolvedValue({
      deletedJobs: 5,
      deletedJobEvents: 10,
      deletedJobAttempts: 8,
      deletedDeadLetters: 2,
      deletedJobDeliveries: 12,
      deletedWorkers: 1,
      deletedIdempotencyKeys: 4,
      deletedAuditLogs: 3,
      errors: [],
    });
    vi.mocked(listQueues).mockResolvedValue({
      queues: [
        {
          id: 'q-1',
          name: 'default',
          displayName: 'Default',
          description: null,
          concurrency: 10,
          priority: 5,
          isActive: true,
          maxAttempts: 3,
          timeoutMs: 30000,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'q-2',
          name: 'high-priority',
          displayName: 'High Priority',
          description: null,
          concurrency: 20,
          priority: 10,
          isActive: true,
          maxAttempts: 3,
          timeoutMs: 30000,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      total: 2,
    });
    vi.mocked(trimStream).mockResolvedValue(15);
  });

  it('runs database retention and trims streams across all discovered queues', async () => {
    const report = await executeFullRetention({
      policy: {
        jobsCompletedDays: 10,
        jobEventsDays: 5,
        redisStreamMaxLen: 50_000,
      },
      batchOptions: {
        batchSize: 100,
        maxBatches: 2,
      },
    });

    expect(runDatabaseRetention).toHaveBeenCalledWith(
      expect.objectContaining({
        jobsCompletedDays: 10,
        jobEventsDays: 5,
        redisStreamMaxLen: 50_000,
      }),
      {
        batchSize: 100,
        maxBatches: 2,
      }
    );

    expect(trimStream).toHaveBeenCalledWith('default', 50_000);
    expect(trimStream).toHaveBeenCalledWith('high-priority', 50_000);

    expect(report).toMatchObject({
      deletedJobs: 5,
      deletedJobEvents: 10,
      deletedJobAttempts: 8,
      deletedDeadLetters: 2,
      deletedJobDeliveries: 12,
      deletedWorkers: 1,
      deletedIdempotencyKeys: 4,
      deletedAuditLogs: 3,
      trimmedRedisEntries: {
        default: 15,
        'high-priority': 15,
      },
    });
    expect(typeof report.completedAt).toBe('string');
  });

  it('tolerates individual queue trim failures without failing the entire run', async () => {
    vi.mocked(trimStream)
      .mockResolvedValueOnce(10)
      .mockRejectedValueOnce(new Error('Redis connection lost'));

    const report = await executeFullRetention({
      queues: ['default', 'faulty-queue'],
    });

    expect(report.trimmedRedisEntries).toEqual({
      default: 10,
      'faulty-queue': 0,
    });
    expect(report.deletedJobs).toBe(5);
    expect(report.errors).toEqual([
      { step: 'redis_trim:faulty-queue', message: 'Redis connection lost' },
    ]);
  });

  it('reports a failed database step but still trims streams and keeps the other counts', async () => {
    vi.mocked(runDatabaseRetention).mockResolvedValue({
      deletedJobs: 0,
      deletedJobEvents: 10,
      deletedJobAttempts: 8,
      deletedDeadLetters: 2,
      deletedJobDeliveries: 12,
      deletedWorkers: 0,
      deletedIdempotencyKeys: 4,
      deletedAuditLogs: 3,
      errors: [{ step: 'jobs', message: 'deadlock detected' }],
    });

    const report = await executeFullRetention({ queues: ['default'] });

    expect(report.errors).toEqual([
      { step: 'jobs', message: 'deadlock detected' },
    ]);
    expect(report.deletedJobEvents).toBe(10);
    expect(report.deletedIdempotencyKeys).toBe(4);
    expect(trimStream).toHaveBeenCalledWith('default', expect.any(Number));
  });

  it('reads every page of queues instead of a fixed cap', async () => {
    const queue = (name: string) =>
      ({ id: name, name }) as unknown as Awaited<
        ReturnType<typeof listQueues>
      >['queues'][number];
    vi.mocked(listQueues)
      .mockResolvedValueOnce({
        queues: Array.from({ length: 100 }, (_, i) => queue(`q-${i}`)),
        total: 130,
      })
      .mockResolvedValueOnce({
        queues: Array.from({ length: 30 }, (_, i) => queue(`q-${100 + i}`)),
        total: 130,
      });

    const report = await executeFullRetention();

    expect(listQueues).toHaveBeenNthCalledWith(1, { limit: 100, offset: 0 });
    expect(listQueues).toHaveBeenNthCalledWith(2, { limit: 100, offset: 100 });
    expect(listQueues).toHaveBeenCalledTimes(2);
    expect(Object.keys(report.trimmedRedisEntries)).toHaveLength(130);
  });

  it('trims nothing when there are no queues, instead of assuming "default"', async () => {
    vi.mocked(listQueues).mockResolvedValue({ queues: [], total: 0 });

    const report = await executeFullRetention();

    expect(trimStream).not.toHaveBeenCalled();
    expect(report.trimmedRedisEntries).toEqual({});
  });

  it('skips stream trimming but still reports when queue discovery fails', async () => {
    vi.mocked(listQueues).mockRejectedValue(new Error('database unavailable'));

    const report = await executeFullRetention();

    expect(trimStream).not.toHaveBeenCalled();
    expect(report.errors).toEqual([
      { step: 'list_queues', message: 'database unavailable' },
    ]);
    expect(report.deletedJobs).toBe(5);
  });

  it('uses configured defaults when no explicit options are supplied', async () => {
    await executeFullRetention();
    expect(runDatabaseRetention).toHaveBeenCalledWith(
      expect.objectContaining({
        jobsCompletedDays: expect.any(Number),
        jobEventsDays: expect.any(Number),
        jobAttemptsDays: expect.any(Number),
        deadLettersDays: expect.any(Number),
        deliveriesDays: expect.any(Number),
        workersDays: expect.any(Number),
        idempotencyKeysHours: expect.any(Number),
        auditLogsDays: expect.any(Number),
        redisStreamMaxLen: expect.any(Number),
      }),
      expect.objectContaining({
        batchSize: expect.any(Number),
      })
    );
  });
});
