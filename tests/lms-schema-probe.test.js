const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * The LMS column probes.
 *
 * `courses.is_mandatory` and `training_videos.is_global` arrive by ALTER
 * (2026-08-26-lms-mandatory-flags.sql), so code that names them can ship ahead
 * of the migration — which is exactly what happened on 2026-08-26, taking the
 * Content page down with an unconditional `c.is_mandatory` in its SELECT.
 *
 * What is pinned here is not "the probe runs" but the three things whose
 * failure is silent:
 *
 *   1. a missing column NEVER reaches the SQL, so no query can 500 on it;
 *   2. the degraded SQL keeps its PLACEHOLDER COUNT — three callers bind
 *      positionally, and an arm that vanished with its `?` would misalign
 *      every later parameter instead of failing loudly;
 *   3. a FAILED probe assumes PRESENT — the opposite default would let one
 *      information_schema hiccup switch off mandatory training platform-wide.
 */

const PROBE = /information_schema\.columns/i;
const COURSE_LIST = /FROM\s+courses c/i;

const fake = installFakePool();
const lms = require('../services/lms.service');

after(() => fake.restore());

// Route queries, with the probe answering `present`. Returns a restore fn.
function withSchema(present, extra = []) {
  const db = require('../db');
  const previous = db.pool.query;
  db.pool.query = async (sql, params) => {
    const text = Array.isArray(sql) ? String(sql[0]) : String(sql);
    fake.calls.push({ sql: text, params });
    if (PROBE.test(text)) {
      if (present === 'throw') throw new Error('information_schema unavailable');
      return [present.map(([t, c]) => ({ t, c })), []];
    }
    for (const [re, resp] of extra) {
      if (re.test(text)) return [typeof resp === 'function' ? resp(text, params) : resp, []];
    }
    return [[], []];
  };
  return () => { db.pool.query = previous; };
}

const BOTH = [['courses', 'is_mandatory'], ['training_videos', 'is_global']];
const NEITHER = [];

function reset(present, extra) {
  lms.invalidateLmsSchemaCache();
  fake.reset();
  return withSchema(present, extra);
}

