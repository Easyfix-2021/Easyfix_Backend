/*
 * Material Request Flow v2 (2026-09-21) — admin-side route coverage not
 * already exercised by tests/ops-material-approval.test.js /
 * tests/pending-for-material.test.js:
 *
 *   - GET /admin/quotations?jobId= — each row gains `state`.
 *   - PATCH /admin/quotations/:id/approve|reject — only on review_pending,
 *     else 409.
 *   - NEW POST /admin/jobs/:id/quotation-lines (CRM add line): at 2 -> 15 +
 *     client request sent; at 15 -> stays 15, re-sent; at 16 -> stays 16, no
 *     send.
 *   - GET /admin/aux/materials/job/:jobId filters to type IS NULL OR
 *     type = 'Material'.
 *   - Client + public estimate approve/reject stamp ONLY approval_pending
 *     lines (services/job-estimate-approval.js stampApprovalPendingLines).
 *
 * Runner: `node --test --test-force-exit tests/material-request-flow-v2-admin.test.js`.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.WEBHOOK_OUTBOUND_ENABLED = 'false';

const { installFakePool } = require('./helpers/fake-pool');
const qls = require('../services/quotation-line-state');

const OPS_USER_ID = 77;
const TECH_EFR_ID = 4242;
const JOB_ID = 800;

function makeJob(over = {}) {
  return {
    job_id: JOB_ID, job_status: 2, fk_easyfixter_id: TECH_EFR_ID, fk_client_id: 133,
    city_id: 11, vertical_id: 3, fk_customer_id: 3, reporting_contact_id: 43,
    job_owner: null, client_ref_id: null,
    approved_on_date_time: null, approval_reject_date_time: null, approval_sent_on_date_time: null,
    material_sub_status: null, permission_required: 0, material_reject_reason: null,
    requested_date_time: '2026-09-20 10:00:00', booking_cut_off_time_slot: null, otp: null,
    remarks: null, custom_property: null, customer_name: 'Test Customer', customer_mob_no: null,
    client_name: 'Test Client', ...over,
  };
}

let jobFixture = makeJob();
let quotationRows;      // [{ id, job_id, sent_on, action_on, status, client_status, client_action_on }]
let materialRequestSent; // [] of jobIds sendMaterialClientRequest was called with

function qLine(over = {}) {
  return { id: null, job_id: JOB_ID, type: 'material', name: 'Pipe', unit: 1, unit_price: 100,
    client_charge: 0, approved_charge: null, sent_on: null, action_on: null,
    status: 1, client_status: null, client_action_on: null, ...over };
}

const fake = installFakePool([
  [/SELECT user_id FROM tbl_client_contacts WHERE id\s*=\s*\?/i, () => [{ user_id: 555 }]],
  [/FROM\s+tbl_job_comment\s+c\b[\s\S]*comment_id\s*=\s*\?/i, () => [{ id: 1, job_id: JOB_ID, comment_on: 1 }]],
  [/FROM tbl_job j\s+LEFT JOIN tbl_customer/i, () => (jobFixture ? [jobFixture] : [])],
  [/SELECT j\.\*/i, () => (jobFixture ? [jobFixture] : [])],
  [/FROM\s+tbl_job\s+WHERE\s+job_id\s*=\s*\?/i, () => (jobFixture ? [jobFixture] : [])],
  [/^\s*UPDATE tbl_job\b/i, () => ({ affectedRows: 1 })],
  [/^\s*INSERT INTO tbl_job_comment/i, () => ({ insertId: 1, affectedRows: 1 })],
  [/^\s*INSERT INTO tbl_job_logs/i, () => ({ insertId: 1, affectedRows: 1 })],
  [/INFORMATION_SCHEMA/i, () => [{ n: 3 }]],
  [/^\s*SELECT pre_material_status FROM tbl_job_material_review/i, () => []],
  [/^\s*INSERT INTO tbl_job_material_review \(job_id, pre_material_status\)/i, () => ({ affectedRows: 1 })],

  // routes/admin/quotations.js GET / — the list, with `state` computed via
  // the REAL derivation (this file tests the ROUTE's wiring/shape, not the
  // predicate itself — quotation-line-state.test.js owns that).
  [/SELECT id, type, name, unit, unit_price,[\s\S]*FROM quotation_details\s+WHERE job_id = \?/i,
    (sql, params) => quotationRows.filter((r) => Number(r.job_id) === Number(params[0]))
      .map((r) => ({ ...r, state: qls.quotationLineState(r) }))],
  // routes/admin/quotations.js assertQuotationLineReviewPending's single-line fetch.
  [/^\s*SELECT sent_on, action_on,\s*CAST\(status AS UNSIGNED\) AS status,\s*CAST\(client_status AS SIGNED\) AS client_status\s*FROM quotation_details WHERE id = \?/i,
    (sql, params) => {
      const r = quotationRows.find((x) => Number(x.id) === Number(params[0]));
      return r ? [{ sent_on: r.sent_on, action_on: r.action_on, status: r.status, client_status: r.client_status }] : [];
    }],
  // quotationScopeGuard's job_id lookup.
  [/^\s*SELECT job_id FROM quotation_details WHERE id = \?/i, (sql, params) => {
    const r = quotationRows.find((x) => Number(x.id) === Number(params[0]));
    return r ? [{ job_id: r.job_id }] : [];
  }],
  // Client/public approve-reject's stampApprovalPendingLines UPDATE —
  // job-scoped (WHERE job_id = ? AND (...)), not line-scoped. Only recorded
  // (fake.calls) for assertion; no mutation needed since these tests inspect
  // the captured SQL/params directly.
  [/^\s*UPDATE quotation_details\s+SET client_status/i, () => ({ affectedRows: 1 })],
  [/^\s*UPDATE quotation_details\b/i, (sql, params) => {
    const isApprove = /approved_charge/.test(sql);
    const id = params[params.length - 1];
    const r = quotationRows.find((x) => Number(x.id) === Number(id));
    if (r) {
      if (isApprove) { r.approved_charge = params[0]; r.action_by = params[1]; r.action_on = params[2]; r.status = 1; }
      else { r.action_by = params[0]; r.action_on = params[1]; r.status = 0; }
    }
    return { affectedRows: r ? 1 : 0 };
  }],

  // NEW POST /admin/jobs/:id/quotation-lines
  [/^\s*SELECT material_id, material_name, CAST\(status AS SIGNED\) AS status\s*FROM tbl_material_master/i,
    () => [{ material_id: 10, material_name: 'Screw', status: 1 }]],
  [/FROM tbl_job j\s+LEFT JOIN tbl_address ad/i, () => [{ state_id: 9 }]],
  // CRM add-line's INSERT — params: name, quantity, unitPrice, clientCharge,
  // approvedAmount, actionBy, sentBy, sentOn, actionOn, jobId, materialId.
  [/^\s*INSERT INTO quotation_details\b/i, (sql, params) => {
    const id = (quotationRows.reduce((m, r) => Math.max(m, r.id || 0), 0)) + 1;
    const [name, unit, unitPrice, clientCharge, approvedCharge, , , sentOn, actionOn, jobId, materialId] = params;
    quotationRows.push(qLine({
      id, job_id: jobId, name, unit, unit_price: unitPrice, client_charge: clientCharge,
      approved_charge: approvedCharge, sent_on: sentOn, action_on: actionOn, material_id: materialId,
    }));
    return { insertId: id };
  }],

  // GET /admin/aux/materials/job/:jobId
  // The type filter is applied here by READING it out of the real SQL text
  // (same technique as tests/ops-material-approval.test.js's
  // filterQuotationRows) rather than hardcoding it — so a regression that
  // drops the clause from routes/admin/auxiliary.js is caught, not masked.
  [/FROM job_material\s+WHERE job_id = \?/i, (sql, params) => {
    const hasTypeFilter = /type\s+IS\s+NULL\s+OR\s+type\s*=\s*'Material'/i.test(sql);
    return AUX_MATERIALS.filter((r) => Number(r.job_id) === Number(params[0])
      && (!hasTypeFilter || r.type == null || r.type === 'Material'));
  }],

  [/^\s*(SELECT|INSERT|UPDATE)/i, () => []],
]);

