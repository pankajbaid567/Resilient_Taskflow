/**
 * Redis Operations Analyzer
 *
 * Analyzes Redis command patterns and identifies optimization opportunities
 */

import { logger } from '@taskflow/logger';

export interface RedisMetrics {
  command: string;
  duration: number;
  timestamp: number;
  key?: string;
  args?: unknown[];
}

export interface RedisStats {
  command: string;
  count: number;
  totalDuration: number;
  avgDuration: number;
  minDuration: number;
  maxDuration: number;
  p95Duration: number;
  p99Duration: number;
}

export interface RedisRecommendation {
  issue: string;
  severity: 'low' | 'medium' | 'high';
  recommendation: string;
  affectedCommands?: string[];
}

/**
 * Redis operations analyzer
 */
export class RedisAnalyzer {
  private operations: Map<string, RedisMetrics[]> = new Map();
  private slowCommandThreshold: number = 10; // ms
  private enabled: boolean = true;

  constructor(slowCommandThreshold: number = 10) {
    this.slowCommandThreshold = slowCommandThreshold;
  }

  /**
   * Record a Redis operation
   */
  record(
    command: string,
    duration: number,
    metadata?: Partial<RedisMetrics>
  ): void {
    if (!this.enabled) return;

    const normalizedCommand = command.toUpperCase();
    const metrics: RedisMetrics = {
      command: normalizedCommand,
      duration,
      timestamp: Date.now(),
      ...metadata,
    };

    const operations = this.operations.get(normalizedCommand) || [];
    operations.push(metrics);
    this.operations.set(normalizedCommand, operations);

    // Log slow commands
    if (duration > this.slowCommandThreshold) {
      logger.warn('Slow Redis command detected', {
        command: normalizedCommand,
        duration: `${duration.toFixed(2)}ms`,
        threshold: `${this.slowCommandThreshold}ms`,
        key: metadata?.key,
      });
    }
  }

  /**
   * Get statistics for a command
   */
  getStats(command: string): RedisStats | null {
    const normalizedCommand = command.toUpperCase();
    const operations = this.operations.get(normalizedCommand);
    if (!operations || operations.length === 0) {
      return null;
    }

    const durations = operations.map((op) => op.duration).sort((a, b) => a - b);
    const count = durations.length;
    const totalDuration = durations.reduce((sum, d) => sum + d, 0);

    return {
      command: normalizedCommand,
      count,
      totalDuration,
      avgDuration: totalDuration / count,
      minDuration: durations[0]!,
      maxDuration: durations[count - 1]!,
      p95Duration: this.percentile(durations, 0.95),
      p99Duration: this.percentile(durations, 0.99),
    };
  }

  /**
   * Get all command statistics
   */
  getAllStats(): RedisStats[] {
    const stats: RedisStats[] = [];
    for (const command of this.operations.keys()) {
      const commandStats = this.getStats(command);
      if (commandStats) {
        stats.push(commandStats);
      }
    }
    return stats.sort((a, b) => b.totalDuration - a.totalDuration);
  }

  /**
   * Get slow commands
   */
  getSlowCommands(threshold?: number): RedisMetrics[] {
    const th = threshold || this.slowCommandThreshold;
    const slowCommands: RedisMetrics[] = [];

    for (const operations of this.operations.values()) {
      for (const op of operations) {
        if (op.duration > th) {
          slowCommands.push(op);
        }
      }
    }

    return slowCommands.sort((a, b) => b.duration - a.duration);
  }

