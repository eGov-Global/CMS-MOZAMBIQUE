const { Machine, assign } = require("xstate");
const pgr = require("./pgr");
const userProfileService = require("./service/egov-user-profile");
const emailTenantService = require("./service/email-tenant-service");
const config = require("../env-variables");
const dialog = require("./util/dialog.js");

const localisationService = require("./util/localisation-service");
const legacyOrganizationStates = require("./flow/legacy-organization");
const { buildSteps } = require("./flow/steps-seva");
const { generate, mergeStates, assertTargets } = require("./flow/generate");

const localeOptions = () => {
  const renderable = Object.keys(messages.onboarding.onboardingWelcome).filter((k) => k !== 'code');
  const offered = localisationService.getLocales().filter((l) => renderable.includes(l.value));
  return offered.length ? offered : [{ value: "en_IN", label: "ENGLISH" }];
};

const localeMenuText = () =>
  dialog
    .get_message(messages.onboarding.localeMenu, localisationService.getLocales()[0]?.value)
    .replace('{{options}}', localeOptions().map((l, i) => `${i + 1}.   ${l.label}`).join("\n"));

const localeGrammer = () =>
  localeOptions().map((l, i) => ({
    intention: l.value,
    recognize: [
      String(i + 1),
      l.label.toLowerCase(),
      l.label.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "")
    ]
  }));

const sevaConfig = {
  id: "mseva",
  initial: "start",
  on: {
    USER_RESET: {
      target: "#welcome",
      // actions: assign( (context, event) => dialog.sendMessage(context, dialog.get_message(messages.reset, context.user.locale), false))
    },
  },
  states: {
    start: {
      on: {
        USER_MESSAGE: [
          {
            cond: (context) => context.user.locale,
            target: "#welcome",
          },
          {
            target: "#onboarding",
          },
        ],
      },
    },
    onboarding: {
      id: "onboarding",
      initial: "onboardingLocale",
      states: {
        onboardingLocale: {
          id: "onboardingLocale",
          initial: "question",
          states: {
            question: {
              onEntry: assign((context, event) => {
                context.onboarding = {};
                let message = localeMenuText();
                context.grammer = localeGrammer();
                var templateContent = {
                  output: "3797433",
                  type: "template",
                };
                //dialog.sendMessage(context, templateContent, true);
                dialog.sendMessage(context, message, true);
              }),
              on: {
                USER_MESSAGE: "process",
              },
            },
            process: {
              onEntry: assign((context, event) => {
                if (dialog.validateInputType(event, "text"))
                  context.intention = dialog.get_intention(
                    context.grammer,
                    event,
                    true
                  );
                else context.intention = dialog.INTENTION_UNKOWN;
                if (context.intention != dialog.INTENTION_UNKOWN) {
                  context.user.locale = context.intention;
                } else {
                  context.user.locale = "en_IN";
                }
                context.onboarding.locale = context.user.locale;
              }),
              always: "#onboardingWelcome"
            },
          },
        },
      },
    },
    welcome: {
      id: "welcome",
      initial: "preCondition",
      states: {
        preCondition: {
          always: [
            {
              target: "invoke",
              cond: (context) => context.user.locale,
            },
            {
              target: "#onboarding",
            },
          ],
        },
        invoke: {
          onEntry: assign((context, event) => {
            var message = dialog.get_message(
              messages.welcome,
              context.user.locale
            );
            let name = "Citizen";
            if (context.user.name) {
              message = message.replace("{{name}}", context.user.name);
              name = context.user.name;
            } else {
              message = message.replace("{{name}}", "Citizen");
              name = "Citizen";
            }
            let params = [];
            params.push(name);

            var templateContent = {
              output: "3797437",
              type: "template",
              params: params,
            };
            //dialog.sendMessage(context, templateContent, true);
            dialog.sendMessage(context, message, true);
          }),
          always: "#pgr",
        },
      },
    },
    pgr: pgr,
    endstate: {
      id: "endstate",
      always: "start",
      // type: 'final', //Another approach: Make it a final state so session manager kills this machine and creates a new one when user types again
      // onEntry: assign((context, event) => {
      //   dialog.sendMessage(context, dialog.get_message(messages.endstate, context.user.locale));
      // })
    },
    system_error: {
      id: "system_error",
      always: {
        target: "#welcome",
        actions: assign((context, event) => {
          let message = dialog.get_message(
            dialog.global_messages.system_error,
            context.user.locale
          );
          dialog.sendMessage(context, message, true);
          context.chatInterface.system_error(event.data);
        }),
      },
    },
  }, // states
}; // sevaConfig

