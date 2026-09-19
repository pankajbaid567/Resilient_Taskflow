# Job State Machine

## Overview

The job state machine defines all valid states and transitions for a job throughout its lifecycle. Invalid transitions are explicitly rejected to maintain system consistency.

## States

```
CREATED          - Job inserted into database, not yet queued
QUEUED           - Job in Redis Stream, waiting for worker
PROCESSING       - Worker actively executing job
SUCCEEDED        - Job completed successfully
FAILED           - Job failed current attempt
RETRY_SCHEDULED  - Job failed, scheduled for retry
CANCEL_REQUESTED - Cancellation requested while processing
CANCELLED        - Job permanently cancelled
DEAD_LETTERED    - Job exhausted all retries
```

## State Diagram

```
                    ┌─────────────┐
                    │   CREATED   │
                    └──────┬──────┘
                           │
                           │ enqueue
                           ▼
                    ┌─────────────┐
            ┌──────►│   QUEUED    │◄──────┐
            │       └──────┬──────┘       │
            │              │              │ retry
            │              │ dequeue      │
            │              ▼              │
            │       ┌─────────────┐       │
            │       │ PROCESSING  │       │
            │       └──────┬──────┘       │
            │              │              │
     ┌──────┴──────┬───────┴────┬────────┴──────┐
     │             │            │               │
     │ cancel      │ success    │ retriable    │ non-retriable
     │             │            │ error         │ error OR max
     ▼             ▼            ▼               │ attempts reached
┌──────────┐  ┌──────────┐  ┌──────────┐      │
│CANCEL_   │  │SUCCEEDED │  │  FAILED  │      │
│REQUESTED │  └──────────┘  └────┬─────┘      │
└────┬─────┘                     │            │
     │                           │            │
     │ complete                  │ check      │
     │ cancellation              │ attempts   │
     ▼                           ▼            │
┌──────────┐              ┌──────────────┐   │
│CANCELLED │              │RETRY_        │   │
└──────────┘              │SCHEDULED     │   │
                          └──────────────┘   │
                                │            │
                                └────────────┘
                                             │
                                             ▼
                                      ┌──────────────┐
                                      │DEAD_LETTERED │
                                      └──────────────┘
```

## Valid Transitions

### From CREATED

| To State  | Condition                 | Action                      |
| --------- | ------------------------- | --------------------------- |
| QUEUED    | Job enqueued to Redis     | Update status, record event |
| CANCELLED | User cancels before queue | Update status, record event |

### From QUEUED

| To State   | Condition               | Action                                             |
| ---------- | ----------------------- | -------------------------------------------------- |
| PROCESSING | Worker acquires lease   | Update status, set worker_id, lease_id, started_at |
| CANCELLED  | User cancels queued job | Update status, remove from Redis, record event     |

### From PROCESSING

| To State         | Condition                                               | Action                                   |
| ---------------- | ------------------------------------------------------- | ---------------------------------------- |
| SUCCEEDED        | Handler completes successfully                          | Update status, set completed_at, result  |
| FAILED           | Handler throws error, attempts < max_attempts           | Update status, set failed_at, error      |
| RETRY_SCHEDULED  | Handler throws retriable error, attempts < max_attempts | Update status, calculate next retry time |
| DEAD_LETTERED    | Handler throws error, attempts >= max_attempts          | Update status, move to DLQ               |
| CANCEL_REQUESTED | User requests cancellation                              | Update status, set cancellation flag     |

### From FAILED

| To State        | Condition                               | Action                           |
| --------------- | --------------------------------------- | -------------------------------- |
| RETRY_SCHEDULED | Retry logic determines job should retry | Update status, calculate backoff |
| DEAD_LETTERED   | Max attempts reached                    | Update status, move to DLQ       |

### From RETRY_SCHEDULED

| To State  | Condition                 | Action                             |
| --------- | ------------------------- | ---------------------------------- |
| QUEUED    | Scheduled time reached    | Update status, re-enqueue to Redis |
| CANCELLED | User cancels before retry | Update status, record event        |

### From CANCEL_REQUESTED

| To State  | Condition                                        | Action                               |
| --------- | ------------------------------------------------ | ------------------------------------ |
| CANCELLED | Worker detects cancellation and exits gracefully | Update status, set completed_at      |
| SUCCEEDED | Job completes before cancellation check          | Update status (cancellation ignored) |
| FAILED    | Job fails before cancellation check              | Update status, apply retry logic     |

