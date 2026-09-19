import { describe, it, expect } from 'vitest';

import {
  shouldRetryJob,
  createRetryPolicy,
  DEFAULT_RETRY_POLICY,
  NON_RETRYABLE_ERRORS,
  RETRYABLE_ERRORS,
  PermanentJobError,
  decideJobRetry,
} from '../retry-policy';

describe('RetryPolicy', () => {
  describe('shouldRetryJob', () => {
    it('should retry when attempts below max', () => {
      const policy = createRetryPolicy({ maxAttempts: 3 });
      const createdAt = new Date();

      const decision = shouldRetryJob(0, 'Some error', createdAt, policy);

      expect(decision.shouldRetry).toBe(true);
      expect(decision.nextAttempt).toBe(1);
      expect(decision.scheduledAt).toBeDefined();
    });

    it('should not retry when max attempts reached', () => {
      const policy = createRetryPolicy({ maxAttempts: 3 });
      const createdAt = new Date();

      const decision = shouldRetryJob(3, 'Some error', createdAt, policy);

      expect(decision.shouldRetry).toBe(false);
      expect(decision.reason).toContain('Max attempts reached');
    });

    it('should not retry when retry timeout exceeded', () => {
      const policy = createRetryPolicy({
        maxAttempts: 5,
        retryTimeoutMs: 10000, // 10 seconds
      });
      const createdAt = new Date(Date.now() - 11000); // 11 seconds ago

      const decision = shouldRetryJob(1, 'Some error', createdAt, policy);

      expect(decision.shouldRetry).toBe(false);
      expect(decision.reason).toContain('Retry timeout exceeded');
    });

    it('should not retry for non-retryable errors', () => {
      const policy = createRetryPolicy({
        maxAttempts: 3,
        nonRetryableErrors: ['ValidationError', 'AuthenticationError'],
      });
      const createdAt = new Date();

      const decision = shouldRetryJob(
        1,
        'ValidationError: Invalid input',
        createdAt,
        policy
      );

      expect(decision.shouldRetry).toBe(false);
      expect(decision.reason).toContain('Non-retryable error');
    });

    it('should retry only for retryable errors when specified', () => {
      const policy = createRetryPolicy({
        maxAttempts: 3,
        retryableErrors: ['TimeoutError', 'NetworkError'],
      });
      const createdAt = new Date();

      // Retryable error - should retry
      const retryableDecision = shouldRetryJob(
        1,
        'TimeoutError: Request timed out',
        createdAt,
        policy
      );
      expect(retryableDecision.shouldRetry).toBe(true);

      // Non-matching error - should not retry
      const nonMatchingDecision = shouldRetryJob(
        1,
        'Some other error',
        createdAt,
        policy
      );
      expect(nonMatchingDecision.shouldRetry).toBe(false);
    });

    it('should use default policy when none provided', () => {
      const createdAt = new Date();

      const decision = shouldRetryJob(0, 'Some error', createdAt);

      expect(decision.shouldRetry).toBe(true);
      expect(decision.scheduledAt).toBeDefined();
    });
  });

  describe('createRetryPolicy', () => {
    it('should create policy with defaults', () => {
      const policy = createRetryPolicy();

      expect(policy.maxAttempts).toBe(DEFAULT_RETRY_POLICY.maxAttempts);
      expect(policy.backoff).toEqual(DEFAULT_RETRY_POLICY.backoff);
    });

    it('should merge overrides with defaults', () => {
      const policy = createRetryPolicy({
        maxAttempts: 5,
        backoff: {
          baseDelayMs: 2000,
        },
      });

      expect(policy.maxAttempts).toBe(5);
      expect(policy.backoff?.baseDelayMs).toBe(2000);
      expect(policy.backoff?.strategy).toBe(
        DEFAULT_RETRY_POLICY.backoff?.strategy
      );
    });
  });

  describe('Error Patterns', () => {
    it('should include common non-retryable errors', () => {
      expect(NON_RETRYABLE_ERRORS).toContain('ValidationError');
      expect(NON_RETRYABLE_ERRORS).toContain('AuthenticationError');
      expect(NON_RETRYABLE_ERRORS).toContain('AuthorizationError');
      expect(NON_RETRYABLE_ERRORS).toContain('NotFoundError');
    });

    it('should include common retryable errors', () => {
      expect(RETRYABLE_ERRORS).toContain('TimeoutError');
      expect(RETRYABLE_ERRORS).toContain('NetworkError');
      expect(RETRYABLE_ERRORS).toContain('ConnectionError');
      expect(RETRYABLE_ERRORS).toContain('ServiceUnavailable');
    });
  });

  describe('decideJobRetry', () => {
    it('uses deterministic bounded exponential delays for the runtime path', () => {
      const first = decideJobRetry({
        currentAttempt: 1,
        maxAttempts: 4,
        error: new Error('temporary'),
        jobCreatedAt: new Date(),
        baseDelayMs: 300,
        maxDelayMs: 600,
      });
      const second = decideJobRetry({
        currentAttempt: 2,
        maxAttempts: 4,
        error: new Error('temporary'),
        jobCreatedAt: new Date(),
        baseDelayMs: 300,
        maxDelayMs: 600,
      });
      const capped = decideJobRetry({
        currentAttempt: 3,
        maxAttempts: 4,
        error: new Error('temporary'),
        jobCreatedAt: new Date(),
        baseDelayMs: 300,
        maxDelayMs: 600,
      });

      expect(first).toMatchObject({ shouldRetry: true, delayMs: 300 });
      expect(second).toMatchObject({ shouldRetry: true, delayMs: 600 });
      expect(capped).toMatchObject({ shouldRetry: true, delayMs: 600 });
    });

    it('stops immediately for an explicit permanent handler failure', () => {
      expect(
        decideJobRetry({
          currentAttempt: 1,
          maxAttempts: 5,
          error: new PermanentJobError('invalid payload', 'INVALID_PAYLOAD'),
          jobCreatedAt: new Date(),
          baseDelayMs: 100,
          maxDelayMs: 1000,
        })
      ).toEqual({ shouldRetry: false, reason: 'PERMANENT_ERROR' });
    });

    it('makes the attempt budget authoritative before error classification', () => {
      expect(
        decideJobRetry({
          currentAttempt: 3,
          maxAttempts: 3,
          error: new Error('temporary'),
          jobCreatedAt: new Date(),
          baseDelayMs: 100,
          maxDelayMs: 1000,
        })
      ).toEqual({ shouldRetry: false, reason: 'ATTEMPTS_EXHAUSTED' });
    });
  });
});
