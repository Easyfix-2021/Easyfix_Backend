/*
 * App Estimate Material Picker (Material Management phase 2, sub-project B).
 * See docs/superpowers/specs/2026-09-18-app-estimate-material-picker-design.md
 * ("Backend" + "Testing") — this file covers every numbered item there:
 *
 *   1. GET /:id/materials is scoped to the job's service category, and each
 *      resolved price matches resolveMaterialPrice() for the job's client +
 *      state (client override / master state / master group).
 *   2. POST /:id/quotation stores the TECHNICIAN'S amount as unit_price and
 *      the RESOLVED rate-card price as client_charge (a snapshot) — positive
 *      control: the two values differ, so a swap of the columns is caught.
 *   3. A material line without materialId is rejected with 422.
 *   4. Idempotency: the same key twice creates one quotation line.
 *
 * OWNER DECISION (2026-09-21) retired the old rule pinned by an earlier
 * version of this file ("the payload price is IGNORED; the server always
 * re-resolves and stores that"). The technician's own quoted amount is now
 * what gets billed — a material priced ₹500 in the rate card but bought for
 * ₹550 must quote ₹550 — and the resolved rate-card price moves to
 * client_charge as a same-transaction snapshot so the CRM can show Rate Card
 * vs Amount Quoted vs Approved side by side. See
 * services/mobile-job-estimate.service.js addQuotationLine's own comment.
 *
 * resolveMaterialPrice() (services/material-price-resolver.js) is NOT
 * reimplemented here — it is the real module, run against fake tables shaped
 * exactly like tests/client-material-rates.test.js already verified (same
 * JOIN-anchored regexes, so a no-brand query can never satisfy a branded
 * query's route or vice versa).
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { installFakePool } = require('./helpers/fake-pool');

// ─── In-memory tables ───────────────────────────────────────────────────

const JOBS = {
  // job_id: { fk_client_id, fk_easyfixter_id, job_status, fk_service_catg_id, state_id }
  100: { fk_client_id: 5, fk_easyfixter_id: 42, job_status: 2, fk_service_catg_id: 21, state_id: 9 },
  200: { fk_client_id: 5, fk_easyfixter_id: 42, job_status: 2, fk_service_catg_id: 21, state_id: 9 },
  201: { fk_client_id: 5, fk_easyfixter_id: 999, job_status: 2, fk_service_catg_id: 21, state_id: 9 }, // another tech's job
};

const MATERIALS = {
  // No-Brand materials (category 21) — one per price_source.
  1: { material_id: 1, material_name: 'Cement Bag', service_catg_id: 21, pricing_type: 'FIXED', uom_name: 'Bag', status: 1 },
  2: { material_id: 2, material_name: 'Steel Rod', service_catg_id: 21, pricing_type: 'FIXED', uom_name: 'Kg', status: 1 },
  3: { material_id: 3, material_name: 'PVC Pipe', service_catg_id: 21, pricing_type: 'FIXED', uom_name: 'Meter', status: 1 },
  // Branded material (category 21).
  5: { material_id: 5, material_name: 'Paint', service_catg_id: 21, pricing_type: 'FIXED', uom_name: 'Litre', status: 1 },
  // Different category — must never appear in job 100/200's list.
  4: { material_id: 4, material_name: 'Cable Reel', service_catg_id: 99, pricing_type: 'FIXED', uom_name: 'Reel', status: 1 },
  // Inactive material in the same category — must never appear either.
  6: { material_id: 6, material_name: 'Discontinued Tape', service_catg_id: 21, pricing_type: 'FIXED', uom_name: 'Roll', status: 0 },
  // For the quotation-line tests — No-Brand, master_group only.
  10: { material_id: 10, material_name: 'Screw', service_catg_id: 21, pricing_type: 'FIXED', uom_name: 'Pc', status: 1 },
};

const BRAND_LINKS = [
  { material_id: 5, brand_id: 1, brand_name: 'Asian Paints' },
];

// Price-resolver backing tables, keyed exactly the way
// services/material-price-resolver.js queries them.
const CLIENT_GROUP_BRANDED = new Map();   // `${clientId}:${materialId}:${brandId}` -> {group_id, price}
const CLIENT_GROUP_NOBRAND = new Map();   // `${clientId}:${materialId}` -> {group_id, price}
const CLIENT_STATE_PRICE = new Map();     // `${groupId}:${stateId}` -> {price}
const MASTER_GROUP_BRANDED = new Map();   // `${materialId}:${brandId}` -> {group_id, price}
const MASTER_GROUP_NOBRAND = new Map();   // `${materialId}` -> {group_id, price}
const MASTER_STATE_PRICE = new Map();     // `${groupId}:${stateId}` -> {price}

let QUOTATIONS;
let nextQuotationId;
let ledger; // tbl_idempotency_key, single-row stand-in (mirrors tests/material-add-requests.test.js)

const fake = installFakePool([
  // ─── tbl_job — ownership guard (jobForTech; SQL text pinned by
  // tests/mobile-job-estimate-timestamps.test.js, so it must not change) ──
  [/SELECT job_id, fk_client_id, fk_easyfixter_id, job_status\s+FROM tbl_job/i, (sql, params) => {
    const j = JOBS[params[0]];
    return j ? [{ job_id: params[0], fk_client_id: j.fk_client_id, fk_easyfixter_id: j.fk_easyfixter_id, job_status: j.job_status }] : [];
  }],
  // ─── tbl_job — category + state context (jobEstimateContext) ───────────
  [/SELECT j\.fk_service_catg_id, ci\.state_id/i, (sql, params) => {
    const j = JOBS[params[0]];
    return j ? [{ fk_service_catg_id: j.fk_service_catg_id, state_id: j.state_id }] : [];
  }],
  // ─── tbl_material_master — category-scoped list (getJobMaterials) ──────
  [/FROM tbl_material_master m\s+LEFT JOIN tbl_uom_master/i, (sql, params) => {
    const [catgId, like] = params;
    let rows = Object.values(MATERIALS).filter((m) => m.status === 1 && m.service_catg_id === catgId);
    if (like) {
      const needle = String(like).replace(/%/g, '').toLowerCase();
      rows = rows.filter((m) => m.material_name.toLowerCase().includes(needle));
    }
    return rows.map((m) => ({ material_id: m.material_id, material_name: m.material_name, pricing_type: m.pricing_type, uom_name: m.uom_name }));
  }],
  // ─── tbl_material_master — single lookup (addQuotationLine) ────────────
  [/SELECT material_id, material_name, service_catg_id, CAST\(status AS SIGNED\) AS status\s+FROM tbl_material_master WHERE material_id = \?/i, (sql, params) => {
    const m = MATERIALS[params[0]];
    return m ? [{ material_id: m.material_id, material_name: m.material_name, service_catg_id: m.service_catg_id, status: m.status }] : [];
  }],
  // ─── tbl_material_price_group_brand + tbl_brand_master — brand list ────
  [/FROM tbl_material_price_group_brand gb\s+JOIN tbl_brand_master bm/i, (sql, params) => {
    const ids = params[0];
    return BRAND_LINKS.filter((b) => ids.includes(b.material_id));
  }],

  // ─── services/material-price-resolver.js — same JOIN-anchored regexes as
  // tests/client-material-rates.test.js, backed by real lookup maps here. ──
  [/FROM tbl_client_material_price_group_brand gb\s+JOIN tbl_client_material_price_group g/i, (sql, params) => {
    const row = CLIENT_GROUP_BRANDED.get(`${params[0]}:${params[1]}:${params[2]}`);
    return row ? [row] : [];
  }],
  [/FROM tbl_client_material_price_group g\b/i, (sql, params) => {
    const row = CLIENT_GROUP_NOBRAND.get(`${params[0]}:${params[1]}`);
    return row ? [row] : [];
  }],
  [/FROM tbl_client_material_state_price sp/i, (sql, params) => {
    const row = CLIENT_STATE_PRICE.get(`${params[0]}:${params[1]}`);
    return row ? [row] : [];
  }],
  [/FROM tbl_material_price_group_brand gb\s+JOIN tbl_material_price_group g/i, (sql, params) => {
    const row = MASTER_GROUP_BRANDED.get(`${params[0]}:${params[1]}`);
    return row ? [row] : [];
  }],
  [/FROM tbl_material_price_group g\b/i, (sql, params) => {
    const row = MASTER_GROUP_NOBRAND.get(String(params[0]));
    return row ? [row] : [];
  }],
  [/FROM tbl_material_state_price sp/i, (sql, params) => {
    const row = MASTER_STATE_PRICE.get(`${params[0]}:${params[1]}`);
    return row ? [row] : [];
  }],

  // ─── quotation_details ──────────────────────────────────────────────────
  [/INSERT INTO quotation_details/i, (sql, params) => {
    const id = nextQuotationId++;
    QUOTATIONS[id] = { id, params };
    return { insertId: id };
  }],

  // ─── tbl_idempotency_key (middleware/idempotency.js — verbatim shapes,
  // mirrors tests/material-add-requests.test.js) ──────────────────────────
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

const estimateService = require('../services/mobile-job-estimate.service');

beforeEach(() => {
  fake.reset();
  QUOTATIONS = {}; nextQuotationId = 1; ledger = null;
  CLIENT_GROUP_BRANDED.clear(); CLIENT_GROUP_NOBRAND.clear(); CLIENT_STATE_PRICE.clear();
  MASTER_GROUP_BRANDED.clear(); MASTER_GROUP_NOBRAND.clear(); MASTER_STATE_PRICE.clear();
});

after(() => fake.restore());

// ─── 1. GET /:id/materials: category scoping + resolved prices ───────────

test('getJobMaterials scopes to the job\'s service category (other-category and inactive materials excluded)', async () => {
  const out = await estimateService.getJobMaterials(100, 42, {});
  const ids = out.items.map((i) => i.material_id).sort((a, b) => a - b);
  // Category 21, status=1: 1/2/3/5 (price-source fixtures) + 10 (used by the
  // quotation-line tests below, also category 21) — NOT 4 (category 99) or
  // 6 (status=0).
  assert.deepEqual(ids, [1, 2, 3, 5, 10], 'only category-21, status=1 materials may appear');
});

test('getJobMaterials: No-Brand material resolves client_state (client override wins)', async () => {
  CLIENT_GROUP_NOBRAND.set('5:1', { group_id: 10, price: 500 });
  CLIENT_STATE_PRICE.set('10:9', { price: 550 });
  const out = await estimateService.getJobMaterials(100, 42, {});
  const item = out.items.find((i) => i.material_id === 1);
  assert.equal(item.price, 550);
  assert.equal(item.price_source, 'client_state');
  assert.deepEqual(item.brands, []);
});

test('getJobMaterials: No-Brand material resolves master_state (no client override)', async () => {
  MASTER_GROUP_NOBRAND.set('2', { group_id: 20, price: 80 });
  MASTER_STATE_PRICE.set('20:9', { price: 95 });
  const out = await estimateService.getJobMaterials(100, 42, {});
  const item = out.items.find((i) => i.material_id === 2);
  assert.equal(item.price, 95);
  assert.equal(item.price_source, 'master_state');
});

test('getJobMaterials: No-Brand material resolves master_group (no state override anywhere)', async () => {
  MASTER_GROUP_NOBRAND.set('3', { group_id: 30, price: 40 });
  const out = await estimateService.getJobMaterials(100, 42, {});
  const item = out.items.find((i) => i.material_id === 3);
  assert.equal(item.price, 40);
  assert.equal(item.price_source, 'master_group');
});

test('getJobMaterials: a material WITH brands returns one priced entry per brand, null at the top level', async () => {
  MASTER_GROUP_BRANDED.set('5:1', { group_id: 40, price: 200 });
  const out = await estimateService.getJobMaterials(100, 42, {});
  const item = out.items.find((i) => i.material_id === 5);
  assert.equal(item.price, null);
  assert.equal(item.price_source, null);
  assert.deepEqual(item.brands, [{ brand_id: 1, brand_name: 'Asian Paints', price: 200, price_source: 'master_group' }]);
});

test('getJobMaterials: search filters by name within the category', async () => {
  const out = await estimateService.getJobMaterials(100, 42, { search: 'Steel' });
  assert.deepEqual(out.items.map((i) => i.material_id), [2]);
});

test('getJobMaterials 404s when the job is not this technician\'s', async () => {
  await assert.rejects(estimateService.getJobMaterials(201, 42, {}), (e) => { assert.equal(e.status, 404); return true; });
});

// ─── 2. POST /:id/quotation: technician amount → unit_price,
//        resolved rate-card price → client_charge (snapshot) ─────────────
//
// Bound params for every INSERT INTO quotation_details below (tx_charge/
// margin/status are literal 0/0/1 in the SQL, not bound):
//   type, name, unit, unit_price, client_charge, easyfxer_id, sent_on,
//   job_id, client_service_id, material_id.

test('addQuotationLine: unit_price = technician amount, client_charge = resolved rate-card price (positive control, different values)', async () => {
  MASTER_GROUP_NOBRAND.set('10', { group_id: 50, price: 500 });
  const out = await estimateService.addQuotationLine(200, 42, {
    type: 'material', materialId: 10, quantity: 3, amount: 550, // technician actually paid 550, rate card says 500
  });
  assert.ok(out.lineId);
  const ins = QUOTATIONS[out.lineId];
  const [type, name, unit, unitPrice, clientCharge, , , jobId, clientServiceId, materialId] = ins.params;
  assert.equal(type, 'material');
  assert.equal(name, 'Screw', 'material line name comes from the master, not the payload');
  assert.equal(unit, 3);
  assert.equal(unitPrice, 550, 'unit_price must be the TECHNICIAN\'S own quoted amount');
  assert.equal(clientCharge, 500, 'client_charge must be the RESOLVED rate-card price, as a snapshot');
  assert.equal(jobId, 200);
  assert.equal(clientServiceId, null);
  assert.equal(materialId, 10);
});

test('addQuotationLine: missing amount defaults unit_price to the resolved price (client_charge matches)', async () => {
  MASTER_GROUP_NOBRAND.set('10', { group_id: 50, price: 500 });
  const out = await estimateService.addQuotationLine(200, 42, {
    type: 'material', materialId: 10, quantity: 1, // amount omitted entirely
  });
  const ins = QUOTATIONS[out.lineId];
  assert.equal(ins.params[3], 500, 'with no technician amount, unit_price falls back to the resolved price');
  assert.equal(ins.params[4], 500, 'client_charge is always the resolved price, regardless of the fallback');
});

test('addQuotationLine: a non-positive amount (0) is treated as missing and also falls back to the resolved price', async () => {
  MASTER_GROUP_NOBRAND.set('10', { group_id: 50, price: 500 });
  const out = await estimateService.addQuotationLine(200, 42, {
    type: 'material', materialId: 10, quantity: 1, amount: 0,
  });
  const ins = QUOTATIONS[out.lineId];
  assert.equal(ins.params[3], 500, 'amount=0 is not a positive quote, so unit_price falls back to the resolved price');
});

test('addQuotationLine: amount present with source "none" stores the amount as unit_price and NULL as client_charge', async () => {
  // No client override, no master group/state anywhere for material 10 in this test.
  const out = await estimateService.addQuotationLine(200, 42, {
    type: 'material', materialId: 10, quantity: 1, amount: 77,
  });
  const ins = QUOTATIONS[out.lineId];
  assert.equal(ins.params[3], 77, 'with no resolvable price, the technician amount is the only source for unit_price');
  assert.equal(ins.params[4], null, 'client_charge must be NULL — distinguishable from a real ₹0 rate-card price — when the resolver has no price at all');
});

test('addQuotationLine: neither a positive amount nor a resolvable price → 422, no row written', async () => {
  // No fixtures set for material 10 anywhere → resolveMaterialPrice source 'none'.
  await assert.rejects(
    estimateService.addQuotationLine(200, 42, { type: 'material', materialId: 10, quantity: 1 }), // amount omitted
    (e) => { assert.equal(e.status, 422); return true; },
  );
  assert.equal(Object.keys(QUOTATIONS).length, 0, 'no line may be written for a rejected request');
});

// ─── 3. A material line without materialId → 422 ──────────────────────────

test('addQuotationLine rejects a material line with no materialId (422)', async () => {
  await assert.rejects(
    estimateService.addQuotationLine(200, 42, { type: 'material', quantity: 1, amount: 5 }),
    (e) => { assert.equal(e.status, 422); return true; },
  );
  assert.equal(Object.keys(QUOTATIONS).length, 0, 'no line may be written for a rejected request');
});

test('addQuotationLine rejects a materialId from a different service category (422)', async () => {
  await assert.rejects(
    estimateService.addQuotationLine(200, 42, { type: 'material', materialId: 4, quantity: 1, amount: 5 }),
    (e) => { assert.equal(e.status, 422); return true; },
  );
});

// ─── 4. Idempotency: the same key twice creates one line ─────────────────

test('POST /jobs/:id/quotation with a repeated Idempotency-Key creates only one line', async () => {
  MASTER_GROUP_NOBRAND.set('10', { group_id: 50, price: 12 });
  const idempotency = require('../middleware/idempotency');
  const jobsEstimateRouter = require('../routes/mobile/jobs-estimate');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tech = { efr_id: 42 }; next(); });
  app.use(idempotency());
  app.use('/jobs', jobsEstimateRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = () => fetch(`${baseUrl}/jobs/200/quotation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'quote-key-1' },
      body: JSON.stringify({ type: 'material', materialId: 10, quantity: 1, amount: 12 }),
    });

    const first = await post();
    const firstBody = await first.json();
    assert.equal(first.status, 201);
    assert.equal(Object.keys(QUOTATIONS).length, 1);

    const second = await post();
    const secondBody = await second.json();
    assert.equal(second.headers.get('idempotent-replay'), 'true');
    assert.deepEqual(secondBody, firstBody);
    assert.equal(Object.keys(QUOTATIONS).length, 1, 'the retried key must not create a second line');

    const insertCalls = fake.calls.filter((c) => /INSERT INTO quotation_details/i.test(c.sql));
    assert.equal(insertCalls.length, 1);
  } finally { server.close(); }
});

/* A deactivated brand must vanish from the technician's picker — quoting a
   brand Ops has retired is exactly what deactivation is for. The fake pool
   answers canned rows, so assert on the SQL the picker actually runs. */
