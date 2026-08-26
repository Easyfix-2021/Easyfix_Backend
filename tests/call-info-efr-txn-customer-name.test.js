/*
 * JOB-SCOPED CUSTOMER NAME — the two surfaces owned by this change (2026-08-03):
 *
 *   routes/admin/call-info.js       GET /admin/call-info  +  /export.xlsx
 *   services/easyfixer.service.js   listTransactions()  ("Transaction List" modal)
 *
 * (tests/job-customer-name-projection.test.js covers the OTHER sites of the same
 * rollout — job list / calls / magic-link / mobile. This file is deliberately
 * scoped to the two files above and does not assert about any other module.)
 *
 * THE RULE. A name rendered as "the customer on THIS JOB" comes from
 * tbl_job.job_customer_name — the name typed on the booking page — falling back
 * to the customer-master tbl_customer.customer_name only when the job carries
 * none. Both surfaces here are job-scoped: a call record is a call ABOUT a job,
 * and each transaction row IS a job. Customer-MASTER surfaces (Manage Customers,
 * customer lookup / dedupe) keep the master name and are not touched.
 *
 * THE TRAP. In MySQL, COALESCE returns the first NON-NULL argument, and '' is
 * non-null: COALESCE('', 'Master') is '', not 'Master'. So the plain
 * `COALESCE(j.job_customer_name, cu.customer_name)` form used elsewhere in the
 * repo renders a BLANK customer name for any job whose job_customer_name is an
 * empty or whitespace-only string. The shipped form must be
 *
 *     COALESCE(NULLIF(TRIM(j.job_customer_name), ''), cu.customer_name)
 *
 * Is '' reachable? Not in today's data — a read-only prod probe on 2026-08-03
 * over 481,027 tbl_job rows found 358,332 NULL and ZERO rows that were '' or
 * whitespace-only, on tbl_job overall AND on the two joins these surfaces use
 * (tbl_job_transaction, tbl_easyfixer_call_record). But it is reachable by
 * CODE, which is what a projection has to hold against: job.validator.js
 * declares job_customer_name as Joi.string().allow('', null) on both the create
 * and update bodies, and job.service.js binds it with the ?? operator (a
 * null/undefined guard only), so one blank form field stores ''. The blank case
 * is LATENT, not live — these tests keep it that way.
 *
 * HOW THE SEMANTIC TESTS WORK. They do not merely string-match the SQL. They
 * EXTRACT the projection expression from the statement the code actually emits
 * and evaluate it under MySQL COALESCE / NULLIF / TRIM semantics, so a revert
 * to the plain form fails on the empty-string row rather than on a regex.
 *
 * Non-destructive: fake pool, no real DB, zero writes. Runner: `node --test`.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const ExcelJS = require('exceljs');
const { installFakePool } = require('./helpers/fake-pool');

// Rows the fake pool hands back. Mutable so a test can reshape the export set.
const scenario = { callRows: [], txnRows: [] };

const fake = installFakePool([
  [/FROM tbl_easyfixer_call_record/i, () => scenario.callRows],
  [/^SELECT COUNT\(\*\) AS total\s+FROM tbl_job_transaction/i, [{ total: 1 }]],
  [/FROM tbl_job_transaction TJT/i, () => scenario.txnRows],
]);

const efrSvc = require('../services/easyfixer.service');
const callInfoRouter = require('../routes/admin/call-info');

// ── captured-SQL helpers ─────────────────────────────────────────────
const oneMatching = (re) => {
  const hits = fake.calls.filter((c) => re.test(c.sql));
  assert.equal(hits.length, 1, `expected exactly 1 query matching ${re}, saw ${hits.length}`);
  return hits[0].sql;
};

/*
 * listTransactions runs TWO statements over tbl_job_transaction — the paginated
 * data query and the separate COUNT. `FROM tbl_job_transaction TJT` appears in
 * both, so the data query is identified by its LIMIT ? OFFSET ? tail and the
 * COUNT by its projection. Keeping them distinct is the whole point of the
 * COUNT-parity test below.
 */
const TXN_DATA = /FROM tbl_job_transaction TJT[\s\S]*LIMIT \? OFFSET \?/i;
const TXN_COUNT = /^SELECT COUNT\(\*\) AS total\s+FROM tbl_job_transaction/i;

