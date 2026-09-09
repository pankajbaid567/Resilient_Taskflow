# TaskFlow test gates

The test commands are intentionally separated so a fast default run cannot be
mistaken for process, failure-injection, or load evidence.

| Gate | Command | Boundary |
| --- | --- | --- |
| Workspace default | `pnpm test` | Package tests plus `tests/unit`; no Docker, chaos, or load |
| Unit | `pnpm test:unit` | Shared names, envelope, and state vocabulary |
| Simulated | `pnpm test:simulated` | Explicit model-only checks; never runtime evidence |
| Redis integration | `pnpm test:integration` | Real Redis producer, consumer group, pending entry, and XACK |
| Docker process | `pnpm test:docker-process` | API-created happy path through a real worker process, PostgreSQL, and Redis |
| Chaos | `pnpm test:chaos` | Real worker/infra failure-injection cases only |
| Full worker runtime | `pnpm test:worker-integration` | Docker process and chaos cases together |
| Test TypeScript | `pnpm --filter @taskflow/tests typecheck` | Every retained TypeScript test and config file |
| Load | `pnpm load:all` | k6 scripts; never selected by Vitest or the default gate |

## Prerequisites

Unit and simulated tests need only installed workspace dependencies. The Redis
integration test uses `REDIS_URL` and does not start or stop Redis:

```bash
REDIS_URL=redis://127.0.0.1:6379 pnpm test:integration
```

The Docker-process and chaos gates require an available Docker daemon. Their
Compose file owns isolated PostgreSQL and Redis ports and the test tears down
its project and volumes afterward:

```bash
pnpm test:worker-integration
```

The worker runtime suite is the lifecycle authority. It asserts the persisted
state/event transitions and observes Redis pending entries before and after
acknowledgement. The simulated suite is deliberately not cited as proof of
runtime delivery behavior.

Load scripts require k6 and a separately started target. They are opt-in and no
performance result is implied merely by their presence.