test('the materials picker only offers ACTIVE brands', async () => {
  await estimateService.getJobMaterials(100, 42, {});
  const call = fake.calls.find((c) => /FROM tbl_material_price_group_brand/i.test(c.sql));
  assert.ok(call, 'the picker should query the brand join');
  assert.match(
    call.sql,
    /JOIN\s+tbl_brand_master\s+bm\s+ON\s+bm\.brand_id\s*=\s*gb\.brand_id\s+AND\s+bm\.status\s*=\s*1/i,
    'inactive brands must not reach the picker',
  );
});

/* quotation_details.unit_price is a legacy INT column, so MySQL would truncate
   a fractional quote with no error. The service must refuse it rather than
   let ₹550.50 land as ₹550 — and a fractional rate-card FALLBACK is rounded,
   not truncated, for the same column. */
test('addQuotationLine refuses a fractional technician amount (422) instead of letting MySQL truncate it', async () => {
  MASTER_GROUP_NOBRAND.set('10', { group_id: 50, price: 500 });
  await assert.rejects(
    estimateService.addQuotationLine(200, 42, { type: 'material', materialId: 10, quantity: 1, amount: 550.5 }),
    (e) => { assert.equal(e.status, 422); assert.match(e.message, /whole rupees/); return true; },
  );
});

test('addQuotationLine rounds a fractional rate-card fallback rather than truncating it', async () => {
  MASTER_GROUP_NOBRAND.set('10', { group_id: 50, price: 180.5 });
  const out = await estimateService.addQuotationLine(200, 42, { type: 'material', materialId: 10, quantity: 1 });
  const [, , , unitPrice, clientCharge] = QUOTATIONS[out.lineId].params;
  assert.equal(unitPrice, 181, 'the INT unit_price gets the rounded rate, not a truncated 180');
  assert.equal(clientCharge, 180.5, 'client_charge is FLOAT and keeps the exact rate');
});
