import {
  authFetch,
  buildRequestInfo,
  getTenantId,
  hasAuth,
} from "./authService";
import { withTraceHeaders } from "./dashboardMetrics";


/**
 * Resolve officer UUIDs to employee names.
 * API: POST /egov-hrms/employees/_search?tenantId=&uuids=
 *
 * Officer identity is PII: the caller only reaches this path for a tile the
 * analytics API already cleared (OFFICER_PII_ROLES), so no gate is duplicated
 * here — but the public runtime has no officer tiles and no auth, so it never
 * calls in. Unresolved uuids are returned absent, never guessed: the caller
 * falls back to a short opaque id.
 */
export async function fetchEmployeeNamesByUuids(uuids = []) {
  if (!hasAuth() || !uuids.length) return {};

  const tenantId = getTenantId();
  const unique = [...new Set(uuids.filter(Boolean))];
  const chunkSize = 50;
  const names = {};

  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const params = new URLSearchParams({
      tenantId,
      uuids: chunk.join(","),
    });

    // Per-chunk tolerance, like boundaryService: a partial resolution still
    // labels the officers it did resolve, and a 401 on auxiliary data must
    // never declare the session dead.
    try {
      const response = await authFetch(`/egov-hrms/employees/_search?${params}`, {
        headers: withTraceHeaders({}),
        buildBody: () => ({ RequestInfo: buildRequestInfo("dashboard-employee") }),
        sessionCritical: false,
      });

      if (!response.ok) continue;


      const payload = await response.json();
      for (const employee of payload?.Employees || []) {
        const uuid = String(employee?.uuid ?? "").trim();
        const name = String(employee?.user?.name ?? "").trim();
        if (uuid && name) names[uuid] = name;
      }
    } catch (error) {
    // Non-fatal: unresolved uuids fall back to an opaque id in the caller.
    }
  }

  return names;
}
