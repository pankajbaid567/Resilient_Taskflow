# Resilient TaskFlow - System Architecture Overview

## Executive Summary

Resilient TaskFlow is a production-grade distributed task queue and asynchronous job-processing platform built to demonstrate deep understanding of distributed systems, fault tolerance, and event-driven architecture.

## Core Philosophy

**PostgreSQL = Source of Truth**  
All durable job state lives in PostgreSQL. If every other system fails, job state can be reconstructed from PostgreSQL.

**Redis Streams = Task Delivery**  
Redis Streams provide the message transport mechanism for job distribution to workers.

**Kafka/Redpanda = Event Propagation**  
Domain and system events are published to Kafka for analytics, auditing, and notifications.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          Client Layer                            │
│                    (HTTP Clients, SDKs)                          │
└─────────────────────┬───────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Load Balancer                              │
│                    (AWS ALB / Nginx)                             │
└─────────────────────┬───────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                        API Service                               │
│              (Fastify + TypeScript + Node.js)                    │
│                                                                   │
│  ┌──────────────┬──────────────┬──────────────┐                │
│  │ Job Submit   │ Rate Limiter │ Auth/AuthZ   │                │
│  │ Job Query    │ Validation   │ Idempotency  │                │
│  │ Job Cancel   │ API Keys     │ Metrics      │                │
│  └──────────────┴──────────────┴──────────────┘                │
└───────────┬────────────────────┬────────────────────────────────┘
            │                    │
            ▼                    ▼
┌───────────────────┐  ┌──────────────────┐
│   PostgreSQL      │  │     Redis        │
│                   │  │                  │
│ • jobs            │  │ • Streams        │
│ • job_attempts    │  │ • Rate Limits    │
│ • workers         │  │ • Locks          │
│ • queues          │  │ • Heartbeats     │
│ • idempotency     │  │ • Cache          │
│ • dead_letter     │  │                  │
└───────────┬───────┘  └────────┬─────────┘
            │                   │
            │                   │ Consumer Groups
            │                   ▼
            │        ┌─────────────────────────┐
            │        │    Redis Streams        │
            │        │  ┌──────────────────┐   │
            │        │  │ Queue: default   │   │
            │        │  │ Queue: email     │   │
            │        │  │ Queue: critical  │   │
            │        │  └──────────────────┘   │
            │        └────────┬────────────────┘
            │                 │
            │                 │ XREADGROUP
            │                 ▼
            │     ┌──────────────────────────┐
            │     │     Worker Pool          │
            │     │                          │
            │     │  ┌────┐ ┌────┐ ┌────┐   │
            │     │  │ W1 │ │ W2 │ │ W3 │   │
            │     │  └────┘ └────┘ └────┘   │
            │     │          ...             │
            │     │  ┌────┐ ┌────┐ ┌────┐   │
            │     │  │ W8 │ │ W9 │ │ WN │   │
            │     │  └────┘ └────┘ └────┘   │
            │     │                          │
            │     │ • Job Execution          │
            │     │ • Lease Management       │
            │     │ • Heartbeat              │
            │     │ • Concurrency Control    │
            │     │ • Graceful Shutdown      │
            │     └──────┬──────────────┬────┘
            │            │              │
            └────────────┘              │
                                        │ Lifecycle Events
                                        ▼
                              ┌──────────────────┐
                              │  Kafka/Redpanda  │
                              │                  │
                              │ Topics:          │
                              │ • job.created    │
                              │ • job.started    │
                              │ • job.completed  │
                              │ • job.failed     │
                              │ • job.retried    │
                              │ • job.cancelled  │
                              │ • job.dlq        │
                              └─────────┬────────┘
                                        │
                         ┌──────────────┼──────────────┐
                         ▼              ▼              ▼
                   ┌──────────┐  ┌──────────┐  ┌──────────┐
                   │Analytics │  │  Audit   │  │ Notif.   │
                   │Consumer  │  │ Consumer │  │ Consumer │
                   └──────────┘  └──────────┘  └──────────┘

                         Observability Layer
                         ───────────────────
                    ┌────────────────────────────┐
                    │  Prometheus + Grafana      │
                    │  OpenTelemetry             │
                    │  Pino Structured Logs      │
                    └────────────────────────────┘
