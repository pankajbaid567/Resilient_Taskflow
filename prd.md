🚀 PRD — Resilient TaskFlow
Distributed Task Queue & Event-Driven Job Processing Platform

Project type: Production-grade backend / distributed systems
Primary target: SDE Intern + Backend Intern
Secondary target: Backend + AI, Platform/Infrastructure
Difficulty: Advanced
Estimated build time: 3–5 weeks
Primary language: TypeScript

1. Product Vision

Build a production-grade distributed task queue that allows applications to submit asynchronous jobs and have those jobs reliably processed by a horizontally scalable pool of workers.

The system should demonstrate that you understand:

REST API design
asynchronous processing
queues
distributed systems
concurrency
retries
idempotency
fault tolerance
distributed locking
caching
event-driven architecture
database transactions
observability
horizontal scaling
containerization
cloud deployment

The goal is not to build "another CRUD backend."

The goal is:

Build a miniature production-grade job-processing infrastructure similar in concept to systems such as Celery, BullMQ, Sidekiq and cloud task queues.

2. Why This Project?

Your existing stack already gives you:

MERN + TypeScript + Redis + backend experience.

So instead of learning an entirely new ecosystem, this project should take your existing skills and push them into systems engineering.

Current Indian backend hiring signals support this direction: Node.js/TypeScript, PostgreSQL and Redis appear together in current internship/backend listings, while Kafka/event-driven systems and scalable concurrency are strong differentiators.

Your hiring intelligence documents also explicitly identify working rate limiters, distributed caches and message queues as underrated SDE projects.

3. Recommended Tech Stack
🥇 My exact recommendation for you
Layer	Technology	Why
Language	TypeScript	You already know it
Runtime	Node.js 22+	Strong Indian backend relevance
HTTP	Express.js	You already know it + broad hiring recognition
Database	PostgreSQL	Essential backend/SDE skill
DB driver	pg	Gives you SQL/control for distributed systems
Queue	Redis Streams	Core queue implementation
Event bus	Kafka / Redpanda	Event-driven architecture
Cache	Redis	You already know it
ORM	Drizzle ORM	Lightweight; lets you retain SQL control
Validation	Zod	Type-safe API validation
Testing	Vitest/Jest + Supertest	Backend testing
Load testing	k6	Performance benchmarking
Containers	Docker + Docker Compose	Production deployment
CI/CD	GitHub Actions	Industry-standard workflow
Metrics	Prometheus	Production observability
Dashboard	Grafana	Metrics visualization
Logging	Pino	Fast structured logging
Tracing	OpenTelemetry	Distributed tracing
Cloud	AWS	Strong India hiring signal
Deployment	AWS ECS/Fargate	Better than simply deploying to EC2
Reverse proxy	Nginx / AWS ALB	Load balancing
Documentation	OpenAPI/Swagger	API quality

Current Indian hiring data also shows PostgreSQL, Redis, Docker, Kubernetes, AWS, Node.js and CI/CD among frequently requested technologies, while backend listings emphasize Node/TypeScript/Postgres/Redis and Kafka.

One important decision:

Don't use MongoDB for this project.

You already have MERN.

This project should deliberately demonstrate:

Node + TypeScript + PostgreSQL + Redis + Kafka

That fills the gap in your portfolio.

4. Why NOT Go or Java?

You might wonder:

"Should I build this in Go because distributed systems companies use Go?"

Eventually — yes.

But not for V1.

For your internship strategy:

V1

TypeScript + Node.js

because:

you already know it
you can build faster
you can go deeper into distributed systems
it strengthens your backend profile
it matches current Node/TypeScript roles
V2

Rewrite the worker engine in Go.

Then your GitHub can demonstrate:

TypeScript API
       ↓
Redis/Kafka
       ↓
Go Worker Pool
       ↓
PostgreSQL

That becomes an extremely interesting systems project.

5. Core Product

The system should allow developers to submit jobs.

Example:

POST /api/v1/jobs

Request:

{
  "type": "send_email",
  "payload": {
    "to": "user@example.com",
    "template": "welcome"
  },
  "priority": 5
}

Response:

{
  "jobId": "job_8f92...",
  "status": "queued"
}

Then:

API
 ↓
Redis Stream
 ↓
Worker
 ↓
Execute Job
 ↓
PostgreSQL
 ↓
Event
 ↓
