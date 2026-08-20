/*
 * tests/job-log-service.test.js — pins the tbl_job_logs write contract.
 *
 * tbl_job_logs is a LIVE 1.7-million-row archive the legacy Java stack has
 * written since 2015. The value of the new backend writing it is ENTIRELY in
 * writing it the same way: one wrong byte in a log_for string, one eta_status
 * copied from the wrong event, or one efr id in changed_by, and old and new rows
 * stop being one history. So these tests are quoted from production
 * (INFORMATION_SCHEMA + SELECT DISTINCT, 2026-08-20) rather than from the
 * implementation, and they will fail if someone "tidies up" the odd-looking
 * strings — which is the point, because the odd-looking strings are the ones
 * legacy actually holds.
 *
 * Runner: npx node --test --test-force-exit tests/job-log-service.test.js
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * Scenario knobs, all reset in beforeEach:
 *   insertError        — the fake throws instead of accepting the log insert.
 *   revisitReasonRows  — what the revisit-reason master returns ([] = no row).
 *   revisitReasonError — the reason lookup throws.
 *   droppedTable       — one table INFORMATION_SCHEMA reports as non-existent,
 *   droppedColumn      — one {table, col} INFORMATION_SCHEMA omits,
 *                        both for the schema-verify severity tests at the bottom.
 */
const scenario = {
  insertError: null,
  revisitReasonRows: null,
  revisitReasonError: null,
  droppedTable: null,
  droppedColumn: null,
};

const fake = installFakePool([
  /*
   * The revisit-reason master. Ordered ABOVE the generic routes because the
   * fake takes the FIRST matching route.
   */
  [/FROM\s+revisit_reason_by_app/i, () => {
    if (scenario.revisitReasonError) throw scenario.revisitReasonError;
    return scenario.revisitReasonRows === null
      ? [{ reason: 'Need to buy material' }]
      : scenario.revisitReasonRows;
  }],
  /*
   * INFORMATION_SCHEMA stand-in for scripts/schema-verify. Answers with the
   * verifier's OWN expected column list for every table, so the only mismatch
   * in a run is the one a test deliberately introduces via scenario.droppedTable.
   * Required lazily so this array can be built before the module graph loads.
   * More specific than the generic probe route below, so it must come first.
   */
  [/SELECT\s+COLUMN_NAME\s+FROM\s+INFORMATION_SCHEMA\.COLUMNS/i, (sql, params) => {
    const { EXPECTED } = require('../scripts/schema-verify')._internals;
    const table = params[1];
    if (table === scenario.droppedTable) return [];
    const gone = scenario.droppedColumn && scenario.droppedColumn.table === table
      ? scenario.droppedColumn.col
      : null;
    return (EXPECTED[table] || [])
      .filter((c) => c !== gone)
      .map((COLUMN_NAME) => ({ COLUMN_NAME }));
  }],
  [/INSERT\s+INTO\s+tbl_job_logs/i, () => {
    if (scenario.insertError) throw scenario.insertError;
    return { insertId: 999 };
  }],
  // Everything below exists only for the end-to-end fail-soft test at the
  // bottom, which drives the real job.service.setStatus(): the column probes,
  // getJobMeta's read, and the UPDATE. No other test in this file queries them.
  [/INFORMATION_SCHEMA/i, () => [{ n: 3 }]],
  [/UPDATE\s+tbl_job\s+SET/i, () => ({ affectedRows: 1 })],
  [/FROM\s+tbl_job\s+WHERE\s+job_id/i, () => [{
    job_id: 42, job_status: 0, fk_easyfixter_id: 7, fk_customer_id: 3,
    fk_client_id: 5, requested_date_time: '2026-08-20 10:00:00',
    booking_cut_off_time_slot: null, otp: null,
  }]],
]);

const jobLog = require('../services/job-log.service');
const jobService = require('../services/job.service');