// Count `?` outside string literals — the arity the callers bind against.
function placeholders(sql) {
  return (sql.replace(/'[^']*'/g, '').match(/\?/g) || []).length;
}

// ─── 1. A missing column never reaches the SQL ───────────────────────

test('listCourses omits is_mandatory when the column is absent', async () => {
  const restore = reset(NEITHER, [[COURSE_LIST, [{ total: 0 }]]]);
  await lms.listCourses({});
  restore();
  const listSql = fake.calls.map((c) => c.sql).filter((s) => COURSE_LIST.test(s)).join('\n');
  assert.ok(listSql.length, 'the course list query should have run');
  assert.ok(!/c\.is_mandatory/.test(listSql),
    'a column that does not exist must not be named in the SELECT');
  assert.ok(/0 AS is_mandatory/.test(listSql),
    'the alias must survive so the CRM still gets the key it renders');
});

test('listCourses names is_mandatory when the column is present', async () => {
  const restore = reset(BOTH, [[COURSE_LIST, [{ total: 0 }]]]);
  await lms.listCourses({});
  restore();
  const listSql = fake.calls.map((c) => c.sql).filter((s) => COURSE_LIST.test(s)).join('\n');
  assert.ok(/c\.is_mandatory/.test(listSql), 'the real column must be read once it exists');
});

test('mandatoryOnly returns nothing rather than everything without the column', async () => {
  const restore = reset(NEITHER, [[COURSE_LIST, [{ total: 0 }]]]);
  await lms.listCourses({ mandatoryOnly: true });
  restore();
  const listSql = fake.calls.map((c) => c.sql).filter((s) => COURSE_LIST.test(s)).join('\n');
  assert.ok(/1=0/.test(listSql),
    'dropping the filter would list EVERY course as mandatory — it must return none');
});

test('createCourse drops the column and its value together', async () => {
  const restore = reset(NEITHER, [[/^\s*INSERT INTO courses/i, { insertId: 7 }]]);
  await lms.createCourse({ name: 'Induction', is_mandatory: true });
  restore();
  const ins = fake.calls.find((c) => /^\s*INSERT INTO courses/i.test(c.sql));
  assert.ok(ins, 'the course should still be creatable pre-migration');
  assert.ok(!/is_mandatory/.test(ins.sql));
  // 4 columns named -> 4 binds. A dropped column with its value left behind
  // is the failure this asserts against.
  assert.equal(placeholders(ins.sql), ins.params.length,
    'placeholder count must match the bound parameters');
});

test('assignMandatoryCourses assigns nothing without the column', async () => {
  const restore = reset(NEITHER, [[/INSERT INTO easyfixer_courses/i, { affectedRows: 0 }]]);
  const res = await lms.assignMandatoryCourses(8379);
  restore();
  assert.equal(res.assigned, 0, 'no flag means nothing is mandatory, so nobody is assigned');
  const ins = fake.calls.find((c) => /INSERT INTO easyfixer_courses/i.test(c.sql));
  assert.ok(ins, 'the INSERT still runs — it is the ternary that empties it, not a branch');
  assert.ok(!/is_mandatory/.test(ins.sql) && /1=0/.test(ins.sql),
    'the absent column must not be named, and the predicate must match nothing');
});

// ─── 2. Degraded SQL keeps its placeholder count ─────────────────────

test('the mandatory/visible SQL keeps its arity in both schema states', async () => {
  let restore = reset(BOTH);
  const mandatoryFull = await lms.mandatoryVideoIdsSql();
  const visibleFull = await lms.visibleVideoIdsSql();
  restore();

  restore = reset(NEITHER);
  const mandatoryBare = await lms.mandatoryVideoIdsSql();
  const visibleBare = await lms.visibleVideoIdsSql();
  restore();

  assert.equal(placeholders(mandatoryFull), 1, 'callers bind the technician once');
  assert.equal(placeholders(visibleFull), 2, 'and twice for the visible set');
  assert.equal(placeholders(mandatoryBare), placeholders(mandatoryFull),
    'a dropped UNION arm would take its ? with it and misalign every later param');
  assert.equal(placeholders(visibleBare), placeholders(visibleFull));

  assert.ok(!/is_global|is_mandatory/.test(mandatoryBare),
    'neither absent column may be named');
  assert.ok(/is_global/.test(mandatoryFull) && /is_mandatory/.test(mandatoryFull),
    'both must be named once they exist');
});

// ─── 3. A failed probe assumes PRESENT ───────────────────────────────

test('a probe that throws assumes the columns are there', async () => {
  const restore = reset('throw');
  const sql = await lms.mandatoryVideoIdsSql();
  restore();
  assert.ok(/tv\.is_global = 1/.test(sql) && /c\.is_mandatory = 1/.test(sql),
    'concluding "absent" from a failed query would disable mandatory training '
    + 'for everyone on a transient information_schema error');
});

// ─── The probe is cached, not run per query ──────────────────────────

test('the probe runs once across many builds, not once per build', async () => {
  const restore = reset(BOTH);
  await lms.mandatoryVideoIdsSql();
  await lms.mandatoryVideoIdsSql();
  await lms.visibleVideoIdsSql();
  restore();
  const probes = fake.calls.filter((c) => PROBE.test(c.sql)).length;
  assert.equal(probes, 1, 'this sits in front of the technician training screen');
});

// ─── The guard that outlives this change ─────────────────────────────

/*
 * Every read of the two probed columns must go through the probe.
 *
 * This is not belt-and-braces. While this probe was being written, a parallel
 * change ("Put mandatory courses first in the technician's LMS list", 91d02f7)
 * added TWO fresh unconditional `c.is_mandatory` reads to coursesForTech — the
 * technician's own LMS screen. The class of bug reappeared inside the same
 * afternoon it was being fixed, which is the argument for checking the source
 * rather than trusting the next author to remember.
 *
 * Comments are STRIPPED before scanning. Half the occurrences in this file are
 * prose explaining the probe, and a scanner that matched its own rationale
 * would fail the moment the reasoning was written down.
 */

// Blank out comments, preserving line structure so numbers stay honest.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

const PROBED_COLUMNS = /\b(is_mandatory|is_global)\b/;
// The probe's own declaration of what it looks for: ['courses', 'is_mandatory'].
const DECLARATION = /^\s*\['(?:courses|training_videos)',\s*'(?:is_mandatory|is_global)'\],?\s*$/;
const PROBE_MARKER = /\b(courseMandatory|videoGlobal)\b/;
const LOG_LINE = /\blogger\.(warn|info|error|debug)\(/;

test('no read of a probed column escapes the probe', async () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');

  // Files that legitimately name these columns. A new one appearing here is
  // itself the signal to re-run this reasoning.
  const scanned = [
    'services/lms.service.js',
    'services/mobile-registration.service.js',
    'routes/mobile/index.js',
    'routes/admin/auxiliary.js',
  ];

  /*
   * FAIL SAFE: every surviving occurrence is checked. An earlier version tried
   * to be clever and look only INSIDE template literals, tracking backtick
   * parity across the file — and stripComments eats the `//` in a URL or a
   * regex, so the parity silently inverted and the scanner went blind on two of
   * the four bug shapes while still reporting green. A tripwire that lies is
   * worse than no tripwire, so the shapes that are NOT column reads are now
   * subtracted by name and everything else has to justify itself.
   *
   * These three are JavaScript, not SQL — a destructured default, a bare
   * argument, and a property of the patch object. No database ever sees them.
   */
  const JS_SHAPES = [
    /patch\.is_mandatory/g,
    /(?<![.\w'])is_mandatory = false/g,
    /(?<![.\w'])is_mandatory(?= \?)/g,
  ];

  const violations = [];
  for (const rel of scanned) {
    const lines = stripComments(fs.readFileSync(path.join(root, rel), 'utf8')).split('\n');
    lines.forEach((raw, i) => {
      // Subtract the JS shapes, then ask what is left.
      const line = JS_SHAPES.reduce((acc, re) => acc.replace(re, ''), raw);
      if (!PROBED_COLUMNS.test(line)) return;
      if (DECLARATION.test(line)) return;
      // Log prose naming the column is not SQL and cannot 500 anything.
      if (LOG_LINE.test(line)) return;
      // The marker must be on THIS line, or on the guard immediately above it
      // (updateCourse puts the `if` on one line and the assignment on the next).
      // ONE line of lookback, never a scan of the enclosing function: that
      // looser rule was tried first and was WORSE THAN NOTHING — coursesForTech
      // consults the probe for one column and 91d02f7's unguarded read sat a few
      // lines below it, so the check passed on the very bug it exists for.
      if (PROBE_MARKER.test(line)) return;
      if (PROBE_MARKER.test(lines[i - 1] || '')) return;
      violations.push(`${rel}:${i + 1}  ${raw.trim()}`);
    });
  }

  assert.deepEqual(violations, [],
    'these name a column that arrives by ALTER without asking whether it is there yet — '
    + 'route them through lmsFlagColumns() (see services/lms.service.js)');
});
