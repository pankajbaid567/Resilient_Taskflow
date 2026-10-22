# Resilient TaskFlow — Implementation Plan

Working document for the agent that executes the remaining work. Follow tasks **in order**. Tick the checkbox when a task's "Done when" criteria are verified, and append a one-line note under "Progress log" at the bottom. Delete this file only when the user asks.

---

## 0. Ground rules (read first)

**Scope.** Local only. Deployment (cloud, Terraform, `deploy.yml`) is explicitly deferred by the user. Do not touch AWS/Cloudflare configuration beyond what is listed.

**Safety.**

- Never commit, push, or amend unless the user asks. Leave everything as working-tree changes.
- Never print secrets. `.env` and `/tmp/tf-key` contain secrets; reference keys by name only. Read the API key in shell with `K=$(cat /tmp/tf-key)`.
- Never run `TRUNCATE`/`DROP`/bulk `DELETE` against the dev database `taskflow`. Destructive tests only target:
  - `taskflow_contract` (same dev Postgres container, created for DB contract tests), or
  - the Docker integration stacks (ports 55439/56389 and 55459/56399), created and torn down by the test scripts.
- Adding dependencies: exact pinned versions, well-known packages only. Mention every new dependency in the final summary.
- Don't delete `prompts.md` or `prd.md` (user decides). Don't edit `.env`.

**Environment already running.**

| Thing         | How it runs                                                     | Notes                                                        |
| ------------- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| Postgres 16   | `docker compose` service `taskflow-postgres`, `localhost:5432`  | db `taskflow` (dev), db `taskflow_contract` (contract tests) |
| Redis 7       | `taskflow-redis`, `localhost:6379`                              |                                                              |
| Prometheus    | `taskflow-prometheus`, `localhost:9091`                         | scrape config is broken (Task 6)                             |
| Grafana       | `taskflow-grafana`, `localhost:3002`                            | admin/admin, local only                                      |
| API           | background process `pnpm dev:api` (tsx watch), `localhost:3000` |                                                              |
| Worker        | background process `pnpm dev:worker` (tsx watch)                |                                                              |
| Admin API key | `/tmp/tf-key` (chmod 600)                                       | user `admin@taskflow.local`, role admin                      |

Important: apps import workspace packages through their **built `dist/`**. After changing anything in `packages/*`, run `pnpm --filter <pkg> build` (or `pnpm build`) before the running API/worker or the Docker integration suites see the change. Restart the dev API/worker processes after rebuilding packages.

**Verification commands.**

| Gate                          | Command                                   | Baseline now                                                                         |
| ----------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------ |
| Typecheck                     | `pnpm typecheck`                          | 24/24 tasks pass                                                                     |
| Lint / format                 | `pnpm lint` · `pnpm format:check`         | format passes; lint not yet run this session                                         |
| Unit tests                    | `pnpm test`                               | all pass (worker 80, api 29, db 34 + 12 skipped, queue 22, retry 25, obs 5, tests 4) |
| DB contract (real Postgres)   | see command below                         | 12/12 pass                                                                           |
| Worker process suite (Docker) | `pnpm test:worker-integration`            | 19/19 passed **before** the shutdown change; not re-run since                        |
| API runtime suite (Docker)    | `pnpm test:api-runtime`                   | not run this session                                                                 |
| Migrations suite (Docker)     | `pnpm test:migrations`                    | not run this session                                                                 |
| Dashboard build               | `pnpm --filter @taskflow/dashboard build` | builds                                                                               |

DB contract command:

```bash
export DATABASE_URL=postgresql://taskflow:taskflow_password@localhost:5432/taskflow_contract
pnpm db:migrate
cd packages/database && TASKFLOW_DATABASE_INTEGRATION=true API_KEY_HASH_SALT=integration-test-salt \
  npx vitest run src/__tests__/delivery.repository.integration.test.ts
```

After **every** task: `pnpm typecheck && pnpm test`, plus the specific suites named in that task. Fix failures before moving on. If the same fix fails twice, stop and diagnose the root cause instead of tweaking.

---

## Already done this session (do not redo)

- Deleted 21 stale status/summary markdown files; README gained a Quick start section.
- `packages/database/src/create-api-key.ts` + `pnpm db:create-api-key -- --email <e> --role admin|user --name <n>` (prints the plaintext key once; stores the HMAC hash).
- Handlers `process-data` and `send-email` throw `PermanentJobError` (re-exported from `@taskflow/worker`) on payload validation, so bad payloads dead-letter immediately instead of burning retries.
- **Graceful shutdown** (`packages/worker/src/worker.ts`, `releaseJobDelivery` in `delivery.repository.ts`):
  - phase 1 drains in-flight handlers while leases keep renewing;
  - phase 2 interrupts the leftovers and hands each lease back in one fenced transaction: job → `QUEUED`, attempt refunded, open attempt row removed, outbox row re-armed to `PENDING`, `lease_released` event written, then XACK.
- **Scheduler**: `promoteDueScheduledJobs(limit)` in `job.repository.ts`, a single transaction using `FOR UPDATE SKIP LOCKED`, ordered by `scheduled_at` on the DB clock, with a savepoint per row. `scheduler.ts` uses it, and the unit tests were rewritten.
- **Lease renewal** no longer writes a `job_events` row; it is now a single fenced UPDATE. The `lease_renewed` event type was replaced by `lease_released` in `packages/types`.
- **Cancel vs. complete race**:
  - `completeJobDelivery` accepts `CANCEL_REQUESTED`, so a result produced before the worker observed the cancel wins, with metadata `lateCancellationRequestIgnored`.
  - `failJobDelivery` throws `JobCancellationRequestedError` under `CANCEL_REQUESTED`; the worker converts that into `completeCancellation` + XACK instead of a retry.
- New DB contract tests (passing): shutdown release, late-cancel semantics, concurrent schedulers getting disjoint batches.
- Worker integration test updated: new "drains an in-flight job to SUCCEEDED before a SIGTERM-ed worker exits"; the old SIGTERM test was rewritten to "releases a non-cooperative job … without consuming its attempt budget".

---

## Task 1 — Finish cancel/shutdown work and re-run integration suites (~30 min)

- [x] **1.1 Unit test for the failure-under-cancel path** in `packages/worker/src/__tests__/worker-delivery.test.ts`:
  - The handler throws a plain `Error`.
  - `database.failJobDelivery.mockRejectedValue(new database.JobCancellationRequestedError('x'))`.
  - Assert `completeCancellation` is called with `(jobId, workerId, leaseId)`, `acknowledgeMessage` is called after it, and nothing schedules a retry.
  - The mocked class is already declared in the `database` hoisted mock; the instance must come from that mock so `instanceof` matches.
- [x] **1.2** `pnpm build`, then `pnpm test:worker-integration`. Expect 20 tests.
  - Known timing: in "releases a non-cooperative job…", the replacement re-runs attempt 1, so `delayFirstAttemptMs: 10_000` applies again. The 25 s wait covers it.
  - If "turns an API stop request into a clean worker-process shutdown" or "retains a due retry through worker shutdown" fail, read the worker output in the failure: the drain phase now waits up to `shutdownTimeoutMs − min(5s, timeout/2)` for in-flight handlers.
- [x] **1.3** Run `pnpm test:api-runtime` and `pnpm test:migrations`; both must pass.
- [x] **1.4 Docs**:
  - `docs/leases-and-heartbeats.md`: renewal writes no event; shutdown drain + release semantics; attempt refund rationale.
  - `docs/cancellation.md`: "first durable observation wins". A result that commits before the owner sees `CANCEL_REQUESTED` succeeds; a failure under `CANCEL_REQUESTED` cancels instead of retrying.
  - Keep both docs factual and short.

**Done when:** all unit tests, DB contract (12+), worker integration (20), API runtime and migrations suites pass.

---

## Task 2 — Retention: make it safe, then wire it in (~2 h)

Current files (untracked WIP):

- `packages/database/src/repositories/retention.repository.ts`
- `packages/worker/src/retention-service.ts`
- `packages/worker/src/__tests__/retention-service.test.ts`
- `packages/database/src/__tests__/retention-contract.test.ts`

Config lives in `packages/config/src/index.ts` (`retentionConfig`). Integration tests are in `tests/integration/worker-runtime.test.ts` → `describe('bounded lifecycle retention')`.

**Defects to fix:**

