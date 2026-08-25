const test = require('node:test');
const assert = require('node:assert/strict');

/*
 * ── A FUTURE DATE THAT CANNOT ROT ───────────────────────────────────────────
 *
 * assertTransition rejects a PAUSED/SUSPENDED `until` that is not strictly
 * after today, and it compares against TODAY IN IST:
 *
 *     const todayIst = new Intl.DateTimeFormat('en-CA',
 *       { timeZone: 'Asia/Kolkata' }).format(new Date());
 *     if (!/^\d{4}-\d{2}-\d{2}$/.test(suppliedUntil) || suppliedUntil <= todayIst)
 *       throw httpError(400, 'PAUSED until must be a future date');
 *
 * So any date LITERAL used as an `until` here is a bomb with a fuse on it.
 * This file shipped `until: '2026-08-20'`, comfortably in the future when it
 * was written, which became TODAY on 2026-08-20: the guard fired, the test
 * failed, and it took the QA and Production deploy pipelines down with it.
 * Bumping the literal to a later date only re-arms the same fuse, so the value
 * is COMPUTED.
 *
 * It is derived from the same clock AND the same timezone the guard reads, so
 * the two cannot disagree. A UTC-derived date would sit a day ahead of IST for
 * five and a half hours every night — an intermittent bomb instead of a dated
 * one, which is worse.
 */
