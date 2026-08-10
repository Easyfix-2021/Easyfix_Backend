/*
 * The customer name shown ON A JOB.
 *
 * THE PRODUCT RULE: a job displays the name typed on ITS booking
 * (`tbl_job.job_customer_name`). The customer-master name
 * (`tbl_customer.customer_name`) is keyed on the mobile number and shared by
 * every job that number ever booked, so it is the FALLBACK — used only when the
 * job carries no name of its own.
 *
 * THE TRAP THIS FILE EXISTS FOR: MySQL's COALESCE skips NULL and NOTHING ELSE.
 * `COALESCE('', cu.customer_name)` is `''`, not the fallback. `job_customer_name`
 * is written straight from a form field and the empty string is an ACCEPTED
 * request value — validators/job.validator.js declares it
 * `Joi.string().max(255).allow('', null)` on BOTH the create and the update
 * schema, create() stores it through `??` (which passes '' straight through),
 * and services/job-magic-link.service.js writes
 * `job_customer_name = COALESCE(?, job_customer_name)`, which also stores ''
 * verbatim. So the naive `COALESCE(j.job_customer_name, cu.customer_name)` form
 * renders a BLANK customer name for those rows. The guarded form
 * `COALESCE(NULLIF(TRIM(j.job_customer_name), ''), cu.customer_name)` is what
 * every job-keyed read must use, and the empty-string fallback is pinned below
 * as a first-class case rather than left to a code comment.
 *
 * ALSO PINNED, because each has broken production before:
 *   · the ALIAS stays `customer_name` — the CRM row key, the client-side search
 *     field and the XLSX exports all read that key;
 *   · display / sort / search are ONE expression, so a search cannot match rows
 *     the browser then hides (see tests/job-search-parity.test.js for why that
 *     failure mode is invisible);
 *   · COUNT-query join parity — the paginated list runs a SEPARATE COUNT whose
 *     joins are sniffed off the WHERE clause. The customer-name term must keep
 *     pulling in the tbl_customer join or the COUNT 500s;
 *   · this is a READ change: listing and reading a job issues no write.
 *
 * SCOPE GUARD: customer-MASTER surfaces (Manage Customers, customer detail,
 * lookup/dedupe-by-mobile) are keyed on tbl_customer and must keep showing the
 * master name. The write paths in this service (upsertCustomer, the
 * `customer.customer_name` UPDATE) are asserted untouched below.
 *
 * No DB: the shared pool singleton is faked BEFORE the services load, so every
 * statement is captured as a string instead of executed.
 *
 * Runner: `node --test`.
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { installFakePool } = require('./helpers/fake-pool');

// Install BEFORE requiring the services — both capture `pool` by reference at
// load time. COUNT must return a row shaped for list()'s `[[[{ total }]], …]`
// destructure.
const fake = installFakePool([
  [/SHOW COLUMNS/i, []],
  [/FROM easyfix_properties/i, []],
  [/SELECT COUNT\(\*\) AS total/i, [{ total: 0 }]],
]);
after(() => fake.restore());

const jobService = require('../services/job.service');
const { JOB_CUSTOMER_NAME_EXPR, SORTABLE_COLUMNS } = jobService;
const premature = require('../services/quicksight/quicksight-premature-confirmations.service');

beforeEach(() => { fake.reset(); });

// Collapse newlines/indentation so assertions read like the SQL does.
const flat = (s) => String(s).replace(/\s+/g, ' ').trim();
// Strip SQL block comments first — the prose around these expressions mentions
// the very column names being asserted on.
const sql = (s) => flat(String(s).replace(/\/\*[\s\S]*?\*\//g, ' '));

const dataQuery  = () => fake.calls.find((c) => /LIMIT \? OFFSET \?/.test(c.sql));
const countQuery = () => fake.calls.find((c) => /SELECT COUNT\(\*\) AS total/i.test(c.sql));
const detailQuery = () => fake.calls.find((c) => /WHERE j\.job_id = \? LIMIT 1/.test(c.sql));

// ─── THE TRAP: empty string must fall back ──────────────────────────

/*
 * A pure-JS mirror of the two candidate SQL forms, so the difference between
 * them is demonstrated rather than asserted about. MySQL semantics:
 *   COALESCE(a, b) → a unless a IS NULL
 *   NULLIF(x, '')  → NULL when x = '', else x
 *   TRIM(NULL)     → NULL
 */
const mysqlPlainCoalesce   = (job, master) => (job === null ? master : job);
const mysqlGuardedCoalesce = (job, master) => {
  const trimmed = job === null ? null : job.trim();
  return (trimmed === null || trimmed === '') ? master : trimmed;
};

test('THE TRAP: an EMPTY-STRING job name falls back to the master name', () => {
  // This is the whole reason the change carries NULLIF/TRIM. A booking saved
  // with the name field cleared must show the customer-master name, never a
  // blank cell.
  assert.equal(mysqlGuardedCoalesce('', 'Master Name'), 'Master Name');
  // And the form the codebase used before would have rendered a blank:
  assert.equal(mysqlPlainCoalesce('', 'Master Name'), '',
    'the plain COALESCE form returns the empty string — that IS the bug');
});

