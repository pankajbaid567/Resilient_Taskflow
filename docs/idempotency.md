# Idempotency in TaskFlow

## Overview

Idempotency ensures that submitting the same job multiple times has the same effect as submitting it once. This is critical for building reliable distributed systems.

## Why Idempotency Matters

### Problem Scenarios

**1. Network Timeout Retries**
```
Client → API: Submit job
API → Client: [timeout, no response]
Client thinks: "Did the job get created? Better retry..."
Client → API: Submit job again (duplicate!)
```

**2. Duplicate API Calls**
```
User clicks "Submit" button twice
→ Two identical requests sent
→ Two duplicate jobs created
```

**3. Message Queue Retries**
```
Worker processes job
Worker crashes before acknowledging
→ Job redelivered to another worker
→ Job processed twice (duplicate execution)
```

### Without Idempotency
- Duplicate jobs flood the system
- Same email sent multiple times
- Same charge processed twice
- Wasted resources on duplicate work

### With Idempotency
- ✅ Same request = same result
- ✅ Safe to retry on network errors
- ✅ No duplicate processing
- ✅ Predictable behavior

## Implementation

### Database Schema

```sql
CREATE TABLE idempotency_keys (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  job_id UUID NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  
  UNIQUE(user_id, idempotency_key)
);

CREATE INDEX idx_idempotency_keys_expires 
  ON idempotency_keys(expires_at);
```

**Key Fields:**
- `idempotency_key`: Client-provided unique key
- `job_id`: Associated job ID
- `request_hash`: SHA-256 hash of request for replay detection
- `expires_at`: TTL for key (24 hours default)

### API Usage

#### Submit Job with Idempotency Key

```bash
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test-api-key" \
  -H "Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
  -d '{
    "type": "send-email",
    "payload": {
      "to": "user@example.com",
      "subject": "Welcome"
    }
  }'

# Response: 201 Created
{
  "id": "job_abc123",
  "status": "QUEUED",
  ...
}

# Header: Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
```

#### Retry Same Request

```bash
# Same idempotency key, same request
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test-api-key" \
  -H "Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
  -d '{
    "type": "send-email",
    "payload": {
      "to": "user@example.com",
      "subject": "Welcome"
    }
  }'

# Response: 200 OK (not 201!)
{
  "id": "job_abc123",  # Same job ID
  "status": "COMPLETED",
  ...
}

# Headers:
# Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
# X-Idempotent-Replay: true
```

**Behavior:**
- First request: Job created, returns 201
- Subsequent requests: Existing job returned, returns 200
- `X-Idempotent-Replay: true` header indicates replay

## Request Hash for Conflict Detection

### Purpose

Prevents accidental key reuse with different requests.

### How It Works

```typescript
// Request 1
POST /api/v1/jobs
Idempotency-Key: my-key
Body: { type: "send-email", payload: { to: "user1@example.com" } }
Hash: a1b2c3...

// Request 2 (CONFLICT!)
POST /api/v1/jobs
Idempotency-Key: my-key  # Same key
Body: { type: "send-email", payload: { to: "user2@example.com" } }
Hash: d4e5f6...  # Different hash

// Response: 409 Conflict
{
  "error": "Idempotency Key Conflict",
  "message": "Idempotency key already used with different request"
}
```

**Hash Includes:**
- HTTP method
- URL path
- Request body

### Implementation

```typescript
function calculateRequestHash(request: FastifyRequest): string {
  const hash = crypto.createHash('sha256');
  hash.update(request.method);
  hash.update(request.url);
  hash.update(JSON.stringify(request.body));
  return hash.digest('hex');
}
```

## Key Format

### Rules

- Length: 1-255 characters
- Recommended: UUIDv4 or similar
- Must be unique per request
- Scoped to user (different users can use same key)

### Good Examples

```javascript
// UUIDv4
"550e8400-e29b-41d4-a716-446655440000"

// Timestamp + random
"20240115-abc123"

// Request-based
`${userId}-${timestamp}-${randomBytes}`

// Client request ID
request.headers['x-request-id']
```

### Bad Examples

```javascript
// Too predictable
"1", "2", "3"

// Not unique enough
Date.now().toString()

// Too short
"a"

// Too long (>255 chars)
"a".repeat(300)
```

## Expiration

### Default TTL

24 hours (86400000 ms)

### Why Expiration?

- Prevents unbounded growth of idempotency table
- Keys eventually freed for reuse
- Balances safety vs. storage

### Cleanup

