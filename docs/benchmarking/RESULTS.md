# Benchmark results

Every number in this file was measured on the machine below with the commands listed. Nothing is projected or extrapolated. Raw k6 summaries are in `tests/load/results/` (git-ignored).

**These are single-laptop numbers. They are not production capacity.** Postgres, Redis, the API, the workers and the load generator all share one 8-core, 8 GB MacBook, and Postgres runs inside Docker's Linux VM. Use them to compare configurations of this system, not to size a deployment.

## Environment

| Item           | Value                                                                                                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine        | Apple M3, 8 cores, 8 GB RAM, macOS 15.6.1                                                                                                                                                           |
| Docker         | 8 CPUs, 3.8 GB memory available to the VM                                                                                                                                                           |
| PostgreSQL     | 16.15 (`postgres:16-alpine`, default settings, `synchronous_commit=on`), database `taskflow_bench`                                                                                                  |
| Redis          | 7.4.11 (`redis:7-alpine`, AOF `everysec`)                                                                                                                                                           |
| Node.js        | 20.20.2; API and workers run from the compiled `dist/` (`NODE_ENV=production`, `LOG_LEVEL=warn`)                                                                                                    |
| Load generator | k6 2.2.0, same machine                                                                                                                                                                              |
| Code           | commit `5eafc4d` plus uncommitted changes (the working tree was dirty)                                                                                                                              |
| Configuration  | 1 API process, DB pool max 10; workers `WORKER_CONCURRENCY=20`, lease 30 s, dispatch window 200 per queue; rate limits raised to 100,000,000/min so the limiter does not hide the system under test |
| Handlers       | `noop` (returns immediately; registered only with `ENABLE_BENCHMARK_HANDLERS=true`) and `process-data` (about 50 ms of simulated work)                                                              |

## How to reproduce

```bash
docker compose up -d postgres redis      # development stack; stop any dev worker first (shared Redis)
pnpm build
tests/load/bench.sh setup                # creates taskflow_bench, migrates, seeds, writes an API key
tests/load/bench.sh api                  # built API on :3000 against taskflow_bench
```

`bench.sh reset` empties only `taskflow_bench` and the `taskflow:queue:*` Redis streams. It is run before every scenario.

## 1. API admission latency

`POST /api/v1/jobs` with a `noop` job, k6 `constant-arrival-rate`, 60 s per rate, no workers running (so this measures the API plus the Postgres insert of the job, its delivery row and its events, not job execution).

```bash
K6_API_KEY=$(cat /tmp/tf-bench/api-key) MODE=admission RATE=<r> DURATION=60s \
  k6 run --summary-trend-stats="avg,med,p(95),p(99),max" tests/load/bench.js
```

| Target req/s | Achieved req/s | p50 ms | p95 ms | p99 ms | max ms | HTTP errors | Dropped iterations |
| -----------: | -------------: | -----: | -----: | -----: | -----: | ----------: | -----------------: |
|          100 |          100.0 |    7.5 |   19.6 |   74.5 |    188 |           0 |                  0 |
|          250 |          249.8 |    3.8 |   27.4 |  135.0 |    270 |           0 |                 10 |
|          500 |          497.2 |    3.7 |  200.3 |  345.7 |    521 |           0 |                165 |
|          750 |          728.5 |  243.2 | 1157.7 | 1554.1 |   1600 |           0 |               1033 |
|         1000 |          683.4 | 1403.1 | 1900.2 | 2417.1 |   2482 |           0 |              18310 |
|         1500 |          546.7 | 1398.3 | 3079.9 | 3943.1 |   4083 |           0 |              55590 |

The stop rule was an error rate above 1% or p99 above 1 s. The error rate never rose (no request failed), but p99 passed 1 s at 750 req/s. **The last good rate is 500 req/s** (p99 346 ms). Beyond about 700 req/s one API process saturates: achieved throughput falls as the target rises and latency is dominated by queueing. The 100 req/s row has a higher p50 than the 250 row because the first seconds of each run include JIT warm-up and k6 connection setup, which weigh more in a lower-volume run.

Not measured: more than one API process, a larger DB pool, or a load generator on another machine.

## 2. End-to-end throughput versus workers

20,000 `noop` jobs are enqueued first, with no worker running. Then N workers start and the backlog drains. Each configuration was run three times.

```bash
tests/load/bench-scaling.sh 3     # runs scenarios 2 and 3; per-run output below
tests/load/bench-drain.sh <workers> 20000 noop      # a single run, with full SQL report
```

Throughput is `count / (max(completed_at) - min(started_at))` for `SUCCEEDED` jobs.

| Workers | Run 1 jobs/s | Run 2 jobs/s | Run 3 jobs/s | Mean jobs/s |
| ------: | -----------: | -----------: | -----------: | ----------: |
|       1 |          217 |          235 |          211 |         221 |
|       2 |          249 |          227 |          247 |         241 |
|       4 |          206 |          195 |          207 |         203 |

Every run waited for all 20,000 jobs to finish. In the single runs whose full report was inspected, all 20,000 jobs succeeded with exactly one attempt each.

