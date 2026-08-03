/*
 * Characterization tests for the fixed-OTP test account (added 2026-07-31).
 *
 * Guarantees the two properties the owner asked for, for an allowlisted test
 * user (pradeep@easyfix.in) — and, critically, that they hold in EVERY
 * environment including production:
 *   1. resolveLoginOtp() returns the STATIC OTP (2468) even with
 *      QA_DETERMINISTIC_OTP unset (the prod path), and case/space-insensitively.
 *   2. createLoginOtp() SUPPRESSES delivery for the account — deliverOtp() is
 *      never invoked (no real email/WhatsApp leaves the box) — while still
 *      persisting the 2468 row and reporting success so the client proceeds.
 * Plus the negative controls: a non-allowlisted login is unaffected (random
 * OTP, and its delivery still runs).
 *
 * Non-destructive: swaps the shared mysql2 pool for tests/helpers/fake-pool and
 * stubs otp-delivery before the service requires it, so no DB and no gateway is
 * touched. Runner: `npm test` (node --test --test-force-exit).
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
// Prod-like by default: prove the static OTP does NOT depend on the QA flag.
delete process.env.QA_DETERMINISTIC_OTP;

const TEST_EMAIL = 'pradeep@easyfix.in';
const STATIC_OTP = 2468;

// ── Part A — pure OTP resolution (utils/otp.js) ────────────────────────────

const { resolveLoginOtp, staticLoginOtpFor } = require('../utils/otp');

test('staticLoginOtpFor: allowlisted email → 2468, everyone else → null', () => {
  assert.equal(staticLoginOtpFor(TEST_EMAIL), STATIC_OTP);
  assert.equal(staticLoginOtpFor('  PRADEEP@EasyFix.IN  '), STATIC_OTP, 'trim + case-insensitive');
  assert.equal(staticLoginOtpFor('someone@else.in'), null);
  assert.equal(staticLoginOtpFor('9876543210'), null);
  assert.equal(staticLoginOtpFor(''), null);
  assert.equal(staticLoginOtpFor(undefined), null);
});

test('resolveLoginOtp: test account is 2468 in prod mode (QA flag unset)', () => {
  assert.equal(process.env.QA_DETERMINISTIC_OTP, undefined, 'guard: prod-like env');
  assert.equal(resolveLoginOtp(TEST_EMAIL), STATIC_OTP);
  assert.equal(resolveLoginOtp('  PRADEEP@EasyFix.IN '), STATIC_OTP, 'trim + case-insensitive');
});

test('resolveLoginOtp: test account is STILL 2468 with the QA flag on', () => {
  process.env.QA_DETERMINISTIC_OTP = 'true';
  try {
    assert.equal(resolveLoginOtp(TEST_EMAIL), STATIC_OTP);
  } finally {
    delete process.env.QA_DETERMINISTIC_OTP;
  }
});

test('resolveLoginOtp: a NON-allowlisted email gets a random 4-digit OTP in prod', () => {
  // Deterministic guard (no flake): it is simply not on the static allowlist.
  assert.equal(staticLoginOtpFor('someone@else.in'), null);
  const otp = resolveLoginOtp('someone@else.in');
  assert.ok(Number.isInteger(otp) && otp >= 1000 && otp <= 9999, 'random 4-digit range');
});

// ── Part B — delivery suppression (auth.service.js::createLoginOtp) ─────────

const USER_LOOKUP   = /FROM tbl_user\s+WHERE LOWER\(official_email\) = \?/i;
const OTP_EXISTING  = /SELECT id FROM otp_details/i;
const OTP_INSERT    = /INSERT INTO otp_details/i;

// Return an active internal user whose email echoes what was queried, so both
// the test account and the control account resolve through findActiveUser…().
const fake = installFakePool([
  [USER_LOOKUP,  (sql, params) => [{
    user_id: 501, user_code: 'U501', user_name: 'Test User',
    official_email: params[0], user_role: 2, user_type_id: 5,
    city_id: 1, mobile_no: '9999999999', alternate_no: null,
    manage_clients: null, manage_cities: null, manage_states: null, manage_verticals: null,
    user_status: 1,
  }]],
  [OTP_EXISTING, () => []],              // force the INSERT branch
  [OTP_INSERT,   () => ({ insertId: 999 })],
]);

// Spy stub for OTP delivery, installed before the service lazily requires it.
const deliveryPath = require.resolve('../services/otp-delivery.service');
let deliverCalls = [];
require.cache[deliveryPath] = {
  id: deliveryPath, filename: deliveryPath, loaded: true,
  exports: {
    deliverOtp: async (args) => {
      deliverCalls.push(args);
      return { finalDelivered: true, attempts: [{ channel: 'email', delivered: true }] };
    },
  },
};

const auth = require('../services/auth.service');

beforeEach(() => { fake.reset(); deliverCalls = []; });

test('createLoginOtp: test account persists 2468 and does NOT deliver', async () => {
  const res = await auth.createLoginOtp(TEST_EMAIL);

  assert.equal(res.found, true);
  assert.equal(res.delivered, true, 'reports success so the client advances to OTP entry');
  assert.equal(res.channelsTried, 'static-test-otp');
  assert.equal(deliverCalls.length, 0, 'NO real email/WhatsApp send for the test account');

  const insert = fake.calls.find((c) => OTP_INSERT.test(c.sql));
  assert.ok(insert, 'expected the OTP row to be written');
  assert.equal(Number(insert.params[0]), STATIC_OTP, 'the persisted OTP must be 2468');
});

test('createLoginOtp: a normal account still delivers (control)', async () => {
  const res = await auth.createLoginOtp('realstaff@easyfix.in');

  assert.equal(res.found, true);
  assert.equal(deliverCalls.length, 1, 'normal logins must still send their OTP');
  // (That a normal login never gets 2468 is proven deterministically in Part A
  // via staticLoginOtpFor('someone@else.in') === null — asserting !== 2468 on a
  // random OTP here would be a 1-in-9000 CI flake, so it is intentionally omitted.)
});
