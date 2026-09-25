/*
 * technicianSharesForJobs — the query budget, and the three answers it gives.
 *
 * WHY THIS EXISTS AT ALL. V3 plan 2.1/2.8 put the technician's own cut on the
 * mobile job LIST and the OFFERED list — the two reads every technician's app
 * issues on every foreground and every pull-to-refresh. CRM, the technician app
 * and the client dashboard are one backend against one MySQL, so a per-row query
 * added here does not slow the app down, it slows all three down, and it would
 * do it gradually as the fleet grows rather than failing on the day it shipped.
 *
 * So the property under test is not "the number is right" — computeCompletion-
 * Amounts is already pinned by job-completion-ledger.test.js. It is:
 *
 *     THE NUMBER OF QUERIES DOES NOT DEPEND ON THE NUMBER OF JOBS.
 *
 * That is the regression an innocent-looking refactor makes: someone adds a
 * convenience `technicianShareForJob(id)` and maps it over the page, every test
 * still passes, every number is still correct, and the list goes from 3 queries
 * to 3 + 2N. Counting is the only thing that can see it.
 *
 * Runner: `node --test tests/technician-share-query-budget.test.js`
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { makeFakePool } = require('./helpers/fake-pool');

// Job 101 completed and has a ledger row; 102 and 103 have not. 104 has neither
// a priced line nor a material row — it is the "no answer" case.
const POSTED = new Map([[101, 1234.5]]);

function routes() {
  return [
    // loadLedgerConfig's two reads.
    [/FROM\s+tbl_tax_rate/i, [{ rate: 18 }]],
    [/tbl_easyfixer_rating_parameters_weightage/i, [{ param_weightage: 0 }]],
    // The posted lookup.
    [/FROM\s+tbl_job_transaction/i, (_sql, params) => {
      const ids = (params && params[0]) || [];
      return ids.filter((id) => POSTED.has(Number(id)))
        .map((id) => ({ job_id: Number(id), efr_charge: POSTED.get(Number(id)) }));
    }],
    // estimateTechnicianShares' service lines. 102 and 103 are priced; 104 is not.
    [/FROM\s+tbl_job_services/i, (_sql, params) => {
      const ids = ((params && params[0]) || []).map(Number);
      return ids.filter((id) => id === 102 || id === 103).map((id) => ({
        job_id: id,
        total_charge: 1000,
        quantity: 1,
        client_fixed: 0, client_variable: 0,
        easyfix_direct_fixed: 0, easyfix_direct_variable: 0,
        overhead_fixed: 0, overhead_variable: 0,
      }));
    }],
    // …and its material rows. None, in every case here.
    [/FROM\s+job_material/i, []],
  ];
}

let ledger;
beforeEach(() => {
  // A fresh module per test so the config cache starts cold and the counts below
  // are the COLD budget — the worst case, not the one a warm process flatters.
  delete require.cache[require.resolve('../services/job-ledger.service')];
  ledger = require('../services/job-ledger.service');
});

test('the query count is the same for 1 job and for 200', async () => {
  const one = makeFakePool(routes());
  await ledger.technicianSharesForJobs(one.pool, [102]);
  const forOne = one.calls.length;

  // Same module instance, so the config cache is now WARM for both — this
  // measures the per-page cost, which is what a list actually pays.
  const many = makeFakePool(routes());
  const ids = Array.from({ length: 200 }, (_, i) => 1000 + i);
  await ledger.technicianSharesForJobs(many.pool, ids);

  assert.equal(
    many.calls.length, forOne - 2,
    `200 jobs must cost the same as 1 (minus the 2 config reads the first call paid).\n`
    + `      1 job: ${forOne} queries · 200 jobs: ${many.calls.length}.\n`
    + `      A count that GREW with the list is an N+1 — technicianSharesForJobs takes a\n`
    + `      LIST precisely so there is no single-job variant to map over.`,
  );

  // Positive control: the fake really was asked something, and really was handed
  // all 200 ids in ONE statement. Without this, a function that issued no
  // queries at all would satisfy the assertion above.
  assert.ok(many.calls.length >= 2, 'the fake pool saw no queries — the routes or the seam are wrong');
  const posted = many.calls.find((c) => /tbl_job_transaction/i.test(c.sql));
  assert.ok(posted, 'no tbl_job_transaction lookup was issued');
  assert.equal(posted.params[0].length, 200, 'all 200 ids must go in ONE IN (?) list');
});

test('a posted ledger row wins over the estimate, and says so', async () => {
  const fake = makeFakePool(routes());
  const shares = await ledger.technicianSharesForJobs(fake.pool, [101, 102]);

  assert.deepEqual(shares.get(101), { amount: 1234.5, posted: true },
    'a completed job answers with what it actually paid, not a recomputation — '
    + 'the rate card may have moved since, and the technician\'s wallet did not');
  assert.equal(shares.get(102).posted, false, 'an unposted job is explicitly an ESTIMATE');
  assert.ok(shares.get(102).amount > 0, 'and it still carries a figure');

  // 101 is posted, so it must NOT also be priced through the rate card.
  const lines = fake.calls.find((c) => /FROM\s+tbl_job_services/i.test(c.sql));
  assert.ok(lines, 'the unposted job must still be estimated');
  assert.deepEqual(lines.params[0].map(Number), [102],
    'only the UNPOSTED ids may reach the estimate query');
});

test('a job with no priced line is ABSENT from the map, never zero', async () => {
  const fake = makeFakePool(routes());
  const shares = await ledger.technicianSharesForJobs(fake.pool, [104]);

  assert.equal(shares.has(104), false,
    'a job nobody can price has an earning nobody can state. "Rs 0" is a claim, and '
    + 'the app renders absence as absence — see decorateTechnicianShare.');
});

test('the config reads are cached, so a second page pays nothing for them', async () => {
  const first = makeFakePool(routes());
  await ledger.technicianSharesForJobs(first.pool, [102]);
  assert.ok(
    first.calls.some((c) => /FROM\s+tbl_tax_rate/i.test(c.sql)),
    'the COLD read must actually hit tbl_tax_rate — if it never did, the assertion '
    + 'below would pass for the wrong reason',
  );

  const second = makeFakePool(routes());
  await ledger.technicianSharesForJobs(second.pool, [102]);
  assert.equal(
    second.calls.filter((c) => /FROM\s+tbl_tax_rate|rating_parameters_weightage/i.test(c.sql)).length, 0,
    'the tax rate and minimum fee change perhaps twice a year; re-reading them on '
    + 'every list refresh, for every technician, is load this backend shares with '
    + 'the CRM and the client dashboard',
  );

  // And the flush really flushes — otherwise ops could never roll a rate change
  // out inside the hour and would have nothing to reach for.
  ledger.flushLedgerConfig();
  const third = makeFakePool(routes());
  await ledger.technicianSharesForJobs(third.pool, [102]);
  assert.ok(
    third.calls.some((c) => /FROM\s+tbl_tax_rate/i.test(c.sql)),
    'flushLedgerConfig() must force the next read to hit the DB',
  );
});

test('no ids, no queries', async () => {
  const fake = makeFakePool(routes());
  assert.equal((await ledger.technicianSharesForJobs(fake.pool, [])).size, 0);
  assert.equal(fake.calls.length, 0, 'an empty page must not even load the config');
});
