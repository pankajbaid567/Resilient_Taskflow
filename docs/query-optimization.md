# Database Query Optimization Guide

This document covers database query optimization strategies, index usage, and best practices for Resilient TaskFlow.

## Table of Contents

- [Overview](#overview)
- [Index Strategy](#index-strategy)
- [Query Patterns](#query-patterns)
- [Optimization Techniques](#optimization-techniques)
- [Monitoring](#monitoring)
- [Troubleshooting](#troubleshooting)

## Overview

### Performance Goals

- P95 query latency < 10ms
- P99 query latency < 50ms
- Index hit rate > 99%
- Connection pool utilization < 80%

### Database Configuration

```sql
-- Recommended PostgreSQL settings for production
max_connections = 200
shared_buffers = 256MB
effective_cache_size = 1GB
maintenance_work_mem = 64MB
checkpoint_completion_target = 0.9
wal_buffers = 16MB
default_statistics_target = 100
random_page_cost = 1.1  -- For SSD
effective_io_concurrency = 200
work_mem = 4MB
min_wal_size = 1GB
max_wal_size = 4GB
```

## Index Strategy

### Primary Indexes

All tables have primary key indexes (UUID). These support:

- Fast row lookups by ID
- Foreign key constraints
- Join operations

### Secondary Indexes

#### Jobs Table

**1. Worker Polling (Most Critical)**

```sql
CREATE INDEX idx_jobs_worker_polling
ON jobs (queue_id, status, priority DESC, created_at ASC)
INCLUDE (id, type, payload, max_attempts, timeout_ms, scheduled_at)
WHERE status = 'QUEUED';
```

**Why**: This is the hottest query path. Workers constantly poll for jobs.

**Query**:

```sql
SELECT id, type, payload, max_attempts, timeout_ms, scheduled_at
FROM jobs
WHERE queue_id = $1 AND status = 'QUEUED'
ORDER BY priority DESC, created_at ASC
LIMIT 10;
```

**Optimization**: Covering index includes all columns needed, avoiding heap lookup.

**2. Stale Lease Detection**

```sql
CREATE INDEX idx_jobs_stale_leases
ON jobs (lease_expires_at, status)
WHERE lease_expires_at IS NOT NULL AND status = 'PROCESSING';
```

**Why**: Worker recovery scans for expired leases every 30s.

**Query**:

```sql
SELECT id, worker_id, lease_id
FROM jobs
WHERE lease_expires_at < NOW() AND status = 'PROCESSING';
```

**Optimization**: Partial index only on processing jobs with leases.

**3. Scheduled Job Pickup**

```sql
CREATE INDEX idx_jobs_ready_to_schedule
ON jobs (scheduled_at, status)
WHERE status = 'CREATED' AND scheduled_at IS NOT NULL;
```

**Why**: Scheduler polls for jobs ready to execute.

**Query**:

```sql
SELECT id FROM jobs
WHERE status = 'CREATED' AND scheduled_at <= NOW()
LIMIT 100;
```

**Optimization**: Partial index only on scheduled jobs.

**4. User Job Listing**

```sql
CREATE INDEX idx_jobs_user_status_created
ON jobs (user_id, status, created_at DESC);
```

**Why**: Dashboard queries filter by user and status.

**Query**:

```sql
SELECT * FROM jobs
WHERE user_id = $1 AND status = $2
ORDER BY created_at DESC
LIMIT 20;
```

**5. Failed Jobs (DLQ)**

```sql
CREATE INDEX idx_jobs_failed_recent
ON jobs (status, failed_at DESC)
WHERE status IN ('FAILED', 'DEAD_LETTERED');
```

**Why**: DLQ interface needs fast failed job retrieval.

#### Workers Table

**1. Stale Worker Detection**

```sql
CREATE INDEX idx_workers_stale
ON workers (last_heartbeat_at, status)
WHERE status = 'ACTIVE';
```

**Why**: Health check service monitors worker heartbeats.

**Query**:

```sql
SELECT id, worker_name, last_heartbeat_at
FROM workers
WHERE last_heartbeat_at < NOW() - INTERVAL '1 minute'
  AND status = 'ACTIVE';
```

**2. Active Workers by Queue**

```sql
CREATE INDEX idx_workers_active_queues
ON workers USING GIN (queues)
WHERE status = 'ACTIVE';
```

**Why**: Queue stats need active worker count per queue.

**Query**:

```sql
SELECT COUNT(*) FROM workers
WHERE status = 'ACTIVE' AND 'email' = ANY(queues);
```

**Optimization**: GIN index supports array containment queries.

#### Job Attempts Table

**1. Failed Attempts per Job**

```sql
CREATE INDEX idx_job_attempts_job_failures
ON job_attempts (job_id, status, attempt_number DESC)
WHERE status = 'FAILED';
```

**Why**: Error analysis needs failed attempt history.

**2. Slow Job Detection**

```sql
CREATE INDEX idx_job_attempts_slow
ON job_attempts (duration_ms DESC)
WHERE duration_ms > 5000;
```

**Why**: Performance monitoring identifies slow jobs.

**Query**:

```sql
SELECT job_id, duration_ms, started_at
FROM job_attempts
WHERE duration_ms > 5000
ORDER BY duration_ms DESC
LIMIT 100;
```

#### Idempotency Keys Table

**1. Active Keys Lookup**

```sql
CREATE INDEX idx_idempotency_keys_active
ON idempotency_keys (user_id, idempotency_key)
WHERE expires_at > NOW();
```

**Why**: Every job submission checks idempotency.

**Query**:

```sql
SELECT job_id FROM idempotency_keys
WHERE user_id = $1 AND idempotency_key = $2 AND expires_at > NOW();
```

**Optimization**: Partial index excludes expired keys.

### Index Maintenance

**Automatic Vacuuming**:

```sql
ALTER TABLE jobs SET (autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE job_attempts SET (autovacuum_vacuum_scale_factor = 0.1);
```

**Manual Vacuum** (after bulk operations):

```sql
VACUUM ANALYZE jobs;
VACUUM ANALYZE workers;
VACUUM ANALYZE job_attempts;
```

**Reindex** (if indexes become bloated):

```sql
REINDEX TABLE CONCURRENTLY jobs;
```

## Query Patterns

### Efficient Patterns

#### ✅ Use Prepared Statements

```typescript
// Good: Prepared statement with parameters
const result = await db
  .select()
  .from(jobs)
  .where(and(eq(jobs.queueId, queueId), eq(jobs.status, 'QUEUED')))
  .orderBy(desc(jobs.priority), asc(jobs.createdAt))
  .limit(10);
```

**Why**: Prepared statements are cached and prevent SQL injection.

#### ✅ Use Covering Indexes

```typescript
// Good: Only select columns in covering index
const result = await db
  .select({
    id: jobs.id,
    type: jobs.type,
    payload: jobs.payload,
  })
  .from(jobs)
  .where(/* ... */);
```

**Why**: Avoids heap lookup if all columns are in index.

#### ✅ Use Batch Operations

```typescript
// Good: Single query for multiple rows
await db
  .insert(jobAttempts)
  .values([
    { jobId: 'job1' /* ... */ },
    { jobId: 'job2' /* ... */ },
    { jobId: 'job3' /* ... */ },
  ]);
```

**Why**: Reduces round-trip time (RTT).

#### ✅ Use EXISTS for Existence Checks

```typescript
// Good: Use EXISTS
const exists = await db
  .select({ count: sql`1` })
  .from(jobs)
  .where(eq(jobs.id, jobId))
  .limit(1);
```

**Why**: EXISTS stops at first match (faster than COUNT).

### Inefficient Patterns

#### ❌ Avoid SELECT *

```typescript
// Bad: Fetches all columns
const result = await db.select().from(jobs);

// Good: Select only needed columns
const result = await db.select({ id: jobs.id, status: jobs.status }).from(jobs);
```

**Why**: Fetching unused columns wastes memory and I/O.

#### ❌ Avoid N+1 Queries

```typescript
// Bad: N+1 queries
for (const job of jobs) {
  const attempts = await db
    .select()
    .from(jobAttempts)
    .where(eq(jobAttempts.jobId, job.id));
}

// Good: Single query with JOIN
const result = await db
  .select()
  .from(jobs)
  .leftJoin(jobAttempts, eq(jobAttempts.jobId, jobs.id));
```

**Why**: N+1 creates network overhead (N RTTs).

#### ❌ Avoid OR in WHERE

```typescript
// Bad: OR prevents index usage
const result = await db
  .select()
  .from(jobs)
  .where(or(eq(jobs.status, 'QUEUED'), eq(jobs.status, 'PROCESSING')));

// Good: Use IN
const result = await db
  .select()
  .from(jobs)
  .where(inArray(jobs.status, ['QUEUED', 'PROCESSING']));
```

**Why**: IN can use index, OR often can't.

#### ❌ Avoid LIKE with Leading Wildcard

```typescript
// Bad: Leading wildcard prevents index usage
const result = await db.select().from(jobs).where(like(jobs.type, '%email%'));

// Good: Use full-text search or exact match
const result = await db.select().from(jobs).where(eq(jobs.type, 'email-send'));
```

**Why**: Leading wildcard requires full table scan.

#### ❌ Avoid Function Calls on Indexed Columns

```typescript
// Bad: Function prevents index usage
const result = await db
  .select()
  .from(jobs)
  .where(sql`LOWER(${jobs.type}) = 'email'`);

// Good: Store normalized values
const result = await db.select().from(jobs).where(eq(jobs.type, 'email'));
```

**Why**: Index can't be used on function result.

## Optimization Techniques

### 1. Use Connection Pooling

```typescript
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,

  // Connection pool settings
  max: 20, // Maximum connections
  min: 5, // Minimum connections (keep-alive)
  idleTimeoutMillis: 30000, // Close idle connections after 30s
  connectionTimeoutMillis: 2000, // Wait max 2s for connection

  // Statement timeout
  statement_timeout: 10000, // Kill queries after 10s
});

const db = drizzle(pool);
```

### 2. Use Transactions for Consistency

```typescript
// Good: Use transaction for multiple related operations
await db.transaction(async (tx) => {
  // Create job
  const job = await tx.insert(jobs).values(/* ... */).returning();

  // Record idempotency key
  await tx.insert(idempotencyKeys).values(/* ... */);

  // Create initial attempt
  await tx.insert(jobAttempts).values(/* ... */);
});
```

**Why**: Ensures atomicity and consistency.

### 3. Use Optimistic Locking

```typescript
// Update with version check (optimistic locking)
const result = await db
  .update(jobs)
  .set({
    status: 'PROCESSING',
    version: sql`${jobs.version} + 1`,
  })
  .where(
    and(
      eq(jobs.id, jobId),
      eq(jobs.version, currentVersion) // Version check
    )
  )
  .returning();

if (result.length === 0) {
  throw new Error('Job was modified by another process');
}
```

**Why**: Prevents lost updates without row locking.

### 4. Use Pagination

```typescript
// Good: Use limit and offset for pagination
async function listJobs(page: number = 1, pageSize: number = 20) {
  const offset = (page - 1) * pageSize;

  return await db
    .select()
    .from(jobs)
    .orderBy(desc(jobs.createdAt))
    .limit(pageSize)
    .offset(offset);
}
```

**Why**: Prevents memory exhaustion on large result sets.

### 5. Use Materialized Views for Complex Aggregations

```sql
-- Create materialized view for queue statistics
CREATE MATERIALIZED VIEW queue_stats AS
SELECT
  q.id AS queue_id,
  q.name AS queue_name,
  COUNT(*) FILTER (WHERE j.status = 'QUEUED') AS queued_count,
  COUNT(*) FILTER (WHERE j.status = 'PROCESSING') AS processing_count,
  COUNT(*) FILTER (WHERE j.status = 'FAILED') AS failed_count,
  AVG(ja.duration_ms) FILTER (WHERE ja.status = 'SUCCEEDED') AS avg_duration_ms
FROM queues q
LEFT JOIN jobs j ON j.queue_id = q.id
LEFT JOIN job_attempts ja ON ja.job_id = j.id
GROUP BY q.id, q.name;

-- Refresh periodically (every minute)
REFRESH MATERIALIZED VIEW CONCURRENTLY queue_stats;
```

**Why**: Pre-computes expensive aggregations.

### 6. Use Query Result Caching

```typescript
import { LRUCache } from 'lru-cache';

// Cache query results
const cache = new LRUCache<string, any>({
  max: 1000, // Max 1000 entries
  ttl: 60000, // 60 seconds TTL
});

async function getQueueStats(queueId: string) {
  const cacheKey = `queue_stats:${queueId}`;

  // Check cache
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // Query database
  const stats = await db.select().from(/* ... */);

  // Store in cache
  cache.set(cacheKey, stats);

  return stats;
}
```

**Why**: Reduces database load for frequently accessed data.

## Monitoring

### Key Metrics to Monitor

```sql
-- 1. Slow queries (queries taking > 100ms)
SELECT
  query,
  calls,
  total_exec_time,
  mean_exec_time,
  max_exec_time
FROM pg_stat_statements
WHERE mean_exec_time > 100
ORDER BY total_exec_time DESC
LIMIT 20;

-- 2. Index usage statistics
SELECT
  schemaname,
  tablename,
  indexname,
  idx_scan AS index_scans,
  idx_tup_read AS tuples_read,
  idx_tup_fetch AS tuples_fetched,
  pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
ORDER BY idx_scan DESC;

-- 3. Table statistics
SELECT
  schemaname,
  tablename,
  seq_scan AS sequential_scans,
  seq_tup_read AS seq_rows_read,
  idx_scan AS index_scans,
  idx_tup_fetch AS idx_rows_fetched,
  n_tup_ins AS rows_inserted,
  n_tup_upd AS rows_updated,
  n_tup_del AS rows_deleted,
  pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_stat_user_tables
WHERE schemaname = 'public'
ORDER BY seq_scan DESC;

-- 4. Unused indexes (candidates for removal)
SELECT
  schemaname,
  tablename,
  indexname,
  idx_scan,
  pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE schemaname = 'public' AND idx_scan = 0
ORDER BY pg_relation_size(indexrelid) DESC;

-- 5. Connection pool usage
SELECT
  count(*) AS total_connections,
  count(*) FILTER (WHERE state = 'active') AS active,
  count(*) FILTER (WHERE state = 'idle') AS idle,
  count(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_tx
FROM pg_stat_activity
WHERE datname = current_database();

-- 6. Cache hit ratio (should be > 99%)
SELECT
  sum(heap_blks_read) AS heap_read,
  sum(heap_blks_hit) AS heap_hit,
  sum(heap_blks_hit) / (sum(heap_blks_hit) + sum(heap_blks_read)) * 100 AS cache_hit_ratio
FROM pg_statio_user_tables;

-- 7. Lock waits
SELECT
  locktype,
  relation::regclass,
  mode,
  transactionid,
  pid,
  granted
FROM pg_locks
WHERE NOT granted;
```

### Enable Query Logging

```sql
-- PostgreSQL configuration
ALTER SYSTEM SET log_min_duration_statement = 100; -- Log queries > 100ms
ALTER SYSTEM SET log_line_prefix = '%t [%p]: [%l-1] user=%u,db=%d,app=%a,client=%h ';
ALTER SYSTEM SET log_statement = 'none'; -- Don't log all statements
ALTER SYSTEM SET log_duration = on;

-- Reload configuration
SELECT pg_reload_conf();
```

### Enable pg_stat_statements

```sql
-- Add to postgresql.conf
shared_preload_libraries = 'pg_stat_statements'
pg_stat_statements.track = all
pg_stat_statements.max = 10000

-- Create extension
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

## Troubleshooting

### High CPU Usage

**Symptom**: PostgreSQL process consuming high CPU

**Possible Causes**:

1. Missing indexes (full table scans)
2. Complex queries
3. Too many connections

**Investigation**:

```sql
-- Find running queries
SELECT pid, query, state, query_start, now() - query_start AS duration
FROM pg_stat_activity
WHERE state = 'active' AND query NOT LIKE '%pg_stat_activity%'
ORDER BY duration DESC;

-- Kill long-running query
SELECT pg_terminate_backend(pid);
```

### Slow Queries

**Symptom**: Queries taking > 100ms

**Investigation**:

```sql
-- Explain query plan
EXPLAIN ANALYZE
SELECT * FROM jobs
WHERE queue_id = 'xxx' AND status = 'QUEUED'
ORDER BY priority DESC, created_at ASC
LIMIT 10;
```

**Look for**:

- Seq Scan (should be Index Scan)
- High execution time
- Many rows processed

**Fix**:

- Add index
- Rewrite query
- Update statistics: `ANALYZE jobs;`

### Lock Contention

**Symptom**: Queries waiting for locks

**Investigation**:

```sql
-- Find blocking queries
SELECT
  blocked_locks.pid AS blocked_pid,
  blocked_activity.query AS blocked_query,
  blocking_locks.pid AS blocking_pid,
  blocking_activity.query AS blocking_query
FROM pg_catalog.pg_locks blocked_locks
JOIN pg_catalog.pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid
JOIN pg_catalog.pg_locks blocking_locks
  ON blocking_locks.locktype = blocked_locks.locktype
  AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
  AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
  AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
  AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
  AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
  AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
  AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
  AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
  AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
  AND blocking_locks.pid != blocked_locks.pid
JOIN pg_catalog.pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid
WHERE NOT blocked_locks.granted;
```

**Fix**:

- Keep transactions short
- Use optimistic locking instead of row locks
- Consider SKIP LOCKED for job polling

### Connection Pool Exhaustion

**Symptom**: "Too many connections" errors

**Investigation**:

```sql
-- Check connection count
SELECT count(*) FROM pg_stat_activity;

-- Show max connections
SHOW max_connections;
```

**Fix**:

- Increase max_connections
- Fix connection leaks in application
- Use connection pooling (PgBouncer)

## Summary

**Key Takeaways**:

✅ **Always use indexes** for WHERE, ORDER BY, JOIN columns  
✅ **Use covering indexes** to avoid heap lookups  
✅ **Use partial indexes** for filtered queries  
✅ **Use prepared statements** for security and performance  
✅ **Avoid N+1 queries** with JOINs or batch loading  
✅ **Monitor slow queries** with pg_stat_statements  
✅ **Keep transactions short** to avoid lock contention  
✅ **Use connection pooling** to manage resources  
✅ **Cache frequently accessed data** to reduce DB load  
✅ **Profile before optimizing** to find real bottlenecks

**Remember**: Premature optimization is the root of all evil. Profile first, then optimize!