### From SUCCEEDED

**No transitions allowed** - Terminal state

### From CANCELLED

**No transitions allowed** - Terminal state (manual requeue creates new job)

### From DEAD_LETTERED

| To State | Condition                          | Action                                    |
| -------- | ---------------------------------- | ----------------------------------------- |
| None     | Manual requeue creates **new job** | Insert new job record, reference original |

## Invalid Transitions (Explicitly Rejected)

The following transitions should be rejected by the application:

- SUCCEEDED → any state (job is done)
- CANCELLED → any state (cancellation is permanent)
- DEAD_LETTERED → QUEUED (must create new job)
- PROCESSING → CREATED (cannot go backwards)
- SUCCEEDED → FAILED (cannot fail after success)
- Any non-sequential jump (e.g., CREATED → SUCCEEDED)

## Transition Validation

### Application Layer

```typescript
type JobStatus =
  | 'CREATED'
  | 'QUEUED'
  | 'PROCESSING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'RETRY_SCHEDULED'
  | 'CANCEL_REQUESTED'
  | 'CANCELLED'
  | 'DEAD_LETTERED';

const VALID_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  CREATED: ['QUEUED', 'CANCELLED'],
  QUEUED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: [
    'SUCCEEDED',
    'FAILED',
    'RETRY_SCHEDULED',
    'DEAD_LETTERED',
    'CANCEL_REQUESTED',
  ],
  FAILED: ['RETRY_SCHEDULED', 'DEAD_LETTERED'],
  RETRY_SCHEDULED: ['QUEUED', 'CANCELLED'],
  CANCEL_REQUESTED: ['CANCELLED', 'SUCCEEDED', 'FAILED'],
  SUCCEEDED: [],
  CANCELLED: [],
  DEAD_LETTERED: [],
};

function isValidTransition(from: JobStatus, to: JobStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

function validateTransition(from: JobStatus, to: JobStatus): void {
  if (!isValidTransition(from, to)) {
    throw new InvalidStateTransitionError(
      `Invalid transition from ${from} to ${to}`
    );
  }
}
```

### Database Layer (Optional CHECK Constraint)

```sql
-- This can be added but may be overly restrictive during development
-- Better to enforce in application layer with clear error messages

CREATE OR REPLACE FUNCTION validate_job_status_transition()
RETURNS TRIGGER AS $$
BEGIN
  -- Only validate on UPDATE
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    -- Define valid transitions
    IF NOT (
      (OLD.status = 'CREATED' AND NEW.status IN ('QUEUED', 'CANCELLED')) OR
      (OLD.status = 'QUEUED' AND NEW.status IN ('PROCESSING', 'CANCELLED')) OR
      (OLD.status = 'PROCESSING' AND NEW.status IN ('SUCCEEDED', 'FAILED', 'RETRY_SCHEDULED', 'DEAD_LETTERED', 'CANCEL_REQUESTED')) OR
      (OLD.status = 'FAILED' AND NEW.status IN ('RETRY_SCHEDULED', 'DEAD_LETTERED')) OR
      (OLD.status = 'RETRY_SCHEDULED' AND NEW.status IN ('QUEUED', 'CANCELLED')) OR
      (OLD.status = 'CANCEL_REQUESTED' AND NEW.status IN ('CANCELLED', 'SUCCEEDED', 'FAILED'))
    ) THEN
      RAISE EXCEPTION 'Invalid status transition from % to %', OLD.status, NEW.status;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER validate_job_status_transition_trigger
  BEFORE UPDATE ON jobs
  FOR EACH ROW
  EXECUTE FUNCTION validate_job_status_transition();
```

## State Transition Details

### 1. Job Creation → Queue

**Trigger:** API receives `POST /api/v1/jobs`

**Steps:**

1. Validate request (Zod schema)
2. Check authentication
3. Check idempotency key
4. BEGIN TRANSACTION
5. INSERT INTO jobs (status = 'CREATED')
6. INSERT INTO idempotency_keys
7. INSERT INTO job_events (event_type = 'created')
8. COMMIT
9. XADD to Redis Stream
10. If Redis succeeds: UPDATE status = 'QUEUED'
11. If Redis fails: Background sweeper will retry

**Race Conditions:**

- Duplicate idempotency key → Return existing job
- Redis unavailable → Job stays CREATED, sweeper recovers

