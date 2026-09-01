// What each onboarding and shell step IS. Where each step GOES lives in
// shell-transitions.js.
//
// Fields a step may declare:
// `key`     — the step's name, referenced by shell-transitions.js.
// `kind`    — step type (say/ask/choose/call/gate/goto); picks the behavior generate.js builds.
// `prompt`  — the message(s) sent to the citizen.
// `accept`  — expected reply type (e.g. 'text').
// `options` — choices offered (list or a function).
// `recognize` — extra strings that match an option, beyond its literal label (kind: 'choose').
// `set`     — writes the reply into context.
// `fill`    — values injected into the prompt template.
// `src`     — async function to run (kind: 'call').
// `onDone` / `onUnknown` — outcome routing after the step runs.
// `effect`  — side effect run without changing the prompt flow.

const config = require('../../env-variables');
const dialog = require('../util/dialog');

const stripDiacritics = (text) =>
  String(text).toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

module.exports = ({ messages, userProfileService, offeredLocales }) => [
{
    key: 'onboardingLocale',
    kind: 'choose',
    accept: 'text',
    prompt: messages.onboarding.localeMenu,
    options: () => offeredLocales(),
    recognize: (option) => [option.label.toLowerCase(), stripDiacritics(option.label)],
    set: (context, locale) => {
      context.user.locale = locale;
      context.onboarding.locale = locale;
    },
    // onUnknown it uses the default locale from the configuration.
    onUnknown: {
      set: (context) => {
        context.user.locale = config.defaultLocale;
        context.onboarding.locale = config.defaultLocale;
      }
    }

  },

  {
    key: 'onboardingWelcome',
    kind: 'say',
    prompt: messages.onboarding.onboardingWelcome
  },

  {
    key: 'onboardingName',
    kind: 'ask',
    accept: 'text',
    prompt: [
      { bundle: messages.onboarding.nameInformation, delay: 3000 },
      { bundle: messages.onboarding.onboardingName.question, delay: 4000 }
    ],
    set: (context, name) => {
      context.onboarding.name = name;
    }
  },

  {
    key: 'onBoardingUserProfileConfirmation',
    kind: 'choose',
    options: ['Yes', 'No'],
    prompt: [
      { bundle: messages.onboarding.nameInformation, delay: 3000, immediate: false },
      { bundle: messages.onboarding.onBoardingUserProfileConfirmation.question, delay: 4000 }
    ],
    fill: { name: (context) => context.user.name }
  },

  {
    key: 'changeName',
    kind: 'ask',
    accept: 'text',
    prompt: messages.onboarding.changeName.question,
    set: (context, name) => {
      context.onboarding.name = name;
    }
  },

  {
    key: 'onboardingNameConfirmation',
    kind: 'choose',
    options: ['Yes', 'No'],
    prompt: [{ bundle: messages.onboarding.onboardingNameConfirmation, delay: 1000 }],
    fill: { name: (context) => context.onboarding.name }
  },

  {
    key: 'onboardingUpdateUserProfile',
    kind: 'call',
    invokeId: 'updateUserProfile',
    src: (context) =>
      userProfileService.updateUser(context.user, context.onboarding, context.extraInfo.tenantId),
    onDone: {
      nameGiven: {
        when: (context) => context.onboarding.name,
        set: (context) => {
          context.user.name = context.onboarding.name;
          context.user.locale = context.onboarding.locale;
          context.onboarding = undefined;
        }
      },
      nameSkipped: {}
    }
  },

  {
    key: 'onboardingThankYou',
    kind: 'say',
    prompt: messages.onboarding.onboardingThankYou
  },

  // --- shell --------------------------------------------------------------

  {
    key: 'start',
    kind: 'gate'
  },

  {
    key: 'preCondition',
    kind: 'goto'
  },

  {
    key: 'invoke',
    kind: 'say',
    prompt: messages.welcome,
    fill: { name: (context) => context.user.name || 'Citizen' }
  },

  {
    key: 'endstate',
    kind: 'goto'
  },

  {
    key: 'system_error',
    kind: 'say',
    prompt: dialog.global_messages.system_error,
    // reported from the entry action so the error.platform payload survives
    effect: (context, event) => context.chatInterface.system_error(event.data)
  }
];
