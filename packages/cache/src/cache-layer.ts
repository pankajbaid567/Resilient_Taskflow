/**
 * Multi-Layer Cache System
 * 
 * Implements a hierarchical cache with:
 * - L1: In-memory LRU cache (fastest, smallest)
 * - L2: Redis cache (fast, shared across instances)
 * - L3: Database (slowest, source of truth)
 */

import { logger } from '@taskflow/logger';
import { LRUCache } from 'lru-cache';

export interface CacheOptions {
  l1MaxSize?: number;
  l1TTL?: number; // milliseconds
  l2TTL?: number; // seconds
  enableL1?: boolean;
  enableL2?: boolean;
  namespace?: string;
}

export interface CacheStats {
  l1Hits: number;
  l1Misses: number;
  l2Hits: number;
  l2Misses: number;
  dbHits: number;
  totalRequests: number;
  l1HitRate: number;
  l2HitRate: number;
  overallHitRate: number;
}

/**
 * Multi-layer cache
 */
export class MultiLayerCache<T> {
  private l1Cache: LRUCache<string, T> | null = null;
  private l2Get: ((key: string) => Promise<string | null>) | null = null;
  private l2Set: ((key: string, value: string, ttl: number) => Promise<void>) | null = null;
  private namespace: string;
  private options: Required<CacheOptions>;
  
  // Statistics
  private stats = {
    l1Hits: 0,
    l1Misses: 0,
    l2Hits: 0,
    l2Misses: 0,
    dbHits: 0,
  };

  constructor(
    l2Get?: (key: string) => Promise<string | null>,
    l2Set?: (key: string, value: string, ttl: number) => Promise<void>,
    options: CacheOptions = {}
  ) {
    this.options = {
      l1MaxSize: options.l1MaxSize || 1000,
      l1TTL: options.l1TTL || 60000, // 1 minute
      l2TTL: options.l2TTL || 300, // 5 minutes
      enableL1: options.enableL1 !== false,
      enableL2: options.enableL2 !== false && !!l2Get && !!l2Set,
      namespace: options.namespace || 'cache',
    };

    this.namespace = this.options.namespace;
    this.l2Get = l2Get || null;
    this.l2Set = l2Set || null;

    // Initialize L1 cache
    if (this.options.enableL1) {
      this.l1Cache = new LRUCache<string, T>({
        max: this.options.l1MaxSize,
        ttl: this.options.l1TTL,
        updateAgeOnGet: true,
        updateAgeOnHas: false,
      });
    }
  }

  /**
   * Get value from cache (L1 → L2 → DB)
   */
  async get(
    key: string,
    fetcher: () => Promise<T>,
    ttlOverride?: { l1?: number; l2?: number }
  ): Promise<T> {
    const fullKey = this.buildKey(key);

    // Try L1 cache
    if (this.l1Cache) {
      const l1Value = this.l1Cache.get(fullKey);
      if (l1Value !== undefined) {
        this.stats.l1Hits++;
        return l1Value;
      }
      this.stats.l1Misses++;
    }

    // Try L2 cache (Redis)
    if (this.l2Get && this.options.enableL2) {
      try {
        const l2Value = await this.l2Get(fullKey);
        if (l2Value) {
          this.stats.l2Hits++;
          const parsed = JSON.parse(l2Value) as T;
          
          // Backfill L1
          if (this.l1Cache) {
            this.l1Cache.set(fullKey, parsed, {
              ttl: ttlOverride?.l1 || this.options.l1TTL,
            });
          }
          
          return parsed;
        }
      } catch (error: unknown) {
        logger.warn('L2 cache read error', { key: fullKey, error });
      }
      this.stats.l2Misses++;
    }

    // Fetch from source (database)
    this.stats.dbHits++;
    const value = await fetcher();

    // Populate caches in background (don't wait)
    this.populateCaches(fullKey, value, ttlOverride).catch((error: unknown) => {
      logger.warn('Cache population error', { key: fullKey, error });
    });

    return value;
  }

  /**
   * Set value in all cache layers
   */
  async set(
    key: string,
    value: T,
    ttlOverride?: { l1?: number; l2?: number }
  ): Promise<void> {
    const fullKey = this.buildKey(key);
    await this.populateCaches(fullKey, value, ttlOverride);
  }

  /**
   * Populate all cache layers
   */
  private async populateCaches(
    fullKey: string,
    value: T,
    ttlOverride?: { l1?: number; l2?: number }
  ): Promise<void> {
    // Set L1
    if (this.l1Cache) {
      this.l1Cache.set(fullKey, value, {
        ttl: ttlOverride?.l1 || this.options.l1TTL,
      });
    }

    // Set L2
    if (this.l2Set && this.options.enableL2) {
      try {
        await this.l2Set(
          fullKey,
          JSON.stringify(value),
          ttlOverride?.l2 || this.options.l2TTL
        );
      } catch (error: unknown) {
        logger.warn('L2 cache write error', { key: fullKey, error });
      }
    }
  }

