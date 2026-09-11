'use strict';
/*
 * Manage Jobs' "Job Id" box matches a job id OR a job booking reference.
 *
 * ─── WHAT CHANGED (2026-09-11, per ops) ────────────────────────────────────
 *
 * The box sent `jobIds`, a numeric-only CSV. Typing the reference the grid
 * shows under every id (REF-482505) was a Joi 400, and because the grid keeps
 * its previous rows on error the operator saw nothing happen. It now sends
 * `jobIdOrRef`, and list() matches each token exactly:
 *
 *   digits      → j.job_id IN (…)            the PRIMARY KEY, as before
 *   anything    → j.job_reference_id IN (…)  exact, never a %wildcard%
 *
 * Digits deliberately do NOT also probe job_reference_id: that column has no
 * index, so naming it in an OR turns a 39 ms primary-key lookup into a 635 ms
 * scan of 433k rows (QA, 2026-09-11), to look for a digits-only reference that
 * does not exist on either database. See the block above the clause in
 * services/job.service.js.
 *
 * This file RUNS list() against a fake pool and reads the SQL it emits — the
 * data query AND the COUNT — because the two share one WHERE and a filter that
 * reaches only one of them is a total that disagrees with its rows.
 *
 * Non-destructive: fake pool, no real DB, zero writes. Runner: `node --test`.
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/SELECT COUNT\(\*\) AS total/i, () => [{ total: 1 }]],
]);

const jobSvc = require('../services/job.service');
const { listQuery } = require('../validators/job.validator');

beforeEach(() => fake.reset());

const dataCall = () => fake.calls.find((c) => /FROM tbl_job j/i.test(c.sql) && /LIMIT \? OFFSET \?/.test(c.sql));
const countCall = () => fake.calls.find((c) => /^SELECT COUNT\(\*\) AS total/i.test(c.sql));
// The COUNT query carries no projection subqueries, so its first WHERE is the
// top-level one — the whole filter, and nothing else.
const countWhere = () => { const s = countCall().sql; return s.slice(s.indexOf('WHERE')).trim(); };

async function run(args) {
  fake.reset();
  await jobSvc.list({ limit: 50, offset: 0, ...args });
  const data = dataCall();
  const count = countCall();
  // Both queries must have RUN — otherwise every doesNotMatch below is vacuous.
  assert.ok(data, 'the data query must have run');
  assert.ok(count, 'and so must the COUNT');
  // One WHERE, one param list: the data query binds the COUNT's params plus
  // LIMIT and OFFSET, in that order, and contains the COUNT's WHERE verbatim.
  assert.deepEqual(data.params, [...count.params, 50, 0], 'COUNT and data must bind the same filter params');
  if (count.sql.includes('WHERE')) assert.ok(data.sql.includes(countWhere()), 'and carry the same WHERE');
  return { data, count };
}

test('a job id hits the PRIMARY KEY — in the data query AND the COUNT', async () => {
  const { data, count } = await run({ jobIdOrRef: '482505' });
  for (const [name, call] of [['data', data], ['COUNT', count]]) {
    assert.ok(call.sql.includes('(j.job_id IN (?))'), `${name}: the id must reach j.job_id`);
    assert.doesNotMatch(call.sql, /job_reference_id IN/,
      `${name}: digits must not pay for an unindexed reference scan`);
  }
  assert.deepEqual(count.params, [482505], 'bound as a NUMBER — a string would compare the PK as text');
});

test('a REF-… token is accepted and matches job_reference_id exactly', async () => {
  // The reported failure first: the validator used to 400 this.
  const { error, value } = listQuery.validate({ jobIdOrRef: 'REF-538916' });
  assert.equal(error, undefined, 'a booking reference must be a legal search');

  const { data, count } = await run({ jobIdOrRef: value.jobIdOrRef });
  for (const [name, call] of [['data', data], ['COUNT', count]]) {
    assert.ok(call.sql.includes('(j.job_reference_id IN (?))'), `${name}: must match the reference column`);
    assert.doesNotMatch(call.sql, /job_reference_id LIKE/, `${name}: exact, never a wildcard`);
    assert.doesNotMatch(call.sql, /REF-538916/, `${name}: the term is bound, never interpolated`);
  }
  assert.deepEqual(count.params, ['REF-538916']);
});

test('ids and references in one search are OR-ed, ids first, in both queries', async () => {
  // Surrounded by two other filters so a shifted binding cannot hide: every
  // value must land on its own placeholder, in order.
  const { data, count } = await run({ clientId: '12', jobIdOrRef: 'REF-1, 482505 ,,REF-1', categoryId: 4 });
  const clause = '(j.job_id IN (?) OR j.job_reference_id IN (?))';
  assert.ok(count.sql.includes(clause), 'COUNT: one parenthesised OR — an unbracketed OR would escape the AND chain');
  assert.ok(data.sql.includes(clause), 'data: the same clause');
  assert.deepEqual(count.params, [12, 482505, 'REF-1', 4],
    'trimmed, empties dropped, duplicates collapsed, bound in placeholder order');
});

test('an empty search adds no clause at all', async () => {
  const { count: baseline } = await run({});
  for (const jobIdOrRef of [undefined, '', ',', ' , ']) {
    const { count } = await run({ jobIdOrRef });
    assert.equal(count.sql, baseline.sql, `jobIdOrRef=${JSON.stringify(jobIdOrRef)} must not filter`);
    assert.deepEqual(count.params, baseline.params);
  }
});

test('the validator: reference charset in, anything else out', () => {
  for (const ok of ['482505', 'REF-538916', 'ref-538916', '482505,REF-1', '482505,', 'WO/2026/01', 'a.b_c']) {
    assert.equal(listQuery.validate({ jobIdOrRef: ok }).error, undefined, `${ok} must be accepted`);
  }
  for (const bad of ['REF 1', "a'b", 'a;b', '%', 'a%b']) {
    assert.ok(listQuery.validate({ jobIdOrRef: bad }).error, `${bad} must be rejected`);
  }
  const many = Array.from({ length: 501 }, (_, i) => String(i + 1)).join(',');
  assert.ok(listQuery.validate({ jobIdOrRef: many }).error, 'the same 500-token ceiling as csvIds');
});

test('the same predicate is exported for the XLSX export, on its `J` alias', () => {
  // The export must mean the same jobs by the same search. It emits through
  // this function rather than a copy of it — a copy is how list() and the
  // export drifted on every other filter (see FILTER_COVERAGE there).
  assert.deepEqual(jobSvc.jobIdOrRefPredicate('482505,REF-1', 'J'),
    { sql: '(J.job_id IN (?) OR J.job_reference_id IN (?))', params: [482505, 'REF-1'] });
  assert.equal(jobSvc.jobIdOrRefPredicate(' , '), null, 'an empty search is no predicate, not an empty OR');
});

test('jobIds is untouched: still numeric-only, still the primary key alone', async () => {
  /*
   * jobIds is also the technician app's "Offered to you" set
   * (listOfferedForTech). Widening IT to references would let a job reach a
   * technician's offer list by sharing a reference string with an offered one.
   * And the export route validates with this same schema: a REF token that
   * jobIds accepted and toIdArray() then dropped would export every row.
   */
  assert.ok(listQuery.validate({ jobIds: 'REF-1' }).error, 'jobIds must keep rejecting references');
  const { count } = await run({ jobIds: [9001, 9002] });
  assert.ok(count.sql.includes('j.job_id IN (?,?)'));
  assert.doesNotMatch(count.sql, /job_reference_id/, 'no reference matching on the id list');
  assert.deepEqual(count.params, [9001, 9002]);
});
