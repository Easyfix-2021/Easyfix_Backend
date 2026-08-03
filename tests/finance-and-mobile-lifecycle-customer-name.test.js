/*
 * Customer-name projection — routes/admin/finance.js + services/mobile-job-lifecycle.service.js
 *
 * THE PRODUCT RULE. A name displayed as "the customer on THIS JOB" comes from
 * the booking form (tbl_job.job_customer_name), NOT from the customer master
 * (tbl_customer.customer_name). The master is only a fallback. Customer-MASTER
 * surfaces (Manage Customers, customer detail, dedupe-by-mobile, lookup /
 * autocomplete) are unaffected — neither file under test owns one.
 *
 * THE TRAP THIS FILE EXISTS FOR. The obvious spelling —
 *
 *     COALESCE(j.job_customer_name, cu.customer_name)
 *
 * — is WRONG, because MySQL COALESCE only skips NULL. `COALESCE('', 'Master')`
 * is `''`, so any job whose job_customer_name is an empty string renders a
 * BLANK customer name instead of falling back. The column is written straight
 * off a form field and `validators/job.validator.js` explicitly permits '' on
 * BOTH the create and update paths (`Joi.string().max(255).allow('', null)`),
 * and services/job.service.js binds the value verbatim (`input.job_customer_name
 * ?? …` only falls through on null/undefined; the MUTABLE_COLUMNS update loop
 * applies no empty-string normalisation). Prod today happens to hold zero ''
 * rows — the hazard is latent, not manifest — which is exactly why it needs a
 * test rather than a spot-check. The correct form is:
 *
 *     COALESCE(NULLIF(TRIM(j.job_customer_name), ''), cu.customer_name)
 *
 * HOW THIS IS PINNED. Rather than restating the expression (which would pass
 * even if the source reverted), the tests READ the projection out of the real
 * source files and evaluate it under MySQL COALESCE/NULLIF/TRIM semantics with
 * a tiny expression interpreter. A revert to plain COALESCE is still parsed and
 * still evaluated — and then fails the ''-fixture. The interpreter also refuses
 * any SQL function it does not model, so a rewrite into something it cannot
 * reason about fails loudly instead of silently passing.
 *
 * Non-destructive: fake pool, no real DB, zero writes. Runner: `node --test`.
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installFakePool } = require('./helpers/fake-pool');

const ROOT = path.join(__dirname, '..');
const FILES = {
  finance: path.join(ROOT, 'routes/admin/finance.js'),
  mobileLifecycle: path.join(ROOT, 'services/mobile-job-lifecycle.service.js'),
};
const SRC = Object.fromEntries(
  Object.entries(FILES).map(([k, p]) => [k, fs.readFileSync(p, 'utf8')]),
);

/* ── A minimal MySQL expression interpreter ──────────────────────────────────
 * Supports exactly what a customer-name projection may legitimately contain:
 * COALESCE / NULLIF / TRIM, single-quoted string literals, and `alias.column`
 * references. Anything else throws — an unmodelled function must not slip
 * through as a silent pass.
 */
function parseSqlExpr(src) {
  let i = 0;
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  function expr() {
    ws();
    if (src[i] === "'") {
      i++;
      let out = '';
      while (i < src.length && src[i] !== "'") out += src[i++];
      i++; // closing quote
      return { t: 'lit', v: out };
    }
    let name = '';
    while (i < src.length && /[A-Za-z0-9_.$]/.test(src[i])) name += src[i++];
    ws();
    if (src[i] === '(') {
      i++;
      const args = [];
      ws();
      if (src[i] === ')') { i++; return { t: 'fn', name: name.toUpperCase(), args }; }
      for (;;) {
        args.push(expr());
        ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === ')') { i++; break; }
        throw new Error(`unparseable projection near index ${i}: ${src}`);
      }
      return { t: 'fn', name: name.toUpperCase(), args };
    }
    if (!name) throw new Error(`unparseable projection near index ${i}: ${src}`);
    return { t: 'col', name };
  }
  const node = expr();
  ws();
  if (i !== src.length) throw new Error(`trailing input in projection: ${src.slice(i)}`);
  return node;
}

