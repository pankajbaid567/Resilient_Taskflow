# Leases and Worker Heartbeats

## Overview

TaskFlow uses a lease-based system to prevent duplicate job processing and detect worker failures. This ensures **at-most-once execution** within a lease period, combined with **at-least-once delivery** through automatic recovery.

## Core Concepts

### Job Leases

A **lease** is a time-bound exclusive lock on a job that prevents other workers from processing it.

**Key Properties:**

- **Exclusive**: Only one worker can hold a lease at a time
- **Time-bound**: Leases expire automatically after a duration
- **Renewable**: Active workers periodically renew their leases
- **Recoverable**: Expired leases allow other workers to take over

### Worker Heartbeats

**Heartbeats** are periodic status updates that workers send to indicate they're alive and healthy.

**Key Properties:**

- **Periodic**: Sent every 10 seconds (configurable)
- **Includes Statistics**: Current jobs, total processed, success/failure counts
- **Enables Monitoring**: Dead workers detected by missing heartbeats
- **Supports Scaling**: Orchestration systems can scale based on worker health

## Database Schema

### Jobs Table (Lease Fields)

```sql
CREATE TABLE jobs (
  id UUID PRIMARY KEY,

  -- Lease fields
  worker_id UUID,                    -- Which worker has the lease
  lease_id UUID,                     -- Unique lease identifier
  lease_expires_at TIMESTAMP,        -- When lease expires

  -- Other fields...
  status VARCHAR(50),
  version INTEGER,                   -- Optimistic locking
  ...
);

-- Index for lease expiration queries
CREATE INDEX idx_jobs_lease_expires
  ON jobs(lease_expires_at)
  WHERE lease_expires_at IS NOT NULL;
```

### Workers Table

```sql
CREATE TABLE workers (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  queues TEXT[] NOT NULL,
  status VARCHAR(50) NOT NULL,
  concurrency INTEGER NOT NULL,
  current_jobs INTEGER DEFAULT 0,

  -- Heartbeat fields
  last_heartbeat TIMESTAMP NOT NULL,

  -- Statistics
  total_jobs_processed INTEGER DEFAULT 0,
  total_jobs_succeeded INTEGER DEFAULT 0,
  total_jobs_failed INTEGER DEFAULT 0,

  -- Lifecycle
  created_at TIMESTAMP NOT NULL,
  stopped_at TIMESTAMP,

  metadata JSONB
);

-- Index for heartbeat monitoring
CREATE INDEX idx_workers_heartbeat
  ON workers(last_heartbeat, status);
```

## Lease Lifecycle

### 1. Lease Acquisition

```typescript
// Worker acquires lease when starting job
const lease = await acquireJobLease(jobId, workerId, {
  leaseDurationMs: 30000, // 30 seconds
});

// Database update:
UPDATE jobs
SET
  worker_id = $workerId,
  lease_id = $leaseId,        -- New random UUID
  lease_expires_at = NOW() + INTERVAL '30 seconds',
  status = 'PROCESSING',
  version = version + 1       -- Optimistic locking
WHERE
  id = $jobId
  AND status = 'QUEUED'
  AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
  AND version = $expectedVersion
RETURNING *;
```

**Race Condition Prevention:**

- Optimistic locking with `version` field
- Only one UPDATE succeeds if multiple workers try simultaneously
- Failed updates return no rows → worker knows it didn't get the lease

### 2. Lease Renewal

The worker renews each active lease every `leaseDuration / 3` (10 s for the
default 30 s lease) with a single fenced `UPDATE`:

```sql
UPDATE jobs
SET lease_expires_at = clock_timestamp() + $duration,
    version = version + 1
WHERE id = $jobId
  AND status IN ('PROCESSING', 'CANCEL_REQUESTED')
  AND worker_id = $workerId
  AND lease_id = $leaseId                      -- must match the current lease
  AND lease_expires_at > clock_timestamp()     -- lease not already expired
RETURNING *;
```

- No row returned means the lease was lost (expired or taken over); the worker
  interrupts the handler with reason `LEASE_LOST` and leaves the Redis entry
  pending.
- A renewal that returns `CANCEL_REQUESTED` is how a running worker first
  observes a user cancellation (see `cancellation.md`).