function futureIstDate(daysAhead = 30) {
  const todayIst = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' })
    .format(new Date());
  // Anchored at UTC midnight so this is pure calendar arithmetic. IST observes
  // no DST, so no offset can shift the result by a day.
  const d = new Date(todayIst + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

/*
 * Resolved ONCE per run. A fixture and the transition that has to match it must
 * be the same string; calling futureIstDate() twice either side of IST midnight
 * would silently produce two different dates and fail somewhere unrelated.
 */
const FUTURE_UNTIL = futureIstDate(30);


const lifecycle = require('../services/easyfixer-lifecycle.service');
const evaluator = require('../services/easyfixer-lifecycle-evaluation-cron');
const registrationPush = require('../services/registration-status-push.service');

const {
  assertTransition,
  assertFinalActivationEligible,
  gate1FinalizationDecision,
  resolveGate1Finalization,
  assertManagerStatusInvariant,
  assertVerificationActivationSourceAllowed,
  operationalStatusForManager,
  requiresReapplicationVerificationReset,
  legacyStatusForTransition,
  protectsVerificationSync,
  historyItemFromRow,
  managementAlertForTransition,
  managementAlertMessage,
  expireOpenOffersForRestrictedLifecycle,
  overlayOpenJobCapabilities,
  OPEN_JOB_STATUSES,
} = lifecycle._internals;
const {
  decide,
  dateMs,
  drainBatches,
} = evaluator._internals;

test('list projection aliases derive an unverified complete profile as UNDER_VERIFICATION', () => {
  const row = {
    efr_status: 1,
    is_technician_verified: 0,
    user_id: 42,
    personal_details_filled: 1,
    lifecycle_personal_submitted: 1,
    lifecycle_aadhaar_present: 1,
    lifecycle_photo_present: 1,
  };
  assert.equal(lifecycle.deriveLegacyStatus(row), 'UNDER_VERIFICATION');
  assert.equal(lifecycle.lifecycleFromRow(row).status, 'UNDER_VERIFICATION');
});

test('list projection aliases fail closed to REGISTRATION_INCOMPLETE when a gate is missing', () => {
  const row = {
    efr_status: 1,
    is_technician_verified: 0,
    user_id: 42,
    personal_details_filled: 1,
    lifecycle_personal_submitted: 1,
    lifecycle_aadhaar_present: 1,
    lifecycle_photo_present: 0,
  };
  assert.equal(lifecycle.deriveLegacyStatus(row), 'REGISTRATION_INCOMPLETE');
});

test('legacy scheduled inactive rows derive SUSPENDED before migration', () => {
  assert.equal(lifecycle.deriveLegacyStatus({
    is_technician_verified: 1,
    efr_status: 0,
    // NOT a bomb: deriveLegacyStatus tests PRESENCE only —
    // `row.scheduled_reactivation_date ? 'SUSPENDED' : 'INACTIVE'` — so this is
    // never compared to today and any non-empty string behaves identically.
    scheduled_reactivation_date: '2099-01-01',
  }), 'SUSPENDED');
});

test('legacy NULL efr_status does not deactivate a verified technician', () => {
  const resolved = lifecycle.lifecycleFromRow({
    is_technician_verified: 1,
    efr_status: null,
  });
  assert.equal(resolved.status, 'ACTIVE');
  assert.equal(resolved.jobsAllowed, true);
  assert.deepEqual(Object.keys(resolved.capabilities), [
    'receiveNewJobs',
    'continueAssignedJobs',
    'mutateAssignedJobs',
    'markAttendance',
    'editRegistration',
    'claimMoney',
    'reapply',
    'readOnlyApp',
  ]);
});

test('persisted operational lifecycle drift fails every server work capability closed', () => {
  for (const row of [
    { lifecycle_status: 'ACTIVE', efr_status: 0, is_technician_verified: 1 },
    { lifecycle_status: 'UNDER_MASTER', efr_status: 1, is_technician_verified: 0, efr_manager_id: 9 },
    { lifecycle_status: 'ACTIVE', efr_status: null, is_technician_verified: 1 },
  ]) {
    const resolved = lifecycle.lifecycleFromRow(row);
    assert.equal(resolved.jobsAllowed, false);
    assert.equal(resolved.capabilities.receiveNewJobs, false);
    assert.equal(resolved.capabilities.continueAssignedJobs, false);
    assert.equal(resolved.capabilities.mutateAssignedJobs, false);
    assert.equal(resolved.capabilities.markAttendance, false);
  }

  const paused = lifecycle.lifecycleFromRow({
    lifecycle_status: 'PAUSED',
    efr_status: 0,
    is_technician_verified: 1,
  });
  assert.equal(paused.capabilities.receiveNewJobs, false);
  assert.equal(paused.capabilities.mutateAssignedJobs, true);
  assert.equal(paused.capabilities.markAttendance, false);
});

test('legacy efr_status projection changes only for active and operational blocks', () => {
  assert.equal(legacyStatusForTransition('ACTIVE', 0), 1);
  assert.equal(legacyStatusForTransition('PAUSED', 1), 0);
  assert.equal(legacyStatusForTransition('DORMANT', 1), 0);
  assert.equal(legacyStatusForTransition('OFFLINE', 1), 0);
  assert.equal(legacyStatusForTransition('ON_BENCH', 1), 0);
  assert.equal(legacyStatusForTransition('UNDER_VERIFICATION', 1), 1);
  assert.equal(legacyStatusForTransition('REAPPLIED', 0), 0);
  assert.equal(legacyStatusForTransition('REGISTRATION_INCOMPLETE', null), null);
});

test('PAUSED blocks new work but preserves already-assigned job mutations and money claims', () => {
  const caps = lifecycle._internals.capabilitiesForStatus('PAUSED');
  assert.equal(caps.receiveNewJobs, false);
  assert.equal(caps.continueAssignedJobs, true);
  assert.equal(caps.mutateAssignedJobs, true);
  assert.equal(caps.markAttendance, false);
  assert.equal(caps.claimMoney, true);
});

test('terminal restrictions retain money access and expose only documented reapply states', () => {
  const inactive = lifecycle._internals.capabilitiesForStatus('INACTIVE');
  const blacklisted = lifecycle._internals.capabilitiesForStatus('BLACKLISTED');
  assert.equal(inactive.claimMoney, true);
  assert.equal(inactive.reapply, true);
  assert.equal(blacklisted.claimMoney, true);
  assert.equal(blacklisted.reapply, false);
});

test('technician projection hides only internal BLACKLISTED reason fields', () => {
  const blacklisted = lifecycle.forTechnician({
    status: 'BLACKLISTED',
    reasonCode: 'INTERNAL_RCA',
    reason: 'Internal investigation detail',
    capabilities: lifecycle._internals.capabilitiesForStatus('BLACKLISTED'),
  });
  assert.equal(blacklisted.status, 'BLACKLISTED');
  assert.equal(blacklisted.reasonCode, null);
  assert.equal(blacklisted.reason, null);
  assert.equal(blacklisted.capabilities.claimMoney, true);

  const paused = {
    status: 'PAUSED',
    reasonCode: 'GRADE_BELOW_THRESHOLD',
    reason: 'Complete remediation training',
  };
  assert.equal(lifecycle.forTechnician(paused), paused,
    'technician-actionable reasons remain visible without cloning');
});

test('blacklisted technician can load the bounded payout summary', () => {
  assert.doesNotThrow(() => {
    lifecycle._internals.assertReapplicationSummaryAllowed('BLACKLISTED');
  });
});

test('REAPPLIED remains protected from implicit verification derivation', () => {
  assert.equal(protectsVerificationSync('REAPPLIED', undefined), true);
  assert.equal(protectsVerificationSync('REAPPLIED', 'APPLICATION_REJECTED'), false);
  assert.equal(protectsVerificationSync('UNDER_VERIFICATION', undefined), false);
  assert.equal(protectsVerificationSync('BLACKLISTED', 'ACTIVE'), true);
});

test('every different reapplication onboarding outcome resets final verification eligibility', () => {
  for (const target of [
    'NEW',
    'REGISTRATION_INCOMPLETE',
    'TRAINING_PENDING',
    'ASSESSMENT_FAILED',
    'UNDER_VERIFICATION',
    'VERIFICATION_REJECTED',
    'APPLICATION_REJECTED',
  ]) {
    assert.equal(requiresReapplicationVerificationReset('REAPPLIED', target), true);
  }

  assert.equal(requiresReapplicationVerificationReset('REAPPLIED', 'REAPPLIED'), false);
  assert.equal(requiresReapplicationVerificationReset('REAPPLIED', 'ACTIVE'), false);
  assert.equal(requiresReapplicationVerificationReset('UNDER_VERIFICATION', 'TRAINING_PENDING'), false);

  assert.equal(lifecycle.deriveLegacyStatus({
    efr_status: 0,
    is_technician_verified: null,
    user_id: 42,
    lifecycle_personal_submitted: 1,
    lifecycle_aadhaar_present: 1,
    lifecycle_photo_present: 1,
  }), 'UNDER_VERIFICATION');
});

test('approved reapplication stays incomplete until the explicit Gate-1 finalize commit', () => {
  const prefilledButNotConfirmed = gate1FinalizationDecision('REGISTRATION_INCOMPLETE', {
    personal_submitted: 0,
    adhaar_card_number: '123412341234',
    efr_profile_img: 'existing/profile.jpg',
  });
  assert.equal(prefilledButNotConfirmed.complete, false);
  assert.equal(prefilledButNotConfirmed.target, 'REGISTRATION_INCOMPLETE');
  assert.throws(
    () => resolveGate1Finalization('REGISTRATION_INCOMPLETE', {
      personal_submitted: 0,
      adhaar_card_number: '123412341234',
      efr_profile_img: 'existing/profile.jpg',
    }),
    /Gate 1 is incomplete/,
  );

  const explicitlyConfirmed = gate1FinalizationDecision('REGISTRATION_INCOMPLETE', {
    personal_submitted: 1,
    adhaar_card_number: '123412341234',
    efr_profile_img: 'existing/profile.jpg',
  });
  assert.equal(explicitlyConfirmed.complete, true);
  assert.equal(explicitlyConfirmed.target, 'UNDER_VERIFICATION');

  const rejectedResubmission = gate1FinalizationDecision('VERIFICATION_REJECTED', {
    personal_submitted: 1,
    adhaar_card_number: '123412341234',
    efr_profile_img: 'existing/profile.jpg',
  });
  assert.equal(rejectedResubmission.target, 'UNDER_VERIFICATION');
  assert.equal(rejectedResubmission.clearIdentityRejection, true);
  assert.equal(
    resolveGate1Finalization('UNDER_VERIFICATION', {}).idempotent,
    true,
  );
  assert.throws(
    () => resolveGate1Finalization('REAPPLIED', {
      personal_submitted: 1,
      adhaar_card_number: '123412341234',
      efr_profile_img: 'existing/profile.jpg',
    }),
    /cannot be finalized from REAPPLIED/,
  );
});

test('second-pass final activation requires fresh lead and identity approvals', () => {
  assert.throws(
    () => assertFinalActivationEligible({
      user_personal_details_filled: null,
      is_identity_details_verified_by_crm: null,
      efr_profile_perc: 100,
    }),
    /accepted lead, approved identity/,
  );
  assert.throws(
    () => assertFinalActivationEligible({
      user_personal_details_filled: 1,
      is_identity_details_verified_by_crm: null,
      efr_profile_perc: 100,
    }),
    /accepted lead, approved identity/,
  );
  assert.doesNotThrow(() => assertFinalActivationEligible({
    user_personal_details_filled: 1,
    is_identity_details_verified_by_crm: 1,
    efr_profile_perc: 100,
  }));
  assert.doesNotThrow(() => assertTransition(
    { status: 'UNDER_VERIFICATION' },
    'ACTIVE',
    { source: 'SYSTEM' },
  ));
  assert.equal(legacyStatusForTransition('ACTIVE', 0), 1);
});

test('final verification activation rechecks restricted lifecycle under the row lock', () => {
  for (const status of [
    'PAUSED', 'INACTIVE', 'BLACKLISTED', 'DORMANT', 'SUSPENDED', 'OFFLINE', 'ON_BENCH',
  ]) {
    assert.throws(
      () => assertVerificationActivationSourceAllowed({
        lifecycle_status: status,
        efr_status: 0,
        is_technician_verified: 1,
      }),
      new RegExp(`lifecycle is ${status}`),
    );
  }
  assert.doesNotThrow(() => assertVerificationActivationSourceAllowed({
    lifecycle_status: 'UNDER_VERIFICATION',
    efr_status: 0,
    is_technician_verified: null,
  }));
});

test('ACTIVE and UNDER_MASTER always match the locked manager mapping', () => {
  assert.equal(operationalStatusForManager({ efr_manager_id: null }), 'ACTIVE');
  assert.equal(operationalStatusForManager({ efr_manager_id: 81 }), 'UNDER_MASTER');
  assert.doesNotThrow(() => assertManagerStatusInvariant('ACTIVE', { efr_manager_id: 0 }));
  assert.doesNotThrow(() => assertManagerStatusInvariant('UNDER_MASTER', { efr_manager_id: 81 }));
  assert.throws(
    () => assertManagerStatusInvariant('UNDER_MASTER', { efr_manager_id: 0 }),
    /without a manager mapping/,
  );
  assert.throws(
    () => assertManagerStatusInvariant('ACTIVE', { efr_manager_id: 81 }),
    /must use UNDER_MASTER/,
  );
});

test('lifecycle history exposes the immutable scheduled-until date from metadata', () => {
  const item = historyItemFromRow({
    lifecycle_log_id: 11,
    from_status: 'ACTIVE',
    to_status: 'SUSPENDED',
    reason_code: 'TEMPORARY_SUSPENSION',
    reason: 'Leave',
    source: 'CRM',
    actor_user_id: 7,
    // NOT a bomb: this `until` is metadata carried through for DISPLAY and
    // asserted against itself below. Nothing compares it to today, so a fixed
    // literal is correct here — a derived value would assert nothing.
    metadata: JSON.stringify({ until: '2026-09-30', actorName: 'Ops' }),
    status_version: 3,
    created_at: '2026-08-10 12:00:00',
  });
  assert.equal(item.until, '2026-09-30');
  assert.equal(item.metadata.until, '2026-09-30');
});

test('lifecycle-owned push skips a redundant registration gate read', () => {
  const { shouldDeriveStatus } = registrationPush._internals;
  assert.equal(shouldDeriveStatus({}), true);
  assert.equal(shouldDeriveStatus({ status: 'active' }), false);
  assert.equal(shouldDeriveStatus({ lifecycleStatus: 'PAUSED' }), false);
});

test('restricting lifecycle expiry closes all open offers in one set-based write', async () => {
  let captured = null;
  const conn = {
    query: async (sql, params) => {
      captured = { sql, params };
      return [{ affectedRows: 3 }];
    },
  };

  const expired = await expireOpenOffersForRestrictedLifecycle(conn, 77);

  assert.equal(expired, 3);
  assert.match(captured.sql, /UPDATE tbl_job_offer/i);
  assert.match(captured.sql, /WHERE fk_easyfixter_id = \?/i);
  assert.match(captured.sql, /AND offer_status = \?/i);
  assert.doesNotMatch(captured.sql, /updated_on/i, 'works with the base offer-table schema');
  assert.deepEqual(captured.params, [3, 77, 0]);
});

test('offer expiry remains compatible before the offer table is installed', async () => {
  const missingTable = new Error('table missing');
  missingTable.code = 'ER_NO_SUCH_TABLE';
  const conn = { query: async () => { throw missingTable; } };
  assert.equal(await expireOpenOffersForRestrictedLifecycle(conn, 77), 0);
});

test('a same-status restricted transition repairs stale offers without a new lifecycle log', async () => {
  const { pool } = require('../db');
  const originalPoolQuery = pool.query;
  const originalGetConnection = pool.getConnection;
  const calls = [];
  let committed = false;

  try {
    lifecycle._internals.resetSchemaProbeForTests();
    pool.query = async (sql, params = []) => {
      assert.match(sql, /information_schema\.columns/i);
      return [[{ column_count: params.length, history_count: 1 }]];
    };
    assert.equal(await lifecycle.hasLifecycleSchema({ force: true }), true);

    pool.getConnection = async () => ({
      async beginTransaction() { calls.push('begin'); },
      async query(sql, params) {
        calls.push({ sql, params });
        if (/SELECT e\.efr_id/i.test(sql)) {
          return [[{
            efr_id: 77,
            efr_status: 0,
            is_technician_verified: 1,
            efr_manager_id: 0,
            lifecycle_status: 'PAUSED',
            lifecycle_reason_code: 'MANUAL_PAUSE',
            lifecycle_reason: 'Planned leave',
            lifecycle_changed_at: '2026-08-10 10:00:00',
            // The scheduled "until" is single-sourced from
            // scheduled_reactivation_date now (no lifecycle_until column).
            // Far-future sentinel, matching the `until` sent below. It must be a
            // DATE THAT NEVER ARRIVES: assertTransition rejects a PAUSED `until`
            // that is <= today in IST, so a plausible near-date here is a time
            // bomb — this pair was '2026-08-20' and began failing, and blocking
            // every deploy, at midnight on 2026-08-20. The assertions below never
            // read the date; it only has to be valid and match the fixture.
            scheduled_reactivation_date: FUTURE_UNTIL,
            lifecycle_version: 4,
            lifecycle_source: 'CRM',
          }]];
        }
        if (/FROM tbl_easyfixer_lifecycle_status_log/i.test(sql)) {
          // Audit-log-derived pause / re-application counters, read under the
          // row lock the transition already holds.
          return [[{ pause_count: 1, reapplication_count: 0 }]];
        }
        if (/UPDATE tbl_job_offer/i.test(sql)) return [{ affectedRows: 2 }];
        throw new Error(`unexpected same-status query: ${sql}`);
      },
      async commit() { committed = true; calls.push('commit'); },
      async rollback() { calls.push('rollback'); },
      release() { calls.push('release'); },
    });

    const result = await lifecycle.transition(77, {
      status: 'PAUSED',
      reasonCode: 'MANUAL_PAUSE',
      reason: 'Planned leave',
      until: FUTURE_UNTIL,   // must equal the fixture above; both derived
      expectedVersion: 4,
      source: 'CRM',
    }, { user_id: 9 });

    assert.equal(result.changed, false);
    assert.equal(result.expiredOpenOffers, 2);
    assert.equal(committed, true);
    assert.equal(calls.filter((entry) => (
      typeof entry === 'object' && /UPDATE tbl_job_offer/i.test(entry.sql)
    )).length, 1);
    assert.equal(calls.some((entry) => (
      typeof entry === 'object' && /INSERT INTO tbl_easyfixer_lifecycle_status_log/i.test(entry.sql)
    )), false);
  } finally {
    pool.query = originalPoolQuery;
    pool.getConnection = originalGetConnection;
    lifecycle._internals.resetSchemaProbeForTests();
  }
});

test('negative-wallet management email is queued only for an actual cron transition', () => {
  const actual = managementAlertForTransition({
    changed: true,
    transitionedFrom: 'ACTIVE',
    lifecycle: {
      status: 'DORMANT',
      reasonCode: 'WALLET_BELOW_ZERO',
      reason: 'Wallet balance is below zero (-125.50)',
    },
  }, {
    source: 'CRON',
    metadata: { walletBalance: -125.5 },
  });
  assert.deepEqual(actual, {
    kind: 'negative-wallet',
    lifecycleStatus: 'DORMANT',
    reason: 'Wallet balance is below zero (-125.50)',
    amount: -125.5,
  });
  const message = managementAlertMessage({
    efr_id: 77,
    efr_name: 'Technician',
    current_balance: -125.5,
  }, actual);
  assert.deepEqual(message.to, ['management@easyfix.in', 'supply@easyfix.in']);
  assert.match(message.subject, /Negative wallet/);
  assert.match(message.text, /Wallet balance: -125\.5/);
  assert.match(message.text, /Reason: Wallet balance is below zero \(-125\.50\)/);

  assert.equal(managementAlertForTransition({
    changed: false,
    transitionedFrom: 'DORMANT',
    lifecycle: {
      status: 'DORMANT',
      reasonCode: 'WALLET_BELOW_ZERO',
      reason: 'unchanged',
    },
  }, { source: 'CRON', metadata: { walletBalance: -125.5 } }), null);
  assert.equal(managementAlertForTransition({
    changed: true,
    transitionedFrom: 'ACTIVE',
    lifecycle: { status: 'DORMANT', reasonCode: 'NO_ATTENDANCE_OR_JOB_ACTIVITY' },
  }, { source: 'CRON' }), null);
});

test('cron policy cannot set INACTIVE or BLACKLISTED', () => {
  const current = { status: 'ACTIVE' };
  assert.throws(
    () => assertTransition(current, 'INACTIVE', {
      source: 'CRON', reason: 'not allowed',
    }),
    /not allowed|cannot set/,
  );
  assert.throws(
    () => assertTransition(current, 'BLACKLISTED', {
      source: 'CRON', reason: 'not allowed',
    }),
    /not allowed|cannot set/,
  );
  assert.doesNotThrow(() => assertTransition(current, 'PAUSED', {
    source: 'CRON', reason: 'Grade D',
  }));
  assert.doesNotThrow(() => assertTransition({ status: 'SUSPENDED' }, 'UNDER_MASTER', {
    source: 'CRON', reason: 'Scheduled suspension completed',
  }));
});

test('BLACKLISTED is fully reversible from CRM (admin decision) and SUSPENDED requires a future date', () => {
  // Blacklist is a pure admin decision, so an admin can fully reverse it — to any
  // operational status, including straight to ACTIVE. (INACTIVE/DORMANT differ:
  // they must reapply — covered by 'server transition graph enforces reapplication'.)
  assert.doesNotThrow(
    () => assertTransition({ status: 'BLACKLISTED' }, 'INACTIVE', {
      source: 'CRM', reason: 'Reversing blacklist after review',
    }),
  );
  assert.doesNotThrow(
    () => assertTransition({ status: 'BLACKLISTED' }, 'ACTIVE', {
      source: 'CRM', reason: 'Reactivate after review',
    }),
  );
  assert.throws(
    () => assertTransition({ status: 'ACTIVE' }, 'SUSPENDED', {
      source: 'CRM', reason: 'Temporary hold',
    }),
    /future until date/,
  );
  assert.doesNotThrow(() => assertTransition({ status: 'ACTIVE' }, 'SUSPENDED', {
    source: 'CRM', reason: 'Temporary hold', until: FUTURE_UNTIL,
  }));
});

test('technician re-application is allowed only from documented states', () => {
  for (const status of ['INACTIVE', 'DORMANT', 'APPLICATION_REJECTED', 'REAPPLIED']) {
    assert.doesNotThrow(() => assertTransition({ status }, 'REAPPLIED', {
      source: 'APP', reason: 'Please review',
    }));
  }
  assert.throws(
    () => assertTransition({ status: 'ACTIVE' }, 'REAPPLIED', {
      source: 'APP', reason: 'Please review',
    }),
    /not allowed|cannot move/,
  );
});

test('operational technicians cannot be pushed into onboarding states', () => {
  assert.throws(
    () => assertTransition({ status: 'ACTIVE' }, 'APPLICATION_REJECTED', {
      source: 'CRM', reason: 'Invalid path',
    }),
    /cannot move an operational technician/,
  );
});

test('CRM cannot activate onboarding rows outside verification approval', () => {
  assert.throws(
    () => assertTransition({ status: 'UNDER_VERIFICATION' }, 'ACTIVE', { source: 'CRM' }),
    /verification approval flow/,
  );
  assert.doesNotThrow(
    () => assertTransition({ status: 'UNDER_VERIFICATION' }, 'ACTIVE', { source: 'SYSTEM' }),
  );
  assert.equal(
    lifecycle._internals.allowedCrmTransitions('REAPPLIED', true).includes('ACTIVE'),
    false,
  );
});

test('server transition graph enforces reapplication before second verification', () => {
  for (const currentStatus of ['INACTIVE', 'DORMANT']) {
    assert.throws(
      () => assertTransition({ status: currentStatus }, 'ACTIVE', { source: 'CRM' }),
      /must reapply/,
    );
    assert.throws(
      () => assertTransition(
        { status: currentStatus },
        'REGISTRATION_INCOMPLETE',
        { source: 'CRM' },
      ),
      /must reapply/,
    );
  }
  assert.throws(
    () => assertTransition({ status: 'INACTIVE' }, 'REAPPLIED', { source: 'CRM' }),
    /only be requested by the technician app/,
  );
  assert.throws(
    () => assertTransition({ status: 'REAPPLIED' }, 'UNDER_VERIFICATION', { source: 'CRM' }),
    /CRM admission to REGISTRATION_INCOMPLETE/,
  );
  assert.throws(
    () => assertTransition({ status: 'REAPPLIED' }, 'ACTIVE', { source: 'SYSTEM' }),
    /CRM admission to REGISTRATION_INCOMPLETE/,
  );
  assert.doesNotThrow(() => assertTransition(
    { status: 'REAPPLIED' },
    'REGISTRATION_INCOMPLETE',
    { source: 'CRM' },
  ));
  assert.doesNotThrow(() => assertTransition(
    { status: 'REAPPLIED' },
    'APPLICATION_REJECTED',
    { source: 'CRM', reason: 'Second application rejected' },
  ));
  assert.doesNotThrow(() => assertTransition(
    { status: 'REGISTRATION_INCOMPLETE' },
    'ACTIVE',
    { source: 'SYSTEM' },
  ));
  assert.doesNotThrow(() => assertTransition(
    { status: 'PAUSED' },
    'ACTIVE',
    { source: 'CRM' },
  ));
  assert.doesNotThrow(() => assertTransition(
    { status: 'SUSPENDED' },
    'ACTIVE',
    { source: 'CRM' },
  ));
  for (const currentStatus of ['PAUSED', 'SUSPENDED']) {
    assert.throws(
      () => assertTransition(
        { status: currentStatus },
        'REGISTRATION_INCOMPLETE',
        { source: 'CRM' },
      ),
      /cannot move an operational technician/,
    );
  }
});

function emptySignals() {
  return {
    attendance: new Map(),
    jobs: new Map(),
    grades: new Map(),
    escalations: new Map(),
    margins: new Map(),
    noShows: new Map(),
  };
}

const CFG = {
  dormantDays: 90,
  gradeMaxAgeDays: 7,
  escalationWindowDays: 90,
  marginWindowDays: 30,
  marginMinJobs: 3,
  marginThreshold: 15,
  noShowEnabled: false,
  noShowWindowDays: null,
  noShowThreshold: 5,
  noShowMinRecords: 10,
};

test('lifecycle evaluator prioritises negative wallet and records the amount', () => {
  const decision = decide({
    efr_id: 7,
    current_balance: -12.5,
    insert_date: '2026-08-01 00:00:00',
  }, emptySignals(), CFG, Date.parse('2026-08-10T00:00:00Z'));
  assert.equal(decision.status, 'DORMANT');
  assert.equal(decision.reasonCode, 'WALLET_BELOW_ZERO');
  assert.equal(decision.metadata.walletBalance, -12.5);
});

test('lifecycle evaluator applies 90-day inactivity and D/E grade rules', () => {
  const now = Date.parse('2026-08-10T00:00:00Z');
  const dormant = decide({
    efr_id: 8,
    current_balance: 0,
    insert_date: '2026-01-01 00:00:00',
  }, emptySignals(), CFG, now);
  assert.equal(dormant.reasonCode, 'NO_ATTENDANCE_OR_JOB_ACTIVITY');

  const signals = emptySignals();
  signals.grades.set(9, {
    efr_id: 9,
    grade: 'D',
    computed_at: '2026-08-08 00:00:00',
  });
  const paused = decide({
    efr_id: 9,
    current_balance: 0,
    insert_date: '2026-08-01 00:00:00',
  }, signals, CFG, now);
  assert.equal(paused.reasonCode, 'LOW_PERFORMANCE_GRADE');
});

test('stale D grade snapshot cannot automatically pause a technician', () => {
  const signals = emptySignals();
  signals.grades.set(11, {
    efr_id: 11,
    grade: 'D',
    computed_at: '2026-06-01 00:00:00',
  });
  const result = decide({
    efr_id: 11,
    current_balance: 0,
    insert_date: '2026-08-01 00:00:00',
  }, signals, CFG, Date.parse('2026-08-10T00:00:00Z'));
  assert.equal(result, null);
});

test('no-show rule is inert unless exact denominator/window configuration enables it', () => {
  const signals = emptySignals();
  signals.noShows.set(10, { efr_id: 10, denominator: 100, no_shows: 100 });
  const result = decide({
    efr_id: 10,
    current_balance: 0,
    insert_date: '2026-08-01 00:00:00',
  }, signals, CFG, Date.parse('2026-08-10T00:00:00Z'));
  assert.equal(result, null);
});

test('dateMs accepts mysql2 Date objects and IST date strings', () => {
  const date = new Date('2026-08-01T00:00:00Z');
  assert.equal(dateMs(date), date.getTime());
  assert.equal(
    dateMs('2026-08-01 05:30:00'),
    Date.parse('2026-08-01T05:30:00+05:30'),
  );
});

test('lifecycle evaluator drains multiple cursor-ordered batches in one run', async () => {
  const queue = Array.from({ length: 250 }, (_, index) => ({ efr_id: index + 1 }));
  const result = await drainBatches({
    batchSize: 100,
    maxBatches: 5,
    maxRuntimeMs: 60000,
    loadBatch: async (limit) => queue.splice(0, limit),
    processBatch: async (rows) => ({
      evaluated: rows.length,
      transitioned: 0,
      paused: 0,
      dormant: 0,
      failed: 0,
    }),
    loadRemaining: async () => queue.length,
  });
  assert.equal(result.batches, 3);
  assert.equal(result.processed, 250);
  assert.equal(result.remaining, 0);
  assert.equal(result.drained, true);
  assert.equal(result.stopReason, 'drained');
});

test('lifecycle evaluator reports backlog when the configured batch cap is reached', async () => {
  const queue = Array.from({ length: 250 }, (_, index) => ({ efr_id: index + 1 }));
  const result = await drainBatches({
    batchSize: 100,
    maxBatches: 2,
    maxRuntimeMs: 60000,
    loadBatch: async (limit) => queue.splice(0, limit),
    processBatch: async (rows) => ({ evaluated: rows.length }),
    loadRemaining: async () => queue.length,
  });
  assert.equal(result.batches, 2);
  assert.equal(result.processed, 200);
  assert.equal(result.remaining, 50);
  assert.equal(result.backlog, true);
  assert.equal(result.stopReason, 'max_batches');
});


/*
 * ── INACTIVE MUST NOT STRAND WORK IN HAND ───────────────────────────────────
 *
 * INACTIVE stops NEW jobs; it must not hide or block jobs the technician is
 * already on. The overlay takes an injected executor, so these characterize the
 * real decision without a pool and without a DB.
 */
function fakeExecutor(rows, { fail = false } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      if (fail) throw new Error('ER_LOCK_WAIT_TIMEOUT: lock wait timeout exceeded');
      return [rows, []];
    },
  };
}

