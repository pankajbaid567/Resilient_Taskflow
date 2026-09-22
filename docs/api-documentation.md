# API contract

The API is mounted under `/api/v1`. API routes and `/metrics` accept a database-backed `X-API-Key` or signed bearer JWT. Job routes are tenant-scoped. Queue and worker controls require the current database role to be `admin`.

## Jobs

- `POST /jobs` creates a job. A due job returns `QUEUED`; a future job returns `CREATED`. The optional `Idempotency-Key` is scoped to the user and request body. Same content replays the original response; different content returns `409`.
- `GET /jobs` lists the caller's jobs with validated `status`, `limit`, and `offset`.
- `GET /jobs/:id` returns an owned job or `404`.
- `DELETE /jobs/:id` requests or completes cancellation according to current state.
- `POST /jobs/:id/retry` accepts only an owned, unrequeued `DEAD_LETTERED` job. It returns `201` with a new job, `404` across tenant boundaries, and `409` for an invalid/repeated retry or paused queue.

The shared response uses the real queue name and canonical uppercase states: `CREATED`, `QUEUED`, `PROCESSING`, `SUCCEEDED`, `FAILED`, `RETRY_SCHEDULED`, `CANCEL_REQUESTED`, `CANCELLED`, and `DEAD_LETTERED`.

## Queues

- `GET /queues` lists durable configuration.
- `GET /queues/:name/stats` combines PostgreSQL statistics, Redis depth, and active-worker count.
- `POST /queues/:name/pause` and `/resume` require admin authorization and persist `isActive`. Pause rejects new submissions and prevents pending delivery/lease acquisition; it does not interrupt an in-flight handler.

## Workers

- `GET /workers`, `GET /workers/:id`, and `GET /workers/:id/stats` read PostgreSQL worker records.
- `POST /workers/:id/stop` requires admin authorization. It persists `STOPPING` and returns `202`; the live worker observes the request on heartbeat, drains, closes worker-owned infrastructure, and persists `STOPPED`. An already terminal worker returns `409`.
- Operational audit rows cover authenticated requests that reach an authorized control handler. Authentication and authorization failures remain in structured security logs and do not create durable operational-audit rows.

## Operational audit

- `GET /audit` returns operational control records with validated `action`, `outcome`, `actorUserId`, `limit`, and `offset` filters.
- Ordinary users are always scoped to their own actor ID. Administrators may query all actors or select one actor.
- Queue pause/resume, worker stop, and manual retry record actor ID/role, request ID, target, outcome, status code, timestamp, and bounded metadata. Credentials and job payloads are not stored.
- Decisions for existing resources commit their audit record in the same PostgreSQL transaction as the mutation or rejection. A hidden/missing-resource `404` is recorded in a separate transaction because there is no target mutation.

## Probes and metrics

- Public `GET /health/live` returns only `{ "status": "alive" }`.
- Public `GET /health/ready` checks PostgreSQL and Redis and returns only `ready` or `not_ready`, with `200` or `503`.
- `GET /metrics` requires an authenticated admin and returns Prometheus text.

Interactive Swagger is disabled in production. Invalid input returns `400`, failed authentication `401`, insufficient role `403`, hidden/missing tenant resources `404`, state/idempotency conflicts `409`, unavailable safety dependencies `503`, and unexpected errors `500`.
