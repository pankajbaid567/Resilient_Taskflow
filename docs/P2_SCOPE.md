# P2 Scope: Operable Lifecycle Management

P2 is incremental. The audit-log slice is implemented; retention, extended
control semantics, and deployable configuration remain open.

## Current progress

- Implemented: application append-only operational audit schema, transactional control audit writes, payload-free metadata policy, tenant/admin audit reads, pagination, and process tests.
- Implemented: bounded, resumable lifecycle retention across PostgreSQL tables (jobs, events, attempts, dead letters, deliveries, workers, idempotency keys, audit logs) and Redis stream trimming with PEL preservation and referential integrity protection.
- Implemented: a production-style local Docker stack (`docker-compose.prod.yml`) with required-secret validation, migrations as a one-shot job, health probes and authenticated metrics scraping. It has not been deployed anywhere.
- Not implemented: bounded control waits/status APIs, stale-worker policy extensions (a crashed worker stays `ACTIVE` in the database), TLS, and a real deployment.

## Objective

Make the verified TaskFlow core easier to operate without changing its PostgreSQL-authoritative, Redis-at-least-once delivery contract.

## In scope

1. Operational controls
   - expose control status and bounded wait semantics for queue pause/resume and worker stop;
   - define behavior for concurrent controls and stale worker records;
   - add audit records for who requested each control and its result.
2. Cleanup and retention
   - define separate retention windows for jobs, attempts, events, dead letters, workers, idempotency keys, deliveries, and Redis stream entries;
   - implement bounded, resumable cleanup with referential-integrity checks;
   - prove cleanup cannot remove data needed by an active lease, pending entry, retry, or redispatch.
3. Audit logging
   - persist tenant/operator identity, action, target, request ID, timestamp, and outcome;
   - avoid credentials and job payloads by default;
   - provide tenant/admin authorization and pagination tests.
4. Deployable configuration
   - validate required secrets and connection settings at startup;
   - document TLS, trusted proxies, authenticated metrics scraping, migrations, shutdown budgets, and health-probe wiring;
   - add container configuration tests without deploying or claiming production readiness.

## Explicitly out of scope

- Kafka integration
- sustained or multi-machine load testing (single-machine benchmarks exist in `docs/benchmarking/RESULTS.md`)
- deployment, publishing, paid infrastructure, credential rotation, or external-account changes
- exactly-once claims for arbitrary external effects

## Entry gates

- typecheck, lint, build, unit, migration, API-runtime, OTLP-collector, and worker-process gates pass from a clean staged snapshot;
- P1 operational-control process tests pass;
- current documentation contains no unsupported benchmark or readiness claims.

## Exit gates

- retention and cleanup are transactionally bounded and process-tested against active/pending jobs;
- every operational mutation writes a queryable audit record;
- deployment configuration fails closed on missing production secrets and has a documented rollback path;
- delivery guarantees and remaining unverified environments are stated precisely.
