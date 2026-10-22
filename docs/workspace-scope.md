# Workspace support scope

This file defines which pnpm workspaces form the supported TaskFlow runtime.
It does not claim deployment or production readiness.

## Core runtime and verification workspaces

| Workspace                              | Responsibility                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| `@taskflow/api` (`apps/api`)           | HTTP job-creation and query boundary                                             |
| `@taskflow/worker-app` (`apps/worker`) | The only supported worker process entry point                                    |
| `@taskflow/worker` (`packages/worker`) | Worker runtime library; it is not a second executable                            |
| `@taskflow/config`                     | Runtime configuration validation                                                 |
| `@taskflow/database`                   | PostgreSQL schema, migrations, repositories, leases, and job state               |
| `@taskflow/queue`                      | Redis connection, stream delivery, consumer groups, reclaim, and acknowledgement |
| `@taskflow/types`                      | Shared stream/message/state definitions and public data types                    |
| `@taskflow/retry`                      | Retry and dead-letter policy used by the worker runtime                          |
| `@taskflow/logger`                     | Shared structured logging                                                        |
| `@taskflow/observability`              | Prometheus metrics (API and worker) and optional tracing                         |
| `@taskflow/tests`                      | Cross-workspace verification; not a deployable service                           |

The core worker process is started with `pnpm dev:worker`. Delivery behavior is
owned by `packages/worker`; consumers must not start it as a separate process.

## Other workspaces

| Workspace             | Current status                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `@taskflow/dashboard` | React UI for the real API (sign in with an API key; jobs, DLQ, queues, workers). Verified in a browser against a live dev stack. |

Workspaces outside the core remain subject to repository build, typecheck, and lint
gates so they cannot hide failures in the core. An intentionally empty test
suite may use Vitest's `--passWithNoTests`; this means only that the workspace
has no package-local tests, not that its behavior was verified.

## Test-suite boundaries

- Unit suites verify package-local logic and contracts.
- Simulated suites verify in-memory models only and are not lifecycle evidence.
- Integration suites require their named infrastructure and run explicitly.
- `pnpm test:worker-integration` is the Docker/process lifecycle gate. It is the
  only current suite that exercises API creation, Redis delivery, a real worker
  process, PostgreSQL persistence, pending-entry recovery, and acknowledgement
  ordering together.
- Chaos and k6 load suites are separate opt-in commands. Neither runs as part of
  the default test command, and neither is evidence for this milestone unless
  it is explicitly executed and reported.