let messages = {
  onboarding: {
    localeMenu: {
      code: 'chatbot.pgr.locale.question',
      en_IN: "To select the language simply type and send the number of the preferred option  👇\n\n{{options}}",
      pt_PT: "Para escolher o idioma, escreva e envie o número da opção pretendida 👇\n\n{{options}}",
    },
    onboardingWelcome: {
      code: 'chatbot.pgr.onboarding.welcome',
      en_IN:
        "Dear Citizen,\n\nWelcome to the eGov Whatsapp Chatbot experience 🙏\n\nNow you can file your complaint via WhatsApp.",
      pt_PT:
        "Estimado(a) Cidadão(ã),\n\nBem-vindo(a) ao chatbot eGov no WhatsApp 🙏\n\nJá pode apresentar a sua reclamação através do WhatsApp.",
    },
    email: {
      question: {
        en_IN: "Please enter your registered email address:",
        hi_IN: "कृपया अपना पंजीकृत ईमेल पता दर्ज करें:",
        pa_IN: "ਕਿਰਪਾ ਕਰਕੇ ਆਪਣਾ ਰਜਿਸਟਰਡ ਈਮੇਲ ਪਤਾ ਦਰਜ ਕਰੋ:"
      },
      invalidEmail: {
        en_IN: "❌ Email not found. Please check your email and try again.",
        hi_IN: "❌ ईमेल नहीं मिला। कृपया अपना ईमेल जांचें और पुनः प्रयास करें।",
        pa_IN: "❌ ਈਮੇਲ ਨਹੀਂ ਮਿਲਿਆ। ਕਿਰਪਾ ਕਰਕੇ ਆਪਣਾ ਈਮੇਲ ਜਾਂਚੋ ਅਤੇ ਦੁਬਾਰਾ ਕੋਸ਼ਿਸ਼ ਕਰੋ।"
      },
      userFound: {
        en_IN: "✅ Welcome back! How can I help you today?",
        hi_IN: "✅ स्वागत है! मैं आज आपकी कैसे मदद कर सकता हूं?",
        pa_IN: "✅ ਵਾਪਸੀ ਦਾ ਸਵਾਗਤ! ਮੈਂ ਅੱਜ ਤੁਹਾਡੀ ਕਿਵੇਂ ਮਦਦ ਕਰ ਸਕਦਾ ਹਾਂ?"
      },
      notRegistered: {
        en_IN: "❌ Your number is not registered with *{{organizationName}}*.\n\n👉 Complete your registration:\n{{registrationUrl}}\n\nAfter registration, type *Hi* to continue.",
        hi_IN: "❌ आपका नंबर *{{organizationName}}* के साथ पंजीकृत नहीं है।\n\n👉 अपना पंजीकरण पूरा करें:\n{{registrationUrl}}\n\nपंजीकरण के बाद, जारी रखने के लिए *Hi* टाइप करें।",
        pa_IN: "❌ ਤੁਹਾਡਾ ਨੰਬਰ *{{organizationName}}* ਨਾਲ ਰਜਿਸਟਰਡ ਨਹੀਂ ਹੈ।\n\n👉 ਆਪਣੀ ਰਜਿਸਟ੍ਰੇਸ਼ਨ ਪੂਰੀ ਕਰੋ:\n{{registrationUrl}}\n\nਰਜਿਸਟ੍ਰੇਸ਼ਨ ਤੋਂ ਬਾਅਦ, ਜਾਰੀ ਰੱਖਣ ਲਈ *Hi* ਟਾਈਪ ਕਰੋ।"
      }
    },
    organizationCode: {
      question: {
        en_IN: "Please enter your organization code to continue.\n\n👉 The organization code is provided by your organization administrator.",
        hi_IN: "जारी रखने के लिए कृपया अपना संगठन कोड दर्ज करें।\n\n👉 संगठन कोड आपके संगठन व्यवस्थापक द्वारा प्रदान किया गया है।",
        pa_IN: "ਜਾਰੀ ਰੱਖਣ ਲਈ ਕਿਰਪਾ ਕਰਕੇ ਆਪਣਾ ਸੰਗਠਨ ਕੋਡ ਦਰਜ ਕਰੋ।\n\n👉 ਸੰਗਠਨ ਕੋਡ ਤੁਹਾਡੇ ਸੰਗਠਨ ਪ੍ਰਸ਼ਾਸਕ ਦੁਆਰਾ ਪ੍ਰਦਾਨ ਕੀਤਾ ਗਿਆ ਹੈ।"
      },
      invalidCode: {
        en_IN: "The organization code you entered is not valid. Please check and enter the correct organization code.",
        hi_IN: "आपके द्वारा दर्ज किया गया संगठन कोड मान्य नहीं है। कृपया जांचें और सही संगठन कोड दर्ज करें।",
        pa_IN: "ਤੁਹਾਡੇ ਦੁਆਰਾ ਦਰਜ ਕੀਤਾ ਗਿਆ ਸੰਗਠਨ ਕੋਡ ਵੈਧ ਨਹੀਂ ਹੈ। ਕਿਰਪਾ ਕਰਕੇ ਜਾਂਚ ਕਰੋ ਅਤੇ ਸਹੀ ਸੰਗਠਨ ਕੋਡ ਦਰਜ ਕਰੋ।"
      },
      notRegistered: {
        en_IN: "You are not registered with organization *{{organizationName}}*.\n\n👉 Please register first using the link below:\n{{registrationUrl}}\n\n👉 After registration, send *Hi* to start again.",
        hi_IN: "आप संगठन *{{organizationName}}* के साथ पंजीकृत नहीं हैं।\n\n👉 कृपया पहले नीचे दिए गए लिंक का उपयोग करके पंजीकरण करें:\n{{registrationUrl}}\n\n👉 पंजीकरण के बाद, फिर से शुरू करने के लिए *Hi* भेजें।",
        pa_IN: "ਤੁਸੀਂ ਸੰਗਠਨ *{{organizationName}}* ਨਾਲ ਰਜਿਸਟਰਡ ਨਹੀਂ ਹੋ।\n\n👉 ਕਿਰਪਾ ਕਰਕੇ ਪਹਿਲਾਂ ਹੇਠਾਂ ਦਿੱਤੇ ਲਿੰਕ ਦੀ ਵਰਤੋਂ ਕਰਕੇ ਰਜਿਸਟਰ ਕਰੋ:\n{{registrationUrl}}\n\n👉 ਰਜਿਸਟ੍ਰੇਸ਼ਨ ਤੋਂ ਬਾਅਦ, ਦੁਬਾਰਾ ਸ਼ੁਰੂ ਕਰਨ ਲਈ *Hi* ਭੇਜੋ।"
      }
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
      "Dear {{name}},\n\nWelcome to eGov WhatsApp chatbot 🙏.\n\nYou can now file your complaint via WhatsApp.\n",
    pt_PT:
      "Estimado(a) {{name}},\n\nBem-vindo(a) ao chatbot eGov no WhatsApp 🙏.\n\nJá pode apresentar a sua reclamação através do WhatsApp.\n",
  },
};

let grammer = {
  confirmation: {
    choice: [
      { intention: "Yes", recognize: ["1", "yes", "Yes"] },
      { intention: "No", recognize: ["2", "no", "No"] },
    ],
  },
};

mergeStates(
  sevaConfig.states.onboarding.states,
  generate(buildSteps({ messages, userProfileService }))
);
Object.assign(
  sevaConfig.states.onboarding.states,
  legacyOrganizationStates({ messages, emailTenantService })
);

assertTargets(sevaConfig.states);

const sevaMachine = Machine(sevaConfig);

module.exports = sevaMachine;
