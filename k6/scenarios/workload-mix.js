// Persona-weighted workload mix.
//
// Real PGR usage is read-heavy: citizens/officers browse inboxes far more often
// than they file or resolve complaints. This runs three concurrent open-model
// (arrival-rate) personas at production-like ratios so the measured mix of reads
// vs writes reflects reality, instead of the uniform write-path loop the ramp
// scenarios use.
//
//   read      (~70%) — inbox-style list search, as the Screening Officer
//   create    (~20%) — citizen submission (APPLY only)
//   lifecycle (~10%) — full create -> assign -> assign -> resolve -> verify
//
// Tunables (env): READ_RATE (35), CREATE_RATE (10), LIFECYCLE_RATE (5), DURATION (7m).
import exec from 'k6/execution';
import { Rate } from 'k6/metrics';
import { login } from '../helpers/auth.js';
import { createComplaint, listComplaints } from '../helpers/pgr.js';
// Importing pgrLifecycle registers its transaction_duration/transaction_success metrics too.
import { pgrLifecycle, transactionDuration, transactionSuccess } from './pgr-lifecycle.js';
import { makeHandleSummary, reportThresholds } from '../helpers/report.js';
import { getEnv } from '../config/environments.js';

const READ_RATE = Number(__ENV.READ_RATE || 35);
const CREATE_RATE = Number(__ENV.CREATE_RATE || 10);
const LIFECYCLE_RATE = Number(__ENV.LIFECYCLE_RATE || 5);
const DURATION = __ENV.DURATION || '7m';

// Per-persona success signal (read + create); lifecycle uses transaction_success.
export const personaSuccess = new Rate('persona_success');

const META = {
  title: 'Workload mix (personas)',
  description: `Read ${READ_RATE}/s, create ${CREATE_RATE}/s, lifecycle ${LIFECYCLE_RATE}/s for ${DURATION}.`,
  scenarios: ['read', 'create', 'lifecycle'],
};

// Small pools for the create persona (representative CCRS subset — this is load
// generation, not exhaustive coverage). Overridden by env.serviceCodes/localities
// when set.
const FALLBACK_SERVICE_CODES = [
  'PublicServicePoorServiceByEmployee', 'PublicIntegrityBriberyCorruptionRequest',
  'HealthLackOfMedicines', 'EducationTeacherMisbehavior', 'EnergyConstantPowerCuts',
  'WaterAndSanitationLackOfWaterSupply', 'PublicSafetyAbuseOfAuthority', 'OtherOther',
];
const FALLBACK_LOCALITIES = [
  { code: 'zambezia', name: 'Zambezia' },
  { code: 'sofala', name: 'Sofala' },
  { code: 'niassa', name: 'Niassa' },
];
const randomPick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Per-VU token caches (k6 module scope is per-VU). Each scenario has its own VUs.
let empToken = null, empUser = null;
let searchToken = null, searchUser = null;

function ensureEmployeeAuth(env) {
  if (!empToken) {
    const auth = login(env.baseUrl, env.username, env.password, env.tenant, 'EMPLOYEE');
    if (!auth) return false;
    empToken = auth.token; empUser = auth.userInfo;
  }
  return true;
}

function ensureSearchAuth(env) {
  if (!searchToken) {
    const auth = login(env.baseUrl, env.searchUsername, env.searchPassword, env.tenant, 'EMPLOYEE');
    if (!auth) return false;
    searchToken = auth.token; searchUser = auth.userInfo;
  }
  return true;
}

export const options = {
  scenarios: {
    read: {
      executor: 'constant-arrival-rate',
      rate: READ_RATE, timeUnit: '1s', duration: DURATION,
      preAllocatedVUs: 10, maxVUs: 100,
      exec: 'readFn',
    },
    create: {
      executor: 'constant-arrival-rate',
      rate: CREATE_RATE, timeUnit: '1s', duration: DURATION,
      preAllocatedVUs: 10, maxVUs: 100,
      exec: 'createFn',
    },
    lifecycle: {
      executor: 'constant-arrival-rate',
      rate: LIFECYCLE_RATE, timeUnit: '1s', duration: DURATION,
      preAllocatedVUs: 30, maxVUs: 200,
      exec: 'lifecycleFn',
    },
  },
  thresholds: {
    'http_req_failed': ['rate<0.05'],
    'persona_success': ['rate>0.95'],
    'transaction_success': ['rate>0.95'],
    ...reportThresholds(META.scenarios),
  },
};

export const handleSummary = makeHandleSummary(META);

// ~70% — inbox read as the Screening Officer (only role that lists all complaints).
export function readFn() {
  const env = getEnv();
  if (!ensureSearchAuth(env)) return;
  const list = listComplaints(env.baseUrl, searchToken, searchUser, env.tenant, 50);
  personaSuccess.add(list !== null, { persona: 'read' });
}

// ~20% — citizen submission (APPLY only).
export function createFn() {
  const env = getEnv();
  if (!ensureEmployeeAuth(env)) return;
  const serviceCodes = (Array.isArray(env.serviceCodes) && env.serviceCodes.length) ? env.serviceCodes : FALLBACK_SERVICE_CODES;
  const localities = (Array.isArray(env.localities) && env.localities.length) ? env.localities : FALLBACK_LOCALITIES;
  const idx = (exec.vu.idInTest % 100) + 1;
  const phone = `8${String(idx).padStart(8, '0')}`; // ^8[0-9]{8}$
  const name = `LoadTestCitizen_${idx}`;
  const service = createComplaint(
    env.baseUrl, empToken, empUser, env.tenant,
    randomPick(serviceCodes), phone, name, randomPick(localities)
  );
  personaSuccess.add(!!service, { persona: 'create' });
}

// ~10% — full lifecycle (tracked via transaction_success/transaction_duration).
export function lifecycleFn() {
  pgrLifecycle();
}
