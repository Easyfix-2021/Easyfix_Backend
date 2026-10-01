/*
 * Employee Hub — leave (services/leave.service.js) and its roster layer
 * (services/roster.service.js resolveDays + the four roster writers).
 *
 *   1. Every §4 create rule (LV lead, SL today only, no past, to ≥ from,
 *      half = one date, working days, overlap incl. complementary halves).
 *   2. Approver snapshot: active RH, else NULL → Roster Admins.
 *   3. withdraw / cancel / decide × requester / RH / Roster Admin / stranger.
 *   4. resolveDays: approved full wins (locked), half keeps PR + leave,
 *      pending is an overlay, cancelled vanishes.
 *   5. Roster lock on saveCells / fillPattern / resetRange / bulk upload.
 *   6. Alerts exclude acked; me() summary.
 *
 * In-memory fake pool — no DB is touched. Dates are relative to today (IST);
 * holidays are pinned by the test, never the real calendar.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');

const { installFakePool } = require('./helpers/fake-pool');

// 1 = RH of 2 and 3 · 5 reports to 9 (INACTIVE) · 8 = Roster Admin (no team).
// A second line, 6 → 7 → 4, gives a skip-level manager (6 over 4) that the
// grid / roster tests rooted at 1 never see.
const USERS = {
  1: { user_name: 'Rhea', official_email: 'rhea@easyfix.in', reporting_manager: null, user_status: 1 },
  2: { user_name: 'Ravi', official_email: 'ravi@easyfix.in', reporting_manager: 1, user_status: 1 },
  3: { user_name: 'Sam', official_email: 'sam@easyfix.in', reporting_manager: 1, user_status: 1 },
  4: { user_name: 'Kai', official_email: 'kai@easyfix.in', reporting_manager: 7, user_status: 1 },
  5: { user_name: 'Nora', official_email: 'nora@easyfix.in', reporting_manager: 9, user_status: 1 },
  6: { user_name: 'Mia', official_email: 'mia@easyfix.in', reporting_manager: null, user_status: 1 },
  7: { user_name: 'Leo', official_email: 'leo@easyfix.in', reporting_manager: 6, user_status: 1 },
  8: { user_name: 'Ada', official_email: 'ada@easyfix.in', reporting_manager: null, user_status: 1 },
  9: { user_name: 'Gone', official_email: 'gone@easyfix.in', reporting_manager: null, user_status: 0 },
};
const ROSTER_ADMINS = [8];
const ADJ = Object.entries(USERS).filter(([, u]) => u.user_status === 1).map(([id, u]) => ({ user_id: Number(id), reporting_manager: u.reporting_manager }));

let requests = [];   // tbl_employee_leave_request
let rosterRows = []; // tbl_employee_roster
let acks = [];       // tbl_user_alert_ack
let nextId = 100;

const fmt = (v) => (v instanceof Date ? v.toISOString().slice(0, 19).replace('T', ' ') : v);
const withNames = (r) => ({ ...r, user_name: USERS[r.user_id]?.user_name, user_code: 'E' + r.user_id, role_name: 'Ops', decided_by_name: r.decided_by ? USERS[r.decided_by]?.user_name : null });
/** Honour the status IN (…) list written in the SQL itself, so a wrong list is caught. */
function statusFilter(sql) {
  const m = /status IN \(([^)]*)\)/.exec(sql);
  const allowed = m ? m[1].split(',').map((s) => s.trim().replace(/'/g, '')) : null;
  return (r) => !allowed || allowed.includes(r.status);
}
/**
 * Honour the approvals WHERE as written: the PENDING / history arm, the team
 * `r.user_id IN (…)` list, the Roster Admin `r.approver_user_id IS NULL` arm
 * and the `r.user_id <> ?` self-exclusion — each only while its clause is in
 * the SQL, so a dropped or widened clause shows up as a wrong row set.
 */
function approvalsFilter(sql, params) {
  const inList = /r\.user_id IN \(([^)]*)\)/.exec(sql);
  const n = inList ? inList[1].split(',').length : 0;
  const team = params.slice(0, n);
  const noRh = /r\.approver_user_id IS NULL/.test(sql);
  const self = /r\.user_id <> \?/.test(sql) ? params[n] : undefined;
  return (r) => (!/r\.status = 'PENDING'/.test(sql) || r.status === 'PENDING')
    && (!/r\.status <> 'PENDING'/.test(sql) || r.status !== 'PENDING')
    && ((!inList && !noRh) || (inList && team.includes(r.user_id)) || (noRh && r.approver_user_id === null))
    && (self === undefined || r.user_id !== self);
}

