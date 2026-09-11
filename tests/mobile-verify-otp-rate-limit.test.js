const test = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

// The login limiters count in tbl_attempt_window (services/attempt-window.service.js).
// A fake pool, installed before the router is required, keeps every test off a
// real database: without the table (the default here) they count per process,
// which is what the ceiling tests below exercise; the last test turns it on.
const S = { table: false };
const fake = installFakePool([
  [/INFORMATION_SCHEMA\.TABLES/, () => (S.table ? [{ 1: 1 }] : [])],
  [/UPDATE tbl_attempt_window/, () => ({ affectedRows: 1 })],
]);
const store = require('../services/attempt-window.service');
const router = require('../routes/mobile');
const { otpFailureHttpStatus } = require('../routes/mobile/otp-http-status');

function responseDouble() {
  return {
    locals: {},
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function verifyMiddlewares() {
  const layer = router.stack.find((entry) => (
    entry.route && entry.route.path === '/auth/verify-otp' && entry.route.methods.post
  ));
  assert.ok(layer, 'POST /auth/verify-otp must be mounted');
  return layer.route.stack.map((entry) => entry.handle);
}

function loginMiddlewares() {
  const layer = router.stack.find((entry) => (
    entry.route && entry.route.path === '/auth/login-otp' && entry.route.methods.post
  ));
  assert.ok(layer, 'POST /auth/login-otp must be mounted');
  return layer.route.stack.map((entry) => entry.handle);
}

test('OTP failure reasons keep invalid, expired, and retryable HTTP semantics distinct', () => {
  assert.equal(otpFailureHttpStatus('OTP_MISMATCH'), 401);
  assert.equal(otpFailureHttpStatus('NO_OTP_ISSUED'), 401);
  assert.equal(otpFailureHttpStatus('OTP_EXPIRED'), 410);
  assert.equal(otpFailureHttpStatus('OTP_ALREADY_USED'), 409);
  assert.equal(otpFailureHttpStatus('OTP_VERIFICATION_BUSY'), 409);
  assert.equal(otpFailureHttpStatus('ONBOARDING_FAILED'), 503);
});

test('login OTP is capped independently by mobile and IP before validation', async () => {
  const [ipLimit, mobileLimit] = loginMiddlewares();

  for (let i = 0; i < 20; i += 1) {
    let allowed = false;
    await mobileLimit(
      { ip: `203.0.113.${i + 1}`, body: { mobile: '9013877371' } },
      responseDouble(),
      () => { allowed = true; },
    );
    assert.equal(allowed, true);
  }
  const mobileBlocked = responseDouble();
  await mobileLimit(
    { ip: '203.0.113.99', body: { mobile: '9013877371' } },
    mobileBlocked,
    () => assert.fail('21st login OTP request for one mobile must be blocked'),
  );
  assert.equal(mobileBlocked.statusCode, 429);

  for (let i = 0; i < 60; i += 1) {
    let allowed = false;
    await ipLimit(
      { ip: '198.51.100.20', body: { mobile: String(9000000000 + i) } },
      responseDouble(),
      () => { allowed = true; },
    );
    assert.equal(allowed, true);
  }
  const ipBlocked = responseDouble();
  await ipLimit(
    { ip: '198.51.100.20', body: { mobile: '9999999999' } },
    ipBlocked,
    () => assert.fail('61st login OTP request from one IP must be blocked'),
  );
  assert.equal(ipBlocked.statusCode, 429);
});

test('verify OTP is capped independently by mobile and IP before validation', async () => {
  const [ipLimit, mobileLimit] = verifyMiddlewares();
  const request = { ip: '203.0.113.22', body: { mobile: '9013877370' } };

  for (let i = 0; i < 30; i += 1) {
    let allowed = false;
    await mobileLimit(request, responseDouble(), () => { allowed = true; });
    assert.equal(allowed, true);
  }
  const mobileBlocked = responseDouble();
  await mobileLimit(request, mobileBlocked, () => assert.fail('31st mobile attempt must be blocked'));
  assert.equal(mobileBlocked.statusCode, 429);

  for (let i = 0; i < 120; i += 1) {
    let allowed = false;
    await ipLimit({ ip: '203.0.113.23', body: { mobile: String(9000000000 + i) } }, responseDouble(), () => { allowed = true; });
    assert.equal(allowed, true);
  }
  const ipBlocked = responseDouble();
  await ipLimit({ ip: '203.0.113.23', body: { mobile: '9999999999' } }, ipBlocked,
    () => assert.fail('121st IP attempt must be blocked'));
  assert.equal(ipBlocked.statusCode, 429);
});

test('oversized pre-validation mobile values collapse to a bounded IP key', async () => {
  const [, mobileLimit] = verifyMiddlewares();
  const ip = '198.51.100.44';
  for (let i = 0; i < 30; i += 1) {
    let allowed = false;
    await mobileLimit(
      { ip, body: { mobile: `${'9'.repeat(10_000)}${i}` } },
      responseDouble(),
      () => { allowed = true; },
    );
    assert.equal(allowed, true);
  }

  const blocked = responseDouble();
  await mobileLimit(
    { ip, body: { mobile: `${'8'.repeat(10_000)}last` } },
    blocked,
    () => assert.fail('invalid high-cardinality bodies must share the IP bucket'),
  );
  assert.equal(blocked.statusCode, 429);
});

test('with tbl_attempt_window all four limiters count SHARED, each with its own key and max', async () => {
  S.table = true; store._resetProbeCache(); fake.calls.length = 0;
  try {
    const req = { ip: '192.0.2.7', body: { mobile: '9013877372' } };
    for (const mw of [...loginMiddlewares().slice(0, 2), ...verifyMiddlewares().slice(0, 2)]) {
      let allowed = false;
      await mw(req, responseDouble(), () => { allowed = true; });
      assert.equal(allowed, true);
    }
    const claims = fake.calls.filter((c) => /UPDATE tbl_attempt_window/.test(c.sql))
      .map((c) => ({ key: c.params[4], max: c.params[6], windowMs: c.params[2] - c.params[0] }));
    assert.deepEqual(claims, [
      { key: 'rate:login-otp:ip:192.0.2.7', max: 60, windowMs: 10 * 60_000 },
      { key: 'rate:login-otp:mobile:9013877372', max: 20, windowMs: 10 * 60_000 },
      { key: 'rate:verify-otp:ip:192.0.2.7', max: 120, windowMs: 10 * 60_000 },
      { key: 'rate:verify-otp:mobile:9013877372', max: 30, windowMs: 10 * 60_000 },
    ]);
  } finally { S.table = false; store._resetProbeCache(); }
});
