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

// ─── The entitlement OR-arm ──────────────────────────────────────────

/*
 * A technician's badge and certificate are an EARNED ENTITLEMENT, recorded once
 * on easyfixer_courses.badge_earned_at and never cleared. Course settings —
 * `status` (retired) and `certificate_enabled` — govern who can earn one NEXT;
 * they must never revoke one already earned.
 *
 * Easy to state, easy to break, because the offending query looks completely
 * ordinary. coursesForTech filtered `c.status = 1`, which reads as "don't show
 * retired courses" and is right for a catalogue — but on a technician's OWN
 * list it dropped the row entirely, taking the trophy AND the certificate
 * button with it. Retiring a course silently un-earned it. Fixed by
 *
 *     AND (c.status = 1 OR ec.badge_earned_at IS NOT NULL)
 *
 * One mutation test covers that one query. This covers the CLASS: every future
 * course-settings filter in the LMS services has to declare which kind it is —
 * name badge_earned_at on the line (it serves an entitlement, so it carries the
 * OR-arm), or carry a marker saying why it may be narrow:
 *
 *     // entitlement-guard: <why>
 *
 * Default-deny, because the two are indistinguishable in SQL and differ
 * entirely in meaning — the author is the only one who knows which they wrote.
 */

const ENTITLEMENT_FILES = [
  'services/lms.service.js',
  'services/lms-action.service.js',
];

// A COMPARISON on a course setting. A bare projection (`c.status,`) is not a
// filter and cannot revoke anything, so it is not matched.
const COURSE_SETTING_FILTER = /\bc\.(?:status|certificate_enabled)\s*(?:=|<>|!=|>=|<=|>|<|\bIN\b)/;
const ENTITLEMENT_MARKER = /entitlement-guard:/;
const OR_ARM = /badge_earned_at/;

/*
 * The marker counts on the line itself, or in the unbroken comment block
 * directly above it. A fixed lookback does not survive contact with real code:
 * the filter worth marking is exactly the one needing a paragraph to justify,
 * and the paragraph pushes the marker out of range. Any statement between the
 * two ends the walk, so a marker cannot drift onto unrelated code. Same rule as
 * scripts/verify-scope-predicates.js.
 */