- **Renewal writes no `job_events` row.** A heartbeat is not a state
  transition. Logging one per renewal made `job_events` grow with execution
  time rather than with lifecycle changes. `event_sequence` therefore stays
  contiguous over real transitions only.

**Why renew at one third of the duration?** Two consecutive renewals can fail
(a slow query, a brief network blip) before the lease expires.

### 3. Lease Release

```typescript
// Worker releases lease when job completes/fails
await completeJob(jobId, result);

// Database update:
UPDATE jobs
SET
  status = 'SUCCEEDED',
  worker_id = NULL,
  lease_id = NULL,
  lease_expires_at = NULL,
  result = $result,
  completed_at = NOW()
WHERE id = $jobId;
```

#### Release on shutdown

When a worker is stopped while a handler is still running, the lease is handed
back instead of being left to expire (`releaseJobDelivery`). In one fenced
transaction the job returns to `QUEUED`, the in-flight attempt is **refunded**
(`attempts - 1`), the open `job_attempts` row is removed, the job's outbox row
is re-armed to `PENDING`, and a `lease_released` event is written. The worker
acknowledges the Redis entry only after that commit.

Why refund the attempt? Without it, a rolling deploy would burn one attempt per
running job, and a job on its final attempt would be dead-lettered by a
restart. The removed attempt row is not lost history: its start time and the
reason are recorded in the `lease_released` event metadata.

If the release fails or the lease is already gone, nothing is acknowledged and
ordinary lease-expiry recovery (below) still applies.

### 4. Lease Expiration

```typescript
// Automatic - no code needed
// Expired leases allow other workers to acquire

// Find jobs with expired leases:
SELECT * FROM jobs
WHERE status = 'PROCESSING'
  AND lease_expires_at < NOW();

// Another worker can acquire:
UPDATE jobs
SET
  worker_id = $newWorkerId,
  lease_id = $newLeaseId,      -- New lease ID
  lease_expires_at = NOW() + INTERVAL '30 seconds'
WHERE
  id = $jobId
  AND lease_expires_at < NOW() -- Lease expired
RETURNING *;
```

## Heartbeat Lifecycle

### 1. Worker Registration

```typescript
// Worker registers when starting
await registerWorker({
  id: workerId,
  name: 'worker-hostname-pid',
  queues: ['default', 'email'],
  status: 'ACTIVE',
  concurrency: 10,
  currentJobs: 0,
  lastHeartbeat: new Date(),
  metadata: {
    hostname: os.hostname(),
    pid: process.pid,
    nodeVersion: process.version,
  },
});
```

### 2. Periodic Heartbeats

```typescript
// Worker sends heartbeat every 10 seconds
setInterval(async () => {
  await updateWorkerHeartbeat(workerId, {
    currentJobs: activeJobs.size,
    totalJobsProcessed: stats.totalProcessed,
    totalJobsSucceeded: stats.totalSucceeded,
    totalJobsFailed: stats.totalFailed,
  });
}, 10000);

// Database update:
UPDATE workers
SET
  last_heartbeat = NOW(),
  current_jobs = $currentJobs,
  total_jobs_processed = $totalProcessed,
  total_jobs_succeeded = $totalSucceeded,
  total_jobs_failed = $totalFailed
WHERE id = $workerId;
```

### 3. Worker Failure Detection

```typescript
// Monitor process detects stale workers
async function detectStaleWorkers(thresholdMs = 30000) {
  const staleWorkers = await db
    .select()
    .from(workers)
    .where(
      and(
        eq(workers.status, 'ACTIVE'),
        lt(workers.lastHeartbeat, new Date(Date.now() - thresholdMs))
      )
    );

  for (const worker of staleWorkers) {
    logger.warn('Worker heartbeat timeout', {
      workerId: worker.id,
      lastHeartbeat: worker.lastHeartbeat,
    });

    // Mark worker as STOPPED
    await updateWorkerStatus(worker.id, 'STOPPED');

    // Jobs will be recovered via expired leases
  }
}
```

### 4. Worker Shutdown

`Worker.stop()` runs in two phases within `shutdownTimeoutMs` (default 30 s):

1. **Drain.** Polling stops and the worker is marked `STOPPING`, but leases keep
   renewing so in-flight handlers can finish and commit through the normal
   path. The drain budget is `shutdownTimeoutMs` minus a release reserve of
   `min(5 s, shutdownTimeoutMs / 2)`.