```typescript
// Periodic cleanup job
setInterval(async () => {
  const deleted = await cleanupExpiredIdempotencyKeys();
  logger.info('Cleaned up expired idempotency keys', { deleted });
}, 3600000); // Every hour
```

## Transaction Safety

### Atomic Job Creation

```typescript
export async function createJobWithIdempotency(
  jobData: NewJob,
  userId: string,
  idempotencyKey: string,
  requestHash: string
): Promise<Job> {
  return await db.transaction(async (tx) => {
    // 1. Check if key exists
    const existing = await tx.select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.idempotencyKey, idempotencyKey));

    if (existing) {
      // Return existing job
      return getJobById(existing.jobId);
    }

    // 2. Create job
    const job = await tx.insert(jobs).values(jobData).returning();

    // 3. Create idempotency key
    await tx.insert(idempotencyKeys).values({
      userId,
      idempotencyKey,
      jobId: job.id,
      requestHash,
      expiresAt: new Date(Date.now() + 86400000),
    });

    return job;
  });
}
```

**ACID Guarantees:**
- ✅ Atomic: All-or-nothing
- ✅ Consistent: Unique constraint prevents duplicates
- ✅ Isolated: Concurrent requests don't interfere
- ✅ Durable: Committed to disk

### Race Condition Handling

```
Time    Request A              Request B
----    ---------              ---------
t0      BEGIN TRANSACTION      
t1      Check key (not found)  
t2                             BEGIN TRANSACTION
t3      Insert job             
t4                             Check key (not found)
t5      Insert idempotency key 
t6                             Insert job
t7      COMMIT                 
t8                             Insert idempotency key ← FAILS!
t9                             ROLLBACK
t10                            Retry → finds existing job
```

**Database ensures:**
- UNIQUE constraint on (user_id, idempotency_key)
- Second insert fails
- Transaction rolled back
- Retry succeeds

## Client Best Practices

### Generate Unique Keys

```typescript
import { v4 as uuidv4 } from 'uuid';

async function submitJob(jobData) {
  const idempotencyKey = uuidv4();
  
  return fetch('/api/v1/jobs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(jobData),
  });
}
```

### Retry on Network Errors

```typescript
async function submitJobWithRetry(jobData, maxRetries = 3) {
  const idempotencyKey = uuidv4();
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch('/api/v1/jobs', {
        method: 'POST',
        headers: {
          'Idempotency-Key': idempotencyKey,  // Same key!
          ...
        },
        body: JSON.stringify(jobData),
      });
      
      if (response.ok) {
        return await response.json();
      }
      
      // Only retry on network errors, not 4xx
      if (response.status >= 400 && response.status < 500) {
        throw new Error(`Client error: ${response.status}`);
      }
    } catch (error) {
      if (attempt === maxRetries - 1) throw error;
      await sleep(1000 * Math.pow(2, attempt));
    }
  }
}
```

### Check Replay Header

```typescript
const response = await submitJob(jobData);

if (response.headers.get('X-Idempotent-Replay') === 'true') {
  console.log('Job already submitted, returning cached result');
}
```

## Server Behavior

### First Request (201 Created)

```
POST /api/v1/jobs
Idempotency-Key: abc-123

1. Extract idempotency key
2. Check if key exists → NO
3. Begin transaction
4. Create job
5. Create idempotency key record
6. Commit transaction
7. Enqueue to Redis
8. Return 201 Created

Response Headers:
- Idempotency-Key: abc-123
```

### Duplicate Request (200 OK)

```
POST /api/v1/jobs
Idempotency-Key: abc-123

1. Extract idempotency key
2. Check if key exists → YES
3. Retrieve existing job
4. Return 200 OK (not 201!)

Response Headers:
- Idempotency-Key: abc-123
- X-Idempotent-Replay: true
```

### Different Request Body (409 Conflict)

```
POST /api/v1/jobs
Idempotency-Key: abc-123
Body: { different payload }

1. Extract idempotency key
2. Check if key exists → YES
3. Compare request hashes → MISMATCH
4. Return 409 Conflict

Response:
{
  "error": "Idempotency Key Conflict",
  "message": "Key already used with different request"
}
```

## Monitoring

### Metrics to Track

```typescript
// Idempotency replay rate
idempotent_replay_total{user_id, endpoint}

// Key conflicts
idempotent_conflict_total{user_id, endpoint}

// Expired keys cleaned up
idempotent_cleanup_total{timestamp}

// Active keys count
idempotent_keys_active{status}
```

### Alerting

**High Replay Rate**
```
idempotent_replay_rate > 0.3
→ Alert: >30% of requests are replays
→ Possible: Client retrying too aggressively
```

