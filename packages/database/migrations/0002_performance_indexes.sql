-- Performance Optimization Indexes
-- Migration: 0002_performance_indexes
-- Purpose: Add indexes to optimize common query patterns identified through profiling

-- =============================================================================
-- Jobs Table Optimizations
-- =============================================================================

-- Index for finding stale leases (worker recovery)
-- Query: SELECT * FROM jobs WHERE lease_expires_at < NOW() AND status = 'PROCESSING'
CREATE INDEX IF NOT EXISTS idx_jobs_stale_leases 
ON jobs (lease_expires_at, status)
WHERE lease_expires_at IS NOT NULL AND status = 'PROCESSING';

-- Index for finding jobs to schedule (scheduled job pickup)
-- Query: SELECT * FROM jobs WHERE status = 'CREATED' AND scheduled_at <= NOW()
CREATE INDEX IF NOT EXISTS idx_jobs_ready_to_schedule
ON jobs (scheduled_at, status)
WHERE status = 'CREATED' AND scheduled_at IS NOT NULL;

-- Index for finding retry-scheduled jobs
-- Query: SELECT * FROM jobs WHERE status = 'RETRY_SCHEDULED' AND scheduled_at <= NOW()
CREATE INDEX IF NOT EXISTS idx_jobs_ready_to_retry
ON jobs (scheduled_at, status)
WHERE status = 'RETRY_SCHEDULED';

-- Index for worker polling (most important query)
-- Query: SELECT * FROM jobs WHERE queue_id = ? AND status = 'QUEUED' ORDER BY priority DESC, created_at ASC
-- Already exists as idx_jobs_queue_status_priority, but add covering index with more columns
CREATE INDEX IF NOT EXISTS idx_jobs_worker_polling
ON jobs (queue_id, status, priority DESC, created_at ASC)
INCLUDE (id, type, payload, max_attempts, timeout_ms, scheduled_at)
WHERE status = 'QUEUED';

-- Index for finding jobs by worker (for cancellation checks)
-- Query: SELECT * FROM jobs WHERE worker_id = ? AND status = 'PROCESSING'
CREATE INDEX IF NOT EXISTS idx_jobs_worker_processing
ON jobs (worker_id, status)
WHERE status = 'PROCESSING';

-- Index for finding failed jobs (DLQ queries)
-- Query: SELECT * FROM jobs WHERE status = 'FAILED' AND failed_at > ?
CREATE INDEX IF NOT EXISTS idx_jobs_failed_recent
ON jobs (status, failed_at DESC)
WHERE status IN ('FAILED', 'DEAD_LETTERED');

-- Index for user job listing with status filter
-- Query: SELECT * FROM jobs WHERE user_id = ? AND status = ? ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_jobs_user_status_created
ON jobs (user_id, status, created_at DESC);

-- Index for finding jobs by tags (if using tag queries)
-- Query: SELECT * FROM jobs WHERE tags @> ARRAY['tag1', 'tag2']
CREATE INDEX IF NOT EXISTS idx_jobs_tags
ON jobs USING GIN (tags)
WHERE tags IS NOT NULL;

-- =============================================================================
-- Workers Table Optimizations
-- =============================================================================

-- Index for finding stale workers (worker health check)
-- Query: SELECT * FROM workers WHERE last_heartbeat_at < NOW() - INTERVAL '1 minute' AND status = 'ACTIVE'
CREATE INDEX IF NOT EXISTS idx_workers_stale
ON workers (last_heartbeat_at, status)
WHERE status = 'ACTIVE';

-- Index for finding active workers by queue
-- Query: SELECT * FROM workers WHERE status = 'ACTIVE' AND 'queue_name' = ANY(queues)
CREATE INDEX IF NOT EXISTS idx_workers_active_queues
ON workers USING GIN (queues)
WHERE status = 'ACTIVE';

-- =============================================================================
-- Job Attempts Table Optimizations
-- =============================================================================

-- Index for finding failed attempts for a job
-- Query: SELECT * FROM job_attempts WHERE job_id = ? AND status = 'FAILED' ORDER BY attempt_number
CREATE INDEX IF NOT EXISTS idx_job_attempts_job_failures
ON job_attempts (job_id, status, attempt_number DESC)
WHERE status = 'FAILED';

