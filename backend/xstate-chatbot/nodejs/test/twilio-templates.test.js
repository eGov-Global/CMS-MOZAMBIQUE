const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { Machine, interpret } = require("xstate");

const projectRoot = path.resolve(__dirname, "..");
const p = (rel) => path.join(projectRoot, rel);

function stub(rel, exports) {
  const filename = p(rel);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stub("src/machine/util/localisation-service.js", { getMessageBundleForCode: () => undefined, getLocales: () => [] });

const SID = "HX00000000000000000000000000000001";

/** A Twilio deployment with every template configured, which each case then breaks one way. */
function config(overrides = {}, twilioOverrides = {}) {
  return {
    whatsAppProvider: "Twilio",
    defaultLocale: "pt_PT",
    twilio: {
      templatesEnabled: true,
      templateLocale: "pt_PT",
      templates: { menu: SID, confirmSubmission: SID },
      listPickers: { 1: "HX-one", 2: "HX-two", 10: "HX-ten", 11: "HX-eleven" },
      ...twilioOverrides,
    },
    ...overrides,
  };
}

function load(cfg) {
  stub("src/env-variables.js", cfg);
  for (const rel of [
    "src/machine/flow/flow-state.js", "src/machine/flow/flow-state-question.js", "src/machine/flow/flow-state-walk.js",
    "src/machine/flow/list-picker.js", "src/machine/util/dialog.js",
  ]) {
    delete require.cache[p(rel)];
  }
  return {
    State: require(p("src/machine/flow/flow-state.js")),
    QuestionState: require(p("src/machine/flow/flow-state-question.js")),
    WalkState: require(p("src/machine/flow/flow-state-walk.js")),
    listPickerMessage: require(p("src/machine/flow/list-picker.js")).listPickerMessage,
  };
}

const compile = require(p("src/machine/flow/flow-state-compiler.js"));
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

/** Starts a machine made of `states` and records what the citizen is sent. */
function run(states, initial, context = {}) {
  const outputs = [];
  const service = interpret(Machine({
    id: "root",
    ...compile(states, initial),
    context: { user: { locale: "pt_PT" }, extraInfo: {}, slots: { pgr: {} }, chatInterface: { toUser: (user, messages) => outputs.push(...messages) }, ...context },
  })).start();
  return { outputs, service };
}

const citizen = (locale = "pt_PT") => ({ user: { locale } });
const labels = (n) => Array.from({ length: n }, (_, i) => `Opção ${i + 1}`);

// -- quick replies (QuestionState.templateMessage) -------------------------

test("a question with a SID goes out as its template", () => {
  const { QuestionState } = load(config());
  const menu = new QuestionState("menu").setTemplate("menu");
  assert.deepEqual(menu.templateMessage(citizen()), { type: "template", output: SID, params: [] });
});

test("the master switch, another provider, another locale or no SID keep the text prompt", () => {
  const cases = [
    ["templates switched off", config({}, { templatesEnabled: false })],
    ["Kaleyra", config({ whatsAppProvider: "Kaleyra" })],
    ["ValueFirst", config({ whatsAppProvider: "ValueFirst" })],
    ["Console", config({ whatsAppProvider: "Console" })],
    ["no SID for the question", config({}, { templates: { menu: "" } })],
  ];
  for (const [label, cfg] of cases) {
    const { QuestionState } = load(cfg);
    assert.equal(new QuestionState("menu").setTemplate("menu").templateMessage(citizen()), null, label);
  }

  const { QuestionState } = load(config());
  assert.equal(new QuestionState("menu").setTemplate("menu").templateMessage(citizen("en_IN")), null, "en_IN citizen");
  assert.equal(new QuestionState("menu").templateMessage(citizen()), null, "a question with no template");
});

test("template variables are flattened onto one line, capped, and never empty", () => {
  const { QuestionState } = load(config());
  const long = "x".repeat(600);
  const confirm = new QuestionState("confirmSubmission").setTemplate("confirmSubmission", () => [
    "Linha 1\nLinha 2\r\n\n   Linha 3\tfim",
    "",
    undefined,
    long,
    "😀".repeat(600),
  ]);

  const [multiLine, empty, missing, capped, emoji] = confirm.templateMessage(citizen()).params;
  // Meta rejects a variable containing a line break, a tab or a run of spaces
  assert.equal(multiLine, "Linha 1 Linha 2 Linha 3 fim");
  assert.equal(empty, "-", "Twilio rejects an empty variable");
  assert.equal(missing, "-");
  assert.equal(capped.length, 500);
  assert.ok(capped.endsWith("…"), "a cut value says so");
  assert.equal(Array.from(emoji).length, 500, "counted by character, not UTF-16 unit");
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji), "no emoji cut in half");
});

// -- list pickers (listPickerMessage) -------------------------------------

