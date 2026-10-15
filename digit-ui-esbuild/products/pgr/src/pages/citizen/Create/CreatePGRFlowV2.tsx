/* eslint-disable @typescript-eslint/no-explicit-any */
// Citizen "File a Complaint": three steps, as in the #2038 design.
//
//   1. Complaint details: the authority the complaint is about (when
//      RAINMAKER-PGR.ComplaintRelatedToMap is seeded), the description (typed,
//      or spoken through the browser's speech recognition), attachments, the
//      category, the category's additional fields, and the complainant's own
//      details.
//   2. Location: the map pin (optional), the boundary down to its last level,
//      and a landmark. No postal code: it was retired (CCSD-2207) — the
//      boundary already pins every complaint to a ward.
//   3. Review and the declarations, then submit.
//
// Each step is its own route (STEP_SLUGS) and the answers are mirrored into a
// session draft that only a reload restores. All three steps stay mounted and
// only the current one shows, so going Back finds the pickers as the citizen
// left them. The response page's redux contract is unchanged.

import * as React from "react";
import { useTranslation } from "react-i18next";
import { complaintLabel } from "../../../utils/complaintLabel";
import { isVisibleOnEntrance } from "../../../utils/testingTenant";
import { serializeGeoLocation } from "../../../utils/geoLocation";
import { EV, trackE, failureName, trackEvent } from "../../../utils/analytics";
import useVoiceInputEnabled from "../../../hooks/pgr/useVoiceInputEnabled";
import PGRDatePicker from "../../../components/PGRDatePicker";
import PgrFileUpload from "../../../components/PgrFileUpload";
import { useDispatch } from "react-redux";
import { useHistory, useLocation } from "react-router-dom";
import { useQueryClient } from "react-query";

import { Button, ScreenContainer, ScreenHeader, Field, Input, Select, Textarea } from "@egovernments/digit-ui-components-v2";
import { MicButton, VoiceSheet, speechToTextSupported } from "./VoiceInput";

/**
 * Resolve a translation key with an English fallback.
 *
 * react-i18next's `t()` echoes the key back when no translation is registered.
 * The CCRS localization bundle has the legacy keys (NEXT, SUBMIT, BACK,
 * CS_COMMON_FILE_A_COMPLAINT, CS_COMPLAINT_DETAILS_COMPLAINT_TYPE …) but not
 * the v2-specific descriptive ones (hints, intro copy). Until those land in
 * MDMS, fall back to a sensible English string when t() returns the key
 * unchanged — never show a raw `CS_…` token to the user.
 */
function tr(t: (k: string) => string, key: string, fallback: string): string {
  const out = t(key);
  return out === key ? fallback : out;
}

declare const Digit: any;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ServiceDef {
  serviceCode: string;
  menuPath: string;
  menuPathName?: string;
  name?: string;
  department?: string;
  order?: number;
  // Optional denormalised hierarchy links (present once a tenant runs the
  // ServiceDefs backfill). The picker falls back to menuPath when absent.
  parentCode?: string;
  sector?: string;
}

// Configurable complaint hierarchy (RAINMAKER-PGR.ComplaintHierarchyDefinition):
// the number/identity of levels is pure data, mirroring boundary-service's
// HierarchyDefinition. Absent => legacy flat menuPath grouping.
interface HierarchyLevel {
  levelCode: string;
  order?: number;
  parentLevel?: string | null;
  isFreeText?: boolean;
  isLeafServiceCode?: boolean;
  label?: string;
}
interface ComplaintHierarchyDef {
  hierarchyType: string;
  active?: boolean;
  levels: HierarchyLevel[];
}
interface ClassificationNode {
  hierarchyType: string;
  levelCode: string;
  code: string;
  parentCode?: string | null;
  name?: string;
  order?: number;
  active?: boolean;
  path?: string;
}

interface BoundaryNode {
  code?: string;
  children?: unknown[];
  [key: string]: unknown;
}

interface GeoPoint {
  lat?: number | null;
  lng?: number | null;
  /** Reverse-geocoded address, when the map found one. */
  address?: string | null;
  ward?: { code?: string; name?: string } | null;
  pincode?: string | number | null;
}

interface FormData {
  SelectComplaintType?: ServiceDef | null;
  SelectSubComplaintType?: ServiceDef | null;
  GeoLocationsPoint?: GeoPoint | null;
  landmark?: string;
  SelectedBoundary?: BoundaryNode | null;
  description?: string;
  ComplaintImagesPoint?: string[]; // fileStoreIds
  // Authority dispatcher + dynamic "additional details" (Mozambique IGE/IGSAE).
  // Populated only when RAINMAKER-PGR.ComplaintRelatedToMap is seeded; absent
  // otherwise so the legacy flow is byte-identical.
  caseRelatedTo?: string; // category code (doc discriminator; FK → ComplaintRelatedToMap.code)
  caseRelatedToName?: string; // display name of the picked category
  resolvedTenantId?: string; // sub-tenant the complaint files under (ComplaintRelatedToMap.tenantCode)
  dynamicFields?: Record<string, unknown>;
  consents?: string[];
  isConfidential?: boolean; // doc "Keep details confidential" (backend-enforced later)
  // Reporter identity (optional, prefilled from the citizen profile).
  // Travels in extendedAttributes — deliberately NOT citizen.name: posting an
  // edited name back to the user service triggers its masked-update rejection.
  complainantName?: string;
  complainantAddress?: string;
  email?: string;
}

/** The boundary picker's selection: the leaf, plus the node at each level. */
interface BoundaryLevel {
  code?: string;
  name?: string;
  boundaryType?: string;
}

// RAINMAKER-PGR.ComplaintRelatedToMap — the citizen-facing category lookup. Maps
// a category `code` → display name + the sub-tenant the complaint is filed under.
// State-level master.
interface RelatedToOption {
  code: string; // category code (e.g. IGE | IGSAE)
  name: string; // citizen-facing display name
  shortName?: string;
  tenantCode: string; // sub-tenant the complaint is filed under
  tenantId?: string; // parent state tenant
  displayOrder?: number;
  active?: boolean;
}

// A renderable dynamic field, derived from the per-category JSON Schema
// (RAINMAKER-PGR.ComplaintExtendedAttributeSchema.schema.properties).
interface TemplateField {
  fieldKey: string;
  labelKey?: string; // x-label-key → localization key for the label
  label: string; // human fallback (prettified fieldKey)
  dataType?: string; // string | textarea | date | number | boolean
  mandatory?: boolean; // from schema.required
  maxLength?: number;
  order?: number; // from x-order
  encrypted?: boolean; // from top-level x-security (informational; backend encrypts)
}

