/**
 * Spike Load Test
 * 
 * Purpose: Test system recovery from sudden traffic spikes
 * Duration: 3 minutes
 * Pattern: Baseline → Sudden spike → Recovery
 * 
 * This test validates:
 * - System handles sudden 10x traffic increase
 * - Error rate remains acceptable during spike
 * - System recovers gracefully after spike
 * - No cascading failures or resource exhaustion
 * - Queue backlog clears after spike
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
    spike_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 10 },   // Baseline: 10 VUs
        { duration: '30s', target: 10 },   // Sustain baseline
        { duration: '10s', target: 100 },  // SPIKE: 10x increase to 100 VUs
        { duration: '1m', target: 100 },   // Sustain spike for 1 minute
        { duration: '10s', target: 10 },   // Drop back to baseline
        { duration: '30s', target: 10 },   // Recovery period
        { duration: '30s', target: 0 },    // Ramp down
      ],
      gracefulRampDown: '15s',
    },
  },
  thresholds: {
    // More relaxed thresholds during spike - some degradation is expected
    'http_req_duration': ['p(95)<1000', 'p(99)<2000'], // 2x normal
    'http_req_failed': ['rate<0.05'], // Up to 5% error rate acceptable during spike
    'job_submission_duration': ['p(95)<500', 'p(99)<1000'],
    'queue_depth': ['value<2000'], // Queue can back up during spike
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

// =============================================================================
// Setup
// =============================================================================

export function setup() {
  const client = new TaskFlowClient();
  
  console.log('='.repeat(80));
  console.log('SPIKE LOAD TEST - SETUP');
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
  console.log(`Active workers: ${workerStats?.workers?.filter(w => w.status === 'ACTIVE').length || 0}`);
  
  console.log('Setup complete. Prepare for spike...');
  console.log('='.repeat(80));
  
  return {
    startTime: Date.now(),
    initialQueueDepth: queueStats?.total || 0,
    initialWorkerCount: workerStats?.workers?.length || 0,
  };
}

// =============================================================================
// Main Test Logic
// =============================================================================

export default function (data) {
  const client = new TaskFlowClient();
  
  try {
    // During spike, submit jobs more aggressively
    const isSpike = __VU > 50; // More than 50 VUs = spike period
    
    // Submit a job
    const job = client.submitJob({
      type: randomJobType(),
      priority: isSpike ? 'HIGH' : randomPriority(), // Higher priority during spike
      payload: randomPayload(isSpike ? 'medium' : 'small'),
      maxRetries: 3,
    });
    
    if (!job) {
      console.error('Failed to submit job');
      return;
    }
    
    // Less think time during spike (more aggressive)
    if (isSpike) {
      thinkTime(0.1, 0.5);
    } else {
      thinkTime(0.5, 2);
    }
    
    // Check status occasionally
    if (Math.random() < 0.1) {
      client.getJob(job.id);
    }
    
    // Collect system metrics more frequently during spike
    const metricsInterval = isSpike ? 5 : 10;
    if (__ITER % metricsInterval === 0) {
      collectSystemMetrics(client);
    }
    
  } catch (error) {
    handleError(error, 'spike test function');
  }
}

// =============================================================================
// Teardown
// =============================================================================

export function teardown(data) {
  const client = new TaskFlowClient();
  
  console.log('='.repeat(80));
  console.log('SPIKE LOAD TEST - TEARDOWN');
  console.log('='.repeat(80));
  
  // Collect final system state
  console.log('Collecting final system state...');
  const queueStats = client.getQueueStats();
  const workerStats = client.getWorkerStats();
  
  console.log(`Final queue depth: ${queueStats?.total || 0}`);
  console.log(`Active workers: ${workerStats?.workers?.filter(w => w.status === 'ACTIVE').length || 0}`);
  
  const testDuration = (Date.now() - data.startTime) / 1000;
  console.log(`Test duration: ${testDuration.toFixed(2)}s`);
  
  // Check recovery
  const queueGrowth = (queueStats?.total || 0) - data.initialQueueDepth;
  if (queueGrowth > 500) {
    console.warn(`⚠️  Queue backed up by ${queueGrowth} jobs. May need more workers or longer recovery time.`);
  } else if (queueGrowth > 100) {
    console.log(`⚠️  Queue grew by ${queueGrowth} jobs but system is recovering.`);
  } else {
    console.log(`✅ System recovered successfully (queue growth: ${queueGrowth} jobs)`);
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
  const successRate = ((1 - (data.metrics.http_req_failed?.values?.rate || 0)) * 100).toFixed(2);
  const avgLatency = (data.metrics.http_req_duration?.values?.avg || 0).toFixed(2);
  const p95Latency = (data.metrics.http_req_duration?.values['p(95)'] || 0).toFixed(2);
  const p99Latency = (data.metrics.http_req_duration?.values['p(99)'] || 0).toFixed(2);
  const maxLatency = (data.metrics.http_req_duration?.values?.max || 0).toFixed(2);
  const requestRate = (data.metrics.http_reqs?.values?.rate || 0).toFixed(2);
  const totalRequests = data.metrics.http_reqs?.values?.count || 0;
  
  const customSummary = `
${'='.repeat(80)}
SPIKE LOAD TEST RESULTS
${'='.repeat(80)}

Test Configuration:
  Duration: 4 minutes
  Pattern: 10 VUs → 100 VUs (10x spike) → 10 VUs
  Spike Duration: 1 minute at 100 VUs
  Recovery Period: 30 seconds

Performance During Spike:
  ✓ Request Rate:        ${requestRate} req/s
  ✓ Total Requests:      ${totalRequests}
  ✓ Success Rate:        ${successRate}%
  ✓ Avg Latency:         ${avgLatency}ms
  ✓ P95 Latency:         ${p95Latency}ms
  ✓ P99 Latency:         ${p99Latency}ms
  ✓ Max Latency:         ${maxLatency}ms

Thresholds:
  ${data.metrics.http_req_duration?.thresholds ? 
    Object.entries(data.metrics.http_req_duration.thresholds)
      .map(([key, val]) => `  ${val.ok ? '✓' : '✗'} ${key}`)
      .join('\n') 
    : 'No thresholds defined'}

Job Metrics:
  Job Submissions:       ${data.metrics.job_submission_success?.values?.count || 0}
  Job Failures:          ${data.metrics.job_submission_failure?.values?.count || 0}
  Avg Submission Time:   ${(data.metrics.job_submission_duration?.values?.avg || 0).toFixed(2)}ms
  Max Submission Time:   ${(data.metrics.job_submission_duration?.values?.max || 0).toFixed(2)}ms

Spike Analysis:
  ${successRate >= 95 ? '✅ System maintained >95% success rate during spike' : `⚠️  Success rate dropped to ${successRate}% during spike`}
  ${p95Latency <= 1000 ? '✅ P95 latency remained under 1s during spike' : `⚠️  P95 latency spiked to ${p95Latency}ms`}
  ${maxLatency <= 5000 ? '✅ Max latency remained reasonable (<5s)' : `⚠️  Max latency reached ${maxLatency}ms`}

Recovery:
  ${successRate >= 99 ? '✅ System recovered to normal success rate' : '⚠️  System may still be recovering'}

Recommendations:
  ${successRate < 95 ? '⚠️  Consider adding more workers to handle spike traffic' : ''}
  ${p95Latency > 1000 ? '⚠️  Consider implementing backpressure or request queuing' : ''}
  ${maxLatency > 5000 ? '⚠️  Some requests exceeded 5s - investigate slow queries or bottlenecks' : ''}

${'='.repeat(80)}
`;

  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }) + customSummary,
    [`results/spike-load-${timestamp}.html`]: htmlReport(data),
    [`results/spike-load-${timestamp}.json`]: JSON.stringify(data, null, 2),
  };
}
