/*
 * Material Add Requests (Material Management phase 2, sub-project A). See
 * docs/superpowers/specs/2026-09-18-material-add-requests-design.md — this
 * file covers every numbered item in its "Testing" section.
 *
 * One shared fake pool backs three things at once, the same way the real
 * `pool` singleton does: tbl_material_add_request + tbl_job + tbl_material_master
 * (material-request.service.js + material.service.js) AND tbl_idempotency_key
 * (middleware/idempotency.js) — item 5 needs the real idempotency middleware
 * in front of the real mobile route, not a re-implementation of it.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { installFakePool } = require('./helpers/fake-pool');

// ─── In-memory tables ─────────────────────────────────────────────────────

const JOBS = {
  900: { job_id: 900, fk_easyfixter_id: 55, fk_service_catg_id: 21 },
  901: { job_id: 901, fk_easyfixter_id: 999, fk_service_catg_id: 30 }, // owned by a different tech
};

let REQUESTS;
let MATERIALS;
let nextRequestId;
let nextMaterialId;
let ledger; // tbl_idempotency_key, single-row stand-in (mirrors tests/idempotency-route.test.js)
const scenario = { failMaterialInsert: false, failStampUpdate: false };

function seedRequest(overrides = {}) {
  const id = nextRequestId++;
  REQUESTS[id] = {
    request_id: id,
    material_name: 'Drill Bit 10mm',
    brand_name: null,
    service_catg_id: 21,
    job_id: 900,
    efr_id: 55,
    expected_price: null,
    qty: null,
    note: null,
    request_status: 1,
    reject_reason: null,
    material_id: null,
    reviewed_by: null,
    reviewed_at: null,
    created_at: new Date(),
    ...overrides,
  };
  return id;
}

function seedMaterial(overrides = {}) {
  const id = nextMaterialId++;
  MATERIALS[id] = {
    material_id: id,
    material_name: 'Existing Material',
    material_key: 'existing material',
    description: null,
    service_catg_id: 21,
    uom_id: null,
    pricing_type: 'DYNAMIC',
    status: 1,
    created_by: null,
    created_at: new Date(),
    ...overrides,
  };
  return id;
}

const fake = installFakePool([
  // ─── tbl_job (ownership guard) ──────────────────────────────────────
  [/SELECT job_id, fk_easyfixter_id, fk_service_catg_id FROM tbl_job WHERE job_id = \?/i,
    (sql, params) => { const j = JOBS[params[0]]; return j ? [j] : []; }],

  // ─── tbl_material_add_request ───────────────────────────────────────
  [/INSERT INTO tbl_material_add_request/i, (sql, params) => {
    const [material_name, brand_name, service_catg_id, job_id, efr_id, expected_price, qty, note, request_status] = params;
    const id = nextRequestId++;
    REQUESTS[id] = {
      request_id: id, material_name, brand_name, service_catg_id, job_id, efr_id,
      expected_price, qty, note, request_status,
      reject_reason: null, material_id: null, reviewed_by: null, reviewed_at: null, created_at: new Date(),
    };
    return { insertId: id };
  }],
  [/UPDATE tbl_material_add_request\s+SET request_status = \?, material_id/i, (sql, params) => {
    if (scenario.failStampUpdate) throw new Error('stamp update failed (simulated)');
    const [newStatus, materialId, reviewedBy, reviewedAt, id, expectedStatus] = params;
    const row = REQUESTS[id];
    if (!row || row.request_status !== expectedStatus) return { affectedRows: 0 };
    row.request_status = newStatus; row.material_id = materialId; row.reviewed_by = reviewedBy; row.reviewed_at = reviewedAt;
    return { affectedRows: 1 };
  }],
  [/UPDATE tbl_material_add_request\s+SET request_status = \?, reject_reason/i, (sql, params) => {
    const [newStatus, reason, reviewedBy, reviewedAt, id, expectedStatus] = params;
    const row = REQUESTS[id];
    if (!row || row.request_status !== expectedStatus) return { affectedRows: 0 };
    row.request_status = newStatus; row.reject_reason = reason; row.reviewed_by = reviewedBy; row.reviewed_at = reviewedAt;
    return { affectedRows: 1 };
  }],
  [/FROM tbl_material_add_request WHERE request_id = \?/i, (sql, params) => {
    const row = REQUESTS[params[0]]; return row ? [row] : [];
  }],
  [/FROM tbl_material_add_request WHERE job_id = \?/i, (sql, params) => {
    return Object.values(REQUESTS).filter((r) => r.job_id === params[0]);
  }],
  [/SELECT r\.request_id, r\.material_name/i, () => Object.values(REQUESTS)],
  [/SELECT COUNT\(\*\) AS total FROM tbl_material_add_request/i, () => [{ total: Object.keys(REQUESTS).length }]],
  [/SELECT COUNT\(\*\) AS count FROM tbl_material_add_request/i, (sql, params) => {
    const code = params[0];
    return [{ count: Object.values(REQUESTS).filter((r) => r.request_status === code).length }];
  }],

  // ─── tbl_material_master (material.service.js createMaterial / deleteMaterial) ─
  [/FROM tbl_material_master WHERE material_id = \? AND status = 1/i, (sql, params) => {
    const m = MATERIALS[params[0]];
    return (m && m.status === 1) ? [{ material_id: m.material_id, material_name: m.material_name }] : [];
  }],
  [/material_key = \?\s+AND service_catg_id = \?\s+AND status = 1/i, (sql, params) => {
    const [key, catgId] = params;
    const found = Object.values(MATERIALS).find((m) => m.material_key === key && m.service_catg_id === catgId && m.status === 1);
    return found ? [{ material_id: found.material_id, material_name: found.material_name }] : [];
  }],
  [/material_key = \?\s+AND service_catg_id = \?\s+LIMIT 1/i, (sql, params) => {
    const [key, catgId] = params;
    const found = Object.values(MATERIALS).find((m) => m.material_key === key && m.service_catg_id === catgId);
    return found ? [{ material_id: found.material_id, material_name: found.material_name }] : [];
  }],
  [/INSERT INTO tbl_material_master/i, (sql, params) => {
    if (scenario.failMaterialInsert) throw new Error('material insert failed (simulated)');
    const [material_name, material_key, description, service_catg_id, uom_id, pricing_type] = params;
    const id = nextMaterialId++;
    MATERIALS[id] = { material_id: id, material_name, material_key, description, service_catg_id, uom_id, pricing_type, status: 1 };
    return { insertId: id };
  }],
  [/FROM tbl_material_master m[\s\S]*WHERE m\.material_id = \?/i, (sql, params) => {
    const m = MATERIALS[params[0]];
    return m ? [{ material_id: m.material_id, material_name: m.material_name, description: m.description,
      service_catg_id: m.service_catg_id, service_catg_name: null, uom_id: m.uom_id, uom_name: null,
      pricing_type: m.pricing_type, status: 1 }] : [];
  }],
  [/SELECT group_id, price FROM tbl_material_price_group WHERE material_id = \?/i, () => []],
  [/DELETE FROM tbl_material_master WHERE material_id = \?/i, (sql, params) => {
    delete MATERIALS[params[0]];
    return { affectedRows: 1 };
  }],

  // ─── tbl_idempotency_key (middleware/idempotency.js — verbatim shapes) ──
  [/^\s*INSERT INTO tbl_idempotency_key/i, (sql, params) => {
    if (ledger) { const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e; }
    ledger = { fingerprint: params[5], leaseToken: params[6], state: 'in_flight', response_status: null, response_json: null };
    return { affectedRows: 1 };
  }],
  [/^\s*SELECT request_fingerprint/i, () => (ledger ? [{
    request_fingerprint: ledger.fingerprint, state: ledger.state,
    response_status: ledger.response_status, response_json: ledger.response_json,
    retry_after_seconds: 0,
  }] : [])],
  [/SET response_status = \?, response_json/i, (sql, params) => {
    if (!ledger) return { affectedRows: 0 };
    ledger.response_status = params[0]; ledger.response_json = params[1]; ledger.state = 'done';
    return { affectedRows: 1 };
  }],
  [/^\s*DELETE FROM tbl_idempotency_key/i, () => { ledger = null; return { affectedRows: 1 }; }],
]);

const materialRequestSvc = require('../services/material-request.service');

beforeEach(() => {
  fake.reset();
  REQUESTS = {}; MATERIALS = {}; ledger = null;
  nextRequestId = 1000; nextMaterialId = 5000;
  scenario.failMaterialInsert = false;
  scenario.failStampUpdate = false;
});

after(() => { fake.restore(); });

// ─── 4. service_catg_id is read from the job — positive control ──────────

test('createFromJob stamps the JOB\'s service_catg_id and ignores any value in the payload', async () => {
  const out = await materialRequestSvc.createFromJob(900, 55, { material_name: 'Pipe Fitting', service_catg_id: 99999 });
  assert.equal(out.service_catg_id, 21); // job 900's fk_service_catg_id — NOT 99999
  const insertCall = fake.calls.find((c) => /INSERT INTO tbl_material_add_request/i.test(c.sql));
  assert.ok(insertCall, 'insert should have run');
  assert.equal(insertCall.params[2], 21, 'the bound service_catg_id param must be the job\'s, not the payload\'s');
});

test('createFromJob 404s when the job is not this technician\'s', async () => {
  await assert.rejects(materialRequestSvc.createFromJob(901, 55, { material_name: 'X' }), (e) => { assert.equal(e.status, 404); return true; });
});

test('listForJob returns only this job\'s requests, newest scoped correctly', async () => {
  seedRequest({ job_id: 900 });
  seedRequest({ job_id: 555 });
  const out = await materialRequestSvc.listForJob(900, 55);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].job_id, 900);
});

// ─── 1. approve creates the master material and stamps the request ───────

test('approveRequest creates a master material and stamps the request (no link)', async () => {
  const id = seedRequest({ material_name: 'Wall Anchor' });
  const out = await materialRequestSvc.approveRequest(id, { pricing_type: 'DYNAMIC' }, { userId: 7 });

  assert.equal(out.request_status, 2);
  assert.ok(out.material_id, 'request should be stamped with the new material_id');
  assert.ok(MATERIALS[out.material_id], 'a new master material row should exist');
  assert.equal(MATERIALS[out.material_id].material_name, 'Wall Anchor');
  assert.equal(out.reviewed_by, 7);

  const insertIdx = fake.calls.findIndex((c) => /INSERT INTO tbl_material_master/i.test(c.sql));
  const updateIdx = fake.calls.findIndex((c) => /UPDATE tbl_material_add_request\s+SET request_status = \?, material_id/i.test(c.sql));
  assert.ok(insertIdx >= 0 && updateIdx >= 0 && insertIdx < updateIdx, 'material must be created before the request is stamped');
});

test('approveRequest with link_material_id links instead of creating', async () => {
  const materialId = seedMaterial({ material_name: 'Screwdriver Set' });
  const id = seedRequest();
  const out = await materialRequestSvc.approveRequest(id, { link_material_id: materialId }, { userId: 7 });

  assert.equal(out.material_id, materialId);
  const createCalls = fake.calls.filter((c) => /INSERT INTO tbl_material_master/i.test(c.sql));
  assert.equal(createCalls.length, 0, 'linking must not create a new material');
});

// Mutation control: a failing material create must roll back BOTH — i.e. the
// request must be left untouched (never stamped), proving there is no
// half-approved state even though the two steps are not one literal txn.
test('mutation control: a failing material create leaves the request pending, untouched', async () => {
  const id = seedRequest();
  scenario.failMaterialInsert = true;
  await assert.rejects(materialRequestSvc.approveRequest(id, { pricing_type: 'DYNAMIC' }, { userId: 7 }));

  assert.equal(REQUESTS[id].request_status, 1, 'request must still be pending');
  assert.equal(REQUESTS[id].material_id, null);
  const stampCalls = fake.calls.filter((c) => /UPDATE tbl_material_add_request\s+SET request_status = \?, material_id/i.test(c.sql));
  assert.equal(stampCalls.length, 0, 'the stamp must never even be attempted when material creation failed');
});

// Mutation control: the reverse direction — material creation succeeds but
// the stamp fails. The just-created material must be rolled back (deleted)
// so it doesn't orphan behind a still-pending request.
test('mutation control: a failing stamp rolls back the just-created material', async () => {
  const id = seedRequest();
  scenario.failStampUpdate = true;
  await assert.rejects(materialRequestSvc.approveRequest(id, { pricing_type: 'DYNAMIC' }, { userId: 7 }));

  assert.equal(REQUESTS[id].request_status, 1, 'request must still be pending');
  assert.equal(Object.keys(MATERIALS).length, 0, 'the orphaned material must have been deleted');
});

// ─── 2. already-reviewed → 409; reject without a reason → 422 ────────────

test('approveRequest on an already-reviewed request → 409', async () => {
  const id = seedRequest({ request_status: 2 });
  await assert.rejects(materialRequestSvc.approveRequest(id, {}, {}), (e) => { assert.equal(e.status, 409); return true; });
});

test('rejectRequest on an already-reviewed request → 409', async () => {
  const id = seedRequest({ request_status: 3 });
  await assert.rejects(materialRequestSvc.rejectRequest(id, { reject_reason: 'dup' }, {}), (e) => { assert.equal(e.status, 409); return true; });
});

test('rejectRequest without a reason → 422', async () => {
  const id = seedRequest();
  await assert.rejects(materialRequestSvc.rejectRequest(id, {}, {}), (e) => { assert.equal(e.status, 422); return true; });
  assert.equal(REQUESTS[id].request_status, 1, 'an invalid reject must not mutate the row');
});

test('rejectRequest with a reason succeeds', async () => {
  const id = seedRequest();
  const out = await materialRequestSvc.rejectRequest(id, { reject_reason: 'Already stocked' }, { userId: 3 });
  assert.equal(out.request_status, 3);
  assert.equal(out.reject_reason, 'Already stocked');
});

// ─── 3. duplicate name → 409 naming the existing material ────────────────

test('approveRequest 409s naming the existing material when the name already matches an active one', async () => {
  const dupId = seedMaterial({ material_name: 'Cement Bag 50kg', material_key: 'cement bag 50kg', service_catg_id: 21 });
  const id = seedRequest({ material_name: 'Cement Bag 50kg' });
  await assert.rejects(materialRequestSvc.approveRequest(id, { pricing_type: 'DYNAMIC' }, {}), (e) => {
    assert.equal(e.status, 409);
    assert.ok(e.message.includes('Cement Bag 50kg'), e.message);
    assert.equal(e.existing_material_id, dupId);
    return true;
  });
});

// ─── 6. RBAC — approve/reject require isMaterialAddNew; list requires isMaterialView ─

function buildAdminApp(actions) {
  const router = require('../routes/admin/material-requests');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { user_id: 1, permissions: { menuIds: [], actionPermissions: actions } }; next(); });
  app.use('/material-requests', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err && err.message) }));
  return app;
}

async function listenOn(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test('RBAC: isMaterialAddNew-only user gets 403 on GET /material-requests (needs isMaterialView)', async () => {
  const { server, baseUrl } = await listenOn(buildAdminApp(['isMaterialAddNew']));
  try {
    const res = await fetch(`${baseUrl}/material-requests`);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /isMaterialView/);
  } finally { server.close(); }
});

test('RBAC: isMaterialView-only user gets 403 on POST /material-requests/:id/approve (needs isMaterialAddNew)', async () => {
  const { server, baseUrl } = await listenOn(buildAdminApp(['isMaterialView']));
  try {
    const res = await fetch(`${baseUrl}/material-requests/1/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /isMaterialAddNew/);
  } finally { server.close(); }
});

test('RBAC: isMaterialView-only user gets 403 on POST /material-requests/:id/reject (needs isMaterialAddNew)', async () => {
  const { server, baseUrl } = await listenOn(buildAdminApp(['isMaterialView']));
  try {
    const res = await fetch(`${baseUrl}/material-requests/1/reject`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reject_reason: 'x' }) });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /isMaterialAddNew/);
  } finally { server.close(); }
});

test('RBAC: a user holding both keys can list and approve', async () => {
  const id = seedRequest({ material_name: 'Cable Tie' });
  const { server, baseUrl } = await listenOn(buildAdminApp(['isMaterialView', 'isMaterialAddNew']));
  try {
    const listRes = await fetch(`${baseUrl}/material-requests`);
    assert.equal(listRes.status, 200);
    const approveRes = await fetch(`${baseUrl}/material-requests/${id}/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pricing_type: 'DYNAMIC' }),
    });
    assert.equal(approveRes.status, 200);
  } finally { server.close(); }
});

// ─── 5. Idempotency: the same key twice creates one row ──────────────────

test('POST /jobs/:id/material-request with a repeated Idempotency-Key creates only one row', async () => {
  const idempotency = require('../middleware/idempotency');
  const jobsEstimateRouter = require('../routes/mobile/jobs-estimate');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tech = { efr_id: 55 }; next(); });
  app.use(idempotency());
  app.use('/jobs', jobsEstimateRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = () => fetch(`${baseUrl}/jobs/900/material-request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'mat-req-key-1' },
      body: JSON.stringify({ material_name: 'Silicone Sealant' }),
    });

    const first = await post();
    const firstBody = await first.json();
    assert.equal(first.status, 201);
    assert.equal(Object.keys(REQUESTS).length, 1);

    const second = await post();
    const secondBody = await second.json();
    assert.equal(second.headers.get('idempotent-replay'), 'true');
    assert.deepEqual(secondBody, firstBody);
    assert.equal(Object.keys(REQUESTS).length, 1, 'the retried key must not create a second row');

    const insertCalls = fake.calls.filter((c) => /INSERT INTO tbl_material_add_request/i.test(c.sql));
    assert.equal(insertCalls.length, 1);
  } finally { server.close(); }
});

// ─── 7. TINYINT cast guard on request_status ──────────────────────────────

test('services/material-request.service.js: request_status is CAST before reaching the API', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'material-request.service.js'), 'utf8');
  const lists = [...src.matchAll(/SELECT\b([\s\S]*?)\bFROM\b/g)].map((m) => m[1]);
  assert.ok(lists.length > 0, 'found no SELECT — the guard would pass vacuously');
  const FLAG = /(?:^|[\s,(])(?:\w+\.)?(request_status)\s*(?:,|$|\s+FROM\b)/im;
  const offenders = lists
    .map((list) => list.replace(/CAST\([^)]*\)\s+AS\s+\w+/gi, ''))
    .filter((list) => FLAG.test(list));
  assert.deepEqual(offenders, [], 'bare TINYINT request_status in a SELECT list');
});