function snapshotFor(status) {
  return { status, capabilities: lifecycle.capabilitiesForStatus(status) };
}

test('INACTIVE with open jobs keeps assigned work but never receives new jobs', async () => {
  const db = fakeExecutor([{ open_jobs: 3 }]);
  const out = await overlayOpenJobCapabilities(snapshotFor('INACTIVE'), 77, db);

  assert.equal(out.status, 'INACTIVE', 'the lifecycle STATUS is unchanged');
  assert.equal(out.capabilities.continueAssignedJobs, true);
  assert.equal(out.capabilities.mutateAssignedJobs, true);
  assert.equal(out.capabilities.markAttendance, true);
  assert.equal(out.capabilities.receiveNewJobs, false, 'INACTIVE still blocks NEW work');
  assert.equal(out.capabilities.readOnlyApp, false, 'mutations are allowed, so not read-only');
  assert.equal(out.openJobs, 3);

  assert.equal(db.calls.length, 1, 'exactly one bounded COUNT');
  const [{ sql, params }] = db.calls;
  assert.match(sql, /COUNT\(\*\) AS open_jobs/);
  assert.match(sql, /fk_easyfixter_id = \?/, 'scoped to this technician');
  assert.doesNotMatch(sql, /NOT IN/, 'positive IN list — no NULL-swallows-every-row trap');
  // ASSERTION UPDATED (2026-08-21, deliberately): the set used to be the
  // dashboard counter's (1, 2, 20) and stranded a technician whose only work
  // sat in 15 / 21 / 10. "Work in hand" is now derived from the job status
  // model — see the OPEN_JOB_STATUSES comment in the service.
  assert.deepEqual([...OPEN_JOB_STATUSES], [1, 2, 10, 15, 20, 21]);
  assert.deepEqual(params, [77, 1, 2, 10, 15, 20, 21]);
});

