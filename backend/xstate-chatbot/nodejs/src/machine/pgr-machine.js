// Migration port of pgr-states.js/pgr-transitions.js (the complaint-filing
// journey) to the class-based flow authoring in flow/flow-state*.js. Not
// wired into the running system - pgr.js still builds the original machine.
// `endstate`/`system_error` are placeholders shared with shell-machine.js's
// chassis; both ports will target the same real states once merged.
const { assign } = require('xstate');
const dialog = require('./util/dialog');
const moment = require('moment-timezone');

const State = require('./flow/flow-state');
const QuestionState = require('./flow/flow-state-question');
const AskState = require('./flow/flow-state-ask');
const ProcessingState = require('./flow/flow-state-processing');
const WalkState = require('./flow/flow-state-walk');
const Group = require('./flow/flow-state-group');
const compile = require('./flow/flow-state-compiler');

const config = require('../env-variables');
const messages = require('./flow/pgr-messages');
const localisationService = require('./util/localisation-service');
const { pgrService } = require('./service/service-loader');

const consentStatements = (context) =>
  [messages.fileComplaint.consent.dataProcessing, messages.fileComplaint.consent.truthfulness]
    .map((bundle) => dialog.get_message(bundle, context.user.locale))
    .filter(Boolean)
    .map((statement) => `• ${statement}`)
    .join('\n');

const receiptCategory = (context) => {
  const code = (context.slots.pgr.hierarchyPath || [])[0] || context.slots.pgr.complaint;
  const bundle = code
    ? localisationService.getMessageBundleForCode('COMPLAINT_HIERARCHY.' + String(code).toUpperCase())
    : undefined;
  return (bundle && dialog.get_message(bundle, context.user.locale)) || code || '-';
};

const complaintList = (context, event) => {
  const locale = context.user.locale;
  let message = dialog.get_message(messages.trackComplaint.results.preamble, locale);
  for (const complaint of event.data) {
    message += '\n\n' + dialog.get_message(messages.trackComplaint.results.complaintTemplate, locale)
      .replace('{{complaintType}}', complaint.complaintType || 'Complaint')
      .replace('{{complaintNumber}}', complaint.complaintNumber || 'N/A')
      .replace('{{filedDate}}', complaint.filedDate || 'N/A')
      .replace('{{complaintStatus}}', complaint.complaintStatus || 'N/A');
  }
  return message + dialog.get_message(messages.trackComplaint.results.closingStatement, locale);
};

// the boundary walk records which city the complaint belongs to, whichever way it finishes
const recordCity = (context) => { context.slots.pgr.city = context.extraInfo.tenantId; };

// -- steps ----------------------------------------------------------------

const menu = new QuestionState('menu');
const complaintType2Step = new WalkState('complaintType2Step');
const boundary = new WalkState('boundary');
const institution = new AskState('institution');
const description = new AskState('description');
const imageUpload = new AskState('imageUpload');
const consent = new QuestionState('consent');
const consentDeclined = new State('consentDeclined');
const confidentiality = new QuestionState('confidentiality');
const persistComplaint = new ProcessingState('persistComplaint');
const trackComplaint = new ProcessingState('trackComplaint');

// chassis placeholders - real states live in shell-machine.js
const endstate = new State('endstate');
const system_error = new State('system_error');

// -- groups (fileComplaint.type/location/other, matching layout.js) -------

const typeGroup = new Group('type', [complaintType2Step], 'complaintType2Step');
const locationGroup = new Group('location', [boundary], 'boundary');
const otherGroup = new Group('other', [institution, description, imageUpload], 'institution');

const fileComplaintGroup = new Group(
  'fileComplaint',
  [typeGroup, locationGroup, otherGroup, consent, consentDeclined, confidentiality, persistComplaint],
  'type'
);

// -- wiring -----------------------------------------------------------

menu
  .setPrompt(messages.menu.question)
  .setOptions(['fileComplaint', 'trackComplaint'])
  .setConditionalNext(fileComplaintGroup, (context) => context.intention === 'fileComplaint')
  .setNext(trackComplaint);

