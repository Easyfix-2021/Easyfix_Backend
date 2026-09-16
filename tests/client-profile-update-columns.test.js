/*
 * updateClient — the Client Profile write path.
 *
 * Three behaviours this pins, each of which fails silently and expensively if
 * it regresses:
 *
 *   1. THE NEW PRESENTATION NAMES REACH THEIR COLUMNS. displayName /
 *      billingName / techAppName are camelCase on the wire and snake_case in
 *      the DB; a missing CAMEL_TO_SNAKE entry does not throw, it just drops the
 *      field. The operator sees "Client updated." and the value is gone.
 *
 *   2. AN EMPTY billing_start_date BECOMES NULL. Clearing the invoice start
 *      date sends ''. MySQL stores '' in a DATE as the zero date '0000-00-00'
 *      under a lax sql_mode, and rejects the whole UPDATE under STRICT — so
 *      one blank field either corrupts the row or takes the other fields down
 *      with it. Only this column gets the coercion; '' is a legitimate value
 *      for every text column beside it, and blanket-nulling would make
 *      "clear this field" impossible everywhere else.
 *
 *   3. A COLUMN THIS DB DOES NOT HAVE IS SKIPPED, NOT EMITTED. display_name
 *      arrives with migrations/2026-08-25-client-profile-names.sql; until that
 *      is applied the column probe must drop it rather than emit SQL that
 *      errors 1054 and fails the entire save.
 *
 * The probe memoises per process, so this file deliberately runs ONE column
 * set — one that has tech_app_name and billing_start_date but NOT
 * display_name — which is exactly the half-migrated shape worth testing.
 *
 * Runner: `node --test`.
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/* The probe's shape: INFORMATION_SCHEMA rows of { COLUMN_NAME }. */
const COLUMNS = [
  'client_id', 'client_name', 'client_email', 'client_status',
  'billing_name', 'billing_cycle', 'billing_raised', 'billing_start_date',
  'tech_app_name',            // migrated
  // 'display_name'           // ← deliberately absent: migration not applied
  'insert_date', 'update_date', 'updated_by',
].map((c) => ({ COLUMN_NAME: c }));

const fake = installFakePool([
  [/INFORMATION_SCHEMA\.COLUMNS/i, COLUMNS],
  [/^UPDATE tbl_client/i, { affectedRows: 1 }],
  [/^INSERT INTO tbl_client/i, () => ({ insertId: 999 })],
]);

const svc = require('../services/client.service');

/* The UPDATE statement the service emitted, plus its bound values. */
let stmt;

before(async () => {
  await svc.updateClient(133, {
    displayName: 'Brightline Retail',
    billingName: 'Brightline Retail Private Limited',
    techAppName: 'Brightline',
    billingRaised: 1,
    billingCycle: '1,15',
    billingStartDate: '',
  }, 7);
  stmt = fake.calls.find((c) => /^UPDATE tbl_client/i.test(c.sql));
  assert.ok(stmt, 'updateClient must emit exactly one UPDATE');
});

/* Reads the value bound to `col = ?` by counting placeholders before it. */
function boundValue(col) {
  const sets = stmt.sql.replace(/^UPDATE tbl_client SET /i, '').split(' WHERE ')[0];
  const assignments = sets.split(', ');
  let paramIndex = 0;
  for (const a of assignments) {
    const [name, rhs] = a.split(' = ');
    if (rhs !== '?') continue;               // e.g. a bare SQL literal, not a bound param
    if (name === col) return stmt.params[paramIndex];
    paramIndex += 1;
  }
  return undefined;
}

test('billingName reaches the pre-existing billing_name column', () => {
  assert.equal(boundValue('billing_name'), 'Brightline Retail Private Limited');
});

test('techAppName reaches tech_app_name', () => {
  assert.equal(boundValue('tech_app_name'), 'Brightline');
});

test('billingCycle is written as the CSV STRING it is, not coerced to a number', () => {
  assert.equal(boundValue('billing_cycle'), '1,15',
    'billing_cycle is a comma-separated list of days (40 = last of month), not an int');
});

test("an empty billingStartDate is written as NULL, never ''", () => {
  assert.ok(/billing_start_date = \?/.test(stmt.sql), 'the column must still be written');
  assert.equal(boundValue('billing_start_date'), null,
    "'' in a DATE column is the zero date under a lax sql_mode and a hard error under STRICT");
});

test('update_date is bound as a Date, not NOW()', () => {
  // tbl_client.update_date is TIMESTAMP — bound as a Date, never NOW(): the
  // pool is `timezone: '+05:30'`, so a JS Date serialises to the IST wall
  // clock the column expects, whereas NOW() resolves in the DB session zone.
  assert.doesNotMatch(stmt.sql, /update_date = NOW\(\)/i);
  assert.ok(boundValue('update_date') instanceof Date, 'update_date must be a bound Date');
});

test('display_name is DROPPED while its migration is unapplied', () => {
  assert.ok(!/display_name/.test(stmt.sql),
    'emitting a column this DB lacks would fail the whole save with ER_BAD_FIELD_ERROR 1054');
});

test('the unapplied column does not shift the other bindings', () => {
  // The regression this guards: dropping a column from the SET list but not
  // from the values array silently writes every later field into the wrong
  // column. Re-reading each one by position proves the pairing held.
  assert.equal(boundValue('billing_name'), 'Brightline Retail Private Limited');
  assert.equal(boundValue('billing_raised'), 1);
  assert.equal(stmt.params[stmt.params.length - 1], 133, 'client_id must be the last binding');
});

test('createClient binds insert_date and update_date as the SAME Date, not NOW()', async () => {
  fake.reset();
  await svc.createClient({ clientName: 'New Co' }, 7);
  const ins = fake.calls.find((c) => /^INSERT INTO tbl_client/i.test(c.sql));
  assert.ok(ins, 'createClient must emit exactly one INSERT');
  assert.doesNotMatch(ins.sql, /NOW\(\)/, 'insert_date/update_date must be bound Dates, not NOW()');
  const cols = ins.sql.replace(/^INSERT INTO tbl_client \(/i, '').split(')')[0].split(', ');
  const insertDateIdx = cols.indexOf('insert_date');
  const updateDateIdx = cols.indexOf('update_date');
  assert.ok(insertDateIdx >= 0 && updateDateIdx >= 0, 'both audit columns must be emitted');
  assert.ok(ins.params[insertDateIdx] instanceof Date, 'insert_date must be a bound Date');
  assert.ok(ins.params[updateDateIdx] instanceof Date, 'update_date must be a bound Date');
  assert.equal(ins.params[insertDateIdx].getTime(), ins.params[updateDateIdx].getTime(),
    'a new client stamps insert_date and update_date identically');
});
