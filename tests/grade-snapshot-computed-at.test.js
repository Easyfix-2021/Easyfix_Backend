/*
 * grade.service.js saveSnapshot() stamps tbl_efr_grade_snapshot.computed_at
 * with a bound Date, never SQL NOW() (2026-09-16). db.js pool: timezone
 * '+05:30', dateStrings true — a bound Date is stored as the IST wall clock
 * regardless of host; NOW() takes the DB session's own (SYSTEM) zone.
 *
 * Runner: `node --test` (see npm test).
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

// Every read grade.service.js performs degrades to a neutral default on
// failure/absence (see the per-signal try/catch in services/grade.service.js),
// so an otherwise-empty fake pool exercises computeGrade + saveSnapshot with
// no per-query stubs beyond the snapshot cache-miss read.
const fake = installFakePool([
  [/FROM tbl_efr_grade_snapshot WHERE efr_id/i, []],
]);
after(() => fake.restore());

const grade = require('../services/grade.service');

test('saveSnapshot binds computed_at as a Date, never NOW()', async () => {
  await grade.getGrade(4471);

  const ins = fake.calls.find((c) => /INSERT INTO tbl_efr_grade_snapshot/i.test(c.sql));
  assert.ok(ins, 'the snapshot upsert ran');
  assert.doesNotMatch(ins.sql, /NOW\(\)/, 'computed_at must not be SQL NOW()');
  // (efr_id, grade, composite, onboarding_score, performance_score,
  //  completed_jobs, basis, computed_at) — computed_at is the 8th value,
  // and the ON DUPLICATE KEY branch binds the same Date again.
  assert.ok(ins.params[7] instanceof Date, 'computed_at (VALUES) is the 8th bound value');
  assert.ok(ins.params[8] instanceof Date, 'computed_at (ON DUPLICATE KEY) is the 9th bound value');
  assert.equal(ins.params[7].getTime(), ins.params[8].getTime(), 'both stamps share one instant');
});
