# @taskflow/retry

Retry decisions and standalone backoff utilities for failed jobs.

The TaskFlow worker has one authoritative entry point: `decideJobRetry`. It
uses bounded exponential backoff without jitter so the exact due time can be
persisted with the failed attempt, event, and successor delivery in one
PostgreSQL transaction. `PermanentJobError` terminates immediately; exhausted
attempts become dead-lettered without a successor.

`shouldRetryJob` and the configurable jitter helpers below are compatibility
utilities. They do not drive the TaskFlow worker runtime.

```typescript
import { decideJobRetry, PermanentJobError } from '@taskflow/retry';

const decision = decideJobRetry({
  currentAttempt,
  maxAttempts,
  error,
  jobCreatedAt,
  baseDelayMs: 1000,
  maxDelayMs: 60000,
});
```

## Features

- **Multiple Backoff Strategies**: Exponential, linear, fixed, Fibonacci
- **Jitter Support**: Prevents thundering herd problem
- **Retry Policies**: Configure max attempts, timeouts, error patterns
- **Dead Letter Queue**: Handle permanently failed jobs
- **Statistics**: Track DLQ metrics and alerting

## Compatibility utilities

```typescript
import {
  shouldRetryJob,
  createRetryPolicy,
  calculateBackoff,
} from '@taskflow/retry';

// Create retry policy
const policy = createRetryPolicy({
  maxAttempts: 3,
  backoff: {
    strategy: 'exponential',
    baseDelayMs: 1000,
    maxDelayMs: 60000,
    enableJitter: true,
  },
});

// Check if job should retry
const decision = shouldRetryJob(
  currentAttempt,
  errorMessage,
  jobCreatedAt,
  policy
);

if (decision.shouldRetry) {
  console.log(`Retry scheduled for: ${decision.scheduledAt}`);
  console.log(`Attempt: ${decision.nextAttempt}`);
} else {
  console.log(`Not retrying: ${decision.reason}`);
}
```

## Backoff Strategies

### Exponential Backoff (Default)

Delay doubles with each attempt:

```typescript
const delay = calculateBackoff(attempt, {
  strategy: 'exponential',
  baseDelayMs: 1000,
  maxDelayMs: 60000,
  factor: 2,
});

// Attempt 0: 1s
// Attempt 1: 2s
// Attempt 2: 4s
// Attempt 3: 8s
// Attempt 4: 16s
// Attempt 5: 32s
// Attempt 6: 60s (capped)
```

### Linear Backoff

Delay increases linearly:

```typescript
const delay = calculateBackoff(attempt, {
  strategy: 'linear',
  baseDelayMs: 2000,
});

// Attempt 0: 2s
// Attempt 1: 4s
// Attempt 2: 6s
// Attempt 3: 8s
```

### Fixed Backoff

Constant delay:

```typescript
const delay = calculateBackoff(attempt, {
  strategy: 'fixed',
  baseDelayMs: 5000,
});

// Attempt 0: 5s
// Attempt 1: 5s
// Attempt 2: 5s
```

### Fibonacci Backoff

Delay follows Fibonacci sequence:

```typescript
const delay = calculateBackoff(attempt, {
  strategy: 'fibonacci',
  baseDelayMs: 1000,
});

// Attempt 0: 1s (1)
// Attempt 1: 2s (2)
// Attempt 2: 3s (3)
// Attempt 3: 5s (5)
// Attempt 4: 8s (8)
// Attempt 5: 13s (13)
```

## Jitter

Jitter adds randomness to prevent thundering herd:

```typescript
const delay = calculateBackoff(attempt, {
  strategy: 'exponential',
  baseDelayMs: 1000,
  enableJitter: true,
  jitterFactor: 0.1, // ±10%
});

// Attempt 2: ~4000ms ±400ms (3600-4400ms)
```

Why jitter?

- Prevents many jobs from retrying simultaneously
- Spreads load over time
- Reduces resource contention

## Retry Policies

### Default Policy

```typescript
const policy = createRetryPolicy();

// Default configuration:
// - maxAttempts: 3
// - Exponential backoff (1s, 2s, 4s)
// - Jitter enabled (10%)
// - Max delay: 60 seconds
```

### Custom Policy