2. **Interrupt and release.** Handlers still running are signalled through
   their cancellation token, and each owned lease is handed back with
   `releaseJobDelivery` (see "Release on shutdown").

A JavaScript promise cannot be force-terminated. If a handler ignores the
signal, its code may keep running after its job has been released; handlers
must therefore make external effects idempotent. The worker reports
`STOPPED_UNCLEAN` and leaves the durable status at `STOPPING` in that case.

## Failure Scenarios

### Scenario 1: Worker Crashes During Job Processing

```
Timeline:
t0   Worker A acquires lease (expires at t0 + 30s)
t5   Worker A starts processing job
t10  Worker A crashes (no renewal, no completion)
t30  Lease expires
t31  Worker B acquires expired lease
t32  Worker B processes job (retry)

Result: Job processed at most once per lease, at least once overall
```

**Detection:** Lease expiration (automatic)  
**Recovery:** Other workers claim expired lease  
**Durability:** Job state preserved in PostgreSQL

### Scenario 2: Network Partition

```
Timeline:
t0   Worker A acquires lease (expires at t0 + 30s)
t5   Network partition: Worker A isolated
t15  Worker A tries to renew → fails (no network)
t20  Worker A continues processing (doesn't know lease expired)
t30  Lease expires
t31  Worker B acquires expired lease
t32  Worker B starts processing (duplicate work!)

Result: Possible duplicate execution (at-least-once guarantee)
```

**Detection:** Lease expiration + heartbeat timeout  
**Recovery:** Job processed by Worker B  
**Note:** At-least-once delivery allows this

### Scenario 3: Slow Job Processing

```
Timeline:
t0   Worker A acquires lease (expires at t0 + 30s)
t5   Worker A starts processing
t15  Worker A renews lease (expires at t15 + 30s = t45)
t30  Worker A renews lease (expires at t60)
t45  Worker A renews lease (expires at t75)
t50  Worker A completes job

Result: Successful processing with multiple renewals
```

**Detection:** N/A (normal operation)  
**Recovery:** N/A  
**Note:** Lease renewals prevent expiration

### Scenario 4: Database Failure During Renewal

```
Timeline:
t0   Worker A acquires lease (expires at t0 + 30s)
t15  Worker A tries to renew → database down → fails
t20  Database recovers
t30  Lease expires
t31  Worker B acquires expired lease

Result: Job may be processed twice (Worker A + Worker B)
```

**Detection:** Renewal failure + lease expiration  
**Recovery:** Other workers can acquire lease  
**Mitigation:** Worker should abort job if renewal fails

## Implementation Details

### Worker Class (packages/worker/src/worker.ts)

```typescript
class Worker {
  // Lease management
  private async executeJob(message, queue) {
    // 1. Acquire lease
    const lease = await acquireJobLease(jobId, this.workerId, {
      leaseDurationMs: this.config.leaseDurationMs,
    });

    if (!lease) {
      logger.warn('Failed to acquire lease', { jobId });
      return; // Another worker has it
    }

    // 2. Track active job
    const activeJob = {
      jobId,
      leaseId: lease.leaseId,
      startedAt: new Date(),
    };
    this.activeJobs.set(jobId, activeJob);

    // 3. Start lease renewal
    this.startLeaseRenewal(activeJob);

    try {
      // 4. Execute handler
      const result = await this.runHandler(job);

      // 5. Complete job (releases lease)
      await completeJob(jobId, result);
    } catch (error) {
      // 6. Fail job (releases lease)
      await failJob(jobId, { error: error.message });
    } finally {
      // 7. Stop renewal and cleanup
      this.stopLeaseRenewal(activeJob);
      this.activeJobs.delete(jobId);
    }
  }

  // Lease renewal
  private startLeaseRenewal(activeJob) {
    const renew = async () => {
      try {
        await renewJobLease(
          activeJob.jobId,
          activeJob.leaseId,
          this.config.leaseDurationMs
        );
      } catch (error) {
        logger.error('Lease renewal failed', { jobId: activeJob.jobId, error });
        // TODO: Abort job processing
      }
    };

    activeJob.leaseRenewalTimer = setInterval(
      renew,
      this.config.leaseRenewalIntervalMs // leaseDurationMs / 3
    );
  }

  // Heartbeat
  private startHeartbeat() {
    const sendHeartbeat = async () => {
      try {
        await updateWorkerHeartbeat(this.workerId, {
          currentJobs: this.activeJobs.size,
          totalJobsProcessed: this.stats.totalProcessed,
          totalJobsSucceeded: this.stats.totalSucceeded,
          totalJobsFailed: this.stats.totalFailed,
        });
      } catch (error) {
        logger.error('Heartbeat failed', { error });
      }
    };

    sendHeartbeat(); // Initial
    this.heartbeatTimer = setInterval(
      sendHeartbeat,
      this.config.heartbeatIntervalMs // 10000ms
    );
  }
}
```

