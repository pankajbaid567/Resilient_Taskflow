# Resilient TaskFlow

TaskFlow is a learning and testable reference implementation of a PostgreSQL-backed job lifecycle delivered through Redis Streams. It is not a production-readiness claim and has no published benchmark results.

## Supported core

- `apps/api`: authenticated HTTP job and operational-control API
- `apps/worker`: the only supported worker process entry point
- `packages/worker`: worker runtime library used by `apps/worker`; it is not a second process entry point
- `packages/database`: PostgreSQL schema, migrations, repositories, lifecycle events, leases, retry/dead-letter persistence, and durable delivery outbox
- `packages/queue`: shared Redis stream transport
- `packages/types`: shared states and versioned queue-envelope contract

The dashboard, Kafka package, load scripts, and deployment examples are deferred. They are not evidence of supported scale, availability, or deployability.

## Delivery invariant

PostgreSQL is authoritative for job state. An API-created due job and its outbox delivery intent commit together. The dispatcher publishes the shared versioned envelope to `taskflow:queue:{queue}:jobs`; workers consume through consumer group `taskflow:workers`. A worker acknowledges the Redis entry only after a durable terminal state is committed. Pending entries and durable redispatch recover interrupted delivery.

This provides at-least-once handler execution. A committed terminal job is not executed again after a commit-before-ACK crash, but handler execution and arbitrary external effects can still be duplicated before terminal persistence. Handlers must make external effects idempotent; TaskFlow does not claim exactly-once external effects.

Canonical states are:

`CREATED → QUEUED → PROCESSING → SUCCEEDED`

Failures may transition through `FAILED` and `RETRY_SCHEDULED`, then return to `QUEUED` or finish as `DEAD_LETTERED`. Cancellation uses `CANCEL_REQUESTED` and `CANCELLED`.

## Operational controls

- `POST /api/v1/queues/:name/pause` and `/resume` require an admin and persist queue admission in PostgreSQL. Pause does not interrupt already-running handlers.
- `POST /api/v1/workers/:id/stop` requires an admin, persists `STOPPING`, and is observed by the worker heartbeat for graceful whole-process shutdown.
- `POST /api/v1/jobs/:id/retry` requires authentication and ownership. It accepts an unrequeued `DEAD_LETTERED` job, atomically creates one new job/outbox intent, and rejects repeated retries.
- `/health/live` and `/health/ready` are public minimal probes. `/metrics` is authenticated and admin-only.

## Local verification

Docker must be running for the process and migration gates.

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm build
pnpm test
pnpm test:migrations
pnpm test:api-runtime
pnpm test:observability-integration
pnpm test:worker-integration
```

The worker integration suite starts actual worker processes and Dockerized PostgreSQL/Redis. It covers the API-to-worker lifecycle, Redis pending inspection, commit-before-ACK recovery, worker kill/replacement, transient lease-database failure, retry exhaustion/backoff/dead-lettering, idempotent local effects, queue pause/resume, worker stop, and manual retry.

See [`docs/testing.md`](docs/testing.md), [`docs/api-documentation.md`](docs/api-documentation.md), and [`docs/P2_SCOPE.md`](docs/P2_SCOPE.md).

## Current limitations

- No exactly-once guarantee for arbitrary external effects.
- Kafka, load testing, dashboard enhancement, retention automation, audit-log APIs, and production deployment configuration are outside the completed milestone.
- Public readiness performs dependency checks, but deliberately hides dependency details.
- Admin-only Prometheus scraping requires a provisioned database-backed admin API key or JWT.
- The Docker suites prove the documented local failure scenarios; they do not establish throughput, multi-region behavior, availability targets, or production readiness.