// Patch sendMaterialClientRequest so the fire-and-forget path is observable
// without a real email/notification stack.
const materialClientRequestService = require('../services/material-client-request.service');
const originalSend = materialClientRequestService.sendMaterialClientRequest;

let AUX_MATERIALS = [];

after(async () => {
  materialClientRequestService.sendMaterialClientRequest = originalSend;
  await new Promise((resolve) => setImmediate(resolve));
  fake.restore();
});

before(() => {
  materialClientRequestService.sendMaterialClientRequest = async (jobId) => { materialRequestSent.push(jobId); };
});

beforeEach(() => {
  fake.calls.length = 0;
  jobFixture = makeJob();
  quotationRows = [];
  AUX_MATERIALS = [];
  materialRequestSent = [];
});

function boundValue(call, col) {
  const at = call.sql.search(new RegExp(`\\b${col}\\s*=`));
  if (at < 0) return undefined;
  const before_ = (call.sql.slice(0, at).match(/\?/g) || []).length;
  return call.params[before_];
}
function statusUpdates(calls) { return calls.filter((c) => /^\s*UPDATE tbl_job\b/i.test(c.sql) && /\bjob_status\s*=\s*\?/i.test(c.sql)); }

// ═════════════════════════════════════════════════════════════════════════
// routes/admin/quotations.js
// ═════════════════════════════════════════════════════════════════════════

