/*
 * Bulk deep-skill upload stamps tbl_deep_skill.inserted_on with a BOUND
 * Date, not SQL NOW() (2026-09-16) — datetime column, same convention as
 * every other application timestamp in this repo (see
 * tests/otp-attempt-cap.test.js).
 *
 * Runner: `node --test` (see npm test).
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/SELECT service_catg_id, service_catg_name\s+FROM tbl_service_catg/, [{ service_catg_id: 3, service_catg_name: 'Electrical' }]],
  [/SELECT service_type_id, service_type_name\s+FROM tbl_service_type/, [{ service_type_id: 55, service_type_name: 'Wiring' }]],
  [/SELECT deepskill_id\s+FROM tbl_deep_skill/, []],
  [/INSERT INTO tbl_deep_skill\b/, { insertId: 900 }],
  [/INSERT INTO tbl_deepskill_options/, { affectedRows: 1 }],
  [/SELECT skill_option FROM tbl_deepskill_options/, []],
]);

const { processBuffer } = require('../services/deep-skill-bulk.service');

after(() => { if (fake.restore) fake.restore(); });

async function buildWorkbook() {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Sheet1');
  sheet.addRow(['Screenshot 1']); // row 1 — decorative, unchecked
  sheet.addRow([
    'Key words Attached to theTechnician who selects the skill',
    'Tag Words to tell technicians when attending the service',
    'Service Category',
    'Service Type',
    'Services',
    'Option 1',
  ]); // row 2 — real headers
  sheet.addRow(['fix wiring', 'wiring tag', 'Electrical', 'Wiring', 'Rewire socket', 'Chip A']); // row 3 — data
  return wb.xlsx.writeBuffer();
}

test('bulk commit stamps inserted_on with a bound Date, never NOW()', async () => {
  const buffer = await buildWorkbook();
  const result = await processBuffer(buffer, { commit: true, actor: { user_id: 9 } });
  assert.equal(result.summary.skillsNew, 1, JSON.stringify(result.rows));

  const insert = fake.calls.find((c) => /INSERT INTO tbl_deep_skill\b/.test(c.sql));
  assert.ok(insert, 'positive control: the deep-skill insert ran');
  assert.doesNotMatch(insert.sql, /NOW\(\)/);
  const insertedOn = insert.params[6];
  assert.ok(insertedOn instanceof Date, 'inserted_on is the seventh bound value');
  assert.ok(Math.abs(Date.now() - insertedOn.getTime()) < 60_000, 'and it is now');
});
