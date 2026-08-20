const { Machine } = require("xstate");
const pgr = require("./pgr");
const userProfileService = require("./service/egov-user-profile");
const emailTenantService = require("./service/email-tenant-service");

const legacyOrganizationStates = require("./flow/legacy-organization");
const { buildSteps } = require("./flow/steps-seva");
const layout = require("./flow/layout");
const { generate, mergeStates, assertTargets } = require("./flow/generate");
const messages = require("./flow/messages-seva");
const { offeredLocales } = require("./flow/offered-locales");

const sevaConfig = {
  id: "mseva",
  initial: "start",
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

mergeStates(
  sevaConfig.states,
  generate(
    buildSteps({ messages, userProfileService, offeredLocales }),
    layout.seva
  )
);
Object.assign(
  sevaConfig.states.onboarding.states,
  legacyOrganizationStates({ emailTenantService })
);

assertTargets(sevaConfig);

const sevaMachine = Machine(sevaConfig);

module.exports = sevaMachine;
