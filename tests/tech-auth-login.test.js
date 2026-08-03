/*
 * Characterization tests for technician login identity resolution.
 *
 * Guards the 2026-07-23 fix for duplicate tbl_user + tbl_easyfixer rows:
 *   1. the login lookup must NOT filter on efr_status — 55% of production rows
 *      are NULL or 0, and every one of them used to mint a duplicate stub
 *   2. send-OTP must never write identity rows (it is public + unauthenticated)
 *   3. verify-OTP onboards ONLY when the number is unknown everywhere
 *   4. an existing technician — verified, deactivated, or NULL-status — is
 *      always reused, never shadowed by a new stub
 *
 * Non-destructive: the shared mysql2 pool is swapped for tests/helpers/fake-pool
 * ONCE at module load (the same convention job-service-*.test.js uses — a
 * mid-file restore would re-arm the real pool for later cases). No DB is
 * touched. Runner: `npm test` (node --test --test-force-exit).
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const EFR_BY_NO    = /FROM tbl_easyfixer\s+WHERE efr_no = \?/i;
const EFR_BY_USER  = /JOIN tbl_user u ON u\.user_id = e\.user_id/i;
const EFR_BY_ID    = /FROM tbl_easyfixer WHERE efr_id = \?/i;
const OTP_VERIFY   = /SELECT id, otp, valid_up_to, is_expired FROM otp_details/i;
const OTP_EXISTING = /SELECT id FROM otp_details/i;
const INSERT_USER  = /INSERT INTO tbl_user/i;
const INSERT_EFR   = /INSERT INTO tbl_easyfixer/i;
const GET_LOCK     = /GET_LOCK/i;

const DEACTIVATED = { efr_id: 11179, efr_name: 'Harshit', efr_no: '9013877370', efr_email: null, efr_status: 0,    is_technician_verified: null, user_id: 8500 };
const VIA_USER    = { efr_id: 11079, efr_name: 'Harshit', efr_no: '9560966498', efr_email: null, efr_status: 1,    is_technician_verified: true, user_id: 8379 };
const NULL_STATUS = { efr_id: 10795, efr_name: 'Legacy',  efr_no: '9013877370', efr_email: null, efr_status: null, is_technician_verified: null, user_id: 7898 };

const DEFAULTS = () => ({
  byEfrNo: [],       // rows for the efr_no lookup
  byUserMobile: [],  // rows for the tbl_user reconciliation
  otpRow: [{ id: 77, otp: 1234, valid_up_to: new Date(Date.now() + 5 * 60_000), is_expired: 0 }],
});
let scenario = DEFAULTS();

const fake = installFakePool([
  [EFR_BY_USER,  () => scenario.byUserMobile],   // must precede EFR_BY_NO (both mention tbl_easyfixer)
  [EFR_BY_NO,    () => scenario.byEfrNo],
  [EFR_BY_ID,    () => scenario.byEfrNo],
  [OTP_VERIFY,   () => scenario.otpRow],
  [OTP_EXISTING, () => []],
]);

// Stub OTP delivery before the service lazily requires it, so no test can reach
// a real WhatsApp/SMS provider.
const deliveryPath = require.resolve('../services/otp-delivery.service');
require.cache[deliveryPath] = {
  id: deliveryPath, filename: deliveryPath, loaded: true,
  exports: { deliverOtp: async () => {} },
};

const techAuth = require('../services/tech-auth.service');

const wroteIdentity = () =>
  fake.calls.some((c) => INSERT_USER.test(c.sql) || INSERT_EFR.test(c.sql));

beforeEach(() => { scenario = DEFAULTS(); fake.reset(); });

// ── Identity resolution ────────────────────────────────────────────────

/*
 * Scoped to the WHERE clause on purpose: the query legitimately mentions
 * `(efr_status = 1) DESC` in its ORDER BY for best-row ranking. Asserting on
 * the whole statement would flag that ranking as a filter.
 */
const whereClause = (sql) =>
  (sql.split(/\bWHERE\b/i)[1] || '').split(/ORDER BY/i)[0];

test('login lookup does NOT filter on efr_status', async () => {
  await techAuth.findByMobile('9999999999');
  const q = fake.calls.find((c) => EFR_BY_NO.test(c.sql));
  assert.ok(q, 'expected an efr_no lookup');
  assert.ok(!/efr_status/.test(whereClause(q.sql)),
    'filtering efr_status in WHERE is what minted duplicate stubs');
});

