/*
 * Weekly working days (tbl_employee_attendance_preference) — the guarantees
 * the roster, the dashboard and job routing all lean on.
 *
 *   1. working_days is DERIVED from the seven days — a client-sent count is
 *      never stored, so the number can never disagree with the days.
 *   2. At least one working day; every day is PR or WO; nothing else.
 *   3. Every changed value lands in the change log (the Team Roster Update Log).
 *   4. Edit User backfills: a user without a row gets one on their next real
 *      edit, and an edit that changes nothing stays a no-op.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { installFakePool } = require('./helpers/fake-pool');

let storedPref = null;       // the tbl_employee_attendance_preference row, or null
let currentUser = null;

const fake = installFakePool([
  [/FROM tbl_employee_attendance_preference/i, () => (storedPref ? [storedPref] : [])],
  [/INSERT INTO tbl_employee_attendance_preference/i, () => ({ affectedRows: 1 })],
  [/INSERT INTO tbl_employee_roster_action_log/i, () => ({ insertId: 314, affectedRows: 1 })],
  [/INSERT INTO tbl_employee_roster_change_log/i, () => ({ affectedRows: 1 })],
  [/FROM tbl_user_personal_details/i, []],
  [/FROM tbl_user_allowed_stages/i, []],
  [/SELECT role_id, role_name/i, [{ role_id: 2, role_name: 'Admin', role_status: 1, menu_ids: '' }]],
  [/UPDATE tbl_user SET/i, () => ({ affectedRows: 1 })],
  [/FROM tbl_user\s+WHERE user_id/i, () => (currentUser ? [currentUser] : [])],
  [/FROM tbl_user\s+u/i, () => (currentUser ? [{ ...currentUser, role_name: 'Admin' }] : [])],
]);

const pref = require('../services/attendance-preference.service');
const userService = require('../services/user.service');

const ALL_PR = { monday: 'PR', tuesday: 'PR', wednesday: 'PR', thursday: 'PR', friday: 'PR', saturday: 'PR', sunday: 'PR' };
const storedRow = (days, extra = {}) => ({ user_id: 501, emp_code: 'E200501', default_shift_start: null, ...days, ...extra });
const writes = (re) => fake.calls.filter((c) => re.test(c.sql));

function reset() { fake.calls.length = 0; storedPref = null; currentUser = null; }

// ── 1 + 2. VALIDATION AND THE DERIVED COUNT ──────────────────────────────
test('a client-sent working_days is ignored — the count is derived from the days', async () => {
  reset();
  const { values } = pref.normalisePreference({ ...ALL_PR, sunday: 'WO', working_days: 7 });
  assert.equal('working_days' in values, false, 'the sent count must not survive normalisation');
  await pref.upsertPreference(501, 'E200501', values, 99);
  const [ins] = writes(/INSERT INTO tbl_employee_attendance_preference/i);
  assert.ok(ins, 'the preference row must be written');
  assert.equal(ins.params[2], 6, 'working_days column must be 6 (Sunday is WO), not the sent 7');
});

test('all seven days as Week Off is rejected', () => {
  const allWo = Object.fromEntries(Object.keys(ALL_PR).map((k) => [k, 'WO']));
  assert.throws(() => pref.normalisePreference(allWo), (e) => e.status === 400 && /at least one/i.test(e.message));
});

test('a missing day or an unknown code is rejected', () => {
  const { sunday: _omit, ...sixDays } = ALL_PR;
  assert.throws(() => pref.normalisePreference(sixDays), (e) => e.status === 400 && /sunday/.test(e.message));
  assert.throws(() => pref.normalisePreference({ ...ALL_PR, monday: 'HD' }), (e) => e.status === 400);
  assert.throws(() => pref.normalisePreference({ ...ALL_PR, default_shift_start: '25:00' }), (e) => e.status === 400);
});

test('CONTROL — a valid 6-day payload with a shift is accepted', () => {
  const { values } = pref.normalisePreference({ ...ALL_PR, saturday: 'wo', default_shift_start: '09:30' });
  assert.equal(values.saturday, 'WO', 'codes are case-insensitive on the way in');
  assert.equal(values.default_shift_start, '09:30');
  assert.equal(pref.workingDays(values), 6);
});

test('dayKeyOfDate maps calendar dates to weekday columns without timezone drift', () => {
  assert.equal(pref.dayKeyOfDate('2026-09-28'), 'monday');
  assert.equal(pref.dayKeyOfDate('2026-10-04'), 'sunday');
  assert.equal(pref.dayKeyOfDate('2026-10-02'), 'friday');
});

// ── 3. CHANGE LOG ────────────────────────────────────────────────────────
test('the first save that unselects Sunday logs PR → WO and 7 → 6 against the default', async () => {
  reset();
  await pref.upsertPreference(501, 'E200501', pref.normalisePreference({ ...ALL_PR, sunday: 'WO' }).values, 99);
  const [log] = writes(/INSERT INTO tbl_employee_roster_change_log/i);
  assert.ok(log, 'a change-log insert must happen');
  const rows = [];
  for (let i = 0; i < log.params.length; i += 7) rows.push(log.params.slice(i, i + 7));
  const byField = Object.fromEntries(rows.map(([, , field, o, n]) => [field, [o, n]]));
  assert.deepEqual(byField['pref.sunday'], ['PR', 'WO']);
  assert.deepEqual(byField['pref.working_days'], ['7', '6']);
  assert.equal(rows.length, 2, 'only the two real changes are logged');
  // The save is ONE Action Log row ('WORKING_DAYS'), and every change points at it.
  const [act] = writes(/INSERT INTO tbl_employee_roster_action_log/i);
  assert.ok(act, 'a WORKING_DAYS action row must be written');
  assert.match(act.sql, /'WORKING_DAYS'/);
  assert.equal(act.params[1], 'Week Off: Sun · Shift 10:00 AM');
  assert.ok(rows.every((r) => r[0] === 314), 'each change row carries the action id');
});

test('re-saving identical days with the same emp code writes nothing at all', async () => {
  reset();
  storedPref = storedRow({ ...ALL_PR, sunday: 'WO' });
  const r = await pref.upsertPreference(501, 'E200501', pref.normalisePreference({ ...ALL_PR, sunday: 'WO' }).values, 99);
  assert.deepEqual(r.changed, []);
  assert.equal(writes(/INSERT/i).length, 0);
});

// ── 4. EDIT USER WIRING (through updateUser, not the helper alone) ──────
function userRow(overrides = {}) {
  return {
    user_id: 501, user_type_id: 5, user_code: 'E200501', user_name: 'Test User', mobile_no: '9000000001',
    alternate_no: null, user_role: 2, city_id: 1,
    manage_clients: null, manage_cities: null, manage_states: null, manage_verticals: null,
    reporting_manager: null, user_status: 1, ...overrides,
  };
}
const update = (fields) => userService.updateUser(501, fields, 99, { enforcePersonalEmail: false });

test('Edit User of a user WITHOUT a row writes one even when the days are the 7-day default', async () => {
  reset();
  currentUser = userRow();
  const r = await update({ attendance_preference: ALL_PR });
  assert.notEqual(r && r.__unchanged, true, 'a missing row must not be reported as unchanged');
  assert.equal(writes(/INSERT INTO tbl_employee_attendance_preference/i).length, 1, 'the backfill row must be written');
});

test('Edit User that echoes the STORED days is a no-op — no preference write', async () => {
  reset();
  currentUser = userRow();
  storedPref = storedRow({ ...ALL_PR, sunday: 'WO' });
  const r = await update({ attendance_preference: { ...ALL_PR, sunday: 'WO' } });
  assert.equal(r && r.__unchanged, true);
  assert.equal(writes(/INSERT INTO tbl_employee_attendance_preference/i).length, 0);
});

test('an edit WITHOUT days (bulk path) backfills the default row but never touches stored days', async () => {
  reset();
  currentUser = userRow();
  await update({ mobile_no: '9000000002' });
  const [ins] = writes(/INSERT INTO tbl_employee_attendance_preference/i);
  assert.ok(ins, 'a real edit must ensure the row exists');
  assert.match(ins.sql, /ON DUPLICATE KEY UPDATE emp_code = VALUES\(emp_code\)\s*$/i,
    'on an existing row only emp_code may change — never the days');
});

test('an invalid day in Edit User rejects the whole edit before any write', async () => {
  reset();
  currentUser = userRow();
  await assert.rejects(update({ mobile_no: '9000000003', attendance_preference: { ...ALL_PR, friday: 'X' } }),
    (e) => e.status === 400);
  assert.equal(writes(/UPDATE tbl_user SET|INSERT/i).length, 0, 'nothing may be half-applied');
});

// ── 5. SHIFT: 30-minute slots, 10:00 by default ─────────────────────────
test('a shift off the :00/:30 grid is rejected; slot times are accepted', () => {
  assert.throws(() => pref.normalisePreference({ ...ALL_PR, default_shift_start: '09:45' }), (e) => e.status === 400);
  assert.equal(pref.normalisePreference({ ...ALL_PR, default_shift_start: '09:30' }).values.default_shift_start, '09:30');
  assert.equal(pref.normalisePreference({ ...ALL_PR, default_shift_start: '11:00:00' }).values.default_shift_start, '11:00');
});

test('no shift sent → 10:00; a stored NULL shift reads back as 10:00', async () => {
  reset();
  assert.equal(pref.normalisePreference({ ...ALL_PR }).values.default_shift_start, '10:00');
  assert.equal(pref.defaultPreference().default_shift_start, '10:00');
  storedPref = storedRow({ ...ALL_PR });                       // default_shift_start: null in the row
  assert.equal((await pref.loadPreference(501)).default_shift_start, '10:00');
});
