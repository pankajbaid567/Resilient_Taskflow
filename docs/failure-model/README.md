# Failure Model

## Overview

This document catalogs every failure scenario the system must handle, along with detection mechanisms, recovery strategies, consistency implications, and testing approaches.

## Design Philosophy

**Failures are normal.** A distributed system must be designed with the assumption that components will fail. The question is not "if" but "when" and "how gracefully."

## Core Principles

1. **PostgreSQL is Truth**: If everything else fails, PostgreSQL contains the durable state
2. **Fail Fast**: Detect failures quickly rather than propagating corrupted state
3. **Graceful Degradation**: Partial failures shouldn't cause total system failure
4. **Observable Failures**: Every failure mode produces metrics/logs/traces
5. **Testable**: Every failure must have an automated test

## Failure Taxonomy

### 1. API Service Crash

**Scenario:** API process terminates unexpectedly (OOM, segfault, kill signal)

**Detection:**
- Health check endpoint returns 503 or times out
- Load balancer marks instance unhealthy
- Prometheus alert: `up{job="api"} == 0`

**Recovery:**
- Other API instances continue serving requests
- Container orchestrator restarts crashed instance
- In-flight requests fail with 503 (client should retry)

**Consistency Implications:**
- Jobs already written to PostgreSQL survive
- Jobs in middle of submission transaction roll back
- Redis enqueue operations may or may not complete

**Data Loss:**
- No job data loss (PostgreSQL durability)
- Possible loss of in-flight HTTP responses (client should retry with idempotency key)

**Testing:**
```typescript
it('handles API crash during job submission', async () => {
  // Submit job, kill API mid-request
  const jobPromise = submitJob({ type: 'test' });
  setTimeout(() => killAPI(), 50);
  
  // Should either succeed or fail cleanly
  await expect(jobPromise).rejects.toThrow();
  
  // Job should be in consistent state
  const jobs = await getJobsInDatabase();
  jobs.forEach(job => {
    expect(['CREATED', 'QUEUED']).toContain(job.status);
  });
});
```

---

### 2. Worker Crash

**Scenario:** Worker process dies while processing job

**Detection:**
- Worker heartbeat stops updating
- `workers.last_heartbeat_at > 30 seconds ago`
- Lease expires: `jobs.lease_expires_at < NOW()`
- Prometheus alert: `worker_last_heartbeat_seconds > 30`

**Recovery:**
1. Lease expiry detector finds stale job:
   ```sql
   SELECT id FROM jobs 
   WHERE status = 'PROCESSING' 
     AND lease_expires_at < NOW()
   ```
2. Job transitioned back to QUEUED
3. Re-enqueued to Redis Stream
4. Another worker picks it up

**Consistency Implications:**
- Job may be delivered twice (at-least-once delivery)
- Handler must be idempotent
- Database update and Redis ACK must be coordinated

**Data Loss:**
- No data loss if lease mechanism works correctly
- Possible duplicate execution if handler not idempotent

**Timeline:**
```
T+0s:   Worker starts processing job (lease acquired)
T+30s:  Lease expires (worker hasn't renewed)
T+35s:  Worker crash detected by heartbeat monitor
T+40s:  Lease expiry detector finds job
T+41s:  Job transitioned to QUEUED, re-enqueued
T+45s:  Another worker picks up job
```

**Testing:**
```typescript
it('recovers job after worker crash', async () => {
  const job = await createJob();
  const worker = await startWorker();
  
  // Wait for worker to start processing
  await waitUntil(() => job.status === 'PROCESSING');
  
  // Kill worker
  await worker.kill();
  
  // Wait for lease expiry (30s)
  await sleep(35000);
  
  // Job should be recovered
  const recovered = await getJob(job.id);
  expect(recovered.status).toBe('QUEUED');
  
  // Start new worker, should complete
  const worker2 = await startWorker();
  await waitUntil(() => job.status === 'SUCCEEDED');
});
```

---

### 3. Redis Crash / Restart

**Scenario:** Redis instance crashes or is restarted for maintenance

**Detection:**
- Redis client connection errors
- `ECONNREFUSED` or `ETIMEDOUT`
- Prometheus alert: `redis_up == 0`

