# TaskFlow Quick Start Guide

Get TaskFlow up and running in 5 minutes!

## Prerequisites

- **Node.js**: 20.11+ 
- **pnpm**: 8.0+
- **Docker**: 24.0+
- **Docker Compose**: 2.20+

## Step 1: Install Dependencies

```bash
# Install all dependencies
pnpm install
```

## Step 2: Start Infrastructure

```bash
# Start PostgreSQL, Redis, Kafka, Grafana, Prometheus
docker-compose up -d

# Verify all services are running
docker-compose ps
```

You should see all services in "Up" state:
- `taskflow-postgres` (PostgreSQL)
- `taskflow-redis` (Redis)
- `taskflow-redpanda` (Kafka)
- `taskflow-grafana` (Grafana)
- `taskflow-prometheus` (Prometheus)

## Step 3: Configure Environment

```bash
# Copy example environment file
cp .env.example .env

# The default values should work for local development
# Key settings:
# - DATABASE_URL=postgresql://taskflow:taskflow_password@localhost:5432/taskflow
# - REDIS_URL=redis://localhost:6379
# - JWT_SECRET=your-super-secret-jwt-key-change-this-in-production-min-32-chars
```

## Step 4: Run Database Migrations

```bash
# Create database schema
pnpm db:migrate

# (Optional) Seed with test data
pnpm db:seed
```

## Step 5: Start the API Server

```bash
# Terminal 1: Start API server
pnpm dev:api

# You should see:
# ✓ Database connected
# ✓ Redis connected
# ✓ API server listening on 0.0.0.0:3000
```

Verify API is running:
```bash
curl http://localhost:3000/health
# Should return: {"status":"healthy","postgres":true,"redis":true,"kafka":true}
```

## Step 6: Start Workers

```bash
# Terminal 2: Start worker process
pnpm dev:worker

# You should see:
# ✓ Database connected
# ✓ Redis connected
# ✓ Job handlers initialized (2 types: send-email, process-data)
# ✓ Stale recovery started
# ✓ Worker started successfully
```

## Step 7: Run the Demo

```bash
# Terminal 3: Run end-to-end demo
pnpm demo
```

The demo will:
1. Check API health
2. Submit 4 test jobs (email, data processing, critical email, aggregation)
3. Wait for workers to process jobs
4. Show results and status

**Expected Output:**
```
╔════════════════════════════════════════════════════════════════╗
║             TaskFlow End-to-End Demo                          ║
╚════════════════════════════════════════════════════════════════╝

1. Checking API health...
   ✓ API is healthy
   ✓ PostgreSQL: connected
   ✓ Redis: connected
   ✓ Kafka: connected

2. Submitting test jobs...
   Submitting: send-email (HIGH priority)
   ✓ Job created: abc-123

3. Waiting for jobs to be processed by workers...
   ✓ Job abc-123 succeeded
      Status: SUCCEEDED
      
Demo completed successfully! 🎉
```

## Step 8: Explore the System

### API Documentation (Swagger UI)
```bash
open http://localhost:3000/docs
```

Interactive API documentation with:
- Job submission
- Job status checking
- Job cancellation
- DLQ management

### Grafana Dashboards
```bash
open http://localhost:3001
# Login: admin / admin
```

Pre-configured dashboards showing:
- Jobs per minute (created, succeeded, failed)
- Queue depth over time
- Worker utilization
- API latency (P50, P95, P99)

### Prometheus Metrics
```bash
open http://localhost:9090
```

Raw metrics endpoint:
```bash
curl http://localhost:3000/metrics
```

### View Logs

**API Server:**
```bash
docker logs -f taskflow-api
```

**Worker:**
```bash
# Worker runs in foreground (Terminal 2)
# Ctrl+C to view scrollback
```

**Infrastructure:**
```bash
docker-compose logs -f postgres
docker-compose logs -f redis
docker-compose logs -f redpanda
```

## Manual Testing

### Submit a Job

```bash
# Using API key authentication (dev mode)
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test-api-key" \
  -d '{
    "type": "send-email",
    "payload": {
      "to": "user@example.com",
      "subject": "Hello from TaskFlow",
      "body": "This is a test email"
    },
    "priority": "HIGH"
  }'

# Response:
# {
#   "jobId": "550e8400-e29b-41d4-a716-446655440000",
#   "status": "PENDING",
#   "createdAt": "2024-01-01T00:00:00.000Z"
# }
```

### Check Job Status

```bash
# Get job by ID
curl http://localhost:3000/api/v1/jobs/{jobId} \
  -H "X-API-Key: test-api-key"

# Response:
# {
#   "jobId": "550e8400-e29b-41d4-a716-446655440000",
#   "type": "send-email",
#   "status": "SUCCEEDED",
#   "result": {
#     "sentAt": "2024-01-01T00:00:02.000Z",
#     "to": "user@example.com"
#   }
# }
```

### List All Jobs

```bash
curl "http://localhost:3000/api/v1/jobs?status=SUCCEEDED&limit=10" \
  -H "X-API-Key: test-api-key"
```

### Cancel a Job

