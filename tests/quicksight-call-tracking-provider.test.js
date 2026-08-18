/*
 * The Provider FILTER and the Provider CELL must say the same thing.
 *
 * ─── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 *
 * The Call Tracking drill-down for job 529116 showed seven calls from 18 Aug
 * 2026 with a BLANK Provider cell — while filtering that same report by Kaleyra
 * returned those same seven rows. One file held two beliefs about one column:
 *
 *   the filter  — "unstamped means Kaleyra" (only two vendors ever existed, so
 *                 the 941,968 rows with provider NULL are the old CRM's Kaleyra
 *                 history, and 'not plivo' IS Kaleyra)
 *   the cell    — the raw column, passed straight through, so NULL rendered as
 *                 the FE's em-dash fallback: "we have no idea".
 *
 * The fix makes both derive from ONE expression (PROVIDER_RULE). These tests
 * exist so the two can never drift apart again — which is the only failure mode
 * that matters here, and the one a row fixture cannot show, because a query that
 * labels a row wrongly returns exactly as many rows as one that labels it right.
 *
 * ─── HOW THEY TEST IT ─────────────────────────────────────────────────────
 *
 * The shipped SQL fragments are read from the service's `_test` seam and
 * EVALUATED against MySQL's semantics by the tiny interpreter below (three-
 * valued logic; case- and trailing-space-insensitive comparison). So these assertions are made
 * against the text that actually ships, not a re-statement of it — a
 * re-statement would be a third belief about the same column.
 *
 * Runner: `node --test`.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { installFakePool } = require('./helpers/fake-pool');

// The drill-down is the only statement selecting `AS id` off the PK column.
const DRILL_SQL = /jci\.job_caller_info AS id/;
let drillRows = [];
const fake = installFakePool([[DRILL_SQL, () => drillRows]]);
after(() => fake.restore());

const service = require('../services/quicksight/quicksight-call-tracking.service');
const { PROVIDER_RULE, PROVIDER_CLAUSE, PROVIDER_LABELS } = service._test;

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'quicksight', 'quicksight-call-tracking.service.js'), 'utf8',
);

/* ─── A very small MySQL interpreter, for the shapes this rule uses ────────
 *
 * Supports exactly what PROVIDER_RULE contains: the raw column, NULLIF(TRIM
 * (col), ''), = / <> against a literal, IS NULL, AND / OR, and CASE WHEN … THEN
 * … ELSE … END. Anything else in a fragment shows up as a ReferenceError when
 * the compiled function runs, which is the failure we want if the rule grows a
 * shape this harness cannot judge.
 */

/*
 * The harness MODELS a PAD SPACE, case-insensitive collation: 'PLIVO' and
 * 'plivo  ' both equal 'plivo'; leading whitespace does not.
 *
 * ⚠ That is a MODEL, not a verified fact about the deployed column. MySQL 8's
 * default utf8mb4_0900_ai_ci is NO PAD, under which 'plivo ' does NOT equal
 * 'plivo', and nothing in this repo pins which collation the column actually
 * has.
 *
 * It does not matter here, and the reason it does not matter is the whole point
 * of PROVIDER_RULE: the filter and the label read the SAME comparison, so they
 * move together under either collation. Whichever way the database resolves
 * 'plivo ', the row lands in a tab and the cell names that tab. The agreement
 * table below is therefore collation-agnostic — it asserts a RELATIONSHIP
 * between two expressions, never an absolute verdict on one.
 */
const collate = (s) => String(s).replace(/ +$/, '').toLowerCase();
const eq = (a, b) => (a === null ? null : collate(a) === collate(b));
const ne = (a, b) => (a === null ? null : collate(a) !== collate(b));
const isNull = (a) => a === null;

