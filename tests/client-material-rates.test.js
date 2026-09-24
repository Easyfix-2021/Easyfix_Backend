'use strict';
/*
 * Client Material Rates (sub-project C) — see
 * docs/superpowers/specs/2026-09-18-client-material-rates-design.md.
 *
 * Covers, per the spec's "Testing" section:
 *   1. Resolver — one test per branch (client_state / client_group /
 *      master_state / master_group / none) plus the two rules (missing
 *      stateId skips steps 1+3; a client group with no matching state falls
 *      to client_group, never master_state).
 *   2. Validation guards — duplicate brand across groups, missing price,
 *      mixing No Brand with a branded group.
 *   3. Review flag — master_price_seen equal / different / NULL.
 *   4. TINYINT cast guard on the list SELECT (fake-pool rows return plain
 *      numbers and cannot catch a bare boolean-cast column — see
 *      tests/manage-materials-tinyint-cast.test.js, same shape here).
 *   5. Route gate — write endpoints require isClientEdit and are scope-
 *      guarded via the client's own loadAndGuardClient (same mechanism
 *      tests/client-rate-card-delete-scope.test.js verifies elsewhere).
 */
const { test, beforeEach, describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installFakePool } = require('./helpers/fake-pool');

const ROOT = path.join(__dirname, '..');

// ─── 1. Resolver ─────────────────────────────────────────────────────────

const scenario = {
  clientGroupBranded: null,
  clientGroupNoBrand: null,
  clientStatePrice: null,
  masterGroupBranded: null,
  masterGroupNoBrand: null,
  masterStatePrice: null,
  removeGroupRow: null,
};

const fake = installFakePool([
  // client group — branded. Requires the immediate JOIN so this does NOT also
  // match the no-brand query's `NOT EXISTS (SELECT 1 FROM
  // tbl_client_material_price_group_brand gb WHERE gb.group_id = g.group_id)`,
  // which contains the same table name with no JOIN after it.
  [/FROM tbl_client_material_price_group_brand gb\s+JOIN tbl_client_material_price_group g/i, () => (scenario.clientGroupBranded ? [scenario.clientGroupBranded] : [])],
  // client group — No Brand / sole group (top-level FROM, never matches the
  // branded query above, where this table is reached via JOIN, not FROM).
  [/FROM tbl_client_material_price_group g\b/i, () => (scenario.clientGroupNoBrand ? [scenario.clientGroupNoBrand] : [])],
  // client state price
  [/FROM tbl_client_material_state_price sp/i, () => (scenario.clientStatePrice ? [scenario.clientStatePrice] : [])],
  // master group — branded (same JOIN-anchoring reason as the client one above).
  [/FROM tbl_material_price_group_brand gb\s+JOIN tbl_material_price_group g/i, () => (scenario.masterGroupBranded ? [scenario.masterGroupBranded] : [])],
  // master group — No Brand / sole group
  [/FROM tbl_material_price_group g\b/i, () => (scenario.masterGroupNoBrand ? [scenario.masterGroupNoBrand] : [])],
  // master state price
  [/FROM tbl_material_state_price sp/i, () => (scenario.masterStatePrice ? [scenario.masterStatePrice] : [])],
  // remove(): existence check for a (client_id, material_id) pair on the card
  [/SELECT group_id FROM tbl_client_material_price_group WHERE client_id = \?/i, () => (scenario.removeGroupRow ? [scenario.removeGroupRow] : [])],
]);

const { resolveMaterialPrice } = require('../services/material-price-resolver');

beforeEach(() => {
  fake.reset();
  scenario.clientGroupBranded = null;
  scenario.clientGroupNoBrand = null;
  scenario.clientStatePrice = null;
  scenario.masterGroupBranded = null;
  scenario.masterGroupNoBrand = null;
  scenario.masterStatePrice = null;
  scenario.removeGroupRow = null;
});

test('resolver: client_state wins when the client has a state price for the brand\'s group', async () => {
  scenario.clientGroupBranded = { group_id: 1, price: 100 };
  scenario.clientStatePrice = { price: 150 };
  const out = await resolveMaterialPrice({ clientId: 1, materialId: 2, brandId: 3, stateId: 4 });
  assert.deepEqual(out, { price: 150, source: 'client_state', groupId: 1, tx_share: 30 });
});

test('resolver: client_state uses its OWN stored tx_share when set, not the 20% default', async () => {
  scenario.clientGroupBranded = { group_id: 1, price: 100 };
  scenario.clientStatePrice = { price: 150, tx_share: 42 };
  const out = await resolveMaterialPrice({ clientId: 1, materialId: 2, brandId: 3, stateId: 4 });
  assert.deepEqual(out, { price: 150, source: 'client_state', groupId: 1, tx_share: 42 });
});

