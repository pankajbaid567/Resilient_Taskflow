#!/usr/bin/env bash
# Scenarios 2 and 3: drain time versus worker count, repeated REPS times.
#
#   tests/load/bench-scaling.sh [REPS]      (default 3)
#
# Output: one line per run, "<type> workers=<n> run=<i> jobs/s=<x>".
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPS="${1:-3}"
run() {
  local type="$1" count="$2" workers="$3" rep="$4"
  "$ROOT/tests/load/bench.sh" api >/dev/null
  local out
  out="$("$ROOT/tests/load/bench-drain.sh" "$workers" "$count" "$type" 2>&1)"
  local rate
  rate="$(echo "$out" | grep 'first-start to last-complete' | sed -E 's/.* ([0-9]+) jobs\/s$/\1/')"
  local p99
  p99="$(echo "$out" | grep 'end-to-end' | sed -E 's/.*\/ ([0-9]+)$/\1/')"
  echo "$type count=$count workers=$workers run=$rep jobs/s=$rate e2e_p99_ms=$p99"
}
for rep in $(seq 1 "$REPS"); do
  for w in 1 2 4; do run noop 20000 "$w" "$rep"; done
done
for rep in $(seq 1 "$REPS"); do
  run process-data 5000 4 "$rep"
done
