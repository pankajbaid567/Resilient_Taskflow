/**
 * Database Query Analyzer
 * 
 * Analyzes slow queries and provides optimization recommendations
 */

import { logger } from '@taskflow/logger';

export interface QueryMetrics {
  query: string;
  duration: number;
  timestamp: number;
  rows?: number;
  params?: any[];
  stackTrace?: string;
}

export interface QueryStats {
  query: string;
  count: number;
  totalDuration: number;
  avgDuration: number;
  minDuration: number;
  maxDuration: number;
  p95Duration: number;
  p99Duration: number;
  totalRows?: number;
  avgRows?: number;
}

export interface SlowQuery {
  query: string;
  duration: number;
  timestamp: number;
  recommendation?: string;
}

/**
 * Query analyzer for tracking and analyzing database queries
 */
export class QueryAnalyzer {
  private queries: Map<string, QueryMetrics[]> = new Map();
  private slowQueryThreshold: number = 100; // ms
  private enabled: boolean = true;

  constructor(slowQueryThreshold: number = 100) {
    this.slowQueryThreshold = slowQueryThreshold;
  }

  /**
   * Record a query execution
   */
  record(query: string, duration: number, metadata?: Partial<QueryMetrics>): void {
    if (!this.enabled) return;

    const normalizedQuery = this.normalizeQuery(query);
    const metrics: QueryMetrics = {
      query: normalizedQuery,
      duration,
      timestamp: Date.now(),
      ...metadata,
    };

    const queries = this.queries.get(normalizedQuery) || [];
    queries.push(metrics);
    this.queries.set(normalizedQuery, queries);

    // Log slow queries
    if (duration > this.slowQueryThreshold) {
      logger.warn('Slow query detected', {
        query: normalizedQuery,
        duration: `${duration.toFixed(2)}ms`,
        threshold: `${this.slowQueryThreshold}ms`,
        rows: metadata?.rows,
      });
    }
  }

  /**
   * Normalize query (remove parameter values)
   */
  private normalizeQuery(query: string): string {
    return query
      .replace(/\$\d+/g, '$?') // PostgreSQL parameters
      .replace(/\?/g, '$?') // MySQL parameters
      .replace(/\s+/g, ' ') // Normalize whitespace
      .replace(/--.*$/gm, '') // Remove comments
      .trim();
  }

  /**
   * Get statistics for a query
   */
  getStats(query: string): QueryStats | null {
    const normalizedQuery = this.normalizeQuery(query);
    const queries = this.queries.get(normalizedQuery);
    if (!queries || queries.length === 0) {
      return null;
    }

    const durations = queries.map((q) => q.duration).sort((a, b) => a - b);
    const count = durations.length;
    const totalDuration = durations.reduce((sum, d) => sum + d, 0);

    const totalRows = queries.reduce((sum, q) => sum + (q.rows || 0), 0);
    const avgRows = totalRows / count;

    return {
      query: normalizedQuery,
      count,
      totalDuration,
      avgDuration: totalDuration / count,
      minDuration: durations[0],
      maxDuration: durations[count - 1],
      p95Duration: this.percentile(durations, 0.95),
      p99Duration: this.percentile(durations, 0.99),
      totalRows,
      avgRows,
    };
  }

  /**
   * Get all query statistics
   */
  getAllStats(): QueryStats[] {
    const stats: QueryStats[] = [];
    for (const query of this.queries.keys()) {
      const queryStats = this.getStats(query);
      if (queryStats) {
        stats.push(queryStats);
      }
    }
    return stats.sort((a, b) => b.totalDuration - a.totalDuration);
  }

  /**
   * Get slow queries
   */
  getSlowQueries(threshold?: number): SlowQuery[] {
    const th = threshold || this.slowQueryThreshold;
    const slowQueries: SlowQuery[] = [];

    for (const [query, metrics] of this.queries.entries()) {
      for (const metric of metrics) {
        if (metric.duration > th) {
          slowQueries.push({
            query,
            duration: metric.duration,
            timestamp: metric.timestamp,
            recommendation: this.getRecommendation(query, metric),
          });
        }
      }
    }

    return slowQueries.sort((a, b) => b.duration - a.duration);
  }

