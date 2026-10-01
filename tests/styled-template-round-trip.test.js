/*
 * Every import whose Download Template is built with utils/xlsx-styled-export
 * must accept that template straight back.
 *
 * The styled writer puts a title, a note and a blank row above the header
 * (header on row 4, data from row 5). Four importers read row 1 as the header
 * instead, so every row of OUR OWN template failed "required field missing":
 * Manage Materials brand + material imports (since 2026-09-17) and the rate-
 * card Services + Materials uploads (since 2026-09-21). Their existing tests
 * fed hand-built header-on-row-1 sheets or the per-tab DOWNLOAD (also row 1),
 * never the template — so this file round-trips each template itself.
 *
 * POPULATION (2026-10-01): every template that both (a) is written through
 * utils/xlsx-styled-export and (b) is re-read by an importer — 4 of the
 * backend's 15 template downloads; the other 11 use their own writers with the
 * header on row 1. A new styled template belongs in TEMPLATES below.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { installFakePool } = require('./helpers/fake-pool');

function fakeRes() {
  const p = new PassThrough();
  const chunks = [];
  p.on('data', (c) => chunks.push(c));
  p.setHeader = () => {};
  p.done = new Promise((resolve) => p.on('finish', () => resolve(Buffer.concat(chunks))));
  return p;
}
async function templateBuffer(generate) {
  const res = fakeRes();
  await generate(res);
  return res.done;
}

describe('styled import templates round-trip through their own importer', () => {
  let fake;
  before(() => {
    fake = installFakePool([
      // Manage Materials import (brand + material).
      [/SELECT brand_id, brand_name, brand_key FROM tbl_brand_master$/im, () => []],
      [/SELECT brand_id, brand_name, brand_key FROM tbl_brand_master\s*$/im, () => []],
      // Real QA/Prod names (2026-10-01) — there is NO "Electrical" category.
      [/FROM tbl_service_catg WHERE service_catg_status = 1/i, () => [
        { service_catg_id: 5, service_catg_name: 'Carpentry Services' }, { service_catg_id: 1, service_catg_name: 'Electrician Services' },
      ]],
      [/FROM tbl_uom_master WHERE status = 1/i, () => [{ uom_id: 1, uom_name: 'Nos' }]],
      [/SELECT brand_id, brand_name, brand_key, is_system FROM tbl_brand_master/i, () => [
        { brand_id: 1, brand_name: 'Philips', brand_key: 'philips', is_system: 0 },
        { brand_id: 2, brand_name: 'Havells', brand_key: 'havells', is_system: 0 },
      ]],
      [/SELECT material_id, material_key, service_catg_id FROM tbl_material_master/i, () => []],
      // Rate-card Services.
      [/FROM tbl_service_type WHERE service_type_status <> 3/i, () => [
        { service_type_id: 1, service_type_name: 'AC Installation', service_type_status: 1, service_catg_id: 3 },
      ]],
      [/COALESCE\(easyfix_direct_fixed,0\)/i, () => []],
      // Rate-card Materials (template's example rows come from these names).
      [/SELECT material_id, material_name FROM tbl_material_master WHERE status = 1/i, () => [{ material_id: 700, material_name: 'PVC Pipe' }]],
      [/SELECT brand_id, brand_name, brand_key FROM tbl_brand_master WHERE status = 1/i, () => [{ brand_id: 1, brand_name: 'Philips', brand_key: 'philips' }]],
      [/SELECT state_id, state_name FROM tbl_state/i, () => [{ state_id: 21, state_name: 'Maharashtra' }]],
      [/FROM tbl_client_material_price_group g\b/i, () => []],
      [/FROM tbl_material_master\b/i, () => [{ material_id: 700, material_name: 'PVC Pipe', pricing_type: 'per_unit' }]],
      [/FROM tbl_client_material_price_group_brand gb/i, () => []],
      [/FROM tbl_client_material_state_price\s+WHERE/i, () => []],
      [/FROM tbl_client_material_state_price_state/i, () => []],
      [/FROM tbl_material_price_group g\b/i, () => []],
      [/FROM tbl_material_price_group_brand gb/i, () => []],
    ]);
  });
  after(() => fake.restore());

  const mi = () => require('../services/material-import.service');
  const rc = () => require('../services/rate-card-bulk-upload.service');
  const TEMPLATES = [
    { name: 'Manage Materials · Brand', generate: (r) => mi().generateBrandTemplate(r), preview: (b) => mi().previewBrandImport(b), exampleRows: 1 },
    { name: 'Manage Materials · Material', generate: (r) => mi().generateMaterialTemplate(r), preview: (b) => mi().previewMaterialImport(b), exampleRows: 1 },
    { name: 'Rate Card · Services', generate: (r) => rc().generateServicesTemplate(r), preview: (b) => rc().previewServicesUpload(b, 900), exampleRows: 1 },
    { name: 'Rate Card · Materials', generate: (r) => rc().generateMaterialRatesTemplate(r), preview: (b) => rc().previewMaterialRatesUpload(b, 900), exampleRows: 2 },
  ];

  it('Manage Materials · Material: the example row itself imports clean (built from real reference data)', async () => {
    const out = await mi().previewMaterialImport(await templateBuffer((r) => mi().generateMaterialTemplate(r)));
    assert.deepEqual(out.rows[0].errors, [], 'the example must validate against the same data it was built from');
    assert.equal(out.rows[0].outcome, 'NEW');
  });

  it('templateExampleRow: first category A-Z, prefers Nos, two non-system brands, blank brands when none', () => {
    const { templateExampleRow } = mi();
    const m = (rows, key) => new Map(rows.map((r) => [String(r[key]).toLowerCase(), r]));
    const ref = {
      categoryByKey: m([{ service_catg_name: 'Plumbing Services' }, { service_catg_name: 'Carpentry Services' }], 'service_catg_name'),
      uomByKey: m([{ uom_name: 'KG' }, { uom_name: 'Nos' }], 'uom_name'),
      brandByKey: m([{ brand_name: 'Zeta', is_system: 0 }, { brand_name: 'Alpha', is_system: 0 }, { brand_name: 'Beta', is_system: 0 }, { brand_name: 'AAA System', is_system: 1 }], 'brand_name'),
    };
    const ex = templateExampleRow(ref);
    assert.equal(ex.category, 'Carpentry Services');
    assert.equal(ex.uom, 'Nos');
    assert.equal(ex.brands, 'Alpha, Beta', 'system brands are never suggested');
    assert.equal(templateExampleRow({ ...ref, brandByKey: new Map() }).brands, '', 'no brands → blank = No Brand');
  });

  // In-cell dropdowns (utils/xlsx-list-validation): a hidden Lists sheet and
  // list validation on the right DATA columns, from row 5 (header on row 4).
  async function dropdowns(generate) {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await templateBuffer(generate));
    const lists = wb.getWorksheet('Lists');
    const data = wb.worksheets.find((w) => w.name !== 'Lists');
    const model = data.dataValidations.model;
    const byRange = (range) => {
      const key = Object.keys(model).find((k) => k === range || k.startsWith(range.split(':')[0]));
      return key ? model[key] : null;
    };
    const listValues = (col) => lists.getColumn(col).values.filter((v) => v != null).slice(1);
    return { lists, byRange, listValues };
  }

  it('Manage Materials · Material: Category, Pricing Type and UOM are dropdowns; Brands stays free text', async () => {
    const d = await dropdowns((r) => mi().generateMaterialTemplate(r));
    assert.ok(d.lists, 'hidden Lists sheet exists');
    assert.equal(d.lists.state, 'hidden');
    for (const [col, listCol] of [['B', 'A'], ['C', 'B'], ['D', 'C']]) {
      const v = d.byRange(`${col}5:${col}1000`);
      assert.ok(v, `column ${col} has list validation from row 5`);
      assert.equal(v.type, 'list');
      assert.ok(v.formulae[0].startsWith(`Lists!$${listCol}$2:`), `column ${col} points at Lists column ${listCol}: ${v.formulae[0]}`);
    }
    assert.equal(d.byRange('F5:F1000'), null, 'Brands (comma-separated) must NOT be a single-value dropdown');
    assert.deepEqual(d.listValues(1), ['Carpentry Services', 'Electrician Services']);
    assert.deepEqual(d.listValues(2), ['Fixed', 'Dynamic']);
    assert.deepEqual(d.listValues(3), ['Nos']);
  });

  it('Rate Card · Materials: Material, Brand and State dropdowns survive the move to the shared helper', async () => {
    const d = await dropdowns((r) => rc().generateMaterialRatesTemplate(r));
    for (const col of ['A', 'B', 'E']) assert.ok(d.byRange(`${col}5:${col}1000`), `column ${col} keeps its dropdown`);
    assert.equal(d.byRange('D5:D1000'), null, 'Tx Share (D) is a number, never a dropdown');
    assert.deepEqual(d.listValues(1), ['PVC Pipe']);
    assert.deepEqual(d.listValues(3), ['Maharashtra']);
  });

  for (const t of TEMPLATES) {
    it(`${t.name}: the template's example row(s) are read as data at Excel row 5+, with no "required" error`, async () => {
      const buf = await templateBuffer(t.generate);
      const out = await t.preview(buf);
      assert.equal(out.rows.length, t.exampleRows, 'exactly the example rows — not the title/note rows, not zero');
      assert.equal(out.rows[0].row_number, 5, 'row numbers are real Excel rows (header on row 4)');
      for (const row of out.rows) {
        const errs = (row.errors || []).join('; ');
        assert.doesNotMatch(errs, /required/i, `row ${row.row_number} was misread: ${errs}`);
      }
    });
  }
});
