// Stress-to-failure test.
//
// Ramps the arrival rate well past the expected knee to find the breakpoint and
// observe recovery. Thresholds here are NOT correctness gates — they define
// "system is clearly saturated" and abort the run (abortOnFail) so we don't keep
// hammering a dead system. Read the result as: at what req/s did latency/errors
// blow past the ceiling? (Inspect report.html time-series for the exact point.)
//
// Tunables (env): PEAK (top rate iters/s, default 400), STEP (duration per step),
// PRE_VUS, MAX_VUS.
import { pgrLifecycle, transactionDuration, transactionSuccess } from './pgr-lifecycle.js';
import { makeHandleSummary, reportThresholds } from '../helpers/report.js';

const PEAK = Number(__ENV.PEAK || 400);
const STEP = __ENV.STEP || '2m';
const PRE_VUS = Number(__ENV.PRE_VUS || 100);
const MAX_VUS = Number(__ENV.MAX_VUS || 1000);

const META = {
  title: 'Stress to failure',
  description: `Ramps arrival rate to ${PEAK} iters/s; aborts once the saturation ceiling is crossed.`,
  scenarios: ['main'],
};

// Saturation ceiling — crossing any of these aborts the run.
const THRESHOLDS_STRESS = {
  'http_req_failed{scenario:main}': [{ threshold: 'rate<0.10', abortOnFail: true }],
  'http_req_duration{scenario:main}': [{ threshold: 'p(95)<30000', abortOnFail: true }],
  'transaction_success{scenario:main}': ['rate>0.80'],
};

export const options = {
  scenarios: {
    main: {
      executor: 'ramping-arrival-rate',
      startRate: Math.max(1, Math.round(PEAK / 16)),
      timeUnit: '1s',
      preAllocatedVUs: PRE_VUS,
      maxVUs: MAX_VUS,
      stages: [
        { duration: STEP, target: Math.round(PEAK / 8) },
        { duration: STEP, target: Math.round(PEAK / 4) },
        { duration: STEP, target: Math.round(PEAK / 2) },
        { duration: STEP, target: Math.round((PEAK * 3) / 4) },
        { duration: STEP, target: PEAK },
        { duration: STEP, target: PEAK },
      ],
      exec: 'mainFn',
    },
  },
  thresholds: { ...THRESHOLDS_STRESS, ...reportThresholds(META.scenarios) },
};

export const handleSummary = makeHandleSummary(META);

export function mainFn() {
  pgrLifecycle();
}
