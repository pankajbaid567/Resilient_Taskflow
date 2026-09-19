-- Migration: 0006_p1_integrity_constraints
--
-- Enforce the runtime invariants used by the canonical API and worker paths.
-- Invalid legacy rows intentionally make this migration fail: silently
-- rewriting attempt or lease ownership would destroy evidence needed for safe
-- recovery.

ALTER TABLE jobs
  ADD CONSTRAINT jobs_attempts_non_negative CHECK (attempts >= 0),
  ADD CONSTRAINT jobs_max_attempts_positive CHECK (max_attempts > 0),
  ADD CONSTRAINT jobs_max_attempts_bounded CHECK (max_attempts <= 10),
  ADD CONSTRAINT jobs_attempts_within_budget CHECK (attempts <= max_attempts),
  ADD CONSTRAINT jobs_timeout_positive CHECK (timeout_ms > 0),
  ADD CONSTRAINT jobs_timeout_bounded CHECK (timeout_ms <= 86400000),
  ADD CONSTRAINT jobs_version_positive CHECK (version > 0),
  ADD CONSTRAINT jobs_lease_state_consistent CHECK (
    (
      status IN ('PROCESSING', 'CANCEL_REQUESTED')
      AND worker_id IS NOT NULL
      AND lease_id IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
    OR
    (
      status NOT IN ('PROCESSING', 'CANCEL_REQUESTED')
      AND lease_id IS NULL
      AND lease_expires_at IS NULL
    )
  );

ALTER TABLE queues
  ADD CONSTRAINT queues_name_format
    CHECK (name ~ '^[a-z0-9][a-z0-9._-]{0,62}$'),
  ADD CONSTRAINT queues_priority_positive CHECK (priority > 0),
  ADD CONSTRAINT queues_concurrency_positive
    CHECK (concurrency_limit IS NULL OR concurrency_limit > 0),
  ADD CONSTRAINT queues_max_retry_attempts_positive
    CHECK (max_retry_attempts > 0),
  ADD CONSTRAINT queues_max_retry_attempts_bounded
    CHECK (max_retry_attempts <= 10),
  ADD CONSTRAINT queues_default_timeout_positive
    CHECK (default_timeout_ms > 0),
  ADD CONSTRAINT queues_default_timeout_bounded
    CHECK (default_timeout_ms <= 86400000),
  ADD CONSTRAINT queues_rate_limit_positive
    CHECK (rate_limit_per_minute IS NULL OR rate_limit_per_minute > 0);

ALTER TABLE workers
  ADD CONSTRAINT workers_process_id_positive CHECK (process_id > 0),
  ADD CONSTRAINT workers_concurrency_positive CHECK (concurrency > 0),
  ADD CONSTRAINT workers_queues_non_empty CHECK (cardinality(queues) > 0),
  ADD CONSTRAINT workers_current_job_count_non_negative
    CHECK (current_job_count >= 0),
  ADD CONSTRAINT workers_totals_non_negative CHECK (
    total_jobs_processed >= 0
    AND total_jobs_succeeded >= 0
    AND total_jobs_failed >= 0
  );

ALTER TABLE job_attempts
  ADD CONSTRAINT job_attempts_attempt_number_positive
    CHECK (attempt_number > 0),
  ADD CONSTRAINT job_attempts_duration_non_negative
    CHECK (duration_ms IS NULL OR duration_ms >= 0);

-- These indexes duplicate the leading columns of UNIQUE constraints.
DROP INDEX IF EXISTS idx_job_attempts_job_id;
DROP INDEX IF EXISTS idx_dead_letter_jobs_original;
DROP INDEX IF EXISTS idx_queues_name;

-- PostgreSQL enums sort by declaration order. job_priority was declared
-- CRITICAL, HIGH, NORMAL, LOW, so DESC incorrectly puts LOW first. Keep the
-- enum for storage but index the explicit business rank used by the query.
DROP INDEX IF EXISTS idx_jobs_worker_polling;
CREATE INDEX idx_jobs_worker_polling
  ON jobs (
    queue_id,
    status,
    (CASE priority
      WHEN 'CRITICAL' THEN 4
      WHEN 'HIGH' THEN 3
      WHEN 'NORMAL' THEN 2
      WHEN 'LOW' THEN 1
    END) DESC,
    created_at ASC
  )
  INCLUDE (id, type, payload, max_attempts, timeout_ms, scheduled_at)
  WHERE status = 'QUEUED';
