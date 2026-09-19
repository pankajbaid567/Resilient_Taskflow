-- Migration: 0004_job_event_sequence
--
-- Adds a transactionally allocated, monotonic lifecycle-event sequence for
-- each job. Timestamps and random UUIDs remain useful metadata, but neither is
-- an authoritative logical ordering key.

ALTER TABLE jobs
  ADD COLUMN event_sequence integer NOT NULL DEFAULT 0;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_event_sequence_non_negative
  CHECK (event_sequence >= 0);

ALTER TABLE job_events
  ADD COLUMN event_sequence integer;

WITH ranked_events AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY job_id
      ORDER BY created_at, id
    )::integer AS event_sequence
  FROM job_events
)
UPDATE job_events AS event
SET event_sequence = ranked.event_sequence
FROM ranked_events AS ranked
WHERE event.id = ranked.id;

UPDATE jobs AS job
SET event_sequence = event_count.maximum_sequence
FROM (
  SELECT job_id, max(event_sequence) AS maximum_sequence
  FROM job_events
  GROUP BY job_id
) AS event_count
WHERE job.id = event_count.job_id;

ALTER TABLE job_events
  ALTER COLUMN event_sequence SET NOT NULL;

ALTER TABLE job_events
  ADD CONSTRAINT job_events_event_sequence_positive
  CHECK (event_sequence > 0);

ALTER TABLE job_events
  ADD CONSTRAINT job_events_job_sequence_unique
  UNIQUE (job_id, event_sequence);