```

## Component Responsibilities

### 1. API Service (Fastify)

**Responsibilities:**

- Accept job submission requests
- Validate payloads using Zod schemas
- Authenticate and authorize requests
- Enforce rate limits (per-user, per-API-key)
- Handle idempotency (Idempotency-Key header)
- Coordinate PostgreSQL write + Redis enqueue atomically
- Query job status and history
- Handle job cancellation requests
- Expose metrics endpoint for Prometheus
- Health checks and readiness probes

**Key Operations:**

- `POST /api/v1/jobs` - Submit new job
- `GET /api/v1/jobs/:id` - Get job status
- `DELETE /api/v1/jobs/:id` - Cancel job
- `POST /api/v1/jobs/:id/retry` - Retry failed job
- `GET /api/v1/queues` - List queues
- `GET /api/v1/queues/:name/stats` - Queue statistics
- `GET /api/v1/workers` - List active workers
- `GET /health` - Health check
- `GET /ready` - Readiness check
- `GET /metrics` - Prometheus metrics

**Technology:**

- Fastify (HTTP framework)
- Zod (validation)
- Pino (logging)
- JWT (authentication)

### 2. PostgreSQL (Durable State)

**Responsibilities:**

- Store all job records
- Track job state transitions
- Record job attempts and errors
- Store idempotency keys
- Track worker registrations
- Maintain dead letter queue
- Provide queryable job history
- Enforce data integrity constraints

**Key Tables:**

- `users` - User accounts
- `queues` - Queue definitions
- `jobs` - Primary job records
- `job_attempts` - Attempt history
- `workers` - Worker registrations
- `job_events` - State change audit log
- `idempotency_keys` - Duplicate prevention
- `dead_letter_jobs` - Failed jobs after max retries

**Guarantees:**

- ACID transactions for state transitions
- Row-level locking for concurrency control
- Foreign key constraints
- Unique constraints on idempotency keys
- Indexed queries for performance

### 3. Redis (Ephemeral State & Delivery)

**Responsibilities:**

**Redis Streams (Job Delivery):**

- Distribute jobs to worker pool
- Support consumer groups
- Track pending messages
- Enable message acknowledgement
- Support message reclaim for stale consumers

**Redis Data Structures:**

- Rate limiting counters (sliding window)
- Distributed locks (SET NX EX)
- Worker heartbeats (TTL-based)
- Queue statistics cache
- Temporary worker state

**Key Operations:**

- `XADD` - Enqueue job
- `XREADGROUP` - Consume job
- `XACK` - Acknowledge completion
- `XPENDING` - Check stale messages
- `XCLAIM` - Reclaim stale messages

**Important Constraints:**

- Redis is NOT the source of truth
- All durable state must be in PostgreSQL
- System must recover if Redis is restarted
- Message loss is acceptable (jobs can be recovered from PostgreSQL)

### 4. Worker Pool (Job Execution)

**Responsibilities:**

- Consume jobs from Redis Streams
- Acquire lease before processing
- Update job state in PostgreSQL
- Execute job handler functions
- Send heartbeat to indicate liveness
- Handle job timeout
- Support graceful shutdown
- Emit lifecycle events to Kafka
- Record attempt metadata

**Worker Lifecycle:**

```
Start
  ↓
Register in PostgreSQL
  ↓
Join Consumer Group
  ↓
┌─→ XREADGROUP (blocking)
│     ↓
│   Receive Job
│     ↓
│   Acquire Lease (PostgreSQL)
│     ↓
│   Update Status: PROCESSING
│     ↓
│   Execute Handler
│     ↓
│   Success?
│   ├─ Yes → Update: SUCCEEDED
│   │         Publish: job.completed
│   │         XACK
│   │
│   └─ No → Update: FAILED
│            Retry logic
│            XACK
│     ↓
└── Continue (if not shutdown)
  ↓
Graceful Shutdown
  ↓
Stop accepting new jobs
  ↓
Finish in-progress jobs
  ↓
