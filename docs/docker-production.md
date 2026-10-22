# Production-style Docker stack

`docker-compose.prod.yml` runs the whole system on one machine: Postgres, Redis, a one-shot migration job, the API, the workers, the dashboard behind nginx, Prometheus and Grafana. It has been run end to end locally (a job submitted through the dashboard's nginx reached `SUCCEEDED`). It has **not** been deployed to a real host, load-balanced, or backed up. Treat it as a reproducible local environment, not a hardened production setup.

## Run it

```bash
cp .env.production.example .env.prod.local      # git-ignored; never commit it
# Replace every CHANGE_THIS value. Generate secrets with: openssl rand -hex 32
chmod 600 .env.prod.local

docker compose -p taskflow-prod --env-file .env.prod.local \
  -f docker-compose.prod.yml up -d --build --wait
```

Always pass `-p taskflow-prod`. The development stack (`docker-compose.yml`) uses the default project name, so a different name keeps its volumes safe from `down -v`.

Required variables (compose refuses to start without them): `POSTGRES_PASSWORD`, `JWT_SECRET` (32+ chars), `API_KEY_HASH_SALT` (16+ chars), `GRAFANA_ADMIN_PASSWORD`. Changing `API_KEY_HASH_SALT` later invalidates every issued API key.

| Service      | Host port (default) | Notes                                                                            |
| ------------ | ------------------- | -------------------------------------------------------------------------------- |
| `dashboard`  | 8080                | nginx; serves the SPA and proxies `/api/` and `/health/` to the API              |
| `prometheus` | 9092                | scrapes every API and worker replica through Docker DNS                          |
| `grafana`    | 3003                | dashboard "TaskFlow - System Overview" is provisioned                            |
| `postgres`   | not published       | internal network only                                                            |
| `redis`      | not published       | internal network only; `noeviction` so queued jobs are never dropped             |
| `api`        | not published       | reach it through the dashboard origin                                            |
| `worker`     | not published       | `/metrics` on 9464 is unauthenticated and reachable on the internal network only |
| `migrate`    | n/a                 | one-shot: applies migrations, seeds default queues, exits                        |

Defaults avoid the development stack's ports (5432, 6379, 3000, 3001, 9091, 3002, 9464), so both can run together.

## First use

Create an admin API key inside the stack (the key is the first line of stdout; log lines follow it):

```bash
docker compose -p taskflow-prod --env-file .env.prod.local -f docker-compose.prod.yml \
  run --rm --no-deps -T migrate \
  node node_modules/@taskflow/database/dist/create-api-key.js --role admin --name me 2>/dev/null | head -n 1
```

Open `http://localhost:8080` and sign in with that key. For Prometheus, create a second key the same way and save it (only the key, no newline) to `infrastructure/prometheus/secrets/stack_api_key`; that directory is git-ignored. Until the file exists, the `taskflow-api` target shows `401`.

## Images

All three Dockerfiles build from the repository root (`docker build -f apps/<app>/Dockerfile .`).

- API and worker: `node:20-alpine`, `pnpm deploy --prod` output only, non-root `node` user, `dumb-init` as PID 1. Health checks call `/health/live` (API) and the worker's `/metrics`.
- The worker image carries `@taskflow/database` (compiled code and SQL migrations), which is why `migrate` reuses it.
- Dashboard: `nginxinc/nginx-unprivileged` on port 8080, a CSP restricted to the same origin, long-cache for fingerprinted assets and `no-cache` for `index.html`. `VITE_API_URL` is a build argument; leave it empty to use the same origin.
- `docker stop` takes about 2 seconds and exits 0 for both the API and a worker (checked): the worker drains in-flight jobs, then releases leases (see `docs/leases-and-heartbeats.md`).

## Scaling and known limits

- `API_REPLICAS` and `WORKER_REPLICAS` work (checked with 2 and 2). Dashboard panels built on API snapshot gauges collapse replicas with `avg without (instance)`, so counts are not multiplied.
- nginx resolves the `api` hostname when it starts. Recreate the dashboard container after changing the number of API replicas.
- Security settings that are present: no published database ports, read-only root filesystems for API/worker/dashboard, `no-new-privileges`, non-root users, `API_TRUSTED_PROXIES` limited to the compose subnet.
- Not present: TLS (put a TLS-terminating proxy in front), backups, Redis/Postgres replication, resource limits for Postgres/Redis/Prometheus/Grafana, secret management beyond a local env file. The Grafana password is whatever you set in the env file.
- Workers that crash stay `ACTIVE` in the database until stopped; the dashboard counts only fresh heartbeats.

## Tear down

```bash
docker compose -p taskflow-prod --env-file .env.prod.local -f docker-compose.prod.yml down -v   # deletes this stack's data volumes
```
