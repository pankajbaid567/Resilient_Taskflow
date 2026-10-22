-- Migration: 0010_delivery_priority
--
-- Make job priority affect delivery order.
--
-- Redis Streams are FIFO, so priority cannot be applied once a delivery has
-- been published. Instead the backlog stays in PostgreSQL, where it can be
-- ordered, and the dispatcher publishes only a bounded window per queue (see
-- docs/priority-and-scheduling.md). That requires the outbox to be orderable
-- by priority: job_deliveries.priority_rank.
--
-- job_priority_rank() is the single definition of the ordering. It is used for
-- the backfill below and by every insert into job_deliveries. The enum itself
-- declares CRITICAL first, so it cannot be sorted directly.

CREATE FUNCTION job_priority_rank(priority job_priority)
RETURNS smallint
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT (
    CASE priority
      WHEN 'CRITICAL' THEN 4
      WHEN 'HIGH' THEN 3
      WHEN 'NORMAL' THEN 2
      ELSE 1
    END
  )::smallint
$$;

ALTER TABLE job_deliveries
  ADD COLUMN priority_rank smallint NOT NULL DEFAULT 2;

UPDATE job_deliveries AS delivery
   SET priority_rank = job_priority_rank(job.priority)
  FROM jobs AS job
 WHERE job.id = delivery.job_id;

ALTER TABLE job_deliveries
  ADD CONSTRAINT job_deliveries_priority_rank_valid
    CHECK (priority_rank BETWEEN 1 AND 4);

-- Dispatcher claim order within one queue: highest priority first, then
-- oldest due time. Partial, because only PENDING rows are ever claimed.
CREATE INDEX idx_job_deliveries_pending_priority
  ON job_deliveries (queue_name, priority_rank DESC, available_at, created_at)
  WHERE status = 'PENDING';
