# Job Cancellation

## Overview

TaskFlow supports **cooperative job cancellation**, allowing jobs to be gracefully cancelled while respecting work already in progress. Cancellation is **race-safe** with proper state machine transitions and optimistic locking.

## Cancellation Semantics

### Two-Phase Cancellation

**Phase 1: Request Cancellation** (`CANCEL_REQUESTED`)

- Job is running (`PROCESSING`)
- API marks job as `CANCEL_REQUESTED`
- Worker detects cancellation request
- Worker signals cancellation token
- Handler checks token and aborts gracefully

**Phase 2: Actual Cancellation** (`CANCELLED`)

- Handler throws `CancellationError`
- Worker marks job as `CANCELLED`
- Job enters terminal state

### Immediate vs Cooperative

| Job Status         | Cancellation Type | Behavior                                  |
| ------------------ | ----------------- | ----------------------------------------- |
| `CREATED`          | Immediate         | Status → `CANCELLED` (job never started)  |
| `QUEUED`           | Immediate         | Status → `CANCELLED` (job never claimed)  |
| `RETRY_SCHEDULED`  | Immediate         | Status → `CANCELLED` (retry prevented)    |
| `PROCESSING`       | Cooperative       | Status → `CANCEL_REQUESTED` → `CANCELLED` |
| `CANCEL_REQUESTED` | N/A               | Already cancelling                        |
| `SUCCEEDED`        | Not allowed       | Job completed                             |
| `CANCELLED`        | Not allowed       | Already cancelled                         |
| `DEAD_LETTERED`    | Not allowed       | Terminal state                            |

## State Machine

```
CREATED / QUEUED / RETRY_SCHEDULED
  └─→ DELETE /jobs/:id
       └─→ CANCELLED (immediate, terminal)

PROCESSING
  └─→ DELETE /jobs/:id
       └─→ CANCEL_REQUESTED (cooperative)
            └─→ Handler checks cancellation token
                 ├─→ CANCELLED (graceful abort, terminal)
                 ├─→ SUCCEEDED (completed before cancellation)
                 └─→ FAILED (error during cancellation)
```

## API Usage

### Cancel a Job

```typescript
// DELETE /api/v1/jobs/:jobId
const response = await fetch(`/api/v1/jobs/${jobId}`, {
  method: 'DELETE',
  headers: {
    'X-API-Key': apiKey,
  },
});

if (response.ok) {
  const job = await response.json();
  console.log('Job status:', job.status); // CANCELLED or CANCEL_REQUESTED
}
```

**Response**:

- `200 OK` + status `CANCELLED` → Job cancelled immediately (not running)
- `200 OK` + status `CANCEL_REQUESTED` → Cancellation requested (running job)
- `400 Bad Request` → Job in terminal state (cannot cancel)
- `404 Not Found` → Job doesn't exist

## Handler Implementation

### Basic Cancellation Check

```typescript
import { JobHandler, JobHandlerContext } from '@taskflow/types';

const handler: JobHandler = async (payload, ctx) => {
  const items = await fetchItems();

  for (const item of items) {
    // Check cancellation before processing each item
    ctx.cancellationToken.throwIfCancellationRequested();

    await processItem(item);
  }

  return { processed: items.length };
};
```

### With Cleanup

```typescript
const handler: JobHandler = async (payload, ctx) => {
  const resource = await allocateResource();

  try {
    // Register cleanup on cancellation
    ctx.cancellationToken.onCancellationRequested(() => {
      resource.cleanup();
    });

    for (const task of tasks) {
      ctx.cancellationToken.throwIfCancellationRequested();
      await executeTask(task, resource);
    }

    return { success: true };
  } finally {
    await resource.release();
  }
};
```

### Long-Running Operations

```typescript
const handler: JobHandler = async (payload, ctx) => {
  const { videoUrl } = payload;

  // Start external process
  const process = startVideoEncoding(videoUrl);

  // Register cancellation handler
  ctx.cancellationToken.onCancellationRequested(() => {
    process.kill(); // Terminate external process
  });

  // Wait for completion or cancellation
  while (!process.isDone()) {
    ctx.cancellationToken.throwIfCancellationRequested();
    await sleep(1000);
  }

  return { outputUrl: process.getOutputUrl() };
};
```

