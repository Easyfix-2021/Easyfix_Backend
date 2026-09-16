/*
 * Escalation-bucket age (TIMESTAMPDIFF(HOUR, TRC.escalated_time, NOW())).
 *
 * escalated_time is app-written (routes/admin/jobs.js binds `new Date()`), so
 * the read side must compare it against the same app clock rather than the
 * DB session zone — the repo's own rule (see
 * services/plivo-call-log.service.js::listStuckConferenceLegs): a comparison
 * must use the clock the column was written in. Both quicksight services
 * build this CASE with 6 TIMESTAMPDIFF(...) calls sharing one clock read.
 *
 * No DB: the shared pool singleton is faked before either service loads.
 */
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([[/[\s\S]*/, () => []]]);
after(() => fake.restore());
beforeEach(() => fake.reset());

const adminDashboard = require('../services/quicksight/quicksight-admin-dashboard.service');
const employeeProductivity = require('../services/quicksight/quicksight-employee-productivity.service');

function assertSixSharedNowBinds(sql, params) {
  assert.doesNotMatch(sql, /NOW\(\)/i);
  const qMarksBeforeGroupBy = sql.slice(0, sql.search(/GROUP BY/i)).match(/\?/g) || [];
  assert.ok(qMarksBeforeGroupBy.length >= 6, 'expected at least the 6 escalated_time binds');
  const qMarkCount = (sql.match(/\?/g) || []).length;
  assert.equal(qMarkCount, params.length, 'placeholder count must match bound params');
  const nowParams = params.slice(0, 6);
  for (const p of nowParams) assert.ok(p instanceof Date, 'escalated_time compares against a bound Date');
  assert.ok(nowParams.every((p) => p.getTime() === nowParams[0].getTime()), 'all six share one clock read');
  assert.ok(Math.abs(Date.now() - nowParams[0].getTime()) < 60000, 'the bound Date is ~now');
}

test('admin-dashboard escalation buckets compare escalated_time against a bound Date, never NOW()', async () => {
  await adminDashboard.openOrders({}, null);
  const esc = fake.calls.find((c) => /escalation_bucket/i.test(c.sql) && /TRC\.escalated_time/i.test(c.sql));
  assert.ok(esc, 'expected the escalation-bucket query to run');
  assertSixSharedNowBinds(esc.sql, esc.params);
});

test('employee-productivity escalation buckets compare escalated_time against a bound Date, never NOW()', async () => {
  const pf = {
    dateMode: 'requested', verticalId: null, zonalManagerId: null,
    applyClientFilter: 0, managedClientIds: [],
  };
  await employeeProductivity.getDashboardCounts({ pf });
  const esc = fake.calls.find((c) => /escalation_bucket/i.test(c.sql) && /TRC\.escalated_time/i.test(c.sql));
  assert.ok(esc, 'expected the escalation-bucket query to run');
  assertSixSharedNowBinds(esc.sql, esc.params);

  // The sibling open-orders bucket (requested/original appointment dates)
  // was left on NOW() by an earlier round; a later round converted it too
  // (quicksight-employee-productivity.service.js::fetchOpenOrders) — same
  // rule, same clock, once requested_date_time/original_appointment_date_time
  // were confirmed app-written.
  const openBucket = fake.calls.find((c) => /date_range/i.test(c.sql) && /requested_date_time/i.test(c.sql));
  assert.ok(openBucket, 'expected the open-orders aging query to run');
  assert.doesNotMatch(openBucket.sql, /NOW\(\)/i);
  const openQMarkCount = (openBucket.sql.match(/\?/g) || []).length;
  assert.equal(openQMarkCount, openBucket.params.length, 'placeholder count must match bound params');
  const openNowParams = openBucket.params.filter((p) => p instanceof Date);
  assert.equal(openNowParams.length, 4, 'expected the 4 age-bucket clock binds (Future + 3 TIMESTAMPDIFF branches)');
  assert.ok(openNowParams.every((p) => p.getTime() === openNowParams[0].getTime()), 'all four share one clock read');
});
