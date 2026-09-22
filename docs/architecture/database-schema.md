# Database Schema Design

## Overview

PostgreSQL serves as the authoritative source of truth for all durable job state. This document defines the complete schema, including tables, indexes, constraints, and rationale.

## Design Principles

1. **Durability First**: All critical state must survive system crashes
2. **Explicit State Machine**: Use CHECK constraints to enforce valid states
3. **Audit Trail**: Track all state transitions in `job_events`
4. **Concurrent Safety**: Use optimistic locking and row-level locks
5. **Query Performance**: Index all common query patterns
6. **Referential Integrity**: Use foreign keys to maintain consistency

## Schema Diagram

```
┌──────────────┐
│    users     │
└──────┬───────┘
       │
       │ (owns)
       │
       ├─────────────┐
       │             │
       ▼             ▼
┌──────────────┐  ┌──────────────┐
│   queues     │  │    jobs      │◄──┐
└──────┬───────┘  └──────┬───────┘   │
       │                 │            │
       │ (contains)      │ (has)      │ (references)
       │                 │            │
       └─────────────────┤            │
                         ▼            │
                  ┌──────────────┐   │
                  │ job_attempts │   │
                  └──────────────┘   │
                         │            │
                         │            │
                  ┌──────▼───────┐   │
                  │ job_events   │   │
                  └──────────────┘   │
                                     │
┌──────────────┐              ┌─────┴────────┐
│   workers    │              │ idempotency_ │
└──────────────┘              │    keys      │
                              └──────────────┘

┌──────────────┐
│dead_letter_  │
│   jobs       │
└──────────────┘
```

## Tables

### 1. users

Stores user accounts with authentication and authorization information.

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'user',
  api_key VARCHAR(255) UNIQUE,
  api_key_hash VARCHAR(255),
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT users_role_check CHECK (role IN ('user', 'admin', 'worker'))
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_api_key_hash ON users(api_key_hash);
CREATE INDEX idx_users_is_active ON users(is_active);
```

**Rationale:**

- `api_key_hash` stores hashed API key for secure comparison
- `role` enables RBAC
- `rate_limit_per_minute` allows per-user rate limiting
- `is_active` for soft deletion

### 2. queues

Defines queue configurations and metadata.

```sql
CREATE TABLE queues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) UNIQUE NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  description TEXT,
  priority INTEGER NOT NULL DEFAULT 5,
  concurrency_limit INTEGER,
  max_retry_attempts INTEGER NOT NULL DEFAULT 3,
  default_timeout_ms INTEGER NOT NULL DEFAULT 30000,
  rate_limit_per_minute INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT queues_priority_check CHECK (priority >= 1 AND priority <= 10),
  CONSTRAINT queues_concurrency_check CHECK (concurrency_limit IS NULL OR concurrency_limit > 0),
  CONSTRAINT queues_timeout_check CHECK (default_timeout_ms > 0)
);

CREATE INDEX idx_queues_name ON queues(name);
CREATE INDEX idx_queues_priority ON queues(priority);
CREATE INDEX idx_queues_is_active ON queues(is_active);
```

**Rationale:**

- `priority` enables queue-level priority (1=LOW, 10=CRITICAL)
- `concurrency_limit` for per-queue rate limiting
- `max_retry_attempts` queue-specific retry policy
- `default_timeout_ms` queue-specific timeout

### 3. jobs

The core job table storing all job records.

```sql
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

CREATE TYPE job_priority AS ENUM (
  'CRITICAL',  -- 10
  'HIGH',      -- 7
  'NORMAL',    -- 5
  'LOW'        -- 1
);

CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ownership
  user_id UUID NOT NULL REFERENCES users(id),
  queue_id UUID NOT NULL REFERENCES queues(id),

  -- Job Definition
  type VARCHAR(255) NOT NULL,
  payload JSONB NOT NULL,
  priority job_priority NOT NULL DEFAULT 'NORMAL',

  -- Status
  status job_status NOT NULL DEFAULT 'CREATED',

  -- Retry Configuration
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,

  -- Timing
  timeout_ms INTEGER NOT NULL DEFAULT 30000,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,

  -- Worker Lease
  worker_id UUID REFERENCES workers(id),
  lease_id UUID,
  lease_expires_at TIMESTAMPTZ,

  -- Result
  result JSONB,
  error JSONB,

  -- Metadata
  metadata JSONB,
  tags TEXT[],

  -- Versioning
  version INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT jobs_attempts_check CHECK (attempts >= 0),
  CONSTRAINT jobs_max_attempts_check CHECK (max_attempts > 0),
  CONSTRAINT jobs_timeout_check CHECK (timeout_ms > 0),
  CONSTRAINT jobs_timing_check CHECK (
    (completed_at IS NULL OR started_at IS NOT NULL) AND
    (started_at IS NULL OR started_at >= created_at) AND
    (completed_at IS NULL OR completed_at >= started_at)
  )
);

-- Indexes for common queries
CREATE INDEX idx_jobs_user_id ON jobs(user_id);
CREATE INDEX idx_jobs_queue_id ON jobs(queue_id);
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_type ON jobs(type);
CREATE INDEX idx_jobs_scheduled_at ON jobs(scheduled_at) WHERE status IN ('CREATED', 'RETRY_SCHEDULED');
CREATE INDEX idx_jobs_lease_expires ON jobs(lease_expires_at) WHERE status = 'PROCESSING';
CREATE INDEX idx_jobs_created_at ON jobs(created_at DESC);

-- Composite indexes for worker queries
CREATE INDEX idx_jobs_queue_status_priority ON jobs(queue_id, status, priority DESC, created_at ASC);
CREATE INDEX idx_jobs_status_scheduled ON jobs(status, scheduled_at) WHERE status IN ('CREATED', 'RETRY_SCHEDULED');

-- GIN index for JSONB queries
CREATE INDEX idx_jobs_payload_gin ON jobs USING GIN(payload);
CREATE INDEX idx_jobs_metadata_gin ON jobs USING GIN(metadata);

-- Array index for tags
CREATE INDEX idx_jobs_tags_gin ON jobs USING GIN(tags);
```

**Rationale:**

- `version` enables optimistic locking for concurrent updates
- `lease_id` + `lease_expires_at` implement lease mechanism
- `scheduled_at` supports delayed job execution
- `attempts` vs `max_attempts` for retry logic
- `JSONB` for flexible payload and metadata
- Partial indexes reduce index size for conditional queries
- GIN indexes enable fast JSONB searches

**State Machine Constraints:**
Enforced at application layer (see state-machine.md)

### 4. job_attempts

Records every execution attempt for debugging and analytics.

```sql
CREATE TABLE job_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,

  -- Attempt Info
  attempt_number INTEGER NOT NULL,

  -- Execution
  worker_id UUID REFERENCES workers(id),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,

  -- Result
  status job_status NOT NULL,
  error JSONB,
  error_message TEXT,
  stack_trace TEXT,

  -- Context
  metadata JSONB,

  CONSTRAINT job_attempts_attempt_number_check CHECK (attempt_number > 0),
  CONSTRAINT job_attempts_duration_check CHECK (duration_ms IS NULL OR duration_ms >= 0)
);

CREATE INDEX idx_job_attempts_job_id ON job_attempts(job_id, attempt_number);
CREATE INDEX idx_job_attempts_worker_id ON job_attempts(worker_id);
CREATE INDEX idx_job_attempts_started_at ON job_attempts(started_at DESC);
CREATE INDEX idx_job_attempts_status ON job_attempts(status);
```

**Rationale:**

- Complete audit trail of all attempts
- Enables debugging of intermittent failures
- Analytics on failure patterns
- Worker performance analysis

### 5. job_events

Audit log of all job state transitions.

```sql
CREATE TABLE job_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,

  -- Event
  event_type VARCHAR(50) NOT NULL,
  from_status job_status,
  to_status job_status NOT NULL,

  -- Context
  worker_id UUID REFERENCES workers(id),
  user_id UUID REFERENCES users(id),

  -- Timing
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Details
  metadata JSONB,

  CONSTRAINT job_events_type_check CHECK (
    event_type IN (
      'created', 'queued', 'started', 'completed',
      'failed', 'retried', 'cancelled', 'dead_lettered',
      'timeout', 'lease_acquired', 'lease_expired'
    )
  )
);

