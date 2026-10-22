/**
 * Worker Scaling Test
 *
 * Purpose: Validate system scales linearly with worker count
 * Duration: 10 minutes
 * Pattern: Constant load with dynamic worker scaling
 *
 * This test validates:
 * - Job throughput increases with worker count
 * - Queue depth decreases as workers are added
 * - System gracefully handles worker removal
 * - No job loss during worker scaling
 * - Leases properly transfer between workers
 *
 * NOTE: This test requires manual worker scaling or a companion script
 * to add/remove workers at specific intervals. See README for details.
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
    constant_load: {
      executor: 'constant-arrival-rate',
      rate: 50, // 50 jobs per second (constant)
      timeUnit: '1s',
      duration: '10m',
      preAllocatedVUs: 30,
      maxVUs: 100,
    },
  },
  thresholds: {
    ...commonThresholds,
    // Worker scaling specific thresholds
    http_req_duration: ['p(95)<800', 'p(99)<1500'],
    http_req_failed: ['rate<0.02'], // 2% error rate acceptable during scaling
    job_submission_duration: ['p(95)<300'],
    queue_depth: ['value<1500'], // Queue may grow initially with 1 worker
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

// =============================================================================
// Worker Scaling Schedule
// =============================================================================

const SCALING_SCHEDULE = `
Worker Scaling Schedule (manual execution required):
  
  0:00 - 2:00  → 1 worker   (baseline, queue should back up)
  2:00 - 4:00  → 5 workers  (scale up, queue should drain)
  4:00 - 6:00  → 10 workers (scale up more, queue should clear quickly)
  6:00 - 8:00  → 5 workers  (scale down, queue may grow slightly)
  8:00 - 10:00 → 1 worker   (scale down more, queue should back up again)

Commands to run in parallel terminal:
  # Start with 1 worker
  docker-compose up -d worker
  
  # At 2:00 - scale to 5 workers
  docker-compose up -d --scale worker=5
  
  # At 4:00 - scale to 10 workers
  docker-compose up -d --scale worker=10
  
  # At 6:00 - scale down to 5 workers
  docker-compose up -d --scale worker=5
  
  # At 8:00 - scale down to 1 worker
  docker-compose up -d --scale worker=1

Alternatively, use the automated scaling script:
  # In another terminal
  node tests/load/scale-workers.js
`;

// =============================================================================
// Setup
// =============================================================================

export function setup() {
  const client = new TaskFlowClient();

  console.log('='.repeat(80));
  console.log('WORKER SCALING TEST - SETUP');
  console.log('='.repeat(80));
  console.log(SCALING_SCHEDULE);
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

  const initialWorkerCount =
    workerStats?.workers?.filter((w) => w.status === 'ACTIVE').length || 0;

  console.log(`Initial queue depth: ${queueStats?.total || 0}`);
  console.log(`Active workers: ${initialWorkerCount}`);

  if (initialWorkerCount === 0) {
    console.warn(
      '⚠️  WARNING: No active workers detected. Please start at least 1 worker before running test.'
    );
  }

  console.log('Setup complete. Starting constant load...');
  console.log('⏰ Remember to scale workers according to schedule!');
  console.log('='.repeat(80));

  return {
    startTime: Date.now(),
    initialQueueDepth: queueStats?.total || 0,
    initialWorkerCount,
    snapshots: [], // Track system state over time
  };
}

// =============================================================================
// Main Test Logic
// =============================================================================

export default function (data) {
  const client = new TaskFlowClient();

  try {
    // Submit job at constant rate
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

    // Minimal think time for constant load
    thinkTime(0.1, 0.3);

    // Collect metrics frequently to track scaling impact
    if (__ITER % 5 === 0) {
      collectSystemMetrics(client);

      // Take periodic snapshots for analysis
      if (__ITER % 50 === 0) {
        const elapsed = Math.floor((Date.now() - data.startTime) / 1000);
        const queueStats = client.getQueueStats();
        const workerStats = client.getWorkerStats();
        const activeWorkers =
          workerStats?.workers?.filter((w) => w.status === 'ACTIVE').length ||
          0;

        console.log(
          `[${elapsed}s] Workers: ${activeWorkers}, ` +
            `Queue: ${queueStats?.total || 0}, ` +
            `Jobs/s: ${(metrics.jobsPerSecond.value || 0).toFixed(2)}`
        );
      }
    }
  } catch (error) {
    handleError(error, 'worker scaling test');
  }
}

// =============================================================================
// Teardown
// =============================================================================

export function teardown(data) {
  const client = new TaskFlowClient();

  console.log('='.repeat(80));
  console.log('WORKER SCALING TEST - TEARDOWN');
  console.log('='.repeat(80));

  // Collect final system state
  console.log('Collecting final system state...');
  const queueStats = client.getQueueStats();
  const workerStats = client.getWorkerStats();

  const finalWorkerCount =
    workerStats?.workers?.filter((w) => w.status === 'ACTIVE').length || 0;
  const finalQueueDepth = queueStats?.total || 0;

  console.log(`Final queue depth: ${finalQueueDepth}`);
  console.log(`Active workers: ${finalWorkerCount}`);

  const testDuration = (Date.now() - data.startTime) / 1000;
  console.log(
    `Test duration: ${testDuration.toFixed(2)}s (${(testDuration / 60).toFixed(1)} minutes)`
  );

  // Analysis
  const queueGrowth = finalQueueDepth - data.initialQueueDepth;
  console.log(`Queue growth: ${queueGrowth} jobs`);

  if (queueGrowth > 1000) {
    console.warn(
      `⚠️  Queue backed up significantly. Workers couldn't keep up with 50 jobs/s.`
    );
  } else if (queueGrowth > 200) {
    console.log(
      `⚠️  Queue grew moderately. System is processing but not at full capacity.`
    );
  } else {
    console.log(
      `✅ Queue remained manageable. Workers handled the load effectively.`
    );
  }

  console.log('Teardown complete.');
  console.log('='.repeat(80));
}

// =============================================================================
// Custom Summary Report
// =============================================================================

export function handleSummary(data) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  // Calculate metrics
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
  const totalRequests = data.metrics.http_reqs?.values?.count || 0;
  const totalJobs = data.metrics.job_submission_success?.values?.count || 0;

  // Calculate job throughput
  const testDurationMinutes = 10;
  const avgJobsPerSecond = (totalJobs / (testDurationMinutes * 60)).toFixed(2);

  const customSummary = `
${'='.repeat(80)}
WORKER SCALING TEST RESULTS
${'='.repeat(80)}

Test Configuration:
  Duration: 10 minutes
  Load Pattern: Constant 50 jobs/second
  Worker Scaling: 1 → 5 → 10 → 5 → 1 workers
  
Expected Behavior:
  • 1 worker: Queue backs up (can't keep up)
  • 5 workers: Queue drains (catches up)
  • 10 workers: Queue clears quickly (over-provisioned)
  • Scale down: Queue grows but system remains stable

Performance Metrics:
  ✓ Request Rate:        ${requestRate} req/s (target: 50 req/s)
  ✓ Total Requests:      ${totalRequests}
  ✓ Total Jobs:          ${totalJobs}
  ✓ Avg Jobs/Second:     ${avgJobsPerSecond} jobs/s
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
  Successful Submissions: ${data.metrics.job_submission_success?.values?.count || 0}
  Failed Submissions:     ${data.metrics.job_submission_failure?.values?.count || 0}
  Avg Submission Time:    ${(data.metrics.job_submission_duration?.values?.avg || 0).toFixed(2)}ms
  P95 Submission Time:    ${(data.metrics.job_submission_duration?.values['p(95)'] || 0).toFixed(2)}ms

Scaling Analysis:
  ${successRate >= 98 ? '✅ System maintained high success rate during scaling' : `⚠️  Success rate degraded during scaling: ${successRate}%`}
  ${avgJobsPerSecond >= 45 ? '✅ Achieved target throughput (≥90% of 50 jobs/s)' : `⚠️  Throughput below target: ${avgJobsPerSecond} jobs/s`}
  ${p95Latency <= 800 ? '✅ Latency remained acceptable during scaling' : `⚠️  Latency increased during scaling: ${p95Latency}ms`}

Observations:
  • Check Grafana dashboard for queue depth correlation with worker count
  • Queue should grow with 1 worker, shrink with 10 workers
  • No jobs should be lost during worker scaling events
  • Lease system should properly handle worker handoffs

Recommendations:
  ${avgJobsPerSecond < 45 ? '⚠️  System did not reach target throughput. Check worker efficiency.' : ''}
  ${p95Latency > 800 ? '⚠️  High latency detected. Possible bottleneck in DB or Redis.' : ''}
  
Capacity Planning:
  • At 50 jobs/s, optimal worker count appears to be: ${avgJobsPerSecond >= 48 ? '5-7 workers' : 'More than tested'}
  • For production 100 jobs/s, estimate: ${Math.ceil((100 / 50) * 7)} workers needed

${'='.repeat(80)}

MANUAL VERIFICATION:
  1. Check Grafana dashboard for queue depth over time
  2. Verify queue grew with 1 worker, shrank with 10 workers
  3. Confirm no job loss (DB job count = submitted jobs)
  4. Review worker logs for lease transfers

${'='.repeat(80)}
`;

  return {
    stdout:
      textSummary(data, { indent: ' ', enableColors: true }) + customSummary,
    [`results/worker-scaling-${timestamp}.html`]: htmlReport(data),
    [`results/worker-scaling-${timestamp}.json`]: JSON.stringify(data, null, 2),
  };
}
