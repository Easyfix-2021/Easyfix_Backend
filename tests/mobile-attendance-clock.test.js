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
let props = []; // easyfix_properties rows; empty → code default (12)
const fake = installFakePool([
  [/FROM easyfix_properties/i, () => props],
  [/^\s*UPDATE tbl_easyfixer_attendance/i, () => ({ affectedRows: S.affectedRows })],
  [/^\s*INSERT INTO tbl_easyfixer_attendance/i, () => ({ insertId: 1 })],
]);
after(() => fake.restore());

const { markDay } = require('../services/mobile-attendance.service');
const properties = require('../services/properties.service');

// 2026-09-16 09:00 IST — before the noon cutoff, so these marks are allowed.
const MORNING_IST = new Date('2026-09-16T03:30:00Z');

test('markDay UPDATE binds updated_on as a Date, never NOW()', async () => {
  S.affectedRows = 1; // UPDATE branch hits (row already exists)
  await markDay(9, { date: '2026-09-16', morningSlot: true, eveningSlot: false }, MORNING_IST);

  const upd = fake.calls.find((c) => /UPDATE tbl_easyfixer_attendance/.test(c.sql));
  assert.ok(upd, 'the mark-day UPDATE ran');
  assert.doesNotMatch(upd.sql, /NOW\(\)/, 'updated_on must not be SQL NOW()');
  assert.ok(upd.params[2] instanceof Date, 'updated_on is the third bound value');
});

test('markDay INSERT (no existing row) binds insert_date as a Date, never NOW()', async () => {
  S.affectedRows = 0; // UPDATE affects nothing → INSERT branch runs
  fake.reset();
  await markDay(9, { date: '2026-09-16', morningSlot: true, eveningSlot: false }, MORNING_IST);

  const ins = fake.calls.find((c) => /INSERT INTO tbl_easyfixer_attendance/.test(c.sql));
  assert.ok(ins, 'the mark-day INSERT ran');
  assert.doesNotMatch(ins.sql, /NOW\(\)/, 'insert_date must not be SQL NOW()');
  // (easyfixer_id, morning_slot, evening_slot, is_leave_marked, created_on, insert_date)
  assert.ok(ins.params[4] instanceof Date, 'insert_date is the fifth bound value');
});

// ── Today-present cutoff: 12:00 IST (2026-09-22) ─────────────────────────
const at = (iso) => new Date(iso);

test('marking TODAY present at 11:59 IST is allowed', async () => {
  await markDay(9, { date: '2026-09-22', morningSlot: true, eveningSlot: true }, at('2026-09-22T06:29:00Z'));
});

test('marking TODAY present at 12:00 IST and 18:18 IST is rejected (400)', async () => {
  for (const now of [at('2026-09-22T06:30:00Z'), at('2026-09-22T12:48:00Z')]) {
    fake.reset();
    await assert.rejects(
      markDay(9, { date: '2026-09-22', morningSlot: true, eveningSlot: true }, now),
      (e) => e.status === 400 && /12:00 PM/.test(e.message),
    );
    assert.equal(fake.calls.length, 0, 'no write after the cutoff');
  }
});

test('un-marking TODAY (0/0) after the cutoff is still allowed', async () => {
  await markDay(9, { date: '2026-09-22', morningSlot: false, eveningSlot: false }, at('2026-09-22T12:48:00Z'));
});

test('marking TOMORROW present in the evening is allowed', async () => {
  await markDay(9, { date: '2026-09-23', morningSlot: true, eveningSlot: true }, at('2026-09-22T12:48:00Z'));
});

test('IST date, not UTC: 00:30 IST on the 23rd is before noon on the 23rd', async () => {
  // 2026-09-22T19:00Z = 2026-09-23 00:30 IST — UTC still says the 22nd.
  await markDay(9, { date: '2026-09-23', morningSlot: true, eveningSlot: false }, at('2026-09-22T19:00:00Z'));
});

test('marking a PAST day present is rejected', async () => {
  await assert.rejects(
    markDay(9, { date: '2026-09-21', morningSlot: true, eveningSlot: false }, at('2026-09-22T03:30:00Z')),
    (e) => e.status === 400 && /past date/.test(e.message),
  );
});

// ── Cutoff hour is the `attendance.today.cutoff_hour` property ───────────
async function withCutoff(value, fn) {
  props = value === undefined ? [] : [{ property_key: 'attendance.today.cutoff_hour', property_value: value }];
  await properties.flushCache();
  try { await fn(); } finally { props = []; await properties.flushCache(); }
}

test('property 10 → 10:30 IST rejected with "10:00 AM", 09:59 allowed', async () => {
  await withCutoff('10', async () => {
    await assert.rejects(
      markDay(9, { date: '2026-09-22', morningSlot: true, eveningSlot: true }, at('2026-09-22T05:00:00Z')),
      (e) => e.status === 400 && /before 10:00 AM/.test(e.message),
    );
    await markDay(9, { date: '2026-09-22', morningSlot: true, eveningSlot: true }, at('2026-09-22T04:29:00Z'));
  });
});

test('property 24 → no cutoff (23:30 IST allowed)', async () => {
  await withCutoff('24', () =>
    markDay(9, { date: '2026-09-22', morningSlot: true, eveningSlot: true }, at('2026-09-22T18:00:00Z')));
});

test('garbage property falls back to 12', async () => {
  await withCutoff('noon', async () => {
    const { todayCutoffHour } = require('../services/mobile-attendance.service');
    assert.equal(todayCutoffHour(), 12);
  });
});
