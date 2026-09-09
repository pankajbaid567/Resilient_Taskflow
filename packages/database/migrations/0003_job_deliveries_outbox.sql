-- Migration: 0003_job_deliveries_outbox
--
-- Adds a transactional outbox table for durable job delivery to Redis.
-- Each row represents one intended XADD operation. The dispatcher claims
-- rows with FOR UPDATE SKIP LOCKED, publishes to Redis, and records the
-- outcome. Job creation (or scheduler promotion) writes a PENDING row in
-- the same transaction that changes the job status to QUEUED, so no job
-- can become QUEUED without a delivery intent row.
--
-- Redis loss guarantees:
--   - If Redis AOF/RDB is in use: the stream survives restarts and the
--     delivery row's purpose is completed.
--   - If stream entries can be lost: the dispatcher's stale-delivery scan
--     periodically republishes rows that are PENDING/PUBLISHED but whose
--     job is still QUEUED or RETRY_SCHEDULED and scheduledAt <= now().
--     Duplicate XADD is safe because the worker deduplicates via the
--     database lease (acquireJobForDelivery returns BUSY or TERMINAL).

CREATE TABLE job_deliveries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  queue_name   text NOT NULL,
  attempt      integer NOT NULL DEFAULT 1,

  -- Delivery lifecycle: PENDING → PUBLISHED | FAILED
  status       text NOT NULL DEFAULT 'PENDING'
               CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED')),

  -- Set after successful XADD
  redis_message_id text,
  published_at     timestamptz,

  -- Concurrency fence: claimed by one dispatcher at a time
  claimed_by   text,
  claimed_at   timestamptz,

  -- Failure tracking
  error        text,
  retry_count  integer NOT NULL DEFAULT 0,

  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),

  -- Each job+attempt has at most one delivery row
  UNIQUE (job_id, attempt)
);

-- Dispatcher scans: fetch PENDING rows ordered by creation time
CREATE INDEX idx_job_deliveries_pending
  ON job_deliveries (created_at)
  WHERE status = 'PENDING';

-- Stale-delivery republish scan: find rows whose job is still non-terminal
-- (used when Redis stream entries may have been lost)
CREATE INDEX idx_job_deliveries_published_job
  ON job_deliveries (job_id)
  WHERE status = 'PUBLISHED';
