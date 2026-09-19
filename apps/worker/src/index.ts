import { randomUUID } from 'crypto';

import { closeConnection, initDatabase } from '@taskflow/database';
import { createLogger } from '@taskflow/logger';
import {
  closeRedisConnection,
  getRedisClient,
  initRedis,
} from '@taskflow/queue';
import {
  createHandlerRegistry,
  createWorker,
  createDispatcher,
  createScheduler,
  type Worker,
  type WorkerConfig,
  type Dispatcher,
  type Scheduler,
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

function getTestAfterCommitBarrierKey(): string | undefined {
  if (process.env.NODE_ENV !== 'test') return undefined;

  const key = process.env.TASKFLOW_TEST_AFTER_COMMIT_BARRIER_KEY;
  if (!key) return undefined;
  if (!/^taskflow:test:[a-z0-9:_-]{1,128}$/i.test(key)) {
    throw new Error(
      'TASKFLOW_TEST_AFTER_COMMIT_BARRIER_KEY must be a TaskFlow test key'
    );
  }
  return key;
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
  const shutdownTimeoutMs = parseTestDelay('TASKFLOW_TEST_SHUTDOWN_TIMEOUT_MS');
  const crashAfterCommit = testCrashAfterCommitEnabled();
  const afterCommitBarrierKey = getTestAfterCommitBarrierKey();

  return {
    // PostgreSQL stores worker IDs as UUIDs. Human-readable identity belongs in
    // the worker record/metadata fields managed by the canonical runtime.
    workerId: randomUUID(),
    ...(staleThresholdMs > 0 ? { staleThresholdMs } : {}),
    ...(pollIntervalMs > 0 ? { pollIntervalMs } : {}),
    ...(shutdownTimeoutMs > 0 ? { shutdownTimeoutMs } : {}),
    beforeLease:
      beforeLeaseDelayMs > 0
        ? async () => {
            await new Promise((resolve) =>
              setTimeout(resolve, beforeLeaseDelayMs)
            );
          }
        : undefined,
    afterTerminalPersist:
      afterCommitDelayMs > 0 || crashAfterCommit || afterCommitBarrierKey
        ? async ({ jobId, status }) => {
            if (afterCommitDelayMs > 0) {
              await new Promise((resolve) =>
                setTimeout(resolve, afterCommitDelayMs)
              );
            }

            if (crashAfterCommit) {
              logger.warn(
                'Integration failpoint: crashing after terminal commit',
                {
                  jobId,
                  status,
                }
              );
              process.kill(process.pid, 'SIGKILL');
              return;
            }

            if (!afterCommitBarrierKey) return;
            const redis = getRedisClient();
            await redis.set(`${afterCommitBarrierKey}:reached`, jobId);
            while (
              (await redis.get(`${afterCommitBarrierKey}:release`)) !== jobId
            ) {
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
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
      const error: unknown = result.reason;
      logger.error('Failed to close worker infrastructure', {
        error,
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
  const entryPointShutdownTimeoutMs =
    (runtimeConfig.shutdownTimeoutMs ?? 30_000) + 2_000;
  const schedulerIntervalMs = parseTestDelay(
    'TASKFLOW_TEST_SCHEDULER_INTERVAL_MS'
  );
  const dispatcherClaimTimeoutMs = parseTestDelay(
    'TASKFLOW_TEST_DISPATCH_CLAIM_TIMEOUT_MS'
  );
  const dispatcherStaleThresholdMs = parseTestDelay(
    'TASKFLOW_TEST_DISPATCH_STALE_THRESHOLD_MS'
  );
  const worker: Worker = createWorker(runtimeConfig, handlers);

  // The Dispatcher claims rows from job_deliveries and publishes to Redis.
  // It runs independently of the Worker so Redis failures during dispatch
  // do not affect in-flight job processing.
  const dispatcher: Dispatcher = createDispatcher({
    claimTimeoutMs:
      dispatcherClaimTimeoutMs > 0 ? dispatcherClaimTimeoutMs : undefined,
    stalePublishedThresholdMs:
      dispatcherStaleThresholdMs > 0 ? dispatcherStaleThresholdMs : undefined,
  });
  const scheduler: Scheduler = createScheduler({
    intervalMs: schedulerIntervalMs > 0 ? schedulerIntervalMs : undefined,
  });

  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (signal: string): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        logger.info('Stopping worker entry point', { signal });
        // Stop creating new delivery intents, and wait for the active scheduler
        // transaction before closing either backing service.
        await scheduler.stop();
        // Stop the worker first (drains in-flight jobs)
        await worker.stop();
        // Stop the dispatcher after the worker so any jobs that just
        // completed and created delivery rows still get published.
        await dispatcher.stop();
        await closeInfrastructure();
        logger.info('Worker entry point stopped');
      })();
    }

    return shutdownPromise;
  };

  const requestShutdown = (signal: string): void => {
    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(() => {
        reject(
          new Error(
            `Worker entry point shutdown exceeded ${entryPointShutdownTimeoutMs}ms`
          )
        );
      }, entryPointShutdownTimeoutMs);
    });

    void Promise.race([shutdown(signal), deadline])
      .then(() => {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        process.exit(0);
      })
      .catch((error: unknown) => {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        logger.error('Worker entry point shutdown failed', { signal, error });
        process.exit(1);
      });
  };

  process.once('SIGTERM', () => requestShutdown('SIGTERM'));
  process.once('SIGINT', () => requestShutdown('SIGINT'));

  await worker.start();
  dispatcher.start();
  scheduler.start();
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
  process.exit(1);
});
