# Chaos gate

`pnpm test:chaos` selects the `failure injection` group in
`tests/integration/worker-runtime.test.ts`. These are destructive only to the
dedicated `taskflow-worker-it` Compose project created by that suite.

The gate currently exercises:

- `SIGKILL` during handler execution and replacement-worker reclaim;
- cooperative cancellation and killed-owner cancellation recovery;
- bounded `SIGTERM` with a noncooperative handler;
- loss of QUEUED and expired PROCESSING Redis entries with outbox redispatch;
- transient PostgreSQL loss before lease acquisition;
- process exit after terminal commit but before Redis acknowledgement; and
- retry exhaustion with observed backoff and dead-letter persistence, including
  separate handler-execution, effect-attempt, and unique-effect counts.

Run the complete happy-path and failure-injection suite with
`pnpm test:worker-integration`. Do not run these commands against shared or
production infrastructure.
