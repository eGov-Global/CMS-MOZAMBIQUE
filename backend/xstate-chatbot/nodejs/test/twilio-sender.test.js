const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const envPath = path.join(projectRoot, "src/env-variables.js");
const twilioPath = path.join(projectRoot, "src/channel/twilio.js");
const mobilePath = path.join(projectRoot, "src/machine/service/mobile-validation-service.js");

function loadProvider(whatsappNumber) {
  delete require.cache[twilioPath];
  delete require.cache[mobilePath];
  require.cache[envPath] = {
    id: envPath,
    filename: envPath,
    loaded: true,
    exports: {
      rootTenantId: "pg",
      twilio: { accountSid: "AC", authToken: "tok", whatsappNumber, baseUrl: "" },
      mobileValidation: { defaultCountryCode: "+91", defaultRegex: "^[0-9]{10}$", cacheTtlMs: 1000 },
      egovServices: { egovServicesHost: "http://localhost/", mdmsV2SearchPath: "mdms-v2/v2/_search" },
    },
  };
  return require(twilioPath);
}

test("REGRESSION #7: the repo-wide whatsapp:-prefixed sender is not double-prefixed", () => {
  // twilio_whatsapp_from is documented as "whatsapp:+14155238886" in every host_vars
  // example and in the Novu bootstrap default. Re-prefixing produced
  // From=whatsapp:+whatsapp:+14155238886, which Twilio rejects -- the webhook validated,
  // the dialog ran, and the citizen never got a reply.
  assert.equal(loadProvider("whatsapp:+14155238886").senderAddress(), "whatsapp:+14155238886");
});

test("REGRESSION #7: an unprefixed sender still works", () => {
  assert.equal(loadProvider("+14155238886").senderAddress(), "whatsapp:+14155238886");
  assert.equal(loadProvider("14155238886").senderAddress(), "whatsapp:+14155238886");
});

test("REGRESSION #7: mixed case and stray formatting are normalised", () => {
  assert.equal(loadProvider("WhatsApp:+1 (415) 523-8886").senderAddress(), "whatsapp:+14155238886");
});

test("REGRESSION #6/#7: an unset sender fails loudly instead of using the eGov demo number", () => {
  // Previously this silently became +919880900990, so a misconfigured deployment sent
  // as someone else's number rather than failing.
  for (const blank of ["", "   ", undefined]) {
    assert.throws(() => loadProvider(blank).senderAddress(), /TWILIO_WHATSAPP_NUMBER is not set/);
  }
});

test("REGRESSION: replies go to the address the citizen wrote from, not a re-prefixed national number", async (t) => {
  const provider = loadProvider("whatsapp:+14155238886");
  // ke's first row: +254, whose regex also admits 10-digit Indian numbers.
  // t.mock.method restores the shared singleton when the test ends.
  const mobile = require(mobilePath);
  t.mock.method(mobile, "getConfig", async () => ({ countryCode: "+254", mobileNumberRegex: "^(0?[17][0-9]{8}|[6-9][0-9]{9})$" }));
  const sent = [];
  provider.sendTwilioRequest = async (params) => sent.push(params.get("To"));

  const citizen = { mobileNumber: "6307817430", whatsAppAddress: "whatsapp:+916307817430" };
  await provider.sendMessageToUser(citizen, ["hello"], { tenantId: "ke" });
  // Previously the national number was re-prefixed with the tenant default: +2546307817430.
  assert.deepEqual(sent, ["whatsapp:+916307817430"]);

  // Without a captured address the old national-number path is unchanged.
  sent.length = 0;
  await provider.sendMessageToUser({ mobileNumber: "712345678" }, ["hello"], { tenantId: "ke" });
  assert.deepEqual(sent, ["whatsapp:+254712345678"]);
});

// -- quick replies and list pickers ------------------------------------------

const citizen = { mobileNumber: "841234567", whatsAppAddress: "whatsapp:+258841234567" };
const TEMPLATE_SID = "HX00000000000000000000000000000001";
const prompt = "Confirme os dados:\n\n*Descrição:* o meu vizinho...\n\n*1.* Submeter.\n*2.* Cancelar.";
const template = { type: "template", output: TEMPLATE_SID, params: ["Saúde", "-"], fallbackText: prompt };

/** Records every request, answering template sends with `templateResponse`. */
function recordSends(provider, templateResponse) {
  const sent = [];
  provider.sendTwilioRequest = async (params) => {
    sent.push(Object.fromEntries(params));
    return params.get("ContentSid") ? templateResponse : { sid: "SM-text" };
  };
  return sent;
}

test("a template Twilio accepts goes out alone, with its variables numbered", async () => {
  const provider = loadProvider("whatsapp:+14155238886");
  const sent = recordSends(provider, { sid: "SM-template", status: "queued", error_code: null });

  await provider.sendMessageToUser(citizen, [template], { tenantId: "mz" });

  assert.equal(sent.length, 1, "no text fallback");
  assert.equal(sent[0].ContentSid, TEMPLATE_SID);
  assert.deepEqual(JSON.parse(sent[0].ContentVariables), { 1: "Saúde", 2: "-" });
});

test("a template Twilio refuses is followed by its prompt as text, so the citizen is never left waiting", async (t) => {
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args.join(" ")));

  // sendTwilioRequest answers undefined for a non-2xx and for a request that threw;
  // a 2xx carrying an error code is a refusal too.
  for (const refusal of [undefined, { sid: "SM-x", error_code: 63016 }]) {
    const provider = loadProvider("whatsapp:+14155238886");
    const sent = recordSends(provider, refusal);
    errors.length = 0;

    await provider.sendMessageToUser(citizen, [template], { tenantId: "mz" });

    assert.equal(sent.length, 2, `template, then text (${JSON.stringify(refusal)})`);
    assert.equal(sent[1].Body, prompt, "the same prompt the flow stored as lastPrompt");
    assert.equal(sent[1].To, "whatsapp:+258841234567");
    assert.ok(errors.some((line) => line.includes(TEMPLATE_SID)), "the failure names the template");
    assert.ok(!errors.some((line) => line.includes("vizinho")), "never the citizen's words");
  }
});

test("a refused template without a text prompt sends nothing more", async (t) => {
  t.mock.method(console, "error", () => {});
  const provider = loadProvider("whatsapp:+14155238886");
  const sent = recordSends(provider, undefined);

  await provider.sendMessageToUser(citizen, [{ ...template, fallbackText: undefined }], { tenantId: "mz" });

  assert.equal(sent.length, 1);
});
