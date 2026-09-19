-- Migration: 0005_retry_successor_delivery
--
-- Gives each durable delivery intent its own due time. Handler failure writes
-- the RETRY_SCHEDULED job state and a unique successor PENDING delivery in one
-- transaction. Dispatchers claim that successor only when available_at is due.

ALTER TABLE job_deliveries
  ADD COLUMN available_at timestamptz;

UPDATE job_deliveries
SET available_at = created_at
WHERE available_at IS NULL;

ALTER TABLE job_deliveries
  ALTER COLUMN available_at SET DEFAULT clock_timestamp(),
  ALTER COLUMN available_at SET NOT NULL;

DROP INDEX idx_job_deliveries_pending;

CREATE INDEX idx_job_deliveries_pending
  ON job_deliveries (available_at, created_at)
  WHERE status = 'PENDING';
