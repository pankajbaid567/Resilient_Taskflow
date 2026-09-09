import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { Scheduler, SchedulerConfig } from '../scheduler';

// Mock dependencies
vi.mock('@taskflow/database', () => ({
  getJobsReadyToQueue: vi.fn(),
  updateJobStatus: vi.fn(),
}));

vi.mock('@taskflow/queue', () => ({
  enqueueJob: vi.fn(),
}));

vi.mock('@taskflow/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { getJobsReadyToQueue, updateJobStatus } from '@taskflow/database';
import { enqueueJob } from '@taskflow/queue';

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
      const scheduler = new Scheduler();
      const stats = scheduler.getStats();

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

      const scheduler = new Scheduler(config);
      expect(scheduler).toBeDefined();
    });
  });

  describe('start', () => {
    it('should not start if disabled', () => {
      const scheduler = new Scheduler({ enabled: false });
      scheduler.start();

      // Scheduler should not run
      expect(getJobsReadyToQueue).not.toHaveBeenCalled();
    });

    it('should warn if already started', () => {
      vi.useFakeTimers();
      const scheduler = new Scheduler({ intervalMs: 1000 });

      scheduler.start();
      scheduler.start(); // Second start

      // Should only set up one interval
      expect(vi.getTimerCount()).toBe(1);

      scheduler.stop();
      vi.useRealTimers();
    });
  });

  describe('stop', () => {
    it('should clear interval timer', () => {
      vi.useFakeTimers();
      const scheduler = new Scheduler({ intervalMs: 1000 });

      scheduler.start();
      expect(vi.getTimerCount()).toBe(1);

      scheduler.stop();
      expect(vi.getTimerCount()).toBe(0);

      vi.useRealTimers();
    });

    it('should warn if not running', () => {
      const scheduler = new Scheduler();
      scheduler.stop(); // Stop without start

      // Should not throw
      expect(scheduler).toBeDefined();
    });
  });

  describe('runSchedulingCycle', () => {
    it('should process jobs ready to queue', async () => {
      const jobs = [
        {
          id: 'job-1',
          type: 'test',
          priority: 'HIGH',
          scheduledAt: new Date(),
          metadata: { queue: 'default' },
        },
        {
          id: 'job-2',
          type: 'test',
          priority: 'NORMAL',
          scheduledAt: new Date(),
          metadata: { queue: 'email' },
        },
      ];

      vi.mocked(getJobsReadyToQueue).mockResolvedValue(jobs as any);
      vi.mocked(enqueueJob).mockResolvedValue('message-id-1' as any);
      vi.mocked(updateJobStatus).mockResolvedValue(undefined as any);

      const scheduler = new Scheduler({
        intervalMs: 5000,
        batchSize: 100,
      });

      scheduler.start();

      // Wait for first cycle
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(getJobsReadyToQueue).toHaveBeenCalledWith(100);
      expect(enqueueJob).toHaveBeenCalledTimes(2);
      expect(enqueueJob).toHaveBeenCalledWith('job-1', 'default', 1);
      expect(enqueueJob).toHaveBeenCalledWith('job-2', 'email', 1);
      expect(updateJobStatus).toHaveBeenCalledTimes(2);

      const stats = scheduler.getStats();
      expect(stats.totalRuns).toBeGreaterThan(0);
      expect(stats.totalJobsScheduled).toBe(2);

      scheduler.stop();
    });

    it('should use default queue if not in metadata', async () => {
      const jobs = [
        {
          id: 'job-1',
          type: 'test',
          priority: 'NORMAL',
          scheduledAt: new Date(),
          metadata: null, // No queue specified
        },
      ];

      vi.mocked(getJobsReadyToQueue).mockResolvedValue(jobs as any);
      vi.mocked(enqueueJob).mockResolvedValue('message-id' as any);
      vi.mocked(updateJobStatus).mockResolvedValue(undefined as any);

      const scheduler = new Scheduler({ intervalMs: 5000 });
      scheduler.start();

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(enqueueJob).toHaveBeenCalledWith('job-1', 'default', 1);

      scheduler.stop();
    });

    it('should handle no jobs gracefully', async () => {
      vi.mocked(getJobsReadyToQueue).mockResolvedValue([]);

      const scheduler = new Scheduler({ intervalMs: 5000 });
      scheduler.start();

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(getJobsReadyToQueue).toHaveBeenCalled();
      expect(enqueueJob).not.toHaveBeenCalled();

      const stats = scheduler.getStats();
      expect(stats.totalJobsScheduled).toBe(0);

      scheduler.stop();
    });

    it('should handle enqueue errors', async () => {
      const jobs = [
        {
          id: 'job-1',
          type: 'test',
          priority: 'HIGH',
          scheduledAt: new Date(),
          metadata: { queue: 'default' },
        },
        {
          id: 'job-2',
          type: 'test',
          priority: 'NORMAL',
          scheduledAt: new Date(),
          metadata: { queue: 'email' },
        },
      ];

      vi.mocked(getJobsReadyToQueue).mockResolvedValue(jobs as any);
      vi.mocked(enqueueJob)
        .mockRejectedValueOnce(new Error('Redis error'))
        .mockResolvedValueOnce('message-id' as any);
      vi.mocked(updateJobStatus).mockResolvedValue(undefined as any);

      const scheduler = new Scheduler({ intervalMs: 5000 });
      scheduler.start();

      await new Promise((resolve) => setTimeout(resolve, 100));

      const stats = scheduler.getStats();
      expect(stats.totalJobsScheduled).toBe(1); // Only job-2 succeeded
      expect(stats.totalErrors).toBeGreaterThan(0);

      scheduler.stop();
    });

    it('should handle database errors', async () => {
      vi.mocked(getJobsReadyToQueue).mockRejectedValue(
        new Error('Database error')
      );

      const scheduler = new Scheduler({ intervalMs: 5000 });
      scheduler.start();

      await new Promise((resolve) => setTimeout(resolve, 100));

      const stats = scheduler.getStats();
      expect(stats.totalErrors).toBeGreaterThan(0);

      scheduler.stop();
    });

    it('should prevent concurrent runs', async () => {
      const jobs = [
        {
          id: 'job-1',
          type: 'test',
          priority: 'NORMAL',
          scheduledAt: new Date(),
          metadata: { queue: 'default' },
        },
      ];

      // Make getJobsReadyToQueue slow
      vi.mocked(getJobsReadyToQueue).mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(jobs as any), 1000);
          })
      );

      vi.mocked(enqueueJob).mockResolvedValue('message-id' as any);
      vi.mocked(updateJobStatus).mockResolvedValue(undefined as any);

      vi.useFakeTimers();

      const scheduler = new Scheduler({ intervalMs: 500 }); // Fast interval
      scheduler.start();

      // Trigger an interval while the initial slow cycle is still running.
      await vi.advanceTimersByTimeAsync(750);

      // Should only call once due to concurrent run prevention
      expect(getJobsReadyToQueue).toHaveBeenCalledTimes(1);

      scheduler.stop();
      await vi.advanceTimersByTimeAsync(250);
    });

    it('should update stats correctly', async () => {
      const jobs = [
        {
          id: 'job-1',
          type: 'test',
          priority: 'CRITICAL',
          scheduledAt: new Date(),
          metadata: { queue: 'default' },
        },
        {
          id: 'job-2',
          type: 'test',
          priority: 'HIGH',
          scheduledAt: new Date(),
          metadata: { queue: 'default' },
        },
        {
          id: 'job-3',
          type: 'test',
          priority: 'NORMAL',
          scheduledAt: new Date(),
          metadata: { queue: 'default' },
        },
      ];

      vi.mocked(getJobsReadyToQueue).mockResolvedValue(jobs as any);
      vi.mocked(enqueueJob).mockResolvedValue('message-id' as any);
      vi.mocked(updateJobStatus).mockResolvedValue(undefined as any);

      const scheduler = new Scheduler({ intervalMs: 5000 });
      scheduler.start();

      await new Promise((resolve) => setTimeout(resolve, 100));

      const stats = scheduler.getStats();
      expect(stats.totalRuns).toBeGreaterThan(0);
      expect(stats.totalJobsScheduled).toBe(3);
      expect(stats.lastRunAt).toBeDefined();
      expect(stats.lastRunDurationMs).toBeGreaterThanOrEqual(0);
      expect(stats.lastRunJobCount).toBe(3);

      scheduler.stop();
    });
  });

  describe('getStats', () => {
    it('should return copy of stats', () => {
      const scheduler = new Scheduler();
      const stats1 = scheduler.getStats();
      const stats2 = scheduler.getStats();

      expect(stats1).not.toBe(stats2); // Different objects
      expect(stats1).toEqual(stats2); // Same values
    });
  });
});