  /**
   * Analyze command patterns and generate recommendations
   */
  analyzePatterns(): RedisRecommendation[] {
    const recommendations: RedisRecommendation[] = [];
    const stats = this.getAllStats();

    // Check for frequent GET/SET instead of HGET/HSET
    const getCount = stats.find((s) => s.command === 'GET')?.count || 0;
    const setCount = stats.find((s) => s.command === 'SET')?.count || 0;
    if (getCount + setCount > 1000) {
      recommendations.push({
        issue: 'High GET/SET usage',
        severity: 'medium',
        recommendation:
          'Consider using HGET/HSET with hash keys to reduce key count and improve memory efficiency',
        affectedCommands: ['GET', 'SET'],
      });
    }

    // Check for KEYS command usage
    const keysCount = stats.find((s) => s.command === 'KEYS')?.count || 0;
    if (keysCount > 0) {
      recommendations.push({
        issue: 'KEYS command detected',
        severity: 'high',
        recommendation:
          'KEYS blocks Redis. Use SCAN for production. Never use KEYS in production code.',
        affectedCommands: ['KEYS'],
      });
    }

    // Check for DEL instead of UNLINK
    const delCount = stats.find((s) => s.command === 'DEL')?.count || 0;
    if (delCount > 100) {
      recommendations.push({
        issue: 'High DEL usage',
        severity: 'low',
        recommendation:
          'Consider using UNLINK instead of DEL for large keys. UNLINK is non-blocking.',
        affectedCommands: ['DEL'],
      });
    }

    // Check for missing pipelining
    const totalCommands = stats.reduce((sum, s) => sum + s.count, 0);
    const pipelineCount =
      stats.find((s) => s.command === 'PIPELINE')?.count || 0;
    if (totalCommands > 1000 && pipelineCount === 0) {
      recommendations.push({
        issue: 'No pipelining detected',
        severity: 'medium',
        recommendation:
          'Use pipelining for bulk operations to reduce round-trip time (RTT)',
      });
    }

    // Check for SMEMBERS on large sets
    const smembersStats = stats.find((s) => s.command === 'SMEMBERS');
    if (smembersStats && smembersStats.avgDuration > 10) {
      recommendations.push({
        issue: 'Slow SMEMBERS operations',
        severity: 'medium',
        recommendation:
          'SMEMBERS returns entire set. Use SSCAN for large sets or consider pagination.',
        affectedCommands: ['SMEMBERS'],
      });
    }

    // Check for LRANGE without limits
    const lrangeStats = stats.find((s) => s.command === 'LRANGE');
    if (lrangeStats && lrangeStats.avgDuration > 10) {
      recommendations.push({
        issue: 'Slow LRANGE operations',
        severity: 'medium',
        recommendation:
          'Always use start/stop parameters with LRANGE. Avoid LRANGE 0 -1 on large lists.',
        affectedCommands: ['LRANGE'],
      });
    }

    // Check for ZADD instead of batch ZADD
    const zaddCount = stats.find((s) => s.command === 'ZADD')?.count || 0;
    if (zaddCount > 100) {
      recommendations.push({
        issue: 'High individual ZADD usage',
        severity: 'low',
        recommendation:
          'Batch multiple ZADD operations into a single command or use pipelining',
        affectedCommands: ['ZADD'],
      });
    }

    // Check for EXPIRE vs TTL at creation
    const expireCount = stats.find((s) => s.command === 'EXPIRE')?.count || 0;
    if (expireCount > setCount * 0.5) {
      recommendations.push({
        issue: 'Separate EXPIRE calls',
        severity: 'low',
        recommendation:
          'Use SETEX/SET with EX option instead of separate SET + EXPIRE',
        affectedCommands: ['EXPIRE', 'SET'],
      });
    }

    // Check for WATCH/MULTI/EXEC patterns
    const watchCount = stats.find((s) => s.command === 'WATCH')?.count || 0;
    const multiCount = stats.find((s) => s.command === 'MULTI')?.count || 0;
    if (watchCount > 0 && watchCount !== multiCount) {
      recommendations.push({
        issue: 'Mismatched WATCH/MULTI usage',
        severity: 'medium',
        recommendation:
          'Ensure WATCH is followed by MULTI/EXEC. Unmatched WATCH can cause issues.',
        affectedCommands: ['WATCH', 'MULTI', 'EXEC'],
      });
    }

    // Check for high connection overhead
    const avgCommandDuration =
      stats.reduce((sum, s) => sum + s.avgDuration, 0) / stats.length;
    if (avgCommandDuration > 5) {
      recommendations.push({
        issue: 'High average command duration',
        severity: 'high',
        recommendation:
          'Network latency or connection issues detected. Check Redis connection pooling and network.',
      });
    }

    return recommendations.sort((a, b) => {
      const severityOrder = { high: 3, medium: 2, low: 1 };
      return severityOrder[b.severity] - severityOrder[a.severity];
    });
  }

