# System overview

TaskFlow accepts jobs over HTTP, stores them in PostgreSQL, hands them to workers through Redis Streams and records every outcome back in PostgreSQL. This page describes what the code does today; the diagrams are in the [README](../../README.md).

## Components

| Component                    | Runs as             | Responsibility                                                                                                                   |
| ---------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| API (`apps/api`)             | Fastify process(es) | Authentication, rate limiting, validation, job creation/query/cancel/retry, queue and worker controls, audit, `/metrics`         |
| PostgreSQL                   | Database            | Source of truth: jobs, attempts, events, leases, workers, dead letters, idempotency keys, API keys, the delivery outbox          |
| Redis                        | Streams and locks   | One stream per queue (`taskflow:queue:{queue}:jobs`), consumer group `taskflow:workers`, rate-limit counters, the retention lock |
| Worker (`apps/worker`)       | One process         | Runs four loops: the **dispatcher**, the **worker pool**, the **scheduler** and the **retention scheduler**                      |
| Dashboard (`apps/dashboard`) | Static SPA + nginx  | Reads and controls jobs, dead letters, queues and workers through the API                                                        |
| Prometheus, Grafana          | Optional            | Scrape the API (admin key) and each worker; one provisioned dashboard                                                            |

Redis holds no state that cannot be rebuilt from PostgreSQL. Losing the streams is recoverable because published deliveries of non-terminal jobs are re-published.

## Request path (job submission)

1. The API authenticates the caller (database-backed `X-API-Key`, or a signed JWT), applies the per-user rate limit and validates the body.
2. In **one PostgreSQL transaction** it inserts the job, a `created`/`queued` event and a `PENDING` row in `job_deliveries` (the outbox). An `Idempotency-Key` is checked in the same transaction under an advisory lock, so a repeated request replays the original response and a different body with the same key returns `409`.
3. It returns `201` with the job. The job itself is never written to Redis by the API, so a crash cannot leave a job saved but never queued. (The rate limiter does use Redis; see the security model for what happens when it is down.)

## Delivery path

1. The **dispatcher** claims due outbox rows (`FOR UPDATE SKIP LOCKED`, highest priority first, only as many as fit in the queue's in-flight window), runs `XADD`, and records the Redis message id (`PUBLISHED`). See [ADR-012](../decisions/012-priority-window.md).
2. A **worker** reads with `XREADGROUP` on its own Redis connection, then acquires a fenced lease in PostgreSQL (`jobs.lease_id`, `lease_expires_at`, `version`) and records an attempt.
3. The handler runs. The lease is renewed on an interval; renewal writes no events.
4. The worker commits the outcome (`SUCCEEDED`, a retry, `DEAD_LETTERED` or `CANCELLED`) in a transaction that checks the lease, and only then sends `XACK`.
5. The **scheduler** promotes delayed jobs (`CREATED` with a future `scheduled_at`) to `QUEUED` plus an outbox row when they fall due. A retry is a new outbox row (the successor delivery) that becomes available after an exponential backoff delay with a cap.

## Recovery

| Failure                               | What happens                                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| API crashes after the transaction     | Nothing to repair: job and outbox row are committed together                                                               |
| Worker crashes mid-job (`SIGKILL`)    | Lease expires (30 s default); another worker reclaims the pending entry and re-runs the job; the attempt counts            |
| Worker stopped gracefully (`SIGTERM`) | Running jobs finish or are handed back with the attempt refunded ([ADR-011](../decisions/011-shutdown-releases-leases.md)) |
| Crash between commit and `XACK`       | The entry is redelivered; the worker finds the job terminal and only acknowledges                                          |
| Redis loses data                      | The dispatcher re-publishes deliveries whose jobs are not terminal                                                         |
| Dispatcher dies holding claimed rows  | The claim lease times out and another dispatcher takes them                                                                |

Details and test coverage: [failure model](../failure-model/README.md), [leases](../leases-and-heartbeats.md), [Redis delivery contract](redis-streams.md).

## Invariants

- PostgreSQL decides job state; a status change is rejected unless it is in the transition table ([state machine](state-machine.md)), which is enforced before every status update.
- At most one live lease per job; a result commit that lost its lease is refused.
- A terminal job is not executed again.
- Delivery is at-least-once. Handlers may run more than once and must make external effects idempotent.

## Scaling, as measured

On one laptop, one API process accepted about 500 jobs/s within a 1-second p99, and workers drained about 200 to 250 jobs/s regardless of whether 1, 2 or 4 were running, because PostgreSQL (commits and CPU) was the limit ([results](../benchmarking/RESULTS.md)). Nothing here has been measured on separate hosts, so no multi-machine scaling claim is made. The expected pressure points are PostgreSQL write throughput (about 5 transactions per job) and, for priority-sensitive workloads, the in-flight window size.

## Security model

- API keys are random, shown once, and stored as a salted HMAC (`API_KEY_HASH_SALT`); changing the salt invalidates every key. JWTs are verified with `JWT_SECRET`.
- Roles are `user` and `admin` (read from the database on each request). Job routes are scoped to the owner; queue pause/resume, worker stop, audit of other users and `/metrics` need `admin`.
- Rate limits are per user and per request class (submission, mutation, read, metrics) and configurable by environment variable. If the limiter's Redis is unavailable, submission and mutation requests are rejected with `503` (fail closed) while reads and `/metrics` are allowed (fail open).
- Health probes are public and reveal nothing about dependencies. Swagger UI is disabled in production.
- The worker `/metrics` endpoint is unauthenticated and must stay on an internal network. There is no TLS termination in this repository.
