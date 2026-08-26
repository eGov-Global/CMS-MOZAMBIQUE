// Open-model load test.
//
// Unlike the ramping-vus scenarios (closed model, where a slow server reduces
// offered load), this drives a target request rate independent of latency using
// arrival-rate executors. This avoids coordinated omission: when the system
// saturates you see rising latency and dropped_iterations rather than the load
// silently throttling itself.
//
// Tunables (env): RATE (iters/s target, default 20), PRE_VUS, MAX_VUS.
import { pgrLifecycle, transactionDuration, transactionSuccess } from './pgr-lifecycle.js';
import { THRESHOLDS } from '../config/thresholds.js';
import { makeHandleSummary, reportThresholds } from '../helpers/report.js';

const RATE = Number(__ENV.RATE || 20);
const PRE_VUS = Number(__ENV.PRE_VUS || 50);
const MAX_VUS = Number(__ENV.MAX_VUS || 300);

const META = {
  title: 'Open-model arrival rate',
  description: `Drives ${RATE} iters/s (open model) — 2m warmup, 2m ramp, 5m steady, 1m down.`,
  scenarios: ['warmup', 'main'],
};

export const options = {
  scenarios: {
    warmup: {
      executor: 'constant-arrival-rate',
      rate: Math.max(1, Math.round(RATE / 4)),
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: Math.max(5, Math.round(PRE_VUS / 4)),
      maxVUs: MAX_VUS,
      exec: 'warmupFn',
    },
    main: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: PRE_VUS,
      maxVUs: MAX_VUS,
      stages: [
        { duration: '2m', target: RATE },
        { duration: '5m', target: RATE },
        { duration: '1m', target: 0 },
      ],
      startTime: '2m',
      exec: 'mainFn',
    },
  },
  thresholds: { ...THRESHOLDS, ...reportThresholds(META.scenarios) },
};

export const handleSummary = makeHandleSummary(META);

export function warmupFn() {
  pgrLifecycle();
}

export function mainFn() {
  pgrLifecycle();
}