## Configuration

### Default Configuration

```typescript
const defaultConfig = {
  // Lease settings
  leaseDurationMs: 30000, // 30 seconds
  leaseRenewalIntervalMs: 10000, // lease duration / 3

  // Heartbeat settings
  heartbeatIntervalMs: 10000, // 10 seconds

  // Stale detection
  staleThresholdMs: 60000, // 60 seconds (2x lease duration)
};
```

### Tuning Guidelines

**Short Jobs (< 5 seconds)**

```typescript
{
  leaseDurationMs: 10000,              // 10 seconds
  leaseRenewalIntervalMs: 5000,        // 5 seconds
  heartbeatIntervalMs: 5000,           // 5 seconds
}
```

**Long Jobs (> 1 minute)**

```typescript
{
  leaseDurationMs: 120000,             // 2 minutes
  leaseRenewalIntervalMs: 60000,       // 1 minute
  heartbeatIntervalMs: 30000,          // 30 seconds
}
```

**High Availability**

```typescript
{
  leaseDurationMs: 15000,              // 15 seconds (faster recovery)
  leaseRenewalIntervalMs: 7000,        // 7 seconds
  heartbeatIntervalMs: 5000,           // 5 seconds (more frequent)
}
```

## Monitoring

### Key Metrics

```typescript
// Lease metrics
lease_acquisition_total{queue, worker_id, result}  // success/failure
lease_renewal_total{queue, worker_id, result}
lease_expiration_total{queue, reason}              // timeout/worker_crash

// Heartbeat metrics
worker_heartbeat_total{worker_id}
worker_heartbeat_age_seconds{worker_id}            // Time since last heartbeat
worker_active_total{status}                        // ACTIVE, STOPPED, etc.

// Job processing
job_lease_duration_seconds{queue, job_type}        // How long leases held
job_processing_duration_seconds{queue, job_type}   // Actual processing time
```

### Alerting Rules

```yaml
# Worker heartbeat timeout
- alert: WorkerHeartbeatTimeout
  expr: time() - worker_heartbeat_age_seconds > 30
  for: 1m
  annotations:
    summary: Worker {{ $labels.worker_id }} heartbeat timeout

# High lease expiration rate
- alert: HighLeaseExpirationRate
  expr: rate(lease_expiration_total[5m]) > 0.1
  for: 5m
  annotations:
    summary: High lease expiration rate in {{ $labels.queue }}

# Lease renewal failures
- alert: LeaseRenewalFailures
  expr: rate(lease_renewal_total{result="failure"}[5m]) > 0.05
  for: 2m
  annotations:
    summary: Lease renewal failures in {{ $labels.queue }}
```

## Best Practices

### ✅ Do

1. **Set appropriate lease durations**
   - Match to expected job duration
   - Add buffer for network delays
   - Consider P99 latency, not average

2. **Renew at one third of the duration**
   - Standard pattern (Chubby, etcd)
   - Provides safety margin
   - Handles temporary network issues

3. **Handle renewal failures**
   - Abort job if renewal fails
   - Log failure for debugging
   - Don't assume lease is valid

4. **Monitor heartbeats**
   - Alert on missing heartbeats
   - Track worker health trends
   - Scale based on worker count

5. **Use optimistic locking**
   - Prevents race conditions
   - Ensures consistency
   - Version field in UPDATE WHERE

### ❌ Don't

1. **Don't make leases too short**
   - Increases renewal overhead
   - Higher chance of spurious expiration
   - More database load

2. **Don't make leases too long**
   - Slower failure recovery
   - Wasted capacity on dead workers
   - Harder to debug issues

3. **Don't ignore renewal failures**
   - Leads to duplicate processing
   - Wastes resources
   - Causes data inconsistency

