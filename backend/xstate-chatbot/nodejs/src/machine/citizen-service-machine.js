// Combines shell-machine.js (onboarding + chassis) and pgr-machine.js
// (complaint filing) into one machine, splicing pgr.config into the shell's
// `pgr` slot. Live: required directly by state-machine.js.
const shell = require('./shell-machine');
const pgr = require('./pgr-machine');

const config = {
  id: 'citizenService',
  on: { USER_RESET: { target: '#welcome' } },
  ...shell.config,
  states: { ...shell.config.states, pgr: pgr.config }
};

module.exports = { config };
