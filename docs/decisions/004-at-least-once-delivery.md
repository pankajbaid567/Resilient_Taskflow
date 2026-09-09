# ADR-004: At-Least-Once Delivery Semantics

**Status**: Accepted

**Date**: 2026-08-23

**Deciders**: Architecture Team

## Context

We must define the delivery guarantee for job processing. The spectrum of guarantees:

1. **At-most-once**: Message may be lost, never duplicated
2. **At-least-once**: Message guaranteed to be delivered, may be duplicated
3. **Exactly-once**: Message delivered exactly one time, never lost or duplicated

## Decision

We will implement **at-least-once delivery** semantics with **idempotent handlers**.

Jobs are guaranteed to execute at least once but may execute multiple times. Handlers must be designed to handle duplicate executions safely.

## Rationale

### Why Not At-Most-Once?

At-most-once delivery (fire-and-forget) is unacceptable for a task queue:
- ❌ Jobs can be permanently lost
- ❌ No reliability guarantees
- ❌ Unusable for critical workflows (payments, emails, etc.)

**Verdict**: Not suitable for production task queue.

### Why Not Exactly-Once?

Exactly-once delivery in distributed systems is extremely difficult:

**Technical Challenges**:
- Requires distributed transactions (2PC, 3PC)
- Requires coordination between Redis, PostgreSQL, and handlers
- Significant performance overhead
- Complex failure recovery
- Clock synchronization issues

**Industry Reality**:
- Kafka "exactly-once" is really "effectively-once" with caveats
- AWS SQS doesn't offer exactly-once
- Most production systems use at-least-once + idempotency

**Cost-Benefit Analysis**:
- Massive engineering complexity for marginal benefit
- Performance penalty unacceptable for high-throughput system
- Can achieve same outcome with idempotency patterns

**Verdict**: Over-engineered for portfolio project, impractical for production.

### Why At-Least-Once?

At-least-once provides the right balance:

✅ **Reliability**: Jobs are never lost  
✅ **Simplicity**: Well-understood pattern  
✅ **Performance**: Minimal overhead  
✅ **Industry Standard**: Used by AWS SQS, RabbitMQ, Kafka (default)  
✅ **Practical**: Solves real-world problems without excessive complexity  

## Implementation Strategy

### 1. Guarantee Delivery

**PostgreSQL Durability**:
```sql
-- Job survives API crash
BEGIN;
INSERT INTO jobs (...) VALUES (...);
COMMIT; -- Durable write
```

**Redis Streams Persistence**:
```typescript
// Message persists until acknowledged
await redis.xadd(streamKey, '*', 'data', message);
// Message in stream until XACK
```

**Worker Acknowledgement**:
```typescript
// Only ACK after successful processing
await processJob(job);
await updateDatabase(job.id, 'SUCCEEDED');
await redis.xack(streamKey, groupName, messageId); // Finally ACK
```

### 2. Handle Duplicates

**Duplicate Detection at Job Creation**:
```typescript
// Idempotency key prevents duplicate job submission
await db.query(`
  INSERT INTO idempotency_keys (key, user_id, job_id)
  VALUES ($1, $2, $3)
  ON CONFLICT (user_id, key) DO NOTHING
  RETURNING job_id
`);
```

**Lease Mechanism Prevents Duplicate Processing**:
```typescript
// Optimistic locking
const updated = await db.query(`
  UPDATE jobs
  SET status = 'PROCESSING',
      worker_id = $1,
      lease_id = $2,
      lease_expires_at = NOW() + INTERVAL '30s'
  WHERE id = $3
    AND status = 'QUEUED'
    AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
  RETURNING id
`);

if (updated.rowCount === 0) {
  // Another worker got it, skip
  return;
}
```

**Idempotent Handlers**:
```typescript
// Email handler checks if already sent
async function sendEmailHandler(payload: EmailPayload) {
  const { to, subject, body, idempotencyKey } = payload;
  
  // Check if already sent
  const sent = await db.query(
    'SELECT id FROM sent_emails WHERE idempotency_key = $1',
    [idempotencyKey]
  );
  
  if (sent.rowCount > 0) {
    return { status: 'already_sent' }; // Idempotent
  }
  
  // Send email
  await emailService.send({ to, subject, body });
  
  // Record sent
  await db.query(
    'INSERT INTO sent_emails (idempotency_key, to, sent_at) VALUES ($1, $2, NOW())',
    [idempotencyKey, to]
  );
  
  return { status: 'sent' };
}
```

### 3. Document Idempotency Requirements

Every handler must document its idempotency strategy:

```typescript
/**
 * Payment Processing Handler
 * 
 * Idempotency Strategy:
 * - Uses payment_id as idempotency key
 * - Checks payment_transactions table before processing
 * - Uses database UNIQUE constraint to prevent duplicate charges
 * - Safe to retry on failure
 * 
 * Retriable Errors:
 * - Network timeout
 * - Payment gateway rate limit
 * - Temporary gateway unavailable
 * 
 * Non-Retriable Errors:
 * - Invalid credit card
 * - Insufficient funds
 * - Account closed
 */
async function processPaymentHandler(payload: PaymentPayload) {
  // Implementation...
}
```

## Consequences

### Positive

✅ **Reliability**: No job loss under normal failures  
✅ **Simplicity**: Straightforward implementation  
✅ **Performance**: Minimal overhead  
✅ **Scalability**: Supports high throughput  
✅ **Industry Standard**: Well-understood pattern  
✅ **Debuggability**: Clear semantics for troubleshooting  

