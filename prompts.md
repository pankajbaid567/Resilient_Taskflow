> Historical planning input only. It is not current implementation status or acceptance evidence.

Below is the **`prompts.md`** I would use with Claude Opus / another coding agent. It is deliberately phased: the agent should **not try to build the entire distributed system in one shot**, because the difficult parts are correctness, failure semantics, concurrency, idempotency, recovery, and benchmarking.

```md
# PROMPTS.md

# RESILIENT TASKFLOW

## Production-Grade Distributed Task Queue

### TypeScript + Fastify + Redis Streams + PostgreSQL + Kafka/Redpanda

---

# 0. MASTER PROJECT CONTEXT

You are the principal engineer responsible for building **Resilient TaskFlow**, a production-grade distributed task queue and asynchronous job-processing platform.

This is NOT a CRUD project.

The primary purpose is to demonstrate deep understanding of:

- distributed systems
- asynchronous job processing
- queues
- worker pools
- concurrency
- failure recovery
- retries
- idempotency
- leases
- distributed locks
- scheduling
- event-driven architecture
- PostgreSQL transactions
- Redis Streams
- Kafka
- observability
- performance engineering
- testing
- Docker
- CI/CD
- cloud deployment

The project is intended for an engineering portfolio targeting:

1. SDE Intern
2. Backend Intern
3. Backend + AI Intern
4. Platform / Infrastructure Intern

The implementation must be production-quality, deeply documented, measurable, and interview-defensible.

---

# 1. NON-NEGOTIABLE ARCHITECTURAL DECISIONS

Do NOT change these decisions without explicitly explaining why and receiving approval.

## Language

TypeScript.

## Runtime

Node.js LTS.

## HTTP framework

Fastify.

Do NOT use Express.

## Database

PostgreSQL.

PostgreSQL is the source of truth for durable job state.

## ORM

Drizzle ORM.

Use raw SQL where necessary for:

- transactions
- row locking
- atomic state transitions
- performance-critical operations
- PostgreSQL-specific functionality

Do not hide important distributed-system behavior behind the ORM.

## Queue

Redis Streams.

Use:

- streams
- consumer groups
- pending entries
- explicit acknowledgement
- reclaiming stale messages

Do NOT use BullMQ as the core queue implementation.

The goal is to demonstrate understanding of queue internals.

## Event bus

Kafka-compatible Redpanda for local development.

Kafka-compatible architecture should be preserved so Kafka can be used in production.

Redis Streams = task delivery.

Kafka = domain/system events.

Do NOT use Kafka as the primary job queue in V1.

## Cache / ephemeral state

Redis.

Use it for:

- rate limiting
- worker heartbeats
- distributed locks where appropriate
- temporary state
- queue statistics cache

## Validation

Zod.

## Logging

Pino.

## Metrics

Prometheus.

## Visualization

Grafana.

## Distributed tracing

OpenTelemetry.

## Testing

Vitest.

Supertest is acceptable only if required by the HTTP testing setup; prefer Fastify's native injection where practical.

## Load testing

k6.

## Containers

Docker.

Docker Compose for local development.

## CI/CD

GitHub Actions.

## Monorepo

pnpm workspaces + Turborepo.

If Turborepo adds unnecessary complexity, use pnpm workspaces, but preserve clean package boundaries.

---

# 2. CORE ARCHITECTURE

The intended architecture is:

Client
|
v
Load Balancer
|
v
Fastify API
|
+--------------------+
| |
v v
PostgreSQL Redis
| |
| v
| Redis Streams
| |
| +------+------+------+
| | | | |
| v v v v
| W1 W2 W3 WN
| | | | |
+-------------+------+------+
|
v
Job State

Job lifecycle events
|
v
Kafka
|
+--> analytics consumer
+--> audit consumer
+--> notification consumer
+--> metrics consumer

Observability:

API / Workers
|
+--> Pino
+--> Prometheus
+--> OpenTelemetry
|
+--> Grafana
```

---

# 3. SOURCE-OF-TRUTH RULE

This is critical.

PostgreSQL is the authoritative source for durable job state.

Redis Streams are the delivery mechanism.

Kafka is the event propagation mechanism.

Redis ephemeral data must never be treated as the permanent source of truth.

If Redis disappears, the system must be capable of recovering durable state from PostgreSQL.

---

# 4. JOB STATE MACHINE

Implement an explicit state machine.

Allowed states:

CREATED
QUEUED
PROCESSING
SUCCEEDED
FAILED
RETRY_SCHEDULED
CANCEL_REQUESTED
CANCELLED
DEAD_LETTERED

Do NOT allow arbitrary status updates.

Every state transition must be validated.

Example:

CREATED -> QUEUED
QUEUED -> PROCESSING
PROCESSING -> SUCCEEDED
PROCESSING -> FAILED
FAILED -> RETRY_SCHEDULED
RETRY_SCHEDULED -> QUEUED
FAILED -> DEAD_LETTERED
QUEUED -> CANCELLED
PROCESSING -> CANCEL_REQUESTED
CANCEL_REQUESTED -> CANCELLED

Document every valid and invalid transition.

---

# 5. JOB MODEL

Every job should support:

- id
- queue
- type
- payload
- priority
- status
- attempts
- maxAttempts
- timeout
- idempotencyKey
- scheduledAt
- createdAt
- startedAt
- completedAt
- failedAt
- workerId
- leaseId
- leaseExpiresAt
- result
- error
- metadata

Never store sensitive payloads unnecessarily in logs.

---

# 6. CORE GUARANTEES

The system should aim for:

## At-least-once delivery

Jobs may be delivered more than once.

The system must therefore support idempotent processing.

Do NOT claim exactly-once execution.

Exactly-once semantics should NOT be advertised unless technically proven for a specific operation.

## Durable job state

Job state must survive API crashes.

## Worker failure recovery

If a worker dies during processing, the job must eventually become recoverable.

## Retry safety

Retries must not cause uncontrolled retry storms.

## Idempotency

Duplicate job submission must be safely handled when an idempotency key is supplied.

## Backpressure

The system must avoid unlimited in-memory job accumulation.

## Graceful shutdown

Workers must stop accepting new work and finish/release active work safely.

---

# 7. FAILURE MODEL

Explicitly design for:

- API crash
- worker crash
- worker network partition
- Redis restart
- PostgreSQL restart
- Kafka restart
- duplicate delivery
- delayed delivery
- message acknowledgement failure
- job timeout
- job handler failure
- malformed payload
- poison job
- retry storm
- database transaction failure
- partial system failure

Every failure scenario must have:

1. detection mechanism
2. recovery mechanism
3. consistency implications
4. test case
5. observability signal

---

# 8. SECURITY REQUIREMENTS

Implement:

- API authentication
- API keys
- role-based authorization
- request validation
- payload size limits
- rate limiting
- secure headers
- CORS
- secrets through environment variables
- no secrets committed to Git
- SQL injection prevention
- audit logging
- safe error responses

Never expose:

- database credentials
- Redis credentials
- Kafka credentials
- API keys
- internal stack traces in production

---

# 9. ENGINEERING RULES

## DO

- write tests before/alongside complex behavior
- use strict TypeScript
- use explicit types
- use dependency injection where useful
- use structured logging
- use transactions for state transitions
- document distributed-system assumptions
- measure performance
- test failures
- keep services independently testable
- keep commits focused
- maintain a clean README

## DO NOT

- use `any` unless absolutely justified
- use global mutable state
- silently swallow errors
- use arbitrary `setTimeout` hacks for reliability
- claim exactly-once processing
- hide queue semantics behind BullMQ
- add microservices without justification
- introduce Kubernetes early
- optimize before measuring
- fabricate benchmark numbers
- over-engineer authentication
- create 20 services just to appear distributed

---

# 10. REPOSITORY TARGET

Use:

resilient-taskflow/

```
apps/
    api/
    worker/
    dashboard/

packages/
    config/
    database/
    queue/
    types/
    logger/
    observability/
    job-runtime/

tests/
    unit/
    integration/
    failure/
    load/

infrastructure/
    docker/
    prometheus/
    grafana/
    redpanda/

docs/
    architecture/
    api/
    reliability/
    failure-model/
    benchmarking/
    decisions/

scripts/

.github/
    workflows/

docker-compose.yml
package.json
pnpm-workspace.yaml
turbo.json
README.md
```

---

# PHASE 0 — ARCHITECTURE REVIEW

## PROMPT

Before writing any implementation code:

Study this entire project specification.

Do NOT start coding.

Produce:

1. complete architecture
2. component responsibilities
3. service boundaries
4. database schema proposal
5. Redis Streams design
6. consumer-group design
7. Kafka topic design
8. job state machine
9. failure model
10. retry strategy
11. idempotency strategy
12. lease strategy
13. worker lifecycle
14. graceful shutdown strategy
15. scheduling strategy
16. cancellation strategy
17. rate-limiting strategy
18. observability architecture
19. testing architecture
20. deployment architecture
21. security model
22. key architectural risks
23. alternatives considered
24. Architecture Decision Records

Pay special attention to race conditions.

For every critical operation explain:

- what can happen concurrently
- what can fail
- what transaction boundary exists
- what guarantees are provided

Do not implement until the architecture is internally consistent.

---

# PHASE 1 — PROJECT FOUNDATION

## PROMPT

Implement the repository foundation.

Requirements:

- pnpm
- TypeScript strict mode
- Turborepo/workspaces
- Fastify
- PostgreSQL
- Drizzle
- Redis client
- Redpanda/Kafka client
- Zod
- Pino
- Vitest
- Docker
- environment configuration
- linting
- formatting
- Git hooks if useful

Create:

apps/api
apps/worker
apps/dashboard

packages:

config
database
types
logger
observability

Requirements:

- clean dependency boundaries
- no circular dependencies
- no business logic inside route files
- environment validation at startup
- graceful shutdown skeleton
- health endpoints

Implement:

GET /health
GET /ready
GET /metrics

Add unit tests.

Do not implement the queue yet.

At the end:

1. run tests
2. run typecheck
3. run lint
4. run Docker Compose
5. verify health endpoints

Fix all issues before finishing.

---

# PHASE 2 — DATABASE AND JOB DOMAIN

## PROMPT

Implement the durable job domain.

Create PostgreSQL schema for:

users
queues
jobs
job_attempts
workers
job_events
idempotency_keys
dead_letter_jobs

Design indexes deliberately.

Implement the job state machine.

Requirements:

- explicit valid transitions
- invalid transitions rejected
- transactional state changes
- optimistic/concurrency-safe updates where required
- timestamps
- UUID/ULID identifiers
- appropriate JSONB usage
- constraints
- foreign keys
- indexes

Create domain services rather than placing logic in routes.

Implement repository tests.

Add tests for:

- valid transitions
- invalid transitions
- concurrent state changes
- transaction rollback
- idempotency uniqueness

Document the state machine.

---

# PHASE 3 — REDIS STREAM QUEUE ENGINE

## PROMPT

Implement the queue engine from first principles using Redis Streams.

Do NOT use BullMQ.

Implement:

- stream creation
- consumer groups
- producers
- consumers
- acknowledgement
- pending-entry inspection
- stale-message recovery
- consumer identification
- graceful consumer shutdown

Define:

queue naming
consumer group naming
message format
versioning

Example message:

{
jobId,
queue,
attempt,
createdAt,
schemaVersion
}

The Redis message must NOT become the durable source of truth.

The worker must always reconcile message processing with PostgreSQL state.

Implement queue abstractions so business logic does not directly depend on Redis commands.

Add integration tests using a real Redis container.

Test:

- enqueue
- consume
- acknowledge
- duplicate delivery
- pending messages
- consumer restart
- stale consumer recovery

---

# PHASE 4 — JOB SUBMISSION API

## PROMPT

Implement the public job API.

Endpoints:

POST /api/v1/jobs
GET /api/v1/jobs/:id
POST /api/v1/jobs/:id/cancel
POST /api/v1/jobs/:id/retry

Also:

GET /api/v1/queues
GET /api/v1/queues/:queue/stats

Implement:

- Zod validation
- authentication
- authorization
- idempotency
- rate limiting
- pagination
- consistent error responses
- OpenAPI documentation

Critical requirement:

Job creation must handle the PostgreSQL + Redis consistency problem carefully.

Do not blindly:

1. insert DB row
2. enqueue Redis message

without thinking about failure between the two operations.

Design and implement a reliable enqueue strategy.

Document the chosen approach and its trade-offs.

---

# PHASE 5 — WORKER ENGINE

## PROMPT

Implement the TypeScript worker runtime.

Worker responsibilities:

1. consume job
2. validate job
3. acquire processing ownership
4. update PostgreSQL state
5. execute handler
6. record attempt
7. persist result
8. publish lifecycle event
9. acknowledge message

Implement a handler registry:

job type -> handler

Example handlers:

send_email
generate_report
resize_image
process_webhook
simulate_failure
sleep
cpu_task

Handlers must be independently testable.