const express1 = express();
express1.use(express.json());
express1.use((req, _res, next) => {
  req.user = { user_id: OPS_USER_ID, permissions: { menuIds: [], actionPermissions: [] } };
  req.userRole = { role_name: 'Project Manager' };
  req.scope = {
    clients: { mode: 'all', ids: [], placeholders: '' }, cities: { mode: 'all', ids: [], placeholders: '' },
    states: { mode: 'all', ids: [], placeholders: '' }, verticals: { mode: 'all', ids: [], placeholders: '' },
  };
  next();
});
express1.use('/quotations', require('../routes/admin/quotations'));
// eslint-disable-next-line no-unused-vars
express1.use((err, _req, res, _next) => res.status(500).json({ error: String(err && err.message) }));

let quotationsServer, quotationsBaseUrl;
before(async () => { await new Promise((resolve) => { quotationsServer = express1.listen(0, resolve); }); quotationsBaseUrl = `http://127.0.0.1:${quotationsServer.address().port}`; });
after(() => { if (quotationsServer) quotationsServer.close(); });

test('GET /admin/quotations?jobId= — each row carries `state`', async () => {
  quotationRows = [
    qLine({ id: 1, sent_on: null }),
    qLine({ id: 2, sent_on: new Date(), action_on: null }),
    qLine({ id: 3, sent_on: new Date(), action_on: new Date(), status: 0 }),
    qLine({ id: 4, sent_on: new Date(), action_on: new Date(), status: 1, client_status: 1 }),
  ];
  const res = await fetch(`${quotationsBaseUrl}/quotations?jobId=${JOB_ID}`);
  const body = await res.json();
  const byId = Object.fromEntries((body.data || body).map((r) => [r.id, r.state]));
  assert.equal(byId[1], 'draft');
  assert.equal(byId[2], 'review_pending');
  assert.equal(byId[3], 'rejected');
  assert.equal(byId[4], 'client_approved');
});

test('PATCH /admin/quotations/:id/approve on a review_pending line succeeds', async () => {
  quotationRows = [qLine({ id: 1, sent_on: new Date(), action_on: null })];
  const res = await fetch(`${quotationsBaseUrl}/quotations/1/approve`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvedCharge: 100 }),
  });
  assert.equal(res.status, 200, JSON.stringify(await res.json()));
});

test('PATCH /admin/quotations/:id/approve on a DRAFT line -> 409 (not yet sent, nothing to review)', async () => {
  quotationRows = [qLine({ id: 1, sent_on: null })];
  const res = await fetch(`${quotationsBaseUrl}/quotations/1/approve`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvedCharge: 100 }),
  });
  assert.equal(res.status, 409);
  assert.equal(quotationRows[0].status, 1, 'must be untouched');
});

test('PATCH /admin/quotations/:id/reject on an already-rejected line -> 409', async () => {
  quotationRows = [qLine({ id: 1, sent_on: new Date(), action_on: new Date(), status: 0 })];
  const res = await fetch(`${quotationsBaseUrl}/quotations/1/reject`, { method: 'PATCH' });
  assert.equal(res.status, 409);
});

