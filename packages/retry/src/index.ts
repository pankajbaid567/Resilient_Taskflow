/**
 * @taskflow/retry
 * 
 * Retry logic and backoff strategies for failed jobs.
 * 
 * Features:
 * - Exponential backoff with jitter
 * - Multiple backoff strategies (exponential, linear, fixed, fibonacci)
 * - Retry policies with configurable attempts
 * - Retryable/non-retryable error patterns
 * - Dead letter queue handling
 * - Retry scheduling
 */

// Backoff
export {
  BackoffStrategy,
  BackoffConfig,
  calculateBackoff,
  calculateRetryTime,
  formatDelay,
  previewBackoffSchedule,
} from './backoff';

// Retry Policy
export {
  RetryPolicy,
  RetryDecision,
  DEFAULT_RETRY_POLICY,
  NON_RETRYABLE_ERRORS,
  RETRYABLE_ERRORS,
  shouldRetryJob,
  createRetryPolicy,
  createAggressiveRetryPolicy,
  createConservativeRetryPolicy,
  createLinearRetryPolicy,
} from './retry-policy';

// Dead Letter Queue
export {
  DeadLetterEntry,
  DeadLetterReason,
  DeadLetterDecision,
  DLQStats,
  shouldDeadLetterJob,
  createDeadLetterEntry,
  calculateDLQStats,
  isDLQAlerting,
} from './dead-letter';
