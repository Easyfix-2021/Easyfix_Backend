'use strict';
/*
 * POST /api/mobile/profile/professional-details and GET /profile/professional
 * (2026-09-11) — the Professional Details section, now in Edit Profile only.
 *
 * TWO GAPS THE SECTION EXPOSED, both of which read correct from the app side:
 *
 *   1. hasBike was accepted and THROWN AWAY. The app showed a Bike toggle and
 *      sent it; the handler's unknown(true) swallowed it, and the CRM's
 *      verification screen reads tbl_easyfixer.have_bike. It is written now —
 *      and like every other flag here, an omitted value must KEEP the stored one
 *      (COALESCE), or an Edit Profile save that never touched the toggle would
 *      reset it.
 *   2. The prefill did not say whether the education certificate and tool-bag
 *      photos were on file, so Edit Profile would show both tiles blank for a
 *      technician who had uploaded them.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installFakePool } = require('./helpers/fake-pool');

let efRow = null;
let docRows = [];
const fake = installFakePool([
  [/SELECT experience_id, efr_tools, use_whatsapp, have_bike FROM tbl_easyfixer/i, () => (efRow ? [efRow] : [])],
  [/efr_doc_type_id IN \(7, 9\)/i, () => docRows],
  [/FROM tbl_efr_deepskill_mapping/i, () => []],
]);

for (const [mod, exports] of [
  ['../middleware/tech-auth', (req, _res, next) => { req.tech = { efr_id: 7 }; next(); }],
  ['../middleware/require-tech-lifecycle-capability', {
    requireTechCapability: () => (_req, _res, next) => next(),
    requireTechJobMutationCapability: (_req, _res, next) => next(),
  }],
  ['../middleware/idempotency', () => (_req, _res, next) => next()],
]) {
  const id = require.resolve(mod);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

let server;
let baseUrl;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/mobile', require('../routes/mobile/index'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  fake.restore();
});
beforeEach(() => { efRow = null; docRows = []; fake.reset(); });

const post = (body) => fetch(`${baseUrl}/mobile/profile/professional-details`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const updateCall = () => fake.calls.find((c) => /UPDATE tbl_easyfixer SET/.test(c.sql));

/* The UPDATE binds, in order: experience, tools CSV, WhatsApp, bike, perc, efr id. */
const BIKE = 3;

test('hasBike is WRITTEN to have_bike — 1 for yes, 0 for no', async () => {
  for (const [hasBike, want] of [[true, 1], [false, 0]]) {
    fake.reset();
    const r = await post({ experienceId: 2, hasBike, useWhatsapp: true });
    assert.equal(r.status, 200, `POST hasBike=${hasBike} → ${r.status} ${await r.clone().text()}`);
    const call = updateCall();
    assert.ok(call, 'the tbl_easyfixer UPDATE must have run');
    assert.match(call.sql, /have_bike\s+= COALESCE\(\?, have_bike\)/, 'have_bike is COALESCEd like the other flags');
    assert.equal(call.params[BIKE], want, `hasBike=${hasBike} must bind ${want} to have_bike`);
    assert.deepEqual(call.params.slice(0, 3), [2, null, 1], 'the neighbours bind where they did before');
  }
});

test('an omitted hasBike keeps the stored value (binds NULL into the COALESCE)', async () => {
  // Edit Profile saves the section when ANY of its fields changed; a technician
  // who only changed his experience must not have his bike answer reset.
  const r = await post({ experienceId: 3 });
  assert.equal(r.status, 200);
  const call = updateCall();
  assert.equal(call.params[BIKE], null, 'no hasBike in the body → NULL → COALESCE keeps have_bike');
  assert.equal(call.params[0], 3, 'control: the field that WAS sent is bound');
});

test('the prefill returns hasBike and which single photos are on file', async () => {
  efRow = { experience_id: 4, efr_tools: '', use_whatsapp: Buffer.from([0]), have_bike: Buffer.from([1]) };
  docRows = [{ efr_doc_type_id: 9 }];
  const r = await fetch(`${baseUrl}/mobile/profile/professional`);
  assert.equal(r.status, 200);
  const { data } = await r.json();
  assert.equal(data.hasBike, true, 'have_bike is BIT(1): a Buffer [1] must read as true');
  assert.equal(data.useWhatsapp, false, 'and a Buffer [0] as false — the flags are not confused');
  assert.deepEqual(data.docs, { education: false, toolBag: true }, 'type 9 on file, type 7 not');
  assert.equal(data.experienceId, 4);
});

test('a technician with no row reads as nothing on file, never as a crash', async () => {
  const r = await fetch(`${baseUrl}/mobile/profile/professional`);
  assert.equal(r.status, 200);
  const { data } = await r.json();
  assert.deepEqual([data.hasBike, data.docs], [false, { education: false, toolBag: false }]);
});
