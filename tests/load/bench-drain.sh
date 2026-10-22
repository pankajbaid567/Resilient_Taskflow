#!/usr/bin/env bash
# Drain benchmark: enqueue COUNT jobs while no worker is running, then start
# WORKERS workers and time how long the backlog takes to drain.
#
#   tests/load/bench-drain.sh WORKERS COUNT TYPE [CONCURRENCY]
#   e.g. tests/load/bench-drain.sh 4 20000 noop
#
# Needs the API running (tests/load/bench.sh api) and no worker running.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
B="$ROOT/tests/load/bench.sh"
WORKERS="${1:?workers}"; COUNT="${2:?count}"; TYPE="${3:?noop|process-data}"; CONC="${4:-20}"
KEY="$(cat "${BENCH_DIR:-/tmp/tf-bench}/api-key")"
OUT="$ROOT/tests/load/results/drain-${TYPE}-w${WORKERS}.json"

"$B" reset >/dev/null
K6_API_KEY="$KEY" MODE=enqueue COUNT="$COUNT" VUS=50 JOB_TYPE="$TYPE" \
  k6 run --quiet --summary-export "$OUT" "$ROOT/tests/load/bench.js" >/dev/null 2>&1
queued="$("$B" sql "SELECT count(*) FROM jobs")"
echo "enqueued: $queued"
[ "$queued" = "$COUNT" ] || { echo "enqueue incomplete" >&2; exit 1; }

start=$(python3 -c 'import time;print(time.time())')
"$B" workers "$WORKERS" "$CONC" >/dev/null
while :; do
  done_n="$("$B" sql "SELECT count(*) FROM jobs WHERE status IN ('SUCCEEDED','DEAD_LETTERED','FAILED','CANCELLED')")"
  [ "$done_n" = "$COUNT" ] && break
  sleep 1
done
end=$(python3 -c 'import time;print(time.time())')
python3 - "$start" "$end" "$COUNT" <<'EOF'
import sys
s, e, n = float(sys.argv[1]), float(sys.argv[2]), int(sys.argv[3])
print(f"wall clock from worker start to last job finished: {e-s:.1f}s ({n/(e-s):.0f} jobs/s)")
EOF
"$B" sql "SELECT status, count(*), max(attempts) FROM jobs GROUP BY status"
"$B" sql "SELECT count(*) || ' jobs, ' || round(EXTRACT(EPOCH FROM max(completed_at) - min(started_at))::numeric,1) || ' s first-start to last-complete, ' || round((count(*) / NULLIF(EXTRACT(EPOCH FROM max(completed_at) - min(started_at)),0))::numeric) || ' jobs/s' FROM jobs WHERE status='SUCCEEDED'"
"$B" sql "SELECT 'end-to-end (created to completed) ms p50/p95/p99: ' || round((percentile_cont(ARRAY[0.5,0.95,0.99]) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM completed_at - created_at)*1000))[1]::numeric) || ' / ' || round((percentile_cont(ARRAY[0.5,0.95,0.99]) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM completed_at - created_at)*1000))[2]::numeric) || ' / ' || round((percentile_cont(ARRAY[0.5,0.95,0.99]) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM completed_at - created_at)*1000))[3]::numeric) FROM jobs WHERE status='SUCCEEDED'"
"$B" sql "SELECT 'executions: ' || sum(attempts) || ' for ' || count(*) || ' jobs (>1 attempt: ' || count(*) FILTER (WHERE attempts > 1) || ')' FROM jobs"
"$B" stop >/dev/null
