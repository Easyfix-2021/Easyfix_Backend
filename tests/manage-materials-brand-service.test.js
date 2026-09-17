/*
 * services/brand.service.js — duplicate guard, delete-with-references guard,
 * and replace-and-delete conflict guard. Non-destructive: fake pool routes
 * key off the bound params so brand_id=5 ("me") and brand_id=8
 * ("replacement") each get their own canned row.
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const BRANDS = {
  5: { brand_id: 5, brand_name: 'Philips', is_system: 0, status: 1 },
  8: { brand_id: 8, brand_name: 'Havells', is_system: 0, status: 1 },
};

const scenario = {
  dupOnCreate: null,       // row returned by the brand_key dup lookup, or null
  referenceCount: 0,       // rows referencing brand_id=5 (delete guard)
  conflictRows: [],        // rows for the replace-and-delete conflict check
};

const fake = installFakePool([
  [/SELECT brand_id, brand_name FROM tbl_brand_master WHERE brand_key = \?\s*LIMIT 1/i, () => (scenario.dupOnCreate ? [scenario.dupOnCreate] : [])],
  [/FROM tbl_brand_master WHERE brand_id = \?/i, (sql, params) => {
    const row = BRANDS[params[0]];
    return row ? [row] : [];
  }],
  [/FROM tbl_material_price_group_brand WHERE brand_id = \?/i, () => [{ cnt: scenario.referenceCount }]],
  [/gb_to\.material_id, m\.material_name/i, () => scenario.conflictRows],
  [/INSERT INTO tbl_brand_master/i, () => ({ insertId: 42 })],
  [/DELETE FROM tbl_brand_master/i, () => ({ affectedRows: 1 })],
  [/UPDATE tbl_material_price_group_brand SET brand_id/i, () => ({ affectedRows: scenario.conflictRows.length ? 0 : 1 })],
]);

const brandSvc = require('../services/brand.service');

beforeEach(() => {
  fake.reset();
  scenario.dupOnCreate = null;
  scenario.referenceCount = 0;
  scenario.conflictRows = [];
});

// ─── Duplicate brand (case + whitespace variants) → 409 ────────────────

test('createBrand rejects a duplicate with 409, naming the existing record', async () => {
  scenario.dupOnCreate = { brand_id: 5, brand_name: 'Philips' };
  await assert.rejects(brandSvc.createBrand({ brand_name: '  PHILIPS  ' }), (e) => {
    assert.equal(e.status, 409);
    assert.ok(e.message.includes('Philips'), e.message);
    return true;
  });
});

test('createBrand succeeds when no duplicate exists', async () => {
  scenario.dupOnCreate = null;
  // id 42 (the fake INSERT's insertId) has no canned row — proves createBrand
  // didn't throw; the follow-up getBrandById resolving null is expected here.
  const got = await brandSvc.createBrand({ brand_name: 'Bosch' });
  assert.equal(got, null);
});

// ─── Delete with references → 409 ───────────────────────────────────────

test('deleteBrand rejects with 409 when materials still reference it', async () => {
  scenario.referenceCount = 3;
  await assert.rejects(brandSvc.deleteBrand(5), (e) => {
    assert.equal(e.status, 409);
    assert.ok(e.references, 'error should carry the references payload');
    assert.equal(e.references.total, 3);
    return true;
  });
});

test('deleteBrand succeeds when nothing references it', async () => {
  scenario.referenceCount = 0;
  const out = await brandSvc.deleteBrand(5);
  assert.deepEqual(out, { deleted: true });
});

test('deleteBrand rejects the system brand with 422', async () => {
  BRANDS[5].is_system = 1;
  try {
    await assert.rejects(brandSvc.deleteBrand(5), (e) => { assert.equal(e.status, 422); return true; });
  } finally {
    BRANDS[5].is_system = 0;
  }
});

// ─── replace-and-delete: replacement already on the same material → 409 ─

test('replaceAndDeleteBrand rejects with 409 listing the conflicting material', async () => {
  scenario.conflictRows = [{ material_id: 71, material_name: 'Adapter 5A' }];
  await assert.rejects(brandSvc.replaceAndDeleteBrand(5, 8), (e) => {
    assert.equal(e.status, 409);
    assert.ok(Array.isArray(e.conflicts), 'error should carry a conflicts array');
    assert.equal(e.conflicts[0].material_id, 71);
    assert.equal(e.conflicts[0].material_name, 'Adapter 5A');
    return true;
  });
});

test('replaceAndDeleteBrand succeeds and repoints when there is no conflict', async () => {
  scenario.conflictRows = [];
  const out = await brandSvc.replaceAndDeleteBrand(5, 8);
  assert.equal(out.deleted, true);
});
