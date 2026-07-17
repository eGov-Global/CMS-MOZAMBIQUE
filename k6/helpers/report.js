// Shared reporting helpers for the k6 scenarios.
//
// The rich HTML report (charts + tables) is generated AFTER the run by
// scripts/build-report.py, which needs both aggregates (summary.json) and
// time-series (metrics.csv) — data k6's handleSummary can't access on its own.
// So here handleSummary just writes summary.json + meta.json (title/description
// for the builder) + a compact console summary.
//
// k6 only surfaces tagged sub-metrics in handleSummary `data`/summary.json when a
// threshold is declared for them, so reportThresholds() declares trivial always-pass
// thresholds for the scenario/API/error breakdowns the report renders. Requests are
// tagged with `name` in the helpers; k6 auto-tags every sample with `scenario`.
import { Counter } from 'k6/metrics';

// API endpoints, keyed by the request `name` tag set in helpers/pgr.js + auth.js.
export const API_NAMES = [
  'Auth_Login', 'PGR_Create', 'PGR_Assign', 'PGR_Resolve', 'PGR_Search', 'PGR_List',
];

// HTTP statuses enumerated for the per-API failure breakdown (0 = timeout/no response).
const COMMON_STATUSES = [0, 400, 401, 403, 404, 408, 409, 422, 429, 500, 502, 503, 504];

// Counter incremented by helpers on every failed call, tagged {name, status}.
export const apiErrors = new Counter('api_errors');

/**
 * Trivial always-pass thresholds that force the scenario/API/error sub-metrics to
 * appear in summary.json. Spread into a scenario's options.thresholds.
 * @param {string[]} scenarioNames - keys of options.scenarios for this test.
 */
export function reportThresholds(scenarioNames) {
  const t = {};
  for (const s of scenarioNames || []) {
    t[`http_reqs{scenario:${s}}`] = ['count>=0'];
    t[`http_req_failed{scenario:${s}}`] = ['rate<=1'];
    t[`http_req_duration{scenario:${s}}`] = ['p(95)>=0'];
  }
  for (const n of API_NAMES) {
    t[`http_reqs{name:${n}}`] = ['count>=0'];
    t[`http_req_failed{name:${n}}`] = ['rate<=1'];
    t[`http_req_duration{name:${n}}`] = ['p(95)>=0'];
    for (const c of COMMON_STATUSES) {
      t[`api_errors{name:${n},status:${c}}`] = ['count>=0'];
    }
  }
  return t;
}

// ---- value helpers (for the console summary) -----------------------------

function vals(data, key) {
  const m = data.metrics && data.metrics[key];
  return (m && m.values) ? m.values : {};
}
function num(v, d = 0) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
function f0(v) { return num(v).toFixed(0); }
function f1(v) { return num(v).toFixed(1); }

// ---- compact console summary (no remote jslib dependency) ----------------

function textSummary(data, meta) {
  const reqs = vals(data, 'http_reqs');
  const failed = vals(data, 'http_req_failed');
  const dur = vals(data, 'http_req_duration');
  const txSucc = vals(data, 'transaction_success');
  const breaches = [];
  for (const [key, met] of Object.entries(data.metrics || {})) {
    if (met.thresholds) {
      for (const [src, res] of Object.entries(met.thresholds)) {
        if (res && res.ok === false) breaches.push(`${key}: ${src}`);
      }
    }
  }
  const lines = [
    '',
    `  ${(meta && meta.title) || 'k6 Load Test'}`,
    (meta && meta.description) ? `  ${meta.description}` : '',
    `  requests=${f0(reqs.count)}  http_error=${f1(num(failed.rate) * 100)}%  p95=${f0(dur['p(95)'])}ms` +
      (typeof txSucc.rate === 'number' ? `  tx_success=${f1(txSucc.rate * 100)}%` : ''),
    breaches.length ? `  THRESHOLD BREACHES (${breaches.length}):` : '  thresholds: all passed',
    ...breaches.map((b) => `    ✗ ${b}`),
    '',
  ];
  return lines.filter((l) => l !== '').join('\n') + '\n';
}

/**
 * Build a handleSummary() that writes summary.json + meta.json for the post-run
 * report builder. run-test.sh passes OUT_DIR so files land in the result dir;
 * without it (ad-hoc `k6 run`) they're written to the current directory.
 * @param {{title:string, description?:string, scenarios?:string[]}} meta
 */
export function makeHandleSummary(meta) {
  return function handleSummary(data) {
    const dir = __ENV.OUT_DIR ? __ENV.OUT_DIR.replace(/\/+$/, '') + '/' : '';
    return {
      [`${dir}summary.json`]: JSON.stringify(data),
      [`${dir}meta.json`]: JSON.stringify(meta || {}),
      stdout: textSummary(data, meta),
    };
  };
}
