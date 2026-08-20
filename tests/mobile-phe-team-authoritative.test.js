const test = require('node:test');
const assert = require('node:assert/strict');

const phe = require('../services/mobile-phe.service');
const team = require('../services/mobile-team.service');
const { pool } = require('../db');

test.after(async () => {
  await pool.end();
});

test('Under Audit ledger is owner scoped, bounded and labels partial amount coverage', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/ORDER BY j\.app_checkout_date_time DESC/.test(sql)) return [[{
        job_id: 88277,
        title: 'Chimney service',
        client_name: 'Hafele',
        app_checkout_date_time: '2026-08-12 16:20:00',
        review_age_days: 3,
        review_age_secs: 259200,
        transaction_count: 1,
        technician_earning: 800,
      }, {
        job_id: 88301,
        title: 'Cabinet fitting',
        client_name: 'Hafele',
        app_checkout_date_time: '2026-08-13 12:00:00',
        review_age_days: 2,
        review_age_secs: 172800,
        transaction_count: 0,
        technician_earning: 0,
      }]];
      return [[{ total_jobs: 2, amount_known_jobs: 1, known_amount: 800 }]];
    },
  };

  const result = await phe.getInQa(7, { page: 2, limit: 99 }, db);
  assert.equal(calls.length, 2);
  assert.equal(result.limit, 50);
  assert.equal(result.page, 2);
  assert.equal(result.availability.semantics, 'OPERATIONS_UNDER_AUDIT_NOT_CLIENT_QC');
  assert.equal(result.summary.amountCoverageComplete, false);
  assert.equal(result.items[0].amount, 800);
  assert.equal(result.items[0].reviewAgeDays, 3);
  assert.equal(result.items[1].amount, null, 'a missing job transaction is not a fabricated zero');
  assert.equal(result.items[1].amountAvailability.reasonCode, 'NO_JOB_TRANSACTION');
  assert.ok(calls.every((call) => /j\.fk_easyfixter_id = \?/.test(call.sql)));
  assert.ok(calls.every((call) => /j\.no_of_req_approval < 1/.test(call.sql)));
  assert.ok(calls.every((call) => /j\.no_of_req_foh < 1/.test(call.sql)));
  assert.ok(calls.every((call) => /j\.revisit_reason_id IS NULL/.test(call.sql)));
  assert.deepEqual(calls[0].params.slice(-2), [50, 50]);
});

test('payout breakdown exposes only transaction-backed values', () => {
  const available = phe._internals.payoutBreakdown({
    transaction_count: 2,
    technician_earning: 1100,
    wallet_credit_count: 1,
    paid_to_technician: 1100,
  });
  assert.deepEqual(available.components.technicianEarning, {
    available: true,
    amount: 1100,
    source: 'tbl_job_transaction.efr_charge',
    reasonCode: null,
  });
  assert.deepEqual(available.components.paidToTechnician, {
    available: true,
    amount: 1100,
    source: 'tbl_easyfixer_transaction.amount',
    reasonCode: null,
  });
  for (const key of ['basePayout', 'sameDayIncentive', 'visitationCharge', 'material', 'penalty']) {
    assert.equal(available.components[key].amount, null);
    assert.equal(available.components[key].reasonCode, 'PAYOUT_COMPONENT_NOT_STORED');
  }

  const missing = phe._internals.payoutBreakdown({});
  assert.equal(missing.available, false);
  assert.equal(missing.components.technicianEarning.reasonCode, 'NO_JOB_TRANSACTION');
  assert.equal(missing.components.paidToTechnician.reasonCode, 'NO_JOB_LINKED_WALLET_CREDIT');
});

test('team member jobs enforce active ownership on every fact query and remain bounded', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT efr_id\s+FROM tbl_easyfixer/.test(sql)) return [[{ efr_id: 21 }]];
      if (/ORDER BY j\.checkout_date_time DESC/.test(sql)) return [[{
        job_id: 88213,
        title: 'AC service',
        client_name: 'Hafele',
        ticket_created_date_time: '2026-08-09 08:00:00',
        checkout_date_time: '2026-08-12 13:00:00',
        age_days: 3,
        age_secs: 277200,
        visit_number: 1,
        revisit_reason_id: null,
        transaction_count: 1,
        technician_earning: 450,
        job_rating: 4.5,
        on_time: 1,
        same_day: 1,
      }]];
      if (/SELECT COUNT\(\*\) AS total/.test(sql)) return [[{ total: 1 }]];
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };

  const result = await team.getMemberJobs(
    7,
    21,
    { month: '2026-08', page: 2, limit: 99 },
    db,
  );
  assert.equal(calls.length, 3);
  assert.equal(result.limit, 50);
  assert.equal(result.page, 2);
  assert.equal(result.items[0].amount, 450);
  assert.equal(result.items[0].ageDays, 3);
  assert.equal(result.items[0].recordedRevisit, false);
  const factCalls = calls.filter((call) => /FROM tbl_job j/.test(call.sql));
  assert.equal(factCalls.length, 2);
  assert.ok(factCalls.every((call) => /member\.efr_manager_id = \?/.test(call.sql)));
  assert.ok(factCalls.every((call) => /member\.efr_status = 1/.test(call.sql)));
  assert.deepEqual(factCalls[0].params.slice(-2), [50, 50]);
});

test('team metrics expose provenance blockers instead of synthetic rework, no-show or grade points', () => {
  const availability = team._internals.metricAvailability(2);
  assert.equal(availability.recordedRevisitJobs, 2);
  assert.equal(availability.rework.available, false);
  assert.equal(availability.rework.reasonCode, 'NO_CANONICAL_REWORK_OUTCOME');
  assert.equal(availability.noShow.reasonCode, 'NO_CANONICAL_JOB_NO_SHOW_OUTCOME');
  assert.equal(availability.gradeImpact.points, null);
  assert.equal(
    availability.gradeImpact.explanationCode,
    'CURRENT_GRADE_MODEL_HAS_NO_MEMBER_LEVEL_CAUSAL_LEDGER',
  );
});

test('team member jobs reject non-owned ids before reading fact tables', async () => {
  let calls = 0;
  const db = {
    async query(sql) {
      calls += 1;
      assert.doesNotMatch(sql, /FROM tbl_job j/);
      return [[]];
    },
  };
  await assert.rejects(
    team.getMemberJobs(7, 999, { month: '2026-08' }, db),
    (error) => error.status === 404 && error.message === 'team member not found',
  );
  assert.equal(calls, 1);
});
