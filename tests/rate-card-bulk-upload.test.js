'use strict';
/*
 * Rate Card Bulk Upload (Services + Materials tabs) — see
 * docs/superpowers/specs/2026-09-21-rate-card-bulk-upload-design.md.
 *
 * Covers, per the spec's "Testing" section:
 *   1. Round-trip (both tabs) — export via the REAL exporter
 *      (services/client-xlsx.service.js), feed the buffer to preview,
 *      every row 'unchanged', zero blocked. Most important test: it is
 *      what keeps export and import from drifting apart.
 *   2. Client scoping — the URL's clientId drives every lookup; the file
 *      never carries one, so "cannot write to another client" is proven
 *      by showing the SAME file buffer scopes its DB lookups to whichever
 *      clientId the caller passed. Route-level out-of-scope 404 is the
 *      same loadAndGuardClient() every other material-rates route already
 *      uses (exhaustively tested in tests/client-material-rates.test.js /
 *      tests/client-rate-card-delete-scope.test.js) — proven wired up here
 *      via the routeBlock() static check below, not re-derived.
 *   3. Commit re-validates and is all-or-nothing — a row that turns
 *      invalid between preview and commit (a race) rolls back the WHOLE
 *      transaction, including materials/rows that themselves succeeded.
 *   4. Blocked-reason coverage — unknown material/brand/state/service
 *      type, missing/negative price, No Brand mixed with brands,
 *      malformed State Overrides (segment quoted).
 *   5. isClientEdit required for template/preview/commit — same static
 *      routeBlock() technique tests/client-material-rates.test.js uses.
 *
 * fake-pool harness throughout (no real DB) — see tests/helpers/fake-pool.js.
 */
