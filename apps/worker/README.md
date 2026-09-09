# TaskFlow worker entry point

`apps/worker/src/index.ts` is the single executable worker entry point. Run it
from the repository root with:

```sh
pnpm dev:worker
```

The application registers job handlers and owns process startup/shutdown only.
All queue consumption, leases, retries, stale-message recovery, terminal-state
persistence, and Redis acknowledgement ordering are implemented by the
canonical `@taskflow/worker` runtime in `packages/worker`.

The `test-idempotent` handler and the
`TASKFLOW_TEST_BEFORE_LEASE_DELAY_MS`,
`TASKFLOW_TEST_AFTER_COMMIT_DELAY_MS`, and
`TASKFLOW_TEST_CRASH_AFTER_COMMIT` failure hooks, plus the
`TASKFLOW_TEST_STALE_THRESHOLD_MS` and `TASKFLOW_TEST_POLL_INTERVAL_MS` timing
overrides and the
`TASKFLOW_TEST_DATABASE_CONNECT_TIMEOUT_SECONDS` database-driver timeout, are
active only when
`NODE_ENV=test`; they exist solely for the process-level integration suite.

## Delivery guarantees

- PostgreSQL is authoritative for job state. Redis delivery is acknowledged
  only after PostgreSQL commits `SUCCEEDED`, `CANCELLED`, or
  `DEAD_LETTERED`.
- Unacknowledged entries remain in the Redis consumer-group pending-entry list.
  Workers reclaim idle entries with `XCLAIM`; database lease IDs fence stale
  workers from committing.
- Handler execution is at least once. A process death during a handler can run
  that handler again after lease expiry. External effects therefore require an
  idempotency key or another handler-owned deduplication mechanism.
- A crash after terminal commit but before `XACK` does not rerun the handler:
  the replacement worker observes the terminal database row and only
  acknowledges the pending entry.
- Database creation and Redis `XADD` are not one atomic transaction. The
  existing scheduler can redispatch `CREATED` rows, but this entry point does
  not start that scheduler; a production topology must run it or adopt an
  outbox. A delivery whose database row is absent is retained pending.

## Process-level verification

With Docker running, execute:

```sh
pnpm test:worker-integration
```

The suite creates an isolated PostgreSQL/Redis Compose project, starts real
worker processes, sends jobs through the Fastify API route, and exercises
`SIGKILL`, database interruption, post-commit/pre-ack crash, retry exhaustion,
and replacement-worker recovery. It tears down its containers and named volume
afterward.