test('whitespace-only is the same case as empty', () => {
  assert.equal(mysqlGuardedCoalesce('   ', 'Master Name'), 'Master Name');
  assert.equal(mysqlPlainCoalesce('   ', 'Master Name'), '   ');
});

test('NULL falls back, and a real job name always WINS over the master', () => {
  assert.equal(mysqlGuardedCoalesce(null, 'Master Name'), 'Master Name');
  assert.equal(mysqlGuardedCoalesce('Booked Name', 'Master Name'), 'Booked Name');
  // Both names present is the ordinary case for a repeat mobile number: the job
  // wins. If this ever inverts, every re-booking shows the wrong name.
  assert.equal(mysqlGuardedCoalesce('Booked Name', null), 'Booked Name');
  // Neither present → NULL, which the FE renders as an em-dash.
  assert.equal(mysqlGuardedCoalesce(null, null), null);
});

test('the SQL expression is the guarded form, in the right order', () => {
  const e = flat(JOB_CUSTOMER_NAME_EXPR);
  assert.equal(e, "COALESCE(NULLIF(TRIM(j.job_customer_name), ''), cu.customer_name)");
  // Spelled out so a "simplifying" edit fails loudly rather than silently
  // blanking names in production.
  assert.match(e, /NULLIF\(\s*TRIM\(j\.job_customer_name\)\s*,\s*''\s*\)/,
    'the empty-string guard must not be dropped');
  assert.ok(e.indexOf('j.job_customer_name') < e.indexOf('cu.customer_name'),
    'the JOB name must be the preferred arm, the master the fallback');
});

// ─── The LIST projection ────────────────────────────────────────────

test('the LIST projects the job name under the UNCHANGED `customer_name` alias', async () => {
  await jobService.list({ limit: 50, offset: 0 });
  const s = sql(dataQuery().sql);
  assert.ok(s.includes(`${flat(JOB_CUSTOMER_NAME_EXPR)} AS customer_name`),
    `LIST must project the shared expression as customer_name — got: ${s.slice(0, 400)}`);
  // The old bare projection must be gone: it would have shadowed the alias.
  assert.doesNotMatch(s, /,\s*cu\.customer_name\s*,/,
    'a bare cu.customer_name is still being projected');
});

test('the DETAIL projects the SAME expression under the same alias', async () => {
  await jobService.getByIdCore(12345);
  const s = sql(detailQuery().sql);
  assert.ok(s.includes(`${flat(JOB_CUSTOMER_NAME_EXPR)} AS customer_name`),
    'the job modal and the list row must resolve the name identically');
  // `j.*` still carries the raw column for the Confirm-mode form field that
  // EDITS it — the alias must not have replaced it.
  assert.match(s, /SELECT j\.\*/);
});

test('tbl_job has no `customer_name` column, so `j.*` cannot shadow the alias', () => {
  // The detail query is `SELECT j.*, <expr> AS customer_name, …`. If tbl_job
  // ever grew a literal `customer_name` column, `j.*` would emit that key first
  // and mysql2's row object would be ambiguous. scripts/schema-verify.js is the
  // repo's declared tbl_job column set — assert the collision isn't there.
  const { readFileSync } = require('fs');
  const path = require('path');
  const src = readFileSync(path.join(__dirname, '..', 'scripts', 'schema-verify.js'), 'utf8');
  const tblJob = src.slice(src.indexOf('tbl_job:'), src.indexOf('tbl_job_services:'));
  assert.ok(tblJob.includes("'job_customer_name'"), 'job_customer_name must be a declared tbl_job column');
  assert.ok(!/'customer_name'/.test(tblJob), 'tbl_job must NOT declare a bare customer_name column');
});

// ─── Sort and search use the SAME expression ────────────────────────

test('the `customer_name` SORT key IS the projected expression', async () => {
  // Reference identity, not a lookalike string — they cannot be edited apart.
  assert.equal(SORTABLE_COLUMNS.customer_name, JOB_CUSTOMER_NAME_EXPR);
  await jobService.list({ sortBy: 'customer_name', sortDir: 'asc', limit: 50, offset: 0 });
  const s = sql(dataQuery().sql);
  const order = s.slice(s.lastIndexOf('ORDER BY'));
  assert.ok(order.includes(flat(JOB_CUSTOMER_NAME_EXPR)),
    `ORDER BY must sort on the displayed name — got: ${order}`);
  assert.match(order, /ASC, j\.job_id DESC LIMIT \? OFFSET \?$/);
});

test('the `customerQ` filter matches the DISPLAYED name, not the master alone', async () => {
  await jobService.list({ customerQ: 'asha', limit: 50, offset: 0 });
  const s = sql(countQuery().sql);
  assert.ok(s.includes(`${flat(JOB_CUSTOMER_NAME_EXPR)} LIKE ?`),
    'searching the master name alone returns rows whose visible name differs');
  // Still exactly two placeholders / two bound params (name + mobile).
  assert.deepEqual(countQuery().params, ['%asha%', '%asha%']);
});

