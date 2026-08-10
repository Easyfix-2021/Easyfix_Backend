/*
 * THE EMPTY-STRING PIN for the job-scoped customer name on the magic-link
 * (public Unconfirmed-Order) surface.
 *
 * WHAT CHANGED. A customer name rendered on a JOB surface must come from
 * `tbl_job.job_customer_name` — the name typed on the booking page — and only
 * fall back to the `tbl_customer` master row. Two statements in
 * services/job-magic-link.service.js carry that projection:
 *
 *   fetchPrefill()  → the public GET payload  (customer.name on the form)
 *   sendForJob()    → the WhatsApp `confirm_order` greeting  (bodyValues 1)
 *
 * THE TRAP THIS FILE EXISTS FOR. The obvious spelling —
 *
 *     COALESCE(j.job_customer_name, cu.customer_name)
 *
 * — is WRONG. MySQL's COALESCE only skips NULL, so `COALESCE('', 'Master')`
 * evaluates to '' and the surface renders a BLANK name. `job_customer_name` is
 * written straight from a form field (validators/job.validator.js:235 and :325
 * both `.allow('')`, and services/job.service.js binds the value verbatim in
 * both create() and the MUTABLE_COLUMNS update loop), so an empty string is
 * reachable from the FE. The correct spelling is
 *
 *     COALESCE(NULLIF(TRIM(j.job_customer_name), ''), cu.customer_name)
 *
 * HOW IT IS PINNED. A string match on the SQL would pass for the wrong reason
 * the moment someone rewrites the expression. So instead the test EXTRACTS the
 * `AS customer_name` expression out of the SQL the service actually issued and
 * EVALUATES it with a miniature MySQL-semantics interpreter (COALESCE / NULLIF
 * / TRIM). Revert to the plain COALESCE form and the empty-string case returns
 * '' and these tests fail — which is exactly the regression to catch. The
 * interpreter is itself proven honest below by feeding it the OLD expression
 * and asserting it reproduces the blank.
 *
 * Non-destructive: fake pool, no real DB, zero writes. Runner: `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { makeFakePool } = require('./helpers/fake-pool');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-magic-link';

/* ── Stub the two outbound side-effect modules BEFORE the service is required.
 *    Seeding require.cache is the seam that keeps sendForJob() offline: the
 *    service captures both at module load, so the stub must land first. ──── */
const sent = [];
function stubModule(relPath, exports) {
  const full = require.resolve(path.join(__dirname, '..', relPath));
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
}
stubModule('services/gallabox.whatsapp.service', {
  async sendTemplate(args) { sent.push(args); return { delivered: true, providerMessageId: 'stub-1' }; },
});
stubModule('services/url-shortener.service', {
  async shortenUrl() { return { short_url: 'https://s.test/abc' }; },
});

const magic = require('../services/job-magic-link.service');

/* ───────────────────────── the mini MySQL interpreter ───────────────────── */

/*
 * Pull the expression aliased `AS <alias>` out of a SELECT list. Walks
 * BACKWARDS from the alias with a paren-depth counter so a comma nested inside
 * COALESCE(...) is not mistaken for the select-list separator. `--` line
 * comments are stripped first (the projections carry explanatory ones).
 * Known limit: a top-level comma inside a string literal would confuse the
 * walk — none of the expressions under test contain one ('' is the only
 * literal).
 */
function extractProjection(sql, alias) {
  const clean = String(sql).replace(/--[^\n]*/g, '');
  const m = new RegExp(`\\bAS\\s+${alias}\\b`, 'i').exec(clean);
  assert.ok(m, `SQL must project an "AS ${alias}" column`);
  const head = clean.slice(0, m.index);
  let depth = 0;
  let start = 0;
  for (let i = head.length - 1; i >= 0; i--) {
    const ch = head[i];
    if (ch === ')') depth++;
    else if (ch === '(') depth--;
    else if ((ch === ',' && depth === 0) || (depth < 0)) { start = i + 1; break; }
  }
  return head.slice(start).trim();
}

/*
 * Evaluate a projection expression against a seeded raw-column map, applying
 * MySQL's own semantics for the three functions in play. `null` models SQL
 * NULL. An unseeded column throws rather than silently reading as undefined,
 * so a renamed source column surfaces as a loud test failure.
 */
