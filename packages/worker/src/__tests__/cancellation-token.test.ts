import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  CancellationToken,
  CancellationError,
  createCancellationToken,
  checkCancellation,
  createTimeoutCancellationToken,
  combineCancellationTokens,
} from '../cancellation-token';

describe('CancellationToken', () => {
  let token: CancellationToken;

  beforeEach(() => {
    token = new CancellationToken();
  });

  describe('constructor', () => {
    it('should initialize with not cancelled', () => {
      expect(token.isCancellationRequested).toBe(false);
    });
  });

  describe('cancel', () => {
    it('should set cancelled flag', () => {
      token.cancel();
      expect(token.isCancellationRequested).toBe(true);
    });

    it('should be idempotent', () => {
      token.cancel();
      token.cancel();
      expect(token.isCancellationRequested).toBe(true);
    });
  });

  describe('throwIfCancellationRequested', () => {
    it('should not throw if not cancelled', () => {
      expect(() => token.throwIfCancellationRequested()).not.toThrow();
    });

    it('should throw if cancelled', () => {
      token.cancel();
      expect(() => token.throwIfCancellationRequested()).toThrow(
        CancellationError
      );
    });

    it('should throw with correct message', () => {
      token.cancel();
      try {
        token.throwIfCancellationRequested();
      } catch (error) {
        expect(error).toBeInstanceOf(CancellationError);
        expect((error as Error).message).toBe('Job cancellation requested');
      }
    });
  });

  describe('onCancellationRequested', () => {
    it('should register callback', () => {
      const callback = vi.fn();

      token.onCancellationRequested(callback);
      token.cancel();

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should support multiple callbacks', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      token.onCancellationRequested(callback1);
      token.onCancellationRequested(callback2);
      token.cancel();

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
    });

    it('should not call callback if already cancelled', () => {
      const callback = vi.fn();

      token.cancel();
      token.onCancellationRequested(callback);

      // Callback not called for already-cancelled token
      expect(callback).not.toHaveBeenCalled();
    });

    it('should return unsubscribe function', () => {
      const callback = vi.fn();

      const unsubscribe = token.onCancellationRequested(callback);
      unsubscribe();
      token.cancel();

      expect(callback).not.toHaveBeenCalled();
    });

    it('should handle callback errors gracefully', () => {
      const errorCallback = vi.fn(() => {
        throw new Error('Callback error');
      });
      const successCallback = vi.fn();

      token.onCancellationRequested(errorCallback);
      token.onCancellationRequested(successCallback);

      // Should not throw
      expect(() => token.cancel()).not.toThrow();

      // Success callback should still be called
      expect(successCallback).toHaveBeenCalledTimes(1);
    });
  });

  describe('createChildToken', () => {
    it('should create child token', () => {
      const child = token.createChildToken();

      expect(child).toBeInstanceOf(CancellationToken);
      expect(child.isCancellationRequested).toBe(false);
    });

    it('should cancel child when parent is cancelled', () => {
      const child = token.createChildToken();

      token.cancel();

      expect(child.isCancellationRequested).toBe(true);
    });

    it('should not cancel parent when child is cancelled', () => {
      const child = token.createChildToken();

      child.cancel();

      expect(token.isCancellationRequested).toBe(false);
    });

    it('should create already-cancelled child if parent is cancelled', () => {
      token.cancel();

      const child = token.createChildToken();

      expect(child.isCancellationRequested).toBe(true);
    });
  });
});

describe('CancellationError', () => {
  it('should create error with default message', () => {
    const error = new CancellationError();

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(CancellationError);
    expect(error.message).toBe('Operation cancelled');
    expect(error.name).toBe('CancellationError');
  });

  it('should create error with custom message', () => {
    const error = new CancellationError('Custom message');

    expect(error.message).toBe('Custom message');
  });

  it('should have correct prototype', () => {
    const error = new CancellationError();

    expect(Object.getPrototypeOf(error)).toBe(CancellationError.prototype);
  });
});

describe('createCancellationToken', () => {
  it('should create new token', () => {
    const token = createCancellationToken();

    expect(token).toBeInstanceOf(CancellationToken);
    expect(token.isCancellationRequested).toBe(false);
  });
});

describe('checkCancellation', () => {
  it('should not throw if not cancelled', async () => {
    const token = createCancellationToken();

    await expect(checkCancellation(token)).resolves.toBeUndefined();
  });

  it('should throw if cancelled', async () => {
    const token = createCancellationToken();
    token.cancel();

    await expect(checkCancellation(token)).rejects.toThrow(CancellationError);
  });

  it('should delay if delayMs provided', async () => {
    const token = createCancellationToken();
    const start = Date.now();

    await checkCancellation(token, 100);

    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(100);
  });

  it('should check cancellation after delay', async () => {
    const token = createCancellationToken();

    const promise = checkCancellation(token, 100);

    // Cancel during delay
    setTimeout(() => token.cancel(), 50);

    await expect(promise).rejects.toThrow(CancellationError);
  });
});

describe('createTimeoutCancellationToken', () => {
  it('should create token that cancels after timeout', async () => {
    vi.useFakeTimers();

    const token = createTimeoutCancellationToken(1000);

    expect(token.isCancellationRequested).toBe(false);

    vi.advanceTimersByTime(1000);

    expect(token.isCancellationRequested).toBe(true);

    vi.useRealTimers();
  });

  it('should cancel after specified time', async () => {
    const token = createTimeoutCancellationToken(100);

    expect(token.isCancellationRequested).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(token.isCancellationRequested).toBe(true);
  });
});

describe('combineCancellationTokens', () => {
  it('should create combined token', () => {
    const token1 = createCancellationToken();
    const token2 = createCancellationToken();

    const combined = combineCancellationTokens(token1, token2);

    expect(combined).toBeInstanceOf(CancellationToken);
    expect(combined.isCancellationRequested).toBe(false);
  });

  it('should cancel when first token is cancelled', () => {
    const token1 = createCancellationToken();
    const token2 = createCancellationToken();

    const combined = combineCancellationTokens(token1, token2);

    token1.cancel();

    expect(combined.isCancellationRequested).toBe(true);
  });

  it('should cancel when second token is cancelled', () => {
    const token1 = createCancellationToken();
    const token2 = createCancellationToken();

    const combined = combineCancellationTokens(token1, token2);

    token2.cancel();

    expect(combined.isCancellationRequested).toBe(true);
  });

  it('should be already cancelled if any source is cancelled', () => {
    const token1 = createCancellationToken();
    const token2 = createCancellationToken();

    token1.cancel();

    const combined = combineCancellationTokens(token1, token2);

    expect(combined.isCancellationRequested).toBe(true);
  });

  it('should work with multiple tokens', () => {
    const token1 = createCancellationToken();
    const token2 = createCancellationToken();
    const token3 = createCancellationToken();

    const combined = combineCancellationTokens(token1, token2, token3);

    token2.cancel();

    expect(combined.isCancellationRequested).toBe(true);
  });
});
