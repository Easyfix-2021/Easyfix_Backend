'use strict';

/*
 * routes/admin/easyfixers.js — the sensitive-change surface (mobile + bank),
 * and services/easyfixer-sensitive-change.service.js behind it.
 *
 * ─── WHY THESE TESTS EXIST ────────────────────────────────────────────────
 *
 * These two endpoints are account takeover and payment redirection:
 *   • tbl_easyfixer.efr_no IS the technician's login identity — tech-auth
 *     resolves an account by mobile alone.
 *   • tbl_easyfixer_bank_details is where the technician's money lands.
 *
 * What makes them safe is not one mechanism but four, and a test suite that
 * checks some of them proves very little:
 *
 *   1. NO TWO TECHNICIANS MAY SHARE A NUMBER. A duplicate efr_no collapses
 *      two people into one login. Asserted as a 409 that writes NOTHING.
 *   2. THE TECHNICIAN CONSENTS BEFORE THEIR MONEY MOVES. A wrong OTP must
 *      leave the DB untouched — and must not even reach the vendor.
 *   3. AN UNVERIFIED ACCOUNT NEVER REACHES THE DB. A vendor rejection is a
 *      422 that writes nothing, so a typo'd account cannot fail silently
 *      days later at payout time.
 *   4. THE AUDIT ROW IS THE EVIDENCE. It must name the operator, the source,
 *      and — critically — carry the account number MASKED, because a
 *      fraud-prevention log that stores full account numbers is just a second
 *      copy of the payment instructions with no masking layer in front of it.
 *
 * Plus two properties that are easy to regress and impossible to notice:
 *   • The OTP value must NEVER appear in a response body. An endpoint that
 *     leaks it lets an operator complete a bank change with no technician
 *     involved at all — the OTP would be theatre.
 *   • An audit-write failure must NOT roll back a change the operator has
 *     already been told succeeded. Losing the note is recoverable; silently
 *     reverting the change is not.
 *
 * Faithfulness: the REAL router is mounted, so the chain under test is the
 * shipped one — Joi, requireAction, the scope guard, the handlers. Only what
 * routes/admin/index.js would have attached (req.user, req.scope) is injected
 * by a stand-in. RBAC resolves through the real services/role.service against
 * the fake pool, so a wrong action key fails here exactly as in production.
 *
 * Non-destructive: fake pool, no real DB; globalThis.fetch is stubbed for the
 * whole file so the KYC vendor is never called. Runner:
 *   node --test --test-force-exit tests/easyfixer-sensitive-change.test.js
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

// The KYC service reads this at CALL time; unset it and every bank call is a
// 503 instead of reaching the (stubbed) vendor.
process.env.SUREPASS_VERIFICATION_KEY = 'test-verification-key';
// Suppress WhatsApp: sendOtp still writes the OTP column, which is what the
// leak test reads, but no message is dispatched.
process.env.NOTIFICATIONS_DISABLE = 'true';
delete process.env.QA_DETERMINISTIC_OTP;

/* ─────────────────────── the values under test ─────────────────────────── */

const EFR_ID = 4471;
const OTHER_EFR_ID = 9902;
const USER_ID = 12;

const OLD_MOBILE = '9812345678';
const NEW_MOBILE = '9876543210';
const TAKEN_MOBILE = '9911223344';   // already held by OTHER_EFR_ID

const OLD_ACCOUNT = '000111222333';
const NEW_ACCOUNT = '509876543211';
const NEW_IFSC = 'HDFC0001234';
const BANK_NAME = 'HDFC Bank';
const BANK_ID = 3;

/* ───────────────────────── mutable fake DB ─────────────────────────────── */

const scenario = {
  actions: ['isEasyfixerMobileUpdate', 'isEasyfixerBankUpdate'],
  easyfixer: null,
  mobileClash: null,      // row returned by the duplicate probe, or null
  storedOtp: null,        // tbl_easyfixer.profile_update_otp
  otpValidUpTo: null,
  bankRow: null,          // existing tbl_easyfixer_bank_details row, or null
  vendorOk: true,
  vendorMessage: 'Invalid account number',
  auditFails: false,
};

