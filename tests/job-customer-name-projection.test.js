/*
 * Unit tests for the JOB-scoped customer-name projection (2026-08-03).
 *
 * THE PRODUCT RULE. The name typed on the booking page is stored on
 * `tbl_job.job_customer_name` — a PER-JOB override of the customer-master
 * `tbl_customer.customer_name` (see the MUTABLE_COLUMNS note in
 * services/job.service.js). Anywhere a name is rendered as "the customer on
 * THIS JOB" it must prefer the job-row copy and fall back to the master name.
 * Customer-MASTER surfaces (Manage Customers, customer lookup / dedupe, and
 * Gallabox's contact-book `recipient.name`) deliberately keep the master name.
 *
 * THE TRAP THIS FILE EXISTS FOR. In MySQL, COALESCE returns the first NON-NULL
 * argument — '' is non-null. So the widespread
 *
 *     COALESCE(j.job_customer_name, cu.customer_name)
 *
 * renders a BLANK customer name for any job whose job_customer_name is an
 * empty string, silently swallowing the master-name fallback. The correct form
 * — the one every site in this file must use — is
 *
 *     COALESCE(NULLIF(TRIM(j.job_customer_name), ''), cu.customer_name)
 *
 * Is '' reachable? Not in today's data — a prod probe on 2026-08-03 over
 * 481,027 tbl_job rows found 358,332 NULL and ZERO rows that were '' or
 * whitespace-only. But it is reachable by CODE, which is what matters for a
 * projection that has to hold going forward:
 *   - validators/job.validator.js declares
 *     `job_customer_name: Joi.string().max(255).allow('', null)` on BOTH the
 *     create and the update body, so '' passes validation;
 *   - services/job.service.js create() binds
 *     `input.job_customer_name ?? input.customer?.customer_name ?? null`
 *     — `??` guards null/undefined only, so '' flows straight to the INSERT;
 *   - services/job.service.js update() binds `input[col]` verbatim for
 *     job_customer_name, so PATCH {"job_customer_name": ""} stores ''.
 * One blank form field is all it takes.
 *
 * HOW THESE TESTS WORK. They do not string-match the SQL and call it a day.
 * They EXTRACT the real projection expression out of the shipped code (from
 * the SQL the fake pool actually receives, and from the route file's source)
 * and run it through `evalCustomerNameExpr` — a tiny evaluator that reproduces
 * MySQL's COALESCE / NULLIF / TRIM semantics for exactly these two shapes.
 * Reverting either site to the plain COALESCE form therefore fails the
 * empty-string assertion on BEHAVIOUR, not on formatting. (The evaluator is
 * itself pinned as non-vacuous below: it is asserted to reproduce the '' leak
 * when handed the plain form.)
 *
 * Non-destructive: fake pool, no real DB, zero writes. Runner: `node --test`.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installFakePool } = require('./helpers/fake-pool');

/* ── MySQL semantics for the two expression shapes ───────────────────────── */

const GUARDED = /^COALESCE\(\s*NULLIF\(\s*TRIM\(\s*j\.job_customer_name\s*\)\s*,\s*''\s*\)\s*,\s*([a-z]+)\.customer_name\s*\)$/i;
const PLAIN   = /^COALESCE\(\s*j\.job_customer_name\s*,\s*([a-z]+)\.customer_name\s*\)$/i;

/*
 * Evaluate a customer-name projection the way MySQL would, against a row of
 * { job_customer_name, customer_name }. Throws on any shape it does not
 * recognise — a site rewritten into some third form must come back here and
 * declare its semantics rather than quietly opting out of the trap check.
 */
function evalCustomerNameExpr(expr, row) {
  const norm = String(expr).replace(/\s+/g, ' ').trim();
  const master = row.customer_name === undefined ? null : row.customer_name;

  if (GUARDED.test(norm)) {
    // TRIM(NULL) = NULL; NULLIF(x, '') = NULL when x = ''.
    const trimmed = row.job_customer_name == null ? null : String(row.job_customer_name).trim();
    const nullified = trimmed === '' ? null : trimmed;
    return nullified == null ? master : nullified;
  }
  if (PLAIN.test(norm)) {
    // COALESCE returns the first NON-NULL argument — '' qualifies.
    return row.job_customer_name == null ? master : row.job_customer_name;
  }
  throw new Error(`unrecognised customer-name expression: ${norm}`);
}

// Strip SQL/JS block comments so prose about COALESCE can't be mistaken for code.
const stripComments = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, ' ');

/*
 * Pull `<expr> AS customer_name` off whichever statement/source is handed in.
 * The alias is matched with a \b so `AS customer_master_name` cannot satisfy it.
 */
