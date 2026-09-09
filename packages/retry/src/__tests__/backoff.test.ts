import { describe, it, expect } from 'vitest';

import {
  calculateBackoff,
  calculateRetryTime,
  formatDelay,
  previewBackoffSchedule,
} from '../backoff';

describe('Backoff', () => {
  describe('calculateBackoff', () => {
    it('should calculate exponential backoff', () => {
      const config = {
        strategy: 'exponential' as const,
        baseDelayMs: 1000,
        maxDelayMs: 60000,
        factor: 2,
        enableJitter: false,
      };

      expect(calculateBackoff(0, config)).toBe(1000); // 1000 * 2^0
      expect(calculateBackoff(1, config)).toBe(2000); // 1000 * 2^1
      expect(calculateBackoff(2, config)).toBe(4000); // 1000 * 2^2
      expect(calculateBackoff(3, config)).toBe(8000); // 1000 * 2^3
      expect(calculateBackoff(4, config)).toBe(16000); // 1000 * 2^4
      expect(calculateBackoff(5, config)).toBe(32000); // 1000 * 2^5
      expect(calculateBackoff(6, config)).toBe(60000); // capped at maxDelayMs
    });

    it('should calculate linear backoff', () => {
      const config = {
        strategy: 'linear' as const,
        baseDelayMs: 1000,
        maxDelayMs: 10000,
        enableJitter: false,
      };

      expect(calculateBackoff(0, config)).toBe(1000); // 1000 * 1
      expect(calculateBackoff(1, config)).toBe(2000); // 1000 * 2
      expect(calculateBackoff(2, config)).toBe(3000); // 1000 * 3
      expect(calculateBackoff(3, config)).toBe(4000); // 1000 * 4
      expect(calculateBackoff(10, config)).toBe(10000); // capped at maxDelayMs
    });

    it('should calculate fixed backoff', () => {
      const config = {
        strategy: 'fixed' as const,
        baseDelayMs: 5000,
        enableJitter: false,
      };

      expect(calculateBackoff(0, config)).toBe(5000);
      expect(calculateBackoff(1, config)).toBe(5000);
      expect(calculateBackoff(2, config)).toBe(5000);
      expect(calculateBackoff(10, config)).toBe(5000);
    });

    it('should calculate fibonacci backoff', () => {
      const config = {
        strategy: 'fibonacci' as const,
        baseDelayMs: 1000,
        maxDelayMs: 100000,
        enableJitter: false,
      };

      expect(calculateBackoff(0, config)).toBe(1000); // 1000 * 1
      expect(calculateBackoff(1, config)).toBe(2000); // 1000 * 2
      expect(calculateBackoff(2, config)).toBe(3000); // 1000 * 3
      expect(calculateBackoff(3, config)).toBe(5000); // 1000 * 5
      expect(calculateBackoff(4, config)).toBe(8000); // 1000 * 8
      expect(calculateBackoff(5, config)).toBe(13000); // 1000 * 13
    });

    it('should add jitter when enabled', () => {
      const config = {
        strategy: 'exponential' as const,
        baseDelayMs: 1000,
        enableJitter: true,
        jitterFactor: 0.1,
      };

      // Run multiple times to test jitter variance
      const delays = [];
      for (let i = 0; i < 10; i++) {
        delays.push(calculateBackoff(2, config));
      }

      // All delays should be close to 4000 but not exactly the same
      const uniqueDelays = new Set(delays);
      expect(uniqueDelays.size).toBeGreaterThan(1); // Jitter creates variance

      // All delays should be within jitter range (±10% of 4000)
      for (const delay of delays) {
        expect(delay).toBeGreaterThan(3600); // 4000 - 400
        expect(delay).toBeLessThan(4400); // 4000 + 400
      }
    });

    it('should cap delay at maxDelayMs', () => {
      const config = {
        strategy: 'exponential' as const,
        baseDelayMs: 1000,
        maxDelayMs: 5000,
        factor: 2,
        enableJitter: false,
      };

      expect(calculateBackoff(10, config)).toBe(5000);
      expect(calculateBackoff(100, config)).toBe(5000);
    });
  });

  describe('calculateRetryTime', () => {
    it('should calculate future retry time', () => {
      const config = {
        strategy: 'fixed' as const,
        baseDelayMs: 5000,
        enableJitter: false,
      };

      const before = Date.now();
      const retryTime = calculateRetryTime(0, config);
      const after = Date.now();

      const retryTimestamp = retryTime.getTime();
      expect(retryTimestamp).toBeGreaterThan(before + 4900);
      expect(retryTimestamp).toBeLessThan(after + 5100);
    });
  });

  describe('formatDelay', () => {
    it('should format milliseconds', () => {
      expect(formatDelay(500)).toBe('500ms');
      expect(formatDelay(999)).toBe('999ms');
    });

    it('should format seconds', () => {
      expect(formatDelay(1000)).toBe('1s');
      expect(formatDelay(5000)).toBe('5s');
      expect(formatDelay(30000)).toBe('30s');
    });

    it('should format minutes', () => {
      expect(formatDelay(60000)).toBe('1m');
      expect(formatDelay(120000)).toBe('2m');
      expect(formatDelay(1800000)).toBe('30m');
    });

    it('should format hours', () => {
      expect(formatDelay(3600000)).toBe('1h');
      expect(formatDelay(7200000)).toBe('2h');
    });
  });

  describe('previewBackoffSchedule', () => {
    it('should generate backoff schedule', () => {
      const config = {
        strategy: 'exponential' as const,
        baseDelayMs: 1000,
        maxDelayMs: 60000,
        factor: 2,
        enableJitter: false,
      };

      const schedule = previewBackoffSchedule(5, config);

      expect(schedule).toHaveLength(5);
      expect(schedule[0]).toEqual({
        attempt: 1,
        delayMs: 1000,
        delayFormatted: '1s',
      });
      expect(schedule[1]).toEqual({
        attempt: 2,
        delayMs: 2000,
        delayFormatted: '2s',
      });
      expect(schedule[4]).toEqual({
        attempt: 5,
        delayMs: 16000,
        delayFormatted: '16s',
      });
    });
  });
});
