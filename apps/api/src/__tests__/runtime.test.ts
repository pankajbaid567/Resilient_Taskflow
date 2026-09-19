import { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@taskflow/database', () => ({
  closeConnection: vi.fn(),
  initDatabase: vi.fn(),
}));

vi.mock('@taskflow/observability', () => ({
  initializeTracing: vi.fn(),
  shutdownTracing: vi.fn(),
}));

vi.mock('@taskflow/queue', () => ({
  closeRedisConnection: vi.fn(),
  initRedis: vi.fn(),
}));

import {
  ApiRuntimeDependencies,
  createApiRuntimeController,
  createTerminationCoordinator,
  startApiRuntime,
} from '../index';

function resolvedCloser(): ReturnType<typeof vi.fn<[], Promise<void>>> {
  return vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
}

describe('API runtime resource ownership', () => {
  it('wires the real runtime shutdown boundary to HTTP, Redis, database and tracing', async () => {
    const closeHttp = resolvedCloser();
    const app = { close: closeHttp } as unknown as FastifyInstance;
    const closeRedis = resolvedCloser();
    const closeDatabase = resolvedCloser();
    const closeTracing = resolvedCloser();
    const dependencies: ApiRuntimeDependencies = {
      initTracing: resolvedCloser(),
      initDatabase: resolvedCloser(),
      initRedis: resolvedCloser(),
      startServer: vi.fn<[], Promise<FastifyInstance>>().mockResolvedValue(app),
      closeRedis,
      closeDatabase,
      closeTracing,
      shutdownTimeoutMs: 1_000,
    };

    const runtime = await startApiRuntime(dependencies);
    await Promise.all([
      runtime.shutdown('SIGTERM'),
      runtime.shutdown('SIGINT'),
    ]);

    expect(closeHttp).toHaveBeenCalledTimes(1);
    expect(closeRedis).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(closeTracing).toHaveBeenCalledTimes(1);
  });

  it('closes every initialized client after a partial startup failure', async () => {
    const startupError = new Error('Redis initialization failed');
    const initDatabase = resolvedCloser();
    const initRedis = vi
      .fn<[], Promise<void>>()
      .mockRejectedValue(startupError);
    const startServer = vi.fn<[], Promise<FastifyInstance>>();
    const closeRedis = resolvedCloser();
    const closeDatabase = resolvedCloser();
    const closeTracing = resolvedCloser();
    const dependencies: ApiRuntimeDependencies = {
      initTracing: resolvedCloser(),
      initDatabase,
      initRedis,
      startServer,
      closeRedis,
      closeDatabase,
      closeTracing,
      shutdownTimeoutMs: 1_000,
    };

    await expect(startApiRuntime(dependencies)).rejects.toBe(startupError);
    expect(initDatabase).toHaveBeenCalledTimes(1);
    expect(initRedis).toHaveBeenCalledTimes(1);
    expect(startServer).not.toHaveBeenCalled();
    expect(closeRedis).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(closeTracing).toHaveBeenCalledTimes(1);
  });

  it('interrupts startup before the next phase when shutdown is requested', async () => {
    let finishDatabaseInit: (() => void) | undefined;
    const initDatabase = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDatabaseInit = resolve;
        })
    );
    const initRedis = resolvedCloser();
    const startServer = vi.fn<[], Promise<FastifyInstance>>();
    const closeRedis = resolvedCloser();
    const closeDatabase = resolvedCloser();
    const closeTracing = resolvedCloser();
    const controller = createApiRuntimeController({
      initTracing: resolvedCloser(),
      initDatabase,
      initRedis,
      startServer,
      closeRedis,
      closeDatabase,
      closeTracing,
      shutdownTimeoutMs: 1_000,
    });

    const startup = controller.start();
    await vi.waitFor(() => expect(initDatabase).toHaveBeenCalledTimes(1));
    const shutdown = controller.shutdown('SIGTERM');
    finishDatabaseInit?.();

    await expect(startup).rejects.toThrow('interrupted by shutdown');
    await shutdown;
    expect(initRedis).not.toHaveBeenCalled();
    expect(startServer).not.toHaveBeenCalled();
    expect(closeRedis).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(closeTracing).toHaveBeenCalledTimes(1);
  });

  it('retains fatal exit severity when it races with a normal signal', async () => {
    let finishShutdown: (() => void) | undefined;
    const shutdown = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishShutdown = resolve;
        })
    );
    const exit = vi.fn<[0 | 1], void>();
    const onShutdownError = vi.fn<[unknown], void>();
    const termination = createTerminationCoordinator(
      shutdown,
      exit,
      onShutdownError
    );

    termination.request('SIGTERM', 0);
    termination.request('uncaughtException', 1);
    finishShutdown?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(onShutdownError).not.toHaveBeenCalled();
  });
});
