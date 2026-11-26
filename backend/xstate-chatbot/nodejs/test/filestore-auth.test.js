// Filestore calls carry the service-account token (VAPT #223).
const test = require('node:test');
const assert = require('node:assert');

const userService = require('../src/session/user-service');
const { filestoreAuthHeaders, withFilestoreAuth } = require('../src/channel/filestore-auth');

function stubLogin(tokens) {
  let n = 0;
  userService._serviceAccount = undefined;
  userService._serviceAccountExpiry = 0;
  userService.loginServiceAccount = async () => {
    const t = tokens[Math.min(n++, tokens.length - 1)];
    if (t instanceof Error) throw t;
    userService._serviceAccount = { authToken: t, userInfo: {} };
    userService._serviceAccountExpiry = Date.now() + 60_000;
    return userService._serviceAccount;
  };
  return () => n;
}

test('sends the service-account token as auth-token', async () => {
  stubLogin(['tok-1']);
  assert.deepStrictEqual(await filestoreAuthHeaders(), { 'auth-token': 'tok-1' });
});

test('a failed login yields no header instead of throwing', async () => {
  stubLogin([new Error('down'), new Error('down'), new Error('down')]);
  assert.deepStrictEqual(await filestoreAuthHeaders(), {});
});

test('fetch-style 401 retries once with a fresh token', async () => {
  const logins = stubLogin(['stale', 'fresh']);
  const seen = [];
  const res = await withFilestoreAuth(async (auth) => {
    seen.push(auth['auth-token']);
    return { status: seen.length === 1 ? 401 : 200 };
  });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(seen, ['stale', 'fresh']);
  assert.strictEqual(logins(), 2);
});

test('axios-style 401 error retries once with a fresh token', async () => {
  stubLogin(['stale', 'fresh']);
  const seen = [];
  const res = await withFilestoreAuth(async (auth) => {
    seen.push(auth['auth-token']);
    if (seen.length === 1) {
      const e = new Error('Request failed with status code 401');
      e.response = { status: 401 };
      throw e;
    }
    return { status: 201, data: 'ok' };
  });
  assert.strictEqual(res.data, 'ok');
  assert.deepStrictEqual(seen, ['stale', 'fresh']);
});

test('other errors are not retried', async () => {
  stubLogin(['tok']);
  let calls = 0;
  await assert.rejects(
    withFilestoreAuth(async () => {
      calls++;
      const e = new Error('boom');
      e.response = { status: 500 };
      throw e;
    }),
    /boom/,
  );
  assert.strictEqual(calls, 1);
});