const fake = installFakePool([
  [/FROM tbl_employee_attendance_preference/i, []],
  [/FROM tbl_employee_roster\s+WHERE \(user_id, roster_date\) IN/i, () => []],
  [/FROM tbl_employee_roster\s+WHERE user_id IN/i, (sql, params) => {
    const [from, to] = params.slice(-2);
    const ids = params.slice(0, -2);
    return rosterRows.filter((r) => ids.includes(r.user_id) && r.roster_date >= from && r.roster_date <= to);
  }],
  [/INSERT INTO tbl_employee_roster_action_log/i, () => ({ insertId: 77 })],
  [/INSERT INTO tbl_employee_roster_change_log/i, () => ({ affectedRows: 1 })],
  [/INSERT INTO tbl_employee_roster\b/i, () => ({ affectedRows: 1 })],
  [/DELETE FROM tbl_employee_roster/i, () => ({ affectedRows: 1 })],
  // roster.service loadLeaveRows
  [/FROM tbl_employee_leave_request\s+WHERE user_id IN/i, (sql, params) => {
    const [to, from] = params.slice(-2);
    const ids = params.slice(0, -2);
    return requests.filter((r) => ids.includes(r.user_id) && statusFilter(sql)(r) && r.from_date <= to && r.to_date >= from);
  }],
  // leave.service assertNoOverlap
  [/FROM tbl_employee_leave_request\s+WHERE user_id = \?/i, (sql, [uid, to, from]) =>
    requests.filter((r) => r.user_id === uid && statusFilter(sql)(r) && r.from_date <= to && r.to_date >= from)],
  [/FROM tbl_employee_leave_request r WHERE r\.id = \? FOR UPDATE/i, (sql, [id]) => requests.filter((r) => r.id === id)],
  // Each filter applies only while its clause is in the SQL, so dropping a clause is caught.
  [/LEFT JOIN tbl_user_alert_ack/i, (sql, [uid]) => requests.filter((r) => r.status === 'PENDING'
    && (!/r\.kind = 'SL'/.test(sql) || r.kind === 'SL') && r.user_id !== uid
    && (r.approver_user_id === uid || (/OR r\.approver_user_id IS NULL/.test(sql) && r.approver_user_id === null))
    && (!/a\.user_id IS NULL/.test(sql) || !acks.some((a) => a.user_id === uid && a.alert_key === `leave:${r.id}`))).map(withNames)],
  [/LEFT JOIN tbl_user d[\s\S]*WHERE r\.id = \?/i, (sql, [id]) => requests.filter((r) => r.id === id).map(withNames)],
  // me() My Requests — the status IN list, the `to_date >= ?` floor and the ORDER BY as written.
  [/LEFT JOIN tbl_user d[\s\S]*WHERE r\.user_id = \?/i, (sql, [uid, floor]) => requests
    .filter((r) => r.user_id === uid && statusFilter(sql)(r) && (!/r\.to_date >= \?/.test(sql) || r.to_date >= floor))
    .sort((a, b) => (/ORDER BY r\.from_date, r\.id/.test(sql) ? a.from_date.localeCompare(b.from_date) || a.id - b.id : b.id - a.id))
    .map(withNames)],
  [/SELECT COUNT\(\*\) AS total FROM tbl_employee_leave_request/i, (sql, params) => [{ total: requests.filter(approvalsFilter(sql, params)).length }]],
  [/LEFT JOIN tbl_user d[\s\S]*LIMIT \?, \?/i, (sql, params) => requests.filter(approvalsFilter(sql, params)).map(withNames)],
  [/INSERT INTO tbl_employee_leave_request \(([^)]*)\)/i, (sql, params) => {
    const cols = /\(([^)]*)\)/.exec(sql)[1].split(',').map((c) => c.trim());
    const row = { id: nextId++, decided_by: null, decided_at: null, decision_note: null, cancelled_by: null, cancelled_at: null, cancel_note: null };
    cols.forEach((c, i) => { row[c] = fmt(params[i]); });
    requests.push(row);
    return { insertId: row.id };
  }],
  [/UPDATE tbl_employee_leave_request SET/i, (sql, params) => {
    const cols = /SET (.*) WHERE id = \?/s.exec(sql)[1].split(',').map((c) => c.trim().split(' ')[0]);
    const row = requests.find((r) => r.id === params[params.length - 1]);
    cols.forEach((c, i) => { row[c] = fmt(params[i]); });
    return { affectedRows: 1 };
  }],
  [/INSERT INTO tbl_user_alert_ack/i, (sql, [uid, key]) => { if (!acks.some((a) => a.user_id === uid && a.alert_key === key)) acks.push({ user_id: uid, alert_key: key }); return { affectedRows: 1 }; }],
  [/INSERT INTO dashboard_notification_log/i, () => ({ insertId: 5 })],
  [/JOIN tbl_user m ON m\.user_id = u\.reporting_manager AND m\.user_status = 1/i, (sql, [uid]) => {
    const rm = USERS[uid]?.reporting_manager;
    return rm && USERS[rm]?.user_status === 1 ? [{ user_id: rm }] : [];
  }],
  [/ma\.action_name = 'isRosterAdmin'/i, () => ROSTER_ADMINS.map((id) => ({ user_id: id }))],
  [/SELECT user_id, user_name, official_email FROM tbl_user WHERE user_id IN/i, (sql, params) =>
    params.filter((id) => USERS[id]).map((id) => ({ user_id: id, ...USERS[id] }))],
  [/SELECT user_id, reporting_manager/i, ADJ],
  [/SELECT user_id FROM tbl_user WHERE user_status = 1 AND user_type_id = 5/i, () => ADJ.map((r) => ({ user_id: r.user_id }))],
  [/FROM tbl_user u LEFT JOIN tbl_role r/i, (sql, params) =>
    params.filter((id) => ADJ.some((a) => a.user_id === id)).map((id) => ({ user_id: id, user_name: USERS[id].user_name, user_code: 'E' + id, reporting_manager: null, role_name: 'Ops' }))],
]);

process.env.CRM_PUBLIC_BASE_URL = 'https://crm.example.test/';
let HOL = [];
const holidays = require('../services/holiday.service');
holidays.getRange = ({ from, to }) => HOL.filter((h) => h.date >= from && h.date <= to);
const mails = [];
let mailThrows = false;
require('../services/email.service').send = async (m) => { if (mailThrows) throw new Error('graph down'); mails.push(m); return { accepted: true }; };

const leave = require('../services/leave.service');
const roster = require('../services/roster.service');
const bulk = require('../services/roster-bulk.service');
const { todayIst, shiftYmd, currentIstMonth, monthBounds } = require('../utils/ist-calendar');

