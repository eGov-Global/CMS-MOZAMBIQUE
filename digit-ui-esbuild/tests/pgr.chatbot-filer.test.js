// Issue #214 — the timeline's APPLY row shows the complainant instead of the
// chatbot's service account, and only for a chatbot filing: an employee who
// registered a complaint on a citizen's behalf stays on the row.
// Run from digit-ui-esbuild/:  node --test tests/pgr.chatbot-filer.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const esbuild = require("esbuild");

const ENTRY = path.join(__dirname, "../products/pgr/src/utils/chatbotFiler.js");
const OUT = path.join(os.tmpdir(), `chatbotFiler.cjs.${process.pid}.js`);
esbuild.buildSync({ entryPoints: [ENTRY], bundle: true, format: "cjs", platform: "neutral", outfile: OUT });
process.on("exit", () => {
  try {
    fs.unlinkSync(OUT);
  } catch {
    // Best effort; the temp file is process-scoped.
  }
});
const { chatbotFiler, CHATBOT_SOURCE } = require(OUT);

const COMPLAINANT_UUID = "citizen-uuid";
const complainant = { uuid: COMPLAINANT_UUID, name: "Ana Macuácua", mobileNumber: "841234567" };
const isComplainant = (person) => person?.uuid === COMPLAINANT_UUID;
const context = (overrides = {}) => ({
  complaintSource: CHATBOT_SOURCE,
  complainant,
  complainantUuid: COMPLAINANT_UUID,
  isComplainant,
  citizenLabel: "Cidadão",
  ...overrides,
});

const apply = (assigner) => ({ action: "APPLY", assigner });
const bot = { uuid: "chatbot-uuid", name: "CHATBOT" };
const clerk = { uuid: "reception-uuid", name: "Clerk" };

test("the chatbot marks what it files as whatsapp", () => {
  assert.equal(CHATBOT_SOURCE, "whatsapp");
});

test("a chatbot filing shows the complainant, not the bot account", () => {
  assert.deepEqual(chatbotFiler(apply(bot), context()), { ...complainant, uuid: COMPLAINANT_UUID });
});

test("a redacted complainant name falls back to the citizen label", () => {
  const filer = chatbotFiler(apply(bot), context({ complainant: { mobileNumber: "*****4567" } }));
  assert.deepEqual(filer, { mobileNumber: "*****4567", name: "Cidadão", uuid: COMPLAINANT_UUID });
});

test("an employee filing on a citizen's behalf keeps the clerk on the row", () => {
  for (const source of ["inperson", "email", "letter", "linhaverde", "web", null, undefined]) {
    assert.equal(chatbotFiler(apply(clerk), context({ complaintSource: source })), null, String(source));
  }
});

test("only the APPLY row is substituted", () => {
  for (const action of ["ASSIGN", "COMMENT", "RESOLVE", "REOPEN"]) {
    assert.equal(chatbotFiler({ action, assigner: bot }, context()), null, action);
  }
});

test("an APPLY already showing the complainant is left alone", () => {
  assert.equal(chatbotFiler(apply({ uuid: COMPLAINANT_UUID, name: "Ana" }), context()), null);
});

test("an APPLY with no recorded actor, or no known complainant, is left alone", () => {
  assert.equal(chatbotFiler(apply(null), context()), null);
  assert.equal(chatbotFiler(apply({ name: "no uuid" }), context()), null);
  assert.equal(chatbotFiler(apply(bot), context({ complainantUuid: null })), null);
});