// Records what the transaction did. The fake pool's connection has no-op
// commit/rollback, so getConnection is wrapped below to observe them.
const txn = { began: false, committed: false, rolledBack: false };

function freshEasyfixer(over = {}) {
  return {
    efr_id: EFR_ID,
    efr_name: 'Ravi Kumar',
    efr_no: OLD_MOBILE,
    efr_cityId: 7,
    ...over,
  };
}

const fake = installFakePool([
  [/FROM easyfix_properties/i, () => []],

  // ── RBAC resolves through the REAL services/role.service ──
  [/FROM tbl_role/i, () => [{
    role_id: 2, role_name: 'Admin', role_desc: 'Admin', role_status: 1, menu_ids: '1,2,3',
  }]],
  [/SELECT user_role FROM tbl_user/i, () => [{ user_role: 2 }]],
  [/FROM role_menu_action/i, () => scenario.actions.map((a) => ({ action_name: a }))],

  // ── the OTP columns (easyfixer-profile-otp.service.js) ──
  // Ordered BEFORE the generic tbl_easyfixer reads: both select from the same
  // table and only the column list tells them apart.
  [/SELECT profile_update_otp/i, () => [{
    profile_update_otp: scenario.storedOtp,
    profile_update_otp_valid_up_to: scenario.otpValidUpTo,
  }]],
  [/SELECT efr_name, efr_no/i, () => (scenario.easyfixer ? [scenario.easyfixer] : [])],

  // ── the sensitive-change service's own reads ──
  [/SELECT efr_id, efr_no\s+FROM tbl_easyfixer WHERE efr_id/i,
    () => (scenario.easyfixer ? [scenario.easyfixer] : [])],
  [/SELECT efr_id FROM tbl_easyfixer WHERE efr_no = \?/i,
    () => (scenario.mobileClash ? [scenario.mobileClash] : [])],

  // ── easyfixer.getById (the scope guard's load) ──
  [/FROM tbl_easyfixer e\s/i, () => (scenario.easyfixer ? [scenario.easyfixer] : [])],

  // ── bank lookups + writes ──
  [/FROM bank_name WHERE bank_name/i, () => [{ id: BANK_ID }]],
  [/FROM tbl_easyfixer_bank_details/i, () => (scenario.bankRow ? [scenario.bankRow] : [])],
  [/INSERT INTO tbl_easyfixer_bank_details/i, () => ({ insertId: 88, affectedRows: 1 })],
  [/UPDATE tbl_easyfixer_bank_details/i, () => ({ affectedRows: 1 })],

  // ── the audit row ──
  // Throwing here models the ONE failure mode that must not be fatal: the
  // change applied, the note did not.
  [/INSERT INTO tbl_easyfixer_sensitive_change_log/i, () => {
    if (scenario.auditFails) throw new Error('audit table is unavailable');
    return { insertId: 501, affectedRows: 1 };
  }],
]);

/* ─── observe the transaction ─── */
const dbModule = require('../db');
const fakeGetConnection = dbModule.pool.getConnection;
dbModule.pool.getConnection = async () => {
  const conn = await fakeGetConnection();
  return {
    ...conn,
    beginTransaction: async () => { txn.began = true; },
    commit: async () => { txn.committed = true; },
    rollback: async () => { txn.rolledBack = true; },
  };
};

/* ─────────────────────────── the app + client ──────────────────────────── */

const express = require('express');
const { invalidatePermissionsCache } = require('../services/role.service');
const easyfixersRouter = require('../routes/admin/easyfixers');

let server;
let baseUrl;
const realFetch = globalThis.fetch;

// Every response body this file ever sees, so the leak scan at the end is
// over the WHOLE suite rather than one hand-picked call. `issuedOtps`
// accumulates across tests too — fake.calls is reset per test, these are not.
const seenBodies = [];
const issuedOtps = [];

async function api(method, path, body) {
  const res = await realFetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  seenBodies.push(text);
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body — text is enough */ }
  return { status: res.status, text, json };
}

