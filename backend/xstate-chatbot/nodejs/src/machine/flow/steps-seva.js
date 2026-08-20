// onboardingLocale stays hand-written in seva.js: its options come from the
// localisation service at runtime, it has no error state (unknown input falls
// back to en_IN), and its prompt numbering format differs from
// constructListPromptAndGrammer's.
module.exports = {
  buildSteps: ({ messages, userProfileService }) => [
    {
      key: 'onboardingWelcome',
      id: 'onboardingWelcome',
      kind: 'say',
      prompt: messages.onboarding.onboardingWelcome,
      next: [
        { when: (context) => context.user.name, to: '#onBoardingUserProfileConfirmation' },
        { to: '#onboardingName' }
      ]
    },

    {
      key: 'onboardingName',
      id: 'onboardingName',
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
        { when: (context) => context.onboarding.name, to: '#onboardingNameConfirmation' },
        { to: '#onboardingUpdateUserProfile' }
      ]
    },

    {
      key: 'onBoardingUserProfileConfirmation',
      id: 'onBoardingUserProfileConfirmation',
      kind: 'choose',
      options: ['Yes', 'No'],
      prompt: [
        { bundle: messages.onboarding.nameInformation, delay: 3000, immediate: false },
        { bundle: messages.onboarding.onBoardingUserProfileConfirmation.question, delay: 4000 }
      ],
      fill: { name: (context) => context.user.name },
      next: { Yes: '#onboardingUpdateUserProfile', No: '#changeName' }
    },

    {
      key: 'changeName',
      id: 'changeName',
      kind: 'ask',
      accept: 'text',
      prompt: messages.onboarding.changeName.question,
      set: (context, name) => {
        context.onboarding.name = name;
      },
      next: [{ when: (context) => context.onboarding.name, to: '#onboardingNameConfirmation' }]
    },

    {
      key: 'onboardingNameConfirmation',
      id: 'onboardingNameConfirmation',
      kind: 'choose',
      options: ['Yes', 'No'],
      prompt: [{ bundle: messages.onboarding.onboardingNameConfirmation, delay: 1000 }],
      fill: { name: (context) => context.onboarding.name },
      next: {
        Yes: {
          to: '#onboardingUpdateUserProfile',
          set: (context) => {
            context.user.name = context.onboarding.name;
          }
        },
        No: '#changeName'
      }
    },

    {
      key: 'onboardingUpdateUserProfile',
      id: 'onboardingUpdateUserProfile',
      kind: 'call',
      invokeId: 'updateUserProfile',
      src: (context) =>
        userProfileService.updateUser(context.user, context.onboarding, context.extraInfo.tenantId),
      onDone: [
        {
          when: (context) => context.onboarding.name,
          to: '#onboardingThankYou',
          set: (context) => {
            context.user.name = context.onboarding.name;
            context.user.locale = context.onboarding.locale;
            context.onboarding = undefined;
          }
        },
        { to: '#onboardingThankYou' }
      ],
      onError: '#welcome'
    },

    {
      key: 'onboardingThankYou',
      id: 'onboardingThankYou',
      kind: 'say',
      prompt: messages.onboarding.onboardingThankYou,
      next: '#pgr'
    }
  ]
};
