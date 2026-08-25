const { Machine } = require("xstate");
const pgr = require("./pgr");
const userProfileService = require("./service/egov-user-profile");
const emailTenantService = require("./service/email-tenant-service");

const legacyOrganizationStates = require("./flow/legacy-organization");
const buildStates = require("./flow/seva-states");
const transitions = require("./flow/seva-transitions");
const layout = require("./flow/layout");
const { generate, mergeStates, assertTargets } = require("./flow/generate");
const { join } = require("./flow/join");
const messages = require("./flow/messages-seva");
const { offeredLocales } = require("./flow/offered-locales");

const flow = join(
  buildStates({ messages, userProfileService, offeredLocales }),
  transitions,
  layout.seva
);

const sevaConfig = {
  id: "mseva",
  initial: flow.layout.initial[layout.seva.root],
  on: {
    USER_RESET: {
      target: "#welcome"
    },
  },
  states: {
    // the filing journey, assembled in pgr.js and spliced in whole
    pgr: pgr
  }, // states
}; // sevaConfig

mergeStates(sevaConfig.states, generate(flow.steps, flow.layout));
Object.assign(
  sevaConfig.states.onboarding.states,
  legacyOrganizationStates({ emailTenantService })
);

assertTargets(sevaConfig);

const sevaMachine = Machine(sevaConfig);

module.exports = sevaMachine;