test('resolver: client_group wins when the client has a brand price but no matching state price', async () => {
  scenario.clientGroupBranded = { group_id: 1, price: 100 };
  scenario.clientStatePrice = null;
  const out = await resolveMaterialPrice({ clientId: 1, materialId: 2, brandId: 3, stateId: 4 });
  assert.deepEqual(out, { price: 100, source: 'client_group', groupId: 1, tx_share: 20 });
});

test('resolver: client_group uses its OWN stored tx_share when set, not the 20% default', async () => {
  scenario.clientGroupBranded = { group_id: 1, price: 100, tx_share: 33 };
  const out = await resolveMaterialPrice({ clientId: 1, materialId: 2, brandId: 3, stateId: 4 });
  assert.deepEqual(out, { price: 100, source: 'client_group', groupId: 1, tx_share: 33 });
});

test('resolver: master_state wins when there is no client override but the master has a state price', async () => {
  scenario.masterGroupBranded = { group_id: 9, price: 80 };
  scenario.masterStatePrice = { price: 95 };
  const out = await resolveMaterialPrice({ clientId: 1, materialId: 2, brandId: 3, stateId: 4 });
  assert.deepEqual(out, { price: 95, source: 'master_state', groupId: 9, tx_share: 19 });
});

test('resolver: master_group wins when there is no client override and no master state price', async () => {
  scenario.masterGroupBranded = { group_id: 9, price: 80 };
  scenario.masterStatePrice = null;
  const out = await resolveMaterialPrice({ clientId: 1, materialId: 2, brandId: 3, stateId: 4 });
  assert.deepEqual(out, { price: 80, source: 'master_group', groupId: 9, tx_share: 16 });
});

test('resolver: none when nothing prices the material anywhere (phase-1 Price Pending)', async () => {
  const out = await resolveMaterialPrice({ clientId: 1, materialId: 2, brandId: 3, stateId: 4 });
  assert.deepEqual(out, { price: null, source: 'none', groupId: null, tx_share: null });
});

test('resolver: none when the master group exists but its price is NULL (Price Pending) and no state override', async () => {
  scenario.masterGroupBranded = { group_id: 9, price: null };
  const out = await resolveMaterialPrice({ clientId: 1, materialId: 2, brandId: 3, stateId: 4 });
  assert.deepEqual(out, { price: null, source: 'none', groupId: null, tx_share: null });
});

// ─── Rule: a missing stateId skips steps 1 and 3 ──────────────────────────

test('resolver rule: missing stateId skips the client_state lookup entirely', async () => {
  scenario.clientGroupBranded = { group_id: 1, price: 100 };
  scenario.clientStatePrice = { price: 999 }; // would win if the rule were violated
  const out = await resolveMaterialPrice({ clientId: 1, materialId: 2, brandId: 3 }); // no stateId
  assert.deepEqual(out, { price: 100, source: 'client_group', groupId: 1, tx_share: 20 });
  assert.ok(!fake.calls.some((c) => /FROM tbl_client_material_state_price sp/i.test(c.sql)),
    'no stateId means the client-state query must never run');
});

test('resolver rule: missing stateId skips the master_state lookup entirely', async () => {
  scenario.masterGroupBranded = { group_id: 9, price: 80 };
  scenario.masterStatePrice = { price: 999 }; // would win if the rule were violated
  const out = await resolveMaterialPrice({ clientId: 1, materialId: 2, brandId: 3 }); // no stateId
  assert.deepEqual(out, { price: 80, source: 'master_group', groupId: 9, tx_share: 16 });
  assert.ok(!fake.calls.some((c) => /FROM tbl_material_state_price sp/i.test(c.sql)),
    'no stateId means the master-state query must never run');
});

// ─── Rule: a client group without that state falls to client_group, NEVER master_state ──

test('resolver rule: a client group with no price for this state never falls through to master_state', async () => {
  scenario.clientGroupBranded = { group_id: 1, price: 100 };
  scenario.clientStatePrice = null; // client has no override for THIS state
  scenario.masterGroupBranded = { group_id: 9, price: 80 };
  scenario.masterStatePrice = { price: 55 }; // must be ignored — client_group wins first
  const out = await resolveMaterialPrice({ clientId: 1, materialId: 2, brandId: 3, stateId: 4 });
  assert.deepEqual(out, { price: 100, source: 'client_group', groupId: 1, tx_share: 20 });
  assert.ok(!fake.calls.some((c) => /FROM tbl_material_price_group_brand gb/i.test(c.sql)),
    'once a client group is found, master tables must never be queried');
  assert.ok(!fake.calls.some((c) => /FROM tbl_material_state_price sp/i.test(c.sql)),
    'once a client group is found, the master state price must never be queried');
});

