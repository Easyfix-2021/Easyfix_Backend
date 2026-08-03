/*
 * Characterization tests for the mobile serviceable-pincodes READ.
 *
 * Pins the CSV → array parsing of tbl_efr_serviceable_pincodes.pincodes:
 *   - a normal CSV splits into a clean 6-digit array
 *   - blanks, whitespace and non-6-digit junk are dropped
 *   - a missing row (new technician) returns []
 *
 * The WRITE path delegates to easyfixer-verification.replaceServiceablePincodes
 * (already covered by its own flows), so it isn't re-tested here.
 *
 * Non-destructive: fake pool, no real DB. Runner: `npm test`.
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const SELECT_PINCODES = /SELECT pincodes FROM tbl_efr_serviceable_pincodes/i;

let scenario = { row: null };
const fake = installFakePool([
  [SELECT_PINCODES, () => (scenario.row ? [scenario.row] : [])],
]);

const svc = require('../services/mobile-profile-extra.service');

beforeEach(() => { scenario = { row: null }; fake.reset(); });

test('splits a normal CSV into a 6-digit array', async () => {
  scenario.row = { pincodes: '110001,110002,110062' };
  const { pincodes } = await svc.getServiceablePincodes(8379);
  assert.deepEqual(pincodes, ['110001', '110002', '110062']);
});

test('drops blanks, whitespace and non-6-digit junk', async () => {
  scenario.row = { pincodes: ' 500007 ,,abc,12345,5000078,500031 ' };
  const { pincodes } = await svc.getServiceablePincodes(8379);
  assert.deepEqual(pincodes, ['500007', '500031']);
});

test('an empty CSV yields an empty array', async () => {
  scenario.row = { pincodes: '' };
  const { pincodes } = await svc.getServiceablePincodes(8379);
  assert.deepEqual(pincodes, []);
});

test('a missing row (new technician) yields an empty array', async () => {
  scenario.row = null;
  const { pincodes } = await svc.getServiceablePincodes(99999);
  assert.deepEqual(pincodes, []);
});

test('the read is scoped to the technician efr_id', async () => {
  scenario.row = { pincodes: '110001' };
  await svc.getServiceablePincodes(8379);
  const q = fake.calls.find((c) => SELECT_PINCODES.test(c.sql));
  assert.ok(q, 'expected the serviceable-pincode lookup');
  assert.deepEqual(q.params, [8379]);
});
