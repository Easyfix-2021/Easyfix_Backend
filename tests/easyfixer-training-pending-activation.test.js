const test = require('node:test');
const { after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

/*
 * NO ACTIVATION OUT OF TRAINING_PENDING UNTIL MANDATORY TRAINING IS DONE.
 *
 * The rule lives in transition() — the only writer of lifecycle_status — and is
 * keyed on the STORED status, so it is exercised here through the real
 * transaction with a fake connection. "Complete" is the app's definition,
 * mobile-registration.fetchTrainingCompletedTime, stubbed per test.
 *
 * Legacy technicians (never TRAINING_PENDING) have no mandatory-training rows at
 * all; they must activate exactly as before and never pay for the lookup.
 */

const { pool } = require('../db');
const lifecycle = require('../services/easyfixer-lifecycle.service');
const registration = require('../services/mobile-registration.service');
const registrationPush = require('../services/registration-status-push.service');

const original = {
  query: pool.query,
  getConnection: pool.getConnection,
  fetchTrainingCompletedTime: registration.fetchTrainingCompletedTime,
  notify: registrationPush.notifyRegistrationStatusChanged,
};

let row;
let trainingDone;
let trainingLookups;
let calls;

function baseRow(overrides = {}) {
  return {
    efr_id: 77,
    efr_status: 0,
    is_technician_verified: null,
    efr_manager_id: 0,
    user_id: 5,
    adhaar_card_number: '123412341234',
    efr_profile_img: 'k',
    is_identity_details_verified_by_crm: 1,
    efr_profile_perc: 100,
    user_personal_details_filled: 1,
    user_is_personal_detail_filled: 1,
    lifecycle_status: 'TRAINING_PENDING',
    lifecycle_version: 3,
    lifecycle_source: 'SYSTEM',
    lifecycle_changed_at: '2026-09-20 10:00:00',
    ...overrides,
  };
}

beforeEach(() => {
  row = baseRow();
  trainingDone = null;
  trainingLookups = 0;
  calls = [];
  lifecycle._internals.resetSchemaProbeForTests();
  pool.query = async (sql, params = []) => {
    if (/information_schema\.columns/i.test(sql) && /tbl_easyfixer_lifecycle_status_log/i.test(sql)) {
      return [[{ column_count: params.length, history_count: 1 }]];
    }
    return [[]];
  };
  pool.getConnection = async () => ({
    async beginTransaction() { calls.push('begin'); },
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT e\.efr_id/i.test(sql)) return [[{ ...row }]];
      if (/FROM tbl_easyfixer_lifecycle_status_log/i.test(sql)) {
        return [[{ pause_count: 0, reapplication_count: 0 }]];
      }
      if (/^\s*(UPDATE|INSERT)/i.test(sql)) return [{ affectedRows: 1 }];
      throw new Error(`unexpected query: ${sql}`);
    },
    async commit() { calls.push('commit'); },
    async rollback() { calls.push('rollback'); },
    release() {},
  });
  registration.fetchTrainingCompletedTime = async () => {
    trainingLookups += 1;
    return trainingDone;
  };
  registrationPush.notifyRegistrationStatusChanged = async () => ({ delivered: false });
});

after(() => {
  pool.query = original.query;
  pool.getConnection = original.getConnection;
  registration.fetchTrainingCompletedTime = original.fetchTrainingCompletedTime;
  registrationPush.notifyRegistrationStatusChanged = original.notify;
  lifecycle._internals.resetSchemaProbeForTests();
});

const lifecycleWrites = () => calls.filter((c) => (
  typeof c === 'object' && /UPDATE tbl_easyfixer SET .*lifecycle_status = \?/is.test(c.sql)
));
const activate = () => lifecycle.activateFromVerification(77, { final_accept_comment: 'ok' }, { user_id: 9 });

test('TRAINING_PENDING with mandatory training incomplete is refused activation (409)', async () => {
  trainingDone = null;
  await assert.rejects(activate, (e) => (
    e.status === 409
    && e.code === 'MANDATORY_TRAINING_INCOMPLETE'
    && /Mandatory training is not complete yet/.test(e.message)
  ));
  assert.equal(trainingLookups, 1);
  assert.equal(lifecycleWrites().length, 0, 'no lifecycle write on refusal');
  assert.equal(calls.some((c) => typeof c === 'object' && /is_technician_verified = 1/.test(c.sql)), false,
    'the verification flags are not written either');
  assert.ok(calls.includes('rollback'));
  assert.equal(calls.includes('commit'), false);
});

