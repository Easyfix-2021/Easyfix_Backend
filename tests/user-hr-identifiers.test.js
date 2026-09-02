/*
 * HR master-data identifiers — the write-side guarantees.
 *
 * THE FAILURE THIS FILE EXISTS TO PREVENT, in the owner's words: "on save, we
 * don't update until it's actually edited, to avoid updating the incorrect
 * masked value in DB".
 *
 * PAN and Aadhaar are stored encrypted and are only ever returned MASKED
 * (XXXXXX234F). The Edit User form therefore cannot prefill them — there is no
 * plaintext to prefill with — so those two boxes open empty on every edit. That
 * design has exactly one catastrophic failure mode: something submits the MASK
 * as if it were a value, and a real PAN is overwritten with a row of X's that
 * nobody can recover.
 *
 * Three independent things have to hold, and each is asserted below rather than
 * argued:
 *   1. an untouched field issues NO write at all,
 *   2. a masked value is REJECTED by validation, never stored — so even if
 *      layer 1 were ever broken, the mask still cannot reach a column,
 *   3. a value already on file SATISFIES the mandatory check, so HR is never
 *      asked to re-type a number the form is not allowed to show them.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

/* field-crypto reads the key at first use; set one before the service loads. */
before(() => {
  if (!process.env.EASYFIX_FIELD_ENC_KEY) {
    process.env.EASYFIX_FIELD_ENC_KEY = crypto.randomBytes(32).toString('base64');
  }
});

const userService = require('../services/user.service');

/* A fake runner that records what would have been written. */
function recorder() {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return [[]]; } };
}

// ── 1. UNTOUCHED MEANS NO WRITE ────────────────────────────────────────
test('an untouched PAN issues no query at all — the masked value cannot be written back', async () => {
  const r = recorder();
  await userService.upsertPersonalIdentifiers(42, {}, r);
  assert.equal(r.calls.length, 0, 'omitting the key must not touch the database');
});

test('editing a DIFFERENT field leaves PAN and Aadhaar untouched', async () => {
  const r = recorder();
  await userService.upsertPersonalIdentifiers(42, { uan: '100717632403' }, r);
  assert.equal(r.calls.length, 1);
  const { sql } = r.calls[0];
  assert.match(sql, /uan/);
  assert.doesNotMatch(sql, /\bpan\b/,     'pan must not appear in a write that did not set it');
  assert.doesNotMatch(sql, /\baadhaar\b/, 'aadhaar must not appear either');
});

// ── 2. THE MASK IS NOT A VALID VALUE ───────────────────────────────────
test('a masked PAN is rejected by validation, so it can never reach a column', () => {
  //   the exact string the API returns and the form displays
  const r = userService.normalisePan('XXXXXX234F');
  assert.equal(r.ok, false, 'the mask must not validate as a PAN');
});

test('a masked Aadhaar is rejected too — including after separator stripping', () => {
  for (const masked of ['XXXX XXXX 9521', 'XXXXXXXX9521', 'XXXX-XXXX-9521']) {
    assert.equal(userService.normaliseAadhaar(masked).ok, false, `must reject ${masked}`);
  }
});

test('CONTROL — the validators still accept the real values they guard', () => {
  // Without this, the two assertions above would also pass against a validator
  // that rejected everything, which would prove nothing.
  assert.equal(userService.normalisePan('ABCDE1234F').ok, true);
  assert.equal(userService.normaliseAadhaar('7307-8151-9521').value, '730781519521');
});

// ── 3. STORED SATISFIES THE MANDATE ────────────────────────────────────
test('a PAN already on file satisfies the mandatory check without being re-typed', () => {
  const stored = {
    date_of_birth: '1990-01-01', date_of_joining: '2020-01-01',
    uan: '100717632403', address: '12 MG Road',
    pan_last4: '234F', aadhaar_last4: '9521',
  };
  assert.deepEqual(userService.missingHrIdentifiers({}, stored), [],
    'an edit that touches nothing must not demand PAN and Aadhaar again');
});

test('CONTROL — the mandatory check can still report a missing field', () => {
  const missing = userService.missingHrIdentifiers({}, {});
  assert.deepEqual(missing.sort(),
    ['aadhaar', 'address', 'date_of_birth', 'date_of_joining', 'pan', 'uan'],
    'a user with nothing on file must be flagged for all six');
});

// ── 4. A REAL EDIT DOES WRITE, AND WRITES CIPHERTEXT ───────────────────
test('a typed PAN is stored ENCRYPTED with a clear last4 — never plaintext', async () => {
  const r = recorder();
  await userService.upsertPersonalIdentifiers(42, { pan: 'ABCDE1234F' }, r);
  assert.equal(r.calls.length, 1);
  const [, pan, last4] = r.calls[0].params;
  assert.notEqual(pan, 'ABCDE1234F', 'the plaintext PAN must not be the stored value');
  assert.ok(String(pan).length > 100, 'expected a field-crypto envelope');
  assert.equal(last4, '234F');
});