### 2. Queue → Processing

**Trigger:** Worker calls XREADGROUP

**Steps:**

1. Worker receives job ID from Redis
2. BEGIN TRANSACTION
3. SELECT * FROM jobs WHERE id = ? FOR UPDATE
4. Validate status = 'QUEUED' AND scheduled_at <= NOW()
5. Generate lease_id (UUID)
6. UPDATE jobs SET status = 'PROCESSING', worker_id = ?, lease_id = ?, lease_expires_at = NOW() + INTERVAL '30s', started_at = NOW(), attempts = attempts + 1
7. INSERT INTO job_events (event_type = 'started')
8. COMMIT
9. Publish job.started event to Kafka
10. Execute job handler

**Race Conditions:**

- Multiple workers try to acquire same job → FOR UPDATE lock ensures only one succeeds
- Lease expires during processing → Another worker can reclaim
- Worker crashes after UPDATE → Lease expiry enables recovery

### 3. Processing → Success

**Trigger:** Handler returns successfully

**Steps:**

1. BEGIN TRANSACTION
2. UPDATE jobs SET status = 'SUCCEEDED', completed_at = NOW(), result = ?, lease_id = NULL
3. INSERT INTO job_events (event_type = 'completed')
4. INSERT INTO job_attempts (status = 'SUCCEEDED', duration_ms = ?)
5. COMMIT
6. XACK Redis message
7. Publish job.completed event to Kafka
8. Update worker metrics

**Race Conditions:**

- Lease expires before update → Optimistic lock (check worker_id, lease_id in WHERE clause)
- Worker crashes before XACK → Redis message becomes pending, eventually reclaimed

### 4. Processing → Retry

**Trigger:** Handler throws retriable error, attempts < max_attempts

**Steps:**

1. Classify error as retriable
2. Calculate backoff: delay = baseDelay * (2 ^ attempts) + jitter
3. Calculate next_scheduled_at = NOW() + delay
4. BEGIN TRANSACTION
5. UPDATE jobs SET status = 'RETRY_SCHEDULED', failed_at = NOW(), error = ?, scheduled_at = next_scheduled_at, lease_id = NULL
6. INSERT INTO job_attempts (status = 'FAILED', error = ?)
7. INSERT INTO job_events (event_type = 'retried')
8. COMMIT
9. XACK Redis message
10. Publish job.retried event to Kafka

**Background Process:**

- Scheduler finds RETRY_SCHEDULED jobs where scheduled_at <= NOW()
- Transitions to QUEUED
- Enqueues to Redis

**Race Conditions:**

- Multiple workers see expired lease → Optimistic locking prevents duplicate processing
- Retry scheduled before lease expires → Lease check prevents

### 5. Processing → Dead Letter

**Trigger:** Handler throws error, attempts >= max_attempts

**Steps:**

1. BEGIN TRANSACTION
2. UPDATE jobs SET status = 'DEAD_LETTERED', failed_at = NOW(), error = ?
3. INSERT INTO dead_letter_jobs (snapshot of job)
4. INSERT INTO job_attempts (status = 'FAILED')
5. INSERT INTO job_events (event_type = 'dead_lettered')
6. COMMIT
7. XACK Redis message
8. Publish job.dead_lettered event to Kafka
9. Alert monitoring systems

**Race Conditions:**

- None significant (terminal state)

### 6. Processing → Cancellation

**Trigger:** User calls `DELETE /api/v1/jobs/:id` while job is processing

**Steps:**

1. API UPDATE jobs SET status = 'CANCEL_REQUESTED' WHERE id = ? AND status = 'PROCESSING'
2. Worker periodically checks cancellation flag
3. If cancelled, worker:
   - Calls handler.abort() if supported
   - Cleans up resources
   - BEGIN TRANSACTION
   - UPDATE jobs SET status = 'CANCELLED', completed_at = NOW()
   - INSERT INTO job_events (event_type = 'cancelled')
   - COMMIT
   - XACK Redis message

**Race Conditions:**

- Job completes before cancellation check → Keep SUCCEEDED status (cancellation too late)
- Job fails before cancellation check → Apply normal failure logic
- Worker crashes before CANCELLED update → Lease expiry + another worker sees CANCEL_REQUESTED

### 7. Queue → Cancellation

**Trigger:** User calls `DELETE /api/v1/jobs/:id` while job is queued

**Steps:**

