/*
 * services/material-import.service.js — the import preview pass (stateless:
 * preview and commit both re-parse the raw file). Real .xlsx buffers are
 * built in-memory with the `xlsx` package (same lib the service parses
 * with) rather than hand-rolled fixtures, so a header-matching regression
 * in the service would show up here too. Non-destructive: fake pool, no
 * real DB.
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { installFakePool } = require('./helpers/fake-pool');

function xlsxBuffer(rows) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const scenario = {
  existingBrands: [],       // [{brand_id, brand_name, brand_key}]
  categories: [{ service_catg_id: 3, service_catg_name: 'Electrical' }],
  uoms: [{ uom_id: 1, uom_name: 'Nos' }],
  brands: [],               // full brand rows incl. is_system, for material import
  materials: [],            // existing materials, for NEW/UPDATE resolution
};

const fake = installFakePool([
  [/SELECT brand_id, brand_name, brand_key FROM tbl_brand_master/i, () => scenario.existingBrands],
  [/FROM tbl_service_catg WHERE service_catg_status = 1/i, () => scenario.categories],
  [/FROM tbl_uom_master WHERE status = 1/i, () => scenario.uoms],
  [/SELECT brand_id, brand_name, brand_key, is_system FROM tbl_brand_master/i, () => scenario.brands],
  [/SELECT material_id, material_key, service_catg_id FROM tbl_material_master/i, () => scenario.materials],
]);

const imports = require('../services/material-import.service');

beforeEach(() => {
  fake.reset();
  scenario.existingBrands = [];
  scenario.categories = [{ service_catg_id: 3, service_catg_name: 'Electrical' }];
  scenario.uoms = [{ uom_id: 1, uom_name: 'Nos' }];
  scenario.brands = [{ brand_id: 1, brand_name: 'Philips', brand_key: 'philips', is_system: 0 }];
  scenario.materials = [];
});

// ─── Brand import: in-file duplicate ────────────────────────────────────

test('brand import: a later in-file duplicate (case-insensitive) is BLOCKED, the first row is NEW', async () => {
  const buf = xlsxBuffer([['Brand Name*'], ['Philips'], ['PHILIPS']]);
  const { rows, summary } = await imports.previewBrandImport(buf);
  assert.equal(rows[0].outcome, 'NEW');
  assert.equal(rows[1].outcome, 'BLOCKED');
  assert.ok(rows[1].errors[0].includes('Duplicate of row 2'), rows[1].errors[0]);
  assert.ok(rows[1].errors[0].includes('Philips'), rows[1].errors[0]);
  assert.equal(summary.new, 1);
  assert.equal(summary.blocked, 1);
});

test('brand import: an existing DB brand is EXISTS, not an error', async () => {
  scenario.existingBrands = [{ brand_id: 5, brand_name: 'Havells', brand_key: 'havells' }];
  const buf = xlsxBuffer([['Brand Name*'], ['Havells']]);
  const { rows, summary } = await imports.previewBrandImport(buf);
  assert.equal(rows[0].outcome, 'EXISTS');
  assert.equal(rows[0].errors.length, 0);
  assert.equal(summary.exists, 1);
});

// ─── Material import: non-numeric price → PRICE_PENDING ────────────────

test('material import: a non-numeric FIXED price ("As per Actual") is PRICE_PENDING', async () => {
  const buf = xlsxBuffer([
    ['Material Name*', 'Category*', 'Pricing Type*', 'UOM', 'Description', 'Brands', 'Price'],
    ['Adapter 5A', 'Electrical', 'Fixed', 'Nos', '', 'Philips', 'As per Actual'],
  ]);
  const { rows, summary } = await imports.previewMaterialImport(buf, { canCreateBrands: false });
  assert.equal(rows[0].outcome, 'PRICE_PENDING');
  assert.equal(rows[0].errors.length, 0);
  assert.equal(summary.price_pending, 1);
});

test('material import: a blank FIXED price is also PRICE_PENDING', async () => {
  const buf = xlsxBuffer([
    ['Material Name*', 'Category*', 'Pricing Type*', 'UOM', 'Description', 'Brands', 'Price'],
    ['Adapter 5A', 'Electrical', 'Fixed', 'Nos', '', 'Philips', ''],
  ]);
  const { rows } = await imports.previewMaterialImport(buf, { canCreateBrands: false });
  assert.equal(rows[0].outcome, 'PRICE_PENDING');
});

// ─── Material import: unknown brand without isBrandAddNew → BLOCKED ────

test('material import: an unknown brand is BLOCKED when the importer lacks isBrandAddNew', async () => {
  const buf = xlsxBuffer([
    ['Material Name*', 'Category*', 'Pricing Type*', 'UOM', 'Description', 'Brands', 'Price'],
    ['Adapter 5A', 'Electrical', 'Fixed', 'Nos', '', 'Bosch', '150'],
  ]);
  const { rows, summary } = await imports.previewMaterialImport(buf, { canCreateBrands: false });
  assert.equal(rows[0].outcome, 'BLOCKED');
  assert.ok(rows[0].errors.some((e) => e.includes('Unknown brand "Bosch"') && e.includes('isBrandAddNew')), rows[0].errors.join('; '));
  assert.equal(summary.blocked, 1);
  assert.equal(summary.can_create_brands, false);
});

test('material import: an unknown brand is CREATED and listed when the importer HAS isBrandAddNew', async () => {
  const buf = xlsxBuffer([
    ['Material Name*', 'Category*', 'Pricing Type*', 'UOM', 'Description', 'Brands', 'Price'],
    ['Adapter 5A', 'Electrical', 'Fixed', 'Nos', '', 'Bosch', '150'],
  ]);
  const { rows, summary } = await imports.previewMaterialImport(buf, { canCreateBrands: true });
  assert.equal(rows[0].outcome, 'NEW');
  assert.equal(rows[0].errors.length, 0);
  assert.ok(summary.brands_to_create.includes('Bosch'), summary.brands_to_create.join(','));
  assert.equal(summary.can_create_brands, true);
});

// ─── Material import: DYNAMIC carrying brands/price → BLOCKED ──────────

test('material import: a DYNAMIC row carrying Brands/Price is BLOCKED', async () => {
  const buf = xlsxBuffer([
    ['Material Name*', 'Category*', 'Pricing Type*', 'UOM', 'Description', 'Brands', 'Price'],
    ['Diagnostic Visit', 'Electrical', 'Dynamic', '', '', 'Philips', '150'],
  ]);
  const { rows } = await imports.previewMaterialImport(buf, { canCreateBrands: false });
  assert.equal(rows[0].outcome, 'BLOCKED');
  assert.ok(rows[0].errors.some((e) => /DYNAMIC/i.test(e)), rows[0].errors.join('; '));
});

// ─── Material import: Decision A — "No Brand" replaces "Not Applicable" ─

test('material import: a blank Brands cell on a FIXED row is a No Brand group, not an error', async () => {
  const buf = xlsxBuffer([
    ['Material Name*', 'Category*', 'Pricing Type*', 'UOM', 'Description', 'Brands', 'Price'],
    ['Cable Tie', 'Electrical', 'Fixed', 'Nos', '', '', '25'],
  ]);
  const { rows } = await imports.previewMaterialImport(buf, { canCreateBrands: false });
  assert.equal(rows[0].outcome, 'NEW');
  assert.equal(rows[0].errors.length, 0, rows[0].errors.join('; '));
});

for (const alias of ['not applicable', 'NA', 'n/a', 'No Brand', '  Not Applicable  ']) {
  test(`material import: a Brands cell of "${alias}" on a FIXED row is a No Brand group`, async () => {
    const buf = xlsxBuffer([
      ['Material Name*', 'Category*', 'Pricing Type*', 'UOM', 'Description', 'Brands', 'Price'],
      ['Cable Tie', 'Electrical', 'Fixed', 'Nos', '', alias, '25'],
    ]);
    const { rows } = await imports.previewMaterialImport(buf, { canCreateBrands: false });
    assert.equal(rows[0].outcome, 'NEW', rows[0].errors.join('; '));
    assert.equal(rows[0].errors.length, 0, rows[0].errors.join('; '));
  });
}

test('material import: mixing a No Brand row and a branded row for the same material is BLOCKED', async () => {
  const buf = xlsxBuffer([
    ['Material Name*', 'Category*', 'Pricing Type*', 'UOM', 'Description', 'Brands', 'Price'],
    ['Cable Tie', 'Electrical', 'Fixed', 'Nos', '', '', '25'],
    ['Cable Tie', 'Electrical', 'Fixed', 'Nos', '', 'Philips', '30'],
  ]);
  const { rows, summary } = await imports.previewMaterialImport(buf, { canCreateBrands: false });
  assert.equal(rows[0].outcome, 'NEW', 'first row parses fine on its own');
  assert.equal(rows[1].outcome, 'BLOCKED');
  assert.ok(
    rows[1].errors.some((e) => e.includes('Cannot mix No Brand and brand prices for "Cable Tie"')),
    rows[1].errors.join('; ')
  );
  assert.equal(summary.blocked, 1);
});

test('material import: mixing a branded row THEN a No Brand row for the same material is also BLOCKED', async () => {
  const buf = xlsxBuffer([
    ['Material Name*', 'Category*', 'Pricing Type*', 'UOM', 'Description', 'Brands', 'Price'],
    ['Cable Tie', 'Electrical', 'Fixed', 'Nos', '', 'Philips', '30'],
    ['Cable Tie', 'Electrical', 'Fixed', 'Nos', '', 'Not Applicable', '25'],
  ]);
  const { rows } = await imports.previewMaterialImport(buf, { canCreateBrands: false });
  assert.equal(rows[0].outcome, 'NEW');
  assert.equal(rows[1].outcome, 'BLOCKED');
  assert.ok(
    rows[1].errors.some((e) => e.includes('Cannot mix No Brand and brand prices for "Cable Tie"')),
    rows[1].errors.join('; ')
  );
});