function compile(fragment) {
  let js = String(fragment).replace(/\s+/g, ' ').trim();
  // A WHERE fragment arrives as " AND <predicate>".
  js = js.replace(/^AND /, '');
  js = js.split("NULLIF(TRIM(jci.provider), '')").join('NORM');
  js = js.split('jci.provider').join('RAW');
  js = js.replace(/(NORM|RAW) = '([^']*)'/g, "eq($1, '$2')");
  js = js.replace(/(NORM|RAW) <> '([^']*)'/g, "ne($1, '$2')");
  js = js.replace(/(NORM|RAW) IS NULL/g, 'isNull($1)');
  js = js.replace(/ OR /g, ' || ').replace(/ AND /g, ' && ');
  js = js.replace(/CASE WHEN (.+?) THEN (.+?) ELSE (.+?) END/g, '(($1) ? $2 : $3)');
  assert.equal(/CASE|WHEN|NULLIF|TRIM|jci\./.test(js), false,
    `the interpreter does not understand this fragment: ${fragment}`);
  // eslint-disable-next-line no-new-func -- a test-only compiler over a frozen
  // constant from our own source; nothing here reads user input.
  const fn = new Function('RAW', 'NORM', 'eq', 'ne', 'isNull', `return (${js});`);
  return (raw) => {
    const norm = raw === null ? null : (String(raw).trim() === '' ? null : String(raw).trim());
    return fn(raw, norm, eq, ne, isNull);
  };
}

const labelOf = compile(PROVIDER_RULE.label);
const namedOf = compile(PROVIDER_RULE.namedFlag);
const plivoTab = compile(PROVIDER_CLAUSE.plivo);
const kaleyraTab = compile(PROVIDER_CLAUSE.kaleyra);
// SQL truthiness: a WHERE predicate that evaluates to NULL does NOT match.
const matches = (pred, v) => pred(v) === true;

/*
 * Every distinct state the column is known to hold. The counts are from the
 * measured analysis above PROVIDER_RULE (live data, 2026-07-30); the three
 * "nothing was stamped" spellings are listed separately on purpose, because
 * '' is invisible to IS NULL and has bitten this column before.
 */
const CASES = [
  { v: 'plivo', label: 'Plivo', named: true, raw: 'plivo', why: '33 rows, explicitly stamped' },
  { v: 'kaleyra', label: 'Kaleyra', named: true, raw: 'kaleyra', why: '2 rows, explicitly stamped' },
  { v: null, label: 'Kaleyra', named: false, raw: null, why: '941,968 rows — the old CRM, all Kaleyra' },
  { v: '', label: 'Kaleyra', named: false, raw: null, why: "'' renders blank but is NOT NULL" },
  { v: '   ', label: 'Kaleyra', named: false, raw: null, why: 'whitespace-only is a third spelling of nothing' },
  { v: 'JIO', label: 'Kaleyra', named: false, raw: 'JIO', why: 'legacy stored the telecom CARRIER here' },
];

// ─── The one rule ──────────────────────────────────────────────────────────

test('the filter and the label are derived from ONE expression', () => {
  // Not "both mention plivo" — the label must contain the filter's predicate
  // VERBATIM, so editing one cannot leave the other behind.
  assert.equal(PROVIDER_CLAUSE.plivo, ` AND ${PROVIDER_RULE.isPlivo}`);
  assert.equal(PROVIDER_CLAUSE.kaleyra, ` AND ${PROVIDER_RULE.notPlivo}`);
  assert.ok(PROVIDER_RULE.label.includes(PROVIDER_RULE.isPlivo),
    'the label must reuse the filter predicate, not restate it');
  assert.ok(PROVIDER_RULE.namedFlag.includes(PROVIDER_RULE.isPlivo),
    'the "was it stamped" test must reuse the same predicate too');
});