after(() => fake.restore());
beforeEach(() => {
  fake.calls.length = 0;
  scenario.insertError = null;
  scenario.revisitReasonRows = null;
  scenario.revisitReasonError = null;
  scenario.droppedTable = null;
  scenario.droppedColumn = null;
});

function insert() {
  return fake.calls.find((c) => /INSERT\s+INTO\s+tbl_job_logs/i.test(c.sql)) || null;
}
// Named accessors so a column-order change fails loudly instead of shifting
// every assertion by one.
const COL = Object.fromEntries(jobLog.COLUMNS.map((c, i) => [c, i]));

/* ── The insert shape ─────────────────────────────────────────────────────── */

test('column order matches the legacy CRM insert, with old_data in its declared position', () => {
  assert.deepEqual(jobLog.COLUMNS, [
    'log_for', 'old_data', 'new_data', 'job_id', 'eta_status', 'change_date', 'changed_by', 'comments',
  ]);
});

test('one parameterised INSERT with a placeholder per column', async () => {
  await jobLog.logNewJob(42, { user_id: 7 });
  const q = insert();
  assert.ok(q, 'an INSERT INTO tbl_job_logs should have been issued');
  assert.match(q.sql, /INSERT INTO tbl_job_logs \(log_for, old_data, new_data, job_id, eta_status, change_date, changed_by, comments\) VALUES \(\?, \?, \?, \?, \?, \?, \?, \?\)/);
  assert.equal(q.params.length, jobLog.COLUMNS.length);
});

test('event_received_date is never written — change_date IS the event instant', async () => {
  await jobLog.logNewJob(42, { user_id: 7 });
  assert.doesNotMatch(insert().sql, /event_received_date/i);
});

/* ── The vocabulary ───────────────────────────────────────────────────────── */

/*
 * SELECT DISTINCT log_for FROM tbl_job_logs, production, 2026-08-20. Copied here
 * so a change to LOG_FOR is checked against the TABLE and not against itself.
 */
const LIVE_LOG_FOR_VALUES = [
  'Requested Date/time Change', 'Re-Scheduling', 'job Desc', 'new job', 'checkout',
  'schedule', 'Requested For ETA', 'checkin', 'Re-visit Required', 'reject',
  'Expected Date/time Change',
];

test('the five continued log_for values are byte-identical to production', () => {
  for (const key of ['NEW_JOB', 'SCHEDULE', 'CHECKOUT', 'RESCHEDULE', 'REVISIT_REQUIRED']) {
    assert.ok(
      LIVE_LOG_FOR_VALUES.includes(jobLog.LOG_FOR[key]),
      `LOG_FOR.${key} = ${JSON.stringify(jobLog.LOG_FOR[key])} is not a value the live table holds`,
    );
  }
  // Spelled out too, so the diff shows what changed if one is edited.
  assert.equal(jobLog.LOG_FOR.NEW_JOB, 'new job');
  assert.equal(jobLog.LOG_FOR.SCHEDULE, 'schedule');
  assert.equal(jobLog.LOG_FOR.CHECKOUT, 'checkout');
  assert.equal(jobLog.LOG_FOR.RESCHEDULE, 'Re-Scheduling');
  assert.equal(jobLog.LOG_FOR.REVISIT_REQUIRED, 'Re-visit Required');
});

test('the new status-transition event does NOT reuse a legacy value', () => {
  assert.ok(
    !LIVE_LOG_FOR_VALUES.includes(jobLog.LOG_FOR.STATUS_CHANGE),
    'a generic transition must get its own log_for, never overload an existing one',
  );
});

test('the six dead log_for values are not written by anything here', () => {
  const dead = ['checkin', 'reject', 'Requested For ETA', 'Requested Date/time Change',
    'Expected Date/time Change', 'job Desc'];
  const written = Object.values(jobLog.LOG_FOR);
  for (const d of dead) {
    assert.ok(!written.includes(d), `${d} died with its writer and must not be resurrected`);
  }
});

