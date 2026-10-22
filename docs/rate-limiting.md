# Rate limiting

Each request is checked against a per-key quota before the route handler runs. The limiter is `apps/api/src/middleware/rate-limiter.ts`.

## Algorithm

A **sliding-window log** in Redis, decided by one Lua script so concurrent requests cannot both read the same count and then both add themselves:

1. Read the time from Redis (`TIME`), so API instances with skewed clocks agree.
2. Drop entries older than the window (`ZREMRANGEBYSCORE`).
3. If the remaining count is at the limit, reject. Otherwise add this request (`ZADD`).
4. Set the key's expiry to twice the window.

The key is `taskflow:rate-limit:{scope}:{identity}`. Memory is proportional to the number of requests inside the window, per key. Compared with a fixed window there is no burst at the window boundary; compared with a token bucket there is no burst allowance.

## Policies

| Preset          | Scope            | Identity  | Default per minute | Env variable                        | If Redis is unavailable |
| --------------- | ---------------- | --------- | -----------------: | ----------------------------------- | ----------------------- |
| `jobSubmission` | `job-submission` | user id   |                 50 | `RATE_LIMIT_JOB_SUBMISSION_PER_MIN` | reject with `503`       |
| `mutation`      | `mutation`       | user id   |                 50 | `RATE_LIMIT_MUTATION_PER_MIN`       | reject with `503`       |
| `read`          | `read`           | user id   |                200 | `RATE_LIMIT_READ_PER_MIN`           | allow                   |
| `health`        | `observability`  | client IP |               1000 | `RATE_LIMIT_METRICS_PER_MIN`        | allow                   |

State-changing requests fail **closed** because admitting them without a quota check removes the protection; reads and observability fail open so a Redis outage does not take down reads. The window is 60 seconds for every preset. Each rejection or Redis failure is logged (`Rate limit exceeded` at `warn`, `Rate limiter unavailable` at `error`).

The client IP comes from `request.ip`. It only reflects `X-Forwarded-For` for proxies listed in `API_TRUSTED_PROXIES`; behind nginx or a load balancer set it, or every request appears to come from the proxy.

## Responses

Every checked response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (epoch milliseconds when the oldest counted request leaves the window). A rejected request returns `429` with `Retry-After` in seconds and a JSON body with `error`, `message`, `statusCode`, `timestamp` and `retryAfter`.

## Tuning for load tests

The limits are per user, so a single benchmark key hits them quickly. Raise them with the variables above (the benchmarks in `docs/benchmarking/RESULTS.md` use 100,000,000 per minute so the limiter does not hide the system under test). The limits are read at startup.

## Monitoring

There is no dedicated rate-limit metric. A rejected request is an ordinary HTTP response, so it appears in `taskflow_http_requests_total{status="429"}` and in the Grafana panel "Request rate by status":

```promql
sum(rate(taskflow_http_requests_total{status="429"}[5m]))
  / sum(rate(taskflow_http_requests_total[5m]))
```

There are no alert rules in this repository.

## Tests

`apps/api/src/__tests__/rate-limiter.test.ts` checks, with a fake Redis client, that one scoped `EVAL` is issued, that spoofed forwarding headers are ignored unless the proxy is trusted, that a denial returns the `429` body without running the route, and that writes fail closed while reads fail open. `rate-limit-config.test.ts` covers the environment variables and presets. **The Lua script itself is not executed by any test**, and no test measures limiter throughput or latency.

## Not implemented

Per-tier limits, burst allowance, dynamic limits, geolocation-based limits and a Redis-cluster-safe key layout. The Lua script touches one key, so it would work on a cluster, but that has not been tried.