  /**
   * Invalidate key in all cache layers
   */
  invalidate(key: string): Promise<void> {
    const fullKey = this.buildKey(key);

    // Invalidate L1
    if (this.l1Cache) {
      this.l1Cache.delete(fullKey);
    }

    // Invalidate L2
    if (this.l2Get && this.options.enableL2) {
      // Note: We need a delete function for L2, but for simplicity we'll just let it expire
      // In production, you'd want: await this.l2Delete(fullKey);
    }

    return Promise.resolve();
  }

  /**
   * Invalidate multiple keys by pattern
   */
  invalidatePattern(pattern: string): Promise<void> {
    // Invalidate L1
    if (this.l1Cache) {
      const regex = new RegExp(pattern);
      const keysToDelete: string[] = [];
      
      for (const key of this.l1Cache.keys()) {
        if (regex.test(key)) {
          keysToDelete.push(key);
        }
      }
      
      for (const key of keysToDelete) {
        this.l1Cache.delete(key);
      }
    }

    // Invalidate L2 (would need Redis SCAN + DEL in production)
    return Promise.resolve();
  }

  /**
   * Clear all caches
   */
  clear(): void {
    if (this.l1Cache) {
      this.l1Cache.clear();
    }
    // Note: L2 would need to be cleared separately
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const totalRequests =
      this.stats.l1Hits +
      this.stats.l1Misses +
      this.stats.l2Hits +
      this.stats.l2Misses +
      this.stats.dbHits;

    return {
      ...this.stats,
      totalRequests,
      l1HitRate: totalRequests > 0 ? this.stats.l1Hits / totalRequests : 0,
      l2HitRate:
        totalRequests > 0
          ? (this.stats.l1Hits + this.stats.l2Hits) / totalRequests
          : 0,
      overallHitRate:
        totalRequests > 0
          ? (this.stats.l1Hits + this.stats.l2Hits) / totalRequests
          : 0,
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      l1Hits: 0,
      l1Misses: 0,
      l2Hits: 0,
      l2Misses: 0,
      dbHits: 0,
    };
  }

  /**
   * Build full cache key with namespace
   */
  private buildKey(key: string): string {
    return `${this.namespace}:${key}`;
  }

  /**
   * Get L1 cache size
   */
  getL1Size(): number {
    return this.l1Cache?.size || 0;
  }

  /**
   * Get L1 cache capacity
   */
  getL1Capacity(): number {
    return this.options.l1MaxSize;
  }
}

/**
 * Cache-aside pattern helper
 */
export async function cacheAside<T>(
  cache: MultiLayerCache<T>,
  key: string,
  fetcher: () => Promise<T>,
  ttl?: { l1?: number; l2?: number }
): Promise<T> {
  return cache.get(key, fetcher, ttl);
}

/**
 * Write-through pattern helper
 */
export async function writeThrough<T>(
  cache: MultiLayerCache<T>,
  key: string,
  value: T,
  persister: (value: T) => Promise<void>,
  ttl?: { l1?: number; l2?: number }
): Promise<void> {
  // Write to database first
  await persister(value);
  
  // Then update cache
  await cache.set(key, value, ttl);
}

/**
 * Write-behind pattern helper (async write)
 */
export async function writeBehind<T>(
  cache: MultiLayerCache<T>,
  key: string,
  value: T,
  persister: (value: T) => Promise<void>,
  ttl?: { l1?: number; l2?: number }
): Promise<void> {
  // Update cache first
  await cache.set(key, value, ttl);
  
  // Write to database asynchronously (fire and forget)
  void persister(value).catch((error: unknown) => {
    logger.error('Write-behind persister failed', { key, error });
  });
}

/**
 * Refresh-ahead pattern helper
 */
export class RefreshAheadCache<T> extends MultiLayerCache<T> {
  private refreshThreshold: number;
  private refreshing: Set<string> = new Set();

  constructor(
    l2Get?: (key: string) => Promise<string | null>,
    l2Set?: (key: string, value: string, ttl: number) => Promise<void>,
    options: CacheOptions & { refreshThreshold?: number } = {}
  ) {
    super(l2Get, l2Set, options);
    this.refreshThreshold = options.refreshThreshold || 0.75; // Refresh when 75% of TTL expired
  }

  /**
   * Get value and refresh proactively if near expiration
   */
  async getWithRefresh(
    key: string,
    fetcher: () => Promise<T>,
    ttl?: { l1?: number; l2?: number }
  ): Promise<T> {
    const value = await this.get(key, fetcher, ttl);

    // Check if we should refresh (in background)
    this.maybeRefresh(key, fetcher, ttl);

    return value;
  }

  /**
   * Maybe refresh cache if near expiration
   */
  private maybeRefresh(
    key: string,
    fetcher: () => Promise<T>,
    ttl?: { l1?: number; l2?: number }
  ): void {
    // Don't refresh if already refreshing
    if (this.refreshing.has(key)) {
      return;
    }

    // Simple heuristic: refresh randomly based on threshold
    // In production, you'd want to track TTL more precisely
    if (Math.random() > this.refreshThreshold) {
      this.refreshing.add(key);
      
      fetcher()
        .then((value) => this.set(key, value, ttl))
        .catch((error: unknown) =>
          logger.warn('Refresh-ahead failed', { key, error })
        )
        .finally(() => this.refreshing.delete(key));
    }
  }
}
