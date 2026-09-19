#!/usr/bin/env ts-node
/**
 * Performance Report CLI
 *
 * Generates performance reports from running system
 *
 * Usage:
 *   ts-node scripts/performance-report.ts
 *   pnpm perf:report
 */

import { logPerformanceReport } from '../packages/performance/src/index.js';

async function main() {
  console.log('Generating performance report...');
  console.log('');

  // Generate and log report
  logPerformanceReport();

  console.log('');
  console.log('Report generation complete.');
  console.log('');
  console.log('Next steps:');
  console.log('  1. Review slow queries and add indexes');
  console.log(
    '  2. Check Redis command patterns for optimization opportunities'
  );
  console.log('  3. Profile slow operations in application code');
  console.log('  4. Run load tests again after optimizations');
}

main().catch((error) => {
  console.error('Error generating performance report:', error);
  process.exit(1);
});