// camelCase fieldKey → "Title Case" fallback label.
function prettifyKey(k: string): string {
  const s = k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Build renderable fields from a draft-07 JSON Schema object (properties +
// required + x-security + the x-order / x-widget / x-label-key UI hints).
// Control/standard keys are skipped (rendered elsewhere or sent automatically).
function fieldsFromSchema(schema: any): TemplateField[] {
  if (!schema || typeof schema !== "object" || !schema.properties) return [];
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  const security: string[] = Array.isArray(schema["x-security"]) ? schema["x-security"] : [];
  const CONTROL = new Set([
    "caseRelatedTo",
    "isConfidential",
    "schemaVersion",
    "hierarchyLevel1",
    "hierarchyLevel2",
    "complainantName",
    "complainantAddress",
    "email",
  ]);
  return Object.keys(schema.properties)
    .filter((k) => !CONTROL.has(k))
    .map((k) => {
      const p = schema.properties[k] || {};
      const widget = p["x-widget"];
      const dataType =
        widget === "textarea"
          ? "textarea"
          : p.format === "date"
          ? "date"
          : p.type === "number" || p.type === "integer"
          ? "number"
          : p.type === "boolean"
          ? "boolean"
          : "string";
      return {
        fieldKey: k,
        labelKey: p["x-label-key"],
        label: prettifyKey(k),
        dataType,
        mandatory: required.includes(k),
        maxLength: typeof p.maxLength === "number" ? p.maxLength : undefined,
        order: typeof p["x-order"] === "number" ? p["x-order"] : 999,
        encrypted: security.includes(k),
      } as TemplateField;
    })
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

// Complaint-level declarations confirmed before submit (BRD).
const REQUIRED_CONSENTS: ReadonlyArray<{ code: string; labelKey: string; label: string }> = [
  { code: "TRUTHFULNESS", labelKey: "PGR_CONSENT_TRUTHFULNESS_LABEL", label: "I declare that the information provided is true and accurate." },
  { code: "DATA_PROCESSING", labelKey: "PGR_CONSENT_DATA_PROCESSING_LABEL", label: "I consent to my data being processed to handle this complaint." },
];

const PRIMARY = "var(--color-primary-1, var(--color-primary-main, #c84c0e))";

// Consistent checkbox styling: fixed-size box with a theme-accent (centered native
// tick), nudged to align with the first line of the label text.
const CHECKBOX_STYLE: React.CSSProperties = {
  width: "1rem",
  height: "1rem",
  marginTop: "0.15rem",
  flexShrink: 0,
  accentColor: PRIMARY,
  cursor: "pointer",
};

const STEPS = [
  { id: "details", key: "CS_FILE_STEP_DETAILS", fallback: "Complaint Details" },
  { id: "location", key: "CS_FILE_STEP_LOCATION", fallback: "Location" },
  { id: "review", key: "CS_FILE_STEP_REVIEW", fallback: "Review" },
] as const;

// URL segment per step — every tab is a real, unique, deep-linkable route:
//   /citizen/pgr/create-complaint/complaint-type | /location | /details
// The URL is the single source of truth for the current step: browser
// back/forward move between steps, a mid-flow F5 reopens the same step, and
// analytics sees ordinary route pageviews (no virtual-pageview special case).
// The segments are kept from before the #2038 step regrouping so the step
// pageviews (and the sidebar's complaint-type entry link) keep their URLs.
const STEP_SLUGS = ["complaint-type", "location", "details"] as const;

// Session-draft key for the whole wizard. All 3 steps live on ONE route with
// plain component state, so a refresh (or leaving and re-entering the route)
// used to wipe every answer. {formData, stepIndex} is mirrored into
// Digit.SessionStorage under this key (same-tab, 24h TTL, quota-guarded) and
// deleted after a successful create. Attachments are already fileStoreIds
// (strings) so the draft stays tiny. Distinct from the legacy
// PGR_CITIZEN_CREATE_COMPLAINT key, which Module.js clears on every
// citizen-home mount.
const CREATE_DRAFT_KEY = "PGR_CREATE_CITIZEN_DRAFT";

// The saved draft (answers AND step position) may only be restored when the
// document itself was RELOADED (mid-flow F5) — and only by the first wizard
// mount after it. Any other entry (SPA links, and sidebar items that
// hard-navigate like "Citizen Complaint Resolution System") is a FRESH start:
// the stored draft is discarded entirely — answers included (user feedback:
// re-entering via "File a Complaint" with pre-filled fields reads as stale
// state, matching the pre-draft behaviour). The flag is consumed on first use
// so later SPA re-entries within the same document also start clean.
let RESTORE_STEP_ARMED = (() => {
  try {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return nav?.type === "reload";
  } catch (e) {
    return false;
  }
})();

// CCSD-1956: the description is 20–1000 characters and must contain real
// words. 1000 is also the employee form's cap.
const DESCRIPTION_MAX = 1000;
const DESCRIPTION_MIN = 20;

// ---------------------------------------------------------------------------
// Helpers (kept identical to the legacy FormExplorer so the API payload
// shape is preserved byte-for-byte)
// ---------------------------------------------------------------------------

function validateString(v: unknown): string {
  return typeof v === "string" && v.trim().length > 0 ? v : "";
}

// Email is OPTIONAL: blank is fine, but a value the citizen typed must be a
// well-formed address (single @, a dot in the domain, no whitespace). Kept
// deliberately permissive — matches the HTML5 email spirit without rejecting
// valid-but-unusual real addresses.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isEmailAcceptable(v: unknown): boolean {
  const s = String(v ?? "").trim();
  return s.length === 0 || EMAIL_RE.test(s);
}

// A real description, not padding: at least 3 letters, so "000000…" is
// rejected. \p{L} counts any-language letters (Portuguese accents included).
function descriptionLetters(v: unknown): number {
  return (String(v ?? "").match(/\p{L}/gu) || []).length;
}
function isDescriptionValid(v: unknown): boolean {
  const s = String(v ?? "").trim();
  return s.length >= DESCRIPTION_MIN && descriptionLetters(s) >= 3;
}

function getEffectiveServiceCode(
  mainType: ServiceDef | null | undefined,
  subType: ServiceDef | null | undefined
): string | undefined {
  if (
    subType &&
    mainType &&
    subType.department === mainType.department &&
    subType.menuPath === mainType.menuPath &&
    subType.serviceCode !== mainType.serviceCode
  ) {
    return subType.serviceCode;
  }
  return mainType?.serviceCode;
}

function mapFormDataToRequest(formData: FormData, tenantId: string, user: any, documentType = "EVIDENCE") {
  const timestamp = Date.now();
  const userInfo = user;
  // FLAT extendedAttributes (doc §2/§5) ride at the TOP LEVEL of service —
  // jsonPath $.service.extendedAttributes (a dedicated JSONB column), NOT nested
  // under additionalDetail. Built only when a category was resolved (legacy flow
  // unchanged). complainantAddress/email travel here too but the backend strips
  // them to the User Service (eg_user_address / eg_user.emailaddress) — they are
  // not stored as category data. NOTE: x-security fields are submitted in clear
  // text until the backend encryption phase lands.
  const additionalDetail: Record<string, unknown> = {};
  let extendedAttributes: Record<string, unknown> | undefined;
  if (formData?.caseRelatedTo) {
    const sct: any = formData.SelectComplaintType;
    const sst: any = formData.SelectSubComplaintType;
    const lvl1 = sct?.code ?? sct?.name;
    const lvl2 = sst?.code ?? sst?.name;
    extendedAttributes = {
      caseRelatedTo: formData.caseRelatedTo,
      isConfidential: !!formData.isConfidential,
      schemaVersion: "1.0",
      ...(lvl1 ? { hierarchyLevel1: lvl1 } : {}),
      ...(lvl2 ? { hierarchyLevel2: lvl2 } : {}),
      ...(formData.complainantName ? { complainantName: formData.complainantName } : {}),
      ...(formData.complainantAddress ? { complainantAddress: formData.complainantAddress } : {}),
      ...(formData.email ? { email: formData.email } : {}),
      // Consent checkboxes are shown at create (explicit opt-in, gated on
      // submit); the codes recorded here are the ones the citizen ticked.
      consents: formData.consents || [],
      ...(formData.dynamicFields || {}),
    };
  }
  const geoLocation = formData?.GeoLocationsPoint || { lat: null, lng: null };
  return {
    service: {
      active: true,
      tenantId,
      serviceCode: getEffectiveServiceCode(
        formData?.SelectComplaintType,
        formData?.SelectSubComplaintType
      ),
      description: formData?.description || "",
      applicationStatus: "CREATED",
      source: "web",
      citizen: userInfo,
      isDeleted: false,
      rowVersion: 1,
      address: {
        landmark: validateString(formData?.landmark),
        buildingName: "",
        street: "",
        // The ward the citizen confirmed in the cascade, which Review shows.
        // It is the map's ward whenever the map's ward is in the boundary
        // tree (the cascade fills from it); when the tree has no such ward,
        // or the citizen changed the cascade, the map's code was filed while
        // Review showed another ward.
        locality: {
          code:
            formData?.SelectedBoundary?.code ||
            formData?.GeoLocationsPoint?.ward?.code ||
            "",
        },
        geoLocation: serializeGeoLocation(geoLocation),
      },
      // Top-level service.extendedAttributes (doc jsonPath $.service.extendedAttributes).
      // Attached only when a category resolved; legacy/no-category flow is unchanged.
      ...(extendedAttributes ? { extendedAttributes } : {}),
      additionalDetail: JSON.stringify(additionalDetail),
      auditDetails: {
        createdBy: user?.uuid,
        createdTime: timestamp,
        lastModifiedBy: user?.uuid,
        lastModifiedTime: timestamp,
      },
    },
    workflow: {
      action: "APPLY",
      verificationDocuments: Array.isArray(formData?.ComplaintImagesPoint)
        ? formData.ComplaintImagesPoint.map((image) => ({
            documentType,
            fileStoreId: image,
            documentUid: "",
            additionalDetails: {},
          }))
        : [],
    },
  };
}

function isFieldValid(data: FormData, fieldKey: keyof FormData | string): boolean {
  switch (fieldKey) {
    case "ComplaintImagesPoint":
      return Array.isArray(data.ComplaintImagesPoint) && data.ComplaintImagesPoint.length > 0;
    case "SelectedBoundary": {
      const sb = data.SelectedBoundary;
      if (sb?.code) {
        // Trust the emitter's isLeaf tag first (BoundaryComponent computes it
        // from hierarchy depth precisely because `.children` isn't reliable —
        // a tree deeper than the rendered levels leaves children on the
        // deepest PICKABLE node, which dead-locked NEXT with every dropdown
        // filled). The children check stays as fallback for untagged values
        // (mirrors the FormExplorer fix, egovernments/CCRS#478).
        if (typeof sb.isLeaf === "boolean") return sb.isLeaf;
        return !Array.isArray(sb.children) || sb.children.length === 0;
      }
      return false;
    }
    case "description":
      // CCSD-1956 / CCSD-1980: 20–1000 characters, and real words — a
      // numbers-only or whitespace-only description (e.g. "000000…") is
      // rejected. The employee form applies the same rule.
      return isDescriptionValid(data.description);
    case "SelectComplaintType":
      return data.SelectComplaintType != null;
    case "GeoLocationsPoint":
      return data.GeoLocationsPoint?.lat != null && data.GeoLocationsPoint?.lng != null;
    default:
      return (data as Record<string, unknown>)[fieldKey as string] != null;
  }
}

// ---------------------------------------------------------------------------
// Sub-step bodies
// ---------------------------------------------------------------------------

/** One of the step's grouped panels: a small heading over its fields. */
function Section({ title, className, children }: { title?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <section className={`cms-section${className ? ` ${className}` : ""}`}>
      {title ? <h2 className="cms-section-head">{title}</h2> : null}
      {children}
    </section>
  );
}

interface StepBodyProps {
  data: FormData;
  patch: (partial: Partial<FormData>) => void;
  serviceDefs: ServiceDef[];
  hierarchyDef?: ComplaintHierarchyDef | null;
  nodes?: ClassificationNode[];
  t: (key: string) => string;
  /** Tenant the complaint will be created under — the authority-resolved
   *  sub-tenant once one is picked. Steps that read tenant-scoped masters
   *  (catalogue, map, boundary tree, filestore) must use THIS, not a tenant
   *  re-derived from the session. */
  tenantId?: string;
  // Authority dispatcher + dynamic-detail props (present only in the
  // ComplaintRelatedToMap-seeded flow).
  relatedToOptions?: RelatedToOption[];
  templateFields?: TemplateField[];
  // Inline loading flags, so a spinner shows in place instead of blanking the
  // whole screen when the authority (and with it the catalogue) changes.
  catalogueLoading?: boolean;
  dispatcherLoading?: boolean;
}

function InlineSpinner() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "1.5rem 0" }}>
      <span
        aria-label="Loading"
        style={{
          display: "inline-block",
          height: "1.75rem",
          width: "1.75rem",
          border: "3px solid currentColor",
          borderTopColor: "transparent",
          borderRadius: "9999px",
          color: PRIMARY,
          animation: "spin 0.8s linear infinite",
        }}
      />
    </div>
  );
}

/**
 * Generic, configurable N-level cascading picker driven entirely by a
 * ComplaintHierarchyDefinition + the single ComplaintHierarchy adjacency list.
 * Renders one dependent dropdown per level (the count is data, not code —
 * boundary-service style). Non-leaf options come from the interior nodes
 * (filtered by levelCode + parentCode); the single leaf level's options come
 * from the leaf rows linked to the parent strictly by parentCode. Selecting the
 * leaf hands the chosen ServiceDef-shaped row up so the existing payload/
 * validation logic is reused unchanged.
 */
