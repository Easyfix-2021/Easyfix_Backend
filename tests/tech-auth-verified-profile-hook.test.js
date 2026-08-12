const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const OTP_VERIFY = /SELECT id, otp, valid_up_to, is_expired FROM otp_details/i;
const OTP_CONSUME = /UPDATE otp_details SET is_expired = 1[\s\S]*WHERE id = \?/i;
const GET_LOCK = /GET_LOCK/i;
const RELEASE_LOCK = /RELEASE_LOCK/i;
const EFR_BY_NO = /FROM tbl_easyfixer\s+WHERE efr_no = \?/i;
const EFR_BY_USER = /JOIN tbl_user u ON u\.user_id = e\.user_id/i;
const TECH = {
  efr_id: 11179,
  efr_name: 'Technician',
  efr_no: '9013877370',
  efr_email: null,
  efr_status: 1,
  is_technician_verified: 1,
  user_id: 8379,
};

let otpRow;
let consumeAffectedRows;
const fake = installFakePool([
  [OTP_VERIFY, () => otpRow],
  [EFR_BY_USER, () => []],
  [EFR_BY_NO, () => [TECH]],
  [OTP_CONSUME, () => ({ affectedRows: consumeAffectedRows })],
  [GET_LOCK, (sql) => (/AS got/i.test(sql) ? [{ got: 1 }] : [{ acquired: 1 }])],
  [RELEASE_LOCK, () => [{ released: 1 }]],
]);

beforeEach(() => {
  otpRow = [{ id: 77, otp: 1234, valid_up_to: new Date(Date.now() + 60_000), is_expired: 0 }];
  consumeAffectedRows = 1;
  fake.reset();
});

const techAuth = require('../services/tech-auth.service');

test('verified profile hook runs after proof but before OTP consumption', async () => {
  let hookTech = null;
  const result = await techAuth.verifyLoginOtp('9013877370', 1234, {
    onVerifiedTech: async (tech) => {
      hookTech = tech;
      assert.equal(fake.calls.some((call) => OTP_CONSUME.test(call.sql)), false,
        'OTP must still be reusable while profile persistence runs');
    },
  });

  assert.equal(result.ok, true);
  assert.equal(hookTech.efr_id, TECH.efr_id);
  assert.equal(fake.calls.filter((call) => OTP_CONSUME.test(call.sql)).length, 1);
});

test('profile persistence failure leaves the proven OTP unconsumed for retry', async () => {
  const persistenceFailure = Object.assign(new Error('persistence failed'), { status: 503 });
  await assert.rejects(
    techAuth.verifyLoginOtp('9013877370', 1234, {
      onVerifiedTech: async () => { throw persistenceFailure; },
    }),
    persistenceFailure,
  );
  assert.equal(fake.calls.some((call) => OTP_CONSUME.test(call.sql)), false);
});

test('conditional consume denies a second verifier when another request already won', async () => {
  consumeAffectedRows = 0;
  const result = await techAuth.verifyLoginOtp('9013877370', 1234);
  assert.deepEqual(result, { ok: false, reason: 'OTP_ALREADY_USED' });
  const consume = fake.calls.find((call) => OTP_CONSUME.test(call.sql));
  assert.ok(consume);
  assert.match(consume.sql, /is_expired = 0/i);
  assert.match(consume.sql, /valid_up_to >= NOW\(\)/i);
});

test('new-technician onboarding reuses a caller-pinned connection', async () => {
  let created = false;
  let released = false;
  const calls = [];
  const newTech = { ...TECH, efr_id: 12001, efr_no: '9000000009', user_id: 9001 };
  const runner = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() { released = true; },
    async query(sql) {
      calls.push(String(sql));
      if (/GET_LOCK/i.test(sql)) return [[{ got: 1 }], []];
      if (/RELEASE_LOCK/i.test(sql)) return [[{ released: 1 }], []];
      if (EFR_BY_USER.test(sql)) return [[], []];
      if (EFR_BY_NO.test(sql)) return [created ? [newTech] : [], []];
      if (/INSERT INTO tbl_user/i.test(sql)) return [{ insertId: 9001 }, []];
      if (/INSERT INTO tbl_easyfixer/i.test(sql)) {
        created = true;
        return [{ affectedRows: 1 }, []];
      }
      throw new Error('unexpected query: ' + sql);
    },
  };

  const result = await techAuth.createStubTechnician('9000000009', runner);
  assert.equal(result.efr_id, newTech.efr_id);
  assert.equal(released, false, 'only the owner of the pinned verify connection may release it');
  assert.equal(calls.some((sql) => /GET_LOCK|RELEASE_LOCK/i.test(sql)), false,
    'the outer verify lock must not be replaced by a nested stub lock');
});

test('standalone stub onboarding retains its own per-mobile named lock', async () => {
  fake.reset();
  const result = await techAuth.createStubTechnician(TECH.efr_no);
  assert.equal(result.efr_id, TECH.efr_id);
  assert.ok(fake.calls.some((call) => /GET_LOCK/i.test(call.sql)
    && call.params?.[0] === `tech_stub_create_${TECH.efr_no}`));
  assert.ok(fake.calls.some((call) => /RELEASE_LOCK/i.test(call.sql)
    && call.params?.[0] === `tech_stub_create_${TECH.efr_no}`));
});