test("a list of 2 to 10 options with a SID for that count goes out as a list picker", () => {
  const { listPickerMessage } = load(config());
  assert.deepEqual(listPickerMessage(citizen(), "Distrito", labels(2)), {
    type: "template",
    output: "HX-two",
    params: ["Distrito", "Opção 1", "Opção 2"],
  });
  assert.equal(listPickerMessage(citizen(), "Distrito", labels(10)).output, "HX-ten");
});

test("1 or 11 options stay text even when a SID is configured for that count", () => {
  const { listPickerMessage } = load(config());
  assert.equal(listPickerMessage(citizen(), "Distrito", labels(1)), null, "one option is not a choice");
  assert.equal(listPickerMessage(citizen(), "Distrito", labels(11)), null, "WhatsApp lists hold at most 10 rows");
});

test("a count with no SID stays text", () => {
  const { listPickerMessage } = load(config());
  assert.equal(listPickerMessage(citizen(), "Distrito", labels(3)), null);
});

test("an option over WhatsApp's 24-character item limit keeps the whole list as text", () => {
  const { listPickerMessage } = load(config());
  const fits = "a".repeat(24);
  assert.equal(listPickerMessage(citizen(), "Distrito", [fits, "Outro"]).params[1], fits);
  assert.equal(listPickerMessage(citizen(), "Distrito", ["a".repeat(25), "Outro"]), null);
});

test("list pickers follow the same switch, provider and locale rules as quick replies", () => {
  assert.equal(load(config({}, { templatesEnabled: false })).listPickerMessage(citizen(), "Distrito", labels(2)), null);
  assert.equal(load(config({ whatsAppProvider: "Kaleyra" })).listPickerMessage(citizen(), "Distrito", labels(2)), null);
  assert.equal(load(config()).listPickerMessage(citizen("en_IN"), "Distrito", labels(2)), null);
});

test("the list heading is flattened, and a missing one is sent as '-'", () => {
  const { listPickerMessage } = load(config());
  assert.equal(listPickerMessage(citizen(), "Saúde\nSubtipo", labels(2)).params[0], "Saúde Subtipo");
  assert.equal(listPickerMessage(citizen(), "", labels(2)).params[0], "-");
});

// -- what the flow hands the channel ----------------------------------------

test("a quick-reply template carries the text prompt the flow stored, for the channel to fall back on", () => {
  const { QuestionState } = load(config());
  const confirm = new QuestionState("confirm")
    .setPrompt({ pt_PT: "Confirme os dados:\n\n{{options}}" })
    .setTemplate("confirmSubmission", () => ["Saúde"])
    .setOptions(["Submeter", "Cancelar"]);

  const { outputs, service } = run([confirm], "confirm");

  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].type, "template");
  assert.equal(outputs[0].fallbackText, service.state.context.lastPrompt);
  assert.match(outputs[0].fallbackText, /\*1\.\* Submeter/, "numbered, so a typed digit still answers it");
  service.stop();
});

test("a list picker carries the numbered text list the flow stored", async () => {
  const { State, WalkState } = load(config());
  const done = new State("done");
  const walk = new WalkState("boundary")
    .setPreamble({ pt_PT: "*{{level}}*\n" })
    .setFetch(async () => ({ options: ["KAMPFUMU", "KAMAXAQUENE"], messageBundle: {}, levelLabel: "Distrito", isLeafLevel: true }))
    .setOnError(done)
    .setOnLeaf(done);

  const { outputs, service } = run([walk, done], "boundary");
  await settle();

  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].output, "HX-two");
  assert.equal(outputs[0].fallbackText, service.state.context.lastPrompt);
  assert.match(outputs[0].fallbackText, /\*2\.\*  KAMAXAQUENE/);
  service.stop();
});

test("every new prompt retires the previous prompt's buttons", async () => {
  // lastPromptSid names the message whose taps are accepted; it is set again only
  // once this prompt's own template has gone out (chat-service.recordPromptSid).
  const { State, QuestionState, WalkState } = load(config());
  const previous = { lastPrompt: "PREVIOUS", lastPromptSid: "SM-previous" };
  const done = new State("done");

  const asText = new State("asText").setPrompt({ pt_PT: "Nome da instituição?" });
  const asTemplate = new QuestionState("asTemplate").setPrompt({ pt_PT: "Menu" }).setTemplate("menu").setOptions(["a", "b"]);
  const asList = new WalkState("asList")
    .setFetch(async () => ({ options: ["A", "B"], messageBundle: {}, levelLabel: "Distrito", isLeafLevel: true }))
    .setOnError(done)
    .setOnLeaf(done);

  for (const [state, extra] of [[asText, []], [asTemplate, []], [asList, [done]]]) {
    const { service } = run([state, ...extra], state.key, previous);
    await settle();
    assert.notEqual(service.state.context.lastPrompt, "PREVIOUS", state.key);
    assert.equal(service.state.context.lastPromptSid, undefined, state.key);
    service.stop();
  }
});