- [x] **2.1 Migration `packages/database/migrations/0009_retention_safety.sql`.** Constraint names were verified in the dev DB.

  ```sql
  ALTER TABLE jobs         DROP CONSTRAINT jobs_worker_id_fkey,
    ADD CONSTRAINT jobs_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE SET NULL;
  ALTER TABLE job_attempts DROP CONSTRAINT job_attempts_worker_id_fkey,
    ADD CONSTRAINT job_attempts_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE SET NULL;
  ALTER TABLE job_events   DROP CONSTRAINT job_events_worker_id_fkey,
    ADD CONSTRAINT job_events_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE SET NULL;
  CREATE INDEX IF NOT EXISTS idx_dead_letter_jobs_requeued_job_id
    ON dead_letter_jobs (requeued_job_id) WHERE requeued_job_id IS NOT NULL;
  ```

  - Mirror `onDelete: 'set null'` in the Drizzle schema: `schema/jobs.ts`, `schema/job-attempts.ts`, `schema/job-events.ts`.
  - `jobs_lease_state_consistent` still blocks deleting a worker that owns a PROCESSING job. That is intended, and the worker cleaner already excludes such workers.
  - Run `pnpm test:migrations`. It asserts `names.length >= 4` and checksums, so it should pass unchanged.

- [x] **2.2 Protect live jobs.** Add a job-is-terminal condition to:
  - `cleanupBoundedJobEvents`
  - `cleanupBoundedJobAttempts`
  - `cleanupBoundedJobDeliveries`

  Terminal means `status IN ('SUCCEEDED','CANCELLED','DEAD_LETTERED','FAILED')`. Use `EXISTS (SELECT 1 FROM jobs j WHERE j.id = <t>.job_id AND j.status IN (...))`. A `PUBLISHED` delivery of a `QUEUED`/`PROCESSING` job is the stale-republish safety net and must never be deleted.

- [x] **2.3 Purge DEAD_LETTERED jobs.**
  - Add `DEAD_LETTERED` to the status list in `cleanupBoundedJobs`.
  - Its `dead_letter_jobs` row (purged first by step 1 of `runDatabaseRetention`) keeps it protected until the DLQ retention window passes.
  - Split the `requeued_job_id = id OR original_job_id = id` subquery into two `NOT EXISTS` clauses so both can use indexes.
- [x] **2.4 Atomic select-then-delete.**
  - Rewrite every `cleanupBounded*` as one statement so the safety predicates are evaluated under lock: `DELETE … WHERE id IN (SELECT id … ORDER BY … LIMIT n FOR UPDATE SKIP LOCKED) RETURNING id`.
  - With Drizzle: `db.delete(t).where(inArray(t.id, db.select({id: t.id}).from(t).where(...).orderBy(...).limit(n).for('update', { skipLocked: true })))`. If Drizzle 0.29 rejects `.for()` inside a subquery, use `db.execute(sql\`...\`)` with parameters. Never interpolate strings.
- [x] **2.5 Error isolation.**
  - In `runDatabaseRetention`, wrap each step in try/catch.
  - Record `{ step, message }` into a new `errors: Array<{ step: string; message: string }>` field on `DatabaseRetentionSummary` and on `RetentionCleanupReport` (`packages/types`).
  - Continue with the remaining steps.
- [x] **2.6 Fix `cleanupExpiredIdempotencyKeys`** in `job.repository.ts`: add `.returning({ id: schema.idempotencyKeys.id })`. It currently always returns 0.
- [x] **2.7 `retention-service.ts`.**
  - Paginate `listQueues` (100 per page until exhausted) instead of `limit: 1000`.
  - Remove the silent `['default']` fallback; zero queues means zero stream trims.
- [x] **2.8 Single-runner lock + scheduler.** New `packages/worker/src/retention-scheduler.ts`, modelled on `scheduler.ts` (start/stop, tracked cycle promise, `stop()` awaits the active cycle).
  - Lock: Redis `SET taskflow:lock:retention <token> NX PX <ttlMs>`, released with a compare-and-delete Lua script. TTL = 10 min. If not acquired, log debug and skip. Use the shared client from `@taskflow/queue` (`getRedisClient`).
  - Interval: `RETENTION_INTERVAL_MS` (default 3_600_000) plus random jitter of 0–10%. First run after one interval, not at startup.
  - `RETENTION_ENABLED` (default `true`). Add both env vars to the zod schema, `retentionConfig`, `.env.example` and `.env.production.example`.
  - Export it from `packages/worker/src/index.ts`. Wire it into `apps/worker/src/index.ts`: start after `scheduler.start()`, stop first in `shutdown()`.
  - Log the report at info level (counts and errors only).
- [x] **2.9 Tests**, added to `tests/integration/worker-runtime.test.ts` → `bounded lifecycle retention`:
  1. A STOPPED worker whose id is referenced by old terminal jobs/attempts/events is deleted, and the references become NULL (no FK error).
  2. A `PUBLISHED` delivery older than the cutoff whose job is `QUEUED` survives `cleanupBoundedJobDeliveries`.
  3. Events and attempts older than the cutoff for a `PROCESSING` job survive.
  4. A `DEAD_LETTERED` job is purged only after its `dead_letter_jobs` row is gone.
  5. Two concurrent `RetentionScheduler` runs (or two lock attempts) result in exactly one execution.

  Also add a unit test in `packages/worker/src/__tests__/retention-service.test.ts` for error isolation: one mocked step rejects and the report still contains the other counts plus one error.

- [x] **2.10 README.** Remove "retention automation … unimplemented" from Current limitations. Add retention to the feature list with its env vars.

**Done when:** all suites from Task 1 pass, plus the new retention tests. A manual run against dev reports no errors: temporarily set `RETENTION_INTERVAL_MS=5000` in the worker env for one run, check the log line, then revert.

---

## Task 3 — Remove dead code and Kafka (~45 min)

Verified orphaned (no app imports):

- [x] **3.1 Delete packages and stray deps.**
  - Delete `packages/events` (Kafka/kafkajs), `packages/cache` and `packages/performance`.
  - Delete `packages/queue/src/redis-optimized.ts`; it is the only consumer of performance.
  - Remove `"@taskflow/performance"` from `packages/queue/package.json` and `"@taskflow/events"` from `tests/package.json`. Grep `tests/` for imports from `@taskflow/events` and remove those tests if they exist.
  - Run `pnpm install` to refresh `pnpm-lock.yaml` (dependency change; mention it in the summary).
- [x] **3.2 Remove Kafka everywhere.**
  - Delete the `KAFKA_*` keys from the zod schema in `packages/config/src/index.ts` and from anything exporting them; zod ignores extra keys, so `.env` keeps working.
  - Remove them from `.env.example` and `.env.production.example`.
  - Remove the `redpanda` service and volume from `docker-compose.yml`; remove `redpanda` plus `KAFKA_BROKERS` and `depends_on: redpanda` from `docker-compose.prod.yml`.
  - Clean up the redpanda references in `scripts/start-all.sh` and `.github/workflows/docker.yml`.
  - Docs: delete Kafka sections in `docs/chaos-testing.md` and `docs/ci-cd.md`. `docs/benchmarking/BENCHMARK_REPORT.md` is replaced in Task 8.
- [x] **3.3 Delete unused functions.** Each has 0 call sites outside its own file and index re-export; re-check with grep first.
  - `job.repository.ts`: `getJobsReadyToProcess`, `getJobsReadyForRetry`, `getJobsWithExpiredLeases`, `getJobsReadyToQueue` (the scheduler now uses `promoteDueScheduledJobs`), `deleteOldCompletedJobs`.
  - `worker.repository.ts`: `deleteOldStoppedWorkers`.
  - `dispatch.repository.ts`: `markDeliveryFailed`.
  - `@taskflow/queue`: `enqueueJobBatch`, `acknowledgeMessageBatch`, `createPipeline`, `createTransaction`, plus their `index.ts` exports.
  - `packages/retry/src/dead-letter.ts`: delete the whole file and its exports from `packages/retry/src/index.ts` if nothing else references it; delete matching tests.
  - `packages/worker/src/cancellation-token.ts`: `combineCancellationTokens`, `createTimeoutCancellationToken` and their tests/exports.
  - Remove now-unused imports. `pnpm lint` must stay clean.