/** Every (sql, params) the fake pool saw, filtered by a pattern. */
function callsMatching(re) {
  return fake.calls.filter((c) => re.test(c.sql));
}

before(async () => {
  const app = express();
  app.use(express.json());
  /*
   * Stand-in for routes/admin/index.js. requireAuth / role / maskMobile are
   * that router's job, not this one's — deliberately NOT mounted, so the
   * assertions below prove the endpoints' own behaviour instead of leaning on
   * the masking safety net. `scope` is set (to undefined) so buildRequestScope
   * takes the "middleware ran, caller is unrestricted" branch, which is what a
   * bypass-role admin gets in production.
   */
  app.use((req, _res, next) => {
    req.user = { user_id: USER_ID, user_name: 'Ops Tester', user_role: 2 };
    req.scope = undefined;
    next();
  });
  app.use('/easyfixers', easyfixersRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(500).json({ success: false, error: String(err && err.message) });
  });

  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Installed only AFTER the server is listening, so the test client keeps the
  // real fetch while the KYC vendor gets the stub.
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith(baseUrl)) return realFetch(url, init);
    // aadhaarkyc.io bank-verification envelope, per the shapes documented in
    // services/mobile-kyc.service.js: { data, status_code, message_code,
    // message, success }.
    if (scenario.vendorOk) {
      return {
        status: 200,
        json: async () => ({
          success: true,
          status_code: 200,
          message_code: 'success',
          message: 'Bank account verified',
          data: { full_name: 'RAVI KUMAR', account_number: NEW_ACCOUNT },
        }),
      };
    }
    return {
      status: 200,
      json: async () => ({
        success: false,
        status_code: 422,
        message_code: 'invalid_account',
        message: scenario.vendorMessage,
        data: {},
      }),
    };
  };
});

beforeEach(() => {
  fake.reset();
  invalidatePermissionsCache();
  scenario.actions = ['isEasyfixerMobileUpdate', 'isEasyfixerBankUpdate'];
  scenario.easyfixer = freshEasyfixer();
  scenario.mobileClash = null;
  scenario.storedOtp = null;
  scenario.otpValidUpTo = null;
  scenario.bankRow = null;
  scenario.vendorOk = true;
  scenario.auditFails = false;
  txn.began = false;
  txn.committed = false;
  txn.rolledBack = false;
});

after(async () => {
  globalThis.fetch = realFetch;
  fake.restore();
  if (server) await new Promise((resolve) => server.close(resolve));
});

/* ───────────────────────────── mobile ──────────────────────────────────── */

test('a mobile number already held by another easyfixer is refused with 409, and nothing is written', async () => {
  scenario.mobileClash = { efr_id: OTHER_EFR_ID };

  const res = await api('PATCH', `/easyfixers/${EFR_ID}/mobile`, {
    mobile: TAKEN_MOBILE,
    reason: 'technician lost the SIM',
  });

  assert.equal(res.status, 409);
  assert.match(res.json.error, new RegExp(String(OTHER_EFR_ID)));
  // efr_no is the login identity: two rows sharing it means two people
  // resolving to one account. The write must not have happened.
  assert.equal(callsMatching(/UPDATE tbl_easyfixer SET efr_no/i).length, 0);
  assert.equal(callsMatching(/INSERT INTO tbl_easyfixer_sensitive_change_log/i).length, 0);
});

