// Builds a Twilio list-picker message for an option list, or null when the list
// must stay plain text: another provider, another locale, no template for this
// many options, or a label over WhatsApp's 24-character item limit. The
// templates read "Etapa: {{1}}" then one item per {{2}}..{{n+1}} with ids 1..n,
// so a tap arrives as the option's number (ListId) and matches the same grammar
// a typed digit does.
const config = require('../../env-variables');

const ITEM_MAX_LENGTH = 24;

function listPickerMessage(context, stepLabel, labels) {
  const twilio = config.twilio || {};
  const sid = (twilio.listPickers || {})[labels.length];
  if (!sid) return null;
  if (config.whatsAppProvider !== 'Twilio') return null;
  if (!twilio.templatesEnabled) return null;
  if (context.user.locale !== twilio.templateLocale) return null;
  if (labels.some((label) => !label || label.length > ITEM_MAX_LENGTH)) return null;
  return { type: 'template', output: sid, params: [stepLabel || '-', ...labels] };
}

module.exports = { listPickerMessage };