CREATE INDEX idx_job_events_job_id ON job_events(job_id, created_at);
CREATE INDEX idx_job_events_type ON job_events(event_type);
CREATE INDEX idx_job_events_created_at ON job_events(created_at DESC);
CREATE INDEX idx_job_events_worker_id ON job_events(worker_id);
```

**Rationale:**

- Complete audit trail for compliance
- Debugging state machine issues
- Analytics on job lifecycle
- Enables event replay

### 6. workers

Tracks registered workers and their health status.

```sql
CREATE TYPE worker_status AS ENUM ('STARTING', 'ACTIVE', 'STOPPING', 'STOPPED', 'FAILED');

CREATE TABLE workers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  worker_name VARCHAR(255) NOT NULL,
  hostname VARCHAR(255) NOT NULL,
  process_id INTEGER NOT NULL,

  -- Configuration
  concurrency INTEGER NOT NULL DEFAULT 10,
  queues TEXT[] NOT NULL,

  -- Status
  status worker_status NOT NULL DEFAULT 'STARTING',
  current_job_count INTEGER NOT NULL DEFAULT 0,

  -- Health
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stopped_at TIMESTAMPTZ,

  -- Metrics
  total_jobs_processed INTEGER NOT NULL DEFAULT 0,
  total_jobs_succeeded INTEGER NOT NULL DEFAULT 0,
  total_jobs_failed INTEGER NOT NULL DEFAULT 0,

  -- Metadata
  version VARCHAR(50),
  metadata JSONB,

  CONSTRAINT workers_concurrency_check CHECK (concurrency > 0),
  CONSTRAINT workers_current_jobs_check CHECK (current_job_count >= 0),
  CONSTRAINT workers_job_counts_check CHECK (
    total_jobs_processed >= total_jobs_succeeded + total_jobs_failed
  )
);

CREATE INDEX idx_workers_status ON workers(status);
CREATE INDEX idx_workers_last_heartbeat ON workers(last_heartbeat_at);
CREATE INDEX idx_workers_queues_gin ON workers USING GIN(queues);
CREATE INDEX idx_workers_hostname ON workers(hostname);
```

**Rationale:**

- Health monitoring via `last_heartbeat_at`
- Worker discovery for monitoring dashboards
- Metrics for worker performance analysis
- `queues` array for multi-queue workers

### 7. idempotency_keys

Prevents duplicate job submissions.

```sql
CREATE TABLE idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Key
  idempotency_key VARCHAR(255) NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id),

  -- Reference
  job_id UUID NOT NULL REFERENCES jobs(id),

  -- Request fingerprint
  request_hash VARCHAR(64) NOT NULL,

  -- Timing
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,

  CONSTRAINT idempotency_keys_unique UNIQUE (user_id, idempotency_key)
);

CREATE INDEX idx_idempotency_keys_expires ON idempotency_keys(expires_at);
CREATE INDEX idx_idempotency_keys_job_id ON idempotency_keys(job_id);
```

**Rationale:**

- Prevents duplicate job creation
- Scoped per user
- TTL via `expires_at` for cleanup
- `request_hash` detects conflicting requests with same key

### 8. dead_letter_jobs

Jobs that have permanently failed after max retry attempts.

```sql
CREATE TABLE dead_letter_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Original Job Reference
  original_job_id UUID NOT NULL,

  -- Job Data (snapshot at failure)
  user_id UUID NOT NULL REFERENCES users(id),
  queue_id UUID NOT NULL REFERENCES queues(id),
  type VARCHAR(255) NOT NULL,
  payload JSONB NOT NULL,

  -- Failure Info
  attempts INTEGER NOT NULL,
  last_error JSONB,
  last_error_message TEXT,

  -- Timing
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  failed_at TIMESTAMPTZ NOT NULL,

  -- Resolution
  requeued BOOLEAN NOT NULL DEFAULT false,
  requeued_at TIMESTAMPTZ,
  requeued_job_id UUID REFERENCES jobs(id),

  -- Metadata
  metadata JSONB
);

