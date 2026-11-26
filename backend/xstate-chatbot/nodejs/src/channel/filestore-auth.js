// Filestore needs a login (VAPT #223): Kong answers 401 to upload and
// /files/url calls without a token. The bot has no citizen session for these
// calls, so it uses its service account (USER_SERVICE_ACCOUNT_*), the same one
// egov-pgr.js uses. Filestore paths are RBAC-exempt at the gateway, so any
// valid token is enough.

function userService() {
  // Required lazily: channel modules are loaded early, and the session layer
  // requires the channel provider.
  return require('../session/user-service');
}

/** Headers for a filestore call. `fresh` drops the cached token first (after
 *  a 401: egov-user restart, token flush, password rotation). Never throws: a
 *  failed login yields no header, and the call reports Kong's 401 as before. */
async function filestoreAuthHeaders(fresh = false) {
  const svc = userService();
  if (fresh) {
    svc._serviceAccount = undefined;
    svc._serviceAccountExpiry = 0;
  }
  try {
    const account = await svc.getServiceAccount();
    return account && account.authToken ? { 'auth-token': account.authToken } : {};
  } catch (error) {
    console.error('Filestore: service account login failed:', error.message);
    return {};
  }
}

/** Runs `perform(headers)` with the service-account token, retrying once with
 *  a fresh token when the first answer is 401. `perform` returns a fetch
 *  Response or an axios response, or throws an axios error. */
async function withFilestoreAuth(perform) {
  const statusOf = (r) => (r && (r.status || (r.response && r.response.status))) || 0;
  let first;
  try {
    first = await perform(await filestoreAuthHeaders());
    if (statusOf(first) !== 401) return first;
  } catch (error) {
    if (statusOf(error) !== 401) throw error;
  }
  console.warn('Filestore: token rejected (401); re-authenticating and retrying once');
  return perform(await filestoreAuthHeaders(true));
}

module.exports = { filestoreAuthHeaders, withFilestoreAuth };