- [x] **3.4 Enforce the state machine** rather than deleting it; it is a good interview talking point.
  - Update `VALID_TRANSITIONS` in `packages/database/src/state-machine.ts` to exactly the transitions the repositories perform:
    - `CREATED→QUEUED|CANCELLED`
    - `QUEUED→PROCESSING|CANCELLED`
    - `PROCESSING→SUCCEEDED|RETRY_SCHEDULED|DEAD_LETTERED|QUEUED|CANCEL_REQUESTED` (QUEUED covers lease-expiry recovery and shutdown release)
    - `RETRY_SCHEDULED→QUEUED|CANCELLED`
    - `CANCEL_REQUESTED→CANCELLED|SUCCEEDED` (late result wins)
    - terminal states → `[]`
    - keep the legacy `FAILED` entry
  - Call `validateTransition(from, to)` immediately before each status-changing UPDATE in `delivery.repository.ts` and `job.repository.ts` (cancel, promote, acquire paths, complete, fail, release, completeCancellation, retry promotion, lease-expiry recovery, dead-letter).
  - Update `state-machine.test.ts` to the new table. Add one test asserting every repository transition pair appears in the table; hard-code the list.
- [x] **3.5** Run all gates, including `pnpm test:worker-integration` (transitions are now asserted at runtime).

**Done when:** `pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test` pass, the worker integration suite passes, and `grep -ri kafka` returns only historical docs or nothing.

---

## Task 4 — Real job priority (~2 h)

**Problem.** `jobs.priority` is stored but has no effect. The dispatcher publishes every due outbox row immediately, so any backlog sits in a FIFO Redis stream.

**Design.** Keep the backlog in PostgreSQL, where it can be ordered, and give Redis only a bounded in-flight window per queue.

- [x] **4.1 Migration `0010_delivery_priority.sql`.**

  ```sql
  ALTER TABLE job_deliveries ADD COLUMN priority_rank smallint NOT NULL DEFAULT 2;
  UPDATE job_deliveries d SET priority_rank = CASE j.priority
    WHEN 'CRITICAL' THEN 4 WHEN 'HIGH' THEN 3 WHEN 'NORMAL' THEN 2 ELSE 1 END
    FROM jobs j WHERE j.id = d.job_id;
  CREATE INDEX idx_job_deliveries_pending_priority
    ON job_deliveries (queue_name, priority_rank DESC, available_at, created_at)
    WHERE status = 'PENDING';
  ```

  - Add `priorityRank` to `schema/job-deliveries.ts`.
  - Add a helper `priorityRank(priority: JobPriority): number` in `packages/types` or the database package, and unit test it.

- [x] **4.2** `insertPendingDelivery(tx, jobId, queueName, attempt, availableAt, priorityRank)`: thread the job's priority through every caller (create job, scheduler promotion, retry successor in `failJobDelivery`, `releaseJobDelivery`, manual DLQ retry).
- [x] **4.3 Claim per queue in priority order.**
  - `claimPendingDeliveries(dispatcherId, limit, claimTimeoutMs, queueName?)` takes an optional `queueName` filter.
  - ORDER BY becomes `priority_rank DESC, available_at, created_at`.
- [x] **4.4 In-flight window in `packages/worker/src/dispatcher.ts`.**
  - New config `DISPATCH_MAX_IN_FLIGHT_PER_QUEUE`, default 200; `0` disables the window and restores the old behaviour. Add it to config, `.env.example` and the dispatcher config.
  - Each dispatch cycle, for each active queue:

    ```
    inFlight = group.pending + (group.lag ?? 0)
    budget = max(0, window − inFlight)
    claim min(batchSize, budget) rows for that queue
    ```

    `group.pending` and `group.lag` come from `XINFO GROUPS <stream>` for group `taskflow:workers`; the `lag` field exists from Redis 7.0. If the group doesn't exist yet, use `XLEN`. If lag is null (it can be after deletions or trims), use `XLEN` as a conservative stand-in.

  - Put the Redis helper `getStreamInFlight(queue)` in `packages/queue`, with a unit test using the existing mock style. Stream naming must go through `stream-names.ts`.
- [x] **4.5 Integration test** in `tests/integration/worker-runtime.test.ts`.
  - Start the worker with `WORKER_CONCURRENCY=1` and `DISPATCH_MAX_IN_FLIGHT_PER_QUEUE=1`.
  - Submit 10 `LOW` jobs with `payload: { delayMs: 300 }`, then 1 `CRITICAL` job.
  - Assert the CRITICAL job's `completed_at` is earlier than at least 7 of the LOW jobs.
  - The test API in that file accepts a `priority` field; check the `submitJob` helper and add an option.
- [x] **4.6 Docs.** Rewrite `docs/priority-and-scheduling.md`: the window design, why priority lives in Postgres, the trade-off (the window adds dispatch latency under load; `0` disables it), and the strict-isolation alternative (separate queues).

**Fallback.** If 4.4 cannot be made reliable within about 2 attempts, revert 4.4–4.5, keep 4.1–4.3 (priority-ordered dispatch), and state honestly in the docs and README that priority orders dispatch from the outbox only.

**Done when:** all gates pass and the priority integration test passes three runs in a row.

---

## Task 5 — Dashboard that works against the real API (~2 h)

Stack: React 18 + Vite 5 + CSS modules, in `apps/dashboard`. The real API contracts are below; these shapes are authoritative.

| Endpoint                                                                                                          | Response                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/jobs?status=&limit=&offset=` (owner-scoped, `.strict()` query: only `status`, `limit≤100`, `offset`) | `{ data: Job[], pagination: { limit, offset, total } }`                                                                                                                                                                                                         |
| Job (`serializeJob`)                                                                                              | `id, status, type, queue, priority, attempts, maxAttempts, createdAt, startedAt, completedAt, scheduledAt, result, error`                                                                                                                                       |
| `GET /api/v1/jobs/:id`, `DELETE /api/v1/jobs/:id` (cancel), `POST /api/v1/jobs/:id/retry` (DEAD_LETTERED only)    | Job                                                                                                                                                                                                                                                             |
| `POST /api/v1/jobs`                                                                                               | body `{ type, payload, queue?, priority?, maxAttempts?, timeoutMs?, scheduledAt? }`; header `Idempotency-Key` optional                                                                                                                                          |
| `GET /api/v1/queues`                                                                                              | `{ data: Queue[], pagination }`; Queue = `id,name,displayName,description,priority,concurrencyLimit,maxRetryAttempts,defaultTimeoutMs,rateLimitPerMinute,isActive,createdAt,updatedAt`                                                                          |
| `GET /api/v1/queues/:name/stats`                                                                                  | `{ queue, timestamp, jobs:{queued,processing,succeeded,failed}, redis:{depth}, workers:{active}, performance:{avgDurationMs} }`                                                                                                                                 |
| `POST /api/v1/queues/:name/pause` · `/resume`                                                                     | admin only                                                                                                                                                                                                                                                      |
| `GET /api/v1/workers`                                                                                             | `{ data: Worker[], pagination }`; Worker = `id,name,hostname,processId,queues,status(STARTING/ACTIVE/STOPPING/STOPPED/FAILED),concurrency,currentJobs,totalJobsProcessed,totalJobsSucceeded,totalJobsFailed,lastHeartbeat,startedAt,stoppedAt,version,metadata` |
| `POST /api/v1/workers/:id/stop`                                                                                   | admin only, 202                                                                                                                                                                                                                                                 |
| `GET /health/ready` (no `/api/v1` prefix, public)                                                                 | `{ status }`                                                                                                                                                                                                                                                    |

Job statuses are uppercase: `CREATED, QUEUED, PROCESSING, SUCCEEDED, FAILED, RETRY_SCHEDULED, DEAD_LETTERED, CANCEL_REQUESTED, CANCELLED`.

- [x] **5.1 Auth.**
  - Add a sign-in screen: one API-key input; store the key in `sessionStorage` under `taskflow.apiKey`.
  - Call `apiClient.setAPIKey` on load and on sign-in. Add a sign-out button in `Layout`.
  - On any 401, clear the key and return to sign-in.
  - Do **not** bake keys into the bundle; delete `VITE_API_KEY`/`VITE_JWT_TOKEN` from `apps/dashboard/.env.example`.
- [x] **5.2 Client and types.**
  - Rewrite `src/types/index.ts` to the shapes above.
  - Base URL is `import.meta.env.VITE_API_URL ?? '/api/v1'`; health uses `/health/ready` from the origin root.
  - Add `/health` to the Vite dev proxy in `vite.config.ts`.
  - `submitJob` sends `timeoutMs` and an optional `Idempotency-Key` header.
  - Delete `listDLQ`/`requeueFromDLQ`; the DLQ page uses `listJobs({ status: 'DEAD_LETTERED' })` and `retryJob(id)`.
  - Parse error bodies defensively: the body may not be JSON.
- [x] **5.3 Metrics without invention.**
  - `getDashboardMetrics` aggregates `GET /queues`, then `GET /queues/:name/stats` for each, plus `GET /workers`.
  - Remove the fake `p95Latency = avg*1.5` and the hardcoded `jobsPerSecond: 0`.
  - Compute throughput honestly in the Dashboard page as the delta of total `succeeded` between two polls divided by the elapsed seconds; show "—" until two samples exist.
- [x] **5.4 Fix the `useAPI` request loop.**
  - Keep the fetcher in a `useRef` updated every render.
  - The effect depends on `[skip, pollingInterval, key]`, where `key` is a stable string passed by the specific hooks (e.g. `JSON.stringify(params)`).
  - Ignore results from stale requests (request-id counter) and clear the interval on unmount.
  - Default polling: 5 s on the dashboard, 10 s elsewhere.
- [x] **5.5 Pages.**
  - Jobs: status filter, pagination, cancel.
  - Job detail modal: result/error JSON.
  - DLQ: list + retry.
  - Queues: stats + admin pause/resume, which show an error toast on 403.
  - Workers: list + admin stop.
  - Remove any references to fields the API doesn't return.
  - Accessibility: label every input, give buttons visible text or `aria-label`, mark the status badges with text and not just colour.
- [x] **5.6 Verify.**
  - `pnpm --filter @taskflow/dashboard build` and `pnpm --filter @taskflow/dashboard lint` pass.
  - Start `pnpm dev:dashboard` as a background process. Curl `http://localhost:3001/api/v1/queues` with `X-API-Key` through the Vite proxy and check 200 + `data`. Curl `http://localhost:3001/health/ready`.
  - Submit a few jobs with curl, including one with a bad payload so the DLQ has an entry.
  - Ask the user to open `http://localhost:3001` and confirm visually; you cannot see the browser.

