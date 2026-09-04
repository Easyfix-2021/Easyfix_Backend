/*
 * GET /api/admin/users/:userId — personal_email must obey the SAME rule the
 * LIST route applies.
 *
 * THE ASYMMETRY THIS FILE PINS. routes/admin/users.js passes
 * `includePersonalEmail: isAdminRole(req)` to the list, so nine of the ten
 * admin-group roles get "—" in that column. The detail route returned the
 * whole row, personal_email included, to every one of them — so the rule the
 * list enforced was, in practice, a rate limit: read the same addresses one
 * user at a time instead of a page at a time.
 *
 * It is the same shape as the bulk-upload-template hole fixed in 6132967: a
 * sibling route on the same resource treats a field as sensitive, and this one
 * did not. Found by auditing for exactly that shape after the first instance.
 *
 * The strip lives in the ROUTE, not in getUserById, and a test here rather than
 * a service test is the point — five server-side callers still need that
 * function to return personal_email, most sharply the update route, which
 * reads it to decide whether the address is mandatory for an edit.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const scenario = {
  roleName: 'Admin',                      // what isAdminRole() reads
  personalEmail: 'someone@gmail.com',
};

const fake = installFakePool([
  [/FROM tbl_user_allowed_stages/i, []],
  // loadPersonalIdentifiers — only issued for the Admin role.
  [/SELECT date_of_birth, date_of_joining/i,
    [{ date_of_birth: null, date_of_joining: null, uan: null, address: null,
       pan_last4: null, aadhaar_last4: null }]],
  // loadPersonalEmail
  [/SELECT personal_email FROM tbl_user_personal_details/i,
    () => [{ personal_email: scenario.personalEmail }]],
  // getUserById's main projection
  [/FROM tbl_user\s+u/i,
    [{ user_id: 501, user_code: 'E000501', user_name: 'Test User',
       official_email: 'test.user@easyfix.in', mobile_no: '9000000001',
       user_status: 1, user_type_id: 5 }]],
]);

const express = require('express');
const usersRouter = require('../routes/admin/users');

let server;
let baseUrl;

before(async () => {
  const app = express();
  /*
   * Stand-in for routes/admin/index.js. isAdminRole() reads req.userRole —
   * resolved once by the group guard upstream — NOT req.user.user_role, so
   * that is what the test varies.
   */
  app.use((req, _res, next) => {
    req.user = { user_id: 99 };
    req.userRole = { role_name: scenario.roleName };
    next();
  });
  app.use('/users', usersRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ success: false, error: String(err && err.message) });
  });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  fake.restore();
});

beforeEach(() => {
  fake.calls.length = 0;
  scenario.roleName = 'Admin';
  scenario.personalEmail = 'someone@gmail.com';
});

const getUser = async () => {
  const res = await fetch(`${baseUrl}/users/501`);
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('a non-Admin admin-group role does NOT receive personal_email', async () => {
  scenario.roleName = 'Finance';           // in the admin GROUP, not the Admin ROLE
  const res = await getUser();
  assert.equal(res.status, 200, 'the route still works — this is a field rule, not a 403');
  assert.equal(res.body.data.personal_email, undefined,
    'personal_email must be absent for a role the LIST already refuses it to');
  // The rest of the record is still served: this must not become a blanket denial.
  assert.equal(res.body.data.user_name, 'Test User');
});

test('the Admin role still receives it — the rule is a gate, not a deletion', async () => {
  scenario.roleName = 'Admin';
  const res = await getUser();
  assert.equal(res.body.data.personal_email, 'someone@gmail.com');
  // CONTROL. Without this the test above would pass against a route that had
  // simply stopped returning personal_email to everyone, which is a different
  // bug wearing the same green tick.
});

test('the identifiers stay Admin-only too, and are not even QUERIED otherwise', async () => {
  scenario.roleName = 'Project Manager';
  await getUser();
  const asked = fake.calls.some((c) => /date_of_birth, date_of_joining/i.test(c.sql));
  assert.equal(asked, false,
    'a non-Admin must not cause the identifier read at all — not merely have it stripped after');
});

test('CONTROL — the Admin role DOES trigger the identifier read', async () => {
  scenario.roleName = 'Admin';
  await getUser();
  const asked = fake.calls.some((c) => /date_of_birth, date_of_joining/i.test(c.sql));
  assert.equal(asked, true, 'otherwise the assertion above proves only that nothing runs');
});
