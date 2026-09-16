/*
 * services/rate-card-b2b.service.js and rate-card-b2c.service.js write
 * tbl_client_rate_card / tbl_retail_rate_card insert_date & update_date
 * (TIMESTAMP). Bound as a Date, never NOW(): the pool is
 * `timezone: '+05:30'`, so a JS Date serialises to the IST wall clock the
 * columns expect, whereas NOW() resolves in the DB session zone.
 *
 * Runner: `node --test` (see npm test).
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/FROM tbl_service_type/i, () => [{ service_type_id: 5 }]],
  [/^\s*INSERT INTO tbl_client_rate_card/i, () => ({ insertId: 21 })],
  [/^\s*INSERT INTO tbl_retail_rate_card/i, () => ({ insertId: 22 })],
  [/^\s*UPDATE tbl_client_rate_card/i, () => ({ affectedRows: 1 })],
  [/^\s*UPDATE tbl_retail_rate_card/i, () => ({ affectedRows: 1 })],
  // updateRateCard's existence check (WHERE crc_id/rrc_id = ?) must find the
  // row; createRateCard's DUP check (WHERE …servicetype_id = ? AND name = ?)
  // must find nothing — same SELECT shape, disambiguated by the WHERE clause.
  [/WHERE crc_id = \?/i, () => [{ crc_id: 1 }]],
  [/WHERE rrc_id = \?/i, () => [{ rrc_id: 1 }]],
]);
const b2b = require('../services/rate-card-b2b.service');
const b2c = require('../services/rate-card-b2c.service');

after(() => fake.restore());

// Zips the INSERT's column list against its VALUES tuple, walking `params`
// only for entries that are `?` — both tables' INSERTs mix bound params with
// a literal (`status = 1`), so a plain column-index lookup misaligns.
function boundInsertValue(sql, params, col) {
  const colList = sql.replace(/^[\s\S]*INSERT INTO \S+\s*\(/i, '').split(')')[0]
    .split(',').map((s) => s.trim());
  const values = sql.replace(/^[\s\S]*VALUES\s*\(/i, '').split(')')[0]
    .split(',').map((s) => s.trim());
  let paramIndex = 0;
  for (let i = 0; i < colList.length; i++) {
    if (values[i] !== '?') continue;
    if (colList[i] === col) return params[paramIndex];
    paramIndex += 1;
  }
  return undefined;
}

function assertSamePairedDate(sql, params, cols) {
  const values = cols.map((col) => {
    const v = boundInsertValue(sql, params, col);
    assert.ok(v instanceof Date, `${col} must be a bound Date`);
    return v;
  });
  assert.equal(values[0].getTime(), values[1].getTime(), 'insert_date and update_date must stamp identically on create');
}

test('b2b createRateCard binds insert_date/update_date as Dates, not NOW()', async () => {
  fake.reset();
  await b2b.createRateCard({ crc_ratecard_name: 'Standard', crc_servicetype_id: 5, createdBy: 9 });
  const ins = fake.calls.find((c) => /^\s*INSERT INTO tbl_client_rate_card/i.test(c.sql));
  assert.ok(ins, 'the INSERT must run');
  assert.doesNotMatch(ins.sql, /NOW\(\)/);
  assertSamePairedDate(ins.sql, ins.params, ['insert_date', 'update_date']);
});

test('b2b updateRateCard binds update_date as a Date, not NOW()', async () => {
  fake.reset();
  await b2b.updateRateCard(1, { crc_ratecard_name: 'Renamed' }, 9);
  const upd = fake.calls.find((c) => /^\s*UPDATE tbl_client_rate_card/i.test(c.sql));
  assert.ok(upd, 'the UPDATE must run');
  assert.doesNotMatch(upd.sql, /update_date = NOW\(\)/i);
  const idx = upd.sql.replace(/^[\s\S]*SET /i, '').split(' WHERE ')[0].split(',')
    .map((s) => s.trim()).findIndex((a) => a.startsWith('update_date'));
  assert.ok(upd.params[idx] instanceof Date, 'update_date must be a bound Date');
});

test('b2c createRateCard binds insert_date/update_date as Dates, not NOW()', async () => {
  fake.reset();
  await b2c.createRateCard({ rrc_service_name: 'Retail Standard', rrc_servicetype_id: 5, rrc_service_price: 499, createdBy: 9 });
  const ins = fake.calls.find((c) => /^\s*INSERT INTO tbl_retail_rate_card/i.test(c.sql));
  assert.ok(ins, 'the INSERT must run');
  assert.doesNotMatch(ins.sql, /NOW\(\)/);
  assertSamePairedDate(ins.sql, ins.params, ['insert_date', 'update_date']);
});

test('b2c updateRateCard binds update_date as a Date, not NOW()', async () => {
  fake.reset();
  await b2c.updateRateCard(1, { rrc_service_name: 'Renamed' }, 9);
  const upd = fake.calls.find((c) => /^\s*UPDATE tbl_retail_rate_card/i.test(c.sql));
  assert.ok(upd, 'the UPDATE must run');
  assert.doesNotMatch(upd.sql, /update_date = NOW\(\)/i);
  const idx = upd.sql.replace(/^[\s\S]*SET /i, '').split(' WHERE ')[0].split(',')
    .map((s) => s.trim()).findIndex((a) => a.startsWith('update_date'));
  assert.ok(upd.params[idx] instanceof Date, 'update_date must be a bound Date');
});