CREATE INDEX idx_dead_letter_jobs_original ON dead_letter_jobs(original_job_id);
CREATE INDEX idx_dead_letter_jobs_user_id ON dead_letter_jobs(user_id);
CREATE INDEX idx_dead_letter_jobs_queue_id ON dead_letter_jobs(queue_id);
CREATE INDEX idx_dead_letter_jobs_created_at ON dead_letter_jobs(created_at DESC);
CREATE INDEX idx_dead_letter_jobs_requeued ON dead_letter_jobs(requeued);
```

**Rationale:**

- Separate table for failed jobs
- Enables manual inspection and requeue
- Prevents cluttering main `jobs` table
- Complete snapshot of job at failure time

## Common Query Patterns

### 1. Submit Job

```sql
BEGIN;

-- Check idempotency
INSERT INTO idempotency_keys (idempotency_key, user_id, job_id, request_hash, expires_at)
VALUES ($1, $2, $3, $4, NOW() + INTERVAL '24 hours')
ON CONFLICT (user_id, idempotency_key) DO NOTHING
RETURNING job_id;

-- If no conflict, insert job
INSERT INTO jobs (
  user_id, queue_id, type, payload, priority,
  max_attempts, timeout_ms, scheduled_at, status
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'CREATED')
RETURNING *;

-- Record event
INSERT INTO job_events (job_id, event_type, to_status)
VALUES ($1, 'created', 'CREATED');

COMMIT;
```

### 2. Get Jobs to Process

```sql
SELECT j.id, j.type, j.payload, j.priority, j.timeout_ms, j.attempts
FROM jobs j
WHERE j.queue_id = $1
  AND j.status = 'QUEUED'
  AND j.scheduled_at <= NOW()
ORDER BY j.priority DESC, j.created_at ASC
LIMIT 100;
```

### 3. Acquire Job Lease

```sql
UPDATE jobs
SET
  status = 'PROCESSING',
  worker_id = $1,
  lease_id = $2,
  lease_expires_at = NOW() + INTERVAL '30 seconds',
  started_at = NOW(),
  attempts = attempts + 1,
  version = version + 1
WHERE id = $3
  AND status = 'QUEUED'
  AND scheduled_at <= NOW()
  AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
  AND version = $4
RETURNING *;
```

**Note:** The `version = $4` check provides optimistic locking.

### 4. Renew Lease

```sql
UPDATE jobs
SET
  lease_expires_at = NOW() + INTERVAL '30 seconds',
  version = version + 1
WHERE id = $1
  AND worker_id = $2
  AND lease_id = $3
  AND status = 'PROCESSING'
RETURNING lease_expires_at;
```

### 5. Complete Job

```sql
BEGIN;

UPDATE jobs
SET
  status = 'SUCCEEDED',
  completed_at = NOW(),
  result = $1,
  lease_id = NULL,
  lease_expires_at = NULL,
  version = version + 1
WHERE id = $2
  AND status = 'PROCESSING'
  AND worker_id = $3
RETURNING *;

INSERT INTO job_events (job_id, event_type, from_status, to_status, worker_id)
VALUES ($2, 'completed', 'PROCESSING', 'SUCCEEDED', $3);

COMMIT;
```

### 6. Fail Job with Retry

```sql
BEGIN;

UPDATE jobs
SET
  status = CASE
    WHEN attempts < max_attempts THEN 'RETRY_SCHEDULED'
    ELSE 'DEAD_LETTERED'
  END,
  failed_at = NOW(),
  error = $1,
  scheduled_at = CASE
    WHEN attempts < max_attempts THEN NOW() + (INTERVAL '1 second' * POW(2, attempts))
    ELSE scheduled_at
  END,
  lease_id = NULL,
  lease_expires_at = NULL,
  version = version + 1
WHERE id = $2
  AND status = 'PROCESSING'
  AND worker_id = $3
RETURNING *, status;

INSERT INTO job_attempts (job_id, attempt_number, worker_id, status, error, completed_at, duration_ms)
VALUES ($2, $4, $3, 'FAILED', $1, NOW(), $5);