Do NOT put job-specific logic directly inside the worker loop.

Implement configurable worker concurrency.

Example:

WORKER_CONCURRENCY=10

Implement backpressure.

Do not create unlimited promises.

Add graceful shutdown.

---

# PHASE 6 — RETRIES AND BACKOFF

## PROMPT

Implement production-grade retry behavior.

Requirements:

- configurable max attempts
- exponential backoff
- jitter
- retryable vs non-retryable errors
- retry scheduling
- retry metadata
- attempt records
- DLQ transition

Example:

attempt 1 -> 1 sec
attempt 2 -> 2 sec
attempt 3 -> 4 sec
attempt 4 -> 8 sec

Add configurable maximum backoff.

Implement retry storm protection.

Tests must cover:

- retryable errors
- permanent errors
- maximum attempts
- backoff correctness
- jitter range
- DLQ transition
- duplicate delivery during retry

Do not rely solely on application timers for durable scheduling.

---

# PHASE 7 — IDEMPOTENCY

## PROMPT

Implement robust idempotent job submission and execution.

Support:

Idempotency-Key HTTP header.

Requirements:

- same key + same request -> same job
- same key + different request -> conflict
- concurrent identical requests -> one job
- database uniqueness enforcement
- safe retry after API crash

Also design handler-level idempotency.

Explain why queue-level at-least-once delivery means handlers themselves must be designed carefully.

Create race-condition tests using concurrent requests.

---

# PHASE 8 — LEASES AND WORKER HEARTBEATS

## PROMPT

Implement worker leases.

A worker must obtain a lease before processing.

Lease includes:

- leaseId
- workerId
- jobId
- acquiredAt
- expiresAt

Workers must periodically renew the lease.

Implement heartbeat:

workerId
status
currentJob
lastHeartbeat

Use Redis for ephemeral heartbeat state.

PostgreSQL remains the durable state source.

If a worker dies:

1. heartbeat becomes stale
2. lease expires
3. job becomes recoverable
4. another worker can process it
5. duplicate execution must be safely handled

Test:

- worker crash
- lease expiry
- worker pause
- delayed heartbeat
- duplicate worker recovery

---

# PHASE 9 — PRIORITY AND SCHEDULING

## PROMPT

Implement priority-aware queues.

Support:

CRITICAL
HIGH
NORMAL
LOW

Workers should prefer higher-priority work while avoiding starvation.

Implement delayed jobs:

scheduledAt

Support:

- immediate jobs
- delayed jobs
- retry-delayed jobs

Do not build a naive polling loop that constantly queries PostgreSQL.

Design an efficient scheduling mechanism using Redis and/or a dedicated scheduler process.

Document the trade-offs.

Test:

- priority ordering
- starvation prevention
- delayed execution
- scheduler restart
- duplicate scheduling

---

# PHASE 10 — CANCELLATION

## PROMPT

Implement cancellation semantics.

States:

QUEUED -> CANCELLED

PROCESSING -> CANCEL_REQUESTED -> CANCELLED

Requirements:

- queued jobs should be cancellable
- running jobs should support cooperative cancellation
- cancellation must be race-safe
- completed jobs cannot be cancelled
- cancellation should be idempotent

Implement AbortController or equivalent cancellation propagation for handlers.

Add race-condition tests.

---

# PHASE 11 — KAFKA / REDPANDA EVENTS

## PROMPT

Introduce Kafka-compatible event streaming using Redpanda locally.

Kafka is for events, NOT primary task delivery.

Create topics:

taskflow.job.created
taskflow.job.started
taskflow.job.completed
taskflow.job.failed
taskflow.job.retried
taskflow.job.cancelled
taskflow.job.dead_lettered

Define versioned event schemas.

Implement event producer.

Implement at least two consumers:

1. analytics consumer
2. audit consumer

Requirements:

- idempotent consumers
- consumer groups
- offsets
- retries
- dead-letter handling for events
- schema versioning

Document:

Redis Streams vs Kafka responsibilities.

---

# PHASE 12 — RATE LIMITING

## PROMPT

Implement distributed API rate limiting using Redis.

Use a well-defined algorithm:

- token bucket
  OR
- sliding window

Support per-user and/or per-API-key limits.

Example:

100 job submissions/minute.

Requirements:

- distributed-safe
- race-safe
- HTTP 429
- Retry-After
- configurable limits
- tests under concurrency

Benchmark the rate limiter.