test('the drill-down no longer projects the raw column as `provider`', () => {
  // The bug, restated in one line of SQL. If this comes back, the cell blanks.
  assert.equal(/jci\.provider\s+AS provider\b/.test(SRC), false,
    'projecting the raw column as `provider` is exactly the reported bug');
  assert.match(SRC, /\$\{PROVIDER_RULE\.label\}\s+AS providerLabel/);
  assert.match(SRC, /\$\{PROVIDER_RULE\.namedFlag\}\s+AS providerNamedFlag/);
  assert.match(SRC, /\$\{PROVIDER_RULE\.value\}\s+AS providerRaw/);
});

test('the rule buckets on the VALUE alone — no date boundary anywhere in it', () => {
  /*
   * A cutoff ("NULL before 2026-06-04 is Kaleyra, after that it is Unknown")
   * would relabel the seven reported rows — they are from 18 Aug 2026 — and
   * reproduce the same contradiction with a different word in the cell.
   */
  for (const frag of [PROVIDER_RULE.isPlivo, PROVIDER_RULE.notPlivo, PROVIDER_RULE.label,
    PROVIDER_RULE.namedFlag, PROVIDER_RULE.value]) {
    assert.equal(/inserted_time|DATE|20\d\d-\d\d-\d\d/i.test(frag), false,
      `the vendor rule must not look at time: ${frag}`);
  }
});

// ─── Filter ↔ label agreement, value by value ─────────────────────────────

for (const c of CASES) {
  const shown = c.v === null ? 'NULL' : JSON.stringify(c.v);

  test(`${shown} — label, filter and stamped-ness all agree (${c.why})`, () => {
    // 1. the cell is never blank, and never prints a carrier as a vendor
    assert.equal(labelOf(c.v), c.label);
    assert.ok(Object.values(PROVIDER_LABELS).includes(labelOf(c.v)),
      `${shown} produced a label that is not one of the two vendors`);

    // 2. the two tabs PARTITION the rows: exactly one of them returns this row
    const inPlivo = matches(plivoTab, c.v);
    const inKaleyra = matches(kaleyraTab, c.v);
    assert.equal(inPlivo && inKaleyra, false, `${shown} is returned by BOTH tabs`);
    assert.equal(inPlivo || inKaleyra, true, `${shown} is returned by NEITHER tab`);

    // 3. THE BUG: the tab that returns the row is the vendor the cell prints.
    assert.equal(inPlivo ? PROVIDER_LABELS.plivo : PROVIDER_LABELS.kaleyra, c.label,
      `${shown} is filtered as one vendor and displayed as the other`);

    // 4. inferred vs asserted — 1 only when the column itself named a vendor
    assert.equal(namedOf(c.v), c.named ? 1 : 0);
  });
}

// ─── The generated SQL is unchanged ───────────────────────────────────────

test('the filter clauses are byte-for-byte what they always were', () => {
  /*
   * The row sets these two produce are load-bearing for every KPI, table, trend
   * and export on the page. This change was allowed to alter what the report
   * DISPLAYS, never which rows it counts, so the strings are pinned literally.
   */
  assert.equal(PROVIDER_CLAUSE.plivo, " AND jci.provider = 'plivo'");
  assert.equal(PROVIDER_CLAUSE.kaleyra, " AND (jci.provider IS NULL OR jci.provider <> 'plivo')");
});

test('buildScope still emits those exact clauses into the statement', async () => {
  for (const [provider, clause] of Object.entries(PROVIDER_CLAUSE)) {
    fake.reset();
    drillRows = [];
    await service.getCallDetails({ provider }, { jobId: 529116 });
    const sql = (fake.calls.find((c) => DRILL_SQL.test(c.sql)) || {}).sql || '';
    assert.ok(sql.includes(clause), `the ${provider} filter no longer reaches the query`);
  }
  // …and the default (no provider chosen) still applies NO predicate, so both
  // tabs' worth of calls are included — the behaviour ops relies on.
  fake.reset();
  drillRows = [];
  await service.getCallDetails({}, { jobId: 529116 });
  const sql = (fake.calls.find((c) => DRILL_SQL.test(c.sql)) || {}).sql || '';
  for (const clause of Object.values(PROVIDER_CLAUSE)) {
    // The clause, not the bare predicate: the predicate also appears in the
    // projection now (that is the whole point — one expression, both places).
    assert.equal(sql.includes(clause), false, 'an unfiltered report must not filter by vendor');
  }
});

