import { BackoffConfig, calculateRetryTime } from './backoff';

/**
 * Retry Policy
 * 
 * Defines when and how to retry failed jobs.
 */
export interface RetryPolicy {
  /**
   * Maximum retry attempts
   * Default: 3
   */
  maxAttempts?: number;

  /**
   * Backoff configuration
   */
  backoff?: BackoffConfig;

  /**
   * Retryable error patterns
   * Only retry if error matches one of these patterns
   */
  retryableErrors?: string[];

  /**
   * Non-retryable error patterns
   * Never retry if error matches one of these patterns
   */
  nonRetryableErrors?: string[];

  /**
   * Retry timeout in milliseconds
   * If job hasn't succeeded within this time, stop retrying
   */
  retryTimeoutMs?: number;
}

/**
 * Retry Decision
 */
export interface RetryDecision {
  /**
   * Should retry?
   */
  shouldRetry: boolean;

  /**
   * Scheduled retry time
   * Only set if shouldRetry is true
   */
  scheduledAt?: Date;

  /**
   * Reason for decision
   */
  reason: string;

  /**
   * Next attempt number
   */
  nextAttempt?: number;
}

/**
 * Default retry policy
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  backoff: {
    strategy: 'exponential',
    baseDelayMs: 1000,
    maxDelayMs: 60000,
    factor: 2,
    enableJitter: true,
    jitterFactor: 0.1,
  },
};

/**
 * Determine if job should be retried
 */
export function shouldRetryJob(
  currentAttempt: number,
  error: string | null,
  jobCreatedAt: Date,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY
): RetryDecision {
  const maxAttempts = policy.maxAttempts || 3;

  // Check if max attempts reached
  if (currentAttempt >= maxAttempts) {
    return {
      shouldRetry: false,
      reason: `Max attempts reached (${maxAttempts})`,
    };
  }

  // Check retry timeout
  if (policy.retryTimeoutMs) {
    const elapsed = Date.now() - jobCreatedAt.getTime();
    if (elapsed >= policy.retryTimeoutMs) {
      return {
        shouldRetry: false,
        reason: `Retry timeout exceeded (${policy.retryTimeoutMs}ms)`,
      };
    }
  }

  // Check non-retryable errors
  if (error && policy.nonRetryableErrors) {
    for (const pattern of policy.nonRetryableErrors) {
      if (error.includes(pattern)) {
        return {
          shouldRetry: false,
          reason: `Non-retryable error: ${pattern}`,
        };
      }
    }
  }

  // Check retryable errors (if specified)
  if (error && policy.retryableErrors && policy.retryableErrors.length > 0) {
    let isRetryable = false;

    for (const pattern of policy.retryableErrors) {
      if (error.includes(pattern)) {
        isRetryable = true;
        break;
      }
    }

    if (!isRetryable) {
      return {
        shouldRetry: false,
        reason: 'Error does not match retryable patterns',
      };
    }
  }

  // Calculate next retry time
  const scheduledAt = calculateRetryTime(currentAttempt, policy.backoff);

  return {
    shouldRetry: true,
    scheduledAt,
    reason: `Retry attempt ${currentAttempt + 1} of ${maxAttempts}`,
    nextAttempt: currentAttempt + 1,
  };
}

/**
 * Common non-retryable error patterns
 */
export const NON_RETRYABLE_ERRORS = [
  'ValidationError',
  'AuthenticationError',
  'AuthorizationError',
  'NotFoundError',
  'BadRequestError',
  'Invalid input',
  'Invalid payload',
  'Permission denied',
  'Unauthorized',
  'Forbidden',
];

/**
 * Common retryable error patterns
 */
export const RETRYABLE_ERRORS = [
  'TimeoutError',
  'NetworkError',
  'ConnectionError',
  'ServiceUnavailable',
  'RateLimitError',
  'TemporaryError',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  '503',
  '502',
  '429',
];

/**
 * Create retry policy with common defaults
 */
export function createRetryPolicy(
  overrides: Partial<RetryPolicy> = {}
): RetryPolicy {
  return {
    ...DEFAULT_RETRY_POLICY,
    ...overrides,
    backoff: {
      ...DEFAULT_RETRY_POLICY.backoff,
      ...overrides.backoff,
    },
  };
}

/**
 * Create aggressive retry policy
 * More attempts, faster retries
 */
export function createAggressiveRetryPolicy(): RetryPolicy {
  return createRetryPolicy({
    maxAttempts: 5,
    backoff: {
      strategy: 'exponential',
      baseDelayMs: 500,
      maxDelayMs: 30000,
      factor: 1.5,
      enableJitter: true,
    },
  });
}

/**
 * Create conservative retry policy
 * Fewer attempts, longer delays
 */
export function createConservativeRetryPolicy(): RetryPolicy {
  return createRetryPolicy({
    maxAttempts: 2,
    backoff: {
      strategy: 'exponential',
      baseDelayMs: 5000,
      maxDelayMs: 120000,
      factor: 3,
      enableJitter: true,
    },
  });
}

/**
 * Create linear retry policy
 * Simple linear backoff
 */
export function createLinearRetryPolicy(
  maxAttempts: number = 3,
  delayMs: number = 2000
): RetryPolicy {
  return createRetryPolicy({
    maxAttempts,
    backoff: {
      strategy: 'linear',
      baseDelayMs: delayMs,
      maxDelayMs: delayMs * maxAttempts,
      enableJitter: false,
    },
  });
}
