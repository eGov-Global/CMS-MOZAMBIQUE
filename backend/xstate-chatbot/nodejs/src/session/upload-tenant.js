const sessionManager = require("./session-manager");
const userService = require("./user-service");

/**
 * Which tenant an inbound attachment should be stored against.
 *
 * Sandbox deployments store it against the tenant the citizen is registered
 * with; everywhere else this returns null and the channel adapter falls back to
 * the root tenant. Kept out of InboundMessageParser so that parsing stays free
 * of session and user-identity dependencies.
 */
function resolveUploadTenantId(req, config) {
  const body = (req && req.body) || {};
  const isUpload = !!(body.NumMedia && parseInt(body.NumMedia, 10) > 0);

  if (!config.isSandboxMode || !isUpload) {
    return null;
  }

  // The tracker is keyed by the same normalisation userService applies, so both
  // must agree — see sanitizeMobileNumber.
  const mobileNumber = userService.sanitizeMobileNumber(body.From);
  if (!mobileNumber) {
    return null;
  }

  const tenantId = sessionManager.getTenantForMobileNumber(mobileNumber);
  console.log(`Image upload detected for ${mobileNumber}, using tenant: ${tenantId || 'default'}`);
  return tenantId;
}

module.exports = { resolveUploadTenantId };
