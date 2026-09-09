# Redis Streams Queue Design

## Overview

Redis Streams serves as the job delivery mechanism in Resilient TaskFlow. This document explains how we use Redis Streams from first principles to build a production-grade distributed queue.

**Important:** We do NOT use BullMQ. The goal is to demonstrate deep understanding of queue internals by building directly on Redis Streams.

## Why Redis Streams?

Redis Streams provides:
- **Consumer Groups**: Automatic load balancing across workers
- **Pending Entries**: Track unacknowledged messages
- **Message Claiming**: Recover from worker failures
- **At-least-once delivery**: Messages persist until acknowledged
- **Ordered delivery**: Within a partition/stream
- **High throughput**: Millions of messages per second

## Architecture

```
API Server                          Redis                      Workers
────────────                    ────────────                ──────────

                              ┌──────────────────┐
                              │  Stream: default │
POST /jobs                    │                  │
    │                         │  Messages:       │
    │  XADD                   │  ┌────────────┐  │
    ├──────────────────────►  │  │ job_id_1   │  │
    │                         │  ├────────────┤  │
    │                         │  │ job_id_2   │  │
    │                         │  ├────────────┤  │
    │                         │  │ job_id_3   │  │
    │                         │  └────────────┘  │
    │                         │                  │
    │                         │  Consumer Group: │
    │                         │  "workers"       │
    │                         │                  │
    │                         │  Consumers:      │
    │                         │  • worker-1      │
    │                         │  • worker-2      │
    │                         │  • worker-3      │
    │                         │                  │
    │                         │  Pending (PEL):  │
    │                         │  worker-1: [msg] │
    │                         └─────────┬────────┘
    │                                   │
    │                                   │ XREADGROUP
    │                                   │
    │                         ┌─────────▼────────┐
    │                         │     worker-1     │
    │                         │                  │
    │                         │  • Fetch job     │
    │                         │  • Process       │
    │                         │  • XACK          │
    │                         └──────────────────┘
```

## Stream Naming Convention

```
taskflow:queue:{queueName}:jobs
```

Examples:
- `taskflow:queue:default:jobs`
- `taskflow:queue:email:jobs`
- `taskflow:queue:critical:jobs`

## Consumer Group Naming

```
taskflow:workers
```

All workers join the same consumer group per queue, enabling automatic load balancing.

## Consumer Naming

```
worker:{workerId}
```

Examples:
- `worker:01HQXYZ...`
- `worker:01HQYZX...`

Each worker process has a unique ID (ULID or UUID).

## Message Format

Messages contain minimal information. Full job state lives in PostgreSQL.

```typescript
interface RedisJobMessage {
  // Message metadata
  schemaVersion: number;
  
  // Job reference
  jobId: string;
  
  // Timing
  enqueuedAt: string; // ISO 8601
  
  // Retry tracking
  attempt: number;
  
  // Optional context for optimization
  queue?: string;
  type?: string;
}
```

Example:
```json
{
  "schemaVersion": 1,
  "jobId": "01HQXYZ123456789ABCDEFGH",
  "enqueuedAt": "2026-08-23T10:30:00.000Z",
  "attempt": 1,
  "queue": "default",
  "type": "send_email"
}
```

**Rationale:**
- Minimal payload size (faster throughput)
- PostgreSQL remains source of truth
- Schema versioning enables evolution
- Worker fetches full job details from PostgreSQL

## Core Operations

### 1. Enqueue Job (Producer)

```typescript
async function enqueueJob(
  jobId: string,
  queue: string,
  attempt: number = 1
): Promise<string> {
  const streamKey = `taskflow:queue:${queue}:jobs`;
  
  const message = {
    schemaVersion: 1,
    jobId,
    enqueuedAt: new Date().toISOString(),
    attempt,
    queue,
  };
  
  // XADD returns message ID (e.g., "1629789600000-0")
  const messageId = await redis.xadd(
    streamKey,
    '*', // Auto-generate ID
    'data', JSON.stringify(message)
  );
  
  logger.info('Job enqueued', { jobId, queue, messageId, attempt });
  
  return messageId;
}
```

