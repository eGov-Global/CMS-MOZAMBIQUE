// One node in a citizen conversation flow: what message it sends on entry,
// and (via branches) which state comes next. compileNode() turns it into an
// XState node; subclasses (QuestionState, ProcessingState) override it for
// question-and-wait and async-call behavior.
const { assign } = require('xstate');
const dialog = require('../util/dialog');

class State {
  constructor(key) {
    this.key = key;
    this.prompt = null;
    this.branches = [];
  }

  // sets the message sent to the citizen when this state is entered
  setPrompt(prompt) {
    this.prompt = prompt;
    return this;
  }

  // sets the state to go to next, unconditionally; set (optional) writes to context
  setNext(state, set) {
    this.branches.push({ cond: null, state, set });
    return this;
  }

  // adds a guarded transition to the next state when cond is true; set (optional)
  // writes to context. Chain multiple times for 3+ branches, then close with setNext.
  setConditionalNext(state, cond, set) {
    this.branches.push({ cond, state, set });
    return this;
  }

  // walks the branches in order, returns the first whose cond passes (or has none)
  resolveNextState(context) {
    for (const branch of this.branches) {
      if (!branch.cond || branch.cond(context)) return branch.state;
    }
    return null;
  }

  // sends the prompt's localized text to the citizen
  enter(context) {
    if (!this.prompt) return;
    const text = dialog.get_message(this.prompt, context.user.locale);
    dialog.sendMessage(context, text);
  }

  // builds the guarded transitions array for this state's branches, targeting by
  // absolute id so nested (question/process) states can reach top-level siblings
  resolveBranches() {
    return this.branches.map((branch) => ({
      target: '#' + branch.state.key,
      cond: branch.cond || undefined,
      ...(branch.set ? { actions: assign(branch.set) } : {})
    }));
  }

  // compiles this state into its XState node shape
  compileNode() {
    return {
      id: this.key,
      entry: (context) => this.enter(context),
      always: this.resolveBranches()
    };
  }
}

module.exports = State;
