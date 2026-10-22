# @taskflow/observability

Prometheus metrics (prom-client) and optional OpenTelemetry tracing shared by the API and the worker. See `docs/observability.md` for endpoint policy, scrape setup and what is verified.

## Using it

```ts
import { jobsCompletedTotal, getMetrics } from '@taskflow/observability';

jobsCompletedTotal.inc({ queue: 'default', type: 'send-email' });
const text = await getMetrics(); // Prometheus exposition format
```

The worker imports `@taskflow/observability/dist/metrics` directly instead of the package root. The root also loads the OpenTelemetry SDK (roughly 70 MB and 200 ms at startup), which the worker does not need unless tracing is on.

Exports from `metrics.ts`: every metric below, `getMetrics()`, `getRegistry()`, `clearMetrics()` (tests only) and `collectProcessMetrics()` (default Node.js process metrics, idempotent). Exports from `tracing.ts`: SDK start/shutdown and span helpers; tracing is off unless `ENABLE_TRACING=true`.

## Metrics

Every metric listed here is written by running code. Anything not listed does not exist; earlier drafts of this README described database, Redis and rate-limit metrics that were never implemented, and they were removed.

Written by the **worker** (`/metrics` on `WORKER_METRICS_PORT`, unauthenticated):

| Metric                                                                                             | Type              | Labels                  |
| -------------------------------------------------------------------------------------------------- | ----------------- | ----------------------- |
| `taskflow_jobs_started_total`                                                                      | Counter           | queue, type, worker_id  |
| `taskflow_jobs_completed_total`                                                                    | Counter           | queue, type             |
| `taskflow_jobs_failed_total`                                                                       | Counter           | queue, type, error_type |
| `taskflow_jobs_retried_total`                                                                      | Counter           | queue, type, attempt    |
| `taskflow_jobs_dead_lettered_total`                                                                | Counter           | queue, type, reason     |
| `taskflow_jobs_cancelled_total`, `taskflow_jobs_timed_out_total`                                   | Counter           | queue, type             |
| `taskflow_job_duration_seconds`                                                                    | Histogram         | queue, type, status     |
| `taskflow_job_wait_duration_seconds`                                                               | Histogram         | queue, priority         |
| `taskflow_worker_jobs_concurrent`                                                                  | Gauge             | worker_id               |
| `taskflow_worker_heartbeats_total`                                                                 | Counter           | worker_id               |
| `taskflow_worker_lease_renewals_total`                                                             | Counter           | worker_id               |
| `taskflow_worker_lease_acquisition_failures_total`                                                 | Counter           | worker_id, reason       |
| `taskflow_worker_failures_total`                                                                   | Counter           | worker_id, reason       |
| `taskflow_scheduler_runs_total`, `_jobs_scheduled_total`, `_errors_total`, `_run_duration_seconds` | Counter/Histogram | see source              |
| `taskflow_dispatcher_published_total`                                                              | Counter           | queue                   |
| `taskflow_dispatcher_window_limited_total`                                                         | Counter           | queue                   |

The `type` label is limited to registered handler names; anything else is recorded as `unregistered` to bound cardinality.

Written by the **API** (`GET /metrics`, admin only):

| Metric                                   | Type      | Labels                         |
| ---------------------------------------- | --------- | ------------------------------ |
| `taskflow_jobs_submitted_total`          | Counter   | queue, priority                |
| `taskflow_http_requests_total`           | Counter   | method, path, status           |
| `taskflow_http_request_duration_seconds` | Histogram | method, path, status           |
| `taskflow_jobs_current`                  | Gauge     | status, queue                  |
| `taskflow_queue_depth`                   | Gauge     | queue, priority                |
| `taskflow_queue_lag_seconds`             | Gauge     | queue                          |
| `taskflow_dlq_depth`                     | Gauge     | queue                          |
| `taskflow_workers_active`                | Gauge     | queue                          |
| `taskflow_workers_live`                  | Gauge     | none                           |
| `taskflow_build_info`                    | Gauge     | version, service, node_version |

The snapshot gauges come from one database query per scrape. `path` is the route pattern (`/api/v1/jobs/:id`), never the raw URL.

Both processes also expose the default Node.js process metrics (`process_*`, `nodejs_*`).
