// A State that drills into a fetched hierarchy one level at a time: fetch the
// current level's options, show them, and on reply either descend (fetch the
// next level), go back (pop to the previous level), or land on a leaf.
const { assign } = require('xstate');
const State = require('./flow-state');

class WalkState extends State {
  // async fn(context, path) -> {options, isLeafLevel}, fetching the current level
  // the function that fetches the current level's options
  setFetch(fn) {
    this.fetch = fn;
    return this;
  }

  // sets where to go if the fetch's promise rejects
  setOnError(state) {
    this.onError = state;
    return this;
  }

  // sets the state (and optional context write) to use when a fetch returns no options
  setOnEmpty(state, set) {
    this.onEmpty = { state, set };
    return this;
  }

  // sets the state (and optional context write) to use once a leaf option is picked
  setOnLeaf(state, set) {
    this.onLeaf = { state, set };
    return this;
  }

  // where this instance's walked path / fetched level live in context — derived
  // from the state's own key, so no separate slot names need declaring
  get pathSlot() { return this.key + 'Path'; }
  get stepSlot() { return this.key + 'Step'; }
  get matchSlot() { return this.key + 'Match'; }

  getPath(context) {
    return context[this.pathSlot] || [];
  }

  // matches a reply against the currently fetched level's options
  matchOption(context, event) {
    const options = (context[this.stepSlot] || {}).options || [];
    const input = String(event.message.input).trim().toLowerCase();
    if (input === 'back') return 'BACK';

    const index = parseInt(input, 10);
    return options.find((option, i) =>
      i + 1 === index || String(option).toLowerCase() === input
    ) || null;
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
          entry: (context) => this.enter(context),
          on: { USER_MESSAGE: 'process' }
        },
        process: {
          entry: assign((context, event) => {
            context[this.matchSlot] = this.matchOption(context, event);
          }),
          always: [
            {
              target: 'fetch',
              cond: (context) => context[this.matchSlot] === 'BACK',
              actions: assign((context) => { context[this.pathSlot] = this.getPath(context).slice(0, -1); })
            },
            {
              target: '#' + this.onLeaf.state.key,
              cond: (context) => context[this.matchSlot] && context[this.matchSlot] !== 'BACK' && (context[this.stepSlot] || {}).isLeafLevel,
              actions: assign((context) => {
                context[this.pathSlot] = [...this.getPath(context), context[this.matchSlot]];
                if (this.onLeaf.set) this.onLeaf.set(context);
              })
            },
            {
              target: 'fetch',
              cond: (context) => context[this.matchSlot] && context[this.matchSlot] !== 'BACK',
              actions: assign((context) => { context[this.pathSlot] = [...this.getPath(context), context[this.matchSlot]]; })
            },
            { target: 'question' }
          ]
        }
      }
    };
  }
}

module.exports = WalkState;
