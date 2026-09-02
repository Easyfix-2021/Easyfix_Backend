const test = require('node:test');
const assert = require('node:assert/strict');

const { _internals } = require('../services/mobile-deepskill.service');
const { pool } = require('../db');

test.after(async () => { await pool.end(); });

const { categoryAllowedForApp } = _internals;

/*
 * The rule, as the business stated it: a technician onboarding picks ONE
 * category. After that the app never adds another — Ops adds categories from
 * the CRM and the technician edits skills inside them.
 *
 * Both halves are the same question asked of what the technician already holds,
 * which is why there is one predicate and not an `isActive` branch. That
 * matters: `efr_status` looked like the activation signal and is not — 2,044 of
 * the 4,680 rows carrying efr_status=1 are unverified, and 4,721 rows have it
 * NULL — so a rule keyed on it would have been wrong for half the estate.
 */
test('a technician with nothing yet may choose their one category', () => {
  assert.equal(categoryAllowedForApp({ inThis: 0, inAny: 0 }), true);
});

test('a technician may keep editing skills in a category they already hold', () => {
  assert.equal(categoryAllowedForApp({ inThis: 3, inAny: 3 }), true);
  assert.equal(categoryAllowedForApp({ inThis: 1, inAny: 9 }), true,
    'Ops may have granted several; editing any of them is still editing');
});

test('a SECOND category from the app is refused', () => {
  assert.equal(categoryAllowedForApp({ inThis: 0, inAny: 1 }), false,
    'this is the onboarding technician trying to add a second category');
  assert.equal(categoryAllowedForApp({ inThis: 0, inAny: 12 }), false,
    'and an established one trying to add an unassigned category');
});
