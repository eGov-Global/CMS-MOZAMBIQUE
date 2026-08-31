const { Machine } = require("xstate");
const pgr = require("./pgr");
const userProfileService = require("./service/egov-user-profile");
const emailTenantService = require("./service/email-tenant-service");

const legacyOrganizationStates = require("./flow/legacy-organization");
const buildStates = require("./flow/shell-states");
const transitions = require("./flow/shell-transitions");
const layout = require("./flow/layout");
const { generate, mergeStates, assertTargets } = require("./flow/generate");
const { join } = require("./flow/join");
const messages = require("./flow/shell-messages");
const { offeredLocales } = require("./flow/offered-locales");

const flow = join(
  buildStates({ messages, userProfileService, offeredLocales }),
  transitions,
  layout.shell
);

const stateMachineConfig = {
  id: "citizenService",
  initial: flow.layout.initial[layout.shell.root],
  on: {
    USER_RESET: {
      target: "#welcome"
    },
  },
  states: {
    // the filing journey, assembled in pgr.js and spliced in whole
    pgr: pgr
  }, // states
}; // stateMachineConfig

mergeStates(stateMachineConfig.states, generate(flow.steps, flow.layout));
Object.assign(
  stateMachineConfig.states.onboarding.states,
  legacyOrganizationStates({ emailTenantService })
);

assertTargets(stateMachineConfig);

const stateMachine = Machine(stateMachineConfig);

module.exports = stateMachine;