Unregister from PostgreSQL
```

**Concurrency Model:**

- Each worker supports N concurrent jobs
- Use bounded queue/pool to prevent memory exhaustion
- Backpressure when queue is full

**Handler Registry:**

```typescript
handlers = {
  send_email: sendEmailHandler,
  process_webhook: webhookHandler,
  resize_image: resizeImageHandler,
  generate_report: reportHandler,
  simulate_failure: failureHandler,
  cpu_task: cpuTaskHandler,
  sleep: sleepHandler,
};
```

### 5. Kafka/Redpanda (Event Bus)

**Responsibilities:**

- Publish job lifecycle events
- Enable event-driven consumers
- Support event replay
- Decouple event producers from consumers
- Provide event ordering guarantees

**Topics:**

- `taskflow.job.created`
- `taskflow.job.started`
- `taskflow.job.completed`
- `taskflow.job.failed`
- `taskflow.job.retried`
- `taskflow.job.cancelled`
- `taskflow.job.dead_lettered`

**Event Schema (versioned):**

```typescript
{
  schemaVersion: 1,
  eventType: 'job.completed',
  eventId: 'evt_...',
  timestamp: '2026-08-23T...',
  jobId: 'job_...',
  queue: 'default',
  type: 'send_email',
  workerId: 'worker-01',
  duration: 842,
  attempts: 1,
  metadata: {...}
}
```

**Consumers:**

- Analytics consumer (aggregate metrics)
- Audit consumer (compliance logging)
- Notification consumer (webhooks, alerts)
- Metrics consumer (real-time dashboards)

### 6. Observability Stack

**Structured Logging (Pino):**

- JSON logs with correlation IDs
- Request/response logging
- Job lifecycle logging
- Error logging with stack traces
- Never log sensitive payloads

**Metrics (Prometheus):**

- Counters: jobs_submitted_total, jobs_completed_total, jobs_failed_total
- Gauges: jobs_processing, queue_depth, worker_count
- Histograms: job_duration_seconds, job_wait_duration_seconds
- Labels: queue, type, status, worker_id

**Tracing (OpenTelemetry):**

- Distributed trace from API → Redis → Worker → PostgreSQL → Kafka
- Span attributes: jobId, queue, type, attempt
- Trace context propagation

**Dashboard (Grafana):**

- Job throughput (jobs/sec)
- Queue depth by queue
- Success/failure rates
- Latency percentiles (P50, P95, P99)
- Active workers
- Error rates

## Key Architectural Decisions

### Decision 1: PostgreSQL as Source of Truth

**Rationale:**

- Jobs must survive system crashes
- Redis Streams are ephemeral by nature
- PostgreSQL provides ACID transactions
- Enables complex queries and reporting
- Industry-standard approach for durable state

**Trade-off:**

- Higher latency for state updates
- Database becomes potential bottleneck
- Requires careful index design

### Decision 2: Redis Streams for Job Delivery

**Rationale:**

- Low-latency message delivery
- Built-in consumer groups
- Automatic load balancing across workers
- Pending entry tracking
- Stale message reclaim

**Why not BullMQ?**

- Goal is to demonstrate understanding of queue internals
- BullMQ hides distributed systems complexity
- Building from Redis Streams directly shows deeper knowledge

**Trade-off:**

- Must implement retry logic ourselves
- Must implement scheduling ourselves
- More code to maintain

### Decision 3: Separate Kafka for Events

**Rationale:**

- Redis Streams = task execution (at-least-once delivery)
- Kafka = event propagation (ordered event log)
- Separates concerns: job processing vs event streaming
- Kafka provides durable event replay
- Enables multiple independent consumers

**Trade-off:**

- Increased system complexity
- Another service to manage
- Additional failure modes

### Decision 4: At-Least-Once Delivery

**Guarantee:**

- Jobs MAY be delivered more than once
- Jobs WILL NOT be lost (durable in PostgreSQL)
- Handlers MUST be idempotent

**Why not Exactly-Once?**

- Distributed exactly-once is extremely difficult
- Requires distributed transactions or two-phase commit
- Performance overhead is significant
- At-least-once + idempotency is pragmatic solution

**Implementation:**

- Idempotency keys for job submission
- Handler-level idempotency patterns
- Database constraints prevent duplicate processing

### Decision 5: Worker Leases

**Rationale:**

- Workers can crash during processing
- Need mechanism to detect stale workers
- Need mechanism to reclaim abandoned jobs

**Implementation:**

- Lease stored in PostgreSQL `jobs` table
- `lease_id`, `lease_expires_at`, `worker_id`
- Worker renews lease periodically
- Expired leases allow job recovery
- Prevents duplicate processing under normal conditions

**Trade-off:**

- Requires heartbeat mechanism
- Clock synchronization concerns
- Lease duration tuning required

## Critical Invariants

### Invariant 1: Job State Consistency

**Rule:** Job state in PostgreSQL is authoritative. Redis and Kafka are derived state.

**Enforcement:**

- All state transitions write to PostgreSQL first
- Redis message contains only job ID (not full state)
- Workers re-fetch state from PostgreSQL before processing

### Invariant 2: No Orphaned Jobs

**Rule:** Every job in QUEUED state must either be in Redis or recoverable.

**Enforcement:**

- Job insertion and Redis enqueue must be atomic (see consistency strategies)
- Periodic sweep finds QUEUED jobs not in Redis and re-enqueues them
- Dead letter queue captures jobs exceeding max attempts

### Invariant 3: State Machine Compliance

**Rule:** Only valid state transitions are allowed.

**Enforcement:**

- State transition validation in domain layer
- PostgreSQL CHECK constraints
- Optimistic locking for concurrent updates
- Transaction rollback on invalid transitions

### Invariant 4: Idempotency

**Rule:** Duplicate submissions with same idempotency key return same job.

**Enforcement:**

- Unique index on `idempotency_keys` table
- Foreign key to `jobs` table
- TTL-based cleanup of old keys
- Race-safe INSERT ... ON CONFLICT

### Invariant 5: Lease Exclusivity

**Rule:** At most one worker processes a job at a time (under normal conditions).

**Enforcement:**

- Optimistic locking with `lease_id`
- UPDATE WHERE lease_expires_at < NOW()
- Heartbeat renewal extends lease
- Expired leases allow re-acquisition

## Failure Model

The system is designed to handle:

1. **API Service Crash**
   - Jobs in PostgreSQL survive
   - In-flight requests fail (client retries)
   - Other API instances continue serving

2. **Worker Crash**
   - Lease expires
   - Job becomes recoverable
   - Another worker can claim it

3. **Redis Crash**
   - Jobs in PostgreSQL survive
   - Recovery process re-enqueues from PostgreSQL
   - Temporary unavailability of queue

4. **PostgreSQL Crash**
   - System cannot accept new jobs
   - Workers cannot update state
   - System halts until recovery
   - No data loss (PostgreSQL durability)

5. **Kafka Crash**
   - Events are buffered
   - Job processing continues
   - Event consumers lag

6. **Network Partition**
   - API cannot reach PostgreSQL/Redis
   - Worker cannot reach PostgreSQL/Redis
   - Graceful degradation where possible

## Consistency Strategy: API + Redis + PostgreSQL

**The Problem:**

```
Client → POST /jobs
API → INSERT INTO jobs (PostgreSQL) ✓
API → XADD (Redis) ✗ (crash)
API → Response ???
```

Job is in PostgreSQL but not in Redis. Job will never execute.

**Solution A: Write-Ahead (Chosen)**

```
1. BEGIN TRANSACTION
2. INSERT INTO jobs (status=CREATED)
3. COMMIT
4. XADD to Redis Stream
5. If XADD fails:
   - Log error
   - Job remains in CREATED state
   - Background sweeper finds CREATED jobs and enqueues them
