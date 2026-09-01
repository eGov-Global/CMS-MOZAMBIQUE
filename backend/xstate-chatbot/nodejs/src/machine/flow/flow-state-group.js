// src/machine/flow/flow-state-group.js

// A named group of states, compiled into a compound XState node — lets steps
// nest under a shared parent (e.g. onboarding) without changing the steps
// themselves. Plays the role layout.js's wrappers/place mapping plays today.
class Group {
  constructor(key, states, initialKey) {
    this.key = key;
    this.states = states;
    this.initialKey = initialKey;
  }

  compileNode() {
    const config = { id: this.key, initial: this.initialKey, states: {} };
    for (const state of this.states) {
      config.states[state.key] = state.compileNode();
    }
    return config;
  }
}

module.exports = Group;
