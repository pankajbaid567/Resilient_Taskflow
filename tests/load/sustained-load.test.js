/**
 * Sustained Load Test
 *
 * Purpose: Measure steady-state performance under sustained load
 * Duration: 5 minutes
 * Pattern: Ramp up → Sustain → Ramp down
 *
 * This test validates:
 * - System can handle sustained load without degradation
 * - Latency remains stable over time
 * - No memory leaks or resource exhaustion
 * - Queue depth remains manageable
 * - Success rate stays high (>99%)
 */

import { sleep } from 'k6';
import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';
import {
  TaskFlowClient,
  metrics,
  commonThresholds,
  randomJobType,
  randomPriority,
  randomPayload,
  collectSystemMetrics,
  thinkTime,
  handleError,
} from './utils.js';

// =============================================================================
// Test Configuration
// =============================================================================

export const options = {
  scenarios: {
    sustained_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 10 }, // Ramp up to 10 VUs over 1 minute
        { duration: '3m', target: 50 }, // Ramp up to 50 VUs over 3 minutes
        { duration: '3m', target: 50 }, // Sustain 50 VUs for 3 minutes
        { duration: '1m', target: 10 }, // Ramp down to 10 VUs over 1 minute
        { duration: '1m', target: 0 }, // Ramp down to 0 VUs over 1 minute
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    ...commonThresholds,
    // Sustained load specific thresholds
    http_req_duration: ['p(95)<500', 'p(99)<1000', 'avg<300'],
    http_req_failed: ['rate<0.01'], // Less than 1% error rate
    job_submission_duration: ['p(95)<200', 'p(99)<400'],
    queue_depth: ['value<500'], // Queue should not back up beyond 500
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

// =============================================================================
// Setup (runs once before test)
// =============================================================================

export function setup() {
  const client = new TaskFlowClient();

  console.log('='.repeat(80));
  console.log('SUSTAINED LOAD TEST - SETUP');
  console.log('='.repeat(80));

  // Health check
  console.log('Performing health check...');
  const health = client.healthCheck();
  console.log(`Health status: ${JSON.stringify(health)}`);

  if (!health || health.status !== 'healthy') {
    throw new Error('System is not healthy. Aborting test.');
  }

  // Get initial system state
  console.log('Collecting initial system state...');
  const queueStats = client.getQueueStats();
  const workerStats = client.getWorkerStats();

  console.log(`Initial queue depth: ${queueStats?.total || 0}`);
  console.log(
    `Active workers: ${workerStats?.workers?.filter((w) => w.status === 'ACTIVE').length || 0}`
  );

  const startTime = Date.now();

  console.log('Setup complete. Starting test...');
  console.log('='.repeat(80));

  return {
    startTime,
    initialQueueDepth: queueStats?.total || 0,
    initialWorkerCount: workerStats?.workers?.length || 0,
  };
}

// =============================================================================
// Main Test Logic (runs for each VU iteration)
// =============================================================================

export default function (data) {
  const client = new TaskFlowClient();

  try {
    // Submit a job
    const job = client.submitJob({
      type: randomJobType(),
      priority: randomPriority(),
      payload: randomPayload('small'),
      maxRetries: 3,
    });

    if (!job) {
      console.error('Failed to submit job');
      return;
    }

    // Simulate realistic think time between requests
    thinkTime(0.5, 2);

    // Occasionally check job status (10% of iterations)
    if (Math.random() < 0.1) {
      client.getJob(job.id);
    }

    // Occasionally list jobs (5% of iterations)
    if (Math.random() < 0.05) {
      client.listJobs({ limit: 10, status: 'QUEUED' });
    }

    // Collect system metrics every 10 iterations
    if (__ITER % 10 === 0) {
      collectSystemMetrics(client);
    }
  } catch (error) {
    handleError(error, 'main test function');
  }
}

// =============================================================================
// Teardown (runs once after test)
// =============================================================================

export function teardown(data) {
  const client = new TaskFlowClient();

  console.log('='.repeat(80));
  console.log('SUSTAINED LOAD TEST - TEARDOWN');
  console.log('='.repeat(80));

  // Collect final system state
  console.log('Collecting final system state...');
  const queueStats = client.getQueueStats();
  const workerStats = client.getWorkerStats();

  console.log(`Final queue depth: ${queueStats?.total || 0}`);
  console.log(
    `Active workers: ${workerStats?.workers?.filter((w) => w.status === 'ACTIVE').length || 0}`
  );

  const testDuration = (Date.now() - data.startTime) / 1000;
  console.log(`Test duration: ${testDuration.toFixed(2)}s`);

  // Check for queue backup
  const queueGrowth = (queueStats?.total || 0) - data.initialQueueDepth;
  if (queueGrowth > 100) {
    console.warn(
      `⚠️  Queue grew by ${queueGrowth} jobs during test. Workers may be under-provisioned.`
    );
  } else {
    console.log(`✅ Queue remained stable (growth: ${queueGrowth} jobs)`);
  }

  console.log('Teardown complete.');
  console.log('='.repeat(80));
}

// =============================================================================
// Custom Summary Report
// =============================================================================

export function handleSummary(data) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  // Calculate custom metrics
  const successRate = (
    (1 - (data.metrics.http_req_failed?.values?.rate || 0)) *
    100
  ).toFixed(2);
  const avgLatency = (data.metrics.http_req_duration?.values?.avg || 0).toFixed(
    2
  );
  const p95Latency = (
    data.metrics.http_req_duration?.values['p(95)'] || 0
  ).toFixed(2);
  const p99Latency = (
    data.metrics.http_req_duration?.values['p(99)'] || 0
  ).toFixed(2);
  const requestRate = (data.metrics.http_reqs?.values?.rate || 0).toFixed(2);

  // Custom summary text
  const customSummary = `
${'='.repeat(80)}
SUSTAINED LOAD TEST RESULTS
${'='.repeat(80)}

Test Configuration:
  Duration: 9 minutes (1m ramp up → 3m ramp to peak → 3m sustain → 2m ramp down)
  Peak VUs: 50 virtual users
  Pattern: Sustained load with gradual ramp-up

Performance Metrics:
  ✓ Request Rate:        ${requestRate} req/s
  ✓ Success Rate:        ${successRate}%
  ✓ Avg Latency:         ${avgLatency}ms
  ✓ P95 Latency:         ${p95Latency}ms
  ✓ P99 Latency:         ${p99Latency}ms

Thresholds:
  ${
    data.metrics.http_req_duration?.thresholds
      ? Object.entries(data.metrics.http_req_duration.thresholds)
          .map(([key, val]) => `  ${val.ok ? '✓' : '✗'} ${key}`)
          .join('\n')
      : 'No thresholds defined'
  }

Job Metrics:
  Job Submissions:       ${data.metrics.job_submission_success?.values?.count || 0}
  Job Failures:          ${data.metrics.job_submission_failure?.values?.count || 0}
  Avg Submission Time:   ${(data.metrics.job_submission_duration?.values?.avg || 0).toFixed(2)}ms
  P95 Submission Time:   ${(data.metrics.job_submission_duration?.values['p(95)'] || 0).toFixed(2)}ms

Analysis:
  ${successRate >= 99 ? '✅ Success rate is excellent (≥99%)' : `⚠️  Success rate is below target: ${successRate}%`}
  ${p95Latency <= 500 ? '✅ P95 latency is within target (≤500ms)' : `⚠️  P95 latency exceeds target: ${p95Latency}ms`}
  ${p99Latency <= 1000 ? '✅ P99 latency is within target (≤1000ms)' : `⚠️  P99 latency exceeds target: ${p99Latency}ms`}

${'='.repeat(80)}
`;

  return {
    stdout:
      textSummary(data, { indent: ' ', enableColors: true }) + customSummary,
    [`results/sustained-load-${timestamp}.html`]: htmlReport(data),
    [`results/sustained-load-${timestamp}.json`]: JSON.stringify(data, null, 2),
  };
}
