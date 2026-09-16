/*
 * services/mobile-email-verify.service.js::verifyToken stamps
 * tbl_efr_email_verification.verified_at (DATETIME) with a bound Date,
 * never SQL NOW() (2026-09-16). db.js pool timezone '+05:30' stores a
 * bound Date as the IST wall clock regardless of host; NOW() takes the DB
 * session's own (SYSTEM) zone.
 *
 * Runner: `node --test` (see npm test).
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/SELECT id, efr_id FROM tbl_efr_email_verification/i, () => [{ id: 1, efr_id: 4471 }]],
  [/UPDATE tbl_efr_email_verification/i, () => ({ affectedRows: 1 })],
  [/UPDATE tbl_easyfixer SET is_email_verified/i, () => ({ affectedRows: 1 })],
]);
after(() => fake.restore());

const { verifyToken } = require('../services/mobile-email-verify.service');

test('verifyToken binds verified_at as a Date, never NOW()', async () => {
  const r = await verifyToken('sometoken');
  assert.equal(r.ok, true);

  const upd = fake.calls.find((c) => /UPDATE tbl_efr_email_verification/.test(c.sql));
  assert.ok(upd, 'the verify UPDATE ran');
  assert.doesNotMatch(upd.sql, /NOW\(\)/, 'verified_at must not be SQL NOW()');
  assert.ok(upd.params[0] instanceof Date, 'verified_at is the first bound value');
});