const T = todayIst();
const D = (n) => shiftYmd(T, n);
function reset() { fake.calls.length = 0; requests = []; rosterRows = []; acks = []; HOL = []; mails.length = 0; mailThrows = false; }
function seed(r) {
  const row = { id: nextId++, kind: 'LV', duration: 'FULL', days: 1, reason: null, status: 'PENDING', approver_user_id: 1, decided_by: null, decided_at: null,
    decision_note: null, cancelled_by: null, cancelled_at: null, cancel_note: null, created_at: `${T} 09:00:00`, ...r };
  requests.push(row);
  return row;
}
const wo = (uid, d) => rosterRows.push({ user_id: uid, roster_date: d, day_type: 'WO', shift_start: null, source: 'GRID' });
const dry = (body, uid = 2) => leave.create({ userId: uid, duration: 'FULL', ...body, dryRun: true });
const rejects = (p, status, re) => assert.rejects(p, (e) => e.status === status && (!re || re.test(e.message)));

// ── 1. CREATE RULES ───────────────────────────────────────────────────────
test('LV starts at least 2 days ahead: today+1 → 400, today+2 → ok', async () => {
  reset();
  await rejects(dry({ kind: 'LV', fromDate: D(1), toDate: D(1) }), 400, /2 days ahead/);
  assert.deepEqual(await dry({ kind: 'LV', fromDate: D(2), toDate: D(4) }), { days: 3 });
});

test('SL is today only — a future day or a range is refused', async () => {
  reset();
  assert.deepEqual(await dry({ kind: 'SL', fromDate: T, toDate: T }), { days: 1 });
  await rejects(dry({ kind: 'SL', fromDate: D(1), toDate: D(1) }), 400, /today only/);
  await rejects(dry({ kind: 'SL', fromDate: T, toDate: D(1) }), 400, /today only/);
});

test('never the past — neither kind', async () => {
  reset();
  await rejects(dry({ kind: 'LV', fromDate: D(-1), toDate: D(3) }), 400, /past/);
  await rejects(dry({ kind: 'SL', fromDate: D(-1), toDate: D(-1) }), 400, /past/);
});

test('the end date must not precede the start date', async () => {
  reset();
  await rejects(dry({ kind: 'LV', fromDate: D(5), toDate: D(4) }), 400, /on or after/);
});

test('a half day is one date and counts 0.5', async () => {
  reset();
  await rejects(dry({ kind: 'LV', fromDate: D(3), toDate: D(4), duration: 'FIRST_HALF' }), 400, /single date/);
  assert.deepEqual(await dry({ kind: 'LV', fromDate: D(3), toDate: D(3), duration: 'SECOND_HALF' }), { days: 0.5 });
});

test('working days skip week offs and holidays; none at all → 400', async () => {
  reset();
  wo(2, D(3));
  HOL = [{ date: D(4), name: 'Test Day' }];
  assert.deepEqual(await dry({ kind: 'LV', fromDate: D(2), toDate: D(5) }), { days: 2 });
  await rejects(dry({ kind: 'LV', fromDate: D(3), toDate: D(4) }), 400, /week offs or holidays/);
});

test('overlap with PENDING or APPROVED → 409; REJECTED / WITHDRAWN / CANCELLED do not block', async () => {
  reset();
  const p = seed({ user_id: 2, from_date: D(5), to_date: D(7) });
  await rejects(dry({ kind: 'LV', fromDate: D(7), toDate: D(9) }), 409, /pending/);
  p.status = 'APPROVED';
  await rejects(dry({ kind: 'LV', fromDate: D(3), toDate: D(5) }), 409, /approved/);
  for (const s of ['REJECTED', 'WITHDRAWN', 'CANCELLED']) {
    p.status = s;
    assert.deepEqual(await dry({ kind: 'LV', fromDate: D(5), toDate: D(5) }), { days: 1 }, s);
  }
  assert.deepEqual(await dry({ kind: 'LV', fromDate: D(5), toDate: D(5) }, 3), { days: 1 }, 'another user is never an overlap');
});

test('two halves of one date are allowed; the same half or a full day on it is not', async () => {
  reset();
  seed({ user_id: 2, from_date: D(3), to_date: D(3), duration: 'FIRST_HALF', days: 0.5 });
  assert.deepEqual(await dry({ kind: 'LV', fromDate: D(3), toDate: D(3), duration: 'SECOND_HALF' }), { days: 0.5 });
  await rejects(dry({ kind: 'LV', fromDate: D(3), toDate: D(3), duration: 'FIRST_HALF' }), 409);
  await rejects(dry({ kind: 'LV', fromDate: D(3), toDate: D(3) }), 409);
});

// ── 2. CREATE + APPROVER + NOTIFY ─────────────────────────────────────────
test('create snapshots the RH, mails RH cc employee with the review link, inbox for the RH', async () => {
  reset();
  const { request } = await leave.create({ userId: 2, kind: 'LV', fromDate: D(2), toDate: D(3), duration: 'FULL', reason: 'Wedding <3' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].approver_user_id, 1);
  assert.equal(requests[0].status, 'PENDING');
  assert.equal(requests[0].days, 2);
  assert.equal(request.status, 'PENDING');
  assert.equal(request.canWithdraw, true);
  assert.equal(request.canCancel, false);
  assert.equal(mails.length, 1);
  assert.deepEqual(mails[0].to, ['rhea@easyfix.in']);
  assert.deepEqual(mails[0].cc, ['ravi@easyfix.in']);
  assert.match(mails[0].html, new RegExp(`href="https://crm\\.example\\.test/employee-hub/approvals\\?request=${request.id}"`));
  assert.match(mails[0].html, /Review In CRM/);
  assert.match(mails[0].html, /Wedding &lt;3/, 'the reason is HTML-escaped');
  const inboxRows = fake.calls.filter((c) => /INSERT INTO dashboard_notification_log/.test(c.sql));
  assert.deepEqual(inboxRows.map((c) => c.params[0]), [1]);
});

