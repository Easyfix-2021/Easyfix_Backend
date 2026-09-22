/*
 * services/material.service.js::createMaterial — duplicate guard (case +
 * whitespace variants collide via nameKey, scoped to service_catg_id) and
 * the No Brand save/price_pending round trip (Decision A, QA-fixes round).
 * Non-destructive: fake pool, no real DB.
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const scenario = { dup: null, materialRow: null, groupRows: [], brandRows: [] };

const fake = installFakePool([
  [/FROM tbl_material_master WHERE material_key = \?/i, () => (scenario.dup ? [scenario.dup] : [])],
  [/FROM tbl_service_catg WHERE service_catg_id = \?/i, [{ service_catg_name: 'Electrical' }]],
  [/INSERT INTO tbl_material_master/i, () => ({ insertId: 501 })],
  [/INSERT INTO tbl_material_price_group\b/i, () => ({ insertId: 9001 })],
  [/SELECT m\.material_id[\s\S]*FROM tbl_material_master m/i, () => (scenario.materialRow ? [scenario.materialRow] : [])],
  [/FROM tbl_material_price_group WHERE material_id = \?/i, () => scenario.groupRows],
  [/FROM tbl_material_price_group_brand gb/i, () => scenario.brandRows],
  [/FROM tbl_material_state_price WHERE group_id/i, () => []],
]);

const materialSvc = require('../services/material.service');

beforeEach(() => {
  fake.reset();
  scenario.dup = null;
  scenario.materialRow = null;
  scenario.groupRows = [];
  scenario.brandRows = [];
});

const validGroups = [{ price: 100, brand_ids: [1], states: [] }];

test('createMaterial rejects a duplicate (case + whitespace variant) with 409, naming the existing record and category', async () => {
  scenario.dup = { material_id: 12, material_name: 'Adapter 5A' };
  await assert.rejects(
    materialSvc.createMaterial({
      material_name: '  adapter    5a  ', service_catg_id: 3, pricing_type: 'FIXED', groups: validGroups,
    }),
    (e) => {
      assert.equal(e.status, 409);
      assert.ok(e.message.includes('Adapter 5A'), e.message);
      assert.ok(e.message.includes('Electrical'), e.message);
      return true;
    }
  );
});

test('createMaterial rejects an invalid groups payload (FIXED, zero groups) before ever checking duplicates', async () => {
  scenario.dup = { material_id: 12, material_name: 'Should not matter' };
  await assert.rejects(
    materialSvc.createMaterial({ material_name: 'New Thing', service_catg_id: 3, pricing_type: 'FIXED', groups: [] }),
    (e) => { assert.equal(e.status, 422); return true; }
  );
  // Validation is pure (no queries at all) — nothing should have run.
  const dupQueryRan = fake.calls.some((c) => /FROM tbl_material_master WHERE material_key/i.test(c.sql));
  assert.equal(dupQueryRan, false, 'validation must fail before the duplicate lookup');
});

// ─── Decision A: No Brand save + derived price_pending ──────────────────

test('a sole No Brand group with a NULL price saves and derives price_pending = true', async () => {
  scenario.materialRow = {
    material_id: 501, material_name: 'Cable Tie', description: null,
    service_catg_id: 3, service_catg_name: 'Electrical', uom_id: null, uom_name: null,
    pricing_type: 'FIXED', status: 1,
  };
  scenario.groupRows = [{ group_id: 9001, price: null }];
  scenario.brandRows = [];

  const created = await materialSvc.createMaterial({
    material_name: 'Cable Tie', service_catg_id: 3, pricing_type: 'FIXED',
    groups: [{ price: null, brand_ids: [], states: [] }],
  });

  assert.equal(created.price_pending, true);
  assert.equal(created.groups.length, 1);
  assert.equal(created.groups[0].price, null);
  assert.deepEqual(created.groups[0].brands, []);

  // Positive control: prove the price-group INSERT actually ran and carried
  // a NULL price (not a stray default) — a check whose passing signal is
  // silence (price_pending===true) must first prove it found its subject.
  const groupInsert = fake.calls.find((c) => /INSERT INTO tbl_material_price_group\b/i.test(c.sql));
  assert.ok(groupInsert, 'the price-group INSERT should have run');
  assert.equal(groupInsert.params[1], null);
});
