# ADR-012: Priority through a Postgres-ordered, bounded in-flight window

**Status**: Accepted
**Date**: 2026-10-21

## Context

Jobs have a priority (`LOW`, `NORMAL`, `HIGH`, `CRITICAL`), but delivery goes through a Redis Stream, which is strictly first-in-first-out. If the dispatcher publishes every due job at once, a `CRITICAL` job submitted behind 10,000 `LOW` jobs waits behind all of them: the stored priority has no effect.

Options considered:

1. **One stream per priority**, with workers reading the highest first. Works, but multiplies streams, consumer groups, pending-entry recovery and metrics by four, and makes per-queue pause and retention more complicated.
2. **A priority-aware structure in Redis** (a sorted set). Moves the backlog out of the database that is already the source of truth (ADR-001) and needs its own recovery story.
3. **Order in PostgreSQL, publish a short window** to the existing stream.

## Decision

Option 3. The backlog stays in PostgreSQL (`job_deliveries`, the transactional outbox). The dispatcher keeps at most `DISPATCH_MAX_IN_FLIGHT_PER_QUEUE` entries (default 200) in flight in each queue's stream. Each cycle it computes `budget = window - in-flight` and claims that many pending deliveries ordered by `priority_rank DESC, available_at, created_at`, so the entries released are always the most urgent waiting.

- The rank comes from a single SQL function, `job_priority_rank()`, evaluated when the delivery row is inserted. No application code passes a rank, so a delivery cannot disagree with its job and the mapping is not duplicated in TypeScript. A partial index on `(queue_name, priority_rank DESC, available_at, created_at) WHERE status = 'PENDING'` serves the claim query.
- "In flight" is pending entries plus undelivered entries (from the consumer group's `lag`, or an exact capped `XRANGE` when Redis reports `lag` as unknown). It is deliberately not `XLEN`, which also counts acknowledged history that has not been trimmed yet and would stall dispatch.
- While a window is full the dispatcher re-checks after 50 ms rather than a whole poll interval; otherwise throughput would be capped at `window / interval`.
- `0` disables the window and restores plain FIFO publishing.

## Consequences

**Easier**

- A late `CRITICAL` job waits behind at most the window plus work already running, not the whole backlog. Integration tests show strict order within a window, a late `CRITICAL` job overtaking a backlog, and (as a control) FIFO order with the window off.
- No new Redis structures. Recovery, retention and pause behave as before; a paused queue's backlog stays in PostgreSQL in priority order.
- Retries keep their priority because a retry successor is created from the same job.

**Harder**

- The window is a soft bound. Concurrent dispatchers budget from the same snapshot, so it can be exceeded by up to one batch per extra dispatcher.
- The window must stay above the total worker concurrency for the queue, or workers starve.
- Ordering is strict with no aging: sustained `CRITICAL` load that saturates the workers can starve `LOW` jobs indefinitely. There is no preemption either; a running `LOW` job is never interrupted.
- Priority is per queue. For hard isolation use separate queues and dedicated workers.
- Dispatch now costs a Redis measurement per queue per cycle. Measured effect on throughput was not separated from the rest of the pipeline (`docs/benchmarking/RESULTS.md`).