**Throughput does not scale with workers on this machine.** One worker already reaches the plateau; four workers are slightly slower. Postgres is the limit:

- During a 2-worker drain, the Postgres container used about 260% CPU while each worker process used about 50%. With 1 worker, Postgres used about 170% and the worker about 77%.
- A job costs about 5 transactions, 4 row inserts and 7 row updates (`pg_stat_database` deltas over a 3,000-job run). `pg_stat_statements`, enabled temporarily and then removed, showed 5 `job_events` inserts per job plus the job, attempt and delivery inserts and the status updates, each taking 0.1 to 0.5 ms on average.
- Sampling `pg_stat_activity` during a drain showed backends mostly in `commit` (WAL write lock and I/O waits) or in `ClientRead` between statements.
- Setting `synchronous_commit=off` for the bench database improved a 2-worker run only from about 270 to 297 jobs/s, so fsync latency alone is not the bottleneck. That setting was reverted and is not used in any other number here.

Because the backlog is created before the workers start, the "created to completed" latency of a job is mostly time spent waiting in the backlog (p99 of 81 to 103 s across these runs). It is a drain-time figure, not a per-job processing latency.

## 3. A realistic handler

5,000 `process-data` jobs (`{"operation":"transform","data":[{"id":1,"value":1}]}`, about 50 ms of simulated work), 4 workers, otherwise as scenario 2.

```bash
tests/load/bench-drain.sh 4 5000 process-data
```

| Run | jobs/s | Drain p99 ms (created to completed) |
| --: | -----: | ----------------------------------: |
|   1 |    184 |                               28348 |
|   2 |    172 |                               30232 |
|   3 |    214 |                               24376 |

Mean 190 jobs/s. 80 execution slots with 50 ms handlers could in theory do far more, so Postgres is again the limit.

## 4. Crash recovery

10,000 `process-data` jobs, 2 workers (concurrency 20 each). When 5,000 had succeeded, one worker was killed with `SIGKILL` (no shutdown handling at all).

```bash
tests/load/bench-crash.sh 10000 process-data
```

| Measurement                                   | Result                               |
| --------------------------------------------- | ------------------------------------ |
| Jobs submitted / finished `SUCCEEDED`         | 10,000 / 10,000                      |
| **Lost jobs**                                 | **0**                                |
| `PROCESSING` when the worker was killed       | 18 (both workers)                    |
| Jobs executed more than once (`attempts > 1`) | 8 (each has a `lease_expired` event) |
| Dead-lettered                                 | 0                                    |
| Kill until the last re-run job completed      | 30.2 s (the lease duration is 30 s)  |

Jobs that were running on the dead worker are re-run after their lease expires, so a handler must tolerate being executed twice (at-least-once). Single run; not repeated.

## 5. Graceful deploy

Same setup, but one worker received `SIGTERM` (the normal stop signal for a deploy) instead of `SIGKILL`.

```bash
tests/load/bench-term.sh 10000 process-data
```

| Measurement                                | Result            |
| ------------------------------------------ | ----------------- |
| Jobs submitted / finished `SUCCEEDED`      | 10,000 / 10,000   |
| Lost jobs                                  | 0                 |
| `PROCESSING` at `SIGTERM`                  | 17 (both workers) |
| Jobs that used more than one attempt       | **0**             |
| `lease_released` events (jobs handed back) | 2                 |
| Dead-lettered                              | 0                 |

The stopping worker finishes what it can and hands the rest back without spending a retry attempt. Single run; not repeated. The surviving worker needed about 31 s to finish the remaining jobs alone.

## Problems the benchmarks found (and fixed)

These were fixed before the numbers above were taken. Each has a regression test where one is practical.

1. **A worker published about 3 jobs/s when its queue was idle.** The consumer's blocking `XREADGROUP ... BLOCK` shared one Redis connection with the dispatcher's `XADD`, so each publish waited for the block to time out. Blocking reads now use their own connection (`getBlockingRedisClient`). The same 1,500-job backlog went from 31 jobs in 10 s to fully drained in under 10 s.
2. **Each worker was capped at `concurrency / pollIntervalMs` jobs/s.** When all slots were busy the poll loop slept a fixed 250 ms before looking again, so 20 slots allowed at most 80 jobs/s per worker however fast handlers were. The loop now wakes when a handler settles. For `process-data` with one worker this moved throughput from about 80 to 224 jobs/s.
3. **The dispatcher scanned the whole backlog every cycle** to find which queues had work (`SELECT DISTINCT` over all pending deliveries). It now probes each active queue with `EXISTS`. Measured end-to-end throughput did not change (Postgres commit and CPU cost dominate), so this is a correctness-of-cost fix, not a measured speed-up.

## Limits of this data

- One machine, shared by every component; no network between them.
- Postgres in Docker on macOS, default configuration, no tuning.
- Scenarios 4 and 5 are single runs. Scenarios 2 and 3 have three runs each; the spread within a configuration (for example 195 to 235 jobs/s) is about as large as the difference between configurations, so the 1-versus-2-worker ordering is not significant.
- No sustained (hours-long) run, no memory-growth measurement, no mixed read/write API load, and no failure injection on Redis or Postgres.