### Manual Cancellation Check

```typescript
const handler: JobHandler = async (payload, ctx) => {
  for (const batch of batches) {
    // Manual check
    if (ctx.cancellationToken.isCancellationRequested) {
      // Cleanup
      await rollbackBatch(batch);

      // Throw cancellation error
      throw new CancellationError('Job cancelled during batch processing');
    }

    await processBatch(batch);
  }

  return { success: true };
};
```

## Worker Implementation

### Cancellation Detection

A running worker first observes a cancel request when it renews the job's lease
(every `leaseDuration / 3`, 10 s by default). The renewal returns the row with
`status = CANCEL_REQUESTED`, and the worker signals the handler's cancellation
token. There is no separate polling loop.

### Handler Execution and Persistence

After the handler settles, the worker persists the outcome with a fenced
transaction (`completeJobDelivery`, `failJobDelivery`, or
`completeCancellation`) and only then acknowledges the Redis entry.

- Handler observed the cancel request and stopped: `completeCancellation`
  moves `CANCEL_REQUESTED -> CANCELLED`.
- Handler returned a result: `completeJobDelivery` (see Scenario 3).
- Handler failed: `failJobDelivery` (see Scenario 3b).

## Race Conditions

### Scenario 1: Cancel Before Start

```
Timeline:
t0   Job created (CREATED)
t1   Job enqueued (QUEUED)
t2   User cancels → CANCELLED
t3   Worker tries to acquire lease → fails (status != QUEUED)

Result: Job cancelled immediately, never executed
```

**Protection**: Lease acquisition checks `status = QUEUED`

### Scenario 2: Cancel During Execution

```
Timeline:
t0   Worker acquires lease (PROCESSING)
t1   Handler starts executing
t2   User cancels -> CANCEL_REQUESTED
t3   Next lease renewal returns CANCEL_REQUESTED (<= leaseDuration / 3 later)
t4   Worker signals the cancellation token
t5   Handler checks the token -> throws CancellationError
t6   Worker calls completeCancellation -> CANCELLED, then ACKs Redis

Result: Handler aborts gracefully
```

**Protection**: Cooperative cancellation; terminal state is committed before ACK

### Scenario 3: Result Produced Before the Cancel Request Is Observed

```
Timeline:
t0   Worker acquires lease (PROCESSING)
t1   Handler starts
t2   User cancels -> CANCEL_REQUESTED
t3   Handler returns a result (worker has not yet seen the request)
t4   completeJobDelivery commits -> SUCCEEDED

Result: Job succeeds; the cancel request arrived too late
```

The first durable observation wins. `completeJobDelivery` accepts a row in
either `PROCESSING` or `CANCEL_REQUESTED` while the caller still owns the
lease. The `completed` event records `lateCancellationRequestIgnored: true`.
Discarding a finished result and waiting out a full lease expiry would waste
the work and delay the job's terminal state.

### Scenario 3b: Failure Under an Unobserved Cancel Request

```
t2   User cancels -> CANCEL_REQUESTED
t3   Handler throws a transient error
t4   failJobDelivery sees CANCEL_REQUESTED -> throws JobCancellationRequestedError
t5   Worker calls completeCancellation -> CANCELLED, then ACKs Redis
```

A cancelled job must not be retried, so `failJobDelivery` never schedules a
retry or successor delivery for a `CANCEL_REQUESTED` job. The worker converts
the error into the normal cancellation path.

### Scenario 4: Concurrent Cancellation

```
Timeline:
t0   Worker A: Executing job
t1   Worker B: Also processing same job (lease stolen somehow)
t2   User cancels
t3   Worker A: Detects cancellation → CANCELLED
t4   Worker B: Tries to complete → fails (version mismatch)

Result: Optimistic locking prevents duplicate completion
```

**Protection**: Optimistic locking with version field

## Cancellation Token API

### CancellationToken Class

