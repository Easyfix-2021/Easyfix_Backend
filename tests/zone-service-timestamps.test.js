/*
 * services/zone.service.js writes two application timestamps, neither of
 * which may be SQL NOW() (2026-09-16):
 *   - tbl_zone_master.created_date (TIMESTAMP) — createZone()
 *   - tbl_zone_pincode_mapping.created_on (DATETIME) — setPincodeMapping()
 * Both are bound `new Date()` — the pool's timezone '+05:30' serializes it
 * as the IST wall clock regardless of host, whereas NOW() would resolve in
 * the DB session's own (SYSTEM) zone. Same convention as every other
 * application timestamp in this repo (see tests/otp-attempt-cap.test.js).
 *
 * Runner: `node --test` (see npm test).
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/SELECT city_id FROM tbl_city WHERE city_id = \?/, [{ city_id: 1 }]],
  [/SELECT zone_id FROM tbl_zone_master\s+WHERE city_id = \?/, []],
  [/INSERT INTO tbl_zone_master/, { insertId: 88 }],
  [/INSERT INTO tbl_zone_city_mapping/, {}],
  [/SELECT z\.zone_id, z\.zone_name, z\.zone_status, z\.created_date/, [{ zone_id: 88, zone_name: 'North', zone_status: 1, created_date: new Date(), city_id: 1, city_name: 'Delhi' }]],
  [/SELECT p\.pincode_id, p\.pincode, p\.location, p\.district, p\.pincode_status/, []],
  [/SELECT zone_id, city_id FROM tbl_zone_master WHERE zone_id = \?/, [{ zone_id: 88, city_id: 1 }]],
  [/SELECT pincode_id, pincode\s+FROM tbl_pincode WHERE pincode_id IN/, [{ pincode_id: 5, pincode: '110001' }]],
  [/DELETE FROM tbl_zone_pincode_mapping/, {}],
  [/INSERT IGNORE INTO tbl_zone_pincode_mapping/, { affectedRows: 1 }],
]);

const { createZone, setPincodeMapping } = require('../services/zone.service');

after(() => { if (fake.restore) fake.restore(); });

test('createZone() stamps tbl_zone_master.created_date (timestamp) with a bound Date, never NOW()', async () => {
  const zone = await createZone({ zone_name: 'North', city_id: 1 });
  assert.equal(zone.zone_id, 88, 'positive control: the insert + detail read ran');

  const insert = fake.calls.find((c) => /INSERT INTO tbl_zone_master/.test(c.sql));
  assert.ok(insert, 'positive control: the zone-master insert ran');
  assert.doesNotMatch(insert.sql, /NOW\(\)/);
  assert.ok(insert.params[2] instanceof Date, 'created_date is the third bound value');
  assert.ok(Math.abs(Date.now() - insert.params[2].getTime()) < 60_000, 'and it is now');
});

test('setPincodeMapping() stamps tbl_zone_pincode_mapping.created_on (datetime) with a bound Date, never NOW()', async () => {
  fake.reset();
  await setPincodeMapping(88, [5], { userId: 9 });

  const insert = fake.calls.find((c) => /INSERT IGNORE INTO tbl_zone_pincode_mapping/.test(c.sql));
  assert.ok(insert, 'positive control: the mapping insert ran');
  assert.doesNotMatch(insert.sql, /NOW\(\)/);
  assert.ok(insert.params[2] instanceof Date, 'created_on is the third bound value');
  assert.ok(Math.abs(Date.now() - insert.params[2].getTime()) < 60_000, 'and it is now');
});
