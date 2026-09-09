# @taskflow/queue

Redis Streams queue engine built from first principles (no BullMQ).

## Purpose

This package demonstrates deep understanding of distributed queue internals by implementing job delivery directly on Redis Streams using:

- **Consumer Groups**: Automatic load balancing across workers
- **Acknowledgement**: Explicit message acknowledgement
- **Pending Entry List (PEL)**: Track unacknowledged messages
- **Message Claiming**: Recover from worker failures
- **At-Least-Once Delivery**: Guaranteed message delivery

## Architecture

```
Producer                   Redis Streams              Consumers
────────                   ─────────────              ─────────

enqueueJob()  ─XADD─>  Stream: taskflow:queue:default:jobs
                            │
                            │  Consumer Group: taskflow:workers
                            │
                            ├─> worker:01 (XREADGROUP)
                            ├─> worker:02 (XREADGROUP)
                            └─> worker:03 (XREADGROUP)
                                    │
                                    ├─> Process Job
                                    └─> XACK (acknowledge)
```

## Key Concepts

### Stream Naming

```typescript
// Queue name: "default"
Stream Key:    taskflow:queue:default:jobs
Group Name:    taskflow:workers
Consumer Name: worker:{workerId}
```

### Message Format

```json
{
  "schemaVersion": 1,
  "jobId": "job_abc123",
  "enqueuedAt": "2026-08-23T10:00:00.000Z",
  "attempt": 1,
  "queue": "default"
}
```

**Important**: Redis message contains only job ID and metadata. Full job data is in PostgreSQL (source of truth).

## Usage

### Producer (Enqueue Jobs)

```typescript
import { enqueueJob, enqueueJobBatch } from '@taskflow/queue';

// Enqueue single job
const messageId = await enqueueJob('job_123', 'default', 1);

// Enqueue batch
const messageIds = await enqueueJobBatch([
  { jobId: 'job_1', queueName: 'default' },
  { jobId: 'job_2', queueName: 'email' },
]);
```

### Consumer Groups (Setup)

```typescript
import { createConsumerGroup, createConsumerGroups } from '@taskflow/queue';

// Create group for single queue
await createConsumerGroup('default');

// Create groups for multiple queues
await createConsumerGroups(['default', 'email', 'critical']);
```

### Consumer (Process Jobs)

```typescript
import { consumeJobs, acknowledgeMessage } from '@taskflow/queue';

const workerId = 'worker-01';

// Consume jobs (blocking for 5 seconds)
const messages = await consumeJobs(workerId, ['default'], {
  batchSize: 10,
  blockMs: 5000,
});

for (const message of messages) {
  try {
    // 1. Fetch full job from PostgreSQL
    const job = await getJob(message.data.jobId);
    
    // 2. Acquire lease
    const acquired = await acquireLease(job.id, workerId);
    if (!acquired) continue;
    
    // 3. Execute job
    await executeJob(job);
    
    // 4. Acknowledge Redis message
    await acknowledgeMessage(message.queue, message.messageId);
  } catch (error) {
    // Handle error (retry logic)
  }
}
```

### Stale Message Recovery

```typescript
import { claimStaleMessages } from '@taskflow/queue';

// Claim messages idle > 30 seconds
const claimed = await claimStaleMessages(
  'default',
  workerId,
  30000, // minIdleTimeMs
  10     // limit
);

// Process claimed messages (same as consumed)
for (const message of claimed) {
  // ...
}
```

## Key Operations

### Producer Operations

| Function | Description |
|----------|-------------|
| `enqueueJob(jobId, queue, attempt)` | Add job to stream |
| `enqueueJobBatch(jobs)` | Add multiple jobs (pipeline) |
| `getQueueDepth(queue)` | Get stream length |
| `trimStream(queue, maxLength)` | Trim old messages |

### Consumer Group Operations

| Function | Description |
|----------|-------------|
| `createConsumerGroup(queue)` | Create consumer group |
| `deleteConsumerGroup(queue)` | Delete consumer group |
| `getConsumerGroupInfo(queue)` | Get group stats |
| `getConsumers(queue)` | List consumers |
| `deleteConsumer(queue, consumer)` | Remove consumer |