const COMMENT_OR_BLANK = /^\s*(?:\/\/|\*|\/\*)|^\s*$/;
// The nearest DECLARATION above the filter — a function, or a module-level
// const holding a SQL fragment (LIVE_FROM and friends are not functions).
const FUNCTION_START = /^(?:async\s+)?function\s+\w+\s*\(|^const\s+\w+\s*=/;

function entitlementMarkedNear(lines, i) {
  if (ENTITLEMENT_MARKER.test(lines[i])) return true;
  for (let k = i - 1; k >= 0; k -= 1) {
    if (!COMMENT_OR_BLANK.test(lines[k])) return false;
    if (ENTITLEMENT_MARKER.test(lines[k])) return true;
  }
  return false;
}

/*
 * The filter is often INSIDE a SQL template literal, where a `//` marker is
 * impossible — it would be neither a JS comment nor valid SQL, and would ship
 * to MySQL inside the query string. Those take a FUNCTION-level marker instead,
 * in the comment block above the function that builds the SQL.
 *
 * That is the more honest scope anyway: "this whole builder is job gating, not
 * an entitlement read" is a property of the function, not of one line of its
 * WHERE clause. It still cannot drift — the walk stops at the function it is
 * inside and reads only the unbroken comment block directly above it.
 */
function entitlementMarkedOnFunction(lines, i) {
  let fn = -1;
  for (let k = i; k >= 0; k -= 1) {
    if (FUNCTION_START.test(lines[k])) { fn = k; break; }
  }
  if (fn < 0) return false;
  for (let k = fn - 1; k >= 0; k -= 1) {
    if (!COMMENT_OR_BLANK.test(lines[k])) return false;
    if (ENTITLEMENT_MARKER.test(lines[k])) return true;
  }
  return false;
}

/* Blank comment BODIES so prose describing the rule is not mistaken for it —
 * but keep any line carrying the marker, which is the whole point of a marker
 * living in a comment. Line structure is preserved so numbers stay honest. */
function stripProse(src) {
  let inBlock = false;
  return src.split('\n').map((line) => {
    if (ENTITLEMENT_MARKER.test(line)) return line;
    let out = '';
    for (let i = 0; i < line.length; i += 1) {
      if (inBlock) {
        if (line[i] === '*' && line[i + 1] === '/') { inBlock = false; i += 1; }
        out += ' ';
        continue;
      }
      if (line[i] === '/' && line[i + 1] === '*') { inBlock = true; out += '  '; i += 1; continue; }
      if (line[i] === '/' && line[i + 1] === '/') return out + ' '.repeat(line.length - i);
      out += line[i];
    }
    return out;
  }).join('\n');
}

function entitlementViolations(overrides = {}) {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const found = [];
  /* With synthetic input, scan ONLY what was handed in. Scanning the real files
   * too would make every self-check inherit production's findings and fail for
   * a reason that has nothing to do with the case under test. */
  const targets = Object.keys(overrides).length ? Object.keys(overrides) : ENTITLEMENT_FILES;
  for (const rel of targets) {
    const src = overrides[rel] ?? fs.readFileSync(path.join(root, rel), 'utf8');
    const raw = src.split('\n');
    const lines = stripProse(src).split('\n');
    lines.forEach((line, i) => {
      if (!COURSE_SETTING_FILTER.test(line)) return;
      if (OR_ARM.test(line)) return;                     // serves the entitlement
      if (entitlementMarkedNear(lines, i)) return;       // declared narrow, on purpose
      if (entitlementMarkedOnFunction(lines, i)) return; // …or the whole builder is
      found.push(`${rel}:${i + 1}  ${raw[i].trim()}`);
    });
  }
  return found;
}

test('every course-settings filter either carries the OR-arm or says why not', () => {
  assert.deepEqual(entitlementViolations(), [],
    'a filter on c.status / c.certificate_enabled can revoke a badge somebody already '
    + "earned. Add `OR ec.badge_earned_at IS NOT NULL` if it serves a technician's own "
    + 'entitlement, or an `// entitlement-guard: <why>` comment if it legitimately '
    + 'governs only who earns one NEXT (a catalogue, the award itself, or job gating).');
});

test('the guard FIRES on the exact query that shipped the bug', () => {
  const regressed = [
    'async function coursesForTech(efrId) {',
    '  const [courses] = await pool.query(`SELECT ec.course_id AS id',
    '       FROM easyfixer_courses ec',
    '       JOIN courses c ON c.id = ec.course_id',
    '      WHERE ec.easyfixer_id = ?',
    '        AND c.status = 1`, [efrId]);',
    '}',
  ].join('\n');
  const v = entitlementViolations({ 'services/lms.service.js': regressed });
  assert.equal(v.length, 1, 'the bare status filter must be caught');
  assert.match(v[0], /lms\.service\.js:6/);
});

test('the OR-arm and a marker each satisfy the guard, and prose does not', () => {
  const withArm = '      WHERE ec.easyfixer_id = ?\n'
    + '        AND (c.status = 1 OR ec.badge_earned_at IS NOT NULL)';
  assert.deepEqual(entitlementViolations({ 'services/lms.service.js': withArm }), []);

  const withMarker = '  // entitlement-guard: the CRM catalogue, not a technician entitlement\n'
    + "  if (!includeInactive) where.push('c.status = 1');";
  assert.deepEqual(entitlementViolations({ 'services/lms.service.js': withMarker }), []);

  const prose = '  /* c.status = 1 matters here, and certificate_enabled too. */\n'
    + "  where.push('c.status = 1');";
  assert.equal(entitlementViolations({ 'services/lms.service.js': prose }).length, 1,
    'prose about the rule must not satisfy the rule');
});

test('a function-level marker covers a filter inside a SQL template literal', () => {
  const fnMarked = [
    '/*',
    ' * entitlement-guard: job gating — retiring a course must stop it gating work.',
    ' */',
    'async function mandatoryVideoIdsSql() {',
    '  return `SELECT lc.ref_id FROM lms_content lc',
    '    JOIN courses c ON c.id = lc.course_id',
    '   WHERE c.status = 1`;',
    '}',
  ].join('\n');
  assert.deepEqual(entitlementViolations({ 'services/lms.service.js': fnMarked }), []);

  // Same function, marker removed — the guard must fire again.
  const unmarked = fnMarked.split('\n').filter((l) => !/entitlement-guard/.test(l)).join('\n');
  assert.equal(entitlementViolations({ 'services/lms.service.js': unmarked }).length, 1);
});

test('a marker cannot drift across a statement onto unrelated code', () => {
  const drifted = [
    '  // entitlement-guard: this justifies the line right below it',
    "  where.push('lc.status = 1');",
    '',
    "  where.push('c.status = 1');",
  ].join('\n');
  assert.equal(entitlementViolations({ 'services/lms.service.js': drifted }).length, 1,
    'a statement between the marker and the filter must end the walk');
});

test('a PROJECTION is not a filter — it can revoke nothing', () => {
  const projection = '    `SELECT c.id, c.name, c.status, c.certificate_enabled\n'
    + '       FROM courses c`';
  assert.deepEqual(entitlementViolations({ 'services/lms.service.js': projection }), []);
});
