/*
 * scripts/backfill-completion-ledger.js — the one-off that posts the ledger for
 * jobs this backend completed without one (2026-09-11). Pinned: the scope is
 * the critic's (3/5, since go-live, no job row AND no technician ledger row),
 * a dry run writes NOTHING, and --apply refuses unless the operator names the
 * database it is connected to. The posting itself is the live function,
 * covered in tests/job-completion-ledger.test.js.
 *
 * Runner: `node --test` (see npm test).
 */
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const S = { host: 'Easyfix-qa-appsrv-2.0', candidates: [] };
const fake = installFakePool([
  [/@@hostname/i, () => [{ host: S.host, db: 'easyfix' }]],
  [/LEFT JOIN \(SELECT DISTINCT job_id FROM tbl_easyfixer_transaction/i, () => S.candidates],
  [/FROM tbl_job WHERE job_id = \?/i, () => [{ job_id: 9, job_status: 3, fk_easyfixter_id: 7, collected_by: 2, fk_client_id: 5 }]],
  [/COUNT\(\*\) AS n/i, () => [{ n: 0 }]],
  [/FROM tbl_tax_rate/i, () => [{ rate: 0 }]],
  [/FROM tbl_job_services js/i, () => [{ job_service_id: 1, service_id: 900, total_charge: 400, quantity: 1, client_service_id: 900,
    client_fixed: 0, client_variable: 0, easyfix_direct_fixed: 200, easyfix_direct_variable: 10, overhead_fixed: 10, overhead_variable: 20 }]],
  [/ORDER BY transaction_id DESC LIMIT 1/i, () => [{ balance: 450 }]],
]);
const script = require('../scripts/backfill-completion-ledger');

after(() => fake.restore());
beforeEach(() => { fake.reset(); S.host = 'Easyfix-qa-appsrv-2.0'; S.candidates = []; });

const writes = () => fake.calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(c.sql) || /GET_LOCK|CALL\s/i.test(c.sql));

test('arguments: dry run by default, and --apply is refused without --confirm-db', () => {
  assert.deepEqual(script.parseArgs([]), { since: script.GO_LIVE, jobId: null, csv: null, apply: false, confirmDb: null });
  assert.throws(() => script.parseArgs(['--apply']), /--confirm-db/);
  assert.throws(() => script.parseArgs(['--since', '17-04-2026']), /YYYY-MM-DD/);
  assert.throws(() => script.parseArgs(['--jobs', '1']), /unknown argument/);
  assert.equal(script.parseArgs(['--apply', '--confirm-db', 'x']).apply, true);
});

test('the candidate scope: completed, since go-live, no job row and no technician ledger row', async () => {
  await script.findCandidates(require('../db').pool, { since: '2026-04-17', jobId: null });
  const [q] = fake.calls.filter((c) => /FROM tbl_job j/i.test(c.sql));
  for (const must of [/j\.job_status IN \(3, 5\)/, /j\.checkout_date_time >= \?/, /jt\.fk_job_id IS NULL/, /e\.job_id IS NULL/]) {
    assert.match(q.sql, must);
  }
  assert.deepEqual(q.params, ['2026-04-17']);
});

test('a dry run plans every candidate and writes nothing', async () => {
  S.candidates = [{ job_id: 9, job_status: 3, fk_easyfixter_id: 7, collected_by: 2, checkout_date_time: '2026-05-01 10:00:00' }];
  const lines = []; const log = console.log; console.log = (m) => lines.push(String(m));
  try { await script.main([]); } finally { console.log = log; }
  assert.ok(lines.some((l) => /candidates: 1 · postable: 1/.test(l)), `the plan must have run: ${lines.join(' | ')}`);
  assert.deepEqual(writes().map((c) => c.sql.slice(0, 60)), [], 'a dry run must not write, lock or call anything');
});

test('--apply against a server other than the one named writes nothing', async () => {
  S.candidates = [{ job_id: 9, job_status: 3, fk_easyfixter_id: 7, collected_by: 2, checkout_date_time: '2026-05-01 10:00:00' }];
  const log = console.log; console.log = () => {};
  try {
    await assert.rejects(script.main(['--apply', '--confirm-db', 'some-other-host']), /does not match this server/);
  } finally { console.log = log; }
  assert.equal(fake.calls.filter((c) => /FROM tbl_job j/i.test(c.sql)).length, 0, 'refused before it even looked for candidates');
  assert.deepEqual(writes(), []);
});
