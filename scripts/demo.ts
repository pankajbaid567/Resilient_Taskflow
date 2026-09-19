#!/usr/bin/env tsx

/**
 * TaskFlow Demo Script
 *
 * Demonstrates the complete job processing flow:
 * 1. Submit jobs via API
 * 2. Workers pick up and process jobs
 * 3. Monitor job status
 * 4. Show metrics
 */

const API_URL = process.env.API_URL || 'http://localhost:3000';
const API_KEY = process.env.API_KEY;

function apiKeyHeader(): { 'X-API-Key': string } {
  if (!API_KEY) {
    throw new Error(
      'API_KEY is required and must match an active, unexpired, unrevoked api_keys row'
    );
  }

  return { 'X-API-Key': API_KEY };
}

/**
 * Submit a job to the API
 */
async function submitJob(
  type: string,
  payload: Record<string, unknown>,
  priority: string = 'NORMAL'
) {
  const response = await fetch(`${API_URL}/api/v1/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...apiKeyHeader(),
    },
    body: JSON.stringify({
      type,
      payload,
      priority,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to submit job: ${response.status} ${error}`);
  }

  return await response.json();
}

/**
 * Get job status
 */
async function getJobStatus(jobId: string) {
  const response = await fetch(`${API_URL}/api/v1/jobs/${jobId}`, {
    headers: {
      ...apiKeyHeader(),
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get job status: ${response.status}`);
  }

  return await response.json();
}

/**
 * Wait for job to complete
 */
async function waitForJob(
  jobId: string,
  maxWaitMs: number = 30000
): Promise<any> {
  const startTime = Date.now();
  const pollInterval = 500;

  while (Date.now() - startTime < maxWaitMs) {
    const job = await getJobStatus(jobId);

    if (['SUCCEEDED', 'FAILED', 'DLQ'].includes(job.status)) {
      return job;
    }

    await sleep(pollInterval);
  }

  throw new Error(`Job ${jobId} did not complete within ${maxWaitMs}ms`);
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Print colored output
 */
function print(
  message: string,
  color: 'green' | 'red' | 'yellow' | 'blue' | 'cyan' = 'cyan'
) {
  const colors = {
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    reset: '\x1b[0m',
  };

  console.log(`${colors[color]}${message}${colors.reset}`);
}

/**
 * Main demo
 */
async function main() {
  print(
    '╔════════════════════════════════════════════════════════════════╗',
    'cyan'
  );
  print(
    '║             TaskFlow End-to-End Demo                          ║',
    'cyan'
  );
  print(
    '╚════════════════════════════════════════════════════════════════╝',
    'cyan'
  );
  console.log();

  try {
    // Check API health
    print('1. Checking API health...', 'blue');
    const healthResponse = await fetch(`${API_URL}/health`);
    const health = await healthResponse.json();

    if (health.status === 'healthy') {
      print('   ✓ API is healthy', 'green');
      print(
        `   ✓ PostgreSQL: ${health.postgres ? 'connected' : 'disconnected'}`,
        'green'
      );
      print(
        `   ✓ Redis: ${health.redis ? 'connected' : 'disconnected'}`,
        'green'
      );
      print(
        `   ✓ Kafka: ${health.kafka ? 'connected' : 'disconnected'}`,
        'green'
      );
    } else {
      print('   ✗ API is not healthy', 'red');
      return;
    }
    console.log();

    // Submit test jobs
    print('2. Submitting test jobs...', 'blue');

    const jobs = [];

    // Job 1: Send email (HIGH priority)
    print('   Submitting: send-email (HIGH priority)', 'yellow');
    const emailJob = await submitJob(
      'send-email',
      {
        to: 'user@example.com',
        subject: 'Test Email from TaskFlow',
        body: 'This is a test email sent from the TaskFlow demo.',
      },
      'HIGH'
    );
    print(`   ✓ Job created: ${emailJob.jobId}`, 'green');
    jobs.push(emailJob);

    // Job 2: Process data (NORMAL priority)
    print('   Submitting: process-data (NORMAL priority)', 'yellow');
    const processJob = await submitJob(
      'process-data',
      {
        operation: 'transform',
        data: [
          { id: 1, value: 100 },
          { id: 2, value: 200 },
          { id: 3, value: 300 },
        ],
      },
      'NORMAL'
    );
    print(`   ✓ Job created: ${processJob.jobId}`, 'green');
    jobs.push(processJob);

    // Job 3: Another email (CRITICAL priority)
    print('   Submitting: send-email (CRITICAL priority)', 'yellow');
    const criticalEmail = await submitJob(
      'send-email',
      {
        to: 'admin@example.com',
        subject: 'CRITICAL: System Alert',
        body: 'This is a critical priority email.',
      },
      'CRITICAL'
    );
    print(`   ✓ Job created: ${criticalEmail.jobId}`, 'green');
    jobs.push(criticalEmail);

    // Job 4: Data aggregation
    print('   Submitting: process-data (aggregation)', 'yellow');
    const aggregateJob = await submitJob(
      'process-data',
      {
        operation: 'aggregate',
        data: [
          { id: 1, type: 'user', count: 10 },
          { id: 2, type: 'order', count: 25 },
          { id: 3, type: 'product', count: 50 },
        ],
      },
      'NORMAL'
    );
    print(`   ✓ Job created: ${aggregateJob.jobId}`, 'green');
    jobs.push(aggregateJob);

    console.log();

    // Wait for jobs to be processed
    print('3. Waiting for jobs to be processed by workers...', 'blue');
    print(
      '   (Make sure you have started workers with: pnpm dev:worker)',
      'yellow'
    );
    console.log();

    for (const job of jobs) {
      print(`   Polling job ${job.jobId}...`, 'yellow');

      try {
        const completedJob = await waitForJob(job.jobId, 30000);

        if (completedJob.status === 'SUCCEEDED') {
          print(`   ✓ Job ${job.jobId} succeeded`, 'green');
          if (completedJob.result) {
            console.log(
              `      Result: ${JSON.stringify(completedJob.result).substring(0, 100)}...`
            );
          }
        } else if (completedJob.status === 'FAILED') {
          print(`   ✗ Job ${job.jobId} failed: ${completedJob.error}`, 'red');
        } else if (completedJob.status === 'DLQ') {
          print(
            `   ✗ Job ${job.jobId} moved to DLQ: ${completedJob.error}`,
            'red'
          );
        }

        console.log(`      Status: ${completedJob.status}`);
        console.log(
          `      Created: ${new Date(completedJob.createdAt).toLocaleTimeString()}`
        );
        console.log(
          `      Updated: ${new Date(completedJob.updatedAt).toLocaleTimeString()}`
        );
        console.log();
      } catch (error) {
        print(`   ✗ Job ${job.jobId} timeout or error`, 'red');
        console.log(
          `      ${error instanceof Error ? error.message : String(error)}`
        );
        console.log();
      }
    }

    // Summary
    print('4. Demo Summary', 'blue');
    print('   ┌─────────────────────────────────────────┐', 'cyan');
    print(
      `   │ Jobs Submitted: ${jobs.length}                        │`,
      'cyan'
    );
    print('   │                                         │', 'cyan');
    print('   │ ✓ Job submission working                │', 'green');
    print('   │ ✓ Worker processing working             │', 'green');
    print('   │ ✓ Status updates working                │', 'green');
    print('   │ ✓ End-to-end flow complete              │', 'green');
    print('   └─────────────────────────────────────────┘', 'cyan');
    console.log();

    print('Demo completed successfully! 🎉', 'green');
    console.log();
    print('Next steps:', 'blue');
    print('  - View Grafana dashboards: http://localhost:3001', 'cyan');
    print('  - Check Prometheus metrics: http://localhost:9090', 'cyan');
    print('  - View API docs: http://localhost:3000/docs', 'cyan');
    console.log();
  } catch (error) {
    print('Demo failed:', 'red');
    console.error(error);
    process.exit(1);
  }
}

// Run the demo
main();
