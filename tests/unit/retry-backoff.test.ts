/**
 * Unit Tests: Retry and Backoff Logic
 * Tests exponential backoff, jitter, and retry strategies
 */

import { describe, it, expect } from 'vitest';
import {
  calculateBackoff,
  calculateRetryTime,
  addJitter,
} from '@taskflow/retry/backoff';
import { shouldRetryJob, createRetryPolicy } from '@taskflow/retry/retry-policy';
import {
  shouldDeadLetterJob,
  createDeadLetterEntry,
} from '@taskflow/retry/dead-letter';

describe('Retry Backoff', () => {
  describe('calculateBackoff', () => {
    it('should calculate exponential backoff correctly', () => {
      const backoff = calculateBackoff({
        strategy: 'exponential',
        baseDelay: 1000,
        factor: 2,
        maxDelay: 60000,
        attempt: 1,
      });

      expect(backoff).toBe(1000); // 1000 * 2^0
    });

    it('should apply factor correctly for attempt 2', () => {
      const backoff = calculateBackoff({
        strategy: 'exponential',
        baseDelay: 1000,
        factor: 2,
        maxDelay: 60000,
        attempt: 2,
      });

      expect(backoff).toBe(2000); // 1000 * 2^1
    });

    it('should apply factor correctly for attempt 3', () => {
      const backoff = calculateBackoff({
        strategy: 'exponential',
        baseDelay: 1000,
        factor: 2,
        maxDelay: 60000,
        attempt: 3,
      });

      expect(backoff).toBe(4000); // 1000 * 2^2
    });

    it('should cap at maxDelay', () => {
      const backoff = calculateBackoff({
        strategy: 'exponential',
        baseDelay: 1000,
        factor: 2,
        maxDelay: 5000,
        attempt: 10, // Would be 512000 without cap
      });

      expect(backoff).toBe(5000);
    });

    it('should handle linear backoff', () => {
      const backoff = calculateBackoff({
        strategy: 'linear',
        baseDelay: 1000,
        maxDelay: 60000,
        attempt: 3,
      });

      expect(backoff).toBe(3000); // 1000 * 3
    });

    it('should handle fibonacci backoff', () => {
      const backoff1 = calculateBackoff({
        strategy: 'fibonacci',
        baseDelay: 1000,
        maxDelay: 60000,
        attempt: 5,
      });

      // Fibonacci: 1, 1, 2, 3, 5
      expect(backoff1).toBe(5000);
    });

    it('should handle fixed backoff', () => {
      const backoff = calculateBackoff({
        strategy: 'fixed',
        baseDelay: 5000,
        maxDelay: 60000,
        attempt: 10,
      });

      expect(backoff).toBe(5000);
    });
  });

  describe('addJitter', () => {
    it('should add jitter within acceptable range', () => {
      const delay = 1000;
      const jitterFactor = 0.1; // 10%

      const results = Array.from({ length: 100 }, () =>
        addJitter(delay, jitterFactor)
      );

      results.forEach((result) => {
        expect(result).toBeGreaterThanOrEqual(900); // 1000 - 10%
        expect(result).toBeLessThanOrEqual(1100); // 1000 + 10%
      });
    });

    it('should return original delay with zero jitter', () => {
      const result = addJitter(1000, 0);
      expect(result).toBe(1000);
    });

    it('should handle negative jitter gracefully', () => {
      const result = addJitter(1000, -0.1);
      expect(result).toBe(1000);
    });
  });

  describe('calculateRetryTime', () => {
    it('should calculate future retry time', () => {
      const now = new Date();
      const delay = 1000;

      const retryTime = calculateRetryTime(delay, now);

      expect(retryTime.getTime()).toBeGreaterThanOrEqual(
        now.getTime() + delay
      );
      expect(retryTime.getTime()).toBeLessThan(now.getTime() + delay + 200);
    });

    it('should use current time when not provided', () => {
      const before = Date.now();
      const retryTime = calculateRetryTime(1000);
      const after = Date.now();

      expect(retryTime.getTime()).toBeGreaterThanOrEqual(before + 1000);
      expect(retryTime.getTime()).toBeLessThanOrEqual(after + 1200);
    });
  });
});