// ─── Rule: a missing brandId (No Brand) resolves against the sole group ───

test('resolver rule: missing brandId resolves against the client\'s sole No Brand group', async () => {
  scenario.clientGroupNoBrand = { group_id: 5, price: 60 };
  const out = await resolveMaterialPrice({ clientId: 1, materialId: 2 }); // no brandId
  assert.deepEqual(out, { price: 60, source: 'client_group', groupId: 5, tx_share: 12 });
});

test('resolver rule: missing brandId falls to the master\'s sole No Brand group with no client override', async () => {
  scenario.masterGroupNoBrand = { group_id: 11, price: 40 };
  const out = await resolveMaterialPrice({ clientId: 1, materialId: 2 }); // no brandId
  assert.deepEqual(out, { price: 40, source: 'master_group', groupId: 11, tx_share: 8 });
});

// ─── 2. Validation guards (services/client-material-rates.service.js) ────

const ratesSvc = require('../services/client-material-rates.service');

test('validation: a brand cannot repeat across price groups on the same material → 422', () => {
  assert.throws(
    () => ratesSvc.validateClientGroupsPayload([
      { price: 100, brand_ids: [5] },
      { price: 200, brand_ids: [5] },
    ]),
    (e) => { assert.equal(e.status, 422); return true; },
  );
});

test('validation: a missing/zero price on a group → 422', () => {
  assert.throws(
    () => ratesSvc.validateClientGroupsPayload([{ price: null, brand_ids: [5] }]),
    (e) => { assert.equal(e.status, 422); return true; },
  );
  assert.throws(
    () => ratesSvc.validateClientGroupsPayload([{ price: 0, brand_ids: [5] }]),
    (e) => { assert.equal(e.status, 422); return true; },
  );
});

test('validation: No Brand cannot be mixed with a branded group → 422', () => {
  assert.throws(
    () => ratesSvc.validateClientGroupsPayload([
      { price: 100, brand_ids: [] },
      { price: 200, brand_ids: [5] },
    ]),
    (e) => { assert.equal(e.status, 422); return true; },
  );
});

test('validation: a single No Brand group as the sole group is legal', () => {
  assert.doesNotThrow(() => ratesSvc.validateClientGroupsPayload([{ price: 100, brand_ids: [] }]));
});

test('validation: distinct branded groups with valid prices are legal', () => {
  assert.doesNotThrow(() => ratesSvc.validateClientGroupsPayload([
    { price: 100, brand_ids: [5] },
    { price: 200, brand_ids: [8], states: [{ price: 210, state_ids: [12] }] },
  ]));
});

// ─── 2b. Tx Share validation (2026-09-24) ─────────────────────────────
// Exercised directly against the service — the ROUTE'S own Joi schema
// (routes/admin/clients.js's txShareField: min(0) + precision(2), which
// ROUNDS rather than rejects extra decimals) already blocks a negative
// value before this guard would ever see it; this is what protects a
// caller that skips Joi entirely — the bulk-upload service, which compiles
// groups programmatically from parsed Excel rows.

test('validation: a negative tx_share on a group → 422', () => {
  assert.throws(
    () => ratesSvc.validateClientGroupsPayload([{ price: 100, brand_ids: [5], tx_share: -1 }]),
    (e) => { assert.equal(e.status, 422); return true; },
  );
});

test('validation: a tx_share with more than 2 decimal places on a group → 422', () => {
  assert.throws(
    () => ratesSvc.validateClientGroupsPayload([{ price: 100, brand_ids: [5], tx_share: 12.345 }]),
    (e) => { assert.equal(e.status, 422); return true; },
  );
});

test('validation: a negative tx_share on a state override → 422', () => {
  assert.throws(
    () => ratesSvc.validateClientGroupsPayload([
      { price: 100, brand_ids: [5], states: [{ price: 110, state_ids: [12], tx_share: -1 }] },
    ]),
    (e) => { assert.equal(e.status, 422); return true; },
  );
});

test('validation: an omitted or valid tx_share is legal', () => {
  assert.doesNotThrow(() => ratesSvc.validateClientGroupsPayload([{ price: 100, brand_ids: [5] }]));
  assert.doesNotThrow(() => ratesSvc.validateClientGroupsPayload([{ price: 100, brand_ids: [5], tx_share: 0 }]));
  assert.doesNotThrow(() => ratesSvc.validateClientGroupsPayload([{ price: 100, brand_ids: [5], tx_share: 33.5 }]));
});

// ─── 3. Review flag ────────────────────────────────────────────────────

test('review flag: master_price_seen NULL → no flag', () => {
  assert.deepEqual(ratesSvc.reviewFlag(null, 250), { flagged: false });
});