**Recovery:**

**Phase 1: During Outage**
- API cannot enqueue new jobs
- API returns 503 for job submissions
- Workers cannot consume jobs
- Jobs stay in CREATED state in PostgreSQL

**Phase 2: After Redis Recovers**
1. Streams are empty (Redis Streams are in-memory by default)
2. Consumer groups are gone
3. Background sweeper finds CREATED jobs:
   ```sql
   SELECT id, queue_id FROM jobs
   WHERE status = 'CREATED' AND created_at < NOW() - INTERVAL '1 minute'
   ```
4. Re-enqueue all CREATED jobs to Redis
5. Recreate consumer groups
6. Workers resume processing

**Consistency Implications:**
- PostgreSQL remains source of truth
- No job loss (all durable in PostgreSQL)
- Temporary unavailability of queue

**Data Loss:**
- No job data loss
- Loss of Redis Streams data (acceptable - jobs recovered from PostgreSQL)
- Loss of worker heartbeats (workers re-register)
- Loss of rate limit counters (temporary)

**Mitigation:**
- Enable Redis AOF (Append-Only File) for persistence
- Use Redis Sentinel for automatic failover
- Use Redis Cluster for high availability

**Testing:**
```typescript
it('recovers from Redis crash', async () => {
  // Create jobs
  const jobs = await Promise.all([
    createJob(), createJob(), createJob()
  ]);
  
  // Verify enqueued
  jobs.forEach(async j => {
    expect(await getJob(j.id).status).toBe('QUEUED');
  });
  
  // Kill Redis
  await redis.kill();
  
  // New submissions should fail gracefully
  await expect(createJob()).rejects.toThrow();
  
  // Restart Redis
  await redis.start();
  
  // Run sweeper
  await sweepOrphanedJobs();
  
  // Jobs should be re-enqueued
  jobs.forEach(async j => {
    const job = await getJob(j.id);
    expect(['QUEUED', 'PROCESSING']).toContain(job.status);
  });
  
  // Start worker
  await startWorker();
  
  // Jobs should complete
  await waitUntil(() => 
    jobs.every(j => getJob(j.id).status === 'SUCCEEDED')
  );
});
```

---

### 4. PostgreSQL Crash

**Scenario:** PostgreSQL crashes or becomes unavailable

**Detection:**
- Database connection errors
- Query timeouts
- Health check fails
- Prometheus alert: `pg_up == 0`

**Impact:**
- **API**: Cannot create jobs, cannot query job status → Return 503
- **Workers**: Cannot update job status → Cannot process jobs
- **System**: Complete halt until PostgreSQL recovers

**Recovery:**
- PostgreSQL restarts (automatic with Docker, orchestrator, or managed service)
- WAL (Write-Ahead Log) replays uncommitted transactions
- All committed data survives
- API and workers reconnect

**Consistency Implications:**
- In-flight transactions roll back
- Committed transactions are durable
- No data loss for committed jobs

**Data Loss:**
- No data loss for committed writes
- Loss of in-flight transactions
- Redis may contain messages for jobs that rolled back

**Handling Inconsistency:**
```typescript
async function processMessage(msg: JobMessage) {
  try {
    const job = await getJob(msg.jobId);
    if (!job) {
      // Job doesn't exist (transaction rolled back)
      logger.warn('Job not found, skipping', { jobId: msg.jobId });
      await acknowledgeJob(msg.queue, msg.messageId);
      return;
    }
    // Continue processing...
  } catch (error) {
    // Handle database errors...
  }
}
```

**Testing:**
```typescript
it('handles PostgreSQL crash gracefully', async () => {
  // System running normally
  const job1 = await createJob();
  expect(job1.status).toBe('QUEUED');
  
  // Kill PostgreSQL
  await postgres.kill();
  
  // New submissions should fail
  await expect(createJob()).rejects.toThrow(/connection/);
  
  // Health check should report unhealthy
  const health = await fetch('/health');
  expect(health.status).toBe(503);
  
  // Restart PostgreSQL
  await postgres.start();
  
  // System should recover
  const health2 = await fetch('/health');
  expect(health2.status).toBe(200);
  
  // Should be able to create new jobs
  const job2 = await createJob();
  expect(job2.status).toBe('QUEUED');
});
```