function evalSql(expr, cols) {
  let i = 0;
  const ws = () => { while (i < expr.length && /\s/.test(expr[i])) i++; };

  const apply = (fn, args) => {
    switch (fn) {
      case 'COALESCE': return args.find((a) => a !== null && a !== undefined) ?? null;
      case 'NULLIF':   return args[0] === args[1] ? null : args[0];
      case 'TRIM':     return args[0] === null || args[0] === undefined ? null : String(args[0]).trim();
      default: throw new Error(`mini-SQL: unsupported function ${fn}()`);
    }
  };

  function parse() {
    ws();
    if (expr[i] === "'") {                       // string literal ('' escapes)
      i++;
      let s = '';
      while (i < expr.length) {
        if (expr[i] === "'" && expr[i + 1] === "'") { s += "'"; i += 2; continue; }
        if (expr[i] === "'") { i++; break; }
        s += expr[i++];
      }
      return s;
    }
    const start = i;
    while (i < expr.length && /[A-Za-z0-9_.$]/.test(expr[i])) i++;
    const name = expr.slice(start, i);
    assert.notEqual(name, '', `mini-SQL: cannot parse at offset ${i} of ${expr}`);
    ws();
    if (expr[i] === '(') {                       // function call
      i++;
      const args = [];
      ws();
      if (expr[i] === ')') { i++; } else {
        for (;;) {
          args.push(parse());
          ws();
          if (expr[i] === ',') { i++; continue; }
          if (expr[i] === ')') { i++; break; }
          throw new Error(`mini-SQL: unexpected "${expr[i]}" at ${i} of ${expr}`);
        }
      }
      return apply(name.toUpperCase(), args);
    }
    if (!(name in cols)) throw new Error(`mini-SQL: unseeded column ${name}`);
    return cols[name];
  }

  const out = parse();
  ws();
  assert.equal(i, expr.length, `mini-SQL: trailing input in ${expr}`);
  return out;
}

/* Column seeds. `job` = what the booking page typed onto tbl_job. */
const seed = (jobName) => ({
  'j.job_customer_name': jobName,
  'cu.customer_name': 'Priya Master',
});

/* ── The interpreter is honest: it reproduces the OLD bug ────────────────── */

test('the mini-SQL interpreter reproduces the plain-COALESCE blank (self-check)', () => {
  const old = 'COALESCE(j.job_customer_name, cu.customer_name)';
  assert.equal(evalSql(old, seed('')), '', 'plain COALESCE must render the BLANK — that is the bug');
  assert.equal(evalSql(old, seed(null)), 'Priya Master', 'plain COALESCE does handle NULL');
});

/* ── The projection each statement actually issues ───────────────────────── */

async function capture(run) {
  const fake = makeFakePool([
    [/^SELECT j\.job_id/i, () => [{}]],   // shape irrelevant; we want the SQL text
  ]);
  try { await run(fake.pool); } catch { /* downstream steps may bail — SQL is captured */ }
  return fake.calls;
}

const JOB_SELECT = /FROM tbl_job j\s+LEFT JOIN tbl_customer cu/i;