```typescript
class CancellationToken {
  // Properties
  isCancellationRequested: boolean;

  // Methods
  throwIfCancellationRequested(): void;
  onCancellationRequested(callback: () => void): () => void;
  cancel(): void; // Internal use only
  createChildToken(): CancellationToken;
}
```

### Helper Functions

```typescript
// Throw if cancelled + optional delay
await checkCancellation(token, 100);

// Timeout cancellation
const token = createTimeoutCancellationToken(5000);

// Combined cancellation (any of the tokens)
const combined = combineCancellationTokens(token1, token2);
```

## Best Practices

### ✅ Do

1. **Check periodically**

   ```typescript
   for (const item of items) {
     ctx.cancellationToken.throwIfCancellationRequested();
     await processItem(item);
   }
   ```

2. **Register cleanup handlers**

   ```typescript
   ctx.cancellationToken.onCancellationRequested(() => {
     cleanup();
   });
   ```

3. **Cancel external processes**

   ```typescript
   ctx.cancellationToken.onCancellationRequested(() => {
     childProcess.kill();
   });
   ```

4. **Throw CancellationError**

   ```typescript
   if (ctx.cancellationToken.isCancellationRequested) {
     throw new CancellationError('Cancelled during upload');
   }
   ```

5. **Use child tokens for nested operations**
   ```typescript
   const childToken = parentToken.createChildToken();
   await subOperation(childToken);
   ```

### ❌ Don't

1. **Don't ignore cancellation**

   ```typescript
   // BAD: No cancellation checks
   for (const item of items) {
     await processItem(item); // Long running, no checks
   }
   ```

2. **Don't catch CancellationError**

   ```typescript
   // BAD: Swallows cancellation
   try {
     ctx.cancellationToken.throwIfCancellationRequested();
   } catch {
     // Ignore
   }
   ```

3. **Don't assume immediate cancellation**

   ```typescript
   // BAD: Cancellation is asynchronous
   await cancelJob(jobId);
   // Job may still be running here!
   ```

4. **Don't check too infrequently**

   ```typescript
   // BAD: Hours between checks
   for (const largeItem of items) {
     ctx.cancellationToken.throwIfCancellationRequested();
     await processForHours(largeItem);
   }
   ```

5. **Don't cancel completed jobs**
   ```typescript
   // BAD: Check job status first
   if (job.status === 'SUCCEEDED') {
     // Don't try to cancel
   }
   ```

## Performance Impact

### Worker Cancellation Check

- **Frequency**: Every 2 seconds
- **Overhead**: Single database query per active job
- **Network**: ~1ms query latency
- **CPU**: Negligible

**Example**: 10 active jobs = 10 queries/2s = 5 QPS

### Handler Check

- **Cost**: In-memory boolean check
- **Overhead**: Nanoseconds
- **Recommendation**: Check every loop iteration or every 100ms

## Monitoring

### Metrics

```typescript
// Cancellation metrics
job_cancellation_total{status}              // immediate vs cooperative
job_cancellation_duration_seconds{status}   // time to cancel
job_cancel_detection_lag_seconds            // worker detection delay

// Cancellation outcomes
job_cancelled_graceful_total                // CancellationError thrown
job_cancelled_completed_total               // Completed before cancellation
job_cancelled_failed_total                  // Error during cancellation
```

### Alerts

```yaml
# High cancellation rate
- alert: HighJobCancellationRate
  expr: rate(job_cancellation_total[5m]) > 0.1
  for: 5m
  annotations:
    summary: High job cancellation rate

# Slow cancellation detection
- alert: SlowCancellationDetection
  expr: job_cancel_detection_lag_seconds > 10
  for: 2m
  annotations:
    summary: Worker taking >10s to detect cancellation
```

## Testing

### Unit Tests

