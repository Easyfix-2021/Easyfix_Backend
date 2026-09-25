/*
 * tests/job-activity-feed.test.js — the READ side of tbl_job_logs (V3 3.1).
 *
 * jobLog.listForJob is what GET /api/admin/jobs/:id/activity returns and what
 * every later V3 item (3.2's ops desk, 3.6's verification queue, 3.7's
 * waiting-for groups) reads. Three properties are worth pinning, because each
 * fails SILENTLY and each produces a screen that looks fine:
 *
 *  1. ACTOR NAMESPACES STAY SPLIT. The write side puts operators in changed_by
 *     and technicians in comments as '(efr:N)' with changed_by = 0 — see
 *     ACTOR_RULE. A reader that joined tbl_user alone renders every technician
 *     action as nobody, and a reader that trusted changed_by would render a
 *     technician as whoever tbl_user row 0 resolves to.
 *  2. THE QUERY BUDGET IS FIXED. Three statements when both kinds of actor
 *     appear, fewer when they do not — never one per row. A per-row lookup is
 *     invisible in a test that only checks output.
 *  3. THE FEED READS OLDEST-FIRST WHILE THE SQL TAKES THE NEWEST. The LIMIT has
 *     to bite at the recent end or a long-running job shows its first day
 *     forever; the OUTPUT has to be ascending or it disagrees with every other
 *     history panel in the CRM. Those two pull in opposite directions, which
 *     is exactly why it is easy to get wrong and easy to not notice.
 *
 * Runner: npx node --test --test-force-exit tests/job-activity-feed.test.js
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const scenario = { logRows: [], users: [], techs: [] };

const fake = installFakePool([
  [/FROM\s+tbl_job_logs/i, () => scenario.logRows],
  [/FROM\s+tbl_user\s+WHERE\s+user_id\s+IN/i, () => scenario.users],
  [/FROM\s+tbl_easyfixer\s+WHERE\s+efr_id\s+IN/i, () => scenario.techs],
  [/INSERT\s+INTO\s+tbl_job_logs/i, () => ({ insertId: 7 })],
]);

const jobLog = require('../services/job-log.service');

after(() => fake.restore());
beforeEach(() => {
  fake.calls.length = 0;
  scenario.logRows = [];
  scenario.users = [];
  scenario.techs = [];
});

const reads = (re) => fake.calls.filter((c) => re.test(c.sql));
const row = (over) => ({
  job_log_id: 1, log_for: 'status change', old_data: 'Status: 1', new_data: 'Status: 2',
  eta_status: null, change_date: '2026-09-23 10:00:00', changed_by: 0,
  comments: 'Changed by New CRM System', ...over,
});

/* ── Positive control ─────────────────────────────────────────────────────── */

test('the feed query actually filters on the job it was asked about', async () => {
  scenario.logRows = [row({})];
  await jobLog.listForJob(4242);
  const q = reads(/FROM\s+tbl_job_logs/i)[0];
  assert.ok(q, 'no tbl_job_logs read was issued at all');
  assert.match(q.sql, /WHERE\s+job_id\s*=\s*\?/i);
  assert.equal(q.params[0], 4242);
  // If this ever stopped binding the id, every other test here would still
  // pass on the fake's canned rows — which is the whole reason it is first.
});

test('an unusable job id reads nothing rather than reading everything', async () => {
  for (const bad of [0, -1, null, undefined, 'abc']) {
    assert.deepEqual(await jobLog.listForJob(bad), []);
  }
  assert.equal(reads(/FROM\s+tbl_job_logs/i).length, 0);
});

/* ── Actor namespaces ─────────────────────────────────────────────────────── */

test('a technician row resolves through comments, never through changed_by', async () => {
  scenario.logRows = [row({ changed_by: 0, comments: 'Changed by New CRM App (efr:314)' })];
  scenario.techs = [{ efr_id: 314, efr_name: 'Ravi Kumar' }];
  const [e] = await jobLog.listForJob(42);
  assert.equal(e.source, 'app');
  assert.equal(e.actor.kind, 'technician');
  assert.equal(e.actor.efrId, 314);
  assert.equal(e.actor.name, 'Ravi Kumar');
  // The one that matters: 0 is NOT handed back as a joinable user id.
  assert.equal(e.actor.userId, null);
});

