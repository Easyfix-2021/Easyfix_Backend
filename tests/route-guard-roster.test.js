/*
 * Team Roster route guards — TWO locks, AND never OR (routes/admin/roster.js):
 *   the easyfix_properties allowlist roster.manager.emails  (WHO may reach it)
 *   the RBAC action key isRosterManage                      (the screen EXISTS)
 * Each lock is tested failing ALONE with the other one satisfied — a test that
 * only ever fails both at once cannot tell AND from OR. /me needs neither.
 * A denied mutation still leaves an Action Log row.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { installFakePool } = require('./helpers/fake-pool');

const ALLOWED = ['tl@easyfix.in', 'tl2@easyfix.in'];
const ROLE_OF = { 1: 2, 5: 3, 6: 2, 7: 3 };                  // user → role
const ACTIONS_OF_ROLE = { 2: ['isRosterManage'], 3: [] };    // role 2 holds the key, role 3 does not
const ADJ = [
  { user_id: 1, reporting_manager: null }, { user_id: 2, reporting_manager: 1 },
  { user_id: 3, reporting_manager: 1 }, { user_id: 9, reporting_manager: 8 },
];

const fake = installFakePool([
  [/SELECT user_role FROM tbl_user/i, (_s, p) => [{ user_role: ROLE_OF[p[0]] }]],
  [/ma\.action_name/i, (_s, p) => (ACTIONS_OF_ROLE[p[0]] || []).map((a) => ({ action_name: a }))],
  // role.service loadRoles() reads the whole table (no params) into its cache.
  [/FROM tbl_role/i, [
    { role_id: 2, role_name: 'Admin', role_status: 1, menu_ids: '' },
    { role_id: 3, role_name: 'Executive Supply', role_status: 1, menu_ids: '' },
  ]],
  [/FROM easyfix_properties/i, () => [{ property_key: 'roster.manager.emails', property_value: ALLOWED.join(',') }]],
  [/SELECT user_id, reporting_manager/i, ADJ],
  [/FROM tbl_user u LEFT JOIN tbl_role r/i, (_s, p) => p.map((id) => ({ user_id: id, user_name: 'U' + id, user_code: null, role_name: 'Ops' }))],
  [/INSERT INTO tbl_employee_roster_action_log/i, () => ({ insertId: 1 })],
]);

const rosterRouter = require('../routes/admin/roster');

let server; let base; let actingUser;
before(async () => {
  await require('../services/properties.service').flushCache();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { ...actingUser }; next(); });
  app.use('/api/admin/roster', rosterRouter);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/api/admin/roster`;
});
after(async () => { if (server) await new Promise((r) => server.close(r)); });

async function call(user, path, init) {
  actingUser = user;
  const res = await fetch(base + path, { headers: { 'content-type': 'application/json' }, ...init });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const grid = '/?from=2026-10-05&to=2026-10-11';

test('BOTH locks satisfied → the grid loads', async () => {
  const r = await call({ user_id: 1, official_email: ALLOWED[0] }, grid);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.members.map((m) => m.userId).sort(), [1, 2, 3]);
  assert.equal(r.body.data.members.find((m) => m.userId === 1).editable, false, 'own row is read-only');
});

test('allowlisted email WITHOUT the action key → 403', async () => {
  const r = await call({ user_id: 5, official_email: ALLOWED[1] }, grid);
  assert.equal(r.status, 403);
  assert.match(r.body.error, /isRosterManage/);
});

test('action key WITHOUT an allowlisted email → 403', async () => {
  const r = await call({ user_id: 6, official_email: 'someone@easyfix.in' }, grid);
  assert.equal(r.status, 403);
});

test('/me needs neither lock — every CRM user sees their own roster', async () => {
  const r = await call({ user_id: 7, official_email: 'someone@easyfix.in' }, '/me?days=7');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.days.length, 7);
});

test('a denied save (member outside the team) is 403 AND lands in the Action Log', async () => {
  fake.calls.length = 0;
  const { todayIst, shiftYmd } = require('../utils/ist-calendar');
  const r = await call({ user_id: 1, official_email: ALLOWED[0] }, '/cells', {
    method: 'PUT', body: JSON.stringify({ cells: [{ userId: 9, date: shiftYmd(todayIst(), 1), dayType: 'WO' }] }),
  });
  assert.equal(r.status, 403);
  const log = fake.calls.find((c) => /INSERT INTO tbl_employee_roster_action_log/i.test(c.sql));
  assert.ok(log, 'the denied attempt must be logged');
  assert.equal(log.params[0], 'SAVE_GRID');
  assert.equal(log.params[6], 403);
});