test('a mobile change writes the new number and an audit row naming the operator, with no OTP claimed', async () => {
  const res = await api('PATCH', `/easyfixers/${EFR_ID}/mobile`, {
    mobile: NEW_MOBILE,
    reason: 'handset stolen — number reissued',
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.data.efr_no, NEW_MOBILE);
  assert.equal(res.json.data.changed, true);

  const update = callsMatching(/UPDATE tbl_easyfixer SET efr_no/i)[0];
  assert.ok(update, 'the mobile UPDATE must have run');
  assert.equal(update.params[0], NEW_MOBILE);

  const audit = callsMatching(/INSERT INTO tbl_easyfixer_sensitive_change_log/i)[0];
  assert.ok(audit, 'the audit row must have been written');
  const [efrId, changeType, oldValue, newValue, byUser, source, reason, verification, otpVerified]
    = audit.params;
  assert.equal(efrId, EFR_ID);
  assert.equal(changeType, 'mobile');
  // Mobile numbers are stored IN FULL, unlike account numbers: recovering a
  // hijacked login means proving which number the account moved FROM and TO.
  assert.equal(oldValue, OLD_MOBILE);
  assert.equal(newValue, NEW_MOBILE);
  assert.equal(byUser, USER_ID);
  assert.equal(source, 'crm');
  assert.equal(reason, 'handset stolen — number reissued');
  assert.equal(verification, null);
  // 0 by design — there is no number an OTP could meaningfully be sent to on
  // this path. See the route comment.
  assert.equal(otpVerified, 0);
});

test('the mobile change requires the NEW sensitive key, not the broad isEdit', async () => {
  // An operator with full ordinary edit rights and nothing else.
  scenario.actions = ['isEdit', 'isAddNew'];

  const res = await api('PATCH', `/easyfixers/${EFR_ID}/mobile`, {
    mobile: NEW_MOBILE,
    reason: 'should never apply',
  });

  assert.equal(res.status, 403);
  assert.match(res.json.error, /isEasyfixerMobileUpdate/);
  assert.equal(callsMatching(/UPDATE tbl_easyfixer SET efr_no/i).length, 0);
});

/* ────────────────────────────── bank ───────────────────────────────────── */

/*
 * "YYYY-MM-DD HH:mm:ss" in IST — exactly what mysql2 hands back for a DATETIME
 * under `dateStrings: true` with the pool's +05:30 session timezone.
 *
 * This used to build a PROCESS-LOCAL stamp, which matched the old
 * `new Date(str)` comparison in easyfixer-profile-otp.service.js. That made
 * the fixture a model of the BUG rather than of the database: it agreed with
 * the code on a laptop set to Asia/Kolkata and disagreed on a UTC pod, so the
 * suite could not have caught the 5h30m expiry drift.
 *
 * Built by shifting the instant into IST and formatting from the ISO string,
 * so it produces the same value in every timezone.
 */
function wallClock(ms) {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

function validOtpScenario(otp = 8642) {
  scenario.storedOtp = otp;
  scenario.otpValidUpTo = wallClock(Date.now() + 5 * 60_000);
  return otp;
}

function bankBody(over = {}) {
  return {
    otp: 8642,
    accountNumber: NEW_ACCOUNT,
    ifsc: NEW_IFSC,
    bankName: BANK_NAME,
    accountHolderName: 'Ravi Kumar',
    reason: 'technician changed banks',
    ...over,
  };
}

test('a wrong OTP is a 400 that writes nothing and never reaches the vendor', async () => {
  validOtpScenario(8642);
  let vendorCalled = false;
  const stubbed = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith(baseUrl)) vendorCalled = true;
    return stubbed(url, init);
  };

  try {
    const res = await api('PATCH', `/easyfixers/${EFR_ID}/bank`, bankBody({ otp: 1111 }));

    assert.equal(res.status, 400);
    assert.match(res.json.error, /OTP/i);
    assert.equal(vendorCalled, false, 'no consent means no vendor call');
    assert.equal(callsMatching(/(INSERT INTO|UPDATE) tbl_easyfixer_bank_details/i).length, 0);
    assert.equal(callsMatching(/is_bank_details_verified_by_crm/i).length, 0);
    assert.equal(callsMatching(/INSERT INTO tbl_easyfixer_sensitive_change_log/i).length, 0);
  } finally {
    globalThis.fetch = stubbed;
  }
});

test('an expired OTP is a 400 — a stale consent is not consent', async () => {
  scenario.storedOtp = 8642;
  scenario.otpValidUpTo = wallClock(Date.now() - 60_000);

  const res = await api('PATCH', `/easyfixers/${EFR_ID}/bank`, bankBody({ otp: 8642 }));

  assert.equal(res.status, 400);
  assert.equal(callsMatching(/(INSERT INTO|UPDATE) tbl_easyfixer_bank_details/i).length, 0);
  assert.equal(callsMatching(/INSERT INTO tbl_easyfixer_sensitive_change_log/i).length, 0);
});