test('no RH (manager inactive) → approver NULL, routed to the Roster Admins', async () => {
  reset();
  await leave.create({ userId: 5, kind: 'SL', fromDate: T, toDate: T, duration: 'FIRST_HALF', reason: 'Fever' });
  assert.equal(requests[0].approver_user_id, null);
  assert.deepEqual(mails[0].to, ['ada@easyfix.in']);
});

test('no base URL → the mail has no link; a mail failure never fails the request', async () => {
  reset();
  const saved = process.env.CRM_PUBLIC_BASE_URL;
  delete process.env.CRM_PUBLIC_BASE_URL;
  try {
    await leave.create({ userId: 2, kind: 'LV', fromDate: D(2), toDate: D(2), duration: 'FULL', reason: 'Errand' });
    assert.doesNotMatch(mails[0].html, /href=/);
    mailThrows = true;
    const { request } = await leave.create({ userId: 3, kind: 'LV', fromDate: D(2), toDate: D(2), duration: 'FULL', reason: 'Errand' });
    assert.equal(request.status, 'PENDING');
    assert.ok(fake.calls.some((c) => /INSERT INTO dashboard_notification_log/.test(c.sql) && c.params[0] === 1), 'inbox still written');
  } finally { process.env.CRM_PUBLIC_BASE_URL = saved; }
});

test('a reason is mandatory on submit (blank / missing → 400, nothing written); a dry run needs none', async () => {
  reset();
  for (const reason of [undefined, null, '', '   ']) {
    await rejects(leave.create({ userId: 2, kind: 'LV', fromDate: D(2), toDate: D(2), duration: 'FULL', reason }), 400, /Enter a reason/);
  }
  assert.equal(fake.calls.filter((c) => /tbl_employee_leave_request/.test(c.sql)).length, 0, 'refused before any rule or write');
  assert.equal(requests.length, 0);
  assert.equal(mails.length, 0);
  assert.deepEqual(await leave.create({ userId: 2, kind: 'LV', fromDate: D(2), toDate: D(2), duration: 'FULL', dryRun: true }), { days: 1 });
  const { request } = await leave.create({ userId: 2, kind: 'LV', fromDate: D(2), toDate: D(2), duration: 'FULL', reason: ' Visa ' });
  assert.equal(request.status, 'PENDING', 'CONTROL — the same body with a reason is accepted');
});

// ── 3. AUTHORISATION MATRIX ───────────────────────────────────────────────
test('withdraw: only the requester, only while PENDING', async () => {
  reset();
  const r = seed({ user_id: 2, from_date: D(4), to_date: D(4) });
  await rejects(leave.withdraw({ actorId: 1, id: r.id }), 403);
  await rejects(leave.withdraw({ actorId: 8, id: r.id }), 403);
  await rejects(leave.withdraw({ actorId: 3, id: r.id }), 403);
  const out = await leave.withdraw({ actorId: 2, id: r.id });
  assert.equal(out.request.status, 'WITHDRAWN');
  await rejects(leave.withdraw({ actorId: 2, id: r.id }), 409);
  await rejects(leave.withdraw({ actorId: 2, id: 999999 }), 404);
});

test('decide: the reporting line decides (RH, mid-level and skip-level); a peer, a report, an outside manager → 403; never your own; only PENDING', async () => {
  reset();
  const r = seed({ user_id: 2, from_date: D(4), to_date: D(4) });
  await rejects(leave.decide({ actorId: 3, isAdmin: false, id: r.id, decision: 'APPROVE' }), 403, /not from your team/);
  await rejects(leave.decide({ actorId: 6, isAdmin: false, id: r.id, decision: 'APPROVE' }), 403, /not from your team/);
  await rejects(leave.decide({ actorId: 2, isAdmin: true, id: r.id, decision: 'APPROVE' }), 403, /your own/);
  await rejects(leave.decide({ actorId: 1, isAdmin: false, id: r.id, decision: 'REJECT', note: ' ' }), 400, /note/);
  const out = await leave.decide({ actorId: 1, isAdmin: false, id: r.id, decision: 'APPROVE' });
  assert.equal(out.request.status, 'APPROVED');
  assert.equal(out.request.decidedByName, 'Rhea');
  assert.deepEqual(mails.at(-1).to, ['ravi@easyfix.in']);
  assert.deepEqual(mails.at(-1).cc, ['rhea@easyfix.in']);
  await rejects(leave.decide({ actorId: 1, isAdmin: false, id: r.id, decision: 'REJECT', note: 'late' }), 409);

  // 6 → 7 → 4: the skip-level manager and the mid-level both decide for 4; 4 never decides for 7.
  const skip = seed({ user_id: 4, approver_user_id: 7, from_date: D(4), to_date: D(4) });
  const bySkip = await leave.decide({ actorId: 6, isAdmin: false, id: skip.id, decision: 'APPROVE' });
  assert.deepEqual([bySkip.request.status, bySkip.request.decidedByName], ['APPROVED', 'Mia']);
  const mid = seed({ user_id: 4, approver_user_id: 7, from_date: D(5), to_date: D(5) });
  assert.equal((await leave.decide({ actorId: 7, isAdmin: false, id: mid.id, decision: 'REJECT', note: 'Clash' })).request.status, 'REJECTED');
  const up = seed({ user_id: 7, approver_user_id: 6, from_date: D(4), to_date: D(4) });
  await rejects(leave.decide({ actorId: 4, isAdmin: false, id: up.id, decision: 'APPROVE' }), 403, /not from your team/);
  await rejects(leave.decide({ actorId: 1, isAdmin: false, id: up.id, decision: 'APPROVE' }), 403, /not from your team/);
});

