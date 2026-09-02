/*
 * ROUTE-LEVEL tests for the five HR master-data identifiers on the Manage
 * Users bulk-upload sheet (POST /api/admin/users/bulk-upload, cols J..N:
 * Date Of Joining, UAN, PAN, Aadhaar, Address).
 *
 * WHY AT THE ROUTE, NOT AT THE SERVICE
 * ────────────────────────────────────
 * services/user.service.js already validates and writes all five — that half is
 * covered elsewhere. Everything this feature ADDED lives between the uploaded
 * spreadsheet and the updateUser() call: which cell index is which field, what
 * an empty cell means, and what an ExcelJS cell VALUE actually is by the time
 * the parser sees it. None of that is reachable by calling the service, so
 * these tests post a REAL .xlsx / .csv at the REAL router and assert on the SQL
 * that came out the other end.
 *
 * THE FOUR THINGS PINNED
 * ──────────────────────
 *   1. A row that fills all five reaches tbl_user_personal_details with the
 *      values the shared normalisers produce — PAN uppercased and ENCRYPTED,
 *      Aadhaar separators stripped, last4 derived from the plaintext.
 *   2. Blank identifier cells leave the columns untouched. Blank is this
 *      sheet's "do not touch" signal for every other column and must stay so
 *      here, or a 500-row sheet with an empty PAN column wipes 500 PANs.
 *   3. An invalid PAN fails THAT ROW and nothing else. Bulk upload has no
 *      rollback by design; one bad cell in row 40 must not cost rows 2..39.
 *   4. Excel hands a date-formatted cell back as a JS DATE, not a string, and
 *      the two upload formats disagree about which midnight it is:
 *        · .xlsx  → 1990-05-04T00:00:00Z  (UTC midnight)
 *        · .csv   → 1990-05-03T18:30:00Z  (LOCAL midnight, on an IST host)
 *      Reading UTC parts off the second one yields 1990-05-03 — the employee
 *      joins a day early, silently, forever. Both are exercised below.
 *
 * TIMEZONE IS PINNED, NOT INHERITED. Test 4b can only fail on a host whose
 * local time is not UTC, so on a UTC CI runner a naive implementation would
 * pass it. TZ is forced to Asia/Kolkata at the top of this file and the offset
 * is ASSERTED, so a runtime that ignored the override reports itself instead of
 * quietly turning the test into a no-op.
 *
 * NO DATABASE, NO NETWORK. tests/helpers/fake-pool answers every read from
 * canned rows and RECORDS every (sql, params); nothing is written anywhere.
 * Runner: `node --test --test-force-exit`.
 */

/* Before ANY require: Date construction and the field-crypto key are both read
 * at module load, so setting these later would be setting them too late. */
process.env.TZ = 'Asia/Kolkata';
const crypto = require('node:crypto');
process.env.EASYFIX_FIELD_ENC_KEY = crypto.randomBytes(32).toString('base64');

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { installFakePool } = require('./helpers/fake-pool');

// Mutable per-test fixtures the fake pool routes read.
const scenario = {
  me: null,          // the tbl_user row updateUser loads to diff against
  templateRows: [],  // GET bulk-upload-template's pre-population query
  hrRows: [],        // that template's side-table identifier read
  hrError: null,     // set to make that read THROW, as a pre-migration host does
  userRole: 2,       // req.user.user_role — 2 is Admin, 7 is Finance (see tbl_role below)
};

function internalUser(overrides = {}) {
  return {
    user_id: 501, user_type_id: 5, user_code: 'E000501',
    mobile_no: '9000000001', alternate_no: null,
    user_role: 2, city_id: 1,
    manage_clients: null, manage_cities: null,
    manage_states: null, manage_verticals: null,
    reporting_manager: null, user_status: 1, ...overrides,
  };
}

