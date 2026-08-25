/*
 * Client portal login — an UNKNOWN identifier must fail at step 1.
 *
 * The reported bug: entering an unregistered email sent you to the OTP screen,
 * and only the verify call said anything — as the raw string "USER_NOT_FOUND".
 * Two defects, one flow:
 *
 *   1. `POST /auth/login-otp` answers 200 with `delivered: false` for an
 *      unknown identifier (it is not an error; nothing was sent). Both web and
 *      mobile clients gate on that flag, so it is a CONTRACT, not an
 *      implementation detail — the first test pins it.
 *   2. `POST /auth/verify-otp` returned `r.reason` as the user-facing message,
 *      so reason codes reached the screen. Codes belong in the log.
 *
 * Handlers are invoked straight off the router stack, past validate(), so no
 * HTTP server or supertest dependency is needed.
 *
 * Runner: `node --test`.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

// findSpoc() finds nobody → the unknown-user path for both routes.
const fake = installFakePool([
  [/FROM tbl_client_contacts cc/i, []],
]);

const router = require('../routes/client/index');

function handlerFor(path, method) {
  const layer = router.stack.find((e) => e.route && e.route.path === path && e.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function res() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    cookie() { return this; },
  };
}

beforeEach(() => fake.reset());

test('login-otp reports delivered:false for an unknown identifier — the flag both clients gate on', async () => {
  const r = res();
  await handlerFor('/auth/login-otp', 'post')(
    { body: { identifier: 'nobody@example.com' } }, r, (e) => { throw e; },
  );

  assert.equal(r.statusCode, null, 'this is a 200 — nothing failed, nothing was sent');
  assert.equal(r.body.success, true);
  assert.equal(r.body.data.delivered, false,
    'the web + mobile login screens stop on !delivered; flipping this to true strands an unknown user on the OTP screen');
});

test('login-otp does NOT write an OTP row for an unknown identifier', async () => {
  await handlerFor('/auth/login-otp', 'post')(
    { body: { identifier: 'nobody@example.com' } }, res(), (e) => { throw e; },
  );
  const wrote = fake.calls.some((c) => /INSERT INTO otp_details|UPDATE otp_details/i.test(c.sql));
  assert.equal(wrote, false, 'no SPOC matched, so there is nothing to send an OTP to');
});

test('verify-otp returns a SENTENCE, never the raw reason code', async () => {
  const r = res();
  await handlerFor('/auth/verify-otp', 'post')(
    { body: { identifier: 'nobody@example.com', otp: 1234 } }, r, (e) => { throw e; },
  );

  assert.equal(r.statusCode, 401);
  assert.equal(r.body.success, false);
  assert.doesNotMatch(r.body.error, /USER_NOT_FOUND|OTP_MISMATCH|OTP_EXPIRED|NO_OTP_ISSUED/,
    'a reason code on screen is the bug this test exists for');
  assert.match(r.body.error, /registered/i, 'and it should say something a person can act on');
});
