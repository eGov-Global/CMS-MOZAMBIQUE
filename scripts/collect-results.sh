#!/usr/bin/env bash
# Collect all test results into a summary markdown table
# Reads summary.json from each result directory

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
RESULTS_DIR="${ROOT_DIR}/results"
SUMMARY_FILE="${RESULTS_DIR}/SUMMARY.md"

if [ ! -d "$RESULTS_DIR" ] || [ -z "$(ls -A "$RESULTS_DIR" 2>/dev/null)" ]; then
  echo "No results found in ${RESULTS_DIR}"
  exit 1
fi

cat > "$SUMMARY_FILE" <<'HEADER'
# Load Test Results Summary

| Timestamp | Machine | CPUs | Scenario | p50 (ms) | p95 (ms) | p99 (ms) | Error% | Tx/min | Success% | Pass |
|-----------|---------|------|----------|----------|----------|----------|--------|--------|----------|------|
HEADER

for dir in "$RESULTS_DIR"/*/; do
  [ -f "${dir}summary.json" ] || continue

  dirname="$(basename "$dir")"
  # Parse dirname: YYYYMMDD-HHMMSS_env_profile_scenario (underscore-separated after timestamp)
  timestamp="$(echo "$dirname" | cut -d_ -f1)"
  env="$(echo "$dirname" | cut -d_ -f2)"
  profile="$(echo "$dirname" | cut -d_ -f3)"
  scenario="$(echo "$dirname" | cut -d_ -f4)"

  # Extract metrics from k6 summary JSON using python (available on most systems)
  read -r p50 p95 p99 error_rate tx_rate success_rate <<< "$(python3 -c "
import json, sys
with open('${dir}summary.json') as f:
    data = json.load(f)

metrics = data.get('metrics', {})

# k6's --summary-export writes metric fields flat on the metric object.
# Older k6 nested them under a 'values' key; support both.
def m(name):
    v = metrics.get(name, {})
    return v.get('values', v)

# Transaction duration (falls back to med/max when p(50)/p(99) not exported)
td = m('transaction_duration')
p50 = td.get('p(50)', td.get('med', 0))
p95 = td.get('p(95)', 0)
p99 = td.get('p(99)', td.get('max', 0))

# Error rate — Rate metric exposes the fraction as 'value' (0..1)
hrf = m('http_req_failed')
error_rate = hrf.get('value', hrf.get('rate', 0)) * 100

# Success rate — custom Rate metric
ts = m('transaction_success')
success_rate = ts.get('value', ts.get('rate', 0)) * 100

# Throughput (transactions per minute) from the iteration rate
it = m('iterations')
tx_min = it.get('rate', 0) * 60
if not tx_min:
    # Fallback: ~6 HTTP requests per transaction over a rough 8-min window
    tx_min = (m('http_reqs').get('count', 0) / 6) / 8

print(f'{p50:.0f} {p95:.0f} {p99:.0f} {error_rate:.1f} {tx_min:.1f} {success_rate:.1f}')
" 2>/dev/null || echo "- - - - - -")"

  # Determine pass/fail — mirrors k6/config/thresholds.js baseline gates.
  # transaction_duration includes ~8s of think time, hence the higher latency bounds.
  pass="PASS"
  if python3 -c "
p95=${p95:-0}; p99=${p99:-0}; err=${error_rate:-100}; succ=${success_rate:-0}
if p95 > 15000 or p99 > 25000 or err > 1 or succ < 95: exit(1)
" 2>/dev/null; then
    pass="PASS"
  else
    pass="FAIL"
  fi

  echo "| ${timestamp} | ${env} | ${profile#cpu-} | ${scenario} | ${p50} | ${p95} | ${p99} | ${error_rate}% | ${tx_rate} | ${success_rate}% | ${pass} |" >> "$SUMMARY_FILE"
done

echo "Summary written to: ${SUMMARY_FILE}"
cat "$SUMMARY_FILE"
