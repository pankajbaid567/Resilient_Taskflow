> Historical snapshot only. Claims and numbers below are not current acceptance evidence; use the root README and executable gates.

# Architecture Review: TaskFlow Distributed Task Queue

**Review Date**: January 2024  
**Reviewer Role**: Principal Distributed Systems Engineer  
**Review Scope**: Complete system architecture, correctness, reliability, scalability, security

## Executive Summary

TaskFlow is a **well-architected distributed task queue** demonstrating strong understanding of distributed systems principles. The separation of concerns (PostgreSQL as source of truth, Redis Streams for message delivery, Kafka for events) is correct, and the lease-based coordination with optimistic locking shows production-grade thinking.

**However, several critical correctness issues must be fixed before production deployment.**

### Overall Assessment

| Category                | Rating     | Status                      |
| ----------------------- | ---------- | --------------------------- |
| **Architecture Design** | ⭐⭐⭐⭐⭐ | Excellent                   |
| **Correctness**         | ⭐⭐⭐     | Good (with P0 issues)       |
| **Reliability**         | ⭐⭐⭐⭐   | Very Good                   |
| **Scalability**         | ⭐⭐⭐     | Good (needs work)           |
| **Security**            | ⭐⭐       | Poor (NOT production-ready) |
| **Observability**       | ⭐⭐⭐⭐   | Very Good                   |
| **Operations**          | ⭐⭐⭐     | Good (missing features)     |

### Production Readiness: **NOT READY** ❌

**Blockers:**

