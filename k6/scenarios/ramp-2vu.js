import { pgrLifecycle, transactionDuration, transactionSuccess } from './pgr-lifecycle.js';
import { THRESHOLDS } from '../config/thresholds.js';
import { makeHandleSummary, reportThresholds } from '../helpers/report.js';

const META = {
  title: 'Ramp 2 VU',
  description: '2m warmup (1 VU), ramp to 2 VUs, 5m steady, 1m ramp-down.',
  scenarios: ['warmup', 'main'],
};

export const options = {
  scenarios: {
    warmup: {
      executor: 'constant-vus',
      vus: 1,
      duration: '2m',
      exec: 'warmupFn',
    },
    main: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 2 },
        { duration: '5m', target: 2 },
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