function ComplaintHierarchyPicker({
  def,
  nodes,
  serviceDefs,
  onLeafChange,
  restoreCode,
  t,
}: {
  def: ComplaintHierarchyDef;
  nodes: ClassificationNode[];
  serviceDefs: ServiceDef[];
  onLeafChange: (leaf: ServiceDef | null) => void;
  restoreCode?: string;
  t: (k: string) => string;
}) {
  const levels = React.useMemo(
    () => [...(def.levels || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [def]
  );
  const [sel, setSel] = React.useState<(string | null)[]>(() => levels.map(() => null));
  React.useEffect(() => {
    setSel((prev) => levels.map((_, i) => prev[i] ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levels.length]);

  // Draft-restore repaint: the per-level selection is private state, so a
  // restored session draft has a valid SelectComplaintType while the dropdowns
  // render blank. While the picker is untouched, rebuild the visible chain by
  // walking parentCode up from the restored code (leaf or terminal interior
  // node). No onLeafChange emit — the value is already in formData.
  React.useEffect(() => {
    if (!restoreCode || sel.some((s) => s != null)) return;
    if (!levels.length) return;
    const byCode = new Map((nodes || []).map((n) => [n.code, n]));
    const leaf = (serviceDefs || []).find((s) => s.serviceCode === restoreCode);
    if (!leaf && !byCode.has(restoreCode)) return; // catalogue not loaded / other tenant
    const chain: string[] = [restoreCode];
    let parent: string | null | undefined = leaf
      ? leaf.parentCode ?? leaf.menuPath
      : byCode.get(restoreCode)?.parentCode;
    while (parent) {
      chain.unshift(parent);
      parent = byCode.get(parent)?.parentCode ?? null;
    }
    setSel(levels.map((_, i) => chain[i] ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreCode, nodes, serviceDefs, levels.length]);

  const labelFor = (lvl: HierarchyLevel) =>
    tr(t, (def.hierarchyType + "_" + lvl.levelCode).toUpperCase(), lvl.label || lvl.levelCode);

  // Options for level `i` computed against an explicit selection array. Needed
  // because handleChange must know the children of a just-picked node BEFORE
  // React commits the new `sel` state (setSel is async).
  const optionsForLevelWith = (
    selArr: (string | null)[],
    i: number
  ): { value: string; label: string }[] => {
    const lvl = levels[i];
    const parentCode = i === 0 ? null : selArr[i - 1];
    if (i > 0 && !parentCode) return [];
    if (lvl.isLeafServiceCode) {
      // Leaf rows link to their parent node strictly via parentCode (single
      // adjacency list); no separate sector/menuPath master anymore.
      return (serviceDefs || [])
        .filter((s) => (parentCode ? s.parentCode === parentCode : true))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((s) => ({ value: s.serviceCode, label: complaintLabel(t, s.serviceCode, s.name) }));
    }
    return (nodes || [])
      .filter((n) => n.levelCode === lvl.levelCode && n.active !== false)
      .filter((n) => (i === 0 ? !n.parentCode : n.parentCode === parentCode))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((n) => ({ value: n.code, label: complaintLabel(t, n.code, n.name) }));
  };

  const optionsForLevel = (i: number) => optionsForLevelWith(sel, i);

  // Build a ServiceDef-shaped value from an interior node so a branch that
  // bottoms out before the declared leaf level (e.g. 3 levels declared, but
  // this SECTOR has no SUB_TYPE) can still be submitted: the deepest node the
  // user actually picked becomes the complaint's serviceCode. It is a real
  // ComplaintHierarchy row, so pgr-services accepts it (no INVALID_SERVICECODE).
  const interiorAsServiceDef = (i: number, code: string): ServiceDef | null => {
    const node = (nodes || []).find(
      (n) => n.levelCode === levels[i].levelCode && n.code === code
    );
    if (!node) return null;
    return {
      serviceCode: node.code,
      menuPath: node.parentCode ?? node.code,
      name: node.name || node.code,
      parentCode: node.parentCode ?? undefined,
      order: node.order,
    };
  };

  const handleChange = (i: number, value: string) => {
    const next = sel.slice();
    next[i] = value || null;
    for (let j = i + 1; j < next.length; j++) next[j] = null;
    setSel(next);
    if (!value) {
      onLeafChange(null);
      return;
    }
    if (levels[i].isLeafServiceCode) {
      onLeafChange((serviceDefs || []).find((s) => s.serviceCode === value) || null);
      return;
    }
    // Non-leaf selection: if a deeper level still has options, keep drilling
    // (clear any pending value). Otherwise this node is terminal — submit with
    // it as the serviceCode instead of trapping the user on an empty dropdown.
    const hasDeeper =
      i + 1 < levels.length && optionsForLevelWith(next, i + 1).length > 0;
    onLeafChange(hasDeeper ? null : interiorAsServiceDef(i, value));
  };

  // The deepest level the user has actually selected, and whether that node is
  // terminal (no children at the next level). Deeper levels are then hidden so
  // the user isn't blocked by an empty, mandatory dropdown.
  const deepestSelected = sel.reduce<number>((acc, v, idx) => (v != null ? idx : acc), -1);
  const terminalAt =
    deepestSelected >= 0 &&
    (deepestSelected + 1 >= levels.length ||
      optionsForLevelWith(sel, deepestSelected + 1).length === 0)
      ? deepestSelected
      : -1;

  return (
    // Its levels sit in the step's field grid: side by side on desktop,
    // stacked on a phone.
    <div className="cms-hierarchy">
      {levels.map((lvl, i) => {
        // Once the chosen branch terminates early, drop the deeper levels that
        // have nothing to offer (e.g. SUB_TYPE under a SECTOR that has none).
        if (terminalAt >= 0 && i > terminalAt) return null;
        const disabled = i > 0 && !sel[i - 1];
        const opts = optionsForLevel(i);
        return (
          <Field
            key={lvl.levelCode}
            label={labelFor(lvl)}
            required={opts.length > 0}
            htmlFor={`lvl-${i}`}
          >
            <Select
              id={`lvl-${i}`}
              value={sel[i] ?? undefined}
              disabled={disabled}
              onValueChange={(value: string) => handleChange(i, value)}
              // Every filing list searches, whatever its length, as the
              // employee form's do (CCRS#941).
              searchable
              searchPlaceholder={tr(t, "CS_COMMON_SEARCH", "Search")}
              placeholder={
                disabled
                  ? tr(t, "CS_COMPLAINT_PICK_PARENT_FIRST", "Select the level above first")
                  : tr(t, "CS_COMPLAINT_PICK_ONE", "Select…")
              }
              options={opts}
            />
          </Field>
        );
      })}
    </div>
  );
}

// ── Authority / "Complaint related to" ────────────────────────────────────
// Renders only when RAINMAKER-PGR.ComplaintRelatedToMap is seeded with more
// than one authority (a single one is auto-selected upstream). The pick
// resolves a templateType + the sub-tenant the complaint is filed under (the
// catalogue is then fetched at that tenant; tenant code is never shown).
function AuthorityField({ data, patch, relatedToOptions, t }: StepBodyProps) {
  const options = relatedToOptions || [];
  return (
    <Field
      label={tr(t, "CS_COMPLAINT_RELATED_TO_FIELD", "Complaint related to")}
      required
      htmlFor="related-to"
      hint={tr(t, "CS_RELATED_TO_HELP", "Choose the organization or entity responsible for the issue.")}
    >
      <Select
        id="related-to"
        value={data.caseRelatedTo}
        searchable
        searchPlaceholder={tr(t, "CS_COMMON_SEARCH", "Search")}
        onValueChange={(value: string) => {
          const o = options.find((x) => x.code === value);
          if (!o) return;
          patch({
            caseRelatedTo: o.code,
            caseRelatedToName: o.name,
            resolvedTenantId: o.tenantCode,
            // Category drives the catalogue + fields — reset downstream.
            SelectComplaintType: null,
            SelectSubComplaintType: null,
            dynamicFields: {},
            // The boundary tree is fetched at the resolved tenant, so a
            // previously picked node belongs to the OLD tenant's tree.
            // The map pin (geographic) is kept — its ward hint re-cascades
            // against the new tree automatically.
            SelectedBoundary: null,
            // Filestore ids are tenant-scoped: files uploaded under the old
            // resolved tenant are unreadable under the new one. Drop them so
            // the citizen re-uploads (previews would break anyway).
            ComplaintImagesPoint: undefined,
          });
        }}
        placeholder={tr(t, "CS_COMPLAINT_PICK_ONE", "Select…")}
        // MDMS `name` carries a localization KEY on newer data
        // (PGR_RELATEDTO_NAME_<CODE>, prod convention) — t() resolves it per
        // locale. Older data ships display TEXT in `name`; t() passes any
        // non-key string through unchanged, so both conventions render.
        options={options.map((o) => ({ value: o.code, label: t(o.name) }))}
      />
    </Field>
  );
}

function CategoryFields({ data, patch, serviceDefs, hierarchyDef, nodes, t, catalogueLoading }: StepBodyProps) {
  const hierarchyActive = !!(
    hierarchyDef &&
    Array.isArray(hierarchyDef.levels) &&
    hierarchyDef.levels.length > 0
  );

  // Unique main types by menuPath
  const types = React.useMemo(() => {
    const seen = new Set<string>();
    return serviceDefs
      .filter((s) => {
        if (!s.menuPath || seen.has(s.menuPath)) return false;
        seen.add(s.menuPath);
        return true;
      })
      .map((s) => ({
        ...s,
        // Group label = key-based (COMPLAINT_HIERARCHY.<parentCode>) with the
        // parent node name as fallback.
        menuPathName: complaintLabel(t, s.menuPath, s.menuPathName),
      }));
  }, [serviceDefs, t]);

  const subTypes = React.useMemo(() => {
    const mp = data.SelectComplaintType?.menuPath;
    if (!mp) return [];
    return serviceDefs
      .filter((s) => s.menuPath === mp)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }, [data.SelectComplaintType?.menuPath, serviceDefs]);

  // The authority's catalogue is still arriving: never show the previous
  // tenant's options meanwhile.
  if (catalogueLoading) return <InlineSpinner />;

  return (
    <div className="cms-field-grid">
      {hierarchyActive ? (
        <ComplaintHierarchyPicker
          def={hierarchyDef as ComplaintHierarchyDef}
          nodes={nodes || []}
          serviceDefs={serviceDefs}
          t={t}
          restoreCode={data.SelectComplaintType?.serviceCode}
          onLeafChange={(leaf) =>
            patch({ SelectComplaintType: leaf, SelectSubComplaintType: leaf })
          }
        />
      ) : (
        <>
          <Field
            label={tr(t, "CS_COMPLAINT_DETAILS_COMPLAINT_TYPE", "Complaint Category")}
            required
            htmlFor="complaint-type"
          >
            <Select
              id="complaint-type"
              value={data.SelectComplaintType?.menuPath}
              searchable
              searchPlaceholder={tr(t, "CS_COMMON_SEARCH", "Search")}
              onValueChange={(value: string) => {
                const picked = types.find((tp) => tp.menuPath === value);
                patch({ SelectComplaintType: picked, SelectSubComplaintType: null });
              }}
              placeholder={tr(t, "CS_COMPLAINT_PICK_TYPE", "Select a complaint category")}
              options={types.map((tp) => ({
                value: tp.menuPath,
                label: tp.menuPathName ?? tp.menuPath,
              }))}
            />
          </Field>
          {subTypes.length > 1 ? (
            <Field
              label={tr(t, "CS_COMPLAINT_DETAILS_COMPLAINT_SUBTYPE", "Complaint Subcategory")}
              required
              htmlFor="complaint-subtype"
            >
              <Select
                id="complaint-subtype"
                value={data.SelectSubComplaintType?.serviceCode}
                searchable
                searchPlaceholder={tr(t, "CS_COMMON_SEARCH", "Search")}
                onValueChange={(value: string) => {
                  const picked = subTypes.find((s) => s.serviceCode === value);
                  patch({ SelectSubComplaintType: picked });
                }}
                placeholder={tr(t, "CS_COMPLAINT_PICK_SUBTYPE", "Select a subcategory")}
                options={subTypes.map((s) => ({
                  value: s.serviceCode,
                  label: complaintLabel(t, s.serviceCode, s.name),
                }))}
              />
            </Field>
          ) : null}
        </>
      )}
    </div>
  );
}

/** The selected category's additional fields (RAINMAKER-PGR.ComplaintTemplateType → its JSON Schema). */
function AdditionalFields({ data, patch, templateFields, t }: StepBodyProps) {
  const fields = templateFields || [];
  const dyn = data.dynamicFields || {};
  const setDyn = (key: string, value: unknown) => patch({ dynamicFields: { ...dyn, [key]: value } });
  return (
    <div className="cms-field-grid">
      {fields.map((f) => {
        const val = (dyn[f.fieldKey] as string) ?? "";
        return (
          <Field
            key={f.fieldKey}
            // CCSD-1955: optional fields are explicitly labeled "(Optional)".
            label={
              (f.labelKey ? tr(t, f.labelKey, f.label) : f.label) +
              (f.mandatory ? "" : " " + tr(t, "CS_OPTIONAL_SUFFIX", "(Optional)"))
            }
            required={!!f.mandatory}
            htmlFor={`xf-${f.fieldKey}`}
          >
            {f.dataType === "textarea" ? (
              <Textarea
                id={`xf-${f.fieldKey}`}
                data-matomo-mask
                maxLength={f.maxLength}
                value={val}
                onChange={(e) => setDyn(f.fieldKey, e.target.value)}
              />
            ) : f.dataType === "date" ? (
              // CCSD-1952: SAME calendar as the employee form (PGRDatePicker,
              // maxDate today) — future dates render greyed-out and unclickable
              // on both surfaces. The native <input type="date"> was dropped
              // here: its max attr enforcement varies by browser, and silently
              // ignoring a future pick reads as broken.
              <PGRDatePicker
                onSelect={(name: string, v: string) => setDyn(f.fieldKey, v)}
                config={{ key: f.fieldKey, populators: { name: f.fieldKey, maxDate: "today" } }}
                formData={dyn}
                // Match the v2 wizard's field metrics (full width, h-11,
                // rounded-md) — the picker's default caps at the employee
                // form's 37.5rem, which rendered narrower than every other
                // field on this step.
                style={{ maxWidth: "100%" }}
                fieldStyle={{ height: "2.75rem", borderRadius: "0.375rem" }}
              />
            ) : (
              <Input
                id={`xf-${f.fieldKey}`}
                data-matomo-mask
                type={f.dataType === "number" ? "number" : "text"}
                maxLength={f.dataType === "number" ? undefined : f.maxLength}
                value={val}
                onChange={(e) => setDyn(f.fieldKey, e.target.value)}
              />
            )}
          </Field>
        );
      })}
    </div>
  );
}

// Optional reporter identity, prefilled from the logged-in citizen's profile
// (name + address editable per complaint). The values travel in
// extendedAttributes (complainantName/complainantAddress), so editing them
// never round-trips through the user service.
function ReporterFields({ data, patch, t }: StepBodyProps) {
  React.useEffect(() => {
    const info = Digit.UserService.getUser()?.info;
    const prefill: Partial<FormData> = {};
    if (data.complainantName === undefined && info?.name) prefill.complainantName = info.name;
    if (data.complainantAddress === undefined && (info?.permanentAddress || info?.correspondenceAddress)) {
      prefill.complainantAddress = info.permanentAddress || info.correspondenceAddress;
    }
    if (data.email === undefined && info?.emailId) prefill.email = info.emailId;
    if (Object.keys(prefill).length) patch(prefill);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const optional = tr(t, "CS_COMMON_OPTIONAL", "Optional");
  return (
    <div className="cms-field-grid">
      <Field label={tr(t, "CS_REPORTER_FULL_NAME_LABEL", "Full Name")} htmlFor="reporter-name" hint={optional}>
        <Input
          id="reporter-name"
          data-matomo-mask
          maxLength={128}
          value={data.complainantName ?? ""}
          onChange={(e) => patch({ complainantName: e.target.value })}
        />
      </Field>
      <Field label={tr(t, "CS_REPORTER_ADDRESS_LABEL", "Address")} htmlFor="reporter-address" hint={optional}>
        <Input
          id="reporter-address"
          data-matomo-mask
          maxLength={300}
          value={data.complainantAddress ?? ""}
          onChange={(e) => patch({ complainantAddress: e.target.value })}
        />
      </Field>
      <Field
        label={tr(t, "PGR_EXT_EMAIL_LABEL", "Email Address")}
        htmlFor="reporter-email"
        hint={optional}
        error={isEmailAcceptable(data.email) ? undefined : tr(t, "CS_EMAIL_INVALID", "Please enter a valid email address")}
      >
        <Input
          id="reporter-email"
          data-matomo-mask
          type="email"
          value={data.email ?? ""}
          onChange={(e) => patch({ email: e.target.value })}
        />
      </Field>
    </div>
  );
}

/**
 * The declarations confirmed before submit, on the authority flow: the
 * mandatory consents under one header and the confidentiality opt-in under
 * another (CCSD-2072).
 */
function Declarations({ data, patch, t }: StepBodyProps) {
  const consents = data.consents || [];
  const toggleConsent = (code: string, on: boolean) =>
    patch({ consents: on ? [...consents, code] : consents.filter((c) => c !== code) });
  return (
    <div className="space-y-2">
      {/* Consents are EXPLICIT at create (CCSD-1979 revisited: show at
          create; hidden only on the details/view screens — CCSD-1988). */}
      <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: PRIMARY }}>
        {tr(t, "PGR_CONSENT_SECTION_MANDATORY", "Mandatory")}
        <span className="ml-0.5" style={{ color: "var(--color-error, #d4351c)" }} aria-hidden>
          *
        </span>
      </div>
      {REQUIRED_CONSENTS.map((c) => (
        <label key={c.code} className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            style={CHECKBOX_STYLE}
            checked={consents.includes(c.code)}
            onChange={(e) => toggleConsent(c.code, e.target.checked)}
          />
          <span>
            {tr(t, c.labelKey, c.label)}
            {/* Same required marker the design-system Label renders. */}
            <span className="ml-0.5 text-destructive" style={{ color: "var(--color-error, #d4351c)" }} aria-hidden>
              *
            </span>
          </span>
        </label>
      ))}
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground pt-3 mt-1 border-t border-border">
        {tr(t, "PGR_CONSENT_SECTION_OPTIONAL", "Optional")}
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          style={CHECKBOX_STYLE}
          checked={!!data.isConfidential}
          onChange={(e) => patch({ isConfidential: e.target.checked })}
        />
        <span>
          {tr(t, "PGR_EXT_IS_CONFIDENTIAL_LABEL", "Keep details confidential.")}{" "}
          <span className="text-muted-foreground">
            {tr(t, "PGR_EXT_IS_CONFIDENTIAL_HINT", "Visibility is enforced once secure handling is enabled; for now this flags the complaint for staff awareness.")}
          </span>
        </span>
      </label>
    </div>
  );
}

function MapPanel({ data, patch, t, tenantId }: StepBodyProps) {
  // Reuse the existing GeoLocations component — it owns the leaflet map +
  // Nominatim integration. We just pass through formData and a setter.
  const GeoLocations = Digit?.ComponentRegistryService?.getComponent("GeoLocations");
  if (!GeoLocations) {
    return <p className="cms-field-error">Map component not registered.</p>;
  }
  return (
    <GeoLocations
      t={t}
      // The map's MapConfig + ward-boundary tree resolve at the tenant the
      // complaint files under (the authority's tenantCode), not the citizen's
      // login tenant (state root) whose tree is empty.
      tenantId={tenantId}
      config={{
        key: "GeoLocationsPoint",
        populators: { name: "GeoLocationsPoint" },
        withoutLabel: true,
      }}
      formData={data}
      onSelect={(_key: string, value: GeoPoint) => {
        patch({ GeoLocationsPoint: value });
      }}
    />
  );
}

/**
 * The boundary cascade and landmark under the map.
 *
 * The cascade auto-fills from the map pin (GeoLocations.resolveWard writes
 * the ward, BoundaryComponent rebuilds the path) and renders the filled
 * levels read-only; a level the auto-fill missed stays interactive so the
 * citizen can fill the gap.
 */
function LocationFields({ data, patch, t, tenantId }: StepBodyProps) {
  const PGRBoundaryComponent = Digit?.ComponentRegistryService?.getComponent("PGRBoundaryComponent");

  // The map's resolveWard writes ward.{code, name} into
  // GeoLocationsPoint when the pin lands inside a known ward polygon.
  // BoundaryComponent watches that field and rebuilds its cascade
  // path; we use the same hint to decide whether to mark the cascade
  // read-only.
  const wardHint = data?.GeoLocationsPoint?.ward;
  const wardFromMap = !!(wardHint?.code || wardHint?.name);

  return (
    <div className="cms-field-grid">
      {PGRBoundaryComponent ? (
        <PGRBoundaryComponent
          t={t}
          userType="citizen"
          // Scope the cascade to the tenant the complaint FILES under, which is
          // the same tenant the map resolves against. Without it the cascade
          // falls back to ULBService.getCurrentTenantId(), which returns
          // STATE_LEVEL_TENANT_ID for every citizen — so a citizen whose home
          // city is set would pick boundaries out of the state root's tree and
          // attach them to a complaint filed in their city.
          config={{ key: "SelectedBoundary", populators: { name: "SelectedBoundary" }, label: "", tenantId }}
          formData={data}
          // Ask the cascade to render its dropdowns as disabled
          // wherever it has an auto-filled value. Levels left empty
          // (auto-fill miss) stay interactive so the user can pick.
          readOnly={wardFromMap}
          onSelect={(_key: string, value: BoundaryNode) => {
            patch({ SelectedBoundary: value });
          }}
        />
      ) : (
        <p className="text-sm text-destructive">Boundary component not registered.</p>
      )}

      <Field
        label={tr(t, "CS_COMPLAINT_LANDMARK__DETAILS", "Landmark") + " " + tr(t, "CS_OPTIONAL_SUFFIX", "(Optional)")}
        htmlFor="landmark"
      >
        <Input
          id="landmark"
          data-matomo-mask
          placeholder={tr(t, "CS_LANDMARK_PLACEHOLDER", "e.g. Near Jamia Mosque")}
          maxLength={64}
          value={data.landmark ?? ""}
          onChange={(e) => patch({ landmark: e.target.value })}
        />
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const ChevronLeft = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="m15 18-6-6 6-6" />
  </svg>
);
const ArrowRight = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
  </svg>
);
const CheckMark = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);
const PinGlyph = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
    <circle cx="12" cy="10" r="3" />
  </svg>
);

interface DetailsStepProps extends StepBodyProps {
  canSpeak: boolean;
  onVoice: () => void;
}

function DetailsStep(props: DetailsStepProps) {
  const { data, patch, t, tenantId, canSpeak, onVoice, relatedToOptions, dispatcherLoading, templateFields } = props;
  const say = (key: string, fallback: string) => tr(t, key, fallback);
  const hasDispatcher = (relatedToOptions?.length ?? 0) > 0;
  // With an authority dispatcher, the category waits for the authority: its
  // catalogue lives at the authority's tenant.
  const showCategory = !hasDispatcher || !!data.caseRelatedTo;
  return (
    <div className="cms-step-body">
      {dispatcherLoading ? (
        <InlineSpinner />
      ) : hasDispatcher && (relatedToOptions?.length ?? 0) > 1 ? (
        // Single-authority: the one option is auto-selected upstream — no picker.
        <Section title={say("CS_COMPLAINT_RELATED_TO", "What is your complaint about?")} className="cms-section-authority">
          <AuthorityField {...props} />
        </Section>
      ) : null}
      <Section className="cms-section-describe">
        <label className="cms-label" htmlFor="complaint-description">
          {say("CS_FILE_DESCRIBE_TITLE", "Tell us how we can help")} <span className="cms-required">*</span>
        </label>
        <div className={`cms-textarea-wrap${canSpeak ? " with-mic" : ""}`}>
          <Textarea
            id="complaint-description"
            className="cms-textarea"
            data-matomo-mask
            rows={6}
            maxLength={DESCRIPTION_MAX}
            placeholder={say(
              "CS_FILE_DESCRIBE_PLACEHOLDER",
              "Please share as much as you can about the issue. The more you can tell us, the sooner we can help.",
            )}
            value={data.description ?? ""}
            onChange={(e) => patch({ description: e.target.value })}
          />
          {canSpeak ? <MicButton label={say("CS_VOICE_RECORD", "Record your complaint")} onClick={onVoice} /> : null}
        </div>
        <div className="cms-counter">
          {(data.description ?? "").length} / {DESCRIPTION_MAX}
        </div>
      </Section>
      <Section
        // CCSD-2071: photos OR documents (PDF, DOC/DOCX, XLS/XLSX, video).
        title={say("CS_ADDCOMPLAINT_UPLOAD_PHOTO", "Upload photos / attachments") + " " + say("CS_OPTIONAL_SUFFIX", "(Optional)")}
        className="cms-section-photos"
      >
        <PgrFileUpload
          t={t}
          // Filestore ids are tenant-scoped: upload under the tenant the
          // complaint submits under.
          tenantId={tenantId}
          fieldKey="ComplaintImagesPoint"
          value={Array.isArray(data.ComplaintImagesPoint) ? data.ComplaintImagesPoint : []}
          onSelect={(_key: string, value: string[]) => {
            patch({ ComplaintImagesPoint: value });
          }}
        />
      </Section>
      <Section title={say("CS_FILE_CATEGORY", "Nature of your issue")} className="cms-section-category">
        {showCategory ? (
          <CategoryFields {...props} />
        ) : (
          <p className="cms-section-hint">
            {say("CS_HINT_RELATED_TITLE", "Start by selecting what your complaint is about.")}
          </p>
        )}
      </Section>
      {showCategory && (templateFields?.length ?? 0) > 0 ? (
        <Section title={say("CS_COMPLAINT_DETAILS_ADDITIONAL_DETAILS", "Additional Details")} className="cms-section-additional">
          <AdditionalFields {...props} />
        </Section>
      ) : null}
      <Section title={say("CS_REPORTER_DETAILS_TITLE", "Your details")} className="cms-section-reporter">
        <p className="cms-section-hint">
          {say("CS_REPORTER_DETAILS_SUB", "Shown to the handling officers. You can edit them for this complaint.")}
        </p>
        <ReporterFields {...props} />
      </Section>
    </div>
  );
}

function LocationStep(props: StepBodyProps) {
  const { data, t } = props;
  const point = data.GeoLocationsPoint;
  const pinned = point?.lat != null && point?.lng != null;
  const coords = pinned ? `${Number(point?.lat).toFixed(5)}, ${Number(point?.lng).toFixed(5)}` : "";
  return (
    <div className="cms-step-body cms-location-body">
      <Section title={tr(t, "CS_FILE_LOCATION_TITLE", "Tell us where this happened")} className="cms-section-map">
        <p className="cms-section-hint">
          {tr(t, "CS_PIN_LOCATION_HINT", "Drop a pin on the exact spot — we'll use it to route your complaint to the right ward.")}
        </p>
        <div className="cms-map">
          <MapPanel {...props} />
        </div>
        <div className="cms-pin-summary">
          <span className={`cms-pin-icon${pinned ? " pinned" : ""}`}>
            <PinGlyph />
          </span>
          <span className="cms-pin-text">
            <span className="cms-pin-title">
              {pinned
                ? tr(t, "CS_FILE_PINNED", "Pinned location")
                : tr(t, "CS_FILE_NOT_PINNED", "No location pinned yet (Optional)")}
            </span>
            <span className="cms-pin-meta">
              {pinned ? point?.address || coords : tr(t, "CS_FILE_PIN_HINT", "Search, drag the map, or use current location")}
            </span>
          </span>
        </div>
      </Section>
      <Section className="cms-section-address">
        <LocationFields {...props} />
      </Section>
    </div>
  );
}

const truncate = (text: string, max: number) => {
  const flat = text.trim().replace(/\s+/g, " ");
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
};

/** Category and sub-category names for the chosen type, as the pickers show them. */
function categoryNames(data: FormData, t: (k: string) => string): { category: string; subCategory: string } {
  const main = data.SelectComplaintType;
  const sub = data.SelectSubComplaintType || main;
  if (!main) return { category: "", subCategory: "" };
  // A leaf with a parent reads "parent · leaf"; a type picked at its own
  // (terminal) level has no sub-category.
  const hasParent = !!main.menuPath && main.menuPath !== sub?.serviceCode;
  return {
    category: hasParent ? complaintLabel(t, main.menuPath, main.menuPathName) : complaintLabel(t, sub?.serviceCode, sub?.name),
    subCategory: hasParent && sub ? complaintLabel(t, sub.serviceCode, sub.name) : "",
  };
}

/** "Ward, Sub County, County": the boundary levels, leaf first. */
function addressLine(data: FormData, t: (k: string) => string): string {
  const levels: BoundaryLevel[] = (data.SelectedBoundary?.levels as BoundaryLevel[]) || [];
  // Named as the cascade's dropdowns name them: the code's translation, else
  // the node's own name, so an unlocalised tenant does not read raw codes.
  return levels
    .slice()
    .reverse()
    .map((level) => {
      if (!level.code) return "";
      const translated = t(level.code);
      return translated && translated !== level.code ? translated : level.name || level.code;
    })
    .filter(Boolean)
    .join(", ");
}

function ReviewCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="cms-review-card">
      <h3 className="cms-review-head">{title}</h3>
      {children}
    </section>
  );
}

function ReviewRows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="cms-review-rows">
      {rows.map(([label, value]) => (
        <div key={label} className="cms-review-row">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ReviewStep(props: StepBodyProps) {
  const { data, t, templateFields } = props;
  const say = (key: string, fallback: string) => tr(t, key, fallback);
  const notProvided = say("CS_FILE_NOT_PROVIDED", "Not provided");
  const notSelected = say("CS_FILE_NOT_SELECTED", "Not selected");
  const { category, subCategory } = categoryNames(data, t);
  const attachedCount = Array.isArray(data.ComplaintImagesPoint) ? data.ComplaintImagesPoint.length : 0;
  const point = data.GeoLocationsPoint;
  const pinned = point?.lat != null && point?.lng != null;
  const user = Digit.UserService.getUser()?.info;
  const dyn = data.dynamicFields || {};

  const detailRows: Array<[string, string]> = [];
  if (data.caseRelatedTo) {
    detailRows.push([say("CS_COMPLAINT_RELATED_TO_FIELD", "Complaint related to"), data.caseRelatedToName ? t(data.caseRelatedToName) : data.caseRelatedTo]);
  }
  detailRows.push(
    [say("CS_COMPLAINT_DETAILS_ADDITIONAL_DETAILS_DESCRIPTION", "Description"), data.description?.trim() ? truncate(data.description, 180) : notProvided],
    [say("CS_FILE_CATEGORY_LABEL", "Complaint Category"), category || notSelected],
    // A type with no sub-types has nothing to select here.
    [say("CS_FILE_SUBCATEGORY_LABEL", "Complaint Subcategory"), subCategory || (category ? "—" : notSelected)],
  );
  (templateFields || []).forEach((f) => {
    const value = String(dyn[f.fieldKey] ?? "").trim();
    detailRows.push([f.labelKey ? tr(t, f.labelKey, f.label) : f.label, value ? truncate(value, 120) : notProvided]);
  });
  detailRows.push([
    say("CS_FILE_PHOTOS", "Photos"),
    attachedCount
      ? say("CS_FILE_PHOTOS_ATTACHED", "{count} attached").replace("{count}", String(attachedCount))
      : say("CS_FILE_NO_PHOTOS", "None attached"),
  ]);

  const complainantRows: Array<[string, string]> = [
    [say("CORE_COMMON_NAME", "Name"), data.complainantName?.trim() || user?.name || notProvided],
    [say("CORE_COMMON_MOBILE_NUMBER", "Phone number"), user?.mobileNumber || notProvided],
  ];
  if (data.complainantAddress?.trim()) complainantRows.push([say("CS_REPORTER_ADDRESS_LABEL", "Address"), truncate(data.complainantAddress, 120)]);
  if (data.email?.trim()) complainantRows.push([say("PGR_EXT_EMAIL_LABEL", "Email Address"), data.email.trim()]);

  return (
    <div className="cms-step-body cms-review-body">
      <h2 className="cms-review-heading">{say("CS_FILE_REVIEW_HEADING", "Review before you submit")}</h2>
      <ReviewCard title={say("CS_COMPLAINT_DETAILS_COMPLAINT_DETAILS", "Complaint details")}>
        <ReviewRows rows={detailRows} />
      </ReviewCard>
      <ReviewCard title={say("CS_FILE_STEP_LOCATION", "Location")}>
        <ReviewRows
          rows={[
            [say("CS_FILE_ADDRESS", "Address"), addressLine(data, t) || notProvided],
            [say("CS_COMPLAINT_LANDMARK__DETAILS", "Landmark"), data.landmark?.trim() ? truncate(data.landmark, 60) : notProvided],
            [
              say("CS_FILE_PIN_DROP", "Location"),
              pinned
                ? point?.address || `${Number(point?.lat).toFixed(5)}, ${Number(point?.lng).toFixed(5)}`
                : say("CS_FILE_NOT_CAPTURED", "Not captured"),
            ],
          ]}
        />
      </ReviewCard>
      <ReviewCard title={say("CS_FILE_COMPLAINANT", "Complainant details")}>
        <ReviewRows rows={complainantRows} />
      </ReviewCard>
      {data.caseRelatedTo ? (
        <section className="cms-review-card">
          <Declarations {...props} />
        </section>
      ) : null}
    </div>
  );
}

/** Desktop: the numbered stepper at the top of the card. Done steps go back. */
function FlowStepper({ index, t, onGo }: { index: number; t: (k: string) => string; onGo: (i: number) => void }) {
  return (
    <nav className="cms-stepper" aria-label={tr(t, "CS_FILE_PROGRESS", "Progress")}>
      <ol>
        {STEPS.map((step, i) => {
          const state = i < index ? "done" : i === index ? "current" : "todo";
          return (
            <li key={step.id} className={`cms-step ${state}`}>
              <button
                type="button"
                className="cms-step-mark"
                disabled={i >= index}
                aria-current={i === index ? "step" : undefined}
                onClick={() => onGo(i)}
                data-analytics-event={`pgr.file-complaint.stepper.${step.id}`}
              >
                <span className="cms-step-dot">{i < index ? <CheckMark /> : i + 1}</span>
                <span className="cms-step-label">{tr(t, step.key, step.fallback)}</span>
              </button>
              {i < STEPS.length - 1 ? <span className={`cms-step-line${i < index ? " done" : ""}`} aria-hidden="true" /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Phone: "Step 1 of 3 · Complaint Details", what comes next, and a bar per step. */
function FlowStrip({ index, t }: { index: number; t: (k: string) => string }) {
  const current = STEPS[index];
  const next = STEPS[index + 1];
  const stepOf = tr(t, "CS_FILE_STEP_OF", "Step {current} of {total}")
    .replace("{current}", String(index + 1))
    .replace("{total}", String(STEPS.length));
  return (
    <div className="cms-strip">
      <div className="cms-strip-row">
        <span className="cms-strip-heading">
          {stepOf} · {tr(t, current.key, current.fallback)}
        </span>
        <span className="cms-strip-next">
          {next
            ? tr(t, "CS_FILE_NEXT_STEP", "Next: {step}").replace("{step}", tr(t, next.key, next.fallback))
            : tr(t, "CS_FILE_CHECK_SUBMIT", "Check and submit")}
        </span>
      </div>
      <div className="cms-strip-bars" aria-hidden="true">
        {STEPS.map((step, i) => (
          <span key={step.id} className={i <= index ? "on" : ""} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

const CreatePGRFlowV2: React.FC = () => {
  const { t, i18n } = useTranslation();
  const history = useHistory();
  const dispatch = useDispatch();
  const client = useQueryClient();

  const baseTenant =
    Digit.SessionStorage.get("CITIZEN.COMMON.HOME.CITY")?.code ||
    Digit.ULBService.getCurrentTenantId();
  const stateTenant =
    Digit.ULBService.getStateId() ||
    (baseTenant ? String(baseTenant).split(".")[0] : baseTenant);

  // Seed from the session draft ONLY on a document reload (mid-flow F5) so the
  // citizen doesn't lose their answers to an accidental refresh. Every other
  // entry ("File a Complaint", sidebar, deep link) starts completely clean and
  // deletes the stored draft. The draft is also stamped with the tenant + user
  // it was written under and DISCARDED on mismatch — a home-city switch or a
  // re-login must never restore another tenant's serviceCode / boundary (they
  // would submit under the new tenant with blank pickers).
  const draftUserUuid = Digit.UserService.getUser()?.info?.uuid;
  const savedDraftRef = React.useRef<any>(null);
  if (savedDraftRef.current === null) {
    if (RESTORE_STEP_ARMED) {
      const d = Digit.SessionStorage.get(CREATE_DRAFT_KEY) || {};
      savedDraftRef.current =
        d.formData && typeof d.formData === "object" && d.tenant === baseTenant && d.user === draftUserUuid
          ? d
          : {};
    } else {
      Digit.SessionStorage.del(CREATE_DRAFT_KEY);
      savedDraftRef.current = {};
    }
  }
  // The step is DERIVED FROM THE URL — each tab is its own route (STEP_SLUGS).
  // On a document reload the URL itself preserves the position; a fresh
  // (non-reload) entry whose URL points past step 1 is normalised back to
  // step 1, because its answers were just discarded by the draft block above.
  const location = useLocation();
  const basePath = `/${window?.contextPath || "digit-ui"}/citizen/pgr/create-complaint`;
  const urlSlug = location.pathname.startsWith(basePath)
    ? location.pathname.slice(basePath.length).replace(/^\//, "").split("/")[0] || ""
    : "";
  const urlIndex = (STEP_SLUGS as readonly string[]).indexOf(urlSlug);
  const stepIndex = urlIndex === -1 ? 0 : urlIndex;
  // Consume the reload flag (the draft block above already read it): later
  // SPA re-entries within this document must start clean.
  const freshEntryRef = React.useRef(!RESTORE_STEP_ARMED);
  RESTORE_STEP_ARMED = false;

  const scrollToTop = () => {
    window.scrollTo({ top: 0 });
    // The app scrolls inside .body-container rather than the window.
    document.querySelector(".body-container")?.scrollTo({ top: 0 });
  };

  const goToStep = React.useCallback(
    (i: number, replace?: boolean) => {
      const bounded = Math.min(Math.max(i, 0), STEPS.length - 1);
      const to = `${basePath}/${STEP_SLUGS[bounded]}`;
      if (replace) history.replace(to);
      else history.push(to);
    },
    [history, basePath]
  );
  // Canonicalise: bare /create-complaint (or an unknown segment) becomes step
  // 1's URL, and a fresh entry may not START past step 1.
  React.useEffect(() => {
    if (urlIndex === -1) {
      goToStep(0, true);
      return;
    }
    if (urlIndex > 0 && freshEntryRef.current) {
      freshEntryRef.current = false;
      goToStep(0, true);
      return;
    }
    freshEntryRef.current = false;
  }, [urlIndex, goToStep]);

  const [formData, setFormData] = React.useState<FormData>(() => savedDraftRef.current.formData || {});
  const [submitting, setSubmitting] = React.useState(false);
  const [voiceOpen, setVoiceOpen] = React.useState(false);
  // The location step mounts on its first visit and then stays, so the map
  // and the boundary cascade keep what the citizen picked when they go Back.
  const [locationVisited, setLocationVisited] = React.useState(stepIndex >= 1);
  React.useEffect(() => {
    if (stepIndex >= 1) setLocationVisited(true);
  }, [stepIndex]);
  // The browser has to support speech, and the tenant mustn't have turned
  // voice off (RAINMAKER-PGR.UIConstants.VOICE_INPUT: false).
  const browserCanSpeak = React.useMemo(() => speechToTextSupported(), []);
  const voiceEnabled = useVoiceInputEnabled(baseTenant);
  const canSpeak = browserCanSpeak && voiceEnabled;

  // Mirror every change into the session draft. Deleted on successful create;
  // kept on failure so "Try Again" restores the answers.
  React.useEffect(() => {
    Digit.SessionStorage.set(CREATE_DRAFT_KEY, { formData, stepIndex, tenant: baseTenant, user: draftUserUuid });
  }, [formData, stepIndex, baseTenant, draftUserUuid]);

  const patch = React.useCallback((partial: Partial<FormData>) => {
    setFormData((prev) => ({ ...prev, ...partial }));
  }, []);

  // Authority dispatcher (RAINMAKER-PGR.ComplaintRelatedToMap @ state tenant).
  // Empty (the default for any tenant that hasn't seeded it) => the legacy flow:
  // no authority picker, catalogue fetched at the base tenant, no extendedAttributes.
  const { data: relatedToOptions, isLoading: isDispatcherLoading } = Digit.Hooks.useCustomMDMS(
    stateTenant,
    "RAINMAKER-PGR",
    [{ name: "ComplaintRelatedToMap" }],
    {
      cacheTime: Infinity,
      select: (raw: any) =>
        ((raw?.["RAINMAKER-PGR"]?.ComplaintRelatedToMap || []) as RelatedToOption[])
          .filter((o) => o?.active !== false && !!o?.code && !!o?.name && !!o?.tenantCode)
          // Entrance scoping: the gated /digit-ui-test entrance sees ONLY
          // testing-tenant authorities; production entrances never see them.
          // Which tenants are "testing" comes from the isTestingTenant flag
          // (set via the configurator checkbox) with the legacy
          // TESTING_TENANT_ID config as fallback — see utils/testingTenant.
          .filter((o: RelatedToOption) => isVisibleOnEntrance(o.tenantCode))
          .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0)),
    },
    { schemaCode: "PGR_COMPLAINT_RELATED_TO_MAP", tenantId: stateTenant }
  );
  const hasDispatcher = Array.isArray(relatedToOptions) && relatedToOptions.length > 0;

  // Single-authority deployments (one active row — e.g. IGE-only after the
  // split, or the testing entrance): the authority is a foregone conclusion,
  // so pick it automatically and never render the dropdown. Multi-authority
  // keeps the picker exactly as before. The auto-pick mirrors the manual
  // handler's patch (resolvedTenantId drives catalogue/boundary/map fetches).
  React.useEffect(() => {
    if (!Array.isArray(relatedToOptions) || relatedToOptions.length !== 1) return;
    const o = relatedToOptions[0];
    if (formData.caseRelatedTo === o.code && formData.resolvedTenantId === o.tenantCode) return;
    patch({
      caseRelatedTo: o.code,
      caseRelatedToName: o.name,
      resolvedTenantId: o.tenantCode,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relatedToOptions, formData.caseRelatedTo, formData.resolvedTenantId]);

  // The tenant the complaint files under: the authority-resolved sub-tenant
  // once picked, else the base tenant (legacy). Changing it re-fetches the
  // catalogue, map and boundary tree at that tenant.
  const resolvedTenant = formData.resolvedTenantId || baseTenant;
  const caseRelatedTo = formData.caseRelatedTo;

  // Mount the MDMS validation mirror: fetches common-masters.FormValidations
  // (and MobileNumberValidation) and publishes the tenant's rules to
  // window.__DIGIT_FORM_VALIDATIONS. Mobile validation reads this channel
  // first; without it the v2 flow would silently keep validating against the
  // globalConfigs fallback while the employee form honours the
  // (higher-precedence) MDMS row.
  Digit.Hooks.pgr.useMobileValidation(baseTenant);

  // The single RAINMAKER-PGR.ComplaintHierarchy adjacency list (interior nodes
  // + leaf complaint types) is the only complaint-type master now. We derive:
  //   - serviceDefs: leaf rows mapped to the legacy shape (serviceCode=code,
  //     menuPath=parentCode) so the flat fallback picker keeps working verbatim;
  //   - hierData.nodes: the full row set the N-level cascade picker walks.
  // Absent definition => the flat menuPath (=parentCode) picker is used.
  const { data: hierAll, isLoading: isMDMSLoading, isFetching: isMDMSFetching } = Digit.Hooks.useCustomMDMS(
    resolvedTenant,
    "RAINMAKER-PGR",
    [{ name: "ComplaintHierarchyDefinition" }, { name: "ComplaintHierarchy" }],
    {
      cacheTime: Infinity,
      select: (raw: any) => {
        const allDefs = (raw?.["RAINMAKER-PGR"]?.ComplaintHierarchyDefinition || []).filter(
          (d: any) => d?.active !== false
        );
        const allRows = raw?.["RAINMAKER-PGR"]?.ComplaintHierarchy || [];
        // Prefer a definition that actually HAS rows — guards against a
        // stray/empty definition being picked first. Scope rows to its type.
        const def =
          allDefs.find((d: any) => allRows.some((n: any) => n?.hierarchyType === d?.hierarchyType)) ||
          allDefs[0] ||
          null;
        const rows = def
          ? allRows.filter((n: any) => n?.hierarchyType === def.hierarchyType)
          : allRows;
        const isLeaf = (n: any) => n?.department != null || n?.slaHours != null;
        const nodes = (rows || []).filter((n: any) => !isLeaf(n));
        const serviceDefs = (rows || [])
          .filter((n: any) => isLeaf(n) && n.active !== false)
          .map((n: any) => ({ ...n, serviceCode: n.code, menuPath: n.parentCode }));
        return { def, nodes, serviceDefs };
      },
    },
    // The 5th (mdmsv2) arg makes useCustomMDMS ignore the positional tenant —
    // the tenant must ride inside it.
    { schemaCode: "PGR_COMPLAINT_HIERARCHY", tenantId: resolvedTenant }
  );

  const serviceDefs = hierAll?.serviceDefs;
  const hierData = hierAll ? { def: hierAll.def, nodes: hierAll.nodes } : undefined;

  // Which tenant the currently-held catalogue was fetched for. The shared MDMS
  // hook forces keepPreviousData, so on an authority switch isLoading stays
  // false and `serviceDefs` briefly holds the PREVIOUS tenant's rows. Comparing
  // the resolved tenant to the last-settled one (updated only when a fetch
  // completes) is frame-accurate — the category shows the inline spinner the
  // instant the tenant changes, never the stale options — and does NOT trigger
  // on same-tenant background refetches (which would reset the picker). Kept
  // in STATE so the settle re-renders and the spinner gives way to the picker.
  const [catalogueLoadedFor, setCatalogueLoadedFor] = React.useState<string | undefined>(undefined);
  React.useEffect(() => {
    if (!isMDMSFetching) setCatalogueLoadedFor(resolvedTenant);
  }, [isMDMSFetching, resolvedTenant]);
  const catalogueStale = catalogueLoadedFor !== resolvedTenant;

  // Per-category templates (RAINMAKER-PGR.ComplaintTemplateType @ state tenant),
  // keyed by caseRelatedTo. Each points at a JSON Schema (schemaRef) + the
  // allowed evidence document types.
  const { data: templatesAll } = Digit.Hooks.useCustomMDMS(
    stateTenant,
    "RAINMAKER-PGR",
    [{ name: "ComplaintTemplateType" }],
    {
      cacheTime: Infinity,
      select: (raw: any) =>
        (raw?.["RAINMAKER-PGR"]?.ComplaintTemplateType || []) as Array<{
          caseRelatedTo: string;
          active?: boolean;
          schemaRef?: string;
          allowedDocumentTypes?: string[];
        }>,
    },
    { schemaCode: "PGR_COMPLAINT_TEMPLATE_TYPE", tenantId: stateTenant }
  );
  // The per-category JSON Schemas (RAINMAKER-PGR.ComplaintExtendedAttributeSchema),
  // keyed by schemaRef — the FE renders the dynamic fields from these.
  const { data: schemasAll } = Digit.Hooks.useCustomMDMS(
    stateTenant,
    "RAINMAKER-PGR",
    [{ name: "ComplaintExtendedAttributeSchema" }],
    {
      cacheTime: Infinity,
      select: (raw: any) => {
        const rows = (raw?.["RAINMAKER-PGR"]?.ComplaintExtendedAttributeSchema || []) as Array<{
          schemaRef: string;
          schema?: any;
        }>;
        const byRef: Record<string, any> = {};
        rows.forEach((r) => {
          if (r?.schemaRef) byRef[r.schemaRef] = r.schema;
        });
        return byRef;
      },
    },
    { schemaCode: "PGR_COMPLAINT_EXT_ATTR_SCHEMA", tenantId: stateTenant }
  );
  // Resolve the picked category → its template → its JSON Schema → renderable
  // fields (recomputes on category change without re-fetching). NOTE: every schema
  // field renders, incl. x-security ones — they are submitted in clear text until
  // the backend encryption phase lands.
  const { templateFields, evidenceDocType } = React.useMemo(() => {
    const entry = (templatesAll || []).find(
      (x: any) => x?.active !== false && x?.caseRelatedTo === caseRelatedTo
    );
    const schema = entry?.schemaRef ? (schemasAll || {})[entry.schemaRef] : null;
    return {
      templateFields: fieldsFromSchema(schema),
      evidenceDocType: (entry?.allowedDocumentTypes && entry.allowedDocumentTypes[0]) || "EVIDENCE",
    };
  }, [templatesAll, schemasAll, caseRelatedTo]);

  const { mutate: createMutation } = Digit.Hooks.pgr.useCreateComplaint(resolvedTenant);

  const curId = STEPS[stepIndex]?.id;
  const isLast = stepIndex === STEPS.length - 1;

  // The step's FIRST blocking requirement, or null when the step is valid.
  // One source of truth: Next's disabled state, the hint under it, and the
  // Error/ValidationError analytics reason all derive from it, so they can
  // never disagree.
  const stepBlocker = React.useMemo<string | null>(() => {
    switch (curId) {
      case "details": {
        // Dispatcher (if seeded) must be answered, then a leaf complaint type.
        if (hasDispatcher && !formData.caseRelatedTo) return "AuthorityRequired";
        if (!isFieldValid(formData, "description")) return "DescriptionRequired";
        if (!isFieldValid(formData, "SelectComplaintType")) return "ComplaintTypeRequired";
        // Sub-type is conditionally mandatory: if the chosen type has sub-services
        // in the same menuPath, one must be picked (mirrors legacy FormExplorer).
        const mainPath = formData.SelectComplaintType?.menuPath;
        const subTypeOptions = (Array.isArray(serviceDefs) ? serviceDefs : []).filter(
          (s: ServiceDef) => s.menuPath === mainPath
        );
        if (subTypeOptions.length > 1 && !formData.SelectSubComplaintType) return "SubTypeRequired";
        // Mandatory dynamic fields (dispatcher flow).
        for (const f of templateFields) {
          if (f.mandatory && !String((formData.dynamicFields || {})[f.fieldKey] ?? "").trim()) return "DynamicFieldRequired";
        }
        // Optional email, but if typed it must be well-formed. Blank passes.
        if (!isEmailAcceptable(formData.email)) return "EmailInvalid";
        return null;
      }
      case "location":
        // A leaf ward is what routing needs; the map pin is the fast path to
        // it (auto-cascade) but NOT mandatory — clearing the pin (the map's ✕)
        // and picking the cascade manually is a supported flow.
        return isFieldValid(formData, "SelectedBoundary") ? null : "LocationRequired";
      case "review":
        // Both consents are required once an authority/template is in play
        // (checkboxes restored at create — CCSD-1979 revisited).
        if (formData.caseRelatedTo && REQUIRED_CONSENTS.some((c) => !(formData.consents || []).includes(c.code))) {
          return "ConsentRequired";
        }
        return null;
      default:
        return null;
    }
    // templateFields/hasDispatcher must be deps: with a restored draft the memo
    // otherwise never recomputes when the catalogue/templates settle AFTER
    // mount, letting a last-step draft submit with empty mandatory dynamic fields.
  }, [curId, formData, serviceDefs, templateFields, hasDispatcher]);
  const stepIsValid = !stepBlocker;

  /** Why Next is held, in the words the design uses. */
  const hint = (() => {
    switch (stepBlocker) {
      case "AuthorityRequired":
        return tr(t, "CS_HINT_RELATED_TITLE", "Start by selecting what your complaint is about.");
      case "DescriptionRequired": {
        const described = (formData.description ?? "").trim();
        if (!described) return tr(t, "CS_FILE_HINT_DESCRIBE", "Tell us about the issue to continue.");
        if (described.length < DESCRIPTION_MIN) return tr(t, "CS_DESC_MIN_CHARS", "Minimum 20 characters");
        return tr(t, "CS_DESC_NEEDS_WORDS", "Please describe the issue in words, not only numbers");
      }
      case "ComplaintTypeRequired":
      case "SubTypeRequired":
        return tr(t, "CS_FILE_HINT_CATEGORY", "Select a complaint category and subcategory to continue.");
      case "DynamicFieldRequired":
        return tr(t, "CORE_COMMON_REQUIRED_ERRMSG", "Fill in the required fields to continue.");
      case "EmailInvalid":
        return tr(t, "CS_EMAIL_INVALID", "Please enter a valid email address");
      case "LocationRequired":
        return tr(t, "CS_FILE_HINT_LOCATION", "Select every level of the location to continue.");
      case "ConsentRequired":
        return tr(t, "CORE_COMMON_REQUIRED_ERRMSG", "Confirm the mandatory declarations to submit.");
      default:
        return "";
    }
  })();

  // ── Behaviour analytics (catalogue events; the steps themselves are real
  //    pageviews, so no per-step "reached" events — see utils/analytics.js) ──
  // Started: once per FRESH entry into the flow — not on a mid-flow F5 restore
  // and not on step navigation (the component stays mounted across steps).
  const enteredFreshRef = React.useRef(freshEntryRef.current);
  React.useEffect(() => {
    if (enteredFreshRef.current) trackE(EV.COMPLAINT_STARTED);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Type/location selections: fire only on a USER change — the refs start at
  // the (possibly draft-restored) current value, so a restore replay or a
  // re-render emits nothing.
  //
  // The reported label is the MDMS master NAME ("Rude behavior"), not the
  // UI-localised t() string: the master name is readable AND identical for
  // every user of the tenant regardless of language, so one type stays ONE
  // row in reports. Master data, never PII.
  const selectedTypeCode = formData.SelectComplaintType?.serviceCode;
  const selectedTypeName = formData.SelectComplaintType?.name || selectedTypeCode;
  const prevTypeRef = React.useRef(selectedTypeCode);
  React.useEffect(() => {
    if (selectedTypeCode && selectedTypeCode !== prevTypeRef.current) {
      trackE(EV.COMPLAINT_TYPE_SELECTED, `Type:${selectedTypeName}`);
    }
    prevTypeRef.current = selectedTypeCode;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTypeCode]);

  const selectedBoundaryCode = formData.SelectedBoundary?.code;
  const prevBoundaryRef = React.useRef(selectedBoundaryCode);
  React.useEffect(() => {
    // Only the none→selected transition: every cascade level updates the
    // boundary, so change-based tracking fired once PER LEVEL. "Citizen picked
    // a location" is one action; refinements are not. Clearing and re-picking
    // counts again. Name stays "Location" — never the ward/boundary code,
    // which combined with a timestamp could narrow down to a person.
    if (selectedBoundaryCode && !prevBoundaryRef.current) {
      trackE(EV.COMPLAINT_LOCATION_SELECTED, "Location");
    }
    prevBoundaryRef.current = selectedBoundaryCode;
  }, [selectedBoundaryCode]);

  // Coming back to the map: Leaflet sized itself while hidden, and redraws on
  // a window resize.
  React.useEffect(() => {
    if (stepIndex !== 1) return undefined;
    const id = window.requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    return () => window.cancelAnimationFrame(id);
  }, [stepIndex]);

  function handleContinue() {
    // Guard the handler as well as the button: a fast double-tap can fire
    // twice before React re-renders the disabled state, and Enter on the
    // form would bypass the button entirely.
    if (submitting) return;
    if (!stepIsValid) {
      trackE(EV.VALIDATION_ERROR, stepBlocker || curId || "");
      return;
    }
    if (isLast) {
      // The whole form runs on auth-optional endpoints, so a session that
      // expired while the citizen typed goes unnoticed until this submit —
      // previously surfacing as a hung create and a dead end. Check first:
      // the draft (answers + step) is already persisted, so after re-login
      // the citizen returns here and continues. Only a KNOWN-expired session
      // redirects; sessions without expiry info submit as before.
      if (Digit.UserService.isSessionExpired?.()) {
        const from = encodeURIComponent(window.location.pathname + window.location.search);
        history.push(`/${window?.contextPath || "digit-ui"}/citizen/login?from=${from}`);
        return;
      }
      setSubmitting(true);
      trackE(EV.COMPLAINT_SUBMITTED);
      const user = Digit.UserService.getUser();
      const payload = mapFormDataToRequest(formData, resolvedTenant, user?.info ?? user, evidenceDocType);
      // What the confirmation screen summarises, handed over in the route's
      // state: the create response carries only codes, and the names are known
      // here. Route state survives the response page remounting.
      const names = categoryNames(formData, t);
      const filedSummary = {
        category: [names.category, names.subCategory].filter(Boolean).join(" · "),
        location: addressLine(formData, t),
        photos: Array.isArray(formData.ComplaintImagesPoint) ? formData.ComplaintImagesPoint.length : 0,
        filedAt: Date.now(),
      };
      const responsePath = `/${window?.contextPath || "digit-ui"}/citizen/pgr/response`;
      createMutation(payload, {
        onError: (err: any) => {
          // Outcome, not intent. The submit click is already tagged; whether the
          // complaint was actually created happens later and a click listener
          // cannot see it. Without this pair the funnel ends at "pressed submit".
          trackEvent("pgr.file-complaint.submit-failed", { category: "pgr" });
          trackE(EV.COMPLAINT_FAILED, failureName(err));
          dispatch({ type: "CREATE_COMPLAINT", payload: { responseInfo: { status: "failed" } } });
          setSubmitting(false);
          history.push(responsePath);
        },
        onSuccess: async (responseData: any) => {
          // Create is done — drop the session draft so the next visit starts fresh.
          Digit.SessionStorage.del(CREATE_DRAFT_KEY);
          trackEvent("pgr.file-complaint.submitted", { category: "pgr" });
          dispatch({ type: "CREATE_COMPLAINT", payload: responseData });
          // Name carries the complaint TYPE (master name, same rationale as
          // the Selected event — never the complaint id): conversions become
          // segmentable by type without any identifying data.
          trackE(EV.COMPLAINT_CREATED, formData.SelectComplaintType?.name || formData.SelectComplaintType?.serviceCode || "");
          await client.refetchQueries(["complaintsList"]);
          setSubmitting(false);
          history.push(responsePath, { filedSummary });
        },
      });
      return;
    }
    goToStep(stepIndex + 1);
    scrollToTop();
  }

  function handleBack() {
    if (submitting) return;
    // On the first step Back leaves the flow, as Cancel did — the one
    // EXPLICIT abandon signal (later-step abandonment shows up as pageview
    // drop-off between the step routes).
    if (stepIndex === 0) {
      trackE(EV.COMPLAINT_CANCELLED);
      history.goBack();
      return;
    }
    goToStep(stepIndex - 1);
    scrollToTop();
  }

  const stepProps: StepBodyProps = {
    data: formData,
    patch,
    serviceDefs: Array.isArray(serviceDefs) ? serviceDefs : [],
    hierarchyDef: hierData?.def ?? null,
    nodes: hierData?.nodes ?? [],
    t,
    tenantId: resolvedTenant,
    relatedToOptions: Array.isArray(relatedToOptions) ? relatedToOptions : [],
    templateFields,
    catalogueLoading: isMDMSLoading || catalogueStale,
    dispatcherLoading: isDispatcherLoading,
  };
  const say = (key: string, fallback: string) => tr(t, key, fallback);
  const appendSpoken = (text: string) => {
    const prev = (formData.description ?? "").trim();
    patch({ description: (prev ? `${prev} ${text}` : text).slice(0, DESCRIPTION_MAX) });
  };

  return (
    <ScreenContainer className="cms-file">
      <div className="cms-file-title">
        <ScreenHeader title={say("CS_COMMON_FILE_A_COMPLAINT", "File a Complaint")} />
      </div>
      <div className="cms-file-card">
        <FlowStepper
          index={stepIndex}
          t={t}
          onGo={(i) => {
            if (i < stepIndex && !submitting) {
              goToStep(i);
              scrollToTop();
            }
          }}
        />
        <FlowStrip index={stepIndex} t={t} />
        <div className={`cms-file-body is-${STEPS[stepIndex]?.id}`}>
          <div className={`cms-step-pane${stepIndex === 0 ? "" : " is-hidden"}`}>
            <DetailsStep
              {...stepProps}
              canSpeak={canSpeak}
              onVoice={() => setVoiceOpen(true)}
            />
          </div>
          {locationVisited ? (
            <div className={`cms-step-pane${stepIndex === 1 ? "" : " is-hidden"}`}>
              <LocationStep {...stepProps} />
            </div>
          ) : null}
          {stepIndex === 2 ? <ReviewStep {...stepProps} /> : null}
        </div>
        <div className="cms-footer">
          {hint ? (
            <p className="cms-hint" aria-live="polite">
              {hint}
            </p>
          ) : null}
          <div className="cms-footer-actions">
            {/* Analytics (CCRS#2007). Named from the step's stable STEPS id rather
                than stepIndex, so inserting or reordering a step cannot silently
                re-point an existing funnel step in the reports. */}
            <Button
              variant="outline"
              className="cms-back"
              onClick={handleBack}
              disabled={submitting}
              aria-label={say("CS_COMMON_BACK", "Back")}
              leading={<ChevronLeft />}
              data-analytics-event={
                stepIndex === 0 ? "pgr.file-complaint.cancel" : `pgr.file-complaint.back.${STEPS[stepIndex]?.id ?? "unknown"}`
              }
            >
              <span className="cms-back-label">{say("CS_COMMON_BACK", "Back")}</span>
            </Button>
            {/* The button is DISABLED while the step is invalid, so a click never
                reaches handleContinue — but the click ATTEMPT is exactly the
                "citizen is stuck: on what?" signal behaviour analytics needs. The
                v2 Button sets disabled:pointer-events-none, so hit-testing falls
                through the button to this wrapper (which must render a real box —
                inline-flex — for that; display:contents would generate none). */}
            <span
              style={{ display: "inline-flex" }}
              onClick={() => {
                if (!stepIsValid) trackE(EV.VALIDATION_ERROR, stepBlocker || curId || "");
              }}
            >
              <Button
                variant="primary"
                className="cms-next"
                onClick={handleContinue}
                // Also disabled while the create is in flight: a second tap on a
                // slow connection would file a duplicate complaint.
                disabled={!stepIsValid || submitting}
                loading={submitting}
                trailing={<ArrowRight />}
                data-analytics-event={isLast ? "pgr.file-complaint.submit" : `pgr.file-complaint.${STEPS[stepIndex]?.id ?? "unknown"}`}
              >
                {isLast ? say("CS_ADDCOMPLAINT_ADDITIONAL_DETAILS_SUBMIT_COMPLAINT", "Submit complaint") : say("CS_COMMON_NEXT", "Next")}
              </Button>
            </span>
          </div>
        </div>
      </div>
      <VoiceSheet
        open={voiceOpen}
        onClose={() => setVoiceOpen(false)}
        onUse={appendSpoken}
        tr={say}
        locale={i18n?.language}
      />
    </ScreenContainer>
  );
};

export default CreatePGRFlowV2;
