// A State that asks the citizen something and waits for their reply before
// branching: sends the prompt, waits for USER_MESSAGE, matches the reply
// against its options, then resolves the next state via the base class's branches.
// Options may be a static array or a function (called with context) for a
// runtime-computed list (e.g. offeredLocales()) — either way the resolved list
// is stored in context so a persisted/resumed session sees the same list it
// was shown, not a freshly recomputed one.
const { assign } = require('xstate');
const dialog = require('../util/dialog');
const State = require('./flow-state');
const config = require('../../env-variables');

class QuestionState extends State {
  // stores the choices this state offers: a static array (plain strings or
  // {value, label} objects), or a function(context) returning either
  setOptions(options) {
    this.options = options;
    return this;
  }

  // overrides the default "invalid option" message sent on an unrecognized reply
  setRetryMessage(prompt) {
    this.retryPrompt = prompt;
    return this;
  }

  // sets the state (and write) to use when the reply is unrecognized, instead
  // of retrying — e.g. defaulting a locale rather than re-asking
  setOnUnknown(state, set) {
    this.onUnknown = { state, set };
    return this;
  }

  // sends this question as a Twilio quick-reply template instead of text. key names
  // its SID in config.twilio.templates, read at send time; params (optional) is a
  // function(context) returning the {{1}}..{{n}} values in order.
  setTemplate(key, params) {
    this.template = { key, params };
    return this;
  }

  // the template message to send in place of the text prompt, or null when the
  // provider, the citizen's locale or a missing SID calls for plain text
  templateMessage(context) {
    const sid = this.template && ((config.twilio || {}).templates || {})[this.template.key];
    if (!sid) return null;
    if (config.whatsAppProvider !== 'Twilio') return null;
    if (!config.twilio.templatesEnabled) return null;
    if (context.user.locale !== config.twilio.templateLocale) return null;
    // Twilio rejects a template whose variable is empty
    const params = this.template.params
      ? this.template.params(context).map((value) => String(value || '-'))
      : [];
    return { type: 'template', output: sid, params };
  }


  get optionsSlot() { return this.key + 'Options'; }

  resolveOptions(context) {
    return typeof this.options === 'function' ? this.options(context) : (this.options || []);
  }

  renderOptionsList(options) {
    return options.map((option, i) => `*${i + 1}.* ${typeof option === 'object' ? option.label : option}`).join('\n');
  }

    // strips case and accents so a reply typed without diacritics still matches —
  // WhatsApp keyboards routinely drop them ("portugues" for "Português").
  normalizeReply(text) {
    return String(text ?? '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '');
  }

  // matches the reply against the resolved options stored in context — by number,
  // by value, or by the LABEL the citizen was actually shown — returning the plain
  // value (unwrapped from {value, label} if needed) so context.intention is always
  // a plain value
  matchReply(context, event) {
    const options = context[this.optionsSlot] || [];
    const input = this.normalizeReply(event.message.input);
    const index = /^\d+$/.test(input) ? Number(input) : NaN;
    const match = options.find((option, i) => {
      const value = typeof option === 'object' ? option.value : option;
      const label = typeof option === 'object' ? option.label : option;
      // Some prompts spell their choice as a sentence ("Manter os meus dados
      // confidenciais"), which nobody types — aliases are the short forms.
      const aliases = (typeof option === 'object' && option.aliases) || [];
      return i + 1 === index
        || this.normalizeReply(value) === input
        || this.normalizeReply(label) === input
        || aliases.some((alias) => this.normalizeReply(alias) === input);
    });
    if (!match) return null;
    return typeof match === 'object' ? match.value : match;
  }


  compileNode() {
    return {
      id: this.key,
      initial: 'question',
      states: {
        question: {
          entry: [
            assign((context) => { context[this.optionsSlot] = this.resolveOptions(context); }),
            (context, event) => {
              const fill = { options: () => this.renderOptionsList(context[this.optionsSlot] || []) };
              const template = this.templateMessage(context);
              if (!template) return this.enter(context, fill, event);
              // the citizen gets the buttons; the rendered text stays the resume prompt
              context.lastPrompt = this.renderText(this.prompt, { ...this.fill, ...fill }, context, event);
              dialog.sendMessage(context, template);
            }
          ],
          on: { USER_MESSAGE: 'process' }
        },
        process: {
          entry: assign((context, event) => {
            context.intention = this.matchReply(context, event);
          }),
          always: [
            { target: 'retry', cond: (context) => context.intention === null && !this.onUnknown },
            ...(this.onUnknown ? [{
              target: '#' + this.onUnknown.state.key,
              cond: (context) => context.intention === null,
              ...(this.onUnknown.set ? { actions: assign(this.onUnknown.set) } : {})
            }] : []),
            ...this.resolveBranches()
          ]
        },
        retry: {
          entry: (context) => {
            const text = dialog.get_message(this.retryPrompt || dialog.global_messages.error.retry, context.user.locale);
            dialog.sendMessage(context, text);
          },
          always: 'question'
        }

      }
    };
  }
}

module.exports = QuestionState;