test('a vendor rejection is a 422 carrying the vendor message, and writes nothing', async () => {
  validOtpScenario();
  scenario.vendorOk = false;
  scenario.vendorMessage = 'Beneficiary account does not exist';

  const res = await api('PATCH', `/easyfixers/${EFR_ID}/bank`, bankBody());

  assert.equal(res.status, 422);
  assert.equal(res.json.error, 'Beneficiary account does not exist');
  // An unverified account must never land in the payout row — a bad account
  // fails silently, days later, at payout time.
  assert.equal(callsMatching(/(INSERT INTO|UPDATE) tbl_easyfixer_bank_details/i).length, 0);
  assert.equal(callsMatching(/is_bank_details_verified_by_crm/i).length, 0);
  assert.equal(callsMatching(/INSERT INTO tbl_easyfixer_sensitive_change_log/i).length, 0);
});

test('an unconfigured vendor key is a 503, never a 500', async () => {
  validOtpScenario();
  const key = process.env.SUREPASS_VERIFICATION_KEY;
  delete process.env.SUREPASS_VERIFICATION_KEY;

  try {
    const res = await api('PATCH', `/easyfixers/${EFR_ID}/bank`, bankBody());
    assert.equal(res.status, 503);
    assert.match(res.json.error, /not configured/i);
    assert.equal(callsMatching(/(INSERT INTO|UPDATE) tbl_easyfixer_bank_details/i).length, 0);
  } finally {
    process.env.SUREPASS_VERIFICATION_KEY = key;
  }
});

test('a verified bank change writes the row and an audit entry with the account number MASKED', async () => {
  validOtpScenario();
  scenario.bankRow = { efr_bank_id: 88, efr_bank_acc_num: OLD_ACCOUNT };

  const res = await api('PATCH', `/easyfixers/${EFR_ID}/bank`, bankBody());

  assert.equal(res.status, 200);
  assert.equal(txn.committed, true);
  assert.equal(txn.rolledBack, false);

  // The payout row was updated with the verified account.
  const bankWrite = callsMatching(/UPDATE tbl_easyfixer_bank_details/i)[0];
  assert.ok(bankWrite);
  assert.equal(bankWrite.params[0], NEW_ACCOUNT);
  assert.equal(bankWrite.params[2], NEW_IFSC);

  // The CRM verification flag FOLLOWS the vendor result (1 = valid); it is
  // derived, not hardcoded.
  const flagWrite = callsMatching(/is_bank_details_verified_by_crm/i)[0];
  assert.ok(flagWrite);
  assert.equal(flagWrite.params[0], 1);

  const audit = callsMatching(/INSERT INTO tbl_easyfixer_sensitive_change_log/i)[0];
  assert.ok(audit);
  const [efrId, changeType, oldValue, newValue, byUser, source, reason, verification, otpVerified]
    = audit.params;
  assert.equal(efrId, EFR_ID);
  assert.equal(changeType, 'bank');
  assert.equal(byUser, USER_ID);
  assert.equal(source, 'crm');
  assert.equal(reason, 'technician changed banks');
  assert.equal(otpVerified, 1);

  // ⚠ THE MASKING ASSERTION. This log is evidence of a change, not a second
  // copy of the payment instructions.
  assert.equal(oldValue, `••••${OLD_ACCOUNT.slice(-4)}`);
  assert.equal(newValue, `••••${NEW_ACCOUNT.slice(-4)}`);
  assert.doesNotMatch(String(oldValue), new RegExp(OLD_ACCOUNT));
  assert.doesNotMatch(String(newValue), new RegExp(NEW_ACCOUNT));
  // The vendor's verdict is kept — that is what makes the row auditable —
  // but it must not smuggle the full number back in.
  assert.match(String(verification), /RAVI KUMAR/);
  assert.doesNotMatch(String(verification), new RegExp(NEW_ACCOUNT));

  // The response echoes only the last four.
  assert.equal(res.json.data.account_number_masked, `••••${NEW_ACCOUNT.slice(-4)}`);
  assert.doesNotMatch(res.text, new RegExp(NEW_ACCOUNT));
});

