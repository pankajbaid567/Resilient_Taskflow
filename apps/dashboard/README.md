# TaskFlow Dashboard

A React single-page app for operating TaskFlow: watch jobs, queues and workers,
and act on them (cancel, retry dead-lettered jobs, pause queues, stop workers).
It only calls the public API; it holds no state of its own.

## Pages

| Page              | Shows                                                                 | Actions                |
| ----------------- | --------------------------------------------------------------------- | ---------------------- |
| Dashboard         | Active workers, queued/processing, success rate, run time, throughput | none                   |
| Jobs              | Your jobs, filterable by status, paginated; detail with result/error  | cancel                 |
| Queues            | Per-queue counts, run time, stream entries, config, paused state      | pause / resume (admin) |
| Workers           | Workers by status, load, success rate, heartbeat health               | stop (admin)           |
| Dead Letter Queue | Dead-lettered jobs with their error                                   | retry as a new job     |

Admin-only buttons are visible to everyone; the API answers 403 for non-admin
keys and the page says so.

## Running it

```bash
pnpm install
pnpm dev:api        # API on :3000
pnpm dev:dashboard  # dashboard on :3001
```

Open <http://localhost:3001> and sign in with an API key. Create one with:

```bash
pnpm db:create-api-key -- --email you@example.com --role admin --name dashboard
```

The key is kept in `sessionStorage` for the tab only. It is never compiled into
the bundle (a `VITE_*` variable would be public). If the server rejects a stored
key (revoked, expired), the app returns to the sign-in screen.

The Vite dev server proxies `/api` and `/health` to `http://localhost:3000`, so
no CORS setup is needed in development.

## Configuration

| Variable       | Default   | Notes                                                                                                      |
| -------------- | --------- | ---------------------------------------------------------------------------------------------------------- |
| `VITE_API_URL` | `/api/v1` | Vite inlines it at **build** time. Probe URLs (`/health/ready`) are derived from it by dropping `/api/v1`. |

## What the numbers mean

Nothing on the Dashboard is estimated.

- **Active workers** counts workers marked `ACTIVE` that also have a heartbeat
  in the last 30 s. A crashed worker stays `ACTIVE` in the database, so status
  alone would overcount.
- **Success rate** is succeeded / (succeeded + failed + dead-lettered) over jobs
  still retained in PostgreSQL (retention purges old ones).
- **Avg run time** is the mean of started-to-finished for succeeded jobs,
  weighted by count across queues.
- **Throughput** is the change in the succeeded count between the last two
  5-second refreshes. It shows "—" until two samples exist, or if the count fell
  (for example after a retention purge).
- **Redis stream entries** is the stream length, which includes acknowledged
  entries until retention trims them. It is not a backlog measure; use "Queued".
- Percentile latency (p95/p99) is not shown: the API does not expose it.
  Prometheus/Grafana is the place for that.

## Data fetching

`useAPI(key, fetcher, options)` (`src/hooks/useAPI.ts`):

- refetches only when `key`, `skip` or `pollingInterval` change, so inline
  fetcher arrows are safe;
- keeps one request in flight per hook: the next poll is scheduled after the
  previous one settles;
- discards a response that arrives for an outdated key or after unmount;
- pauses polling while the tab is hidden and refreshes when it returns;
- on a failed refresh keeps the last good data and shows the error beside it.

Polling: Dashboard and Queues 5 s, Workers 5 s, Jobs 5 s, DLQ 10 s, an open job
dialog 3 s.

## Structure

```
src/
  auth/        AuthProvider (sessionStorage key, sign-in/out), useAuth
  components/  Layout, Modal (focus-trapped dialog), StatusBadge, Notice, ...
  hooks/       useAPI and the per-resource hooks
  lib/         api-client (typed, one place that knows the API), utils
  pages/       Dashboard, Jobs, Queues, Workers, DeadLetterQueue, SignIn
  types/       API response shapes
```

## Accessibility

Form controls are labelled, dialogs use `role="dialog"` with focus trapping and
focus return, statuses are always text (never colour alone), tables have column
headers, and errors use `role="alert"`. This has not been audited with assistive
technology; it needs manual screen-reader and keyboard testing.

## Limitations

- The API returns no job `payload`, so the job dialog shows result and error only.
- The Jobs list cannot filter by queue (the endpoint accepts only status).
- There is no role endpoint, so admin buttons cannot be hidden up front.
- The Docker image and nginx config for this app are being reworked separately;
  until then run it with the dev server.