function evalSqlExpr(node, row) {
  if (node.t === 'lit') return node.v;
  if (node.t === 'col') {
    if (!(node.name in row)) throw new Error(`projection reads an unexpected column: ${node.name}`);
    return row[node.name];
  }
  const a = node.args.map((x) => evalSqlExpr(x, row));
  switch (node.name) {
    // MySQL: returns the first non-NULL argument ('' is NOT NULL).
    case 'COALESCE': { for (const v of a) if (v !== null) return v; return null; }
    // MySQL: NULL when the two are equal, else the first argument.
    case 'NULLIF': return a[0] === a[1] ? null : a[0];
    // MySQL TRIM() with no remstr strips SPACES only, and TRIM(NULL) is NULL.
    case 'TRIM': return a[0] === null ? null : String(a[0]).replace(/^ +| +$/g, '');
    default:
      throw new Error(
        `projection uses SQL function ${node.name}(), which this test cannot reason about — ` +
        'model it here before shipping it',
      );
  }
}

const runProjection = (sqlExpr, row) => evalSqlExpr(parseSqlExpr(sqlExpr), row);

/* Pull every `<expr> AS customer_name` out of a source file by walking left
 * from the alias with paren balancing, so commas INSIDE the expression don't
 * truncate it. Stops at a depth-0 comma or the opening backtick of the
 * template literal. */
function extractCustomerNameProjections(src) {
  const out = [];
  const re = /\bAS\s+customer_name\b/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let i = m.index - 1;
    while (i >= 0 && /\s/.test(src[i])) i--;
    const exprEnd = i + 1;
    let depth = 0;
    for (; i >= 0; i--) {
      const c = src[i];
      if (c === ')') depth++;
      else if (c === '(') { if (depth === 0) break; depth--; }
      else if (depth === 0 && (c === ',' || c === '`')) break;
    }
    out.push(src.slice(i + 1, exprEnd).trim().replace(/^SELECT\s+(DISTINCT\s+)?/i, ''));
  }
  return out;
}

/* The four rows that decide whether the projection is right. */
const FIXTURES = [
  { label: 'booking-form name present → it wins over the master',
    job: 'Booking Form Name', master: 'Master Name', want: 'Booking Form Name' },
  { label: 'NULL job name → master name',
    job: null, master: 'Master Name', want: 'Master Name' },
  { label: "THE TRAP: EMPTY-STRING job name → master name (NOT '')",
    job: '', master: 'Master Name', want: 'Master Name' },
  { label: 'whitespace-only job name → master name',
    job: '   ', master: 'Master Name', want: 'Master Name' },
  { label: 'padded job name → trimmed job name, master untouched',
    job: '  Padded Name  ', master: 'Master Name', want: 'Padded Name' },
  { label: 'neither present → NULL, never a stray empty string',
    job: null, master: null, want: null },
];

const rowFor = (f) => ({ 'j.job_customer_name': f.job, 'cu.customer_name': f.master });

/* ── The projections, read out of the real sources ───────────────────────── */

test('both owned files project customer_name off the JOB row, master as fallback', () => {
  for (const [key, src] of Object.entries(SRC)) {
    const projections = extractCustomerNameProjections(src);
    assert.ok(projections.length > 0, `${key}: expected at least one AS customer_name projection`);
    for (const p of projections) {
      assert.match(p, /j\.job_customer_name/, `${key}: must read the job-row name — got: ${p}`);
      assert.match(p, /cu\.customer_name/, `${key}: must keep the master as fallback — got: ${p}`);
    }
  }
});

test('THE TRAP: every extracted projection falls back on an EMPTY-STRING job name', () => {
  for (const [key, src] of Object.entries(SRC)) {
    for (const p of extractCustomerNameProjections(src)) {
      for (const f of FIXTURES) {
        assert.equal(
          runProjection(p, rowFor(f)), f.want,
          `${key} — ${f.label}\n  projection: ${p}`,
        );
      }
    }
  }
});

