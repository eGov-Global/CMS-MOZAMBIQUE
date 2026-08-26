// Soak / endurance test.
//
// Holds a modest, steady arrival rate for a long duration to surface issues that
// short ramps never hit: memory leaks, DB connection-pool exhaustion, Kafka /
// persister lag build-up, ElasticSearch/index bloat, and slow latency drift as
// the dataset grows. Watch transaction_duration and http_req_duration over time
// (report.html time-series) for upward trends, not just the final percentile.
//
// Tunables (env): RATE (iters/s, default 10), DURATION (default 2h),
// PRE_VUS, MAX_VUS.
import { pgrLifecycle, transactionDuration, transactionSuccess } from './pgr-lifecycle.js';
import { THRESHOLDS } from '../config/thresholds.js';
import { makeHandleSummary, reportThresholds } from '../helpers/report.js';

const RATE = Number(__ENV.RATE || 10);
const DURATION = __ENV.DURATION || '2h';
const PRE_VUS = Number(__ENV.PRE_VUS || 50);
const MAX_VUS = Number(__ENV.MAX_VUS || 200);

const META = {
  title: 'Soak / endurance',
  description: `Steady ${RATE} iters/s for ${DURATION} — watch for latency drift / leaks over time.`,
  scenarios: ['warmup', 'main'],
};

export const options = {
  scenarios: {
    warmup: {
      executor: 'constant-arrival-rate',
      rate: Math.max(1, Math.round(RATE / 2)),
      timeUnit: '1s',
      duration: '1m',
      preAllocatedVUs: Math.max(5, Math.round(PRE_VUS / 2)),
      maxVUs: MAX_VUS,
      exec: 'warmupFn',
    },
    main: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: PRE_VUS,
      maxVUs: MAX_VUS,
      startTime: '1m',
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
