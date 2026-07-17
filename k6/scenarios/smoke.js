// Quick smoke test: 1 VU, 1 iteration
import { pgrLifecycle, transactionDuration, transactionSuccess } from './pgr-lifecycle.js';
import { makeHandleSummary, reportThresholds } from '../helpers/report.js';

// No `scenarios` block → k6 uses the implicit scenario named 'default'.
const META = {
  title: 'Smoke test',
  description: '1 VU, 1 iteration — validate the full lifecycle works before load.',
  scenarios: ['default'],
};

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: reportThresholds(META.scenarios),
};

export const handleSummary = makeHandleSummary(META);

export default function () {
  pgrLifecycle();
}