test('the free-text `q` search matches the DISPLAYED name too', async () => {
  await jobService.list({ q: 'asha', limit: 50, offset: 0 });
  const s = sql(countQuery().sql);
  assert.ok(s.includes(`${flat(JOB_CUSTOMER_NAME_EXPR)} LIKE ?`),
    'the q predicate must match the same name the row shows');
  // One bound param per LIKE — a mismatch shifts every later param silently.
  const placeholders = (s.match(/LIKE \?/g) || []).length;
  assert.equal(countQuery().params.length, placeholders,
    `${countQuery().params.length} params bound for ${placeholders} LIKE placeholders`);
});

// ─── COUNT-query join parity (the recorded 500) ─────────────────────

test('COUNT-JOIN PARITY: a customer-name search still joins tbl_customer in COUNT', async () => {
  await jobService.list({ customerQ: 'asha', limit: 50, offset: 0 });
  const count = sql(countQuery().sql);
  // The expression names `cu.customer_name` inside itself, which is what keeps
  // the WHERE-alias sniffing adding this join. Drop the `cu` arm and COUNT 500s
  // with "Unknown column 'cu.customer_name'".
  assert.match(count, /LEFT JOIN tbl_customer cu ON cu\.customer_id = j\.fk_customer_id/);
  assert.match(count, /LEFT JOIN tbl_job_customer|FROM tbl_job j/);
});

test('COUNT-JOIN PARITY: the q search joins tbl_customer in COUNT as well', async () => {
  await jobService.list({ q: 'asha', limit: 50, offset: 0 });
  assert.match(sql(countQuery().sql),
    /LEFT JOIN tbl_customer cu ON cu\.customer_id = j\.fk_customer_id/);
});

test('COUNT and data queries share the SAME where + params', async () => {
  await jobService.list({ customerQ: 'asha', status: 0, limit: 50, offset: 0 });
  const count = countQuery();
  const data  = dataQuery();
  const where = count.sql.slice(count.sql.indexOf('WHERE')).trim();
  assert.ok(flat(data.sql).includes(flat(where)),
    'the data query must carry the COUNT query\'s exact WHERE');
  // data = count params + [limit, offset].
  assert.deepEqual(data.params.slice(0, count.params.length), count.params);
});

// ─── The QuickSight report row ──────────────────────────────────────

test('Premature Confirmations shows the job name, guarded, aliased customer_name', async () => {
  await premature.getPrematureConfirmations({ limit: 10 });
  const stmt = fake.calls.find((c) => /moved_by_confidence/.test(c.sql));
  assert.ok(stmt, 'the report query must have run');
  const s = sql(stmt.sql);
  assert.ok(
    s.includes("COALESCE(NULLIF(TRIM(j.job_customer_name), ''), cu.customer_name) AS customer_name"),
    `report must resolve the name like the jobs list — got: ${s.slice(0, 600)}`,
  );
  // The alias the FE table and the XLSX column both read.
  assert.match(s, /AS customer_name/);
  // The join the fallback arm depends on is present in the one statement.
  assert.match(s, /LEFT JOIN tbl_customer cu ON cu\.customer_id = j\.fk_customer_id/);
  // Single statement, no separate COUNT — nothing to keep in parity here.
  assert.ok(!/SELECT COUNT\(\*\)/i.test(stmt.sql));
});

test("the report's XLSX column still reads the `customer_name` key", () => {
  const { columns } = premature.toXlsx({ rows: [] });
  const col = columns.find((c) => c.key === 'customer_name');
  assert.ok(col, 'renaming the alias would silently blank the Customer column');
  assert.equal(col.header, 'Customer');
});

// ─── READ-ONLY: no write path moved ─────────────────────────────────

test('listing and reading a job issue ZERO writes', async () => {
  await jobService.list({ customerQ: 'asha', q: 'asha', sortBy: 'customer_name', limit: 50, offset: 0 });
  await jobService.getByIdCore(12345);
  await premature.getPrematureConfirmations({ limit: 10 });
  const writes = fake.calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(c.sql));
  assert.deepEqual(writes.map((w) => flat(w.sql)), [],
    'this is a projection change — no statement may write');
});

test('SCOPE: the customer-MASTER write still targets tbl_customer.customer_name', () => {
  // The rule is "the name shown ON A JOB changes; the customer RECORD does
  // not". Editing the master name must still write the master column — if this
  // ever got redirected at job_customer_name, Manage Customers would stop
  // working and every past job would keep a stale name.
  const { readFileSync } = require('fs');
  const path = require('path');
  const src = readFileSync(path.join(__dirname, '..', 'services', 'job.service.js'), 'utf8');
  assert.match(src, /INSERT INTO tbl_customer \(customer_name,/,
    'upsertCustomer must still insert the master name');
  assert.match(src, /custSets\.push\('customer_name = \?'\)/,
    'the master-name UPDATE must still target tbl_customer.customer_name');
});