test('a DEACTIVATED technician (efr_status = 0) still resolves', async () => {
  scenario.byEfrNo = [DEACTIVATED];
  const tech = await techAuth.findByMobile('9013877370');
  assert.equal(tech.efr_id, 11179);
});

test('a NULL-status legacy technician still resolves', async () => {
  scenario.byEfrNo = [NULL_STATUS];
  const tech = await techAuth.findByMobile('9013877370');
  assert.equal(tech.efr_id, 10795, 'NULL efr_status must not hide a technician');
});

test('falls back to tbl_user.mobile_no when efr_no differs', async () => {
  scenario.byUserMobile = [VIA_USER];
  const tech = await techAuth.findByMobile('9310992052');
  assert.equal(tech.efr_id, 11079, 'must reconcile through tbl_user.mobile_no');
});

test('reconciliation is scoped to the technician role', async () => {
  await techAuth.findByMobile('9310992052');
  const q = fake.calls.find((c) => EFR_BY_USER.test(c.sql));
  assert.ok(q, 'expected the reconciliation query');
  assert.ok(/u\.user_role = \?/.test(q.sql), 'must constrain by role');
  assert.equal(q.params[1], 19, 'role 19 = Technician');
});

test('best-row order prefers verified, then active, then newest', async () => {
  await techAuth.findByMobile('9013877370');
  const q = fake.calls.find((c) => EFR_BY_NO.test(c.sql));
  assert.ok(/\(is_technician_verified = 1\) DESC/.test(q.sql), 'verified wins');
  assert.ok(/\(efr_status = 1\) DESC/.test(q.sql), 'active outranks inactive');
  assert.ok(/efr_id DESC/.test(q.sql), 'newest breaks the tie');
});

test('findById does NOT filter efr_status — deactivated tokens stay valid', async () => {
  await techAuth.findById(11179);
  const q = fake.calls.find((c) => EFR_BY_ID.test(c.sql));
  assert.ok(q, 'expected a findById lookup');
  assert.ok(!/efr_status\s*=\s*1/.test(whereClause(q.sql)),
    'a deactivated technician must keep a working token to see their status');
});

// ── No identity writes before OTP proof ────────────────────────────────

test('send-OTP writes NO identity row for an unknown number', async () => {
  const r = await techAuth.createLoginOtp('9000000001');
  assert.equal(r.found, true, 'an unknown number must still receive an OTP');
  assert.ok(!wroteIdentity(), 'send-OTP must not INSERT tbl_user / tbl_easyfixer');
  assert.ok(!fake.calls.some((c) => GET_LOCK.test(c.sql)),
    'send-OTP must not take the onboarding lock');
});

test('send-OTP for a known technician also writes no identity row', async () => {
  scenario.byEfrNo = [DEACTIVATED];
  await techAuth.createLoginOtp('9013877370');
  assert.ok(!wroteIdentity());
});

test('verify-OTP reuses a deactivated technician instead of creating one', async () => {
  scenario.byEfrNo = [DEACTIVATED];
  const r = await techAuth.verifyLoginOtp('9013877370', 1234);
  assert.equal(r.ok, true);
  assert.equal(r.tech.efr_id, 11179, 'must reuse the deactivated record');
  assert.ok(!wroteIdentity(), 'a deactivated technician must never be shadowed by a stub');
});

test('verify-OTP reuses a technician reached via tbl_user reconciliation', async () => {
  scenario.byUserMobile = [VIA_USER];
  const r = await techAuth.verifyLoginOtp('9310992052', 1234);
  assert.equal(r.ok, true);
  assert.equal(r.tech.efr_id, 11079);
  assert.ok(!wroteIdentity(), 'the verified record must not be shadowed by a stub');
});

test('a wrong OTP creates nothing', async () => {
  const r = await techAuth.verifyLoginOtp('9000000002', 4321);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'OTP_MISMATCH');
  assert.ok(!wroteIdentity(), 'a failed OTP must not onboard');
});

test('an expired OTP creates nothing', async () => {
  scenario.otpRow = [{ id: 78, otp: 1234, valid_up_to: new Date(Date.now() - 1000), is_expired: 0 }];
  const r = await techAuth.verifyLoginOtp('9000000004', 1234);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'OTP_EXPIRED');
  assert.ok(!wroteIdentity());
});

test('no issued OTP creates nothing', async () => {
  scenario.otpRow = [];
  const r = await techAuth.verifyLoginOtp('9000000003', 1234);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'NO_OTP_ISSUED');
  assert.ok(!wroteIdentity());
});