---

### 5. Kafka/Redpanda Crash

**Scenario:** Kafka instance crashes or becomes unavailable

**Detection:**
- Producer send failures
- Consumer connection errors
- Prometheus alert: `kafka_up == 0`

**Impact:**
- Events cannot be published
- Event consumers cannot read
- **Job processing continues** (Kafka is event propagation, not critical path)

**Recovery:**
- **Graceful Degradation**:
  - Queue event publications in memory buffer
  - If buffer fills, log to file or drop events
  - Workers continue processing jobs
  
- **After Kafka Recovers**:
  - Flush buffered events
  - Event consumers catch up

**Consistency Implications:**
- Job processing unaffected
- Event consumers see gaps or delays
- Acceptable for analytics/audit use case

**Data Loss:**
- Possible event loss (not critical for job execution)
- Job data remains intact in PostgreSQL

**Testing:**
```typescript
it('continues processing jobs when Kafka is down', async () => {
  // Kill Kafka
  await kafka.kill();
  
  // Should still be able to create and process jobs
  const job = await createJob({ type: 'test' });
  await startWorker();
  await waitUntil(() => getJob(job.id).status === 'SUCCEEDED');
  
  // Events might be buffered or dropped
  const events = await getKafkaEvents();
  expect(events).toHaveLength(0); // Kafka was down
  
  // Restart Kafka
  await kafka.start();
  
  // Future events should work
  const job2 = await createJob({ type: 'test2' });
  await waitUntil(() => getJob(job2.id).status === 'SUCCEEDED');
  
  const events2 = await getKafkaEvents();
  expect(events2.length).toBeGreaterThan(0);
});
```

---

### 6. Network Partition

**Scenario:** Network split isolates components

**Types:**

**6a. API ↔ PostgreSQL Partition**
- API cannot write jobs
- Return 503 to clients
- Workers in same network continue processing

**6b. API ↔ Redis Partition**
- API cannot enqueue jobs
- Jobs remain in CREATED state
- Background sweeper recovers when partition heals

**6c. Worker ↔ PostgreSQL Partition**
- Worker cannot update job status
- Lease expires
- Another worker (in connected partition) takes over

**6d. Worker ↔ Redis Partition**
- Worker cannot consume new jobs
- Continue processing in-flight jobs
- Cannot ACK messages (remain in PEL)
- After reconnection, messages claimed as stale

**Detection:**
- Connection timeouts
- High error rates
- Prometheus alerts on connection failures

**Recovery:**
- Automatic reconnection with exponential backoff
- Circuit breaker pattern
- Lease mechanism handles worker isolation

**Testing:**
```typescript
it('handles network partition between worker and Redis', async () => {
  const job = await createJob();
  const worker = await startWorker();
  
  // Partition worker from Redis
  await networkPartition(worker, redis);
  
  // Worker cannot consume, lease will expire
  await sleep(35000);
  
  // Heal partition
  await networkHeal(worker, redis);
  
  // Worker or another worker should recover job
  await waitUntil(() => getJob(job.id).status !== 'PROCESSING');
});
```

---

### 7. Duplicate Message Delivery

**Scenario:** Job delivered to multiple workers

**Causes:**
- Lease expires while worker still processing
- Redis message claimed by multiple workers (race condition)
- Network issue causes retry

**Prevention:**
- Lease mechanism (optimistic locking)
- Idempotent handlers
- Database constraints

**Detection:**
- Multiple workers report processing same job
- Log correlation shows duplicate execution

**Handling:**
```typescript
async function acquireLease(jobId: string, workerId: string): Promise<boolean> {
  const result = await db.query(`
    UPDATE jobs
    SET status = 'PROCESSING',
        worker_id = $1,
        lease_id = gen_random_uuid(),
        lease_expires_at = NOW() + INTERVAL '30 seconds',
        attempts = attempts + 1,
        version = version + 1
    WHERE id = $2
      AND status = 'QUEUED'
      AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
      AND version = $3
    RETURNING id
  `, [workerId, jobId, currentVersion]);
  
  return result.rowCount > 0; // False if another worker got it
}
```