test('review flag: seen equals today\'s master price → no flag', () => {
  assert.deepEqual(ratesSvc.reviewFlag(250, 250), { flagged: false });
});

test('review flag: seen differs from today\'s master price → flagged with both values', () => {
  assert.deepEqual(ratesSvc.reviewFlag(250, 275), { flagged: true, master_price_seen: 250, master_price_today: 275 });
});

// ─── 4. TINYINT cast guard ─────────────────────────────────────────────
// Mirrors tests/manage-materials-tinyint-cast.test.js: db.js typeCast turns
// TINYINT(1) into a JS boolean, so any status column reaching a SELECT must
// be CAST(... AS SIGNED). Fake-pool rows return plain numbers and cannot
// catch this — hence a source-level guard.

test('services/client-material-rates.service.js: status is CAST before reaching the API', () => {
  const src = fs.readFileSync(path.join(ROOT, 'services/client-material-rates.service.js'), 'utf8');
  const FLAG = /(?:^|[\s,(])(?:\w+\.)?(status)\s*(?:,|$|\s+FROM\b)/im;
  const lists = [...src.matchAll(/SELECT\b([\s\S]*?)\bFROM\b/g)].map((m) => m[1]);
  assert.ok(lists.length > 0, 'found no SELECT — the guard would pass vacuously');
  const offenders = lists
    .map((list) => list.replace(/CAST\([^)]*\)\s+AS\s+\w+/gi, ''))
    .filter((list) => FLAG.test(list));
  assert.deepEqual(offenders, [], 'bare status flag in a SELECT list of client-material-rates.service.js');
});

// ─── 5. Route gate ──────────────────────────────────────────────────────

const ROUTES = fs.readFileSync(path.join(ROOT, 'routes/admin/clients.js'), 'utf8');

function routeBlock(anchor) {
  const idx = ROUTES.indexOf(anchor);
  assert.ok(idx >= 0, `route registration for ${anchor} not found`);
  const end = ROUTES.indexOf('\n);', idx);
  assert.ok(end > idx, `route registration for ${anchor} has no closing ");"`);
  return ROUTES.slice(idx, end);
}