### 2. Create Consumer Group

Must be created once per stream:

```typescript
async function createConsumerGroup(queue: string): Promise<void> {
  const streamKey = `taskflow:queue:${queue}:jobs`;
  const groupName = 'taskflow:workers';
  
  try {
    await redis.xgroup(
      'CREATE',
      streamKey,
      groupName,
      '0', // Read from beginning
      'MKSTREAM' // Create stream if doesn't exist
    );
    
    logger.info('Consumer group created', { queue, groupName });
  } catch (error) {
    // BUSYGROUP error means group already exists (OK)
    if (!error.message.includes('BUSYGROUP')) {
      throw error;
    }
  }
}
```

### 3. Consume Jobs (Worker)

```typescript
async function consumeJobs(
  workerId: string,
  queues: string[],
  batchSize: number = 10,
  blockMs: number = 5000
): Promise<JobMessage[]> {
  const groupName = 'taskflow:workers';
  const consumerName = `worker:${workerId}`;
  
  // Build XREADGROUP command for multiple streams
  const streams = queues.map(q => `taskflow:queue:${q}:jobs`);
  const ids = queues.map(() => '>'); // '>' means new messages only
  
  const results = await redis.xreadgroup(
    'GROUP', groupName, consumerName,
    'COUNT', batchSize,
    'BLOCK', blockMs,
    'STREAMS', ...streams, ...ids
  );
  
  if (!results) {
    return []; // Timeout, no new messages
  }
  
  // Parse results
  const messages: JobMessage[] = [];
  
  for (const [stream, entries] of results) {
    for (const [messageId, fields] of entries) {
      const data = JSON.parse(fields[1]); // fields = ['data', '{...}']
      messages.push({
        messageId,
        stream,
        ...data
      });
    }
  }
  
  return messages;
}
```

### 4. Acknowledge Job (Worker)

After successful processing:

```typescript
async function acknowledgeJob(
  queue: string,
  messageId: string
): Promise<void> {
  const streamKey = `taskflow:queue:${queue}:jobs`;
  const groupName = 'taskflow:workers';
  
  const acknowledged = await redis.xack(
    streamKey,
    groupName,
    messageId
  );
  
  if (acknowledged === 0) {
    logger.warn('Message already acknowledged', { messageId, queue });
  } else {
    logger.debug('Message acknowledged', { messageId, queue });
  }
}
```

### 5. Check Pending Entries

Find messages that were delivered but not acknowledged:

```typescript
async function getPendingMessages(
  queue: string,
  consumerName?: string
): Promise<PendingMessage[]> {
  const streamKey = `taskflow:queue:${queue}:jobs`;
  const groupName = 'taskflow:workers';
  
  // XPENDING returns summary or detailed list
  const pending = await redis.xpending(
    streamKey,
    groupName,
    '-', '+', // Start and end IDs (all)
    100, // Max count
    consumerName // Optional: filter by consumer
  );
  
  return pending.map(([messageId, consumer, idleTime, deliveryCount]) => ({
    messageId,
    consumer,
    idleTimeMs: idleTime,
    deliveryCount
  }));
}
```

### 6. Claim Stale Messages

Recover messages from dead/slow workers:

```typescript
async function claimStaleMessages(
  queue: string,
  workerId: string,
  minIdleTimeMs: number = 30000 // 30 seconds
): Promise<JobMessage[]> {
  const streamKey = `taskflow:queue:${queue}:jobs`;
  const groupName = 'taskflow:workers';
  const consumerName = `worker:${workerId}`;
  
  // Find stale pending messages
  const pending = await getPendingMessages(queue);
  const staleIds = pending
    .filter(p => p.idleTimeMs > minIdleTimeMs)
    .map(p => p.messageId);
  
  if (staleIds.length === 0) {
    return [];
  }
  
  // Claim ownership
  const claimed = await redis.xclaim(
    streamKey,
    groupName,
    consumerName,
    minIdleTimeMs,
    ...staleIds,
    'JUSTID' // Return only IDs for efficiency
  );
  
  logger.info('Claimed stale messages', {
    queue,
    workerId,
    count: claimed.length
  });
  
  // Fetch full message content
  const messages = await redis.xrange(
    streamKey,
    ...claimed.map(id => [id, id]).flat()
  );
  
  return messages.map(([messageId, fields]) => ({
    messageId,
    stream: streamKey,
    ...JSON.parse(fields[1])
  }));
}
```