6. UPDATE jobs SET status=QUEUED
7. Return job ID to client
```

**Solution B: Write-Behind**

```
1. XADD to Redis
2. If fails: return error
3. INSERT INTO PostgreSQL
4. If fails: Job in Redis will fail when worker tries to process
```

**Trade-off Analysis:**

| Aspect      | Write-Ahead         | Write-Behind         |
| ----------- | ------------------- | -------------------- |
| Durability  | ✅ PostgreSQL first | ⚠️ Redis first       |
| Consistency | ✅ Sweeper recovers | ❌ Orphaned messages |
| Performance | ⚠️ 2 round trips    | ✅ 1 round trip      |
| Complexity  | ⚠️ Sweeper needed   | ✅ Simpler           |

**Decision: Write-Ahead** because durability and consistency are more important than raw performance for a portfolio project demonstrating distributed systems understanding.

## Scalability Characteristics

**Horizontal Scaling:**

- API: Stateless, scale by adding instances behind load balancer
- Workers: Scale by adding worker processes/containers
- PostgreSQL: Vertical scaling + read replicas for queries
- Redis: Redis Cluster for high throughput
- Kafka: Partition-based scaling

**Bottlenecks:**

- PostgreSQL write throughput (job state updates)
- Redis Stream throughput (job enqueue rate)
- Worker handler execution time

**Scaling Strategy:**

```
1K jobs/sec:  3 API instances, 5 workers, single PostgreSQL
10K jobs/sec: 5 API instances, 20 workers, PostgreSQL tuning
100K jobs/sec: 10 API instances, 50+ workers, PostgreSQL cluster, Redis cluster
```

## Security Model

**Authentication:**

- JWT tokens for user authentication
- API keys for service-to-service
- Role-based access control (RBAC)

**Authorization:**

- Users can only access their own jobs
- Admin role can access all jobs
- Worker role can update job status

**Data Protection:**

- Secrets via environment variables
- No secrets in logs
- TLS for all network communication (production)
- SQL injection prevention (parameterized queries)
- Input validation (Zod schemas)

**Rate Limiting:**

- Per-user limits (100 req/min)
- Per-API-key limits (1000 req/min)
- DDoS protection at load balancer

## Next Steps

This document provides the high-level architecture. See related documents:

- [Database Schema](./database-schema.md) - PostgreSQL table design
- [Redis Streams Design](./redis-streams.md) - Queue implementation
- [State Machine](./state-machine.md) - Job lifecycle
- [Failure Model](../failure-model/README.md) - Detailed failure scenarios
- [ADRs](../decisions/README.md) - Architecture Decision Records
