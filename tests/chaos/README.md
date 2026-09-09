# Chaos Testing Suite

Controlled chaos testing for validating Resilient TaskFlow's failure resilience.

## Quick Start

```bash
# Start test environment
docker-compose up -d

# Run automated chaos tests
pnpm test:chaos

# Run specific chaos scenario
pnpm chaos worker-crash
```

## Available Scenarios

### Service Failures

```bash
# Kill and auto-restart worker
pnpm chaos worker-crash

# Restart PostgreSQL
pnpm chaos postgres-restart

# Restart Redis
pnpm chaos redis-restart

# Restart Kafka
pnpm chaos kafka-restart

# Restart API
pnpm chaos api-restart
```

### Network Issues

```bash
# Simulate network partition (pause container)
pnpm chaos network-partition

# Add network latency (requires tc in container)
# pnpm chaos network-latency
```

### Resource Exhaustion

```bash
# Fill Redis memory to 90%
pnpm chaos redis-memory-pressure

# Exhaust database connection pool
pnpm chaos db-connection-exhaustion

# Inject slow query (10s)
pnpm chaos slow-query
```

### Data Corruption

```bash
# Delete random Redis keys
pnpm chaos delete-redis-keys
```

### Complex Scenarios

```bash
# Rolling restarts (services one by one)
pnpm chaos rolling-restarts

# Total system failure (kill everything)
pnpm chaos total-failure

# Cascading failure (sequential failures)
pnpm chaos cascading-failure
```

## What to Monitor

### During Chaos Tests

1. **Grafana Dashboard**: http://localhost:3001/d/taskflow-overview
   - Watch queue depth
   - Monitor worker activity
   - Check success rate

2. **Logs**:
```bash
docker-compose logs -f
```

3. **Metrics**:
```bash
curl http://localhost:3000/metrics | grep taskflow
```

### Expected Behavior

✅ **Worker Crash**:
- Jobs return to queue after lease expires (30s)
- Another worker picks up and completes
- No jobs lost

✅ **Database Restart**:
- Connections retry with backoff
- System reconnects automatically
- Jobs resume processing

✅ **Redis Restart**:
- Streams lost (ephemeral)
- Jobs re-enqueued from PostgreSQL
- Processing resumes

✅ **Kafka Restart**:
- Event publishing fails
- Jobs continue processing (fire-and-forget)
- System remains available

## Verification

After chaos tests, verify system health:

```bash
# Check job consistency
docker exec taskflow-postgres psql -U taskflow -d taskflow -c \
  "SELECT status, COUNT(*) FROM jobs GROUP BY status;"

# Check for stuck jobs (should be 0)
docker exec taskflow-postgres psql -U taskflow -d taskflow -c \
  "SELECT COUNT(*) FROM jobs WHERE status = 'PROCESSING' AND lease_expires_at < NOW();"

# Check Redis health
docker exec taskflow-redis redis-cli INFO stats

# Submit test job
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test-api-key" \
  -d '{"type":"test-job","payload":{},"queue":"default"}'
```

## Test Suite Structure

```
tests/chaos/
├── chaos-scenarios.test.ts    # Automated test scenarios
├── chaos-injector.ts          # Chaos injection utilities
├── run-chaos.ts               # CLI for manual chaos testing
└── README.md                  # This file
```

## Files

### `chaos-scenarios.test.ts`

Automated Vitest test suite covering:
- Worker crash scenarios
- Service restart scenarios
- Network failure scenarios
- Resource exhaustion scenarios
- Data corruption scenarios
- Timing and race conditions
- Cascading failures

Run with: `pnpm test:chaos`

### `chaos-injector.ts`

Utility class for programmatic chaos injection:

```typescript
import { ChaosInjector } from './chaos-injector';

const injector = new ChaosInjector();
await injector.connect({ redisUrl: '...', databaseUrl: '...' });

// Kill container
await injector.killContainer('taskflow-worker-1', {
  autoRecover: true,
  duration: 10000,
});

// Fill Redis
await injector.fillRedisMemory(90);

// Exhaust DB connections
await injector.exhaustDatabaseConnections(10);
```

### `run-chaos.ts`

CLI for executing chaos scenarios:

```bash
# List available scenarios
pnpm chaos help

# Run specific scenario
pnpm chaos worker-crash

# Run complex scenario
pnpm chaos total-failure
```

## Best Practices

### Before Testing

1. ✅ Start with isolated test environment
2. ✅ Document baseline metrics
3. ✅ Check all services are healthy
4. ✅ Monitor Grafana dashboard

### During Testing

1. ✅ Watch metrics in real-time
2. ✅ Tail logs for all services
3. ✅ Time the recovery duration
4. ✅ Take notes on observations

### After Testing

1. ✅ Verify system fully recovered
2. ✅ Check no jobs were lost
3. ✅ Review logs for errors
4. ✅ Document any issues found

## Troubleshooting

### Test Won't Run

```bash
# Check Docker is running
docker ps

# Check containers exist
docker-compose ps

# Check container names
docker ps --format "table {{.Names}}\t{{.Status}}"
```

### System Won't Recover

```bash
# Reset stuck jobs
docker exec taskflow-postgres psql -U taskflow -d taskflow -c \
  "UPDATE jobs SET status = 'QUEUED', worker_id = NULL WHERE status = 'PROCESSING' AND lease_expires_at < NOW();"

# Recreate Redis consumer group
docker exec taskflow-redis redis-cli XGROUP CREATE taskflow:queue:default taskflow-workers 0 MKSTREAM

# Restart workers
docker-compose restart taskflow-worker-1
```

## Safety

⚠️ **NEVER run chaos tests in production**

Chaos testing is for:
- ✅ Local development
- ✅ Test environments
- ✅ Staging (with caution)

NOT for:
- ❌ Production systems
- ❌ Shared environments
- ❌ During business hours (on shared systems)

## Documentation

Full chaos testing guide: [docs/chaos-testing.md](../../docs/chaos-testing.md)

Related docs:
- [Testing Guide](../../docs/testing.md)
- [Failure Model](../../docs/failure-model/README.md)
- [Observability](../../docs/observability.md)

## Examples

### Example 1: Test Worker Failure Recovery

```bash
# 1. Start system
docker-compose up -d

# 2. Submit test jobs
for i in {1..10}; do
  curl -X POST http://localhost:3000/api/v1/jobs \
    -H "X-API-Key: test-api-key" \
    -H "Content-Type: application/json" \
    -d '{"type":"test-job","payload":{}}'
done

# 3. Watch dashboard
open http://localhost:3001/d/taskflow-overview

# 4. Kill worker
pnpm chaos worker-crash

# 5. Observe recovery (30s for lease expiration)
# 6. Verify all jobs completed

# 7. Check metrics
curl http://localhost:3000/metrics | grep taskflow_jobs_completed
```

### Example 2: Test Database Resilience

```bash
# 1. Start long-running job
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "X-API-Key: test-api-key" \
  -d '{"type":"sleep-job","payload":{"duration":60000}}'

# 2. Restart database mid-job
pnpm chaos postgres-restart

# 3. Verify job completes successfully
# 4. Check logs for reconnection
docker logs taskflow-api | grep "database"
```

### Example 3: Test Total System Failure

```bash
# 1. Submit jobs
# 2. Kill everything
pnpm chaos total-failure

# 3. Wait 10s for auto-recovery
# 4. Verify system comes back healthy
# 5. Check all jobs are accounted for
```

## Support

For issues with chaos testing:
1. Check [docs/chaos-testing.md](../../docs/chaos-testing.md)
2. Review test output and logs
3. Verify Docker and services are healthy
