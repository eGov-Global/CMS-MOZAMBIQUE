/* eslint-disable react/prop-types */
// Citizen complaint details, as in the #2038 design: a Home breadcrumb, one
// card of captioned values, then additional details, location, attachments and
// the timeline, and "File another complaint" / "Download receipt".
//
// Data: `useComplaintDetails` for the complaint, pgr-services' filtered
// `_chronology` endpoint for the timeline (rendered by the generic
// TimelineWrapper, with the citizen's RATE / REOPEN actions), and
// `useReopenWindow` for the reopen window.

import React, { useEffect } from "react";
import { Link, useHistory, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { Loader } from "@egovernments/digit-ui-react-components";
import { Button, Card } from "@egovernments/digit-ui-components-v2";
import { AlertCircle } from "lucide-react";

import { buildComplaintPath } from "../../utils/complaintHierarchyPath";
import { complaintLabel } from "../../utils/complaintLabel";
import TimelineWrapper from "../../components/TimeLineWrapper";
import ComplaintPhotos from "../../components/ComplaintPhotos";
import ComplaintLocationMap from "../../components/ComplaintLocationMap";
import { buildExtendedAttributeRows, useExtendedAttributeOrder } from "../../components/PgrExtendedAttributesView";
import StarRated from "../../components/timelineInstances/StarRated";
import DownloadReceiptButton from "../../components/DownloadReceiptButton";
import useReopenWindow from "../../hooks/pgr/useReopenWindow";
import { hasUsableGeoLocation } from "../../utils/geoLocation";

function renderRowValue(val, t) {
  if (Array.isArray(val)) {
    return val
      .map((item) => (typeof item === "object" && item ? t(item?.code) : t(String(item ?? ""))))
      .filter(Boolean)
      .join(", ");
  }
  if (val == null || val === "") return "N/A";
  if (typeof val === "object") return t(val?.code ?? "") || "N/A";
  return t(String(val)) || "N/A";
}

function WorkflowComponent({ complaintDetails, id }) {
  const { t } = useTranslation();
  const tenantId =
    Digit.SessionStorage.get("CITIZEN.COMMON.HOME.CITY")?.code ||
    complaintDetails.service.tenantId;

  // Workflow-driven timeline: fetch the raw process instances (same source the
  // employee side uses) and render them via the generic TimelineWrapper. This
  // renders whatever states a BusinessService defines (standard PGR *and* the
  // mz.igsae CMS workflow) with no hardcoded status list.
  const { isLoading: isWorkFlowLoading, data: workflowData, revalidate } = Digit.Hooks.useCustomAPIHook({
    // CRQ v2 AC-03: read the chronology through pgr-services' filtered
    // endpoint — same response shape, but employee comments/attachments and
    // identities are stripped SERVER-SIDE for citizens instead of only being
    // hidden by this page. (The raw workflow API returned everything to the
    // citizen's token.)
    url: "/pgr-services/v2/request/_chronology",
    params: { tenantId, history: true, businessIds: id },
    changeQueryName: id,
  });

  // Reopen window from RAINMAKER-PGR.UIConstants.REOPENSLA — the same master
  // pgr-services enforces in validateReOpen(), so the button and the server
  // cannot disagree. undefined (not configured / loading) offers REOPEN and
  // defers to the server's own backstop (see useReopenWindow).
  const reopenWindowMs = useReopenWindow(tenantId);

  useEffect(() => {
    revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Citizen actions for the CURRENT state (RATE / REOPEN / …) straight from the
  // workflow's nextActions — the legacy <TimeLine> rendered these links inside
  // its Resolved/Rejected checkpoints, so the TimelineWrapper swap dropped them.
  // COMMENT is excluded (no citizen page for it); REOPEN honors the window.
  const current = workflowData?.ProcessInstances?.[0];
  const lastModifiedTime = complaintDetails?.service?.auditDetails?.lastModifiedTime;
  const reopenWindowOpen =
    reopenWindowMs === undefined ||
    (typeof lastModifiedTime === "number" && Number.isFinite(lastModifiedTime) && Date.now() - lastModifiedTime < reopenWindowMs);
  const citizenActions = (current?.nextActions || [])
    .filter((a) => Array.isArray(a?.roles) && a.roles.includes("CITIZEN"))
    .map((a) => a?.action)
    .filter((a) => a && a !== "COMMENT")
    .filter((a) => a !== "REOPEN" || reopenWindowOpen);

  // Rendered INSIDE the current-state timeline row (legacy-checkpoint parity):
  // action buttons while actions are open; the given star rating once rated.
  const rating = complaintDetails?.service?.rating;
  const currentStateChildren =
    rating || citizenActions.length > 0 ? (
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.75rem", marginTop: "0.5rem" }}>
        {rating ? <StarRated text={t("CS_ADDCOMPLAINT_YOU_RATED")} rating={rating} /> : null}
        {citizenActions
          .filter((action) => !(rating && action === "RATE"))
          .map((action) => {
            const key = `CS_COMMON_${action}`;
            const label = t(key) === key ? action : t(key);
            return (
              <Link key={action} to={`/${window?.contextPath || "digit-ui"}/citizen/pgr/${action.toLowerCase()}/${id}`}>
                <Button data-analytics-event={`pgr.complaint.details-${action.toLowerCase()}`}>{label}</Button>
              </Link>
            );
          })}
      </div>
    ) : null;

  return (
    <TimelineWrapper
      businessId={id}
      isWorkFlowLoading={isWorkFlowLoading}
      workflowData={workflowData}
      labelPrefix="WF_PGR_"
      currentStateChildren={currentStateChildren}
      // QA #19 part 1 (sheet v4): the citizen must not see which employee
      // handled the complaint — employee name + contact lines are omitted.
      hideEmployeeContacts
      // Comments and attachments exchanged BETWEEN officers (assignment,
      // escalation, internal notes) stay internal; the citizen sees the
      // closing entry and their own submissions (CRQ v2 §3).
      hideInternalNotes
      // CRQ v2: the citizen's OWN name/number in the chronology are shown on a
      // non-confidential complaint and masked on a confidential one.
      maskConfidential={complaintDetails?.service?.extendedAttributes?.isConfidential === true}
      // Who the complainant IS — the actor/complainant split matches on this
      // uuid, not on the CITIZEN role (officers can hold it too).
      complainantUuid={complaintDetails?.service?.citizen?.uuid || complaintDetails?.service?.accountId}
      complainant={complaintDetails?.service?.citizen}
    />
  );
}

const ComplaintDetailsPage = () => {
  const { t } = useTranslation();
  const history = useHistory();
  const { id } = useParams();
  const tenantId =
    Digit.SessionStorage.get("CITIZEN.COMMON.HOME.CITY")?.code ||
    Digit.ULBService.getCurrentTenantId();
  const { isLoading, isError, complaintDetails } = Digit.Hooks.pgr.useComplaintDetails({
    tenantId,
    id,
  });
  // CCSD-2123: schema x-order for the Additional Details card (complainantName
  // is pinned first inside buildExtendedAttributeRows regardless).
  const extAttrOrder = useExtendedAttributeOrder(complaintDetails?.service?.extendedAttributes);

  // Complaint classification hierarchy (configurable N levels). Absent on
  // un-migrated tenants -> buildComplaintPath returns null and the legacy flat
  // Type/Sub-Type rows from `details` are shown unchanged.
  // Single RAINMAKER-PGR.ComplaintHierarchy adjacency list (interior nodes +
  // leaf complaint types). buildComplaintPath finds the leaf (code===serviceCode)
  // and walks parentCode up through these same rows.
  // The hierarchy (nodes + their names) is onboarded at the COMPLAINT'S tenant
  // (e.g. mz.igsae) — not the citizen's home city, which on multi-authority envs
  // is the state root with no such rows. Read it where it lives, else the
  // Type/Sub-Type rows render raw COMPLAINT_HIERARCHY.* keys with no name
  // fallback (nodes absent at the home tenant too).
  const hierarchyTenant = complaintDetails?.service?.tenantId || tenantId;
  const { data: hier } = Digit.Hooks.useCustomMDMS(
    hierarchyTenant,
    "RAINMAKER-PGR",
    [{ name: "ComplaintHierarchyDefinition" }, { name: "ComplaintHierarchy" }],
    {
      cacheTime: Infinity,
      select: (raw) => {
        const defs = (raw?.["RAINMAKER-PGR"]?.ComplaintHierarchyDefinition || []).filter((d) => d?.active !== false);
        const allRows = raw?.["RAINMAKER-PGR"]?.ComplaintHierarchy || [];
        return { defs, allRows };
      },
    },
    // NOTE: this 5th arg switches useCustomMDMS into its v2 branch, which
    // IGNORES the positional tenantId — the tenant must ride inside this
    // object (mdmsv2.tenantId) or the fetch silently uses the logged-in
    // tenant (the citizen's home/state root) no matter what we pass above.
    { schemaCode: "PGR_COMPLAINT_HIERARCHY_DETAILS", tenantId: hierarchyTenant }
  );

  // Pick the hierarchy DEFINITION that owns this complaint's leaf node — a
  // tenant can hold several hierarchies (e.g. the state root aggregates every
  // authority's), and "first def with any rows" mis-picked for complaints of
  // the other authority, collapsing the view to the legacy flat rows.
  const { hierDef, hierNodes } = React.useMemo(() => {
    const defs = hier?.defs || [];
    const allRows = hier?.allRows || [];
    const sc = complaintDetails?.service?.serviceCode;
    const leaf = sc ? allRows.find((n) => n?.code === sc) : null;
    const def =
      (leaf && defs.find((d) => d?.hierarchyType === leaf?.hierarchyType)) ||
      defs.find((d) => allRows.some((n) => n?.hierarchyType === d?.hierarchyType)) ||
      defs[0] ||
      null;
    const nodes = def ? allRows.filter((n) => n?.hierarchyType === def.hierarchyType) : [];
    return { hierDef: def, hierNodes: nodes };
  }, [hier, complaintDetails?.service?.serviceCode]);

  const classification = buildComplaintPath({
    serviceCode: complaintDetails?.service?.serviceCode,
    def: hierDef,
    nodes: hierNodes,
    t,
  });

  const tr = (key, fallback) => {
    const v = t(key);
    return v === key ? fallback : v;
  };

  // The details hook hands the flat Type / Sub-Type rows over as bare
  // COMPLAINT_HIERARCHY.<code> keys, which printed raw on any tenant that has
  // not seeded them. Label them as My Complaints and the employee page do:
  // the key's translation, else the hierarchy node's own name.
  const serviceDefs = Digit.Hooks.pgr.useServiceDefs(tenantId, "PGR");
  const serviceDef = (serviceDefs || []).find((def) => def?.serviceCode === complaintDetails?.service?.serviceCode);
  const typeRowLabels = serviceDef
    ? {
        CS_ADDCOMPLAINT_COMPLAINT_TYPE: complaintLabel(t, serviceDef.menuPath, serviceDef.menuPathName),
        CS_ADDCOMPLAINT_COMPLAINT_SUB_TYPE: complaintLabel(t, serviceDef.serviceCode, serviceDef.name),
      }
    : {};

  // When a hierarchy applies, the level rows below replace the flat category
  // and subcategory entries the details hook injects (useComplaintDetails).
  // Matched by key: the labels are whatever the tenant seeds, so matching on
  // their text stopped working as soon as they were renamed.
  const isFlatTypeRow = (key) => key === "CS_ADDCOMPLAINT_COMPLAINT_TYPE" || key === "CS_ADDCOMPLAINT_COMPLAINT_SUB_TYPE";

  const geoLocation = complaintDetails?.service?.address?.geoLocation;
  const address = complaintDetails?.service?.address;
  // QA #31/#25: show ONLY what the complainant typed — no boundary code, no
  // tenant/authority name (those rendered as raw identifiers like
  // "MZ_IGE_ADMIN_hungaro" or appended "…, IGSAE").
  const displayAddress = [
    address?.buildingName,
    address?.street,
    address?.landmark,
    address?.pincode,
  ]
    .filter(Boolean)
    .join(", ");

  // Shared by the Additional Details card and the receipt, so the printed
  // document and the screen can never list different rows.
  const extAttrRows = React.useMemo(
    () => buildExtendedAttributeRows(complaintDetails?.service?.extendedAttributes, t, extAttrOrder),
    [complaintDetails?.service?.extendedAttributes, t, extAttrOrder]
  );

  // One captioned value per detail, in the design's order: the classification
  // (when a hierarchy applies) where the flat Type / Sub-Type rows sat, the
  // status after the boundary levels, and the description last, full width.
  const detailRows = [];
  let statusRow = null;
  let descriptionRow = null;
  let classificationPlaced = false;
  const pushClassification = () => {
    if (classificationPlaced || !classification || classification.length === 0) return;
    classification.forEach((r) => detailRows.push({ key: r.levelCode, label: r.label, value: r.value || "N/A" }));
    classificationPlaced = true;
  };
  Object.keys(complaintDetails?.details || {}).forEach((flag) => {
    if (classification && isFlatTypeRow(flag)) {
      pushClassification();
      return;
    }
    const row = {
      key: flag,
      label: t(flag),
      value: typeRowLabels[flag] || renderRowValue(complaintDetails.details[flag], t),
    };
    if (flag === "CS_COMPLAINT_DETAILS_APPLICATION_STATUS") statusRow = row;
    else if (flag === "CS_COMPLAINT_ADDTIONAL_DETAILS") descriptionRow = { ...row, wide: true };
    else detailRows.push(row);
    // After the complaint number, when no flat type row marks the spot.
    if (flag === "CS_COMPLAINT_DETAILS_COMPLAINT_NO") pushClassification();
  });
  pushClassification();
  if (statusRow) detailRows.push(statusRow);
  if (descriptionRow) detailRows.push(descriptionRow);

  const home = `/${window?.contextPath}/citizen/all-services`;
  const fileAnother = `/${window?.contextPath}/citizen/pgr/create-complaint`;
  const pageTitle = tr("CS_COMPLAINT_DETAILS_COMPLAINT_DETAILS", "Complaint Details");

  return (
    <div className="v2-scope cms-details">
      <nav className="cms-breadcrumb" aria-label={tr("CS_COMMON_BREADCRUMB", "Breadcrumb")}>
        <Link to={home} data-analytics-event="pgr.complaint.details-home">
          {tr("CS_COMMON_HOME", "Home")}
        </Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{pageTitle}</span>
      </nav>
      <h1 className="cms-details-head">{pageTitle}</h1>
      {isLoading ? (
        <div style={{ padding: "32px 0" }}>
          <Loader />
        </div>
      ) : isError || !complaintDetails || Object.keys(complaintDetails).length === 0 ? (
        <Card
          style={{
            padding: "48px 24px",
            textAlign: "center",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <span
            aria-hidden
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              height: "3rem",
              width: "3rem",
              borderRadius: "9999px",
              backgroundColor: "var(--color-error-bg, #FAE5E2)",
              color: "var(--color-error, #d4351c)",
            }}
          >
            <AlertCircle style={{ height: "1.5rem", width: "1.5rem" }} />
          </span>
          <h3
            style={{
              margin: 0,
              fontSize: "1.125rem",
              fontWeight: 600,
              color: "var(--color-text-heading, #363636)",
            }}
          >
            {tr("CS_COMPLAINT_DETAILS_LOAD_ERROR", "Couldn't load this complaint")}
          </h3>
          <p
            style={{
              margin: 0,
              fontSize: "0.875rem",
              color: "var(--color-text-secondary, #6B7280)",
              maxWidth: "32rem",
            }}
          >
            {tr(
              "CS_COMPLAINT_DETAILS_LOAD_ERROR_DESC",
              "The complaint details aren't reachable right now. Please try refreshing in a moment."
            )}
          </p>
        </Card>
      ) : (
        <>
          <section className="cms-details-card">
            <dl className="cms-details-grid">
              {detailRows.map((row) => (
                <div key={row.key} className={`cms-details-item${row.wide ? " wide" : ""}`}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
          </section>

          {/* Read-only "Additional Details" — service.extendedAttributes as
              returned; the backend already masks confidential values ("****"). */}
          {extAttrRows.length > 0 ? (
            <section className="cms-details-card">
              <h2 className="cms-details-card-head">{tr("CS_COMPLAINT_DETAILS_ADDITIONAL_DETAILS", "Additional Details")}</h2>
              <dl className="cms-details-grid">
                {extAttrRows.map((r) => (
                  <div key={r.fieldKey} className="cms-details-item">
                    <dt>{r.label}</dt>
                    <dd>{r.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}

          {hasUsableGeoLocation(geoLocation) ? (
            <section className="cms-details-card">
              <h2 className="cms-details-card-head">{t("CS_COMPLAINT_LOCATION")}</h2>
              <ComplaintLocationMap
                latitude={geoLocation.latitude}
                longitude={geoLocation.longitude}
                address={displayAddress}
              />
            </section>
          ) : null}

          {complaintDetails?.workflow?.verificationDocuments?.length > 0 ? (
            <section className="cms-details-card">
              <h2 className="cms-details-card-head">{t("CS_COMMON_ATTACHMENTS")}</h2>
              <ComplaintPhotos serviceWrapper={complaintDetails} />
            </section>
          ) : null}

          <section className="cms-details-card">
            <h2 className="cms-details-card-head">{tr("CS_COMPLAINT_DETAILS_COMPLAINT_TIMELINE", "Complaint Timeline")}</h2>
            {complaintDetails?.service ? <WorkflowComponent complaintDetails={complaintDetails} id={id} /> : null}
          </section>

          <div className="cms-details-actions">
            {complaintDetails?.service ? <DownloadReceiptButton complaintDetails={complaintDetails} /> : null}
            <Button onClick={() => history.push(fileAnother)} data-analytics-event="pgr.complaint.details-file-another">
              {tr("CS_FILE_ANOTHER", "File another complaint")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
};

export default ComplaintDetailsPage;