---

# PHASE 13 — OBSERVABILITY

## PROMPT

Implement production-grade observability.

## Logging

Use Pino.

Structured fields:

requestId
jobId
workerId
queue
attempt
duration
event
error

Never log sensitive payloads.

## Metrics

Prometheus metrics:

jobs_submitted_total
jobs_started_total
jobs_completed_total
jobs_failed_total
jobs_retried_total
jobs_dead_lettered_total
jobs_cancelled_total
jobs_processing
queue_depth
worker_count
worker_failures_total
job_duration_seconds
job_wait_duration_seconds
retry_count

Use counters, gauges and histograms correctly.

## Tracing

Implement OpenTelemetry.

Trace:

HTTP request
job creation
Redis enqueue
worker consumption
job execution
PostgreSQL operation
Kafka publish

Propagate correlation IDs.

---

# PHASE 14 — GRAFANA DASHBOARD

## PROMPT

Create an engineering-focused Grafana dashboard.

Include:

1. throughput
2. queue depth
3. active workers
4. processing jobs
5. success rate
6. failure rate
7. retry rate
8. DLQ count
9. P50 latency
10. P95 latency
11. P99 latency
12. worker failures
13. CPU
14. memory

Dashboard should be useful for diagnosing an incident.

Do not make it visually flashy at the expense of useful engineering information.

---

# PHASE 15 — TESTING

## PROMPT

Perform a complete testing pass.

Create:

## Unit tests

- state machine
- retry logic
- backoff
- idempotency
- priority
- scheduling
- cancellation
- rate limiting
- lease logic

## Integration tests

- API + PostgreSQL
- API + Redis
- worker + Redis
- worker + PostgreSQL
- Kafka events

## End-to-end tests

Submit job
-> queue
-> worker
-> execution
-> result
-> event

## Failure tests

- API crash
- worker crash
- Redis restart
- PostgreSQL restart
- Kafka restart
- duplicate message
- stale lease
- poison job

No major functionality should remain untested.

---

# PHASE 16 — CHAOS TESTING

## PROMPT

Build a controlled chaos testing suite.

Simulate:

- worker process termination
- Redis restart
- Kafka restart
- random job failures
- delayed jobs
- network failures where practical
- worker pauses
- database transient errors

Measure whether:

- jobs are lost
- jobs become stuck
- duplicates occur
- recovery works
- DLQ works
- metrics accurately represent the incident

Do NOT claim zero data loss unless the tests actually prove the specific guarantee.

Create:

docs/reliability/chaos-testing.md

---

# PHASE 17 — LOAD TESTING

## PROMPT

Build k6 load tests.

Scenarios:

1. sustained load
2. spike load
3. worker scaling
4. queue backlog
5. mixed priority
6. high failure rate

Measure:

- requests/sec
- jobs/sec
- P50
- P95
- P99
- error rate
- queue depth
- worker utilization
- memory
- CPU

Benchmark:

1 worker
3 workers
5 workers
10 workers

Do not fabricate any values.

Save actual results in:

docs/benchmarking/results.md

---

# PHASE 18 — PERFORMANCE ENGINEERING

## PROMPT

Analyze the complete system for bottlenecks.

Investigate:

- PostgreSQL query performance
- Redis throughput
- worker concurrency
- serialization
- API overhead
- Kafka publishing
- logging overhead
- tracing overhead

Use profiling where appropriate.

Only optimize based on measurements.

For every optimization document:

Before
After
Improvement
Trade-off

Do not optimize code merely because it looks slow.

---

# PHASE 19 — SECURITY AUDIT

## PROMPT

Perform a security review.

Check:

- authentication
- authorization
- API keys
- rate limiting
- input validation
- payload limits
- SQL injection
- Redis injection risks
- Kafka credentials
- secrets
- CORS
- headers
- error leakage
- logging of sensitive information
- dependency vulnerabilities
- Docker security

Run dependency auditing.

Create:

docs/security/security-audit.md

Document:

finding
severity
impact
fix
verification

---

# PHASE 20 — API DOCUMENTATION

## PROMPT

Create complete OpenAPI documentation.

Document:

- authentication
- job creation
- job retrieval
- cancellation
- retries
- queues
- queue statistics
- workers
- DLQ
- health
- metrics

Every endpoint must specify:

- request schema
- response schema
- error schema
- authentication
- status codes
- examples

Ensure generated OpenAPI matches implementation.