```typescript
const policy = createRetryPolicy({
  maxAttempts: 5,
  retryTimeoutMs: 300000, // 5 minutes
  backoff: {
    strategy: 'exponential',
    baseDelayMs: 2000,
    maxDelayMs: 120000,
    factor: 3,
  },
  retryableErrors: ['TimeoutError', 'NetworkError', 'ECONNREFUSED'],
  nonRetryableErrors: ['ValidationError', 'AuthenticationError'],
});
```

### Preset Policies

```typescript
import {
  createAggressiveRetryPolicy,
  createConservativeRetryPolicy,
  createLinearRetryPolicy,
} from '@taskflow/retry';

// Aggressive: More attempts, faster retries
const aggressive = createAggressiveRetryPolicy();
// 5 attempts: 500ms, 750ms, 1125ms, 1687ms, 2531ms

// Conservative: Fewer attempts, longer delays
const conservative = createConservativeRetryPolicy();
// 2 attempts: 5s, 15s

// Linear: Simple linear backoff
const linear = createLinearRetryPolicy(3, 2000);
// 3 attempts: 2s, 4s, 6s
```

## Error Patterns

### Non-Retryable Errors

Never retry these errors:

```typescript
import { NON_RETRYABLE_ERRORS } from '@taskflow/retry';

// Includes:
// - ValidationError
// - AuthenticationError
// - AuthorizationError
// - NotFoundError
// - BadRequestError
// - Permission denied
// - Unauthorized
// - Forbidden
```

### Retryable Errors

Safe to retry:

```typescript
import { RETRYABLE_ERRORS } from '@taskflow/retry';

// Includes:
// - TimeoutError
// - NetworkError
// - ConnectionError
// - ServiceUnavailable
// - RateLimitError
// - ECONNREFUSED
// - ETIMEDOUT
// - 503, 502, 429
```

### Custom Error Patterns

```typescript
const policy = createRetryPolicy({
  // Only retry these errors
  retryableErrors: ['DatabaseTimeout', 'ConnectionPool', 'TemporaryFailure'],

  // Never retry these errors
  nonRetryableErrors: ['InvalidAPIKey', 'QuotaExceeded', 'DataCorruption'],
});
```

## Retry Decision Logic

```typescript
const decision = shouldRetryJob(
  currentAttempt,
  errorMessage,
  jobCreatedAt,
  policy
);

// Decision checks (in order):
// 1. Max attempts reached? → Don't retry
// 2. Retry timeout exceeded? → Don't retry
// 3. Non-retryable error? → Don't retry
// 4. Retryable error (if specified)? → Retry
// 5. Otherwise → Retry

if (decision.shouldRetry) {
  // Schedule retry
  await scheduleJob(jobId, decision.scheduledAt);
} else {
  // Move to DLQ
  await moveToDeadLetterQueue(jobId, decision.reason);
}
```

## Dead Letter Queue

### Determine if Job Should Be Dead-Lettered

```typescript
import { shouldDeadLetterJob } from '@taskflow/retry';

const decision = shouldDeadLetterJob(
  job,
  currentAttempt,
  maxAttempts,
  errorMessage
);

if (decision.shouldDeadLetter) {
  console.log(`Dead letter reason: ${decision.reason}`);
  // Reasons: 'max_attempts_exceeded', 'non_retryable_error'
}
```

### Create DLQ Entry

```typescript
import { createDeadLetterEntry } from '@taskflow/retry';

const entry = createDeadLetterEntry(job, 'max_attempts_exceeded');

await insertDeadLetterJob(entry);
```

### DLQ Statistics

```typescript
import { calculateDLQStats, isDLQAlerting } from '@taskflow/retry';

// Get DLQ entries from database
const entries = await getDeadLetterJobs();

// Calculate statistics
const stats = calculateDLQStats(entries);

console.log({
  totalJobs: stats.totalJobs,
  byReason: stats.byReason,
  byJobType: stats.byJobType,
  oldestJob: stats.oldestJob,
  newestJob: stats.newestJob,
});

// Check if alerting needed
if (
  isDLQAlerting(stats, {
    maxJobs: 1000,
    maxNonRetryablePercent: 0.5,
    maxJobTypePercent: 0.8,
  })
) {
  console.log('⚠️ DLQ requires attention!');
}
```

## Preview Backoff Schedule

Useful for debugging and configuration:

```typescript
import { previewBackoffSchedule } from '@taskflow/retry';

const schedule = previewBackoffSchedule(5, {
  strategy: 'exponential',
  baseDelayMs: 1000,
  factor: 2,
});

console.table(schedule);
/*
┌─────────┬─────────┬─────────┬─────────────────┐
│ (index) │ attempt │ delayMs │ delayFormatted  │
├─────────┼─────────┼─────────┼─────────────────┤
│    0    │    1    │  1000   │      '1s'       │
│    1    │    2    │  2000   │      '2s'       │
│    2    │    3    │  4000   │      '4s'       │
│    3    │    4    │  8000   │      '8s'       │
│    4    │    5    │ 16000   │      '16s'      │
└─────────┴─────────┴─────────┴─────────────────┘
*/
```

## Integration with Worker

```typescript
import { Worker } from '@taskflow/worker';
import { shouldRetryJob, createRetryPolicy } from '@taskflow/retry';
import { scheduleJobRetry, moveToDeadLetter } from '@taskflow/database';

class WorkerWithRetry extends Worker {
  private retryPolicy = createRetryPolicy({
    maxAttempts: 3,
    backoff: {
      strategy: 'exponential',
      baseDelayMs: 1000,
    },
  });

  async handleJobFailure(job: Job, error: Error): Promise<void> {
    const decision = shouldRetryJob(
      job.attempts,
      error.message,
      job.createdAt,
      this.retryPolicy
    );

    if (decision.shouldRetry) {
      // Schedule retry
      await scheduleJobRetry(job.id, decision.scheduledAt!);
      this.logger.info('Job scheduled for retry', {
        jobId: job.id,
        attempt: decision.nextAttempt,
        scheduledAt: decision.scheduledAt,
      });
    } else {
      // Move to DLQ
      await moveToDeadLetter(job, decision.reason);
      this.logger.warn('Job moved to DLQ', {
        jobId: job.id,
        reason: decision.reason,
      });
    }
  }
}
```

## Best Practices

### Choose the Right Strategy

**Exponential Backoff** (default)

- ✅ Best for most cases
- ✅ Backs off quickly
- ✅ Prevents overwhelming downstream services
- ❌ May wait too long for later attempts

**Linear Backoff**

- ✅ Predictable delays
- ✅ Good for consistent failures
- ❌ Doesn't back off aggressively

**Fixed Backoff**

- ✅ Simple and predictable
- ✅ Good when you know the failure pattern
- ❌ No adaptation to failure severity

**Fibonacci Backoff**

- ✅ Balanced growth
- ✅ Not as aggressive as exponential
- ❌ More complex

### Configure Max Attempts

```typescript
// Transient errors: More attempts
const transientPolicy = createRetryPolicy({
  maxAttempts: 5,
  retryableErrors: ['TimeoutError', 'NetworkError'],
});

// External API: Fewer attempts
const externalPolicy = createRetryPolicy({
  maxAttempts: 2,
  backoff: { baseDelayMs: 5000 },
});

// Critical jobs: More aggressive
const criticalPolicy = createAggressiveRetryPolicy();
```

### Use Error Patterns

```typescript
// Be specific about what to retry
const policy = createRetryPolicy({
  retryableErrors: [
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ServiceUnavailable',
  ],
  nonRetryableErrors: [
    'InvalidCredentials',
    'QuotaExceeded',
    'RateLimitPermanent',
  ],
});
```

### Monitor DLQ

```typescript
// Regular DLQ monitoring
setInterval(async () => {
  const entries = await getDeadLetterJobs();
  const stats = calculateDLQStats(entries);

  if (isDLQAlerting(stats)) {
    await sendAlert('DLQ requires attention', stats);
  }
}, 300000); // Every 5 minutes
```

### Set Retry Timeouts

```typescript
// Prevent infinite retries
const policy = createRetryPolicy({
  maxAttempts: 10,
  retryTimeoutMs: 3600000, // 1 hour max
});
```

## Testing

```typescript
import { describe, it, expect } from 'vitest';
import { calculateBackoff, shouldRetryJob } from '@taskflow/retry';

describe('Retry Logic', () => {
  it('should calculate correct backoff', () => {
    const delay = calculateBackoff(2, {
      strategy: 'exponential',
      baseDelayMs: 1000,
      factor: 2,
      enableJitter: false,
    });

    expect(delay).toBe(4000); // 1000 * 2^2
  });

  it('should retry on retryable error', () => {
    const decision = shouldRetryJob(1, 'TimeoutError', new Date(), {
      maxAttempts: 3,
      retryableErrors: ['TimeoutError'],
    });

    expect(decision.shouldRetry).toBe(true);
  });
});
```

## License

MIT
