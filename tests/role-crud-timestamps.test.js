/*
 * services/role.service.js — createRole / updateRole write tbl_role's
 * insert_date / update_date (TIMESTAMP). Both must be bound Dates, never
 * NOW(): the pool is `timezone: '+05:30'`, so a JS Date serialises to the
 * IST wall clock the columns expect, whereas NOW() resolves in the DB
 * session zone.
 *
 * Runner: `node --test` (see npm test).
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/^\s*SELECT role_id, role_name FROM tbl_role WHERE role_id = \?/i, () => [{ role_id: 3, role_name: 'Old Name' }]],
  [/^\s*INSERT INTO tbl_role/i, () => ({ insertId: 501 })],
  [/^\s*UPDATE tbl_role/i, () => ({ affectedRows: 1 })],
]);
const roleService = require('../services/role.service');

after(() => fake.restore());

// Zips an `(col, col, ...) VALUES (v, v, ...)` INSERT's column list against
// its VALUES tuple, walking `params` only for the entries that are `?` —
// tbl_role's INSERT mixes bound params with a literal (`role_status = 1`),
// so a plain column-index lookup misaligns against `params`.
function boundInsertValue(sql, params, col) {
  const cols = sql.replace(/^[\s\S]*INSERT INTO tbl_role\s*\(/i, '').split(')')[0]
    .split(',').map((s) => s.trim());
  const values = sql.replace(/^[\s\S]*VALUES\s*\(/i, '').split(')')[0]
    .split(',').map((s) => s.trim());
  let paramIndex = 0;
  for (let i = 0; i < cols.length; i++) {
    if (values[i] !== '?') continue;
    if (cols[i] === col) return params[paramIndex];
    paramIndex += 1;
  }
  return undefined;
}

test('createRole binds insert_date and update_date as the same Date, not NOW()', async () => {
  fake.reset();
  await roleService.createRole({ role_name: 'Ops Reviewer', createdBy: 9 });
  const ins = fake.calls.find((c) => /^\s*INSERT INTO tbl_role/i.test(c.sql));
  assert.ok(ins, 'the tbl_role INSERT must run');
  assert.doesNotMatch(ins.sql, /NOW\(\)/, 'insert_date/update_date must be bound Dates, not NOW()');
  const insertDate = boundInsertValue(ins.sql, ins.params, 'insert_date');
  const updateDate = boundInsertValue(ins.sql, ins.params, 'update_date');
  assert.ok(insertDate instanceof Date, 'insert_date must be a bound Date');
  assert.ok(updateDate instanceof Date, 'update_date must be a bound Date');
  assert.equal(insertDate.getTime(), updateDate.getTime(),
    'a new role stamps insert_date and update_date identically');
});

test('updateRole binds update_date as a Date, not NOW()', async () => {
  fake.reset();
  await roleService.updateRole(3, { role_name: 'Renamed Role' }, 9);
  const upd = fake.calls.find((c) => /^\s*UPDATE tbl_role/i.test(c.sql));
  assert.ok(upd, 'the tbl_role UPDATE must run');
  assert.doesNotMatch(upd.sql, /update_date = NOW\(\)/i);
  assert.match(upd.sql, /update_date = \?/i);
  const setClause = upd.sql.replace(/^[\s\S]*SET /i, '').split('WHERE')[0];
  const assignments = setClause.split(',').map((s) => s.trim());
  const idx = assignments.findIndex((a) => a.startsWith('update_date'));
  assert.ok(idx >= 0, 'update_date must be in the SET list');
  assert.ok(upd.params[idx] instanceof Date, 'update_date must be a bound Date');
});