complaintType2Step
  .setPreamble(messages.fileComplaint.complaintType2Step.level.question.preamble)
  .setTrail(true)
  .setFetch((context, path) => pgrService.fetchComplaintHierarchyStep(context.extraInfo.tenantId, path))
  .setOnError(system_error)
  .setOnLeaf(otherGroup, { slot: 'complaint' });

boundary
  .setPreamble(messages.fileComplaint.boundary.question.preamble)
  .setFetch((context, path) => pgrService.fetchBoundaryStep(context.extraInfo.tenantId, path))
  .setOnError(system_error)
  .setOnLeaf(consent, { slot: 'locality', set: recordCity })
  .setOnEmpty(consent, { slot: 'locality', set: recordCity });

institution
  .setPrompt(messages.fileComplaint.institution.question)
  .setFill({ maxLength: config.instituteNameMaxLength })
  .setValidate((name) =>
    name.length === 0
      ? false
      : name.length > config.instituteNameMaxLength
        ? messages.fileComplaint.institution.tooLong
        : true)
  .setOnValid((context, name) => { context.slots.pgr.instituteName = name; })
  .setNext(description);

description
  .setPrompt(messages.fileComplaint.description.question)
  .setFill({ minLength: config.descriptionMinLength })
  .setValidate((text) => text.length >= config.descriptionMinLength ? true : messages.fileComplaint.description.tooShort)
  .setOnValid((context, text) => { context.slots.pgr.description = text; })
  .setNext(imageUpload);

imageUpload
  .setPrompt(messages.fileComplaint.imageUpload.question)
  .setAccept(['image', 'document'])
  .setOptional(true)
  .setOnValid((context, input) => { context.slots.pgr.image = input; })
  .setNext(locationGroup);

consent
  .setPrompt(messages.fileComplaint.consent.question)
  .setFill({ statements: consentStatements })
  .setOptions(['Yes', 'No'])
  .setConditionalNext(confidentiality, (context) => context.intention === 'Yes')
  .setNext(consentDeclined);

consentDeclined
  .setPrompt(messages.fileComplaint.consent.declined)
  .setNext(endstate);

confidentiality
  .setPrompt(messages.fileComplaint.confidentiality.question)
  .setFill({ label: messages.fileComplaint.confidentiality.label, hint: messages.fileComplaint.confidentiality.hint })
  .setOptions(['Yes', 'No'])
  .setConditionalNext(persistComplaint, (context) => context.intention === 'Yes', (context) => { context.slots.pgr.isConfidential = true; })
  .setNext(persistComplaint, (context) => { context.slots.pgr.isConfidential = false; });

persistComplaint
  .setProcessing((context) => pgrService.persistComplaint(context.user, context.slots.pgr, context.extraInfo))
  .setNext(endstate)
  .setOutcomeMessage(messages.fileComplaint.persistComplaint, {
    1: receiptCategory,
    2: (context, event) => (event.data && event.data.complaintNumber) || '-',
    3: () => moment().tz(config.timeZone).format(config.dateFormat)
  });

trackComplaint
  .setProcessing((context) => pgrService.fetchOpenComplaints(context.user, context.extraInfo))
  .setConditionalNext(endstate, (context, event) => Array.isArray(event.data) && event.data.length > 0)
  .setOutcomeMessage(complaintList)
  .setNext(endstate)
  .setOutcomeMessage(messages.trackComplaint.noRecords);

const pgrConfig = {
  id: 'pgr',
  entry: assign((context) => { context.slots.pgr = {}; context.pgr = { slots: {} }; }),
  ...compile([menu, fileComplaintGroup, trackComplaint, endstate, system_error], 'menu')
};

module.exports = {
  config: pgrConfig,
  states: { menu, complaintType2Step, boundary, institution, description, imageUpload,
    consent, consentDeclined, confidentiality, persistComplaint, trackComplaint,
    endstate, system_error, fileComplaintGroup, typeGroup, locationGroup, otherGroup }
};