/*
 * Source with comments removed. The static sweep below looks for an unguarded
 * COALESCE in the SHIPPED SQL — the files legitimately *describe* the bad form
 * in their explanatory comments, and that prose must not read as a violation.
 */
function strippedSource(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments (JS and in-SQL alike)
    .replace(/^[ \t]*\/\/.*$/gm, ' ');   // whole-line // comments
}

/*
 * Pull `<expr> AS customer_name` back out of a captured statement. The
 * expression sits on one line, and the lazy `.*?` stops at the first `)`
 * immediately followed by ` AS customer_name` — i.e. the full balanced
 * expression. Returns the expression text only.
 */
function customerNameExpr(sql) {
  const m = /(COALESCE\(.*?\))\s+AS\s+customer_name/.exec(sql);
  assert.ok(m, `no "... AS customer_name" projection found in:\n${sql}`);
  return m[1];
}

/* ── A pinhole MySQL expression evaluator ─────────────────────────────
 * Understands exactly what these projections use: COALESCE, NULLIF, TRIM,
 * 'string literals' and alias.column references. Anything else THROWS, so it
 * can never silently "pass" an expression it did not actually understand.
 */
function parseExpr(src) {
  let i = 0;
  const skipWs = () => { while (i < src.length && /\s/.test(src[i])) i++; };

  function node() {
    skipWs();
    if (src[i] === "'") {                        // '...' with '' escaping
      let out = ''; i++;
      while (i < src.length) {
        if (src[i] === "'" && src[i + 1] === "'") { out += "'"; i += 2; continue; }
        if (src[i] === "'") { i++; return { kind: 'lit', value: out }; }
        out += src[i++];
      }
      throw new Error('unterminated string literal');
    }
    const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
    if (!m) throw new Error(`unparsable at: ${src.slice(i, i + 24)}`);
    const name = m[0];
    i += name.length;
    skipWs();
    if (src[i] !== '(') return { kind: 'col', name };
    i++;                                         // consume '('
    const args = [];
    skipWs();
    if (src[i] !== ')') {
      for (;;) {
        args.push(node());
        skipWs();
        if (src[i] === ',') { i++; continue; }
        break;
      }
    }
    if (src[i] !== ')') throw new Error('unbalanced parentheses');
    i++;
    return { kind: 'call', name: name.toUpperCase(), args };
  }

  const root = node();
  skipWs();
  assert.equal(i, src.length, `trailing junk in expression: ${src.slice(i)}`);
  return root;
}

function evalExpr(n, values) {
  if (n.kind === 'lit') return n.value;
  if (n.kind === 'col') {
    assert.ok(n.name in values, `expression referenced an unexpected column: ${n.name}`);
    return values[n.name];
  }
  switch (n.name) {
    case 'COALESCE': {
      for (const a of n.args) {
        const v = evalExpr(a, values);
        if (v !== null) return v;                // ONLY NULL is "absent" — the trap
      }
      return null;
    }
    case 'NULLIF': {
      const a = evalExpr(n.args[0], values);
      const b = evalExpr(n.args[1], values);
      if (a === null) return null;
      return a === b ? null : a;
    }
    case 'TRIM': {                               // MySQL TRIM(x): strips spaces
      const v = evalExpr(n.args[0], values);
      return v === null ? null : String(v).replace(/^ +| +$/g, '');
    }
    default:
      throw new Error(`evaluator does not model SQL function ${n.name}()`);
  }
}

// Bind {column: value} for whichever aliases the expression happens to use
// (j. in call-info, J. in easyfixer.service), so the tests stay alias-agnostic.
function bind(expr, jobName, masterName) {
  const jobCol = /\b[A-Za-z_]+\.job_customer_name\b/.exec(expr)[0];
  const masterCol = /\b[A-Za-z_]+\.customer_name\b/.exec(expr.replace(jobCol, ''))[0];
  return { [jobCol]: jobName, [masterCol]: masterName };
}

// ── express harness for the call-info router ─────────────────────────
let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use('/call-info', callInfoRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err && err.message) }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  fake.restore();
});

beforeEach(() => {
  fake.reset();
  scenario.callRows = [];
  scenario.txnRows = [];
});

const RANGE = 'fromDate=2026-08-01&toDate=2026-08-03';

