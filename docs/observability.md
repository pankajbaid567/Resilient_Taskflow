# Observability

TaskFlow exposes structured logs, Prometheus metrics, and optional OpenTelemetry traces. These facilities do not establish service-level objectives or production readiness.

## Endpoint policy

`/health/live` and `/health/ready` are public for orchestrator probes but intentionally reveal no uptime, memory, dependency names, or error strings. `/metrics` exposes workload information and therefore requires a database-backed admin credential.

Prometheus must be configured with an admin API key or JWT. Keep that credential in the deployment secret mechanism; do not put it in this repository or logs.

## Tracing lifecycle

Set `ENABLE_TRACING=true` and `OTEL_EXPORTER_OTLP_ENDPOINT` to the full OTLP HTTP traces URL, for example `http://collector:4318/v1/traces`. API startup initializes one SDK. Graceful API shutdown owns and awaits `shutdownTracing()`, which flushes the exporter. The tracing library itself does not install signal handlers.

Run the live collector proof with:

```bash
pnpm test:observability-integration
```

The test starts a Dockerized OpenTelemetry Collector, emits a named span from a separate Node process, calls SDK shutdown, and asserts the collector received the service name, span name, and attribute. This verifies the local OTLP HTTP shutdown/export path only; collector authentication, TLS, sampling, storage, and a deployed backend remain unverified.

## Data handling

Logs and telemetry should carry stable identifiers and bounded operational metadata, not API keys, JWTs, credentials, or full job payloads. Trace sampling and retention are deployment decisions and have no validated defaults in this repository.
