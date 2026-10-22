import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@taskflow/queue', () => ({ getRedisClient: vi.fn() }));
vi.mock('../retention-service', () => ({ executeFullRetention: vi.fn() }));
vi.mock('@taskflow/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type { RetentionCleanupReport } from '@taskflow/types';

import { RETENTION_LOCK_KEY, RetentionScheduler } from '../retention-scheduler';

function report(): RetentionCleanupReport {
  return {
    deletedJobs: 1,
    deletedJobEvents: 2,
    deletedJobAttempts: 3,
    deletedDeadLetters: 0,
    deletedJobDeliveries: 0,
    deletedWorkers: 0,
    deletedIdempotencyKeys: 0,
    deletedAuditLogs: 0,
    trimmedRedisEntries: {},
    errors: [],
    completedAt: new Date().toISOString(),
  };
}

/** In-memory stand-in for the two Redis commands the lock uses. */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    set: vi.fn(async (key: string, value: string) => {
      if (store.has(key)) return null;
      store.set(key, value);
      return 'OK' as const;
    }),
    // Mirrors the compare-and-delete Lua script.
    eval: vi.fn(
      async (_script: string, _n: number, key: string, token: string) => {
        if (store.get(key) === token) {
          store.delete(key);
          return 1;
        }
        return 0;
      }
    ),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('RetentionScheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs once under the lock and releases it afterwards', async () => {
    const redis = fakeRedis();
    const run = vi.fn().mockResolvedValue(report());
    const scheduler = new RetentionScheduler({ run, getRedis: () => redis });

    const outcome = await scheduler.runOnce();

    expect(outcome).toMatchObject({ ran: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      RETENTION_LOCK_KEY,
      expect.any(String),
      'PX',
      600_000,
      'NX'
    );
    expect(redis.store.has(RETENTION_LOCK_KEY)).toBe(false);
    expect(scheduler.getStats().totalRuns).toBe(1);
  });

  it('lets exactly one of two concurrent schedulers run', async () => {
    const redis = fakeRedis();
    const gate = deferred<RetentionCleanupReport>();
    const runA = vi.fn(() => gate.promise);
    const runB = vi.fn().mockResolvedValue(report());
    const a = new RetentionScheduler({ run: runA, getRedis: () => redis });
    const b = new RetentionScheduler({ run: runB, getRedis: () => redis });

    const first = a.runOnce();
    await vi.waitFor(() => expect(runA).toHaveBeenCalledTimes(1));
    const second = await b.runOnce();

    expect(second).toEqual({ ran: false, reason: 'LOCKED' });
    expect(runB).not.toHaveBeenCalled();
    expect(b.getStats().skippedLocked).toBe(1);

    gate.resolve(report());
    await expect(first).resolves.toMatchObject({ ran: true });

    // After release the next scheduler can run.
    await expect(b.runOnce()).resolves.toMatchObject({ ran: true });
    expect(runB).toHaveBeenCalledTimes(1);
  });

  it('never releases a lock it no longer owns', async () => {
    const redis = fakeRedis();
    const run = vi.fn(async () => {
      // The TTL expired mid-run and another process took the lock.
      redis.store.set(RETENTION_LOCK_KEY, 'someone-else');
      return report();
    });
    const scheduler = new RetentionScheduler({ run, getRedis: () => redis });

    await scheduler.runOnce();

    expect(redis.store.get(RETENTION_LOCK_KEY)).toBe('someone-else');
  });

  it('reports a failed run without throwing, and still releases the lock', async () => {
    const redis = fakeRedis();
    const run = vi.fn().mockRejectedValue(new Error('boom'));
    const scheduler = new RetentionScheduler({ run, getRedis: () => redis });

    await expect(scheduler.runOnce()).resolves.toEqual({
      ran: false,
      reason: 'FAILED',
    });

    expect(scheduler.getStats().totalErrors).toBe(1);
    expect(redis.store.has(RETENTION_LOCK_KEY)).toBe(false);
  });

  it('treats an unreachable Redis as a failed run, not a crash', async () => {
    const redis = fakeRedis();
    redis.set.mockRejectedValue(new Error('ECONNREFUSED'));
    const run = vi.fn();
    const scheduler = new RetentionScheduler({ run, getRedis: () => redis });

    await expect(scheduler.runOnce()).resolves.toEqual({
      ran: false,
      reason: 'FAILED',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('does not run at startup; the first run is one interval later', async () => {
    vi.useFakeTimers();
    const redis = fakeRedis();
    const run = vi.fn().mockResolvedValue(report());
    const scheduler = new RetentionScheduler({
      run,
      getRedis: () => redis,
      intervalMs: 1_000,
      jitterRatio: 0,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it('waits for an in-progress run when stopping, and schedules no more', async () => {
    vi.useFakeTimers();
    const redis = fakeRedis();
    const gate = deferred<RetentionCleanupReport>();
    const run = vi.fn(() => gate.promise);
    const scheduler = new RetentionScheduler({
      run,
      getRedis: () => redis,
      intervalMs: 1_000,
      jitterRatio: 0,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    gate.resolve(report());
    await stopping;
    expect(stopped).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('schedules nothing when disabled', () => {
    vi.useFakeTimers();
    const scheduler = new RetentionScheduler({
      enabled: false,
      run: vi.fn(),
      getRedis: () => fakeRedis(),
    });

    scheduler.start();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects invalid configuration', () => {
    expect(() => new RetentionScheduler({ intervalMs: 0 })).toThrow(RangeError);
    expect(() => new RetentionScheduler({ lockTtlMs: 0 })).toThrow(RangeError);
    expect(() => new RetentionScheduler({ jitterRatio: 2 })).toThrow(
      RangeError
    );
  });
});
