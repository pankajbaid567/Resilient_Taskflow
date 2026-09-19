import { createLogger } from '@taskflow/logger';
import { Counter, Gauge, Histogram, register, Summary } from 'prom-client';

const logger = createLogger({ component: 'Metrics' });

/**
 * Prometheus Metrics Registry
 *
 * Comprehensive metrics for distributed task queue system.
 */

// ========================================
// Job Metrics
// ========================================

/**
 * Total jobs submitted by status and queue
 */
export const jobsSubmittedTotal = new Counter({
  name: 'taskflow_jobs_submitted_total',
  help: 'Total number of jobs submitted',
  labelNames: ['queue', 'type', 'priority'],
  registers: [register],
});

/**
 * Total jobs started (picked up by workers)
 */
export const jobsStartedTotal = new Counter({
  name: 'taskflow_jobs_started_total',
  help: 'Total number of jobs started by workers',
  labelNames: ['queue', 'type', 'worker_id'],
  registers: [register],
});

/**
 * Total jobs completed successfully
 */
export const jobsCompletedTotal = new Counter({
  name: 'taskflow_jobs_completed_total',
  help: 'Total number of jobs completed successfully',
  labelNames: ['queue', 'type'],
  registers: [register],
});

/**
 * Total jobs failed
 */
export const jobsFailedTotal = new Counter({
  name: 'taskflow_jobs_failed_total',
  help: 'Total number of jobs failed',
  labelNames: ['queue', 'type', 'error_type'],
  registers: [register],
});

/**
 * Total job retries
 */
export const jobsRetriedTotal = new Counter({
  name: 'taskflow_jobs_retried_total',
  help: 'Total number of job retries',
  labelNames: ['queue', 'type', 'attempt'],
  registers: [register],
});

/**
 * Total jobs moved to dead letter queue
 */
export const jobsDeadLetteredTotal = new Counter({
  name: 'taskflow_jobs_dead_lettered_total',
  help: 'Total number of jobs moved to dead letter queue',
  labelNames: ['queue', 'type', 'reason'],
  registers: [register],
});

/**
 * Total jobs cancelled
 */
export const jobsCancelledTotal = new Counter({
  name: 'taskflow_jobs_cancelled_total',
  help: 'Total number of jobs cancelled',
  labelNames: ['queue', 'type'],
  registers: [register],
});

/**
 * Total jobs timed out
 */
export const jobsTimedOutTotal = new Counter({
  name: 'taskflow_jobs_timed_out_total',
  help: 'Total number of jobs that timed out',
  labelNames: ['queue', 'type'],
  registers: [register],
});

/**
 * Current jobs in each status (gauge)
 */
export const jobsCurrentByStatus = new Gauge({
  name: 'taskflow_jobs_current',
  help: 'Current number of jobs by status',
  labelNames: ['status', 'queue'],
  registers: [register],
});

/**
 * Job execution duration histogram
 */
export const jobDurationSeconds = new Histogram({
  name: 'taskflow_job_duration_seconds',
  help: 'Job execution duration in seconds',
  labelNames: ['queue', 'type', 'status'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300], // 100ms to 5min
  registers: [register],
});

/**
 * Job wait time (from submission to start) histogram
 */
export const jobWaitDurationSeconds = new Histogram({
  name: 'taskflow_job_wait_duration_seconds',
  help: 'Time from job submission to start in seconds',
  labelNames: ['queue', 'priority'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 300, 600], // 100ms to 10min
  registers: [register],
});

/**
 * Job retry attempts distribution
 */
export const jobRetryAttempts = new Histogram({
  name: 'taskflow_job_retry_attempts',
  help: 'Number of retry attempts per job',
  labelNames: ['queue', 'type'],
  buckets: [0, 1, 2, 3, 5, 10, 20],
  registers: [register],
});

// ========================================
// Queue Metrics
// ========================================

/**
 * Current queue depth (jobs waiting)
 */
export const queueDepth = new Gauge({
  name: 'taskflow_queue_depth',
  help: 'Current number of jobs waiting in queue',
  labelNames: ['queue', 'priority'],
  registers: [register],
});

/**
 * Queue processing lag (age of oldest job)
 */
export const queueLagSeconds = new Gauge({
  name: 'taskflow_queue_lag_seconds',
  help: 'Age of oldest job in queue (seconds)',
  labelNames: ['queue'],
  registers: [register],
});

