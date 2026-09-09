/**
 * Specific Cache Implementations
 * 
 * Pre-configured caches for common use cases
 */

import { MultiLayerCache, RefreshAheadCache } from './cache-layer.js';

/**
 * Queue statistics cache
 * - High read frequency
 * - Tolerates slightly stale data
 * - Short TTL
 */
export class QueueStatsCache extends MultiLayerCache<{
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  totalJobs: number;
}> {
  constructor(
    l2Get?: (key: string) => Promise<string | null>,
    l2Set?: (key: string, value: string, ttl: number) => Promise<void>
  ) {
    super(l2Get, l2Set, {
      namespace: 'queue_stats',
      l1MaxSize: 100, // Cache stats for 100 queues
      l1TTL: 5000, // 5 seconds (very short for freshness)
      l2TTL: 30, // 30 seconds
      enableL1: true,
      enableL2: true,
    });
  }
}

/**
 * Worker information cache
 * - Medium read frequency
 * - Needs freshness for health checks
 * - Medium TTL
 */
export class WorkerInfoCache extends MultiLayerCache<{
  id: string;
  name: string;
  status: string;
  lastHeartbeat: Date;
  currentJobCount: number;
  totalJobsProcessed: number;
}> {
  constructor(
    l2Get?: (key: string) => Promise<string | null>,
    l2Set?: (key: string, value: string, ttl: number) => Promise<void>
  ) {
    super(l2Get, l2Set, {
      namespace: 'worker_info',
      l1MaxSize: 500, // Cache info for 500 workers
      l1TTL: 10000, // 10 seconds
      l2TTL: 60, // 1 minute
      enableL1: true,
      enableL2: true,
    });
  }
}

/**
 * Job metadata cache
 * - Very high read frequency
 * - Can tolerate some staleness
 * - Longer TTL
 */
export class JobMetadataCache extends MultiLayerCache<{
  id: string;
  type: string;
  status: string;
  priority: string;
  attempts: number;
  createdAt: Date;
  scheduledAt: Date;
}> {
  constructor(
    l2Get?: (key: string) => Promise<string | null>,
    l2Set?: (key: string, value: string, ttl: number) => Promise<void>
  ) {
    super(l2Get, l2Set, {
      namespace: 'job_metadata',
      l1MaxSize: 10000, // Cache metadata for 10k jobs
      l1TTL: 30000, // 30 seconds
      l2TTL: 300, // 5 minutes
      enableL1: true,
      enableL2: true,
    });
  }
}

/**
 * User preferences cache
 * - Low write frequency, high read frequency
 * - Can tolerate staleness
 * - Long TTL with refresh-ahead
 */
export class UserPreferencesCache extends RefreshAheadCache<{
  userId: string;
  theme: string;
  notifications: boolean;
  timezone: string;
  language: string;
}> {
  constructor(
    l2Get?: (key: string) => Promise<string | null>,
    l2Set?: (key: string, value: string, ttl: number) => Promise<void>
  ) {
    super(l2Get, l2Set, {
      namespace: 'user_prefs',
      l1MaxSize: 5000, // Cache prefs for 5k users
      l1TTL: 300000, // 5 minutes
      l2TTL: 3600, // 1 hour
      enableL1: true,
      enableL2: true,
      refreshThreshold: 0.75, // Refresh when 75% of TTL expired
    });
  }
}

/**
 * API rate limit cache
 * - Very high read/write frequency
 * - Needs accuracy (no staleness)
 * - Short TTL, L1 only for speed
 */
export class RateLimitCache extends MultiLayerCache<{
  count: number;
  resetAt: Date;
}> {
  constructor() {
    // L1 only for speed (no network overhead)
    super(undefined, undefined, {
      namespace: 'rate_limit',
      l1MaxSize: 50000, // Cache limits for 50k users/IPs
      l1TTL: 60000, // 1 minute (matches rate limit window)
      enableL1: true,
      enableL2: false, // Don't use Redis (too much overhead for rate limiting)
    });
  }
}

