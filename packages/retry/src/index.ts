/**
 * @taskflow/retry
 *
 * Retry logic and backoff strategies for failed jobs.
 *
 * The authoritative TaskFlow worker policy is decideJobRetry: deterministic
 * bounded exponential backoff with explicit permanent-error handling. Generic
 * backoff/jitter helpers remain for compatibility but do not drive workers.
 *
 * Features:
 * - Canonical deterministic worker retry decisions
 * - Optional jitter for standalone compatibility helpers
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
  PermanentJobError,
  decideJobRetry,
  isPermanentJobError,
  shouldRetryJob,
  createRetryPolicy,
  createAggressiveRetryPolicy,
  createConservativeRetryPolicy,
  createLinearRetryPolicy,
} from './retry-policy';
export type {
  CanonicalRetryDecision,
  CanonicalRetryOptions,
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
