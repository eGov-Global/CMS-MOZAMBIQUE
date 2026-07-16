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
  "PublicServicePoorServiceByEmployee",
  "PublicServicePoorServiceByService",
  "PublicServiceExcessiveWaitingTime",
  "PublicServiceLackOfInformationToTheCitizen",
  "PublicIntegrityBriberyCorruptionRequest",
  "PublicIntegrityFavoritismNepotism",
  "PublicIntegritySexualHarassment",
  "PublicIntegrityMoralHarassment",
  "HealthPoorHospitalCare",
  "HealthLackOfMedicines",
  "HealthMedicalMalpractice",
  "EducationHarassmentOfStudentsByFaculty",
  "EducationTeacherMisbehavior",
  "EducationIllegalCollectionOfBribes",
  "EnvironmentNoisePollutionByPublicEntities",
  "EnvironmentEnvironmentalPollutionByPublicEntity",
  "PublicSafetyAbuseOfAuthority",
  "PublicSafetyExtortionBySecurityAgent",
  "PublicAdministrationUnwarrantedDelayInResponse",
  "PublicAdministrationOmissionOrConcealmentOfInformation",
  "OtherOther",
  "EnergyConstantPowerCuts",
  "EnergyLowSupplyQuality",
  "EnergyMaterialDamageDueToElectricalFailure",
  "EnergyIncorrectEnergyBilling",
  "WaterAndSanitationLackOfWaterSupply",
  "WaterAndSanitationWaterUnfitForConsumption",
  "WaterAndSanitationIncorrectWaterBilling",
  "PublicFinanceDebtsToStateSuppliers",
  "PublicFinanceImproperFeeCharges",
  "PublicFinanceUndueFines",
  "HumanResourcesWagesInArrears",
  "HumanResourcesUnpaidOvertime",
  "HumanResourcesUnpaidManagementAllowance",
  "HumanResourcesUnlawfulTerminationOfContract",
  "LandAndEnvironmentLandConflict",
  "LandAndEnvironmentDelayInIssuingDuat",
  "LandAndEnvironmentIllegalLandOccupationByTheState",
  "HousingAndUrbanizationDelayInIssuingPermit",
  "HousingAndUrbanizationViolationOfUrbanizationRegulations",
  "PublicProcurementViolationOfTenderProcedures",
  "PublicProcurementUnlawfulExclusionOfCandidate",
  "PublicServicesFailureToProvideTheService",
  "SocialProtectionDelayInPensionProcessing",
  "SocialProtectionIncorrectCalculationOfSocialBenefit",
  "TransportationDegradationOfRoadInfrastructures",
  "TransportationPublicTransportFailure",
  "LandAndEnvironmentLandAndEnvironment",
  "HousingHousing",
  "AgricultureAgriculture",
  "EducationEducation",
  "HealthHealth",
  "JusticeJustice",
  "SocialProtectionSocialProtection",
];

const SERVICE_CODES = (() => {
  const env = getEnv();
  const svc = env.serviceCodes;
  return (Array.isArray(svc) && svc.length > 0) ? svc : ALL_SERVICE_CODES;
})();

