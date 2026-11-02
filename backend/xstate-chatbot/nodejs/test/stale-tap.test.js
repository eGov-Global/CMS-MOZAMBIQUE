const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const sessionDir = path.join(projectRoot, "src/session");
const machineDir = path.join(projectRoot, "src/machine");

async function settle(turns = 20) {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function stub(request, from, exports) {
  const filename = require.resolve(request, { paths: [from] });
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
  return exports;
}

// The live machine with quick replies on for confidentiality and the confirmation.
stub("../env-variables", sessionDir, {
  whatsAppProvider: "Twilio",
  twilio: {
    templatesEnabled: true,
    templateLocale: "pt_PT",
    templates: { confidentiality: "HX-confidentiality", confirmSubmission: "HX-confirm" },
    listPickers: {},
  },
  pgrUseCase: {},
  supportedLocales: "pt_PT",
  defaultLocale: "pt_PT",
  allowedMobileNumbers: "",
  rootTenantId: "mz",
  timeZone: "Africa/Maputo",
  dateFormat: "DD/MM/YYYY",
  egovServices: {},
  kafka: {},
  instituteNameMaxLength: 300,
  descriptionMinLength: 20,
  avgSessionTime: 30,
  cancelWords: ["cancelar"],
  resetWords: ["reiniciar"],
  timeouts: { request: 20000, mediaProcessing: 13000, dispatchSettle: 30000 },
});
const filed = [];
stub("./service/service-loader", machineDir, {
  pgrService: { persistComplaint: async (user, slots) => { filed.push({ ...slots }); return { complaintNumber: "PGR-1" }; } },
});
stub("./service/egov-user-profile", machineDir, { updateUser: async () => ({}) });
stub("./service/email-tenant-service", machineDir, {});
stub("./util/localisation-service", machineDir, {
  getMessageBundleForCode: () => undefined,
  getLocales: () => [{ value: "pt_PT", label: "PORTUGUÊS" }],
  init: () => {},
});

// Twilio's side: every template gets the next message SID.
const sent = [];
let nextSid = 0;
stub("../channel", sessionDir, {
  processMessageFromUser: async () => null,
  sendMessageToUser: async (user, messages) => {
    sent.push(...messages);
    const template = messages.find((message) => message && message.type === "template");
    return template ? { messageSid: `SM-${++nextSid}`, prompt: template.fallbackText } : undefined;
  },
});

// One stored row per citizen, as the Postgres repo keeps it.
const rows = {};
const repo = stub("./repo", sessionDir, {
  insertNewState: async (userId, active, state) => { rows[userId] = state; },
  updateState: async (userId, active, state) => { rows[userId] = state; },
  getActiveStateForUserId: async (userId) => (rows[userId] ? ChatState.create(JSON.parse(rows[userId])) : undefined),
  updateSessionId: async () => {},
  getSessionId: async () => "session-1",
});
stub("./telemetry", sessionDir, { log: () => {} });
stub("./system", sessionDir, { error: () => {} });
stub("./user-service", sessionDir, {});

const sessionManager = require(path.join(sessionDir, "session-manager.js"));
const ChatState = require(path.join(sessionDir, "chat-state.js"));
const InboundRequestModel = require(path.join(machineDir, "util/inbound-request-model.js"));
const stateMachine = require(path.join(machineDir, "state-machine.js"));
const pgr = require(path.join(machineDir, "pgr-machine.js"));
const { State } = require("xstate");
const { pendingPersist } = require(path.join(sessionDir, "persist-queue.js"));

const chatService = sessionManager.chatService;
const user = () => ({ userId: "u1", mobileNumber: "841234567", locale: "pt_PT", name: "Feliciano" });
const session = () => ({ userId: "u1", user: user() });

/** Stores a conversation waiting at `value`, as a resumed citizen's row would hold it. */
function storeAt(value, context = {}) {
  const base = { chatInterface: sessionManager, user: user(), extraInfo: { tenantId: "mz" }, slots: { pgr: {} }, ...context };
  // the options each question stored when it was asked
  for (const question of [pgr.states.confidentiality, pgr.states.confirmSubmission]) {
    base[question.optionsSlot] = question.resolveOptions(base);
  }
  const state = stateMachine.withContext(base).resolveState(State.from(value, base));
  rows.u1 = ChatState.create(JSON.parse(JSON.stringify(state))).toPersistableState().state;
}

const stored = () => JSON.parse(rows.u1);

function reply(input, { type = "button", repliedTo } = {}) {
  return InboundRequestModel.create({
    user: user(),
    extraInfo: { tenantId: "mz" },
    message: { type, input, ...(repliedTo ? { repliedTo } : {}) },
  });
}

/** One turn, settled the way authenticateAndDispatch settles it: state written, sends (and their SID patch) done. */
async function turn(model) {
  await chatService.dispatch(session(), model);
  await settle();
  await pendingPersist("u1");
}

test.beforeEach(() => {
  sent.length = 0;
  filed.length = 0;
});

test("a double tap on 'Manter confidencial' does not submit the complaint", async () => {
  storeAt({ pgr: { fileComplaint: { confidentiality: "question" } } }, {
    lastPrompt: "CONFIDENTIALITY PROMPT",
    lastPromptSid: "SM-confidentiality",
  });

  // The first tap answers the question it was tapped on.
  await turn(reply("1", { repliedTo: "SM-confidentiality" }));
  const atConfirmation = stored();
  assert.deepEqual(atConfirmation.value, { pgr: { fileComplaint: { confirmSubmission: "question" } } });
  assert.equal(atConfirmation.context.slots.pgr.isConfidential, true);
  assert.equal(sent[0].output, "HX-confirm", "the confirmation went out as its template");
  assert.equal(atConfirmation.context.lastPromptSid, `SM-${nextSid}`, "and its message SID was stored next to lastPrompt");

  // The second copy of the same tap lands on the confirmation, where 1 = Submeter.
  sent.length = 0;
  await turn(reply("1", { repliedTo: "SM-confidentiality" }));
  assert.equal(filed.length, 0, "nothing was filed");
  assert.deepEqual(stored().value, atConfirmation.value, "still waiting on the confirmation");
  assert.deepEqual(sent, [atConfirmation.context.lastPrompt], "the current prompt is re-sent as text");

  // A tap on the confirmation's own buttons is an answer.
  await turn(reply("1", { repliedTo: atConfirmation.context.lastPromptSid }));
  assert.equal(filed.length, 1, "submitted once, by the tap on the confirmation");
});

test("typed digits, taps without the field and a fresh conversation behave as before", async () => {
  const atConfirmation = { pgr: { fileComplaint: { confirmSubmission: "question" } } };
  const prompt = { lastPrompt: "CONFIRM PROMPT", lastPromptSid: "SM-confirm" };

  storeAt(atConfirmation, prompt);
  await turn(reply("2", { type: "text", repliedTo: "SM-old" }));
  assert.notDeepEqual(stored().value, atConfirmation, "a typed digit is always an answer");

  storeAt(atConfirmation, prompt);
  await turn(reply("2"));
  assert.notDeepEqual(stored().value, atConfirmation, "a tap Twilio did not label is an answer");

  storeAt(atConfirmation, { lastPrompt: undefined });
  await turn(reply("2", { repliedTo: "SM-old" }));
  assert.notDeepEqual(stored().value, atConfirmation, "with no prompt to re-send, the tap is processed");

  storeAt("start", prompt);
  sent.length = 0;
  await turn(reply("1", { repliedTo: "SM-old" }));
  assert.notEqual(stored().value, "start", "at the start gate any message begins the conversation");
  assert.ok(!sent.includes("CONFIRM PROMPT"), "rather than re-sending a finished prompt");
});

test("a SID is not stored against a prompt that has since moved on", async () => {
  storeAt({ pgr: { fileComplaint: { confirmSubmission: "question" } } }, { lastPrompt: "NEWER PROMPT" });
  await chatService.recordPromptSid("u1", { messageSid: "SM-late", prompt: "OLDER PROMPT" });
  assert.equal(stored().context.lastPromptSid, undefined);

  await chatService.recordPromptSid("u1", { messageSid: "SM-current", prompt: "NEWER PROMPT" });
  assert.equal(stored().context.lastPromptSid, "SM-current");
});

test("a failed SID patch is logged and does not fail the citizen's next turn", async (t) => {
  storeAt({ pgr: { fileComplaint: { confirmSubmission: "question" } } }, { lastPrompt: "PROMPT" });
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args.join(" ")));
  t.mock.method(repo, "updateState", async () => { throw new Error("connection reset"); });

  await chatService.recordPromptSid("u1", { messageSid: "SM-1", prompt: "PROMPT" });

  await assert.doesNotReject(pendingPersist("u1"));
  assert.ok(errors.some((line) => line.includes("connection reset")));
});
