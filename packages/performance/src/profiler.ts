/**
 * Performance Profiler
 * 
 * Measures execution time and tracks performance metrics for operations
 */

import { performance } from 'perf_hooks';
import { logger } from '@taskflow/logger';

export interface ProfileResult {
  operation: string;
  duration: number;
  timestamp: number;
  metadata?: Record<string, any>;
}

export interface ProfileStats {
  operation: string;
  count: number;
  totalDuration: number;
  avgDuration: number;
  minDuration: number;
  maxDuration: number;
  p50Duration: number;
  p95Duration: number;
  p99Duration: number;
}

/**
 * Performance profiler for tracking operation timings
 */
export class Profiler {
  private results: Map<string, ProfileResult[]> = new Map();
  private enabled: boolean = true;

  constructor(enabled: boolean = true) {
    this.enabled = enabled;
  }

  /**
   * Start timing an operation
   */
  start(operation: string): () => void {
    if (!this.enabled) {
      return () => {}; // No-op
    }

    const startTime = performance.now();
    const startTimestamp = Date.now();

    return (metadata?: Record<string, any>) => {
      const duration = performance.now() - startTime;
      this.record(operation, duration, startTimestamp, metadata);
    };
  }

  /**
   * Time an async operation
   */
  async profile<T>(
    operation: string,
    fn: () => Promise<T>,
    metadata?: Record<string, any>
  ): Promise<T> {
    if (!this.enabled) {
      return fn();
    }

    const end = this.start(operation);
    try {
      const result = await fn();
      end(metadata);
      return result;
    } catch (error) {
      end({ ...metadata, error: true });
      throw error;
    }
  }

  /**
   * Time a synchronous operation
   */
  profileSync<T>(
    operation: string,
    fn: () => T,
    metadata?: Record<string, any>
  ): T {
    if (!this.enabled) {
      return fn();
    }

    const end = this.start(operation);
    try {
      const result = fn();
      end(metadata);
      return result;
    } catch (error) {
      end({ ...metadata, error: true });
      throw error;
    }
  }

  /**
   * Record a measurement
   */
  private record(
    operation: string,
    duration: number,
    timestamp: number,
    metadata?: Record<string, any>
  ): void {
    const result: ProfileResult = {
      operation,
      duration,
      timestamp,
      metadata,
    };

    const results = this.results.get(operation) || [];
    results.push(result);
    this.results.set(operation, results);

    // Log slow operations
    if (duration > 1000) {
      logger.warn('Slow operation detected', {
        operation,
        duration: `${duration.toFixed(2)}ms`,
        metadata,
      });
    }
  }

  /**
   * Get statistics for an operation
   */
  getStats(operation: string): ProfileStats | null {
    const results = this.results.get(operation);
    if (!results || results.length === 0) {
      return null;
    }

    const durations = results.map((r) => r.duration).sort((a, b) => a - b);
    const count = durations.length;
    const totalDuration = durations.reduce((sum, d) => sum + d, 0);

    return {
      operation,
      count,
      totalDuration,
      avgDuration: totalDuration / count,
      minDuration: durations[0],
      maxDuration: durations[count - 1],
      p50Duration: this.percentile(durations, 0.5),
      p95Duration: this.percentile(durations, 0.95),
      p99Duration: this.percentile(durations, 0.99),
    };
  }

  /**
   * Get statistics for all operations
   */
  getAllStats(): ProfileStats[] {
    const stats: ProfileStats[] = [];
    for (const operation of this.results.keys()) {
      const opStats = this.getStats(operation);
      if (opStats) {
        stats.push(opStats);
      }
    }
    return stats.sort((a, b) => b.totalDuration - a.totalDuration);
  }

  /**
   * Get raw results for an operation
   */
  getResults(operation: string): ProfileResult[] {
    return this.results.get(operation) || [];
  }

  /**
   * Clear all results
   */
  clear(): void {
    this.results.clear();
  }

