// Values for a Twilio template's {{1}}..{{n}}, in the shape Meta accepts. A
// variable may not contain a line break (or a run of spaces), and Twilio rejects
// an empty one, so a citizen's multi-line description is flattened onto one
// line, capped, and a missing value is sent as '-'.
const TEMPLATE_PARAM_MAX_LENGTH = 500;

function templateParams(values) {
  return values.map((value) => {
    const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!flat) return '-';
    // by code point, so an emoji is never cut in half
    const chars = Array.from(flat);
    return chars.length > TEMPLATE_PARAM_MAX_LENGTH
      ? chars.slice(0, TEMPLATE_PARAM_MAX_LENGTH - 1).join('') + '…'
      : flat;
  });
}

module.exports = { templateParams, TEMPLATE_PARAM_MAX_LENGTH };
