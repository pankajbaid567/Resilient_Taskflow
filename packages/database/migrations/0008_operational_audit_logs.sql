-- Migration: 0008_operational_audit_logs
-- Application append-only, payload-free evidence for P2 operational control requests.

CREATE TABLE operational_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL,
  actor_role varchar(16) NOT NULL,
  action varchar(64) NOT NULL,
  target_type varchar(32) NOT NULL,
  target_id varchar(255) NOT NULL,
  request_id varchar(255) NOT NULL,
  outcome varchar(16) NOT NULL,
  status_code integer NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT operational_audit_action_valid CHECK (
    action IN ('queue.pause', 'queue.resume', 'worker.stop', 'job.manual_retry')
  ),
  CONSTRAINT operational_audit_outcome_valid CHECK (
    outcome IN ('SUCCEEDED', 'NOOP', 'REJECTED')
  ),
  CONSTRAINT operational_audit_actor_role_valid CHECK (
    actor_role IN ('admin', 'user')
  ),
  CONSTRAINT operational_audit_status_code_valid CHECK (
    status_code BETWEEN 100 AND 599
  )
);

CREATE INDEX idx_operational_audit_actor_created
  ON operational_audit_logs(actor_user_id, created_at DESC);
CREATE INDEX idx_operational_audit_action_created
  ON operational_audit_logs(action, created_at DESC);
CREATE INDEX idx_operational_audit_target
  ON operational_audit_logs(target_type, target_id, created_at DESC);