-- If dead lettered, copy to DLQ
INSERT INTO dead_letter_jobs (
  original_job_id, user_id, queue_id, type, payload,
  attempts, last_error, failed_at
)
SELECT id, user_id, queue_id, type, payload, attempts, error, failed_at
FROM jobs
WHERE id = $2 AND status = 'DEAD_LETTERED';

COMMIT;
```

### 7. Find Stale Jobs (Lease Expired)

```sql
SELECT id, worker_id, lease_id, lease_expires_at
FROM jobs
WHERE status = 'PROCESSING'
  AND lease_expires_at < NOW()
LIMIT 100;
```

### 8. Worker Heartbeat

```sql
UPDATE workers
SET
  last_heartbeat_at = NOW(),
  current_job_count = $1,
  total_jobs_processed = $2,
  total_jobs_succeeded = $3,
  total_jobs_failed = $4
WHERE id = $5
RETURNING *;
```

### 9. Get Queue Statistics

```sql
SELECT
  q.name,
  COUNT(*) FILTER (WHERE j.status = 'QUEUED') as queued,
  COUNT(*) FILTER (WHERE j.status = 'PROCESSING') as processing,
  COUNT(*) FILTER (WHERE j.status = 'SUCCEEDED') as succeeded,
  COUNT(*) FILTER (WHERE j.status = 'FAILED') as failed,
  AVG(EXTRACT(EPOCH FROM (j.completed_at - j.created_at))) FILTER (WHERE j.status = 'SUCCEEDED') as avg_duration_seconds
FROM queues q
LEFT JOIN jobs j ON j.queue_id = q.id
GROUP BY q.id, q.name;
```

### Operational audit logs

Migration `0008_operational_audit_logs.sql` adds application append-only operational-control evidence. Records contain actor UUID and role snapshots, request ID, action, target type/ID, outcome, HTTP status, bounded metadata, and database time. They intentionally have no foreign key to `users`, so account cleanup cannot erase or block audit history. Credentials and job payloads are excluded.

Indexes support actor, action, target, and reverse-time queries. Existing-resource control decisions insert the audit row in the same transaction as the associated mutation or rejection.

The table is a control-decision audit trail, not a complete security log. Requests rejected during authentication or authorization never reach the control transaction and are represented only by structured API security logs.

## Performance Considerations

### Index Strategy

1. **Primary Key Indexes**: Automatic B-tree indexes
2. **Foreign Key Indexes**: Explicit indexes on all FK columns
3. **Status Queries**: Index on `jobs(status)`
4. **Queue Workers**: Composite index `(queue_id, status, priority, created_at)`
5. **Partial Indexes**: Reduce index size for conditional queries
6. **GIN Indexes**: For JSONB and array columns

### Query Optimization

1. **Use EXPLAIN ANALYZE**: Profile all critical queries
2. **Batch Operations**: Update multiple jobs in single query where possible
3. **Connection Pooling**: Reuse database connections
4. **Prepared Statements**: Reduce parsing overhead
5. **Read Replicas**: Separate read and write workloads

### Retention status

Automated retention is not implemented yet. Do not run ad hoc deletes against jobs, attempts, events, deliveries, or dead letters: pending Redis entries, retry wake-ups, leases, and redispatch evidence must be protected together. P2 requires a bounded, resumable cleanup transaction and process tests before documenting deletion commands.

## Migration Strategy

**Phase 1:** Create tables and indexes
**Phase 2:** Add constraints
**Phase 3:** Populate initial data (queues, admin user)
**Phase 4:** Test with production-like data volume
**Phase 5:** Optimize based on query patterns

## Transaction Boundaries

**Critical Transactions:**

1. Job submission (INSERT job + idempotency key + event)
2. State transitions (UPDATE job + INSERT event)
3. Worker lease acquisition (SELECT FOR UPDATE + UPDATE)
4. Retry with DLQ (UPDATE job + INSERT attempt + possibly INSERT dead_letter)

**Non-Transactional:**

1. Heartbeat updates (can tolerate occasional failure)
2. Metrics queries (read-only)
3. Log event publishing (eventual consistency acceptable)

## Next Steps

- [State Machine](./state-machine.md) - Valid state transitions
- [Redis Streams Design](./redis-streams.md) - Queue implementation
- [Failure Model](../failure-model/README.md) - Consistency guarantees
