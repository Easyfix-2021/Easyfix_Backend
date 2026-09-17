/*
 * Material access must NOT grant brand management (contract rule). This
 * mounts the REAL routes/admin/brands.js router behind the REAL
 * requireAction middleware and proves a user holding only isMaterial*
 * action keys gets 403 on every /admin/brands route.
 *
 * requireAction only hits the DB when req.user.permissions is unset
 * (middleware/require-action.js) — pre-populating it here (same technique
 * as tests/admin-job-edit-permission.test.js) means this test needs no
 * fake pool at all: a 403 must come back before any service/DB code runs.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const brandsRouter = require('../routes/admin/brands');

let server;
let baseUrl;
const scenario = { actions: [] };

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { user_id: 1, permissions: { menuIds: [], actionPermissions: scenario.actions } };
    next();
  });
  app.use('/brands', brandsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { res.status(500).json({ error: String(err && err.message) }); });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => { if (server) server.close(); });

beforeEach(() => { scenario.actions = ['isMaterialView', 'isMaterialAddNew', 'isMaterialEdit', 'isMaterialDeactivate', 'isMaterialDelete', 'isMaterialImport']; });

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('isMaterialView-only user gets 403 on GET /admin/brands', async () => {
  const r = await call('GET', '/brands');
  assert.equal(r.status, 403);
  assert.match(r.body.error, /isBrandView/);
});

test('isMaterial*-only user gets 403 on POST /admin/brands (create)', async () => {
  const r = await call('POST', '/brands', { brand_name: 'Bosch' });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /isBrandAddNew/);
});

test('isMaterial*-only user gets 403 on DELETE /admin/brands/:id', async () => {
  const r = await call('DELETE', '/brands/5');
  assert.equal(r.status, 403);
  assert.match(r.body.error, /isBrandDelete/);
});
