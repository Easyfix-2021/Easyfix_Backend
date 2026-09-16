/*
 * services/mobile-attendance.service.js stamps tbl_easyfixer_attendance's
 * updated_on / insert_date (both DATETIME) with a bound Date, never SQL
 * NOW() (2026-09-16). db.js pool timezone '+05:30' stores a bound Date as
 * the IST wall clock regardless of host; NOW() takes the DB session's own
 * (SYSTEM) zone. created_on is a DATE day-key, not a clock stamp — untouched.
 *
 * Runner: `node --test` (see npm test).
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const S = { affectedRows: 0 }; // 0 → markDay falls through to the INSERT branch
const fake = installFakePool([
  [/^\s*UPDATE tbl_easyfixer_attendance/i, () => ({ affectedRows: S.affectedRows })],
  [/^\s*INSERT INTO tbl_easyfixer_attendance/i, () => ({ insertId: 1 })],
]);
after(() => fake.restore());

const { markDay } = require('../services/mobile-attendance.service');

test('markDay UPDATE binds updated_on as a Date, never NOW()', async () => {
  S.affectedRows = 1; // UPDATE branch hits (row already exists)
  await markDay(9, { date: '2026-09-16', morningSlot: true, eveningSlot: false });

  const upd = fake.calls.find((c) => /UPDATE tbl_easyfixer_attendance/.test(c.sql));
  assert.ok(upd, 'the mark-day UPDATE ran');
  assert.doesNotMatch(upd.sql, /NOW\(\)/, 'updated_on must not be SQL NOW()');
  assert.ok(upd.params[2] instanceof Date, 'updated_on is the third bound value');
});

test('markDay INSERT (no existing row) binds insert_date as a Date, never NOW()', async () => {
  S.affectedRows = 0; // UPDATE affects nothing → INSERT branch runs
  fake.reset();
  await markDay(9, { date: '2026-09-16', morningSlot: true, eveningSlot: false });

  const ins = fake.calls.find((c) => /INSERT INTO tbl_easyfixer_attendance/.test(c.sql));
  assert.ok(ins, 'the mark-day INSERT ran');
  assert.doesNotMatch(ins.sql, /NOW\(\)/, 'insert_date must not be SQL NOW()');
  // (easyfixer_id, morning_slot, evening_slot, is_leave_marked, created_on, insert_date)
  assert.ok(ins.params[4] instanceof Date, 'insert_date is the fifth bound value');
});