-- Index for finding recent attempts by worker (worker performance analysis)
-- Query: SELECT * FROM job_attempts WHERE worker_id = ? AND started_at > ?
CREATE INDEX IF NOT EXISTS idx_job_attempts_worker_recent
ON job_attempts (worker_id, started_at DESC);

-- Index for slow job detection (performance monitoring)
-- Query: SELECT * FROM job_attempts WHERE duration_ms > 5000 ORDER BY duration_ms DESC
CREATE INDEX IF NOT EXISTS idx_job_attempts_slow
ON job_attempts (duration_ms DESC)
WHERE duration_ms > 5000;

-- =============================================================================
-- Idempotency Keys Table Optimizations
-- =============================================================================

-- Index for cleanup of expired keys
-- Query: DELETE FROM idempotency_keys WHERE expires_at < NOW()
-- Already exists as idx_idempotency_keys_expires

-- Include expiry in the lookup index. A predicate using NOW() is invalid in
-- PostgreSQL because index predicates must contain only immutable expressions.
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_active
ON idempotency_keys (user_id, idempotency_key, expires_at);

-- =============================================================================
-- Dead Letter Jobs Table Optimizations
-- =============================================================================

-- Index for listing DLQ jobs by queue and time
CREATE INDEX IF NOT EXISTS idx_dead_letter_jobs_queue_created
ON dead_letter_jobs (queue_id, created_at DESC);

-- Index for finding DLQ jobs by original job
CREATE INDEX IF NOT EXISTS idx_dead_letter_jobs_original
ON dead_letter_jobs (original_job_id);

-- =============================================================================
-- Queues Table Optimizations
-- =============================================================================

-- Index for finding queues by name (fast lookup)
CREATE INDEX IF NOT EXISTS idx_queues_name
ON queues (name);

-- Index for active queues
CREATE INDEX IF NOT EXISTS idx_queues_active
ON queues (is_active)
WHERE is_active = true;

-- =============================================================================
-- Statistics and Monitoring
-- =============================================================================

-- Create statistics for query planner on frequently queried columns
-- This helps PostgreSQL make better query plans

-- Jobs table statistics
CREATE STATISTICS IF NOT EXISTS stats_jobs_status_priority
ON status, priority
FROM jobs;

CREATE STATISTICS IF NOT EXISTS stats_jobs_queue_status
ON queue_id, status
FROM jobs;

-- Workers table statistics
CREATE STATISTICS IF NOT EXISTS stats_workers_status_heartbeat
ON status, last_heartbeat_at
FROM workers;

-- Job attempts statistics
CREATE STATISTICS IF NOT EXISTS stats_job_attempts_duration_status
ON duration_ms, status
FROM job_attempts;

-- =============================================================================
-- Query Performance Comments
-- =============================================================================

COMMENT ON INDEX idx_jobs_stale_leases IS 
'Optimizes worker recovery queries for expired leases';

COMMENT ON INDEX idx_jobs_ready_to_schedule IS 
'Optimizes scheduled job pickup queries';

COMMENT ON INDEX idx_jobs_worker_polling IS 
'Covering index for worker job polling (most frequent query)';

COMMENT ON INDEX idx_jobs_failed_recent IS 
'Optimizes DLQ and failed job queries';

COMMENT ON INDEX idx_workers_stale IS 
'Optimizes worker health check queries';

COMMENT ON INDEX idx_job_attempts_slow IS 
'Enables fast detection of slow jobs for performance monitoring';

-- =============================================================================
-- Maintenance Notes
-- =============================================================================

-- To monitor index usage:
-- SELECT schemaname, tablename, indexname, idx_scan, idx_tup_read, idx_tup_fetch
-- FROM pg_stat_user_indexes
-- WHERE schemaname = 'public'
-- ORDER BY idx_scan DESC;

-- To find unused indexes:
-- SELECT schemaname, tablename, indexname, idx_scan
-- FROM pg_stat_user_indexes
-- WHERE schemaname = 'public' AND idx_scan = 0
-- ORDER BY pg_relation_size(indexrelid) DESC;

-- Run VACUUM ANALYZE separately as an operational maintenance command.
-- Migration runners execute this file in a transaction, where VACUUM is not
-- permitted by PostgreSQL.
