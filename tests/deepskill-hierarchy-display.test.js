'use strict';
/*
 * The Tx app's deep-skill tree reads every service type it may see —
 * tbl_service_type.display 1 (All) or 2 (Tx-app), never 0 (CRM-only) — and
 * drops types with no deep skill. It read `display = 2` alone, which hid 123 of
 * QA's 142 active deep skills (Carpentry showed 1 of 47), 2026-09-28.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/FROM tbl_service_catg/, () => [{ service_catg_id: 5, service_catg_name: 'Carpentry Services' }]],
  [/FROM tbl_service_type/, () => [
    { service_type_id: 1, service_type_name: 'All-type with skills' },
    { service_type_id: 2, service_type_name: 'Tx-type with skills' },
    { service_type_id: 3, service_type_name: 'All-type, no skills' },
  ]],
  [/FROM tbl_deep_skill\b/, () => [
    { deepskill_id: 10, service_type_id: 1, deepskill_name: 'Workstations', deepskill_image: null },
    { deepskill_id: 11, service_type_id: 2, deepskill_name: 'Office Fixtures', deepskill_image: null },
  ]],
  [/FROM tbl_deepskill_options/, () => [
    { id: 100, deepskill_id: 10, skill_option: 'Install', status: 1 },
    { id: 101, deepskill_id: 11, skill_option: 'Repair', status: 1 },
  ]],
  [/FROM tbl_efr_deepskill_mapping/, () => []],
]);
const { getHierarchy } = require('../services/mobile-deepskill.service');

test('service types: display 1 or 2, never 0; types without a deep skill dropped', async () => {
  const h = await getHierarchy(7, 5);
  const q = fake.calls.find((c) => /FROM tbl_service_type/.test(c.sql));
  assert.match(q.sql, /display IN \(1, 2\)/, 'the Tx app sees All (1) and Tx-app (2) types');
  assert.doesNotMatch(q.sql, /display = 2/);
  assert.deepEqual(h.serviceTypes.map((t) => t.serviceTypeId), [1, 2], 'the empty type is dropped');
  assert.equal(h.serviceTypes.reduce((n, t) => n + t.deepSkills.length, 0), 2);
});
