# Test gates

The suites are intentionally separated so a passing unit suite cannot be mistaken for process or Docker evidence.

| Command                               | Boundary                                                        |
| ------------------------------------- | --------------------------------------------------------------- |
| `pnpm test`                           | package unit suites                                             |
| `pnpm test:unit`                      | root unit suite                                                 |
| `pnpm test:simulated`                 | simulated failure models                                        |
| `pnpm test:integration`               | Redis queue integration                                         |
| `pnpm test:migrations`                | real migration runner against Docker PostgreSQL                 |
| `pnpm test:api-runtime`               | API process/lifecycle and auth against Docker PostgreSQL/Redis  |
| `pnpm test:observability-integration` | live OTLP HTTP export and SDK shutdown against Docker collector |
| `pnpm test:worker-integration`        | actual worker processes with Docker PostgreSQL/Redis            |
| `pnpm test:chaos`                     | failure-injection subset of the worker-process suite            |

Run `pnpm typecheck`, `pnpm lint`, and `pnpm build` separately. Tests under `tests/load/**` are deferred and excluded from Vitest; they are not benchmark evidence.

The worker-process suite asserts database states/events/attempts, Redis pending entries and ACK ordering, retry timing/exhaustion, duplicate handler invocations, and separately the idempotent local database effect. It also exercises queue pause/resume, API-requested worker shutdown, and manual dead-letter retry.

Passing local Docker gates proves only the covered scenarios on that environment. It does not prove a throughput target, availability target, multi-region behavior, arbitrary external-effect idempotency, or production readiness.