## Worker Lifecycle

### Startup

```typescript
async function startWorker(workerId: string, queues: string[]) {
  logger.info('Worker starting', { workerId, queues });
  
  // Ensure consumer groups exist
  for (const queue of queues) {
    await createConsumerGroup(queue);
  }
  
  // Register worker in PostgreSQL
  await registerWorker(workerId, queues);
  
  // Start consuming
  await consumeLoop(workerId, queues);
}
```

### Consume Loop

```typescript
async function consumeLoop(workerId: string, queues: string[]) {
  let shutdown = false;
  
  // Graceful shutdown handler
  process.on('SIGTERM', () => {
    logger.info('Shutdown signal received');
    shutdown = true;
  });
  
  while (!shutdown) {
    try {
      // Fetch jobs
      const messages = await consumeJobs(workerId, queues);
      
      // Process in parallel (with concurrency limit)
      await processMessages(workerId, messages);
      
      // Claim stale messages periodically
      if (Math.random() < 0.1) { // 10% of loops
        for (const queue of queues) {
          const stale = await claimStaleMessages(queue, workerId);
          await processMessages(workerId, stale);
        }
      }
      
    } catch (error) {
      logger.error('Consume loop error', { error, workerId });
      await sleep(1000); // Backoff
    }
  }
  
  logger.info('Worker shutting down', { workerId });
}
```

### Message Processing

```typescript
async function processMessages(
  workerId: string,
  messages: JobMessage[]
) {
  // Process with concurrency limit
  const concurrency = 10;
  const semaphore = new Semaphore(concurrency);
  
  await Promise.all(
    messages.map(async (msg) => {
      await semaphore.acquire();
      try {
        await processMessage(workerId, msg);
      } finally {
        semaphore.release();
      }
    })
  );
}

async function processMessage(
  workerId: string,
  message: JobMessage
) {
  const { jobId, messageId, stream, queue } = message;
  
  try {
    // 1. Fetch job from PostgreSQL
    const job = await getJob(jobId);
    
    // 2. Acquire lease
    const leaseAcquired = await acquireLease(job.id, workerId);
    
    if (!leaseAcquired) {
      // Another worker got it, or job already processed
      await acknowledgeJob(queue, messageId);
      return;
    }
    
    // 3. Execute handler
    const result = await executeJobHandler(job);
    
    // 4. Update job status
    await completeJob(job.id, workerId, result);
    
    // 5. Acknowledge message
    await acknowledgeJob(queue, messageId);
    
    // 6. Publish event
    await publishEvent('job.completed', { jobId, workerId });
    
  } catch (error) {
    logger.error('Job processing failed', { jobId, error });
    
    // Handle failure (retry logic)
    await failJob(jobId, workerId, error);
    
    // Still acknowledge (message processed, even if failed)
    await acknowledgeJob(queue, messageId);
  }
}
```

## Handling Edge Cases

### Case 1: Redis Unavailable During Enqueue

```typescript
async function enqueueWithFallback(jobId: string, queue: string) {
  try {
    await enqueueJob(jobId, queue);
    await updateJobStatus(jobId, 'QUEUED');
  } catch (error) {
    logger.error('Redis enqueue failed', { jobId, error });
    
    // Leave job in CREATED state
    // Background sweeper will retry
    await recordEnqueueFailure(jobId, error);
  }
}
```

### Case 2: Worker Crashes Before ACK

Message remains in pending entry list (PEL). After `minIdleTime`, another worker claims it via XCLAIM.

### Case 3: Duplicate Message Delivery