test('log_for is lowercased but new_data keeps the original casing — checkOut / New Job', async () => {
  await jobLog.logCheckout(481851, { user_id: 5169 });
  let q = insert();
  assert.equal(q.params[COL.log_for], 'checkout');
  assert.equal(q.params[COL.new_data], 'checkOut_481851', 'production holds checkOut_481851 for log_for=checkout');

  fake.calls.length = 0;
  await jobLog.logNewJob(482393, { user_id: 6540 });
  q = insert();
  assert.equal(q.params[COL.log_for], 'new job');
  assert.equal(q.params[COL.new_data], 'New Job_482393');

  fake.calls.length = 0;
  await jobLog.logSchedule(482236, { user_id: 5776 });
  q = insert();
  assert.equal(q.params[COL.log_for], 'schedule');
  assert.equal(q.params[COL.new_data], 'schedule_482236');

  fake.calls.length = 0;
  await jobLog.logRevisitRequired(476642, {}, { efr_id: 4679 });
  q = insert();
  assert.equal(q.params[COL.log_for], 'Re-visit Required');
  assert.equal(q.params[COL.new_data], 'revisit_476642');
});

test('eta_status is per-event, not a constant — 01 / 1 / 3 / NULL as production holds', async () => {
  const cases = [
    [() => jobLog.logNewJob(1, { user_id: 7 }), '01'],
    [() => jobLog.logSchedule(1, { user_id: 7 }), '1'],
    [() => jobLog.logCheckout(1, { user_id: 7 }), '3'],
    [() => jobLog.logRevisitRequired(1, {}, { user_id: 7 }), '01'],
    [() => jobLog.logReschedule(1, {}, { user_id: 7 }), null],
    [() => jobLog.logStatusChange(1, { from: 0, to: 2 }, { user_id: 7 }), null],
  ];
  for (const [run, expected] of cases) {
    fake.calls.length = 0;
    await run();
    assert.equal(insert().params[COL.eta_status], expected);
  }
});

/* ── The actor scheme ─────────────────────────────────────────────────────── */

test('a CRM user goes in changed_by and is marked as CRM-sourced', async () => {
  await jobLog.logNewJob(42, { user_id: 5776 });
  const q = insert();
  assert.equal(q.params[COL.changed_by], 5776);
  assert.equal(q.params[COL.comments], 'Changed by New CRM');
});

test('a technician NEVER reaches changed_by — efr_id form', async () => {
  // routes/mobile passes { user_id: <efr_id>, efr_id: <efr_id> }: the raw efr id
  // is in the user_id slot, and efr_id is what stops it being read as a person.
  await jobLog.logCheckout(42, { user_id: 2702, efr_id: 2702 });
  const q = insert();
  assert.equal(q.params[COL.changed_by], jobLog.NO_CRM_USER);
  assert.equal(q.params[COL.changed_by], 0);
  assert.equal(q.params[COL.comments], 'Changed by New CRM App (efr:2702)');
});

test('a technician NEVER reaches changed_by — efr:<n> principal form', async () => {
  // middleware/auth.js shapes a technician bearer as { user_id: 'efr:2702', efr_id: 2702 }.
  await jobLog.logCheckout(42, { user_id: 'efr:2702' });
  const q = insert();
  assert.equal(q.params[COL.changed_by], 0);
  assert.equal(q.params[COL.comments], 'Changed by New CRM App (efr:2702)');
});

test('no actor is recorded as the system, not as user 0-by-accident', async () => {
  // routes/integration/v1 passes { user_id: null }.
  await jobLog.logNewJob(42, { user_id: null });
  assert.equal(insert().params[COL.changed_by], 0);
  assert.equal(insert().params[COL.comments], 'Changed by New CRM System');

  fake.calls.length = 0;
  await jobLog.logNewJob(42, undefined);
  assert.equal(insert().params[COL.comments], 'Changed by New CRM System');
});

test('every source marker is prefix-distinct from the two legacy ones', () => {
  for (const s of Object.values(jobLog.SOURCE)) {
    assert.notEqual(s, 'Changed by CRM', 'must not collide with the old CRM marker');
    assert.notEqual(s, 'Changed by Api', 'must not collide with the old API marker');
    assert.ok(s.startsWith('Changed by New CRM'), 'one LIKE prefix must select every row we wrote');
  }
});

