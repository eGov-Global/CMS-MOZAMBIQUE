const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const p = (rel) => path.join(projectRoot, rel);

function stub(rel, exports) {
  const filename = p(rel);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

function envWith(vars) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  delete require.cache[p("src/env-variables.js")];
  try {
    return require(p("src/env-variables.js"));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[p("src/env-variables.js")];
  }
}

// -- TWILIO_LIST_PICKERS ------------------------------------------------------

test("TWILIO_LIST_PICKERS maps option counts to SIDs", () => {
  const { twilio } = envWith({ TWILIO_LIST_PICKERS: "2:HXtwo, 3 : HXthree ,10:HXten" });
  assert.deepEqual(twilio.listPickers, { 2: "HXtwo", 3: "HXthree", 10: "HXten" });
  assert.deepEqual(twilio.listPickerProblems, []);
});

test("empty, as compose and Ansible pass it when unset, it maps nothing and keeps the defaults", () => {
  const { twilio } = envWith({ TWILIO_LIST_PICKERS: "", TWILIO_TEMPLATES_ENABLED: "", TWILIO_TEMPLATE_LOCALE: "", TWILIO_TEMPLATE_MENU: "" });
  assert.deepEqual(twilio.listPickers, {});
  assert.deepEqual(twilio.listPickerProblems, []);
  assert.equal(twilio.templatesEnabled, true, "the switch defaults on; nothing is sent without a SID");
  assert.equal(twilio.templateLocale, "pt_PT");
  assert.equal(twilio.templates.menu, "");
});

test("entries it cannot read are dropped and reported, never guessed at", () => {
  const { twilio } = envWith({ TWILIO_LIST_PICKERS: "2:HXtwo,02:HXzero,abc,4:,:HXnone,5:HX5:extra,two:HXword," });
  assert.deepEqual(twilio.listPickers, { 2: "HXtwo" }, "'02' would never match a list of 2");
  assert.equal(twilio.listPickerProblems.length, 6);
  for (const entry of ["02:HXzero", "abc", "4:", ":HXnone", "5:HX5:extra", "two:HXword"]) {
    assert.ok(twilio.listPickerProblems.some((problem) => problem.includes(`"${entry}"`)), entry);
  }
});

test("a count listed twice keeps the last SID and says so", () => {
  const { twilio } = envWith({ TWILIO_LIST_PICKERS: "2:HXfirst,2:HXsecond" });
  assert.deepEqual(twilio.listPickers, { 2: "HXsecond" });
  assert.match(twilio.listPickerProblems.join("\n"), /lists 2 options more than once/);
});

// -- startup warnings -----------------------------------------------------------

function warningsWith(twilio) {
  stub("src/env-variables.js", {
    whatsAppProvider: "Twilio",
    repoProvider: "Postgres",
    twilio: { verifyWebhookSignature: true, ...twilio },
  });
  delete require.cache[p("src/startup-checks.js")];
  return require(p("src/startup-checks.js")).warnings();
}

test("a deployment without templates, or with well-formed ones, starts without template warnings", () => {
  assert.deepEqual(warningsWith({}), []);
  assert.deepEqual(warningsWith({
    templates: { menu: "HXmenu", consent: "", confidentiality: "", confirmSubmission: "HXconfirm" },
    listPickers: { 2: "HXtwo", 10: "HXten" },
    listPickerProblems: [],
  }), []);
});

test("unreadable entries, unusable counts and SIDs that are not Content SIDs are warned about at startup", () => {
  const found = warningsWith({
    templates: { menu: "SM123", confirmSubmission: "HXconfirm" },
    listPickers: { 1: "HXone", 4: "MG4", 11: "HXeleven" },
    listPickerProblems: ['TWILIO_LIST_PICKERS entry "02:HXzero" is ignored'],
  }).join("\n");

  assert.match(found, /"02:HXzero" is ignored/);
  assert.match(found, /TWILIO_TEMPLATE_MENU is not a Content SID/);
  assert.doesNotMatch(found, /TWILIO_TEMPLATE_CONFIRM_SUBMISSION/);
  assert.match(found, /SID for 1 options; a list holds 2 to 10/);
  assert.match(found, /SID for 11 options; a list holds 2 to 10/);
  assert.match(found, /SID for 4 options is not a Content SID/);
});

test("other providers never send templates, so they are not warned about", () => {
  stub("src/env-variables.js", {
    whatsAppProvider: "Kaleyra",
    repoProvider: "Postgres",
    twilio: { templates: { menu: "SM123" }, listPickers: {}, listPickerProblems: ["bad"] },
  });
  delete require.cache[p("src/startup-checks.js")];
  assert.deepEqual(require(p("src/startup-checks.js")).warnings(), []);
});
