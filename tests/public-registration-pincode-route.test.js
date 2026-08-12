const test = require('node:test');
const assert = require('node:assert/strict');

const registrationProfile = require('../services/technician-registration-profile.service');
const router = require('../routes/public/pincodes');

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

function routeHandlers() {
  const layer = router.stack.find((entry) => (
    entry.route && entry.route.path === '/:pincode' && entry.route.methods.get
  ));
  assert.ok(layer, 'GET /:pincode must be mounted');
  return layer.route.stack.map((entry) => entry.handle);
}

test('public pincode route rejects anything other than exactly six digits', () => {
  const [, validation] = routeHandlers();
  const invalid = responseDouble();
  let nextCalled = false;
  validation({
    params: { pincode: '11001' },
    originalUrl: '/api/public/pincodes/11001',
    method: 'GET',
  }, invalid, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.success, false);
});

test('public pincode route enforces an independent per-IP request budget', () => {
  const [limit] = routeHandlers();
  for (let i = 0; i < 60; i += 1) {
    const res = responseDouble();
    let allowed = false;
    limit({ ip: '203.0.113.10' }, res, () => { allowed = true; });
    assert.equal(allowed, true);
  }

  const blocked = responseDouble();
  let nextCalled = false;
  limit({ ip: '203.0.113.10' }, blocked, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(blocked.statusCode, 429);
  assert.ok(Number(blocked.headers['Retry-After']) > 0);
});

test('public pincode route returns only the shared location projection', async (t) => {
  const handlers = routeHandlers();
  const handler = handlers[handlers.length - 1];
  const original = registrationProfile.resolvePincode;
  t.after(() => { registrationProfile.resolvePincode = original; });
  registrationProfile.resolvePincode = async () => ({
    pincode: '110001', cityId: 12, city: 'New Delhi', district: 'New Delhi', state: 'Delhi',
  });

  const res = responseDouble();
  await handler({ params: { pincode: '110001' } }, res, (err) => { throw err; });
  assert.deepEqual(res.body, {
    success: true,
    data: { pincode: '110001', cityId: 12, city: 'New Delhi', district: 'New Delhi', state: 'Delhi' },
  });
  assert.equal(res.headers['Cache-Control'], 'public, max-age=300');
});
