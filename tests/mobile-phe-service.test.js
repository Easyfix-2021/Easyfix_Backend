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
  const offerCall = calls.find((call) => /AS given_count/.test(call.sql));
  assert.match(offerCall.sql, /COUNT\(DISTINCT g\.job_id\) AS given_count/, "re-offers must not inflate jobs given");
  assert.match(offerCall.sql, /j\.job_status IN \(3, 5\)/, "directly assigned completed jobs count as given");
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

test('missed opportunities attribute no expiry when closed_reason is absent', async (t) => {
  const closedReason = require('../services/offer-closed-reason');
  t.mock.method(closedReason, 'hasOfferClosedReasonCol', async () => false);
  const sqls = [];
  const db = {
    async query(sql) {
      sqls.push(sql);
      return [[]];
    },
  };
  await phe.getMissed(7, { days: 30 }, db);
  const offerSql = sqls.filter((sql) => /FROM tbl_job_offer jo/.test(sql));
  assert.equal(offerSql.length, 2);
  assert.ok(offerSql.every((sql) => /offer_status = 2 OR FALSE/.test(sql) && !/closed_reason/.test(sql)));
});

test('month jobs list the Given cohort (offered or completed), owner-only facts, page bounded', async () => {
  const calls = [];
  const base = {
    title: 'AC service', client_name: 'Hafele', ticket_created_date_time: '2026-08-09 08:00:00',
    created_date_time: '2026-08-10 09:00:00', paid_at: null, technician_earning: 0,
    job_rating: null, on_time: 1, same_day: 1, visit_number: 1, is_escalated: 0,
    age_days: 3, age_secs: 277200, checkin_date_time: '2026-08-12 10:00:00', my_offer_status: null,
  };
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/ORDER BY g\.given_at/.test(sql)) return [[
        { ...base, job_id: 1, fk_easyfixter_id: 7, job_status: 3, checkout_date_time: '2026-08-12 13:00:00',
          paid_at: '2026-08-13 09:00:00', technician_earning: 450, job_rating: 4.5 },
        { ...base, job_id: 2, fk_easyfixter_id: 7, job_status: 1, checkin_date_time: null, my_offer_status: 1 },
        { ...base, job_id: 3, fk_easyfixter_id: 99, job_status: 3, technician_earning: 800, my_offer_status: 3 },
        { ...base, job_id: 4, fk_easyfixter_id: null, job_status: 0, checkin_date_time: null, my_offer_status: 2 },
      ]];
      if (/SELECT COUNT\(\*\) AS total/.test(sql)) return [[{ total: 4 }]];
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };

  const result = await phe.getMonthJobs(7, '2026-08', { page: 2, limit: 99 }, db);
  assert.equal(result.limit, 50);
  assert.equal(result.page, 2);
  assert.equal(result.total, 4);
  const [done, accepted, sibling, declined] = result.items;
  assert.deepEqual(result.items.map((i) => i.outcome), ['completed', 'accepted', 'missed', 'declined']);
  assert.equal(done.amount, 450);
  assert.equal(done.onTime, true);
  assert.equal(done.visitNumber, 1);
  assert.equal(done.bookedAt, '2026-08-09 08:00:00');
  assert.equal(accepted.amount, null, 'an unfinished job must not read as ₹0 earned');
  assert.equal(accepted.onTime, null, 'no check-in yet is not "late"');
  assert.equal(sibling.amount, null, "a sibling's earning is not this technician's");
  assert.equal(sibling.onTime, null, "a sibling's check-in is not reported");
  assert.equal(sibling.visitNumber, null);
  assert.equal(declined.amount, null);
  const dataCall = calls.find((call) => /ORDER BY g\.given_at/.test(call.sql));
  const countCall = calls.find((call) => /COUNT\(\*\) AS total/.test(call.sql));
  for (const call of [dataCall, countCall]) {
    assert.match(call.sql, /jo\.fk_easyfixter_id = \? AND jo\.offered_at >= \?/, 'cohort includes offered jobs');
    assert.match(call.sql, /j\.job_status IN \(3, 5\)\s+AND j\.checkout_date_time >= \?/, 'cohort includes completed jobs');
  }
  assert.deepEqual(countCall.params, [7, '2026-08-01', '2026-09-01', 7, '2026-08-01', '2026-09-01'].map((v, i) => (
    typeof v === 'string' ? countCall.params[i] : v)));
  assert.equal(dataCall.params.filter((p) => p === 7).length, 5, 'every branch is technician scoped');
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
      if (/LOWER\(image_category\) = 'feedback'/.test(sql)) return [[]];
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  try {
    const result = await phe.getJobDetail(7, 88213, db);
    assert.equal(result.customerFeedback.reviewerDisplayName, 'Anita M.');
    assert.equal(result.bookedAt, '2026-08-09');
    assert.equal(result.ageDays, 3);
    assert.equal(result.amount, 450);
    assert.equal(Object.hasOwn(result, 'earningsCalculation'), false,
      'the per-job charge totals left the mobile payload on 2026-09-16: the app stopped rendering them '
      + 'and the CRM mirror bundle was refreshed first, so nothing reads them any more');
    assert.deepEqual(result.payoutBreakdown.components.technicianEarning, {
      available: true,
      amount: 450,
      source: 'tbl_job_transaction.efr_charge',
      reasonCode: null,
    }, 'tx.transaction_count still gates the payout card — removing it alongside the charge sums would '
      + 'silently blank every row of Payout Details');
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
    assert.equal(proofCalls.length, 3, 'two proof buckets plus the feedback document');
    const bucketCalls = proofCalls.filter((sql) => /IN \(/.test(sql));
    assert.equal(bucketCalls.length, 2);
    assert.ok(bucketCalls.every((sql) => /LIMIT 10/.test(sql)), 'each proof bucket must cap URL signing work');
    assert.ok(bucketCalls.every((sql) => /image NOT LIKE '%\.pdf'/.test(sql)),
      'a PDF is a document and must never reach a photo tile');
    const detailCall = calls.find((sql) => /FROM tbl_job j/.test(sql));
    assert.match(detailCall, /SUM\(COALESCE\(tjt\.efr_charge, 0\)\)/,
      'detail calculation must use the canonical technician share');
    assert.match(detailCall, /TIMESTAMPDIFF\(SECOND, accepted\.offered_at, accepted\.responded_at\)/,
      'acceptance latency is derived from the accepted offer audit timestamps');
  } finally {
    s3Storage.resolveImageUrl = originalResolve;
  }
});