**Testing:**
```typescript
it('prevents duplicate processing via lease', async () => {
  const job = await createJob();
  
  // Two workers try to acquire simultaneously
  const [result1, result2] = await Promise.all([
    acquireLease(job.id, 'worker-1'),
    acquireLease(job.id, 'worker-2')
  ]);
  
  // Only one should succeed
  expect([result1, result2].filter(Boolean)).toHaveLength(1);
});
```

---

### 8. Delayed Message Delivery

**Scenario:** Message takes longer than expected to reach worker

**Causes:**
- Network congestion
- Redis overloaded
- Worker slow to poll

**Impact:**
- Job sits in queue longer (increased wait time)
- No correctness issue
- Affects latency SLAs

**Detection:**
- `job.started_at - job.created_at` metric
- Prometheus alert: `job_wait_duration_seconds > threshold`

**Mitigation:**
- Monitor queue depth
- Auto-scale workers
- Increase worker polling rate
- Tune Redis configuration

---

### 9. Message Acknowledgement Failure

**Scenario:** Worker fails to ACK message after processing job

**Causes:**
- Worker crashes after completing job
- Redis connection lost before ACK
- Bug in ACK logic

**Impact:**
- Message remains in PEL (Pending Entry List)
- Eventually claimed as stale
- Job executed twice (if not idempotent)

**Prevention:**
```typescript
async function processMessage(msg: JobMessage) {
  try {
    // Process job and update database
    await completeJob(msg.jobId, workerId, result);
    
    // Only ACK after successful database update
    await acknowledgeJob(msg.queue, msg.messageId);
    
  } catch (error) {
    // DO NOT ACK on failure
    // Message will be redelivered
    throw error;
  }
}
```

**Detection:**
- High pending message count
- Same job executed multiple times

**Testing:**
```typescript
it('redelivers message if ACK fails', async () => {
  const job = await createJob();
  
  // Mock ACK failure
  jest.spyOn(redis, 'xack').mockRejectedValueOnce(new Error('ACK failed'));
  
  // Process job
  await processMessage({ jobId: job.id, ... });
  
  // Job should be completed in DB
  expect(await getJob(job.id).status).toBe('SUCCEEDED');
  
  // But message not ACKed, so pending
  const pending = await getPendingMessages(job.queue);
  expect(pending.some(p => p.jobId === job.id)).toBe(true);
  
  // Another worker claims and tries to process
  const leaseAcquired = await acquireLease(job.id, 'worker-2');
  
  // Should fail (already SUCCEEDED)
  expect(leaseAcquired).toBe(false);
});
```

---

### 10. Job Timeout

**Scenario:** Job takes longer than timeout_ms to execute

**Causes:**
- Handler has infinite loop
- Handler blocked on external resource
- Handler deadlocked

**Prevention:**
- Enforce timeout at worker level
- Use AbortController for cancellable operations

**Implementation:**
```typescript
async function executeJobWithTimeout(
  job: Job,
  handler: JobHandler
): Promise<any> {
  const timeout = job.timeout_ms || 30000;
  
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new TimeoutError()), timeout);
  });
  
  try {
    return await Promise.race([
      handler(job.payload),
      timeoutPromise
    ]);
  } catch (error) {
    if (error instanceof TimeoutError) {
      logger.warn('Job timed out', { jobId: job.id, timeout });
      throw new JobError('Job execution timed out', true); // Retriable
    }
    throw error;
  }
}
```

**Testing:**
```typescript
it('times out long-running job', async () => {
  const job = await createJob({
    type: 'sleep',
    payload: { duration: 60000 },
    timeout_ms: 1000
  });
  
  const worker = await startWorker();
  
  // Wait for timeout
  await sleep(2000);
  
  // Job should fail with timeout
  const result = await getJob(job.id);
  expect(result.status).toBe('FAILED');
  expect(result.error).toContain('timeout');
});
```

---

### 11. Job Handler Failure

**Scenario:** Handler throws exception

**Causes:**
- Bug in handler code
- Invalid payload
- External service failure

**Classification:**
- **Retriable**: Temporary issues (network, rate limit, transient error)
- **Non-Retriable**: Permanent issues (invalid data, logic error)

