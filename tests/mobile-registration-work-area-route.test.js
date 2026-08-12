const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const registration = require('../services/mobile-registration.service');
const originalSaveWorkArea = registration.saveWorkArea;
let received = null;
let server;
let baseUrl;

before(async () => {
  registration.saveWorkArea = async (efrId, body) => {
    received = { efrId, body };
    return { ok: true, homePincode: body.homePincode, pincodes: body.pincodes };
  };

  // Require after installing the service stub; the real router and validation
  // middleware are mounted, only the database-owning service call is isolated.
  // eslint-disable-next-line global-require
  const router = require('../routes/mobile/registration');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tech = { efr_id: 8379 }; next(); });
  app.use('/registration', router);
  // eslint-disable-next-line no-unused-vars
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  registration.saveWorkArea = originalSaveWorkArea;
  if (server) await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => { received = null; });

async function put(body) {
  const response = await fetch(`${baseUrl}/registration/work-area`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('authenticated route forwards the bounded atomic contract with implicit technician id', async () => {
  const payload = {
    name: 'Ramesh Kumar',
    homePincode: '110001',
    pincodes: ['110001', '110062'],
  };
  const response = await put(payload);
  assert.equal(response.status, 200);
  assert.deepEqual(received, { efrId: 8379, body: payload });
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
