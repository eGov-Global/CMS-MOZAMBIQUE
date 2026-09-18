const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const p = (rel) => path.join(projectRoot, rel);

require.cache[p("src/machine/util/localisation-service.js")] = {
  id: p("src/machine/util/localisation-service.js"),
  filename: p("src/machine/util/localisation-service.js"),
  loaded: true,
  exports: { getMessageBundleForCode: () => undefined },
};

const InboundMessage = require(p("src/machine/util/inbound-message.js"));

test("every type the channels emit is accepted without throwing", () => {
  for (const type of ["text", "image", "document", "location", "button", "unsupported", "unknown"]) {
    assert.doesNotThrow(() => InboundMessage.create({ type, input: "x" }), `type '${type}' must not throw`);
  }
});

test("a quick-reply button is an ordinary message — it carries the payload", () => {
  const message = InboundMessage.create({ type: "button", input: "2" });
  assert.equal(message.isUnsupported(), false);
  assert.equal(message.getInputMessage(), "2");
});

test("a voice note or sticker is flagged, not fatal", () => {
  const message = InboundMessage.create({ type: "unsupported", input: " " });
  assert.equal(message.isUnsupported(), true);
  assert.equal(message.isUserMessage(), false, "blank input, so the state re-prompts");
});

test("an unrecognized future type degrades to unsupported", () => {
  const message = InboundMessage.create({ type: "contacts", input: " " });
  assert.equal(message.type, "unsupported");
  assert.equal(message.isUnsupported(), true);
});

test("cancel and reset words still work on a text message", () => {
  assert.equal(InboundMessage.create({ type: "text", input: "cancelar" }).isCancel(), true);
  assert.equal(InboundMessage.create({ type: "text", input: "reiniciar" }).isReset(), true);
});
