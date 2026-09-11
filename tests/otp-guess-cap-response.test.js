/*
 * What the OTP guess cap SAYS — utils/response.js otpGuessCapError.
 *
 * tests/otp-attempt-cap.test.js proves the cap counts; this proves the user is
 * told. The login UIs render `error` verbatim and read the numbers from
 * `details`, so the sentence and the status are the contract:
 *   - a miss says how many attempts are left, at the status the route already
 *     used (change-phone has always answered 400);
 *   - the lock is a 429 that says when it lifts, with Retry-After;
 *   - a cap that is failing open changes nothing — the route's old message runs.
 *
 * Runner: `node --test` (see npm test).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { otpGuessCapError } = require('../utils/response');

const sent = (r, status) => { const res = fakeRes(); otpGuessCapError(res, r, status); return res; };

function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: null, locals: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}

test('a miss says how many attempts are left', () => {
  const res = fakeRes();
  assert.ok(otpGuessCapError(res, { reason: 'OTP_MISMATCH', attemptsRemaining: 3 }));
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { success: false, error: 'Incorrect OTP. 3 attempts left.',
    details: { code: 'OTP_MISMATCH', attemptsRemaining: 3 } });
  assert.equal(res.headers['Retry-After'], undefined, 'a miss is not a lock');
});

test('one attempt left is singular', () => {
  assert.equal(sent({ reason: 'OTP_MISMATCH', attemptsRemaining: 1 }).body.error,
    'Incorrect OTP. 1 attempt left.');
});

test('a miss keeps the status the route already used', () => {
  const res = fakeRes();
  otpGuessCapError(res, { reason: 'OTP_MISMATCH', attemptsRemaining: 2 }, 400);
  assert.equal(res.statusCode, 400, 'change-phone answered a wrong code with 400 before the cap existed');
});

test('the lock is a 429 that says when it lifts', () => {
  const res = fakeRes();
  assert.ok(otpGuessCapError(res, { reason: 'OTP_ATTEMPTS_EXCEEDED', retryAfterMinutes: 25 }));
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['Retry-After'], '1500');
  assert.deepEqual(res.body, { success: false,
    error: 'Too many incorrect attempts. Please try again in 25 minutes.',
    details: { code: 'OTP_ATTEMPTS_EXCEEDED', retryAfterMinutes: 25 } });
  assert.equal(sent({ reason: 'OTP_ATTEMPTS_EXCEEDED', retryAfterMinutes: 1 }).body.error,
    'Too many incorrect attempts. Please try again in 1 minute.');
});

test('a lock with no known end still refuses, without inventing a time', () => {
  const res = fakeRes();
  otpGuessCapError(res, { reason: 'OTP_ATTEMPTS_EXCEEDED' });
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error, 'Too many incorrect attempts. Please try again later.');
  assert.equal(res.headers['Retry-After'], undefined);
});

test('anything else — including a cap failing open — is left to the route', () => {
  for (const r of [null, undefined, { reason: 'OTP_EXPIRED' }, { reason: 'OTP_MISMATCH' },
    { reason: 'OTP_MISMATCH', attemptsRemaining: null }]) {
    const res = fakeRes();
    assert.equal(otpGuessCapError(res, r), null, JSON.stringify(r));
    assert.equal(res.body, null, 'nothing may be sent');
  }
});
