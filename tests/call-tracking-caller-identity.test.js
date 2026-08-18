/*
 * "Called By" and "To Whom" must not be the same person.
 *
 * ─── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 *
 * The Call Tracking drill-down for job 529116 showed seven rows where Called By
 * and To Whom were both "Sanjay Jagtap", with "#352882" printed beside the
 * caller as though it were a CRM user id.
 *
 * The receiver was resolved correctly — PARTY_NAME matches the dialled number
 * against the job's own parties, which is why its role read "Customer". The
 * CALLER was not resolved at all. Every query joined
 * `LEFT JOIN tbl_user u ON u.user_id = jci.caller_id`, which is right for rows
 * this backend writes (routes/admin/calls.js stamps agent.user_id) and wrong for
 * rows the legacy CRM writes, which put an efr_id there.
 *
 * The namespaces do not overlap: tbl_user ids observed in production are two and
 * three digits (2, 102, 148…); efr_ids run to 2,000,313. So the join could never
 * match, the COALESCE fell through to the stamped caller_name, and the raw id was
 * rendered as a user id that does not exist.
 *
 * ─── WHAT THESE TESTS PIN ─────────────────────────────────────────────────
 *
 * Asserted on the generated SQL, because the defect is in the SHAPE of the query
 * and no fixture of rows can show it: a LEFT JOIN that never matches returns the
 * same row count as one that does, which is exactly why this survived.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'quicksight', 'quicksight-call-tracking.service.js'), 'utf8',
);

const constOf = (name) => {
  const m = SRC.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`;'));
  assert.ok(m, `${name} not found — the caller resolver moved`);
  return m[1].replace(/\s+/g, ' ').trim();
};

test('the caller is resolved by ONE shared expression, used at every site', () => {
  // Four consumers: daily-by-user, combined-by-user, job-callers, drill-down.
  const uses = (SRC.match(/\$\{CALLER_NAME\}/g) || []).length;
  assert.equal(uses, 4, `expected all 4 consumers to use CALLER_NAME, found ${uses}`);
  // and none of them still carries the old inline form
  assert.equal(
    /COALESCE\(u\.user_name, jci\.caller_name\)/.test(SRC), false,
    'an inline copy of the old expression is the bug restated — two sites, one rule',
  );
});

test('tbl_user is tried FIRST, so rows this backend wrote are unaffected', () => {
  const e = constOf('CALLER_NAME');
  const user = e.indexOf('u.user_name');
  const efr = e.indexOf('efr_name');
  const stamped = e.indexOf('jci.caller_name');
  assert.ok(user >= 0 && efr >= 0 && stamped >= 0, 'all three sources must be present');
  assert.ok(user < efr, 'tbl_user must be preferred — otherwise existing rows change meaning');
  assert.ok(efr < stamped, 'the stamped audit name stays the last resort');
});

test('the technician lookup is a SUBQUERY, never a join — the aggregates must not inflate', () => {
  /*
   * Two consumers COUNT(*) and COUNT(DISTINCT …) and GROUP BY caller_id. A join
   * that ever matched two rows would silently double an operational metric, and
   * a report that quietly over-counts is worse than one that leaves a name
   * blank. A scalar subquery cannot multiply rows whatever the table's keys are.
   */
  const e = constOf('CALLER_NAME');
  assert.match(e, /\(SELECT ec\.efr_name FROM tbl_easyfixer ec WHERE ec\.efr_id = jci\.caller_id\)/);
  assert.equal(/JOIN tbl_easyfixer ec/.test(SRC), false, 'the caller lookup must not become a join');
});

test('no new JOIN was added to the caller queries at all', () => {
  // tbl_easyfixer is joined exactly once in this file — as the JOB's technician
  // (alias ef), which is a different person from whoever placed the call.
  const joins = (SRC.match(/LEFT JOIN tbl_easyfixer/g) || []).length;
  assert.equal(joins, 1, `expected only the job-technician join, found ${joins}`);
  assert.match(SRC, /LEFT JOIN tbl_easyfixer ef ON ef\.efr_id\s+= j\.fk_easyfixter_id/);
});

test('the drill-down says WHICH namespace answered, so the id stops asserting a user', () => {
  const k = constOf('CALLER_KIND');
  assert.match(k, /WHEN u\.user_id IS NOT NULL THEN 'user'/);
  assert.match(k, /THEN 'technician'/);
  assert.match(k, /ELSE 'unresolved'/);
  assert.match(SRC, /\$\{CALLER_KIND\}\s+AS callerKind/);
  assert.match(SRC, /callerKind: r\.callerKind \|\| 'unresolved'/);
});

test('the SQL stays safe inside its template literals', () => {
  // Both have broken this repo: a backtick terminates the string, and a "--"
  // survives whitespace-collapsing to comment out the rest of a SELECT.
  for (const name of ['CALLER_NAME', 'CALLER_KIND']) {
    const e = constOf(name);
    assert.equal(e.includes('`'), false, `${name} must not contain a backtick`);
    assert.equal(/--/.test(e), false, `${name} must not contain an SQL line comment`);
    const opens = (e.match(/\(/g) || []).length;
    const closes = (e.match(/\)/g) || []).length;
    assert.equal(opens, closes, `${name} has unbalanced parentheses: ${opens} vs ${closes}`);
  }
});
