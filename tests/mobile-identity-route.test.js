const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const identity = require('../services/mobile-identity.service');
const rewards = require('../services/rewards.service');
const originalSaveIdentityDetails = identity.saveIdentityDetails;
const originalGetIdentityDetails = identity.getIdentityDetails;
const originalQualifyReferral = rewards.qualifyReferralAfterProfileMutation;
let received = null;
let qualificationEfrId = null;
let server;
let baseUrl;

before(async () => {
  identity.getIdentityDetails = async (efrId) => {
    received = { efrId, action: 'get' };
    return { name: 'Ramesh Kumar', aadhaarDocId: 41 };
  };
  identity.saveIdentityDetails = async (efrId, body, options) => {
    received = { efrId, body, hasFinalize: typeof options?.finalize === 'function' };
    return { updated: true, finalization: { finalized: false } };
  };
  rewards.qualifyReferralAfterProfileMutation = async (efrId) => {
    qualificationEfrId = efrId;
    return { qualified: false, referred: false };
  };
  // eslint-disable-next-line global-require
  const router = require('../routes/mobile/profile-identity');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tech = { efr_id: 8379 }; next(); });
  app.use('/profile', router);
  // eslint-disable-next-line no-unused-vars
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  identity.getIdentityDetails = originalGetIdentityDetails;
  identity.saveIdentityDetails = originalSaveIdentityDetails;
  rewards.qualifyReferralAfterProfileMutation = originalQualifyReferral;
  if (server) await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  received = null;
  qualificationEfrId = null;
});

async function post(body) {
  const response = await fetch(`${baseUrl}/profile/identity-details`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('identity GET restores only the authenticated technician projection', async () => {
  const response = await fetch(`${baseUrl}/profile/identity-details`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    data: { name: 'Ramesh Kumar', aadhaarDocId: 41 },
  });
  assert.deepEqual(received, { efrId: 8379, action: 'get' });
});

test('identity route accepts optional name in the existing payload and forwards implicit technician id', async () => {
  const payload = {
    name: 'Ramesh Kumar',
    aadhaarNumber: '123456789012',
    docs: { aadhaarFront: 'kyc/front-key' },
  };
  const response = await post(payload);
  assert.equal(response.status, 200);
  assert.deepEqual(received, { efrId: 8379, body: payload, hasFinalize: true });
  assert.equal(qualificationEfrId, 8379, 'the committed Identity save retries referral qualification');
});

test('identity route preserves backward compatibility when name is omitted', async () => {
  const payload = { aadhaar: '123456789012' };
  const response = await post(payload);
  assert.equal(response.status, 200);
  assert.deepEqual(received, { efrId: 8379, body: payload, hasFinalize: true });
});

test('identity route rejects malformed Aadhaar before reaching the service', async () => {
  const response = await post({ name: 'Ramesh', aadhaarNumber: '1234' });
  assert.equal(response.status, 400);
  assert.equal(received, null);
});
