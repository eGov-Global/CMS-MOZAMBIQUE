// Combines shell-machine.js (onboarding + chassis) and pgr-machine.js
// (complaint filing) into one machine, matching how state-machine.js splices
// pgr.js into the shell's `pgr` slot today. Not wired into the running
// system - this is the migration candidate to compare against state-machine.js
// before any cutover.
const shell = require('./shell-machine');
const pgr = require('./pgr-machine');

const config = {
  id: 'citizenService',
  on: { USER_RESET: { target: '#welcome' } },
  ...shell.config,
  states: { ...shell.config.states, pgr: pgr.config }
};

module.exports = { config };