/*
 * fakeExecutor() above returns a CANNED count, so it can never notice a status
 * missing from the query. This one is honest about the SQL: it evaluates the
 * status list the query actually binds against a single fixture job, exactly
 * as `job_status IN (…)` would. A status that is not in OPEN_JOB_STATUSES
 * therefore counts as ZERO — which IS the stranding bug.
 */
function jobAtStatus(jobStatus) {
  return {
    query: async (sql, params) => {
      const [, ...statuses] = params.map(Number);
      return [[{ open_jobs: statuses.includes(Number(jobStatus)) ? 1 : 0 }], []];
    },
  };
}

test('work still in hand counts as open — estimate-pending (15), on-hold (21), revisit (10)', async () => {
  for (const [jobStatus, what] of [
    [15, 'estimate sent by the technician, awaiting the SPOC decision'],
    [21, 'fulfilment hold placed by Ops, fk_easyfixter_id untouched'],
    [10, 'revisit owed / where a hold release lands'],
  ]) {
    const out = await overlayOpenJobCapabilities(snapshotFor('INACTIVE'), 77, jobAtStatus(jobStatus));
    assert.equal(out.openJobs, 1, `job_status ${jobStatus} (${what}) must count as work in hand`);
    assert.equal(out.capabilities.continueAssignedJobs, true, `job_status ${jobStatus}`);
    assert.equal(out.capabilities.mutateAssignedJobs, true, `job_status ${jobStatus}`);
    assert.equal(out.capabilities.markAttendance, true, `job_status ${jobStatus}`);
    assert.equal(out.capabilities.readOnlyApp, false, `job_status ${jobStatus}`);
    assert.equal(out.capabilities.receiveNewJobs, false, 'NEW work stays blocked regardless');
  }
});

