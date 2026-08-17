/*
 * Integration Basic Auth resolves credentials from the store LEGACY used.
 *
 * Both legacy services authenticate against tbl_client_user — the Dropwizard
 * /v1 API (EasyFix_API EasyFixAuthenticator → ClientLogin) and the webhook
 * relay (Webhook_2023 auth.controller.js). This backend originally read
 * tbl_client_website, a different table with a different population: measured
 * on QA, ~250 logins live there and only two also exist in tbl_client_user.
 * A partner provisioned for legacy therefore got a 401 on credentials that
 * worked the day before.
 *
 * These tests pin the precedence, because getting it backwards is silent —
 * the wrong store simply reports "Invalid credentials".
 */

const test = require('node:test');
const assert = require('node:assert');
const { makeFakePool } = require('./helpers/fake-pool');

const db = require('../db');
const realQuery = db.pool.query;

function withPool(routes) {
  const fake = makeFakePool(routes);
  db.pool.query = fake.pool.query;
  return fake;
}
test.afterEach(() => { db.pool.query = realQuery; });

const basicAuth = require('../middleware/basic-auth');

function reqFor(user, pass) {
  return { headers: { authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') } };
}
function resSpy() {
  const res = { statusCode: null, body: null, headers: {} };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
async function run(fakeRoutes, user = 'Decathlon', pass = 'secret') {
  withPool(fakeRoutes);
  const req = reqFor(user, pass);
  const res = resSpy();
  let nexted = false;
  await basicAuth(req, res, () => { nexted = true; });
  return { req, res, nexted };
}

const LEGACY_ROW = [{
  login_id: 7, client_id: 213, login_name: 'Decathlon',
  login_password: 'secret', role_name: 'website', client_name: 'Decathlon',
}];
const WEBSITE_ROW = [{
  login_id: 99, client_id: 999, login_name: 'Decathlon',
  login_password: 'secret', client_name: 'Someone Else',
}];

test('a credential in tbl_client_user authenticates', async () => {
  const { req, nexted } = await run([[/FROM tbl_client_user/i, LEGACY_ROW]]);
  assert.ok(nexted, 'passed to the route');
  assert.equal(req.integrationClient.id, 213);
  assert.equal(req.integrationClient.loginName, 'Decathlon');
});

test('the legacy store WINS when a login exists in both', async () => {
  // Legacy is still serving traffic, so it must be the authority on who a
  // login belongs to. Resolving to the other client would scope the caller's
  // whole session — jobs, invoices — to the wrong organisation.
  const { req } = await run([
    [/FROM tbl_client_user/i, LEGACY_ROW],
    [/FROM tbl_client_website/i, WEBSITE_ROW],
  ]);
  assert.equal(req.integrationClient.id, 213, 'tbl_client_user wins');
  assert.notEqual(req.integrationClient.id, 999);
  assert.equal(req.integrationClient.name, 'Decathlon');
});

test('tbl_client_website still works when the login is only there', async () => {
  // The fallback exists so switching stores does not invalidate the logins
  // this backend has been accepting — one outage traded for another.
  const { req, nexted } = await run([
    [/FROM tbl_client_user/i, []],
    [/FROM tbl_client_website/i, WEBSITE_ROW],
  ]);
  assert.ok(nexted);
  assert.equal(req.integrationClient.id, 999);
});

test('the role comes off the legacy row without a second query', async () => {
  const fake = withPool([[/FROM tbl_client_user/i, LEGACY_ROW]]);
  const req = reqFor('Decathlon', 'secret');
  await basicAuth(req, resSpy(), () => {});
  assert.equal(req.integrationClient.role, 'website');
  const roleLookups = fake.calls.filter((c) => /tbl_client_role/i.test(c.sql));
  assert.equal(roleLookups.length, 1, 'exactly the auth query — no separate role lookup');
});

test('a wrong password is rejected even when the login exists', async () => {
  const { res, nexted } = await run([[/FROM tbl_client_user/i, LEGACY_ROW]], 'Decathlon', 'wrong');
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.message, 'Invalid credentials');
});

test('an unknown login is rejected by both stores', async () => {
  const { res, nexted } = await run([
    [/FROM tbl_client_user/i, []],
    [/FROM tbl_client_website/i, []],
  ]);
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 401);
});

test('a missing legacy table falls through instead of 500ing', async () => {
  // A deploy without the legacy tables must still serve integration traffic.
  db.pool.query = async (sql, params) => {
    if (/FROM tbl_client_user/i.test(String(sql))) {
      const e = new Error("Table 'easyfix_core.tbl_client_user' doesn't exist");
      e.code = 'ER_NO_SUCH_TABLE';
      throw e;
    }
    return [WEBSITE_ROW, []];
  };
  const req = reqFor('Decathlon', 'secret');
  const res = resSpy();
  let nexted = false;
  await basicAuth(req, res, () => { nexted = true; });
  assert.ok(nexted, 'fell back to tbl_client_website');
  assert.equal(req.integrationClient.id, 999);
});

test('a malformed Authorization header is rejected before any query', async () => {
  const fake = withPool([]);
  const res = resSpy();
  let nexted = false;
  await basicAuth({ headers: { authorization: 'Bearer nope' } }, res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['WWW-Authenticate'], 'Basic realm="EasyFix API"');
  assert.equal(fake.calls.length, 0, 'no DB round trip for a non-Basic header');
});