---

# PHASE 21 — DASHBOARD

## PROMPT

Build a minimal but professional React dashboard.

Pages:

/overview
/jobs
/jobs/:id
/queues
/workers
/dlq
/metrics

Show:

- queue depth
- jobs
- worker status
- failures
- retries
- DLQ
- latency

Use polling or SSE/WebSocket where appropriate.

Do not spend excessive time on frontend styling.

The dashboard exists to demonstrate the distributed system.

---

# PHASE 22 — CI/CD

## PROMPT

Create GitHub Actions pipelines.

On pull request:

- install dependencies
- lint
- typecheck
- unit tests
- integration tests
- build

On main:

- build Docker images
- run tests
- security checks
- publish images if configured
- deploy if configured

Use caching carefully.

Never expose secrets in logs.

---

# PHASE 23 — DOCKER PRODUCTION REVIEW

## PROMPT

Review all Dockerfiles.

Requirements:

- multi-stage builds
- minimal runtime image
- non-root user
- deterministic installs
- health checks
- proper signal handling
- graceful shutdown
- no secrets inside image

Optimize image sizes only after measuring.

---

# PHASE 24 — AWS DEPLOYMENT

## PROMPT

Prepare production deployment architecture on AWS.

Target:

ALB
|
API containers
|
Worker containers
|
Managed PostgreSQL
Managed Redis
Kafka-compatible event system

Do not blindly deploy everything before understanding cost.

Prefer managed services where appropriate.

Document:

- networking
- security groups
- secrets
- environment configuration
- autoscaling
- health checks
- logging
- metrics
- rollback

Keep initial infrastructure cost low.

---

# PHASE 25 — ARCHITECTURE REVIEW

## PROMPT

Now act as a principal distributed-systems engineer reviewing the entire project.

Do NOT immediately change code.

Analyze:

1. correctness
2. consistency
3. race conditions
4. failure recovery
5. durability
6. retry behavior
7. idempotency
8. queue semantics
9. worker semantics
10. database transactions
11. Redis usage
12. Kafka usage
13. observability
14. scalability
15. security
16. test coverage
17. operational complexity

Find every architectural weakness.

Rank findings:

P0 = correctness/data-loss risk
P1 = serious reliability issue
P2 = scalability/performance issue
P3 = quality improvement

Then fix P0 and P1 issues first.

---

# PHASE 26 — ADVERSARIAL REVIEW

## PROMPT

Pretend you are interviewing the candidate who built this project for a senior backend/distributed-systems interview.

Try to break the architecture.

Ask:

- What happens if Redis goes down after DB insertion?
- What happens if Redis accepts the job but API crashes before responding?
- What happens if a worker dies after completing a job but before ACK?
- What happens if ACK succeeds but DB update fails?
- What happens if two workers process the same job?
- What happens if a worker heartbeat is delayed?
- What happens if PostgreSQL is unavailable?
- What happens if Kafka is unavailable?
- What happens during retry storms?
- How does priority avoid starvation?
- How does cancellation race with completion?
- How does idempotency work under concurrent requests?
- Why is this at-least-once rather than exactly-once?
- How does horizontal scaling work?
- What is the bottleneck?
- How would you scale from 1K to 100K jobs/sec?
- What would you change at 1M jobs/day?
- What happens during a regional outage?

For every question:

1. inspect implementation
2. identify weaknesses
3. fix them where appropriate
4. document the answer

---

# PHASE 27 — BENCHMARK REPORT

## PROMPT

Produce the final engineering benchmark.

Run real tests.

Measure:

- API throughput
- job throughput
- P50
- P95
- P99
- worker scaling
- CPU
- memory
- queue backlog
- recovery time
- retry overhead

Compare:

1 worker
3 workers
5 workers
10 workers

Also test:

normal load
high load
failure load

Do NOT invent values.

Produce graphs if useful.

Write:

docs/benchmarking/final-report.md

---

# PHASE 28 — README

## PROMPT

Rewrite the README as a world-class engineering project README.

Structure:

# Resilient TaskFlow

One-line description.

## Why this exists

## Architecture

Architecture diagram.

## Core guarantees

Clearly state:

- at-least-once delivery
- idempotency
- durable state
- worker recovery
- retries
- DLQ

## Features

## Tech stack

## Architecture decisions

## Job lifecycle

## Failure handling

## Observability

## Benchmarks

Only use real measured values.

## Local development