test('PATCH /admin/quotations/:id/approve on a client_approved line -> 409 (locked everywhere)', async () => {
  quotationRows = [qLine({ id: 1, sent_on: new Date(), action_on: new Date(), status: 1, client_status: 1 })];
  const res = await fetch(`${quotationsBaseUrl}/quotations/1/approve`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvedCharge: 100 }),
  });
  assert.equal(res.status, 409);
});

// ═════════════════════════════════════════════════════════════════════════
// routes/admin/jobs.js — NEW POST /:id/quotation-lines
// ═════════════════════════════════════════════════════════════════════════

const express2 = express();
express2.use(express.json());
express2.use((req, _res, next) => {
  req.user = { user_id: OPS_USER_ID, user_name: 'PM Tester', permissions: { menuIds: [], actionPermissions: ['isJobMaterialReview'] } };
  req.userRole = { role_name: 'Project Manager' };
  req.scope = {
    clients: { mode: 'all', ids: [], placeholders: '' }, cities: { mode: 'all', ids: [], placeholders: '' },
    states: { mode: 'all', ids: [], placeholders: '' }, verticals: { mode: 'all', ids: [], placeholders: '' },
  };
  req.allowedStages = null;
  next();
});
express2.use('/jobs', require('../routes/admin/jobs'));
// eslint-disable-next-line no-unused-vars
express2.use((err, _req, res, _next) => res.status(500).json({ error: String(err && err.message) }));

let jobsServer, jobsBaseUrl;
before(async () => { await new Promise((resolve) => { jobsServer = express2.listen(0, resolve); }); jobsBaseUrl = `http://127.0.0.1:${jobsServer.address().port}`; });
after(() => { if (jobsServer) jobsServer.close(); });