### Consumer Operations

| Function | Description |
|----------|-------------|
| `consumeJobs(workerId, queues, opts)` | Read new messages |
| `acknowledgeMessage(queue, msgId)` | ACK single message |
| `acknowledgeMessageBatch(queue, msgIds)` | ACK multiple messages |
| `getPendingMessages(queue, workerId)` | Get unACKed messages |
| `claimStaleMessages(queue, workerId, minIdle)` | Recover from dead workers |
| `getPendingCount(queue)` | Count pending messages |

## Failure Handling

### Worker Crashes Before ACK

```
1. Worker processes job
2. Worker updates PostgreSQL: SUCCEEDED
3. Worker crashes before XACK
4. Message remains in PEL (Pending Entry List)
5. After minIdleTime, another worker claims it
6. New worker tries to acquire lease → Fails (already SUCCEEDED)
7. New worker ACKs message
```

**Result**: Job processed once, message delivered twice (at-least-once).

### Redis Crashes

```
1. Redis crashes → Streams lost (in-memory)
2. Jobs remain in PostgreSQL (status = CREATED or QUEUED)
3. Background sweeper finds jobs not in Redis
4. Re-enqueue jobs to Redis after recovery
5. Workers process jobs normally
```

**Result**: No job loss (PostgreSQL is source of truth).

### Network Partition

```
1. Worker cannot reach Redis
2. Cannot consume new messages
3. Continue processing in-flight jobs
4. Cannot ACK (messages become pending)
5. After partition heals, ACK messages
6. If ACK fails (too old), messages claimed by others
```

## Performance Characteristics

**Throughput**: ~50,000-100,000 messages/sec (single Redis)

**Latency**:
- Enqueue (XADD): <1ms
- Consume (XREADGROUP): <5ms (blocking)
- Acknowledge (XACK): <1ms

**Memory**: ~1KB per message

**Scalability**:
- Horizontal: Add more worker processes
- Vertical: Scale Redis (cluster/replicas)

## Comparison: Custom vs BullMQ

| Aspect | This Implementation | BullMQ |
|--------|---------------------|--------|
| Learning | Deep understanding | Library usage |
| Control | Full control | Limited by API |
| Features | Core queue only | Comprehensive |
| Complexity | Lower | Higher |
| Interview Value | High (demonstrates knowledge) | Medium |

## Design Decisions

### Why Not BullMQ?

See [ADR-010](../../docs/decisions/010-build-queue-from-scratch.md).

**TLDR**: Building from scratch demonstrates understanding of:
- Consumer groups
- Message acknowledgement
- Stale consumer detection
- At-least-once delivery
- Distributed coordination

### Why Redis Streams?

- Native consumer group support
- Automatic load balancing
- Pending entry tracking
- Message claiming
- High throughput

### Why Not Kafka for Jobs?

- Kafka = event log (ordered, replayable)
- Redis Streams = job queue (at-least-once, fast)
- Different use cases, different tools

## Testing

```bash
# Run tests
pnpm test

# Watch mode
pnpm test:watch

# Coverage
pnpm test:coverage
```

## Redis Commands Used

| Command | Purpose |
|---------|---------|
| `XADD` | Add message to stream |
| `XLEN` | Get stream length |
| `XTRIM` | Trim old messages |
| `XGROUP CREATE` | Create consumer group |
| `XGROUP DESTROY` | Delete consumer group |
| `XREADGROUP` | Read messages as consumer |
| `XACK` | Acknowledge messages |
| `XPENDING` | Get pending messages |
| `XCLAIM` | Claim stale messages |
| `XINFO` | Get stream/group/consumer info |

## Further Reading

- [Redis Streams Tutorial](https://redis.io/docs/data-types/streams-tutorial/)
- [Consumer Groups](https://redis.io/docs/manual/data-types/streams/#consumer-groups)
- [Architecture: Redis Streams Design](../../docs/architecture/redis-streams.md)