test('an efr_id actor wins over a numeric user_id on the same object', async () => {
  // Order matters: a technician principal carries BOTH, and reading user_id first
  // would put an efr id in changed_by.
  const resolved = jobLog.resolveActor({ user_id: 5776, efr_id: 2702 });
  assert.equal(resolved.changedBy, 0);
  assert.match(resolved.comments, /efr:2702/);
});

/* ── change_date is the event instant ─────────────────────────────────────── */

test('change_date is a bound Date at the event instant, never SQL NOW()', async () => {
  const before = Date.now();
  await jobLog.logNewJob(42, { user_id: 7 });
  const after = Date.now();
  const q = insert();
  assert.doesNotMatch(q.sql, /NOW\(\)/i, 'NOW() would not be assertable and is not this repo IST convention');
  const at = q.params[COL.change_date];
  assert.ok(at instanceof Date, 'change_date must bind a JS Date so the pool applies its +05:30 timezone');
  assert.ok(+at >= before && +at <= after, 'change_date must be the event instant');
});

test('a caller may pass the instant the event actually happened', async () => {
  const when = new Date('2026-04-29T05:12:35.000Z');
  await jobLog.logCheckout(42, { user_id: 7 }, when);
  assert.equal(+insert().params[COL.change_date], +when);
});

/* ── before / after on a transition ───────────────────────────────────────── */

test('a status transition carries before and after', async () => {
  await jobLog.logStatusChange(42, { from: 0, to: 3 }, { user_id: 5776 });
  const q = insert();
  assert.equal(q.params[COL.log_for], 'status change');
  assert.equal(q.params[COL.old_data], 'Status: 0');
  assert.equal(q.params[COL.new_data], 'Status: 3');
});

test('a no-op transition writes nothing — the mobile extras path passes the CURRENT status', async () => {
  const id = await jobLog.logStatusChange(42, { from: 1, to: 1 }, { user_id: 7 });
  assert.equal(id, null);
  assert.equal(insert(), null, 'thousands of 1 -> 1 rows would bury the real transitions');
});

test('a reschedule carries the technician and schedule it replaced', async () => {
  await jobLog.logReschedule(42, {
    previousEasyfixerId: 7928,
    newEasyfixerId: 155,
    previousScheduledBy: 7813,
    previousScheduledAt: '2026-04-28 18:18:47',
  }, { user_id: 7813 });
  const q = insert();
  assert.equal(q.params[COL.log_for], 'Re-Scheduling');
  assert.equal(q.params[COL.old_data], 'Efr_id: 7928 Sched_by: 7813 Sched_date: 2026-04-28 18:18:47');
  assert.equal(q.params[COL.new_data], 'Efr_id: 155');
});

test('an unassigned reschedule omits the technician rather than writing "null"', async () => {
  await jobLog.logReschedule(42, { previousScheduledBy: 7813 }, { user_id: 7813 });
  const q = insert();
  assert.equal(q.params[COL.old_data], 'Sched_by: 7813');
  assert.equal(q.params[COL.new_data], null);
});

/* ── No PII, and the column widths ────────────────────────────────────────── */

test('caller-supplied free text cannot reach the table', async () => {
  // The signature only takes an id; a string smuggled in is coerced away rather
  // than concatenated into old_data, and never reaches the reason lookup.
  await jobLog.logRevisitRequired(42, { reasonId: 'customer 9876543210 says buy material' }, { efr_id: 9 });
  const q = insert();
  for (const p of q.params) {
    assert.doesNotMatch(String(p), /9876543210/, 'no caller-supplied text may land in this table');
  }
  assert.equal(q.params[COL.old_data], null);
  assert.equal(
    fake.calls.some((c) => /revisit_reason_by_app/i.test(c.sql)), false,
    'a non-id must not even be looked up',
  );
});