test('decide: a Roster Admin is NOT "decide anyone" — only RH-less requests, never a team-owned one, never their own', async () => {
  reset();
  const owned = seed({ user_id: 3, from_date: D(4), to_date: D(4) });
  await rejects(leave.decide({ actorId: 8, isAdmin: true, id: owned.id, decision: 'REJECT', note: 'Short staffed' }), 403, /not from your team/);
  assert.equal(owned.status, 'PENDING');
  const orphan = seed({ user_id: 5, approver_user_id: null, from_date: D(4), to_date: D(4) });
  await rejects(leave.decide({ actorId: 3, isAdmin: false, id: orphan.id, decision: 'APPROVE' }), 403, /not from your team/);
  const byAdmin = await leave.decide({ actorId: 8, isAdmin: true, id: orphan.id, decision: 'REJECT', note: 'Short staffed' });
  assert.deepEqual([byAdmin.request.status, byAdmin.request.decisionNote], ['REJECTED', 'Short staffed']);
  // The admin's OWN request also has no RH (8 reports to nobody) — the NULL arm must not let them decide it.
  const ownOrphan = seed({ user_id: 8, approver_user_id: null, from_date: D(4), to_date: D(4) });
  await rejects(leave.decide({ actorId: 8, isAdmin: true, id: ownOrphan.id, decision: 'APPROVE' }), 403, /your own/);
  assert.equal(ownOrphan.status, 'PENDING');
});

test('approve re-counts working days from the current roster', async () => {
  reset();
  const r = seed({ user_id: 2, from_date: D(3), to_date: D(6), days: 4 });
  wo(2, D(4));
  await leave.decide({ actorId: 1, isAdmin: false, id: r.id, decision: 'APPROVE' });
  assert.equal(r.days, 3);
});

test('cancel before the first day: requester, the reporting line, or a Roster Admin on an RH-less leave → CANCELLED; anyone else → 403', async () => {
  reset();
  const a = seed({ user_id: 2, from_date: D(3), to_date: D(4), status: 'APPROVED' });
  await rejects(leave.cancel({ actorId: 3, isAdmin: false, id: a.id }), 403);
  await rejects(leave.cancel({ actorId: 6, isAdmin: false, id: a.id }), 403, /reporting line/);
  await rejects(leave.cancel({ actorId: 8, isAdmin: true, id: a.id }), 403, /reporting line/);
  assert.equal(a.status, 'APPROVED');
  assert.equal((await leave.cancel({ actorId: 2, isAdmin: false, id: a.id })).request.status, 'CANCELLED');
  await rejects(leave.cancel({ actorId: 2, isAdmin: false, id: a.id }), 409, /approved/);
  const b = seed({ user_id: 2, from_date: D(3), to_date: D(4), status: 'APPROVED' });
  assert.equal((await leave.cancel({ actorId: 1, isAdmin: false, id: b.id, note: 'Need you' })).request.status, 'CANCELLED');
  assert.deepEqual(mails.at(-1).to, ['rhea@easyfix.in'], 'a cancellation mails the RH');
  const skip = seed({ user_id: 4, approver_user_id: 7, from_date: D(3), to_date: D(4), status: 'APPROVED' });
  assert.equal((await leave.cancel({ actorId: 6, isAdmin: false, id: skip.id })).request.status, 'CANCELLED', 'skip-level');
  const orphan = seed({ user_id: 5, approver_user_id: null, from_date: D(3), to_date: D(4), status: 'APPROVED' });
  await rejects(leave.cancel({ actorId: 3, isAdmin: false, id: orphan.id }), 403);
  assert.equal((await leave.cancel({ actorId: 8, isAdmin: true, id: orphan.id })).request.status, 'CANCELLED');
  await rejects(leave.cancel({ actorId: 2, isAdmin: false, id: seed({ user_id: 2, from_date: D(9), to_date: D(9) }).id }), 409, /approved/);
});

test('cancel after the start: the requester is refused; the RH trims to yesterday and it stays APPROVED (ended early)', async () => {
  reset();
  const r = seed({ user_id: 2, from_date: D(-2), to_date: D(3), status: 'APPROVED', days: 6 });
  await rejects(leave.cancel({ actorId: 2, isAdmin: false, id: r.id }), 403, /started/);
  const out = await leave.cancel({ actorId: 1, isAdmin: false, id: r.id, note: 'Back early' });
  assert.equal(out.request.status, 'APPROVED');
  assert.equal(out.request.toDate, D(-1));
  assert.equal(out.request.days, 2);
  assert.equal(out.request.endedEarly, true);
  assert.equal(r.cancelled_by, 1);
  assert.equal(out.request.canCancel, false, 'nothing left to cancel');
  await rejects(leave.cancel({ actorId: 8, isAdmin: true, id: r.id }), 409, /over/);
});