**Done when:** build and lint are clean, the proxied endpoints return 200, the request loop is gone (check the API log: at most one request per hook per polling interval), and the user has confirmed the pages render.

---

## Task 6 — Docker images, prod compose, Prometheus/Grafana, CI (~2 h)

- [x] **6.1 Rewrite the API and worker Dockerfiles** (`apps/api/Dockerfile`, `apps/worker/Dockerfile`). Today the `COPY packages/*/package.json ./packages/*/` glob flattens paths, `pnpm-workspace.yaml` is never copied, and the health check hits a 404 path. Pattern:
  - builder: `node:20-alpine`, `corepack enable && corepack prepare pnpm@8.15.0 --activate`, then `COPY . .` (keep `.dockerignore` excluding `node_modules`, `dist`, `.turbo`, `.env*`, `.git`).
  - `pnpm install --frozen-lockfile`, then `pnpm --filter @taskflow/api... build`.
  - `pnpm deploy --filter @taskflow/api --prod /out`.
  - runtime: `node:20-alpine` + `dumb-init`, non-root user, `COPY --from=builder /out /app`.
  - The worker image must also contain `packages/database/migrations` so the migrate step works; verify the path `migrate.ts` resolves (`../migrations` relative to `dist`).
  - API health check: `node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`.
  - Use the env names config actually reads: `API_PORT`, `API_HOST=0.0.0.0`, `API_SHUTDOWN_TIMEOUT_MS`. Delete `PORT` and `SHUTDOWN_TIMEOUT`.
- [x] **6.2 Dashboard Dockerfile and nginx.**
  - Copy `pnpm-workspace.yaml` and install with `--filter @taskflow/dashboard...`.
  - Delete the `addgroup/adduser nginx` lines; that user already exists in `nginx:alpine`.
  - Take `VITE_API_URL` as a build `ARG`, since Vite inlines env at build time.
  - `nginx.conf`: proxy `/api/` and `/health/` to `http://api:3000`, set `X-Forwarded-For`, remove the static `/health` stub and the deprecated `X-XSS-Protection` header, add a basic CSP (`default-src 'self'; connect-src 'self'`).
- [x] **6.3 `docker-compose.prod.yml`** (used locally as a full-stack run).
  - api and worker env:
    - `API_KEY_HASH_SALT: ${API_KEY_HASH_SALT:?…}` and `JWT_SECRET: ${JWT_SECRET:?…}` on **both** api and worker;
    - remove `API_KEY` and `KAFKA_*`;
    - `API_PORT`/`API_HOST`.
  - Add a one-shot `migrate` service using the worker image with `command: ["node","packages/database/dist/migrate.js"]` (verify the path inside the deployed image). api and worker get `depends_on: migrate: condition: service_completed_successfully`.
  - Pin images: `prom/prometheus:v3.x.y` and `grafana/grafana:11.x.y` (look up current stable tags; pick exact versions).
  - Host ports must not collide with the dev stack (5432/6379/3000/3001/9091/3002). Either don't publish postgres/redis, or use different host ports.
  - Add `.env.prod.local` (gitignored) creation instructions to the README; never commit it.
- [x] **6.4 Worker metrics endpoint.** The worker currently exports no Prometheus metrics: `@taskflow/observability` is not imported by `apps/worker` or `packages/worker`.
  - Add a minimal `node:http` server in `apps/worker/src/metrics-server.ts` serving `GET /metrics` from the prom-client registry (`getMetrics()` from `@taskflow/observability`) on `WORKER_METRICS_PORT` (default 9464), bound to `127.0.0.1` locally and `0.0.0.0` in Docker via `WORKER_METRICS_HOST`. Close it in `shutdown()`.
  - **Flag in the summary:** it is unauthenticated and must stay on an internal network.
  - Increment the existing metrics in the runtime:
    - `jobsStartedTotal` / `jobsCompletedTotal` / `jobsFailedTotal` / `jobsRetriedTotal` / `jobsDeadLetteredTotal` / `jobsCancelledTotal` / `jobsTimedOutTotal` at the matching points in `worker.ts`;
    - `jobDurationSeconds` on completion;
    - `workerJobsConcurrent` gauge on dispatch/settle;
    - scheduler counters in `scheduler.ts`.
  - Check each metric's label names in `packages/observability/src/metrics.ts` before use; wrong labels throw at runtime.
  - Add the dependency `@taskflow/observability: workspace:*` where needed.
- [x] **6.5 Prometheus.** Rewrite `infrastructure/prometheus/prometheus.yml`.
  - `taskflow-api`: target `host.docker.internal:3000`, `metrics_path: /metrics`. It is admin-only, so send `X-API-Key` using Prometheus `http_headers` with `files: [/etc/prometheus/secrets/api_key]`. This needs Prometheus ≥ 2.55/3.x, so also pin the dev compose image.
    - Mount `./infrastructure/prometheus/secrets` read-only.
    - Add `infrastructure/prometheus/secrets/` to `.gitignore`.
    - Document creating the file with `pnpm db:create-api-key -- --role admin --name prometheus > infrastructure/prometheus/secrets/api_key`, ensuring the file contains only the key.
  - `taskflow-worker`: target `host.docker.internal:9464`.
  - Delete the fake `redis:6379` / `postgres:5432` scrape jobs. Optionally add `oliver006/redis_exporter` and `prometheuscommunity/postgres-exporter` services with pinned tags.
  - Verify at `http://localhost:9091/api/v1/targets` that all targets are `up`.
- [x] **6.6 Grafana.** Open `infrastructure/grafana/provisioning/dashboards/taskflow-overview.json`, make every panel query use metric names that now exist, and remove panels for metrics that don't. Verify via the Grafana API (`curl -u admin:admin localhost:3002/api/dashboards/...`) that the dashboard loads; ask the user to eyeball it.
- [x] **6.7 Make rate limits configurable** (also needed by Task 8).
  - In `apps/api/src/middleware/rate-limiter.ts`, read the presets from env with the current values as defaults: `RATE_LIMIT_JOB_SUBMISSION_PER_MIN=50`, `RATE_LIMIT_MUTATION_PER_MIN=50`, `RATE_LIMIT_READ_PER_MIN=200`, `RATE_LIMIT_METRICS_PER_MIN=1000`.
  - Remove the unused `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX_REQUESTS` from config and the env examples.
  - Update `docs/rate-limiting.md` and the rate-limiter unit tests.