/*
 * Regression: job 529042 showed "Before 3 photos / After 1 photo" while the
 * row set held 3 check-in photos, 6 check-out photos and one feedback PDF.
 *
 * The fixture above this one is why the defect shipped: it hands the service
 * image_category 'booking' / 'completion' — the vocabulary THIS backend writes
 * — so it passed while every row the field actually produces ('checkin' /
 * 'checkout', both at job_stage 2) took the other path. The rows below are the
 * real ones, and the stub EVALUATES the bucket predicate instead of answering
 * per query, so a predicate that stops matching the data fails the test.
 */
const JOB_529042_IMAGE_ROWS = [
  { image_id: 1622884, image: '529042_checkin_20260823060219.jpg', image_category: 'checkin', job_stage: 2, created_date: '2026-08-23 06:02:20' },
  { image_id: 1622885, image: '529042_checkin_20260823060222.jpg', image_category: 'checkin', job_stage: 2, created_date: '2026-08-23 06:02:23' },
  { image_id: 1622886, image: '529042_checkin_20260823060226.jpg', image_category: 'checkin', job_stage: 2, created_date: '2026-08-23 06:02:26' },
  { image_id: 1622887, image: '529042_checkout_20260823060303.jpg', image_category: 'checkout', job_stage: 2, created_date: '2026-08-23 06:03:04' },
  { image_id: 1622888, image: '529042_checkout_20260823060306.jpg', image_category: 'checkout', job_stage: 2, created_date: '2026-08-23 06:03:07' },
  { image_id: 1622889, image: '529042_checkout_20260823060309.jpg', image_category: 'checkout', job_stage: 2, created_date: '2026-08-23 06:03:10' },
  { image_id: 1622891, image: '529042_checkout_20260823060455.jpg', image_category: 'checkout', job_stage: 2, created_date: '2026-08-23 06:04:55' },
  { image_id: 1622892, image: '529042_checkout_20260823060527.jpg', image_category: 'checkout', job_stage: 2, created_date: '2026-08-23 06:05:27' },
  { image_id: 1622893, image: '529042_checkout_20260823060603.jpg', image_category: 'checkout', job_stage: 2, created_date: '2026-08-23 06:06:03' },
  { image_id: 1623347, image: 'feedback529042.pdf', image_category: 'feedback', job_stage: 5, created_date: '2026-08-23 12:08:44' },
];