test('can* flags follow the viewer', async () => {
  reset();
  const r = seed({ user_id: 2, from_date: D(3), to_date: D(3) });
  const skip = seed({ user_id: 4, approver_user_id: 7, from_date: D(3), to_date: D(3) });
  const done = seed({ user_id: 3, from_date: D(5), to_date: D(5), status: 'APPROVED' });
  const out = await leave.approvals({ actorId: 1, isAdmin: false, status: 'pending' });
  const row = out.items.find((i) => i.id === r.id);
  assert.deepEqual([row.canDecide, row.canWithdraw, row.canCancel, row.userName, row.empCode], [true, false, false, 'Ravi', 'E2']);
  const hist = await leave.approvals({ actorId: 1, isAdmin: false, status: 'history' });
  assert.deepEqual(hist.items.map((i) => [i.id, i.canDecide, i.canCancel]), [[done.id, false, true]]);
  const bySkip = await leave.approvals({ actorId: 6, isAdmin: false, status: 'pending' });
  assert.deepEqual(bySkip.items.map((i) => [i.id, i.canDecide]), [[skip.id, true]], 'skip-level sees and may decide');
  assert.deepEqual(await leave.approvals({ actorId: 3, isAdmin: false, status: 'pending' }), { total: 0, items: [] }, 'a peer sees nothing');
  const own = await leave.approvals({ actorId: 2, isAdmin: true, status: 'pending' });
  assert.equal(own.items.some((i) => i.id === r.id), false, 'never your own — not even as a Roster Admin');
});

test('approvals scope: the reporting line (any depth), never your own; a Roster Admin adds only RH-less requests', async () => {
  reset();
  const p2 = seed({ user_id: 2, from_date: D(3), to_date: D(3) });
  const p3 = seed({ user_id: 3, from_date: D(4), to_date: D(4) });
  const p4 = seed({ user_id: 4, approver_user_id: 7, from_date: D(3), to_date: D(3) });
  const p7 = seed({ user_id: 7, approver_user_id: 6, from_date: D(3), to_date: D(3) });
  const p1 = seed({ user_id: 1, approver_user_id: null, from_date: D(3), to_date: D(3) }); // the RH's own — no RH above her
  const p5 = seed({ user_id: 5, approver_user_id: null, from_date: D(3), to_date: D(3) });
  const p8 = seed({ user_id: 8, approver_user_id: null, from_date: D(3), to_date: D(3) }); // the admin's own
  const h2 = seed({ user_id: 2, from_date: D(6), to_date: D(6), status: 'APPROVED' });
  const ids = async (args) => {
    const out = await leave.approvals(args);
    const got = out.items.map((i) => i.id).sort((a, b) => a - b);
    assert.equal(out.total, got.length, 'COUNT runs the same WHERE');
    return got;
  };
  const sorted = (...rows) => rows.map((x) => x.id).sort((a, b) => a - b);

  assert.deepEqual(await ids({ actorId: 1, isAdmin: false }), sorted(p2, p3), 'RH: her team only — not her own, not RH-less');
  assert.deepEqual(await ids({ actorId: 1, isAdmin: false, status: 'history' }), sorted(h2));
  assert.deepEqual(await ids({ actorId: 6, isAdmin: false }), sorted(p7, p4), 'skip-level reaches 4 through 7');
  assert.deepEqual(await ids({ actorId: 7, isAdmin: false }), sorted(p4));
  assert.deepEqual(await ids({ actorId: 8, isAdmin: true }), sorted(p1, p5), 'team-less Roster Admin: ONLY RH-less, never their own');
  assert.deepEqual(await ids({ actorId: 1, isAdmin: true }), sorted(p2, p3, p5, p8), 'admin with a team: team ∪ RH-less, minus her own');

  fake.calls.length = 0;
  assert.deepEqual(await leave.approvals({ actorId: 3, isAdmin: false }), { total: 0, items: [] });
  assert.equal(fake.calls.filter((c) => /tbl_employee_leave_request/.test(c.sql)).length, 0, 'no team, not admin → no query at all');

  fake.calls.length = 0;
  await leave.approvals({ actorId: 1, isAdmin: false, status: 'pending', page: 2, limit: 10 });
  const q = fake.calls.find((c) => /LIMIT \?, \?/.test(c.sql));
  assert.match(q.sql, /r\.status = 'PENDING' AND \(r\.user_id IN \(\?,\?\)\) AND r\.user_id <> \?/);
  assert.deepEqual([q.params.slice(0, 2).sort(), q.params.slice(2)], [[2, 3], [1, 10, 10]]);
});

// ── 4. ROSTER LEAVE LAYER ─────────────────────────────────────────────────
test('resolveDays: approved full day wins (locked, WO stays WO but locked); half keeps PR + leave; pending overlays; cancelled vanishes', async () => {
  reset();
  wo(2, D(4));
  const full = seed({ user_id: 2, kind: 'SL', from_date: D(3), to_date: D(4), status: 'APPROVED' });
  const half = seed({ user_id: 2, from_date: D(6), to_date: D(6), duration: 'SECOND_HALF', status: 'APPROVED' });
  const pend = seed({ user_id: 2, from_date: D(7), to_date: D(7), status: 'PENDING' });
  seed({ user_id: 2, from_date: D(8), to_date: D(8), status: 'CANCELLED' });
  seed({ user_id: 2, from_date: D(9), to_date: D(9), duration: 'SECOND_HALF', status: 'PENDING' });
  const halfOk = seed({ user_id: 2, from_date: D(9), to_date: D(9), duration: 'FIRST_HALF', status: 'APPROVED' });
  const { byUser } = await roster.resolveDays([2], D(3), D(9));
  const d = byUser.get(2);
  assert.deepEqual([d[D(3)].type, d[D(3)].source, d[D(3)].locked, d[D(3)].leaveId], ['SL', 'LEAVE', true, full.id]);
  assert.deepEqual([d[D(4)].type, d[D(4)].locked], ['WO', true]);
  assert.deepEqual([d[D(6)].type, d[D(6)].locked, d[D(6)].leave], ['PR', undefined, { id: half.id, kind: 'LV', duration: 'SECOND_HALF', status: 'APPROVED' }]);
  assert.deepEqual([d[D(7)].type, d[D(7)].leave.status, d[D(7)].leave.id], ['PR', 'PENDING', pend.id]);
  assert.deepEqual([d[D(8)].type, d[D(8)].leave, d[D(8)].locked], ['PR', undefined, undefined], 'cancelled leave is gone');
  assert.equal(d[D(9)].leave.id, halfOk.id, 'an approved half beats a pending half for the one leave slot');
  const planOnly = (await roster.resolveDays([2], D(3), D(3), { leaves: false })).byUser.get(2);
  assert.equal(planOnly[D(3)].type, 'PR', 'leaves:false = the plan alone');
});

