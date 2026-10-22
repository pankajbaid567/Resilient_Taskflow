# Observability

TaskFlow exposes structured logs, Prometheus metrics, and optional OpenTelemetry traces. These facilities do not establish service-level objectives or production readiness.

## Endpoint policy

`/health/live` and `/health/ready` are public for orchestrator probes but intentionally reveal no uptime, memory, dependency names, or error strings. `/metrics` exposes workload information and therefore requires a database-backed admin credential.

Prometheus must be configured with an admin API key or JWT. Keep that credential in the deployment secret mechanism; do not put it in this repository or logs.

## Metrics

The API serves `GET /metrics` (admin only) and each worker serves `GET /metrics` on `WORKER_METRICS_PORT` (default 9464, `0` disables). The metric catalogue is in `packages/observability/README.md`; every metric listed there is written by running code.

**The worker endpoint has no authentication.** It listens on `127.0.0.1` unless `WORKER_METRICS_HOST` says otherwise. Bind `0.0.0.0` only on a private network, such as the unpublished Docker network in `docker-compose.prod.yml`. If the port is already taken (several workers on one host), the worker logs a warning and runs without the endpoint.

Cardinality rules: the HTTP `path` label is the route pattern, not the raw URL; the job `type` label on worker metrics is limited to registered handler names (others become `unregistered`); the API's submission counter has no `type` label.

## Prometheus and Grafana

| Stack                                        | Config                                           | Targets                                                                |
| -------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------- |
| Development (`docker-compose.yml`)           | `infrastructure/prometheus/prometheus.yml`       | `host.docker.internal:3000` (API) and `:9464` (worker) on your machine |
| Production-style (`docker-compose.prod.yml`) | `infrastructure/prometheus/prometheus.stack.yml` | Every `api` and `worker` replica via Docker DNS service discovery      |

The API scrape sends an admin API key read from a file at scrape time (Prometheus `http_headers` with `files`), so the key never appears in a config file. Create it with:

```bash
pnpm db:create-api-key -- --role admin --name prometheus \
  --out infrastructure/prometheus/secrets/api_key        # development
```

`--out` writes the key with mode 0600, refuses to overwrite an existing file and does not print the key. The directory is git-ignored. For the production-style stack the file is `stack_api_key` and the key must belong to that stack's database (see `docs/docker-production.md`). Until the file exists the API target shows `401`. The file must be readable by the Prometheus container user.

Check `http://localhost:9091/targets` (development) or `:9092/targets` (production-style). Grafana is described in `docs/grafana-dashboard.md`.

## Tracing lifecycle

Set `ENABLE_TRACING=true` and `OTEL_EXPORTER_OTLP_ENDPOINT` to the full OTLP HTTP traces URL, for example `http://collector:4318/v1/traces`. API startup initializes one SDK. Graceful API shutdown owns and awaits `shutdownTracing()`, which flushes the exporter. The tracing library itself does not install signal handlers.

Run the live collector proof with:

```bash
pnpm test:observability-integration
```

The test starts a Dockerized OpenTelemetry Collector, emits a named span from a separate Node process, calls SDK shutdown, and asserts the collector received the service name, span name, and attribute. This verifies the local OTLP HTTP shutdown/export path only; collector authentication, TLS, sampling, storage, and a deployed backend remain unverified.

## Data handling

Logs and telemetry should carry stable identifiers and bounded operational metadata, not API keys, JWTs, credentials, or full job payloads. Trace sampling and retention are deployment decisions and have no validated defaults in this repository.
