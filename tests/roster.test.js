/*
 * Team Roster — the rules every consumer (grid, dashboard, job routing) relies on.
 *
 *   1. Resolution: a planned row wins over the weekly working days, in BOTH
 *      directions; no row → weekly; no preference at all → 7 working days.
 *   2. Edit window: tomorrow … end of the 3rd month ahead (IST); admins may
 *      edit today; the past never.
 *   3. Scope: only your reporting-line descendants — never yourself, never
 *      someone outside your line (isRosterAdmin: anyone but yourself).
 *   4. Writes: only real changes are written and logged; reset logs → weekly.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { installFakePool } = require('./helpers/fake-pool');

// Hierarchy: 1 (TL) → 2, 3 ; 3 → 4 ; 9 reports to 8 (outside 1's line).
const ADJ = [
  { user_id: 1, reporting_manager: null }, { user_id: 2, reporting_manager: 1 },
  { user_id: 3, reporting_manager: 1 }, { user_id: 4, reporting_manager: 3 },
  { user_id: 8, reporting_manager: null }, { user_id: 9, reporting_manager: 8 },
];
const ALL_PR = { monday: 'PR', tuesday: 'PR', wednesday: 'PR', thursday: 'PR', friday: 'PR', saturday: 'PR', sunday: 'PR' };

let prefs = [];      // tbl_employee_attendance_preference rows
let rosterRows = []; // tbl_employee_roster rows (roster_date as 'YYYY-MM-DD')

const fake = installFakePool([
  [/FROM tbl_employee_attendance_preference/i, (sql, params) => prefs.filter((p) => params.includes(p.user_id))],
  [/FROM tbl_employee_roster\s+WHERE \(user_id, roster_date\) IN/i, (sql, params) => {
    const want = new Set();
    for (let i = 0; i < params.length; i += 2) want.add(`${params[i]}|${params[i + 1]}`);
    return rosterRows.filter((r) => want.has(`${r.user_id}|${r.roster_date}`));
  }],
  [/FROM tbl_employee_roster\s+WHERE user_id IN/i, (sql, params) => {
    const [from, to] = params.slice(-2);
    const ids = params.slice(0, -2);
    return rosterRows.filter((r) => ids.includes(r.user_id) && r.roster_date >= from && r.roster_date <= to);
  }],
  [/INSERT INTO tbl_employee_roster_action_log/i, () => ({ insertId: 77, affectedRows: 1 })],
  [/INSERT INTO tbl_employee_roster_change_log/i, () => ({ affectedRows: 1 })],
  [/INSERT INTO tbl_employee_roster\b/i, () => ({ affectedRows: 1 })],
  [/DELETE FROM tbl_employee_roster/i, () => ({ affectedRows: 1 })],
  [/INSERT INTO dashboard_notification_log/i, () => ({ insertId: 5, affectedRows: 1 })],
  [/SELECT user_id, reporting_manager/i, ADJ],
  [/FROM tbl_user u LEFT JOIN tbl_role r/i, (sql, params) =>
    params.filter((id) => ADJ.some((a) => a.user_id === id)).map((id) => ({ user_id: id, user_name: 'U' + id, user_code: 'E20000' + id, reporting_manager: null, role_name: 'Ops' }))],
]);

const roster = require('../services/roster.service');
const { todayIst, shiftYmd } = require('../utils/ist-calendar');

const writes = (re) => fake.calls.filter((c) => re.test(c.sql));
function reset() { fake.calls.length = 0; prefs = []; rosterRows = []; }

// ── 1. RESOLUTION ─────────────────────────────────────────────────────────
test('a planned row overrides the weekly days both ways; unplanned days follow the weekly days', async () => {
  reset();
  prefs = [{ user_id: 2, emp_code: 'E200002', default_shift_start: '10:00:00', ...ALL_PR, sunday: 'WO' }];
  rosterRows = [
    { user_id: 2, roster_date: '2026-10-04', day_type: 'PR', shift_start: '09:00', source: 'GRID' },   // Sunday: weekly WO → planned PR
    { user_id: 2, roster_date: '2026-10-01', day_type: 'WO', shift_start: null, source: 'PATTERN' },   // Thursday: weekly PR → planned WO
  ];
  const { byUser } = await roster.resolveDays([2], '2026-10-01', '2026-10-11');
  const d = byUser.get(2);
  assert.deepEqual([d['2026-10-04'].type, d['2026-10-04'].source, d['2026-10-04'].shift], ['PR', 'ROSTER', '09:00']);
  assert.deepEqual([d['2026-10-01'].type, d['2026-10-01'].source], ['WO', 'ROSTER']);
  assert.equal(d['2026-10-01'].shift, '10:00', 'a planned row without its own shift falls back to the default shift');
  assert.deepEqual([d['2026-10-11'].type, d['2026-10-11'].source], ['WO', 'WEEKLY'], 'the next Sunday has no row → weekly WO');
  assert.deepEqual([d['2026-10-05'].type, d['2026-10-05'].source], ['PR', 'WEEKLY']);
});

test('a user with no preference row is 7-day working — no invented week off', async () => {
  reset();
  const { byUser } = await roster.resolveDays([3], '2026-10-01', '2026-10-07');
  assert.ok(Object.values(byUser.get(3)).every((c) => c.type === 'PR' && c.source === 'WEEKLY'));
});

test('weekOffSet returns exactly the users off on that date', async () => {
  reset();
  prefs = [{ user_id: 2, ...ALL_PR, sunday: 'WO' }, { user_id: 3, ...ALL_PR }];
  rosterRows = [{ user_id: 3, roster_date: '2026-10-04', day_type: 'WO', shift_start: null, source: 'GRID' }];
  const off = await roster.weekOffSet([2, 3, 4], '2026-10-04');
  assert.deepEqual([...off].sort(), [2, 3]);
  const offMon = await roster.weekOffSet([2, 3, 4], '2026-10-05');
  assert.equal(offMon.size, 0, 'CONTROL — nobody is off on the Monday');
});

// ── 2. EDIT WINDOW ────────────────────────────────────────────────────────
test('window = tomorrow … end of the 3rd month ahead, in IST', () => {
  const w = roster.editWindow({ now: new Date('2026-09-29T06:00:00Z') });
  assert.deepEqual(w, { today: '2026-09-29', editFrom: '2026-09-30', editTo: '2026-12-31' });
  const admin = roster.editWindow({ canEditToday: true, now: new Date('2026-09-29T06:00:00Z') });
  assert.equal(admin.editFrom, '2026-09-29', 'a roster admin may edit today');
  // 20:00 UTC on 29 Sep is 01:30 IST on 30 Sep — the IST date must win.
  assert.equal(roster.editWindow({ now: new Date('2026-09-29T20:00:00Z') }).today, '2026-09-30');
  assert.equal(roster.editWindow({ now: new Date('2026-12-15T06:00:00Z') }).editTo, '2027-03-31', 'crosses the year');
});

// ── 3. SCOPE ──────────────────────────────────────────────────────────────
const tomorrow = () => shiftYmd(todayIst(), 1);

test('nobody plans their own row — not even a roster admin', async () => {
  reset();
  // For a TL the scope check alone rejects this (you are not your own
  // descendant); the ADMIN case is what exercises the explicit self-guard —
  // an admin otherwise reaches everyone. Mutation-tested: without the admin
  // case, deleting the self-guard left this file green.
  await assert.rejects(roster.saveCells({ actorId: 1, isAdmin: false, cells: [{ userId: 1, date: tomorrow(), dayType: 'WO' }] }),
    (e) => e.status === 403);
  await assert.rejects(roster.saveCells({ actorId: 8, isAdmin: true, cells: [{ userId: 8, date: tomorrow(), dayType: 'WO' }] }),
    (e) => e.status === 403);
  assert.equal(writes(/INSERT/i).length, 0);
});

test('a TL cannot plan someone outside their reporting line', async () => {
  reset();
  await assert.rejects(roster.saveCells({ actorId: 1, isAdmin: false, cells: [{ userId: 9, date: tomorrow(), dayType: 'WO' }] }),
    (e) => e.status === 403);
  assert.equal(writes(/INSERT/i).length, 0);
});

test('CONTROL — a TL CAN plan an indirect report (DFS, not just direct reports)', async () => {
  reset();
  const r = await roster.saveCells({ actorId: 1, isAdmin: false, cells: [{ userId: 4, date: tomorrow(), dayType: 'WO' }] });
  assert.equal(r.changed, 1);
});

test('a TL cannot edit today or the past; a roster admin can edit today', async () => {
  reset();
  await assert.rejects(roster.saveCells({ actorId: 1, isAdmin: false, cells: [{ userId: 2, date: todayIst(), dayType: 'WO' }] }),
    (e) => e.status === 400 && /outside the editable range/.test(e.message));
  await assert.rejects(roster.saveCells({ actorId: 8, isAdmin: true, cells: [{ userId: 2, date: shiftYmd(todayIst(), -1), dayType: 'WO' }] }),
    (e) => e.status === 400, 'the past is locked even for an admin');
  const r = await roster.saveCells({ actorId: 8, isAdmin: true, cells: [{ userId: 2, date: todayIst(), dayType: 'WO' }] });
  assert.equal(r.changed, 1, 'admin edits today, and may reach outside their own line');
});

// ── 4. WRITES + LOGS ──────────────────────────────────────────────────────
test('saving an unchanged planned cell writes and logs nothing', async () => {
  reset();
  rosterRows = [{ user_id: 2, roster_date: tomorrow(), day_type: 'WO', shift_start: null, source: 'GRID' }];
  const r = await roster.saveCells({ actorId: 1, isAdmin: false, cells: [{ userId: 2, date: tomorrow(), dayType: 'WO' }] });
  assert.equal(r.changed, 0);
  assert.equal(writes(/INSERT INTO tbl_employee_roster\b|INSERT INTO tbl_employee_roster_change_log/i).length, 0);
});

test('a first plan logs day_type NULL → WO against the action row', async () => {
  reset();
  await roster.saveCells({ actorId: 1, isAdmin: false, cells: [{ userId: 2, date: tomorrow(), dayType: 'WO' }] });
  const [log] = writes(/INSERT INTO tbl_employee_roster_change_log/i);
  assert.ok(log, 'change log written');
  assert.deepEqual(log.params.slice(0, 6), [77, 2, tomorrow(), 'day_type', null, 'WO']);
});

test('Fill From Pattern dry run counts and keeps hand edits, writing nothing', async () => {
  reset();
  const from = tomorrow();
  const to = shiftYmd(from, 6);                          // one full week
  rosterRows = [{ user_id: 2, roster_date: shiftYmd(from, 2), day_type: 'PR', shift_start: null, source: 'GRID' }];
  const off = roster.weekdayIndex(shiftYmd(from, 3));     // the weekday 3 days out
  const r = await roster.fillPattern({ actorId: 1, isAdmin: false, userIds: [2, 3], from, to, weekOffDays: [off], keepManual: true, dryRun: true });
  assert.deepEqual(r, { users: 2, cells: 13, keptManual: 1, wo: 2, pr: 11 });
  assert.equal(writes(/INSERT|DELETE/i).length, 0, 'a dry run must not write');
});

test('reset deletes the planned rows and logs each as → weekly (new_value NULL)', async () => {
  reset();
  rosterRows = [{ user_id: 2, roster_date: tomorrow(), day_type: 'WO', shift_start: null, source: 'GRID' }];
  const r = await roster.resetRange({ actorId: 1, isAdmin: false, userIds: [2], from: tomorrow(), to: tomorrow() });
  assert.equal(r.removed, 1);
  assert.equal(writes(/DELETE FROM tbl_employee_roster/i).length, 1);
  const [log] = writes(/INSERT INTO tbl_employee_roster_change_log/i);
  assert.deepEqual(log.params.slice(3, 6), ['day_type', 'WO', null]);
});

// ── 5. NOTIFY ─────────────────────────────────────────────────────────────
test('notify puts one inbox item per member, one line per day, week offs and shifts as the grid resolves them', async () => {
  reset();
  const from = tomorrow();
  const to = shiftYmd(from, 6);
  prefs = [{ user_id: 2, ...ALL_PR, default_shift_start: '09:30:00' }];
  rosterRows = [{ user_id: 2, roster_date: shiftYmd(from, 2), day_type: 'WO', shift_start: null, source: 'GRID' }];
  const r = await roster.notifyMembers({ actorId: 1, isAdmin: false, userIds: [2, 3], from, to });
  assert.equal(r.notified, 2);
  const items = writes(/INSERT INTO dashboard_notification_log/i);
  assert.equal(items.length, 2, 'one inbox row per member');
  const [uid, , title, desc] = items[0].params;
  assert.equal(uid, 2);
  assert.match(title, /^Your Roster: /);
  const lines = desc.split('\n');
  assert.equal(lines.length, 7, 'one line per day');
  assert.match(lines[2], / · Week Off\b/, 'the planned WO day (a holiday name may follow)');
  assert.match(lines[0], /Present · 09:30 AM/, 'shift shown 12-hour from the default shift');
  const [act] = writes(/INSERT INTO tbl_employee_roster_action_log/i);
  assert.equal(act.params[0], 'NOTIFY');
});

test('notify clips a past start to today and refuses members outside the line', async () => {
  reset();
  const r = await roster.notifyMembers({ actorId: 1, isAdmin: false, userIds: [2], from: shiftYmd(todayIst(), -5), to: todayIst() });
  assert.equal(r.from, todayIst());
  await assert.rejects(roster.notifyMembers({ actorId: 1, isAdmin: false, userIds: [9], from: tomorrow(), to: tomorrow() }),
    (e) => e.status === 403);
});
