# Chaos Testing Guide

Comprehensive guide to chaos testing Resilient TaskFlow's failure resilience.

## Table of Contents

- [Overview](#overview)
- [Philosophy](#philosophy)
- [Prerequisites](#prerequisites)
- [Chaos Scenarios](#chaos-scenarios)
- [Running Chaos Tests](#running-chaos-tests)
- [Interpreting Results](#interpreting-results)
- [Recovery Verification](#recovery-verification)
- [Production Chaos](#production-chaos)

## Overview

Chaos testing validates that Resilient TaskFlow behaves correctly under failure conditions by intentionally injecting faults into a running system.

### Goals

1. **Validate recovery mechanisms** - Ensure system recovers from failures
2. **Identify weak points** - Find gaps in error handling
3. **Measure resilience** - Quantify system behavior under stress
4. **Build confidence** - Prove system works when things fail

### What We Test

- Worker crashes and restarts
- Database connection failures
- Redis unavailability
- Kafka outages
- Network partitions
- Resource exhaustion
- Data corruption
- Race conditions
- Cascading failures

## Philosophy

### Netflix's Principles

Resilient TaskFlow chaos testing follows Netflix's chaos engineering principles:

1. **Build a hypothesis** - What should happen when X fails?
2. **Inject controlled failure** - Deliberately break something
3. **Measure impact** - Does system behave as expected?
4. **Learn and improve** - Fix issues, update monitoring

### Our Approach

**Controlled chaos in test environment**:
- Run against dedicated test infrastructure
- Automate failure injection
- Monitor system behavior
- Verify recovery
- Document findings

**Never in production** (for this project):
- Chaos testing is done in isolated test environments
- Production chaos requires mature monitoring and runbooks

## Prerequisites

### Test Environment

Ensure you have a running test environment:

```bash
# Start all services
docker-compose up -d

# Verify services are healthy
docker ps
docker-compose logs -f

# Check PostgreSQL
docker exec taskflow-postgres pg_isready

# Check Redis
docker exec taskflow-redis redis-cli ping

# Check Kafka
docker exec taskflow-redpanda rpk cluster health
```

### System State

Before running chaos tests:

1. **Submit baseline jobs** - Create jobs to track through failure
2. **Monitor metrics** - Watch Grafana dashboard
3. **Check logs** - Tail logs for all services
4. **Document baseline** - Record normal behavior

### Tools Required

- Docker and Docker Compose
- Node.js / TypeScript
- Access to test database
- Grafana dashboard access

## Chaos Scenarios

### 1. Worker Crash

**Scenario**: Worker process crashes mid-job execution

**Expected Behavior**:
- Job lease expires (30s)
- Job returns to queue
- Another worker picks it up
- Job completes successfully

**Command**:
```bash
pnpm chaos worker-crash
```

**What Happens**:
1. Worker container killed
2. Jobs in PROCESSING state stuck with expired lease
3. After 30s, leases expire
4. Recovery process reclaims jobs
5. Workers complete jobs

**Verification**:
```sql
-- Check for stuck jobs
SELECT id, status, worker_id, lease_expires_at
FROM jobs
WHERE status = 'PROCESSING'
AND lease_expires_at < NOW();

-- Should be 0 after recovery
```

**Metrics to Watch**:
- `taskflow_worker_failures_total` - Increments
- `taskflow_jobs_current{status="queued"}` - Temporarily increases
- `taskflow_worker_lease_acquisition_failures_total` - May spike

### 2. PostgreSQL Restart

**Scenario**: Database restarts during operation

**Expected Behavior**:
- Active connections fail
- Connection pool reconnects automatically
- Queued operations retry
- No data loss

**Command**:
```bash
pnpm chaos postgres-restart
```

**What Happens**:
1. PostgreSQL container restarts (~2-5s)
2. All connections severed
3. Workers/API retry with backoff
4. Connections re-established
5. Operations resume

**Verification**:
```bash
# Check connection pool recovery
docker logs taskflow-api | grep "database connection"

# Verify no data loss
# Compare job counts before/after
```

**Metrics to Watch**:
- `taskflow_db_connection_pool_size` - Drops to 0, then recovers
- `taskflow_db_queries_total` - Dips during restart

### 3. Redis Restart

**Scenario**: Redis crashes, all streams lost

**Expected Behavior**:
- Redis Streams data lost (ephemeral)
- PostgreSQL remains source of truth
- QUEUED jobs re-enqueued from DB
- Consumer groups recreated
- Processing resumes

**Command**:
```bash
pnpm chaos redis-restart
```

**What Happens**:
1. Redis container restarts
2. All stream data lost
3. Recovery process:
   - Query DB for QUEUED jobs
   - Recreate consumer groups
   - Re-enqueue to Redis
4. Workers resume processing

**Verification**:
```bash
# Check stream recreation
docker exec taskflow-redis redis-cli XLEN taskflow:queue:default

# Verify consumer groups
docker exec taskflow-redis redis-cli XINFO GROUPS taskflow:queue:default
```

**Metrics to Watch**:
- `taskflow_queue_depth` - Drops to 0, then refills
- `taskflow_redis_commands_total` - Drops during restart

### 4. Kafka Restart

**Scenario**: Kafka unavailable

**Expected Behavior**:
- Job processing continues
- Events fail to publish
- Errors logged (not thrown)
- System remains available

**Command**:
```bash
pnpm chaos kafka-restart
```

**What Happens**:
1. Kafka container restarts
2. Event publishing fails
3. Jobs complete successfully anyway (fire-and-forget)
4. Events logged as failed
5. Kafka recovers, events resume

**Verification**:
```bash
# Check event publish failures
docker logs taskflow-worker-1 | grep "event publish failed"

# Verify job completion unaffected
```

**Metrics to Watch**:
- `taskflow_event_publish_failures_total` - Increases
- `taskflow_jobs_completed_total` - Continues growing (unaffected)

### 5. API Restart

**Scenario**: API server restarts with inflight requests

**Expected Behavior**:
- Graceful shutdown (SIGTERM)
- Inflight requests complete (up to 30s)
- New requests rejected during shutdown
- Clean restart

**Command**:
```bash
pnpm chaos api-restart
```

**What Happens**:
1. API receives SIGTERM
2. Stop accepting new connections
3. Wait for inflight requests (max 30s)
4. Close connections
5. Restart

**Verification**:
```bash
# Check graceful shutdown
docker logs taskflow-api | grep "graceful shutdown"

# Verify no connection errors
```

**Metrics to Watch**:
- `taskflow_http_requests_total` - Brief drop
- `process_uptime_seconds` - Resets to 0

### 6. Network Partition

**Scenario**: Worker network partition (can't reach DB/Redis)

**Expected Behavior**:
- Worker can't renew leases
- Leases expire
- Other workers claim jobs
- Partitioned worker eventually gives up

**Command**:
```bash
pnpm chaos network-partition
```

**What Happens**:
1. Worker container paused (network effectively down)
2. Worker can't send heartbeats
3. Worker can't renew leases
4. After 30s, leases expire
5. Other workers claim jobs
6. Partition heals, worker reconnects

**Verification**:
```bash
# Check lease expirations
docker logs taskflow-worker-1 | grep "lease renewal failed"

# Verify job recovery
```

**Metrics to Watch**:
- `taskflow_worker_lease_renewals_total` - Stops for partitioned worker
- `taskflow_worker_heartbeats_total` - Stops

### 7. Resource Exhaustion

#### Redis Memory Pressure

**Scenario**: Redis hits maxmemory limit

**Expected Behavior**:
- Eviction policy activates
- Non-critical data evicted (rate limit keys)
- Critical data protected (job queue)
- System continues functioning

**Command**:
```bash
pnpm chaos redis-memory-pressure
```

**What Happens**:
1. Fill Redis to 90% capacity
2. Eviction policy: `allkeys-lru`
3. Old keys evicted first
4. Rate limiting may degrade
5. Core queue functionality preserved

**Verification**:
```bash
# Check Redis memory
docker exec taskflow-redis redis-cli INFO memory

# Verify eviction count
docker exec taskflow-redis redis-cli INFO stats | grep evicted
```

#### Database Connection Exhaustion

**Scenario**: All DB connections in use

**Expected Behavior**:
- New queries wait for available connection
- Timeout if wait exceeds limit
- No crashes, graceful degradation

**Command**:
```bash
pnpm chaos db-connection-exhaustion
```

**What Happens**:
1. Acquire all connections in pool
2. New queries blocked
3. Queries timeout or wait
4. Connections released
5. Queue drains

**Verification**:
```bash
# Check connection pool state
docker logs taskflow-api | grep "connection pool"
```

**Metrics to Watch**:
- `taskflow_db_connection_pool_size{state="used"}` - Maxes out
- `taskflow_db_query_duration_seconds` - Increases

### 8. Data Corruption

#### Malformed Job Payload

**Scenario**: Job with invalid payload

**Expected Behavior**:
- Worker detects invalid payload
- Job moves to DLQ
- Error logged with details
- Other jobs unaffected

**Test Code**:
```typescript
const job = createJob({
  payload: null, // Invalid
  type: 'process-data',
});

// Worker should move to DLQ
```

#### Missing Job Handler

**Scenario**: Job type not registered

**Expected Behavior**:
- Worker detects missing handler
- Job fails with clear error
- Moves to DLQ or retries (config)
- Error logged

**Test Code**:
```typescript
const job = createJob({
  type: 'unknown-job-type',
});

// Should fail with "No handler registered"
```

### 9. Cascading Failures

**Scenario**: Multiple services fail sequentially

**Expected Behavior**:
- Each failure handled independently
- System doesn't amplify failures
- Recovery happens incrementally
- No thundering herd

**Command**:
```bash
pnpm chaos cascading-failure
```

**What Happens**:
1. Redis fails → Jobs can't enqueue
2. API fails → No new jobs submitted
3. Workers fail → No processing
4. Recovery:
   - Redis up → Re-enqueue from DB
   - API up → Accept new jobs
   - Workers up → Resume processing

**Verification**:
```bash
# Monitor recovery sequence
docker-compose logs -f --tail=100
```

**Metrics to Watch**:
- All service metrics recover sequentially
- No spikes/storms during recovery

### 10. Total System Failure

**Scenario**: Everything fails simultaneously

**Expected Behavior**:
- All containers killed
- Auto-recovery after 10s
- Services restart in correct order
- Jobs resume from last known state

**Command**:
```bash
pnpm chaos total-failure
```

**What Happens**:
1. All containers killed
2. 10-second blackout
3. Docker restarts containers
4. Services initialize
5. Recovery process runs
6. System fully operational

**Verification**:
```bash
# Watch recovery
docker-compose ps
docker-compose logs -f

# Verify job consistency
```

## Running Chaos Tests

### Quick Start

```bash
# Install dependencies
pnpm install

# Start test environment
docker-compose up -d

# Run a chaos scenario
pnpm chaos worker-crash

# Monitor results
docker-compose logs -f
open http://localhost:3001/d/taskflow-overview
```

### Test Suite

Run automated chaos test suite:

```bash
# Run all chaos scenarios (automated)
pnpm test:chaos

# Run specific scenario tests
pnpm vitest tests/chaos/chaos-scenarios.test.ts
```

### Manual Chaos Injection

Use the chaos injector programmatically:

```typescript
import { ChaosInjector } from './tests/chaos/chaos-injector';

const injector = new ChaosInjector();

await injector.connect({
  redisUrl: 'redis://localhost:6379',
  databaseUrl: 'postgresql://...',
});

// Kill worker
await injector.killContainer('taskflow-worker-1', {
  autoRecover: true,
  duration: 10000,
});

// Fill Redis
await injector.fillRedisMemory(90);

// Exhaust connections
await injector.exhaustDatabaseConnections(10);
```

## Interpreting Results

### Success Criteria

A chaos test **passes** if:

1. ✅ **No data loss** - All jobs accounted for
2. ✅ **Recovery completes** - System returns to normal
3. ✅ **Correctness maintained** - Jobs process correctly
4. ✅ **Observability works** - Metrics/logs show failure
5. ✅ **Alerts fire** - Monitoring detects issue

### Failure Indicators

A chaos test **fails** if:

1. ❌ **Jobs lost** - Jobs disappear from system
2. ❌ **Jobs stuck** - Jobs never complete
3. ❌ **Silent failure** - No logs/metrics for failure
4. ❌ **Cascading failure** - One failure causes others
5. ❌ **No recovery** - System doesn't recover

### Metrics Dashboard

During chaos tests, watch Grafana:

**System Overview**:
- Queue Depth - Should recover to normal
- Active Workers - Should stabilize
- Success Rate - Should return to baseline

**Job Throughput**:
- Should dip during failure
- Should recover within 1-2 minutes

**Latency**:
- P95/P99 may spike temporarily
- Should return to baseline

**Worker Health**:
- Worker Failures - Should increment
- Worker Activity - Should recover

### Log Analysis

Key log patterns to verify:

**Worker Crash**:
```
[ERROR] Worker heartbeat failed
[INFO] Lease expired for job-123
[INFO] Job reclaimed by worker-2
```

**Database Restart**:
```
[ERROR] Database connection lost
[INFO] Retrying connection (attempt 1/5)
[INFO] Database connection re-established
```

**Redis Restart**:
```
[ERROR] Redis connection lost
[INFO] Recreating consumer group: taskflow-workers
[INFO] Re-enqueuing 42 jobs from database
```

## Recovery Verification

### Automated Checks

After each chaos test, verify:

```bash
# 1. Check job consistency
docker exec taskflow-postgres psql -U taskflow -d taskflow -c \
  "SELECT status, COUNT(*) FROM jobs GROUP BY status;"

# 2. Check Redis health
docker exec taskflow-redis redis-cli INFO stats

# 3. Check worker health
docker exec taskflow-postgres psql -U taskflow -d taskflow -c \
  "SELECT status, COUNT(*) FROM workers GROUP BY status;"

# 4. Check for stuck jobs
docker exec taskflow-postgres psql -U taskflow -d taskflow -c \
  "SELECT COUNT(*) FROM jobs WHERE status = 'PROCESSING' AND lease_expires_at < NOW();"
# Should be 0
```

### Manual Verification

1. **Submit test job**:
```bash
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test-api-key" \
  -d '{"type":"test-job","payload":{},"queue":"default"}'
```

2. **Verify completion**:
```bash
# Check job status
curl http://localhost:3000/api/v1/jobs/{job-id} \
  -H "X-API-Key: test-api-key"
```

3. **Check metrics**:
```bash
curl http://localhost:3000/metrics | grep taskflow_jobs
```

## Production Chaos

### NOT RECOMMENDED for this project

This is a portfolio/learning project. **Do not run chaos tests in production**.

### If You Must (Advanced)

For mature production systems, follow these principles:

1. **Start small** - Single worker, low traffic time
2. **Have runbooks** - Document recovery procedures
3. **Monitor closely** - Watch all metrics
4. **Have rollback** - Be ready to abort
5. **Communicate** - Inform team before chaos test
6. **Learn** - Document findings, improve system

### Production Tools

For real production chaos engineering:
- **Chaos Mesh** - Kubernetes-native chaos engineering
- **Pumba** - Docker chaos testing
- **Gremlin** - Commercial chaos engineering platform
- **LitmusChaos** - Open source chaos engineering

## Best Practices

### Before Chaos Testing

1. ✅ **Document baseline** - Know normal behavior
2. ✅ **Inform team** - Let people know you're testing
3. ✅ **Check monitoring** - Ensure observability works
4. ✅ **Plan recovery** - Know how to fix if needed
5. ✅ **Test in isolation** - Dedicated test environment

### During Chaos Testing

1. ✅ **Watch metrics** - Monitor Grafana dashboard
2. ✅ **Tail logs** - Watch logs in real-time
3. ✅ **Take notes** - Document observations
4. ✅ **Time the chaos** - Measure recovery duration
5. ✅ **Be ready to abort** - Stop if something goes wrong

### After Chaos Testing

1. ✅ **Verify recovery** - Run consistency checks
2. ✅ **Review logs** - Look for unexpected errors
3. ✅ **Document findings** - What broke? What worked?
4. ✅ **Fix issues** - Improve weak points
5. ✅ **Update tests** - Add regression tests

## Troubleshooting

### Chaos Test Won't Run

**Issue**: `docker: command not found`
**Fix**: Install Docker

**Issue**: `Container not found`
**Fix**: Check container name with `docker ps`

**Issue**: `Permission denied`
**Fix**: Run with appropriate permissions or use `sudo`

### System Won't Recover

**Issue**: Jobs stuck in PROCESSING
**Fix**: Manually reset leases:
```sql
UPDATE jobs SET status = 'QUEUED', worker_id = NULL, lease_id = NULL
WHERE status = 'PROCESSING' AND lease_expires_at < NOW();
```

**Issue**: Redis streams not recreating
**Fix**: Manually recreate consumer group:
```bash
docker exec taskflow-redis redis-cli XGROUP CREATE taskflow:queue:default taskflow-workers 0 MKSTREAM
```

**Issue**: Workers not picking up jobs
**Fix**: Restart workers:
```bash
docker-compose restart taskflow-worker-1
```

## Examples

### Example 1: Worker Crash Recovery

```bash
# 1. Submit 10 test jobs
for i in {1..10}; do
  curl -X POST http://localhost:3000/api/v1/jobs \
    -H "X-API-Key: test-api-key" \
    -H "Content-Type: application/json" \
    -d '{"type":"test-job","payload":{}}'
done

# 2. Watch Grafana dashboard
open http://localhost:3001/d/taskflow-overview

# 3. Kill worker mid-processing
pnpm chaos worker-crash

# 4. Verify recovery
# - Jobs complete after 30s
# - Queue depth returns to 0
# - No jobs stuck

# 5. Check metrics
curl http://localhost:3000/metrics | grep worker_failures
```

### Example 2: Database Restart

```bash
# 1. Start long-running job
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "X-API-Key: test-api-key" \
  -d '{"type":"long-job","payload":{}}'

# 2. Restart PostgreSQL mid-job
pnpm chaos postgres-restart

# 3. Verify job completes
# - Connection re-established
# - Job resumes processing
# - No data loss
```

## Related Documentation

- [Testing Guide](./testing.md)
- [Failure Model](./failure-model/README.md)
- [Observability](./observability.md)
- [Leases and Heartbeats](./leases-and-heartbeats.md)

## Summary

Chaos testing validates that Resilient TaskFlow's failure handling works in practice:

✅ **Worker crashes** - Jobs recovered via lease expiration  
✅ **Service restarts** - Automatic reconnection and recovery  
✅ **Network issues** - Graceful degradation and retry  
✅ **Resource limits** - Backpressure and eviction policies  
✅ **Data issues** - DLQ and error handling  

Run chaos tests regularly to maintain confidence in system resilience.
