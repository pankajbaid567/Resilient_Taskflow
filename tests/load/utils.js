/**
 * Shared utilities for k6 load tests
 */
import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Counter, Gauge } from 'k6/metrics';

// =============================================================================
// Configuration
// =============================================================================

export const config = {
  apiUrl: __ENV.K6_API_URL || 'http://localhost:3000',
  apiKey: __ENV.K6_API_KEY || 'test-api-key-123',
  timeout: __ENV.K6_TIMEOUT || '30s',
};

// =============================================================================
// Custom Metrics
// =============================================================================

export const metrics = {
  // Job submission metrics
  jobSubmissionDuration: new Trend('job_submission_duration', true),
  jobSubmissionSuccess: new Counter('job_submission_success'),
  jobSubmissionFailure: new Counter('job_submission_failure'),

  // Job completion metrics
  jobCompletionDuration: new Trend('job_completion_duration', true),
  jobCompletionSuccess: new Counter('job_completion_success'),
  jobCompletionFailure: new Counter('job_completion_failure'),

  // Queue metrics
  queueDepth: new Gauge('queue_depth'),
  queueDepthCritical: new Gauge('queue_depth_critical'),
  queueDepthHigh: new Gauge('queue_depth_high'),
  queueDepthNormal: new Gauge('queue_depth_normal'),
  queueDepthLow: new Gauge('queue_depth_low'),

  // Worker metrics
  activeWorkers: new Gauge('active_workers'),
  jobsProcessingCurrent: new Gauge('jobs_processing_current'),

  // Throughput metrics
  jobsPerSecond: new Trend('jobs_per_second', true),
};

// =============================================================================
// Common Thresholds
// =============================================================================

export const commonThresholds = {
  // HTTP request thresholds
  'http_req_duration': ['p(95)<500', 'p(99)<1000'], // 95th percentile < 500ms, 99th < 1s
  'http_req_failed': ['rate<0.01'], // Error rate < 1%
  'http_reqs': ['rate>10'], // At least 10 req/s

  // Custom metric thresholds
  'job_submission_duration': ['p(95)<200', 'p(99)<500'], // Job submission fast
  'job_completion_duration': ['p(95)<5000', 'p(99)<10000'], // Job completion under 10s
  'queue_depth': ['value<1000'], // Queue not backing up
};

// =============================================================================
// API Client
// =============================================================================

export class TaskFlowClient {
  constructor(baseUrl = config.apiUrl, apiKey = config.apiKey) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };
  }

  /**
   * Submit a new job
   */
  submitJob(jobData) {
    const url = `${this.baseUrl}/api/jobs`;
    const payload = JSON.stringify({
      type: jobData.type || 'test-job',
      payload: jobData.payload || { message: 'test' },
      priority: jobData.priority || 'NORMAL',
      idempotencyKey: jobData.idempotencyKey || undefined,
      scheduledFor: jobData.scheduledFor || undefined,
      maxRetries: jobData.maxRetries || 3,
    });

    const startTime = Date.now();
    const res = http.post(url, payload, {
      headers: this.headers,
      timeout: config.timeout,
    });
    const duration = Date.now() - startTime;

    const success = check(res, {
      'job submitted': (r) => r.status === 201,
      'has job id': (r) => r.json('id') !== undefined,
    });

    if (success) {
      metrics.jobSubmissionSuccess.add(1);
      metrics.jobSubmissionDuration.add(duration);
      return res.json();
    } else {
      metrics.jobSubmissionFailure.add(1);
      console.error(`Job submission failed: ${res.status} ${res.body}`);
      return null;
    }
  }

  /**
   * Get job status
   */
  getJob(jobId) {
    const url = `${this.baseUrl}/api/jobs/${jobId}`;
    const res = http.get(url, {
      headers: this.headers,
      timeout: config.timeout,
    });

    check(res, {
      'job retrieved': (r) => r.status === 200,
    });

    return res.json();
  }

  /**
   * List jobs with filters
   */
  listJobs(filters = {}) {
    const params = new URLSearchParams(filters);
    const url = `${this.baseUrl}/api/jobs?${params.toString()}`;
    const res = http.get(url, {
      headers: this.headers,
      timeout: config.timeout,
    });

    check(res, {
      'jobs listed': (r) => r.status === 200,
    });

    return res.json();
  }

  /**
   * Cancel a job
   */
  cancelJob(jobId) {
    const url = `${this.baseUrl}/api/jobs/${jobId}/cancel`;
    const res = http.post(url, null, {
      headers: this.headers,
      timeout: config.timeout,
    });

    check(res, {
      'job cancelled': (r) => r.status === 200,
    });

    return res.json();
  }

  /**
   * Get queue stats
   */
  getQueueStats(queueName = 'default') {
    const url = `${this.baseUrl}/api/queues/${queueName}/stats`;
    const res = http.get(url, {
      headers: this.headers,
      timeout: config.timeout,
    });

    check(res, {
      'queue stats retrieved': (r) => r.status === 200,
    });

    return res.json();
  }

  /**
   * Get worker stats
   */
  getWorkerStats() {
    const url = `${this.baseUrl}/api/workers`;
    const res = http.get(url, {
      headers: this.headers,
      timeout: config.timeout,
    });

    check(res, {
      'worker stats retrieved': (r) => r.status === 200,
    });

    return res.json();
  }

  /**
   * Health check
   */
  healthCheck() {
    const url = `${this.baseUrl}/health`;
    const res = http.get(url, { timeout: config.timeout });

    check(res, {
      'health check passed': (r) => r.status === 200,
    });

    return res.json();
  }
}

