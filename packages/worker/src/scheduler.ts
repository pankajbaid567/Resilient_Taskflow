import { promoteDueScheduledJobs, type Job } from '@taskflow/database';
import { createLogger } from '@taskflow/logger';

import { workerMetrics } from './metrics';

const logger = createLogger({ component: 'Scheduler' });

/**
 * Scheduler Configuration
 */
export interface SchedulerConfig {
  /**
   * Interval between scheduling runs (milliseconds)
   * Default: 5000 (5 seconds)
   */
  intervalMs?: number;

  /**
   * Maximum number of jobs to process per run
   * Default: 100
   */
  batchSize?: number;

  /**
   * Whether scheduler is enabled
   * Default: true
   */
  enabled?: boolean;
}

/**
 * Scheduler Statistics
 */
export interface SchedulerStats {
  totalRuns: number;
  totalJobsScheduled: number;
  totalErrors: number;
  lastRunAt?: Date;
  lastRunDurationMs?: number;
  lastRunJobCount?: number;
}

/**
 * Scheduler
 *
 * Background service that:
 * - Polls database for CREATED jobs with scheduledAt <= now()
 * - Atomically updates status to QUEUED and writes a durable outbox intent
 *
 * This enables delayed job execution:
 * - Immediate jobs: the API transaction writes QUEUED plus an outbox intent
 * - Delayed jobs: the scheduler writes QUEUED plus an outbox intent when due
 * - The dispatcher is the only component that publishes intents to Redis
 */
export class Scheduler {
  private config: Required<SchedulerConfig>;
  private timer?: NodeJS.Timeout;
  private isRunning = false;
  private cyclePromise?: Promise<void>;
  private stats: SchedulerStats = {
    totalRuns: 0,
    totalJobsScheduled: 0,
    totalErrors: 0,
  };

  constructor(config: SchedulerConfig = {}) {
    this.config = {
      intervalMs: config.intervalMs ?? 5000,
      batchSize: config.batchSize ?? 100,
      enabled: config.enabled ?? true,
    };

    logger.info('Scheduler initialized', {
      intervalMs: this.config.intervalMs,
      batchSize: this.config.batchSize,
      enabled: this.config.enabled,
    });
  }

  /**
   * Start the scheduler
   */
  start(): void {
    if (!this.config.enabled) {
      logger.info('Scheduler is disabled');
      return;
    }

    if (this.timer) {
      logger.warn('Scheduler already started');
      return;
    }

    logger.info('Starting scheduler');

    // Run immediately, then on interval
    this.triggerSchedulingCycle();

    this.timer = setInterval(() => {
      this.triggerSchedulingCycle();
    }, this.config.intervalMs);
  }

  /**
   * Stop the scheduler
   */
  async stop(): Promise<void> {
    if (!this.timer) {
      logger.warn('Scheduler not running');
      return;
    }

    logger.info('Stopping scheduler', { stats: this.stats });

    clearInterval(this.timer);
    this.timer = undefined;
    await this.cyclePromise;
  }

  /** Start one serialized cycle and retain it so shutdown can await it. */
  private triggerSchedulingCycle(): void {
    if (this.isRunning) {
      logger.debug('Scheduling cycle already running, skipping');
      return;
    }

    const cycle = this.runSchedulingCycle();
    const trackedCycle = cycle.finally(() => {
      if (this.cyclePromise === trackedCycle) {
        this.cyclePromise = undefined;
      }
    });
    this.cyclePromise = trackedCycle;
  }

  /**
   * Get scheduler statistics
   */
  getStats(): SchedulerStats {
    return { ...this.stats };
  }

  /**
   * Run a scheduling cycle
   */
  private async runSchedulingCycle(): Promise<void> {
    // Prevent concurrent runs
    if (this.isRunning) {
      logger.debug('Scheduling cycle already running, skipping');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      this.stats.totalRuns++;

      // One transaction claims due rows with SKIP LOCKED and promotes each
      // (QUEUED + outbox row) in its own savepoint.
      const { promoted, failed } = await promoteDueScheduledJobs(
        this.config.batchSize
      );
      workerMetrics.schedulerCycle({
        durationMs: Date.now() - startTime,
        promotedPriorities: promoted.map((job) => job.priority),
        failures: failed.length,
      });
      const total = promoted.length + failed.length;

      if (total === 0) {
        logger.debug('No jobs ready to queue');
        return;
      }

      for (const failure of failed) {
        this.stats.totalErrors++;
        logger.error('Failed to promote job to QUEUED', failure);
      }

      this.stats.totalJobsScheduled += promoted.length;
      this.stats.lastRunAt = new Date();
      this.stats.lastRunDurationMs = Date.now() - startTime;
      this.stats.lastRunJobCount = total;

      logger.info('Scheduling cycle completed', {
        duration: this.stats.lastRunDurationMs,
        successful: promoted.length,
        failed: failed.length,
        priorities: this.countByPriority(promoted),
      });
    } catch (error) {
      this.stats.totalErrors++;
      workerMetrics.schedulerCycleFailed();
      logger.error('Scheduling cycle failed', {
        error: error instanceof Error ? error.message : error,
      });
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Count jobs by priority for logging
   */
  private countByPriority(
    jobs: Array<Pick<Job, 'priority'>>
  ): Record<string, number> {
    return jobs.reduce(
      (acc, job) => {
        const priority = job.priority;
        acc[priority] = (acc[priority] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );
  }
}

/**
 * Create a scheduler instance
 */
export function createScheduler(config?: SchedulerConfig): Scheduler {
  return new Scheduler(config);
}
