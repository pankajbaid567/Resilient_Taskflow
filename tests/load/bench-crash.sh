#!/usr/bin/env bash
# Crash-recovery benchmark: enqueue COUNT jobs, start two workers, SIGKILL one
# when KILL_AT jobs have succeeded, then wait for every job to finish.
#
#   tests/load/bench-crash.sh [COUNT] [TYPE] [KILL_AT]
#
# Reports lost jobs (must be 0), jobs executed more than once and the time from
# the kill until the last job finished. Needs the API running.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
B="$ROOT/tests/load/bench.sh"
COUNT="${1:-10000}"; TYPE="${2:-process-data}"; KILL_AT="${3:-$((COUNT / 2))}"
KEY="$(cat "${BENCH_DIR:-/tmp/tf-bench}/api-key")"

"$B" reset >/dev/null
K6_API_KEY="$KEY" MODE=enqueue COUNT="$COUNT" VUS=50 JOB_TYPE="$TYPE" \
  k6 run --quiet "$ROOT/tests/load/bench.js" >/dev/null 2>&1
echo "enqueued: $("$B" sql "SELECT count(*) FROM jobs")"

"$B" workers 2 20 >/dev/null
while [ "$("$B" sql "SELECT count(*) FROM jobs WHERE status='SUCCEEDED'")" -lt "$KILL_AT" ]; do sleep 0.2; done
in_flight="$("$B" sql "SELECT count(*) FROM jobs WHERE status='PROCESSING'")"
kill_ts=$(python3 -c 'import time;print(time.time())')
"$B" kill-worker 1
echo "jobs PROCESSING at kill: $in_flight; SUCCEEDED at kill: $("$B" sql "SELECT count(*) FROM jobs WHERE status='SUCCEEDED'")"

while [ "$("$B" sql "SELECT count(*) FROM jobs WHERE status IN ('SUCCEEDED','DEAD_LETTERED','FAILED','CANCELLED')")" != "$COUNT" ]; do sleep 0.5; done
end_ts=$(python3 -c 'import time;print(time.time())')
python3 - "$kill_ts" "$end_ts" <<'EOF'
import sys
print(f"kill to last job finished: {float(sys.argv[2])-float(sys.argv[1]):.1f}s")
EOF
"$B" sql "SELECT status || ': ' || count(*) FROM jobs GROUP BY status"
"$B" sql "SELECT 'jobs executed more than once (attempts > 1): ' || count(*) FROM jobs WHERE attempts > 1"
"$B" sql "SELECT 'lost jobs (submitted - finished): ' || ($COUNT - count(*)) FROM jobs WHERE status IN ('SUCCEEDED','DEAD_LETTERED','FAILED','CANCELLED')"
"$B" sql "SELECT 'latest finish of a re-run job minus kill, s: ' || round(EXTRACT(EPOCH FROM max(completed_at))::numeric - $kill_ts::numeric, 1) FROM jobs WHERE attempts > 1"
"$B" sql "SELECT event_type || ': ' || count(*) FROM job_events WHERE event_type NOT IN ('created','queued','lease_acquired','attempt_started','completed') GROUP BY event_type ORDER BY 1"
"$B" stop >/dev/null