**Handling:**
```typescript
async function executeJob(job: Job): Promise<void> {
  try {
    const result = await handlers[job.type](job.payload);
    await completeJob(job.id, workerId, result);
    
  } catch (error) {
    const retriable = isRetriableError(error);
    
    if (retriable && job.attempts < job.max_attempts) {
      await scheduleRetry(job.id, error);
    } else {
      await deadLetterJob(job.id, error);
    }
  }
}

function isRetriableError(error: Error): boolean {
  return (
    error.name === 'NetworkError' ||
    error.name === 'TimeoutError' ||
    error.message.includes('rate limit') ||
    error.message.includes('temporarily unavailable')
  );
}
```

---

### 12. Malformed Payload

**Scenario:** Job payload doesn't match expected schema

**Detection:**
- Zod validation in API layer
- Runtime type checking in handler

**Prevention:**
```typescript
// API Layer
const SendEmailSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  body: z.string()
});

app.post('/jobs', async (req, res) => {
  const parsed = SendEmailSchema.safeParse(req.body.payload);
  
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid payload',
      details: parsed.error.errors
    });
  }
  
  // Continue...
});

// Handler Layer
async function sendEmailHandler(payload: unknown) {
  const validated = SendEmailSchema.parse(payload); // Throws if invalid
  // Process...
}
```