const fake = installFakePool([
  /*
   * The side table FIRST, and the INSERT before the SELECT.
   * "tbl_user_personal_details" contains "tbl_user" as a substring, so any
   * tbl_user route placed above these would swallow them.
   */
  [/INSERT INTO tbl_user_personal_details/i, () => ({ affectedRows: 1 })],
  // The template's identifier read, matched on its projection so it is
  // distinguishable from loadPersonalEmail's read of the same table.
  [/SELECT user_id, date_of_joining, uan, address/i, () => {
    if (scenario.hrError) throw scenario.hrError;
    return scenario.hrRows;
  }],
  [/FROM tbl_user_personal_details/i, () => []],
  [/FROM tbl_user_allowed_stages/i, []],
  /*
   * role.service.loadRoles — feeds roleByName(['Admin']) on the route guards.
   * Finance is here so the guard can be tested against a role that IS in the
   * admin GROUP (so the upstream role(['admin']) guard would let it through)
   * but is NOT Admin. A single-row map could only ever prove the allow path.
   */
  [/SELECT role_id, role_name/i, [
    { role_id: 2, role_name: 'Admin',   role_status: 1, menu_ids: '' },
    { role_id: 7, role_name: 'Finance', role_status: 1, menu_ids: '' },
  ]],
  // The upload's name → id master maps (already LOWER()ed by the real SQL).
  [/FROM tbl_vertical\b/i, [{ id: 1, name: 'retail' }]],
  [/FROM tbl_client\b/i,   [{ id: 2, name: 'acme' }]],
  [/FROM tbl_state\b/i,    [{ id: 3, name: 'maharashtra' }]],
  [/FROM tbl_city\b/i,     [{ id: 7, name: 'mumbai' }]],
  [/FROM tbl_role\b/i,     [{ id: 2, name: 'admin' }]],
  [/FROM tbl_user\s+WHERE user_status/i, [{ id: 88, name: 'manager one' }]],
  [/FROM tbl_user\s+WHERE user_id/i, () => (scenario.me ? [scenario.me] : [])],
  // The template's pre-population query, matched on its unique alias so it is
  // not swallowed by getUserById's `FROM tbl_user  u` below.
  [/reporting_manager_name/i, () => scenario.templateRows],
  // getUserById — [] resolves to null, which updateUser returns and the route
  // reads as "not the __unchanged sentinel". These tests assert on the WRITE,
  // not on the projection.
  [/FROM tbl_user\s+u/i, []],
]);

const express = require('express');
const usersBulkRouter = require('../routes/admin/users-bulk');
const { decryptField } = require('../lib/field-crypto');

let server;
let baseUrl;
let lastError = null;

// Column order the router writes and reads. Any drift between this and the
// route's own `headers` array is the bug these tests exist to catch.
const HEADERS = [
  'user ID', 'user name', 'Role', 'Reporting Manager',
  'Manage Vertical(s)', 'Manage Client(s)', 'Manage State(s)',
  'Manage Cities', 'Home City',
  'Date Of Joining', 'UAN', 'PAN', 'Aadhaar', 'Address',
];

/* A data row with only user ID filled; callers set the cells they care about. */
function blankRow(userId = 501) {
  const r = new Array(HEADERS.length).fill('');
  r[0] = userId;
  return r;
}

before(async () => {
  const app = express();
  /*
   * Stand-in for routes/admin/index.js — the only thing the bulk router needs
   * from upstream is req.user, because roleByName(['Admin']) resolves the role
   * itself. scenario.userRole defaults to 2 (Admin) and is reset per test.
   */
  app.use((req, _res, next) => {
    req.user = { user_id: 99, user_name: 'HR Admin', user_role: scenario.userRole };
    next();
  });
  app.use('/users', usersBulkRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    lastError = err;
    res.status(err.status || 500).json({ success: false, error: String(err && err.message) });
  });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  fake.restore();
});

beforeEach(() => {
  fake.calls.length = 0;
  lastError = null;
  scenario.me = internalUser();
  scenario.templateRows = [];
  scenario.hrRows = [];
  scenario.hrError = null;
  scenario.userRole = 2;
});

