const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const esbuild = require("esbuild");

// The column shape UAT's catalog uses for ep_table_employee_performance: an
// officer column resolves a uuid to an HRMS name, or falls back to an opaque id.
const ENTRY = `
import React from "react";
import ReactDOMServer from "react-dom/server";
import DashboardTable from "./DashboardTable.jsx";
import { formatOfficerLabel } from "../config/kpiDisplay";

const columns = [
  { id: "current_assignee_uuid", type: "officer", label: "Officer" },
  { id: "total", type: "integer", label: "Total" },
];

const rows = [{ current_assignee_uuid: "df53154a-0000-4000-8000-5c2d0caf3357", total: 7 }];

export const renderOfficerTable = (officerNames) =>
  ReactDOMServer.renderToStaticMarkup(
    React.createElement(DashboardTable, { columns, rows, officerNames })
  );

export { formatOfficerLabel };
`;

function bundleEntry() {
  const out = path.join(os.tmpdir(), `dashboard-table-officer.${process.pid}.cjs.js`);
  esbuild.buildSync({
    stdin: {
      contents: ENTRY,
      resolveDir: __dirname,
      loader: "jsx",
      sourcefile: "dashboard-table-officer-entry.jsx",
    },
    bundle: true,
    format: "cjs",
    platform: "node",
    loader: { ".jsx": "jsx", ".js": "jsx" },
    outfile: out,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"test"' },
  });
  process.on("exit", () => {
    try {
      fs.unlinkSync(out);
    } catch (e) {
      /* already gone */
    }
  });
  return out;
}

const bundledEntry = bundleEntry();

function load() {
  delete require.cache[bundledEntry];
  global.window = {
    i18next: {
      language: "en_IN",
      exists: () => false,
      t: (key, fallback) => fallback ?? key,
      on() {},
      off() {},
      store: { on() {}, off() {} },
    },
    localStorage: { getItem: () => "en_IN" },
  };
  try {
    return require(bundledEntry);
  } finally {
    delete global.window;
  }
}

test("an officer column shows the HRMS name when the uuid is resolved", () => {
  const { renderOfficerTable } = load();
  const html = renderOfficerTable({ "df53154a-0000-4000-8000-5c2d0caf3357": "MISAU Supervisor 1" });
  assert.match(html, /MISAU Supervisor 1/);
});

test("an unresolved uuid falls back to an opaque short id, never a fabricated name", () => {
  const { renderOfficerTable } = load();
  const html = renderOfficerTable({});
  assert.match(html, /Officer 3357/);
  assert.doesNotMatch(html, /Mwangi|Kamau|Otieno|Aisha|John/);
});

test("formatOfficerLabel: resolved / unresolved / blank", () => {
  const { formatOfficerLabel } = load();
  assert.equal(formatOfficerLabel("abcd-1234", { "abcd-1234": "Jane Doe" }), "Jane Doe");
  assert.equal(formatOfficerLabel("abcd-1234", {}), "Officer 1234");
  assert.equal(formatOfficerLabel("abcd-1234", undefined), "Officer 1234");
  assert.equal(formatOfficerLabel("", {}), "Unassigned");
  assert.equal(formatOfficerLabel("Unknown", {}), "Unassigned");
});