Worker receives same job twice (e.g., claimed after lease expired).

```typescript
async function acquireLease(jobId: string, workerId: string): Promise<boolean> {
  // Optimistic lock with lease check
  const result = await db.query(
    `UPDATE jobs 
     SET worker_id = $1, 
         lease_id = gen_random_uuid(),
         lease_expires_at = NOW() + INTERVAL '30 seconds',
         status = 'PROCESSING'
     WHERE id = $2 
       AND status = 'QUEUED'
       AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
     RETURNING id`,
    [workerId, jobId]
  );
  
  return result.rowCount > 0;
}
```

Second worker's UPDATE returns 0 rows → Lease not acquired → Skip job.

### Case 4: Message Acknowledged but DB Update Fails

```typescript
async function processMessage(workerId: string, message: JobMessage) {
  try {
    // Process job...
    await completeJob(jobId, workerId, result);
  } catch (error) {
    // DB update failed
    logger.error('Failed to update job', { jobId, error });
    
    // DO NOT ACK - message remains in PEL
    // Worker will retry or another worker will claim
    throw error;
  }
  
  // Only ACK after DB update succeeds
  await acknowledgeJob(queue, messageId);
}
```

**Rule:** Only ACK after successful DB state update.

### Case 5: Consumer Group Doesn't Exist

```typescript
async function consumeJobsWithRetry(workerId: string, queues: string[]) {
  try {
    return await consumeJobs(workerId, queues);
  } catch (error) {
    if (error.message.includes('NOGROUP')) {
      // Recreate consumer group
      for (const queue of queues) {
        await createConsumerGroup(queue);
      }
      return await consumeJobs(workerId, queues);
    }
    throw error;
  }
}
```

## Priority Queues

Redis Streams doesn't natively support priority. We use multiple streams:

```
taskflow:queue:critical:jobs  (priority 10)
taskflow:queue:high:jobs      (priority 7)
taskflow:queue:default:jobs   (priority 5)
taskflow:queue:low:jobs       (priority 1)
```

Worker reads from streams in priority order:

```typescript
async function consumePrioritized(workerId: string) {
  const queues = [
    { name: 'critical', weight: 10 },
    { name: 'high', weight: 7 },
    { name: 'default', weight: 5 },
    { name: 'low', weight: 1 }
  ];
  
  // Weighted random selection to avoid starvation
  const queue = selectQueueByWeight(queues);
  
  return await consumeJobs(workerId, [queue]);
}

function selectQueueByWeight(queues: Queue[]): string {
  const totalWeight = queues.reduce((sum, q) => sum + q.weight, 0);
  const random = Math.random() * totalWeight;
  
  let cumulative = 0;
  for (const queue of queues) {
    cumulative += queue.weight;
    if (random <= cumulative) {
      return queue.name;
    }
  }
  
  return queues[queues.length - 1].name;
}
```

**Alternative:** Always read from highest priority first, but with occasional low-priority reads to prevent starvation.

## Monitoring and Metrics

### Stream Length

```typescript
async function getQueueDepth(queue: string): Promise<number> {
  const streamKey = `taskflow:queue:${queue}:jobs`;
  return await redis.xlen(streamKey);
}
```

### Pending Entry Count

```typescript
async function getPendingCount(queue: string): Promise<number> {
  const streamKey = `taskflow:queue:${queue}:jobs`;
  const groupName = 'taskflow:workers';
  
  const info = await redis.xpending(streamKey, groupName);
  return info[0]; // [count, minId, maxId, consumers]
}
```

### Consumer Lag

```typescript
async function getConsumerInfo(queue: string) {
  const streamKey = `taskflow:queue:${queue}:jobs`;
  const groupName = 'taskflow:workers';
  
  return await redis.xinfo('CONSUMERS', streamKey, groupName);
}
```

## Stream Maintenance

### Trim Old Messages

Prevent unbounded memory growth:

```typescript
async function trimStream(queue: string, maxLength: number = 100000) {
  const streamKey = `taskflow:queue:${queue}:jobs`;
  
  await redis.xtrim(
    streamKey,
    'MAXLEN',
    '~', // Approximate trimming (more efficient)
    maxLength
  );
}
```

Run periodically (e.g., hourly).

### Delete Acknowledged Messages

```typescript
async function deleteAcknowledged(queue: string, olderThanMs: number) {
  const streamKey = `taskflow:queue:${queue}:jobs`;
  const groupName = 'taskflow:workers';
  
  // Get all messages
  const messages = await redis.xrange(streamKey, '-', '+');
  
  // Get pending messages
  const pending = await redis.xpending(streamKey, groupName);
  const pendingIds = new Set(pending.map(p => p[0]));
  
  const now = Date.now();
  const toDelete = messages
    .filter(([id]) => !pendingIds.has(id))
    .filter(([id]) => {
      const timestamp = parseInt(id.split('-')[0]);
      return now - timestamp > olderThanMs;
    })
    .map(([id]) => id);
  
  if (toDelete.length > 0) {
    await redis.xdel(streamKey, ...toDelete);
  }
}
```

## Recovery Mechanisms

### Background Sweeper

Finds jobs in PostgreSQL that should be queued but aren't in Redis:

```typescript
async function sweepOrphanedJobs() {
  // Find jobs in CREATED state for > 1 minute
  const orphaned = await db.query(`
    SELECT id, queue_id FROM jobs
    WHERE status = 'CREATED'
      AND created_at < NOW() - INTERVAL '1 minute'
    LIMIT 100
  `);
  
  for (const job of orphaned) {
    try {
      await enqueueJob(job.id, job.queue_id);
      await updateJobStatus(job.id, 'QUEUED');
      logger.info('Orphaned job recovered', { jobId: job.id });
    } catch (error) {
      logger.error('Failed to recover job', { jobId: job.id, error });
    }
  }
}

// Run every 30 seconds
setInterval(sweepOrphanedJobs, 30000);
```

### Lease Expiry Recovery

Finds jobs with expired leases:

```typescript
async function recoverExpiredLeases() {
  const expired = await db.query(`
    SELECT id, queue_id FROM jobs
    WHERE status = 'PROCESSING'
      AND lease_expires_at < NOW()
    LIMIT 100
  `);
  
  for (const job of expired) {
    logger.warn('Lease expired, re-queueing', { jobId: job.id });
    
    // Reset to QUEUED
    await db.query(`
      UPDATE jobs 
      SET status = 'QUEUED', 
          lease_id = NULL, 
          lease_expires_at = NULL,
          worker_id = NULL
      WHERE id = $1
    `, [job.id]);
    
    // Re-enqueue
    await enqueueJob(job.id, job.queue_id);
  }
}

// Run every 10 seconds
setInterval(recoverExpiredLeases, 10000);
```

## Performance Characteristics

**Throughput:**
- Single Redis instance: ~50,000-100,000 msgs/sec
- Redis Cluster: Millions of msgs/sec

**Latency:**
- Enqueue (XADD): < 1ms
- Consume (XREADGROUP): < 5ms (blocking)
- Acknowledge (XACK): < 1ms

**Memory:**
- ~1KB per message (with metadata)
- 1M messages ≈ 1GB RAM

**Scalability:**
- Horizontal: Add more worker processes
- Vertical: Scale Redis (cluster/replicas)

## Trade-offs vs Kafka

| Aspect | Redis Streams | Kafka |
|--------|---------------|-------|
| Latency | Lower (<5ms) | Higher (~10-50ms) |
| Throughput | High | Very High |
| Durability | In-memory (AOF optional) | Disk-based |
| Retention | Limited | Long-term |
| Replay | Limited | Full history |
| Complexity | Lower | Higher |
| Use Case | Job queue | Event log |

**Decision:** Redis Streams for job delivery, Kafka for event history.

## Next Steps

- [Worker Architecture](./worker-architecture.md)
- [Retry Strategy](./retry-strategy.md)
- [Failure Recovery](../failure-model/recovery.md)
