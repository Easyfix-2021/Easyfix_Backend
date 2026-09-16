const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * The Supply Gap self-registration funnel reads a row that SPANS TWO TABLES,
 * and the query pretended it did not.
 *
 * It selected all nine fields from tbl_easyfixer alone. Six are not there:
 * city, user_name, pin_code and is_personal_detail_filled live on tbl_user;
 * `personal_detail_filled_verified_by_crm` exists in NO table (the real column
 * is is_personal_details_verified_by_crm); and `status` is efr_status. The
 * report 500'd with "Unknown column 'city' in 'field list'" on every
 * environment, and went unnoticed because the branch only runs once a mobile
 * number resolves to a tbl_user row.
 *
 * The aliases are the contract — resolveLabelForEfr() reads efr.city,
 * efr.user_name, efr.status — so the columns are renamed back to what the
 * judgement expects rather than the judgement being rewritten around them.
 */

const scenario = { users: [], efrs: [] };
const fake = installFakePool([
  [/FROM tbl_user WHERE mobile_no IN/i, () => scenario.users],
  [/SELECT efr_no FROM tbl_easyfixer/i, []],
  [/FROM tbl_easyfixer E/i, () => scenario.efrs],
  // pinDetail() prefill for create()'s pin-based (requestFor=0) path below.
  [/FROM tbl_pincode/i, () => [{
    pincode: 700001, city_id: 1, city_name: 'Kolkata', district: 'Kolkata',
    state_name: 'WB', state_user: 5, zonal_manager_name: 'ZM',
  }]],
]);
const svc = require('../services/quicksight/quicksight-supply-gap.service');
const { resolveSupplyStatusBatch } = svc._internals;

after(() => fake.restore());

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'services/quicksight/quicksight-supply-gap.service.js'), 'utf8',
);
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\/\/[^\n]*/g, '');

// ─── The query names only columns that exist ─────────────────────────

test('the resolved-user row is joined, not imagined onto one table', async () => {
  scenario.users = [{ user_id: 7, mobile_no: '9999900001' }];
  scenario.efrs = [];
  fake.reset();
  await resolveSupplyStatusBatch(['9999900001']);
  const sql = fake.calls.map((c) => c.sql).find((s) => /FROM tbl_easyfixer E/i.test(s));
  assert.ok(sql, 'the resolved-user query should have run');
  assert.match(sql, /LEFT JOIN tbl_user U\s+ON U\.user_id = E\.user_id/i,
    'four of the nine fields live on tbl_user — the join is not optional');
  for (const [tbl, col] of [
    ['U', 'city'], ['U', 'user_name'], ['U', 'pin_code'], ['U', 'is_personal_detail_filled'],
    ['E', 'is_personal_details_verified_by_crm'], ['E', 'is_technician_verified'],
    ['E', 'is_identity_details_verified_by_crm'], ['E', 'efr_status'],
  ]) {
    assert.match(sql, new RegExp(`${tbl}\\.${col}\\b`, 'i'), `${tbl}.${col} must be read from its real table`);
  }
});

test('the two names that exist in NO table are gone', () => {
  const sql = stripComments(SRC);
  // As a SOURCE column. They survive only as aliases, which is the contract.
  assert.equal(/E\.personal_detail_filled_verified_by_crm|tbl_easyfixer\.personal_detail_filled_verified_by_crm/i.test(sql), false,
    'personal_detail_filled_verified_by_crm is not a column anywhere');
  assert.equal(/SELECT[^;]*?\bE\.status\b/i.test(sql), false,
    'tbl_easyfixer has efr_status, not status');
});

test('the aliases the judgement reads are all preserved', async () => {
  scenario.users = [{ user_id: 7, mobile_no: '9999900001' }];
  fake.reset();
  await resolveSupplyStatusBatch(['9999900001']);
  const sql = fake.calls.map((c) => c.sql).find((s) => /FROM tbl_easyfixer E/i.test(s));
  for (const alias of [
    'city', 'user_name', 'pin_code', 'is_personal_detail_filled',
    'personal_detail_filled_verified_by_crm', 'is_technician_Verified',
    'is_identity_details_verified_by_crm', 'status',
  ]) {
    assert.match(sql, new RegExp(`AS\\s+${alias}\\b`, 'i'),
      `resolveLabelForEfr reads efr.${alias} — the alias IS the contract`);
  }
});