test('regression: hold (21) → release (10) never strands the deactivated technician', async () => {
  // Ops holds the technician's only job (routes/admin/jobs.js PUT /jobs/:id/hold
  // → job_status 21, tech unchanged); the technician is then deactivated.
  const held = await overlayOpenJobCapabilities(snapshotFor('INACTIVE'), 77, jobAtStatus(21));
  assert.equal(held.capabilities.mutateAssignedJobs, true, 'the job is still theirs to finish');

  // The hold is released (POST /jobs/:id/hold/release → job_status 10). The
  // capability must SURVIVE the release, not disappear into a second dead state.
  const released = await overlayOpenJobCapabilities(snapshotFor('INACTIVE'), 77, jobAtStatus(10));
  assert.equal(released.capabilities.mutateAssignedJobs, true, 'released back to a revisit still owed');
  assert.equal(released.capabilities.markAttendance, true);
});

test('terminal and pre-assignment job statuses are still NOT work in hand', async () => {
  // The set must not drift into "any row with my id on it". 3/5 completed,
  // 6 cancelled and 7 enquiry are terminal; 0 is an open OFFER (expired by the
  // restricting transition); 9 is unconfirmed, pre-assignment.
  for (const jobStatus of [0, 3, 5, 6, 7, 9]) {
    const out = await overlayOpenJobCapabilities(snapshotFor('INACTIVE'), 77, jobAtStatus(jobStatus));
    assert.equal(out.openJobs, undefined, `job_status ${jobStatus} must grant nothing`);
    assert.equal(out.capabilities.continueAssignedJobs, false, `job_status ${jobStatus}`);
    assert.equal(out.capabilities.mutateAssignedJobs, false, `job_status ${jobStatus}`);
    assert.equal(out.capabilities.markAttendance, false, `job_status ${jobStatus}`);
  }
});