Kafka
6. System Architecture
                    ┌──────────────────┐
                    │      Client      │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │    Load Balancer │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │    API Server    │
                    │ Node + TypeScript│
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
        PostgreSQL         Redis          Kafka
              │              │              │
              │              ▼              │
              │        Task Queue           │
              │              │              │
              │              ▼              │
              │      ┌──────────────┐       │
              │      │ Worker Pool  │       │
              │      │              │       │
              │      │ Worker 1     │       │
              │      │ Worker 2     │       │
              │      │ Worker 3     │       │
              │      │ Worker N     │       │
              │      └──────┬───────┘       │
              │             │               │
              └─────────────┴───────────────┘
                            │
                            ▼
                     Job Result Store
7. Core Components
7.1 API Service

Responsible for:

authentication
job submission
job retrieval
job cancellation
retry requests
queue statistics
worker management
API rate limiting

Endpoints:

POST   /api/v1/jobs
GET    /api/v1/jobs/:id
DELETE /api/v1/jobs/:id


POST   /api/v1/jobs/:id/retry
POST   /api/v1/jobs/:id/cancel


GET    /api/v1/queues
GET    /api/v1/queues/:name/stats


GET    /api/v1/workers
GET    /api/v1/health
GET    /api/v1/metrics
8. Job Model

Each job should contain:

id
queue
type
payload
status
priority
attempts
maxAttempts
createdAt
startedAt
completedAt
failedAt
scheduledAt
timeout
workerId
error
result
Status lifecycle
CREATED
   ↓
QUEUED
   ↓
PROCESSING
   ↓
 ┌─┴──────────┐
 ↓            ↓
SUCCESS      FAILED
              ↓
           RETRY?
          /      \
        YES       NO
         ↓         ↓
      QUEUED    DEAD_LETTER
9. Priority Queue

Support:

CRITICAL
HIGH
NORMAL
LOW

Example:

Priority 10 → Payment
Priority 7  → Email
Priority 5  → Data processing
Priority 1  → Analytics

Workers should preferentially process high-priority tasks.

10. Retry System

This is one of the most important features.

If a job fails:

Attempt 1
   ↓
Failure
   ↓
Wait 1 sec
   ↓
Attempt 2
   ↓
Failure
   ↓
Wait 2 sec
   ↓
Attempt 3
   ↓
Failure
   ↓
Dead Letter Queue

Use:

Exponential backoff
delay = baseDelay × 2^attempt

Add jitter to avoid retry storms.

11. Dead Letter Queue

After:

maxAttempts = 5

the job goes into:

DLQ

API:

GET /api/v1/dlq

Admin can:

POST /api/v1/dlq/:id/requeue

This demonstrates real failure handling.

12. Idempotency

This is mandatory.

Imagine:

Payment Job

Worker processes it.

Then worker crashes before acknowledging completion.

The queue sends the job again.

Without idempotency:

₹1000
↓
₹1000 charged
↓
Retry
↓
₹1000 charged AGAIN

Your system should prevent this.

Implement:

idempotencyKey

with PostgreSQL/Redis enforcement.

13. Worker Architecture

Workers should be independent processes.

Worker Manager
      │
 ┌────┼────┬────┐
 ↓    ↓    ↓    ↓
 W1   W2   W3   W4

Each worker:

pulls job
acquires processing ownership
executes job
records result
acknowledges job
emits event
14. Worker Heartbeat

Workers periodically send:

worker_id
last_heartbeat
status
current_job

Example:

Worker-01
Status: ACTIVE
Current Job: job_9328
Heartbeat: 2 seconds ago

If:

heartbeat > 30 seconds

worker is considered dead.

Its unfinished job should become eligible for recovery.

15. Job Lease

Use a lease mechanism:

job
 ↓
worker acquires lease
 ↓
lease expires?
 ├── NO → continue
 └── YES → recover

Example:

lease_duration = 30 seconds

Worker renews periodically.

This demonstrates understanding of distributed failure.

16. Concurrency Control

Workers should support:

concurrency = 10

Meaning:

Worker 1
 ├── Job 1
 ├── Job 2
 ├── Job 3
 ...
 └── Job 10

But don't simply create unlimited promises.

Implement:

ConcurrencyLimiter

and benchmark it.

17. Rate Limiting

Implement:

Token Bucket

or

Sliding Window

Example:

100 jobs/minute/user

Return:

429 Too Many Requests

with:

Retry-After
18. Scheduling

Support delayed jobs.

Example:

{
  "type": "send_reminder",
  "scheduledAt": "2026-08-24T10:00:00Z"
}

Worker should process only when the scheduled time arrives.

Also support:

delay: 10 seconds
19. Job Cancellation

Users should be able to:

DELETE /api/v1/jobs/:id

States:

QUEUED → CANCELLED

For processing jobs:

PROCESSING → CANCELLATION_REQUESTED