// Collect every expression this change ships, from the code that emits it.
async function shippedExpressions() {
  fake.reset();
  await efrSvc.listTransactions(7, { limit: 10, offset: 0 });
  const txn = customerNameExpr(oneMatching(TXN_DATA));

  fake.reset();
  await fetch(`${baseUrl}/call-info?${RANGE}`);
  const list = customerNameExpr(oneMatching(/FROM tbl_easyfixer_call_record/i));

  fake.reset();
  const exp = await fetch(`${baseUrl}/call-info/export.xlsx?${RANGE}`);
  await exp.arrayBuffer();
  const xlsx = customerNameExpr(oneMatching(/FROM tbl_easyfixer_call_record/i));

  return { 'easyfixer listTransactions': txn, 'call-info list': list, 'call-info export': xlsx };
}

/* ── 1. SEMANTICS — the shipped expression, evaluated ─────────────── */

test('THE TRAP: an EMPTY-STRING job_customer_name falls back to the master name', async () => {
  // The single most important assertion here. Under the plain COALESCE form
  // this yields '' and the surface renders a blank customer name.
  for (const [where, expr] of Object.entries(await shippedExpressions())) {
    assert.equal(
      evalExpr(parseExpr(expr), bind(expr, '', 'Master Co')), 'Master Co',
      `${where}: '' must fall back to the master name, not render blank — ${expr}`,
    );
  }
});

test('a WHITESPACE-ONLY job_customer_name also falls back (TRIM, not just NULLIF)', async () => {
  for (const [where, expr] of Object.entries(await shippedExpressions())) {
    for (const blank of [' ', '   ', '  ']) {
      assert.equal(evalExpr(parseExpr(expr), bind(expr, blank, 'Master Co')), 'Master Co', `${where}: ${expr}`);
    }
  }
});

test('a NULL job_customer_name falls back to the master name', async () => {
  for (const [where, expr] of Object.entries(await shippedExpressions())) {
    assert.equal(evalExpr(parseExpr(expr), bind(expr, null, 'Master Co')), 'Master Co', where);
  }
});

test('THE POINT OF THE CHANGE: a real job_customer_name WINS over the master name', async () => {
  for (const [where, expr] of Object.entries(await shippedExpressions())) {
    assert.equal(
      evalExpr(parseExpr(expr), bind(expr, 'Ravi Kumar', 'Master Co')), 'Ravi Kumar',
      `${where}: the booking-page name must win`,
    );
  }
});

test('surrounding spaces are trimmed off a real name, not mistaken for absent', async () => {
  for (const [where, expr] of Object.entries(await shippedExpressions())) {
    assert.equal(evalExpr(parseExpr(expr), bind(expr, '  Ravi Kumar  ', 'Master Co')), 'Ravi Kumar', where);
  }
});

test('both absent ⇒ NULL (the FE renders its own dash; we invent no name)', async () => {
  for (const [where, expr] of Object.entries(await shippedExpressions())) {
    assert.equal(evalExpr(parseExpr(expr), bind(expr, null, null)), null, where);
    assert.equal(evalExpr(parseExpr(expr), bind(expr, '', null)), null, where);
  }
});

test('CONTROL: the plain COALESCE form really does render blank — why NULLIF is required', () => {
  /*
   * Not a test of our code: a test of the evaluator's fidelity to MySQL, and
   * the executable statement of the bug. If this ever returns 'Master Co' the
   * evaluator has stopped modelling COALESCE correctly and every assertion
   * above is worthless.
   */
  const ast = parseExpr('COALESCE(j.job_customer_name, cu.customer_name)');
  assert.equal(evalExpr(ast, { 'j.job_customer_name': '', 'cu.customer_name': 'Master Co' }), '');
  assert.equal(evalExpr(ast, { 'j.job_customer_name': null, 'cu.customer_name': 'Master Co' }), 'Master Co');
});

/* ── 2. SQL SHAPE + WIRING ────────────────────────────────────────── */

test('listTransactions projects the guarded form under the UNCHANGED alias', async () => {
  await efrSvc.listTransactions(7, { limit: 10, offset: 0 });
  const sql = oneMatching(TXN_DATA);
  assert.ok(
    sql.includes("COALESCE(NULLIF(TRIM(J.job_customer_name), ''), cu.customer_name) AS customer_name"),
    `exact shipped projection missing from:\n${sql}`,
  );
  // EasyfixerTransactionsModal.tsx reads `t.customer_name` — the alias IS the contract.
  assert.equal((sql.match(/\bAS customer_name\b/g) || []).length, 1, 'exactly one customer_name alias');
  assert.match(sql, /AS customer_mob_no/, 'sibling columns untouched');
});