/**
 * Redis Streams consumer group lag
 */
export const redisConsumerLag = new Gauge({
  name: 'taskflow_redis_consumer_lag',
  help: 'Number of pending messages in Redis consumer group',
  labelNames: ['queue', 'consumer_group', 'consumer'],
  registers: [register],
});

/**
 * Dead letter queue depth
 */
export const dlqDepth = new Gauge({
  name: 'taskflow_dlq_depth',
  help: 'Current number of jobs in dead letter queue',
  labelNames: ['queue'],
  registers: [register],
});

// ========================================
// Worker Metrics
// ========================================

/**
 * Active workers (gauge)
 */
export const workersActive = new Gauge({
  name: 'taskflow_workers_active',
  help: 'Number of active workers',
  labelNames: ['queue'],
  registers: [register],
});

/**
 * Worker failures
 */
export const workerFailuresTotal = new Counter({
  name: 'taskflow_worker_failures_total',
  help: 'Total number of worker failures',
  labelNames: ['worker_id', 'reason'],
  registers: [register],
});

/**
 * Worker heartbeats
 */
export const workerHeartbeatsTotal = new Counter({
  name: 'taskflow_worker_heartbeats_total',
  help: 'Total number of worker heartbeats',
  labelNames: ['worker_id'],
  registers: [register],
});

/**
 * Worker job concurrency (current processing)
 */
export const workerJobsConcurrent = new Gauge({
  name: 'taskflow_worker_jobs_concurrent',
  help: 'Current number of jobs being processed by worker',
  labelNames: ['worker_id'],
  registers: [register],
});

/**
 * Worker lease renewals
 */
export const workerLeaseRenewalsTotal = new Counter({
  name: 'taskflow_worker_lease_renewals_total',
  help: 'Total number of lease renewals',
  labelNames: ['worker_id'],
  registers: [register],
});

/**
 * Worker lease acquisition failures
 */
export const workerLeaseAcquisitionFailuresTotal = new Counter({
  name: 'taskflow_worker_lease_acquisition_failures_total',
  help: 'Total number of lease acquisition failures',
  labelNames: ['worker_id', 'reason'],
  registers: [register],
});

// ========================================
// Scheduler Metrics
// ========================================

/**
 * Scheduler runs
 */
export const schedulerRunsTotal = new Counter({
  name: 'taskflow_scheduler_runs_total',
  help: 'Total number of scheduler cycles',
  registers: [register],
});

/**
 * Jobs scheduled (moved from CREATED to QUEUED)
 */
export const schedulerJobsScheduledTotal = new Counter({
  name: 'taskflow_scheduler_jobs_scheduled_total',
  help: 'Total number of jobs scheduled by scheduler',
  labelNames: ['priority'],
  registers: [register],
});

/**
 * Scheduler errors
 */
export const schedulerErrorsTotal = new Counter({
  name: 'taskflow_scheduler_errors_total',
  help: 'Total number of scheduler errors',
  labelNames: ['error_type'],
  registers: [register],
});

/**
 * Scheduler run duration
 */