Worker checks cancellation token.

20. Kafka Integration

Don't make Kafka the primary task queue.

Use:

Redis Streams → task execution
Kafka → system events

For example:

Job Created
Job Started
Job Completed
Job Failed
Job Retried
Job Dead Lettered

Kafka event:

{
  "event": "job.completed",
  "jobId": "job_123",
  "workerId": "worker_4",
  "durationMs": 843,
  "timestamp": "..."
}

This gives you event-driven architecture without making the core queue unnecessarily complicated.

21. Database

Use PostgreSQL.

Tables:

users
jobs
job_attempts
queues
workers
job_events
dead_letter_jobs
idempotency_keys

Important indexes:

jobs(status)
jobs(queue, status)
jobs(priority, created_at)
jobs(scheduled_at)
workers(last_heartbeat)

You should benchmark queries before and after indexing.

22. Redis Architecture

Use Redis for:

1. Queue

Redis Streams

2. Rate limiting

Redis counters

3. Distributed locks

Redis

4. Worker heartbeat

Redis TTL

5. Caching

Queue statistics

23. Observability

This is what separates your project from a student CRUD project.

Implement:

Metrics
jobs_submitted_total
jobs_completed_total
jobs_failed_total
jobs_retried_total
jobs_processing
queue_depth
job_latency
worker_count
worker_failures

Prometheus:

/api/v1/metrics

Grafana dashboard:

┌─────────────────────────────┐
│ Jobs / sec                  │
├─────────────────────────────┤
│ Queue Depth                 │
├─────────────────────────────┤
│ Success Rate                │
├─────────────────────────────┤
│ Failure Rate                │
├─────────────────────────────┤
│ P50/P95/P99 Latency         │
├─────────────────────────────┤
│ Active Workers              │
└─────────────────────────────┘
24. Logging

Use structured JSON logs.

Example:

{
  "level": "info",
  "event": "job.completed",
  "jobId": "job_123",
  "workerId": "worker_4",
  "duration": 842
}

Never rely on:

console.log("job done")
25. Distributed Tracing

Add OpenTelemetry.

Trace:

API Request
   ↓
Create Job
   ↓
Redis
   ↓
Worker
   ↓
Postgres
   ↓
Kafka

This lets you show recruiters:

"I understand observability in distributed systems."

26. Security

Implement:

JWT authentication
API keys
RBAC
request validation
rate limiting
payload size limits
CORS
security headers
secret management
SQL injection protection
audit logs
27. Docker Architecture

Your docker-compose.yml should run:

api
worker
worker
worker
postgres
redis
kafka
zookeeper/Redpanda
prometheus
grafana

Example:

docker compose up

should start the entire system.

28. Testing Strategy
Unit tests

Test:

retry calculation
priority
job state transitions
idempotency
scheduling
concurrency
rate limiter
Integration tests

Test:

API → Redis → Worker → PostgreSQL
Failure tests

Kill:

Worker
Redis
Kafka
Database

and verify recovery.

This is very important.

29. Load Testing

Use k6.

Start with:

100 requests/sec

Then:

500 req/sec

Then:

1000 req/sec

Measure:

Throughput
P50
P95
P99
Error rate
Queue depth
Worker utilization

Don't invent impressive numbers.

Measure them.

30. Benchmark

Your README should eventually contain something like:

Benchmark


Workers       Jobs/sec       P95 latency
-----------------------------------------
1             XXX            XX ms
3             XXX            XX ms
5             XXX            XX ms
10            XXX            XX ms

This is much stronger than:

"Scalable backend built using Node.js."

31. Failure Simulation

Create a command:

npm run chaos

It should randomly:

kill workers
delay jobs
cause failures
disconnect Redis
produce duplicate messages

Then demonstrate:

System continues processing

This is an excellent interview talking point.

32. Admin Dashboard

Build a lightweight React dashboard.

Dashboard
Tasks
Workers
Queues
Failures
DLQ
Metrics

For example:

ACTIVE WORKERS
     12


QUEUED JOBS
    1,284


PROCESSING
      73


SUCCESS RATE
    98.7%


P95 LATENCY
    412ms

Don't spend weeks on the frontend.

The backend is the product.

33. Suggested Repository
resilient-taskflow/
│
├── apps/
│   ├── api/
│   ├── worker/
│   └── dashboard/
│
├── packages/
│   ├── config/
│   ├── types/
│   ├── queue/
│   ├── database/
│   ├── logger/
│   └── observability/
│
├── infrastructure/
│   ├── docker/
│   ├── prometheus/
│   ├── grafana/
│   └── kafka/
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── load/
│   └── chaos/
│
├── docs/
│   ├── architecture.md
│   ├── api.md
│   ├── failure-model.md
│   └── benchmarks.md
│
├── docker-compose.yml
├── Dockerfile
├── package.json
├── turbo.json
└── README.md

