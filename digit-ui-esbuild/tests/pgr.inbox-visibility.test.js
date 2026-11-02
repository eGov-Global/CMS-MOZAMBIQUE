// Issue #209 — the server-side inbox decides "creator role" from
// InboxVisibilityConfig.creatorRoles (as pgr-services does), and a creator's
// My tab opens newest first instead of on the oldest, mostly closed filings.
// Run from digit-ui-esbuild/:  node --test tests/pgr.inbox-visibility.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const esbuild = require("esbuild");

const ENTRY = path.join(__dirname, "../products/pgr/src/utils/inboxVisibility.js");
const OUT = path.join(os.tmpdir(), `inboxVisibility.cjs.${process.pid}.js`);
esbuild.buildSync({ entryPoints: [ENTRY], bundle: true, format: "cjs", platform: "neutral", outfile: OUT });
process.on("exit", () => {
  try {
    fs.unlinkSync(OUT);
  } catch {
    // Best effort; the temp file is process-scoped.
  }
});
const { holdsCreatorRole, inboxDefaultSort, inboxSort } = require(OUT);

const roles = (...codes) => codes.map((code) => ({ code, tenantId: "mz" }));

test("a user holding a listed role is a creator", () => {
  assert.equal(holdsCreatorRole(roles("EMPLOYEE", "CMS_RECEPTION_OFFICER"), ["CMS_RECEPTION_OFFICER"]), true);
});

test("a user holding none of the listed roles is not", () => {
  assert.equal(holdsCreatorRole(roles("EMPLOYEE", "CMS_CASE_MANAGER"), ["CMS_RECEPTION_OFFICER"]), false);
});

test("no creator roles in the MDMS record means nobody is a creator", () => {
  const reception = roles("CMS_RECEPTION_OFFICER");
  assert.equal(holdsCreatorRole(reception, undefined), false);
  assert.equal(holdsCreatorRole(reception, []), false);
  assert.equal(holdsCreatorRole(reception, "CMS_RECEPTION_OFFICER"), false);
  assert.equal(holdsCreatorRole(undefined, ["CMS_RECEPTION_OFFICER"]), false);
});

test("codes compare trimmed and upper-cased, whatever the role's tenant", () => {
  assert.equal(holdsCreatorRole([{ code: " cms_reception_officer ", tenantId: "mz.maputo" }], ["CMS_RECEPTION_OFFICER"]), true);
  assert.equal(holdsCreatorRole(roles("CMS_RECEPTION_OFFICER"), ["  cms_reception_officer"]), true);
});

test("malformed entries on either side match nothing", () => {
  assert.equal(holdsCreatorRole([null, {}, { code: "" }], ["", null, "  "]), false);
  assert.equal(holdsCreatorRole([null, { code: "CMS_RECEPTION_OFFICER" }], [null, "CMS_RECEPTION_OFFICER"]), true);
});

// The order every other inbox sent before this change.
const previousSort = (tableForm) => ({
  sortBy: tableForm?.sortBy || "sla",
  sortOrder: (tableForm?.sortOrder || "ASC").toUpperCase(),
});

const TABLE_FORMS = [
  undefined,
  {},
  { limit: 10, offset: 0 },
  { limit: 10, offset: 0, sortOrder: "asc" },
  { sortBy: "serviceRequestId", sortOrder: "desc" },
  { sortBy: "locality", sortOrder: "ASC" },
  { sortBy: "sla" },
];

test("outside a creator's My tab the order is exactly what it was", () => {
  for (const tableForm of TABLE_FORMS) {
    assert.deepEqual(inboxSort(tableForm), previousSort(tableForm), JSON.stringify(tableForm));
    assert.deepEqual(inboxSort(tableForm, false), previousSort(tableForm), JSON.stringify(tableForm));
  }
});

test("a creator's My tab opens newest first", () => {
  assert.deepEqual(inboxSort(undefined, true), { sortBy: "createdTime", sortOrder: "DESC" });
  assert.deepEqual(inboxSort({ limit: 10, offset: 0 }, true), { sortBy: "createdTime", sortOrder: "DESC" });
});

test("a search, filter or clear does not flip a creator's My tab to oldest first", () => {
  // The search card writes this lowercase order, with no column, on every submit.
  assert.deepEqual(inboxSort({ limit: 10, offset: 0, sortOrder: "asc" }, true), { sortBy: "createdTime", sortOrder: "DESC" });
});

test("a column the creator picks still applies", () => {
  assert.deepEqual(inboxSort({ sortBy: "sla", sortOrder: "ASC" }, true), { sortBy: "sla", sortOrder: "ASC" });
  assert.deepEqual(inboxSort({ sortBy: "serviceRequestId", sortOrder: "desc" }, true), { sortBy: "serviceRequestId", sortOrder: "DESC" });
});

test("the table's default sort indicator matches what the inbox sends", () => {
  assert.deepEqual(inboxDefaultSort(true), inboxSort({}, true));
  assert.deepEqual(inboxDefaultSort(false), inboxSort({}, false));
  assert.deepEqual(inboxDefaultSort(), { sortBy: "sla", sortOrder: "ASC" });
});