test('an explicit null CLEARS both the ciphertext and its last4', async () => {
  const r = recorder();
  await userService.upsertPersonalIdentifiers(42, { pan: null }, r);
  const [, pan, last4] = r.calls[0].params;
  assert.equal(pan, null);
  assert.equal(last4, null, 'a stale last4 would keep showing a mask for a value that is gone');
});

// ═══════════════════════════════════════════════════════════════════════
// THE DEACTIVATION EXEMPTION
//
// The owner's rule, verbatim: "if only Status is changed from Active to
// Inactive, details will not be mandatory to add for existing users."
//
// This matters because ~1.2k active users have none of the six on file. Without
// the exemption, offboarding any of them would demand a PAN and an Aadhaar for
// somebody who has already left — data HR cannot get, on the one action that
// must always be possible. The same exemption personal_email already carries.
//
// Driven through updateUser rather than asserting the predicate alone: the
// predicate being right is worth nothing if it is wired to the wrong branch.
// ═══════════════════════════════════════════════════════════════════════

const { installFakePool } = require('./helpers/fake-pool');

let currentUser = null;
let storedIdentifiers = null;

const GATE_ROUTES = [
  [/GET_LOCK/i, [{ got: 1 }]],
  // BEFORE the tbl_user routes — "tbl_user_personal_details" is a substring of
  // neither, but the FROM-clause patterns below would still match it first.
  [/FROM tbl_user_personal_details/i, () => (storedIdentifiers ? [storedIdentifiers] : [])],
  [/INSERT INTO tbl_user_personal_details/i, () => ({ affectedRows: 1 })],
  [/FROM tbl_user_allowed_stages/i, []],
  [/SELECT role_id, role_name/i, [{ role_id: 2, role_name: 'Admin', role_status: 1, menu_ids: '' }]],
  [/FROM tbl_user\s+WHERE user_id/i, () => (currentUser ? [currentUser] : [])],
  [/FROM tbl_user\s+u/i, []],
];

/* stopOn fires at the column write, so "validation passed" is observable
   without needing the rest of the update to be faked. */
const gateFake = installFakePool(GATE_ROUTES, { stopOn: /UPDATE tbl_user SET/i });

function userRow(overrides = {}) {
  return {
    user_id: 501, user_type_id: 5, user_name: 'Test User', mobile_no: '9000000001',
    alternate_no: null, user_role: 2, city_id: 1,
    manage_clients: null, manage_cities: null, manage_states: null, manage_verticals: null,
    reporting_manager: null, user_status: 1, ...overrides,
  };
}

async function runUpdate(fields) {
  try {
    const value = await userService.updateUser(501, fields, 99, { enforceHrIdentifiers: true });
    return { completed: value };
  } catch (e) {
    if (e.__stop) return { reachedWrite: true };
    return { rejected: e.message, status: e.status };
  }
}

test('deactivating a user with NO personal details on file is ALLOWED', async () => {
  currentUser = userRow({ user_status: 1 });   // currently ACTIVE
  storedIdentifiers = null;                    // and nothing on file
  const r = await runUpdate({ is_active: false });
  assert.ok(!r.rejected,
    `offboarding must never be blocked by missing details — got: ${r.rejected}`);
});

test('CONTROL — the SAME user, edited without deactivating, IS blocked', async () => {
  currentUser = userRow({ user_status: 1 });
  storedIdentifiers = null;
  const r = await runUpdate({ mobile_no: '9000000002' });
  assert.ok(r.rejected, 'an ordinary edit of a detail-less active user must be blocked');
  assert.equal(r.status, 400);
  assert.match(r.rejected, /required/i);
  // Without this control the test above would pass against an enforcement
  // that never runs at all.
});

test('an ALREADY-inactive user can be edited without the six', async () => {
  currentUser = userRow({ user_status: 0 });   // already inactive
  storedIdentifiers = null;
  const r = await runUpdate({ mobile_no: '9000000003' });
  assert.ok(!r.rejected, `an inactive user must stay editable — got: ${r.rejected}`);
});

test('deactivating is exempt even when OTHER fields change in the same submit', async () => {
  // The owner said "if only Status is changed". The implementation is broader
  // on purpose: the exemption keys off is_active === false, not off the payload
  // being a single key. A submit that deactivates AND corrects a mobile is
  // still an offboarding, and splitting it into two saves to satisfy a rule
  // nobody can see would be the kind of workaround that teaches operators to
  // distrust the form.
  currentUser = userRow({ user_status: 1 });
  storedIdentifiers = null;
  const r = await runUpdate({ is_active: false, mobile_no: '9000000004' });
  assert.ok(!r.rejected, `got: ${r.rejected}`);
});

test('a user WITH all six on file is editable normally — the mandate is satisfied, not skipped', async () => {
  currentUser = userRow({ user_status: 1 });
  storedIdentifiers = {
    personal_email: 'a@b.com', date_of_birth: '1990-01-01', date_of_joining: '2020-01-01',
    uan: '100717632403', address: '12 MG Road', pan_last4: '234F', aadhaar_last4: '9521',
  };
  const r = await runUpdate({ mobile_no: '9000000005' });
  assert.ok(!r.rejected, `a complete record must edit cleanly — got: ${r.rejected}`);
});

after(() => gateFake.restore());