test('the plain-COALESCE form is REJECTED by the same fixtures (the test has teeth)', () => {
  /*
   * Guards the guard: proves the fixture set actually discriminates, so a
   * revert to `COALESCE(j.job_customer_name, cu.customer_name)` cannot pass
   * the assertion above. If this ever stops throwing, the ''-fixture has been
   * weakened and the whole file is decorative.
   */
  const plain = 'COALESCE(j.job_customer_name, cu.customer_name)';
  assert.equal(runProjection(plain, rowFor({ job: null, master: 'Master Name' })), 'Master Name',
    'plain COALESCE is fine for NULL — that is why the bug hid');
  assert.equal(runProjection(plain, rowFor({ job: '', master: 'Master Name' })), '',
    "plain COALESCE returns '' for an empty-string job name — this IS the blank-name bug");
  assert.throws(
    () => {
      for (const f of FIXTURES) {
        assert.equal(runProjection(plain, rowFor(f)), f.want);
      }
    },
    assert.AssertionError,
    'the fixture set must reject the plain-COALESCE form',
  );
});

test('no plain COALESCE(j.job_customer_name, …) survives in either owned file', () => {
  for (const [key, src] of Object.entries(SRC)) {
    assert.doesNotMatch(
      src, /COALESCE\(\s*j\.job_customer_name\s*,/i,
      `${key}: plain COALESCE blanks the name for '' — use COALESCE(NULLIF(TRIM(...), ''), ...)`,
    );
  }
});

/* ── Structural: the join the projection leans on, per statement ─────────── */

test('every SQL statement naming the `cu.` alias also joins tbl_customer', () => {
  /*
   * THE RECORDED 500: a projection that reaches for an alias its statement
   * never joined. Paginated endpoints make this worse because the COUNT runs
   * as a SEPARATE statement — so this is asserted per template literal, which
   * covers main and COUNT queries alike. Neither owned file paginates a
   * customer-name query today (finance's invoice artifact loads a bounded job
   * set; searchByJobId is LIMIT 1), and this test keeps that honest if one
   * ever grows a COUNT sibling.
   */
  for (const [key, src] of Object.entries(SRC)) {
    const literals = src.match(/`[^`]*`/g) || [];
    const sqlLiterals = literals.filter((l) => /\bFROM\b/i.test(l) || /\bUPDATE\b/i.test(l));
    assert.ok(sqlLiterals.length > 0, `${key}: expected SQL template literals`);
    for (const lit of sqlLiterals) {
      if (!/\bcu\./.test(lit)) continue;
      assert.match(
        lit, /JOIN\s+tbl_customer\s+cu\b/i,
        `${key}: a statement uses the cu. alias without joining tbl_customer:\n${lit}`,
      );
    }
  }
});

test('the job-row name needs no new join — j is the base table everywhere it is read', () => {
  for (const [key, src] of Object.entries(SRC)) {
    const literals = (src.match(/`[^`]*`/g) || []).filter((l) => /j\.job_customer_name/.test(l));
    for (const lit of literals) {
      assert.match(
        lit, /FROM\s+tbl_job\s+j\b/i,
        `${key}: job_customer_name read from a statement whose base table is not tbl_job j:\n${lit}`,
      );
    }
  }
});

/* ── finance.js: the alias the consumer reads is unchanged ───────────────── */

test('finance.js invoice lines still read the row off the `customer_name` alias', () => {
  /*
   * loadInvoiceArtifactData() feeds both /invoices/:id/excel and /pdf. The
   * projection changed; the column name the line builder destructures did not.
   */
  const hits = SRC.finance.match(/customer:\s*j\.customer_name\b/g) || [];
  assert.equal(hits.length, 2, 'both the no-services and per-service line branches must still map j.customer_name');
  assert.doesNotMatch(SRC.finance, /customer:\s*j\.job_customer_name\b/,
    'the consumer must read the ALIAS, not the raw column (the fallback lives in SQL)');
});

test('finance.js customer-name change touched no write path', () => {
  const jobWrites = SRC.finance.match(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+tbl_job\b/gi) || [];
  assert.deepEqual(jobWrites, [], 'finance.js must not write tbl_job at all — this was a read-only change');
});

