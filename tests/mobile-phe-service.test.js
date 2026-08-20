const test = require('node:test');
const assert = require('node:assert/strict');

const phe = require('../services/mobile-phe.service');
const s3Storage = require('../utils/s3-storage');
const { pool } = require('../db');

test.after(async () => {
  await pool.end();
});

test('IST calendar helpers keep month windows deterministic at UTC boundary', () => {
  const { currentIstMonth, monthBounds, monthsBefore } = phe._internals;
  assert.equal(currentIstMonth(new Date('2026-08-31T19:00:00.000Z')), '2026-09');
  assert.deepEqual(monthBounds('2026-12'), { start: '2026-12-01', end: '2027-01-01' });
  assert.deepEqual(monthsBefore('2026-09', 3), ['2026-08', '2026-07', '2026-06']);
});

test('overview separates claimable, pending, withdrawn and lifetime paid-job money without inventing QC', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/FROM tbl_easyfixer e/.test(sql)) return [[{
        current_balance: 4250,
        request_id: 9,
        amount: 3000,
        status: 'paid',
        requested_on: '2026-08-10',
        processed_on: '2026-08-11',
        bank_name: 'HDFC',
        bank_account_number: '1234564471',
        remarks: 'REF-9',
      }]];
      if (/SUM\(CASE WHEN status = 'paid'/.test(sql)) return [[{
        total_withdrawn: 8600,
        pending_amount: 0,
        open_count: 0,
      }]];
      if (/lifetime_job_earnings/.test(sql)) return [[{
        lifetime_job_earnings: 386400,
      }]];
      if (/SELECT activity\.month_key/.test(sql)) {
        return [[
          { month_key: '2026-08' },
          { month_key: '2026-07' },
          { month_key: '2026-06' },
        ]];
      }
      if (/SUM\(p\.technician_earning\)/.test(sql)) {
        return [[{
          month_key: '2026-08', earnings: 18450,
          completed: 36, same_day: 29, rating: 4.7,
        }]];
      }
      if (/FROM tbl_job_offer jo/.test(sql)) {
        return [[{ month_key: '2026-08', given_count: 42, accepted_count: 38 }]];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };

  const result = await phe.getOverview(7, { before: '2026-09', limit: 2 }, db);
  assert.equal(calls.length, 6, 'fixed query count must not grow with month limit');
  assert.equal(result.wallet.availableToWithdraw, 4250);
  assert.equal(result.wallet.claimableNow, 4250);
  assert.equal(result.wallet.currentBalance, 4250);
  assert.equal(result.wallet.pendingWithdrawalAmount, 0);
  assert.equal(result.wallet.totalWithdrawn, 8600);
  assert.equal(result.wallet.lifetimeJobEarnings, 386400);
  assert.equal(result.wallet.canWithdraw, true);
  assert.equal(result.wallet.workInProgress, null);
  assert.equal(result.latestWithdrawal.accountLast4, '4471');
  assert.equal(result.months.items.length, 2);
  assert.deepEqual(result.months.items[0], {
    month: '2026-08', label: 'August 2026', earnings: 18450,
    given: 42, accepted: 38, completed: 36, sameDay: 29, rating: 4.7,
  });
  assert.equal(result.months.items[1].month, '2026-07');
  assert.equal(result.months.nextCursor, '2026-07');
  assert.deepEqual(result.features, { qc: false, inQa: true, workInProgress: true });
  assert.equal(Object.hasOwn(result.wallet, 'inQc'), false);
  const offerCall = calls.find((call) => /COUNT\(DISTINCT jo\.job_id\)/.test(call.sql));
  assert.match(offerCall.sql, /COUNT\(DISTINCT jo\.job_id\)/, 're-offers must not inflate jobs given');
  const paidCall = calls.find((call) => /SUM\(p\.technician_earning\)/.test(call.sql));
  assert.match(paidCall.sql, /LEFT JOIN tbl_job_transaction tjt ON tjt\.fk_job_id = j\.job_id/,
    'technician earnings must use the authoritative job transaction share');
  assert.doesNotMatch(paidCall.sql, /SUM\(ABS\(amount\)\)/,
    'wallet credits must not redefine a job earning');
  assert.match(paidCall.sql, /j\.checkout_date_time >= \?/,
    'paid amount and completion metrics must use one completion-month cohort');
});