async function xlsxBuffer(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Users');
  ws.addRow(HEADERS);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function postSheet(buf, filename) {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), filename);
  const res = await fetch(`${baseUrl}/users/bulk-upload`, { method: 'POST', body: fd });
  const body = await res.json();
  return { status: res.status, body, why: () => `${res.status} ${JSON.stringify(body)}`
    + (lastError ? ` — handler threw: ${lastError.message}` : '') };
}

/*
 * Every identifier write the fake pool saw, decoded back into
 * { user_id, <column>: <param> }. The INSERT's column list is DYNAMIC — only
 * the supplied identifiers appear — so the columns are parsed out of the SQL
 * and zipped with the params rather than read at fixed offsets.
 */
function identifierWrites() {
  return fake.calls
    .filter((c) => /INSERT INTO tbl_user_personal_details/i.test(c.sql))
    .map((c) => {
      const cols = c.sql.match(/\(user_id, (.+?), created_on, updated_on\)/)[1]
        .split(',').map((s) => s.trim());
      const out = { user_id: c.params[0] };
      cols.forEach((col, i) => { out[col] = c.params[i + 1]; });
      return out;
    });
}

// ── 0. The timezone this file's date assertions depend on ────────────
/*
 * Guard, not a feature test. Test 4b distinguishes UTC-midnight from
 * LOCAL-midnight parsing, and on a UTC host those are the same instant — a
 * broken implementation would pass. If this assertion ever fails, test 4b is
 * not testing what its name claims and must be read as inconclusive.
 */
test('the runner honours TZ=Asia/Kolkata, or test 4b proves nothing', () => {
  assert.equal(new Date().getTimezoneOffset(), -330,
    'expected IST (UTC+05:30). This runtime ignored process.env.TZ, so the '
    + 'local-midnight case below cannot distinguish a correct parser from a '
    + 'naive toISOString() one.');
});

// ── 1. A row that sets all five ──────────────────────────────────────

test('a row filling all five identifiers writes all five, normalised and encrypted', async () => {
  const row = blankRow(501);
  row[9]  = '2021-07-19';          // Date Of Joining
  row[10] = 123456789012;          // UAN — a NUMBER cell, as Excel stores 12 digits
  row[11] = 'abcde1234f';          // PAN — lowercase, must be uppercased
  row[12] = '7307 8151 9521';      // Aadhaar — printed in 4-4-4 groups
  row[13] = '  Flat 4,\n Nerul  '; // Address — pasted multi-line, must collapse

  const res = await postSheet(await xlsxBuffer([row]), 'users.xlsx');
  assert.equal(res.status, 200, res.why());
  assert.equal(res.body.data.summary.updated, 1, res.why());
  assert.equal(res.body.data.results[0].status, 'updated', res.why());

  const writes = identifierWrites();
  assert.equal(writes.length, 1, 'expected exactly one identifier upsert');
  const w = writes[0];
  assert.equal(w.user_id, 501);
  assert.equal(w.date_of_joining, '2021-07-19');
  assert.equal(w.uan, '123456789012', 'a numeric UAN cell must survive as 12 digits');
  assert.equal(w.address, 'Flat 4, Nerul', 'newlines collapse, ends trim');

  // The two protected ones: ciphertext in the column, plaintext last4 beside it.
  assert.notEqual(w.pan, 'ABCDE1234F', 'PAN must never be stored in plaintext');
  assert.equal(decryptField(w.pan), 'ABCDE1234F', 'PAN must round-trip, uppercased');
  assert.equal(w.pan_last4, '234F');
  assert.notEqual(w.aadhaar, '730781519521', 'Aadhaar must never be stored in plaintext');
  assert.equal(decryptField(w.aadhaar), '730781519521', 'separators are stripped, not rejected');
  assert.equal(w.aadhaar_last4, '9521');
});

// ── 2. Blank identifier cells leave the columns untouched ────────────