test('INACTIVE with zero open jobs falls back to the locked inactive screen', async () => {
  const db = fakeExecutor([{ open_jobs: 0 }]);
  const out = await overlayOpenJobCapabilities(snapshotFor('INACTIVE'), 77, db);

  assert.equal(out.capabilities.continueAssignedJobs, false);
  assert.equal(out.capabilities.mutateAssignedJobs, false);
  assert.equal(out.capabilities.markAttendance, false);
  assert.equal(out.capabilities.receiveNewJobs, false);
  assert.equal(out.openJobs, undefined, 'nothing granted, nothing reported');
});

test('BLACKLISTED stays terminal even with open jobs, and costs no query', async () => {
  const db = fakeExecutor([{ open_jobs: 9 }]);
  const out = await overlayOpenJobCapabilities(snapshotFor('BLACKLISTED'), 77, db);

  assert.equal(db.calls.length, 0, 'only INACTIVE may pay for the COUNT');
  assert.equal(out.capabilities.continueAssignedJobs, false);
  assert.equal(out.capabilities.mutateAssignedJobs, false);
  assert.equal(out.capabilities.markAttendance, false);
  assert.equal(out.capabilities.receiveNewJobs, false);
});

test('a failed open-job count fails CLOSED — it may never grant capabilities', async () => {
  const db = fakeExecutor([], { fail: true });
  const out = await overlayOpenJobCapabilities(snapshotFor('INACTIVE'), 77, db);

  assert.equal(out.capabilities.continueAssignedJobs, false);
  assert.equal(out.capabilities.mutateAssignedJobs, false);
  assert.equal(out.capabilities.markAttendance, false);
  assert.equal(out.capabilities.receiveNewJobs, false);
  assert.equal(out.openJobs, undefined);
});