for (const [label, run] of [
  ['fetchPrefill', (pool) => magic.fetchPrefill(4242, pool)],
  ['sendForJob',   (pool) => magic.sendForJob(4242, { action: 'first' }, pool)],
]) {
  test(`${label}: an EMPTY-STRING job_customer_name falls back to the MASTER name`, async () => {
    const calls = await capture(run);
    const stmt = calls.find((c) => JOB_SELECT.test(c.sql) && /AS customer_name/i.test(c.sql));
    assert.ok(stmt, `${label} must select customer_name off tbl_job joined to tbl_customer`);
    const expr = extractProjection(stmt.sql, 'customer_name');

    // THE PIN.
    assert.equal(evalSql(expr, seed('')), 'Priya Master',
      'empty string must fall through to the customer-master name, not render blank');
    assert.equal(evalSql(expr, seed('   ')), 'Priya Master',
      'whitespace-only is blank too — TRIM must collapse it before the NULLIF');
    // And the rest of the truth table.
    assert.equal(evalSql(expr, seed(null)), 'Priya Master', 'NULL falls back');
    assert.equal(evalSql(expr, seed('Booked As Ravi')), 'Booked As Ravi',
      'a real booking-page name WINS over the customer-master name');
    assert.equal(evalSql(expr, { 'j.job_customer_name': null, 'cu.customer_name': null }), null,
      'both empty stays NULL — callers apply their own `|| ""`');
  });

  test(`${label}: the FE-facing alias and the tbl_customer join are unchanged`, async () => {
    const calls = await capture(run);
    const stmt = calls.find((c) => JOB_SELECT.test(c.sql) && /AS customer_name/i.test(c.sql));
    // (a) alias the consumers read stays `customer_name`.
    assert.match(stmt.sql, /AS customer_name\b/, 'consumers destructure row.customer_name');
    // (b) the fallback's join is present in the SAME statement — the expression
    //     introduces no new alias, so nothing else has to grow a join.
    assert.match(stmt.sql, /LEFT JOIN tbl_customer cu ON cu\.customer_id = j\.fk_customer_id/);
    // (c) no separate COUNT statement exists on this surface, so the
    //     "projection needs a join the COUNT query lacks" hazard cannot apply.
    assert.equal(calls.filter((c) => /SELECT\s+COUNT\(/i.test(c.sql)).length, 0,
      'magic-link reads are single-row fetches — no paginated COUNT companion');
  });
}

/* ── End-to-end: the value that reaches the consumer ─────────────────────── */

/*
 * Both integration tests drive the REAL service against a fake pool whose job
 * row is COMPUTED by evaluating the service's own projection — so the row the
 * code receives is exactly what MySQL would have handed it.
 */
function jobRowFrom(sql, jobName, extra = {}) {
  const expr = extractProjection(sql, 'customer_name');
  return {
    job_id: 4242,
    fk_client_id: 30,
    fk_address_id: 10,
    job_status: 0,
    customer_name: evalSql(expr, seed(jobName)),
    customer_mob_no: '9876543210',
    customer_email: '',
    client_name: 'For Testing',
    ...extra,
  };
}

test('fetchPrefill: customer.name on the public form shows the MASTER name when the job name is empty', async () => {
  const fake = makeFakePool([
    [JOB_SELECT, (sql) => [jobRowFrom(sql, '')]],
  ]);
  const out = await magic.fetchPrefill(4242, fake.pool);
  assert.equal(out.customer.name, 'Priya Master', 'the form must not render a blank name');
});

test('fetchPrefill: customer.name prefers the BOOKING-PAGE name over the master name', async () => {
  const fake = makeFakePool([
    [JOB_SELECT, (sql) => [jobRowFrom(sql, 'Booked As Ravi')]],
  ]);
  const out = await magic.fetchPrefill(4242, fake.pool);
  assert.equal(out.customer.name, 'Booked As Ravi');
});

test('sendForJob: the WhatsApp greeting uses the BOOKING-PAGE name, and never a blank', async () => {
  const routes = (jobName) => [
    [/UPDATE tbl_job\s+SET magic_link_send_count = magic_link_send_count \+ 1/i, { affectedRows: 1 }],
    [/^UPDATE tbl_job/i, { affectedRows: 1 }],
    [JOB_SELECT, (sql) => [jobRowFrom(sql, jobName, {
      magic_link_sent_at: null, magic_link_send_count: 0, max_send_count: 3,
    })]],
  ];

  sent.length = 0;
  await magic.sendForJob(4242, { action: 'first' }, makeFakePool(routes('Booked As Ravi')).pool);
  assert.equal(sent.at(-1).recipientName, 'Booked As Ravi');
  assert.equal(sent.at(-1).bodyValues[1], 'Booked As Ravi', 'greeting {{1}} is the job-scoped name');

  sent.length = 0;
  await magic.sendForJob(4242, { action: 'first' }, makeFakePool(routes('')).pool);
  assert.equal(sent.at(-1).bodyValues[1], 'Priya Master',
    'an empty job name must NOT produce a blank greeting — it falls back to the master name');
});