```typescript
describe('Cancellation', () => {
  it('should cancel job before execution', async () => {
    const job = await submitJob({ type: 'test', payload: {} });

    await cancelJob(job.id);

    const cancelled = await getJobById(job.id);
    expect(cancelled.status).toBe('CANCELLED');
  });

  it('should request cancellation for running job', async () => {
    const job = await submitJob({ type: 'test', payload: {} });

    // Wait for job to start
    await waitForStatus(job.id, 'PROCESSING');

    await cancelJob(job.id);

    const cancelRequested = await getJobById(job.id);
    expect(cancelRequested.status).toBe('CANCEL_REQUESTED');

    // Wait for actual cancellation
    await waitForStatus(job.id, 'CANCELLED');
  });

  it('should throw CancellationError in handler', async () => {
    const handler: JobHandler = async (payload, ctx) => {
      await sleep(100);
      ctx.cancellationToken.throwIfCancellationRequested();
      return {};
    };

    // Start job
    const promise = executeJob(handler);

    // Cancel during execution
    await sleep(50);
    cancellationToken.cancel();

    // Should throw
    await expect(promise).rejects.toThrow(CancellationError);
  });
});
```

### Integration Tests

```typescript
describe('Cancellation Integration', () => {
  it('should cancel long-running job', async () => {
    const handler: JobHandler = async (payload, ctx) => {
      for (let i = 0; i < 100; i++) {
        ctx.cancellationToken.throwIfCancellationRequested();
        await sleep(100);
      }
      return { iterations: 100 };
    };

    registerHandler('long-running', handler);

    const job = await submitJob({
      type: 'long-running',
      payload: {},
    });

    // Wait for job to start
    await sleep(500);

    // Cancel job
    await cancelJob(job.id);

    // Wait for cancellation
    await sleep(3000);

    const final = await getJobById(job.id);
    expect(final.status).toBe('CANCELLED');
  });
});
```

## Comparison with Other Systems

### BullMQ

```typescript
// BullMQ: Job.remove() or Job.moveToFailed()
await job.remove();
```

**Differences**:

- BullMQ: Immediate removal from queue
- TaskFlow: State machine with CANCEL_REQUESTED
- BullMQ: No cooperative cancellation
- TaskFlow: Cancellation token for handlers

### Celery

```python
# Celery: revoke() with terminate
app.control.revoke(task_id, terminate=True)
```

**Differences**:

- Celery: Can forcefully terminate (SIGTERM)
- TaskFlow: Cooperative only (no force kill)
- Celery: Broker-dependent
- TaskFlow: Database state machine

### Temporal

```typescript
// Temporal: CancellationScope
await CancellationScope.cancellable(async () => {
  await activity.execute();
});
```

**Differences**:

- Temporal: Built into workflow engine
- TaskFlow: Job queue with token
- Temporal: Hierarchical cancellation
- TaskFlow: Flat (per-job tokens)

## Production Considerations

### Cancellation Latency

**Typical Timeline**:

```
User cancels (t0)
  ↓ API processes (10ms)
Status updated (t0 + 10ms)
  ↓ Worker checks (up to 2s)
Worker detects (t0 + 2s)
  ↓ Handler checks (variable)
Handler aborts (t0 + 2s + handler_delay)
```

**Expected**: 2-5 seconds for most jobs

### Tuning Cancellation Check

```typescript
// Fast cancellation (more DB load)
const worker = createWorker({
  cancellationCheckIntervalMs: 500, // Check every 500ms
});

// Slow cancellation (less DB load)
const worker = createWorker({
  cancellationCheckIntervalMs: 5000, // Check every 5s
});
```

**Trade-off**: Latency vs database load

### Graceful Shutdown

Shutdown is not cancellation. On `SIGTERM` the worker first lets in-flight
handlers finish, then signals the stragglers with reason `SHUTDOWN` and hands
their leases back to the queue without consuming an attempt. The job is not
marked `CANCELLED`. See "Release on shutdown" in `leases-and-heartbeats.md`.

## Summary

TaskFlow's cancellation system provides:

✅ **Race-safe** state transitions with optimistic locking  
✅ **Cooperative cancellation** via cancellation tokens  
✅ **Immediate cancellation** for queued jobs  
✅ **Graceful abort** for running jobs  
✅ **Cleanup support** via cancellation callbacks  
✅ **State machine validation** (valid transitions only)  
✅ **Locally process-tested** cancellation behavior; production readiness is not asserted

This enables safe, predictable job cancellation for long-running operations.

## License

MIT