// ─── What the response actually carries ───────────────────────────────────

test('every drill-down row carries a non-empty provider, plus the raw value beside it', async () => {
  /*
   * The DB columns are produced by running the SHIPPED SQL fragments through the
   * interpreter above, so this covers the whole path — rule → projection →
   * response — rather than a hand-written idea of what the DB would return.
   */
  fake.reset();
  drillRows = CASES.map((c, i) => ({
    id: i + 1,
    jobId: 529116,
    callAt: '2026-08-18 11:00:00',
    callerId: 102,
    providerLabel: labelOf(c.v),
    providerNamedFlag: namedOf(c.v),
    providerRaw: c.v === null || String(c.v).trim() === '' ? null : String(c.v).trim(),
    durationSecs: 30,
  }));

  const { items } = await service.getCallDetails({}, { jobId: 529116 });
  assert.equal(items.length, CASES.length);

  items.forEach((row, i) => {
    const c = CASES[i];
    const shown = c.v === null ? 'NULL' : JSON.stringify(c.v);
    // The reported bug, at the field the FE renders as {provider || '—'}.
    assert.ok(row.provider, `${shown} still produces a blank Provider cell`);
    assert.equal(row.provider, c.label);
    // Additive, ignored by the current FE: was this deduced or stamped…
    assert.equal(row.providerAssumed, !c.named);
    // …and what was actually stored, for a tooltip. A carrier is preserved here
    // and nowhere else — never as the printed vendor.
    assert.equal(row.providerRaw, c.raw);
  });
});

test('a row with no provider columns at all still labels, never blanks', async () => {
  // Fail-safe: if the projection is ever dropped, the cell must fall back to the
  // vendor the filter would have assigned, not to an em-dash.
  fake.reset();
  drillRows = [{ id: 1, jobId: 529116, callAt: '2026-08-18 11:00:00', durationSecs: 0 }];
  const { items } = await service.getCallDetails({}, { jobId: 529116 });
  assert.equal(items[0].provider, PROVIDER_LABELS.kaleyra);
  assert.equal(items[0].providerAssumed, true);
  assert.equal(items[0].providerRaw, null);
});

// ─── The behavioural surfaces keep the RAW column ─────────────────────────

test('GET /admin/calls still reads the raw column — an inferred vendor cannot be dialled', () => {
  /*
   * Recording playback, re-analyse and hangup BRANCH on this value to pick an
   * API client. Handing them "Kaleyra" for a row nobody stamped would send a
   * fetch to the wrong vendor. The display rule is for reading, not for acting.
   */
  const calls = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin', 'calls.js'), 'utf8');
  assert.match(calls, /jci\.provider/,
    'the behavioural endpoint must keep the raw column, not adopt the display label');
});

// ─── House rules ──────────────────────────────────────────────────────────

test('the SQL stays safe inside its template literals', () => {
  // Both have broken this repo: a backtick terminates the string, and a "--"
  // survives whitespace-collapsing to comment out the rest of a SELECT.
  for (const [name, frag] of Object.entries(PROVIDER_RULE)) {
    assert.equal(String(frag).includes('`'), false, `PROVIDER_RULE.${name} must not contain a backtick`);
    assert.equal(/--/.test(String(frag)), false, `PROVIDER_RULE.${name} must not contain an SQL line comment`);
    const opens = (String(frag).match(/\(/g) || []).length;
    const closes = (String(frag).match(/\)/g) || []).length;
    assert.equal(opens, closes, `PROVIDER_RULE.${name} has unbalanced parentheses`);
  }
});
