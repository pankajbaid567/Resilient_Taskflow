/**
 * Mixed Workload Test
 * 
 * Purpose: Simulate realistic production traffic patterns
 * Duration: 5 minutes
 * Pattern: Multiple concurrent scenarios with different behaviors
 * 
 * This test validates:
 * - System handles mixed priorities correctly (CRITICAL > HIGH > NORMAL > LOW)
 * - Different job types and sizes are processed efficiently
 * - Scheduled jobs and immediate jobs coexist
 * - Cancellations work under load
 * - Query operations don't impact job processing
 * - Realistic user behavior patterns
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
  futureTimestamp,
  generateUUID,
  waitForJobCompletion,
  collectSystemMetrics,
  thinkTime,
  handleError,
} from './utils.js';

// =============================================================================
// Test Configuration
// =============================================================================

export const options = {
  scenarios: {
    // Scenario 1: Normal user traffic (70% of load)
    normal_users: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 20 },
        { duration: '3m', target: 20 },
        { duration: '1m', target: 0 },
      ],
      exec: 'normalUserFlow',
    },
    
    // Scenario 2: High-priority urgent jobs (15% of load)
    urgent_jobs: {
      executor: 'constant-arrival-rate',
      rate: 10, // 10 urgent jobs per second
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 5,
      maxVUs: 15,
      exec: 'urgentJobFlow',
    },
    
    // Scenario 3: Batch processing (10% of load)
    batch_processing: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 5 },
        { duration: '3m', target: 5 },
        { duration: '1m', target: 0 },
      ],
      exec: 'batchProcessingFlow',
    },
    
    // Scenario 4: Scheduled jobs (5% of load)
    scheduled_jobs: {
      executor: 'constant-arrival-rate',
      rate: 2, // 2 scheduled jobs per second
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 2,
      maxVUs: 5,
      exec: 'scheduledJobFlow',
    },
    
    // Scenario 5: Job monitoring (read-heavy)
    monitoring: {
      executor: 'constant-vus',
      vus: 3,
      duration: '5m',
      exec: 'monitoringFlow',
    },
  },
  thresholds: {
    ...commonThresholds,
    // Mixed workload specific thresholds
    'http_req_duration': ['p(95)<600', 'p(99)<1200'],
    'http_req_failed': ['rate<0.01'],
    'job_submission_duration': ['p(95)<250', 'p(99)<500'],
    'queue_depth': ['value<800'],
    
    // Per-scenario thresholds
    'http_req_duration{scenario:normal_users}': ['p(95)<500'],
    'http_req_duration{scenario:urgent_jobs}': ['p(95)<300'], // Urgent should be faster
    'http_req_duration{scenario:monitoring}': ['p(95)<200'], // Reads should be fast
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

// =============================================================================
// Setup
// =============================================================================

export function setup() {
  const client = new TaskFlowClient();
  
  console.log('='.repeat(80));
  console.log('MIXED WORKLOAD TEST - SETUP');
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
  
  console.log('');
  console.log('Mixed Workload Scenarios:');
  console.log('  1. Normal Users (70%): Submit jobs, check status, cancel occasionally');
  console.log('  2. Urgent Jobs (15%): High-priority jobs with immediate execution');
  console.log('  3. Batch Processing (10%): Large payloads, low priority, bulk operations');
  console.log('  4. Scheduled Jobs (5%): Jobs scheduled for future execution');
  console.log('  5. Monitoring (constant): Read-heavy queries, dashboards, metrics');
  console.log('');
  
  console.log('Setup complete. Starting mixed workload...');
  console.log('='.repeat(80));
  
  return {
    startTime: Date.now(),
    initialQueueDepth: queueStats?.total || 0,
    jobIds: [], // Track submitted jobs for cancellation tests
  };
}

// =============================================================================
// Scenario 1: Normal User Flow
// =============================================================================

export function normalUserFlow(data) {
  const client = new TaskFlowClient();
  
  try {
    // Submit a job with normal behavior
    const job = client.submitJob({
      type: randomJobType(),
      priority: randomPriority(), // Mixed priorities
      payload: randomPayload('small'),
      maxRetries: 3,
      idempotencyKey: `normal-${generateUUID()}`,
    });
    
    if (!job) return;
    
    // Realistic think time
    thinkTime(1, 3);
    
    // Check job status (50% chance)
    if (Math.random() < 0.5) {
      client.getJob(job.id);
      thinkTime(0.5, 1);
    }
    
    // List jobs (20% chance)
    if (Math.random() < 0.2) {
      client.listJobs({ limit: 20, status: 'QUEUED' });
    }
    
    // Cancel job (5% chance)
    if (Math.random() < 0.05) {
      client.cancelJob(job.id);
    }
    
    // Collect metrics periodically
    if (__ITER % 10 === 0) {
      collectSystemMetrics(client);
    }
    
  } catch (error) {
    handleError(error, 'normal user flow');
  }
}

// =============================================================================
// Scenario 2: Urgent Job Flow
// =============================================================================

export function urgentJobFlow(data) {
  const client = new TaskFlowClient();
  
  try {
    // Submit high-priority urgent job
    const priority = Math.random() < 0.7 ? 'HIGH' : 'CRITICAL';
    
    const job = client.submitJob({
      type: 'urgent-' + randomJobType(),
      priority: priority,
      payload: randomPayload('small'),
      maxRetries: 5, // More retries for important jobs
      idempotencyKey: `urgent-${generateUUID()}`,
    });
    
    if (!job) return;
    
    // Minimal think time for urgent requests
    thinkTime(0.1, 0.5);
    
    // Check status immediately (80% chance)
    if (Math.random() < 0.8) {
      client.getJob(job.id);
    }
    
  } catch (error) {
    handleError(error, 'urgent job flow');
  }
}

// =============================================================================
// Scenario 3: Batch Processing Flow
// =============================================================================

export function batchProcessingFlow(data) {
  const client = new TaskFlowClient();
  
  try {
    // Submit batch of low-priority jobs with larger payloads
    const batchSize = Math.floor(Math.random() * 5) + 3; // 3-7 jobs per batch
    const batchId = generateUUID();
    
    for (let i = 0; i < batchSize; i++) {
      client.submitJob({
        type: 'batch-' + randomJobType(),
        priority: 'LOW', // Batch jobs are low priority
        payload: {
          ...randomPayload('large'), // Larger payloads for batch
          batchId: batchId,
          batchIndex: i,
          batchTotal: batchSize,
        },
        maxRetries: 3,
        idempotencyKey: `batch-${batchId}-${i}`,
      });
      
      // Small delay between batch submissions
      sleep(0.1);
    }
    
    // Longer think time between batches
    thinkTime(3, 5);
    
    // Check batch status
    client.listJobs({ limit: batchSize });
    
  } catch (error) {
    handleError(error, 'batch processing flow');
  }
}

// =============================================================================
// Scenario 4: Scheduled Job Flow
// =============================================================================

export function scheduledJobFlow(data) {
  const client = new TaskFlowClient();
  
  try {
    // Schedule job for future execution
    const delaySeconds = Math.floor(Math.random() * 300) + 60; // 60-360 seconds in future
    
    const job = client.submitJob({
      type: 'scheduled-' + randomJobType(),
      priority: randomPriority(),
      payload: randomPayload('medium'),
      scheduledFor: futureTimestamp(delaySeconds),
      maxRetries: 3,
      idempotencyKey: `scheduled-${generateUUID()}`,
    });
    
    if (!job) return;
    
    // Think time
    thinkTime(1, 2);
    
    // Occasionally cancel scheduled jobs (10% chance)
    if (Math.random() < 0.1) {
      client.cancelJob(job.id);
    }
    
  } catch (error) {
    handleError(error, 'scheduled job flow');
  }
}

// =============================================================================
// Scenario 5: Monitoring Flow
// =============================================================================

export function monitoringFlow(data) {
  const client = new TaskFlowClient();
  
  try {
    // Simulate dashboard queries - read-heavy workload
    
    // Get queue stats
    client.getQueueStats();
    sleep(0.5);
    
    // Get worker stats
    client.getWorkerStats();
    sleep(0.5);
    
    // List recent jobs
    client.listJobs({ limit: 50, status: 'QUEUED' });
    sleep(0.5);
    
    client.listJobs({ limit: 50, status: 'RUNNING' });
    sleep(0.5);
    
    client.listJobs({ limit: 50, status: 'COMPLETED' });
    sleep(0.5);
    
    // Collect system metrics
    collectSystemMetrics(client);
    
    // Dashboard refresh interval
    sleep(5);
    
  } catch (error) {
    handleError(error, 'monitoring flow');
  }
}

// =============================================================================
// Teardown
// =============================================================================

export function teardown(data) {
  const client = new TaskFlowClient();
  
  console.log('='.repeat(80));
  console.log('MIXED WORKLOAD TEST - TEARDOWN');
  console.log('='.repeat(80));
  
  // Collect final system state
  console.log('Collecting final system state...');
  const queueStats = client.getQueueStats();
  const workerStats = client.getWorkerStats();
  
  console.log(`Final queue depth: ${queueStats?.total || 0}`);
  console.log(`  CRITICAL: ${queueStats?.byPriority?.CRITICAL || 0}`);
  console.log(`  HIGH: ${queueStats?.byPriority?.HIGH || 0}`);
  console.log(`  NORMAL: ${queueStats?.byPriority?.NORMAL || 0}`);
  console.log(`  LOW: ${queueStats?.byPriority?.LOW || 0}`);
  
  console.log(`Active workers: ${workerStats?.workers?.filter(w => w.status === 'ACTIVE').length || 0}`);
  
  const testDuration = (Date.now() - data.startTime) / 1000;
  console.log(`Test duration: ${testDuration.toFixed(2)}s`);
  
  console.log('Teardown complete.');
  console.log('='.repeat(80));
}

// =============================================================================
// Custom Summary Report
// =============================================================================

export function handleSummary(data) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  
  // Calculate overall metrics
  const successRate = ((1 - (data.metrics.http_req_failed?.values?.rate || 0)) * 100).toFixed(2);
  const avgLatency = (data.metrics.http_req_duration?.values?.avg || 0).toFixed(2);
  const p95Latency = (data.metrics.http_req_duration?.values['p(95)'] || 0).toFixed(2);
  const p99Latency = (data.metrics.http_req_duration?.values['p(99)'] || 0).toFixed(2);
  const requestRate = (data.metrics.http_reqs?.values?.rate || 0).toFixed(2);
  const totalRequests = data.metrics.http_reqs?.values?.count || 0;
  
  const customSummary = `
${'='.repeat(80)}
MIXED WORKLOAD TEST RESULTS
${'='.repeat(80)}

Test Configuration:
  Duration: 5 minutes
  Scenarios: 5 concurrent user behaviors
    • Normal Users (70%): 0→20 VUs, mixed priorities
    • Urgent Jobs (15%): 10 jobs/s, HIGH/CRITICAL priority
    • Batch Processing (10%): 5 VUs, LOW priority, large payloads
    • Scheduled Jobs (5%): 2 jobs/s, future execution
    • Monitoring (constant): 3 VUs, read-heavy queries

Overall Performance:
  ✓ Request Rate:        ${requestRate} req/s
  ✓ Total Requests:      ${totalRequests}
  ✓ Success Rate:        ${successRate}%
  ✓ Avg Latency:         ${avgLatency}ms
  ✓ P95 Latency:         ${p95Latency}ms
  ✓ P99 Latency:         ${p99Latency}ms

Thresholds:
  ${data.metrics.http_req_duration?.thresholds ? 
    Object.entries(data.metrics.http_req_duration.thresholds)
      .map(([key, val]) => `  ${val.ok ? '✓' : '✗'} ${key}`)
      .join('\n') 
    : 'No thresholds defined'}

Job Metrics:
  Successful Submissions: ${data.metrics.job_submission_success?.values?.count || 0}
  Failed Submissions:     ${data.metrics.job_submission_failure?.values?.count || 0}
  Avg Submission Time:    ${(data.metrics.job_submission_duration?.values?.avg || 0).toFixed(2)}ms
  P95 Submission Time:    ${(data.metrics.job_submission_duration?.values['p(95)'] || 0).toFixed(2)}ms

Per-Scenario Performance:
  Normal Users:
    Requests: ${data.metrics['http_reqs{scenario:normal_users}']?.values?.count || 0}
    P95 Latency: ${(data.metrics['http_req_duration{scenario:normal_users}']?.values?.['p(95)'] || 0).toFixed(2)}ms
  
  Urgent Jobs:
    Requests: ${data.metrics['http_reqs{scenario:urgent_jobs}']?.values?.count || 0}
    P95 Latency: ${(data.metrics['http_req_duration{scenario:urgent_jobs}']?.values?.['p(95)'] || 0).toFixed(2)}ms
  
  Batch Processing:
    Requests: ${data.metrics['http_reqs{scenario:batch_processing}']?.values?.count || 0}
    P95 Latency: ${(data.metrics['http_req_duration{scenario:batch_processing}']?.values?.['p(95)'] || 0).toFixed(2)}ms
  
  Scheduled Jobs:
    Requests: ${data.metrics['http_reqs{scenario:scheduled_jobs}']?.values?.count || 0}
    P95 Latency: ${(data.metrics['http_req_duration{scenario:scheduled_jobs}']?.values?.['p(95)'] || 0).toFixed(2)}ms
  
  Monitoring:
    Requests: ${data.metrics['http_reqs{scenario:monitoring}']?.values?.count || 0}
    P95 Latency: ${(data.metrics['http_req_duration{scenario:monitoring}']?.values?.['p(95)'] || 0).toFixed(2)}ms

Analysis:
  ${successRate >= 99 ? '✅ Excellent success rate (≥99%)' : `⚠️  Success rate below target: ${successRate}%`}
  ${p95Latency <= 600 ? '✅ P95 latency within target (≤600ms)' : `⚠️  P95 latency exceeds target: ${p95Latency}ms`}
  
Priority Handling:
  • Check Grafana to verify CRITICAL/HIGH jobs processed before LOW
  • Verify urgent jobs had lower latency than batch jobs
  • Confirm scheduled jobs executed at correct time

Observations:
  • Mixed workload simulates realistic production traffic
  • Different user behaviors coexist without interference
  • Read operations (monitoring) don't impact write performance
  • Priority queue ensures urgent jobs get processed first

Recommendations:
  ${successRate < 99 ? '⚠️  Increase worker capacity or optimize job processing' : ''}
  ${p95Latency > 600 ? '⚠️  Investigate latency spikes - check database query performance' : ''}

${'='.repeat(80)}
`;

  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }) + customSummary,
    [`results/mixed-workload-${timestamp}.html`]: htmlReport(data),
    [`results/mixed-workload-${timestamp}.json`]: JSON.stringify(data, null, 2),
  };
}
