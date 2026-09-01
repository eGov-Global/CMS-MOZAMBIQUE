// Migration port of shell-states.js/shell-transitions.js (onboarding + chassis)
// to the class-based flow authoring in flow/flow-state*.js. Not wired into the
// running system — state-machine.js still uses the original generate.js path.
// `pgr` is a placeholder until pgr-states.js/pgr-transitions.js are ported.
const State = require('./flow/flow-state');
const QuestionState = require('./flow/flow-state-question');
const AskState = require('./flow/flow-state-ask');
const ProcessingState = require('./flow/flow-state-processing');
const GateState = require('./flow/flow-state-gate');
const Group = require('./flow/flow-state-group');
const compile = require('./flow/flow-state-compiler');

const dialog = require('./util/dialog');
const config = require('../env-variables');
const messages = require('./flow/shell-messages');
const { offeredLocales } = require('./flow/offered-locales');
const userProfileService = require('./service/egov-user-profile');

const isOnboarded = (context) => context.user.locale;
const hasProfileName = (context) => context.user.name;
const gaveName = (context) => context.onboarding.name;
const commitName = (context) => { context.user.name = context.onboarding.name; };

// -- onboarding group ---------------------------------------------------

const askLocale = new QuestionState('onboardingLocale');
const sayWelcome = new State('onboardingWelcome');
const askForName = new AskState('onboardingName');
const askToConfirmProfile = new QuestionState('onBoardingUserProfileConfirmation');
const askToChangeName = new AskState('changeName');
const askToConfirmName = new QuestionState('onboardingNameConfirmation');
const updateUserProfile = new ProcessingState('onboardingUpdateUserProfile');
const sayThankYou = new State('onboardingThankYou');

// -- welcome group --------------------------------------------------------

const preCondition = new State('preCondition');
const invoke = new State('invoke');

// -- chassis (top level) --------------------------------------------------

const startNode = new GateState('start');
const endNode = new State('endstate');
const systemErrorNode = new State('system_error');
const pgrNode = new State('pgr'); // placeholder until pgr.js is ported

const onboardingGroup = new Group('onboarding');
onboardingGroup
  .setStates([askLocale, sayWelcome, askForName, askToConfirmProfile,
    askToChangeName, askToConfirmName, updateUserProfile, sayThankYou])
  .setStart('onboardingLocale')
  .setOnEntry((context) => { context.onboarding = {}; });

const welcomeGroup = new Group('welcome')
  .setStates([preCondition, invoke])
  .setStart('preCondition');

// -- wiring -----------------------------------------------------------

startNode
  .setConditionalNext(welcomeGroup, isOnboarded)
  .setNext(onboardingGroup);

askLocale
  .setPrompt(messages.onboarding.localeMenu)
  .setOptions(() => offeredLocales())
  .setOnUnknown(sayWelcome, (context) => {
    context.user.locale = config.defaultLocale;
    context.onboarding.locale = config.defaultLocale;
  })
  .setNext(sayWelcome, (context) => {
    context.user.locale = context.intention;
    context.onboarding.locale = context.intention;
  });

sayWelcome
  .setPrompt(messages.onboarding.onboardingWelcome)
  .setConditionalNext(askToConfirmProfile, hasProfileName)
  .setNext(askForName);

askForName
  .setPrompt([
    { bundle: messages.onboarding.nameInformation, delay: 3000 },
    { bundle: messages.onboarding.onboardingName.question, delay: 4000 }
  ])
  .setOnValid((context, name) => { context.onboarding.name = name; })
  .setConditionalNext(askToConfirmName, gaveName)
  .setNext(updateUserProfile);

askToConfirmProfile
  .setPrompt([
    { bundle: messages.onboarding.nameInformation, delay: 3000, immediate: false },
    { bundle: messages.onboarding.onBoardingUserProfileConfirmation.question, delay: 4000 }
  ])
  .setFill({ name: (context) => context.user.name })
  .setOptions(['Yes', 'No'])
  .setConditionalNext(updateUserProfile, (context) => context.intention === 'Yes')
  .setNext(askToChangeName);

askToChangeName
  .setPrompt(messages.onboarding.changeName.question)
  .setOnValid((context, name) => { context.onboarding.name = name; })
  .setConditionalNext(askToConfirmName, gaveName);

askToConfirmName
  .setPrompt([{ bundle: messages.onboarding.onboardingNameConfirmation, delay: 1000 }])
  .setFill({ name: (context) => context.onboarding.name })
  .setOptions(['Yes', 'No'])
  .setConditionalNext(updateUserProfile, (context) => context.intention === 'Yes', commitName)
  .setNext(askToChangeName);

updateUserProfile
  .setProcessing((context) => userProfileService.updateUser(context.user, context.onboarding, context.extraInfo.tenantId))
  .setOnError(welcomeGroup)
  .setConditionalNext(sayThankYou, (context) => context.onboarding && context.onboarding.name, (context) => {
    context.user.name = context.onboarding.name;
    context.user.locale = context.onboarding.locale;
    context.onboarding = undefined;
  })
  .setNext(sayThankYou);

sayThankYou
  .setPrompt(messages.onboarding.onboardingThankYou)
  .setNext(pgrNode);

preCondition
  .setConditionalNext(invoke, isOnboarded)
  .setNext(onboardingGroup);

invoke
  .setPrompt(messages.welcome)
  .setFill({ name: (context) => context.user.name || 'Citizen' })
  .setNext(pgrNode);

endNode
  .setNext(startNode);

systemErrorNode
  .setPrompt(dialog.global_messages.system_error)
  .setEffect((context, event) => context.chatInterface.system_error(event.data))
  .setNext(welcomeGroup);

const config_ = compile([startNode, onboardingGroup, welcomeGroup, endNode, systemErrorNode, pgrNode], 'start');

module.exports = {
  config: config_,
  states: { start: startNode, onboardingGroup, welcomeGroup, endstate: endNode, system_error: systemErrorNode, pgr: pgrNode,
    onboardingLocale: askLocale, onboardingWelcome: sayWelcome, onboardingName: askForName, onBoardingUserProfileConfirmation: askToConfirmProfile,
    changeName: askToChangeName, onboardingNameConfirmation: askToConfirmName, onboardingUpdateUserProfile: updateUserProfile, onboardingThankYou: sayThankYou,
    preCondition, invoke }
};