test('COUNT-JOIN PARITY: tbl_job J is joined in BOTH listTransactions statements', async () => {
  /*
   * The recorded 500 is a projection that needs a join the SEPARATE COUNT query
   * lacks. Here J was already joined by both (the efrId filter reads
   * J.fk_easyfixter_id), so J.job_customer_name adds no join at all — asserted
   * on both statements rather than assumed.
   */
  await efrSvc.listTransactions(7, { limit: 10, offset: 0 });
  const count = oneMatching(TXN_COUNT);
  const data = oneMatching(TXN_DATA);
  for (const [label, sql] of [['COUNT', count], ['data', data]]) {
    assert.match(sql, /JOIN tbl_job J\s+ON J\.job_id\s+=\s+TJT\.fk_job_id/i, `${label} must join tbl_job J`);
    assert.match(sql, /WHERE J\.fk_easyfixter_id = \?/, `${label} filter must be unchanged`);
  }
  // The COUNT projects nothing, so it needs no customer join and must not grow one.
  assert.doesNotMatch(count, /tbl_customer/i, 'COUNT must not have acquired a customer join');
});

test('both call-info statements project the guarded form under the alias the FE reads', async () => {
  for (const url of [`/call-info?${RANGE}`, `/call-info/export.xlsx?${RANGE}`]) {
    fake.reset();
    const res = await fetch(`${baseUrl}${url}`);
    assert.equal(res.status, 200, `${url} must not error`);
    await res.arrayBuffer();
    const sql = oneMatching(/FROM tbl_easyfixer_call_record/i);
    assert.ok(
      sql.includes("COALESCE(NULLIF(TRIM(j.job_customer_name), ''), cu.customer_name) AS customer_name"),
      `${url}: exact shipped projection missing from:\n${sql}`,
    );
    assert.equal((sql.match(/\bAS customer_name\b/g) || []).length, 1, `${url}: one alias only`);
    // CallInfoModal.tsx types BOTH keys — the raw job column stays projected.
    assert.match(sql, /j\.job_customer_name,/, `${url}: raw job_customer_name must still be projected`);
    assert.match(sql, /cu\.customer_mob_no/, `${url}: customer mobile still projected`);
  }
});

test('the call-info date range is still bound, never inlined', async () => {
  // Guards the fact that the projection edit touched only the SELECT list.
  fake.reset();
  await fetch(`${baseUrl}/call-info?${RANGE}`);
  const hit = fake.calls.find((c) => /FROM tbl_easyfixer_call_record/i.test(c.sql));
  assert.match(hit.sql, /WHERE cr\.insert_date_time BETWEEN \? AND \?/);
  assert.deepEqual(hit.params, ['2026-08-01 00:00:00', '2026-08-03 23:59:59']);
});