test('a row carrying BOTH namespaces still resolves as the technician only', async () => {
  /*
   * Our own writer can never produce this row — resolveActor() sets changed_by
   * to 0 the moment it sees an efr id. A decade-old archive and a hand-run
   * UPDATE can, and the previous test cannot tell the guard from the data:
   * there changed_by is 0, so `userId` comes out null whether the code checks
   * the source or not. This is the case where those two differ, which makes it
   * the one that actually pins the rule.
   */
  scenario.logRows = [row({ changed_by: 88, comments: 'Changed by New CRM App (efr:314)' })];
  scenario.users = [{ user_id: 88, user_name: 'Asha' }];
  scenario.techs = [{ efr_id: 314, efr_name: 'Ravi Kumar' }];
  const [e] = await jobLog.listForJob(42);
  assert.equal(e.source, 'app');
  assert.equal(e.actor.efrId, 314);
  assert.equal(e.actor.name, 'Ravi Kumar');
  assert.equal(e.actor.userId, null, 'an operator id leaked out of a technician row');
});

test('an operator row resolves through changed_by and carries no efr id', async () => {
  scenario.logRows = [row({ changed_by: 88, comments: 'Changed by New CRM' })];
  scenario.users = [{ user_id: 88, user_name: 'Asha' }];
  const [e] = await jobLog.listForJob(42);
  assert.equal(e.source, 'crm');
  assert.equal(e.actor.userId, 88);
  assert.equal(e.actor.name, 'Asha');
  assert.equal(e.actor.efrId, null);
});

test("legacy rows are 'legacy', not 'crm' — one word of difference in comments", () => {
  // 'Changed by CRM' is the OLD CRM (1,015,510 rows); 'Changed by New CRM' is
  // this backend. Treating the first as ours would attribute a decade of
  // legacy rows to the new stack.
  assert.equal(jobLog.sourceOf('Changed by CRM'), 'legacy');
  assert.equal(jobLog.sourceOf('Changed by Api'), 'legacy');
  assert.equal(jobLog.sourceOf('Changed by New CRM'), 'crm');
  assert.equal(jobLog.sourceOf('Changed by New CRM System'), 'system');
  assert.equal(jobLog.sourceOf('Changed by New CRM App (efr:9)'), 'app');
  // Unrecognised is legacy, never system: claiming an unattributable row was
  // written by us is the one answer that is definitely wrong.
  assert.equal(jobLog.sourceOf('something else entirely'), 'legacy');
  assert.equal(jobLog.sourceOf(null), 'legacy');
});

test('an unresolved name stays null rather than becoming a fabricated placeholder', async () => {
  scenario.logRows = [row({ changed_by: 88, comments: 'Changed by New CRM' })];
  scenario.users = [];                                  // the user row is gone
  const [e] = await jobLog.listForJob(42);
  assert.equal(e.actor.userId, 88);
  assert.equal(e.actor.name, null);
});

/* ── Query budget ─────────────────────────────────────────────────────────── */

test('three queries with both actor kinds, for two rows or two hundred', async () => {
  const many = [];
  for (let i = 1; i <= 200; i++) {
    many.push(row({
      job_log_id: i,
      changed_by: i % 2 ? 0 : 88,
      comments: i % 2 ? `Changed by New CRM App (efr:${300 + (i % 5)})` : 'Changed by New CRM',
    }));
  }
  scenario.logRows = many;
  scenario.users = [{ user_id: 88, user_name: 'Asha' }];
  scenario.techs = [{ efr_id: 300, efr_name: 'A' }];
  const out = await jobLog.listForJob(42);
  assert.equal(out.length, 200);
  assert.equal(fake.calls.length, 3, 'expected exactly 3 statements, got ' + fake.calls.length);
  // And the lookups are batched by DISTINCT id, not by row.
  assert.equal(reads(/FROM\s+tbl_easyfixer/i)[0].params[0].length, 5);
});

test('no actor lookup is issued when no actor of that kind appears', async () => {
  scenario.logRows = [row({ changed_by: 0, comments: 'Changed by New CRM System' })];
  await jobLog.listForJob(42);
  assert.equal(fake.calls.length, 1);
  assert.equal(reads(/FROM\s+tbl_user/i).length, 0);
  assert.equal(reads(/FROM\s+tbl_easyfixer/i).length, 0);
});

/* ── Ordering and the cap ─────────────────────────────────────────────────── */

test('the SQL takes the newest rows but the feed hands them back oldest-first', async () => {
  // The fake returns whatever it is given; the SQL's own DESC is asserted
  // separately, because with a fake the two halves cannot prove each other.
  scenario.logRows = [
    row({ job_log_id: 3, change_date: '2026-09-23 12:00:00' }),
    row({ job_log_id: 2, change_date: '2026-09-23 11:00:00' }),
    row({ job_log_id: 1, change_date: '2026-09-23 10:00:00' }),
  ];
  const out = await jobLog.listForJob(42);
  assert.deepEqual(out.map((e) => e.id), [1, 2, 3], 'feed must read oldest-first');
  const sql = reads(/FROM\s+tbl_job_logs/i)[0].sql;
  assert.match(sql, /ORDER BY\s+change_date DESC,\s*job_log_id DESC/i);
  assert.match(sql, /LIMIT\s+\?/i);
});