**If Validation Fails in Handler:**
- Non-retriable error (won't fix with retry)
- Move directly to dead letter queue
- Alert on malformed payloads

---

### 13. Poison Job

**Scenario:** Job consistently crashes worker process

**Causes:**
- Payload triggers worker bug
- Resource exhaustion (memory leak)
- Infinite recursion

**Detection:**
- Same job fails across multiple workers
- Worker crashes correlated with specific job ID
- Memory/CPU spike before crash

**Handling:**
1. Blacklist mechanism:
   ```sql
   ALTER TABLE jobs ADD COLUMN blacklisted BOOLEAN DEFAULT FALSE;
   ```

2. Auto-blacklist after N crashes:
   ```typescript
   if (job.attempts > 3 && allAttemptsResultedInWorkerCrash(job.id)) {
     await blacklistJob(job.id);
     await alertOperators('Poison job detected', { jobId: job.id });
   }
   ```

3. Manual inspection and fix

**Testing:**
```typescript
it('blacklists poison job', async () => {
  // Register handler that crashes worker
  registerHandler('crash', () => {
    process.exit(1);
  });
  
  const job = await createJob({ type: 'crash' });
  
  // Try processing 3 times with different workers
  for (let i = 0; i < 3; i++) {
    const worker = await startWorker();
    await waitUntil(() => worker.status === 'STOPPED');
  }
  
  // Job should be blacklisted
  const result = await getJob(job.id);
  expect(result.blacklisted).toBe(true);
});
```

---

### 14. Retry Storm

**Scenario:** Many jobs fail and retry simultaneously, overwhelming system

**Causes:**
- External service outage causes all jobs to fail
- All jobs scheduled to retry at same time

**Prevention:**
- Exponential backoff with jitter:
  ```typescript
  const baseDelay = 1000; // 1 second
  const attempt = job.attempts;
  const exponential = baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * exponential * 0.1; // ±10%
  const delay = exponential + jitter;
  ```

- Maximum concurrent retries:
  ```typescript
  const retryingCount = await db.query(`
    SELECT COUNT(*) FROM jobs WHERE status = 'RETRY_SCHEDULED'
  `);
  
  if (retryingCount > 10000) {
    // Slow down retry scheduling
    await sleep(5000);
  }
  ```

- Circuit breaker for external services

**Testing:**
```typescript
it('prevents retry storm with jitter', async () => {
  // Create 1000 jobs that will all fail
  const jobs = await Promise.all(
    Array(1000).fill(null).map(() => createJob({ type: 'failing_task' }))
  );
  
  // All fail simultaneously
  await startWorker();
  await waitUntil(() => jobs.every(j => getJob(j.id).status === 'RETRY_SCHEDULED'));
  
  // Check retry times are spread out
  const retryTimes = await db.query(`
    SELECT scheduled_at FROM jobs WHERE status = 'RETRY_SCHEDULED'
  `);
  
  const times = retryTimes.map(r => r.scheduled_at.getTime());
  const spread = Math.max(...times) - Math.min(...times);
  
  // Should be spread over several seconds (not all at once)
  expect(spread).toBeGreaterThan(5000); // > 5 seconds
});
```

---

### 15. Database Transaction Failure

**Scenario:** Transaction fails midway (deadlock, constraint violation, timeout)

**Causes:**
- Deadlock between concurrent transactions
- Unique constraint violation
- Transaction timeout
- Serialization failure

**Handling:**
```typescript
async function updateJobWithRetry(jobId: string, updates: Partial<Job>) {
  const maxRetries = 3;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await db.transaction(async (tx) => {
        const job = await tx.query(
          'SELECT * FROM jobs WHERE id = $1 FOR UPDATE',
          [jobId]
        );
        
        await tx.query(
          'UPDATE jobs SET ... WHERE id = $1',
          [jobId]
        );
        
        await tx.query(
          'INSERT INTO job_events ...',
          [...]
        );
      });
      
      return; // Success
      
    } catch (error) {
      if (isDeadlock(error) || isSerializationFailure(error)) {
        logger.warn('Transaction retry', { jobId, attempt, error });
        await sleep(100 * Math.pow(2, attempt)); // Exponential backoff
        continue;
      }
      throw error; // Non-retriable error
    }
  }
  
  throw new Error('Transaction failed after retries');
}
```

---

### 16. Partial System Failure

**Scenario:** Some components healthy, others failing

**Examples:**
- API healthy, PostgreSQL healthy, Redis down → Cannot enqueue jobs
- API healthy, Redis healthy, PostgreSQL down → Cannot create jobs
- Redis healthy, PostgreSQL healthy, all workers down → Queue grows

**Handling:**
- Health check reports overall system health:
  ```typescript
  app.get('/health', async (req, res) => {
    const postgres = await checkPostgreSQL();
    const redis = await checkRedis();
    const kafka = await checkKafka();
    
    const healthy = postgres && redis;
    const degraded = !kafka;
    
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'healthy' : 'unhealthy',
      degraded,
      checks: { postgres, redis, kafka }
    });
  });
  ```

- Graceful degradation:
  - If Kafka down: Continue job processing, buffer events
  - If Redis down: Return 503 for new jobs, wait for recovery
  - If PostgreSQL down: Return 503, halt all operations

---

## Failure Matrix

| Component | Detection | Recovery Time | Data Loss | Availability Impact |
|-----------|-----------|---------------|-----------|---------------------|
| API Crash | Health check, 30s | Immediate (other instances) | None | Partial (one instance) |
| Worker Crash | Heartbeat, 30s | 30-60s (lease expiry) | None (idempotent) | Minimal (others continue) |
| Redis Crash | Connection error | Minutes (sweeper recovery) | Ephemeral data only | Complete (temporary) |
| PostgreSQL Crash | Connection error | Minutes (restart + WAL replay) | None (committed) | Complete |
| Kafka Crash | Producer error | N/A (events buffered/dropped) | Events only | Job processing unaffected |
| Network Partition | Timeout | Depends on partition | None | Partial (isolated components) |

## Testing Strategy

### Unit Tests
- State machine transitions
- Error classification (retriable vs non-retriable)
- Retry calculation (exponential backoff + jitter)
- Lease logic

### Integration Tests
- API + PostgreSQL + Redis end-to-end
- Worker + PostgreSQL + Redis end-to-end
- Idempotency key enforcement
- Duplicate job handling

### Chaos Tests
- Kill random components
- Inject network delays
- Simulate resource exhaustion
- Corrupt messages
- Simulate clock skew

### Load Tests
- Sustained high throughput
- Spike traffic
- Many concurrent workers
- Large job payloads

## Operational Runbook

See [Incident Response Runbook](./incident-response.md) for detailed procedures.

## Next Steps

- [Retry Strategy](../architecture/retry-strategy.md)
- [Monitoring & Alerting](../reliability/monitoring.md)
- [Incident Response](./incident-response.md)