test('TRAINING_PENDING with mandatory training complete activates', async () => {
  trainingDone = '2026-09-25 12:00:00';
  const result = await activate();
  assert.equal(result.changed, true);
  assert.equal(result.lifecycle.status, 'ACTIVE');
  assert.equal(result.transitionedFrom, 'TRAINING_PENDING');
  assert.equal(trainingLookups, 1);
  assert.equal(lifecycleWrites().length, 1);
  assert.ok(calls.includes('commit'));
});

test('a legacy-bit flip does not hide TRAINING_PENDING: the stored status decides', async () => {
  // Verified + efr_status 1 reads back as ACTIVE, but the column still says
  // TRAINING_PENDING and the training is not done.
  row = baseRow({ is_technician_verified: 1, efr_status: 1 });
  await assert.rejects(activate, { status: 409, code: 'MANDATORY_TRAINING_INCOMPLETE' });
  assert.equal(lifecycleWrites().length, 0);
});

test('technicians NOT in TRAINING_PENDING activate exactly as before, with no training lookup', async () => {
  // No mandatory-training rows at all — what every legacy technician looks like.
  trainingDone = null;
  for (const status of ['UNDER_VERIFICATION', null]) {
    row = baseRow({ lifecycle_status: status });
    calls = [];
    const result = await activate();
    assert.equal(result.changed, true, String(status));
    assert.equal(result.lifecycle.status, 'ACTIVE', String(status));
    assert.equal(lifecycleWrites().length, 1, String(status));
  }
  assert.equal(trainingLookups, 0, 'the rule never runs outside TRAINING_PENDING');
});

test('the automatic post-training exit still advances TRAINING_PENDING -> UNDER_VERIFICATION', async () => {
  // finalizeTrainingCompletion moves unconditionally — its CALLER
  // (lms.settleTrainingCompletion) decides on the mandatory definition. It is
  // not an activation, so the activation rule must not intercept it.
  trainingDone = null;
  const result = await lifecycle.finalizeTrainingCompletion(77);
  assert.equal(result.changed, true);
  assert.equal(result.lifecycle.status, 'UNDER_VERIFICATION');
  assert.equal(result.transitionedFrom, 'TRAINING_PENDING');
  assert.equal(trainingLookups, 0);
  assert.equal(lifecycleWrites().length, 1);
});

/*
 * Gate 1 decides entry into TRAINING_PENDING on the SAME definition (owner,
 * 2026-09-28). It used lms.isTrainingComplete (ASSIGNED courses): with no
 * mandatory course assigned a registrant skipped TRAINING_PENDING, and the
 * activation rule above never got to run.
 */
test('Gate 1: mandatory training outstanding → TRAINING_PENDING, even with no course assigned', async () => {
  const lms = require('../services/lms.service');
  const saved = { assign: lms.assignMandatoryCourses, complete: lms.isTrainingComplete };
  lms.assignMandatoryCourses = async () => ({ assigned: 0 });
  lms.isTrainingComplete = async () => { throw new Error('Gate 1 must not ask the assigned-courses question'); };
  try {
    for (const [done, expected] of [[null, 'TRAINING_PENDING'], ['2026-09-25 12:00:00', 'UNDER_VERIFICATION']]) {
      row = baseRow({ lifecycle_status: 'REGISTRATION_INCOMPLETE' });
      calls = [];
      trainingDone = done;
      const result = await lifecycle.finalizeMobileRegistrationGate1(77);
      assert.equal(result.lifecycle.status, expected, `completedAt=${done}`);
    }
  } finally {
    lms.assignMandatoryCourses = saved.assign;
    lms.isTrainingComplete = saved.complete;
  }
});

/*
 * The mandatory-course INSERT must run BEFORE transition() takes the
 * technician's row lock (QA 2026-09-30, efrId 10798). easyfixer_courses has a
 * foreign key to tbl_easyfixer, and the INSERT runs on the pool, not on the
 * locking connection — inside the lock it waited on that very row until
 * innodb_lock_wait_timeout (50 s), and every identity save that finalized
 * Gate 1 reported failure to the app.
 */
test('Gate 1: mandatory courses are assigned before the row lock, never inside it', async () => {
  const lms = require('../services/lms.service');
  const saved = lms.assignMandatoryCourses;
  const order = [];
  lms.assignMandatoryCourses = async () => {
    order.push(calls.some((c) => c === 'begin') ? 'assign-inside-lock' : 'assign-before-lock');
    return { assigned: 1 };
  };
  try {
    row = baseRow({ lifecycle_status: 'REGISTRATION_INCOMPLETE' });
    calls = [];
    await lifecycle.finalizeMobileRegistrationGate1(77);
    assert.deepEqual(order, ['assign-before-lock']);
    assert.ok(calls.includes('begin'), 'positive control: the transition did open its transaction');
  } finally {
    lms.assignMandatoryCourses = saved;
  }
});
