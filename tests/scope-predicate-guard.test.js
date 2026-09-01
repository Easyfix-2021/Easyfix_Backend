'use strict';
/*
 * Tests for scripts/verify-scope-predicates.js.
 *
 * A checker is only a checker if it FAILS on the input that motivated it, so
 * most of these feed it the bug rather than the fix. The two that matter most
 * are the hoisted-ids evasion — the reason the scan is default-deny instead of
 * shape-matching — and the line-number regression, because a guard that points
 * at the wrong line sends the next reader to innocent code.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const guard = require('../scripts/verify-scope-predicates');
const { scanFile, helperFindings, markedNear } = guard;
const { cityScopeSql } = require('../lib/scope');

const ROOT = path.join(__dirname, '..');

test('flags a hand-rolled city-scope predicate', () => {
  const src = "where.push(`e.efr_cityId IN (${ci.ids.map(() => '?').join(',')})`);";
  const f = scanFile('services/fake.js', src);
  assert.equal(f.length, 1);
  assert.equal(f[0].line, 1);
});

test('flags the HOISTED-IDS evasion — the reason this is default-deny', () => {
  /*
   * Shape-matching on `ci.ids` next to the column would come back clean here,
   * on a query that hides every city-less technician just as thoroughly.
   */
  const src = [
    'const ids = scope.cities.ids;',
    "where.push(`e.efr_cityId IN (${ids.map(() => '?').join(',')})`);",
  ].join('\n');
  const f = scanFile('services/fake.js', src);
  assert.equal(f.length, 1, 'hoisting the ids must not evade the scan');
  assert.equal(f[0].line, 2);
});

test('accepts the predicate when it comes from the helper', () => {
  const src = "where.push(cityScopeSql('e.efr_cityId', 'e.efr_id', ci.ids));";
  assert.deepEqual(scanFile('services/fake.js', src), []);
});

test('accepts a marked user-filter, however long the justification', () => {
  const src = [
    'if (arr.length) {',
    '  // scope-guard: user-supplied filter, not RBAC — must stay narrow.',
    '  // Four more lines of reasoning, because the exception worth marking',
    '  // is exactly the one that needs explaining, and a fixed lookback of',
    '  // two lines would push the marker out of range and fail it anyway.',
    "  where.push(`e.efr_cityId IN (${arr.map(() => '?').join(',')})`);",
    '}',
  ].join('\n');
  assert.deepEqual(scanFile('routes/client/fake.js', src), []);
});

test('a marker separated by a statement does NOT carry over', () => {
  const src = [
    '// scope-guard: this marks the line below it, nothing further',
    'const somethingElse = 1;',
    "where.push(`e.efr_cityId IN (${ci.ids.map(() => '?').join(',')})`);",
  ].join('\n');
  assert.equal(scanFile('services/fake.js', src).length, 1,
    'an intervening statement must end the marker walk');
});

test('an occurrence inside a block comment is not code', () => {
  const src = [
    '/*',
    " * `e.efr_cityId IN (…)` is never true for NULL — this is prose.",
    ' */',
    'const x = 1;',
  ].join('\n');
  assert.deepEqual(scanFile('services/fake.js', src), []);
});

test('REGRESSION: blank lines before comments must not shift the reported line', () => {
  /*
   * The regex strip this replaced blanked /^\s*\/\/.*$/gm, and \s matches a
   * newline — so a blank line before a comment was swallowed with it. On
   * routes/client/index.js that lost 98 lines and reported the one real finding
   * 88 lines above where it lives.
   */
  const src = [
    'const a = 1;',
    '',
    '// a comment preceded by a blank line',
    '',
    '// and another',
    '',
    "where.push(`e.efr_cityId IN (${ci.ids.map(() => '?').join(',')})`);",
  ].join('\n');
  const f = scanFile('services/fake.js', src);
  assert.equal(f.length, 1);
  assert.equal(f[0].line, 7, 'the finding must be reported at its real line');
  assert.match(f[0].text, /efr_cityId/);
});

test('markedNear reads the comment block, not a fixed window', () => {
  const lines = ['// scope-guard: yes', '// filler', '// filler', '// filler', 'code();'];
  assert.equal(markedNear(lines, 4), true);
});

test('the helper still admits city-less rows, anchors, and keeps its arity', () => {
  const sql = cityScopeSql('e.efr_cityId', 'e.efr_id', [1, 2]);
  assert.match(sql, /e\.efr_cityId IS NULL/);
  assert.match(sql, /e\.efr_id IS NOT NULL/);
  assert.equal((sql.match(/\?/g) || []).length, 2, 'params must be unchanged');
  assert.deepEqual(helperFindings(), []);
});

test('the whole repo is clean right now', () => {
  const { findings } = guard.verifyScopePredicates();
  assert.deepEqual(findings, [], `hand-rolled scope predicates:\n${
    findings.map((f) => `  ${f.file}:${f.line}  ${f.text}`).join('\n')}`);
});

/*
 * Wiring. A previous verifier in this repo had full green tests while its only
 * integration line was deleted — the tests exercised the functions, nothing
 * asserted the script was actually RUN. Pin it.
 */
test('verify:scope-predicates exists and verify:all runs it', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts['verify:scope-predicates'], 'the npm script must exist');
  assert.match(pkg.scripts['verify:scope-predicates'], /verify-scope-predicates\.js/);
  assert.match(pkg.scripts['verify:all'], /verify:scope-predicates/,
    'verify:all must run the guard, or it never runs in CI');
});
