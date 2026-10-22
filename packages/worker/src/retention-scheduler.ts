import { randomUUID } from 'node:crypto';

import { retentionConfig } from '@taskflow/config';
import { createLogger } from '@taskflow/logger';
import { getRedisClient } from '@taskflow/queue';
import type { RetentionCleanupReport } from '@taskflow/types';

import { executeFullRetention } from './retention-service';

const logger = createLogger({ component: 'RetentionScheduler' });

/** Redis key holding the single-runner lock. */
export const RETENTION_LOCK_KEY = 'taskflow:lock:retention';

/**
 * Release only if we still own the lock. A plain DEL could delete a lock that
 * expired and was re-acquired by another process while we were running.
 */
const RELEASE_IF_OWNER_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

interface LockRedisClient {
  set(
    key: string,
    value: string,
    expiryMode: 'PX',
    time: number,
    setMode: 'NX'
  ): Promise<'OK' | null>;
  eval(
    script: string,
    numberOfKeys: number,
    ...args: string[]
  ): Promise<unknown>;
}

export interface RetentionSchedulerConfig {
  /** Delay between runs. Default: RETENTION_INTERVAL_MS (1 hour). */
  intervalMs?: number;
  /** Default: RETENTION_ENABLED (true). */
  enabled?: boolean;
  /**
   * Lock lifetime. A run is bounded (batch size x max batches x 8 steps), so
   * this only has to outlive a healthy run; it also frees the lock if the
   * owning process dies mid-run. Default: 10 minutes.
   */
  lockTtlMs?: number;
  /** Random extra delay as a fraction of the interval, to spread workers. */
  jitterRatio?: number;
  /** Injection points for tests. */
  run?: () => Promise<RetentionCleanupReport>;
  getRedis?: () => LockRedisClient;
}

export interface RetentionSchedulerStats {
  totalRuns: number;
  skippedLocked: number;
  totalErrors: number;
  lastRunAt?: Date;
  lastReport?: RetentionCleanupReport;
}

export type RetentionRunOutcome =
  | { ran: true; report: RetentionCleanupReport }
  | { ran: false; reason: 'LOCKED' | 'FAILED' };

/**
 * Runs lifecycle retention periodically from every worker process, while a
 * Redis lock guarantees at most one run is active across all of them.
 *
 * The first run happens one interval after start, never at startup, so a
 * restart loop cannot hammer the database.
 */
export class RetentionScheduler {
  private readonly config: Required<
    Pick<
      RetentionSchedulerConfig,
      'intervalMs' | 'enabled' | 'lockTtlMs' | 'jitterRatio'
    >
  >;
  private readonly run: () => Promise<RetentionCleanupReport>;
  private readonly getRedis: () => LockRedisClient;
  private timer?: NodeJS.Timeout;
  private stopped = true;
  private cyclePromise?: Promise<unknown>;
  private readonly stats: RetentionSchedulerStats = {
    totalRuns: 0,
    skippedLocked: 0,
    totalErrors: 0,
  };

  constructor(config: RetentionSchedulerConfig = {}) {
    this.config = {
      intervalMs: config.intervalMs ?? retentionConfig.intervalMs,
      enabled: config.enabled ?? retentionConfig.enabled,
      lockTtlMs: config.lockTtlMs ?? 600_000,
      jitterRatio: config.jitterRatio ?? 0.1,
    };
    this.run = config.run ?? (() => executeFullRetention());
    this.getRedis =
      config.getRedis ?? ((): LockRedisClient => getRedisClient());

    if (this.config.intervalMs < 1) {
      throw new RangeError('Retention interval must be positive');
    }
    if (this.config.lockTtlMs < 1) {
      throw new RangeError('Retention lock TTL must be positive');
    }
    if (this.config.jitterRatio < 0 || this.config.jitterRatio > 1) {
      throw new RangeError('Retention jitter ratio must be between 0 and 1');
    }
  }

  start(): void {
    if (!this.config.enabled) {
      logger.info('Retention scheduler is disabled');
      return;
    }
    if (!this.stopped) {
      logger.warn('Retention scheduler already started');
      return;
    }

    this.stopped = false;
    this.scheduleNext();
    logger.info('Retention scheduler started', {
      intervalMs: this.config.intervalMs,
    });
  }

  /** Stop scheduling and wait for an in-progress run to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.cyclePromise;
  }

  getStats(): RetentionSchedulerStats {
    return { ...this.stats };
  }

  /**
   * Run retention once if no other process holds the lock. Never throws:
   * a failed run is logged and counted so the schedule keeps going.
   */
  async runOnce(): Promise<RetentionRunOutcome> {
    const redis = this.getRedis();
    const token = randomUUID();

    let acquired: 'OK' | null;
    try {
      acquired = await redis.set(
        RETENTION_LOCK_KEY,
        token,
        'PX',
        this.config.lockTtlMs,
        'NX'
      );
    } catch (error) {
      this.stats.totalErrors++;
      logger.error('Could not acquire retention lock', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { ran: false, reason: 'FAILED' };
    }

    if (acquired !== 'OK') {
      this.stats.skippedLocked++;
      logger.debug('Retention already running elsewhere; skipping');
      return { ran: false, reason: 'LOCKED' };
    }

    try {
      const report = await this.run();
      this.stats.totalRuns++;
      this.stats.lastRunAt = new Date();
      this.stats.lastReport = report;
      return { ran: true, report };
    } catch (error) {
      this.stats.totalErrors++;
      logger.error('Retention run failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { ran: false, reason: 'FAILED' };
    } finally {
      await redis
        .eval(RELEASE_IF_OWNER_LUA, 1, RETENTION_LOCK_KEY, token)
        .catch((error: unknown) => {
          // The TTL will free the lock; only the next run is delayed.
          logger.warn('Could not release retention lock', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;

    const jitter = Math.random() * this.config.jitterRatio;
    const delayMs = Math.round(this.config.intervalMs * (1 + jitter));

    this.timer = setTimeout(() => {
      this.timer = undefined;
      const cycle = this.runOnce().finally(() => {
        if (this.cyclePromise === cycle) this.cyclePromise = undefined;
        this.scheduleNext();
      });
      this.cyclePromise = cycle;
    }, delayMs);
    // Never keep a process alive just for housekeeping.
    this.timer.unref();
  }
}

export function createRetentionScheduler(
  config?: RetentionSchedulerConfig
): RetentionScheduler {
  return new RetentionScheduler(config);
}