/* ── The revisit reason is a LABEL, because a live screen renders it ───────── */

/*
 * EasyFix_CRM JobAction.java:1144 reads THIS column as the reason text:
 *   JobsLog reasonList = jobService.getRescheduledReasonByJobId(jobId, "Re-visit Required");
 *   responseObj.setReSchReason(reasonList.getOldValue());
 * Both legacy writers oblige — ACD_APIs JobServiceImpl:1017 writes
 * EasyfixerRevisitReason.getReason(), EasyFix_API JobsResource:440 the
 * reschReason string. An id in that slot renders as an id to an operator.
 */
test('a revisit reason is written as the LABEL the legacy screen renders, never as an id', async () => {
  scenario.revisitReasonRows = [{ reason: 'Need to buy material' }];
  await jobLog.logRevisitRequired(476642, { reasonId: 12 }, { efr_id: 9 });
  const q = insert();
  assert.equal(q.params[COL.old_data], 'Need to buy material');
  assert.doesNotMatch(
    String(q.params[COL.old_data]), /Reason_id/,
    'JobAction.setReSchReason() prints this verbatim — an id here is a garbage render',
  );
  // Resolved from the master by id, never taken from the caller.
  const lookup = fake.calls.find((c) => /revisit_reason_by_app/i.test(c.sql));
  assert.ok(lookup, 'the label must come from revisit_reason_by_app');
  assert.match(lookup.sql, /SELECT reason FROM revisit_reason_by_app WHERE id = \?/);
  assert.deepEqual(lookup.params, [12]);
});

test('the reason master is queried by id, and a resolved label is cached', async () => {
  scenario.revisitReasonRows = [{ reason: 'Spare part awaited' }];
  await jobLog.logRevisitRequired(42, { reasonId: 8123 }, { efr_id: 9 });
  assert.equal(insert().params[COL.old_data], 'Spare part awaited');

  fake.calls.length = 0;
  // Same id again — a static master of a handful of rows should not be re-read.
  await jobLog.logRevisitRequired(43, { reasonId: 8123 }, { efr_id: 9 });
  assert.equal(insert().params[COL.old_data], 'Spare part awaited');
  assert.equal(
    fake.calls.some((c) => /revisit_reason_by_app/i.test(c.sql)), false,
    'the second revisit for the same reason must not re-query the master',
  );
});

