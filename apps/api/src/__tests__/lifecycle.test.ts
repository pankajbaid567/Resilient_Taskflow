import { describe, expect, it, vi } from 'vitest';

import {
  ApplicationShutdownError,
  createShutdownController,
} from '../lifecycle';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

describe('API shutdown lifecycle', () => {
  it('shares one shutdown across concurrent signals and closes every resource once', async () => {
    const closeHttp = vi.fn().mockResolvedValue(undefined);
    const closeRedis = vi.fn().mockResolvedValue(undefined);
    const closeDatabase = vi.fn().mockResolvedValue(undefined);
    const closeTracing = vi.fn().mockResolvedValue(undefined);
    const shutdown = createShutdownController({
      timeoutMs: 1_000,
      closeHttp,
      closeRedis,
      closeDatabase,
      closeTracing,
    });

    const first = shutdown('SIGTERM');
    const second = shutdown('SIGINT');

    expect(second).toBe(first);
    await first;
    expect(closeHttp).toHaveBeenCalledTimes(1);
    expect(closeRedis).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(closeTracing).toHaveBeenCalledTimes(1);
  });

  it('drains HTTP before closing backing services', async () => {
    const httpDrain = deferred();
    const closeHttp = vi.fn(() => httpDrain.promise);
    const closeRedis = vi.fn().mockResolvedValue(undefined);
    const closeDatabase = vi.fn().mockResolvedValue(undefined);
    const closeTracing = vi.fn().mockResolvedValue(undefined);
    const shutdown = createShutdownController({
      timeoutMs: 1_000,
      closeHttp,
      closeRedis,
      closeDatabase,
      closeTracing,
    });

    const completion = shutdown('SIGTERM');
    await vi.waitFor(() => expect(closeHttp).toHaveBeenCalledTimes(1));
    expect(closeRedis).not.toHaveBeenCalled();
    expect(closeDatabase).not.toHaveBeenCalled();
    expect(closeTracing).not.toHaveBeenCalled();

    httpDrain.resolve();
    await completion;

    expect(closeRedis).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(closeTracing).toHaveBeenCalledTimes(1);
  });

  it('attempts every backing-service close when one close rejects', async () => {
    const redisError = new Error('Redis close failed');
    const closeRedis = vi.fn().mockRejectedValue(redisError);
    const closeDatabase = vi.fn().mockResolvedValue(undefined);
    const closeTracing = vi.fn().mockResolvedValue(undefined);
    const shutdown = createShutdownController({
      timeoutMs: 1_000,
      closeHttp: vi.fn().mockResolvedValue(undefined),
      closeRedis,
      closeDatabase,
      closeTracing,
    });

    const failure = await shutdown('SIGTERM').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApplicationShutdownError);
    expect(failure).toMatchObject({
      signal: 'SIGTERM',
      failures: [{ resource: 'redis', kind: 'error', error: redisError }],
    });
    expect(closeRedis).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(closeTracing).toHaveBeenCalledTimes(1);
  });

  it('bounds a hung HTTP drain and still invokes every resource closer', async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<void>(() => undefined);
      const closeHttp = vi.fn(() => never);
      const closeRedis = vi.fn(() => never);
      const closeDatabase = vi.fn(() => never);
      const closeTracing = vi.fn(() => never);
      const shutdown = createShutdownController({
        timeoutMs: 100,
        closeHttp,
        closeRedis,
        closeDatabase,
        closeTracing,
        monotonicNow: Date.now,
      });

      const completion = shutdown('SIGTERM');
      const failurePromise = completion.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(50);
      expect(closeRedis).toHaveBeenCalledTimes(1);
      expect(closeDatabase).toHaveBeenCalledTimes(1);
      expect(closeTracing).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(50);
      const failure = await failurePromise;

      expect(failure).toBeInstanceOf(ApplicationShutdownError);
      if (!(failure instanceof ApplicationShutdownError)) {
        throw new Error('Expected ApplicationShutdownError');
      }
      expect(
        failure.failures.map(({ resource, kind }) => ({ resource, kind }))
      ).toEqual([
        { resource: 'http', kind: 'timeout' },
        { resource: 'redis', kind: 'timeout' },
        { resource: 'database', kind: 'timeout' },
        { resource: 'tracing', kind: 'timeout' },
      ]);
      expect(closeHttp).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
