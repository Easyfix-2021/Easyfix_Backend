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
const { test, beforeEach } = require('node:test');
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
  assert.deepEqual(out, { price: 150, source: 'client_state', groupId: 1 });
});

test('resolver: client_group wins when the client has a brand price but no matching state price', async () => {
  scenario.clientGroupBranded = { group_id: 1, price: 100 };
  scenario.clientStatePrice = null;
  const out = await resolveMaterialPrice({ clientId: 1, materialId: 2, brandId: 3, stateId: 4 });
  assert.deepEqual(out, { price: 100, source: 'client_group', groupId: 1 });
});

test('resolver: master_state wins when there is no client override but the master has a state price', async () => {
  scenario.masterGroupBranded = { group_id: 9, price: 80 };
  scenario.masterStatePrice = { price: 95 };
  const out = await resolveMaterialPrice({ clientId: 1, materialId: 2, brandId: 3, stateId: 4 });
  assert.deepEqual(out, { price: 95, source: 'master_state', groupId: 9 });
});

test('resolver: master_group wins when there is no client override and no master state price', async () => {
  scenario.masterGroupBranded = { group_id: 9, price: 80 };
  scenario.masterStatePrice = null;
  const out = await resolveMaterialPrice({ clientId: 1, materialId: 2, brandId: 3, stateId: 4 });
  assert.deepEqual(out, { price: 80, source: 'master_group', groupId: 9 });
});

test('resolver: none when nothing prices the material anywhere (phase-1 Price Pending)', async () => {
  const out = await resolveMaterialPrice({ clientId: 1, materialId: 2, brandId: 3, stateId: 4 });
  assert.deepEqual(out, { price: null, source: 'none', groupId: null });
});

test('resolver: none when the master group exists but its price is NULL (Price Pending) and no state override', async () => {
  scenario.masterGroupBranded = { group_id: 9, price: null };
  const out = await resolveMaterialPrice({ clientId: 1, materialId: 2, brandId: 3, stateId: 4 });
  assert.deepEqual(out, { price: null, source: 'none', groupId: null });
});

// ─── Rule: a missing stateId skips steps 1 and 3 ──────────────────────────

test('resolver rule: missing stateId skips the client_state lookup entirely', async () => {
  scenario.clientGroupBranded = { group_id: 1, price: 100 };
  scenario.clientStatePrice = { price: 999 }; // would win if the rule were violated
  const out = await resolveMaterialPrice({ clientId: 1, materialId: 2, brandId: 3 }); // no stateId
  assert.deepEqual(out, { price: 100, source: 'client_group', groupId: 1 });
  assert.ok(!fake.calls.some((c) => /FROM tbl_client_material_state_price sp/i.test(c.sql)),
    'no stateId means the client-state query must never run');
});

test('resolver rule: missing stateId skips the master_state lookup entirely', async () => {
  scenario.masterGroupBranded = { group_id: 9, price: 80 };
  scenario.masterStatePrice = { price: 999 }; // would win if the rule were violated
  const out = await resolveMaterialPrice({ clientId: 1, materialId: 2, brandId: 3 }); // no stateId
  assert.deepEqual(out, { price: 80, source: 'master_group', groupId: 9 });
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
  assert.deepEqual(out, { price: 100, source: 'client_group', groupId: 1 });
  assert.ok(!fake.calls.some((c) => /FROM tbl_material_price_group_brand gb/i.test(c.sql)),
    'once a client group is found, master tables must never be queried');
  assert.ok(!fake.calls.some((c) => /FROM tbl_material_state_price sp/i.test(c.sql)),
    'once a client group is found, the master state price must never be queried');
});

// ─── Rule: a missing brandId (No Brand) resolves against the sole group ───

test('resolver rule: missing brandId resolves against the client\'s sole No Brand group', async () => {
  scenario.clientGroupNoBrand = { group_id: 5, price: 60 };
  const out = await resolveMaterialPrice({ clientId: 1, materialId: 2 }); // no brandId
  assert.deepEqual(out, { price: 60, source: 'client_group', groupId: 5 });
});

test('resolver rule: missing brandId falls to the master\'s sole No Brand group with no client override', async () => {
  scenario.masterGroupNoBrand = { group_id: 11, price: 40 };
  const out = await resolveMaterialPrice({ clientId: 1, materialId: 2 }); // no brandId
  assert.deepEqual(out, { price: 40, source: 'master_group', groupId: 11 });
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