One-command startup.

## API

## Testing

## Chaos testing

## Deployment

## Design trade-offs

## What I learned

## Future improvements

Include screenshots/GIFs where useful.

Do not use meaningless marketing language.

---

# PHASE 29 — CODE QUALITY AUDIT

## PROMPT

Perform a final code-quality audit.

Inspect every source file.

Look for:

- duplicated logic
- poor naming
- excessive abstraction
- unnecessary abstraction
- any
- unsafe casts
- race conditions
- swallowed errors
- missing error handling
- bad async patterns
- resource leaks
- connection leaks
- missing timeouts
- missing graceful shutdown
- incorrect transactions
- unbounded memory
- logging problems
- security issues

Fix everything reasonable.

Do not rewrite working code unnecessarily.

---

# PHASE 30 — FINAL PORTFOLIO AUDIT

## PROMPT

Evaluate this project as if you were:

1. Google SDE recruiter
2. Amazon SDE recruiter
3. Microsoft backend recruiter
4. Indian startup CTO
5. Backend engineering interviewer
6. Distributed systems interviewer

Score:

- engineering depth /10
- backend depth /10
- distributed systems /10
- scalability /10
- reliability /10
- testing /10
- observability /10
- DevOps /10
- code quality /10
- resume value /10
- interview value /10

Identify the 5 highest-impact remaining improvements.

Do not recommend adding technologies merely for resume keywords.

---

# 31. FINAL DEFINITION OF DONE

The project is NOT finished until:

[ ] TypeScript strict mode passes
[ ] lint passes
[ ] typecheck passes
[ ] unit tests pass
[ ] integration tests pass
[ ] E2E tests pass
[ ] Redis Streams works
[ ] consumer groups work
[ ] workers work
[ ] retries work
[ ] exponential backoff works
[ ] DLQ works
[ ] idempotency works
[ ] worker leases work
[ ] heartbeat works
[ ] worker recovery works
[ ] priority works
[ ] scheduling works
[ ] cancellation works
[ ] Kafka events work
[ ] rate limiting works
[ ] Prometheus works
[ ] Grafana works
[ ] OpenTelemetry works
[ ] structured logging works
[ ] chaos tests exist
[ ] load tests exist
[ ] real benchmark exists
[ ] Docker works
[ ] CI works
[ ] security audit completed
[ ] API documentation completed
[ ] architecture documentation completed
[ ] README completed
[ ] no fabricated metrics
[ ] no unexplained TODOs
[ ] no critical vulnerabilities
[ ] no major race conditions discovered
[ ] graceful shutdown works
[ ] local setup works with one command

---

# 32. MASTER RULE FOR THE CODING AGENT

At every phase:

1. Inspect the existing code.
2. Understand the current architecture.
3. Plan before modifying.
4. Implement only the current phase.
5. Run tests.
6. Run typecheck.
7. Run lint.
8. Verify Docker/services where applicable.
9. Review for race conditions.
10. Fix discovered issues.
11. Update documentation.
12. Report exactly what changed.
13. Report tests actually executed.
14. Report known limitations.
15. Do NOT claim completion without verification.

Never fabricate:

- benchmark results
- test results
- deployment status
- coverage
- scalability
- reliability guarantees

When uncertain, investigate the repository and documentation first.

Do not ask unnecessary questions when a reasonable engineering decision can be made from this specification.

Prefer simple, correct architecture over unnecessary complexity.

The goal is not to build the largest system.

The goal is to build the **most technically defensible distributed task-processing system possible for a student portfolio.**

```

### The architecture choice I'd lock in

**TypeScript-only** is now the final decision:

**Fastify → PostgreSQL + Redis Streams → TypeScript Worker Pool → Kafka/Redpanda → Prometheus/Grafana/OpenTelemetry**

The particularly important architectural distinction is:

> **PostgreSQL = durable truth**
> **Redis Streams = task delivery**
> **Kafka = event propagation**

That separation is what I would defend in an interview. It also prevents the project from becoming a superficial "Redis queue + Node.js" demo.

And I would **not start with AWS, Kubernetes, or the dashboard**. Build the correctness-critical queue/worker engine first, then add reliability, observability, load testing, and deployment. Your existing hiring research specifically emphasizes distributed queues, system-design implementations, deployed projects, and measurable outcomes rather than technology-counting. :contentReference[oaicite:0]{index=0} :contentReference[oaicite:1]{index=1}

```