export const schedulerRunDurationSeconds = new Histogram({
  name: 'taskflow_scheduler_run_duration_seconds',
  help: 'Scheduler cycle duration in seconds',
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

/**
 * Scheduler lag (how late jobs are being scheduled)
 */
export const schedulerLagSeconds = new Gauge({
  name: 'taskflow_scheduler_lag_seconds',
  help: 'How late jobs are being scheduled (seconds)',
  registers: [register],
});

// ========================================
// API Metrics
// ========================================

/**
 * HTTP requests total
 */
export const httpRequestsTotal = new Counter({
  name: 'taskflow_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'path', 'status'],
  registers: [register],
});

/**
 * HTTP request duration
 */
export const httpRequestDurationSeconds = new Histogram({
  name: 'taskflow_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'path', 'status'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

/**
 * Rate limit hits
 */
export const rateLimitHitsTotal = new Counter({
  name: 'taskflow_rate_limit_hits_total',
  help: 'Total rate limit checks',
  labelNames: ['status'], // 'allowed' or 'denied'
  registers: [register],
});

/**
 * Rate limit duration (overhead)
 */
export const rateLimitDurationSeconds = new Histogram({
  name: 'taskflow_rate_limit_duration_seconds',
  help: 'Rate limit check duration in seconds',
  buckets: [0.0001, 0.0005, 0.001, 0.002, 0.005, 0.01],
  registers: [register],
});

/**
 * Idempotency key hits
 */
export const idempotencyKeyHitsTotal = new Counter({
  name: 'taskflow_idempotency_key_hits_total',
  help: 'Total idempotency key checks',
  labelNames: ['status'], // 'new', 'replay', 'conflict'
  registers: [register],
});

// ========================================
// Kafka/Event Metrics
// ========================================

/**
 * Events published to Kafka
 */
export const eventsPublishedTotal = new Counter({
  name: 'taskflow_events_published_total',
  help: 'Total events published to Kafka',
  labelNames: ['topic', 'event_type'],
  registers: [register],
});

/**
 * Event publish failures
 */
export const eventPublishFailuresTotal = new Counter({
  name: 'taskflow_event_publish_failures_total',
  help: 'Total event publish failures',
  labelNames: ['topic', 'event_type', 'error_type'],
  registers: [register],
});

/**
 * Event publish duration
 */
export const eventPublishDurationSeconds = new Histogram({
  name: 'taskflow_event_publish_duration_seconds',
  help: 'Event publish duration in seconds',
  labelNames: ['topic'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  registers: [register],
});

/**
 * Event batch size
 */
export const eventBatchSize = new Summary({
  name: 'taskflow_event_batch_size',
  help: 'Number of events in batch',
  labelNames: ['topic'],
  percentiles: [0.5, 0.9, 0.95, 0.99],
  registers: [register],
});

// ========================================
// Database Metrics
// ========================================

/**
 * Database queries total
 */
export const dbQueriesTotal = new Counter({
  name: 'taskflow_db_queries_total',
  help: 'Total database queries',
  labelNames: ['operation', 'table'],
  registers: [register],
});

/**
 * Database query duration
 */
export const dbQueryDurationSeconds = new Histogram({
  name: 'taskflow_db_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['operation', 'table'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2],
  registers: [register],
});

/**
 * Database connection pool size
 */
export const dbConnectionPoolSize = new Gauge({
  name: 'taskflow_db_connection_pool_size',
  help: 'Current database connection pool size',
  labelNames: ['state'], // 'idle' or 'active'
  registers: [register],
});

/**
 * Database transaction duration
 */
export const dbTransactionDurationSeconds = new Histogram({
  name: 'taskflow_db_transaction_duration_seconds',
  help: 'Database transaction duration in seconds',
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

// ========================================
// Redis Metrics
// ========================================

/**
 * Redis commands total
 */
export const redisCommandsTotal = new Counter({
  name: 'taskflow_redis_commands_total',
  help: 'Total Redis commands',
  labelNames: ['command'],
  registers: [register],
});

/**
 * Redis command duration
 */
export const redisCommandDurationSeconds = new Histogram({
  name: 'taskflow_redis_command_duration_seconds',
  help: 'Redis command duration in seconds',
  labelNames: ['command'],
  buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1],
  registers: [register],
});

/**
 * Redis connection pool size
 */
export const redisConnectionPoolSize = new Gauge({
  name: 'taskflow_redis_connection_pool_size',
  help: 'Current Redis connection pool size',
  labelNames: ['state'], // 'ready', 'wait', 'connect'
  registers: [register],
});

// ========================================
// System Metrics
// ========================================

/**
 * Build info (version, service name)
 */
export const buildInfo = new Gauge({
  name: 'taskflow_build_info',
  help: 'Build information',
  labelNames: ['version', 'service', 'node_version'],
  registers: [register],
});

// Set build info once on startup
buildInfo.labels('1.0.0', 'taskflow', process.version).set(1);

/**
 * Export all metrics in Prometheus text format
 */
export async function getMetrics(): Promise<string> {
  return register.metrics();
}

/**
 * Get metrics registry (for custom scrapers)
 */
export function getRegistry(): typeof register {
  return register;
}

/**
 * Clear all metrics (for testing)
 */
export function clearMetrics(): void {
  register.clear();
  logger.info('All metrics cleared');
}

logger.info('Prometheus metrics initialized', {
  metricsCount: register.getMetricsAsArray().length,
});
