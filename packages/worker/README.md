# `@taskflow/worker`

This package contains TaskFlow's canonical worker runtime library. It is not a
second executable worker.

The only supported process entry point is
[`apps/worker/src/index.ts`](../../apps/worker/src/index.ts). From the repository
root, run it with:

```sh
pnpm dev:worker
```

The application entry point registers handlers and owns process
startup/shutdown. This package owns Redis consumption and pending-message
reclaim, PostgreSQL leases, retry/dead-letter decisions, terminal-state
persistence, and acknowledgement ordering.

## Delivery contract

- Stream and consumer-group names, the versioned `data` envelope, and database
  job states come from the shared TaskFlow packages; callers must not define
  private variants.
- A Redis message is acknowledged only after PostgreSQL durably records a
  terminal state, or when a reclaimed message is found to be terminal already.
- Lease-acquisition errors and nonterminal lease outcomes remain pending for a
  later claim. Idle pending entries are reclaimed with `XCLAIM`.
- Handler execution is at least once. Database lease fencing prevents stale
  workers from winning a terminal commit, but does not make external handler
  effects exactly once. Handlers must provide their own idempotency boundary.

See [`apps/worker/README.md`](../../apps/worker/README.md) for configuration,
known durability limits, and the Docker-backed process test.

## Verification

```sh
pnpm --filter @taskflow/worker typecheck
pnpm --filter @taskflow/worker test
pnpm test:worker-integration
```
