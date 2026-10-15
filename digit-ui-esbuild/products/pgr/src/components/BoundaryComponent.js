import { Loader } from "@egovernments/digit-ui-components";
import { selectPlaceholder, translateOr } from "../utils/selectPlaceholder";
import { Field as V2Field, Select as V2Select } from "@egovernments/digit-ui-components-v2";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { sameLevelName } from "../utils/boundaryLevels";
import {
  disambiguateLabels,
  levelsFilledAbove,
  locksAutoFilled,
  optionsForLevels,
  pathsByCode,
  selectionAfterPick,
} from "../utils/boundaryCascade";
import { trackEvent } from "../utils/analytics";

// Humanize a boundary-type code for use as a graceful fallback when its
// localization key isn't seeded: "SUB_COUNTY" -> "Sub County", "bairro" ->
// "Bairro". Accent-preserving so "Município" survives intact.
const humanizeBoundaryType = (raw) =>
  String(raw || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(^|\s)\S/g, (c) => c.toUpperCase());

const BoundaryComponent = ({ t, config, onSelect, userType, formData, readOnly }) => {

  // Boundaries are tenant-scoped. Callers that resolve a tenant at runtime
  // (e.g. the citizen authority→tenant flow) pass it via `config.tenantId`;
  // everyone else falls back to the logged-in tenant (unchanged behaviour).
  const tenantId = config?.tenantId || Digit.ULBService.getCurrentTenantId();

  // Employee jurisdiction gate (egovernments/CCRS#496) — DISABLED on this
  // deployment (Moz product call, 2026-07-23): the employee boundary picker
  // renders the SAME full tree the citizen picker does. A reception officer
  // takes complaints for any location in the country, so pruning the cascade
  // to the operator's HRMS jurisdiction (which the onboarding seeded as
  // maputo_provincia for 418/419 IGE staff, and a single childless Distrito
  // for EMP001) collapsed the picker to one province and read as a bug.
  // The prune machinery below (filterTree) is kept dormant behind
  // `allowedRoots = null` so a future deployment can re-enable scoping by
  // restoring the HRMS lookup here.
  const allowedRoots = null;

  const { data: rawChildrenData, isLoading: isBoundaryLoading } = Digit.Hooks.pgr.useFetchBoundaries(tenantId);

  // Hierarchy type + highest/lowest level are configured per-state on
  // CMS-BOUNDARY.HierarchySchema (written by the onboarding tooling — see
  // utilities/crs_dataloader/unified_loader_v1.py's update_hierarchy_schema)
  // and take priority over the ansible-templated globalConfigs values, which
  // are a deploy-time fallback for tenants where this MDMS master hasn't
  // been seeded yet. Mirrors the established pattern already used on the
  // citizen/employee create-complaint pages in frontend/micro-ui.
  const stateId = Digit.ULBService.getStateId();
  const { data: hierarchySchema } = Digit.Hooks.useCustomMDMS(
    stateId,
    "CMS-BOUNDARY",
    [{ name: "HierarchySchema" }],
    {
      select: (data) => {
        const rows = data?.["CMS-BOUNDARY"]?.HierarchySchema;
        return Array.isArray(rows) ? rows.find((row) => row.moduleName === "CMS") : null;
      },
      retry: false,
      enabled: !!stateId,
    }
  );

  const childrenData = useMemo(() => {
    if (!rawChildrenData || !allowedRoots) return rawChildrenData;
    const filterTree = (nodes) =>
      (nodes || [])
        .map((node) => {
          if (allowedRoots.has(node.code)) {
            // Allowed at this level — preserve the entire subtree so the
            // operator can pick any ward under their sub-county or any
            // descendant under their city.
            return node;
          }
          const filteredChildren = node.children ? filterTree(node.children) : [];
          if (filteredChildren.length === 0) return null;
          // Otherwise the node only stays because a descendant is
          // allowed — keep the path open down to the allowed leaf.
          return { ...node, children: filteredChildren };
        })
        .filter(Boolean);
    const filtered = rawChildrenData.map((entry) => ({
      ...entry,
      boundary: filterTree(entry.boundary || []),
    }));
    // If the jurisdiction filter prunes the entire tree (HRMS boundary codes
    // don't exactly match boundary-service node codes — common with seeding
    // drift), fall back to the full unfiltered tree so the dropdown renders.
    // Silently returning empty would black out the picker with no error shown.
    const hasAny = filtered.some((e) => (e.boundary || []).length > 0);
    return hasAny ? filtered : rawChildrenData;
  }, [rawChildrenData, allowedRoots]);

  // boundaryHierarchyOrder is written by fetchBoundaries just before its data
  // resolves (lazy loading — no more module-mount prefetch). The memo must be
  // keyed on the fetched DATA, not just tenantId: on first visit the order
  // lands AFTER mount, and a tenantId-only memo cached [] for the tenant's
  // lifetime — blank cascade until a full page refresh remounted with the
  // storage already seeded. Re-keying on rawChildrenData recomputes exactly
  // when the tree (and therefore the freshly written order) arrives; the
  // tenantId key still handles operator city switches.
  const boundaryHierarchy = useMemo(() => {
    const order = Digit.SessionStorage.get("boundaryHierarchyOrder");
    return Array.isArray(order) ? order.map((item) => item.code) : [];
    // moz: re-key on rawChildrenData so the cascade recomputes once the
    // boundary tree loads (childless-leaf fallback below depends on it).
  }, [tenantId, rawChildrenData]);
  const hierarchyType =
    hierarchySchema?.hierarchy || window?.globalConfigs?.getConfig("HIERARCHY_TYPE") || "ADMIN";

  // Respect the tenant's configured highest AND lowest boundary levels.
  // PGR_BOUNDARY_LOWEST_LEVEL caps the bottom: a tenant whose boundary tree
  // is shallower than the declared hierarchy (Maputo: many bairros have no
  // Quarteirão) otherwise leaves the deepest declared level with no options
  // — the required leaf dropdown never renders and the citizen can't
  // submit. PGR_BOUNDARY_HIGHEST_LEVEL caps the top: previously this config
  // was written to globalConfigs by ansible but never actually read here,
  // so the cascade always started at whatever level the boundary-service
  // happened to return as root, regardless of the configured highest level
  // (egovernments/CCRS#721).
  //
  // CMS-BOUNDARY.HierarchySchema (fetched above) is the primary source for
  // both levels — it's the master an operator actually edits post-deploy —
  // with the ansible-templated globalConfigs value used only as a fallback
  // for tenants where that MDMS record hasn't been seeded yet.
  //
  // Neither source is trusted blindly: `findIndex` below returns -1 for a
  // configured level that doesn't exist in this tenant's hierarchy at all
  // (typo'd MDMS value, or a level declared for another tenant), in which
  // case the corresponding cap is silently skipped rather than collapsing
  // the whole cascade. Separately, a level that's only MISSING on some
  // branches (e.g. a handful of bairros with no Quarteirão child) is not
  // a findIndex concern at all — `lowestLevelCapped` only records whether
  // the cap was configured and matched in the hierarchy's type list; the
  // childless-node-is-leaf fallback below (keyed off it) is what actually
  // tolerates a specific branch running out of children before reaching
  // the configured lowest level.
  // `lowestLevelCapped` records whether PGR_BOUNDARY_LOWEST_LEVEL was BOTH
  // configured AND matched in this tree (the cap actually applied). The
  // childless-node-is-leaf fallback keys off it: only a deployment that
  // declared a lowest level treats a childless mid-tree node as fileable.
  // Unconfigured deployments keep strict deepest-level-only leaf semantics so a
  // County seeded without children can't become fileable (egovernments/CCRS#478).
  const { effectiveHierarchy, lowestLevelCapped } = useMemo(() => {
    const configuredHighest =
      hierarchySchema?.highestHierarchy || window?.globalConfigs?.getConfig?.("PGR_BOUNDARY_HIGHEST_LEVEL");
    const configuredLowest =
      hierarchySchema?.lowestHierarchy || window?.globalConfigs?.getConfig?.("PGR_BOUNDARY_LOWEST_LEVEL");

    const highestIdx = configuredHighest
      ? boundaryHierarchy.findIndex((k) => String(k).toLowerCase() === String(configuredHighest).toLowerCase())
      : -1;
    const startIdx = highestIdx >= 0 ? highestIdx : 0;

    if (!configuredLowest) {
      return { effectiveHierarchy: boundaryHierarchy.slice(startIdx), lowestLevelCapped: false };
    }
    const lowestIdx = boundaryHierarchy.findIndex(
      (k) => String(k).toLowerCase() === String(configuredLowest).toLowerCase()
    );
    return lowestIdx >= startIdx
      ? { effectiveHierarchy: boundaryHierarchy.slice(startIdx, lowestIdx + 1), lowestLevelCapped: true }
      : { effectiveHierarchy: boundaryHierarchy.slice(startIdx), lowestLevelCapped: false };
  }, [boundaryHierarchy, hierarchySchema]);

  // The chosen node at each level, keyed by boundary type.
  const [selectedValues, setSelectedValues] = useState({});
  // Track which levels were filled by the map auto-fill (vs manually
  // selected by the user). Only auto-filled levels should render as
  // disabled when locked (lockAutoFilled) — once the user changes a level
  // manually, that level (and any children that get reset) flips to
  // interactive so they can keep editing.
  const [autoFilledKeys, setAutoFilledKeys] = useState({});

  // Reset selection state on tenant change so the previous tenant's
  // selected County / Ward doesn't leak through to the new tenant's
  // boundary tree (different UUIDs, different shape).
  useEffect(() => {
    setSelectedValues({});
    setAutoFilledKeys({});
  }, [tenantId]);

  // A caller that clears the value while this stays mounted (the inbox
  // filter's Clear all resets the form) clears the picks behind it too, so
  // they can't come back on the next pick or keep the lists narrowed.
  const currentValue = formData?.[config?.key];
  const hadValue = useRef(false);
  useEffect(() => {
    const hasValue = currentValue != null && currentValue !== "";
    if (hadValue.current && !hasValue) {
      setSelectedValues({});
      setAutoFilledKeys({});
    }
    hadValue.current = hasValue;
  }, [currentValue]);

  // Every level shows from the start, so a ward can be picked (and searched)
  // before its county; a pick fills the levels above it from the tree
  // (utils/boundaryCascade).
  const tree = useMemo(() => childrenData?.[0]?.boundary || [], [childrenData]);
  const pathByCode = useMemo(() => pathsByCode(tree), [tree]);
  const optionsByLevel = useMemo(
    () => optionsForLevels(effectiveHierarchy, selectedValues, tree),
    [effectiveHierarchy, selectedValues, tree]
  );
  // A node's parent, named as the dropdowns name it, to tell apart two places
  // that share a name at one level.
  const parentLabelOf = useCallback(
    (node) => {
      const path = pathByCode.get(node.code);
      const parent = path && path[path.length - 2];
      if (!parent) return null;
      const translated = t(parent.code);
      return translated && translated !== parent.code ? translated : parent.name || parent.code;
    },
    [pathByCode, t]
  );

  // CCRS#491: auto-fill the cascade when the citizen drops a pin on the
  // map. `GeoLocations.fetchAddress` runs `resolveWard` (turf
  // point-in-polygon against the bundled Nairobi-wards GeoJSON) and
  // writes the matching ward into `formData.GeoLocationsPoint.ward`.
  // We watch that field and set the County / Sub-County / Ward
  // dropdowns to the matching tree path, then call onSelect with the
  // deepest node so `formData.SelectedBoundary` is the ward — which is
  // what the submit pipeline reads (utils/index.js).
  //
  // Lenient match: the GeoJSON ships ward codes like `KILIMANI` while
  // the live boundary tree uses `NAIROBI_CITY_KILIMANI`. We accept
  // either, plus a name-based fallback (`Kangemi` ≈ `KANGEMI`). If no
  // match (pin outside any seeded ward, or GeoJSON / boundary-tree
  // drift) we silently leave the cascade alone — the user can still
  // pick manually.
  const wardHintCode = formData?.GeoLocationsPoint?.ward?.code;
  const wardHintName = formData?.GeoLocationsPoint?.ward?.name;
  // The hint key this mount has already handled. Guards two replays:
  // (1) a session-restored draft replays the OLD pin's hint on remount — if
  //     the draft also carries a SelectedBoundary (possibly a manual
  //     correction of that very hint), the saved boundary is the user's final
  //     intent and wins; only a hint CHANGE (fresh pin drop) re-derives;
  // (2) childrenData is recreated when the HRMS jurisdiction filter settles —
  //     without the key guard that re-ran the effect and re-applied the same
  //     hint over a manual correction mid-session.
  const processedHintRef = React.useRef(null);
  const lockAutoFilled = locksAutoFilled(readOnly, formData?.GeoLocationsPoint);
  useEffect(() => {
    if (!wardHintCode && !wardHintName) return;
    if (!childrenData || childrenData.length === 0) return;
    const hintKey = (wardHintCode || "") + "|" + (wardHintName || "");
    if (processedHintRef.current === hintKey) return;
    if (processedHintRef.current === null && formData?.SelectedBoundary?.code) {
      // First hint of this mount with a saved boundary — the draft wins.
      processedHintRef.current = hintKey;
      return;
    }
    // boundaryHierarchyOrder may not be seeded yet (usePGRInitialization
    // still in flight / city just switched). Without it the deepest-level
    // targetType is undefined and findWardPath would match the hint at
    // ANY level. The `boundaryHierarchy` memo is keyed only on tenantId,
    // so if this component mounted before init seeded SessionStorage the
    // memo caches [] for the tenant's lifetime — re-read the session
    // value directly as a fallback so auto-fill recovers once init
    // lands. Skip only when BOTH are empty; the effect re-runs when
    // childrenData settles.
    // Match the hint at the level the cascade actually files at — the CAPPED
    // hierarchy. Using the raw tree depth here made the map and the cascade
    // disagree whenever PGR_BOUNDARY_LOWEST_LEVEL sits above the deepest seeded
    // level: the map resolved a pin to the deeper level, findWardPath looked for
    // a node of that deeper type, and on a tenant that seeds it only patchily the
    // lookup found nothing and auto-fill silently no-opped.
    let hierarchy = effectiveHierarchy;
    if (hierarchy.length === 0) {
      const order = Digit.SessionStorage.get("boundaryHierarchyOrder");
      hierarchy = Array.isArray(order) ? order.map((item) => item.code) : [];
      const configuredLowest = window?.globalConfigs?.getConfig?.("PGR_BOUNDARY_LOWEST_LEVEL");
      const idx = configuredLowest ? hierarchy.findIndex((k) => sameLevelName(k, configuredLowest)) : -1;
      if (idx >= 0) hierarchy = hierarchy.slice(0, idx + 1);
    }
    if (hierarchy.length === 0) return;
    const targetType = hierarchy[hierarchy.length - 1];
    const path = findWardPath(childrenData[0]?.boundary, wardHintCode, wardHintName, targetType);
    if (!path || path.length === 0) return;

    // Rebuild the selection in one go; each level's options follow from it.
    // Only the levels this form shows, as a manual pick keeps them: a tree
    // root above the configured highest level stays out of the address.
    const shownPath = path.filter((node, i) => i === path.length - 1 || hierarchy.includes(node.boundaryType));
    const newSelectedValues = {};
    const newAutoFilled = {};
    for (const node of shownPath) {
      newSelectedValues[node.boundaryType] = node;
      newAutoFilled[node.boundaryType] = true;
    }
    setSelectedValues(newSelectedValues);
    setAutoFilledKeys(newAutoFilled);

    // The deepest hit (typically Ward) is what SelectedBoundary should
    // hold — that's the leaf the routing payload uses. Tag with
    // `isLeaf` so validators don't have to trust `.children` being
    // preserved on the picked node (closes egovernments/CCRS#478 —
    // locality validation was firing only when children happened to
    // be attached, so County-level selections silently passed).
    const deepest = path[path.length - 1];
    // Leaf detection uses the EFFECTIVE (capped) hierarchy deepest level
    // (develop) so a map-pin that auto-fills only to the configured lowest
    // level is still tagged a leaf; AND a childless node counts as a leaf
    // unconditionally (moz — prod Tete→Tsangano branches end above the
    // declared depth). Safe vs CCRS#478: `deepest` is the live tree node.
    const lastLevel = effectiveHierarchy[effectiveHierarchy.length - 1];
    const isDeepestLevel =
      deepest?.boundaryType === lastLevel ||
      !(Array.isArray(deepest?.children) && deepest.children.length > 0);
    processedHintRef.current = hintKey;
    onSelect(
      config.key,
      { ...deepest, isLeaf: isDeepestLevel, levels: levelsOf(shownPath) },
      { shouldValidate: true, shouldDirty: true, shouldTouch: true }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wardHintCode, wardHintName, childrenData]);

  // Draft-restore repaint: a session-restored form holds a valid
  // SelectedBoundary while selectedValues (private state) starts empty, so the
  // cascade rendered blank after a refresh even though the value was set.
  // While the picker is untouched, rebuild the visible chain by locating the
  // saved node in the tree. Runs regardless of any ward hint — the hint effect
  // above yields its mount round to the saved boundary (which may be a manual
  // correction of that very hint, and repaints anyway when they agree). No
  // onSelect emit — the value is already in the form.
  const savedBoundaryCode = formData?.SelectedBoundary?.code;
  useEffect(() => {
    if (!savedBoundaryCode) return;
    if (Object.keys(selectedValues).length > 0) return;
    const path = pathByCode.get(savedBoundaryCode);
    if (!path || path.length === 0) return;
    // Each level's options follow from the selection (optionsForLevels), so a
    // mid-cascade draft (a NON-leaf node) lists its own children next.
    setSelectedValues(
      selectionAfterPick(path[path.length - 1], { shownLevels: effectiveHierarchy, paths: pathByCode })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedBoundaryCode, pathByCode]);

  /**
   * A pick at any level. The picked node's own path fills the levels above it;
   * a lower selection is kept only while it still sits under the new pick.
   */
  const handleSelection = (selectedBoundary) => {
    if (!selectedBoundary) return;

    const boundaryType = selectedBoundary.boundaryType;
    const newSelectedValues = selectionAfterPick(selectedBoundary, {
      shownLevels: effectiveHierarchy,
      paths: pathByCode,
    });

    // A level the user touched, or whose value the pick changed, is no longer
    // "auto-filled" by the map, so it flips from read-only back to interactive.
    const newAutoFilled = {};
    for (const type of Object.keys(autoFilledKeys)) {
      const unchanged = newSelectedValues[type] && newSelectedValues[type].code === selectedValues[type]?.code;
      if (type !== boundaryType && unchanged) newAutoFilled[type] = true;
    }

    setSelectedValues(newSelectedValues);
    setAutoFilledKeys(newAutoFilled);

    // The option is chosen inside a menu, which the click tracking can't see.
    trackEvent("pgr.boundary.selected", {
      category: "pgr",
      label: boundaryType,
      value: levelsFilledAbove(selectedBoundary, selectedValues, newSelectedValues, boundaryHierarchy),
    });

    // Send the deepest chosen boundary, tagged with `isLeaf` so validators can
    // trust hierarchy depth instead of the `.children` array (which isn't
    // reliably preserved on the picked node and let County-level selections
    // pass — egovernments/CCRS#478).
    // Leaf when it is the configured deepest level OR the node has no
    // children. The childless case is UNCONDITIONAL (moz): a branch ending
    // above the declared depth — prod Tete→Tsangano has no Municípios — must
    // still be fileable. Safe vs CCRS#478 because `deepest` is the live tree
    // node (children intact); downstream form-state copies drop .children but
    // never reach this emit.
    const chosen = boundaryHierarchy.map((type) => newSelectedValues[type]).filter(Boolean);
    const deepest = chosen[chosen.length - 1];
    const lastLevel = effectiveHierarchy[effectiveHierarchy.length - 1];
    const nodeHasChildren = deepest.children && deepest.children.length > 0;
    const isDeepestLevel = deepest.boundaryType === lastLevel || !nodeHasChildren;
    // onSelect is RHF's setValue (FieldV1 wires component onSelect -> setValue).
    // Pass shouldValidate so the `required` rule re-runs and formState.isValid
    // (which gates the disabled NEXT/SubmitBar) flips true on selection.
    onSelect(
      config.key,
      { ...deepest, isLeaf: isDeepestLevel, levels: levelsOf(chosen) },
      { shouldValidate: true, shouldDirty: true, shouldTouch: true }
    );
  };

  /**
   * Check if a boundary type is allowed to be selected.
   */

  if (isBoundaryLoading) {
    return <Loader />;
  }

  return (
    <div className="pgr-boundary-cascade" style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
        {effectiveHierarchy.map((key) => {
          // Every level shows from the start (see optionsByLevel). A level
          // too long to list whole (null) waits, disabled, for the level
          // above; one with nothing under the current choice stays hidden.
          const waiting = optionsByLevel[key] === null;
          if (waiting || optionsByLevel[key]?.length > 0) {
            const selectedAtLevel =
              formData?.locality || formData?.SelectedBoundary ? selectedValues[key] : null;
            // Localized level header, with a humanized fallback when no key
            // is seeded — react-i18next otherwise echoes the raw key (e.g.
            // "ADMIN_MUNICÍPIO") into the UI. Onboarding seeds several key
            // shapes (accents KEPT): "divisao_administrativa_PROVÍNCIA",
            // "DIVISAO_ADMINISTRATIVA_PROVÍNCIA",
            // "divisao_administrativa_Província" — try each.
            const levelKeys = [
              `${hierarchyType}_${key?.toUpperCase()}`,
              `${String(hierarchyType).toUpperCase()}_${key?.toUpperCase()}`,
              `${hierarchyType}_${key}`,
            ];
            const levelKey = levelKeys.find((c) => {
              const l = t(c);
              return l && l !== c;
            });
            const levelLabel = levelKey ? t(levelKey) : humanizeBoundaryType(key);
            return (
              <BoundaryDropdown
                key={key}
                fieldKey={key}
                label={levelLabel}
                data={optionsByLevel[key] || []}
                waitingForParent={waiting}
                parentLabelOf={parentLabelOf}
                // Marked required on a form that needs the address; a filter
                // (the inbox's, `isMandatory: false`) leaves every level optional.
                required={config?.isMandatory !== false}
                onChange={(selectedValue) => handleSelection(selectedValue)}
                selected={selectedAtLevel}
                // Read-only when (a) the pin's ward locks it (lockAutoFilled), AND
                // (b) this level was filled by the map auto-fill —
                // NOT just by any value present. If the user
                // manually picks something at this level (e.g.
                // because the auto-fill missed it), the flag is
                // cleared in handleSelection so the field flips back
                // to interactive — they can keep refining without
                // getting locked out by their own click.
                disabled={waiting || (lockAutoFilled && !!autoFilledKeys[key] && !!selectedAtLevel)}
              />
            );
          }
          return null;
        })}
    </div>
  );
};

/**
 * BoundaryDropdown — uses the v2 Select so the boundary cascade matches
 * the rest of the modernized form chrome (theme placeholder color,
 * yellow-tint hover, no list-bullet padding). The boundary objects
 * carry through onChange unchanged so the parent's cascade logic /
 * SelectedBoundary payload stays byte-identical to the legacy.
 */
const BoundaryDropdown = ({ label, data, onChange, selected, fieldKey, disabled, parentLabelOf, waitingForParent, required }) => {
  const { t } = useTranslation();
  const id = `boundary-${(fieldKey || label || "field").toString().toLowerCase().replace(/\s+/g, "-")}`;
  // Defensive dedup by code. The jurisdiction prune (filterTree above)
  // is duplicate-safe by construction, but in the field the dropdown
  // has been observed listing the same ward twice (see
  // egovernments/CCRS#496 screen recording — upstream data shape under
  // overlapping HRMS jurisdictions, exact origin still being chased).
  // Dedup at render keeps the symptom contained regardless of where
  // the duplicate enters `data`.
  // Built once per list, not per render: a level can list hundreds of places.
  const labelled = useMemo(() => {
    const options = [];
    const seen = new Set();
    for (const node of data || []) {
      if (seen.has(node.code)) continue;
      seen.add(node.code);
      // Localization-first: t(code) is the convention (configurator Phase 2
      // writes the human name as the message for the code key). Fall back
      // to a raw `name` only when no translation exists.
      const translated = t(node.code);
      options.push({
        value: node.code,
        label: translated && translated !== node.code ? translated : node.name || node.code,
        node,
      });
    }
    return disambiguateLabels(options, parentLabelOf || (() => null));
  }, [data, t, parentLabelOf]);
  return (
    <V2Field label={t(label)} required={required} htmlFor={id}>
      <V2Select
        id={id}
        value={selected?.code}
        onValueChange={(code) => {
          const picked = data.find((n) => n.code === code);
          if (picked) onChange(picked);
        }}
        options={labelled}
        // Filing's boundary levels search at any length, as the complaint type
        // levels do (CCRS#941): a ward is typed, not scanned for, and a short
        // list on one tenant is a long one on the next.
        searchable
        searchPlaceholder={t("CS_COMMON_SEARCH") === "CS_COMMON_SEARCH" ? "Search" : t("CS_COMMON_SEARCH")}
        // A tenant that seeds CS_COMMON_SELECT still gets its own text; otherwise
        // the verb is translated too, not just the field name.
        placeholder={
          waitingForParent
            ? translateOr(t, "CS_COMPLAINT_PICK_PARENT_FIRST", "Select the level above first")
            : t("CS_COMMON_SELECT") === "CS_COMMON_SELECT"
            ? selectPlaceholder(t, t(label))
            : t("CS_COMMON_SELECT")
        }
        disabled={!!disabled}
      />
    </V2Field>
  );
};

/**
 * The chosen node at each level, root to leaf, as `{ code, name, boundaryType }`.
 * Handed up with the selection so a caller can name the whole address (a
 * review screen showing "Ward, Sub County, County") without another lookup;
 * the complaint payload still reads only the leaf's `code`.
 */
function levelsOf(nodes) {
  return (nodes || []).map((node) => ({ code: node.code, name: node.name, boundaryType: node.boundaryType }));
}

/**
 * Walk the boundary tree and return the path (root → … → ward) whose
 * leaf matches the GeoJSON-resolved hint. Returns null if nothing
 * matches.
 *
 * Match strategy (in priority order, all case-insensitive):
 *   1. Exact code match.
 *   2. Suffix code match — boundary tree codes are typically prefixed
 *      with the tenant (`NAIROBI_CITY_KANGEMI`) while the GeoJSON
 *      ships bare codes (`KANGEMI`). Accepting `code.endsWith('_' +
 *      hint)` covers the common case.
 *   3. Name match against the hint name normalized to UPPER_SNAKE.
 *      Handles future GeoJSON versions that ship display names but no
 *      code field.
 *
 * Only matches nodes whose boundary type matches the deepest level 
 * (targetType). Sub-county / county hints aren't useful here because 
 * the GeoJSON gives us the leaf ward; the parents are derived by 
 * walking up the path.
 */
function findWardPath(roots, hintCode, hintName, targetType) {
  const normCode = String(hintCode || '').toUpperCase();
  const normName = String(hintName || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!normCode && !normName) return null;
  const isMatch = (node) => {
    if (targetType && node.boundaryType !== targetType) return false;
    const code = String(node.code || '').toUpperCase();
    const nodeName = String(node.name || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (normCode && (code === normCode || code.endsWith('_' + normCode))) return true;
    if (normName && (code === normName || code.endsWith('_' + normName))) return true;
    if (normName && (nodeName === normName || nodeName.endsWith('_' + normName))) return true;
    return false;
  };
  const walk = (node, trail) => {
    const next = [...trail, node];
    if (isMatch(node)) return next;
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        const found = walk(child, next);
        if (found) return found;
      }
    }
    return null;
  };
  for (const root of roots || []) {
    const found = walk(root, []);
    if (found) return found;
  }
  return null;
}

export default BoundaryComponent;