/** Apply a proof-bucket WHERE clause to the row set, the way MySQL would. */
function runProofQuery(sql, rows) {
  const inList = /LOWER\(image_category\) IN \(([^)]*)\)/.exec(sql);
  const single = /LOWER\(image_category\) = '([^']*)'/.exec(sql);
  const categories = new Set(
    (inList ? inList[1] : single ? `'${single[1]}'` : '')
      .split(',').map((v) => v.trim().replace(/^'|'$/g, '')).filter(Boolean),
  );
  const stageFallback = /job_stage = (\d+)/.exec(sql);
  const excludesPdf = /image NOT LIKE '%\.pdf'/.test(sql);
  const descending = /ORDER BY image_id DESC/.test(sql);
  const limit = Number((/LIMIT (\d+)/.exec(sql) || [])[1] || rows.length);
  const matched = rows.filter((row) => {
    if (excludesPdf && /\.pdf$/i.test(row.image)) return false;
    if (categories.has(String(row.image_category).toLowerCase())) return true;
    return !!stageFallback && Number(row.job_stage) === Number(stageFallback[1]);
  });
  matched.sort((a, b) => (descending ? b.image_id - a.image_id : a.image_id - b.image_id));
  return [matched.slice(0, limit)];
}

test('proof buckets follow the legacy checkin/checkout vocabulary, not job_stage', async () => {
  const originalResolve = s3Storage.resolveImageUrl;
  s3Storage.resolveImageUrl = async (key) => `https://media.invalid/${encodeURIComponent(key)}`;
  const db = {
    async query(sql) {
      if (/SELECT j\.job_id/.test(sql)) return [[{
        job_id: 529042, title: 'AC service', client_name: 'Hafele',
        checkout_date_time: '2026-08-23 12:00:00', technician_earning: 697,
        transaction_count: 1, customer_rating: 5, reviewer_name: 'Uma Sharma',
        age_days: 1, age_secs: 86400,
      }]];
      if (/FROM tbl_job_image/.test(sql)) return runProofQuery(sql, JOB_529042_IMAGE_ROWS);
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  try {
    const result = await phe.getJobDetail(8859, 529042, db);
    assert.equal(result.proof.before.length, 3, 'every check-in photo is a before photo');
    assert.equal(result.proof.after.length, 6, 'every check-out photo is an after photo');
    const everyUrl = [...result.proof.before, ...result.proof.after].map((p) => p.url).join(' ');
    assert.equal(/feedback529042\.pdf/.test(everyUrl), false,
      'the customer feedback PDF is a document, not a proof photo');
    assert.deepEqual(
      result.proof.before.map((p) => p.imageId),
      [1622884, 1622885, 1622886],
      'before photos stay in capture order',
    );
    // The feedback PDF is not a proof photo — but it is not nothing either.
    assert.match(result.customerFeedback.documentUrl, /feedback529042\.pdf/,
      'the signed feedback form is exposed as a document, not as an after photo');
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

test('missed opportunities price unposted jobs from the rate card and label unknowns honestly', async (t) => {
  const closedReason = require('../services/offer-closed-reason');
  t.mock.method(closedReason, 'hasOfferClosedReasonCol', async () => true);
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/FROM tbl_job_offer jo/.test(sql)) {
        const isCurrent = calls.filter((c) => /FROM tbl_job_offer jo/.test(c.sql)).length === 1;
        return [isCurrent
          ? [
            { job_id: 101, offer_status: 3, posted_amount: 400, posted: 1 },   // done by someone else
            { job_id: 102, offer_status: 3, posted_amount: null, posted: 0 },  // estimate 450
            { job_id: 103, offer_status: 3, posted_amount: null, posted: 0 },  // no service lines → unknown
            { job_id: 106, offer_status: 3, posted_amount: null, posted: 0 },  // materials only: +200 −50
            { job_id: 104, offer_status: 2, posted_amount: null, posted: 0 },  // estimate 300
          ]
          : [{ job_id: 201, offer_status: 2, posted_amount: 1000, posted: 1 }]];
      }
      if (/j\.job_status = 6/.test(sql)) {
        const isCurrent = calls.filter((c) => /j\.job_status = 6/.test(c.sql)).length === 1;
        return [isCurrent ? [{ job_id: 105, posted_amount: null, posted: 0 }] : []];
      }
      if (/tbl_tax_rate/.test(sql)) return [[{ rate: 0 }]];
      if (/rating_parameters_weightage/.test(sql)) return [[{ param_weightage: 0 }]];
      if (/FROM tbl_job_services js/.test(sql)) {
        const all = [
          { job_id: 102, total_charge: 450, quantity: 1 },
          { job_id: 104, total_charge: 150, quantity: 2 },
          { job_id: 105, total_charge: 250, quantity: 1 },
        ];
        return [all.filter((l) => params[0].includes(l.job_id))];
      }
      if (/FROM job_material/.test(sql)) {
        const all = [
          { job_id: 102, type: 'Material', tx_charge: 100 },
          { job_id: 106, type: 'travel', tx_charge: 200 },
          { job_id: 106, type: 'Penalty', tx_charge: 50 },
          { job_id: 104, type: 'unknown', tx_charge: 999 },
        ];
        return [all.filter((m) => params[0].includes(m.job_id))];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };

  const result = await phe.getMissed(7, { days: 30 }, db);
  const byKey = Object.fromEntries(result.categories.map((c) => [c.key, c]));
  assert.deepEqual(result.categories.map((item) => item.key), ['expired', 'rejected', 'cancelledAfterAssignment']);
  assert.equal(byKey.expired.jobs, 4);
  assert.equal(byKey.expired.knownAmount, 1100,
    'posted 400 + (450 service + 100 material) + (200 travel − 50 penalty); the unpriced job adds nothing');
  assert.equal(byKey.expired.amountCoverageComplete, false);
  assert.equal(byKey.rejected.knownAmount, 300, 'estimate multiplies by quantity');
  assert.equal(byKey.rejected.amountCoverageComplete, true);
  assert.equal(byKey.cancelledAfterAssignment.knownAmount, 250);
  assert.equal(result.summary.knownPotentialAmount, 1650, 'an unknown material type moves nothing');
  assert.equal(result.summary.amountCoverageComplete, false);
  assert.equal(result.previousPeriod.knownPotentialAmount, 1000);
  assert.equal(result.previousPeriod.amountCoverageComplete, true);
  const offerCalls = calls.filter((call) => /FROM tbl_job_offer jo/.test(call.sql));
  assert.ok(offerCalls.every((call) => call.params[0] === 7 && call.params.length === 3));
  assert.ok(offerCalls.every((call) => /offer_status = 3 AND jo\.closed_reason = 'ttl_elapsed'/.test(call.sql)),
    'only a real timeout counts as expired — sibling-accepted, re-offered etc. are not the technician\'s miss');
  assert.ok(offerCalls.every((call) => /MAX\(job_offer_id\)[\s\S]*\)\s*latest[\s\S]*WHERE \(jo\.offer_status = 2 OR/.test(call.sql)),
    'status filter must apply AFTER picking the latest offer, so an accepted re-offer is not a miss');
  assert.equal(Object.hasOwn(result.summary, 'acceptedThenGivenAway'), false);
  const cancelCalls = calls.filter((call) => /j\.job_status = 6/.test(call.sql));
  assert.ok(cancelCalls.every((call) => /JOIN action_taken_reason atr\s+ON atr\.id = j\.cancel_reason_id\s+AND atr\.action_type = 1\s+AND atr\.user_type = 4/.test(call.sql)),
    'only cancellations ops attributed to the technician count');
});

test('missed comparison stays hidden until the previous window postdates closed_reason', async (t) => {
  const closedReason = require('../services/offer-closed-reason');
  t.mock.method(closedReason, 'hasOfferClosedReasonCol', async () => true);
  const db = { async query() { return [[]]; } };
  // 2026-09-22 IST: previous window starts 2026-07-24 — before the column.
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-22T06:00:00Z') });
  assert.equal((await phe.getMissed(7, { days: 30 }, db)).previousPeriod.comparable, false);
  // The window includes today, so on 2026-11-08 IST the previous window starts
  // exactly 2026-09-10 — the first fully attributed day (boundary inclusive).
  t.mock.timers.setTime(new Date('2026-11-08T06:00:00Z').getTime());
  assert.equal((await phe.getMissed(7, { days: 30 }, db)).previousPeriod.comparable, true);
  t.mock.timers.setTime(new Date('2026-11-07T06:00:00Z').getTime());
  assert.equal((await phe.getMissed(7, { days: 30 }, db)).previousPeriod.comparable, false);
});
