# Grafana dashboard

Grafana provisions one dashboard, **TaskFlow - System Overview** (`infrastructure/grafana/provisioning/dashboards/taskflow-overview.json`), against a Prometheus datasource with the fixed uid `prometheus`. Every panel query was executed against a live Prometheus through Grafana's query API and returned without error. A panel is empty until the event it measures has happened (for example, "Failures by cause" with no failed jobs).

## Open it

| Stack                                        | URL                     | Login                                                            |
| -------------------------------------------- | ----------------------- | ---------------------------------------------------------------- |
| Development (`docker-compose.yml`)           | `http://localhost:3002` | `admin` / `admin` (local only; change it if you expose the port) |
| Production-style (`docker-compose.prod.yml`) | `http://localhost:3003` | `admin` / `GRAFANA_ADMIN_PASSWORD` from `.env.prod.local`        |

The development Prometheus (`:9091`) scrapes the API and worker running on your host through `host.docker.internal`; the worker must be started with `WORKER_METRICS_HOST=0.0.0.0` for the container to reach it. See `docs/observability.md` for the scrape credential.

## Panels

| Row        | Panel                                             | What it shows                                                                                  |
| ---------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Overview   | Live workers                                      | Distinct workers that are `ACTIVE` with a heartbeat in the last 30 s                           |
|            | Queued / Processing / Dead-lettered               | Current counts from the database snapshot the API publishes                                    |
|            | Oldest waiting job                                | Age of the oldest job still waiting to run                                                     |
|            | Attempt success rate (5m)                         | Completed attempts over all finished attempts (retries count as failures of the attempt)       |
| Throughput | Jobs submitted vs finished                        | Rates of `taskflow_jobs_submitted_total` and `taskflow_jobs_completed_total`                   |
|            | Jobs by status                                    | Snapshot per status                                                                            |
|            | Dispatcher: published vs window-limited           | Outbox rows published to Redis, and how often the per-queue in-flight window held work back    |
|            | Failures by cause                                 | Failed attempts by error type, plus retries                                                    |
| Latency    | Job run time                                      | p50/p95/p99 of handler execution for successful attempts                                       |
|            | Wait time by priority (p95)                       | Time from becoming runnable to starting, per priority                                          |
| Queues     | Backlog by priority, Oldest waiting job per queue | Per-queue snapshot from the API                                                                |
| Workers    | Running jobs, lease renewals and contention       | Concurrency and lease health                                                                   |
|            | Process memory, Event loop lag                    | Node.js process metrics for API and worker                                                     |
| API        | Request rate, latency, requests by route          | From the HTTP hook in `apps/api/src/metrics.ts`; route labels are route patterns, not raw URLs |

## Things to know

- Snapshot gauges (`taskflow_jobs_current`, `taskflow_queue_depth`, `taskflow_queue_lag_seconds`, `taskflow_dlq_depth`, `taskflow_workers_live`) are published only by the API, from one database query per scrape. The panels filter on `job="taskflow-api"` and collapse replicas with `avg without (instance, job)`, so running several API replicas does not multiply the numbers. The worker process also registers the same metric names but never sets them.
- "Live workers" does not reflect crashed workers: nothing marks them stopped in the database, so the panel counts heartbeats instead of the `ACTIVE` status.
- The job `type` label on worker metrics is limited to registered handler names (anything else is `unregistered`) to keep label cardinality bounded. API submission counters carry no type label.
- There are no alert rules in this repository.
- The datasource file deletes and recreates the `Prometheus` datasource so an old volume with an auto-generated uid does not make Grafana fail at startup ("data source not found"). It is a no-op on a fresh install.