Use a monorepo with pnpm + Turborepo if you're comfortable with it.

34. Development Phases
Phase 1 — Foundation

2–3 days

Build:

TypeScript
Express
PostgreSQL
Redis
Docker
project structure
configuration
logging
Phase 2 — Basic Queue

3–4 days

Implement:

POST /jobs
GET /jobs/:id
Redis Stream
Worker
Job execution
Job completion
Phase 3 — Reliability

4–5 days

Implement:

retries
exponential backoff
DLQ
idempotency
job leases
worker heartbeat
recovery
Phase 4 — Distributed Systems

4–5 days

Implement:

multiple workers
concurrency
priority
distributed locking
scheduling
cancellation
Phase 5 — Kafka

2–3 days

Implement:

event publishing
consumers
job lifecycle events
event replay
Phase 6 — Observability

2–3 days

Implement:

Prometheus
Grafana
structured logs
OpenTelemetry
tracing
Phase 7 — Testing

3–4 days

Implement:

unit tests
integration tests
failure tests
load tests
chaos testing
Phase 8 — Cloud

3–4 days

Deploy:

AWS
 ↓
ALB
 ↓
API
 ↓
Workers
 ↓
Redis
Postgres
Kafka

You can initially use managed services where practical rather than self-hosting everything.

35. What NOT to Build

Do not turn this into:

❌ Todo app
❌ E-commerce app
❌ Generic MERN dashboard
❌ Simple BullMQ wrapper
❌ "Redis queue demo"
❌ Kafka producer/consumer tutorial
❌ 50 microservices
❌ Kubernetes before the fundamentals work

The point is to understand the queue engine, not to collect technologies.

36. The Most Important Differentiator

I want you to do something most student projects don't:

Build the queue yourself.

Don't simply do:

queue.add(job)

using BullMQ and call it a distributed queue.

Instead:

Redis Streams
     ↓
Consumer Groups
     ↓
Worker
     ↓
Acknowledgement
     ↓
Retry
     ↓
DLQ
     ↓
Recovery

Then, after your implementation works, create a benchmark:

TaskFlow vs BullMQ

Compare:

throughput
latency
failure recovery
memory
CPU
worker scaling

That gives you an incredible interview discussion.

37. Resume Positioning

Eventually, your resume bullet should look approximately like:

Resilient TaskFlow — Distributed Task Queue | TypeScript, Node.js, Redis Streams, PostgreSQL, Kafka, Docker, AWS

Then:

Built a distributed task-processing platform with Redis Streams, horizontally scalable workers, priority scheduling, exponential backoff, idempotency, dead-letter queues and worker failure recovery.

Then add your measured numbers, e.g.:

Benchmarked X jobs/sec across Y workers with Z ms P95 latency, while maintaining X% successful processing under simulated worker failures.

The numbers must come from your actual benchmark.

Your hiring reports specifically recommend quantified project outcomes and working GitHub repositories rather than vague project descriptions.

38. Final Tech Stack I Want YOU to Use
Core
TypeScript
Node.js
Express
PostgreSQL
Redis
Distributed Systems
Redis Streams
Kafka
Redpanda
Distributed Locks
Consumer Groups
Worker Pools
Backend
REST
Zod
Drizzle
JWT
OpenAPI
Testing
Vitest
Supertest
k6
DevOps
Docker
Docker Compose
GitHub Actions
AWS ECS/Fargate
AWS ALB
Observability
Pino
Prometheus
Grafana
OpenTelemetry
Optional V2
Go
Kubernetes
Terraform
gRPC
⭐ My recommendation for your career strategy

Don't learn Java + Spring Boot + Go + Node simultaneously just to make this project.

You already have MERN + TypeScript + Redis.

Exploit that advantage.

Your progression should be:

MERN knowledge
      ↓
Node + TypeScript backend
      ↓
PostgreSQL
      ↓
Redis
      ↓
Redis Streams
      ↓
Kafka
      ↓
Distributed systems
      ↓
Docker
      ↓
AWS
      ↓
Observability
      ↓
System Design

That converts your current skillset into a serious backend/SDE profile.

And it aligns unusually well with what you're already targeting: your career blueprint calls for backend strength, system design, PostgreSQL/Redis and distributed systems, while the hiring intelligence specifically highlights a distributed task queue as a high-signal SDE project.