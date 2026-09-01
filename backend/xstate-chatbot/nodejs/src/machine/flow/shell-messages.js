// Every citizen-facing string in the onboarding journey and the shell.
//
// `code` is a localisation key looked up live at send time; the locale entries
// below are the fallback used when the platform has no translation. Codes are
// external contracts — they exist nowhere else in this repo, so changing one
// silently stops translations resolving.
//
// Copy for the unreachable organization-code flow lives with that flow, in
// flow/legacy-organization.js.

module.exports = {
  onboarding: {
    localeMenu: {
      code: 'chatbot.pgr.locale.question',
      en_IN: "To select the language simply type and send the number of the preferred option  👇\n\n{{options}}",
      pt_PT: "Para escolher o idioma, escreva e envie o número da opção pretendida 👇\n\n{{options}}",
    },
    onboardingWelcome: {
      code: 'chatbot.pgr.onboarding.welcome',
      en_IN:
        "Dear Citizen,\n\nWelcome to the Fala Cidadao Whatsapp Chatbot experience 🙏\n\nNow you can file your complaint via WhatsApp.",
      pt_PT:
        "Estimado(a) Cidadão(ã),\n\nBem-vindo(a) ao chatbot do Fala Cidadão no WhatsApp 🙏\n\nJá pode apresentar a sua reclamação através do WhatsApp.",
    },
    onboardingName: {
      question: {
        code: 'chatbot.pgr.onboarding.name.question',
        en_IN:
          "As per our records, we have not found any name linked to this mobile number.\n\n👉  Please provide your name to continue.",
        pt_PT:
          "Nos nossos registos não encontrámos nenhum nome associado a este número.\n\n👉  Indique o seu nome para continuar.",
      },
    },
    onBoardingUserProfileConfirmation: {
      question: {
        code: 'chatbot.pgr.onboarding.name.confirmProfile',
        en_IN:
          "As per our records, we have found the name  *“{{name}}”* linked with this mobile number.\n\n👉  Type and send *1* to confirm the name.\n\n👉  Type and send *2* to change the name.",
        pt_PT:
          "Nos nossos registos, este número está associado ao nome  *“{{name}}”*.\n\n👉  Escreva e envie *1* para confirmar o nome.\n\n👉  Escreva e envie *2* para alterar o nome.",
      },
    },
    changeName: {
      question: {
        code: 'chatbot.pgr.onboarding.name.change',
        en_IN: "Please provide your name to continue.",
        pt_PT: "Indique o seu nome para continuar.",
      },
    },
    onboardingNameConfirmation: {
      code: 'chatbot.pgr.onboarding.name.confirm',
      en_IN:
        "Confirm Name : {{name}}?\n\n👉  Type and send *1* to confirm the name.\n\n👉  Type and send *2* to change the name.",
      pt_PT:
        "Confirmar o nome: {{name}}?\n\n👉  Escreva e envie *1* para confirmar o nome.\n\n👉  Escreva e envie *2* para alterar o nome.",
    },
    onboardingThankYou: {
      code: 'chatbot.pgr.onboarding.thankYou',
      en_IN:
        "Thanks for providing the confirmation 👍\nWe are happy to serve you 😊",
      pt_PT:
        "Obrigado pela confirmação 👍\nÉ um prazer servi-lo(a) 😊",
    },
    nameInformation: {
      code: 'chatbot.pgr.onboarding.nameInformation',
      en_IN:
        "For a personalized experience, we would like to confirm your name.",
      pt_PT:
        "Para um atendimento personalizado, gostaríamos de confirmar o seu nome.",
    },
  },
  welcome: {
    code: 'chatbot.pgr.welcome',
    en_IN:
      "Dear {{name}},\n\nWelcome to Fala Cidadao WhatsApp chatbot 🙏.\n\nYou can now file your complaint via WhatsApp.\n",
    pt_PT:
      "Estimado(a) {{name}},\n\nBem-vindo(a) ao chatbot Fala Cidadão no WhatsApp 🙏.\n\nJá pode apresentar a sua reclamação através do WhatsApp.\n",
  },
};