```bash
curl -X POST http://localhost:3000/api/v1/jobs/{jobId}/cancel \
  -H "X-API-Key: test-api-key"
```

## Available Job Types

TaskFlow comes with two example handlers:

### 1. send-email

Send emails (simulated):

```bash
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test-api-key" \
  -d '{
    "type": "send-email",
    "payload": {
      "to": "user@example.com",
      "subject": "Test Email",
      "body": "Email body content"
    },
    "priority": "NORMAL"
  }'
```

### 2. process-data

Process data with various operations:

**Transform:**
```bash
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test-api-key" \
  -d '{
    "type": "process-data",
    "payload": {
      "operation": "transform",
      "data": [
        {"id": 1, "value": 100},
        {"id": 2, "value": 200}
      ]
    }
  }'
```

**Aggregate:**
```bash
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test-api-key" \
  -d '{
    "type": "process-data",
    "payload": {
      "operation": "aggregate",
      "data": [
        {"id": 1, "count": 10},
        {"id": 2, "count": 20}
      ]
    }
  }'
```

**Validate:**
```bash
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test-api-key" \
  -d '{
    "type": "process-data",
    "payload": {
      "operation": "validate",
      "data": [
        {"id": 1, "value": 100}
      ]
    }
  }'
```

**Enrich:**
```bash
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test-api-key" \
  -d '{
    "type": "process-data",
    "payload": {
      "operation": "enrich",
      "data": [
        {"id": 1, "name": "Item 1"}
      ]
    }
  }'
```

## Priority Levels

Jobs can have different priorities:
- `CRITICAL` - Processed first
- `HIGH` - Processed after CRITICAL
- `NORMAL` - Default priority
- `LOW` - Processed last

Example:
```bash
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test-api-key" \
  -d '{
    "type": "send-email",
    "payload": {...},
    "priority": "CRITICAL"
  }'
```

## Scaling Workers

Run multiple workers for higher throughput:

```bash
# Terminal 2: Worker 1
pnpm dev:worker

# Terminal 3: Worker 2
pnpm dev:worker

# Terminal 4: Worker 3
pnpm dev:worker
```

Each worker:
- Processes 10 jobs concurrently (configurable)
- Has unique worker ID
- Coordinates via PostgreSQL leases
- No conflicts (optimistic locking)

## Troubleshooting

### API won't start

**Check if port 3000 is in use:**
```bash
lsof -i :3000
```

**Check database connection:**
```bash
docker exec taskflow-postgres psql -U taskflow -c "SELECT 1"
```

### Worker won't start

**Check Redis connection:**
```bash
docker exec taskflow-redis redis-cli ping
# Should return: PONG
```

**Check if handlers are registered:**
```bash
# Look for this in worker logs:
# ✓ Job handlers initialized
#   count: 2
#   types: ["send-email", "process-data"]
```

### Jobs not being processed

**Check if workers are running:**
```bash
# Worker logs should show:
# Starting queue processor
# Processing loops started for all queues
```

**Check queue depth:**
```bash
docker exec taskflow-redis redis-cli XLEN taskflow:stream:default
```

**Check for stale jobs:**
```bash
docker exec taskflow-postgres psql -U taskflow -c \
  "SELECT id, status, lease_expires_at FROM jobs WHERE status = 'PROCESSING'"
```

### Reset everything

```bash
# Stop and remove all containers
docker-compose down -v

# Start fresh
docker-compose up -d
pnpm db:migrate
```

## Next Steps

1. **Add custom job handlers** - See `apps/worker/src/handlers/`
2. **Run load tests** - `pnpm load:all`
3. **Explore Grafana** - http://localhost:3001
4. **Read documentation** - See README.md, ARCHITECTURE_REVIEW.md

## Common Commands

```bash
# Start everything
docker-compose up -d
pnpm dev:api    # Terminal 1
pnpm dev:worker # Terminal 2
pnpm demo       # Terminal 3

# Stop everything
docker-compose down
# Ctrl+C in Terminal 1 and 2

# View logs
docker-compose logs -f
pnpm docker:logs

# Run tests
pnpm test

# Load testing
pnpm load:sustained  # 9 minute sustained load test
pnpm load:spike      # 3 minute spike test
pnpm load:all        # All load tests

# Code quality
pnpm lint
pnpm typecheck
pnpm format
```

## Success Checklist

- [ ] `docker-compose ps` shows all services running
- [ ] `curl http://localhost:3000/health` returns healthy
- [ ] API server running in Terminal 1
- [ ] Worker running in Terminal 2
- [ ] `pnpm demo` completes successfully
- [ ] Grafana dashboards visible at http://localhost:3001
- [ ] Can submit jobs manually with curl
- [ ] Jobs show status SUCCEEDED

**If all checks pass, you're ready to build with TaskFlow!** 🚀

## Getting Help

- **Documentation**: See README.md
- **Architecture**: See ARCHITECTURE_REVIEW.md
- **Benchmarks**: See docs/benchmarking/BENCHMARK_REPORT.md
- **Issues**: See Known Issues section in README.md
