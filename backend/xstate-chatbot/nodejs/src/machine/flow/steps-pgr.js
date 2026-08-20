const dialog = require('../util/dialog');
const moment = require('moment-timezone');

const wrappers = {
  'fileComplaint.type': { id: 'pgrType' },
  'fileComplaint.location': { id: 'location' },
  'fileComplaint.other': { id: 'other' }
};

module.exports = {
  wrappers,

  buildSteps: ({ messages, pgrService, localisationService, config }) => {
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

    return [
      {
        key: 'complaintType2Step',
        id: 'complaintType2Step',
        path: ['fileComplaint', 'type'],
        first: true,
        kind: 'walk',
        pathSlot: 'hierarchyPath',
        stepSlot: 'hierarchyStep',
        invokeId: 'fetchComplaintHierarchyStep',
        fetch: (context, hierarchyPath) =>
          pgrService.fetchComplaintHierarchyStep(context.extraInfo.tenantId, hierarchyPath),
        preamble: messages.fileComplaint.complaintType2Step.level.question.preamble,
        trail: true,
        onLeaf: { slot: 'complaint', to: '#other' }
      },

      {
        key: 'boundary',
        id: 'boundary',
        path: ['fileComplaint', 'location'],
        first: true,
        kind: 'walk',
        pathSlot: 'boundaryPath',
        stepSlot: 'boundaryStep',
        invokeId: 'fetchBoundaryStep',
        fetch: (context, boundaryPath) =>
          pgrService.fetchBoundaryStep(context.extraInfo.tenantId, boundaryPath),
        preamble: messages.fileComplaint.boundary.question.preamble,
        onLeaf: {
          slot: 'locality',
          to: '#consent',
          set: (context) => {
            context.slots.pgr.city = context.extraInfo.tenantId;
          }
        },
        onEmpty: {
          slot: 'locality',
          to: '#consent',
          set: (context) => {
            context.slots.pgr.city = context.extraInfo.tenantId;
          }
        }
      },

      {
        key: 'menu',
        id: 'pgrMenu',
        kind: 'choose',
        options: ['fileComplaint', 'trackComplaint'],
        prompt: messages.menu.question,
        next: { fileComplaint: '#fileComplaint', trackComplaint: '#trackComplaint' }
      },

      {
        key: 'institution',
        id: 'institution',
        path: ['fileComplaint', 'other'],
        first: true,
        kind: 'ask',
        accept: 'text',
        prompt: messages.fileComplaint.institution.question,
        fill: { maxLength: config.instituteNameMaxLength },
        slot: 'instituteName',
        validate: (name) =>
          name.length === 0
            ? false
            : name.length > config.instituteNameMaxLength
              ? messages.fileComplaint.institution.tooLong
              : true,
        next: '#description'
      },

      {
        key: 'description',
        id: 'description',
        path: ['fileComplaint', 'other'],
        kind: 'ask',
        accept: 'text',
        prompt: messages.fileComplaint.description.question,
        fill: { minLength: config.descriptionMinLength },
        slot: 'description',
        validate: (text) =>
          text.length >= config.descriptionMinLength ? true : messages.fileComplaint.description.tooShort,
        next: '#imageUpload'
      },

      {
        key: 'imageUpload',
        id: 'imageUpload',
        path: ['fileComplaint', 'other'],
        kind: 'ask',
        accept: ['image', 'document'],
        optional: true,
        prompt: messages.fileComplaint.imageUpload.question,
        slot: 'image',
        next: '#location'
      },

      {
        key: 'consent',
        id: 'consent',
        path: ['fileComplaint'],
        kind: 'choose',
        options: ['Yes', 'No'],
        prompt: messages.fileComplaint.consent.question,
        fill: { statements: consentStatements },
        next: { Yes: '#confidentiality', No: '#consentDeclined' }
      },

      {
        key: 'consentDeclined',
        id: 'consentDeclined',
        path: ['fileComplaint'],
        kind: 'say',
        prompt: messages.fileComplaint.consent.declined,
        next: '#endstate'
      },

      {
        key: 'confidentiality',
        id: 'confidentiality',
        path: ['fileComplaint'],
        kind: 'choose',
        options: ['Yes', 'No'],
        prompt: messages.fileComplaint.confidentiality.question,
        fill: {
          label: messages.fileComplaint.confidentiality.label,
          hint: messages.fileComplaint.confidentiality.hint
        },
        slot: 'isConfidential',
        value: (intention) => intention === 'Yes',
        next: { Yes: '#persistComplaint', No: '#persistComplaint' }
      },

      {
        key: 'persistComplaint',
        id: 'persistComplaint',
        path: ['fileComplaint'],
        kind: 'call',
        invokeId: 'persistComplaint',
        src: (context) => pgrService.persistComplaint(context.user, context.slots.pgr, context.extraInfo),
        onDone: [
          {
            message: messages.fileComplaint.persistComplaint,
            fill: {
              1: receiptCategory,
              2: (context, event) => (event.data && event.data.complaintNumber) || '-',
              3: () => moment().tz(config.timeZone).format(config.dateFormat)
            },
            to: '#endstate'
          }
        ]
      },

      {
        key: 'trackComplaint',
        id: 'trackComplaint',
        kind: 'call',
        invokeId: 'fetchOpenComplaints',
        src: (context) => pgrService.fetchOpenComplaints(context.user, context.extraInfo),
        onDone: [
          {
            when: (context, event) => Array.isArray(event.data) && event.data.length > 0,
            message: complaintList,
            to: '#endstate'
          },
          { message: messages.trackComplaint.noRecords, to: '#endstate' }
        ]
      }
    ];
  }
};
