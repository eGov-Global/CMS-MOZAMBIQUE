// The chatbot files WhatsApp complaints with its service account, so the
// workflow records that account as the APPLY actor (upstream CCRS#2503). It
// marks what it files with this service.source (xstate-chatbot egov-pgr.js);
// the employee form sends the channel of receipt (inperson, email, letter,
// linhaverde) and the citizen web flow sends "web".
export const CHATBOT_SOURCE = "whatsapp";

/**
 * The person the timeline's APPLY row shows instead of its recorded actor, or
 * null to keep the actor. Only a chatbot filing is substituted: the bot
 * account is nobody the reader can contact, so the row shows the complainant,
 * carrying their uuid so the masking and hiding rules treat it as the
 * complainant. An employee who registered a complaint on a citizen's behalf
 * stays on the row: that clerk is who filed it.
 */
export const chatbotFiler = (instance, { complaintSource, complainant, complainantUuid, isComplainant, citizenLabel }) =>
  instance?.action === "APPLY" &&
  complaintSource === CHATBOT_SOURCE &&
  complainantUuid &&
  instance?.assigner?.uuid &&
  !isComplainant(instance.assigner)
    ? { ...complainant, name: complainant?.name || citizenLabel, uuid: complainantUuid }
    : null;
