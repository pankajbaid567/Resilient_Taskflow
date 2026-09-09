CREATE TYPE job_status AS ENUM (
  'CREATED',
  'QUEUED',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'RETRY_SCHEDULED',
  'CANCEL_REQUESTED',
  'CANCELLED',
  'DEAD_LETTERED'
);

CREATE TYPE job_priority AS ENUM ('CRITICAL', 'HIGH', 'NORMAL', 'LOW');
CREATE TYPE worker_status AS ENUM ('STARTING', 'ACTIVE', 'STOPPING', 'STOPPED', 'FAILED');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email varchar(255) NOT NULL UNIQUE,
  password_hash varchar(255) NOT NULL,
  role varchar(50) NOT NULL DEFAULT 'user',
  api_key varchar(255) UNIQUE,
  api_key_hash varchar(255),
  rate_limit_per_minute varchar(255) NOT NULL DEFAULT '100',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE queues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(255) NOT NULL UNIQUE,
  display_name varchar(255) NOT NULL,
  description text,
  priority integer NOT NULL DEFAULT 5,
  concurrency_limit integer,
  max_retry_attempts integer NOT NULL DEFAULT 3,
  default_timeout_ms integer NOT NULL DEFAULT 30000,
  rate_limit_per_minute integer,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_name varchar(255) NOT NULL,
  hostname varchar(255) NOT NULL,
  process_id integer NOT NULL,
  concurrency integer NOT NULL DEFAULT 10,
  queues varchar(255)[] NOT NULL,
  status worker_status NOT NULL DEFAULT 'STARTING',
  current_job_count integer NOT NULL DEFAULT 0,
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz,
  total_jobs_processed integer NOT NULL DEFAULT 0,
  total_jobs_succeeded integer NOT NULL DEFAULT 0,
  total_jobs_failed integer NOT NULL DEFAULT 0,
  version varchar(50),
  metadata jsonb
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  queue_id uuid NOT NULL REFERENCES queues(id),
  type varchar(255) NOT NULL,
  payload jsonb NOT NULL,
  priority job_priority NOT NULL DEFAULT 'NORMAL',
  status job_status NOT NULL DEFAULT 'CREATED',
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  timeout_ms integer NOT NULL DEFAULT 30000,
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  worker_id uuid REFERENCES workers(id),
  lease_id uuid,
  lease_expires_at timestamptz,
  result jsonb,
  error jsonb,
  metadata jsonb,
  tags varchar(255)[],
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE job_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  worker_id uuid REFERENCES workers(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  duration_ms integer,
  status job_status NOT NULL,
  error jsonb,
  error_message text,
  stack_trace text,
  metadata jsonb,
  CONSTRAINT job_attempts_job_attempt_unique UNIQUE (job_id, attempt_number)
);

CREATE TABLE job_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  event_type varchar(50) NOT NULL,
  from_status job_status,
  to_status job_status NOT NULL,
  worker_id uuid REFERENCES workers(id),
  user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb
);

CREATE TABLE idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key varchar(255) NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  job_id uuid NOT NULL REFERENCES jobs(id),
  request_hash varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT idempotency_keys_user_key_unique UNIQUE (user_id, idempotency_key)
);

CREATE TABLE dead_letter_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_job_id uuid NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id),
  queue_id uuid NOT NULL REFERENCES queues(id),
  type varchar(255) NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL,
  last_error jsonb,
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  failed_at timestamptz NOT NULL,
  requeued boolean NOT NULL DEFAULT false,
  requeued_at timestamptz,
  requeued_job_id uuid REFERENCES jobs(id),
  metadata jsonb
);

CREATE INDEX idx_jobs_user_id ON jobs(user_id);
CREATE INDEX idx_jobs_queue_id ON jobs(queue_id);
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_type ON jobs(type);
CREATE INDEX idx_jobs_scheduled_at ON jobs(scheduled_at);
CREATE INDEX idx_jobs_lease_expires_at ON jobs(lease_expires_at);
CREATE INDEX idx_jobs_created_at ON jobs(created_at);
CREATE INDEX idx_jobs_queue_status_priority ON jobs(queue_id, status, priority, created_at);
CREATE INDEX idx_workers_status ON workers(status);
CREATE INDEX idx_workers_last_heartbeat ON workers(last_heartbeat_at);
CREATE INDEX idx_workers_hostname ON workers(hostname);
CREATE INDEX idx_job_attempts_job_id ON job_attempts(job_id, attempt_number);
CREATE INDEX idx_job_attempts_worker_id ON job_attempts(worker_id);
CREATE INDEX idx_job_attempts_started_at ON job_attempts(started_at);
CREATE INDEX idx_job_attempts_status ON job_attempts(status);
CREATE INDEX idx_job_events_job_id ON job_events(job_id, created_at);
CREATE INDEX idx_job_events_type ON job_events(event_type);
CREATE INDEX idx_job_events_created_at ON job_events(created_at);
CREATE INDEX idx_job_events_worker_id ON job_events(worker_id);
CREATE INDEX idx_idempotency_keys_expires ON idempotency_keys(expires_at);
CREATE INDEX idx_idempotency_keys_job_id ON idempotency_keys(job_id);
CREATE INDEX idx_dead_letter_jobs_user_id ON dead_letter_jobs(user_id);
CREATE INDEX idx_dead_letter_jobs_queue_id ON dead_letter_jobs(queue_id);
CREATE INDEX idx_dead_letter_jobs_created_at ON dead_letter_jobs(created_at);
CREATE INDEX idx_dead_letter_jobs_requeued ON dead_letter_jobs(requeued);
