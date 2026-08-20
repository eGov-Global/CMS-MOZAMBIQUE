const dialog = require('../util/dialog');

const stripDiacritics = (text) =>
  String(text).toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

module.exports = {
  buildSteps: ({ messages, userProfileService, offeredLocales }) => [
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
      // an unrecognised reply silently selects English and moves on; this step
      // has never had a retry loop
      onUnknown: {
        to: 'onboardingWelcome',
        set: (context) => {
          context.user.locale = 'en_IN';
          context.onboarding.locale = 'en_IN';
        }
      },
      next: 'onboardingWelcome'
    },

    {
      key: 'onboardingWelcome',
      kind: 'say',
      prompt: messages.onboarding.onboardingWelcome,
      next: [
        { when: (context) => context.user.name, to: 'onBoardingUserProfileConfirmation' },
        { to: 'onboardingName' }
      ]
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
      },
      next: [
        { when: (context) => context.onboarding.name, to: 'onboardingNameConfirmation' },
        { to: 'onboardingUpdateUserProfile' }
      ]
    },

    {
      key: 'onBoardingUserProfileConfirmation',
      kind: 'choose',
      options: ['Yes', 'No'],
      prompt: [
        { bundle: messages.onboarding.nameInformation, delay: 3000, immediate: false },
        { bundle: messages.onboarding.onBoardingUserProfileConfirmation.question, delay: 4000 }
      ],
      fill: { name: (context) => context.user.name },
      next: { Yes: 'onboardingUpdateUserProfile', No: 'changeName' }
    },

    {
      key: 'changeName',
      kind: 'ask',
      accept: 'text',
      prompt: messages.onboarding.changeName.question,
      set: (context, name) => {
        context.onboarding.name = name;
      },
      next: [{ when: (context) => context.onboarding.name, to: 'onboardingNameConfirmation' }]
    },

    {
      key: 'onboardingNameConfirmation',
      kind: 'choose',
      options: ['Yes', 'No'],
      prompt: [{ bundle: messages.onboarding.onboardingNameConfirmation, delay: 1000 }],
      fill: { name: (context) => context.onboarding.name },
      next: {
        Yes: {
          to: 'onboardingUpdateUserProfile',
          set: (context) => {
            context.user.name = context.onboarding.name;
          }
        },
        No: 'changeName'
      }
    },

    {
      key: 'onboardingUpdateUserProfile',
      kind: 'call',
      invokeId: 'updateUserProfile',
      src: (context) =>
        userProfileService.updateUser(context.user, context.onboarding, context.extraInfo.tenantId),
      onDone: [
        {
          when: (context) => context.onboarding.name,
          to: 'onboardingThankYou',
          set: (context) => {
            context.user.name = context.onboarding.name;
            context.user.locale = context.onboarding.locale;
            context.onboarding = undefined;
          }
        },
        { to: 'onboardingThankYou' }
      ],
      onError: 'welcome'
    },

    {
      key: 'onboardingThankYou',
      kind: 'say',
      prompt: messages.onboarding.onboardingThankYou,
      next: 'pgr'
    },

    // --- chassis ------------------------------------------------------------

    {
      key: 'start',
      kind: 'gate',
      next: [
        { when: (context) => context.user.locale, to: 'welcome' },
        { to: 'onboarding' }
      ]
    },

    {
      key: 'preCondition',
      kind: 'goto',
      next: [
        { when: (context) => context.user.locale, to: 'invoke' },
        { to: 'onboarding' }
      ]
    },

    {
      key: 'invoke',
      kind: 'say',
      prompt: messages.welcome,
      fill: { name: (context) => context.user.name || 'Citizen' },
      next: 'pgr'
    },

    {
      key: 'endstate',
      kind: 'goto',
      next: 'start'
    },

    {
      key: 'system_error',
      kind: 'say',
      prompt: dialog.global_messages.system_error,
      next: {
        to: 'welcome',
        // event.data is undefined here: xstate resolves `always` transitions
        // under the null event, so the error.platform payload never arrives.
        // Faithful to the hand-written version; fixed separately.
        set: (context, event) => context.chatInterface.system_error(event.data)
      }
    }
  ]
};