// ─── The funnel still judges the way it did ──────────────────────────

function rowFor(over = {}) {
  return {
    user_id: 7,
    city: 'Kolkata',
    user_name: 'Test Tech',
    pin_code: '700001',
    is_personal_detail_filled: 1,
    personal_detail_filled_verified_by_crm: null,
    is_technician_Verified: null,
    is_identity_details_verified_by_crm: null,
    status: 0,
    ...over,
  };
}

const LABEL_CASES = [
  ['New Lead', {}],
  ['Details Not Available', { city: null }],
  ['Details Not Available', { user_name: '' }],
  ['Details Not Available', { pin_code: null }],
  ['Details Not Available', { is_personal_detail_filled: 0 }],
  ['Not Eligible', { personal_detail_filled_verified_by_crm: 2 }],
  ['Self Registration In Progress', { personal_detail_filled_verified_by_crm: 1 }],
  ['Not Suitable', { personal_detail_filled_verified_by_crm: 1, is_identity_details_verified_by_crm: 2 }],
  ['Active', { personal_detail_filled_verified_by_crm: 1, is_technician_Verified: 1, status: 1 }],
  ['In-active', { personal_detail_filled_verified_by_crm: 1, is_technician_Verified: 1, status: 0 }],
];

for (const [expected, over] of LABEL_CASES) {
  test(`a row shaped like the query's output still labels "${expected}"`, async () => {
    scenario.users = [{ user_id: 7, mobile_no: '9999900001' }];
    scenario.efrs = [rowFor(over)];
    fake.reset();
    const map = await resolveSupplyStatusBatch(['9999900001']);
    assert.equal(map.get('9999900001'), expected);
  });
}

test('a missing city collapses the whole funnel — the shape of the old bug', async () => {
  /*
   * Worth pinning: if the join were dropped again, every tbl_user field would
   * arrive null and EVERY technician would read "Details Not Available". That
   * is a silent, uniform wrong answer rather than a 500, so a green report is
   * not evidence the columns are right — the varied distribution is.
   */
  scenario.users = [{ user_id: 7, mobile_no: '9999900001' }];
  scenario.efrs = [rowFor({ city: null, user_name: null, pin_code: null })];
  fake.reset();
  const map = await resolveSupplyStatusBatch(['9999900001']);
  assert.equal(map.get('9999900001'), 'Details Not Available');
});

// ─── create() stamps tbl_open_city.inserted_on as a bound Date ───────
// inserted_on is DATETIME; the pool serialises a bound JS Date as the IST
// wall clock regardless of host, whereas NOW() resolves in the DB session
// zone. A regression back to NOW() would silently drift under UTC hosts.
test('create() binds inserted_on as a Date, not NOW()', async () => {
  fake.reset();
  await svc.create({ requestFor: 0, pin: '700001', catgId: 3, comments: 'test' }, { user_id: 42 });
  const ins = fake.calls.find((c) => /INSERT INTO tbl_open_city/i.test(c.sql));
  assert.ok(ins, 'the tbl_open_city insert should have run');
  assert.doesNotMatch(ins.sql, /NOW\(\)/, 'inserted_on must be a bound Date, not NOW()');
  assert.ok(ins.params.at(-1) instanceof Date, 'inserted_on must be the last bound param');

  // supply_request_log.insert_time (TIMESTAMP) is stamped in the same
  // transaction, with the SAME Date as tbl_open_city.inserted_on.
  const log = fake.calls.find((c) => /INSERT INTO supply_request_log/i.test(c.sql));
  assert.ok(log, 'the supply_request_log insert should have run');
  assert.doesNotMatch(log.sql, /NOW\(\)/, 'insert_time must be a bound Date, not NOW()');
  const logDate = log.params.find((p) => p instanceof Date);
  assert.ok(logDate, 'insert_time must be a bound Date');
  assert.equal(logDate.getTime(), ins.params.at(-1).getTime(),
    'inserted_on and insert_time must stamp the same creation event identically');
});