  /**
   * Clear results for a specific operation
   */
  clearOperation(operation: string): void {
    this.results.delete(operation);
  }

  /**
   * Generate a text report
   */
  generateReport(): string {
    const stats = this.getAllStats();
    if (stats.length === 0) {
      return 'No profiling data available';
    }

    const lines: string[] = [];
    lines.push('');
    lines.push('='.repeat(100));
    lines.push('PERFORMANCE PROFILING REPORT');
    lines.push('='.repeat(100));
    lines.push('');

    // Summary
    const totalOperations = stats.reduce((sum, s) => sum + s.count, 0);
    const totalTime = stats.reduce((sum, s) => sum + s.totalDuration, 0);
    lines.push(`Total Operations: ${totalOperations.toLocaleString()}`);
    lines.push(`Total Time: ${(totalTime / 1000).toFixed(2)}s`);
    lines.push('');

    // Top 10 by total time
    lines.push('Top 10 Operations by Total Time:');
    lines.push('-'.repeat(100));
    lines.push(
      `${'Operation'.padEnd(40)} ${'Count'.padStart(10)} ${'Total'.padStart(12)} ${'Avg'.padStart(10)} ${'P95'.padStart(10)} ${'P99'.padStart(10)}`
    );
    lines.push('-'.repeat(100));

    stats.slice(0, 10).forEach((stat) => {
      lines.push(
        `${stat.operation.padEnd(40)} ${stat.count.toString().padStart(10)} ${this.formatMs(stat.totalDuration).padStart(12)} ${this.formatMs(stat.avgDuration).padStart(10)} ${this.formatMs(stat.p95Duration).padStart(10)} ${this.formatMs(stat.p99Duration).padStart(10)}`
      );
    });

    lines.push('');

    // Slowest operations by P99
    const slowest = [...stats].sort((a, b) => b.p99Duration - a.p99Duration);
    lines.push('Top 10 Slowest Operations (by P99):');
    lines.push('-'.repeat(100));
    lines.push(
      `${'Operation'.padEnd(40)} ${'Count'.padStart(10)} ${'Min'.padStart(10)} ${'P50'.padStart(10)} ${'P95'.padStart(10)} ${'P99'.padStart(10)} ${'Max'.padStart(10)}`
    );
    lines.push('-'.repeat(100));

    slowest.slice(0, 10).forEach((stat) => {
      lines.push(
        `${stat.operation.padEnd(40)} ${stat.count.toString().padStart(10)} ${this.formatMs(stat.minDuration).padStart(10)} ${this.formatMs(stat.p50Duration).padStart(10)} ${this.formatMs(stat.p95Duration).padStart(10)} ${this.formatMs(stat.p99Duration).padStart(10)} ${this.formatMs(stat.maxDuration).padStart(10)}`
      );
    });

    lines.push('');
    lines.push('='.repeat(100));

    return lines.join('\n');
  }

  /**
   * Log the report
   */
  logReport(): void {
    console.log(this.generateReport());
  }

  /**
   * Calculate percentile
   */
  private percentile(sorted: number[], p: number): number {
    const index = Math.ceil(sorted.length * p) - 1;
    return sorted[Math.max(0, index)];
  }

  /**
   * Format milliseconds
   */
  private formatMs(ms: number): string {
    if (ms < 1) {
      return `${(ms * 1000).toFixed(0)}μs`;
    } else if (ms < 1000) {
      return `${ms.toFixed(2)}ms`;
    } else {
      return `${(ms / 1000).toFixed(2)}s`;
    }
  }

  /**
   * Enable profiling
   */
  enable(): void {
    this.enabled = true;
  }

  /**
   * Disable profiling
   */
  disable(): void {
    this.enabled = false;
  }

  /**
   * Check if profiling is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }
}

// Global profiler instance
export const profiler = new Profiler(process.env.NODE_ENV !== 'production');
