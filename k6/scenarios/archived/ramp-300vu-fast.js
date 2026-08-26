import { pgrLifecycle, transactionDuration, transactionSuccess } from '../pgr-lifecycle.js';
import { THRESHOLDS } from '../../config/thresholds.js';
import { makeHandleSummary, reportThresholds } from '../../helpers/report.js';

const META = {
  title: 'Ramp 300 VU (fast)',
  description: '30s warmup (5 VUs), 30s ramp to 300 VUs, 3m steady, 15s ramp-down.',
  scenarios: ['warmup', 'main'],
};

export const options = {
  scenarios: {
    warmup: {
      executor: 'constant-vus',
      vus: 5,
      duration: '30s',
      exec: 'warmupFn',
    },
    main: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 300 },
        { duration: '3m', target: 300 },
        { duration: '15s', target: 0 },
      ],
      startTime: '30s',
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
