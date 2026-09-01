// A State that runs an async operation on entry (e.g. calling a backend
// service) and branches on whether it resolves or rejects — no prompt,
// no waiting on the citizen.
const State = require('./flow-state');

class ProcessingState extends State {
  // stores the async function to run when this state is entered
  setProcessing(fn) {
    this.processing = fn;
    return this;
  }

  // sets where to go if the processing function's promise rejects
  setOnError(state) {
    this.onError = state;
    return this;
  }

  compileNode() {
    return {
      id: this.key,
      invoke: {
        src: (context, event) => this.processing(context, event),
        onDone: this.resolveBranches(),
        onError: { target: '#' + this.onError.key }
      }
    };
  }
}

module.exports = ProcessingState;
