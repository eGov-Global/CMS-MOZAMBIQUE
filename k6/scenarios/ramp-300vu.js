import { pgrLifecycle, transactionDuration, transactionSuccess } from './pgr-lifecycle.js';
import { makeHandleSummary, reportThresholds } from '../helpers/report.js';

const META = {
  title: 'Ramp 300 VU',
  description: '2m warmup (5 VUs), stepped ramp 50→300 VUs, 3m steady at 300, 1m ramp-down.',
  scenarios: ['warmup', 'main'],
};

// Relaxed thresholds for 300-VU stress profile — higher latency and error
// tolerance than the standard THRESHOLDS to avoid noisy failures under load.
const THRESHOLDS_RAMP_300 = {
  'transaction_duration{scenario:main}': ['p(95)<30000', 'p(99)<45000'],
  'transaction_success{scenario:main}': ['rate>0.90'],
  'http_req_failed{scenario:main}': ['rate<0.05'],
  'http_req_duration{scenario:main}': ['p(95)<10000', 'p(99)<20000'],
};

export const options = {
  scenarios: {
    warmup: {
      executor: 'constant-vus',
      vus: 5,
      duration: '2m',
      exec: 'warmupFn',
    },
    main: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 50 },
        { duration: '2m', target: 100 },
        { duration: '2m', target: 200 },
        { duration: '2m', target: 300 },
        { duration: '3m', target: 300 },
        { duration: '1m', target: 0 },
      ],
      startTime: '2m',
      exec: 'mainFn',
    },
  },
  thresholds: { ...THRESHOLDS_RAMP_300, ...reportThresholds(META.scenarios) },
};

export const handleSummary = makeHandleSummary(META);

export function warmupFn() {
  pgrLifecycle();
}

export function mainFn() {
  pgrLifecycle();
}
