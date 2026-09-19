> Historical snapshot only. Claims and numbers below are not current acceptance evidence; use the root README and executable gates.

# Adversarial Architecture Review: TaskFlow

**Interview Format**: Senior Backend/Distributed Systems Engineer  
**Goal**: Stress test architecture, identify edge cases, break assumptions  
**Approach**: Adversarial questioning with honest, technical answers

---

## Table of Contents

1. [Failure Scenarios](#failure-scenarios)
2. [Concurrency & Race Conditions](#concurrency--race-conditions)
3. [Edge Cases & Abuse](#edge-cases--abuse)
4. [Scalability & Performance](#scalability--performance)
5. [Consistency & Guarantees](#consistency--guarantees)
6. [Recovery & Resilience](#recovery--resilience)
7. [Design Trade-offs](#design-trade-offs)

---

## Failure Scenarios

### Q1: What happens if Redis goes down after DB insertion but before enqueue?

**Scenario:**

```
1. API receives POST /api/v1/jobs
2. Job created in PostgreSQL (status=CREATED) ✅
3. Redis connection fails ❌
4. enqueueJob() throws error
5. API returns 500 to client
```

**Current Implementation:**

```typescript
// apps/api/src/routes/jobs.ts:100-150
const job = await createJob(jobData);

// If scheduledAt <= now, enqueue immediately
if (new Date(job.scheduledAt) <= new Date()) {
  await enqueueJob(job.id, queueName); // ⚠️ Can fail!
  await updateJobStatus(job.id, 'QUEUED');
}

return reply.status(201).send({ job });
```

**What Actually Happens:**

1. Job exists in PostgreSQL with status=CREATED
2. Redis enqueue fails, exception thrown
3. API returns 500 Internal Server Error
4. Client retries (with idempotency key)
5. Idempotency middleware returns existing job (200 OK)
6. **Job is now stuck in CREATED state forever** ❌

**Why It's Stuck:**

- Scheduler only enqueues jobs with `scheduledAt <= now AND status = CREATED`
- But this job has `scheduledAt = now()` (in the past)
- Scheduler picks it up eventually ✅

**Wait, Does It Actually Recover?**

Let me check the scheduler implementation:

```typescript
// packages/queue/src/scheduler.ts:50-100
async pollForDueJobs() {
  const dueJobs = await getDueJobs(this.batchSize);

  for (const job of dueJobs) {
    await enqueueJob(job.id, getQueueName(job));
    await updateJobStatus(job.id, 'QUEUED');
  }
}

// packages/database/src/repositories/job.repository.ts
export async function getDueJobs(limit: number = 100): Promise<Job[]> {
  return await db
    .select()
    .from(jobs)
    .where(
      and(
        inArray(jobs.status, ['CREATED', 'RETRY_SCHEDULED']),
        lte(jobs.scheduledAt, new Date())
      )
    )
    .orderBy(asc(jobs.scheduledAt))
    .limit(limit);
}
```

**Answer:** ✅ **It DOES recover** (eventually)

The scheduler will pick up the CREATED job and enqueue it. However:

**Problems:**

1. **Delay**: Job won't start until next scheduler cycle (default: 10s)
2. **Client confusion**: Client gets 500 error but job eventually processes
3. **No client notification**: Client doesn't know job succeeded

**Better Solution:**

```typescript
// Graceful fallback
try {
  if (new Date(job.scheduledAt) <= new Date()) {
    await enqueueJob(job.id, queueName);
    await updateJobStatus(job.id, 'QUEUED');
  }
} catch (error) {
  logger.error('Failed to enqueue job, scheduler will retry', {
    jobId: job.id,
    error,
  });
  // DON'T throw - job is safely in database
}

// Return 201 Created (job is safe, will be processed)
return reply.status(201).send({
  job,
  warning: 'Job created but enqueue delayed, will be processed shortly',
});
```

**Grade:** B (recovers but with poor UX)

---

### Q2: What happens if Redis accepts the job but API crashes before responding?

**Scenario:**

```
1. Job created in PostgreSQL ✅
2. Job enqueued to Redis ✅
3. API crashes before sending response ❌
4. Client times out
5. Client retries with same idempotency key
```

**Current Implementation:**

Client retry hits idempotency middleware:

```typescript
// apps/api/src/middleware/idempotency.ts:70-110
const [existingKey] = await tx
  .select()
  .from(idempotencyKeys)
  .where(
    and(
      eq(idempotencyKeys.userId, userId),
      eq(idempotencyKeys.idempotencyKey, idempotencyKey),
      gt(idempotencyKeys.expiresAt, new Date())
    )
  );

if (existingKey) {
  const [existingJob] = await tx
    .select()
    .from(jobs)
    .where(eq(jobs.id, existingKey.jobId));

  return reply
    .status(200)
    .header('X-Idempotent-Replay', 'true')
    .send({ job: existingJob });
}
```

**Answer:** ✅ **Handled correctly**

1. Client retries with same idempotency key
2. Idempotency middleware finds existing job
3. Returns 200 OK with existing job
4. Client receives job ID
5. Job is already enqueued and processing

**No duplicate job created** ✅

**Grade:** A (perfect idempotency)

---

### Q3: What happens if a worker dies after completing a job but before ACK?

**Scenario:**

```
1. Worker A consumes message from Redis
2. Worker A executes handler successfully
3. Worker A calls completeJob() in PostgreSQL ✅
4. Worker A crashes before XACK to Redis ❌
5. Message stays in Redis pending state
6. After 60s, stale recovery kicks in
7. Worker B claims the message
```

**This is RACE-6 from Architecture Review!**

**Current Implementation:**

```typescript
// packages/worker/src/worker.ts:450-480
try {
  const result = await this.runHandler(job, cancellationToken);

  // Update PostgreSQL
  await completeJob(jobId, this.config.workerId, result); // ✅ COMMITTED

  // Acknowledge Redis
  await acknowledgeMessage(queue, group, message.id); // ❌ CRASH HERE

  this.updateStats(true, duration);
} catch (error) {
  // ...
}
```

**What Actually Happens:**

1. Worker B claims stale message (XCLAIM)
2. Worker B fetches job from PostgreSQL
3. Job status = SUCCEEDED (already done!)
4. Worker B tries to acquire lease:

```typescript
// packages/database/src/repositories/job.repository.ts:270-290
export async function acquireJobLease(
  jobId: string,
  workerId: string,
  options: { leaseDurationMs?: number } = {}
): Promise<Job | null> {
  const [job] = await db
    .update(jobs)
    .set({
      status: 'PROCESSING',
      workerId,
      leaseId,
      leaseExpiresAt,
      startedAt: sql`COALESCE(${jobs.startedAt}, NOW())`,
      attempts: sql`${jobs.attempts} + 1`,
      version: sql`${jobs.version} + 1`,
    })
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.status, 'QUEUED') // ⚠️ Only QUEUED jobs!
        // ...
      )
    )
    .returning();

  return job || null;
}
```

**Answer:** ✅ **Partially protected**

Lease acquisition **requires status=QUEUED**, so Worker B's lease acquisition **fails**.

**But then what?**

```typescript
// packages/worker/src/worker.ts:380-400
const lease = await acquireJobLease(jobId, this.config.workerId, {
  leaseDurationMs: this.config.leaseDurationMs || 30000,
});

if (!lease) {
  this.logger.warn('Failed to acquire job lease', { jobId });
  // ⚠️ Don't acknowledge - let another worker claim it
  return;
}
```

Worker B **doesn't acknowledge** the message!

**Result:**

- Message stays in Redis pending (claimed by Worker B)
- Worker B doesn't process it (lease failed)
- **Message is stuck forever** ❌

**Wait, what about Worker B's stale recovery?**

Worker B will try to claim it again after 60s, but the message is **already owned by Worker B** (from XCLAIM). So `XCLAIM` returns the same message, and we loop forever.

**Actually, let me re-check XCLAIM behavior:**

```typescript
// packages/queue/src/consumer.ts:260-300
export async function claimStaleMessages(
  queueName: string,
  workerId: string,
  minIdleTimeMs: number = 30000,
  limit: number = 10
): Promise<ConsumedMessage[]> {
  // 1. Get pending messages
  const pending = await getPendingMessages(queueName, undefined, 100);

  // 2. Filter by idle time
  const staleIds = pending
    .filter((p) => p.idleTimeMs > minIdleTimeMs)
    .slice(0, limit)
    .map((p) => p.messageId);

  // 3. Claim ownership
  const claimed = await redis.xclaim(
    streamKey,
    groupName,
    consumerName,
    minIdleTimeMs,
    ...staleIds
  );

  return messages;
}
```

**XPENDING returns ALL pending messages**, including those already claimed by the current worker.

So Worker B will:

1. See its own message in pending list
2. XCLAIM it again (becomes stale after 60s)
3. Try to acquire lease (fails, status=SUCCEEDED)
4. Don't XACK
5. Loop forever

**Answer:** ❌ **BROKEN - Message stuck in infinite loop**

**Fix:**

```typescript
// Option 1: XACK even if lease acquisition fails
if (!lease) {
  this.logger.warn('Failed to acquire job lease', { jobId });

  // Check if job is already in terminal state
  const job = await getJobById(jobId);
  if (job && ['SUCCEEDED', 'CANCELLED', 'DEAD_LETTERED'].includes(job.status)) {
    // Job already done, safe to XACK
    await acknowledgeMessage(queue, group, message.id);
    this.logger.info('Acknowledged completed job', { jobId });
  }

  return;
}

// Option 2: Reverse order (from Phase 25 recommendations)
// XACK first, then update PostgreSQL
await acknowledgeMessage(queue, group, message.id);
await completeJob(jobId, workerId, result);
```

**Grade:** D (broken recovery loop)

---

### Q4: What happens if ACK succeeds but DB update fails?

**Scenario:**

```
1. Worker executes job successfully
2. Worker calls XACK to Redis ✅
3. Worker calls completeJob() in PostgreSQL ❌ (fails)
4. Message is gone from Redis
5. Job stuck in PROCESSING state
```

**This would happen if we implement "XACK first" fix from Q3:**

```typescript
// Proposed fix
await acknowledgeMessage(queue, group, message.id); // ✅
await completeJob(jobId, workerId, result); // ❌ Fails
```

**What Actually Happens:**

1. Message removed from Redis (acknowledged)
2. PostgreSQL update fails (connection error, deadlock, etc.)
3. Exception thrown in worker
4. Worker logs error
5. **Job stuck in PROCESSING with valid lease** ❌

**Recovery Mechanism:**

Lease expiry sweeper (if implemented per Phase 25):

```typescript
// Every 30s, find jobs with expired leases
const expiredJobs = await db
  .select()
  .from(jobs)
  .where(
    and(eq(jobs.status, 'PROCESSING'), lt(jobs.leaseExpiresAt, new Date()))
  );

for (const job of expiredJobs) {
  await releaseJobLease(job.id, job.workerId, job.leaseId);
  // Status: PROCESSING → QUEUED
}
```

**But wait!** Job is not in Redis anymore (already XACK'd).

**Answer:** ❌ **Job lost** (stuck in PROCESSING, not in Redis)

**This is why "PostgreSQL first, Redis second" is correct!**

**The Architecture Review recommendation was WRONG for this reason.**

Let me reconsider the trade-offs:

**Option A: PostgreSQL first, Redis second (CURRENT)**

```
completeJob()  ✅
XACK()         ❌ Crash
Result: Job SUCCEEDED but message in Redis → Re-execution
```

**Option B: Redis first, PostgreSQL second (PROPOSED)**

```
XACK()         ✅
completeJob()  ❌ Crash
Result: Message gone, job PROCESSING → Lost job
```

**Which is worse?**

- **Option A**: Duplicate execution (handler must be idempotent)
- **Option B**: Lost job (never completes, never retries)

**Lost job is WAY worse than duplicate execution!**

**Correct Answer:** ✅ **Keep PostgreSQL first** (current is correct)

The RACE-6 fix should be:

```typescript
// Option 2: Idempotency token (from Architecture Review)
const executionToken = `exec:${jobId}:${attempt}`;

// 1. Store result with idempotency token
await db.transaction(async (tx) => {
  await tx.insert(execution_results).values({
    token: executionToken,
    jobId,
    result,
    createdAt: new Date(),
  });

  await completeJob(jobId, workerId, result, tx);
});

// 2. XACK (safe - if crash, re-execution will find token)
await acknowledgeMessage(queue, group, message.id);

// 3. Before executing handler, check token
const existing = await getExecutionResult(executionToken);
if (existing) {
  logger.info('Job already executed', { jobId, token: executionToken });
  return existing.result; // Return cached result
}
```

**Grade:** This question revealed the Architecture Review was wrong! B → A (current design is correct)

---

### Q5: What happens if two workers process the same job?

**Scenario:**

```
1. Worker A consumes message from Redis
2. Worker B claims same message as "stale" (race condition)
3. Both workers try to acquire lease
```

**Current Implementation:**

Both workers call `acquireJobLease()`:

```typescript
export async function acquireJobLease(
  jobId: string,
  workerId: string,
  options: { leaseDurationMs?: number } = {}
): Promise<Job | null> {
  const leaseId = crypto.randomUUID();
  const leaseExpiresAt = new Date(Date.now() + leaseDurationMs);

  const [job] = await db
    .update(jobs)
    .set({
      status: 'PROCESSING',
      workerId,
      leaseId,
      leaseExpiresAt,
      startedAt: sql`COALESCE(${jobs.startedAt}, NOW())`,
      attempts: sql`${jobs.attempts} + 1`,
      version: sql`${jobs.version} + 1`,
    })
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.status, 'QUEUED'),
        lt(jobs.scheduledAt, new Date()),
        or(
          sql`${jobs.leaseExpiresAt} IS NULL`,
          lt(jobs.leaseExpiresAt, new Date())
        )
      )
    )
    .returning();

  return job || null;
}
```

**Answer:** ✅ **Protected by optimistic locking**

Only **one UPDATE succeeds**:

- Worker A: UPDATE returns 1 row (lease acquired)
- Worker B: UPDATE returns 0 rows (job already PROCESSING)

**Winner:** Worker A  
**Loser:** Worker B returns early (doesn't process)

**But what about the message in Redis?**

- Worker A: Has message, has lease → processes job → XACK
- Worker B: Has message (claimed), no lease → doesn't XACK

**Worker B's message stays in pending!**

After 60s, Worker B (or another worker) will claim it again, but job is already SUCCEEDED or PROCESSING.

**This creates the same stuck message problem from Q3.**

**Answer:** ⚠️ **Protected from duplicate execution, but message cleanup is incomplete**

**Better implementation:**

```typescript
const lease = await acquireJobLease(jobId, workerId);

if (!lease) {
  // Check if job is in terminal state
  const job = await getJobById(jobId);
  if (job && ['SUCCEEDED', 'CANCELLED', 'DEAD_LETTERED'].includes(job.status)) {
    await acknowledgeMessage(queue, group, message.id);
  }
  return;
}
```

**Grade:** B+ (prevents duplicate execution, but message cleanup incomplete)

---

### Q6: What happens if a worker heartbeat is delayed?

**Scenario:**

```
1. Worker is healthy but CPU-bound (processing 10 jobs)
2. Heartbeat timer fires but event loop is blocked
3. Heartbeat delayed by 30 seconds
4. External systems think worker is dead
```

**Current Implementation:**

```typescript
// packages/worker/src/worker.ts:180-210
private startHeartbeat(): void {
  const sendHeartbeat = async () => {
    try {
      await updateWorkerHeartbeat(this.config.workerId, {
        currentJobs: this.activeJobs.size,
        totalJobsProcessed: this.stats.totalProcessed,
        totalJobsSucceeded: this.stats.totalSucceeded,
        totalJobsFailed: this.stats.totalFailed,
      });
    } catch (error) {
      this.logger.error('Failed to send heartbeat', { error });
    }
  };

  // Send initial heartbeat
  sendHeartbeat();

  // Schedule periodic heartbeats
  this.heartbeatTimer = setInterval(
    sendHeartbeat,
    this.config.heartbeatIntervalMs || 10000  // Every 10s
  );
}
```

**What Actually Happens:**

Node.js event loop is single-threaded:

- If all jobs are CPU-intensive, event loop is blocked
- `setInterval` callbacks queue up but don't execute
- Heartbeat can be delayed by 10s, 20s, 30s+

**Impact:**

- External monitoring sees worker as unhealthy
- Dashboard shows worker as "stale"
- But worker is actually processing jobs fine

**Is this a problem?**

Check if heartbeat is used for critical decisions:

```typescript
// packages/database/src/repositories/worker.repository.ts:120-140
export async function getStaleWorkers(
  staleThresholdMs: number = 60000
): Promise<Worker[]> {
  return await db
    .select()
    .from(workers)
    .where(
      and(
        inArray(workers.status, ['ACTIVE', 'IDLE']),
        lt(workers.lastHeartbeatAt, new Date(Date.now() - staleThresholdMs))
      )
    );
}
```

**Heartbeat is only used for monitoring, not for critical operations** (like lease expiry).

**Answer:** ⚠️ **Minor issue** (monitoring inaccuracy only)

**Impact:**

- False alarms in monitoring
- Incorrect worker count in dashboard
- But no data loss or duplicate execution

**Better Solution:**

Use `process.hrtime()` to track actual delay:

```typescript
let lastHeartbeatTime = process.hrtime.bigint();

const sendHeartbeat = async () => {
  const now = process.hrtime.bigint();
  const delayNs = now - lastHeartbeatTime;
  const delayMs = Number(delayNs / 1000000n);

  if (delayMs > this.config.heartbeatIntervalMs * 2) {
    this.logger.warn('Heartbeat delayed, event loop blocked', {
      expectedMs: this.config.heartbeatIntervalMs,
      actualDelayMs: delayMs,
    });
  }

  await updateWorkerHeartbeat(this.config.workerId, {
    currentJobs: this.activeJobs.size,
    // ...
    heartbeatDelayMs: delayMs, // Track delay
  });

  lastHeartbeatTime = now;
};
```

**Grade:** B (minor monitoring issue, not critical)

---

### Q7: What happens if PostgreSQL is unavailable?

**Scenario:**

```
1. PostgreSQL connection pool exhausted or database down
2. API receives job submission request
3. Worker tries to fetch job
4. Scheduler tries to query due jobs
```

**API Impact:**

```typescript
// apps/api/src/routes/jobs.ts:85-120
const job = await createJob(jobData); // ❌ Throws exception
```

**Current Error Handling:**

```typescript
// apps/api/src/index.ts:50-80 (Fastify error handler)
fastify.setErrorHandler((error, request, reply) => {
  logger.error('Unhandled error', {
    error,
    requestId: request.id,
    url: request.url,
  });

  reply.status(500).send({
    error: 'Internal Server Error',
    message: 'An unexpected error occurred',
    requestId: request.id,
  });
});
```

**API Returns:** 503 Service Unavailable (should be 503, currently 500)

**Worker Impact:**

```typescript
// packages/worker/src/worker.ts:420-450
const job = await getJobById(jobId);

if (!job) {
  this.logger.error('Job not found in database', { jobId });
  await acknowledgeMessage(queue, group, message.id); // ⚠️ XACK anyway!
  return;
}
```

If `getJobById()` throws exception (DB unavailable):

- Exception caught in `executeJob()` catch block
- Job marked as FAILED
- But wait, `failJob()` also needs DB access! ❌

**Actual Behavior:**

```typescript
catch (error) {
  await failJob(jobId, workerId, {
    error: error.message,
    stackTrace: error.stack,
  }, {
    shouldRetry: true,
    retryDelayMs: 0,
  });  // ❌ This also fails!

  await acknowledgeMessage(queue, group, message.id);  // ⚠️ This might succeed
}
```

**Result:** ❌ **Message XACK'd but job state unknown**

**Answer:** ❌ **Poor PostgreSQL failure handling**

**Better Implementation:**

```typescript
try {
  const job = await getJobById(jobId);
  // ...
} catch (error) {
  // Check if error is database-related
  if (isDatabaseError(error)) {
    this.logger.error('Database unavailable, not acknowledging message', {
      jobId,
      error,
    });

    // DON'T XACK - let stale recovery retry when DB is back
    return;
  }

  // Other errors - proceed with failJob
  await failJob(jobId, workerId, { error: error.message });
  await acknowledgeMessage(queue, group, message.id);
}
```

**Grade:** C (poor failure handling, messages can be lost)

---

### Q8: What happens if Kafka is unavailable?

**Scenario:**

```
1. Worker completes job successfully
2. Worker tries to publish event to Kafka
3. Kafka is down or unreachable
```

**Current Implementation:**

```typescript
// packages/events/src/publisher.ts:50-80
export async function publishJobCompleted(event: JobCompletedEvent): Promise<void> {
  try {
    await producer.send({
      topic: TOPICS.JOB_EVENTS,
      messages: [{
        key: event.jobId,
        value: JSON.stringify(envelope),
        headers: { ... },
      }],
    });
  } catch (error) {
    logger.error('Failed to publish event', { event, error });
    // ⚠️ ERROR LOGGED BUT EVENT LOST!
  }
}
```

**Called From:**

```typescript
// packages/worker/src/worker.ts:470-480
await completeJob(jobId, workerId, result);  // ✅ PostgreSQL updated
await acknowledgeMessage(queue, group, message.id);  // ✅ Redis XACK
await publishJobCompleted({ jobId, ... });  // ❌ Kafka fails
```

**Answer:** ⚠️ **Event is lost** (fire-and-forget)

**Impact:**

- Downstream services don't know job completed
- Webhooks not sent
- Dashboard doesn't update
- Audit log incomplete

**But job is still completed successfully** ✅

**Is this acceptable?**

Depends on requirements:

- If events are **critical**: NO (use outbox pattern)
- If events are **nice-to-have**: YES (current approach is fine)

**Better Implementation (Outbox Pattern):**

```typescript
// In same transaction as completeJob
await db.transaction(async (tx) => {
  await completeJob(jobId, workerId, result, tx);

  // Store event in outbox
  await tx.insert(outbox).values({
    id: crypto.randomUUID(),
    eventType: 'JOB_COMPLETED',
    eventPayload: { jobId, result, ... },
    createdAt: new Date(),
  });
});

// Separate background process publishes from outbox
setInterval(async () => {
  const pendingEvents = await getPendingOutboxEvents(100);

  for (const event of pendingEvents) {
    try {
      await publishToKafka(event);
      await markOutboxEventPublished(event.id);
    } catch (error) {
      await incrementOutboxRetryCount(event.id);
    }
  }
}, 5000);
```

**Grade:** C (events lost, but job processing unaffected)

---

## Concurrency & Race Conditions

### Q9: How does cancellation race with completion?

**Scenario:**

```
Timeline:
T0: Worker starts processing job
T1: Client calls DELETE /api/v1/jobs/:id (cancel)
T2: API updates status: PROCESSING → CANCEL_REQUESTED
T3: Worker completes job
T4: Worker updates status: CANCEL_REQUESTED → SUCCEEDED
```

**Is this race condition handled?**

**State Machine Validation:**

```typescript
// packages/database/src/state-machine.ts:20-80
export const VALID_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  // ...
  CANCEL_REQUESTED: [
    'CANCELLED',
    'SUCCEEDED', // ✅ Allowed!
    'FAILED', // ✅ Allowed!
    'DEAD_LETTERED', // ✅ Allowed!
  ],
  // ...
};
```

**Answer:** ✅ **Explicitly allowed**

**Reasoning:**

- Job already executing when cancel requested
- Cancellation is best-effort (cooperative)
- If job completes before worker checks cancellation token, it succeeds
- This is correct behavior (job actually completed successfully)

**Client receives:**

- DELETE /api/v1/jobs/:id → 200 OK (cancellation requested)
- GET /api/v1/jobs/:id → status=SUCCEEDED (job completed)

**Grade:** A (correct handling, clearly documented)

---

### Q10: How does idempotency work under concurrent requests?

**Scenario:**

```
Two clients send same idempotency key simultaneously:

Thread A: POST /api/v1/jobs (idempotency-key: abc123)
Thread B: POST /api/v1/jobs (idempotency-key: abc123)

Both hit API at same time.
```

**Current Implementation:**

```typescript
// apps/api/src/middleware/idempotency.ts:50-120
export async function checkIdempotency(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const idempotencyKey = request.headers['idempotency-key'] as string;

  if (!idempotencyKey) {
    return; // No idempotency key, proceed
  }

  // Check existing key
  const [existingKey] = await db
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.userId, request.user!.id),
        eq(idempotencyKeys.idempotencyKey, idempotencyKey),
        gt(idempotencyKeys.expiresAt, new Date())
      )
    );

  if (existingKey) {
    // Return existing job
    const [existingJob] = await db
      .select()
      .from(jobs)
      .where(eq(jobs.id, existingKey.jobId));

    return reply
      .status(200)
      .header('X-Idempotent-Replay', 'true')
      .send({ job: existingJob });
  }

  // No existing key, proceed to create job
}
```

**Job Creation:**

```typescript
// packages/database/src/repositories/job.repository.ts:680-750
export async function createJobWithIdempotency(
  userId: string,
  idempotencyKey: string,
  requestHash: string,
  jobData: NewJob,
  idempotencyExpirationMs: number = 86400000 // 24 hours
): Promise<Job> {
  return await db.transaction(async (tx) => {
    // Check if idempotency key already exists
    const [existingKey] = await tx
      .select()
      .from(schema.idempotencyKeys)
      .where(
        and(
          eq(schema.idempotencyKeys.userId, userId),
          eq(schema.idempotencyKeys.idempotencyKey, idempotencyKey),
          gt(schema.idempotencyKeys.expiresAt, new Date())
        )
      );

    if (existingKey) {
      // Return existing job
      const [existingJob] = await tx
        .select()
        .from(jobs)
        .where(eq(jobs.id, existingKey.jobId));

      return existingJob;
    }

    // Create new job
    const [job] = await tx.insert(jobs).values(jobData).returning();

    // Create idempotency key
    const expiresAt = new Date(Date.now() + idempotencyExpirationMs);
    await tx.insert(schema.idempotencyKeys).values({
      id: crypto.randomUUID(),
      userId,
      idempotencyKey,
      jobId: job.id,
      requestHash,
      createdAt: new Date(),
      expiresAt,
    });

    return job;
  });
}
```

**Race Condition Analysis:**

```
Timeline:
T0: Thread A checks idempotency key → NOT FOUND
T0: Thread B checks idempotency key → NOT FOUND
T1: Thread A starts transaction
T1: Thread B starts transaction
T2: Thread A checks idempotency key in transaction → NOT FOUND
T2: Thread B checks idempotency key in transaction → NOT FOUND
T3: Thread A inserts job + idempotency key
T3: Thread B inserts job + idempotency key → ❌ UNIQUE CONSTRAINT VIOLATION
T4: Thread A commits
T4: Thread B rollback (error)
```

**Database Constraint:**

```sql
CREATE TABLE idempotency_keys (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  job_id UUID NOT NULL,
  -- ...
  UNIQUE(user_id, idempotency_key)  -- ✅ Enforces uniqueness
);
```

**Answer:** ✅ **Protected by database constraint**

Thread B gets unique constraint violation, should retry:

```typescript
try {
  const job = await createJobWithIdempotency(...);
} catch (error) {
  if (error.code === '23505') {  // Unique violation
    // Retry read after short delay
    await sleep(100);
    return await getJobByIdempotencyKey(userId, idempotencyKey);
  }
  throw error;
}
```

**But current implementation doesn't retry!**

```typescript
// apps/api/src/routes/jobs.ts:100-120
const job = await createJobWithIdempotency(...);  // ❌ Throws on duplicate
```

**Result:** Thread B gets 500 Internal Server Error

**Thread B should get 200 OK with existing job!**

**Better Implementation:**

```typescript
try {
  const job = await createJobWithIdempotency(...);
  return reply.status(201).send({ job });
} catch (error) {
  if (error.code === '23505') {  // PostgreSQL unique violation
    // Another request with same key just succeeded
    await sleep(50);  // Give it time to commit

    const existingJob = await getJobByIdempotencyKey(
      request.user!.id,
      idempotencyKey
    );

    return reply
      .status(200)
      .header('X-Idempotent-Replay', 'true')
      .send({ job: existingJob });
  }

  throw error;  // Other errors
}
```

**Grade:** B (protected but error handling incomplete)

---

## Edge Cases & Abuse

### Q11: What happens during retry storms?

**Scenario:**

```
1. Bad deployment causes all jobs to fail
2. 10,000 jobs move to RETRY_SCHEDULED
3. All scheduled for retry in 1 second (exponential backoff)
4. Scheduler enqueues all 10,000 jobs simultaneously
5. Workers overwhelmed
```

**Current Implementation:**

```typescript
// packages/retry/src/backoff.ts:40-80
export function calculateBackoff(
  attempt: number,
  strategy: BackoffStrategy = 'exponential',
  options: BackoffOptions = {}
): number {
  const {
    baseDelayMs = 1000,
    maxDelayMs = 60000,
    factor = 2,
    jitterFactor = 0.1,
  } = options;

  let delay: number;

  switch (strategy) {
    case 'exponential':
      delay = Math.min(baseDelayMs * Math.pow(factor, attempt - 1), maxDelayMs);
      break;
    // ...
  }

  // Add jitter to prevent thundering herd
  const jitter = delay * jitterFactor * (Math.random() * 2 - 1);
  delay = Math.max(0, delay + jitter);

  return Math.floor(delay);
}
```

**Jitter helps but doesn't prevent storm:**

With 10,000 jobs:

- Attempt 1 delay: 1000ms ± 10% = 900-1100ms
- All 10,000 jobs retry within 200ms window
- Still a storm!

**Scheduler behavior:**

```typescript
// packages/queue/src/scheduler.ts:60-90
async pollForDueJobs() {
  const dueJobs = await getDueJobs(this.batchSize);  // Default: 100

  for (const job of dueJobs) {
    await enqueueJob(job.id, getQueueName(job));
    await updateJobStatus(job.id, 'QUEUED');
  }
}
```

**Batch size = 100**, so scheduler processes 100 jobs per cycle (10s).

**Time to process 10,000 jobs:** 10,000 / 100 × 10s = 1000s = 16.7 minutes

**Answer:** ✅ **Rate-limited by batch size**

Scheduler processes retries slowly, preventing storm.

**But what about workers?**

Workers consume from Redis:

- 10 workers × 10 concurrent jobs = 100 jobs processing simultaneously
- Queue depth grows faster than workers can process
- Workers don't crash but become slow

**Is this a problem?**

Yes, if queue depth reaches millions:

- Redis memory exhaustion
- Increased latency for new jobs
- Workers spend more time on failing jobs

**Better Solution:**

**Circuit Breaker:**

```typescript
class CircuitBreaker {
  private failureCount = 0;
  private lastFailureTime = 0;
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';

  async execute(jobType: string, handler: () => Promise<any>) {
    if (this.state === 'OPEN') {
      // Check if enough time has passed
      if (Date.now() - this.lastFailureTime > 60000) {
        this.state = 'HALF_OPEN';
      } else {
        throw new CircuitBreakerOpenError();
      }
    }

    try {
      const result = await handler();

      if (this.state === 'HALF_OPEN') {
        this.reset();
      }

      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  private recordFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= 10) {
      this.state = 'OPEN';
      logger.error('Circuit breaker opened', {
        failureCount: this.failureCount,
      });
    }
  }

  private reset() {
    this.failureCount = 0;
    this.state = 'CLOSED';
  }
}
```

**Grade:** B (batch size prevents storm, but no circuit breaker)

---

### Q12: How does priority avoid starvation?

**Scenario:**

```
Queue has:
- 1,000,000 LOW priority jobs
- 1 CRITICAL priority job

Will CRITICAL job ever execute?
```

**Current Implementation:**

**In PostgreSQL:**

```typescript
// packages/database/src/repositories/job.repository.ts:180-220
export async function getNextAvailableJobs(
  queueIds: string[],
  limit: number = 10
): Promise<Job[]> {
  return await db
    .select()
    .from(jobs)
    .where(
      and(
        inArray(jobs.queueId, queueIds),
        eq(jobs.status, 'QUEUED'),
        lte(jobs.scheduledAt, new Date()),
        or(
          sql`${jobs.leaseExpiresAt} IS NULL`,
          lt(jobs.leaseExpiresAt, new Date())
        )
      )
    )
    .orderBy(
      desc(jobs.priority), // ✅ Priority first
      asc(jobs.scheduledAt) // Then FIFO
    )
    .limit(limit);
}
```

**In Redis:**

```typescript
// packages/queue/src/consumer.ts:40-80
const result = await redis.xreadgroup(
  'GROUP',
  groupName,
  consumerName,
  'COUNT',
  batchSize,
  'BLOCK',
  blockMs,
  'STREAMS',
  ...streams,
  ...ids // ⚠️ FIFO order only!
);
```

**Answer:** ❌ **Priority honored in PostgreSQL, ignored in Redis**

**From Phase 25 Architecture Review:** This is RACE condition P1-2.

**What actually happens:**

1. LOW jobs enqueued to Redis (1M messages)
2. CRITICAL job enqueued to Redis (1 message, at end)
3. Workers consume FIFO from Redis
4. CRITICAL job waits behind 1M LOW jobs

**Answer:** ❌ **CRITICAL job starved** (waits for 1M jobs to complete)

**Fix Required:**

Separate streams per priority:

```typescript
// Enqueue to priority-specific stream
const streamKey = `taskflow:stream:${queueName}:${priority}`;
await redis.xadd(streamKey, '*', 'data', JSON.stringify(message));

// Worker consumes from multiple streams with priority
const streams = [
  `taskflow:stream:${queue}:CRITICAL`,
  `taskflow:stream:${queue}:HIGH`,
  `taskflow:stream:${queue}:NORMAL`,
  `taskflow:stream:${queue}:LOW`,
];

// Consume CRITICAL first, then HIGH, etc.
for (const stream of streams) {
  const messages = await redis.xreadgroup(
    'GROUP',
    groupName,
    consumerName,
    'COUNT',
    batchSize,
    'NOBLOCK', // Don't wait
    'STREAMS',
    stream,
    '>'
  );

  if (messages && messages.length > 0) {
    return messages; // Process these first
  }
}
```

**Grade:** D (priority starvation exists)

---

## Scalability & Performance

### Q13: What is the bottleneck at 10K jobs/sec?

**Current Architecture:**

```
API → PostgreSQL (job creation)
API → Redis (enqueue)
Workers → Redis (consume)
Workers → PostgreSQL (lease, update)
Workers → Kafka (events)
```

**Bottleneck Analysis:**

1. **PostgreSQL Writes** (job creation)
   - Single INSERT per job
   - ~10,000 TPS theoretical max
   - **Bottleneck: YES** at 10K jobs/sec

2. **Redis XADD** (enqueue)
   - Single-threaded, ~50K-100K ops/sec
   - **Bottleneck: NO** at 10K jobs/sec

3. **PostgreSQL Reads** (lease acquisition)
   - Single UPDATE per job
   - ~10,000 TPS theoretical max
   - **Bottleneck: YES** at 10K jobs/sec

4. **Redis XREADGROUP** (consume)
   - Batch of 10 messages per call
   - 10K jobs/sec = 1K calls/sec
   - **Bottleneck: NO**

**Answer:** ✅ **PostgreSQL is the bottleneck**

**At 10K jobs/sec:**

- PostgreSQL handles: 10K INSERT + 10K UPDATE = 20K TPS
- This is **at the limit** for single PostgreSQL instance
- Connection pool exhaustion likely

**How to scale beyond 10K jobs/sec:**

**Option 1: Batch Inserts**

```typescript
// Instead of 10K individual INSERTs
for (const job of jobs) {
  await db.insert(jobs).values(job);
}

// Batch insert 100 at a time
const batches = chunk(jobs, 100);
for (const batch of batches) {
  await db.insert(jobs).values(batch);
}

// 10K jobs/sec → 100 INSERT/sec (100x reduction)
```

**Option 2: Read Replicas**

```typescript
// Use read replica for queries (getNextAvailableJobs)
// Use primary for writes (INSERT, UPDATE)

const primaryDb = createDb(primaryConnectionString);
const replicaDb = createDb(replicaConnectionString);

// Read from replica
const jobs = await replicaDb.select().from(jobs).where(...);

// Write to primary
await primaryDb.update(jobs).set(...);
```

**Option 3: Reduce PostgreSQL Updates**

```typescript
// Don't update PostgreSQL on every lease renewal
// Only on acquisition and completion

// Current: Lease renewed every 15s (4 UPDATEs per minute)
// Optimized: No renewal UPDATEs, rely on lease expiry

// Save: 10K jobs × 4 UPDATEs = 40K UPDATEs/min = 667 UPDATEs/sec
```

**Grade:** B (correctly identified, solutions available)

---

### Q14: How would you scale from 10K to 100K to 1M jobs/sec?

**10K jobs/sec (Current Limits):**

- ✅ Single PostgreSQL instance (at limit)
- ✅ Single Redis instance
- ✅ 10-20 workers
- ✅ Single Kafka cluster

**100K jobs/sec:**

**Changes Needed:**

1. **PostgreSQL Sharding**

   ```typescript
   // Shard by queue name
   const shardId = hashCode(queueName) % numShards;
   const db = getDbShard(shardId);

   await db.insert(jobs).values(job);
   ```

2. **Redis Cluster**

   ```typescript
   // Redis Cluster automatically shards by key
   const redis = new Redis.Cluster([
     { host: 'redis-1', port: 6379 },
     { host: 'redis-2', port: 6379 },
     { host: 'redis-3', port: 6379 },
   ]);

   // Stream key includes {queue} for hash tag
   const streamKey = `taskflow:stream:{${queueName}}`;
   ```

3. **100+ Workers**
   - Horizontal scaling
   - Auto-scaling based on queue depth

4. **Batch Operations**
   - Batch INSERT (100 jobs per query)
   - Batch XADD (pipeline 100 messages)

**1M jobs/sec:**

**Changes Needed:**

1. **Remove PostgreSQL from Hot Path**

   ```typescript
   // Option A: Buffer in Redis, persist async
   await redis.xadd(streamKey, '*', 'data', JSON.stringify(job));

   // Background process persists to PostgreSQL
   setInterval(async () => {
     const jobs = await consumeFromBuffer(1000);
     await db.insert(jobs).values(jobs); // Batch 1000
   }, 1000);

   // Option B: Use Kafka as primary queue
   await producer.send({
     topic: queueName,
     messages: [{ value: JSON.stringify(job) }],
   });

   // Workers consume from Kafka, persist to PostgreSQL after completion
   ```

2. **Horizontal Sharding Everything**
   - 10 PostgreSQL shards
   - 10 Redis clusters
   - 1000+ workers
   - Multi-region deployment

3. **Change Architecture**
   ```
   API → Kafka (primary queue)
   Workers → Kafka (consume)
   Workers → PostgreSQL (persist results only)

   PostgreSQL no longer in hot path!
   ```

**Grade:** A (comprehensive scaling plan)

---

## Consistency & Guarantees

### Q15: Why is this at-least-once rather than exactly-once?

**Answer:**

**At-Least-Once Delivery:**

- Job may be executed **one or more times**
- Guaranteed to execute **at least once**

**Exactly-Once Delivery:**

- Job executed **exactly once**
- Never duplicated

**Why TaskFlow is At-Least-Once:**

1. **RACE-6: Duplicate Execution**
   - Worker crashes after PostgreSQL update, before Redis XACK
   - Job re-executed by another worker
   - **2 executions** for 1 job

2. **Retry Logic**
   - Failed jobs are retried
   - If handler has side effects, retry causes duplicate
   - Example: Email sent twice

3. **Idempotency Only at API Layer**
   - Client can't submit duplicate jobs
   - But execution itself not idempotent

**Why Exactly-Once is Hard:**

**Exactly-once requires:**

- Atomic operations across **all systems** (PostgreSQL + Redis + Kafka + Handler side effects)
- Distributed transaction (2PC)
- Or idempotent handlers + deduplication

**TaskFlow doesn't have:**

- ❌ Distributed transactions
- ❌ Handler-level idempotency framework
- ❌ Execution deduplication

**To Achieve Exactly-Once:**

**Option 1: Execution Tokens (from Q4)**

```typescript
const executionToken = `exec:${jobId}:${attempt}`;

// Before execution
const existing = await getExecutionResult(executionToken);
if (existing) {
  return existing.result; // Already executed
}

// Execute handler
const result = await handler(job.payload);

// Store result with token (atomic)
await storeExecutionResult(executionToken, result);
```

**Option 2: Idempotent Handlers**

```typescript
// Handler checks if work already done
async function sendEmailHandler(payload) {
  const { userId, emailId } = payload;

  // Check if email already sent
  const existing = await db
    .select()
    .from(sent_emails)
    .where(eq(sent_emails.emailId, emailId));

  if (existing) {
    return { sent: false, reason: 'already_sent' };
  }

  // Send email
  await sendEmail(userId, emailId);

  // Record sent
  await db.insert(sent_emails).values({ emailId, sentAt: new Date() });

  return { sent: true };
}
```

**Grade:** A (correct understanding, clear explanation)

---

### Q16: What happens during a regional outage?

**Scenario:**

```
Multi-region deployment:
- us-east-1: API, Workers, PostgreSQL primary
- us-west-2: API, Workers, PostgreSQL replica

us-east-1 goes down completely.
```

**Current Architecture:**

TaskFlow has **no multi-region support**:

- Single PostgreSQL instance (no replication configured)
- Single Redis instance (no replication)
- Single Kafka cluster (no cross-region)

**Answer:** ❌ **Complete outage** (no failover)

**Impact:**

- All APIs down (us-west-2 can't reach PostgreSQL)
- All workers down (us-west-2 can't reach Redis)
- No job processing
- Data safe (PostgreSQL not lost, just unavailable)

**To Support Regional Failover:**

**Option 1: PostgreSQL Read Replica + Manual Promotion**

```yaml
Primary: us-east-1 (read-write)
Replica: us-west-2 (read-only)

On outage:
1. Detect primary down
2. Promote replica to primary
3. Update connection strings
4. Resume operations

Downtime: ~5-10 minutes
```

**Option 2: Multi-Master PostgreSQL (BDR)**

```yaml
Primary: us-east-1 (read-write)
Primary: us-west-2 (read-write)

Conflict resolution on job ID (last-write-wins)

Downtime: ~0 seconds (automatic failover)
```

**Option 3: Separate Deployments Per Region**

```yaml
Region: us-east-1
- PostgreSQL, Redis, Kafka, API, Workers (isolated)

Region: us-west-2
- PostgreSQL, Redis, Kafka, API, Workers (isolated)

Jobs partitioned by region (no cross-region dependencies)

Downtime: 0 (jobs in us-east-1 are lost, but us-west-2 continues)
```

**TaskFlow is designed for Option 3** (isolated regions).

**Grade:** B (no multi-region support, but architecture allows it)

---

## Design Trade-offs

### Q17: Why PostgreSQL as source of truth instead of Redis?

**Answer:**

**Reasons for PostgreSQL:**

1. **Durability**
   - PostgreSQL: fsync, WAL, ACID transactions
   - Redis: In-memory, optional persistence (RDB/AOF)
   - **Jobs must survive crashes** → PostgreSQL

2. **Complex Queries**
   - List jobs by user, filter by status, sort by priority
   - Redis: Limited query capabilities
   - PostgreSQL: Full SQL, indexes, joins

3. **Consistency**
   - PostgreSQL: Strong consistency (ACID)
   - Redis: Eventual consistency (replication lag)
   - **Job state must be consistent** → PostgreSQL

4. **Audit Trail**
   - PostgreSQL: Foreign keys, audit tables, triggers
   - Redis: No relational data
   - **Need job_attempts, dead_letter_jobs** → PostgreSQL

**Why Not Redis?**

Redis is used for **ephemeral message delivery**:

- Fast enqueue/dequeue (50K ops/sec)
- Consumer groups for distributed consumption
- No need for durability (messages acknowledged after processing)

**Trade-off:**

✅ **Pros:**

- Strong guarantees (durability, consistency)
- Rich querying (dashboard, filtering)
- Audit trail (compliance, debugging)

❌ **Cons:**

- Lower throughput (10K vs 50K ops/sec)
- More complex (two systems to maintain)
- Possible inconsistency (PostgreSQL vs Redis)

**Grade:** A (correct trade-off for production system)

---

### Q18: Why at-least-once delivery instead of exactly-once?

**Answer:**

**Reasons for At-Least-Once:**

1. **Simpler Implementation**
   - No distributed transactions
   - No global deduplication
   - Easier to reason about

2. **Better Performance**
   - No two-phase commit overhead
   - No consensus protocol (Paxos, Raft)
   - Lower latency

3. **Industry Standard**
   - Most message queues are at-least-once (RabbitMQ, SQS, Kafka)
   - Developers expect it
   - Proven pattern

4. **Handlers Should Be Idempotent Anyway**
   - Retries after transient failures → duplicate execution
   - Network partitions → duplicate execution
   - **Idempotency is required regardless**

**Exactly-Once is Expensive:**

- Requires distributed transactions (2PC)
- Or global coordination (Zookeeper, etcd)
- Significant performance penalty
- Complex failure modes

**Real-World Example:**

**Kafka's "Exactly-Once" Semantics:**

- Actually "effectively once" (within Kafka only)
- Doesn't extend to external systems (database, API calls)
- Requires idempotent producers + transactional consumers
- Still at-least-once for end-to-end processing

**Grade:** A (pragmatic trade-off)

---

## Summary & Recommendations

### Critical Issues Found

**P0 (Must Fix):**

1. **Message stuck in infinite loop** (Q3) - Workers can't XACK terminal jobs
2. **Poor PostgreSQL failure handling** (Q7) - Messages lost on DB errors
3. **Priority starvation** (Q12) - CRITICAL jobs behind 1M LOW jobs

**P1 (Should Fix):** 4. **Idempotency race condition** (Q10) - Concurrent requests get 500 instead of 200 5. **Event loss on Kafka failure** (Q8) - Fire-and-forget events 6. **No circuit breaker** (Q11) - Retry storms not prevented

**P2 (Nice to Have):** 7. **Heartbeat delays** (Q6) - Monitoring inaccuracy 8. **Redis recovery improvements** (Q1) - Better client messaging

### Strengths Confirmed

✅ **Excellent idempotency at API layer** (Q2, Q10)
✅ **Correct cancellation handling** (Q9)
✅ **Lease-based coordination works** (Q5)
✅ **Batch processing prevents retry storms** (Q11)
✅ **Correct architectural trade-offs** (Q17, Q18)

### Architecture Validation

**Question Q4 revealed Architecture Review was WRONG!**

**Correct order:** PostgreSQL first, Redis second

- Prevents job loss (most critical)
- Accepts duplicate execution risk (handlers must be idempotent)

**This is the right trade-off.**

### Scalability Roadmap

**10K jobs/sec:** ✅ Current architecture (at limit)
**100K jobs/sec:** Requires PostgreSQL sharding + Redis Cluster
**1M jobs/sec:** Requires architectural change (Kafka primary, PostgreSQL async)

### Production Readiness

**After fixing P0 issues:**

- ✅ Suitable for 10K-100K jobs/day
- ✅ Correct for medium-scale production
- ⚠️ Needs hardening for mission-critical use

**Not suitable for (without changes):**

- ❌ High-priority job guarantees (priority starvation)
- ❌ Multi-region deployment (no failover)
- ❌ >100K jobs/sec throughput

---

**End of Adversarial Review**
