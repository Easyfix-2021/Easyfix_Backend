/*
 * PER-IP CEILINGS ON THE CRM LOGIN — routes/auth.js.
 *
 * POST /api/auth/login-otp and /verify-otp had no limit: a script could request
 * codes (SMS/email we pay for) and submit guesses across accounts as fast as the
 * network allows. Now 100 code requests and 200 verifies per IP per 10 minutes,
 * checked before validation. Pinned here, through the real router:
 *   - the ceiling refuses with a sentence the login page can show and a
 *     Retry-After, and only past the ceiling;
 *   - it is PER IP, resolved as server.js resolves it (`trust proxy` 1), so one
 *     noisy source does not lock the rest of the office out;
 *   - the two routes have separate budgets.
 * The auth service is stubbed: nothing is sent and no database is touched.
 *
 * Runner: `node --test` (see npm test).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([]);
const authSvcPath = require.resolve('../services/auth.service');
require.cache[authSvcPath] = {
  id: authSvcPath, filename: authSvcPath, loaded: true,
  exports: {
    createLoginOtp: async () => ({ delivered: true, expiresAt: null }),
    verifyLoginOtp: async () => ({ ok: false, reason: 'OTP_MISMATCH' }),
  },
};

let server;
let base;
before(async () => {
  const app = express();
  app.set('trust proxy', 1);             // exactly as server.js
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/api/auth`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  if (fake.restore) fake.restore();
});

const post = (path, ip, body) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
  body: JSON.stringify(body),
});
const LOGIN = { identifier: 'someone@easyfix.in' };
const VERIFY = { identifier: 'someone@easyfix.in', otp: 1234 };

test('login-otp: 100 per IP pass, the 101st is refused with a sentence and Retry-After', async () => {
  for (let i = 0; i < 100; i++) {
    const r = await post('/login-otp', '203.0.113.10', LOGIN);
    assert.notEqual(r.status, 429, `request ${i + 1} is within the ceiling`);
  }
  const over = await post('/login-otp', '203.0.113.10', LOGIN);
  assert.equal(over.status, 429);
  assert.ok(Number(over.headers.get('retry-after')) > 0);
  const body = await over.json();
  assert.match(body.error, /Too many sign-in attempts/, 'the CRM login shows `error` verbatim');
});

test('the ceiling is per IP — another address is unaffected', async () => {
  const r = await post('/login-otp', '203.0.113.11', LOGIN);
  assert.notEqual(r.status, 429);
});

test('verify-otp has its own budget: 200 per IP, then refused', async () => {
  // 203.0.113.10 has spent its login-otp budget above; verify is separate.
  for (let i = 0; i < 200; i++) {
    const r = await post('/verify-otp', '203.0.113.10', VERIFY);
    assert.notEqual(r.status, 429, `verify ${i + 1} is within the ceiling`);
  }
  const over = await post('/verify-otp', '203.0.113.10', VERIFY);
  assert.equal(over.status, 429);
  assert.match((await over.json()).error, /Too many sign-in attempts/);
});

test('the limiter runs before validation — malformed bodies spend the budget too', async () => {
  for (let i = 0; i < 100; i++) await post('/login-otp', '203.0.113.12', {});
  const over = await post('/login-otp', '203.0.113.12', {});
  assert.equal(over.status, 429, 'a flood of garbage is throttled like any other flood');
});