test('resolveDays is fail-soft when the leave table is missing (Prod before migration 01)', async () => {
  reset();
  const db = require('../db');
  const q = db.pool.query;
  db.pool.query = async (sql, p) => {
    if (/FROM tbl_employee_leave_request/.test(String(sql))) throw Object.assign(new Error('no table'), { code: 'ER_NO_SUCH_TABLE', errno: 1146 });
    return q(sql, p);
  };
  try {
    const { byUser } = await roster.resolveDays([2], D(1), D(1));
    assert.equal(byUser.get(2)[D(1)].type, 'PR');
  } finally { db.pool.query = q; }
});

test('grid + headcount + dashboard: full-day leave is off duty; half day is on duty', async () => {
  reset();
  seed({ user_id: 2, from_date: D(2), to_date: D(2), status: 'APPROVED' });
  seed({ user_id: 3, from_date: D(2), to_date: D(2), duration: 'FIRST_HALF', status: 'APPROVED' });
  const g = await roster.getGrid({ actorId: 1, isAdmin: false, from: D(2), to: D(2) });
  const cell = (uid) => g.members.find((m) => m.userId === uid).days[D(2)];
  assert.deepEqual(cell(2), { type: 'LV', shift: '10:00', source: 'LEAVE', locked: true });
  assert.equal(cell(3).type, 'PR');
  assert.equal(cell(3).leave.duration, 'FIRST_HALF');
  assert.equal(g.headcount[D(2)].onDuty, 2, 'Rhea + Sam on duty; Ravi on leave');
  const sets = await roster.offDutySets([2, 3], D(2));
  assert.deepEqual([[...sets.onLeave], sets.weekOff.size], [[2], 0]);
});

// ── 5. ROSTER LOCK ────────────────────────────────────────────────────────
test('saveCells: a day on approved full-day leave → 409; pending / half day stays editable', async () => {
  reset();
  seed({ user_id: 2, from_date: D(3), to_date: D(4), status: 'APPROVED' });
  await rejects(roster.saveCells({ actorId: 1, isAdmin: false, cells: [{ userId: 2, date: D(4), dayType: 'WO' }] }), 409, /approved leave/);
  assert.equal(fake.calls.filter((c) => /INSERT INTO tbl_employee_roster\b/.test(c.sql)).length, 0);
  seed({ user_id: 3, from_date: D(3), to_date: D(3), status: 'PENDING' });
  seed({ user_id: 3, from_date: D(5), to_date: D(5), duration: 'FIRST_HALF', status: 'APPROVED' });
  const r = await roster.saveCells({ actorId: 1, isAdmin: false, cells: [{ userId: 3, date: D(3), dayType: 'WO' }, { userId: 3, date: D(5), dayType: 'WO' }] });
  assert.equal(r.changed, 2);
});

test('fillPattern skips locked days and counts them as keptLeave', async () => {
  reset();
  seed({ user_id: 2, from_date: D(3), to_date: D(4), status: 'APPROVED' });
  const r = await roster.fillPattern({ actorId: 1, isAdmin: false, userIds: [2, 3], from: D(1), to: D(7), weekOffDays: [], dryRun: true });
  assert.equal(r.keptLeave, 2);
  assert.equal(r.cells, 12);
  reset();
  seed({ user_id: 2, from_date: D(3), to_date: D(4), status: 'APPROVED' });
  await roster.fillPattern({ actorId: 1, isAdmin: false, userIds: [2], from: D(1), to: D(7), weekOffDays: [] });
  const [ins] = fake.calls.filter((c) => /INSERT INTO tbl_employee_roster\b/.test(c.sql));
  const dates = []; for (let i = 2; i < ins.params.length; i += 8) dates.push(ins.params[i]);
  assert.ok(!dates.includes(D(3)) && !dates.includes(D(4)) && dates.includes(D(5)));
});

test('resetRange keeps the planned rows on locked days', async () => {
  reset();
  wo(2, D(3)); wo(2, D(5));
  seed({ user_id: 2, from_date: D(3), to_date: D(3), status: 'APPROVED' });
  const r = await roster.resetRange({ actorId: 1, isAdmin: false, userIds: [2], from: D(1), to: D(7) });
  assert.equal(r.removed, 1);
  const del = fake.calls.find((c) => /DELETE FROM tbl_employee_roster/.test(c.sql));
  assert.deepEqual(del.params, [2, D(5)]);
});