- [x] **6.8 CI workflows.**
  - `actions/upload-artifact@v3` / `download-artifact@v3` → `@v4` (release.yml 115/218/233/239; security.yml 69/210; docker.yml 76).
  - `github/codeql-action/*@v2` → `@v3`; `pnpm/action-setup@v2` → `@v4`.
  - `docker-compose` → `docker compose` (docker.yml 130–147).
  - Pin `aquasecurity/trivy-action` and `trufflesecurity/trufflehog` to release tags instead of `@master`/`@main`.
  - Remove the redpanda/Kafka steps.
  - Leave `deploy.yml` as is (deferred) but add a top comment saying it is a placeholder.
  - Validate the YAML: `python3 -c "import yaml,sys,glob; [yaml.safe_load(open(f)) for f in glob.glob('.github/workflows/*.yml')]"`. `actionlint` isn't installed; ask before installing.
- [x] **6.9 Verify locally.**
  - `docker build -f apps/api/Dockerfile -t taskflow-api:local .` and the same for the worker and dashboard.
  - Bring up `docker compose -f docker-compose.prod.yml --env-file .env.prod.local up -d --build`, create an API key inside the stack, then submit a job through the dashboard container's nginx (`/api/v1/jobs`) and see it reach `SUCCEEDED`.
  - Tear down with `docker compose -f docker-compose.prod.yml down -v`. Only this stack's volumes are removed; double-check the project name differs from the dev stack's, or the dev volumes would go too.

**Done when:** all three images build, the prod-compose stack runs a job end to end and is torn down, Prometheus targets are up, workflow YAML parses, and all unit tests pass.

---

## Task 7 — Full verification run (~30 min)

- [x] Run, in order, and record the pass counts in the Progress log:
  1. `pnpm install --frozen-lockfile`
  2. `pnpm build`
  3. `pnpm typecheck`
  4. `pnpm lint`
  5. `pnpm format:check` (run `pnpm format` if needed, then re-check)
  6. `pnpm test`
  7. the DB contract command (§0)
  8. `pnpm test:migrations`
  9. `pnpm test:api-runtime`
  10. `pnpm test:observability-integration`
  11. `pnpm test:worker-integration`
  12. `pnpm --filter @taskflow/dashboard build`
- [x] Restart the dev API and worker and re-run the curl smoke test from the session: submit a job → `SUCCEEDED`; submit a bad payload → `DEAD_LETTERED` after **1** attempt.

**Done when:** every command passes. Any skipped suite must be named with its reason.

---

## Task 8 — Real benchmarks with k6 (~2 h)

Only measured numbers may appear anywhere. Delete `docs/benchmarking/BENCHMARK_REPORT.md`; its numbers were projections.

- [x] **8.1 Benchmark handler.** Register a `noop` handler in `apps/worker/src/handlers` (returns `{}`) only when `ENABLE_BENCHMARK_HANDLERS=true`. Keep `process-data` (≈50 ms simulated work) for the "realistic" scenario.
- [x] **8.2 Production-like processes.** Don't use tsx watch for benchmarks.
  - Stop the dev API/worker background processes.
  - `pnpm build`, then run `NODE_ENV=production LOG_LEVEL=warn node apps/api/dist/index.js` and `node apps/worker/dist/index.js` as background processes, with raised rate limits (`RATE_LIMIT_JOB_SUBMISSION_PER_MIN=1000000`).
  - Use a **separate database** `taskflow_bench` (create it, migrate, seed, create an API key) so dev data isn't polluted; point `DATABASE_URL` at it for both processes.
  - Before each scenario: flush only the bench data (`TRUNCATE` is allowed **only** on `taskflow_bench`) and `DEL` the `taskflow:queue:*` streams in Redis. Redis is shared with dev, so stop the dev worker during benchmarks.
- [x] **8.3 Record the environment** in the results file: `sysctl -n machdep.cpu.brand_string`, `sysctl -n hw.memsize`, `node -v`, Docker CPU/memory allotment (`docker info`), Postgres/Redis versions, git commit hash plus "dirty".
- [x] **8.4 Scenarios.** Read `tests/load/utils.js` and the scripts first; they were partially rewritten in WIP. Env: `K6_API_URL`, `K6_API_KEY`.
  1. **API admission latency.** k6 `constant-arrival-rate` at 100, 250 and 500 req/s for 60 s each, `POST /api/v1/jobs` with `noop`. Report achieved RPS, p50/p95/p99 latency and error rate. Stop increasing the rate when the error rate exceeds 1% or p99 exceeds 1 s; report the last good rate.
  2. **End-to-end throughput vs workers.** Enqueue 20,000 `noop` jobs, then start 1, 2 and 4 worker processes (`WORKER_CONCURRENCY=20`). Measure drain time and jobs/s from Postgres (SQL below).
  3. **Realistic.** Same as scenario 2 with 5,000 `process-data` jobs (`{"operation":"transform","data":[{"id":1,"value":1}]}`) at 4 workers.
  4. **Crash recovery.** During scenario 2 with 2 workers, `kill -9` one worker at about 50%. Report:
     - lost jobs, which must be 0: submitted count = `SUCCEEDED` count;
     - jobs executed more than once (`attempts > 1`);
     - time from kill to the stuck jobs completing (≈ lease duration).
  5. **Graceful deploy.** During scenario 3, `SIGTERM` one worker and confirm zero attempts consumed by the stop: the `lease_released` events in `job_events` equal the jobs handed back, and no job is DEAD_LETTERED.

  Throughput SQL:

  ```sql
  SELECT count(*) AS jobs,
         EXTRACT(EPOCH FROM max(completed_at) - min(started_at)) AS seconds,
         count(*) / NULLIF(EXTRACT(EPOCH FROM max(completed_at) - min(started_at)),0) AS jobs_per_sec,
         percentile_cont(ARRAY[0.5,0.95,0.99]) WITHIN GROUP
           (ORDER BY EXTRACT(EPOCH FROM completed_at - created_at)*1000) AS e2e_ms_p50_p95_p99
  FROM jobs WHERE status = 'SUCCEEDED';
  ```

- [x] **8.5 Write up.**
  - Create `docs/benchmarking/RESULTS.md` with the environment table, per-scenario tables, the exact commands, and caveats: single laptop; Postgres, Redis and the load generator share the machine; numbers are not production capacity.
  - Save raw k6 `--summary-export` JSON under `tests/load/results/` (already gitignored).
  - Restore the dev setup afterwards: restart `pnpm dev:api` / `pnpm dev:worker`.

**Done when:** RESULTS.md has real numbers for scenarios 1–5, each reproducible from the listed commands.

---

## Task 9 — README and docs (~1 h)

- [x] **9.1 Rewrite `README.md`** (keep it under about 250 lines). Sections, in order:
  1. One-paragraph pitch: what the system is, and that it guarantees at-least-once with idempotent effects and no lost jobs.
  2. Mermaid architecture diagram: API → Postgres (jobs + outbox) → Dispatcher → Redis Streams → Workers → Postgres; Scheduler, Retention and Prometheus/Grafana.
  3. Mermaid state diagram of the job lifecycle (from `VALID_TRANSITIONS`).
  4. Key guarantees and how each is achieved, as a table:

     | Guarantee               | Mechanism                       |
     | ----------------------- | ------------------------------- |
     | No lost jobs            | outbox                          |
     | No double commit        | lease fencing + version         |
     | Crash safety            | commit-before-XACK              |
     | Exactly-once submission | idempotency key + advisory lock |
     | No retry burn on deploy | drain + release                 |
     | Priority                | Postgres-ordered window         |
     | Disjoint scheduling     | SKIP LOCKED                     |
     | Bounded storage         | retention                       |

  5. Benchmark summary table copied from RESULTS.md, with a link.
  6. Quick start: dev compose, migrate, seed, `pnpm db:create-api-key`, run the API/worker/dashboard, a curl example.
  7. Full-stack Docker run (prod compose, local).
  8. Testing matrix: each suite, what it proves, its command.
  9. Project structure tree; packages only, after the dead-code removal.
  10. Design decisions: link the ADRs in `docs/decisions/`.
  11. Limitations, honestly:
      - external effects are at-least-once;
      - single-region;
      - the benchmark caveats;
      - deployment not yet done;
      - Terraform is an incomplete skeleton.
- [x] **9.2 Fix the README Quick start command for API keys.**
  - `pnpm db:create-api-key` currently prints pnpm banners and logger lines to stdout next to the key.
  - Change the root script to `pnpm --filter @taskflow/database exec tsx src/create-api-key.ts`, and make `create-api-key.ts` log to stderr only.
  - Verify that `pnpm -s db:create-api-key -- --name x | wc -l` prints `1`.
