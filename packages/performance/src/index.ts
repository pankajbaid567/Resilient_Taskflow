/**
 * Performance profiling and optimization utilities
 */

export { Profiler, profiler, type ProfileResult, type ProfileStats } from './profiler.js';
export {
  QueryAnalyzer,
  queryAnalyzer,
  type QueryMetrics,
  type QueryStats,
  type SlowQuery,
} from './query-analyzer.js';
export {
  RedisAnalyzer,
  redisAnalyzer,
  type RedisMetrics,
  type RedisStats,
  type RedisRecommendation,
} from './redis-analyzer.js';

/**
 * Generate a comprehensive performance report
 */
export function generatePerformanceReport(): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('█'.repeat(120));
  lines.push('█' + ' '.repeat(118) + '█');
  lines.push('█' + ' COMPREHENSIVE PERFORMANCE ANALYSIS REPORT'.padStart(75) + ' '.repeat(43) + '█');
  lines.push('█' + ' '.repeat(118) + '█');
  lines.push('█'.repeat(120));
  lines.push('');

  // Application profiler
  lines.push(profiler.generateReport());

  // Database query analyzer
  lines.push(queryAnalyzer.generateReport());

  // Redis operations analyzer
  lines.push(redisAnalyzer.generateReport());

  lines.push('');
  lines.push('█'.repeat(120));
  lines.push('█' + ' END OF REPORT'.padStart(60) + ' '.repeat(58) + '█');
  lines.push('█'.repeat(120));
  lines.push('');

  return lines.join('\n');
}

/**
 * Log comprehensive performance report
 */
export function logPerformanceReport(): void {
  console.log(generatePerformanceReport());
}

/**
 * Clear all performance data
 */
export function clearPerformanceData(): void {
  profiler.clear();
  queryAnalyzer.clear();
  redisAnalyzer.clear();
}

/**
 * Enable all performance tracking
 */
export function enablePerformanceTracking(): void {
  profiler.enable();
  queryAnalyzer.enable();
  redisAnalyzer.enable();
}

/**
 * Disable all performance tracking
 */
export function disablePerformanceTracking(): void {
  profiler.disable();
  queryAnalyzer.disable();
  redisAnalyzer.disable();
}