test('PUT /:clientId/material-rates/:materialId requires isClientEdit and is client-scope-guarded', () => {
  const block = routeBlock("'/:clientId/material-rates/:materialId'");
  assert.match(block, /requireClientEdit/, 'write route must require isClientEdit');
  assert.match(block, /loadAndGuardClient\(/, 'write route must run the client scope-guard');
});

test('DELETE /:clientId/material-rates/:materialId requires isClientEdit and is client-scope-guarded', () => {
  const idx = ROUTES.indexOf("router.delete(\n  '/:clientId/material-rates/:materialId'");
  assert.ok(idx >= 0, 'DELETE route registration not found');
  const end = ROUTES.indexOf('\n);', idx);
  const block = ROUTES.slice(idx, end);
  assert.match(block, /requireClientEdit/, 'delete route must require isClientEdit');
  assert.match(block, /loadAndGuardClient\(/, 'delete route must run the client scope-guard');
});

test('POST /:clientId/material-rates/:materialId/accept-master requires isClientEdit and is client-scope-guarded', () => {
  const block = routeBlock("'/:clientId/material-rates/:materialId/accept-master'");
  assert.match(block, /requireClientEdit/, 'accept-master route must require isClientEdit');
  assert.match(block, /loadAndGuardClient\(/, 'accept-master route must run the client scope-guard');
});

test('GET routes for material-rates carry no write gate (client view only)', () => {
  const listIdx = ROUTES.indexOf("router.get('/:clientId/material-rates', ");
  const optionsIdx = ROUTES.indexOf("router.get('/:clientId/material-rates/options', ");
  assert.ok(listIdx >= 0 && optionsIdx >= 0, 'GET routes not found');
  const listBlock = ROUTES.slice(listIdx, ROUTES.indexOf('\n});', listIdx));
  const optionsBlock = ROUTES.slice(optionsIdx, ROUTES.indexOf('\n});', optionsIdx));
  assert.doesNotMatch(listBlock, /requireClientEdit/, 'list is a read route — client view, not isClientEdit');
  assert.doesNotMatch(optionsBlock, /requireClientEdit/, 'options is a read route — client view, not isClientEdit');
  assert.match(listBlock, /loadAndGuardClient\(/);
  assert.match(optionsBlock, /loadAndGuardClient\(/);
});

// remove()/acceptMaster() themselves 404 on a (client_id, material_id) pair
// that isn't on that client's card — this is what keeps a materialId from
// reaching another client's rows even though it's the shared master id, not
// a client-owned row id. Exercised directly against the service (no HTTP
// layer needed — the route-level scope guard above proves the client_id half).
test('remove() 404s when the material is not on this client\'s card', async () => {
  scenario.removeGroupRow = null; // no row for this (client_id, material_id)
  await assert.rejects(ratesSvc.remove(1, 999), (e) => { assert.equal(e.status, 404); return true; });
});

// ─── 6. GET /:clientId/material-rates/download ────────────────────────────
//
// Full HTTP harness (same shape as tests/calls-preview-scope.test.js): a real
// express app mounting routes/admin/clients.js, a SEPARATE fake pool wired to
// client-material-rates.service#list()'s actual query shapes (different
// tables/joins than the resolver tests above), and a fetch client.
//
// Scoped in a describe() with its own before/after so the pool-swap happens
// at RUN time, after the resolver/validation tests above have already run
// against the module-top-level `fake` — installFakePool() monkeypatches the
// shared db.pool singleton, so calling it again at module-load time (as a
// second top-level installFakePool(...)) would clobber `fake` for every test
// in this file, resolver tests included, before any of them actually run.
describe('GET /:clientId/material-rates/download', () => {
  const CLIENT_ID = 55;
  const MATERIAL_ID = 501;
  const GROUP_ID = 9001;
  const ZONAL_ROLE = { role_id: 12, role_name: 'Zonal Field Team', role_status: 1, menu_ids: '' };
  const allowClients = (...ids) => ({
    clients: { mode: 'allow', ids }, cities: { mode: 'all', ids: [] },
    states: { mode: 'all', ids: [] }, verticals: { mode: 'all', ids: [] },
  });

  let downloadFake;
  let downloadServer;
  let downloadBaseUrl;
  let scopeForDownloadTest;

  before(async () => {
    downloadFake = installFakePool([
      [/FROM tbl_client\b/i, () => [{ client_id: CLIENT_ID, client_name: 'Acme Corp', vertical_id: 3 }]],
      // list(): client price groups (top-level FROM — never matches the
      // "..._brand gb" join below, which has no space before "_brand").
      [/FROM tbl_client_material_price_group g\b/i, () => [
        { group_id: GROUP_ID, material_id: MATERIAL_ID, price: 200, master_price_seen: 200, status: 1 },
      ]],
      [/FROM tbl_material_master/i, () => [{ material_id: MATERIAL_ID, material_name: 'PVC Pipe', pricing_type: 'per_unit' }]],
      // No brands on this group — "No Brand" in the export, and the group's
      // master-price lookup below takes the no-brand branch.
      [/FROM tbl_client_material_price_group_brand gb/i, () => []],
      [/FROM tbl_client_material_state_price\s+WHERE/i, () => [{ state_price_id: 701, group_id: GROUP_ID, price: 275 }]],
      [/FROM tbl_client_material_state_price_state/i, () => [
        { state_price_id: 701, state_id: 21 }, { state_price_id: 701, state_id: 22 },
      ]],
      // resolveMasterPriceForBrandSet's no-brand branch — 250 vs master_price_seen
      // 200 above is the review-flag fixture ("Master changed ₹200.00 → ₹250.00").
      [/FROM tbl_material_price_group g\b/i, () => [{ price: 250 }]],
      [/FROM tbl_material_price_group_brand gb/i, () => []],
      [/FROM tbl_state ORDER BY state_name/i, () => [
        { state_id: 21, state_name: 'Maharashtra' }, { state_id: 22, state_name: 'Gujarat' },
      ]],
    ]);

    const express = require('express');
    const clientsRouter = require('../routes/admin/clients');

    const app = express();
    app.use((req, _res, next) => {
      req.user = { user_id: 1, user_name: 'Tester' };
      req.userRole = { ...ZONAL_ROLE };
      if (scopeForDownloadTest !== 'absent') req.scope = scopeForDownloadTest;
      next();
    });
    app.use('/clients', clientsRouter);
    app.use((err, _req, res, _next) => { res.status(500).json({ success: false, error: String(err && err.message) }); });
    await new Promise((resolve) => { downloadServer = app.listen(0, resolve); });
    downloadBaseUrl = `http://127.0.0.1:${downloadServer.address().port}`;
  });

  after(async () => {
    downloadFake.restore();
    if (downloadServer) await new Promise((resolve) => downloadServer.close(resolve));
  });

  it('streams a flat Material|Brand|Price|Tx Share|State xlsx, one row per (material, brand, state)', async () => {
    scopeForDownloadTest = allowClients(CLIENT_ID);
    const res = await fetch(`${downloadBaseUrl}/clients/${CLIENT_ID}/material-rates/download`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    const ExcelJS = require('exceljs');
    const buf = Buffer.from(await res.arrayBuffer());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    // No Brand, base price 200, two overridden states at 275 → 1 base row + 2 state rows.
    assert.equal(ws.rowCount, 4, 'header row + base row + one row per overridden state');

    const header = ws.getRow(1).values.slice(1);
    assert.deepEqual(header, ['Material', 'Brand', 'Price', 'Tx Share', 'State']);

    // Neither fixture row sets tx_share — list() computes 20% of price
    // (2026-09-24 default): 200 x 0.2 = 40, 275 x 0.2 = 55.
    assert.deepEqual(ws.getRow(2).values.slice(1), ['PVC Pipe', '', 200, 40, '']);
    assert.deepEqual(ws.getRow(3).values.slice(1), ['PVC Pipe', '', 275, 55, 'Maharashtra']);
    assert.deepEqual(ws.getRow(4).values.slice(1), ['PVC Pipe', '', 275, 55, 'Gujarat']);
  });

  it('refuses a client outside the caller\'s scope, same as the list route', async () => {
    scopeForDownloadTest = allowClients(999); // NOT this client
    const [downloadRes, listRes] = await Promise.all([
      fetch(`${downloadBaseUrl}/clients/${CLIENT_ID}/material-rates/download`),
      fetch(`${downloadBaseUrl}/clients/${CLIENT_ID}/material-rates`),
    ]);
    assert.equal(downloadRes.status, 404);
    assert.equal(listRes.status, 404);
    const [downloadBody, listBody] = await Promise.all([downloadRes.json(), listRes.json()]);
    assert.deepEqual(downloadBody, listBody, 'download must refuse identically to the list route');
    assert.equal(downloadBody.error, 'client not found');
  });
});

// ─── 7. POST /:clientId/material-rates/batch (CRM "Add Materials" modal) ──
//
// Full HTTP harness, same recipe as the download describe block above: own
// fake pool, own express app, own before/after — installFakePool() clobbers
// the shared db.pool singleton, so this can't share the module-top-level
// `fake` (still in use by the resolver tests) or `downloadFake`.
describe('POST /:clientId/material-rates/batch', () => {
  const CLIENT_ID = 77;
  const ZONAL_ROLE = { role_id: 12, role_name: 'Zonal Field Team', role_status: 1, menu_ids: '' };
  const allowClients = (...ids) => ({
    clients: { mode: 'allow', ids }, cities: { mode: 'all', ids: [] },
    states: { mode: 'all', ids: [] }, verticals: { mode: 'all', ids: [] },
  });
  const groupsPayload = (price, extra = {}) => [{ price, brand_ids: [], states: [], ...extra }];

  let batchFake;
  let batchServer;
  let batchBaseUrl;
  let scopeForBatchTest;
  let committed;
  let rolledBack;
  let materialStatusById; // material_id -> 1 (active) | 0 (inactive) | undefined (missing)
  let insertedGroups; // captured params of every INSERT INTO tbl_client_material_price_group

  before(async () => {
    materialStatusById = new Map([[301, 1], [302, 1]]);
    batchFake = installFakePool([
      [/FROM tbl_client\b/i, () => [{ client_id: CLIENT_ID, client_name: 'Acme', vertical_id: 3 }]],
      // replace()'s getMaterialRow (material.service.js#getMaterialRow).
      [/FROM tbl_material_master m\s+LEFT JOIN tbl_service_catg/i, (sql, params) => {
        const status = materialStatusById.get(params[0]);
        return status === undefined ? [] : [{ material_id: params[0], status, pricing_type: 'FIXED' }];
      }],
      // assertBrandsAndStatesExist — fixtures below use No Brand + no states, so
      // these never actually fire; kept so an unexpected call fails loudly
      // (empty result) rather than hanging on an unmatched query.
      [/FROM tbl_brand_master/i, () => []],
      [/FROM tbl_state\b/i, () => []],
      // resolveMasterPriceForBrandSet — No Brand branch (brandIds is empty).
      [/FROM tbl_material_price_group g\b/i, () => []],
      [/^\s*INSERT INTO tbl_client_material_price_group\b/i, (sql, params) => {
        insertedGroups.push(params); // [client_id, material_id, price, tx_share, master_price_seen, ...]
        return { insertId: 9001 };
      }],
    ]);

    const db = require('../db');
    const origGetConnection = db.pool.getConnection;
    db.pool.getConnection = async () => {
      const conn = await origGetConnection.call(db.pool);
      const origCommit = conn.commit, origRollback = conn.rollback;
      conn.commit = async (...a) => { committed = true; return origCommit(...a); };
      conn.rollback = async (...a) => { rolledBack = true; return origRollback(...a); };
      return conn;
    };

    const express = require('express');
    const clientsRouter = require('../routes/admin/clients');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { user_id: 1, user_name: 'Tester', permissions: { menuIds: [], actionPermissions: ['isClientEdit'] } };
      req.userRole = { ...ZONAL_ROLE };
      if (scopeForBatchTest !== 'absent') req.scope = scopeForBatchTest;
      next();
    });
    app.use('/clients', clientsRouter);
    app.use((err, _req, res, _next) => { res.status(500).json({ success: false, error: String(err && err.message) }); });
    await new Promise((resolve) => { batchServer = app.listen(0, resolve); });
    batchBaseUrl = `http://127.0.0.1:${batchServer.address().port}`;
  });

  after(async () => {
    batchFake.restore();
    if (batchServer) await new Promise((resolve) => batchServer.close(resolve));
  });

  beforeEach(() => {
    batchFake.reset();
    committed = false;
    rolledBack = false;
    insertedGroups = [];
    materialStatusById.set(301, 1);
    materialStatusById.set(302, 1);
    scopeForBatchTest = allowClients(CLIENT_ID);
  });

  function postBatch(materials) {
    return fetch(`${batchBaseUrl}/clients/${CLIENT_ID}/material-rates/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ materials }),
    });
  }

  it('writes both materials in one transaction when both are valid', async () => {
    const res = await postBatch([
      { material_id: 301, groups: groupsPayload(100) },
      { material_id: 302, groups: groupsPayload(200) },
    ]);
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.deepEqual(body.data.material_ids, [301, 302]);
    assert.equal(committed, true);
    assert.equal(rolledBack, false);
  });

  it('all-or-nothing: material 302 missing rolls back material 301\'s already-attempted write', async () => {
    materialStatusById.delete(302); // 302 no longer exists → replace() 404s mid-transaction
    const res = await postBatch([
      { material_id: 301, groups: groupsPayload(100) },
      { material_id: 302, groups: groupsPayload(200) },
    ]);
    const body = await res.json();
    assert.equal(res.status, 422, JSON.stringify(body));
    assert.match(body.error, /302/, 'the error must name the failing material');
    assert.ok(batchFake.calls.some((c) => /^\s*INSERT INTO tbl_client_material_price_group\b/i.test(c.sql)),
      'material 301\'s write must have been attempted before material 302\'s failure');
    assert.equal(committed, false, 'commit must never be called when a later material fails');
    assert.equal(rolledBack, true, 'rollback must undo material 301\'s already-attempted write');
  });

  it('refuses duplicate material_id within the batch before opening a connection', async () => {
    const res = await postBatch([
      { material_id: 301, groups: groupsPayload(100) },
      { material_id: 301, groups: groupsPayload(200) },
    ]);
    const body = await res.json();
    assert.equal(res.status, 422, JSON.stringify(body));
    assert.match(body.error, /301/);
    assert.ok(!batchFake.calls.some((c) => /^\s*INSERT INTO/i.test(c.sql)),
      'a duplicate-refused batch must write nothing');
    assert.equal(committed, false);
    assert.equal(rolledBack, false, 'refused before a connection was ever opened');
  });

  // ─── Tx Share (2026-09-24) ────────────────────────────────────────────

  it('replace(): tx_share defaults to 20% of price when omitted', async () => {
    const res = await postBatch([{ material_id: 301, groups: groupsPayload(250) }]);
    assert.equal(res.status, 200, JSON.stringify(await res.json()));
    assert.equal(insertedGroups.length, 1);
    assert.equal(insertedGroups[0][3], 50, 'tx_share must be 20% of price (250 x 0.2), rounded to 2dp');
  });

  it('replace(): an explicit tx_share is kept as given, not overwritten by the 20% default', async () => {
    const res = await postBatch([{ material_id: 301, groups: groupsPayload(250, { tx_share: 37.5 }) }]);
    assert.equal(res.status, 200, JSON.stringify(await res.json()));
    assert.equal(insertedGroups[0][3], 37.5);
  });

  it('refuses a client outside the caller\'s scope, same as the other material-rates routes', async () => {
    scopeForBatchTest = allowClients(999); // NOT this client
    const res = await postBatch([{ material_id: 301, groups: groupsPayload(100) }]);
    const body = await res.json();
    assert.equal(res.status, 404, JSON.stringify(body));
    assert.equal(body.error, 'client not found');
  });

  it('requires isClientEdit and is client-scope-guarded (static route gate)', () => {
    const block = routeBlock("'/:clientId/material-rates/batch'");
    assert.match(block, /requireClientEdit/, 'batch route must require isClientEdit');
    assert.match(block, /loadAndGuardClient\(/, 'batch route must run the client scope-guard');
  });
});

// ─── 8. GET /:clientId/material-rates/master-rows (2026-09-24) ────────────
// Master-catalog rows for the CRM's Add-Material picker — one item per
// active material x active brand; a No-Brand group (or a group whose
// brands are all now inactive) never gets fabricated a phantom brand.
describe('GET /:clientId/material-rates/master-rows', () => {
  const CLIENT_ID = 44;
  const ZONAL_ROLE = { role_id: 12, role_name: 'Zonal Field Team', role_status: 1, menu_ids: '' };
  const allowClients = (...ids) => ({
    clients: { mode: 'allow', ids }, cities: { mode: 'all', ids: [] },
    states: { mode: 'all', ids: [] }, verticals: { mode: 'all', ids: [] },
  });

  let masterRowsFake;
  let masterRowsServer;
  let masterRowsBaseUrl;
  let scopeForMasterRowsTest;

  before(async () => {
    masterRowsFake = installFakePool([
      [/FROM tbl_client\b/i, () => [{ client_id: CLIENT_ID, client_name: 'Acme', vertical_id: 3 }]],
      [/FROM tbl_material_price_group g\s+JOIN tbl_material_master m/i, () => [
        { group_id: 1, material_id: 10, price: 100, material_name: 'Adapter 5A' },   // branded, one active + one inactive brand
        { group_id: 2, material_id: 11, price: 50,  material_name: 'Cement Bag' },   // true No Brand
        { group_id: 3, material_id: 12, price: 75,  material_name: 'Discontinued Fitting' }, // all its brands are inactive
      ]],
      [/FROM tbl_material_price_group_brand gb\s+JOIN tbl_brand_master bm/i, () => [
        { group_id: 1, brand_id: 100, brand_name: 'Philips', brand_status: 1 },
        { group_id: 1, brand_id: 101, brand_name: 'RetiredBrand', brand_status: 0 },
        { group_id: 3, brand_id: 102, brand_name: 'AlsoRetired', brand_status: 0 },
      ]],
      [/FROM tbl_material_state_price sp\s+JOIN tbl_material_state_price_state/i, () => []],
    ]);

    const express = require('express');
    const clientsRouter = require('../routes/admin/clients');
    const app = express();
    app.use((req, _res, next) => {
      req.user = { user_id: 1, user_name: 'Tester' };
      req.userRole = { ...ZONAL_ROLE };
      if (scopeForMasterRowsTest !== 'absent') req.scope = scopeForMasterRowsTest;
      next();
    });
    app.use('/clients', clientsRouter);
    app.use((err, _req, res, _next) => { res.status(500).json({ success: false, error: String(err && err.message) }); });
    await new Promise((resolve) => { masterRowsServer = app.listen(0, resolve); });
    masterRowsBaseUrl = `http://127.0.0.1:${masterRowsServer.address().port}`;
  });

  after(async () => {
    masterRowsFake.restore();
    if (masterRowsServer) await new Promise((resolve) => masterRowsServer.close(resolve));
  });

  beforeEach(() => {
    masterRowsFake.reset();
    scopeForMasterRowsTest = allowClients(CLIENT_ID);
  });

  it('one item per active brand, one item for a true No-Brand group, and NOTHING for a group whose brands are all inactive', async () => {
    const res = await fetch(`${masterRowsBaseUrl}/clients/${CLIENT_ID}/material-rates/master-rows`);
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    const items = body.data.items;
    assert.deepEqual(
      items.map((i) => ({ material_id: i.material_id, brand_id: i.brand_id, label: i.label })),
      [
        { material_id: 10, brand_id: 100, label: 'Adapter 5A - Philips' },
        { material_id: 11, brand_id: null, label: 'Cement Bag' },
      ],
      'RetiredBrand (inactive) must not appear, and material 12 (all brands inactive) must contribute NOTHING — not a phantom No-Brand row',
    );
  });

  it('is a client-view GET (no isClientEdit gate) and is client-scope-guarded', () => {
    const idx = ROUTES.indexOf("router.get('/:clientId/material-rates/master-rows', ");
    assert.ok(idx >= 0, 'master-rows route not found');
    const block = ROUTES.slice(idx, ROUTES.indexOf('\n});', idx));
    assert.doesNotMatch(block, /requireClientEdit/, 'a read route must not require isClientEdit');
    assert.match(block, /loadAndGuardClient\(/, 'must run the client scope-guard');
  });

  it('refuses a client outside the caller\'s scope', async () => {
    scopeForMasterRowsTest = allowClients(999);
    const res = await fetch(`${masterRowsBaseUrl}/clients/${CLIENT_ID}/material-rates/master-rows`);
    assert.equal(res.status, 404);
  });
});