- [x] **9.3 Docs pass.**
  - Delete docs describing things that no longer exist or are aspirational: `docs/aws-deployment.md`, `docs/workflow-badges.md`, `docs/phase*`, `docs/redis-optimization.md`, `docs/query-optimization.md` and `docs/performance-engineering.md` if they describe the deleted performance package. Grep each for references to deleted code first.
  - Update `docs/api-documentation.md` to the endpoint table in Task 5.
  - Update `docs/architecture/*.md` for the outbox priority column, the FK change, and the absence of renewal events.
  - Keep the ADRs. Add **ADR 011**: "Graceful shutdown hands leases back and refunds the attempt" (context, decision, consequences: the attempt row is removed and the history lives in `lease_released`). Add **ADR 012**: "Priority via a Postgres-ordered bounded in-flight window".

**Done when:** README renders (check the mermaid syntax at mermaid.live, or let the user check), every link resolves (`grep -o '](docs/[^)]*)' README.md` → each file exists), and there is no mention of Kafka or of deleted packages.

---

## Task 10 — IEEE-format project report (~2 h)

- [x] **10.1 Ask the user first**, in one message:
  - author name / affiliation / email for the title block (default: Pankaj Baid, affiliation TBD);
  - whether to install `tectonic` via Homebrew (about 100 MB) to compile the PDF locally. The alternative is producing `.tex` for Overleaf.

  Do not install without a yes.

