/*
 * THE GUESS CAP ON THE PROFILE / BANK-CHANGE OTP —
 * services/easyfixer-profile-otp.service.js verifyOtp.
 *
 * This 4-digit code gates the technician's profile update AND the change of
 * the bank account their pay goes to (services/easyfixer-sensitive-change).
 * It lives on tbl_easyfixer, not otp_details, so it had no cap at all when the
 * login OTP got one. Now: 5 attempts per technician per 30 minutes, kept in
 * memory (middleware/rate-limit.js attemptWindow) — the same rule, claimed
 * before the compare, cleared by a right code.
 *
 * The service takes an injected pool, so the real verifyOtp runs against a
 * fake one here: nothing touches a database.
 *
 * Runner: `node --test` (see npm test).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeFakePool } = require('./helpers/fake-pool');
const { otpGuessCapOutcome } = require('../utils/response');

const svc = require('../services/easyfixer-profile-otp.service');

// A code valid far into the future, as an IST wall-clock string (istIsPast).
const LIVE = { profile_update_otp: 4321, profile_update_otp_valid_up_to: '2099-01-01 00:00:00' };
function poolWith(row = LIVE, { slow = false } = {}) {
  return makeFakePool([
    [/SELECT profile_update_otp/, async () => {
      if (slow) await new Promise((r) => setImmediate(r));   // a real await, so calls interleave
      return [row];
    }],
  ]).pool;
}

test('each wrong code says how many are left; the 5th locks; then even the RIGHT code is refused', async () => {
  const pool = poolWith();
  for (let left = 4; left >= 1; left--) {
    const r = await svc.verifyOtp(501, 1111, pool);
    assert.deepEqual(r, { valid: false, reason: 'OTP_MISMATCH', attemptsRemaining: left });
  }
  const fifth = await svc.verifyOtp(501, 1111, pool);
  assert.equal(fifth.reason, 'OTP_ATTEMPTS_EXCEEDED');
  assert.equal(fifth.retryAfterMinutes, 30);
  const right = await svc.verifyOtp(501, 4321, pool);
  assert.equal(right.valid, false, 'a locked technician is refused without comparing');
  assert.equal(right.reason, 'OTP_ATTEMPTS_EXCEEDED');
});

test('the right code clears the count, and technicians are counted separately', async () => {
  const pool = poolWith();
  for (let i = 0; i < 4; i++) await svc.verifyOtp(502, 1111, pool);
  assert.equal((await svc.verifyOtp(503, 1111, pool)).attemptsRemaining, 4, 'another technician starts fresh');
  assert.equal((await svc.verifyOtp(502, 4321, pool)).valid, true);
  assert.equal((await svc.verifyOtp(502, 1111, pool)).attemptsRemaining, 4, 'a success opens a fresh window');
});

test('the lock lifts by itself after 30 minutes', async () => {
  const pool = poolWith();
  for (let i = 0; i < 5; i++) await svc.verifyOtp(504, 1111, pool);
  const realNow = Date.now;
  Date.now = () => realNow() + 31 * 60_000;
  try {
    assert.equal((await svc.verifyOtp(504, 4321, pool)).valid, true);
  } finally { Date.now = realNow; }
});

test('twenty parallel wrong codes are compared at most five times', async () => {
  const pool = poolWith(LIVE, { slow: true });
  const rs = await Promise.all(Array.from({ length: 20 }, () => svc.verifyOtp(505, 1111, pool)));
  const reasons = rs.map((r) => r.reason);
  assert.equal(reasons.filter((x) => x === 'OTP_MISMATCH').length, 4, reasons.join(','));
  assert.equal(reasons.filter((x) => x === 'OTP_ATTEMPTS_EXCEEDED').length, 16);
});

test('an expired or absent code is not a guess — it never counts', async () => {
  const expired = poolWith({ profile_update_otp: 4321, profile_update_otp_valid_up_to: '2000-01-01 00:00:00' });
  for (let i = 0; i < 10; i++) assert.equal((await svc.verifyOtp(506, 1111, expired)).valid, false);
  const none = poolWith({ profile_update_otp: null, profile_update_otp_valid_up_to: null });
  for (let i = 0; i < 10; i++) assert.equal((await svc.verifyOtp(506, 1111, none)).valid, false);
  assert.equal((await svc.verifyOtp(506, 4321, poolWith())).valid, true, 'none of those spent an attempt');
});

test('what the bank change throws: 400 "N attempts left", then 429 with the minutes', () => {
  // services/easyfixer-sensitive-change.service.js changeBank maps a failed
  // verifyOtp through otpGuessCapOutcome(result, 400); both routes that call it
  // (admin PATCH /:id/bank, mobile POST /bank-details) send e.status + e.message.
  assert.deepEqual(
    (({ status, error }) => ({ status, error }))(otpGuessCapOutcome({ reason: 'OTP_MISMATCH', attemptsRemaining: 2 }, 400)),
    { status: 400, error: 'Incorrect OTP. 2 attempts left.' });
  assert.deepEqual(
    (({ status, error }) => ({ status, error }))(otpGuessCapOutcome({ reason: 'OTP_ATTEMPTS_EXCEEDED', retryAfterMinutes: 30 }, 400)),
    { status: 429, error: 'Too many incorrect attempts. Please try again in 30 minutes.' });
  assert.equal(otpGuessCapOutcome({ valid: false }, 400), null, 'no reason → the old "Invalid or expired OTP"');
});
