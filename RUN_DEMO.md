# Run TaskFlow Demo - Step by Step

## Current Status
✅ Docker Desktop is running  
✅ All code is implemented  
✅ Dependencies are installed  

## Run These Commands

### Option 1: Automated Startup (Recommended)

Open your terminal and run:

```bash
cd /Users/pankajbaid/projects/Resilient_TaskFlow
./scripts/start-all.sh
```

This will:
1. Check Docker is running
2. Start all infrastructure (PostgreSQL, Redis, Redpanda, Prometheus, Grafana)
3. Run database migrations
4. Show you what to do next

### Option 2: Manual Step-by-Step

If the automated script has issues, run these commands:

#### Terminal 1 - Start Infrastructure
```bash
cd /Users/pankajbaid/projects/Resilient_TaskFlow

# Start services (ignore dashboard warning)
docker-compose up -d postgres redis redpanda prometheus grafana

# Wait 15 seconds for services to start
sleep 15

# Check services are running
docker ps

# Run migrations
pnpm db:migrate
```

#### Terminal 2 - Start API Server
```bash
cd /Users/pankajbaid/projects/Resilient_TaskFlow
pnpm dev:api
```

You should see:
```
✓ Database connected
✓ Redis connected
✓ API server listening on 0.0.0.0:3000
```

#### Terminal 3 - Start Worker
```bash
cd /Users/pankajbaid/projects/Resilient_TaskFlow
pnpm dev:worker
```

You should see:
```
✓ Database connected
✓ Redis connected
✓ Job handlers initialized (2 types)
✓ Stale recovery started
✓ Worker started successfully
```

#### Terminal 4 - Run Demo
```bash
cd /Users/pankajbaid/projects/Resilient_TaskFlow
pnpm demo
```

Expected output:
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
   ...

3. Waiting for jobs to be processed by workers...
   ✓ Job abc-123 succeeded
   
Demo completed successfully! 🎉
```

## Verify Services Are Running

```bash
# Check Docker containers
docker ps

# Should show:
# taskflow-postgres
# taskflow-redis
# taskflow-redpanda
# taskflow-prometheus
# taskflow-grafana

# Test PostgreSQL
docker exec taskflow-postgres pg_isready -U taskflow

# Test Redis
docker exec taskflow-redis redis-cli ping

# Test API (after starting API server)
curl http://localhost:3000/health
```

## Access Dashboards

- **API Health**: http://localhost:3000/health
- **API Docs**: http://localhost:3000/docs
- **Grafana**: http://localhost:3002 (admin/admin)
- **Prometheus**: http://localhost:9091

## Troubleshooting

### "Cannot connect to Docker daemon"
```bash
# Start Docker Desktop
open -a Docker

# Wait 30 seconds, then try again
```

### "Port already in use"
```bash
# Find what's using the port (example: 5432)
lsof -i :5432

# Kill the process or stop existing containers
docker stop taskflow-postgres
```

### "Database connection failed"
```bash
# Restart PostgreSQL
docker restart taskflow-postgres

# Check logs
docker logs taskflow-postgres
```

### "Worker can't find handlers"
```bash
# Reinstall dependencies
cd /Users/pankajbaid/projects/Resilient_TaskFlow
pnpm install

# Check worker code compiled
cd apps/worker
pnpm build
```

### "Demo times out"
```bash
# Check API is running (Terminal 2)
curl http://localhost:3000/health

# Check worker is running (Terminal 3)
# You should see logs like "Processing loops started"

# Check Redis has jobs
docker exec taskflow-redis redis-cli XLEN taskflow:stream:default
```

## Clean Restart

If something goes wrong:

```bash
# Stop all containers
docker-compose down

# Remove volumes (warning: deletes all data)
docker-compose down -v

# Start fresh
docker-compose up -d postgres redis redpanda prometheus grafana
pnpm db:migrate
```

## Success Criteria

✅ All 5 Docker containers running  
✅ `pnpm dev:api` shows "API server listening"  
✅ `pnpm dev:worker` shows "Worker started successfully"  
✅ `pnpm demo` completes with "Demo completed successfully! 🎉"  

## What You're Demonstrating

1. **Job Submission** - API accepts job requests
2. **Worker Processing** - Worker picks up jobs from queue
3. **Lease Management** - No duplicate processing
4. **Status Updates** - Jobs transition PENDING → PROCESSING → SUCCEEDED
5. **Priority Handling** - CRITICAL jobs process first
6. **Error Handling** - Failed jobs retry with exponential backoff
7. **Stale Recovery** - Crashed worker jobs are recovered
8. **End-to-End Flow** - Complete distributed task queue in action

## File Structure

```
/Users/pankajbaid/projects/Resilient_TaskFlow/
├── docker-compose.yml         # Infrastructure definition
├── scripts/
│   ├── start-all.sh          # Automated startup
│   └── demo.ts               # Demo script
├── apps/
│   ├── api/                  # REST API server
│   └── worker/               # Job processing worker
├── packages/                 # Shared libraries
└── QUICKSTART.md             # Detailed guide
```

---

**Ready to see it in action?** Start with the automated script or follow the manual steps above!
