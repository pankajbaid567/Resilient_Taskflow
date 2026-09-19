/**
 * Backoff Strategy
 *
 * Determines the delay before retrying a failed job.
 */
export type BackoffStrategy = 'exponential' | 'linear' | 'fixed' | 'fibonacci';

/**
 * Backoff Configuration
 */
export interface BackoffConfig {
  /**
   * Backoff strategy
   * Default: 'exponential'
   */
  strategy?: BackoffStrategy;

  /**
   * Base delay in milliseconds
   * Default: 1000 (1 second)
   */
  baseDelayMs?: number;

  /**
   * Maximum delay in milliseconds
   * Default: 60000 (1 minute)
   */
  maxDelayMs?: number;

  /**
   * Exponential factor
   * Only for exponential strategy
   * Default: 2
   */
  factor?: number;

  /**
   * Enable jitter
   * Adds randomness to prevent thundering herd
   * Default: true
   */
  enableJitter?: boolean;

  /**
   * Jitter factor (0-1)
   * Amount of randomness to add
   * Default: 0.1 (10%)
   */
  jitterFactor?: number;
}

/**
 * Calculate retry delay based on backoff strategy
 */
export function calculateBackoff(
  attempt: number,
  config: BackoffConfig = {}
): number {
  const {
    strategy = 'exponential',
    baseDelayMs = 1000,
    maxDelayMs = 60000,
    factor = 2,
    enableJitter = true,
    jitterFactor = 0.1,
  } = config;

  let delay: number;

  switch (strategy) {
    case 'exponential':
      delay = baseDelayMs * Math.pow(factor, attempt);
      break;

    case 'linear':
      delay = baseDelayMs * (attempt + 1);
      break;

    case 'fixed':
      delay = baseDelayMs;
      break;

    case 'fibonacci':
      delay = baseDelayMs * fibonacci(attempt + 1);
      break;

    default:
      throw new Error('Unknown backoff strategy');
  }

  // Cap at max delay
  delay = Math.min(delay, maxDelayMs);

  // Add jitter
  if (enableJitter) {
    delay = addJitter(delay, jitterFactor);
  }

  return Math.floor(delay);
}

/**
 * Calculate scheduled retry time
 */
export function calculateRetryTime(
  attempt: number,
  config: BackoffConfig = {}
): Date {
  const delay = calculateBackoff(attempt, config);
  return new Date(Date.now() + delay);
}

/**
 * Add jitter to delay
 *
 * Jitter prevents thundering herd problem when many jobs fail simultaneously.
 * Uses full jitter algorithm: random value between 0 and calculated delay.
 */
function addJitter(delay: number, jitterFactor: number): number {
  const jitterAmount = delay * jitterFactor;
  const randomJitter = Math.random() * jitterAmount * 2 - jitterAmount;
  return delay + randomJitter;
}

/**
 * Calculate nth Fibonacci number
 * Used for Fibonacci backoff strategy
 */
function fibonacci(n: number): number {
  if (n <= 1) return 1;
  if (n === 2) return 2;

  let a = 1;
  let b = 2;

  for (let i = 3; i <= n; i++) {
    const temp = a + b;
    a = b;
    b = temp;
  }

  return b;
}

/**
 * Get human-readable delay description
 */
export function formatDelay(delayMs: number): string {
  if (delayMs < 1000) {
    return `${delayMs}ms`;
  }

  if (delayMs < 60000) {
    return `${Math.round(delayMs / 1000)}s`;
  }

  if (delayMs < 3600000) {
    return `${Math.round(delayMs / 60000)}m`;
  }

  return `${Math.round(delayMs / 3600000)}h`;
}

/**
 * Preview backoff schedule
 *
 * Useful for debugging and configuration tuning.
 */
export function previewBackoffSchedule(
  maxAttempts: number,
  config: BackoffConfig = {}
): Array<{ attempt: number; delayMs: number; delayFormatted: string }> {
  const schedule: Array<{
    attempt: number;
    delayMs: number;
    delayFormatted: string;
  }> = [];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const delayMs = calculateBackoff(attempt, config);
    schedule.push({
      attempt: attempt + 1,
      delayMs,
      delayFormatted: formatDelay(delayMs),
    });
  }

  return schedule;
}