1. P0-1: Duplicate execution race condition (RACE-6)
2. P0-2: Hardcoded authentication credentials
3. P0-3: Lease expiry sweeper not running
4. P0-4: Queue metadata not integrated
5. P1-1: No rate limiting on job submission

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Critical Findings (P0)](#critical-findings-p0)
3. [Serious Issues (P1)](#serious-issues-p1)
4. [Performance Issues (P2)](#performance-issues-p2)
5. [Quality Improvements (P3)](#quality-improvements-p3)
6. [Detailed Analysis](#detailed-analysis)
7. [Recommendations](#recommendations)
8. [Test Coverage Assessment](#test-coverage-assessment)

---

## Architecture Overview

### Component Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                        Client Applications                    │
└───────────────────────┬─────────────────────────────────────┘
                        │ HTTP/REST
                        ▼
┌─────────────────────────────────────────────────────────────┐
│                    API Server (Fastify)                       │
│  • Job Submission (POST /api/v1/jobs)                        │
│  • Job Status (GET /api/v1/jobs/:id)                         │
│  • Job Cancellation (DELETE /api/v1/jobs/:id)                │
│  • Auth Middleware (API Key / JWT - HARDCODED!)              │
│  • Rate Limiter (NOT APPLIED TO JOBS!)                       │
│  • Idempotency Middleware (transactional)                    │
└───────────────────────┬─────────────────────────────────────┘
                        │
            ┌───────────┼───────────┐
            ▼           ▼           ▼
    ┌───────────┐  ┌────────┐  ┌──────────┐
    │PostgreSQL │  │ Redis  │  │  Kafka   │
    │ (Truth)   │  │(Queue) │  │ (Events) │
    └─────┬─────┘  └────┬───┘  └──────────┘
          │             │
          │             │ XREADGROUP / XACK
          │             ▼
          │      ┌─────────────────┐
          │      │  Worker Pool    │
          │      │  • Lease-based  │
          │      │  • Concurrent   │
          └─────▶│  • Idempotent   │
                 └─────────────────┘
```

### Data Flow: Job Lifecycle

```
1. CLIENT → API: POST /api/v1/jobs
   ├─ Idempotency check (transaction)
   ├─ Create job in PostgreSQL (status=CREATED)
   ├─ If scheduledAt <= now: Enqueue to Redis (status=QUEUED)
   └─ Return job ID

2. REDIS STREAM: Job message waiting
   └─ Consumer group: taskflow-workers

3. WORKER: Poll for jobs
   ├─ XREADGROUP from Redis (blocking, batch=10)
   ├─ Fetch job from PostgreSQL by jobId
   ├─ Acquire lease (optimistic lock, status=PROCESSING)
   ├─ Execute handler with timeout
   ├─ Update PostgreSQL (status=SUCCEEDED)
   ├─ XACK message to Redis ⚠️ RACE CONDITION
   └─ Publish event to Kafka (fire-and-forget)

4. SCHEDULER: Background job
   ├─ Find jobs with scheduledAt <= now AND status=CREATED
   ├─ Enqueue to Redis
   └─ Update status=QUEUED
```

### Key Design Decisions

✅ **Good Decisions:**

1. **PostgreSQL as source of truth** - Single source of state, no eventual consistency issues
2. **Redis Streams with consumer groups** - Distributed consumption, automatic load balancing
3. **Lease-based coordination** - Prevents duplicate execution (mostly)
4. **Optimistic locking** - Uses version field to prevent concurrent updates
5. **State machine validation** - Enforces valid transitions at application layer
6. **Idempotency at API layer** - Request hash + transaction prevents duplicate job creation
7. **Comprehensive schema** - Audit trail, dead letter queue, worker tracking
8. **Event-driven architecture** - Kafka for async notifications (decoupled)
9. **Graceful shutdown** - Waits for active jobs with timeout
10. **Observability built-in** - Prometheus metrics, structured logging, OpenTelemetry support

❌ **Questionable Decisions:**

1. **Fire-and-forget event publishing** - Events can be lost, not transactional
2. **Single consumer group** - All workers share one group (limits flexibility)
3. **Priority queue only in PostgreSQL** - Redis delivers FIFO regardless of priority
4. **No distributed lock for scheduler** - Multiple scheduler instances can race
5. **Polling-based cancellation check** - Inefficient, 2s delay per job
6. **Queue table not integrated** - Hardcoded queue names despite schema

---

## Critical Findings (P0)

### P0-1: Duplicate Execution on Worker Crash (CORRECTNESS)

**Severity:** 🔴 CRITICAL - Data loss/corruption risk  
**Impact:** Jobs can be executed twice, violating at-least-once delivery assumption

**Description:**

Worker updates job to `SUCCEEDED` in PostgreSQL, then crashes **before** XACK to Redis. Message stays in Redis pending state. Stale recovery claims the message and re-executes the succeeded job.

**Code Location:**

```typescript
// packages/worker/src/worker.ts:400-450
try {
  // Execute handler
  const result = await this.runHandler(job, cancellationToken);

  // Complete job in PostgreSQL
  await completeJob(jobId, this.config.workerId, result); // ✅ COMMITTED

  // Acknowledge message in Redis
  await acknowledgeMessage(queue, consumerGroup, message.id); // ⚠️ CRASH HERE = DUPLICATE EXECUTION

  // Update stats
  this.updateStats(true, duration);
} catch (error) {
  // ...
}
```

**Scenario:**

1. Worker A executes job, writes `SUCCEEDED` to PostgreSQL
2. Worker A crashes before XACK
3. Message stays in Redis pending (not acknowledged)
4. Worker B claims stale message after 60s
5. Worker B fetches job from PostgreSQL (status=SUCCEEDED but re-executes anyway? OR lease acquisition fails and message is lost?)

**Root Cause:**
PostgreSQL and Redis operations are **not atomic**. Two-phase commit not used.

**Impact:**

- If handler is **not idempotent**: Duplicate side effects (double charge, double email, etc.)
- If lease acquisition checks status: Message is acknowledged but job stuck in `SUCCEEDED` with no re-execution (better but still broken)

**Recommended Fix:**

**Option 1: Reverse Order (Simpler)**

```typescript
try {
  const result = await this.runHandler(job, cancellationToken);

  // 1. XACK first (idempotent, can retry)
  await acknowledgeMessage(queue, consumerGroup, message.id);

  // 2. Update PostgreSQL (idempotent with optimistic locking)
  await completeJob(jobId, this.config.workerId, result);

  this.updateStats(true, duration);
} catch (error) {
  // If XACK succeeds but completeJob fails, job stays PROCESSING
  // Lease expiry sweeper will catch it (MUST IMPLEMENT P0-3)
}
```

**Pros:** Simple, no additional infra
**Cons:** Job can be stuck in PROCESSING if completeJob fails

**Option 2: Idempotency Token (Better)**

```typescript
// Store execution result with idempotency token before XACK
const executionToken = `exec:${jobId}:${attempt}`;

await db.transaction(async (tx) => {
  // Store result
  await tx.insert(execution_results).values({
    token: executionToken,
    jobId,
    result,
    createdAt: new Date(),
  });

  // Update job
  await completeJob(jobId, workerId, result, tx);
});

// Now safe to XACK (if crash, re-execution will find existing token)
await acknowledgeMessage(queue, consumerGroup, message.id);
```

**Pros:** Truly idempotent, prevents duplicate execution
**Cons:** Adds storage overhead, requires schema change

**Recommendation:** Implement **Option 1 immediately** (hotfix), then **Option 2** for production hardening.

---

### P0-2: Hardcoded Authentication Credentials (SECURITY)

**Severity:** 🔴 CRITICAL - Security vulnerability  
**Impact:** Anyone with code access can authenticate

**Description:**

Authentication middleware uses hardcoded test credentials in production code.

**Code Location:**

```typescript
// apps/api/src/middleware/auth.ts:98-120
async function validateApiKey(
  apiKey: string
): Promise<AuthenticatedUser | null> {
  // Temporary implementation for development
  if (apiKey === 'test-api-key') {
    // ⚠️ HARDCODED!
    return {
      id: 'test-user-id',
      email: 'test@example.com',
      role: 'user',
    };
  }

  if (apiKey === 'admin-api-key') {
    // ⚠️ HARDCODED!
    return {
      id: 'admin-user-id',
      email: 'admin@example.com',
      role: 'admin',
    };
  }

  return null;
}

async function validateJwtToken(
  token: string
): Promise<AuthenticatedUser | null> {
  // Temporary implementation for development
  // In production, use jsonwebtoken or jose library
  if (token === 'valid-jwt-token') {
    // ⚠️ HARDCODED!
    return {
      id: 'jwt-user-id',
      email: 'jwt@example.com',
      role: 'user',
    };
  }

  return null;
}
```

**Impact:**

- **Anyone** can submit jobs with `X-API-Key: test-api-key`
- **No user isolation** - test users can access any job
- **No audit trail** - All actions attributed to test users
- **No rate limiting** - Shared test keys bypass per-user limits

**Recommended Fix:**

1. **Immediate:** Add environment check

```typescript
async function validateApiKey(
  apiKey: string
): Promise<AuthenticatedUser | null> {
  // NEVER allow test keys in production
  if (process.env.NODE_ENV === 'production' && apiKey.startsWith('test-')) {
    logger.error('Test API key used in production', {
      apiKey: apiKey.substring(0, 8),
    });
    return null;
  }

  // Look up API key in database
  const apiKeyRecord = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.key, apiKey))
    .where(eq(apiKeys.isActive, true))
    .where(gt(apiKeys.expiresAt, new Date()));

  if (!apiKeyRecord) {
    return null;
  }

  // Fetch user
  const user = await getUserById(apiKeyRecord.userId);
  return user;
}
```

2. **Proper JWT validation:**

```typescript
import { jwtVerify } from 'jose';

async function validateJwtToken(
  token: string
): Promise<AuthenticatedUser | null> {
  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    const { payload } = await jwtVerify(token, secret);

    return {
      id: payload.sub as string,
      email: payload.email as string,
      role: payload.role as 'admin' | 'user',
    };
  } catch (error) {
    logger.warn('JWT validation failed', { error });
    return null;
  }
}
```

3. **Add api_keys table to schema:**

```sql
CREATE TABLE api_keys (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  key VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMP WITH TIME ZONE
);
```

**Recommendation:** **MUST FIX before any deployment**. This is a show-stopper.

---

### P0-3: Lease Expiry Sweeper Not Running (RELIABILITY)

**Severity:** 🔴 CRITICAL - Resource leak  
**Impact:** Jobs with expired leases never released, workers deadlock

**Description:**

Function `getJobsWithExpiredLeases()` exists but is never called. Expired leases accumulate forever.

**Code Location:**

```typescript
// packages/database/src/repositories/job.repository.ts:450-470
export async function getJobsWithExpiredLeases(
  limit: number = 100
): Promise<Job[]> {
  return await db
    .select()
    .from(jobs)
    .where(
      and(eq(jobs.status, 'PROCESSING'), lt(jobs.leaseExpiresAt, new Date()))
    )
    .limit(limit);
}
// ⚠️ NEVER CALLED ANYWHERE!
```

**Scenario:**

1. Worker A acquires lease (30s), starts processing
2. Worker A hangs (infinite loop, network partition, deadlock)
3. Lease expires after 30s
4. No worker can claim job (status=PROCESSING prevents new lease acquisition)
5. Job stuck forever in PROCESSING

**Impact:**

- **Job starvation**: Jobs never complete or retry
- **Worker deadlock**: All workers waiting for jobs that will never be released
- **Queue depth grows**: Throughput drops to zero

**Recommended Fix:**

**Background Sweeper:**

```typescript
// packages/worker/src/lease-sweeper.ts (NEW FILE)
import { getJobsWithExpiredLeases, releaseJobLease } from '@taskflow/database';
import { createLogger } from '@taskflow/logger';

const logger = createLogger({ component: 'LeaseSweeper' });

export class LeaseSweeper {
  private timer: NodeJS.Timeout | null = null;

  start(intervalMs: number = 30000) {
    this.timer = setInterval(async () => {
      try {
        const expiredJobs = await getJobsWithExpiredLeases(100);

        if (expiredJobs.length > 0) {
          logger.warn('Found expired leases', { count: expiredJobs.length });

          for (const job of expiredJobs) {
            await releaseJobLease(job.id, job.workerId, job.leaseId);
            logger.info('Released expired lease', { jobId: job.id });
          }
        }
      } catch (error) {
        logger.error('Lease sweeper error', { error });
      }
    }, intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
```

**Start in Worker:**

```typescript
// apps/worker/src/index.ts
const leaseSweeper = new LeaseSweeper();
leaseSweeper.start(30000); // Run every 30s

// Stop on shutdown
process.on('SIGTERM', () => {
  leaseSweeper.stop();
  worker.stop();
});
```

**Alternative: Use Scheduled Jobs** (if using scheduler already)

```typescript
// Register lease sweeper as a recurring job
scheduler.schedule('lease-sweeper', {
  cron: '*/30 * * * * *', // Every 30 seconds
  handler: async () => {
    const expired = await getJobsWithExpiredLeases(100);
    for (const job of expired) {
      await releaseJobLease(job.id, job.workerId, job.leaseId);
    }
  },
});
```

**Recommendation:** **MUST implement immediately**. This prevents catastrophic failures.

---

### P0-4: Queue Metadata Not Integrated (CORRECTNESS)

**Severity:** 🔴 CRITICAL - Schema/code mismatch  
**Impact:** Queue configuration ignored, hardcoded values used

**Description:**

`queues` table exists in schema with `maxConcurrency`, `priority`, `rateLimitPerMinute` fields, but API hardcodes `queueId` to `'default-queue-id'` and never reads queue config.

**Code Location:**

```typescript
// apps/api/src/routes/jobs.ts:85
const jobData = {
  id: crypto.randomUUID(),
  userId: request.user!.id,
  queueId: 'default-queue-id', // ⚠️ HARDCODED! Queue table ignored
  type: body.type,
  payload: body.payload,
  priority: body.priority || JobPriority.NORMAL,
  // ...
};
```

**Queue API Returns Mock Data:**

```typescript
// apps/api/src/routes/queues.ts:25-60
fastify.get('/', async (request, reply) => {
  // Mock implementation
  const mockQueues = [
    {
      id: 'default-queue-id',
      name: 'default',
      maxConcurrency: 10, // ⚠️ IGNORED BY WORKERS!
      // ...
    },
    // ...
  ];

  return reply.send({ queues: mockQueues });
});
```

**Impact:**

- **Cannot configure queues dynamically** - Must redeploy to change concurrency
- **Per-queue rate limiting impossible** - All jobs treated equally
- **Queue priorities ignored** - Cannot prioritize critical queues
- **Database schema misleading** - Implies functionality that doesn't exist

**Recommended Fix:**

1. **Read queue from database:**

```typescript
// apps/api/src/routes/jobs.ts
const queue = await getQueueByName(body.queue || 'default');
if (!queue || !queue.isActive) {
  return reply.status(400).send({
    error: 'BadRequest',
    message: `Queue '${body.queue}' not found or inactive`,
  });
}

const jobData = {
  id: crypto.randomUUID(),
  userId: request.user!.id,
  queueId: queue.id, // ✅ Use actual queue ID
  type: body.type,
  payload: body.payload,
  priority: body.priority || queue.defaultPriority || JobPriority.NORMAL,
  // ...
};
```

2. **Workers read queue config:**

```typescript
// packages/worker/src/worker.ts
async start() {
  // Fetch queue configuration from database
  const queueConfigs = await getQueuesByNames(this.config.queues);

  for (const queue of queueConfigs) {
    // Apply per-queue concurrency limits
    this.queueLimits.set(queue.name, {
      maxConcurrency: queue.maxConcurrency,
      currentLoad: 0,
    });
  }

  // ...
}
```

3. **Seed default queues:**

```typescript
// packages/database/src/seed.ts
await db.insert(queues).values([
  {
    id: crypto.randomUUID(),
    name: 'default',
    description: 'Default queue for general jobs',
    maxConcurrency: 10,
    priority: 5,
    isActive: true,
  },
  {
    id: crypto.randomUUID(),
    name: 'critical',
    description: 'High-priority critical jobs',
    maxConcurrency: 20,
    priority: 10,
    isActive: true,
  },
]);
```

**Recommendation:** **MUST fix** to align code with schema. Otherwise, remove queue table.

---

## Serious Issues (P1)

### P1-1: No Rate Limiting on Job Submission (RELIABILITY)

**Severity:** 🟠 HIGH - DoS vulnerability  
**Impact:** API can be overwhelmed, Redis/PostgreSQL exhausted

**Description:**

Rate limiter middleware exists but is **not applied** to job submission endpoints.

**Code Location:**

```typescript
// apps/api/src/routes/jobs.ts:60-150
// POST /api/v1/jobs
fastify.post<{
  Body: CreateJobRequest;
  Headers: { 'idempotency-key'?: string };
}>(
  '/',
  {
    preHandler: [
      authenticate, // ✅ Applied
      checkIdempotency, // ✅ Applied
      // ⚠️ MISSING: rateLimiter!
    ],
  },
  async (request, reply) => {
    // Job creation logic
  }
);
```

**Impact:**

- **API DoS**: Single user can submit millions of jobs
- **Database exhaustion**: Jobs table grows unbounded
- **Redis exhaustion**: Streams fill memory
- **Worker starvation**: Workers can't keep up, latency spikes

**Recommended Fix:**

```typescript
// Create job-specific rate limiter
const jobSubmissionLimiter = createRateLimiter({
  maxRequests: 100, // 100 jobs per minute per user
  windowSeconds: 60,
  keyExtractor: (request) => {
    return `job-submission:${request.user?.id || request.ip}`;
  },
});

// Apply to job submission
fastify.post(
  '/',
  {
    preHandler: [
      authenticate,
      jobSubmissionLimiter, // ✅ Add rate limiting
      checkIdempotency,
    ],
  },
  async (request, reply) => {
    // ...
  }
);
```

**Additional Recommendations:**

- **Per-queue limits**: Different limits for different queues
- **Burst allowance**: Allow short bursts (token bucket algorithm)
- **Admin bypass**: Allow admins to submit without limits (with flag)

---

### P1-2: Priority Queue Not in Redis (PERFORMANCE)

**Severity:** 🟠 HIGH - Priority inversion  
**Impact:** Critical jobs delayed behind low-priority jobs

**Description:**

Job priority is stored in PostgreSQL and used in `ORDER BY`, but Redis Streams delivers messages in FIFO order (insertion order). Workers receive jobs in wrong order.

**Code Location:**

```typescript
// packages/queue/src/consumer.ts:40-80
export async function consumeJobs(
  workerId: string,
  queueNames: string[],
  options: { batchSize?: number; blockMs?: number } = {}
): Promise<ConsumedMessage[]> {
  // ...
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
    ...ids // ⚠️ Returns FIFO order
  );
  // ...
}
```

**Scenario:**

1. Submit 1000 LOW priority jobs (enqueued to Redis)
2. Submit 1 CRITICAL priority job (enqueued after)
3. Worker consumes in FIFO order
4. CRITICAL job waits behind 1000 LOW jobs

**Impact:**

- **Priority inversion**: Critical jobs starved
- **SLA violations**: High-priority customers wait
- **Business impact**: Time-sensitive jobs delayed (payment processing, notifications)

**Recommended Fix:**

**Option 1: Separate Streams Per Priority (Simpler)**

```typescript
// Use different Redis streams per priority
const streamKey = `taskflow:stream:${queueName}:${priority}`;

// Worker consumes from multiple streams with priority
const streams = [
  ...queues.map((q) => `taskflow:stream:${q}:CRITICAL`),
  ...queues.map((q) => `taskflow:stream:${q}:HIGH`),
  ...queues.map((q) => `taskflow:stream:${q}:NORMAL`),
  ...queues.map((q) => `taskflow:stream:${q}:LOW`),
];

// XREADGROUP automatically round-robins, but consume CRITICAL first
```

**Option 2: Redis Sorted Sets (Better for priorities)**

```typescript
// Use sorted set with priority as score
await redis.zadd(
  `taskflow:queue:${queueName}`,
  priorityToScore(job.priority), // Higher score = higher priority
  JSON.stringify({ jobId, enqueuedAt })
);

// Worker pops highest priority jobs
const jobs = await redis.zpopmax(`taskflow:queue:${queueName}`, batchSize);
```

**Pros/Cons:**

- **Option 1**: Preserves consumer groups, easier migration
- **Option 2**: More flexible, true priority queue, but loses consumer group features

**Recommendation:** Implement **Option 1** for quick fix, consider **Option 2** for long-term.

---

### P1-3: No Transactional Event Publishing (RELIABILITY)

**Severity:** 🟠 HIGH - Event loss  
**Impact:** Events can be lost, inconsistent state between services

**Description:**

Job state changes in PostgreSQL are separate from Kafka event publishing. If Kafka is down or publish fails, events are lost.

**Code Location:**

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

**Called After PostgreSQL Commit:**

```typescript
// packages/worker/src/worker.ts:450
await completeJob(jobId, workerId, result); // ✅ COMMITTED
await publishJobCompleted({ jobId, ... });  // ⚠️ MAY FAIL, EVENT LOST
```

**Impact:**

- **Missing events**: Downstream services don't know job completed
- **Inconsistent views**: Dashboard shows stale data
- **Audit trail gaps**: Events missing from audit log
- **Webhook delivery failures**: External systems not notified

**Recommended Fix:**

**Option 1: Outbox Pattern (Best)**

```sql
CREATE TABLE outbox (
  id UUID PRIMARY KEY,
  event_type VARCHAR(100) NOT NULL,
  event_payload JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  published_at TIMESTAMP,
  retry_count INTEGER NOT NULL DEFAULT 0
);
```

```typescript
// In same transaction as job update
await db.transaction(async (tx) => {
  await completeJob(jobId, workerId, result, tx);

  // Store event in outbox (transactional)
  await tx.insert(outbox).values({
    id: crypto.randomUUID(),
    eventType: 'JOB_COMPLETED',
    eventPayload: { jobId, result, ... },
  });
});

// Separate background process publishes from outbox
setInterval(async () => {
  const pending = await db.select().from(outbox).where(isNull(outbox.publishedAt)).limit(100);

  for (const event of pending) {
    try {
      await publishToKafka(event);
      await db.update(outbox).set({ publishedAt: new Date() }).where(eq(outbox.id, event.id));
    } catch (error) {
      await db.update(outbox).set({ retryCount: event.retryCount + 1 }).where(eq(outbox.id, event.id));
    }
  }
}, 5000);
```

**Option 2: Change Data Capture (Ideal for large scale)**

- Use Debezium to stream PostgreSQL WAL to Kafka
- No application code needed, guaranteed consistency
- Requires infrastructure setup

**Option 3: Make Events Optional (Pragmatic)**

- Allow disabling Kafka entirely
- Use job_events table in PostgreSQL as fallback
- Consumers poll database instead of Kafka

**Recommendation:** Implement **Option 1** for production. Option 3 is acceptable if Kafka is not critical.

---

### P1-4: Idempotency Key Cleanup Not Scheduled (RELIABILITY)

**Severity:** 🟠 HIGH - Resource leak  
**Impact:** Idempotency keys table grows unbounded

**Description:**

Function `cleanupExpiredIdempotencyKeys()` exists but is never called. Expired keys (>24h) accumulate forever.

**Code Location:**

```typescript
// packages/database/src/repositories/job.repository.ts:750-760
export async function cleanupExpiredIdempotencyKeys(): Promise<number> {
  const result = await db
    .delete(schema.idempotencyKeys)
    .where(lt(schema.idempotencyKeys.expiresAt, new Date()));

  return result.rowCount || 0;
}
// ⚠️ NEVER CALLED!
```

**Impact:**

- **Table bloat**: Idempotency keys table grows to millions of rows
- **Query slowdown**: Lookups become slow despite indexes
- **Disk exhaustion**: Database runs out of space

**Recommended Fix:**

```typescript
// packages/database/src/cleanup-scheduler.ts (NEW FILE)
export class DatabaseCleaner {
  private timer: NodeJS.Timeout | null = null;

  start(intervalMs: number = 3600000) {
    // 1 hour
    this.timer = setInterval(async () => {
      try {
        // Clean up expired idempotency keys
        const idempotencyDeleted = await cleanupExpiredIdempotencyKeys();
        logger.info('Cleaned up idempotency keys', {
          count: idempotencyDeleted,
        });

        // Clean up old completed jobs (older than 30 days)
        const jobsDeleted = await deleteOldCompletedJobs(30);
        logger.info('Cleaned up old jobs', { count: jobsDeleted });

        // Clean up old job attempts (older than 90 days)
        const attemptsDeleted = await deleteOldJobAttempts(90);
        logger.info('Cleaned up job attempts', { count: attemptsDeleted });
      } catch (error) {
        logger.error('Database cleanup error', { error });
      }
    }, intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }
}
```

**Start in API or Worker:**

```typescript
const cleaner = new DatabaseCleaner();
cleaner.start(3600000); // Run every hour
```

---

### P1-5: Scheduler Not Distributed-Safe (RELIABILITY)

**Severity:** 🟠 HIGH - Race conditions, duplicate work  
**Impact:** Multiple scheduler instances cause duplicate enqueues

**Description:**

No distributed lock ensures only one scheduler instance runs. If multiple API/worker instances run schedulers, same jobs are enqueued multiple times.

**Code Location:**

```typescript
// packages/queue/src/scheduler.ts:50-100
export class JobScheduler {
  async start() {
    this.timer = setInterval(async () => {
      // ⚠️ ALL INSTANCES RUN THIS SIMULTANEOUSLY!
      const dueJobs = await getDueJobs();

      for (const job of dueJobs) {
        await enqueueJob(job.id, job.queueName);
        await updateJobStatus(job.id, 'QUEUED');
      }
    }, this.pollIntervalMs);
  }
}
```

**Scenario:**

1. Deploy 3 API replicas, each runs scheduler
2. Scheduler finds 100 due jobs
3. All 3 replicas enqueue same 100 jobs to Redis (300 messages total)
4. Workers process 300 messages for 100 jobs (3x duplicate execution)

**Impact:**

- **Duplicate execution**: Jobs run multiple times
- **Wasted resources**: Workers process duplicate work
- **Increased costs**: 3x Redis memory, 3x compute

**Recommended Fix:**

**Option 1: Distributed Lock with Redis**

```typescript
import Redlock from 'redlock';

export class JobScheduler {
  private redlock: Redlock;

  constructor(redis: Redis) {
    this.redlock = new Redlock([redis]);
  }

  async start() {
    this.timer = setInterval(async () => {
      try {
        // Acquire lock for 30 seconds (longer than scheduler cycle)
        const lock = await this.redlock.acquire(
          ['scheduler-lock'],
          30000 // 30s
        );

        try {
          // Only one instance runs this
          const dueJobs = await getDueJobs();

          for (const job of dueJobs) {
            await enqueueJob(job.id, job.queueName);
            await updateJobStatus(job.id, 'QUEUED');
          }
        } finally {
          await lock.release();
        }
      } catch (error) {
        // Lock acquisition failed, another instance is running
        logger.debug('Scheduler lock held by another instance');
      }
    }, this.pollIntervalMs);
  }
}
```

**Option 2: PostgreSQL Advisory Locks**

```typescript
async runScheduler() {
  // Try to acquire advisory lock (non-blocking)
  const [result] = await db.execute(sql`SELECT pg_try_advisory_lock(12345)`);

  if (!result.pg_try_advisory_lock) {
    // Another instance holds lock
    return;
  }

  try {
    // Run scheduler logic
    const dueJobs = await getDueJobs();
    // ...
  } finally {
    // Release lock
    await db.execute(sql`SELECT pg_advisory_unlock(12345)`);
  }
}
```

**Option 3: Single Scheduler Instance (Simplest)**

- Deploy dedicated scheduler service (separate from API/worker)
- Only one replica
- Use liveness probe to restart on failure

**Recommendation:** **Option 3** for quick fix, **Option 1** for production resilience.

---

## Performance Issues (P2)

### P2-1: No Connection Pooling Configuration (SCALABILITY)

**Severity:** 🟡 MEDIUM - Performance bottleneck  
**Impact:** Database connections exhausted under load

**Description:**

PostgreSQL connection pool has default max=10 connections, but with multiple API/worker instances, connections are exhausted quickly.

**Code Location:**

```typescript
// packages/database/src/client.ts:15-20
const queryClient = postgres(connectionString, {
  max: databaseConfig.pool.max, // Default: 10
  idle_timeout: 20,
  connect_timeout: 10,
});
```

**Problem:**

- 3 API replicas × 10 connections = 30
- 5 worker replicas × 10 connections = 50
- **Total: 80 connections**
- PostgreSQL default `max_connections` = 100
- **Headroom: 20 connections** (not enough for bursts)

**Recommended Fix:**

```typescript
// packages/config/src/database.ts
export const databaseConfig = {
  url: process.env.DATABASE_URL,
  pool: {
    max: parseInt(process.env.DB_POOL_MAX || '20', 10), // ✅ Configurable
    min: parseInt(process.env.DB_POOL_MIN || '5', 10),
    idleTimeoutMs: 20000,
    connectionTimeoutMs: 10000,
  },
};
```

**Sizing Guide:**

```
max_connections = (num_api_replicas × api_pool_size)
                + (num_worker_replicas × worker_pool_size)
                + 20 (buffer for admin, migrations, etc.)

Example:
  API: 3 replicas × 15 pool = 45
  Workers: 5 replicas × 20 pool = 100
  Buffer: 20
  Total: 165 connections

PostgreSQL config:
  max_connections = 200
```

---

### P2-2: Redis Single-Threaded Bottleneck (SCALABILITY)

**Severity:** 🟡 MEDIUM - Throughput limit  
**Impact:** Redis CPU becomes bottleneck at ~50K ops/sec

**Description:**

Single Redis instance handles all queue operations. Redis is single-threaded, so CPU-bound operations (XREADGROUP, XACK, XADD) max out one core.

**Recommended Fix:**

**Option 1: Redis Cluster (Horizontal Scaling)**

```yaml
# docker-compose.prod.yml
services:
  redis-node-1:
    image: redis:7-alpine
    command: redis-server --cluster-enabled yes --port 7000

  redis-node-2:
    image: redis:7-alpine
    command: redis-server --cluster-enabled yes --port 7001

  redis-node-3:
    image: redis:7-alpine
    command: redis-server --cluster-enabled yes --port 7002
```

**Option 2: Separate Redis Per Queue**

```typescript
// High-throughput queues get dedicated Redis instances
const redisInstances = {
  critical: new Redis({ host: 'redis-critical' }),
  default: new Redis({ host: 'redis-default' }),
  low: new Redis({ host: 'redis-low' }),
};
```

**Option 3: Redis + Valkey (Redis Fork)**

- Valkey is multi-threaded Redis fork
- Drop-in replacement, same API
- Better throughput on multi-core machines

---

### P2-3: No Backpressure Mechanism (SCALABILITY)

**Severity:** 🟡 MEDIUM - Worker overload  
**Impact:** Workers claim more work than they can process

**Description:**

Workers claim up to 10 stale messages in `claimStaleMessages()`, but don't check if they have capacity. Can overload workers.

**Code Location:**

```typescript
// packages/worker/src/worker.ts:350-380
async claimStaleJobs() {
  for (const queue of this.config.queues) {
    const staleMessages = await claimStaleMessages(
      queue,
      this.config.consumerGroup,
      this.config.workerId,
      this.config.staleThresholdMs || 60000,
      10 // ⚠️ Always claim 10, regardless of capacity
    );

    for (const message of staleMessages) {
      this.processJob(message, queue); // Fire and forget
    }
  }
}
```

**Recommended Fix:**

```typescript
async claimStaleJobs() {
  for (const queue of this.config.queues) {
    // Check available capacity
    const availableSlots = this.config.concurrency - this.activeJobs.size;

    if (availableSlots <= 0) {
      logger.debug('No capacity for stale job recovery', {
        concurrency: this.config.concurrency,
        activeJobs: this.activeJobs.size,
      });
      continue;
    }

    // Claim only what we can handle
    const staleMessages = await claimStaleMessages(
      queue,
      this.config.consumerGroup,
      this.config.workerId,
      this.config.staleThresholdMs || 60000,
      Math.min(availableSlots, 10) // ✅ Respect capacity
    );

    for (const message of staleMessages) {
      this.processJob(message, queue);
    }
  }
}
```

---

### P2-4: No Database Query Optimization (PERFORMANCE)

**Severity:** 🟡 MEDIUM - Slow queries  
**Impact:** N+1 queries, missing indexes, full table scans

**Issues Found:**

1. **Missing composite index for retry queries:**

```sql
-- Current: Separate indexes on status and scheduledAt
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_scheduled_at ON jobs(scheduled_at);

-- Needed: Composite index for scheduler query
CREATE INDEX idx_jobs_retry_scheduled
  ON jobs(status, scheduled_at)
  WHERE status = 'RETRY_SCHEDULED';
```

2. **N+1 query in job listing:**

```typescript
// apps/api/src/routes/jobs.ts:200-250
const jobs = await listJobsByUser(userId, { limit, offset });

// Each job fetches queue separately (N+1)
for (const job of jobs) {
  const queue = await getQueueById(job.queueId); // ⚠️ N+1!
  job.queueName = queue.name;
}
```

**Fix:**

```typescript
// Use LEFT JOIN
const jobs = await db
  .select({
    ...jobs,
    queueName: queues.name,
  })
  .from(jobs)
  .leftJoin(queues, eq(jobs.queueId, queues.id))
  .where(eq(jobs.userId, userId))
  .limit(limit)
  .offset(offset);
```

3. **No prepared statements:**

```typescript
// Drizzle ORM automatically uses prepared statements, but verify:
const stmt = db.select().from(jobs).where(eq(jobs.id, jobId)).prepare();
const result = await stmt.execute();
```

---

## Quality Improvements (P3)

### P3-1: Test Coverage Gaps

**Missing Tests:**

- Integration tests for race conditions (RACE-6, etc.)
- Chaos testing for worker crashes
- Load testing for throughput limits
- End-to-end tests for job lifecycle

**Recommendation:**

```typescript
// tests/integration/race-conditions.test.ts
describe('RACE-6: Worker crash before XACK', () => {
  it('should not re-execute succeeded job', async () => {
    // 1. Submit job
    const { jobId } = await submitJob({ type: 'test', payload: {} });

    // 2. Worker processes job, marks SUCCEEDED
    await worker.processJob(jobId);

    // 3. Simulate crash before XACK
    await worker.simulateCrashBeforeAck(jobId);

    // 4. Start new worker
    const worker2 = new Worker();
    await worker2.start();

    // 5. Wait for stale recovery
    await sleep(65000); // Stale threshold + buffer

    // 6. Verify job not re-executed
    const executionCount = await getJobExecutionCount(jobId);
    expect(executionCount).toBe(1); // Should be 1, not 2
  });
});
```

---

### P3-2: Metrics Gaps

**Missing Metrics:**

- Per-queue depth and processing rate
- Retry rate and backoff distribution
- Lease renewal success rate
- Idempotency cache hit rate
- Event publishing failure rate

**Recommendation:**

```typescript
// packages/observability/src/metrics.ts
export const metrics = {
  queueDepth: new prometheus.Gauge({
    name: 'taskflow_queue_depth',
    help: 'Number of pending jobs in queue',
    labelNames: ['queue', 'priority'],
  }),

  retryRate: new prometheus.Counter({
    name: 'taskflow_job_retries_total',
    help: 'Total number of job retries',
    labelNames: ['queue', 'error_type'],
  }),

  leaseRenewalFailures: new prometheus.Counter({
    name: 'taskflow_lease_renewal_failures_total',
    help: 'Failed lease renewal attempts',
  }),
};
```

---

### P3-3: Observability Gaps

**Missing:**

- Distributed tracing spans for job execution
- Correlation IDs across services
- Error categorization (retryable vs non-retryable)
- Audit log for security events

**Recommendation:**

```typescript
// Add OpenTelemetry spans
import { trace } from '@opentelemetry/api';

async executeJob(message, queue) {
  const tracer = trace.getTracer('taskflow');
  const span = tracer.startSpan('job.execute', {
    attributes: {
      'job.id': message.data.jobId,
      'job.type': job.type,
      'job.queue': queue,
      'job.attempt': message.data.attempt,
    },
  });

  try {
    await this.runHandler(job, cancellationToken);
    span.setStatus({ code: SpanStatusCode.OK });
  } catch (error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}
```

---

## Detailed Analysis

### Correctness Assessment

**Strengths:**

- ✅ Optimistic locking prevents concurrent updates
- ✅ State machine enforces valid transitions
- ✅ Idempotency at API layer with request hash
- ✅ Lease-based coordination (mostly correct)
- ✅ Graceful shutdown waits for active jobs

**Weaknesses:**

- ❌ RACE-6: Duplicate execution on crash before XACK
- ❌ Lease expiry sweeper not running (jobs stuck forever)
- ❌ Scheduler not distributed-safe (duplicate enqueues)
- ❌ Event publishing not transactional (event loss)
- ⚠️ No handler-level idempotency framework

**Verdict:** **Production-ready after fixing P0 issues**

---

### Reliability Assessment

**Strengths:**

- ✅ Comprehensive error handling and logging
- ✅ Retry logic with exponential backoff
- ✅ Dead letter queue for failed jobs
- ✅ Stale message recovery (worker crash handling)
- ✅ Heartbeat and health checks

**Weaknesses:**

- ❌ Events can be lost (not transactional)
- ❌ No circuit breaker for failing handlers
- ⚠️ Fire-and-forget event publishing
- ⚠️ No backpressure mechanism

**Verdict:** **Good reliability with some gaps**

---

### Scalability Assessment

**Strengths:**

- ✅ Horizontal scaling of workers (stateless)
- ✅ Consumer groups for distributed consumption
- ✅ Comprehensive indexes on PostgreSQL
- ✅ Redis Streams for high-throughput messaging

**Weaknesses:**

- ❌ Priority queue not in Redis (FIFO only)
- ❌ No connection pool configuration guidance
- ❌ Redis single-threaded bottleneck
- ❌ No database partitioning strategy
- ⚠️ Scheduler not horizontally scalable

**Current Limits (Estimated):**

- **Throughput**: ~10,000 jobs/min (Redis bottleneck)
- **Latency (p95)**: <500ms (no backpressure)
- **Worker scaling**: Limited by PostgreSQL connections
- **Queue depth**: Limited by Redis memory

**Verdict:** **Scales to medium workloads (10K-100K jobs/day)**

---

### Security Assessment

**Strengths:**

- ✅ SQL injection protection (parameterized queries via Drizzle)
- ✅ Input validation with Zod schemas
- ✅ Rate limiter middleware (exists but not applied)
- ✅ HTTPS support in infrastructure

**Weaknesses:**

- ❌ Hardcoded authentication credentials (test-api-key)
- ❌ No JWT validation (hardcoded token)
- ❌ No rate limiting on job endpoints
- ❌ Secrets in docker-compose (plaintext)
- ❌ No authorization checks (owner-only access weak)
- ⚠️ No audit log for sensitive operations
- ⚠️ No input size limits (DoS via large payloads)

**Verdict:** **NOT production-ready for security**

---

### Operational Complexity Assessment

**Strengths:**

- ✅ Docker Compose for easy local dev
- ✅ Terraform for AWS infrastructure
- ✅ GitHub Actions CI/CD pipelines
- ✅ Prometheus + Grafana for monitoring
- ✅ Structured logging with correlation IDs
- ✅ Health check endpoints

**Weaknesses:**

- ⚠️ No alerting rules defined
- ⚠️ No runbook for common failures
- ⚠️ No automated rollback
- ⚠️ No canary deployment strategy
- ⚠️ No cost monitoring

**Verdict:** **Good foundation, needs operational hardening**

---

## Recommendations

### Immediate Actions (Before Any Deployment)

1. **Fix P0-1 (RACE-6)**: Reverse XACK order or implement execution tokens
2. **Fix P0-2**: Remove hardcoded credentials, implement proper auth
3. **Fix P0-3**: Start lease expiry sweeper background job
4. **Fix P0-4**: Integrate queue table or remove it
5. **Fix P1-1**: Apply rate limiting to job submission

**Estimated Effort:** 3-5 days for one engineer

---

### Short-Term (Next Sprint)

1. **Fix P1-2**: Implement priority queues in Redis (separate streams)
2. **Fix P1-3**: Implement outbox pattern for events
3. **Fix P1-4**: Schedule idempotency key cleanup
4. **Fix P1-5**: Add distributed lock for scheduler
5. **Add integration tests** for race conditions
6. **Add load testing** to establish baselines

**Estimated Effort:** 1-2 weeks for one engineer

---

### Medium-Term (Next Quarter)

1. **Fix P2-1**: Add connection pool configuration guidance
2. **Fix P2-2**: Evaluate Redis Cluster or Valkey
3. **Fix P2-3**: Implement backpressure mechanism
4. **Fix P2-4**: Optimize database queries
5. **Add circuit breaker** for failing handlers
6. **Add distributed tracing** end-to-end
7. **Add comprehensive metrics** per recommendations
8. **Write operational runbooks**

**Estimated Effort:** 3-4 weeks for one engineer

---

### Long-Term (Ongoing)

1. **Database partitioning** for jobs table (by date)
2. **Multi-region deployment** for disaster recovery
3. **Chaos engineering** tests
4. **Security audit** by external firm
5. **Performance optimization** based on production data

---

## Test Coverage Assessment

### Current Coverage

**Unit Tests:** ⭐⭐⭐⭐ (Assumed good based on structure)
**Integration Tests:** ⭐⭐ (Limited, missing race condition tests)
**Load Tests:** ⭐⭐⭐⭐ (k6 tests exist)
**Chaos Tests:** ⭐ (Chaos test structure exists but minimal)
**End-to-End Tests:** ⭐ (Missing)

### Critical Gaps

1. **Race condition tests** (RACE-1 through RACE-7)
2. **Worker crash recovery tests**
3. **Lease expiry tests**
4. **Idempotency violation tests**
5. **Priority queue correctness tests**
6. **Event publishing failure tests**

### Recommended Test Suite

```typescript
// tests/integration/correctness.test.ts
describe('Correctness Tests', () => {
  test('RACE-6: No duplicate execution on crash before XACK');
  test('Lease expiry releases stuck jobs');
  test('Optimistic locking prevents concurrent updates');
  test('Idempotency key prevents duplicate jobs');
  test('Priority queue delivers in correct order');
  test('Retry logic respects max attempts');
  test('Dead letter queue captures failed jobs');
});

// tests/chaos/worker-failures.test.ts
describe('Chaos Tests', () => {
  test('Worker crash mid-execution', async () => {
    // Submit job, start worker, kill worker mid-execution
    // Verify job is recovered and completed by another worker
  });

  test('Redis connection loss', async () => {
    // Disconnect Redis mid-operation
    // Verify graceful error handling and retry
  });

  test('PostgreSQL connection loss', async () => {
    // Disconnect PostgreSQL
    // Verify reconnection and recovery
  });
});

// tests/load/throughput.test.ts
describe('Load Tests', () => {
  test('Sustained load: 1000 jobs/sec for 10 minutes');
  test('Burst load: 10000 jobs in 10 seconds');
  test('Mixed workload: CRITICAL, HIGH, NORMAL, LOW priorities');
  test('Worker scaling: Add/remove workers during load');
});
```

---

## Conclusion

TaskFlow is a **well-designed distributed task queue** with **strong architectural foundations**. The separation of concerns, lease-based coordination, and comprehensive schema demonstrate production-grade thinking.

**However, the system has critical correctness and security issues that MUST be fixed before production deployment.**

### Final Recommendation

**DO NOT DEPLOY** to production until:

1. ✅ P0-1: RACE-6 duplicate execution fixed
2. ✅ P0-2: Authentication hardcoding removed
3. ✅ P0-3: Lease expiry sweeper implemented
4. ✅ P0-4: Queue metadata integrated
5. ✅ P1-1: Rate limiting applied to job endpoints

**After these fixes, the system is suitable for:**

- Internal tools and services (low-criticality workloads)
- MVP and prototyping (with monitoring)
- Medium-scale production (10K-100K jobs/day)

**NOT suitable for (without further hardening):**

- Financial transactions (duplicate execution risk)
- Mission-critical systems (availability concerns)
- High-throughput workloads (>100K jobs/day)
- Multi-tenant SaaS (security concerns)

**With P1 and P2 fixes, the system can handle:**

- Production workloads with proper monitoring
- High-criticality use cases (with idempotent handlers)
- Large-scale deployments (100K-1M jobs/day)

### Strengths to Preserve

1. **Architecture pattern** (PostgreSQL + Redis + Kafka)
2. **Lease-based coordination**
3. **State machine validation**
4. **Comprehensive schema**
5. **Observability foundation**

### Engineering Quality

This project demonstrates:

- ✅ Strong distributed systems knowledge
- ✅ Production-grade thinking
- ✅ Comprehensive feature set
- ⚠️ Need for more rigorous testing
- ⚠️ Security awareness needs improvement

**Overall Grade: B+** (A- after P0/P1 fixes)

---

## Appendix: Priority Matrix

| ID   | Finding                      | Severity    | Effort | Impact               |
| ---- | ---------------------------- | ----------- | ------ | -------------------- |
| P0-1 | Duplicate execution (RACE-6) | 🔴 Critical | Medium | Data corruption      |
| P0-2 | Hardcoded auth               | 🔴 Critical | Low    | Security breach      |
| P0-3 | Lease expiry not running     | 🔴 Critical | Low    | Jobs stuck forever   |
| P0-4 | Queue table not integrated   | 🔴 Critical | Medium | Schema/code mismatch |
| P1-1 | No rate limiting             | 🟠 High     | Low    | DoS vulnerability    |
| P1-2 | Priority inversion           | 🟠 High     | High   | SLA violations       |
| P1-3 | Event loss                   | 🟠 High     | High   | Inconsistent state   |
| P1-4 | Idempotency cleanup          | 🟠 High     | Low    | Resource leak        |
| P1-5 | Scheduler races              | 🟠 High     | Medium | Duplicate work       |
| P2-1 | Connection pooling           | 🟡 Medium   | Low    | Scalability limit    |
| P2-2 | Redis bottleneck             | 🟡 Medium   | High   | Throughput limit     |
| P2-3 | No backpressure              | 🟡 Medium   | Medium | Worker overload      |
| P2-4 | Query optimization           | 🟡 Medium   | Medium | Slow queries         |
| P3-1 | Test coverage                | 🟢 Low      | High   | Quality assurance    |
| P3-2 | Metrics gaps                 | 🟢 Low      | Medium | Observability        |
| P3-3 | Tracing gaps                 | 🟢 Low      | Medium | Debugging            |

**Total Issues:** 16 (4 P0, 5 P1, 4 P2, 3 P3)

---

**End of Architecture Review**
