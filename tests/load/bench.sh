#!/usr/bin/env bash
# Helpers for the benchmarks in docs/benchmarking/RESULTS.md.
#
# Runs the BUILT API and worker (no tsx, no watch) against a dedicated database
# named taskflow_bench, never the development database. Requires the dev
# compose stack (Postgres and Redis containers) to be running and `pnpm build`
# to have been run. Redis is shared with the dev stack, so stop any dev worker
# first: it would consume benchmark jobs.
#
#   tests/load/bench.sh setup              create taskflow_bench, migrate, seed, create an API key
#   tests/load/bench.sh reset              empty the bench data and the bench Redis streams
#   tests/load/bench.sh api                start the API
#   tests/load/bench.sh workers N [CONC]   start N workers (default concurrency 20)
#   tests/load/bench.sh kill-worker [i]    SIGKILL worker i (default 1)
#   tests/load/bench.sh term-worker [i]    SIGTERM worker i (default 1)
#   tests/load/bench.sh stop               stop everything this script started
#   tests/load/bench.sh sql "<query>"      run a query against taskflow_bench
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIR="${BENCH_DIR:-/tmp/tf-bench}"
PG_CONTAINER="${PG_CONTAINER:-taskflow-postgres}"
REDIS_CONTAINER="${REDIS_CONTAINER:-taskflow-redis}"
PG_USER="${PG_USER:-taskflow}"
PG_PASSWORD="${PG_PASSWORD:-taskflow_password}"
BENCH_DB="taskflow_bench"
export BENCH_DATABASE_URL="postgresql://${PG_USER}:${PG_PASSWORD}@localhost:5432/${BENCH_DB}"
mkdir -p "$DIR"

# The API-key salt must match between key creation and the API process.
salt() { grep -E '^API_KEY_HASH_SALT=' "$ROOT/.env" | cut -d= -f2-; }

# Environment shared by the benchmarked processes. Rate limits are raised so
# the limiter does not hide the system under test.
# `run_env --exec ...` replaces the (backgrounded) subshell, so $! is the PID of
# the node process itself and can be signalled directly.
run_env() {
  local launcher=""
  if [ "${1:-}" = "--exec" ]; then launcher="exec"; shift; fi
  $launcher env DATABASE_URL="$BENCH_DATABASE_URL" REDIS_URL="redis://localhost:6379" \
    API_KEY_HASH_SALT="$(salt)" NODE_ENV=production LOG_LEVEL=warn \
    RATE_LIMIT_JOB_SUBMISSION_PER_MIN=100000000 RATE_LIMIT_MUTATION_PER_MIN=100000000 \
    RATE_LIMIT_READ_PER_MIN=100000000 RATE_LIMIT_METRICS_PER_MIN=100000000 \
    ENABLE_BENCHMARK_HANDLERS=true WORKER_METRICS_PORT=0 "$@"
}

sql() { docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$BENCH_DB" -At -c "$1"; }

cmd="${1:-}"; shift || true
case "$cmd" in
  setup)
    docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -c "CREATE DATABASE ${BENCH_DB}" 2>&1 || true
    run_env node "$ROOT/packages/database/dist/migrate.js" >/dev/null
    run_env node "$ROOT/packages/database/dist/seed.js" >/dev/null
    rm -f "$DIR/api-key"
    run_env node "$ROOT/packages/database/dist/create-api-key.js" --role admin --name bench --out "$DIR/api-key" >/dev/null
    echo "bench database ready; API key in $DIR/api-key"
    ;;
  reset)
    # TRUNCATE is only ever issued against the bench database.
    sql "TRUNCATE jobs, job_events, job_attempts, job_deliveries, dead_letter_jobs, idempotency_keys, workers, operational_audit_logs RESTART IDENTITY CASCADE" >/dev/null
    for k in $(docker exec "$REDIS_CONTAINER" redis-cli --scan --pattern 'taskflow:queue:*'); do
      docker exec "$REDIS_CONTAINER" redis-cli DEL "$k" >/dev/null
    done
    echo "bench data reset"
    ;;
  api)
    run_env --exec nohup node "$ROOT/apps/api/dist/index.js" >"$DIR/api.log" 2>&1 &
    echo $! >"$DIR/api.pid"
    for _ in $(seq 1 30); do
      curl -fs http://localhost:3000/health/live >/dev/null 2>&1 && { echo "api up (pid $(cat "$DIR/api.pid"))"; exit 0; }
      sleep 1
    done
    echo "api did not start" >&2; tail -20 "$DIR/api.log" >&2; exit 1
    ;;
  workers)
    n="${1:-1}"; conc="${2:-20}"
    for i in $(seq 1 "$n"); do
      run_env --exec WORKER_CONCURRENCY="$conc" nohup node "$ROOT/apps/worker/dist/index.js" >"$DIR/worker-$i.log" 2>&1 &
      echo $! >"$DIR/worker-$i.pid"
    done
    echo "started $n worker(s), concurrency $conc"
    ;;
  kill-worker) kill -9 "$(cat "$DIR/worker-${1:-1}.pid")"; echo "SIGKILL worker ${1:-1}" ;;
  term-worker) kill -TERM "$(cat "$DIR/worker-${1:-1}.pid")"; echo "SIGTERM worker ${1:-1}" ;;
  stop)
    for f in "$DIR"/*.pid; do
      [ -e "$f" ] || continue
      pid="$(cat "$f")"
      kill -TERM "$pid" 2>/dev/null || true
      # Give a graceful shutdown up to 20 s, then force it.
      for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
      kill -9 "$pid" 2>/dev/null || true
      rm -f "$f"
    done
    echo "stopped"
    ;;
  sql) sql "$1" ;;
  *) sed -n 2,22p "${BASH_SOURCE[0]}"; exit 1 ;;
esac
