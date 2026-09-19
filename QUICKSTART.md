# Quick start

This repository is a local reference implementation, not a production-readiness or benchmark claim.

```bash
pnpm install
cp .env.example .env
docker compose up -d postgres redis
pnpm db:migrate
pnpm db:seed
pnpm dev:api
```

In a second terminal:

```bash
pnpm dev:worker
```

Use a database-seeded API key in `X-API-Key`; there is no built-in plaintext development credential. The supported worker entry point is `apps/worker` through `pnpm dev:worker`.

Before relying on a change, run the gates listed in the root README. Docker is required for migration, API-runtime, OTLP, and worker-process suites.