function extractCustomerNameExpr(sql) {
  const m = /^\s*(\S.*?)\s+AS\s+customer_name\b\s*,?\s*$/m.exec(stripComments(sql));
  assert.ok(m, `no "... AS customer_name" projection found in:\n${sql}`);
  return m[1];
}

/* ── The evaluator must be able to TELL THE TWO FORMS APART ──────────────── */

test('the evaluator is not vacuous: the PLAIN COALESCE form really does leak ""', () => {
  /*
   * If this ever stopped being true, every "empty string falls back" assertion
   * below would pass no matter what the code did. Pin the bug itself.
   */
  const plain = "COALESCE(j.job_customer_name, cu.customer_name)";
  assert.equal(
    evalCustomerNameExpr(plain, { job_customer_name: '', customer_name: 'Master Cu' }), '',
    'plain COALESCE must return the empty string — that is the bug being fixed',
  );
  assert.equal(
    evalCustomerNameExpr(plain, { job_customer_name: null, customer_name: 'Master Cu' }), 'Master Cu',
    'plain COALESCE does still handle NULL — which is why the bug hid for so long',
  );
  assert.throws(
    () => evalCustomerNameExpr('cu.customer_name', {}),
    /unrecognised customer-name expression/,
    'a site that drops the job-row override entirely must fail loudly, not silently pass',
  );
});

/*
 * The shared behavioural contract every job-scoped site must satisfy. Fed the
 * expression lifted out of real shipped code.
 */
function assertJobScopedFallback(expr, label) {
  const cases = [
    ['Booked Name',   'Booked Name', 'the booked name wins over the master name'],
    [null,            'Master Cu',   'NULL falls back to the customer-master name'],
    ['',              'Master Cu',   'THE TRAP: an EMPTY STRING falls back, never renders blank'],
    ['   ',           'Master Cu',   'whitespace-only is empty too — TRIM makes it fall back'],
    ['  Padded  ',    'Padded',      'a real name is returned trimmed'],
  ];
  for (const [jobName, expected, why] of cases) {
    assert.equal(
      evalCustomerNameExpr(expr, { job_customer_name: jobName, customer_name: 'Master Cu' }),
      expected,
      `${label}: ${why} (job_customer_name=${JSON.stringify(jobName)})`,
    );
  }
  // Both sides missing must stay NULL — never the string "null"/"undefined".
  assert.equal(
    evalCustomerNameExpr(expr, { job_customer_name: null, customer_name: null }), null,
    `${label}: no name anywhere stays NULL for the JS-side "|| ''" to handle`,
  );
}

/* ═══ SITE 1 — services/enquiry-notification.service.js ═══════════════════
 *
 * loadEnquiryContext() feeds BOTH Gallabox enquiry templates. Driven live
 * through the fake pool, whose handler evaluates the SELECT's own projection
 * — so the row the service consumes is computed by the shipped SQL, not by a
 * hand-written fixture that could drift away from it.
 */

// Mutable fixture the fake pool projects on each call.
let jobRow = {};

const fake = installFakePool([
  [/FROM information_schema\.columns/i, [{ n: 3 }]],
  [/FROM tbl_job j/i, (sql) => [{
    job_id: 4242,
    client_ref_id: 'CRF-1',
    fk_client_id: 7,
    client_name: 'Acme Retail',
    // The projection under test, evaluated with MySQL semantics.
    customer_name: evalCustomerNameExpr(extractCustomerNameExpr(sql), jobRow),
    // `cu.customer_name AS customer_master_name` — the raw master value.
    customer_master_name: jobRow.customer_name,
    customer_mob_no: '9876543210',
    spoc_contact_name: 'Spoc Person',
    spoc_contact_no: '9000000001',
    client_spoc_name: null,
    client_spoc: '9000000002',
    enquiry_reason: 'Customer not available',
    ticket_created_fmt: '01-08-2026 10:00',
    age_days: 2,
  }]],
]);

const enquiry = require('../services/enquiry-notification.service');
const gallabox = require('../services/gallabox.whatsapp.service');

// Capture Gallabox sends instead of performing them (no network, no BSP).
const sends = [];
gallabox.sendTemplate = async (args) => { sends.push(args); return { delivered: true }; };

const contextQuery = () => fake.calls.find((c) => /FROM tbl_job j/i.test(c.sql));
const sentTemplate = (name) => sends.find((s) => s.templateName === name);

beforeEach(() => { fake.reset(); sends.length = 0; jobRow = {}; });

