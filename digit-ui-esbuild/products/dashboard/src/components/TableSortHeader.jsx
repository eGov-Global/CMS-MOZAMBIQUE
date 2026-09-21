import React from "react";
import useDashboardT from "../i18n/useDashboardT";
import { seriesEntryLabel } from "../i18n/textResolver";
import { columnLabelKey } from "../config/kpiDisplay";

const TableSortHeader = ({ column, sortState, onSort }) => {
  const { t } = useDashboardT();
  const active = sortState.key === column.id;
  const nextDirection =
    active && sortState.direction === "asc"
      ? t("DASHBOARD_TABLE_SORT_DESCENDING", "descending")
      : t("DASHBOARD_TABLE_SORT_ASCENDING", "ascending");
  // An explicit labelKey wins; otherwise the column's id resolves one. Catalog
  // columns carry a literal English label and no key, so they never translated.
  const label = seriesEntryLabel({ labelKey: columnLabelKey(column) }, column.label);

  return (
    <button
      type="button"
      className="dashboard-table-sort-btn"
      onClick={() => onSort(column.id)}
      aria-label={`${t("DASHBOARD_TABLE_SORT_BY", "Sort by")} ${label} ${nextDirection}`}
    >
      <span className="dashboard-table-sort-label">{label}</span>
      <span className="dashboard-table-sort-indicator" aria-hidden>
        {active ? (sortState.direction === "asc" ? "↑" : "↓") : "↕"}
      </span>
    </button>
  );
};

export default TableSortHeader;
