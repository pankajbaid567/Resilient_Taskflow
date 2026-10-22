# Priority and Scheduling

This document describes how TaskFlow orders work: job priority, delayed
(scheduled) jobs, and retry timing. Everything here reflects the code; where a
behaviour is a limitation, it says so.

## Priority levels

A job has one of four priorities, set at submission (`priority`, default
`NORMAL`):

| Priority   | Rank | Meaning                |
| ---------- | ---- | ---------------------- |
| `CRITICAL` | 4    | Latency-sensitive work |
| `HIGH`     | 3    |                        |
| `NORMAL`   | 2    | Default                |
| `LOW`      | 1    | Background / bulk work |

The rank is computed by one database function, `job_priority_rank()`
(migration `0010`). It is used for the backfill and by every insert into the
outbox table, so a delivery cannot disagree with its job. (The Postgres enum
declares `CRITICAL` first, so it cannot be sorted directly.)

## Why priority needs a window

Jobs reach workers through a Redis Stream, and a stream is FIFO. Once a
delivery has been published, nothing can reorder it. If the dispatcher
published every due job immediately, a `CRITICAL` job submitted behind 10,000
`LOW` jobs would wait for all of them, whatever its priority said.

So priority is applied **before** publishing, where ordering is possible:

1. The backlog lives in PostgreSQL (`job_deliveries`, the transactional
   outbox), indexed by `(queue_name, priority_rank DESC, available_at,
created_at)` for pending rows.
2. The dispatcher keeps only a bounded **window** of entries in flight in each
   queue's Redis stream.
3. Each cycle it measures the room left in the window and claims exactly that
   many deliveries, **highest priority first, then oldest**.

```
        PostgreSQL (job_deliveries, PENDING)          Redis stream (per queue)
   ┌────────────────────────────────────────┐       ┌──────────────────────────┐
   │ CRITICAL  HIGH  NORMAL ... LOW LOW LOW │ ────▶ │  at most `window` entries │ ──▶ workers
   └────────────────────────────────────────┘       └──────────────────────────┘
        ordered here (priority, then age)             FIFO, but short
```

The most a late `CRITICAL` job can wait behind is the window plus whatever is
already running. With the default window of 200 that is a bounded, small amount
of work instead of the entire backlog.

### What counts as "in flight"

`getStreamInFlight()` counts, for the worker consumer group:

- **pending** entries (delivered to a consumer, not yet acknowledged), plus
- **undelivered** entries (from the group's `lag`, or an exact capped `XRANGE`
  when Redis reports `lag` as unknown).

Acknowledged history that has not been trimmed yet is **not** counted, which is
why this is not `XLEN`: using the stream length would stall dispatch until the
next retention trim.

### Configuration

| Variable                           | Default | Effect                                                                        |
| ---------------------------------- | ------- | ----------------------------------------------------------------------------- |
| `DISPATCH_MAX_IN_FLIGHT_PER_QUEUE` | `200`   | Entries kept in flight per queue. `0` disables the window (Redis FIFO order). |

Trade-offs of the window size:

- **Smaller** gives stricter priority, but the dispatcher must refill more
  often and a worker pool larger than the window would starve. Keep it above
  total worker concurrency for the queue.
- **Larger** gives workers a deeper buffer and fewer round trips, but lets
  more low-priority work get ahead of a late urgent job.
- **`0`** restores the old behaviour: everything is published at once and the
  stream's FIFO order decides.

## Properties and limits

- **Per queue.** Windows and ordering are per queue. Priority does not compare
  jobs in different queues. For hard isolation (for example an SLA tier that
  must never share workers with bulk work) use separate queues and dedicated
  workers (`WORKER_QUEUES`).
- **The bound is soft.** Concurrent dispatchers each budget from the same
  snapshot, so the window can be exceeded by up to one batch per extra
  dispatcher. Ordering is still priority-first; the window is just slightly
  deeper.
- **No aging.** Ordering is strict. Under sustained `CRITICAL` load that
  saturates the workers, `LOW` jobs can wait indefinitely. There is no
  starvation protection yet.
- **No preemption.** A running `LOW` job is never interrupted for a `CRITICAL`
  one; it finishes (or hits its timeout) first.
- **A full window is not idle time.** While a window is full the dispatcher
  re-checks every 50 ms, so freed slots are refilled promptly rather than after
  a full poll interval.
- **Retries keep their priority.** A retry successor is a new outbox row
  created from the same job, so it gets the same rank.
- **Pause is respected.** A paused queue is skipped; its backlog stays in
  PostgreSQL in priority order and resumes in that order.

## Scheduled (delayed) jobs

A job submitted with a future `scheduledAt` is stored as `CREATED`, with no
outbox row yet. The **scheduler** (every worker process runs one) promotes it
when it becomes due:

- It runs every 5 s by default, so a delayed job starts within roughly one
  interval after its due time, not at the exact instant.
- Promotion uses one transaction that claims due jobs with
  `FOR UPDATE SKIP LOCKED`, oldest due first, using the **database clock**.
  Any number of schedulers therefore take disjoint batches rather than
  contending for the same rows, and a bad row is reported and skipped (each
  promotion runs in its own savepoint) instead of blocking the batch.
- Promotion sets `QUEUED` and inserts the outbox row in the same transaction,
  with the priority rank, so the job joins the priority-ordered backlog.

## Retry timing

On a failed attempt, `failJobDelivery` decides retry vs. dead-letter and, for a
retry, writes the job as `RETRY_SCHEDULED` and a successor outbox row whose
`available_at` equals the job's `scheduled_at`, in one transaction. The
dispatcher will not claim it before that time. Backoff is exponential and
bounded by `JOB_RETRY_BASE_DELAY_MS` / `JOB_RETRY_MAX_DELAY_MS`. A
`PermanentJobError` skips retries and dead-letters immediately.

## Tests

| What                                                    | Where                                                     |
| ------------------------------------------------------- | --------------------------------------------------------- |
| Claim order (priority, then age), per-queue scoping     | `delivery.repository.integration.test.ts` (real Postgres) |
| Retry successor inherits priority                       | same                                                      |
| Backfill of `priority_rank` from existing deliveries    | `migration-runner.test.ts`                                |
| In-flight accounting (lag, null lag, caps, no group)    | `packages/queue/src/__tests__/in-flight.test.ts`          |
| Window budgeting, disabled mode, fast re-check          | `packages/worker/src/__tests__/dispatcher.test.ts`        |
| Backlog released strictly by priority                   | `worker-runtime.test.ts` › priority dispatch window       |
| Late `CRITICAL` overtakes a waiting backlog             | same                                                      |
| Control: with the window off, the same scenario is FIFO | same                                                      |