test('the limit is clamped at both ends and defaults without being asked', async () => {
  scenario.logRows = [row({})];
  const limitOf = () => reads(/FROM\s+tbl_job_logs/i).pop().params[1];

  await jobLog.listForJob(42);
  assert.equal(limitOf(), 200);
  await jobLog.listForJob(42, { limit: 5 });
  assert.equal(limitOf(), 5);
  await jobLog.listForJob(42, { limit: 99999 });
  assert.equal(limitOf(), jobLog.ACTIVITY_LIMIT_MAX);
  await jobLog.listForJob(42, { limit: 0 });
  assert.equal(limitOf(), 200, 'a zero limit must not become LIMIT 0');
  await jobLog.listForJob(42, { limit: -3 });
  assert.equal(limitOf(), 200);
});

/* ── The three new write events ───────────────────────────────────────────── */

const written = () => {
  const c = fake.calls.find((x) => /INSERT\s+INTO\s+tbl_job_logs/i.test(x.sql));
  if (!c) return null;
  const at = Object.fromEntries(jobLog.COLUMNS.map((name, i) => [name, c.params[i]]));
  return at;
};

test('customer pin verified records lateness and never the pin', async () => {
  await jobLog.logCustomerPinVerified(42, { late: true }, { efr_id: 314 });
  const w = written();
  assert.equal(w.log_for, 'customer pin verified');
  assert.equal(w.new_data, 'pinVerified_42');
  assert.equal(w.old_data, 'Late: yes');
  assert.equal(w.changed_by, 0);
  assert.equal(w.comments, 'Changed by New CRM App (efr:314)');
  // Nothing in the row may carry a 4-digit code.
  const all = [w.log_for, w.old_data, w.new_data, w.comments].join(' ');
  assert.ok(!/\b\d{4}\b/.test(all.replace('pinVerified_42', '')), 'a pin-shaped value leaked');
});

test('an on-time verification omits the lateness qualifier entirely', async () => {
  await jobLog.logCustomerPinVerified(42, { late: false }, { efr_id: 314 });
  assert.equal(written().old_data, null);
});

test('the two money events are distinguishable and carry their amount', async () => {
  await jobLog.logIncentiveAwarded(42, { amount: 50 }, { efr_id: 314 });
  let w = written();
  assert.equal(w.log_for, 'incentive awarded');
  assert.equal(w.new_data, 'onTime_42');
  assert.equal(w.old_data, 'Amount: 50');

  fake.calls.length = 0;
  await jobLog.logVisitChargeAwarded(42, { amount: 250 }, { efr_id: 314 });
  w = written();
  assert.equal(w.log_for, 'visit charge awarded');
  assert.equal(w.new_data, 'visitCharge_42');
  assert.equal(w.old_data, 'Amount: 250');
});

test('a non-numeric amount writes no row rather than smuggling text into the table', async () => {
  for (const bad of [null, undefined, 'fifty', {}]) {
    fake.calls.length = 0;
    assert.equal(await jobLog.logIncentiveAwarded(42, { amount: bad }, { efr_id: 1 }), null);
    assert.equal(written(), null, 'wrote a row for amount=' + JSON.stringify(bad));
  }
});

test('the new events carry no eta_status — that column reports on the ETA lifecycle', () => {
  for (const k of ['CUSTOMER_PIN_VERIFIED', 'INCENTIVE_AWARDED', 'VISIT_CHARGE_AWARDED']) {
    assert.equal(jobLog.ETA_STATUS[jobLog.LOG_FOR[k]], null, k);
  }
});

test('the five legacy log_for values are still byte-for-byte what production holds', () => {
  // Guards the new additions against a well-meant "tidy-up" pass that
  // normalises the whole map.
  assert.equal(jobLog.LOG_FOR.NEW_JOB, 'new job');
  assert.equal(jobLog.LOG_FOR.SCHEDULE, 'schedule');
  assert.equal(jobLog.LOG_FOR.CHECKOUT, 'checkout');
  assert.equal(jobLog.LOG_FOR.RESCHEDULE, 'Re-Scheduling');
  assert.equal(jobLog.LOG_FOR.REVISIT_REQUIRED, 'Re-visit Required');
});