test('enquiry context: the projection uses the NULLIF/TRIM form and behaves', async () => {
  jobRow = { job_customer_name: 'Booked Name', customer_name: 'Master Cu' };
  await enquiry.sendEnquiryWhatsapp(4242);
  const expr = extractCustomerNameExpr(contextQuery().sql);
  assert.match(expr, GUARDED, `enquiry context must use the guarded form, got: ${expr}`);
  assertJobScopedFallback(expr, 'enquiry-notification');
});

test('enquiry context: the alias the service consumes is still `customer_name`', async () => {
  jobRow = { job_customer_name: 'Booked Name', customer_name: 'Master Cu' };
  await enquiry.sendEnquiryWhatsapp(4242);
  // sendEnquiryWhatsapp reads ctx.customer_name; renaming the alias would
  // silently blank every template variable rather than throw.
  assert.match(stripComments(contextQuery().sql), /\bAS customer_name\b/);
  assert.equal(sentTemplate('spoc_enquiry').bodyValues.customer_name, 'Booked Name');
  assert.equal(sentTemplate('cx_enquiry').bodyValues.customer_name, 'Booked Name');
});

test('THE TRAP, END TO END: "" job_customer_name still sends the MASTER name', async () => {
  /*
   * The whole reason this change exists. With the plain COALESCE form the two
   * templates would go out with a blank `customer_name` variable — which some
   * BSPs reject outright, so the customer gets NO message at all.
   */
  jobRow = { job_customer_name: '', customer_name: 'Master Cu' };
  await enquiry.sendEnquiryWhatsapp(4242);
  assert.equal(sentTemplate('spoc_enquiry').bodyValues.customer_name, 'Master Cu');
  assert.equal(sentTemplate('cx_enquiry').bodyValues.customer_name, 'Master Cu');
  for (const s of sends) {
    assert.notEqual(s.bodyValues.customer_name, '', 'no template may carry a blank customer_name');
  }
});

test('a NULL job_customer_name still falls back (the pre-existing behaviour holds)', async () => {
  jobRow = { job_customer_name: null, customer_name: 'Master Cu' };
  await enquiry.sendEnquiryWhatsapp(4242);
  assert.equal(sentTemplate('cx_enquiry').bodyValues.customer_name, 'Master Cu');
});

test('TRAP 2: Gallabox `recipient.name` keeps the customer-MASTER name', async () => {
  /*
   * recipientName becomes `recipient: { name, phone }` on the Gallabox send —
   * the CONTACT-BOOK identity for the person behind cu.customer_mob_no, i.e.
   * "this customer record", not "the customer on this job". It therefore reads
   * `customer_master_name` and must NOT pick up the per-job override.
   */
  jobRow = { job_customer_name: 'Booked Name', customer_name: 'Master Cu' };
  await enquiry.sendEnquiryWhatsapp(4242);
  assert.equal(sentTemplate('cx_enquiry').recipientName, 'Master Cu');
  assert.equal(sentTemplate('cx_enquiry').bodyValues.customer_name, 'Booked Name',
    'the message BODY still shows the per-job name — only the contact identity differs');
  assert.match(stripComments(contextQuery().sql), /cu\.customer_name AS customer_master_name/,
    'the master name must still be projected, or recipient.name silently blanks');
});

test('COUNT-JOIN PARITY: the override needs no new join — `j` is the base table', async () => {
  /*
   * The recorded "COUNT query 500" is a projection that needs a JOIN the COUNT
   * statement lacks. job_customer_name lives on tbl_job itself, which is the
   * FROM of every one of these statements, so the change adds no join anywhere
   * — and this query is a single-row LIMIT 1 read with no COUNT sibling at all.
   */
  jobRow = { job_customer_name: 'Booked Name', customer_name: 'Master Cu' };
  await enquiry.sendEnquiryWhatsapp(4242);
  const sql = stripComments(contextQuery().sql);
  assert.match(sql, /FROM tbl_job j\b/, 'tbl_job must be the base table, aliased j');
  assert.match(sql, /LIMIT 1/, 'single-row read — no paginated COUNT sibling exists');
  // Exactly the four joins that were there before; none added.
  assert.equal((sql.match(/LEFT JOIN/g) || []).length, 4, 'no JOIN may be added or removed');
  assert.match(sql, /LEFT JOIN tbl_customer\s+cu\b/, 'the cu join the fallback needs already existed');
  assert.deepEqual(contextQuery().params, [4242], 'job id stays a bound placeholder');
});

test('the job name is read, never bound — no user input is concatenated', async () => {
  jobRow = { job_customer_name: 'Booked Name', customer_name: 'Master Cu' };
  await enquiry.sendEnquiryWhatsapp(4242);
  assert.doesNotMatch(contextQuery().sql, /job_customer_name\s*=/,
    'READ-ONLY projection change: nothing may assign to job_customer_name here');
  for (const c of fake.calls) {
    assert.doesNotMatch(c.sql, /^\s*(INSERT|UPDATE|DELETE)\b/i, 'no write path may run in this flow');
  }
});