**High Conflict Rate**
```
idempotent_conflict_rate > 0.01
→ Alert: >1% key conflicts
→ Possible: Client bug (key reuse)
```

## Testing

### Unit Tests

```typescript
describe('Idempotency', () => {
  it('should return existing job on duplicate key', async () => {
    const key = 'test-key';
    
    // First request
    const job1 = await createJobWithIdempotency(
      jobData, userId, key, hash
    );
    
    // Second request (duplicate)
    const job2 = await createJobWithIdempotency(
      jobData, userId, key, hash
    );
    
    expect(job1.id).toBe(job2.id);
  });
  
  it('should reject different request with same key', async () => {
    const key = 'test-key';
    
    await createJobWithIdempotency(
      jobData1, userId, key, hash1
    );
    
    await expect(
      createJobWithIdempotency(
        jobData2, userId, key, hash2  // Different hash
      )
    ).rejects.toThrow('Idempotency key conflict');
  });
});
```

### Integration Tests

```typescript
it('should handle concurrent duplicate submissions', async () => {
  const key = 'concurrent-key';
  
  // Submit 10 concurrent requests with same key
  const promises = Array(10).fill(null).map(() =>
    submitJob({ idempotencyKey: key, ...jobData })
  );
  
  const results = await Promise.all(promises);
  
  // All should return same job ID
  const jobIds = results.map(r => r.id);
  expect(new Set(jobIds).size).toBe(1);
});
```

## Performance Considerations

### Database Impact

**Query:** Check if key exists
```sql
SELECT * FROM idempotency_keys
WHERE user_id = ? AND idempotency_key = ?
AND expires_at > NOW();
```

**Index:** `UNIQUE(user_id, idempotency_key)`
- O(log n) lookup
- Minimal overhead

### Memory Impact

**Storage per key:** ~200 bytes
- UUID (36 bytes)
- Job ID (36 bytes)
- Hash (64 bytes)
- Timestamps (16 bytes)
- Metadata (~50 bytes)

**1M active keys:** ~200 MB
- Acceptable for most systems

### Cleanup Strategy

```typescript
// Option 1: Periodic cleanup (hourly)
setInterval(cleanupExpiredKeys, 3600000);

// Option 2: Lazy cleanup (on read)
if (key.expiresAt < now) {
  await deleteKey(key);
  return null;
}

// Option 3: TTL in PostgreSQL (automatic)
CREATE INDEX idx_expires ON idempotency_keys(expires_at)
WHERE expires_at IS NOT NULL;
```

## Comparison with Other Approaches

### Alternative 1: Application-Level Deduplication

```typescript
const cache = new Map<string, JobId>();

function submitJob(key, data) {
  if (cache.has(key)) {
    return cache.get(key);
  }
  
  const jobId = createJob(data);
  cache.set(key, jobId);
  return jobId;
}
```

**Problems:**
- ❌ Lost on restart
- ❌ Not shared across instances
- ❌ No persistence
- ❌ Race conditions

### Alternative 2: Redis-Based

```typescript
const key = `idempotency:${idempotencyKey}`;
const jobId = await redis.get(key);

if (jobId) {
  return getJob(jobId);
}

const newJobId = await createJob(data);
await redis.setex(key, 86400, newJobId);
```

**Trade-offs:**
- ✅ Fast lookups
- ✅ Automatic expiration (TTL)
- ❌ Eventual consistency
- ❌ Lost on Redis failure
- ❌ Not ACID with job creation

### Our Approach: PostgreSQL

**Benefits:**
- ✅ ACID guarantees
- ✅ Atomic with job creation
- ✅ Durable storage
- ✅ Unique constraints prevent duplicates
- ✅ Survives restarts
- ⚠️ Slightly slower than Redis

**Best of both worlds:**
- Use PostgreSQL for idempotency keys (durability)
- Use Redis for job delivery (performance)

## Production Checklist

- [x] Unique index on (user_id, idempotency_key)
- [x] Index on expires_at for cleanup
- [x] Transaction wrapping job + key creation
- [x] Request hash validation
- [x] Proper HTTP status codes (200 vs 201)
- [x] X-Idempotent-Replay header
- [x] Key expiration (24h)
- [ ] Periodic cleanup job
- [ ] Monitoring and alerting
- [ ] Load testing with concurrent duplicates
- [ ] Documentation for clients

## References

- [RFC: Idempotency-Key HTTP Header](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header)
- [Stripe's Idempotency Design](https://stripe.com/blog/idempotency)
- [AWS API Gateway Idempotency](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-idempotency.html)

## License

MIT
