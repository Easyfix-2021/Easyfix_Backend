/*
 * Employee Hub leave routes (routes/admin/leave.js) + the roster surfaces that
 * read leave: Team Roster export, bulk-reassign, lookup users.
 *
 *   · Joi on every body / query / param → 400 before the service runs.
 *   · isRosterAdmin is resolved from the role's action keys (like the roster),
 *     and only widens scope to RH-less requests — approval is hierarchy-scoped.
 *   · a reason is mandatory on submit (service 400), not on a dry run.
 *   · export: 'LV' for a full day, 'PR (½LV)' for an approved half day.
 *   · bulk-reassign skips users on full-day leave today, like week-off users.
 *   · lookup users carry on_leave_today next to week_off_today.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const ExcelJS = require('exceljs');

const { installFakePool } = require('./helpers/fake-pool');

const ROLE_OF = { 1: 2, 2: 3, 3: 3, 8: 4 };
const ACTIONS_OF_ROLE = { 2: ['isRosterManage'], 3: [], 4: ['isRosterAdmin'] };
const ADJ = [
  { user_id: 1, reporting_manager: null }, { user_id: 2, reporting_manager: 1 },
  { user_id: 3, reporting_manager: 1 }, { user_id: 8, reporting_manager: null },
];
let leaveRows = [];
const jobUpdates = [];

// id 9 has no Reporting Head (approver NULL); every other id is 2's request with RH 1.
const reqRow = (id) => (Number(id) === 9
  ? { id, user_id: 5, kind: 'LV', from_date: '2099-01-05', to_date: '2099-01-05', duration: 'FULL', days: 1, status: 'PENDING', approver_user_id: null }
  : { id, user_id: 2, kind: 'LV', from_date: '2099-01-05', to_date: '2099-01-05', duration: 'FULL', days: 1, status: 'PENDING', approver_user_id: 1 });

const fake = installFakePool([
  [/SELECT user_role FROM tbl_user/i, (_s, p) => [{ user_role: ROLE_OF[p[0]] }]],
  [/SELECT ma\.action_name/i, (_s, p) => (ACTIONS_OF_ROLE[p[0]] || []).map((a) => ({ action_name: a }))],
  [/FROM tbl_role/i, [
    { role_id: 2, role_name: 'Admin', role_status: 1, menu_ids: '' },
    { role_id: 3, role_name: 'Executive Supply', role_status: 1, menu_ids: '' },
    { role_id: 4, role_name: 'Ops Head', role_status: 1, menu_ids: '' },
  ]],
  [/FROM tbl_employee_leave_request\s+WHERE user_id IN/i, (_s, p) => {
    const ids = p.slice(0, -2);
    return leaveRows.filter((r) => ids.includes(r.user_id));
  }],
  [/FROM tbl_employee_leave_request r WHERE r\.id = \? FOR UPDATE/i, (_s, [id]) => [reqRow(id)]],
  [/LEFT JOIN tbl_user d[\s\S]*WHERE r\.id = \?/i, (_s, [id]) => [{ ...reqRow(id), status: 'APPROVED', user_name: 'U' + reqRow(id).user_id }]],
  [/SELECT user_id, reporting_manager/i, ADJ],
  [/FROM tbl_user u LEFT JOIN tbl_role r/i, (_s, p) => p.map((id) => ({ user_id: id, user_name: 'U' + id, user_code: null, role_name: 'Ops' }))],
  [/FROM tbl_user u\s+LEFT JOIN tbl_role r ON r\.role_id = u\.user_role\s+WHERE/i, () => [2, 3].map((id) => ({ user_id: id, user_name: 'U' + id }))],
  [/SELECT job_id FROM tbl_job/i, [{ job_id: 11 }, { job_id: 12 }]],
  [/UPDATE tbl_job SET job_owner/i, (_s, p) => { jobUpdates.push(p[0]); return { affectedRows: 1 }; }],
]);

const { todayIst } = require('../utils/ist-calendar');
const T = todayIst();

let server; let base; let actingUser;
before(async () => {
  await require('../services/properties.service').flushCache();
  require('../services/holiday.service').getRange = () => [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { ...actingUser }; next(); });
  app.use('/api/admin/leave', require('../routes/admin/leave'));
  app.use('/api/admin/roster', require('../routes/admin/roster'));
  app.use('/api/admin/aux', require('../routes/admin/auxiliary'));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/api/admin`;
});
after(async () => { if (server) await new Promise((r) => server.close(r)); });

async function call(userId, path, init = {}) {
  actingUser = { user_id: userId };
  const res = await fetch(base + path, { headers: { 'content-type': 'application/json' }, ...init });
  const isJson = (res.headers.get('content-type') || '').includes('json');
  return { status: res.status, body: isJson ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}
const post = (userId, path, body) => call(userId, path, { method: 'POST', body: JSON.stringify(body || {}) });

test('create: a bad body is a 400 before any rule runs', async () => {
  fake.calls.length = 0;
  for (const body of [
    {},
    { kind: 'XX', fromDate: '2099-01-05', toDate: '2099-01-05' },
    { kind: 'LV', fromDate: '05-01-2099', toDate: '2099-01-05' },
    { kind: 'LV', fromDate: '2099-01-05' },
    { kind: 'LV', fromDate: '2099-01-05', toDate: '2099-01-05', duration: 'MORNING' },
    { kind: 'LV', fromDate: '2099-01-05', toDate: '2099-01-05', reason: 'x'.repeat(501) },
  ]) {
    const r = await post(2, '/leave/requests?dryRun=1', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error, 'Validation failed', 'Joi, not the service: ' + JSON.stringify(body));
  }
  assert.equal(fake.calls.filter((c) => /tbl_employee_leave_request/.test(c.sql)).length, 0, 'no rule ran');
});

test('CONTROL — a valid dry run reaches the service and returns { days }', async () => {
  const r = await post(2, '/leave/requests?dryRun=1', { kind: 'LV', fromDate: '2099-01-05', toDate: '2099-01-06' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data, { days: 2 });
});

test('a service rule failure comes back as its own status + message', async () => {
  const r = await post(2, '/leave/requests?dryRun=1', { kind: 'SL', fromDate: '2099-01-05', toDate: '2099-01-05' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /today only/);
});

test('params / query / decide body are validated', async () => {
  for (const [label, r] of [
    ['non-numeric id', await post(2, '/leave/requests/abc/withdraw')],
    ['reject needs a note', await post(1, '/leave/requests/7/decide', { decision: 'REJECT' })],
    ['unknown decision', await post(1, '/leave/requests/7/decide', { decision: 'MAYBE' })],
    ['cancel note too long', await post(2, '/leave/requests/7/cancel', { note: 'x'.repeat(501) })],
    ['approvals status', await call(1, '/leave/approvals?status=all')],
    ['approvals limit', await call(1, '/leave/approvals?limit=500')],
    ['me month', await call(2, '/leave/me?month=2026-13')],
    ['alert key', await post(2, '/leave/alerts/DROP%20TABLE/ack')],
  ]) {
    assert.equal(r.status, 400, label);
    assert.equal(r.body.error, 'Validation failed', label);
  }
});

test('a submit without a reason is the service\'s 400 (Joi lets it through); nothing is written', async () => {
  fake.calls.length = 0;
  for (const reason of [undefined, '', '   ']) {
    const r = await post(2, '/leave/requests', { kind: 'LV', fromDate: '2099-01-05', toDate: '2099-01-05', reason });
    assert.equal(r.status, 400, String(reason));
    assert.equal(r.body.error, 'Enter a reason for the leave');
  }
  assert.equal(fake.calls.filter((c) => /tbl_employee_leave_request/.test(c.sql)).length, 0);
});

test('decide is hierarchy-scoped: the RH may, a peer may not, a team-less Roster Admin may not', async () => {
  const peer = await post(3, '/leave/requests/7/decide', { decision: 'APPROVE' });
  assert.equal(peer.status, 403);
  const admin = await post(8, '/leave/requests/7/decide', { decision: 'APPROVE' });
  assert.deepEqual([admin.status, admin.body.error], [403, 'This request is not from your team']);
  const rh = await post(1, '/leave/requests/7/decide', { decision: 'APPROVE' });
  assert.equal(rh.status, 200, JSON.stringify(rh.body));
});

test('isRosterAdmin comes from the role: only the admin decides an RH-less request', async () => {
  const peer = await post(3, '/leave/requests/9/decide', { decision: 'APPROVE' });
  assert.equal(peer.status, 403);
  const rh = await post(1, '/leave/requests/9/decide', { decision: 'APPROVE' });
  assert.equal(rh.status, 403, 'an RH outside the requester\'s line is a stranger');
  const admin = await post(8, '/leave/requests/9/decide', { decision: 'APPROVE' });
  assert.equal(admin.status, 200, JSON.stringify(admin.body));
});

test('approvals: no team and not a Roster Admin → an empty page, no leave query', async () => {
  fake.calls.length = 0;
  const r = await call(3, '/leave/approvals');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, { total: 0, items: [] });
  assert.equal(fake.calls.filter((c) => /tbl_employee_leave_request/.test(c.sql)).length, 0);
});

test('ack: a valid key → { ok: true }', async () => {
  const r = await post(2, '/leave/alerts/leave:7/ack');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, { ok: true });
  const ins = fake.calls.find((c) => /INSERT INTO tbl_user_alert_ack/.test(c.sql));
  assert.deepEqual(ins.params.slice(0, 2), [2, 'leave:7']);
});

test('export: LV for a full-day leave, PR (½LV) for an approved half day, nothing for pending', async () => {
  leaveRows = [
    { id: 1, user_id: 2, kind: 'LV', from_date: T, to_date: T, duration: 'FULL', status: 'APPROVED' },
    { id: 2, user_id: 3, kind: 'LV', from_date: T, to_date: T, duration: 'SECOND_HALF', status: 'APPROVED' },
    { id: 3, user_id: 1, kind: 'SL', from_date: T, to_date: T, duration: 'FULL', status: 'PENDING' },
  ];
  try {
    const r = await call(1, `/roster/export?from=${T}&to=${T}`);
    assert.equal(r.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body);
    const ws = wb.getWorksheet('Roster');
    const byName = {};
    ws.eachRow((row, i) => { if (i > 1) byName[row.getCell(1).value] = row.getCell(5).value; });
    assert.deepEqual([byName.U2, byName.U3, byName.U1], ['LV', 'PR (½LV)', 'PR']);
    assert.equal(byName['On Duty'], '2/3', 'full-day leave is off duty');
  } finally { leaveRows = []; }
});

test('bulk-reassign skips users on full-day leave today; all on leave → 400', async () => {
  leaveRows = [{ id: 1, user_id: 2, kind: 'SL', from_date: T, to_date: T, duration: 'FULL', status: 'APPROVED' }];
  try {
    jobUpdates.length = 0;
    const r = await post(1, '/aux/bulk-reassign', { userIds: [2, 3] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.skippedOnLeave, [2]);
    assert.deepEqual(jobUpdates, [3, 3], 'every job went to the user at work');
    const none = await post(1, '/aux/bulk-reassign', { userIds: [2] });
    assert.equal(none.status, 400);
  } finally { leaveRows = []; }
});

test('lookup users: on_leave_today next to week_off_today; a half day is not "on leave"', async () => {
  leaveRows = [
    { id: 1, user_id: 2, kind: 'LV', from_date: T, to_date: T, duration: 'FULL', status: 'APPROVED' },
    { id: 2, user_id: 3, kind: 'LV', from_date: T, to_date: T, duration: 'FIRST_HALF', status: 'APPROVED' },
  ];
  try {
    const rows = await require('../services/lookup.service').users({});
    const by = Object.fromEntries(rows.map((u) => [u.user_id, [u.on_leave_today, u.week_off_today]]));
    assert.deepEqual(by, { 2: [true, false], 3: [false, false] });
  } finally { leaveRows = []; }
});
