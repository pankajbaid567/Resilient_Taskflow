import { createLogger } from '@taskflow/logger';
import { Job } from '@taskflow/types';

const logger = createLogger({ component: 'DeadLetter' });

/**
 * Dead Letter Queue Entry
 */
export interface DeadLetterEntry {
  originalJobId: string;
  userId: string;
  queueId: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  lastError: Record<string, unknown> | null;
  lastErrorMessage: string | null;
  createdAt: Date;
  failedAt: Date;
  metadata: Record<string, unknown> | null;
}

/**
 * Reason for dead lettering
 */
export type DeadLetterReason =
  | 'max_attempts_exceeded'
  | 'retry_timeout_exceeded'
  | 'non_retryable_error'
  | 'manual_dlq';

/**
 * Dead letter decision
 */
export interface DeadLetterDecision {
  shouldDeadLetter: boolean;
  reason: DeadLetterReason;
  details?: string;
}

/**
 * Determine if job should be moved to DLQ
 */
export function shouldDeadLetterJob(
  job: Job,
  currentAttempt: number,
  maxAttempts: number,
  error: string | null
): DeadLetterDecision {
  // Max attempts exceeded
  if (currentAttempt >= maxAttempts) {
    return {
      shouldDeadLetter: true,
      reason: 'max_attempts_exceeded',
      details: `Job failed ${currentAttempt} times (max: ${maxAttempts})`,
    };
  }

  // Check for fatal errors that shouldn't be retried
  if (error) {
    const fatalPatterns = [
      'FATAL',
      'InvalidJobType',
      'HandlerNotFound',
      'UnrecoverableError',
    ];

    for (const pattern of fatalPatterns) {
      if (error.includes(pattern)) {
        return {
          shouldDeadLetter: true,
          reason: 'non_retryable_error',
          details: `Fatal error: ${pattern}`,
        };
      }
    }
  }

  return {
    shouldDeadLetter: false,
    reason: 'max_attempts_exceeded', // Unused, but required
  };
}

/**
 * Create dead letter entry from job
 */
export function createDeadLetterEntry(
  job: Job,
  reason: DeadLetterReason
): DeadLetterEntry {
  logger.warn('Moving job to dead letter queue', {
    jobId: job.id,
    type: job.type,
    attempts: job.attempts,
    reason,
  });

  return {
    originalJobId: job.id,
    userId: job.userId,
    queueId: job.queueId,
    type: job.type,
    payload: job.payload,
    attempts: job.attempts,
    lastError: job.error,
    lastErrorMessage:
      typeof job.error === 'object' && job.error !== null
        ? JSON.stringify(job.error)
        : String(job.error || 'Unknown error'),
    createdAt: job.createdAt,
    failedAt: job.failedAt || new Date(),
    metadata: {
      ...job.metadata,
      deadLetterReason: reason,
      deadLetteredAt: new Date().toISOString(),
    },
  };
}

/**
 * Dead letter queue statistics
 */
export interface DLQStats {
  totalJobs: number;
  byReason: Record<DeadLetterReason, number>;
  byJobType: Record<string, number>;
  oldestJob: Date | null;
  newestJob: Date | null;
}

/**
 * Calculate DLQ statistics
 */
export function calculateDLQStats(
  entries: DeadLetterEntry[]
): DLQStats {
  const stats: DLQStats = {
    totalJobs: entries.length,
    byReason: {
      max_attempts_exceeded: 0,
      retry_timeout_exceeded: 0,
      non_retryable_error: 0,
      manual_dlq: 0,
    },
    byJobType: {},
    oldestJob: null,
    newestJob: null,
  };

  if (entries.length === 0) {
    return stats;
  }

  // Calculate statistics
  for (const entry of entries) {
    // By reason
    const reason = (entry.metadata?.deadLetterReason as DeadLetterReason) || 'max_attempts_exceeded';
    stats.byReason[reason] = (stats.byReason[reason] || 0) + 1;

    // By job type
    stats.byJobType[entry.type] = (stats.byJobType[entry.type] || 0) + 1;

    // Oldest/newest
    if (!stats.oldestJob || entry.failedAt < stats.oldestJob) {
      stats.oldestJob = entry.failedAt;
    }

    if (!stats.newestJob || entry.failedAt > stats.newestJob) {
      stats.newestJob = entry.failedAt;
    }
  }

  return stats;
}

/**
 * Check if DLQ needs attention
 * 
 * Returns true if:
 * - Too many jobs in DLQ
 * - High rate of non-retryable errors
 * - Specific job types failing consistently
 */
export function isDLQAlerting(
  stats: DLQStats,
  thresholds: {
    maxJobs?: number;
    maxNonRetryablePercent?: number;
    maxJobTypePercent?: number;
  } = {}
): boolean {
  const {
    maxJobs = 1000,
    maxNonRetryablePercent = 0.5, // 50%
    maxJobTypePercent = 0.8, // 80%
  } = thresholds;

  // Too many jobs in DLQ
  if (stats.totalJobs >= maxJobs) {
    logger.warn('DLQ alert: Too many jobs', {
      total: stats.totalJobs,
      threshold: maxJobs,
    });
    return true;
  }

  // High rate of non-retryable errors
  const nonRetryableCount = stats.byReason.non_retryable_error || 0;
  const nonRetryablePercent = nonRetryableCount / stats.totalJobs;

  if (nonRetryablePercent >= maxNonRetryablePercent) {
    logger.warn('DLQ alert: High non-retryable error rate', {
      percent: nonRetryablePercent,
      threshold: maxNonRetryablePercent,
    });
    return true;
  }

  // Specific job type failing consistently
  for (const [jobType, count] of Object.entries(stats.byJobType)) {
    const percent = count / stats.totalJobs;

    if (percent >= maxJobTypePercent) {
      logger.warn('DLQ alert: Job type failing consistently', {
        jobType,
        count,
        percent,
        threshold: maxJobTypePercent,
      });
      return true;
    }
  }

  return false;
}