// =============================================================================
// Job Generators
// =============================================================================

/**
 * Generate a random job type
 */
export function randomJobType() {
  const types = ['email-send', 'image-resize', 'data-export', 'report-generate', 'notification-send'];
  return types[Math.floor(Math.random() * types.length)];
}

/**
 * Generate a random priority
 */
export function randomPriority() {
  const priorities = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'];
  const weights = [0.2, 0.5, 0.25, 0.05]; // Weighted distribution
  const rand = Math.random();
  let cumulative = 0;
  for (let i = 0; i < weights.length; i++) {
    cumulative += weights[i];
    if (rand < cumulative) return priorities[i];
  }
  return 'NORMAL';
}

/**
 * Generate a random job payload
 */
export function randomPayload(size = 'small') {
  const sizes = {
    small: 100, // ~100 bytes
    medium: 1000, // ~1 KB
    large: 10000, // ~10 KB
  };

  const dataSize = sizes[size] || sizes.small;
  const data = 'x'.repeat(dataSize);

  return {
    timestamp: Date.now(),
    requestId: generateUUID(),
    data: data,
    metadata: {
      source: 'load-test',
      iteration: __ITER,
      vu: __VU,
    },
  };
}

/**
 * Generate a future timestamp for scheduled jobs
 */
export function futureTimestamp(secondsFromNow = 60) {
  return new Date(Date.now() + secondsFromNow * 1000).toISOString();
}

/**
 * Generate UUID v4
 */
export function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Wait for job completion with polling
 */
export function waitForJobCompletion(client, jobId, maxWaitMs = 30000, pollIntervalMs = 500) {
  const startTime = Date.now();
  let job = null;

  while (Date.now() - startTime < maxWaitMs) {
    job = client.getJob(jobId);

    if (job && (job.status === 'COMPLETED' || job.status === 'FAILED' || job.status === 'CANCELLED')) {
      const duration = Date.now() - startTime;
      if (job.status === 'COMPLETED') {
        metrics.jobCompletionSuccess.add(1);
        metrics.jobCompletionDuration.add(duration);
      } else {
        metrics.jobCompletionFailure.add(1);
      }
      return job;
    }

    sleep(pollIntervalMs / 1000); // k6 sleep takes seconds
  }

  console.warn(`Job ${jobId} did not complete within ${maxWaitMs}ms`);
  return job;
}

/**
 * Collect system metrics
 */
export function collectSystemMetrics(client) {
  try {
    // Queue depth by priority
    const queueStats = client.getQueueStats();
    if (queueStats) {
      metrics.queueDepth.add(queueStats.total || 0);
      metrics.queueDepthCritical.add(queueStats.byPriority?.CRITICAL || 0);
      metrics.queueDepthHigh.add(queueStats.byPriority?.HIGH || 0);
      metrics.queueDepthNormal.add(queueStats.byPriority?.NORMAL || 0);
      metrics.queueDepthLow.add(queueStats.byPriority?.LOW || 0);
    }

    // Worker stats
    const workerStats = client.getWorkerStats();
    if (workerStats && workerStats.workers) {
      const activeCount = workerStats.workers.filter((w) => w.status === 'ACTIVE').length;
      const processingCount = workerStats.workers.reduce((sum, w) => sum + (w.jobsProcessing || 0), 0);
      metrics.activeWorkers.add(activeCount);
      metrics.jobsProcessingCurrent.add(processingCount);
    }
  } catch (error) {
    console.warn(`Failed to collect system metrics: ${error.message}`);
  }
}

/**
 * Think time (realistic user behavior)
 */
export function thinkTime(minSeconds = 1, maxSeconds = 3) {
  const seconds = minSeconds + Math.random() * (maxSeconds - minSeconds);
  sleep(seconds);
}

/**
 * Graceful error handling
 */
export function handleError(error, context = '') {
  console.error(`Error in ${context}: ${error.message}`);
  console.error(`Stack: ${error.stack}`);
}

// =============================================================================
// Scenario Helpers
// =============================================================================

/**
 * Create ramping VU scenario
 */
export function createRampingScenario(stages, options = {}) {
  return {
    executor: 'ramping-vus',
    startVUs: options.startVUs || 0,
    stages: stages,
    gracefulRampDown: options.gracefulRampDown || '30s',
    ...options,
  };
}

/**
 * Create constant arrival rate scenario
 */
export function createConstantArrivalRateScenario(rate, duration, options = {}) {
  return {
    executor: 'constant-arrival-rate',
    rate: rate,
    timeUnit: options.timeUnit || '1s',
    duration: duration,
    preAllocatedVUs: options.preAllocatedVUs || rate,
    maxVUs: options.maxVUs || rate * 2,
    ...options,
  };
}

/**
 * Create ramping arrival rate scenario (for spikes)
 */
export function createRampingArrivalRateScenario(stages, options = {}) {
  return {
    executor: 'ramping-arrival-rate',
    startRate: options.startRate || 0,
    timeUnit: options.timeUnit || '1s',
    stages: stages,
    preAllocatedVUs: options.preAllocatedVUs || 50,
    maxVUs: options.maxVUs || 200,
    ...options,
  };
}

// =============================================================================
// Exports
// =============================================================================

export default {
  config,
  metrics,
  commonThresholds,
  TaskFlowClient,
  randomJobType,
  randomPriority,
  randomPayload,
  futureTimestamp,
  generateUUID,
  waitForJobCompletion,
  collectSystemMetrics,
  thinkTime,
  handleError,
  createRampingScenario,
  createConstantArrivalRateScenario,
  createRampingArrivalRateScenario,
};
