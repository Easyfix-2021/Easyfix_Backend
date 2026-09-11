'use strict';
/*
 * POST /api/mobile/profile/professional-details and GET /profile/professional
 * (2026-09-11) — the Professional Details section, now in Edit Profile only.
 *
 * THE BIKE ANSWER, AND WHY IT TRAVELS AS `haveBike`:
 *
 *   1. The app's registration Step 1 sent `hasBike` and this handler dropped it,
 *      while the CRM verification screen reads tbl_easyfixer.have_bike.
 *   2. Writing `hasBike` (8e2e019) was worse than dropping it: Step 1 never
 *      prefilled the toggle, so every build that still has Step 1 sends
 *      `hasBike: false` whatever the technician answered before, and nothing in
 *      the request tells those builds apart.
 *   3. So only `haveBike` — sent by Edit Profile's section, which prefills it — is
 *      written; `hasBike` is tolerated and dropped again. An omitted flag keeps the
 *      stored one (COALESCE), or a save that never touched the toggle would reset it.
 *
 * COMPLETION is judged on the row after the update: Edit Profile sends
 * experienceId only when it changed, so a request-based test left technicians who
 * already had one short of 100 forever (219 of them on QA, 36 active).
 *
 * The prefill fixtures are built through db.js's REAL typeCast, because that is
 * the shape production reads: BIT(1) arrives as true / false / null, never as a
 * Buffer. A Buffer-only reader passes a hand-built Buffer fixture and reads every
 * technician as "no bike" in production.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installFakePool } = require('./helpers/fake-pool');

// The cast the real pool applies to every BIT(1) column (db.js typeCast).
const { pool: realPool } = require('../db');
const castBit = (bytes) => realPool.pool.config.connectionConfig.typeCast(
  { type: 'BIT', length: 1, buffer: () => (bytes === null ? null : Buffer.from(bytes)) },
  () => { throw new Error('typeCast fell through to next() for BIT(1)'); },
);

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
async function saved(body) {
  fake.reset();
  const r = await post(body);
  assert.equal(r.status, 200, `POST ${JSON.stringify(body)} → ${r.status} ${await r.clone().text()}`);
  const call = updateCall();
  assert.ok(call, 'the tbl_easyfixer UPDATE must have run');
  return call;
}

/* The UPDATE binds: experience, tools CSV, WhatsApp, bike, completion-experience, efr id. */
const BIKE = 3;
const COMPLETION = 4;

test('control: the fixture cast is the pool\'s — BIT(1) reads as a boolean, never a Buffer', () => {
  assert.equal(castBit([1]), true);
  assert.equal(castBit([0]), false);
  assert.equal(castBit(null), null);
});

test('haveBike is WRITTEN to have_bike — 1 for yes, 0 for no', async () => {
  for (const [haveBike, want] of [[true, 1], [false, 0]]) {
    const call = await saved({ experienceId: 2, haveBike, useWhatsapp: true });
    assert.match(call.sql, /have_bike\s+= COALESCE\(\?, have_bike\)/, 'have_bike is COALESCEd like the other flags');
    assert.equal(call.params[BIKE], want, `haveBike=${haveBike} must bind ${want}`);
    assert.deepEqual(call.params.slice(0, 3), [2, null, 1], 'the neighbours bind where they did before');
  }
});

test('an OLD build\'s hasBike cannot touch have_bike — it is dropped, as it was before 8e2e019', async () => {
  // Step 1 in every build that still has it: experience + tools + hasBike:false,
  // always false because it never prefilled the toggle.
  const call = await saved({ experienceId: 2, hasBike: false, useWhatsapp: true });
  assert.equal(call.params[BIKE], null, 'hasBike binds NULL → COALESCE keeps the stored answer');
  assert.equal(call.params[0], 2, 'control: the rest of the old build\'s save still lands');
});

test('an omitted haveBike keeps the stored value', async () => {
  const call = await saved({ experienceId: 3 });
  assert.equal(call.params[BIKE], null, 'no haveBike → NULL → COALESCE keeps have_bike');
});

test('haveBike is validated at the boundary: a non-boolean is refused, "false" is false', async () => {
  const bad = await post({ haveBike: 'yes' });
  assert.equal(bad.status, 400, 'a string that is not a boolean must be a 400, not a truthy 1');
  const call = await saved({ haveBike: 'false' });
  assert.equal(call.params[BIKE], 0, '"false" converts to false and binds 0 — not 1 because a string is truthy');
});

test('completion is judged on the row after the update, not on what the request carried', async () => {
  const call = await saved({ haveBike: true });
  assert.match(call.sql,
    /efr_professional_details_perc = CASE WHEN COALESCE\(\?, experience_id\) IS NOT NULL\s+THEN 100 ELSE efr_professional_details_perc END/,
    'a save without experienceId still completes a row that already has one');
  assert.equal(call.params[COMPLETION], null, 'no experienceId sent → the row\'s own experience_id decides');
  assert.equal((await saved({ experienceId: 5 })).params[COMPLETION], 5, 'a sent experienceId decides it');
});

test('the prefill returns haveBike and which single photos are on file, from the pool\'s real shape', async () => {
  efRow = { experience_id: 4, efr_tools: '', use_whatsapp: castBit([0]), have_bike: castBit([1]) };
  docRows = [{ efr_doc_type_id: 9 }];
  const r = await fetch(`${baseUrl}/mobile/profile/professional`);
  assert.equal(r.status, 200);
  const { data } = await r.json();
  assert.equal(data.haveBike, true, 'have_bike true → haveBike true');
  assert.equal(data.useWhatsapp, false, 'use_whatsapp false → false — the two flags are not confused');
  assert.deepEqual(data.docs, { education: false, toolBag: true }, 'type 9 on file, type 7 not');
  assert.equal(data.experienceId, 4);
  assert.equal('hasBike' in data, false, 'the read uses the write\'s name — one name per field');
});

test('the prefill still reads a Buffer or a NULL flag, whichever pool served the row', async () => {
  for (const [haveBike, want] of [[Buffer.from([1]), true], [castBit(null), false]]) {
    efRow = { experience_id: null, efr_tools: '', use_whatsapp: null, have_bike: haveBike };
    const { data } = await (await fetch(`${baseUrl}/mobile/profile/professional`)).json();
    assert.equal(data.haveBike, want, `have_bike ${JSON.stringify(haveBike)} → ${want}`);
  }
});

test('a technician with no row reads as nothing on file, never as a crash', async () => {
  const r = await fetch(`${baseUrl}/mobile/profile/professional`);
  assert.equal(r.status, 200);
  const { data } = await r.json();
  assert.deepEqual([data.haveBike, data.docs], [false, { education: false, toolBag: false }]);
});
