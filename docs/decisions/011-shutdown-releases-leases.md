# ADR-011: Graceful shutdown hands leases back and refunds the attempt

**Status**: Accepted
**Date**: 2026-10-21

## Context

A worker holds a time-limited lease on every job it runs. When a worker process is stopped (a deploy, a scale-down, `SIGTERM`), it may still have handlers running. Two behaviours were possible:

1. **Let the lease expire.** The job stays `PROCESSING` until the lease runs out (30 s by default), another worker re-runs it, and the interrupted run counts as a used attempt.
2. **Hand the lease back at shutdown.** Wait for running handlers up to a shutdown timeout, then explicitly give back whatever has not finished.

Option 1 has a bad interaction with retries. A rolling deploy interrupts every running job once. Each interruption consumes one of the job's `max_attempts`, so a job on its last attempt is dead-lettered by a restart that had nothing to do with the job failing. It also leaves each interrupted job idle for the remainder of the lease.

## Decision

On shutdown a worker stops taking new work, waits for running handlers up to `shutdownTimeoutMs`, and then calls `releaseJobDelivery` for each job still running. In one fenced transaction (the lease id must still match):

- the job returns to `QUEUED`;
- the in-flight attempt is **refunded** (`attempts - 1`) and its open `job_attempts` row is removed;
- the job's outbox row is re-armed to `PENDING` so the dispatcher republishes it;
- a `lease_released` event is written, carrying the removed attempt's start time and the reason.

The Redis entry is acknowledged only after that transaction commits. If the release fails or the lease is already gone, nothing is acknowledged and ordinary lease-expiry recovery still applies. Lease renewals write no `job_events` rows, so the event log records releases but not routine renewals.

A cancel that races with completion is resolved the same way as everything else: the first durable observation wins, and a failure reported while `CANCEL_REQUESTED` is set raises `JobCancellationRequestedError` instead of burning a retry.

## Consequences

**Easier**

- A deploy does not consume retry attempts. Measured with 2 workers and 10,000 jobs, `SIGTERM` on one worker produced 0 jobs with more than one attempt, 0 dead letters and 2 `lease_released` events (`docs/benchmarking/RESULTS.md`, scenario 5). A `SIGKILL` of the same worker re-ran 8 jobs after the lease expired.
- Interrupted jobs are republished immediately instead of after the lease timeout.

**Harder**

- The refund deletes an `job_attempts` row. History of the interrupted run survives only inside the `lease_released` event metadata, not as an attempt record.
- A handler that was interrupted mid-effect will run again from the start, so handlers must still be idempotent (see ADR-004). Releasing early does not make effects exactly-once.
- Shutdown time is bounded by `shutdownTimeoutMs`; a handler that ignores cancellation delays the stop until the timeout.

**Not covered**

- Hard crashes (`SIGKILL`, power loss) cannot release anything. They are recovered by lease expiry and cost an attempt.
