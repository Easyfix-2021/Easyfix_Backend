/*
 * services/material.service.js::createMaterial — duplicate guard (case +
 * whitespace variants collide via nameKey, scoped to service_catg_id).
 * Non-destructive: fake pool, no real DB, no write queries are reached
 * because the duplicate check throws before the transaction opens.
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const scenario = { dup: null };

const fake = installFakePool([
  [/FROM tbl_brand_master WHERE is_system/i, [{ brand_id: 999 }]],
  [/FROM tbl_material_master WHERE material_key = \?/i, () => (scenario.dup ? [scenario.dup] : [])],
  [/FROM tbl_service_catg WHERE service_catg_id = \?/i, [{ service_catg_name: 'Electrical' }]],
]);

const materialSvc = require('../services/material.service');

beforeEach(() => { fake.reset(); scenario.dup = null; });

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
  // Nothing beyond the not-applicable lookup should have run.
  const dupQueryRan = fake.calls.some((c) => /FROM tbl_material_master WHERE material_key/i.test(c.sql));
  assert.equal(dupQueryRan, false, 'validation must fail before the duplicate lookup');
});