test('blank identifier cells touch no identifier column, even on a row that IS updated', async () => {
  // Home City changes (me.city_id is 1, Mumbai is 7) so the row is genuinely
  // written — this must not be a row that was skipped for unrelated reasons.
  const row = blankRow(501);
  row[8] = 'Mumbai';

  const res = await postSheet(await xlsxBuffer([row]), 'users.xlsx');
  assert.equal(res.status, 200, res.why());
  assert.equal(res.body.data.results[0].status, 'updated', res.why());
  assert.ok(
    fake.calls.some((c) => /UPDATE tbl_user SET/i.test(c.sql)),
    'the row must actually have been written, or this proves nothing',
  );
  assert.deepEqual(identifierWrites(), [],
    'a blank cell means "leave unchanged" — it must never reach the side table, '
    + 'or an empty PAN column wipes every PAN in the sheet');
});

test('a row with nothing but blank identifier cells is skipped, not written', async () => {
  const res = await postSheet(await xlsxBuffer([blankRow(501)]), 'users.xlsx');
  assert.equal(res.status, 200, res.why());
  assert.equal(res.body.data.results[0].status, 'skipped', res.why());
  assert.equal(res.body.data.results[0].reason, 'no fields filled');
  assert.deepEqual(identifierWrites(), []);
});

// ── 3. One bad identifier fails one row ──────────────────────────────

test('an invalid PAN fails ONLY its own row — the rest of the upload still lands', async () => {
  const good1 = blankRow(501);
  good1[11] = 'ABCDE1234F';

  const bad = blankRow(502);
  bad[11] = 'NOTAPAN';            // wrong shape — rejected by normalisePan

  const good2 = blankRow(503);
  good2[9] = '2024-01-15';

  const res = await postSheet(await xlsxBuffer([good1, bad, good2]), 'users.xlsx');
  assert.equal(res.status, 200, res.why());

  const { summary, results } = res.body.data;
  assert.equal(summary.failed, 1, res.why());
  assert.equal(summary.updated, 2, 'the two clean rows must still be applied');

  assert.equal(results[0].status, 'updated');
  assert.equal(results[1].status, 'failed');
  assert.equal(results[1].userId, 502);
  assert.match(results[1].errors[0], /pan/i, JSON.stringify(results[1]));
  assert.equal(results[2].status, 'updated');

  // The failing row must not have half-applied: no identifier write for 502.
  const writes = identifierWrites();
  assert.deepEqual(writes.map((w) => w.user_id), [501, 503],
    'the rejected row must write nothing at all');
});

// ── 4. Excel hands back Dates, and the two formats disagree ──────────

test('4a — an .xlsx date CELL (a JS Date at UTC midnight) normalises to YYYY-MM-DD', async () => {
  const row = blankRow(501);
  // What Excel produces when the operator types a date into a date-formatted
  // cell: exceljs reads the serial back as a Date, never as a string.
  row[9] = new Date(Date.UTC(1990, 4, 4));

  const res = await postSheet(await xlsxBuffer([row]), 'users.xlsx');
  assert.equal(res.status, 200, res.why());
  assert.equal(res.body.data.results[0].status, 'updated',
    `a real date cell must not be rejected as malformed — ${res.why()}`);
  assert.equal(identifierWrites()[0].date_of_joining, '1990-05-04');
});

test('4b — a .csv date (a JS Date at LOCAL midnight) normalises to the SAME day, not the day before', async () => {
  /*
   * Hand-written CSV rather than exceljs's writer: the point is the text an
   * operator's export actually contains, and exceljs's CSV READER turns
   * "1990-05-04" into a Date at LOCAL midnight — 1990-05-03T18:30:00Z on this
   * IST host. A parser that reads .toISOString() off that Date reports
   * 1990-05-03 and backdates the employee's joining by one day.
   */
  const csv = `${HEADERS.join(',')}\n501,,,,,,,,,1990-05-04,,,,\n`;
  const res = await postSheet(Buffer.from(csv, 'utf8'), 'users.csv');
  assert.equal(res.status, 200, res.why());
  assert.equal(res.body.data.results[0].status, 'updated', res.why());
  assert.equal(identifierWrites()[0].date_of_joining, '1990-05-04',
    'off by one day here means the CSV branch is reading UTC parts off a '
    + 'local-midnight Date');
});

