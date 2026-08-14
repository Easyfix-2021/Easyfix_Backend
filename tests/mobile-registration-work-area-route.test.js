const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const registration = require('../services/mobile-registration.service');
const rewards = require('../services/rewards.service');
const originalSaveWorkArea = registration.saveWorkArea;
const originalGetStatus = registration.getStatus;
const originalQualifyReferral = rewards.qualifyReferralAfterProfileMutation;
let received = null;
let receivedStatus = null;
let qualificationEfrId = null;
let server;
let baseUrl;

const overdueLifecycle = Object.freeze({
  status: 'ACTIVE',
  trainingOverdue: true,
  capabilities: Object.freeze({ receiveNewJobs: false, claimMoney: true }),
});

before(async () => {
  registration.saveWorkArea = async (efrId, body) => {
    received = { efrId, body };
    return { ok: true, homePincode: body.homePincode, pincodes: body.pincodes };
  };
  registration.getStatus = async (efrId, lifecycle) => {
    receivedStatus = { efrId, lifecycle };
    return { status: 'active', jobsUnlocked: false, lifecycle };
  };
  rewards.qualifyReferralAfterProfileMutation = async (efrId) => {
    qualificationEfrId = efrId;
    return { qualified: false, referred: false };
  };

  // Require after installing the service stub; the real router and validation
  // middleware are mounted, only the database-owning service call is isolated.
  // eslint-disable-next-line global-require
  const router = require('../routes/mobile/registration');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tech = { efr_id: 8379, lifecycle: overdueLifecycle };
    next();
  });
  app.use('/registration', router);
  // eslint-disable-next-line no-unused-vars
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  registration.saveWorkArea = originalSaveWorkArea;
  registration.getStatus = originalGetStatus;
  rewards.qualifyReferralAfterProfileMutation = originalQualifyReferral;
  if (server) await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  received = null;
  receivedStatus = null;
  qualificationEfrId = null;
});

async function put(body) {
  const response = await fetch(`${baseUrl}/registration/work-area`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: await response.json() };
}

test('registration status reuses the authenticated overdue lifecycle snapshot', async () => {
  const response = await get('/registration/status');
  assert.equal(response.status, 200);
  assert.deepEqual(receivedStatus, { efrId: 8379, lifecycle: overdueLifecycle });
  assert.equal(response.body.data.jobsUnlocked, false);
  assert.equal(response.body.data.lifecycle.trainingOverdue, true);
  assert.equal(response.body.data.lifecycle.capabilities.receiveNewJobs, false);
});

test('authenticated route forwards the bounded atomic contract with implicit technician id', async () => {
  const payload = {
    name: 'Ramesh Kumar',
    homePincode: '110001',
    pincodes: ['110001', '110062'],
  };
  const response = await put(payload);
  assert.equal(response.status, 200);
  assert.deepEqual(received, { efrId: 8379, body: payload });
  assert.equal(qualificationEfrId, 8379, 'the committed Work Area retries referral qualification');
});

test('route rejects a set that omits Home PIN before reaching the service', async () => {
  const response = await put({
    name: 'Ramesh Kumar',
    homePincode: '110001',
    pincodes: ['110062'],
  });
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(response.body), /homePincode must be included in pincodes/i);
  assert.equal(received, null);
});

test('route enforces the 50-pincode payload bound', async () => {
  const pincodes = Array.from({ length: 51 }, (_, index) => String(110000 + index));
  const response = await put({
    name: 'Ramesh Kumar',
    homePincode: pincodes[0],
    pincodes,
  });
  assert.equal(response.status, 400);
  assert.equal(received, null);
});

test('route allows name to be omitted when Work Area is completed before Identity', async () => {
  const payload = {
    homePincode: '110001',
    pincodes: ['110001'],
  };
  const response = await put(payload);
  assert.equal(response.status, 200);
  assert.deepEqual(received, { efrId: 8379, body: payload });
});