  /**
   * Get optimization recommendations for a query
   */
  private getRecommendation(query: string, metrics: QueryMetrics): string {
    const recommendations: string[] = [];

    // Check for missing WHERE clause
    if (query.match(/SELECT .* FROM .* (?!WHERE)/i)) {
      recommendations.push('Consider adding WHERE clause to limit rows');
    }

    // Check for SELECT *
    if (query.match(/SELECT \*/i)) {
      recommendations.push('Avoid SELECT *, specify only needed columns');
    }

    // Check for NOT IN
    if (query.match(/NOT IN/i)) {
      recommendations.push('Consider using NOT EXISTS instead of NOT IN');
    }

    // Check for OR in WHERE
    if (query.match(/WHERE.*OR/i)) {
      recommendations.push('OR conditions may prevent index usage, consider UNION');
    }

    // Check for LIKE with leading wildcard
    if (query.match(/LIKE\s+['"]%/i)) {
      recommendations.push('Leading wildcard in LIKE prevents index usage');
    }

    // Check for many rows
    if (metrics.rows && metrics.rows > 1000) {
      recommendations.push('Consider pagination for large result sets');
    }

    // Check for N+1 query pattern
    if (query.match(/WHERE.*=\s*\$\?/i)) {
      const count = this.queries.get(query)?.length || 0;
      if (count > 10) {
        recommendations.push(
          `Possible N+1 query (${count} executions), consider using IN clause or JOIN`
        );
      }
    }

    // Check for missing indexes (heuristic)
    if (query.match(/WHERE.*(?:name|email|status|type|created_at|updated_at)/i)) {
      recommendations.push('Ensure indexes exist on frequently queried columns');
    }

    return recommendations.join('; ') || 'No specific recommendations';
  }

  /**
   * Generate optimization report
   */
  generateReport(): string {
    const stats = this.getAllStats();
    if (stats.length === 0) {
      return 'No query data available';
    }

    const lines: string[] = [];
    lines.push('');
    lines.push('='.repeat(120));
    lines.push('DATABASE QUERY ANALYSIS REPORT');
    lines.push('='.repeat(120));
    lines.push('');

    // Summary
    const totalQueries = stats.reduce((sum, s) => sum + s.count, 0);
    const totalTime = stats.reduce((sum, s) => sum + s.totalDuration, 0);
    const slowQueries = this.getSlowQueries().length;

    lines.push(`Total Queries Executed: ${totalQueries.toLocaleString()}`);
    lines.push(`Unique Query Patterns: ${stats.length}`);
    lines.push(`Total Query Time: ${(totalTime / 1000).toFixed(2)}s`);
    lines.push(`Slow Queries (>${this.slowQueryThreshold}ms): ${slowQueries}`);
    lines.push('');

    // Top 10 queries by total time
    lines.push('Top 10 Queries by Total Time:');
    lines.push('-'.repeat(120));
    lines.push(
      `${'Query'.padEnd(60)} ${'Count'.padStart(8)} ${'Total'.padStart(10)} ${'Avg'.padStart(10)} ${'P95'.padStart(10)} ${'P99'.padStart(10)}`
    );
    lines.push('-'.repeat(120));

    stats.slice(0, 10).forEach((stat) => {
      const query = this.truncateQuery(stat.query, 60);
      lines.push(
        `${query.padEnd(60)} ${stat.count.toString().padStart(8)} ${this.formatMs(stat.totalDuration).padStart(10)} ${this.formatMs(stat.avgDuration).padStart(10)} ${this.formatMs(stat.p95Duration).padStart(10)} ${this.formatMs(stat.p99Duration).padStart(10)}`
      );
    });

    lines.push('');

    // Slowest queries
    const slowest = this.getSlowQueries().slice(0, 10);
    if (slowest.length > 0) {
      lines.push('Top 10 Slowest Query Executions:');
      lines.push('-'.repeat(120));

      slowest.forEach((slow, index) => {
        lines.push(`${index + 1}. ${this.truncateQuery(slow.query, 110)}`);
        lines.push(`   Duration: ${this.formatMs(slow.duration)}`);
        lines.push(`   Recommendation: ${slow.recommendation}`);
        lines.push('');
      });
    }

    // N+1 Query Detection
    const n1Candidates = stats.filter((s) => s.count > 50 && s.avgDuration < 10);
    if (n1Candidates.length > 0) {
      lines.push('Possible N+1 Query Patterns (high frequency, low duration):');
      lines.push('-'.repeat(120));

      n1Candidates.slice(0, 5).forEach((stat) => {
        lines.push(`• ${this.truncateQuery(stat.query, 100)}`);
        lines.push(`  Executed ${stat.count} times, avg ${this.formatMs(stat.avgDuration)}`);
        lines.push('');
      });
    }

    lines.push('='.repeat(120));

    return lines.join('\n');
  }

  /**
   * Log the report
   */
  logReport(): void {
    console.log(this.generateReport());
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.queries.clear();
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
   * Truncate query string
   */
  private truncateQuery(query: string, maxLength: number): string {
    if (query.length <= maxLength) {
      return query;
    }
    return query.substring(0, maxLength - 3) + '...';
  }

  /**
   * Set slow query threshold
   */
  setSlowQueryThreshold(ms: number): void {
    this.slowQueryThreshold = ms;
  }

  /**
   * Enable analyzer
   */
  enable(): void {
    this.enabled = true;
  }

  /**
   * Disable analyzer
   */
  disable(): void {
    this.enabled = false;
  }
}

// Global query analyzer instance
export const queryAnalyzer = new QueryAnalyzer(100);