describe('Retry Policy', () => {
  describe('shouldRetryJob', () => {
    it('should retry when attempts < maxAttempts', () => {
      const decision = shouldRetryJob({
        attempts: 1,
        maxAttempts: 3,
        error: new Error('Temporary error'),
      });

      expect(decision.shouldRetry).toBe(true);
      expect(decision.reason).toContain('retryable');
    });

    it('should not retry when attempts >= maxAttempts', () => {
      const decision = shouldRetryJob({
        attempts: 3,
        maxAttempts: 3,
        error: new Error('Error'),
      });

      expect(decision.shouldRetry).toBe(false);
      expect(decision.reason).toContain('max attempts');
    });

    it('should not retry permanent errors', () => {
      const policy = createRetryPolicy({
        maxAttempts: 3,
        nonRetryableErrors: ['ValidationError'],
      });

      const error = new Error('Invalid input');
      error.name = 'ValidationError';

      const decision = shouldRetryJob({
        attempts: 1,
        maxAttempts: 3,
        error,
        policy,
      });

      expect(decision.shouldRetry).toBe(false);
      expect(decision.reason).toContain('non-retryable');
    });

    it('should calculate correct backoff for retryable error', () => {
      const decision = shouldRetryJob({
        attempts: 2,
        maxAttempts: 5,
        error: new Error('Temporary error'),
      });

      expect(decision.shouldRetry).toBe(true);
      expect(decision.retryAfter).toBeGreaterThan(0);
    });

    it('should respect custom retry policy', () => {
      const customPolicy = createRetryPolicy({
        maxAttempts: 1,
        backoffStrategy: 'fixed',
        baseDelay: 500,
      });

      const decision = shouldRetryJob({
        attempts: 0,
        maxAttempts: 1,
        error: new Error('Error'),
        policy: customPolicy,
      });

      expect(decision.shouldRetry).toBe(true);
      expect(decision.retryAfter).toBe(500);
    });
  });

  describe('createRetryPolicy', () => {
    it('should create policy with default values', () => {
      const policy = createRetryPolicy({});

      expect(policy.maxAttempts).toBe(3);
      expect(policy.backoffStrategy).toBe('exponential');
      expect(policy.baseDelay).toBe(1000);
    });

    it('should create policy with custom values', () => {
      const policy = createRetryPolicy({
        maxAttempts: 5,
        backoffStrategy: 'linear',
        baseDelay: 2000,
        maxDelay: 30000,
      });

      expect(policy.maxAttempts).toBe(5);
      expect(policy.backoffStrategy).toBe('linear');
      expect(policy.baseDelay).toBe(2000);
      expect(policy.maxDelay).toBe(30000);
    });

    it('should include non-retryable errors', () => {
      const policy = createRetryPolicy({
        nonRetryableErrors: ['ValidationError', 'AuthorizationError'],
      });

      expect(policy.nonRetryableErrors).toContain('ValidationError');
      expect(policy.nonRetryableErrors).toContain('AuthorizationError');
    });
  });
});

describe('Dead Letter Queue', () => {
  describe('shouldDeadLetterJob', () => {
    it('should dead-letter when max attempts reached', () => {
      const decision = shouldDeadLetterJob({
        attempts: 3,
        maxAttempts: 3,
        status: 'FAILED',
      });

      expect(decision.shouldDeadLetter).toBe(true);
      expect(decision.reason).toContain('Max attempts');
    });

    it('should dead-letter for permanent failures', () => {
      const error = new Error('Fatal error');
      error.name = 'FatalError';

      const decision = shouldDeadLetterJob({
        attempts: 1,
        maxAttempts: 3,
        status: 'FAILED',
        error,
        permanentFailures: ['FatalError'],
      });

      expect(decision.shouldDeadLetter).toBe(true);
      expect(decision.reason).toContain('permanent failure');
    });

    it('should not dead-letter when retries remain', () => {
      const decision = shouldDeadLetterJob({
        attempts: 1,
        maxAttempts: 3,
        status: 'FAILED',
      });

      expect(decision.shouldDeadLetter).toBe(false);
    });

    it('should not dead-letter non-failed jobs', () => {
      const decision = shouldDeadLetterJob({
        attempts: 3,
        maxAttempts: 3,
        status: 'PROCESSING',
      });

      expect(decision.shouldDeadLetter).toBe(false);
    });
  });

  describe('createDeadLetterEntry', () => {
    it('should create valid DLQ entry', () => {
      const jobId = 'job-123';
      const error = new Error('Test error');

      const entry = createDeadLetterEntry({
        jobId,
        queue: 'default',
        type: 'test-job',
        payload: { data: 'test' },
        attempts: 3,
        error,
      });

      expect(entry.jobId).toBe(jobId);
      expect(entry.queue).toBe('default');
      expect(entry.type).toBe('test-job');
      expect(entry.attempts).toBe(3);
      expect(entry.error).toContain('Test error');
      expect(entry.deadLetteredAt).toBeInstanceOf(Date);
    });

    it('should include metadata when provided', () => {
      const entry = createDeadLetterEntry({
        jobId: 'job-123',
        queue: 'default',
        type: 'test-job',
        payload: {},
        attempts: 3,
        error: new Error('Error'),
        metadata: { customField: 'value' },
      });

      expect(entry.metadata).toEqual({ customField: 'value' });
    });

    it('should serialize payload correctly', () => {
      const payload = { nested: { data: [1, 2, 3] } };

      const entry = createDeadLetterEntry({
        jobId: 'job-123',
        queue: 'default',
        type: 'test-job',
        payload,
        attempts: 3,
        error: new Error('Error'),
      });

      expect(entry.payload).toEqual(payload);
    });
  });
});

describe('Retry Storm Protection', () => {
  it('should prevent rapid retry storms with backoff', () => {
    const attempts = [1, 2, 3, 4, 5];
    const delays = attempts.map((attempt) =>
      calculateBackoff({
        strategy: 'exponential',
        baseDelay: 1000,
        factor: 2,
        maxDelay: 60000,
        attempt,
      })
    );

    // Verify delays are increasing
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }
  });

  it('should cap total retry time at reasonable limit', () => {
    const totalDelay = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].reduce(
      (sum, attempt) =>
        sum +
        calculateBackoff({
          strategy: 'exponential',
          baseDelay: 1000,
          factor: 2,
          maxDelay: 60000,
          attempt,
        }),
      0
    );

    // Should not exceed reasonable total (e.g., 10 minutes for 10 attempts)
    expect(totalDelay).toBeLessThan(600000);
  });
});
