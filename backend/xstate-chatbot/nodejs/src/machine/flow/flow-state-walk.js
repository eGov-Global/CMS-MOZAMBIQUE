// A State that drills into a fetched hierarchy one level at a time: fetch the
// current level's options, show them (with an optional breadcrumb trail), and
// on reply either descend, go back, or land on a leaf. Reuses the real
// dialog.constructListPromptAndGrammer/get_intention so numbering and grammar
// match the production walk kind exactly.
const { assign } = require('xstate');
const dialog = require('../util/dialog');
const State = require('./flow-state');

class WalkState extends State {
  // async fn(context, path) -> {options, messageBundle, trailBundle, levelLabel, isLeafLevel}
  setFetch(fn) {
    this.fetch = fn;
    return this;
  }

  setOnError(state) {
    this.onError = state;
    return this;
  }

  setOnEmpty(state, set) {
    this.onEmpty = { state, set };
    return this;
  }

  setOnLeaf(state, set) {
    this.onLeaf = { state, set };
    return this;
  }

  // the breadcrumb-line template shown above the list (may contain a {{level}} token)
  setPreamble(bundle) {
    this.preamble = bundle;
    return this;
  }

  // if true, prepends the walked path as a breadcrumb trail above the preamble
  setTrail(trail) {
    this.trail = trail;
    return this;
  }

  // overrides the default "invalid option" message sent on an unrecognized reply
  setRetryMessage(prompt) {
    this.retryPrompt = prompt;
    return this;
  }

  get pathSlot() { return this.key + 'Path'; }
  get stepSlot() { return this.key + 'Step'; }
  get grammerSlot() { return this.key + 'Grammer'; }

  getPath(context) {
    return context[this.pathSlot] || [];
  }

  renderPreamble(context) {
    const { levelLabel, trailBundle } = context[this.stepSlot] || {};
    let text = this.preamble ? dialog.get_message(this.preamble, context.user.locale) : '';
    text = text.replace('{{level}}', levelLabel || '');
    
    if (this.trail) {
      const trail = this.getPath(context)
        .map((code) => (trailBundle && trailBundle[code] ? dialog.get_message(trailBundle[code], context.user.locale) : code))
        .join(' › ');
      if (trail) text = `*${trail}*\n${text}`;
    }
    return text;
  }

  compileNode() {
    return {
      id: this.key,
      initial: 'fetch',
      states: {
        fetch: {
          invoke: {
            src: (context) => this.fetch(context, this.getPath(context)),
            onDone: {
              target: 'evaluate',
              actions: assign((context, event) => { context[this.stepSlot] = event.data; })
            },
            onError: { target: '#' + this.onError.key }
          }
        },
        evaluate: {
          always: [
            {
              target: '#' + this.onEmpty.state.key,
              cond: (context) => ((context[this.stepSlot] || {}).options || []).length === 0,
              ...(this.onEmpty.set ? { actions: assign(this.onEmpty.set) } : {})
            },
            { target: 'question' }
          ]
        },
        question: {
          entry: assign((context) => {
            const { options, messageBundle } = context[this.stepSlot] || {};
            const goback = this.getPath(context).length > 0;
            const list = dialog.constructListPromptAndGrammer(options || [], messageBundle || {}, context.user.locale, false, goback);
            context[this.grammerSlot] = list.grammer;
            dialog.sendMessage(context, this.renderPreamble(context) + list.prompt);
          }),
          on: { USER_MESSAGE: 'process' }
        },
        process: {
          entry: assign((context, event) => {
            context.intention = dialog.get_intention(context[this.grammerSlot] || [], event, true);
          }),
          always: [
            {
              target: 'fetch',
              cond: (context) => context.intention === dialog.INTENTION_GOBACK,
              actions: assign((context) => { context[this.pathSlot] = this.getPath(context).slice(0, -1); })
            },
            {
              target: '#' + this.onLeaf.state.key,
              cond: (context) => context.intention !== dialog.INTENTION_UNKOWN && (context[this.stepSlot] || {}).isLeafLevel,
              actions: assign((context) => {
                context[this.pathSlot] = [...this.getPath(context), context.intention];
                if (this.onLeaf.set) this.onLeaf.set(context);
              })
            },
            {
              target: 'fetch',
              cond: (context) => context.intention !== dialog.INTENTION_UNKOWN,
              actions: assign((context) => { context[this.pathSlot] = [...this.getPath(context), context.intention]; })
            },
            { target: 'retry' }
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

module.exports = WalkState;