test('a first-time bank addition inserts instead of updating, and still audits with a null old value', async () => {
  validOtpScenario();
  scenario.bankRow = null;

  const res = await api('PATCH', `/easyfixers/${EFR_ID}/bank`, bankBody());

  assert.equal(res.status, 200);
  assert.equal(callsMatching(/INSERT INTO tbl_easyfixer_bank_details/i).length, 1);
  assert.equal(callsMatching(/UPDATE tbl_easyfixer_bank_details/i).length, 0);

  const audit = callsMatching(/INSERT INTO tbl_easyfixer_sensitive_change_log/i)[0];
  assert.equal(audit.params[2], null, 'no previous account → null old_value');
  assert.equal(audit.params[3], `••••${NEW_ACCOUNT.slice(-4)}`);
});

/* ─────────────────────── audit-failure isolation ───────────────────────── */

test('a failed audit write does NOT roll back the bank change the operator was shown', async () => {
  validOtpScenario();
  scenario.bankRow = { efr_bank_id: 88, efr_bank_acc_num: OLD_ACCOUNT };
  scenario.auditFails = true;

  const res = await api('PATCH', `/easyfixers/${EFR_ID}/bank`, bankBody());

  // Losing the note is recoverable from the application log. Reverting a
  // change the operator has already been told succeeded is not: the payout
  // would go to the OLD account and nobody would know until it landed.
  assert.equal(res.status, 200);
  assert.equal(txn.committed, true);
  assert.equal(txn.rolledBack, false);
  assert.equal(callsMatching(/UPDATE tbl_easyfixer_bank_details/i).length, 1);
});

test('a failed audit write does NOT undo the mobile change either', async () => {
  scenario.auditFails = true;

  const res = await api('PATCH', `/easyfixers/${EFR_ID}/mobile`, {
    mobile: NEW_MOBILE,
    reason: 'handset stolen',
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.data.efr_no, NEW_MOBILE);
  assert.equal(callsMatching(/UPDATE tbl_easyfixer SET efr_no/i).length, 1);
});

/* ───────────────────────────── OTP secrecy ─────────────────────────────── */

test('sending the OTP returns { sent: true } and nothing that could be the code', async () => {
  const res = await api('POST', `/easyfixers/${EFR_ID}/bank/otp`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.json.data, { sent: true });

  // The OTP the service actually generated, read off the UPDATE it issued —
  // not a value the test chose, so this catches a leak of the real code.
  const write = callsMatching(/SET profile_update_otp/i)[0];
  assert.ok(write, 'the OTP must have been persisted');
  const issuedOtp = String(write.params[0]);
  issuedOtps.push(issuedOtp);
  assert.match(issuedOtp, /^\d{4}$/);
  assert.doesNotMatch(res.text, new RegExp(issuedOtp),
    'the OTP value must never travel in a response body');
});

test('no response body in this suite ever contained an OTP or a full account number', async () => {
  // Runs last, over every body the suite collected. A leak introduced on any
  // endpoint — including one added later — fails here even if its own test
  // forgot to look.
  const otpValues = issuedOtps;

  assert.ok(seenBodies.length > 0, 'the scan must have something to scan');
  assert.ok(otpValues.length > 0, 'at least one real OTP must have been issued to scan for');
  for (const body of seenBodies) {
    assert.doesNotMatch(body, new RegExp(NEW_ACCOUNT), 'full account number in a response body');
    assert.doesNotMatch(body, new RegExp(OLD_ACCOUNT), 'full account number in a response body');
    assert.doesNotMatch(body, /"?(profile_update_)?otp"?\s*:/i, 'an OTP-shaped field in a response body');
    for (const otp of otpValues) {
      assert.doesNotMatch(body, new RegExp(otp), 'OTP value in a response body');
    }
  }
});