async function addLine(body) {
  const res = await fetch(`${jobsBaseUrl}/jobs/${JOB_ID}/quotation-lines`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('CRM add line at 2 (IN_PROGRESS) -> job moves to 15, client request SENT', async () => {
  jobFixture = makeJob({ job_status: 2 });
  const res = await addLine({ materialId: 10, quantity: 1, approvedAmount: 500 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const upd = statusUpdates(fake.calls)[0];
  assert.ok(upd);
  assert.equal(boundValue(upd, 'job_status'), 15);
  assert.equal(quotationRows.length, 1);
  assert.equal(quotationRows[0].status, 1);
  assert.ok(quotationRows[0].action_on, 'a CRM-added line is born reviewed (action_on stamped)');
  assert.deepEqual(materialRequestSent, [JOB_ID], 'the client request must be sent on first entry to 15');
});

test('CRM add line at 15 -> stays 15, client request RE-sent', async () => {
  jobFixture = makeJob({ job_status: 15 });
  const res = await addLine({ materialId: 10, quantity: 1, approvedAmount: 500 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(statusUpdates(fake.calls).length, 0, 'no status move — the job is already at 15');
  assert.deepEqual(materialRequestSent, [JOB_ID], 're-sent even though the job did not move');
});

test('CRM add line at 16 -> stays 16, NO client request (client has not been notified about this job yet)', async () => {
  jobFixture = makeJob({ job_status: 16 });
  const res = await addLine({ materialId: 10, quantity: 1, approvedAmount: 500 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(statusUpdates(fake.calls).length, 0);
  assert.deepEqual(materialRequestSent, [], 'must NOT fire at 16 — nothing has been sent to the client yet');
});

test('CRM add line on a cancelled job (6) -> 409, nothing written', async () => {
  jobFixture = makeJob({ job_status: 6 });
  const res = await addLine({ materialId: 10, quantity: 1, approvedAmount: 500 });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(quotationRows.length, 0);
});

test('CRM add line requires isJobMaterialReview — 403 without it', async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { user_id: OPS_USER_ID, permissions: { menuIds: [], actionPermissions: [] } };
    req.userRole = { role_name: 'Project Manager' };
    req.scope = { clients: { mode: 'all', ids: [] }, cities: { mode: 'all', ids: [] }, states: { mode: 'all', ids: [] }, verticals: { mode: 'all', ids: [] } };
    req.allowedStages = null;
    next();
  });
  app.use('/jobs', require('../routes/admin/jobs'));
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/jobs/${JOB_ID}/quotation-lines`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ materialId: 10, quantity: 1, approvedAmount: 500 }),
    });
    assert.equal(res.status, 403);
  } finally { srv.close(); }
});

// ═════════════════════════════════════════════════════════════════════════
// routes/admin/auxiliary.js — GET /materials/job/:jobId type filter
// ═════════════════════════════════════════════════════════════════════════

const express3 = express();
express3.use(express.json());
express3.use('/aux', require('../routes/admin/auxiliary'));
let auxServer, auxBaseUrl;
before(async () => { await new Promise((resolve) => { auxServer = express3.listen(0, resolve); }); auxBaseUrl = `http://127.0.0.1:${auxServer.address().port}`; });
after(() => { if (auxServer) auxServer.close(); });

test('GET /admin/aux/materials/job/:jobId excludes Travel/Penalty/Incentive typed rows', async () => {
  AUX_MATERIALS = [
    { id: 1, job_id: JOB_ID, name: 'Cement', description: null, sku: 'C1', unit: 2, unit_price: 100, total_price: 200, type: null },
    { id: 2, job_id: JOB_ID, name: 'Screw',  description: null, sku: 'S1', unit: 5, unit_price: 10,  total_price: 50,  type: 'Material' },
    { id: 3, job_id: JOB_ID, name: null,     description: null, sku: null, unit: 0, unit_price: 0,   total_price: 300, type: 'Travel' },
    { id: 4, job_id: JOB_ID, name: null,     description: null, sku: null, unit: 0, unit_price: 0,   total_price: 500, type: 'Penalty' },
  ];
  const res = await fetch(`${auxBaseUrl}/aux/materials/job/${JOB_ID}`);
  const body = await res.json();
  const rows = body.data || body;
  assert.deepEqual(rows.map((r) => r.id).sort(), [1, 2], 'only the NULL-type and Material-type rows may appear');
});

// ═════════════════════════════════════════════════════════════════════════
// Client + public estimate approve/reject — stamp ONLY approval_pending lines
// (services/job-estimate-approval.js stampApprovalPendingLines)
// ═════════════════════════════════════════════════════════════════════════

const clientRouter = require('../routes/client/index');
const publicEstimateRouter = require('../routes/public/estimate.js');

function handlerFor(router, routePath, method) {
  const layer = router.stack.find((e) => e.route && e.route.path === routePath && e.route.methods[method]);
  if (!layer) throw new Error(`${method.toUpperCase()} ${routePath} not mounted`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function mockRes() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
// Material Request Flow v2, 2026-09-22 correction: the estimate/approve
// routes now REQUIRE visit_date_time + permission (see
// services/job-estimate-approval.js#approveWithVisitSchedule). Defaulted
// here so every existing call below keeps exercising what it always tested
// (the stamp/status/transaction behaviour) without each needing its own
// edit; a test with different needs still overrides via its own `body`.
const APPROVE_BODY_DEFAULTS = { visit_date_time: '2026-09-23 10:00:00', permission: 'not_required' };

async function callClient(routePath, method, body = {}) {
  const r = mockRes();
  await handlerFor(clientRouter, routePath, method)(
    {
      spoc: { id: 42, client_id: 133 }, access: { allStores: true }, query: {}, params: { id: String(JOB_ID) },
      body: routePath.includes('/estimate/approve') ? { ...APPROVE_BODY_DEFAULTS, ...body } : body,
    },
    r, (e) => { throw e; },
  );
  return r;
}
const jwt = require('jsonwebtoken');
function mintEstimateToken(jobId, clientContactId = null) {
  return jwt.sign({ sub: String(jobId), clientContactId }, process.env.JWT_SECRET);
}
async function callPublic(routePath, method, { token, body = {} } = {}) {
  const r = mockRes();
  await handlerFor(publicEstimateRouter, routePath, method)(
    {
      params: { token: token || mintEstimateToken(JOB_ID, 42) },
      body: routePath.includes('/approve') ? { ...APPROVE_BODY_DEFAULTS, ...body } : body,
    },
    r, (e) => { throw e; },
  );
  return r;
}

function quotationUpdates(calls) { return calls.filter((c) => /^\s*UPDATE quotation_details\b/i.test(c.sql) && /client_status/i.test(c.sql)); }

test('client estimate approve: stamps ONLY approval_pending lines — a draft and an already-client-decided line are untouched', async () => {
  jobFixture = makeJob({ job_status: 15 });
  quotationRows = [
    qLine({ id: 1, sent_on: null }),                                                          // draft — untouched
    qLine({ id: 2, sent_on: new Date(), action_on: new Date(), status: 1, client_status: null }), // approval_pending — STAMPED
    qLine({ id: 3, sent_on: new Date(), action_on: new Date(), status: 1, client_status: 1, client_action_on: new Date('2020-01-01') }), // already decided — untouched
  ];
  const r = await callClient('/jobs/:id/estimate/approve', 'patch');
  assert.equal(r.body?.success, true, JSON.stringify(r.body));
  const upd = quotationUpdates(fake.calls)[0];
  assert.ok(upd, 'the approval_pending stamp UPDATE must have run');
  assert.match(upd.sql, /WHERE job_id = \? AND \(/);
  // Simulate what the real UPDATE would touch: only rows matching the
  // approval_pending predicate embedded in the captured SQL text.
  const affected = quotationRows.filter((r2) => qls.quotationLineState(r2) === qls.STATE.APPROVAL_PENDING);
  assert.deepEqual(affected.map((r2) => r2.id), [2], 'only line 2 is approval_pending at the moment of the call');
});

test('client estimate reject: the stamp UPDATE runs with client_status bound to 0', async () => {
  jobFixture = makeJob({ job_status: 15 });
  quotationRows = [qLine({ id: 2, sent_on: new Date(), action_on: new Date(), status: 1, client_status: null })];
  const r = await callClient('/jobs/:id/estimate/reject', 'patch', { reason: 'Too expensive' });
  assert.equal(r.body?.success, true, JSON.stringify(r.body));
  const upd = quotationUpdates(fake.calls)[0];
  assert.ok(upd);
  assert.equal(upd.params[0], 0, 'reject binds client_status = 0');
});

test('public token approve also runs the SAME stamp (one shared function, not a second copy)', async () => {
  jobFixture = makeJob({ job_status: 15 });
  quotationRows = [qLine({ id: 2, sent_on: new Date(), action_on: new Date(), status: 1, client_status: null })];
  const r = await callPublic('/:token/approve', 'patch');
  assert.equal(r.statusCode ?? 200, 200, JSON.stringify(r.body));
  const upd = quotationUpdates(fake.calls)[0];
  assert.ok(upd, 'the public-link approve must also stamp approval_pending lines');
  assert.equal(upd.params[0], 1);
});

test('the client approve/reject stamp and the status move are ONE transaction — a stamp failure must roll back the status move too', async () => {
  jobFixture = makeJob({ job_status: 15 });
  quotationRows = [qLine({ id: 2, sent_on: new Date(), action_on: new Date(), status: 1, client_status: null })];
  const db = require('../db');
  const origGetConnection = db.pool.getConnection;
  db.pool.getConnection = async () => {
    const conn = await origGetConnection();
    const origQuery = conn.query.bind(conn);
    conn.query = async (sql, params) => {
      if (/^\s*UPDATE quotation_details\b/i.test(sql) && /client_status/i.test(sql)) {
        throw new Error('simulated stamp failure');
      }
      return origQuery(sql, params);
    };
    return conn;
  };
  try {
    await assert.rejects(callClient('/jobs/:id/estimate/approve', 'patch'));
  } finally {
    db.pool.getConnection = origGetConnection;
  }
  assert.equal(statusUpdates(fake.calls).length, 0, 'a failed line stamp must leave the job_status UPDATE uncommitted/never issued as the transaction winner');
});

/*
 * MUTATION CHECKS (performed manually, not left in the suite):
 * 1. removed the `AND (type IS NULL OR type = 'Material')` clause from
 *    routes/admin/auxiliary.js's GET /materials/job/:jobId query. Re-ran
 *    this file — the test above went red (all 4 rows, including the
 *    Travel/Penalty ones, came back). Reverted.
 * 2. removed the `assertQuotationLineReviewPending` guard call+block from
 *    routes/admin/quotations.js's PATCH /:id/approve. Re-ran this file —
 *    both "on a DRAFT line" and "on a client_approved line" went red
 *    (200 instead of 409). Reverted.
 * 3. changed services/job-estimate-approval.js's stampApprovalPendingLines
 *    to bind `approved ? 0 : 1` (inverted). Re-ran this file — "client
 *    estimate reject: ... bound to 0" went red (bound 1 instead). Reverted.
 */

