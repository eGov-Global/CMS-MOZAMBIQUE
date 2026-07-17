// Quick burst test - use with: k6 run --env TARGET=prod --env VUS=20 --env DUR=2m burst.js
import { pgrLifecycle } from './pgr-lifecycle.js';
import { makeHandleSummary, reportThresholds } from '../helpers/report.js';

const vus = parseInt(__ENV.VUS || '20');
const dur = __ENV.DUR || '2m';

const META = {
  title: 'Burst',
  description: `Constant ${vus} VUs for ${dur} — VU-ceiling probe.`,
  scenarios: ['burst'],
};

export const options = {
  scenarios: {
    burst: {
      executor: 'constant-vus',
      vus: vus,
      duration: dur,
    },
  },
  thresholds: reportThresholds(META.scenarios),
};

export const handleSummary = makeHandleSummary(META);

export default function () {
  pgrLifecycle();
}