test('no other lifecycle status is re-interpreted, and none pays for the query', async () => {
  for (const status of ['ACTIVE', 'PAUSED', 'DORMANT', 'SUSPENDED', 'OFFLINE', 'ON_BENCH', 'NEW']) {
    const db = fakeExecutor([{ open_jobs: 4 }]);
    const before = snapshotFor(status);
    const after = await overlayOpenJobCapabilities(before, 77, db);
    assert.equal(db.calls.length, 0, `${status} must skip the count query entirely`);
    assert.equal(after, before, `${status} must be returned untouched`);
  }
});

/*
 * ⚠ FINALIZE IS A DURABLE OUTBOX MUTATION, SO A PERMANENT ERROR IS A DEAD LETTER.
 *
 * The app queues POST /registration/finalize behind every profile-card save
 * (orderingKey "registration.profile"). An ACTIVE technician editing their
 * identity therefore committed the save and then had the queued finalize
 * rejected with 409 — which a retry can never clear, so the item dead-lettered
 * and the technician was told "Couldn't save your identity" about data that was
 * already written. Convergence on something already converged is success.
 */
test('gate-1 finalization is an idempotent no-op for every status past registration', () => {
  const { resolveGate1Finalization } = lifecycle._internals;
  const complete = {
    personal_submitted: 1,
    adhaar_card_number: '123456789012',
    efr_profile_img: 'photo.jpg',
  };

  for (const status of [
    'ACTIVE', 'UNDER_VERIFICATION', 'TRAINING_PENDING', 'UNDER_MASTER',
    'PAUSED', 'INACTIVE', 'BLACKLISTED', 'SUSPENDED', 'DORMANT',
    'OFFLINE', 'ON_BENCH',
  ]) {
    const decision = resolveGate1Finalization(status, complete, false);
    assert.equal(decision.idempotent, true, `${status} must not throw`);
    // target === current is what _protectLifecycle turns into "do not
    // transition" — the no-op must never move anyone's lifecycle.
    assert.equal(decision.target, status, `${status} must not be transitioned`);
    assert.equal(decision.clearIdentityRejection, false);
  }
});