// Localities from this deployment's boundary data (SUN01/02/03 under city "City A").
// Override via env config `localities` for deployments with a different boundary set.
const DEFAULT_LOCALITIES =[
  { code: "zambezia", name: "Zambezia" },
  { code: "quelimane", name: "Quelimane" },
  { code: "municipio_quelimane", name: "Municipio Quelimane" },
  { code: "pebane", name: "Pebane" },
  { code: "municipio_pebane", name: "Municipio Pebane" },
  { code: "nicoadala", name: "Nicoadala" },
  { code: "namarroi", name: "Namarroi" },
  { code: "namacurra", name: "Namacurra" },
  { code: "municipio_namacurra", name: "Municipio Namacurra" },
  { code: "mulevala", name: "Mulevala" },
  { code: "morrumbala", name: "Morrumbala" },
  { code: "municipio_morrumbala", name: "Municipio Morrumbala" },
  { code: "mopeia", name: "Mopeia" },
  { code: "molumbo", name: "Molumbo" },
  { code: "mocubela", name: "Mocubela" },
  { code: "mocuba", name: "Mocuba" },
  { code: "municipio_mocuba", name: "Municipio Mocuba" },
  { code: "milange", name: "Milange" },
  { code: "municipio_milange", name: "Municipio Milange" },
  { code: "maganja_da_costa", name: "Maganja Da Costa" },
  { code: "municipio_maganja_da_costa", name: "Municipio Maganja Da Costa" },
  { code: "lugela", name: "Lugela" },
  { code: "luabo", name: "Luabo" },
  { code: "inhassunge", name: "Inhassunge" },
  { code: "ile", name: "Ile" },
  { code: "gurue", name: "Gurue" },
  { code: "municipio_gurue", name: "Municipio Gurue" },
  { code: "gile", name: "Gile" },
  { code: "derre", name: "Derre" },
  { code: "chinde", name: "Chinde" },
  { code: "alto_molocue", name: "Alto Molocue" },
  { code: "municipio_alto_molocue", name: "Municipio Alto Molocue" },
  { code: "tete", name: "Tete" },
  { code: "zumbo", name: "Zumbo" },
  { code: "tsangano", name: "Tsangano" },
  { code: "dist_tete", name: "Dist Tete" },
  { code: "municipio_tete", name: "Municipio Tete" },
  { code: "mutarara", name: "Mutarara" },
  { code: "moatize", name: "Moatize" },
  { code: "municipio_moatize", name: "Municipio Moatize" },
  { code: "maravia", name: "Maravia" },
  { code: "marara", name: "Marara" },
  { code: "magoe", name: "Magoe" },
  { code: "macanga", name: "Macanga" },
  { code: "doa", name: "Doa" },
  { code: "chiuta", name: "Chiuta" },
  { code: "chifunde", name: "Chifunde" },
  { code: "changara", name: "Changara" },
  { code: "cahora_bassa", name: "Cahora Bassa" },
  { code: "municipio_chitima", name: "Municipio Chitima" },
  { code: "angonia", name: "Angonia" },
  { code: "municipio_ulongwe", name: "Municipio Ulongwe" },
  { code: "sofala", name: "Sofala" },
  { code: "nhamatanda", name: "Nhamatanda" },
  { code: "municipio_nhamatanda", name: "Municipio Nhamatanda" },
  { code: "muanza", name: "Muanza" },
  { code: "marromeu", name: "Marromeu" },
  { code: "municipio_marromeu", name: "Municipio Marromeu" },
  { code: "maringue", name: "Maringue" },
  { code: "machanga", name: "Machanga" },
  { code: "gorongosa", name: "Gorongosa" },
  { code: "municipio_gorongosa", name: "Municipio Gorongosa" },
  { code: "dondo", name: "Dondo" },
  { code: "municipio_dondo", name: "Municipio Dondo" },
  { code: "chibabava", name: "Chibabava" },
  { code: "cheringoma", name: "Cheringoma" },
  { code: "chemba", name: "Chemba" },
  { code: "caia", name: "Caia" },
  { code: "municipio_caia", name: "Municipio Caia" },
  { code: "buzi", name: "Buzi" },
  { code: "beira", name: "Beira" },
  { code: "municipio_beira", name: "Municipio Beira" },
  { code: "niassa", name: "Niassa" },
  { code: "sanga", name: "Sanga" },
  { code: "nipepe", name: "Nipepe" },
  { code: "ngauma", name: "Ngauma" },
  { code: "muembe", name: "Muembe" },
  { code: "metarica", name: "Metarica" },
  { code: "mecula", name: "Mecula" },
  { code: "mecanhelas", name: "Mecanhelas" },
  { code: "municipio_insaca", name: "Municipio Insaca" },
  { code: "mavago", name: "Mavago" },
  { code: "maua", name: "Maua" },
  { code: "marrupa", name: "Marrupa" },
  { code: "municipio_marrupa", name: "Municipio Marrupa" },
  { code: "mandimba", name: "Mandimba" },
  { code: "municipio_mandimba", name: "Municipio Mandimba" },
  { code: "majune", name: "Majune" },
  { code: "lichinga", name: "Lichinga" },
  { code: "municipio_lichinga", name: "Municipio Lichinga" },
  { code: "cuamba", name: "Cuamba" },
  { code: "municipio_cuamba", name: "Municipio Cuamba" },
  { code: "chimbonila", name: "Chimbonila" },
  { code: "nampula", name: "Nampula" },
  { code: "ribaue", name: "Ribaue" },
  { code: "municipio_ribaue", name: "Municipio Ribaue" },
  { code: "rapale", name: "Rapale" },
  { code: "dist_nampula", name: "Dist Nampula" },
  { code: "municipio_dist_nampula", name: "Municipio Dist Nampula" },
  { code: "nacaroa", name: "Nacaroa" },
  { code: "nacala_velha", name: "Nacala Velha" },
  { code: "municipio_nacala_velha", name: "Municipio Nacala Velha" },
  { code: "nacala", name: "Nacala" },
  { code: "municipio_nacala", name: "Municipio Nacala" },
  { code: "murrupula", name: "Murrupula" },
  { code: "muecate", name: "Muecate" },
  { code: "monapo", name: "Monapo" },
  { code: "municipio_monapo", name: "Municipio Monapo" },
  { code: "moma", name: "Moma" },
  { code: "mogovolas", name: "Mogovolas" },
  { code: "mogincual", name: "Mogincual" },
  { code: "memba", name: "Memba" },
  { code: "mecuburi", name: "Mecuburi" },
  { code: "meconta", name: "Meconta" },
  { code: "malema", name: "Malema" },
  { code: "municipio_malema", name: "Municipio Malema" },
  { code: "liupo", name: "Liupo" },
  { code: "larde", name: "Larde" },
  { code: "lalaua", name: "Lalaua" },
  { code: "erati", name: "Erati" },
  { code: "angoche", name: "Angoche" },
  { code: "municipio_angoche", name: "Municipio Angoche" },
  { code: "maputo_provincia", name: "Maputo Provincia" },
  { code: "namaacha", name: "Namaacha" },
  { code: "municipio_namaacha", name: "Municipio Namaacha" },
  { code: "moamba", name: "Moamba" },
  { code: "matutuine", name: "Matutuine" },
  { code: "matola", name: "Matola" },
  { code: "municipio_matola", name: "Municipio Matola" },
  { code: "marracuene", name: "Marracuene" },
  { code: "municipio_marracuene", name: "Municipio Marracuene" },
  { code: "manhica", name: "Manhica" },
  { code: "municipio_manhica", name: "Municipio Manhica" },
  { code: "magude", name: "Magude" },
  { code: "boane", name: "Boane" },
  { code: "municipio_matola_rio", name: "Municipio Matola Rio" },
  { code: "municipio_boane", name: "Municipio Boane" },
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
  { code: "manica", name: "Manica" },
  { code: "vanduzi", name: "Vanduzi" },
  { code: "tambara", name: "Tambara" },
  { code: "sussundenga", name: "Sussundenga" },
  { code: "mossurize", name: "Mossurize" },
  { code: "dist_manica", name: "Dist Manica" },
  { code: "municipio_dist_manica", name: "Municipio Dist Manica" },
  { code: "macossa", name: "Macossa" },
  { code: "machaze", name: "Machaze" },
  { code: "macate", name: "Macate" },
  { code: "guro", name: "Guro" },
  { code: "municipio_guro", name: "Municipio Guro" },
  { code: "gondola", name: "Gondola" },
  { code: "municipio_gondola", name: "Municipio Gondola" },
  { code: "chimoio", name: "Chimoio" },
  { code: "municipio_chimoio", name: "Municipio Chimoio" },
  { code: "barue", name: "Barue" },
  { code: "municipio_catandica", name: "Municipio Catandica" },
  { code: "inhambane", name: "Inhambane" },
  { code: "zavala", name: "Zavala" },
  { code: "municipio_quissico", name: "Municipio Quissico" },
  { code: "vilankulo", name: "Vilankulo" },
  { code: "municipio_vilankulo", name: "Municipio Vilankulo" },
  { code: "panda", name: "Panda" },
  { code: "morrumbene", name: "Morrumbene" },
  { code: "maxixe", name: "Maxixe" },
  { code: "municipio_maxixe", name: "Municipio Maxixe" },
  { code: "massinga", name: "Massinga" },
  { code: "municipio_massinga", name: "Municipio Massinga" },
  { code: "mabote", name: "Mabote" },
  { code: "jangamo", name: "Jangamo" },
  { code: "inhassoro", name: "Inhassoro" },
  { code: "inharrime", name: "Inharrime" },
  { code: "dist_inhambane", name: "Dist Inhambane" },
  { code: "homoine", name: "Homoine" },
  { code: "govuro", name: "Govuro" },
  { code: "funhalouro", name: "Funhalouro" },
  { code: "gaza", name: "Gaza" },
  { code: "xai_xai", name: "Xai Xai" },
  { code: "municipio_xai_xai", name: "Municipio Xai Xai" },
  { code: "massingir", name: "Massingir" },
  { code: "municipio_massingir", name: "Municipio Massingir" },
  { code: "massangena", name: "Massangena" },
  { code: "mapai", name: "Mapai" },
  { code: "manjacaze", name: "Manjacaze" },
  { code: "municipio_manjacaze", name: "Municipio Manjacaze" },
  { code: "mabalane", name: "Mabalane" },
  { code: "limpopo", name: "Limpopo" },
  { code: "guija", name: "Guija" },
  { code: "chongoene", name: "Chongoene" },
  { code: "chokwe", name: "Chokwe" },
  { code: "municipio_chokwe", name: "Municipio Chokwe" },
  { code: "chigubo", name: "Chigubo" },
  { code: "chicualacuala", name: "Chicualacuala" },
  { code: "chibuto", name: "Chibuto" },
  { code: "municipio_chibuto", name: "Municipio Chibuto" },
  { code: "bilene", name: "Bilene" },
  { code: "municipio_praia_bilene", name: "Municipio Praia Bilene" },
  { code: "cabo_delgado", name: "Cabo Delgado" },
  { code: "quissanga", name: "Quissanga" },
  { code: "pemba", name: "Pemba" },
  { code: "municipio_pemba", name: "Municipio Pemba" },
  { code: "palma", name: "Palma" },
  { code: "nangade", name: "Nangade" },
  { code: "namuno", name: "Namuno" },
  { code: "muidumbe", name: "Muidumbe" },
  { code: "mueda", name: "Mueda" },
  { code: "municipio_mueda", name: "Municipio Mueda" },
  { code: "montepuez", name: "Montepuez" },
  { code: "municipio_montepuez", name: "Municipio Montepuez" },
  { code: "mocimboa_da_praia", name: "Mocimboa Da Praia" },
  { code: "municipio_mocimboa_da_praia", name: "Municipio Mocimboa Da Praia" },
  { code: "metuge", name: "Metuge" },
  { code: "meluco", name: "Meluco" },
  { code: "mecufi", name: "Mecufi" },
  { code: "macomia", name: "Macomia" },
  { code: "ibo", name: "Ibo" },
  { code: "municipio_ibo", name: "Municipio Ibo" },
  { code: "chiure", name: "Chiure" },
  { code: "municipio_chiure", name: "Municipio Chiure" },
  { code: "balama", name: "Balama" },
  { code: "municipio_balama", name: "Municipio Balama" },
  { code: "ancuabe", name: "Ancuabe" }
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
