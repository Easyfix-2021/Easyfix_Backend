const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scanFile, aliasMap, NOT_AN_ALIAS } = require('../scripts/verify-phantom-columns');

/*
 * The phantom-column verifier's own tests.
 *
 * A checker's two failure modes are asymmetric and both expensive. A false
 * POSITIVE gets it added to an allowlist and it quietly stops guarding. A false
 * NEGATIVE reports zero and everyone believes the SQL is clean.
 *
 * The false negative already happened here, on the first attempt: the alias
 * detector had no WHERE in its exclusion list, so `FROM tbl_easyfixer WHERE …`
 * read "WHERE" as an alias, concluded the query was alias-scoped, and SKIPPED
 * it — coming back clean on the exact bug it was written to find. That case is
 * the first test below and it is the reason this file exists.
 */

const cols = new Map([
  ['tbl_easyfixer', new Set(['efr_id', 'user_id', 'efr_status', 'efr_no', 'is_technician_verified'])],
  ['tbl_user', new Set(['user_id', 'city', 'user_name', 'pin_code'])],
  ['tbl_job', new Set(['job_id', 'job_status'])],
]);
const refs = (src) => scanFile('x.js', src, cols).map((f) => f.ref);

test('THE FALSE NEGATIVE: a bare list on an unaliased table is still checked', () => {
  /*
   * `FROM tbl_easyfixer WHERE` — the word after the table is a KEYWORD, not an
   * alias. Read as an alias, this whole query gets skipped and the verifier is
   * decorative. This is the real Supply Gap query, shortened.
   */
  const src = 'const q = `SELECT user_id, city, user_name FROM tbl_easyfixer WHERE user_id = ?`;';
  assert.deepEqual(refs(src).sort(),
    ['tbl_easyfixer.city', 'tbl_easyfixer.user_name'],
    'city and user_name live on tbl_user — naming them here is the bug');
});

test('every keyword that can follow a table is excluded', () => {
  for (const kw of ['where', 'group', 'order', 'limit', 'join', 'left', 'on', 'union', 'having']) {
    assert.ok(NOT_AN_ALIAS.has(kw), `"${kw}" can follow a table name and is not an alias`);
    assert.equal(aliasMap(`FROM tbl_job ${kw.toUpperCase()} x`).size, 0,
      `"${kw}" must not be captured as an alias`);
  }
});

test('a real alias IS captured', () => {
  assert.equal(aliasMap('FROM tbl_job j LEFT JOIN tbl_user u ON u.user_id = j.job_id').get('j'), 'tbl_job');
  assert.equal(aliasMap('FROM tbl_job AS j').get('j'), 'tbl_job');
});

test('alias.column is resolved PER QUERY, never per file', () => {
  /*
   * Two queries in one file, the same alias meaning different tables. A
   * file-wide map invents findings — the first run of this auditor reported 17
   * phantom columns that way, and every one was an artifact.
   */
  const src = 'const a = `SELECT E.efr_id FROM tbl_easyfixer E`;\n'
            + 'const b = `SELECT E.city FROM tbl_user E`;';
  assert.deepEqual(refs(src), [], 'both are valid in their own query');
});

test('a genuine alias.column phantom is caught', () => {
  const src = 'const q = `SELECT e.city FROM tbl_easyfixer e`;';
  assert.deepEqual(refs(src), ['e.city'], 'tbl_easyfixer has no city column');
});

test('derived-table projections are not base columns', () => {
  const src = 'const q = `SELECT t.latest FROM (SELECT MAX(job_id) AS latest FROM tbl_job) t`;';
  assert.deepEqual(refs(src), [], 't is a subquery — its columns are projections');
});

test('a multi-table query is left to the alias pass', () => {
  const src = 'const q = `SELECT city FROM tbl_easyfixer JOIN tbl_user ON 1=1`;';
  assert.deepEqual(refs(src), [], 'a bare column cannot be attributed across two tables');
});

test('SELECT * and function calls are skipped rather than guessed at', () => {
  assert.deepEqual(refs('const q = `SELECT * FROM tbl_easyfixer WHERE 1`;'), []);
  assert.deepEqual(refs('const q = `SELECT COUNT(city) FROM tbl_easyfixer WHERE 1`;'), []);
});

test('a guarded ${...} expression is NOT a phantom', () => {
  /*
   * The drift-tolerant pattern this codebase uses for optional columns. Reading
   * it as literal SQL flags a working guard, and a checker that flags working
   * code gets allowlisted into uselessness.
   */
  const src = "const q = `SELECT ${has ? 'e.city_name' : 'c.city_name'} FROM tbl_easyfixer e`;";
  assert.deepEqual(refs(src), []);
});

test('blanking interpolations does NOT hide a real phantom beside one', () => {
  // The guarded expression is skipped; the literal phantom next to it is not.
  const src = "const q = `SELECT ${has ? 'e.a' : 'c.a'}, e.city FROM tbl_easyfixer e`;";
  assert.deepEqual(refs(src), ['e.city']);
});

test('an alias in a COMMENT does not count', () => {
  const src = '/* SELECT e.city FROM tbl_easyfixer e */\nconst q = `SELECT e.efr_id FROM tbl_easyfixer e`;';
  assert.deepEqual(refs(src), [], 'comments are stripped before scanning');
});
