#!/usr/bin/env bash
# Run a single k6 load test
# Usage: ./scripts/run-test.sh <env> <profile> <scenario>
# Example: ./scripts/run-test.sh dev cpu-2 ramp-2vu

set -euo pipefail

ENV="${1:?Usage: $0 <env> <profile> <scenario>}"
PROFILE="${2:?Usage: $0 <env> <profile> <scenario>}"
SCENARIO="${3:?Usage: $0 <env> <profile> <scenario>}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
RESULT_DIR="${ROOT_DIR}/results/${TIMESTAMP}_${ENV}_${PROFILE}_${SCENARIO}"

mkdir -p "$RESULT_DIR"

echo "=== Load Test ==="
echo "Environment: ${ENV}"
echo "CPU Profile: ${PROFILE}"
echo "Scenario:    ${SCENARIO}"
echo "Results:     ${RESULT_DIR}"
echo "================="

# Run k6
# - handleSummary() writes summary.json + meta.json into the result dir (via OUT_DIR).
# - K6_WEB_DASHBOARD_EXPORT writes the built-in time-series report as dashboard.html;
#   the live dashboard is also served at 127.0.0.1:5665 during the run.
# - --summary-trend-stats controls the percentiles available to the report builder.
# k6 exits 99 when a threshold is crossed; capture the code so the report still builds.
set +e
K6_WEB_DASHBOARD=true \
K6_WEB_DASHBOARD_PERIOD=10s \
K6_WEB_DASHBOARD_EXPORT="${RESULT_DIR}/dashboard.html" \
k6 run \
  --no-usage-report \
  --env TARGET="${ENV}" \
  --env OUT_DIR="${RESULT_DIR}" \
  --out csv="${RESULT_DIR}/metrics.csv" \
  --out json="${RESULT_DIR}/k6-output.json" \
  --summary-trend-stats="avg,min,med,p(50),p(90),p(95),p(99),max" \
  "${ROOT_DIR}/k6/scenarios/${SCENARIO}.js" \
  2>&1 | tee "${RESULT_DIR}/console.log"
K6_RC=${PIPESTATUS[0]}
set -e

# Build the rich HTML report (charts + tables) from summary.json + metrics.csv.
python3 "${SCRIPT_DIR}/build-report.py" "${RESULT_DIR}" || echo "WARN: report build failed"

echo ""
echo "Results saved to: ${RESULT_DIR}"
echo "Custom report:    ${RESULT_DIR}/report.html"
echo "Dashboard report: ${RESULT_DIR}/dashboard.html"

# Preserve k6's exit code (99 = thresholds crossed) so CI / callers still see failures.
exit "${K6_RC}"