test('gate-1 finalization still advances a technician who IS in registration', () => {
  const { resolveGate1Finalization } = lifecycle._internals;
  const complete = {
    personal_submitted: 1,
    adhaar_card_number: '123456789012',
    efr_profile_img: 'photo.jpg',
  };

  // The real path is untouched: a complete Gate 1 still converges.
  for (const status of ['NEW', 'REGISTRATION_INCOMPLETE', 'VERIFICATION_REJECTED']) {
    assert.equal(resolveGate1Finalization(status, complete, false).target, 'UNDER_VERIFICATION');
  }
  // Outstanding training still diverts to TRAINING_PENDING rather than skipping it.
  assert.equal(resolveGate1Finalization('NEW', complete, true).target, 'TRAINING_PENDING');
  // An INCOMPLETE gate still THROWS (REGISTRATION_GATE1_INCOMPLETE) rather than
  // silently converging — that guard is untouched.
  assert.throws(
    () => resolveGate1Finalization('NEW', { personal_submitted: 1 }, false),
    /Gate 1 is incomplete/,
  );
  // And a REAPPLIED technician must STILL be refused: they owe the
  // reapplication path, so a no-op here would strand them.
  assert.throws(
    () => resolveGate1Finalization('REAPPLIED', complete, false),
    /cannot be finalized from REAPPLIED/,
  );
});