4. **Don't skip heartbeats**
   - Breaks monitoring
   - Prevents auto-scaling
   - Hides worker issues

5. **Don't rely on lease alone**
   - Combine with job status
   - Use state machine validation
   - Verify results

## Comparison with Other Systems

### BullMQ (Redis-based)

```typescript
// BullMQ uses Redis locks
const lockDuration = 30000;
const lock = await queue.lock(jobId, lockDuration);

try {
  await processJob(job);
} finally {
  await lock.release();
}
```

**Differences:**

- TaskFlow: PostgreSQL-based (durable, ACID)
- BullMQ: Redis-based (fast, eventually consistent)
- TaskFlow: Automatic expiration via timestamp
- BullMQ: Lua script for atomicity

### Celery (Python)

```python
# Celery uses task state tracking
@app.task(bind=True)
def process_job(self):
    # No explicit lease - relies on worker tracking
    pass
```

**Differences:**

- TaskFlow: Explicit leases with renewal
- Celery: Implicit via worker state
- TaskFlow: Database-backed durability
- Celery: Broker-dependent

### Temporal (Workflow engine)

```typescript
// Temporal uses activity heartbeats
async function processJob() {
  await activity.heartbeat(); // Every 10s
  // Process...
}
```

**Differences:**

- TaskFlow: Leases + heartbeats (dual system)
- Temporal: Heartbeats for activity liveness
- TaskFlow: Job-level leases
- Temporal: Workflow-level orchestration

## Testing

### Unit Tests

```typescript
describe('Lease Management', () => {
  it('should acquire lease successfully', async () => {
    const lease = await acquireJobLease(jobId, workerId, {
      leaseDurationMs: 30000,
    });

    expect(lease).toBeDefined();
    expect(lease.workerId).toBe(workerId);
    expect(lease.leaseExpiresAt).toBeInstanceOf(Date);
  });

  it('should prevent duplicate lease acquisition', async () => {
    await acquireJobLease(jobId, 'worker-1', {});

    const result = await acquireJobLease(jobId, 'worker-2', {});
    expect(result).toBeNull(); // Worker 2 fails to acquire
  });

  it('should renew lease successfully', async () => {
    const lease = await acquireJobLease(jobId, workerId, {
      leaseDurationMs: 30000,
    });

    const renewed = await renewJobLease(jobId, lease.leaseId, 30000);

    expect(renewed).toBeDefined();
  });
});
```

### Integration Tests

```typescript
describe('Worker Heartbeats', () => {
  it('should send periodic heartbeats', async () => {
    const worker = createWorker(config, handlers);
    await worker.start();

    // Wait for 2 heartbeats
    await sleep(25000);

    const workerRecord = await getWorkerById(worker.config.workerId);
    const timeSinceHeartbeat =
      Date.now() - workerRecord.lastHeartbeat.getTime();

    expect(timeSinceHeartbeat).toBeLessThan(15000);

    await worker.stop();
  });
});
```

## Production Checklist

- [x] Lease acquisition with optimistic locking
- [x] Automatic lease renewal (one third of duration)
- [x] Lease expiration handling
- [x] Worker registration
- [x] Periodic heartbeats (10s)
- [x] Worker failure detection
- [x] Stale job recovery
- [x] Graceful shutdown (drain, then release leases without consuming an attempt)
- [ ] Monitoring dashboards
- [ ] Alerting rules
- [ ] Load testing with failures
- [ ] Chaos testing (kill workers)
- [ ] Runbook for incidents

## Summary

TaskFlow's lease and heartbeat system provides:

✅ **At-most-once execution** within a lease period  
✅ **At-least-once delivery** via automatic recovery  
✅ **Worker failure detection** via heartbeat timeouts  
✅ **Duplicate prevention** via exclusive leases  
✅ **Automatic recovery** via lease expiration  
✅ **Graceful degradation** via stale detection

This enables reliable distributed job processing with automatic failure recovery.

## References

- [Google Chubby Lock Service](https://research.google/pubs/pub27897/)
- [etcd Lock Protocol](https://etcd.io/docs/v3.5/learning/api/#lease-vs-lock)
- [Redis Redlock Algorithm](https://redis.io/docs/manual/patterns/distributed-locks/)
- [Apache Kafka Consumer Groups](https://kafka.apache.org/documentation/#intro_concepts_and_terms)

## License

MIT
