/*
 * services/mobile-registration.service.js::setLanguage's fallback INSERT
 * stamps tbl_easyfixer_app.last_login_time (TIMESTAMP, converted the same
 * as a DATETIME column — 2026-09-16) with a bound Date, never SQL NOW().
 * db.js pool timezone '+05:30' stores a bound Date as the IST wall clock
 * regardless of host; NOW() takes the DB session's own (SYSTEM) zone.
 *
 * Runner: `node --test` (see npm test).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { setLanguage } = require('../services/mobile-registration.service');

function fakeRunner() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/^UPDATE tbl_easyfixer_app SET language/i.test(String(sql))) return [{ affectedRows: 0 }]; // no row → INSERT branch
      return [{ insertId: 1 }];
    },
  };
}

test('setLanguage INSERT (no existing row) binds last_login_time as a Date, never NOW()', async () => {
  const runner = fakeRunner();
  await setLanguage(4471, 'English', runner);

  const ins = runner.calls.find((c) => /INSERT INTO tbl_easyfixer_app/i.test(c.sql));
  assert.ok(ins, 'the fallback INSERT ran');
  assert.doesNotMatch(ins.sql, /NOW\(\)/, 'last_login_time must not be SQL NOW()');
  // (efr_id, language, last_login_time)
  assert.ok(ins.params[2] instanceof Date, 'last_login_time is the third bound value');
});