test('4c — a text date and a full ISO timestamp both reduce to the date half', async () => {
  for (const [cell, expected] of [
    ['2024-03-09', '2024-03-09'],
    ['2024-03-09T00:00:00.000Z', '2024-03-09'],
  ]) {
    fake.calls.length = 0;
    const row = blankRow(501);
    // A string cell, not a date cell — exceljs only produces a Date when the
    // value it is handed is one, so this exercises the string branch.
    row[9] = cell;
    const res = await postSheet(await xlsxBuffer([row]), 'users.xlsx');
    assert.equal(res.body.data.results[0].status, 'updated', `${cell} — ${res.why()}`);
    assert.equal(identifierWrites()[0].date_of_joining, expected, cell);
  }
});

// ── 5. Identifiers alone are enough to constitute an edit ────────────
/*
 * The bulk sheet's whole purpose is an HR run that fills ONLY these five
 * columns. updateUser counts supplied fields to tell "operator sent nothing"
 * (a real 400) from "operator sent values that all match" (a no-op), and until
 * the identifiers were counted there, such a row 400'd with "No mutable fields
 * supplied" while the operator was plainly supplying one — and a row whose
 * tbl_user columns happened to match returned the __unchanged sentinel BEFORE
 * the identifier write, losing the values and reporting success.
 */
test('a row supplying ONLY identifiers is a real edit, not "No mutable fields supplied"', async () => {
  const row = blankRow(501);
  row[9] = '2021-07-19';

  const res = await postSheet(await xlsxBuffer([row]), 'users.xlsx');
  assert.equal(res.body.data.summary.failed, 0,
    `identifiers alone must constitute an edit — ${res.why()}`);
  assert.equal(res.body.data.results[0].status, 'updated', res.why());
  assert.equal(identifierWrites().length, 1);
});

test('identifiers still write when every tbl_user column in the row already matches', async () => {
  // Home City echoes the stored city_id, so the column diff is empty and the
  // no-op short-circuit is the branch under test.
  scenario.me = internalUser({ city_id: 7 });
  const row = blankRow(501);
  row[8]  = 'Mumbai';        // already the stored value
  row[11] = 'ABCDE1234F';    // the only real change

  const res = await postSheet(await xlsxBuffer([row]), 'users.xlsx');
  assert.equal(res.status, 200, res.why());
  assert.notEqual(res.body.data.results[0].status, 'unchanged',
    'reporting "unchanged" here would mean the PAN was silently dropped');
  assert.equal(identifierWrites().length, 1,
    'the identifier write must survive the no-change short-circuit on the '
    + 'tbl_user columns');
});

// ── 6. The template: five new headers, and PAN / Aadhaar never on it ──
/*
 * The blank PAN / Aadhaar cells on a PRE-POPULATED template are a deliberate
 * security decision, and a decision with no test is a decision that survives
 * only as long as nobody "helpfully" completes the pre-fill. Two ways it could
 * be undone, both caught here:
 *
 *   · Selecting the columns at all. A decrypted PAN in a downloadable workbook
 *     strips the at-rest envelope off every selected employee in one click.
 *   · Writing a MASK instead of a blank. Blank is this sheet's "leave
 *     unchanged" signal; a mask is a non-empty cell the parser would feed to
 *     normalisePan, so an untouched re-upload would either fail the row or
 *     overwrite a real ID with asterisks.
 */