- [x] **10.2 Write `docs/report/taskflow-ieee.tex`** using the `IEEEtran` conference class (`\documentclass[conference]{IEEEtran}`), plus `docs/report/references.bib` and `docs/report/figures/`. Length: 6–8 pages. Structure:
  - **Title**: "Resilient TaskFlow: A Crash-Safe Job Processing System Using a Transactional Outbox, Lease Fencing, and Redis Streams"
  - **Abstract** (≤ 200 words, include the headline measured numbers) and **Index Terms**.
  - **I. Introduction**: the problem (lost or duplicated jobs in async processing) and the contributions as a bullet list.
  - **II. Background and Related Work**: at-least-once vs exactly-once; the transactional outbox; leases; Redis Streams consumer groups; PostgreSQL `SKIP LOCKED`; comparison with Celery, Sidekiq, BullMQ and Temporal (a table comparing durability source of truth, recovery, priority and idempotency). Only state comparison facts you can verify from official docs.
  - **III. System Design**: architecture figure; data model; the state machine figure; outbox and dispatcher; leases, fencing and versioning; commit-before-ACK; stale recovery (XAUTOCLAIM + outbox republish); idempotent submission; retry/backoff/DLQ; cancellation semantics; scheduling with `SKIP LOCKED`; priority window; graceful shutdown with release; retention.
  - **IV. Implementation**: TypeScript monorepo, Fastify, Drizzle/postgres.js, ioredis, prom-client/OpenTelemetry, React dashboard; LOC counts from `cloc` or `wc`, measured.
  - **V. Failure Model and Correctness**: a table of failure scenario → system behaviour → the test that proves it (map each to an actual test name in `tests/integration/worker-runtime.test.ts` / the DB contract tests); an informal invariant argument (no QUEUED job without a delivery intent; XACK only after a terminal commit; one lease owner at a time).
  - **VI. Evaluation**: setup table and results tables/figures from `docs/benchmarking/RESULTS.md` **only**. For figures, generate PNG charts with a small Python matplotlib script in `docs/report/figures/make_figures.py` if matplotlib is available (`python3 -c "import matplotlib"`); otherwise use `pgfplots` inside LaTeX.
  - **VII. Limitations and Future Work**: external-effect duplication, single region, laptop-only benchmarks, deployment, multi-tenant fairness, exactly-once sinks.
  - **VIII. Conclusion**.
  - **References**, IEEE style via `IEEEtran.bst`. Use only real, verifiable sources, for example:
    - C. Gray and D. Cheriton, "Leases: An Efficient Fault-Tolerant Mechanism for Distributed File Cache Consistency," SOSP 1989;
    - M. Kleppmann, _Designing Data-Intensive Applications_, O'Reilly, 2017;
    - P. Helland, "Life beyond Distributed Transactions: an Apostate's Opinion," CIDR 2007;
    - C. Richardson, _Microservices Patterns_, Manning, 2018 (transactional outbox);
    - the PostgreSQL documentation (SELECT … FOR UPDATE SKIP LOCKED; advisory locks);
    - the Redis documentation (Streams, XAUTOCLAIM, consumer groups);
    - the Celery, Sidekiq, BullMQ and Temporal documentation.

    Include a URL and access date for web documentation. Do not invent DOIs or page numbers; omit any field you cannot confirm.

  - Architecture and state figures: draw with TikZ in the .tex (no external tools needed), or export from mermaid only if `mmdc` is available (it isn't now).
- [x] **10.3 Compile** (if approved): `cd docs/report && tectonic taskflow-ieee.tex`. Fix all errors, overfull boxes in tables and missing references. Register the PDF with the artifact tool (`kind: pdf`), and the `.tex` as a code artifact.
- [x] **10.4 Consistency check.** Every number in the report matches RESULTS.md, every test cited exists (grep), and every claim about behaviour matches the code after Tasks 1–6.

**Done when:** the PDF compiles (or the `.tex` is Overleaf-ready, if the user declined tectonic), the numbers are traceable, and the references are real.

---

## Final hand-off

- [ ] Remove temporary files created during the work (`/tmp/tf-*` scratch logs except `/tmp/tf-key` while the user still needs it; any temporary `.env.prod.local`, but only if you created it and the user doesn't need it).
- [ ] Stop the background processes you started, unless the user wants the stack left running.
- [ ] Give the user a short summary:
  - what changed, per task;
  - test pass counts;
  - new dependencies;
  - security notes: unauthenticated worker metrics endpoint on the internal network; Grafana admin/admin for local use only;
  - a suggested commit breakdown (one commit per task), and an offer to make the commits, since nothing is committed yet.

---

## Progress log

- (session 1) Tasks 1 partially done — see "Already done". DB contract 12/12, unit tests all pass, worker integration not yet re-run after shutdown change.
- (session 2) **Task 1 done.** Added unit test for failure-under-cancel (worker 81 unit tests). Re-ran Docker suites after the shutdown change: worker-integration 20/20, migrations 5/5, api-runtime 10/10; DB contract 12/12. Docs updated (`leases-and-heartbeats.md`, `cancellation.md`) incl. stale "half duration"/"2s polling" claims. Fixed one lint warning; typecheck/lint/format/unit all clean.
- (session 2) **Task 2 done.** Migration `0009_retention_safety.sql` (worker FKs `ON DELETE SET NULL` + `requeued_job_id` index; verified `confdeltype=n`, and verified the pre-0009 FK violation really occurred in a rolled-back probe). `retention.repository.ts` rewritten as single-statement `DELETE … IN (SELECT … FOR UPDATE SKIP LOCKED)`; history tables only purge for terminal jobs; DEAD_LETTERED purgeable after its DLQ record; per-step error isolation (`errors` on summary/report). `cleanupExpiredIdempotencyKeys` now uses RETURNING. `retention-service` paginates queues, no `'default'` fallback. New `RetentionScheduler` (Redis NX lock + compare-and-delete release, first run after one interval, jitter) wired in `apps/worker`; `RETENTION_ENABLED`/`RETENTION_INTERVAL_MS` added to config + env examples. Tests: worker unit 94, retention-scheduler 9, worker-integration 26/26 (6 new retention tests), DB contract 12/12. Manual dev run with `RETENTION_INTERVAL_MS=5000` fired 3 runs with no errors; reverted. Dev DB migrated to 0009; dev API+worker restarted on new builds (terminals 2 and 3).

- (session 2) **Correction to the Task 2 entry above:** `pnpm test:migrations` was initially run _after_ that entry was written and failed 5/5 ("Connection terminated unexpectedly" in `beforeEach`, before any migration ran). Root cause: the compose healthchecks used `pg_isready` over the unix socket, which the postgres image's temporary init server also answers, so `docker compose up --wait` can return just before the init server restarts (confirmed in container logs: ready, shutting down, ready). Fixed all three `tests/integration/*.compose.yml` to probe `-h 127.0.0.1` (TCP, served only by the real server). `test:migrations` now passes 5/5 on 3 consecutive runs (0009 applied), `test:api-runtime` 10/10.
- (session 2) **Task 3 done.** Deleted `packages/{events,cache,performance}` and `queue/src/redis-optimized.ts` (all 21 files were tracked and clean, so restorable via git); removed their config refs (`tests/package.json`, `tests/tsconfig.integration.json`, `tests/vitest.config.ts`, `queue/package.json`) and the `kafkajs` test dep; `pnpm install` refreshed the lockfile (no new deps; `--frozen-lockfile` verified). Kafka removed from config (`KAFKA_*`, `kafkaConfig`), types (`KafkaJobEvent`, `HealthCheck.kafka`), observability (event metrics + unused `Summary` import), OpenAPI health schema, both compose files (`docker compose config` parses; **pre-existing** prod-compose error `container_name`+`replicas` remains for Task 6.3), `docker.yml`, `start-all.sh` (also `docker-compose`→`docker compose`), `demo.ts`, `.env.example`, and Terraform (msk module/vars/outputs; unvalidated, `terraform` not installed). Deleted 13 unused functions + `retry/dead-letter.ts` + their tests/exports. **State machine now enforced:** `validateTransition` precedes all 12 job-status UPDATEs (9 in `delivery.repository.ts`, 3 in `job.repository.ts`); table rewritten to exactly the runtime transitions (`PROCESSING→QUEUED` added, `PROCESSING→FAILED`/`CANCEL_REQUESTED→FAILED` removed, `FAILED` kept as legacy); new contract test pins table == repository transitions. Gates: build 11/11, typecheck 19/19, lint 18/18, format ok, unit (worker 87, db 41+12 skipped, api 29, queue 22, retry 25, obs 5), DB contract 12/12, worker-integration 26/26, api-runtime 10/10, observability-integration 1/1, migrations 5/5. Docs: Kafka removed from system-overview (diagram/section/decision), state-machine, failure-model, chaos-testing, ci-cd, docker-production, workspace-scope, observability README, decisions index (dangling ADR-003 link). Left intentionally: `.env` (yours), dashboard Kafka UI (Task 5), `aws-deployment.md` + `BENCHMARK_REPORT.md` (deleted in Tasks 9/8), accurate comparative mentions (ADR-001/004, queue README "Why not Kafka", P2_SCOPE out-of-scope list).
- (session 2) **Correction to the Task 2 entry (second one):** its claims "Dev DB migrated to 0009; dev API+worker restarted on new builds" and the 5 s manual retention run were **not** against the dev DB. A `DATABASE_URL=…/taskflow_contract` exported in an earlier command persisted in the shell session, so `pnpm db:migrate` and the restarted dev API/worker all targeted `taskflow_contract`. The dev DB (`taskflow`) was still at migration 0008 until Task 4. (The manual retention run still showed 3 error-free runs, but on the contract DB.) Found when a smoke test got 401: the key lives in `taskflow`, the API was reading `taskflow_contract`. **Rule from now on:** never `export DATABASE_URL`; use a per-command prefix (`DATABASE_URL=… cmd`) for contract/test DBs and `env -u DATABASE_URL` when starting dev processes. Dev API (terminal 2) and worker (terminal 3) now run with `env -u DATABASE_URL`, verified by inspecting their environment.
- (session 2) **Task 4 done.** Migration `0010_delivery_priority.sql`: `job_priority_rank()` SQL function (single definition of order), `job_deliveries.priority_rank` (+CHECK 1..4, backfilled from jobs), partial index `(queue_name, priority_rank DESC, available_at, created_at) WHERE PENDING` (migration-owned; Drizzle 0.29 can't express DESC columns, as with other indexes in this repo). **Design deviation from the plan, deliberate:** instead of threading a rank argument through all `insertPendingDelivery` callers (4.2), the rank is computed inside the insert from the job row via `job_priority_rank()`, so callers cannot pass a wrong value and nothing mirrors the mapping in TS. `claimPendingDeliveries(…, queueName?)` orders `priority_rank DESC, available_at, created_at`. `getQueuesWithClaimableDeliveries()` added. `@taskflow/queue` `getStreamInFlight(queue, cap)` = pending + lag, with an exact capped `XRANGE` fallback when Redis reports `lag` null (plan said fall back to `XLEN`; rejected because it would count acknowledged-but-untrimmed history and stall dispatch until the next retention trim). Dispatcher: per-queue window `DISPATCH_MAX_IN_FLIGHT_PER_QUEUE` (default 200, 0 = off), budget = window − in-flight, fast 50 ms re-check while window-limited (otherwise throughput would cap at window/poll-interval). The window is a soft bound (concurrent dispatchers can overshoot by one batch each). Tests: queue in-flight 9, dispatcher window 6 (worker unit 87→94), DB contract 14/14 (claim order+per-queue scoping, successor inherits priority), migrations 6/6 (new test builds real pre-0010 data and verifies backfill), worker-integration 29/29 incl. 3 priority tests which passed 3 consecutive runs (strict order, late CRITICAL overtakes backlog, and a control showing FIFO with the window off). `priority-and-scheduling.md` rewritten 697→140 lines (old one described non-existent worker priority filters / scheduler HA). Gates: build 11/11, typecheck 19/19, lint 18/18, format ok, unit all green. Live smoke on the real dev stack: LOW/LOW/CRITICAL stored ranks 1/1/4 and all SUCCEEDED.
- (session 2) **Task 5 done.** Dashboard rewritten against the real contracts (UPPERCASE statuses, `{data,pagination}`, `error` as object; removed `/dlq`, `/api/v1/health`, Kafka, fake p95/jobsPerSecond). Auth: sign-in page, key in `sessionStorage` only, 401 anywhere returns to sign-in; `VITE_API_KEY/JWT` removed. `useAPI(key, fetcher, opts)` fixes the render loop (fetcher in a ref, explicit key, stale-response guard, no overlapping polls, pauses when tab hidden). Pages: Jobs (status filter + pagination + cancel), DLQ (list + retry-as-new-job), Queues (stats + admin pause/resume, 403 message), Workers (status filter + admin stop, confirm), Dashboard (measured throughput delta, "—" until two samples). **Verified in a real browser** (Playwright/Chromium against the live dev stack, 28 checks incl. sign-in/out, wrong+revoked key, filter, modal focus return, pause/resume, no request loop = 2 req/endpoint in 12 s at 5 s polling) and by looking at screenshots. Two honesty fixes found by that: (1) my first request-loop check passed _vacuously_ (Playwright events don't pump during `time.sleep`; fixed with `wait_for_timeout` plus an assertion that traffic was observed); (2) a crashed worker stays `ACTIVE` forever (nothing reaps it; its heartbeat was 48 min old), so "Active workers"/capacity now count only fresh heartbeats (<=30 s). **Open server-side gap (not fixed, out of Task 5 scope):** no process marks dead workers; `countActiveWorkersForQueue` and `GET /workers?status=ACTIVE` still include them. `redis.depth` is `XLEN` (counts acknowledged history), so the UI labels it "stream entries", not backlog. Also added vite proxy for `/health`, rewrote the dashboard README (216→~100 lines). Gates: dashboard tsc/eslint(max-warnings 0)/build clean; repo build 11/11, typecheck 19/19, lint 18/18, format ok, unit green. Dashboard dev server is running on :3001 (terminal 5). Not done: no admin-role detection (no endpoint), no job-submit form, Dockerfile/nginx for the dashboard (Task 6).
- (session 3) **Task 6 done.** Images: API/worker/dashboard Dockerfiles rewritten (corepack pnpm 8.15.0, `pnpm deploy --prod`, non-root, dumb-init, health checks on `/health/live` and the worker `/metrics`; dashboard on `nginx-unprivileged` :8080 with same-origin proxy and CSP); one root `.dockerignore`; per-app ones removed. The worker image carries `@taskflow/database` (dist + migrations), so the `migrate` service reuses it (`migrate.js` then `seed.js`; building the same image from two services raced on the tag, so only `worker` builds it). `docker-compose.prod.yml` rewritten: required `JWT_SECRET`/`API_KEY_HASH_SALT`/`POSTGRES_PASSWORD`/`GRAFANA_ADMIN_PASSWORD`, no `API_KEY`/`PORT`/`SHUTDOWN_TIMEOUT`, no `container_name`+`replicas` clash, pinned Prometheus v3.15.0 and Grafana 13.2.4, only dashboard/Prometheus/Grafana publish ports (8080/9092/3003), **Redis `allkeys-lru` changed to `noeviction`** (LRU would silently evict queued jobs), default `WORKER_QUEUES` now matches the seeded queues, nonexistent `init.sql` mount removed. `prometheus.stack.yml` uses DNS service discovery per replica. **Verified live** with 2 API + 2 worker replicas: migrate+seed exit 0, 3 jobs through nginx `SUCCEEDED` (a deliberately invalid payload went to DLQ), Prometheus scraped all 4 replicas, Grafana provisioned and its datasource healthy, snapshot panels not multiplied by replicas (`avg without (instance, job)`), `docker stop` ~2 s exit 0 for API and worker; torn down with `down -v` under project `taskflow-prod` (dev volumes untouched). Metrics: worker recorder + `/metrics` server (`WORKER_METRICS_PORT/HOST`, **unauthenticated**), API snapshot gauges + HTTP hook, Prometheus dev config, Grafana dashboard (27 panels, 0 query errors; Live-workers duplicate series fixed with `job="taskflow-api"`). **Removed 13 metrics that nothing ever wrote** (db/redis/rate-limit/idempotency/consumer-lag/scheduler-lag/retry-attempts) and rewrote `packages/observability/README.md` (it described 70+ metrics and an API that do not exist); fixed `rate-limiting.md`/`chaos-testing.md` references to metrics that never existed. Rate limits env-configurable with tests. CI: artifact v3→v4, codeql v2→v4, pnpm/action-setup→v4, dependency-review→v4, github-script→v7, trivy/trufflehog pinned to release tags, Semgrep moved to its container image, `docker-compose-test` replaced by a real prod-stack smoke job (its steps were run locally in bash; a `set -o pipefail` + `head -1` SIGPIPE bug in my first draft was found and fixed that way), `deploy.yml` marked placeholder; all YAML parses. Docs rewritten: `docker-production.md` (583→~60 lines), `grafana-dashboard.md`, `ci-cd.md`, `observability.md`; deleted `docker-optimization.md` and `.github/workflows/README.md`. Gates after all changes: build 11/11, typecheck 19/19, lint 18/18, format ok, unit (worker 116, api 42, db 41, queue 31, retry 25, obs 5, tests 4), DB contract 15/15, worker-integration 29/29 (first run failed: `tests/vitest.config.ts` aliases `@taskflow/observability` to `src`, so the worker's deep import `@taskflow/observability/dist/metrics` did not resolve; alias added), api-runtime 10/10, migrations 6/6, observability-integration 1/1. Not verified: workflows on GitHub itself; the prod stack under load. Known gaps left: `rate-limiting.md` (~900 lines, much aspirational) and `performance-engineering.md` are for Task 9 deletion/rewrite.
- (session 3) **Task 7 done.** `pnpm install --frozen-lockfile` ok; build 11/11; typecheck 19/19; lint 18/18; format ok; unit (worker 116, api 42, db 41 + 15 contract, queue 31, retry 25, obs 5, tests 4); `test:migrations` 6/6; `test:api-runtime` 10/10; `test:observability-integration` 1/1; `test:worker-integration` 29/29; dashboard build ok. Dev smoke: valid `process-data` → `SUCCEEDED` (1 attempt); payload missing `operation` → `DEAD_LETTERED` after 1 attempt. No suite skipped.
- (session 3) **Task 8 done.** `docs/benchmarking/RESULTS.md` has measured numbers for scenarios 1-5 with commands and environment; `BENCHMARK_REPORT.md` (projections) deleted. Tools: `tests/load/bench.js` (k6, admission and enqueue modes), `bench.sh` (separate `taskflow_bench` DB, built processes, reset only bench data), `bench-drain.sh`, `bench-scaling.sh`, `bench-crash.sh`, `bench-term.sh`; `noop` handler behind `ENABLE_BENCHMARK_HANDLERS`. Headline: API admission 500 req/s with p99 346 ms and 0 errors (p99 > 1 s at 750); drain 221/241/203 jobs/s for 1/2/4 workers (Postgres-bound, does not scale on one laptop); `SIGKILL` of a worker: 0 lost, 8 re-run after the 30 s lease; `SIGTERM`: 0 re-attempts, 2 `lease_released`. **The benchmarks exposed three real defects, all fixed:** (1) blocking `XREADGROUP` shared the dispatcher's Redis connection, so an idle worker published ~3 jobs/s (now a dedicated blocking connection; regression test `blocking-connection.test.ts`); (2) the poll loop slept a fixed `pollIntervalMs` when all slots were busy, capping each worker at concurrency/250 ms = 80 jobs/s (now wakes on slot release; test in `worker-delivery.test.ts`; `process-data` 1 worker 80 -> 224 jobs/s); (3) `getQueuesWithClaimableDeliveries` scanned all pending rows each cycle (now `EXISTS` per queue; no measurable throughput change, said so in RESULTS). I also spent time on a wrong lead first (a `pg_stat_statements` / `synchronous_commit=off` investigation; both reverted, Postgres `shared_preload_libraries` reset and container restarted). Gates re-run after these fixes: typecheck 19/19, lint 18/18, unit (worker 117, queue 32, api 42, db 41, retry 25, obs 5, tests 4), worker-integration 29/29, api-runtime 10/10, migrations 6/6, observability-integration 1/1, DB contract 15/15. Dev API/worker restarted (terminals 2 and 3); smoke job `SUCCEEDED`.
- (session 3) **Task 9 done.** README rewritten (157 lines): pitch, mermaid architecture and state diagrams, guarantees table, measured-results table (from RESULTS.md), quick start, Docker stack, verification matrix, layout, limitations. `db:create-api-key` now prints only the key on stdout (`quiet-logs.ts` sets `LOG_LEVEL=fatal` before the logger loads; status text goes to stderr; a bare `--` from pnpm is ignored); root script uses `pnpm exec tsx` so no pnpm banner; verified `pnpm -s db:create-api-key --name x | wc -l` is `1`, also via `-- --name`, and via `node dist/...`. ADR-011 (shutdown releases leases) and ADR-012 (priority window) added; ADR index fixed (it listed 7 ADRs that were never written; dangling links removed). Deleted (all tracked and clean, so restorable from git): `aws-deployment`, `workflow-badges`, `redis-optimization`, `query-optimization`, `performance-engineering`, `load-testing`, `security-audit` (a dated 2026-08-23 report of "critical vulnerabilities" that no longer matched the code), plus `scripts/performance-report.ts` (imported the deleted performance package) and its `perf:report` script. Rewrote `system-overview.md` (it described a write-ahead + sweeper design and "100K jobs/sec" scaling that never existed), `rate-limiting.md` (940 lines to about 60: it claimed 10,000 req/s benchmarks and "fails open" for every limiter, but submission/mutation fail closed), `database-schema.md` (added the missing `job_deliveries` outbox table, dispatch query, worker FK `SET NULL`, no-renewal-events note), `workspace-scope.md`, `P2_SCOPE.md`, `testing.md`; removed fabricated claims in ADR-001 ("10K+ jobs/sec") and ADR-010 ("I actually benchmarked them" vs BullMQ; no such benchmark exists). All markdown links in docs/README resolve; format/lint/build clean. **Not rewritten, and likely still partly aspirational:** `docs/chaos-testing.md` (834 lines), `docs/failure-model/README.md` (~970 lines, mentions alerts that do not exist), `docs/idempotency.md`, `docs/leases-and-heartbeats.md` (partly corrected earlier), `packages/queue/README.md`; they contain no performance numbers I could find, but treat their operational claims as unverified.
- (session 3) **Task 10 done.** `docs/report/taskflow-ieee.tex` (IEEEtran, 6 pages, 15 references) compiled with tectonic 0.17 (installed via Homebrew with your approval) to `taskflow-ieee.pdf`; TikZ architecture and state figures, matplotlib charts from `figures/make_figures.py`. Author block: Pankaj Baid, baidpankaj567@gmail.com; **affiliation is a placeholder**. Related-work table uses only statements I fetched from the Celery, Sidekiq, BullMQ, Temporal, Redis and PostgreSQL documentation (accessed Oct. 21, 2026); no other system was benchmarked. Consistency check: all 19 integration-test titles cited in the failure table exist in `worker-runtime.test.ts` (scripted); admission and drain numbers match RESULTS.md (means recomputed: 221/241/203); LOC and test counts were measured with `wc -l` and the suite outputs. Reference fields I could not confirm (page numbers, DOIs) are omitted.
