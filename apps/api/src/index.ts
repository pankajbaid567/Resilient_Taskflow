import { apiConfig, observabilityConfig } from '@taskflow/config';
import { closeConnection, initDatabase } from '@taskflow/database';
import { logger } from '@taskflow/logger';
import {
  collectProcessMetrics,
  initializeTracing,
  shutdownTracing,
} from '@taskflow/observability';
import { closeRedisConnection, initRedis } from '@taskflow/queue';
import { FastifyInstance } from 'fastify';

import { startServer } from './app';
import { createShutdownController } from './lifecycle';

export interface ApiRuntime {
  app: FastifyInstance;
  shutdown: (signal: string) => Promise<void>;
}

export interface ApiRuntimeDependencies {
  initTracing: () => Promise<void>;
  initDatabase: () => Promise<void>;
  initRedis: () => Promise<void>;
  startServer: () => Promise<FastifyInstance>;
  closeDatabase: () => Promise<void>;
  closeRedis: () => Promise<void>;
  closeTracing: () => Promise<void>;
  shutdownTimeoutMs: number;
}

export interface ApiRuntimeController {
  start: () => Promise<ApiRuntime>;
  shutdown: (signal: string) => Promise<void>;
  isShutdownRequested: () => boolean;
}

export interface TerminationCoordinator {
  request: (reason: string, exitCode: 0 | 1) => void;
  isRequested: () => boolean;
}

const runtimeDependencies: ApiRuntimeDependencies = {
  initTracing: () => {
    if (observabilityConfig.enableTracing) {
      initializeTracing('taskflow-api');
    }
    return Promise.resolve();
  },
  initDatabase,
  initRedis,
  startServer,
  closeDatabase: closeConnection,
  closeRedis: closeRedisConnection,
  closeTracing: shutdownTracing,
  shutdownTimeoutMs: apiConfig.shutdownTimeoutMs,
};

/**
 * Own startup and shutdown together so a signal received during initialization
 * can close the clients that are already being opened and prevent later phases.
 */
export function createApiRuntimeController(
  dependencies: ApiRuntimeDependencies = runtimeDependencies
): ApiRuntimeController {
  let app: FastifyInstance | undefined;
  let shutdownRequested = false;

  const closeResources = createShutdownController({
    timeoutMs: dependencies.shutdownTimeoutMs,
    closeHttp: async () => {
      const listeningApp = app;
      if (listeningApp) {
        await listeningApp.close();
        logger.info('✓ HTTP server closed');
      }
    },
    closeRedis: dependencies.closeRedis,
    closeDatabase: dependencies.closeDatabase,
    closeTracing: dependencies.closeTracing,
  });

  const shutdown = (signal: string): Promise<void> => {
    shutdownRequested = true;
    return closeResources(signal);
  };

  const assertStartupActive = (): void => {
    if (shutdownRequested) {
      throw new Error('API startup interrupted by shutdown');
    }
  };

  const start = async (): Promise<ApiRuntime> => {
    try {
      assertStartupActive();
      // Node.js process metrics (CPU, memory, event-loop lag) for this process.
      collectProcessMetrics();
      await dependencies.initTracing();

      assertStartupActive();
      logger.info('Initializing database connection...');
      await dependencies.initDatabase();
      logger.info('✓ Database connected');

      assertStartupActive();
      logger.info('Initializing Redis connection...');
      await dependencies.initRedis();
      logger.info('✓ Redis connected');

      assertStartupActive();
      const listeningApp = await dependencies.startServer();
      app = listeningApp;

      // A signal can arrive while listen() is pending, before app is assigned.
      if (shutdownRequested) {
        await listeningApp.close();
        throw new Error('API startup interrupted by shutdown');
      }

      return { app: listeningApp, shutdown };
    } catch (error) {
      try {
        await shutdown('startup-failure');
      } catch (cleanupError) {
        logger.error('Failed to fully clean up API startup', { cleanupError });
      }
      throw error;
    }
  };

  return {
    start,
    shutdown,
    isShutdownRequested: () => shutdownRequested,
  };
}

/** Initialize dependencies and return the sole owner of runtime shutdown. */
export function startApiRuntime(
  dependencies: ApiRuntimeDependencies = runtimeDependencies
): Promise<ApiRuntime> {
  return createApiRuntimeController(dependencies).start();
}

/**
 * Coalesce all termination requests into one shutdown and retain the highest
 * requested exit severity. This prevents a fatal error racing with SIGTERM
 * from being reported as a clean exit.
 */
export function createTerminationCoordinator(
  shutdown: (reason: string) => Promise<void>,
  exit: (code: 0 | 1) => void,
  onShutdownError: (error: unknown) => void
): TerminationCoordinator {
  let requested = false;
  let requestedExitCode: 0 | 1 = 0;

  return {
    request: (reason, exitCode): void => {
      requestedExitCode = Math.max(requestedExitCode, exitCode) as 0 | 1;
      if (requested) return;
      requested = true;

      void shutdown(reason).then(
        () => exit(requestedExitCode),
        (error: unknown) => {
          onShutdownError(error);
          exit(1);
        }
      );
    },
    isRequested: () => requested,
  };
}

/** Main entry point for the executable API process. */
export async function main(): Promise<void> {
  logger.info('Starting TaskFlow API server...');
  const controller = createApiRuntimeController();
  const termination = createTerminationCoordinator(
    controller.shutdown,
    (code) => process.exit(code),
    (error) => logger.error('Error during shutdown', { error })
  );

  // Install ownership before the first asynchronous startup operation.
  process.once('SIGTERM', () => {
    logger.info('Received SIGTERM, shutting down gracefully...');
    termination.request('SIGTERM', 0);
  });
  process.once('SIGINT', () => {
    logger.info('Received SIGINT, shutting down gracefully...');
    termination.request('SIGINT', 0);
  });
  process.once('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error });
    termination.request('uncaughtException', 1);
  });
  process.once('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason });
    termination.request('unhandledRejection', 1);
  });

  try {
    await controller.start();
  } catch (error) {
    // A registered signal already owns process exit and startup cleanup.
    if (termination.isRequested()) return;
    throw error;
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    logger.error('Failed to start API server', { error });
    process.exit(1);
  });
}
