const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * City-scope parity on the two technician-grained LMS reads.
 *
 * Until 2026-08-21 GET /admin/lms/assignments and GET /admin/lms/report
 * returned EVERY city's technicians to any admin-group caller. That was
 * invisible while Admin was the only role that could reach the LMS menu, and
 * became a live leak the moment a geographically scoped role was granted it.
 *
 * WHY THIS TEST EXISTS RATHER THAN A COMMENT
 * Both functions run a page query AND a COUNT query. If a future edit scopes
 * one and not the other, nothing throws — the page shows 12 rows above a
 * total of 4,000, pagination walks off the end, and the leak is in the number
 * rather than the rows. This codebase has already shipped that exact bug
 * shape once (a COUNT missing the main query's join aliases).
 *
 * Note the page query cannot be found by "does not contain COUNT(*)": its
 * videos_total / videos_done subselects are COUNTs. Statements are told apart
 * by their LIMIT instead.
 */

const fake = installFakePool([[/.*/, () => [{ total: 0 }]]]);
const lms = require('../services/lms.service');

after(() => fake.restore());

const SCOPE = { cities: { mode: 'allow', ids: [7, 9] } };
const cityParams = (c) => c.params.filter((p) => p === 7 || p === 9);
const pageQuery = () => fake.calls.find((c) => /LIMIT \? OFFSET \?/i.test(c.sql));
const countQuery = () => fake.calls.find((c) => /^\s*SELECT COUNT\(\*\) AS total/im.test(c.sql));

for (const fn of ['listAssignments', 'trainingReport']) {
  test(`${fn}: the page and the total describe the SAME scoped set`, async () => {
    fake.reset();
    await lms[fn]({ limit: 10, offset: 0, scope: SCOPE });
    const page = pageQuery();
    const count = countQuery();
    assert.ok(page, 'a page query must run');
    assert.ok(count, 'a COUNT query must run');
    assert.match(page.sql, /efr_cityId IN/i, 'the ROWS must be scoped');
    assert.match(count.sql, /efr_cityId IN/i, 'the TOTAL must be scoped too');
    assert.deepEqual(cityParams(page), cityParams(count),
      'identical city ids must be bound to both, in the same order');
  });

  test(`${fn}: an unscoped caller gets no city clause at all`, async () => {
    fake.reset();
    await lms[fn]({ limit: 10, offset: 0 });
    for (const c of fake.calls) {
      assert.doesNotMatch(c.sql, /efr_cityId IN/i,
        'Admin and Finance bypass scope entirely — a clause here would hide their own data from them');
    }
  });

  test(`${fn}: a caller scoped to NOTHING is blocked, not silently widened`, async () => {
    fake.reset();
    await lms[fn]({ limit: 10, offset: 0, scope: { cities: { mode: 'none', ids: [] } } });
    const page = pageQuery();
    const count = countQuery();
    assert.match(page.sql, /1=0/, 'no rows');
    assert.match(count.sql, /1=0/, 'and a total of zero to match');
  });
}