1. BEGIN TRANSACTION
2. UPDATE jobs SET status = 'CANCELLED' WHERE id = ? AND status = 'QUEUED'
3. INSERT INTO job_events (event_type = 'cancelled')
4. COMMIT
5. If job in Redis, mark as processed (or let it fail when worker tries to acquire)

**Race Conditions:**

- Worker acquires job between status check and cancellation → Worker sees status mismatch, drops job

## Concurrency Control

### Optimistic Locking

Use `version` column for concurrent updates:

```sql
UPDATE jobs
SET status = $1, version = version + 1
WHERE id = $2 AND version = $3
RETURNING *;
```

If no rows updated, another process modified the job.

### Pessimistic Locking

Use `SELECT FOR UPDATE` when acquiring lease:

```sql
BEGIN;
SELECT * FROM jobs WHERE id = $1 FOR UPDATE;
-- Validate state
UPDATE jobs SET status = 'PROCESSING', worker_id = $2, ...;
COMMIT;
```

### Lease-Based Locking

Workers hold a time-based lease:

```sql
UPDATE jobs
SET worker_id = $1, lease_id = $2, lease_expires_at = NOW() + INTERVAL '30 seconds'
WHERE id = $3
  AND status = 'QUEUED'
  AND (lease_expires_at IS NULL OR lease_expires_at < NOW());
```

## State Queries

### Jobs Ready to Process

```sql
SELECT id FROM jobs
WHERE status = 'QUEUED'
  AND scheduled_at <= NOW()
ORDER BY priority DESC, created_at ASC
LIMIT 100;
```

### Jobs Needing Retry

```sql
SELECT id FROM jobs
WHERE status = 'RETRY_SCHEDULED'
  AND scheduled_at <= NOW()
LIMIT 100;
```

### Stale Jobs (Lease Expired)

```sql
SELECT id, worker_id FROM jobs
WHERE status = 'PROCESSING'
  AND lease_expires_at < NOW()
LIMIT 100;
```

### Pending Cancellations

```sql
SELECT id FROM jobs
WHERE status = 'CANCEL_REQUESTED'
  AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
LIMIT 100;
```

## Error Classification

### Retriable Errors

Jobs should retry for:

- Temporary network failures
- Transient database errors
- External API rate limits
- Timeouts
- Resource temporarily unavailable

### Non-Retriable Errors

Jobs should NOT retry for:

- Invalid payload format
- Missing required data
- Authorization failures (permanent)
- Business logic violations
- Malformed requests

```typescript
class JobError extends Error {
  constructor(
    message: string,
    public readonly retriable: boolean = true,
    public readonly metadata?: Record<string, unknown>
  ) {
    super(message);
  }
}

// Usage
throw new JobError('API rate limit exceeded', true);
throw new JobError('Invalid email format', false);
```

## Testing State Machine

### Unit Tests

Test all valid transitions:

```typescript
describe('JobStateMachine', () => {
  it('allows CREATED → QUEUED', () => {
    expect(isValidTransition('CREATED', 'QUEUED')).toBe(true);
  });

  it('rejects SUCCEEDED → PROCESSING', () => {
    expect(isValidTransition('SUCCEEDED', 'PROCESSING')).toBe(false);
  });

  // Test all transitions...
});
```

### Integration Tests

Test transitions with database:

```typescript
it('transitions job from QUEUED to PROCESSING', async () => {
  const job = await createJob({ status: 'QUEUED' });

  await transitionToProcessing(job.id, workerId);

  const updated = await getJob(job.id);
  expect(updated.status).toBe('PROCESSING');
  expect(updated.worker_id).toBe(workerId);
  expect(updated.lease_id).toBeDefined();
});
```

### Race Condition Tests

Test concurrent state updates:

```typescript
it('prevents duplicate lease acquisition', async () => {
  const job = await createJob({ status: 'QUEUED' });

  // Two workers try to acquire simultaneously
  const [result1, result2] = await Promise.allSettled([
    acquireLease(job.id, 'worker-1'),
    acquireLease(job.id, 'worker-2'),
  ]);

  // Only one should succeed
  const successes = [result1, result2].filter((r) => r.status === 'fulfilled');
  expect(successes).toHaveLength(1);
});
```

## Next Documents

- [Redis Streams Design](./redis-streams.md)
- [Retry Strategy](./retry-strategy.md)
- [Failure Model](../failure-model/README.md)
