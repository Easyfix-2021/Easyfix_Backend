/*
 * Zone bulk-upload stamps both tbl_zone_pincode_mapping.created_on (datetime)
 * and tbl_zone_master.created_date (timestamp) with a BOUND Date, not SQL
 * NOW() (2026-09-16) — same convention as every other application timestamp
 * in this repo (see tests/otp-attempt-cap.test.js,
 * tests/mobile-upload-document-created-on.test.js).
 *
 * Runner: `node --test` (see npm test).
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/SELECT city_id, city_name FROM tbl_city/, [{ city_id: 1, city_name: 'Delhi' }]],
  [/SELECT zone_id, zone_name, city_id, zone_status FROM tbl_zone_master/, []],
  [/SELECT pincode_id, pincode, city_id FROM tbl_pincode/, [{ pincode_id: 5, pincode: '110001', city_id: 1 }]],
  [/SELECT zone_id, pincode_id FROM tbl_zone_pincode_mapping/, []],
  [/INSERT INTO tbl_zone_master/, { insertId: 42 }],
  [/INSERT INTO tbl_zone_city_mapping/, {}],
  [/INSERT IGNORE INTO tbl_zone_pincode_mapping/, { affectedRows: 1 }],
]);

const { processUpload } = require('../services/zone-upload.service');

after(() => { if (fake.restore) fake.restore(); });

function buildWorkbook(rows) {
  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, sheet, 'Zone Pincodes');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('zone_pincode_mapping.created_on is a bound Date, never NOW()', async () => {
  const buffer = buildWorkbook([{ zone_name: 'North Zone', city_name: 'Delhi', pincode: '110001' }]);
  const result = await processUpload(buffer, { dryRun: false, userId: 99 });
  assert.equal(result.summary.assignedPincodes, 1, JSON.stringify(result.results));

  const insert = fake.calls.find((c) => /INSERT IGNORE INTO tbl_zone_pincode_mapping/.test(c.sql));
  assert.ok(insert, 'positive control: the mapping insert ran');
  assert.doesNotMatch(insert.sql, /NOW\(\)/);
  assert.ok(insert.params[2] instanceof Date, 'created_on is the third bound value');
  assert.ok(Math.abs(Date.now() - insert.params[2].getTime()) < 60_000, 'and it is now');
});

test('zone_master.created_date (timestamp) is also a bound Date, never NOW()', async () => {
  const buffer = buildWorkbook([{ zone_name: 'Fresh Zone', city_name: 'Delhi', pincode: '110001' }]);
  const result = await processUpload(buffer, { dryRun: false, userId: 99 });
  assert.equal(result.summary.createdZones, 1, JSON.stringify(result.results));

  const insert = fake.calls.find((c) => /INSERT INTO tbl_zone_master/.test(c.sql));
  assert.ok(insert, 'positive control: the zone-master insert ran');
  assert.doesNotMatch(insert.sql, /NOW\(\)/);
  assert.ok(insert.params[2] instanceof Date, 'created_date is the third bound value');
  assert.ok(Math.abs(Date.now() - insert.params[2].getTime()) < 60_000, 'and it is now');
});