  /**
   * Generate optimization report
   */
  generateReport(): string {
    const stats = this.getAllStats();
    if (stats.length === 0) {
      return 'No Redis operation data available';
    }

    const lines: string[] = [];
    lines.push('');
    lines.push('='.repeat(120));
    lines.push('REDIS OPERATIONS ANALYSIS REPORT');
    lines.push('='.repeat(120));
    lines.push('');

    // Summary
    const totalCommands = stats.reduce((sum, s) => sum + s.count, 0);
    const totalTime = stats.reduce((sum, s) => sum + s.totalDuration, 0);
    const slowCommands = this.getSlowCommands().length;

    lines.push(`Total Commands Executed: ${totalCommands.toLocaleString()}`);
    lines.push(`Unique Command Types: ${stats.length}`);
    lines.push(`Total Execution Time: ${(totalTime / 1000).toFixed(2)}s`);
    lines.push(
      `Slow Commands (>${this.slowCommandThreshold}ms): ${slowCommands}`
    );
    lines.push(
      `Avg Command Duration: ${(totalTime / totalCommands).toFixed(2)}ms`
    );
    lines.push('');

    // Top commands by frequency
    const byFrequency = [...stats].sort((a, b) => b.count - a.count);
    lines.push('Top 10 Commands by Frequency:');
    lines.push('-'.repeat(120));
    lines.push(
      `${'Command'.padEnd(20)} ${'Count'.padStart(12)} ${'Total'.padStart(12)} ${'Avg'.padStart(10)} ${'P95'.padStart(10)} ${'P99'.padStart(10)} ${'Max'.padStart(10)}`
    );
    lines.push('-'.repeat(120));

    byFrequency.slice(0, 10).forEach((stat) => {
      lines.push(
        `${stat.command.padEnd(20)} ${stat.count.toString().padStart(12)} ${this.formatMs(stat.totalDuration).padStart(12)} ${this.formatMs(stat.avgDuration).padStart(10)} ${this.formatMs(stat.p95Duration).padStart(10)} ${this.formatMs(stat.p99Duration).padStart(10)} ${this.formatMs(stat.maxDuration).padStart(10)}`
      );
    });

    lines.push('');

    // Slowest commands
    const slowest = this.getSlowCommands().slice(0, 10);
    if (slowest.length > 0) {
      lines.push('Top 10 Slowest Command Executions:');
      lines.push('-'.repeat(120));

      slowest.forEach((slow, index) => {
        lines.push(
          `${index + 1}. ${slow.command} - ${this.formatMs(slow.duration)} - Key: ${slow.key || 'N/A'}`
        );
      });

      lines.push('');
    }

    // Optimization recommendations
    const recommendations = this.analyzePatterns();
    if (recommendations.length > 0) {
      lines.push('Optimization Recommendations:');
      lines.push('-'.repeat(120));

      recommendations.forEach((rec, index) => {
        const severityIcon =
          rec.severity === 'high'
            ? '🔴'
            : rec.severity === 'medium'
              ? '🟡'
              : '🟢';
        lines.push(
          `${index + 1}. ${severityIcon} ${rec.issue} (${rec.severity.toUpperCase()})`
        );
        lines.push(`   ${rec.recommendation}`);
        if (rec.affectedCommands) {
          lines.push(`   Affected: ${rec.affectedCommands.join(', ')}`);
        }
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
    this.operations.clear();
  }

  /**
   * Calculate percentile
   */
  private percentile(sorted: number[], p: number): number {
    const index = Math.ceil(sorted.length * p) - 1;
    return sorted[Math.max(0, index)]!;
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
   * Set slow command threshold
   */
  setSlowCommandThreshold(ms: number): void {
    this.slowCommandThreshold = ms;
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

// Global Redis analyzer instance
export const redisAnalyzer = new RedisAnalyzer(10);
