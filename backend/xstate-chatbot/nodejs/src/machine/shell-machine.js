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

const onboardingLocale = new QuestionState('onboardingLocale');
const onboardingWelcome = new State('onboardingWelcome');
const onboardingName = new AskState('onboardingName');
const onBoardingUserProfileConfirmation = new QuestionState('onBoardingUserProfileConfirmation');
const changeName = new AskState('changeName');
const onboardingNameConfirmation = new QuestionState('onboardingNameConfirmation');
const onboardingUpdateUserProfile = new ProcessingState('onboardingUpdateUserProfile');
const onboardingThankYou = new State('onboardingThankYou');

// -- welcome group --------------------------------------------------------

const preCondition = new State('preCondition');
const invoke = new State('invoke');

// -- chassis (top level) --------------------------------------------------

const start = new GateState('start');
const endstate = new State('endstate');
const system_error = new State('system_error');
const pgr = new State('pgr'); // placeholder until pgr.js is ported

const onboardingGroup = new Group(
  'onboarding',
  [onboardingLocale, onboardingWelcome, onboardingName, onBoardingUserProfileConfirmation,
    changeName, onboardingNameConfirmation, onboardingUpdateUserProfile, onboardingThankYou],
  'onboardingLocale',
  (context) => { context.onboarding = {}; }
);

const welcomeGroup = new Group('welcome', [preCondition, invoke], 'preCondition');

// -- wiring -----------------------------------------------------------

start
  .setConditionalNext(welcomeGroup, isOnboarded)
  .setNext(onboardingGroup);

onboardingLocale
  .setPrompt(messages.onboarding.localeMenu)
  .setOptions(() => offeredLocales())
  .setOnUnknown(onboardingWelcome, (context) => {
    context.user.locale = config.defaultLocale;
    context.onboarding.locale = config.defaultLocale;
  })
  .setNext(onboardingWelcome, (context) => {
    context.user.locale = context.intention;
    context.onboarding.locale = context.intention;
  });

onboardingWelcome
  .setPrompt(messages.onboarding.onboardingWelcome)
  .setConditionalNext(onBoardingUserProfileConfirmation, hasProfileName)
  .setNext(onboardingName);

onboardingName
  .setPrompt([
    { bundle: messages.onboarding.nameInformation, delay: 3000 },
    { bundle: messages.onboarding.onboardingName.question, delay: 4000 }
  ])
  .setOnValid((context, name) => { context.onboarding.name = name; })
  .setConditionalNext(onboardingNameConfirmation, gaveName)
  .setNext(onboardingUpdateUserProfile);

onBoardingUserProfileConfirmation
  .setPrompt([
    { bundle: messages.onboarding.nameInformation, delay: 3000, immediate: false },
    { bundle: messages.onboarding.onBoardingUserProfileConfirmation.question, delay: 4000 }
  ])
  .setFill({ name: (context) => context.user.name })
  .setOptions(['Yes', 'No'])
  .setConditionalNext(onboardingUpdateUserProfile, (context) => context.intention === 'Yes')
  .setNext(changeName);

changeName
  .setPrompt(messages.onboarding.changeName.question)
  .setOnValid((context, name) => { context.onboarding.name = name; })
  .setConditionalNext(onboardingNameConfirmation, gaveName);

onboardingNameConfirmation
  .setPrompt([{ bundle: messages.onboarding.onboardingNameConfirmation, delay: 1000 }])
  .setFill({ name: (context) => context.onboarding.name })
  .setOptions(['Yes', 'No'])
  .setConditionalNext(onboardingUpdateUserProfile, (context) => context.intention === 'Yes', commitName)
  .setNext(changeName);

onboardingUpdateUserProfile
  .setProcessing((context) => userProfileService.updateUser(context.user, context.onboarding, context.extraInfo.tenantId))
  .setOnError(welcomeGroup)
  .setConditionalNext(onboardingThankYou, (context) => context.onboarding && context.onboarding.name, (context) => {
    context.user.name = context.onboarding.name;
    context.user.locale = context.onboarding.locale;
    context.onboarding = undefined;
  })
  .setNext(onboardingThankYou);

onboardingThankYou
  .setPrompt(messages.onboarding.onboardingThankYou)
  .setNext(pgr);

preCondition
  .setConditionalNext(invoke, isOnboarded)
  .setNext(onboardingGroup);

invoke
  .setPrompt(messages.welcome)
  .setFill({ name: (context) => context.user.name || 'Citizen' })
  .setNext(pgr);

endstate
  .setNext(start);

system_error
  .setPrompt(dialog.global_messages.system_error)
  .setEffect((context, event) => context.chatInterface.system_error(event.data))
  .setNext(welcomeGroup);

const config_ = compile([start, onboardingGroup, welcomeGroup, endstate, system_error, pgr], 'start');

module.exports = {
  config: config_,
  states: { start, onboardingGroup, welcomeGroup, endstate, system_error, pgr,
    onboardingLocale, onboardingWelcome, onboardingName, onBoardingUserProfileConfirmation,
    changeName, onboardingNameConfirmation, onboardingUpdateUserProfile, onboardingThankYou,
    preCondition, invoke }
};
