# Redis delivery contract

Redis carries delivery notifications; PostgreSQL owns job state, attempts, results, events, retry policy, and durable outbox intent.

The shared definitions live in `packages/types` and `packages/queue`:

- stream: `taskflow:queue:{queue}:jobs`
- consumer group: `taskflow:workers`
- field: `data`
- envelope version: `1`
- envelope fields: `version`, `jobId`, `queue`, `attempt`, `enqueuedAt`

Producers and consumers validate the same queue-name and envelope schemas. The envelope attempt is a delivery hint; PostgreSQL `jobs.attempts` is authoritative for execution and retry decisions.

## Ordering and acknowledgement

1. The API or scheduler commits the job transition and a `PENDING` `job_deliveries` row in one PostgreSQL transaction.
2. The dispatcher claims due outbox rows and executes `XADD`.
3. It records the returned Redis message ID as `PUBLISHED`.
4. A worker reads through `XREADGROUP` and tries to acquire a fenced PostgreSQL lease.
5. `TERMINAL` means the handler already finished and the message can be acknowledged without rerunning it. Database errors are thrown and never treated as a terminal outcome.
6. The worker persists `SUCCEEDED`, `CANCELLED`, or `DEAD_LETTERED` before `XACK`.

If a worker dies during execution, the entry remains in the pending-entry list. A replacement uses pending reclaim after the configured idle threshold. If Redis data or group state is lost, the dispatcher scans durable published deliveries whose jobs are still nonterminal and republishes them. Duplicate delivery and handler execution are possible; arbitrary effects require handler-level idempotency.

Queue pause is stored as `queues.is_active=false`. Dispatch skips paused queues and lease acquisition rechecks the queue, closing the already-published-message race. Resume makes the existing durable outbox/pending work eligible again. Pause does not revoke an existing lease or interrupt a running handler.

The process test gate inspects PostgreSQL and `XPENDING` directly:

```bash
pnpm test:worker-integration
```