test('an unresolvable reason writes NO reason — never a placeholder the screen would print', async () => {
  // A reason id with no master row: the row is still written (the revisit
  // happened), the reason column is simply empty.
  scenario.revisitReasonRows = [];
  await jobLog.logRevisitRequired(42, { reasonId: 8201 }, { efr_id: 9 });
  let q = insert();
  assert.ok(q, 'the history row must still be written');
  assert.equal(q.params[COL.old_data], null);
  assert.equal(q.params[COL.log_for], 'Re-visit Required');

  // A master that cannot be READ must cost at most a blank reason — never the
  // job mutation that already committed, and never an exception.
  fake.calls.length = 0;
  scenario.revisitReasonError = Object.assign(
    new Error("Table 'revisit_reason_by_app' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' },
  );
  const id = await jobLog.logRevisitRequired(42, { reasonId: 8202 }, { efr_id: 9 });
  assert.equal(id, 999, 'the log row is still written when the reason lookup fails');
  q = insert();
  assert.equal(q.params[COL.old_data], null);

  // And the failure is not cached as if it were an answer.
  fake.calls.length = 0;
  scenario.revisitReasonError = null;
  scenario.revisitReasonRows = [{ reason: 'Customer not available' }];
  await jobLog.logRevisitRequired(42, { reasonId: 8202 }, { efr_id: 9 });
  assert.equal(insert().params[COL.old_data], 'Customer not available');
});

test('a blank master row is treated as no reason, not as an empty reason', async () => {
  scenario.revisitReasonRows = [{ reason: '   ' }];
  await jobLog.logRevisitRequired(42, { reasonId: 8301 }, { efr_id: 9 });
  assert.equal(insert().params[COL.old_data], null);
});

test('values are clipped to the live column widths', async () => {
  // varchar(255) x3 and a tinytext; MySQL would either reject (strict) or
  // silently halve the value, so the clip happens here.
  await jobLog.logReschedule(42, { previousScheduledBy: 1, previousScheduledAt: 'x'.repeat(400) }, { user_id: 7 });
  const q = insert();
  assert.ok(q.params[COL.old_data].length <= 255);
  assert.ok(String(q.params[COL.comments]).length <= 255);
});

/* ── Fail-soft ────────────────────────────────────────────────────────────── */

test('a failing insert is swallowed and returns null', async () => {
  scenario.insertError = Object.assign(new Error('Table ... doesn\'t exist'), { code: 'ER_NO_SUCH_TABLE' });
  const id = await jobLog.logNewJob(42, { user_id: 7 });
  assert.equal(id, null, 'the write must fail SOFT — a history row is worth less than the mutation');
});

test('the caller still succeeds when the log insert throws', async () => {
  // Stands in for job.service: mutate, commit, then log. The mutation's return
  // value must survive a dead tbl_job_logs.
  scenario.insertError = new Error('Deadlock found when trying to get lock');
  async function mutateThenLog() {
    const result = { jobId: 42, committed: true };
    await jobLog.logStatusChange(42, { from: 0, to: 3 }, { user_id: 7 });
    return result;
  }
  assert.deepEqual(await mutateThenLog(), { jobId: 42, committed: true });
});

test('every exported writer is fail-soft, not just the one we sampled', async () => {
  scenario.insertError = new Error('connection lost');
  const writers = [
    () => jobLog.logNewJob(42, { user_id: 7 }),
    () => jobLog.logSchedule(42, { user_id: 7 }),
    () => jobLog.logCheckout(42, { user_id: 7 }),
    () => jobLog.logReschedule(42, { newEasyfixerId: 5 }, { user_id: 7 }),
    () => jobLog.logRevisitRequired(42, { reasonId: 3 }, { user_id: 7 }),
    () => jobLog.logStatusChange(42, { from: 0, to: 2 }, { user_id: 7 }),
  ];
  for (const w of writers) assert.equal(await w(), null);
});

test('a row with no job id is refused rather than written NULL', async () => {
  // 'job Desc' is the legacy event whose 9,705 rows are all job_id NULL and are
  // therefore unreadable as the history of any job. Not repeating that.
  assert.equal(await jobLog.logNewJob(null, { user_id: 7 }), null);
  assert.equal(insert(), null);
});

/*
 * End-to-end: the same guarantee through the real caller. job.service.setStatus
 * is the transition every consumer funnels through, and a dead tbl_job_logs must
 * not turn a status change that ALREADY COMMITTED into a 500.
 */
test('setStatus still succeeds when the tbl_job_logs insert throws', async () => {
  scenario.insertError = new Error('Table \'tbl_job_logs\' doesn\'t exist');
  await assert.doesNotReject(() => jobService.setStatus(42, { status: 3 }, { user_id: 5776 }));
  assert.ok(
    fake.calls.some((c) => /UPDATE\s+tbl_job\s+SET/i.test(c.sql)),
    'the transition itself must have been issued',
  );
  assert.ok(
    fake.calls.some((c) => /INSERT\s+INTO\s+tbl_job_logs/i.test(c.sql)),
    'and the log must have been attempted, not skipped',
  );
});

test('setStatus writes the transition on the shared pool AFTER the UPDATE, not inside it', async () => {
  await jobService.setStatus(42, { status: 3 }, { user_id: 5776 });
  const updateAt = fake.calls.findIndex((c) => /UPDATE\s+tbl_job\s+SET/i.test(c.sql));
  const logs = fake.calls.filter((c) => /INSERT\s+INTO\s+tbl_job_logs/i.test(c.sql));
  assert.ok(updateAt >= 0);
  assert.ok(
    fake.calls.indexOf(logs[0]) > updateAt,
    'the log row describes a change that has already landed',
  );
  // 0 -> 3 is both a transition and a checkout, and legacy keeps those as two
  // separate events, so two rows is correct.
  const kinds = logs.map((c) => c.params[COL.log_for]).sort();
  assert.deepEqual(kinds, ['checkout', 'status change']);
});

/* ── The admin route must be able to CARRY the revisit reason at all ───────── */

/*
 * services/job.service.js#setStatus reads `extras.revisit_reason_id` — to stamp
 * tbl_job.revisit_reason_id and to name the reason on the 'Re-visit Required'
 * log row. PATCH /api/admin/jobs/:id/status validates with job.validator's
 * statusBody and hands the RESULT straight to setStatus, and
 * middleware/validate.js runs Joi with `stripUnknown: true` — so a key the
 * schema does not declare is not rejected, it is silently deleted. `extras` was
 * not declared, which made that read unconditionally undefined from the CRM.
 *
 * These drive the REAL middleware rather than calling schema.validate() with
 * hand-copied options, because the defect was in the interaction between the
 * schema and the middleware's options, not in either alone.
 */
const validate = require('../middleware/validate');
const { statusBody } = require('../validators/job.validator');

function throughStatusValidator(body) {
  const req = {
    body, method: 'PATCH', originalUrl: '/api/admin/jobs/42/status', user: { user_id: 5776 },
  };
  let rejected = null;
  const res = {
    locals: {},
    _code: 200,
    status(code) { this._code = code; return this; },
    json(payload) { rejected = { code: this._code, payload }; return this; },
  };
  let passed = false;
  validate(statusBody)(req, res, () => { passed = true; });
  return { passed, body: req.body, rejected };
}

test('the CRM status body carries extras.revisit_reason_id through to setStatus', () => {
  const r = throughStatusValidator({ status: 10, extras: { revisit_reason_id: 12 } });
  assert.ok(r.passed, 'a valid revisit body must not 400');
  assert.equal(
    r.body.extras && r.body.extras.revisit_reason_id, 12,
    'setStatus destructures `extras` — stripUnknown used to delete it before the service ever saw it',
  );
});

test('declaring extras did NOT open the whole tbl_job stamp surface', () => {
  // STATUS_EXTRAS_ALLOWLIST spans the mobile check-in / check-out / ETA columns.
  // An operator endpoint gets exactly the one key it legitimately carries; the
  // rest are stripped by the same mechanism that used to strip `extras` itself.
  const r = throughStatusValidator({
    status: 10,
    extras: {
      revisit_reason_id: 12,
      checkin_gps_location: '28.6,77.2',
      fk_checkin_by: 9,
      app_checkout_date_time: '2026-08-20 10:00:00',
    },
  });
  assert.ok(r.passed);
  assert.deepEqual(Object.keys(r.body.extras), ['revisit_reason_id']);
});

test('the mutation endpoint is no weaker than it was', () => {
  assert.equal(throughStatusValidator({ status: 999 }).passed, false, 'invalid status still 400s');
  assert.equal(throughStatusValidator({}).passed, false, 'status is still required');
  assert.equal(
    throughStatusValidator({ status: 10, extras: { revisit_reason_id: -1 } }).passed, false,
    'a reason id must still be a positive integer',
  );
  assert.equal(
    throughStatusValidator({ status: 10, extras: { revisit_reason_id: 'DROP TABLE' } }).passed, false,
    'a non-numeric reason id must still 400',
  );
  // And the bodies the CRM sends today are untouched.
  const cancel = throughStatusValidator({ status: 6, reasonId: 12, comment: 'customer cancelled' });
  assert.ok(cancel.passed, 'extras is optional — the cancel body still validates');
  assert.equal(cancel.body.extras, undefined);
});

test('a CRM revisit carries its reason all the way to the history row', async () => {
  scenario.revisitReasonRows = [{ reason: 'Need to buy material' }];
  const v = throughStatusValidator({ status: 10, extras: { revisit_reason_id: 8401 } });
  assert.ok(v.passed);

  // The route hands exactly this object to setStatus.
  await jobService.setStatus(42, v.body, { user_id: 5776 });

  const update = fake.calls.find((c) => /UPDATE\s+tbl_job\s+SET/i.test(c.sql));
  assert.match(update.sql, /revisit_reason_id = \?/, 'the reason must also reach tbl_job');

  const revisit = fake.calls
    .filter((c) => /INSERT\s+INTO\s+tbl_job_logs/i.test(c.sql))
    .find((c) => c.params[COL.log_for] === 'Re-visit Required');
  assert.ok(revisit, 'a transition into REVISIT must log the legacy event');
  assert.equal(
    revisit.params[COL.old_data], 'Need to buy material',
    'the operator-facing reason, resolved from the master — not an id, and not empty',
  );
});

/* ── A fail-soft table must not be able to block the boot ─────────────────── */

/*
 * server.js (~line 280) calls process.exit(1) on ANY entry in
 * requiredMismatches. Every write to tbl_job_logs is deliberately swallowed, so
 * the table cannot 500 a request — and a table that cannot break a request must
 * not be able to break a deploy. The columns are still checked; the finding is
 * reported through the same softer channel the hardening invariants use.
 */
const { verifySchemaAgainstLiveDb, bootWouldFail } = require('../scripts/schema-verify');

test('a missing tbl_job_logs is a degradation, not a boot blocker', async () => {
  scenario.droppedTable = 'tbl_job_logs';
  const report = await verifySchemaAgainstLiveDb();
  assert.deepEqual(
    report.requiredMismatches, [],
    'a table whose every write is swallowed must never reach the process.exit(1) list',
  );
  assert.ok(
    report.invariantMismatches.some((m) => m.table === 'tbl_job_logs'),
    'but it must still be REPORTED — the check is downgraded, not deleted',
  );
  assert.equal(
    bootWouldFail(report, { strictInvariants: false }), false,
    'a deploy into an environment without the archive must degrade, not crash-loop',
  );
});

test('a missing tbl_job_logs COLUMN is reported at the same softer severity', async () => {
  scenario.droppedColumn = { table: 'tbl_job_logs', col: 'eta_status' };
  const report = await verifySchemaAgainstLiveDb();
  assert.deepEqual(report.requiredMismatches, []);
  const found = report.invariantMismatches.find(
    (m) => m.table === 'tbl_job_logs' && m.col === 'eta_status',
  );
  assert.ok(found, 'the column list still does its job');
  assert.ok(found.impact, 'and says why it is survivable');
  assert.equal(bootWouldFail(report, { strictInvariants: false }), false);
});

test('a table the code SQL actually names still blocks the boot', async () => {
  // The downgrade is scoped to FAIL_SOFT_TABLES, not applied to EXPECTED at large.
  scenario.droppedTable = 'tbl_job';
  const report = await verifySchemaAgainstLiveDb();
  assert.ok(report.requiredMismatches.some((m) => m.table === 'tbl_job'));
  assert.equal(bootWouldFail(report, { strictInvariants: false }), true);

  scenario.droppedTable = null;
  scenario.droppedColumn = { table: 'tbl_job_comment', col: 'enum_reason_id' };
  const report2 = await verifySchemaAgainstLiveDb();
  assert.ok(report2.requiredMismatches.some((m) => m.col === 'enum_reason_id'));
  assert.equal(bootWouldFail(report2, { strictInvariants: false }), true);
});

test('only tables that can justify it are fail-soft', () => {
  const { FAIL_SOFT_TABLES, EXPECTED } = require('../scripts/schema-verify')._internals;
  assert.deepEqual(Object.keys(FAIL_SOFT_TABLES), ['tbl_job_logs']);
  for (const table of Object.keys(FAIL_SOFT_TABLES)) {
    assert.ok(EXPECTED[table], `${table} must still be column-checked, not merely exempted`);
  }
});
