import { retentionConfig } from '@taskflow/config';
import { listQueues, runDatabaseRetention } from '@taskflow/database';
import { createLogger } from '@taskflow/logger';
import { trimStream } from '@taskflow/queue';
import type {
  RetentionBatchOptions,
  RetentionCleanupReport,
  RetentionPolicy,
  RetentionStepError,
} from '@taskflow/types';

const logger = createLogger({ component: 'RetentionService' });

export interface RetentionServiceOptions {
  policy?: RetentionPolicy;
  batchOptions?: RetentionBatchOptions;
  queues?: string[];
}

/**
 * Executes a full, bounded retention pass across authoritative PostgreSQL tables
 * and Redis streams.
 */
export async function executeFullRetention(
  options: RetentionServiceOptions = {}
): Promise<RetentionCleanupReport> {
  const policy: RetentionPolicy = {
    jobsCompletedDays:
      options.policy?.jobsCompletedDays ?? retentionConfig.jobsCompletedDays,
    jobEventsDays:
      options.policy?.jobEventsDays ?? retentionConfig.jobEventsDays,
    jobAttemptsDays:
      options.policy?.jobAttemptsDays ?? retentionConfig.jobAttemptsDays,
    deadLettersDays:
      options.policy?.deadLettersDays ?? retentionConfig.deadLettersDays,
    deliveriesDays:
      options.policy?.deliveriesDays ?? retentionConfig.deliveriesDays,
    workersDays: options.policy?.workersDays ?? retentionConfig.workersDays,
    idempotencyKeysHours:
      options.policy?.idempotencyKeysHours ??
      retentionConfig.idempotencyKeysHours,
    auditLogsDays:
      options.policy?.auditLogsDays ?? retentionConfig.auditLogsDays,
    redisStreamMaxLen:
      options.policy?.redisStreamMaxLen ?? retentionConfig.redisStreamMaxLen,
  };

  const batchOptions: RetentionBatchOptions = {
    batchSize: options.batchOptions?.batchSize ?? retentionConfig.batchSize,
    maxBatches: options.batchOptions?.maxBatches,
  };

  logger.info('Starting bounded lifecycle retention run', {
    policy,
    batchOptions,
  });

  // 1. Database retention. Steps are isolated inside runDatabaseRetention.
  const dbSummary = await runDatabaseRetention(policy, batchOptions);
  const errors: RetentionStepError[] = [...dbSummary.errors];

  // 2. Discover the queues whose Redis streams need trimming.
  let queueNames = options.queues;
  if (!queueNames) {
    try {
      queueNames = await listAllQueueNames();
    } catch (error) {
      errors.push({
        step: 'list_queues',
        message: error instanceof Error ? error.message : String(error),
      });
      queueNames = [];
    }
  }

  // 3. Trim streams safely (respecting unacknowledged PEL boundaries). A
  // failure on one stream never stops the others.
  const trimmedRedisEntries: Record<string, number> = {};
  for (const queue of queueNames) {
    try {
      trimmedRedisEntries[queue] = await trimStream(
        queue,
        policy.redisStreamMaxLen
      );
    } catch (error) {
      logger.error('Failed to trim Redis stream for queue', { queue, error });
      trimmedRedisEntries[queue] = 0;
      errors.push({
        step: `redis_trim:${queue}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const report: RetentionCleanupReport = {
    ...dbSummary,
    trimmedRedisEntries,
    errors,
    completedAt: new Date().toISOString(),
  };

  if (errors.length > 0) {
    logger.warn('Bounded lifecycle retention run completed with errors', {
      report,
    });
  } else {
    logger.info('Completed bounded lifecycle retention run', { report });
  }
  return report;
}

const QUEUE_PAGE_SIZE = 100;

/** Every configured queue name, read page by page. */
async function listAllQueueNames(): Promise<string[]> {
  const names: string[] = [];
  for (let offset = 0; ; offset += QUEUE_PAGE_SIZE) {
    const { queues, total } = await listQueues({
      limit: QUEUE_PAGE_SIZE,
      offset,
    });
    names.push(...queues.map((queue) => queue.name));
    if (queues.length === 0 || offset + queues.length >= total) break;
  }
  return names;
}