/* ═══ SITE 2 — routes/admin/jobs.js · sendEstimateEmail() ═════════════════
 *
 * Module-private and reached only from POST /:id/estimate/send-for-approval,
 * so its statement is lifted from source. The behavioural contract is the
 * same one, run through the same evaluator.
 */

const jobsRouteSrc = fs.readFileSync(
  path.join(__dirname, '..', 'routes', 'admin', 'jobs.js'), 'utf8',
);

// Slice just the sendEstimateEmail SELECT (up to the services query that follows).
function estimateEmailSql() {
  const start = jobsRouteSrc.indexOf('async function sendEstimateEmail');
  assert.notEqual(start, -1, 'sendEstimateEmail must still exist in routes/admin/jobs.js');
  const end = jobsRouteSrc.indexOf('const [services]', start);
  assert.notEqual(end, -1, 'the services query must still follow it');
  return jobsRouteSrc.slice(start, end);
}

test('estimate email: the job customer name uses the NULLIF/TRIM form and behaves', () => {
  const expr = extractCustomerNameExpr(estimateEmailSql());
  assert.match(expr, GUARDED, `estimate email must use the guarded form, got: ${expr}`);
  assertJobScopedFallback(expr, 'estimate-email');
});

test('estimate email: the alias stays `customer_name` for the subject line', () => {
  /*
   * The subject is built as
   *   `Client_Estimate Approval_${j.job_id}_${j.customer_name}_${j.customer_mob_no}`
   * — a renamed alias would silently produce "Approval_4242__9876543210".
   */
  const sql = estimateEmailSql();
  assert.match(stripComments(sql), /\bAS customer_name\b/);
  assert.match(jobsRouteSrc, /subject: `Client_Estimate Approval_\$\{j\.job_id\}_\$\{j\.customer_name \|\| ''\}/,
    'the consumer must still read j.customer_name');
});

test('estimate email: COUNT-JOIN PARITY — base table j, existing cu join, LIMIT 1', () => {
  const sql = stripComments(estimateEmailSql());
  assert.match(sql, /FROM tbl_job j\b/, 'tbl_job is the base table — j.job_customer_name needs no join');
  assert.match(sql, /LEFT JOIN tbl_customer cu\b/, 'the fallback join already existed');
  assert.match(sql, /WHERE j\.job_id = \? LIMIT 1/, 'single-row read — no paginated COUNT sibling');
  assert.equal((sql.match(/LEFT JOIN/g) || []).length, 3, 'no JOIN may be added or removed');
});

test('estimate email: the projection change did not disturb the write path', () => {
  /*
   * The route's UPDATE (job_status = 15, approval stamps) runs inside its own
   * transaction BEFORE sendEstimateEmail is invoked fire-and-forget. Pin that
   * the read function contains no write, and that the UPDATE still precedes it.
   */
  const sql = estimateEmailSql();
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE)\b/i, 'sendEstimateEmail must stay read-only');
  const update = jobsRouteSrc.indexOf('SET job_status = 15');
  const call   = jobsRouteSrc.indexOf('sendEstimateEmail(jobId, req.user.user_id)');
  assert.ok(update !== -1 && call !== -1 && update < call,
    'the status UPDATE must still run before the email read — no write path moved');
});

/* ═══ REGRESSION NET ══════════════════════════════════════════════════════ */

test('no plain-COALESCE job_customer_name form survives in the files this change owns', () => {
  /*
   * Belt and braces across BOTH owned files: every reference to the per-job
   * override in a projection must be wrapped in NULLIF(TRIM(...), '').
   * (Other files still carrying the plain form are reported separately — they
   * are owned by other agents and out of scope here.)
   */
  const owned = [
    path.join(__dirname, '..', 'routes', 'admin', 'jobs.js'),
    path.join(__dirname, '..', 'services', 'enquiry-notification.service.js'),
  ];
  for (const file of owned) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    assert.doesNotMatch(
      src, /COALESCE\(\s*j\.job_customer_name\s*,/,
      `${path.basename(file)} must never use the plain COALESCE form — '' would render blank`,
    );
    for (const m of src.matchAll(/j\.job_customer_name/g)) {
      const around = src.slice(Math.max(0, m.index - 60), m.index + 40);
      assert.match(
        around, /NULLIF\(\s*TRIM\(\s*j\.job_customer_name\s*\)\s*,\s*''\s*\)/,
        `${path.basename(file)}: every j.job_customer_name read must be NULLIF/TRIM-guarded`,
      );
    }
  }
});