/**
 * Idempotency key cache
 * - High read frequency on duplicate requests
 * - Needs accuracy
 * - Medium TTL
 */
export class IdempotencyCache extends MultiLayerCache<{
  jobId: string;
  createdAt: Date;
}> {
  constructor(
    l2Get?: (key: string) => Promise<string | null>,
    l2Set?: (key: string, value: string, ttl: number) => Promise<void>
  ) {
    super(l2Get, l2Set, {
      namespace: 'idempotency',
      l1MaxSize: 10000,
      l1TTL: 60000, // 1 minute
      l2TTL: 3600, // 1 hour (matches idempotency window)
      enableL1: true,
      enableL2: true,
    });
  }
}

/**
 * Job result cache
 * - Medium read frequency
 * - Large values (results can be big)
 * - Should use L2 (Redis) primarily
 */
export class JobResultCache extends MultiLayerCache<{
  jobId: string;
  result: any;
  completedAt: Date;
}> {
  constructor(
    l2Get?: (key: string) => Promise<string | null>,
    l2Set?: (key: string, value: string, ttl: number) => Promise<void>
  ) {
    super(l2Get, l2Set, {
      namespace: 'job_result',
      l1MaxSize: 1000, // Small L1 (results can be large)
      l1TTL: 60000, // 1 minute
      l2TTL: 86400, // 24 hours
      enableL1: true,
      enableL2: true,
    });
  }
}

/**
 * Configuration cache
 * - Very low write frequency
 * - High read frequency
 * - Very long TTL with manual invalidation
 */
export class ConfigCache extends MultiLayerCache<Record<string, any>> {
  constructor(
    l2Get?: (key: string) => Promise<string | null>,
    l2Set?: (key: string, value: string, ttl: number) => Promise<void>
  ) {
    super(l2Get, l2Set, {
      namespace: 'config',
      l1MaxSize: 100,
      l1TTL: 3600000, // 1 hour
      l2TTL: 86400, // 24 hours
      enableL1: true,
      enableL2: true,
    });
  }
}

/**
 * Cache factory for creating custom caches
 */
export class CacheFactory {
  constructor(
    private l2Get?: (key: string) => Promise<string | null>,
    private l2Set?: (key: string, value: string, ttl: number) => Promise<void>
  ) {}

  /**
   * Create a queue stats cache
   */
  createQueueStatsCache(): QueueStatsCache {
    return new QueueStatsCache(this.l2Get, this.l2Set);
  }

  /**
   * Create a worker info cache
   */
  createWorkerInfoCache(): WorkerInfoCache {
    return new WorkerInfoCache(this.l2Get, this.l2Set);
  }

  /**
   * Create a job metadata cache
   */
  createJobMetadataCache(): JobMetadataCache {
    return new JobMetadataCache(this.l2Get, this.l2Set);
  }

  /**
   * Create a user preferences cache
   */
  createUserPreferencesCache(): UserPreferencesCache {
    return new UserPreferencesCache(this.l2Get, this.l2Set);
  }

  /**
   * Create a rate limit cache
   */
  createRateLimitCache(): RateLimitCache {
    return new RateLimitCache();
  }

  /**
   * Create an idempotency cache
   */
  createIdempotencyCache(): IdempotencyCache {
    return new IdempotencyCache(this.l2Get, this.l2Set);
  }

  /**
   * Create a job result cache
   */
  createJobResultCache(): JobResultCache {
    return new JobResultCache(this.l2Get, this.l2Set);
  }

  /**
   * Create a config cache
   */
  createConfigCache(): ConfigCache {
    return new ConfigCache(this.l2Get, this.l2Set);
  }

  /**
   * Create a custom cache
   */
  createCustomCache<T>(
    namespace: string,
    options: {
      l1MaxSize?: number;
      l1TTL?: number;
      l2TTL?: number;
      enableL1?: boolean;
      enableL2?: boolean;
    }
  ): MultiLayerCache<T> {
    return new MultiLayerCache<T>(this.l2Get, this.l2Set, {
      namespace,
      ...options,
    });
  }
}