test('NO unguarded COALESCE site survives in either owned file', () => {
  /*
   * Static sweep of the two files this change owns. A bare
   * `COALESCE(<alias>.job_customer_name, …)` — no NULLIF/TRIM — is the bug; it
   * must not exist here and must not be reintroduced by a later edit.
   */
  for (const rel of ['routes/admin/call-info.js', 'services/easyfixer.service.js']) {
    const src = strippedSource(rel);
    const bad = src.match(/COALESCE\(\s*[A-Za-z_]+\.job_customer_name\s*,/g);
    assert.equal(bad, null, `${rel} still has an unguarded COALESCE: ${bad && bad.join(' | ')}`);
    assert.match(
      src, /COALESCE\(NULLIF\(TRIM\([A-Za-z_]+\.job_customer_name\), ''\),/,
      `${rel} must carry the guarded form`,
    );
  }
});

test('READ-ONLY: none of these flows issues a write', async () => {
  await efrSvc.listTransactions(7, { limit: 10, offset: 0 });
  await fetch(`${baseUrl}/call-info?${RANGE}`);
  const exp = await fetch(`${baseUrl}/call-info/export.xlsx?${RANGE}`);
  await exp.arrayBuffer();
  const writes = fake.calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(c.sql));
  assert.deepEqual(writes.map((w) => w.sql), [], 'a projection change must move no write path');
});

/* ── 3. EXPORT END-TO-END ─────────────────────────────────────────── */

test('the XLSX Customer column is fed by the RESOLVED alias, not the raw job column', async () => {
  /*
   * Discriminating case: a job whose job_customer_name is blank, so SQL
   * resolved customer_name to the master name. An over-eager "just use the job
   * name everywhere" edit of this mapping would print an EMPTY cell; reading
   * the resolved `customer_name` prints 'Master Co'. The mapping this replaced
   * — `r.customer_name || r.job_customer_name` — preferred the MASTER name and
   * so disagreed with the on-screen table; both now read one resolved column.
   */
  scenario.callRows = [
    {
      insert_date_time: '2026-08-02 11:30:00',
      efr_name: 'Tech One', efr_no: '9000000001',
      job_id: 42, job_status: 3, job_type: 'Installation', job_efr_id: 7,
      job_customer_name: '',            // blank on the job …
      customer_name: 'Master Co',       // … so SQL resolved to the master name
      customer_mob_no: '9800000000',
    },
    {
      insert_date_time: '2026-08-02 12:30:00',
      efr_name: 'Tech Two', efr_no: '9000000002',
      job_id: 43, job_status: 3, job_type: 'Repair', job_efr_id: 8,
      job_customer_name: 'Ravi Kumar',  // job name present …
      customer_name: 'Ravi Kumar',      // … so SQL resolved to it
      customer_mob_no: '9800000001',
    },
  ];

  const res = await fetch(`${baseUrl}/call-info/export.xlsx?${RANGE}`);
  assert.equal(res.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const ws = wb.getWorksheet('Call History');
  assert.ok(ws, 'Call History sheet must exist');

  // Locate the header row + Customer column BY NAME, so a layout change
  // (title/meta bands, added columns) cannot silently pass this test.
  let headerRow = null;
  let customerCol = null;
  ws.eachRow((r, n) => {
    if (headerRow) return;
    r.eachCell((cell, c) => {
      if (String(cell.value || '').trim() === 'Customer') { headerRow = n; customerCol = c; }
    });
  });
  assert.ok(headerRow && customerCol, 'a "Customer" header column must exist');

  const cellAt = (offset) => String(ws.getRow(headerRow + offset).getCell(customerCol).value || '');
  assert.equal(cellAt(1), 'Master Co', 'blank job name ⇒ the master name, never an empty cell');
  assert.equal(cellAt(2), 'Ravi Kumar', 'a job name ⇒ that job name');
});

/*
 * ── listTransactions NAMES ONLY REAL COLUMNS ──────────────────────────────
 *
 * The Transactions modal 500'd for every technician: the query joined
 * tbl_user on TJT.created_by, and tbl_job_transaction has no created_by.
 * ORDER BY TJT.transaction_id was the same bug one line down — the PK is
 * job_transaction_id — so fixing only the join would have moved the 500, not
 * removed it.
 *
 * Both came from a comment that GUESSED the column list from a legacy DAO
 * which only ever ran `SELECT *`, and so never had to name one. SELECT * is
 * still fine; a JOIN or an ORDER BY is not. This pins the two that must be
 * real, by name, against the live table's actual columns.
 */
const EFR_SRC = require('fs').readFileSync(
  require('path').join(__dirname, '..', 'services/easyfixer.service.js'), 'utf8',
);

test('listTransactions joins and orders on columns tbl_job_transaction actually has', () => {
  assert.match(EFR_SRC, /tx_user\.user_id = TJT\.updated_by/,
    'the actor column is updated_by — there is no created_by on this table');
  assert.match(EFR_SRC, /ORDER BY TJT\.job_transaction_id DESC/,
    'the PK is job_transaction_id — there is no transaction_id');
});

test('neither phantom column survives anywhere in the transactions query', () => {
  const fn = EFR_SRC.slice(EFR_SRC.indexOf('async function listTransactions('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  /*
   * COMMENTS STRIPPED FIRST. The fix's own comment quotes the error verbatim
   * ("Unknown column 'TJT.created_by'"), so a raw substring search matches the
   * explanation and fails a file that is correct — the test would be reporting
   * on prose, not on SQL. Only executable text is searched.
   */
  const sql = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/TJT\.created_by/.test(sql), false, 'created_by does not exist');
  assert.equal(/TJT\.transaction_id\b/.test(sql), false, 'transaction_id does not exist');
  // And the check has teeth: the real column names ARE still there.
  assert.match(sql, /TJT\.updated_by/);
  assert.match(sql, /TJT\.job_transaction_id/);
});