/* ── mobile-job-lifecycle: end-to-end through the service ────────────────── */

const fake = installFakePool([
  [/SHOW COLUMNS/i, []],
  [/FROM easyfix_properties/i, []],
  [/FROM INFORMATION_SCHEMA\.COLUMNS/i, []],
  [
    // The searchByJobId read. Evaluate the projection the SERVICE actually
    // emitted against the fixture row, so the assertion runs end-to-end:
    // source SQL → MySQL semantics → the camelCase API field.
    /AS customer_name[\s\S]*FROM tbl_job j/i,
    (sql) => {
      const [projection] = extractCustomerNameProjections(sql);
      return [{
        job_id: 7001,
        job_reference_id: 'EF-7001',
        client_ref_id: 'CR-7001',
        job_status: 1,
        job_type: 'Repair',
        requested_date_time: null,
        time_slot: '10:00-12:00',
        otp: 1234,
        customer_name: runProjection(projection, rowFor(fake.__fixture)),
        customer_mob_no: '9999999999',
        address: 'x', locality: 'y', landmark: 'z', pin_code: '110001', gps_location: null,
        city_name: 'Delhi', client_name: 'Acme', service_category: 'AC',
      }];
    },
  ],
]);

const lifecycle = require('../services/mobile-job-lifecycle.service');

beforeEach(() => { fake.reset(); });
after(() => { fake.restore(); });

test('searchByJobId: EMPTY-STRING job name surfaces the MASTER name as customerName', async () => {
  fake.__fixture = { job: '', master: 'Master Name' };
  const out = await lifecycle.searchByJobId(7001, 55);
  assert.equal(out.customerName, 'Master Name', 'the trap: the tech must never see a blank name');
});

test('searchByJobId: the booking-form name wins when present', async () => {
  fake.__fixture = { job: 'Booking Form Name', master: 'Master Name' };
  const out = await lifecycle.searchByJobId(7001, 55);
  assert.equal(out.customerName, 'Booking Form Name');
});

test('searchByJobId: NULL job name still falls back to the master', async () => {
  fake.__fixture = { job: null, master: 'Master Name' };
  const out = await lifecycle.searchByJobId(7001, 55);
  assert.equal(out.customerName, 'Master Name');
});

test('searchByJobId: the app-facing field name is still `customerName`', async () => {
  fake.__fixture = { job: 'Booking Form Name', master: 'Master Name' };
  const out = await lifecycle.searchByJobId(7001, 55);
  assert.ok('customerName' in out, 'the Expo app reads customerName — the key must not drift');
  assert.ok(!('customer_name' in out), 'the service returns camelCase, never the raw column');
});

test('searchByJobId stays a pure read — one SELECT, no write, tech scope intact', async () => {
  fake.__fixture = { job: 'Booking Form Name', master: 'Master Name' };
  await lifecycle.searchByJobId(7001, 55);
  const reads = fake.calls.filter((c) => /FROM tbl_job j/i.test(c.sql));
  assert.equal(reads.length, 1, 'exactly one job read');
  for (const c of fake.calls) {
    assert.doesNotMatch(c.sql, /\b(INSERT|UPDATE|DELETE)\b/i, 'a read path must emit no writes');
  }
  // The ownership guard that makes this safe for a technician must survive.
  assert.match(reads[0].sql, /WHERE j\.job_id = \? AND j\.fk_easyfixter_id = \?/);
  assert.deepEqual(reads[0].params, [7001, 55], 'both ids bound as placeholders, never inlined');
});

test('searchByJobId binds no literal into the projection', async () => {
  fake.__fixture = { job: 'Booking Form Name', master: 'Master Name' };
  await lifecycle.searchByJobId(7001, 55);
  const sql = fake.calls.find((c) => /FROM tbl_job j/i.test(c.sql)).sql;
  // The only literal the projection may carry is the NULLIF sentinel ''.
  const [projection] = extractCustomerNameProjections(sql);
  const literals = projection.match(/'[^']*'/g) || [];
  assert.deepEqual(literals, ["''"], "only the NULLIF empty-string sentinel may appear as a literal");
});
