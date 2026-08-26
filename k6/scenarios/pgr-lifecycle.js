import { sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import exec from 'k6/execution';
import { login, makeRequestInfo } from '../helpers/auth.js';
import { createComplaint, updateComplaint, searchComplaint, isAuthError } from '../helpers/pgr.js';
import { getEnv } from '../config/environments.js';

// Custom metrics
export const transactionDuration = new Trend('transaction_duration', true);
export const transactionSuccess = new Rate('transaction_success');

// Module-scope token cache (per VU)
let employeeToken = null;
let employeeUserInfo = null;
let employeeUUID = null;

// Separate cache for the search user (Screening Officer) — only this role can
// search across all complaints, so the verify step authenticates as it.
let searchToken = null;
let searchUserInfo = null;

// All 33 PGR ServiceDefs from full-dump.sql — each VU/iteration uses a different one.
// Override via env config `serviceCodes` for deployments with fewer ServiceDefs loaded.
const ALL_SERVICE_CODES = [
  "EducationHarassmentOfStudentsByFaculty",
  "EducationIllegalCollectionOfBribes",
  "EducationTeacherMisbehavior",
  "EnergyConstantPowerCuts",
  "EnergyIncorrectEnergyBilling",
  "EnergyLowSupplyQuality",
  "EnergyMaterialDamageDueToElectricalFailure",
  "EnvironmentEnvironmentalPollutionByPublicEntity",
  "EnvironmentNoisePollutionByPublicEntities",
  "Grievance_Other",
  "HealthLackOfMedicines",
  "HealthMedicalMalpractice",
  "HealthPoorHospitalCare",
  "HousingAndUrbanizationDelayInIssuingPermit",
  "HousingAndUrbanizationViolationOfUrbanizationRegulations",
  "HumanResourcesUnlawfulTerminationOfContract",
  "HumanResourcesUnpaidManagementAllowance",
  "HumanResourcesUnpaidOvertime",
  "HumanResourcesWagesInArrears",
  "LandAndEnvironmentDelayInIssuingDuat",
  "LandAndEnvironmentIllegalLandOccupationByTheState",
  "LandAndEnvironmentLandConflict",
  "OtherOther",
  "PublicAdministrationOmissionOrConcealmentOfInformation",
  "PublicAdministrationUnwarrantedDelayInResponse",
  "PublicFinanceDebtsToStateSuppliers",
  "PublicFinanceImproperFeeCharges",
  "PublicFinanceUndueFines",
  "PublicIntegrityBriberyCorruptionRequest",
  "PublicIntegrityFavoritismNepotism",
  "PublicIntegrityMoralHarassment",
  "PublicIntegritySexualHarassment",
  "PublicProcurementUnlawfulExclusionOfCandidate",
  "PublicProcurementViolationOfTenderProcedures",
  "PublicSafetyAbuseOfAuthority",
  "PublicSafetyExtortionBySecurityAgent",
  "PublicServiceExcessiveWaitingTime",
  "PublicServiceLackOfInformationToTheCitizen",
  "PublicServicePoorServiceByEmployee",
  "PublicServicePoorServiceByService",
  "PublicServicesFailureToProvideTheService",
  "SocialProtectionDelayInPensionProcessing",
  "SocialProtectionIncorrectCalculationOfSocialBenefit",
  "TransportationDegradationOfRoadInfrastructures",
  "TransportationPublicTransportFailure",
  "WaterAndSanitationIncorrectWaterBilling",
  "WaterAndSanitationLackOfWaterSupply",
  "WaterAndSanitationWaterUnfitForConsumption",
];

const SERVICE_CODES = (() => {
  const env = getEnv();
  const svc = env.serviceCodes;
  return (Array.isArray(svc) && svc.length > 0) ? svc : ALL_SERVICE_CODES;
})();

// Localities from this deployment's boundary data (SUN01/02/03 under city "City A").
// Override via env config `localities` for deployments with a different boundary set.
const DEFAULT_LOCALITIES =[
  { code: "maputo_cidade", name: "Maputo Cidade" },
  { code: "nlhamankulu", name: "Nlhamankulu" },
  { code: "municipio_maputo_nlhamankulu", name: "Municipio Maputo Nlhamankulu" },
  { code: "katembe", name: "Katembe" },
  { code: "municipio_maputo_katembe", name: "Municipio Maputo Katembe" },
  { code: "kanyaka", name: "Kanyaka" },
  { code: "municipio_maputo_kanyaka", name: "Municipio Maputo Kanyaka" },
  { code: "kamubukwana", name: "Kamubukwana" },
  { code: "municipio_maputo_kamubukwana", name: "Municipio Maputo Kamubukwana" },
  { code: "kampfumu", name: "Kampfumu" },
  { code: "municipio_maputo_kampfumu", name: "Municipio Maputo Kampfumu" },
  { code: "kamaxakeni", name: "Kamaxakeni" },
  { code: "municipio_maputo_kamaxakeni", name: "Municipio Maputo Kamaxakeni" },
  { code: "kamavota", name: "Kamavota" },
  { code: "municipio_maputo_kamavota", name: "Municipio Maputo Kamavota" },
];

const LOCALITIES = (() => {
  const env = getEnv();
  const loc = env.localities;
  return (Array.isArray(loc) && loc.length > 0) ? loc : DEFAULT_LOCALITIES;
})();

// Pick a random element from an array.
const randomPick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Per-VU iteration counter for rotating service codes
let iterationCount = 0;

function thinkTime() {
  sleep(Math.random() * 2 + 1);
}

function ensureEmployeeAuth(env) {
  if (!employeeToken) {
    const auth = login(env.baseUrl, env.username, env.password, env.tenant, 'EMPLOYEE');
    if (!auth) return false;
    employeeToken = auth.token;
    employeeUserInfo = auth.userInfo;
    employeeUUID = auth.userInfo.uuid;
  }
  return true;
}

function ensureSearchAuth(env) {
  if (!searchToken) {
    const auth = login(env.baseUrl, env.searchUsername, env.searchPassword, env.tenant, 'EMPLOYEE');
    if (!auth) return false;
    searchToken = auth.token;
    searchUserInfo = auth.userInfo;
  }
  return true;
}

/**
 * Run one full PGR complaint lifecycle.
 * Called by scenario files (ramp-2vu, ramp-10vu, ramp-50vu).
 */
export function pgrLifecycle() {
  const env = getEnv();
  const start = Date.now();
  let success = false;

  try {
    // Step 1: Ensure employee auth
    if (!ensureEmployeeAuth(env)) return;
    thinkTime();

    // Pick service code: each VU starts at a different offset, rotates each iteration
    const vuId = exec.vu.idInTest;
    const serviceCode = SERVICE_CODES[(vuId + iterationCount++) % SERVICE_CODES.length];

    // Pick a random locality for this complaint
    const locality = randomPick(LOCALITIES);

    // Citizen identity — vary by VU so different citizens file complaints
    const citizenIndex = (vuId % 100) + 1;
    // Phone must match ^8[0-9]{8}$ (leading 8 + 8 digits)
    const citizenPhone = `8${String(citizenIndex).padStart(8, '0')}`;
    const citizenName = `LoadTestCitizen_${citizenIndex}`;

    // Step 2: Create complaint (with 401 retry)
    let service = createComplaint(
      env.baseUrl, employeeToken, employeeUserInfo,
      env.tenant, serviceCode, citizenPhone, citizenName, locality
    );
    if (!service) {
      // Could be 401 — clear auth and retry once
      clearEmployeeAuth();
      if (!ensureEmployeeAuth(env)) return;
      service = createComplaint(
        env.baseUrl, employeeToken, employeeUserInfo,
        env.tenant, serviceCode, citizenPhone, citizenName, locality
      );
      if (!service) return;
    }
    thinkTime();

    // Step 3: Assign to screening (PENDINGFORASSIGNMENT → REFERRED)
    const referred = updateComplaint(
      env.baseUrl, employeeToken, employeeUserInfo,
      service, 'ASSIGN', [], 'Load test screening assignment'
    );
    if (!referred) return;
    thinkTime();

    // Step 4: Assign to investigation (REFERRED → INVESTIGATION)
    const investigating = updateComplaint(
      env.baseUrl, employeeToken, employeeUserInfo,
      referred, 'ASSIGN', [], 'Load test investigation assignment'
    );
    if (!investigating) return;
    thinkTime();

    // Step 5: Resolve (INVESTIGATION → RESOLVED)
    const resolved = updateComplaint(
      env.baseUrl, employeeToken, employeeUserInfo,
      investigating, 'RESOLVE', [], 'Load test resolution'
    );
    if (!resolved) return;
    thinkTime();

    // Step 6: Verify via search (as the Screening Officer — only role that can
    // search across all complaints)
    if (!ensureSearchAuth(env)) return;
    const found = searchComplaint(
      env.baseUrl, searchToken, searchUserInfo,
      env.tenant, service.serviceRequestId
    );
    if (!found) return;

    // Success if complaint reached RESOLVED (RATE step skipped, so no CLOSEDAFTERRESOLUTION)
    if (found.applicationStatus === 'RESOLVED') {
      success = true;
    } else {
      console.warn(`Unexpected final status: ${found.applicationStatus}`);
    }
  } finally {
    const duration = Date.now() - start;
    transactionDuration.add(duration);
    transactionSuccess.add(success ? 1 : 0);
  }
}

/**
 * Clear cached employee token so next iteration re-authenticates.
 * Called internally when a 401 is detected.
 */
function clearEmployeeAuth() {
  employeeToken = null;
  employeeUserInfo = null;
  employeeUUID = null;
}
