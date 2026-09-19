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
`TASKFLOW_TEST_AFTER_COMMIT_BARRIER_KEY`,
`TASKFLOW_TEST_CRASH_AFTER_COMMIT` failure hooks, plus the
`TASKFLOW_TEST_STALE_THRESHOLD_MS`, `TASKFLOW_TEST_POLL_INTERVAL_MS`,
`TASKFLOW_TEST_SHUTDOWN_TIMEOUT_MS`, `TASKFLOW_TEST_SCHEDULER_INTERVAL_MS`,
`TASKFLOW_TEST_DISPATCH_CLAIM_TIMEOUT_MS`, and
`TASKFLOW_TEST_DISPATCH_STALE_THRESHOLD_MS` timing overrides and the
`TASKFLOW_TEST_DATABASE_CONNECT_TIMEOUT_SECONDS` database-driver timeout, are
active only when
`NODE_ENV=test`; they exist solely for the process-level integration suite.

## Delivery guarantees

- PostgreSQL is authoritative for job state. Redis delivery is acknowledged
  only after PostgreSQL commits `SUCCEEDED`, `CANCELLED`, or
  `DEAD_LETTERED`.
- Unacknowledged entries remain in the Redis consumer-group pending-entry list.
  Workers reclaim idle entries with cursor-based `XAUTOCLAIM`; database lease IDs fence stale
  workers from committing.
- Handler execution is at least once. A process death during a handler can run
  that handler again after lease expiry. External effects therefore require an
  idempotency key or another handler-owned deduplication mechanism.
- A crash after terminal commit but before `XACK` does not rerun the handler:
  the replacement worker observes the terminal database row and only
  acknowledges the pending entry.
- Job creation/promotion and its `job_deliveries` intent are one PostgreSQL
  transaction. This entry point starts the scheduler and dispatcher; the
  dispatcher performs `XADD` from durable pending intents and recovers stale
  claims. A crash after `XADD` but before recording publication can duplicate a
  Redis entry, so delivery remains at least once.
- The dispatcher checks old published deliveries and republishes when the
  recorded entry is missing or no longer deliverable by the authoritative
  consumer group, including after an expired processing/cancellation lease.
  Redis is still not the source of truth.
- A noncooperative JavaScript handler cannot be stopped in-process. On a process
  signal, the entry point observes the configured drain deadline and then exits;
  replacement workers recover the still-pending delivery after lease expiry.

## Process-level verification

With Docker running, execute:

```sh
pnpm test:worker-integration
```

The suite creates an isolated PostgreSQL/Redis Compose project, runs the real
migration runner, starts real worker processes, sends jobs through the Fastify
API route, and exercises delayed scheduling, cancellation, `SIGKILL`, database
interruption, post-commit/pre-ack crash, retry exhaustion, and
replacement-worker recovery. It tears down its containers and named volume
afterward.
