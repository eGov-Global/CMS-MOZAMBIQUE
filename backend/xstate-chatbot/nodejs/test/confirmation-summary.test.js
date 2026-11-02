const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { Machine, interpret } = require("xstate");

const projectRoot = path.resolve(__dirname, "..");
const p = (rel) => path.join(projectRoot, rel);

async function settle(turns = 10) {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function stub(file, exports) {
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

// Templates on for the confirmation only, so its params and its text summary
// (the template's fallbackText) come out of the same turn.
stub(p("src/env-variables.js"), {
  whatsAppProvider: "Twilio",
  twilio: { templatesEnabled: true, templateLocale: "pt_PT", templates: { confirmSubmission: "HX-confirm" }, listPickers: {} },
  pgrUseCase: { geoSearch: false },
  supportedLocales: "pt_PT,en_IN",
  defaultLocale: "pt_PT",
  rootTenantId: "mz",
  timeZone: "Africa/Maputo",
  dateFormat: "DD/MM/YYYY",
  egovServices: {},
  kafka: { kafkaConsumerEnabled: false },
  instituteNameMaxLength: 300,
  descriptionMinLength: 20,
  maxMediaSizeMb: 5,
});

const NAMES = {
  "COMPLAINT_HIERARCHY.SAUDE": "Saúde",
  "COMPLAINT_HIERARCHY.FALTA_MEDICAMENTOS": "Falta de medicamentos",
  MAPUTO_CIDADE: "Maputo Cidade",
  KAMPFUMU: "KaMpfumu",
  MAPUTO: "Maputo",
  ALTO_MAE: "Alto Maé",
};
stub(p("src/machine/util/localisation-service.js"), {
  getMessageBundleForCode: (code) => (NAMES[code] ? { pt_PT: NAMES[code], en_IN: NAMES[code] } : undefined),
  getLocales: () => [],
});

const DESCRIPTION = "Faltam medicamentos essenciais no hospital desde a semana passada.";

/** A boundary tree with one option per level, the levels named as given. */
function boundaryStep(levels) {
  return async (tenantId, boundaryPath = []) => {
    const level = levels[boundaryPath.length];
    return { options: [level.code], messageBundle: {}, levelLabel: level.name, isLeafLevel: boundaryPath.length === levels.length - 1 };
  };
}

function service(levels) {
  return {
    fetchComplaintHierarchyStep: async (tenantId, hierarchyPath = []) =>
      hierarchyPath.length === 0
        ? { options: ["SAUDE"], messageBundle: {}, trailBundle: {}, levelLabel: "Tipo", isLeafLevel: false }
        : { options: ["FALTA_MEDICAMENTOS"], messageBundle: {}, trailBundle: {}, levelLabel: "Categoria", isLeafLevel: true },
    fetchBoundaryStep: boundaryStep(levels),
    persistComplaint: async () => ({ complaintNumber: "PGR-1" }),
  };
}

/**
 * Files a complaint up to the confirmation, picking option 1 at every level
 * (`boundaryReplies` overrides the boundary walk's replies), and returns what
 * the confirmation step sent plus the context it left.
 */
async function reachConfirmation(levels, { locale = "pt_PT", boundaryReplies } = {}) {
  stub(p("src/machine/service/service-loader.js"), { pgrService: service(levels) });
  for (const rel of ["src/machine/pgr-machine.js", "src/machine/flow/pgr-messages.js"]) delete require.cache[p(rel)];
  const pgr = require(p("src/machine/pgr-machine.js"));

  const outputs = [];
  const interpreter = interpret(Machine({
    id: "root",
    initial: "pgr",
    context: {
      user: { locale, userId: "u-1" },
      extraInfo: { tenantId: "mz" },
      slots: { pgr: {} },
      chatInterface: { toUser: (user, messages) => outputs.push(...messages) },
    },
    states: { pgr: pgr.config, welcome: { id: "welcome" }, endstate: { id: "endstate", type: "final" }, system_error: { id: "system_error" } },
  })).start();
  await settle();

  const replies = ["1", "1", "1", ...(boundaryReplies || levels.map(() => "1")), "Hospital Central", DESCRIPTION, "1", "1", "2"];
  for (const input of replies) {
    interpreter.send({ type: "USER_MESSAGE", message: { type: "text", input } });
    await settle();
  }

  const context = interpreter.state.context;
  interpreter.stop();
  const template = outputs.find((message) => message && message.output === "HX-confirm");
  return { template, summary: template ? template.fallbackText : outputs[outputs.length - 1], context };
}

const PROVINCIA = { name: "Provincia", code: "MAPUTO_CIDADE" };
const DISTRITO = { name: "Distrito", code: "KAMPFUMU" };
const MUNICIPIO = { name: "Municipio", code: "MAPUTO" };
const BAIRRO = { name: "Bairro", code: "ALTO_MAE" };

const head = ["*Tipo:* Saúde", "*Categoria:* Falta de medicamentos"];
const tail = ["*Instituição:* Hospital Central", `*Descrição:* ${DESCRIPTION}`, "*Confidencialidade:* Não"];
const paramsWith = (fourth, fifth) =>
  ["Saúde", "Falta de medicamentos", "-", fourth, fifth, "Hospital Central", DESCRIPTION, "Não"];

test("one level: its line is shown, and the template's first location slot is '-'", async () => {
  const { summary, template } = await reachConfirmation([DISTRITO]);
  assert.ok(summary.includes([...head, "*Distrito:* KaMpfumu", ...tail].join("\n")));
  assert.deepEqual(template.params, paramsWith("-", "KaMpfumu"));
});

test("two levels: both lines, both template slots", async () => {
  const { summary, template } = await reachConfirmation([DISTRITO, MUNICIPIO]);
  assert.ok(summary.includes([...head, "*Distrito:* KaMpfumu", "*Município:* Maputo", ...tail].join("\n")));
  assert.deepEqual(template.params, paramsWith("KaMpfumu", "Maputo"));
});

test("mz's three levels: a Província line is added, and the template gets what PR #212 sent", async () => {
  const { summary, template, context } = await reachConfirmation([PROVINCIA, DISTRITO, MUNICIPIO]);
  assert.ok(summary.includes(
    [...head, "*Província:* Maputo Cidade", "*Distrito:* KaMpfumu", "*Município:* Maputo", ...tail].join("\n")
  ), "accented labels from the bundles, though the boundary types are Provincia/Municipio");

  // PR #212 filled {{4}} {{5}} from boundary[1] and boundary[2]; the approved
  // template labels those slots Distrito and Município.
  const boundary = context.boundaryPath;
  const pr212 = ["Saúde", "Falta de medicamentos", "-", NAMES[boundary[1]], NAMES[boundary[2]], "Hospital Central", DESCRIPTION, "Não"];
  assert.deepEqual(template.params, pr212);
});

test("four levels: every level is shown, an unknown name as the walk showed it, and the deepest two fill the template", async () => {
  const { summary, template } = await reachConfirmation([PROVINCIA, DISTRITO, MUNICIPIO, BAIRRO]);
  assert.ok(summary.includes(
    [...head, "*Província:* Maputo Cidade", "*Distrito:* KaMpfumu", "*Município:* Maputo", "*Bairro:* Alto Maé", ...tail].join("\n")
  ));
  assert.deepEqual(template.params, paramsWith("Maputo", "Alto Maé"));
});

test("level names match the labels without case or accents; a level with no name is 'Local'", async () => {
  const shouty = await reachConfirmation([
    { name: "PROVÍNCIA", code: "MAPUTO_CIDADE" },
    { name: " distrito ", code: "KAMPFUMU" },
    { name: "Município", code: "MAPUTO" },
  ]);
  assert.ok(shouty.summary.includes("*Província:* Maputo Cidade\n*Distrito:* KaMpfumu\n*Município:* Maputo"));

  const unnamed = await reachConfirmation([{ name: "", code: "KAMPFUMU" }]);
  assert.ok(unnamed.summary.includes("*Local:* KaMpfumu"));
});

test("the labels follow the citizen's locale", async () => {
  // templates are pt_PT only, so an en_IN citizen gets the text summary
  const { template, summary } = await reachConfirmation([PROVINCIA, DISTRITO, MUNICIPIO], { locale: "en_IN" });
  assert.equal(template, undefined);
  assert.ok(summary.includes("*Province:* Maputo Cidade\n*District:* KaMpfumu\n*Municipality:* Maputo"));
});

test("going back a level drops its name with its code, so names stay with their levels", async () => {
  // level 1, then "2" = Voltar at level 2, then level 1 and level 2 again
  const { summary, context } = await reachConfirmation([DISTRITO, MUNICIPIO], { boundaryReplies: ["1", "2", "1", "1"] });
  assert.deepEqual(context.boundaryPath, ["KAMPFUMU", "MAPUTO"]);
  assert.deepEqual(context.boundaryLevels, ["Distrito", "Municipio"]);
  assert.ok(summary.includes("*Distrito:* KaMpfumu\n*Município:* Maputo\n*Instituição:*"));
});
