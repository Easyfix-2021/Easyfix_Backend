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

const S = { host: 'Easyfix-qa-appsrv-2.0', candidates: [], statusLogs: [], checkoutLogs: [] };
const fake = installFakePool([
  [/@@hostname/i, () => [{ host: S.host, db: 'easyfix' }]],
  [/log_for = 'status change'/i, () => S.statusLogs],
  [/log_for = 'checkout'/i, () => S.checkoutLogs],
  [/LEFT JOIN \(SELECT DISTINCT job_id FROM tbl_easyfixer_transaction/i, () => S.candidates],
  [/FROM tbl_job WHERE job_id = \?/i, () => [{ job_id: 9, job_status: 3, fk_easyfixter_id: 7, collected_by: 2, fk_client_id: 5 }]],
  [/COUNT\(\*\) AS n/i, () => [{ n: 0 }]],
  [/FROM tbl_tax_rate/i, () => [{ rate: 0 }]],
  [/FROM tbl_job_services js/i, () => [{ job_service_id: 1, service_id: 900, total_charge: 400, quantity: 1, client_service_id: 900,
    client_fixed: 0, client_variable: 0, easyfix_direct_fixed: 200, easyfix_direct_variable: 10, overhead_fixed: 10, overhead_variable: 20 }]],
  [/ORDER BY transaction_id DESC LIMIT 1/i, () => [{ balance: 450 }]],
  [/ORDER BY trans_id DESC LIMIT 1/i, () => [{ balance: 900 }]],
  [/ORDER BY client_trans_id DESC LIMIT 1/i, () => [{ balance: 10 }]],
  [/@@SESSION\.innodb_lock_wait_timeout/i, () => [{ wait: 50 }]],
  [/GET_LOCK/i, () => [{ got: 1 }]],
  [/SELECT 1 FROM tbl_job_transaction/i, () => []],
  [/SELECT 1 FROM tbl_easyfixer_transaction WHERE job_id/i, () => []],
]);
const script = require('../scripts/backfill-completion-ledger');

after(() => fake.restore());
beforeEach(() => { fake.reset(); S.host = 'Easyfix-qa-appsrv-2.0'; S.candidates = []; S.statusLogs = []; S.checkoutLogs = []; });

const CANDIDATE = { job_id: 9, job_status: 3, fk_easyfixter_id: 7, collected_by: 2, fk_client_id: 5,
  checkout_date_time: '2026-05-01 10:00:00', cancel_date_time: null };

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

test('it refuses exactly what the live path refuses: a completion out of CANCELLED, and one no log explains', async () => {
  const pool = require('../db').pool;
  S.candidates = [CANDIDATE];
  S.statusLogs = [{ job_id: 9, from_cancelled: 1 }];
  let p = await script.plan(pool, S.candidates);
  assert.equal(p.jobs[0].postable, false);
  assert.match(p.jobs[0].reason, /out of CANCELLED/, 'posting it would contradict the live path, which refuses 6 → 3');

  // Cancelled once, and no status-change log to show how it completed: reported, not posted.
  fake.reset(); S.statusLogs = [];
  p = await script.plan(pool, [{ ...CANDIDATE, cancel_date_time: '2026-04-30 09:00:00' }]);
  assert.equal(p.jobs[0].postable, false);
  assert.match(p.jobs[0].reason, /review by hand/);

  // Control: the same job with a clean log IS postable, so the two tests above
  // are the exclusions doing the work and not a broken plan().
  fake.reset(); S.statusLogs = [{ job_id: 9, from_cancelled: 0 }];
  p = await script.plan(pool, S.candidates);
  assert.equal(p.jobs[0].postable, true, p.jobs[0].reason || '');
  assert.ok(p.jobs[0].efrDelta > 0, 'collected_by 2 credits the technician');
});

test('a backfilled row names the CRM user who completed the job, where a log says so', async () => {
  const pool = require('../db').pool;
  S.candidates = [CANDIDATE];
  S.statusLogs = [{ job_id: 9, from_cancelled: 0 }];
  S.checkoutLogs = [{ job_id: 9, changed_by: 12 }];
  const p = await script.plan(pool, S.candidates);
  assert.equal(p.jobs[0].completedBy, 12);

  fake.reset(); S.checkoutLogs = [{ job_id: 9, changed_by: 0 }];   // 0 = not a CRM user (tbl_job_logs' own sentinel)
  const q = await script.plan(pool, S.candidates);
  assert.equal(q.jobs[0].completedBy, null, 'the ledger created_by has a tbl_user FK: 0 would violate it');
});

test('apply(): posts through the live wrapper, dates the job row at the CHECKOUT time, and names the completing user', async () => {
  const pool = require('../db').pool;
  const job = { ...CANDIDATE, postable: true, completedBy: 12 };
  const tally = await script.apply(pool, [job]);
  assert.deepEqual(tally, { posted: 1, skipped: 0, failed: 0 });

  // Through the LIVE wrapper, not its own transaction: bounded lock waits, one
  // retry, the named lock released after the commit, the connection destroyed
  // if it cannot be. The bounded wait is the wrapper's fingerprint.
  assert.ok(fake.calls.some((c) => /SET SESSION innodb_lock_wait_timeout/i.test(c.sql) && c.params[0] === 5),
    'the backfill must post through inLedgerTransaction');

  const jt = fake.calls.find((c) => /INSERT INTO tbl_job_transaction/i.test(c.sql));
  assert.ok(jt, 'the job transaction row must be written');
  assert.equal(jt.params[6], CANDIDATE.checkout_date_time,
    'insert_date is the CHECKOUT time, so backfilled earnings land in the month the work was done');
  assert.equal(jt.params[7], 12, 'updated_by: the CRM user who completed it');

  const efr = fake.calls.find((c) => /INSERT INTO tbl_easyfixer_transaction/i.test(c.sql));
  assert.equal(efr.params[7], 12, 'created_by: the same user, as legacy writes');
  assert.ok(efr.params[4] instanceof Date, 'but the LEDGER rows are dated now, so their balance chains stay in order');
  assert.equal(efr.params[6], 450 + efr.params[5], 'the balance continues this technician\'s chain');
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