### Negative

❌ **Handler Complexity**: Handlers must be idempotent  
❌ **Duplicate Work**: May execute same job multiple times  
❌ **Cost**: Duplicate executions waste resources  

### Mitigation

**For Handler Complexity**:
- Provide idempotency patterns library
- Document common patterns (database check, unique constraints)
- Code review ensures handlers are idempotent
- Testing framework validates idempotency

**For Duplicate Work**:
- Lease mechanism minimizes duplicates under normal operation
- Fast lease renewal (every 10s) keeps leases fresh
- Efficient idempotency checks (indexed database lookups)

**For Cost**:
- Duplicates are rare in practice (only on failures)
- Cost of duplicates << cost of lost jobs
- Acceptable trade-off for reliability

## Testing Strategy

### Unit Tests

```typescript
describe('At-Least-Once Delivery', () => {
  it('delivers job at least once', async () => {
    const job = await createJob();
    
    // Simulate worker crash before ACK
    const worker = await startWorker();
    await waitUntil(() => job.status === 'PROCESSING');
    await worker.kill();
    
    // Job should be redelivered
    const worker2 = await startWorker();
    await waitUntil(() => job.status === 'SUCCEEDED');
    
    // Execution count may be > 1, but >= 1
    const attempts = await getJobAttempts(job.id);
    expect(attempts.length).toBeGreaterThanOrEqual(1);
  });
  
  it('prevents duplicate processing with lease', async () => {
    const job = await createJob();
    
    // Two workers try to process simultaneously
    const [result1, result2] = await Promise.all([
      processJob(job.id, 'worker-1'),
      processJob(job.id, 'worker-2')
    ]);
    
    // Only one should succeed
    const succeeded = [result1, result2].filter(r => r.acquired);
    expect(succeeded).toHaveLength(1);
  });
});
```

### Integration Tests

```typescript
it('handles duplicate submission with idempotency key', async () => {
  const idempotencyKey = 'unique-key-123';
  
  // Submit same job twice
  const job1 = await submitJob({ 
    type: 'test', 
    idempotencyKey 
  });
  
  const job2 = await submitJob({ 
    type: 'test', 
    idempotencyKey 
  });
  
  // Should return same job
  expect(job1.id).toBe(job2.id);
});
```

### Chaos Tests

```typescript
it('delivers job despite multiple failures', async () => {
  const job = await createJob();
  
  // Worker processes, crashes, repeat
  for (let i = 0; i < 3; i++) {
    const worker = await startWorker();
    await sleep(5000); // Let it start processing
    await worker.kill();
  }
  
  // Final worker completes
  const finalWorker = await startWorker();
  await waitUntil(() => getJob(job.id).status === 'SUCCEEDED');
  
  // Job should eventually succeed
  const result = await getJob(job.id);
  expect(result.status).toBe('SUCCEEDED');
  
  // May have multiple attempts, but completed at least once
  const attempts = await getJobAttempts(job.id);
  expect(attempts.length).toBeGreaterThanOrEqual(1);
});
```

## Handler Patterns

### Pattern 1: Database Check

```typescript
async function handler(payload) {
  const existing = await db.query(
    'SELECT id FROM results WHERE job_id = $1',
    [payload.jobId]
  );
  
  if (existing.rowCount > 0) {
    return existing.rows[0]; // Already done
  }
  
  // Do work...
  const result = await doWork(payload);
  
  // Save result
  await db.query(
    'INSERT INTO results (job_id, data) VALUES ($1, $2)',
    [payload.jobId, result]
  );
  
  return result;
}
```

### Pattern 2: Unique Constraint

```typescript
async function handler(payload) {
  try {
    await db.query(
      'INSERT INTO processed_jobs (job_id, processed_at) VALUES ($1, NOW())',
      [payload.jobId]
    );
  } catch (error) {
    if (error.code === '23505') { // Unique violation
      return { status: 'already_processed' };
    }
    throw error;
  }
  
  // Do work...
  return await doWork(payload);
}
```

### Pattern 3: External Service Idempotency

```typescript
async function handler(payload) {
  // Use external service's idempotency mechanism
  await externalAPI.createResource({
    ...payload,
    idempotencyKey: payload.jobId // Service handles duplicates
  });
}
```

## Documentation Requirements

Every job type must document:
1. Idempotency strategy
2. What makes it safe to retry
3. What state is persisted where
4. External services used and their idempotency guarantees

## Related Decisions

- [ADR-001: Use PostgreSQL as Source of Truth](./001-postgresql-source-of-truth.md) - Enables durable delivery
- [ADR-005: Lease-Based Worker Coordination](./005-lease-based-coordination.md) - Minimizes duplicates
- [ADR-002: Use Redis Streams for Job Delivery](./002-redis-streams-for-delivery.md) - Delivery mechanism

## References

- [AWS SQS: At-Least-Once Delivery](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues.html#standard-queues-at-least-once-delivery)
- [Kafka: Delivery Semantics](https://kafka.apache.org/documentation/#semantics)
- [Idempotence Patterns](https://microservices.io/patterns/communication-style/idempotent-consumer.html)
- [Exactly-Once is Impossible](https://bravenewgeek.com/you-cannot-have-exactly-once-delivery/)
