const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const esbuild = require("esbuild");

// The four catalog tables whose columns carry a literal English `label` and no
// labelKey. They rendered "Ward" / "Created" / "% of complaints" on a
// Portuguese dashboard, and no operator could change them without editing MDMS.
const ENTRY = `
import React from "react";
import ReactDOMServer from "react-dom/server";
import DashboardTable from "./DashboardTable.jsx";
import { columnLabelKey, COLUMN_LABEL_KEYS } from "../config/kpiDisplay";

const columns = [
  { id: "zone_code", type: "dimension", label: "Ward" },
  { id: "created", type: "integer", label: "Created" },
  { id: "share_pct", type: "percent", label: "% of complaints" },
  { id: "trendPct", type: "trend", label: "Trend" },
];

export const renderHeaders = () =>
  ReactDOMServer.renderToStaticMarkup(
    React.createElement(DashboardTable, { columns, rows: [] })
  );

export { columnLabelKey, COLUMN_LABEL_KEYS };
`;

function bundleEntry() {
  const out = path.join(os.tmpdir(), `dashboard-table-headers.${process.pid}.cjs.js`);
  esbuild.buildSync({
    stdin: { contents: ENTRY, resolveDir: __dirname, loader: "jsx", sourcefile: "headers-entry.jsx" },
    bundle: true,
    format: "cjs",
    platform: "node",
    loader: { ".jsx": "jsx", ".js": "jsx" },
    outfile: out,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"test"' },
  });
  process.on("exit", () => { try { fs.unlinkSync(out); } catch (e) { /* already gone */ } });
  return out;
}

const bundledEntry = bundleEntry();

/** Loads the bundle with a translator that resolves `dict`, like a seeded tenant. */
function load(dict = {}) {
  delete require.cache[bundledEntry];
  global.window = {
    i18next: {
      language: "pt_PT",
      exists: (key) => key in dict,
      t: (key, fallback) => (key in dict ? dict[key] : fallback ?? key),
      on() {}, off() {},
      store: { on() {}, off() {} },
    },
  };
  return require(bundledEntry);
}

const PT = {
  DASHBOARD_COL_DISTRICT: "Distrito",
  DASHBOARD_COL_CREATED: "Criadas",
  DASHBOARD_COL_SHARE_PCT: "% das manifestações",
  DASHBOARD_COL_TREND: "Tendência",
};

test("a column with no labelKey resolves one from its id", () => {
  const { columnLabelKey } = load();
  assert.equal(columnLabelKey({ id: "zone_code", label: "Ward" }), "DASHBOARD_COL_DISTRICT");
  assert.equal(columnLabelKey({ id: "trendPct", label: "Trend" }), "DASHBOARD_COL_TREND");
});

test("an explicit labelKey still wins, so a tenant can override", () => {
  const { columnLabelKey } = load();
  assert.equal(
    columnLabelKey({ id: "zone_code", label: "Ward", labelKey: "TENANT_CUSTOM_ZONE" }),
    "TENANT_CUSTOM_ZONE"
  );
});

test("an unmapped column falls back to its literal label", () => {
  const { columnLabelKey } = load();
  assert.equal(columnLabelKey({ id: "some_new_measure", label: "Whatever" }), null);
});

test("seeded headers render translated, not the English literal", () => {
  const { renderHeaders } = load(PT);
  const html = renderHeaders();

  for (const word of Object.values(PT)) {
    assert.ok(html.includes(word), `header shows ${word}`);
  }
  for (const literal of ["Ward", "Created", "% of complaints", "Trend"]) {
    assert.ok(!html.includes(`>${literal}<`), `no bare English "${literal}"`);
  }
});

test("an unseeded tenant still gets the English label, never a raw code", () => {
  // translate() renders the RAW KEY when a message is missing, so falling back
  // to the literal matters — otherwise the header reads DASHBOARD_COL_DISTRICT.
  const { renderHeaders } = load({});
  const html = renderHeaders();

  assert.ok(html.includes("Ward"), "falls back to the catalog's literal");
  assert.ok(!html.includes("DASHBOARD_COL_"), "never paints a raw code");
});

test("every mapped code is one the l10n packs actually ship", () => {
  // A typo here is invisible at runtime: the code just fails to resolve and the
  // English literal shows, which is exactly the bug this is meant to fix.
  const { COLUMN_LABEL_KEYS } = load();
  const packDir = path.resolve(__dirname, "../../../../../local-setup/db/dss-mdms-seed/l10n");
  const codes = (locale) =>
    new Set(JSON.parse(fs.readFileSync(path.join(packDir, `${locale}.json`), "utf-8")).map((r) => r.code));
  const en = codes("en_IN");
  const pt = codes("pt_PT");

  const missing = Object.entries(COLUMN_LABEL_KEYS)
    .filter(([, code]) => !en.has(code) || !pt.has(code))
    .map(([col, code]) => `${col} -> ${code}`);

  assert.deepEqual(missing, [], `unseeded codes: ${missing.join(", ")}`);
});
