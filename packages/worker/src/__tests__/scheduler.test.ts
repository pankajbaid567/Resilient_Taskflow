import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Scheduler, SchedulerConfig } from '../scheduler';

// The scheduler delegates claiming + promotion to one SKIP LOCKED batch
// transaction in the database layer; these tests cover orchestration only.
vi.mock('@taskflow/database', () => ({
  promoteDueScheduledJobs: vi.fn(),
}));

vi.mock('@taskflow/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { promoteDueScheduledJobs } from '@taskflow/database';

const promote = vi.mocked(promoteDueScheduledJobs);

function batch(
  promotedIds: string[],
  failed: Array<{ jobId: string; error: string }> = []
) {
  return {
    promoted: promotedIds.map((id) => ({ id, priority: 'NORMAL' as const })),
    failed,
  };
}

describe('Scheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should initialize with default config', () => {
      const stats = new Scheduler().getStats();

      expect(stats.totalRuns).toBe(0);
      expect(stats.totalJobsScheduled).toBe(0);
      expect(stats.totalErrors).toBe(0);
    });

    it('should use custom config', () => {
      const config: SchedulerConfig = {
        intervalMs: 10000,
        batchSize: 50,
        enabled: false,
      };

      expect(new Scheduler(config)).toBeDefined();
    });
  });

  describe('start', () => {
    it('should not start if disabled', () => {
      new Scheduler({ enabled: false }).start();

      expect(promote).not.toHaveBeenCalled();
    });

    it('should warn if already started', () => {
      vi.useFakeTimers();
      promote.mockResolvedValue(batch([]));
      const scheduler = new Scheduler({ intervalMs: 1000 });

      scheduler.start();
      scheduler.start();

      expect(vi.getTimerCount()).toBe(1);
      void scheduler.stop();
    });
  });

  describe('stop', () => {
    it('should clear interval timer', () => {
      vi.useFakeTimers();
      promote.mockResolvedValue(batch([]));
      const scheduler = new Scheduler({ intervalMs: 1000 });

      scheduler.start();
      expect(vi.getTimerCount()).toBe(1);

      void scheduler.stop();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('should not throw if not running', async () => {
      await expect(new Scheduler().stop()).resolves.toBeUndefined();
    });

    it('waits for the active promotion transaction before resolving', async () => {
      let resolveBatch!: (value: ReturnType<typeof batch>) => void;
      promote.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveBatch = resolve;
          })
      );

      const scheduler = new Scheduler({ intervalMs: 5000 });
      scheduler.start();
      await vi.waitFor(() => expect(promote).toHaveBeenCalledTimes(1));

      let stopped = false;
      const stopping = scheduler.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);

      resolveBatch(batch(['job-1']));
      await stopping;
      expect(stopped).toBe(true);
    });
  });

  describe('runSchedulingCycle', () => {
    it('passes the configured batch size and counts promoted jobs', async () => {
      promote.mockResolvedValue(batch(['job-1', 'job-2']));

      const scheduler = new Scheduler({ intervalMs: 5000, batchSize: 100 });
      scheduler.start();
      await vi.waitFor(() =>
        expect(scheduler.getStats().totalJobsScheduled).toBe(2)
      );

      expect(promote).toHaveBeenCalledWith(100);
      expect(scheduler.getStats().totalRuns).toBe(1);
      await scheduler.stop();
    });

    it('handles an empty batch without updating run counters', async () => {
      promote.mockResolvedValue(batch([]));

      const scheduler = new Scheduler({ intervalMs: 5000 });
      scheduler.start();
      await vi.waitFor(() => expect(promote).toHaveBeenCalled());
      await scheduler.stop();

      const stats = scheduler.getStats();
      expect(stats.totalJobsScheduled).toBe(0);
      expect(stats.lastRunJobCount).toBeUndefined();
    });

    it('records per-row failures while counting successful promotions', async () => {
      promote.mockResolvedValue(
        batch(['job-2'], [{ jobId: 'job-1', error: 'DB error' }])
      );

      const scheduler = new Scheduler({ intervalMs: 5000 });
      scheduler.start();
      await vi.waitFor(() =>
        expect(scheduler.getStats().lastRunJobCount).toBe(2)
      );
      await scheduler.stop();

      const stats = scheduler.getStats();
      expect(stats.totalJobsScheduled).toBe(1);
      expect(stats.totalErrors).toBe(1);
    });

    it('counts a failed batch transaction as an error', async () => {
      promote.mockRejectedValue(new Error('Database error'));

      const scheduler = new Scheduler({ intervalMs: 5000 });
      scheduler.start();
      await vi.waitFor(() =>
        expect(scheduler.getStats().totalErrors).toBeGreaterThan(0)
      );
      await scheduler.stop();
    });

    it('should prevent concurrent runs', async () => {
      vi.useFakeTimers();
      promote.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(batch(['job-1'])), 1000);
          })
      );

      const scheduler = new Scheduler({ intervalMs: 500 });
      scheduler.start();

      // An interval fires while the initial slow cycle is still running.
      await vi.advanceTimersByTimeAsync(750);
      expect(promote).toHaveBeenCalledTimes(1);

      const stopping = scheduler.stop();
      await vi.advanceTimersByTimeAsync(250);
      await stopping;
    });

    it('should update stats correctly', async () => {
      promote.mockResolvedValue(batch(['job-1', 'job-2', 'job-3']));

      const scheduler = new Scheduler({ intervalMs: 5000 });
      scheduler.start();
      await vi.waitFor(() =>
        expect(scheduler.getStats().lastRunJobCount).toBe(3)
      );
      await scheduler.stop();

      const stats = scheduler.getStats();
      expect(stats.totalRuns).toBe(1);
      expect(stats.totalJobsScheduled).toBe(3);
      expect(stats.lastRunAt).toBeDefined();
      expect(stats.lastRunDurationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getStats', () => {
    it('should return copy of stats', () => {
      const scheduler = new Scheduler();
      const stats1 = scheduler.getStats();
      const stats2 = scheduler.getStats();

      expect(stats1).not.toBe(stats2);
      expect(stats1).toEqual(stats2);
    });
  });
});
