-- Migration: 0009_retention_safety
--
-- Make bounded retention safe to run against a live system.
--
-- 1. Deleting an old STOPPED worker used to fail with a foreign-key violation
--    whenever retained jobs, attempts, or events still referenced it, which
--    aborted the whole retention run. History keeps its rows; only the worker
--    reference is cleared.
--
--    A worker that still owns a PROCESSING / CANCEL_REQUESTED job cannot be
--    deleted: jobs_lease_state_consistent requires worker_id to be non-null for
--    those states, so SET NULL would violate it. The retention worker cleaner
--    also excludes such workers explicitly.
--
-- 2. The retention job cleaner checks dead_letter_jobs.requeued_job_id for every
--    candidate job; without an index that is a sequential scan per batch.

ALTER TABLE jobs
  DROP CONSTRAINT jobs_worker_id_fkey,
  ADD CONSTRAINT jobs_worker_id_fkey
    FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE SET NULL;

ALTER TABLE job_attempts
  DROP CONSTRAINT job_attempts_worker_id_fkey,
  ADD CONSTRAINT job_attempts_worker_id_fkey
    FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE SET NULL;

ALTER TABLE job_events
  DROP CONSTRAINT job_events_worker_id_fkey,
  ADD CONSTRAINT job_events_worker_id_fkey
    FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_dead_letter_jobs_requeued_job_id
  ON dead_letter_jobs (requeued_job_id)
  WHERE requeued_job_id IS NOT NULL;