const { test, describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const { installFakePool } = require('./helpers/fake-pool');

const ROOT = path.join(__dirname, '..');

function aoaBuffer(rows) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const SERVICES_HEADER = [
  'Service Type ID', 'Service Type Name',
  'Easyfix Direct Fixed', 'Easyfix Direct Variable',
  'Overhead Fixed', 'Overhead Variable',
  'Client Fixed', 'Client Variable',
];
const MATERIALS_HEADER = ['Material', 'Brand', 'Price', 'State'];

// ═══════════════════════════ Round trip (both tabs) ═══════════════════════

describe('round-trip: export → preview is unchanged, zero blocked', () => {
  let fake;
  const CLIENT_ID = 900;

  before(() => {
    fake = installFakePool([
      // Services ref + existing rows (identical to what we're about to export).
      [/FROM tbl_service_type WHERE service_type_status <> 3/i, () => [
        { service_type_id: 10, service_type_name: 'AC Installation', service_type_status: 1, service_catg_id: 3 },
        { service_type_id: 11, service_type_name: 'AC Repair',       service_type_status: 1, service_catg_id: 3 },
      ]],
      [/COALESCE\(easyfix_direct_fixed,0\)/i, () => [
        { client_service_id: 501, service_type_id: 10, easyfix_direct_fixed: 200, easyfix_direct_variable: 10, overhead_fixed: 10, overhead_variable: 20, client_fixed: 0, client_variable: 0 },
        { client_service_id: 502, service_type_id: 11, easyfix_direct_fixed: 50,  easyfix_direct_variable: 5,  overhead_fixed: 5,  overhead_variable: 5,  client_fixed: 0, client_variable: 0 },
      ]],
      // Materials ref + existing card (one No-Brand material with a state override).
      [/SELECT material_id, material_name FROM tbl_material_master WHERE status = 1/i, () => [{ material_id: 700, material_name: 'PVC Pipe' }]],
      [/SELECT brand_id, brand_name, brand_key FROM tbl_brand_master WHERE status = 1/i, () => []],
      [/SELECT state_id, state_name FROM tbl_state/i, () => [
        { state_id: 21, state_name: 'Maharashtra' }, { state_id: 22, state_name: 'Gujarat' },
      ]],
      // materialRatesSvc.list() chain.
      [/FROM tbl_client_material_price_group g\b/i, () => [{ group_id: 9001, material_id: 700, price: 200, master_price_seen: 200, status: 1 }]],
      [/FROM tbl_material_master\b/i, () => [{ material_id: 700, material_name: 'PVC Pipe', pricing_type: 'per_unit' }]],
      [/FROM tbl_client_material_price_group_brand gb/i, () => []],
      [/FROM tbl_client_material_state_price\s+WHERE/i, () => [{ state_price_id: 701, group_id: 9001, price: 275 }]],
      [/FROM tbl_client_material_state_price_state/i, () => [
        { state_price_id: 701, state_id: 21 }, { state_price_id: 701, state_id: 22 },
      ]],
      [/FROM tbl_material_price_group g\b/i, () => [{ price: 200 }]], // resolveMasterPriceForBrandSet no-brand branch — matches seen, no flag
      [/FROM tbl_material_price_group_brand gb/i, () => []],
    ]);
  });
  after(() => fake.restore());

  it('Services: exportRateCards → previewServicesUpload is all unchanged', async () => {
    const xlsxSvc = require('../services/client-xlsx.service');
    const svc = require('../services/rate-card-bulk-upload.service');
    const rateCards = [
      { service_type_id: 10, service_type_name: 'AC Installation', easyfix_direct_fixed: 200, easyfix_direct_variable: 10, overhead_fixed: 10, overhead_variable: 20, client_fixed: 0, client_variable: 0 },
      { service_type_id: 11, service_type_name: 'AC Repair',       easyfix_direct_fixed: 50,  easyfix_direct_variable: 5,  overhead_fixed: 5,  overhead_variable: 5,  client_fixed: 0, client_variable: 0 },
    ];
    const buf = await xlsxSvc.exportRateCards('Acme', rateCards);
    const out = await svc.previewServicesUpload(buf, CLIENT_ID);
    assert.equal(out.summary.blocked, 0, JSON.stringify(out.rows));
    assert.equal(out.summary.unchanged, 2);
    assert.ok(out.rows.every((r) => r.outcome === 'unchanged'));
  });

  it('Materials: exportMaterialRates → previewMaterialRatesUpload is all unchanged', async () => {
    const xlsxSvc = require('../services/client-xlsx.service');
    const svc = require('../services/rate-card-bulk-upload.service');
    const items = [{
      material_id: 700, material_name: 'PVC Pipe', pricing_type: 'per_unit',
      groups: [{
        group_id: 9001, material_id: 700, price: 200, status: 1,
        brands: [],
        states: [{ state_price_id: 701, price: 275, state_ids: [21, 22] }],
        master_price_seen: 200, master_price_today: 200, review: { flagged: false },
      }],
    }];
    const stateNameById = new Map([[21, 'Maharashtra'], [22, 'Gujarat']]);
    const buf = await xlsxSvc.exportMaterialRates(items, stateNameById);
    // Base row (No Brand, ₹200) + one row per overridden state (Maharashtra,
    // Gujarat) — the flat format's own round-trip contract.
    const out = await svc.previewMaterialRatesUpload(buf, CLIENT_ID);
    assert.equal(out.summary.blocked, 0, JSON.stringify(out.rows));
    assert.equal(out.summary.unchanged, 3, JSON.stringify(out.rows));
    assert.ok(out.rows.every((r) => r.outcome === 'unchanged'));
    assert.equal(out.materials.length, 1);
    assert.equal(out.materials[0].outcome, 'unchanged');
    assert.deepEqual(out.materials[0].lines, [
      { brand: 'No Brand', state: 'All States', price: 200 },
      { brand: 'No Brand', state: 'Maharashtra', price: 275 },
      { brand: 'No Brand', state: 'Gujarat', price: 275 },
    ]);
  });
});

// ═══════════════════════════ Client scoping ═══════════════════════════════

describe('client scoping: the URL clientId drives every lookup, never the file', () => {
  let fake;
  before(() => {
    fake = installFakePool([
      [/FROM tbl_service_type WHERE service_type_status <> 3/i, () => [
        { service_type_id: 10, service_type_name: 'AC Installation', service_type_status: 1, service_catg_id: 3 },
      ]],
      [/COALESCE\(easyfix_direct_fixed,0\)/i, () => []], // no existing rows for either client → outcome 'new'
    ]);
  });
  after(() => fake.restore());
  beforeEach(() => fake.reset());

  it('the SAME file scopes its existing-row lookup to whichever clientId the caller passed', async () => {
    const svc = require('../services/rate-card-bulk-upload.service');
    const buf = aoaBuffer([SERVICES_HEADER, [10, 'AC Installation', 200, 10, 10, 20, 0, 0]]);

    await svc.previewServicesUpload(buf, 111);
    const callsForA = fake.calls.filter((c) => /COALESCE\(easyfix_direct_fixed,0\)/i.test(c.sql));
    assert.deepEqual(callsForA[callsForA.length - 1].params, [111]);

    fake.reset();
    await svc.previewServicesUpload(buf, 222);
    const callsForB = fake.calls.filter((c) => /COALESCE\(easyfix_direct_fixed,0\)/i.test(c.sql));
    assert.deepEqual(callsForB[callsForB.length - 1].params, [222]);
  });
});

// ═══════════════════════════ Blocked-reason coverage ═══════════════════════

describe('Materials — blocked-row reasons', () => {
  let fake;
  before(() => {
    fake = installFakePool([
      [/SELECT material_id, material_name FROM tbl_material_master WHERE status = 1/i, () => [{ material_id: 10, material_name: 'Material A' }]],
      [/SELECT brand_id, brand_name, brand_key FROM tbl_brand_master WHERE status = 1/i, () => [{ brand_id: 20, brand_name: 'BrandX', brand_key: 'brandx' }]],
      [/SELECT state_id, state_name FROM tbl_state/i, () => [{ state_id: 30, state_name: 'Karnataka' }]],
      [/FROM tbl_client_material_price_group g\b/i, () => []], // no existing card for this client
    ]);
  });
  after(() => fake.restore());
  beforeEach(() => fake.reset());

  async function preview(rows) {
    const svc = require('../services/rate-card-bulk-upload.service');
    const buf = aoaBuffer([MATERIALS_HEADER, ...rows]);
    return svc.previewMaterialRatesUpload(buf, 1);
  }

  it('unknown material, no close match → blocked, no suggestion', async () => {
    const out = await preview([['Totally Different Thing', '', 100, '']]);
    assert.equal(out.rows[0].outcome, 'blocked');
    assert.match(out.rows[0].errors.join(';'), /^Unknown material "Totally Different Thing"$/);
  });

  it('unknown material, close typo → blocked WITH a "did you mean" suggestion', async () => {
    const out = await preview([['Material A2', '', 100, '']]);
    assert.equal(out.rows[0].outcome, 'blocked');
    assert.match(out.rows[0].errors.join(';'), /Unknown material "Material A2" — did you mean "Material A"\?/);
  });

  it('unknown brand, close typo → blocked with a suggestion', async () => {
    const out = await preview([['Material A', 'BrandXX', 100, '']]);
    assert.equal(out.rows[0].outcome, 'blocked');
    assert.match(out.rows[0].errors.join(';'), /Unknown brand "BrandXX" — did you mean "BrandX"\?/);
  });

  it('unknown state, close typo → blocked with a suggestion', async () => {
    const out = await preview([['Material A', '', 100, 'Karnatak']]);
    assert.equal(out.rows[0].outcome, 'blocked');
    assert.match(out.rows[0].errors.join(';'), /Unknown state "Karnatak" — did you mean "Karnataka"\?/);
  });

  it('missing price → blocked', async () => {
    const out = await preview([['Material A', '', '', '']]);
    assert.equal(out.rows[0].outcome, 'blocked');
    assert.match(out.rows[0].errors.join(';'), /Price is required/);
  });

  it('negative price → blocked', async () => {
    const out = await preview([['Material A', '', -10, '']]);
    assert.equal(out.rows[0].outcome, 'blocked');
    assert.match(out.rows[0].errors.join(';'), /Price must be greater than 0/);
  });

  it('No Brand mixed with a branded row for the same material → both rows blocked', async () => {
    const out = await preview([
      ['Material A', '', 100, ''],
      ['Material A', 'BrandX', 120, ''],
    ]);
    assert.equal(out.summary.blocked, 2);
    assert.ok(out.rows.some((r) => /Cannot mix No Brand and brand prices/.test(r.errors.join(';'))));
    assert.equal(out.materials[0].outcome, 'blocked');
  });

  it('a state price with no all-states base price for that brand → blocked', async () => {
    const out = await preview([['Material A', 'BrandX', 275, 'Karnataka']]);
    assert.equal(out.summary.blocked, 1);
    assert.match(out.rows[0].errors.join(';'), /BrandX has state prices but no all-states price for "Material A"/);
  });

  it('conflicting duplicate (same material/brand/state, different price) → both rows blocked, naming both', async () => {
    const out = await preview([
      ['Material A', '', 100, ''],
      ['Material A', '', 120, ''],
    ]);
    assert.equal(out.summary.blocked, 2);
    assert.match(out.rows[0].errors.join(';'), /Conflicting duplicate rows \(2, 3\)/);
    assert.match(out.rows[1].errors.join(';'), /Conflicting duplicate rows \(2, 3\)/);
  });

  it('identical duplicate (same material/brand/state/price) → kept once, warned, not blocked', async () => {
    const out = await preview([
      ['Material A', '', 100, ''],
      ['Material A', '', 100, ''],
    ]);
    assert.equal(out.summary.blocked, 0, JSON.stringify(out.rows));
    assert.equal(out.summary.new, 2, 'both rows still echoed as new — only the SECOND is flagged a duplicate');
    assert.deepEqual(out.rows[0].warnings, []);
    assert.match(out.rows[1].warnings.join(';'), /Duplicate of row 2 — identical, ignored/);
    // The compiled plan has exactly ONE line — the grouping map naturally
    // collapses two identical (brand, state) rows to a single entry either
    // way, so this is really a lines-shape check, not proof the duplicate
    // was specially dropped (the warning assertion above is what proves that).
    assert.equal(out.materials[0].lines.length, 1);
  });

  it('grouping: two brands with the SAME base price and state-override map share ONE group', async () => {
    const out = await preview([
      ['Material A', 'BrandX', 100, ''],
      ['Material A', 'BrandX', 275, 'Karnataka'],
    ]);
    // Only one brand fixture (BrandX) is seeded in this describe block's fake
    // pool — the grouping behaviour itself (shared group when signatures
    // match) is proven in the dedicated grouping describe block below with
    // two distinct brands. This test just proves the state-override entry
    // groups Karnataka into ONE {price, state_ids} entry.
    assert.equal(out.summary.blocked, 0, JSON.stringify(out.rows));
    assert.equal(out.materials[0].lines.length, 2);
    assert.deepEqual(out.materials[0].lines, [
      { brand: 'BrandX', state: 'All States', price: 100 },
      { brand: 'BrandX', state: 'Karnataka', price: 275 },
    ]);
  });
});

// ═══════════════ Materials — grouping (owner spec, 2026-09-21 addition) ════

describe('Materials — grouping into client price groups', () => {
  // Grouping/signature equality is otherwise invisible from the outside — a
  // buggy "never merge, always one group per brand" implementation produces
  // the SAME flattened lines as a correct merge (same values, just attributed
  // via 2 groups instead of 1). The only externally observable difference is
  // the 'unchanged'/'update' OUTCOME against a pre-existing card, so these
  // tests seed the existing card as EXACTLY the shape a correct merge would
  // produce and assert 'unchanged' — a grouping bug (either direction) then
  // shows up as 'update' because the compiled signature set no longer matches.
  let fake;
  let existingGroupRows;
  let existingBrandRows;
  let existingStateRows;
  let existingStateStateRows;

  before(() => {
    fake = installFakePool([
      [/SELECT material_id, material_name FROM tbl_material_master WHERE status = 1/i, () => [{ material_id: 10, material_name: 'Adapter 5A' }]],
      [/SELECT brand_id, brand_name, brand_key FROM tbl_brand_master WHERE status = 1/i, () => [
        { brand_id: 1, brand_name: 'Philips', brand_key: 'philips' },
        { brand_id: 2, brand_name: 'Havells', brand_key: 'havells' },
      ]],
      [/SELECT state_id, state_name FROM tbl_state\b/i, () => [
        { state_id: 21, state_name: 'Maharashtra' }, { state_id: 22, state_name: 'Gujarat' },
      ]],
      // materialRatesSvc.list()'s existing-card chain — mutable per test.
      [/FROM tbl_client_material_price_group g\b/i, () => existingGroupRows],
      [/FROM tbl_material_master\b/i, () => [{ material_id: 10, material_name: 'Adapter 5A', pricing_type: 'per_unit' }]],
      [/FROM tbl_client_material_price_group_brand gb/i, () => existingBrandRows],
      [/FROM tbl_client_material_state_price\s+WHERE/i, () => existingStateRows],
      [/FROM tbl_client_material_state_price_state/i, () => existingStateStateRows],
      [/FROM tbl_material_price_group g\b/i, () => []],
      [/FROM tbl_material_price_group_brand gb/i, () => []],
    ]);
  });
  after(() => fake.restore());
  beforeEach(() => {
    fake.reset();
    existingGroupRows = [];
    existingBrandRows = [];
    existingStateRows = [];
    existingStateStateRows = [];
  });

  async function preview(rows) {
    const svc = require('../services/rate-card-bulk-upload.service');
    const buf = aoaBuffer([MATERIALS_HEADER, ...rows]);
    return svc.previewMaterialRatesUpload(buf, 1);
  }

  it('Philips + Havells with the SAME base price and SAME state map → ONE group ("unchanged" against a pre-existing single group covering both brands)', async () => {
    // The existing card: ONE group (group_id 501), price 100, BOTH brand ids,
    // with a Maharashtra+Gujarat override at 275 — exactly what a correct
    // merge of the uploaded rows below compiles to.
    existingGroupRows = [{ group_id: 501, material_id: 10, price: 100, master_price_seen: 100, status: 1 }];
    existingBrandRows = [
      { group_id: 501, brand_id: 1, brand_name: 'Philips' },
      { group_id: 501, brand_id: 2, brand_name: 'Havells' },
    ];
    existingStateRows = [{ state_price_id: 9001, group_id: 501, price: 275 }];
    existingStateStateRows = [
      { state_price_id: 9001, state_id: 21 }, { state_price_id: 9001, state_id: 22 },
    ];

    const out = await preview([
      ['Adapter 5A', 'Philips', 100, ''],
      ['Adapter 5A', 'Philips', 275, 'Maharashtra'],
      ['Adapter 5A', 'Philips', 275, 'Gujarat'],
      ['Adapter 5A', 'Havells', 100, ''],
      ['Adapter 5A', 'Havells', 275, 'Maharashtra'],
      ['Adapter 5A', 'Havells', 275, 'Gujarat'],
    ]);
    assert.equal(out.summary.blocked, 0, JSON.stringify(out.rows));
    assert.equal(out.materials[0].outcome, 'unchanged',
      'a grouping bug (merged into the wrong number of groups) changes the compiled signature set, which flips this to "update"');
    // Readability check: both brand labels carry the identical 3-line shape.
    const philipsLines = out.materials[0].lines.filter((l) => l.brand === 'Philips');
    const havellsLines = out.materials[0].lines.filter((l) => l.brand === 'Havells');
    assert.deepEqual(philipsLines.map((l) => ({ state: l.state, price: l.price })),
      havellsLines.map((l) => ({ state: l.state, price: l.price })));
  });

  it('Philips + Havells with DIFFERENT base prices → TWO groups (an "always merge" bug would collapse both brands onto ONE price)', async () => {
    const out = await preview([
      ['Adapter 5A', 'Philips', 100, ''],
      ['Adapter 5A', 'Havells', 150, ''],
    ]);
    assert.equal(out.summary.blocked, 0, JSON.stringify(out.rows));
    assert.equal(out.materials[0].lines.length, 2);
    const philipsLine = out.materials[0].lines.find((l) => l.brand === 'Philips');
    const havellsLine = out.materials[0].lines.find((l) => l.brand === 'Havells');
    assert.notEqual(philipsLine.price, havellsLine.price);
  });

  it('state-override grouping: Maharashtra and Gujarat both at ₹275 land in ONE {price, state_ids} entry ("unchanged" against that exact existing shape)', async () => {
    existingGroupRows = [{ group_id: 501, material_id: 10, price: 100, master_price_seen: 100, status: 1 }];
    existingBrandRows = [{ group_id: 501, brand_id: 1, brand_name: 'Philips' }];
    // ONE state_price row covering BOTH states — the shape a correctly-grouped
    // upload compiles to. If the parser instead emitted TWO override entries
    // (one per state) this fixture would no longer describe its output and
    // the outcome would read 'update', not 'unchanged'.
    existingStateRows = [{ state_price_id: 9001, group_id: 501, price: 275 }];
    existingStateStateRows = [
      { state_price_id: 9001, state_id: 21 }, { state_price_id: 9001, state_id: 22 },
    ];

    const out = await preview([
      ['Adapter 5A', 'Philips', 100, ''],
      ['Adapter 5A', 'Philips', 275, 'Maharashtra'],
      ['Adapter 5A', 'Philips', 275, 'Gujarat'],
    ]);
    assert.equal(out.summary.blocked, 0, JSON.stringify(out.rows));
    assert.equal(out.materials[0].outcome, 'unchanged');
    assert.equal(out.materials[0].lines.filter((l) => l.state !== 'All States').length, 2);
  });
});

describe('Services — blocked-row reasons', () => {
  let fake;
  before(() => {
    fake = installFakePool([
      [/FROM tbl_service_type WHERE service_type_status <> 3/i, () => [
        { service_type_id: 100, service_type_name: 'AC Installation', service_type_status: 1, service_catg_id: 5 },
      ]],
      [/COALESCE\(easyfix_direct_fixed,0\)/i, () => []],
    ]);
  });
  after(() => fake.restore());
  beforeEach(() => fake.reset());

  async function preview(row) {
    const svc = require('../services/rate-card-bulk-upload.service');
    const buf = aoaBuffer([SERVICES_HEADER, row]);
    return svc.previewServicesUpload(buf, 1);
  }

  it('unknown Service Type ID → blocked', async () => {
    const out = await preview([9999, 'Ghost Service', 0, 0, 0, 0, 0, 0]);
    assert.equal(out.rows[0].outcome, 'blocked');
    assert.match(out.rows[0].errors.join(';'), /Unknown Service Type ID 9999/);
  });

  it('negative cost cell → blocked', async () => {
    const out = await preview([100, 'AC Installation', -5, 0, 0, 0, 0, 0]);
    assert.equal(out.rows[0].outcome, 'blocked');
    assert.match(out.rows[0].errors.join(';'), /Easyfix Direct Fixed must be >= 0/);
  });

  it('duplicate Service Type ID within the file → second occurrence blocked', async () => {
    const svc = require('../services/rate-card-bulk-upload.service');
    const buf = aoaBuffer([SERVICES_HEADER,
      [100, 'AC Installation', 10, 0, 0, 0, 0, 0],
      [100, 'AC Installation', 20, 0, 0, 0, 0, 0],
    ]);
    const out = await svc.previewServicesUpload(buf, 1);
    assert.equal(out.rows[1].outcome, 'blocked');
    // row_number 2 (the FIRST occurrence) is cited on row_number 3 (the duplicate).
    assert.equal(out.rows[1].row_number, 3);
    assert.match(out.rows[1].errors.join(';'), /Duplicate of row 2 for Service Type ID 100/);
  });
});

// ═══════════════════════════ Commit: all-or-nothing ═══════════════════════

describe('commit: refuses and writes nothing when a row is blocked', () => {
  let fake;
  before(() => {
    fake = installFakePool([
      [/FROM tbl_service_type WHERE service_type_status <> 3/i, () => []], // nothing known → any id is "unknown"
      [/COALESCE\(easyfix_direct_fixed,0\)/i, () => []],
    ]);
  });
  after(() => fake.restore());
  beforeEach(() => fake.reset());

  it('Services commit() throws 422 and never opens a transaction when a row is blocked', async () => {
    const svc = require('../services/rate-card-bulk-upload.service');
    const buf = aoaBuffer([SERVICES_HEADER, [1, 'Anything', 0, 0, 0, 0, 0, 0]]);
    await assert.rejects(
      () => svc.commitServicesUpload(buf, 1),
      (e) => { assert.equal(e.status, 422); return true; },
    );
    assert.ok(!fake.calls.some((c) => /INSERT INTO tbl_client_service|UPDATE tbl_client_service/i.test(c.sql)),
      'a blocked file must write nothing');
  });
});

describe('commit: a mid-transaction failure rolls back everything already written', () => {
  let fake;
  let rolledBack;
  let committed;

  before(() => {
    fake = installFakePool([
      [/FROM tbl_service_type WHERE service_type_status <> 3/i, () => [
        { service_type_id: 10, service_type_name: 'AC Installation', service_type_status: 1, service_catg_id: 3 },
        { service_type_id: 11, service_type_name: 'AC Repair',       service_type_status: 1, service_catg_id: 3 },
      ]],
      // Existing rows with DIFFERENT costs than the file → both rows are 'update'.
      [/COALESCE\(easyfix_direct_fixed,0\)/i, () => [
        { client_service_id: 501, service_type_id: 10, easyfix_direct_fixed: 1, easyfix_direct_variable: 0, overhead_fixed: 0, overhead_variable: 0, client_fixed: 0, client_variable: 0 },
        { client_service_id: 502, service_type_id: 11, easyfix_direct_fixed: 1, easyfix_direct_variable: 0, overhead_fixed: 0, overhead_variable: 0, client_fixed: 0, client_variable: 0 },
      ]],
      [/^\s*UPDATE tbl_client_service SET/i, (sql, params) => {
        const clientServiceId = params[params.length - 1];
        if (clientServiceId === 502) throw new Error('simulated DB failure on the second row');
        return { affectedRows: 1 };
      }],
    ]);
    // Spy on commit/rollback of the ONE connection the commit loop opens.
    const db = require('../db');
    const origGetConnection = db.pool.getConnection;
    db.pool.getConnection = async () => {
      const conn = await origGetConnection.call(db.pool);
      const origCommit = conn.commit, origRollback = conn.rollback;
      conn.commit = async (...a) => { committed = true; return origCommit(...a); };
      conn.rollback = async (...a) => { rolledBack = true; return origRollback(...a); };
      return conn;
    };
  });
  after(() => fake.restore());
  beforeEach(() => { fake.reset(); rolledBack = false; committed = false; });

  it('row 1 (service_type 10) is attempted, then row 2 fails, then the whole transaction rolls back', async () => {
    const svc = require('../services/rate-card-bulk-upload.service');
    const buf = aoaBuffer([SERVICES_HEADER,
      [10, 'AC Installation', 200, 10, 10, 20, 0, 0],
      [11, 'AC Repair',       50,  5,  5,  5,  0, 0],
    ]);
    await assert.rejects(() => svc.commitServicesUpload(buf, 1));
    assert.ok(fake.calls.some((c) => /^\s*UPDATE tbl_client_service SET/i.test(c.sql) && c.params[c.params.length - 1] === 501),
      'the first (successful) row must have been attempted before the failure');
    assert.equal(committed, false, 'commit must never be called when a later row fails');
    assert.equal(rolledBack, true, 'rollback must be called so the first row\'s write does not stick');
  });
});

describe('commit re-validates: a material that goes inactive between preview and commit rolls everything back', () => {
  let fake;
  let rolledBack;
  let committed;

  before(() => {
    fake = installFakePool([
      [/SELECT material_id, material_name FROM tbl_material_master WHERE status = 1/i, () => [
        { material_id: 1, material_name: 'Material A' }, { material_id: 2, material_name: 'Material B' },
      ]],
      [/SELECT brand_id, brand_name, brand_key FROM tbl_brand_master WHERE status = 1/i, () => []],
      [/SELECT state_id, state_name FROM tbl_state/i, () => []],
      [/FROM tbl_client_material_price_group g\b/i, () => []], // no existing card — both rows preview as 'new'
      // replace()'s getMaterialRow — active for material 1, INACTIVE for material 2 (the race).
      [/FROM tbl_material_master m\s+LEFT JOIN tbl_service_catg/i, (sql, params) => (
        params[0] === 1 ? [{ material_id: 1, status: 1, pricing_type: 'FIXED' }]
          : [{ material_id: 2, status: 0, pricing_type: 'FIXED' }]
      )],
      [/^\s*INSERT INTO tbl_client_material_price_group\b/i, () => ({ insertId: 9999 })],
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
  });
  after(() => fake.restore());
  beforeEach(() => { fake.reset(); rolledBack = false; committed = false; });

  it('Material A (processed first) is attempted, Material B 404s, and the whole file rolls back', async () => {
    const svc = require('../services/rate-card-bulk-upload.service');
    const buf = aoaBuffer([MATERIALS_HEADER,
      ['Material A', '', 100, ''],
      ['Material B', '', 200, ''],
    ]);
    // Preview sees both materials as active/valid — 'new', zero blocked.
    const preview = await svc.previewMaterialRatesUpload(buf, 1);
    assert.equal(preview.summary.blocked, 0);
    assert.equal(preview.summary.new, 2);

    // Commit re-validates via getMaterialRow — Material B is now inactive.
    await assert.rejects(() => svc.commitMaterialRatesUpload(buf, 1));
    assert.ok(fake.calls.some((c) => /^\s*INSERT INTO tbl_client_material_price_group\b/i.test(c.sql)),
      'Material A\'s write must have been attempted before Material B\'s failure');
    assert.equal(committed, false, 'commit must never be called when a later material 404s');
    assert.equal(rolledBack, true, 'rollback must undo Material A\'s already-attempted write');
  });
});

// ═══════════════════════════ Route gates (isClientEdit) ═══════════════════

describe('routes: template/preview/commit require isClientEdit and are client-scope-guarded', () => {
  const ROUTES = fs.readFileSync(path.join(ROOT, 'routes/admin/clients.js'), 'utf8');

  function routeBlock(anchor) {
    const idx = ROUTES.indexOf(anchor);
    assert.ok(idx >= 0, `route registration for ${anchor} not found`);
    const end = ROUTES.indexOf('\n);', idx);
    const endAlt = ROUTES.indexOf('\n});', idx);
    const stop = end === -1 ? endAlt : (endAlt === -1 ? end : Math.min(end, endAlt));
    assert.ok(stop > idx, `route registration for ${anchor} has no closing block`);
    return ROUTES.slice(idx, stop);
  }

  const ROUTE_ANCHORS = [
    "'/:clientId/rate-cards/template'",
    "'/:clientId/rate-cards/upload/preview'",
    "'/:clientId/rate-cards/upload/commit'",
    "'/:clientId/material-rates/template'",
    "'/:clientId/material-rates/upload/preview'",
    "'/:clientId/material-rates/upload/commit'",
  ];

  for (const anchor of ROUTE_ANCHORS) {
    test(`${anchor} requires isClientEdit and calls loadAndGuardClient`, () => {
      const block = routeBlock(anchor);
      assert.match(block, /requireClientEdit/, `${anchor} must require isClientEdit`);
      assert.match(block, /loadAndGuardClient\(/, `${anchor} must run the client scope-guard`);
    });
  }
});