test('the template carries the five new headers and never the two protected values', async () => {
  scenario.templateRows = [{
    user_id: 501, user_name: 'Asha R', role_name: 'Admin',
    reporting_manager_name: 'Manager One',
    manage_verticals: null, manage_clients: null,
    manage_states: null, manage_cities: null,
    home_city_name: 'Mumbai',
  }];
  scenario.hrRows = [{
    user_id: 501, date_of_joining: '2021-07-19',
    uan: '123456789012', address: 'Flat 4, Nerul',
  }];

  const res = await fetch(`${baseUrl}/users/bulk-upload-template?userIds=501`);
  assert.equal(res.status, 200,
    `${res.status}${lastError ? ` — handler threw: ${lastError.message}` : ''}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const ws = wb.getWorksheet('Users');

  const headerRow = ws.getRow(1);
  const got = HEADERS.map((_, i) => headerRow.getCell(i + 1).value);
  assert.deepEqual(got, HEADERS,
    'the template header row and the parser\'s cell indexes must not drift');

  const r = ws.getRow(2);
  assert.equal(r.getCell(10).value, '2021-07-19', 'Date Of Joining pre-fills');
  assert.equal(r.getCell(11).value, '123456789012', 'UAN pre-fills');
  assert.equal(r.getCell(14).value, 'Flat 4, Nerul', 'Address pre-fills');
  for (const [col, label] of [[12, 'PAN'], [13, 'Aadhaar']]) {
    const v = r.getCell(col).value;
    assert.ok(v === null || v === '',
      `${label} must ship BLANK on a pre-populated template, got ${JSON.stringify(v)}. `
      + 'Blank is the only value that round-trips losslessly — a plaintext value '
      + 'leaks the encrypted ID, and a mask would be re-uploaded as if the '
      + 'operator had typed it.');
  }

  // Belt and braces: the route must not even ASK the database for them, so a
  // future projection change is caught before it can reach a cell.
  const sel = fake.calls.find((c) => /FROM tbl_user_personal_details/i.test(c.sql));
  assert.ok(sel, 'the template must read the side table');
  assert.doesNotMatch(sel.sql, /\bpan\b|\baadhaar\b/i,
    'the template query must not select the encrypted identifiers at all');
});

test('the template still builds when the HR side table is missing (pre-migration host)', async () => {
  // A host without 2026-09-02-add-hr-identifiers-user-personal-details.sql must
  // lose five optional cells, never the whole download.
  scenario.templateRows = [{
    user_id: 501, user_name: 'Asha R', role_name: 'Admin',
    reporting_manager_name: null,
    manage_verticals: null, manage_clients: null,
    manage_states: null, manage_cities: null, home_city_name: null,
  }];
  scenario.hrError = Object.assign(
    new Error("Table 'easyfix_core.tbl_user_personal_details' doesn't exist"),
    { code: 'ER_NO_SUCH_TABLE', errno: 1146 },
  );

  const res = await fetch(`${baseUrl}/users/bulk-upload-template?userIds=501`);
  assert.equal(res.status, 200,
    `a missing side table must not 500 the template${lastError ? ` — ${lastError.message}` : ''}`);
});

/*
 * The template is ADMIN-ONLY, like the POST that consumes it.
 *
 * It used to carry nothing but names and scope CSVs, so the router-level
 * role(['admin']) GROUP guard was enough and this route carried no guard of its
 * own. Adding Date Of Joining, UAN and Address changed what a download is worth:
 * `userIds` is uncapped, so one request by any of the ten admin-group roles
 * would have returned the HR identifiers of every internal user as a
 * spreadsheet. Nothing else in this file can see that — every other test runs as
 * Admin — so the guard needs its own.
 */
test('a non-Admin admin-group role cannot download the template at all', async () => {
  scenario.userRole = 7; // Finance: admin group, read-only, cannot edit a user
  scenario.templateRows = [{
    user_id: 501, user_name: 'Asha R', role_name: 'Admin',
    reporting_manager_name: null,
    manage_verticals: null, manage_clients: null,
    manage_states: null, manage_cities: null, home_city_name: null,
  }];
  scenario.hrRows = [{
    user_id: 501, date_of_joining: '2021-07-19',
    uan: '123456789012', address: 'Flat 4, Nerul',
  }];

  const res = await fetch(`${baseUrl}/users/bulk-upload-template?userIds=501`);
  assert.equal(res.status, 403, 'Finance must not reach the HR identifier sheet');
  // The 403 has to land BEFORE the read, not merely hide its output — a guard
  // that ran after the query would still be a harvest, just a quieter one.
  assert.equal(
    fake.calls.filter((c) => /date_of_joining/i.test(c.sql)).length, 0,
    'the identifier query must never run for a role that cannot have the answer',
  );
});
