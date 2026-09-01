// A State that asks the citizen something and waits for their reply before
// branching: sends the prompt, waits for USER_MESSAGE, matches the reply
// against its options, then resolves the next state via the base class's branches.
const { assign } = require('xstate');
const dialog = require('../util/dialog');
const State = require('./flow-state');

class QuestionState extends State {
  // stores the choices this state offers (plain strings, e.g. ['Yes', 'No'])
  setOptions(options) {
    this.options = options;
    return this;
  }

  // overrides the default "invalid option" message sent on an unrecognized reply
  setRetryMessage(prompt) {
    this.retryPrompt = prompt;
    return this;
  }

  // matches the user's reply against options (by number or case-insensitive text)
  matchReply(event) {
    const input = String(event.message.input).trim().toLowerCase();
    const index = parseInt(input, 10);
    return (this.options || []).find((option, i) =>
      i + 1 === index || String(option).toLowerCase() === input
    ) || null;
  }

  // records the match as context.intention, then resolves the next state
  getNextStateFromReply(context, event) {
    context.intention = this.matchReply(event);
    return this.resolveNextState(context);
  }

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
            context.intention = this.matchReply(event);
          }),
          always: [
            { target: 'retry', cond: (context) => context.intention === null },
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