test('overview returns no cursor when no older active month exists', async () => {
  const db = {
    async query(sql) {
      if (/FROM tbl_easyfixer e/.test(sql)) return [[{ current_balance: 0 }]];
      if (/SUM\(CASE WHEN status = 'paid'/.test(sql)) return [[{ total_withdrawn: 0, pending_amount: 0, open_count: 0 }]];
      if (/lifetime_job_earnings/.test(sql)) return [[{ lifetime_job_earnings: 0 }]];
      return [[]];
    },
  };

  const result = await phe.getOverview(7, { before: '2020-01', limit: 6 }, db);
  assert.equal(result.months.items.length, 0);
  assert.equal(result.months.nextCursor, null);
});

test('overview pages across a long inactive calendar gap using active month keys', async () => {
  const db = {
    async query(sql) {
      if (/FROM tbl_easyfixer e/.test(sql)) return [[{ current_balance: 0 }]];
      if (/SUM\(CASE WHEN status = 'paid'/.test(sql)) return [[{ total_withdrawn: 0, pending_amount: 0, open_count: 0 }]];
      if (/lifetime_job_earnings/.test(sql)) return [[{ lifetime_job_earnings: 450 }]];
      if (/SELECT activity\.month_key/.test(sql)) {
        return [[{ month_key: '2026-08' }, { month_key: '2024-01' }]];
      }
      if (/SUM\(p\.technician_earning\)/.test(sql)) {
        return [[{ month_key: '2026-08', earnings: 450, completed: 1, same_day: 1, rating: 5 }]];
      }
      if (/FROM tbl_job_offer jo/.test(sql)) return [[]];
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };

  const result = await phe.getOverview(7, { before: '2026-09', limit: 1 }, db);
  assert.deepEqual(result.months.items.map((item) => item.month), ['2026-08']);
  assert.equal(result.months.nextCursor, '2026-08', 'the 2024 activity remains reachable');
});

test('overview withholds claimable-now while finance has a requested payout', async () => {
  const db = {
    async query(sql) {
      if (/FROM tbl_easyfixer e/.test(sql)) return [[{ current_balance: 4250 }]];
      if (/SUM\(CASE WHEN status = 'paid'/.test(sql)) return [[{
        total_withdrawn: 3000,
        pending_amount: 4250,
        open_count: 1,
      }]];
      if (/lifetime_job_earnings/.test(sql)) return [[{ lifetime_job_earnings: 18450 }]];
      return [[]];
    },
  };

  const result = await phe.getOverview(7, { before: '2026-09', limit: 1 }, db);
  assert.equal(result.wallet.currentBalance, 4250, 'accounting balance is unchanged until finance settles');
  assert.equal(result.wallet.claimableNow, 0, 'a second request must not be invited');
  assert.equal(result.wallet.availableToWithdraw, 0, 'older app builds receive the same safe amount');
  assert.equal(result.wallet.canWithdraw, false);
  assert.equal(result.wallet.pendingWithdrawalAmount, 4250);
});

test('month jobs include zero-rupee completed work, stay owner scoped and page bounded', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/ORDER BY j\.checkout_date_time/.test(sql)) return [[{
        job_id: 88213,
        title: 'AC service',
        client_name: 'Hafele',
        ticket_created_date_time: '2026-08-09 08:00:00',
        created_date_time: '2026-08-10 09:00:00',
        checkout_date_time: '2026-08-12 13:00:00',
        paid_at: '2026-08-13 09:00:00',
        technician_earning: 450,
        job_rating: 4.5,
        on_time: 1,
        same_day: 1,
        visit_number: 1,
        is_escalated: 0,
        age_days: 3,
        age_secs: 277200,
      }]];
      if (/SELECT COUNT\(\*\) AS total/.test(sql)) return [[{ total: 1 }]];
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };

  const result = await phe.getMonthJobs(7, '2026-08', { page: 2, limit: 99 }, db);
  assert.equal(result.limit, 50);
  assert.equal(result.page, 2);
  assert.equal(result.items[0].amount, 450);
  assert.equal(result.items[0].bookedAt, '2026-08-09 08:00:00');
  assert.equal(result.items[0].recordCreatedAt, '2026-08-10 09:00:00');
  assert.equal(result.items[0].ageDays, 3);
  assert.equal(result.items[0].onTime, true);
  assert.equal(result.items[0].visitNumber, 1);
  assert.equal(result.items[0].isEscalated, false);
  assert.ok(calls.every((call) => /j\.fk_easyfixter_id = \?/.test(call.sql)));
  const dataCall = calls.find((call) => /ORDER BY j\.checkout_date_time/.test(call.sql));
  assert.match(dataCall.sql, /COALESCE\(SUM\(tjt\.efr_charge\), 0\)/,
    'completed warranty work remains visible even without a job transaction');
  assert.match(dataCall.sql, /MIN\(et\.transaction_date\)/,
    'wallet credit remains an optional settlement timestamp only');
  assert.match(dataCall.sql, /j\.checkout_date_time >= \?/);
  assert.deepEqual(dataCall.params.slice(-2), [50, 50]);
});

test('job proof detail returns bounded resolved media only and masks reviewer surname', async () => {
  const originalResolve = s3Storage.resolveImageUrl;
  s3Storage.resolveImageUrl = async (key) => `https://media.invalid/${encodeURIComponent(key)}`;
  const calls = [];
  const db = {
    async query(sql) {
      calls.push(sql);
      if (/SELECT j\.job_id/.test(sql)) return [[{
        job_id: 88213,
        title: 'AC service',
        client_name: 'Hafele',
        ticket_created_date_time: '2026-08-09',
        created_date_time: '2026-08-10',
        checkout_date_time: '2026-08-12',
        paid_at: '2026-08-13',
        technician_earning: 450,
        transaction_count: 1,
        gross_charge: 850,
        easyfix_charge: 400,
        client_charge: 850,
        customer_rating: 4.5,
        feedback: 'Very good work',
        reviewer_name: 'Anita Mehta',
        full_address: 'Sector 44, Gurgaon',
        age_days: 3,
        age_secs: 259200,
        offered_at: '2026-08-09 08:00:00',
        accepted_at: '2026-08-09 08:04:00',
        accepted_in_secs: 240,
        reached_at: '2026-08-12 10:00:00',
        visit_number: 1,
        revisit_reason_id: 4,
        revisit_reason: 'Material unavailable',
        is_escalated: 0,
        attendee_efr_id: 7,
        attendee_name: 'Rahul Kumar',
      }]];
      if (/LOWER\(image_category\) IN \('booking'/.test(sql)) return [[
        { image_id: 1, image: 'secret-before-key', image_category: 'booking', job_stage: 0, created_date: '2026-08-12' },
      ]];
      if (/LOWER\(image_category\) IN \('completion'/.test(sql)) return [[
        { image_id: 2, image: 'secret-after-key', image_category: 'completion', job_stage: 5, created_date: '2026-08-12' },
      ]];
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  try {
    const result = await phe.getJobDetail(7, 88213, db);
    assert.equal(result.customerFeedback.reviewerDisplayName, 'Anita M.');
    assert.equal(result.bookedAt, '2026-08-09');
    assert.equal(result.ageDays, 3);
    assert.equal(result.amount, 450);
    assert.deepEqual(result.earningsCalculation, {
      technicianEarning: 450,
      grossJobCharge: 850,
      easyFixCharge: 400,
      clientCharge: 850,
      transactionLines: 1,
    });
    assert.equal(result.acceptedInSecs, 240);
    assert.equal(result.reachedAt, '2026-08-12 10:00:00');
    assert.equal(result.visitNumber, 1);
    assert.deepEqual(result.recordedRevisitReason, {
      id: 4,
      label: 'Material unavailable',
    });
    assert.deepEqual(result.attendee, {
      efrId: 7,
      displayName: 'Rahul Kumar',
      isSelf: true,
    });
    assert.equal(result.attendedByType, 'SELF');
    assert.equal(Object.hasOwn(result, 'attendedBy'), false,
      'backend must not hard-code an English self label');
    assert.equal(result.proof.before.length, 1);
    assert.equal(result.proof.after.length, 1);
    assert.equal(Object.hasOwn(result.proof.before[0], 'image'), false, 'raw storage field must not be returned');
    assert.equal(Object.hasOwn(result, 'customerMobile'), false);
    const proofCalls = calls.filter((sql) => /FROM tbl_job_image/.test(sql));
    assert.equal(proofCalls.length, 2);
    assert.ok(proofCalls.every((sql) => /LIMIT 10/.test(sql)), 'each proof bucket must cap URL signing work');
    const detailCall = calls.find((sql) => /FROM tbl_job j/.test(sql));
    assert.match(detailCall, /SUM\(COALESCE\(tjt\.efr_charge, 0\)\)/,
      'detail calculation must use the canonical technician share');
    assert.match(detailCall, /TIMESTAMPDIFF\(SECOND, accepted\.offered_at, accepted\.responded_at\)/,
      'acceptance latency is derived from the accepted offer audit timestamps');
  } finally {
    s3Storage.resolveImageUrl = originalResolve;
  }
});

test('proof URL resolution signs canonical keys directly and preserves legacy fallback', async () => {
  const originalEnabled = s3Storage.isEnabled;
  const originalPresign = s3Storage.getPresignedUrl;
  const originalResolve = s3Storage.resolveImageUrl;
  const calls = [];
  s3Storage.isEnabled = () => true;
  s3Storage.getPresignedUrl = async (key) => {
    calls.push(['presign', key]);
    if (key.endsWith('_2')) throw new Error('temporary signer failure');
    return `https://signed.invalid/${key}`;
  };
  s3Storage.resolveImageUrl = async (key) => {
    calls.push(['legacy', key]);
    return `https://legacy.invalid/${key}`;
  };

  try {
    const canonical = await phe._internals.resolveProofImageUrl('JobSupportings/Completion_88213_1');
    const canonicalFallback = await phe._internals.resolveProofImageUrl('JobSupportings/Completion_88213_2');
    const legacy = await phe._internals.resolveProofImageUrl('Job_Images/88213_2');
    assert.equal(canonical, 'https://signed.invalid/JobSupportings/Completion_88213_1');
    assert.equal(canonicalFallback, 'https://legacy.invalid/JobSupportings/Completion_88213_2');
    assert.equal(legacy, 'https://legacy.invalid/Job_Images/88213_2');
    assert.deepEqual(calls, [
      ['presign', 'JobSupportings/Completion_88213_1'],
      ['presign', 'JobSupportings/Completion_88213_2'],
      ['legacy', 'JobSupportings/Completion_88213_2'],
      ['legacy', 'Job_Images/88213_2'],
    ], 'healthy canonical keys skip HEAD while signing failures and legacy keys keep fallback behavior');
  } finally {
    s3Storage.isEnabled = originalEnabled;
    s3Storage.getPresignedUrl = originalPresign;
    s3Storage.resolveImageUrl = originalResolve;
  }
});

test('proof URL resolution bounds legacy S3/local fallback concurrency and preserves row order', async () => {
  const originalEnabled = s3Storage.isEnabled;
  const originalResolve = s3Storage.resolveImageUrl;
  let active = 0;
  let peak = 0;
  s3Storage.isEnabled = () => false;
  s3Storage.resolveImageUrl = async (key) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return `https://legacy.invalid/${key}`;
  };

  try {
    const input = Array.from({ length: 17 }, (_, index) => ({
      image_id: index + 1,
      image: `legacy-${index + 1}.jpg`,
    }));
    const result = await phe._internals.resolveProofRows(input, 88213);
    assert.ok(
      peak <= phe._internals.PROOF_IMAGE_RESOLUTION_CONCURRENCY,
      `expected at most ${phe._internals.PROOF_IMAGE_RESOLUTION_CONCURRENCY} concurrent resolutions, saw ${peak}`,
    );
    assert.deepEqual(result.map(({ image }) => image.image_id), input.map((image) => image.image_id));
  } finally {
    s3Storage.isEnabled = originalEnabled;
    s3Storage.resolveImageUrl = originalResolve;
  }
});

test('job detail uses uniform 404 for unowned or missing completed jobs', async () => {
  const db = { async query() { return [[]]; } };
  await assert.rejects(
    phe.getJobDetail(7, 999, db),
    (error) => error.status === 404 && error.message === 'job not found',
  );
});

test('withdrawal history is bounded and exposes only masked destination', async () => {
  const db = {
    async query(sql) {
      if (/ORDER BY request_id DESC/.test(sql)) return [[{
        request_id: 12,
        amount: 5600,
        status: 'paid',
        requested_on: '2026-07-28',
        processed_on: '2026-07-29',
        bank_name: 'HDFC',
        bank_account_number: '1234564471',
        remarks: '8791220',
      }]];
      return [[{ total: 1 }]];
    },
  };
  const result = await phe.getWithdrawals(7, { page: 1, limit: 20 }, db);
  assert.equal(result.items[0].accountLast4, '4471');
  assert.equal(result.items[0].reference, null, 'operator remarks must not be presented as a bank reference');
  assert.equal(Object.hasOwn(result.items[0], 'bankAccountNumber'), false);
});

test('missed opportunities use two fixed 30-day windows and label partial amount coverage honestly', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      const currentWindow = calls.length <= 2;
      if (/FROM tbl_job_offer jo/.test(sql)) {
        return [[currentWindow
          ? {
            expired_jobs: 6,
            rejected_jobs: 2,
            expired_amount: 2400,
            rejected_amount: 700,
            expired_known: 5,
            rejected_known: 2,
          }
          : {
            expired_jobs: 8,
            rejected_jobs: 1,
            expired_amount: 5800,
            rejected_amount: 1000,
            expired_known: 8,
            rejected_known: 1,
          }]];
      }
      if (/j\.job_status = 6/.test(sql)) {
        return [[currentWindow
          ? { cancelled_jobs: 3, cancelled_amount: 1100, cancelled_known: 3 }
          : { cancelled_jobs: 2, cancelled_amount: 900, cancelled_known: 2 }]];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };

  const result = await phe.getMissed(7, { days: 30 }, db);
  assert.equal(calls.length, 4, 'current and comparison windows stay a fixed four queries');
  assert.ok(calls.every((call) => call.params[0] === 7));
  assert.ok(calls.every((call) => call.params.length === 3));
  assert.equal(result.period.days, 30);
  assert.equal(result.summary.knownPotentialAmount, 4200);
  assert.equal(result.summary.amountCoverageComplete, false);
  assert.equal(result.previousPeriod.knownPotentialAmount, 7700);
  assert.equal(result.previousPeriod.amountCoverageComplete, true);
  const missedOfferCalls = calls.filter((call) => /FROM tbl_job_offer jo/.test(call.sql));
  assert.ok(missedOfferCalls.every((call) => /MAX\(job_offer_id\)/.test(call.sql)),
    're-offers in a window must collapse to the latest outcome per job');
  assert.deepEqual(result.categories.map((item) => item.key), [
    'expired', 'rejected', 'cancelledAfterAssignment',
  ]);
  assert.equal(Object.hasOwn(result.summary, 'acceptedThenGivenAway'), false);
});
