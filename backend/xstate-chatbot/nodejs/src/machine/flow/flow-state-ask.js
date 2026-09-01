// A State that captures free-text input: sends the prompt, waits for a reply,
// validates it, writes it into context if valid, retries otherwise.
const { assign } = require('xstate');
const dialog = require('../util/dialog');
const State = require('./flow-state');

class AskState extends State {
  // validates the raw reply; return true if valid, or a string/bundle to show
  // as a custom retry message. Defaults to always valid.
  setValidate(fn) {
    this.validate = fn;
    return this;
  }

  // writes the valid reply into context, before branching
  setOnValid(fn) {
    this.onValid = fn;
    return this;
  }

  // overrides the default "invalid" message shown when validate returns false
  setRetryMessage(prompt) {
    this.retryPrompt = prompt;
    return this;
  }

  get validSlot() { return this.key + 'Valid'; }
  get retryMessageSlot() { return this.key + 'RetryMessage'; }

  compileNode() {
    return {
      id: this.key,
      initial: 'question',
      states: {
        question: {
          entry: (context) => this.enter(context),
          on: { USER_MESSAGE: 'process' }
        },
        process: {
          entry: assign((context, event) => {
            const input = String(event.message.input).trim();
            const verdict = this.validate ? this.validate(input) : true;
            context[this.validSlot] = verdict === true;
            context[this.retryMessageSlot] = verdict === true ? undefined : verdict;
            if (verdict === true && this.onValid) this.onValid(context, input);
          }),
          always: [
            { target: 'retry', cond: (context) => !context[this.validSlot] },
            ...this.resolveBranches()
          ]
        },
        retry: {
          entry: (context) => {
            const bundle = context[this.retryMessageSlot] || this.retryPrompt || dialog.global_messages.error.retry;
            const text = typeof bundle === 'string' ? bundle : dialog.get_message(bundle, context.user.locale);
            dialog.sendMessage(context, text);
          },
          always: 'question'
        }
      }
    };
  }
}

module.exports = AskState;