test('bulk: the template pre-fills LV; unchanged → skipped, changed → "Locked: approved leave"', async () => {
  reset();
  const lvDay = D(40);
  const month = lvDay.slice(0, 7);
  seed({ user_id: 2, from_date: lvDay, to_date: lvDay, status: 'APPROVED' });
  const { buffer } = await bulk.buildTemplate({ actorId: 1, isAdmin: false, months: [month], userIds: [2] });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet('Roster');
  let col;
  ws.getRow(1).eachCell((c, i) => { if (String(c.value).startsWith(`${lvDay.slice(8)}/${lvDay.slice(5, 7)}/`)) col = i; });
  assert.equal(ws.getRow(2).getCell(col).value, 'LV');
  const clean = await bulk.dryRun({ actorId: 1, isAdmin: false, buffer: Buffer.from(await wb.xlsx.writeBuffer()) });
  assert.equal(clean.summary.blocked, 0);
  assert.equal(clean.summary.changedCells, 0);
  ws.getRow(2).getCell(col).value = 'WO';
  const bad = await bulk.dryRun({ actorId: 1, isAdmin: false, buffer: Buffer.from(await wb.xlsx.writeBuffer()) });
  assert.equal(bad.summary.blocked, 1);
  assert.deepEqual(bad.rows[0].errors, ['Locked: approved leave']);
});

// ── 6. ALERTS + ME ────────────────────────────────────────────────────────
test('alerts: pending SL where I am the approver, minus acked; admins also get RH-less SL', async () => {
  reset();
  const sl = seed({ user_id: 2, kind: 'SL', from_date: T, to_date: T });
  seed({ user_id: 3, kind: 'LV', from_date: D(3), to_date: D(3) });
  seed({ user_id: 3, kind: 'SL', from_date: T, to_date: T, status: 'APPROVED' });
  const orphan = seed({ user_id: 5, kind: 'SL', from_date: T, to_date: T, approver_user_id: null });
  const mine = await leave.alerts({ userId: 1, isAdmin: false });
  assert.deepEqual(mine.items.map((i) => i.key), [`leave:${sl.id}`]);
  assert.deepEqual(Object.keys(mine.items[0]).sort(), ['createdAt', 'date', 'duration', 'key', 'kind', 'reason', 'requestId', 'userName']);
  assert.deepEqual((await leave.alerts({ userId: 8, isAdmin: true })).items.map((i) => i.requestId), [orphan.id]);
  await leave.ackAlert({ userId: 1, key: `leave:${sl.id}` });
  assert.deepEqual((await leave.alerts({ userId: 1, isAdmin: false })).items, []);
  assert.equal((await leave.alerts({ userId: 8, isAdmin: true })).items.length, 1, 'an ack is per user');
});

test('me: month days, summary in .5 steps, rules, own requests', async () => {
  reset();
  const month = D(35).slice(0, 7);
  const first = `${month}-01`;
  const day = (n) => shiftYmd(first, n);
  wo(2, day(0));
  HOL = [{ date: day(1), name: 'Test Day' }];
  seed({ user_id: 2, from_date: day(2), to_date: day(3), status: 'APPROVED' });
  seed({ user_id: 2, from_date: day(4), to_date: day(4), duration: 'FIRST_HALF', status: 'APPROVED' });
  seed({ user_id: 2, from_date: day(5), to_date: day(5), status: 'PENDING' });
  const out = await leave.me({ userId: 2, month });
  const total = out.days.length;
  assert.equal(out.month, month);
  assert.deepEqual(out.rules, { lvEarliest: D(2), slDate: T });
  assert.deepEqual(out.days[1], { date: day(1), type: 'PR', holiday: 'Test Day', leave: null });
  assert.deepEqual([out.days[2].type, out.days[2].leave], ['LV', null]);
  assert.equal(out.days[4].leave.duration, 'FIRST_HALF');
  assert.equal(out.days[5].leave.status, 'PENDING');
  assert.deepEqual(out.summary, { totalDays: total, elapsed: 0, plannedPresent: total - 4.5, leaves: 2.5, weekOffsAndHolidays: 2 });
  assert.equal(out.requests.length, 3);
});

test('me: My Requests = PENDING + APPROVED ending this IST month or later, by from_date — whatever month is viewed', async () => {
  reset();
  const first = monthBounds(currentIstMonth()).start;
  const prevMonth = shiftYmd(first, -1).slice(0, 7);
  // Seeded so id order ≠ from_date order (either direction) — the ORDER BY is observable.
  const pending = seed({ user_id: 2, from_date: D(10), to_date: D(10), status: 'PENDING' });
  const straddles = seed({ user_id: 2, from_date: shiftYmd(first, -3), to_date: first, status: 'APPROVED' }); // ends ON the 1st → in
  const lateApproved = seed({ user_id: 2, from_date: D(40), to_date: D(41), status: 'APPROVED' });
  seed({ user_id: 2, from_date: shiftYmd(first, -5), to_date: shiftYmd(first, -1), status: 'APPROVED' }); // ended last month → out
  seed({ user_id: 2, from_date: shiftYmd(first, -2), to_date: shiftYmd(first, -1), status: 'PENDING' }); // ended last month → out
  for (const status of ['REJECTED', 'WITHDRAWN', 'CANCELLED']) seed({ user_id: 2, from_date: D(12), to_date: D(12), status });
  seed({ user_id: 3, from_date: D(10), to_date: D(10), status: 'PENDING' }); // someone else's
  const want = [straddles.id, pending.id, lateApproved.id];
  assert.deepEqual((await leave.me({ userId: 2 })).requests.map((x) => x.id), want);
  assert.deepEqual((await leave.me({ userId: 2, month: prevMonth })).requests.map((x) => x.id), want, 'independent of the viewed month');
  const q = fake.calls.findLast((c) => /WHERE r\.user_id = \?/.test(c.sql));
  assert.deepEqual(q.params, [2, first]);
});
