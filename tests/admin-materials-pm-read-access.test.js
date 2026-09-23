/*
 * RBAC gap fix (2026-09-21, flagged by the CRM side building Material
 * Request Flow v2's Add Material dialog): the CRM's dialog is gated on
 * isJobMaterialReview (roles 2 Admin, 13 Project Manager) and searches
 * GET /admin/materials + GET /admin/materials/:id — both of which were
 * isMaterialView-only (role 2), so a PM opening the dialog got 403.
 *
 * Fix: middleware/require-action.js's new requireAnyAction([...]), applied
 * to ONLY those two GET routes in routes/admin/materials.js — isMaterialView
 * is deliberately NOT granted to role 13 (that would also open the
 * standalone Manage Materials master screen).
 *
 * This mounts the REAL routes/admin/materials.js router behind a fake pool
 * (everything defaults to empty result sets — this test is about the
 * PERMISSION gate, not material data) and a pre-populated req.user.permissions
 * (same technique as tests/manage-materials-rbac.test.js), so a 403 vs
 * 200/404 is decided entirely by the real requireAnyAction logic.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { installFakePool } = require('./helpers/fake-pool');
const fake = installFakePool([]); // every query defaults to an empty result set

const materialsRouter = require('../routes/admin/materials');

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
  app.use('/materials', materialsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { res.status(500).json({ error: String(err && err.message) }); });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => { if (server) server.close(); fake.restore(); });

beforeEach(() => { scenario.actions = []; fake.reset(); });

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('a PM holding ONLY isJobMaterialReview gets past the gate (200) on GET /admin/materials', async () => {
  scenario.actions = ['isJobMaterialReview'];
  const r = await get('/materials');
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('a PM holding ONLY isJobMaterialReview gets past the gate (404, not 403) on GET /admin/materials/:id', async () => {
  scenario.actions = ['isJobMaterialReview'];
  const r = await get('/materials/999');
  // No fixture material exists (empty fake pool) — 404 "not found" proves the
  // PERMISSION gate let the request through to the service; a 403 here would
  // mean the gate is still blocking the PM.
  assert.equal(r.status, 404, JSON.stringify(r.body));
});

test('isMaterialView alone still works (no regression for the existing Admin role)', async () => {
  scenario.actions = ['isMaterialView'];
  const r = await get('/materials');
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('a user with NEITHER key still gets 403 on both GETs', async () => {
  scenario.actions = ['isSomethingUnrelated'];
  const rList = await get('/materials');
  assert.equal(rList.status, 403);
  assert.match(rList.body.error, /isMaterialView|isJobMaterialReview/);
  const rOne = await get('/materials/1');
  assert.equal(rOne.status, 403);
});

// The PM's read-only grant must not leak into a WRITE route — the exact
// concern the coordinator's note called out (isJobMaterialReview must never
// substitute for isMaterialAddNew/Edit/Deactivate/Delete/Import).
test('a PM holding ONLY isJobMaterialReview still gets 403 on every WRITE route', async () => {
  scenario.actions = ['isJobMaterialReview'];
  const post = await fetch(`${baseUrl}/materials`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ material_name: 'x' }),
  });
  assert.equal(post.status, 403);
  const put = await fetch(`${baseUrl}/materials/1`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ material_name: 'x' }),
  });
  assert.equal(put.status, 403);
  const del = await fetch(`${baseUrl}/materials/1`, { method: 'DELETE' });
  assert.equal(del.status, 403);
  const status = await fetch(`${baseUrl}/materials/1/status`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ is_active: false }),
  });
  assert.equal(status.status, 403);
});

/*
 * MUTATION CHECK (performed manually, not left in the suite): reverted
 * routes/admin/materials.js's two GET routes back to plain
 * requireAction('isMaterialView') and re-ran this file — both "a PM holding
 * ONLY isJobMaterialReview..." tests went red (403 instead of 200/404),
 * confirming they actually exercise the fix rather than passing by
 * construction. Re-applied requireAnyAction afterwards.
 */
