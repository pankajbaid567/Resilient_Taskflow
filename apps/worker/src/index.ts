import { randomUUID } from 'crypto';

import { closeConnection, initDatabase } from '@taskflow/database';
import { createLogger } from '@taskflow/logger';
import { closeRedisConnection, initRedis } from '@taskflow/queue';
import {
  createHandlerRegistry,
  createWorker,
  type Worker,
  type WorkerConfig,
} from '@taskflow/worker';

import { registerHandlers } from './handlers';

const logger = createLogger({ component: 'WorkerEntryPoint' });

function parseTestDelay(variableName: string): number {
  if (process.env.NODE_ENV !== 'test') {
    return 0;
  }

  const rawDelay = process.env[variableName];
  if (!rawDelay) {
    return 0;
  }

  const delayMs = Number(rawDelay);
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
    throw new Error(`${variableName} must be an integer between 0 and 60000`);
  }

  return delayMs;
}

function testCrashAfterCommitEnabled(): boolean {
  if (process.env.NODE_ENV !== 'test') {
    return false;
  }

  return ['1', 'true', 'yes'].includes(
    (process.env.TASKFLOW_TEST_CRASH_AFTER_COMMIT || '').toLowerCase()
  );
}

function createRuntimeConfig(): Partial<WorkerConfig> {
  const beforeLeaseDelayMs = parseTestDelay(
    'TASKFLOW_TEST_BEFORE_LEASE_DELAY_MS'
  );
  const afterCommitDelayMs = parseTestDelay(
    'TASKFLOW_TEST_AFTER_COMMIT_DELAY_MS'
  );
  const staleThresholdMs = parseTestDelay('TASKFLOW_TEST_STALE_THRESHOLD_MS');
  const pollIntervalMs = parseTestDelay('TASKFLOW_TEST_POLL_INTERVAL_MS');
  const crashAfterCommit = testCrashAfterCommitEnabled();

  return {
    // PostgreSQL stores worker IDs as UUIDs. Human-readable identity belongs in
    // the worker record/metadata fields managed by the canonical runtime.
    workerId: randomUUID(),
    staleThresholdMs: staleThresholdMs > 0 ? staleThresholdMs : undefined,
    pollIntervalMs: pollIntervalMs > 0 ? pollIntervalMs : undefined,
    beforeLease:
      beforeLeaseDelayMs > 0
        ? async () => {
            await new Promise((resolve) =>
              setTimeout(resolve, beforeLeaseDelayMs)
            );
          }
        : undefined,
    afterTerminalPersist:
      afterCommitDelayMs > 0 || crashAfterCommit
        ? async ({ jobId, status }) => {
            if (afterCommitDelayMs > 0) {
              await new Promise((resolve) =>
                setTimeout(resolve, afterCommitDelayMs)
              );
            }

            if (!crashAfterCommit) {
              return;
            }

            logger.warn(
              'Integration failpoint: crashing after terminal commit',
              {
                jobId,
                status,
              }
            );
            process.kill(process.pid, 'SIGKILL');
          }
        : undefined,
  };
}

async function closeInfrastructure(): Promise<void> {
  const results = await Promise.allSettled([
    closeRedisConnection(),
    closeConnection(),
  ]);

  for (const result of results) {
    if (result.status === 'rejected') {
      logger.error('Failed to close worker infrastructure', {
        error: result.reason,
      });
    }
  }
}

async function main(): Promise<void> {
  await initDatabase();
  await initRedis();

  const handlers = createHandlerRegistry();
  registerHandlers(handlers);

  const runtimeConfig = createRuntimeConfig();
  const worker: Worker = createWorker(runtimeConfig, handlers);
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (signal: string): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        logger.info('Stopping worker entry point', { signal });
        await worker.stop();
        await closeInfrastructure();
        logger.info('Worker entry point stopped');
      })();
    }

    return shutdownPromise;
  };

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM').then(() => {
      process.exitCode = 0;
    });
  });
  process.once('SIGINT', () => {
    void shutdown('SIGINT').then(() => {
      process.exitCode = 0;
    });
  });

  await worker.start();
  logger.info('WORKER_READY', {
    workerId: runtimeConfig.workerId,
    handlers: handlers.getRegisteredTypes(),
  });
}

main().catch(async (error) => {
  logger.error('Worker entry point failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  await closeInfrastructure();
  process.exitCode = 1;
});
