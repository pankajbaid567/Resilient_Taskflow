import { getJobsReadyToQueue, promoteJobToQueued } from '@taskflow/database';
import { createLogger } from '@taskflow/logger';


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
 * - Enqueues them to Redis Streams
 * - Updates status to QUEUED
 * 
 * This enables delayed job execution:
 * - Immediate jobs: scheduledAt = now() → enqueued immediately in API
 * - Delayed jobs: scheduledAt = future → picked up by scheduler when ready
 */
export class Scheduler {
  private config: Required<SchedulerConfig>;
  private timer?: NodeJS.Timeout;
  private isRunning = false;
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
    this.runSchedulingCycle();

    this.timer = setInterval(() => {
      this.runSchedulingCycle();
    }, this.config.intervalMs);
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (!this.timer) {
      logger.warn('Scheduler not running');
      return;
    }

    logger.info('Stopping scheduler', { stats: this.stats });

    clearInterval(this.timer);
    this.timer = undefined;
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

      // Get jobs ready to queue
      const jobs = await getJobsReadyToQueue(this.config.batchSize);

      if (jobs.length === 0) {
        logger.debug('No jobs ready to queue');
        return;
      }

      logger.info('Found jobs ready to queue', {
        count: jobs.length,
        priorities: this.countByPriority(jobs),
      });

      // Enqueue each job atomically — QUEUED status + delivery row in one tx
      let successCount = 0;
      let errorCount = 0;

      for (const job of jobs) {
        try {
          // Resolve queue from the queues FK stored in job.metadata, not raw JSON.
          // The API always stores the queue name in metadata.queue.
          const queueName =
            typeof (job.metadata as Record<string, unknown> | null)?.queue === 'string'
              ? (job.metadata as Record<string, unknown>).queue as string
              : 'default';

          await promoteJobToQueued(job.id, queueName);

          successCount++;

          logger.debug('Job promoted to QUEUED', {
            jobId: job.id,
            type: job.type,
            priority: job.priority,
            queue: queueName,
            scheduledAt: job.scheduledAt,
          });
        } catch (error) {
          errorCount++;
          this.stats.totalErrors++;

          logger.error('Failed to promote job to QUEUED', {
            jobId: job.id,
            error: error instanceof Error ? error.message : error,
          });
        }
      }

      // Update stats
      this.stats.totalJobsScheduled += successCount;
      this.stats.lastRunAt = new Date();
      this.stats.lastRunDurationMs = Date.now() - startTime;
      this.stats.lastRunJobCount = jobs.length;

      logger.info('Scheduling cycle completed', {
        duration: this.stats.lastRunDurationMs,
        successful: successCount,
        failed: errorCount,
        total: jobs.length,
      });
    } catch (error) {
      this.stats.totalErrors++;
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
  private countByPriority(jobs: any[]): Record<string, number> {
    return jobs.reduce((acc, job) => {
      const priority = job.priority || 'NORMAL';
      acc[priority] = (acc[priority] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
  }
}

/**
 * Create a scheduler instance
 */
export function createScheduler(config?: SchedulerConfig): Scheduler {
  return new Scheduler(config);
}
