/*
 * Reached-location geofence (2026-09-07).
 *
 * The technician app is merging its Reached Location and Start Work screens
 * into one, but keeps calling BOTH backend endpoints in order — the CRM's
 * stage timeline reads both transitions and the reached-location selfie is a
 * document row the CRM renders in its Schedule tab. So the whole point of this
 * change is that it is ADDITIVE, and the first test below is the one that
 * matters most: a body with no geofence block must still run exactly the two
 * statements it ran before, in the same order, with the same parameters.
 *
 * The product rule the rest pins: SOFT BLOCK WITH AN AUDITED OVERRIDE.
 *   - outside the fence, no reason, enforcement OFF  → proceeds (recorded)
 *   - outside the fence, no reason, enforcement ON   → 400, and still recorded
 *   - outside the fence, WITH a reason, ON           → proceeds, reason stored
 *   - no site coordinates / no device fix            → never blocked, ever
 *
 * And the one that is easy to get wrong: the enforcement gate reads the
 * SERVER's verdict, not the `withinFence` boolean the client sent. A gate that
 * trusts a boolean supplied by the thing being gated is not a gate.
 *
 * Runner: node --test --test-force-exit tests/mobile-reached-location-geofence.test.js
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { installFakePool } = require('./helpers/fake-pool');

const JOB_ID = 5150;
const EFR_ID = 91;

// Bengaluru. The site pin, and three device fixes at known separations.
const SITE = '12.9716,77.5946';
const NEAR = { latitude: 12.9717, longitude: 77.5947 };  // ~15 m  → inside 150 m
const FAR = { latitude: 12.9800, longitude: 77.6100 };   // ~1.8 km → outside

// Reassigned per-test; the pool closures read them.
let siteGps = SITE;
let geofenceColumnsPresent = true;
let properties = [];

const fake = installFakePool([
  // getOwnedJob
  [/SELECT\s+job_id,\s*job_status/i, () => [{
    job_id: JOB_ID, job_status: 1, fk_easyfixter_id: EFR_ID,
    fk_customer_id: 1, fk_client_id: 1, otp: null,
  }]],
  // recordArrivalGeofence's address lookup
  [/SELECT\s+ad\.gps_location/i, () => [{ gps_location: siteGps }]],
  // properties.service._load
  [/FROM\s+easyfix_properties/i, () => properties],
  // the geofence column probe
  [/INFORMATION_SCHEMA\.COLUMNS[\s\S]*tbl_job_location_track/i,
    () => [{ n: geofenceColumnsPresent ? 3 : 0 }]],
  // tx_selfie_id probe
  [/INFORMATION_SCHEMA\.COLUMNS/i, () => [{ 1: 1 }]],
  [/INSERT\s+INTO\s+tbl_job_location_track/i, () => ({ insertId: 1 })],
  [/UPDATE\s+tbl_job\s+SET\s+tx_selfie_id/i, () => ({ affectedRows: 1 })],
]);

const lifecycle = require('../services/mobile-job-lifecycle.service');
const props = require('../services/properties.service');

after(() => fake.restore());
beforeEach(async () => {
  siteGps = SITE;
  geofenceColumnsPresent = true;
  properties = [];
  fake.reset();
  await props.flushCache();   // reload the (empty) property set from the fake
  fake.reset();
});

async function setEnforcement(on) {
  properties = [
    { property_key: 'geofence.enforcement.enabled', property_value: on ? 'true' : 'false' },
    { property_key: 'geofence.radius.meters', property_value: '150' },
  ];
  await props.flushCache();
  fake.reset();
}

async function reached(body) {
  try {
    const out = await lifecycle.saveSelfie(JOB_ID, EFR_ID, { selfieImageId: 777, ...body });
    return { ok: true, status: 200, out };
  } catch (e) {
    return { ok: false, status: e.status || 500, message: e.message };
  }
}

const trackInserts = () => fake.calls.filter((c) => /INSERT INTO tbl_job_location_track/i.test(c.sql));
const selfieUpdates = () => fake.calls.filter((c) => /UPDATE tbl_job SET tx_selfie_id/i.test(c.sql));

/*
 * ── THE REGRESSION GUARD ────────────────────────────────────────────────
 * Every caller alive today sends no geofence block. That request must reach
 * the selfie UPDATE having touched nothing else new: no address lookup, no
 * track INSERT, no property read. If this ever fails, the merged-screen work
 * has broken the CRM's Schedule-tab selfie.
 */
test('a body with NO geofence block behaves exactly as before', async () => {
  const r = await reached({});
  assert.equal(r.ok, true);
  assert.deepEqual(r.out, { ok: true });

  assert.equal(trackInserts().length, 0, 'no arrival row is written when no fix was reported');
  assert.equal(
    fake.calls.filter((c) => /ad\.gps_location/i.test(c.sql)).length, 0,
    'the site address is not even looked up',
  );
  assert.equal(selfieUpdates().length, 1, 'the selfie ref is still stored');
  assert.deepEqual(
    selfieUpdates()[0].params.filter((p) => !(p instanceof Date)),
    [777, JOB_ID, EFR_ID],
    'same parameters as before the change',
  );
});

test('enforcement ON still cannot reject a body with no geofence block', async () => {
  await setEnforcement(true);
  const r = await reached({});
  assert.equal(r.ok, true, 'the CRM and every shipped caller must survive hard mode');
  assert.equal(selfieUpdates().length, 1);
});

// ── Recording ──────────────────────────────────────────────────────────

test('an arrival inside the fence is recorded as within_fence=1', async () => {
  const r = await reached({ geofence: { ...NEAR, withinFence: true } });
  assert.equal(r.ok, true);

  const ins = trackInserts();
  assert.equal(ins.length, 1);
  // [job_id, efr_id, lat, lng, accuracy, captured_at, distance, within_fence, override]
  assert.equal(ins[0].params[0], JOB_ID);
  assert.equal(ins[0].params[1], EFR_ID);
  assert.ok(ins[0].params[5] instanceof Date, 'captured_at is bound as a Date, never SQL NOW()');
  assert.doesNotMatch(ins[0].sql, /NOW\(\)/);
  assert.equal(ins[0].params[7], 1, 'within_fence = 1');
  assert.equal(ins[0].params[8], null, 'no override reason');
  assert.ok(ins[0].params[6] < 150, 'distance recorded and under the radius');
  assert.equal(selfieUpdates().length, 1);
});

test('the bare latitude/longitude the shipped app already sends is evaluated too', async () => {
  // These were being stripped by Joi and thrown away. Listing them in the
  // schema is what starts recording them; nothing about the request changed.
  const r = await reached({ latitude: FAR.latitude, longitude: FAR.longitude });
  assert.equal(r.ok, true, 'soft by default — never rejected');
  const ins = trackInserts();
  assert.equal(ins.length, 1);
  assert.equal(ins[0].params[7], 0, 'evaluated as outside');
});

test('an override reason is stored so ops can see who started from outside', async () => {
  await setEnforcement(true);
  const r = await reached({
    geofence: { ...FAR, withinFence: false, overrideReason: 'Mall gate pass desk is across the road' },
  });
  assert.equal(r.ok, true, 'a reason is always enough to proceed');
  const ins = trackInserts();
  assert.equal(ins[0].params[7], 0, 'within_fence = 0');
  assert.equal(ins[0].params[8], 'Mall gate pass desk is across the road');
});

// ── Enforcement ────────────────────────────────────────────────────────

test('SOFT by default: outside the fence with no reason still proceeds', async () => {
  const r = await reached({ geofence: { ...FAR, withinFence: false } });
  assert.equal(r.ok, true, 'nobody is stranded while enforcement is off');
  assert.equal(trackInserts().length, 1, 'but it IS recorded');
  assert.equal(trackInserts()[0].params[7], 0);
  assert.equal(selfieUpdates().length, 1);
});

test('HARD mode: outside with no reason is 400, and the attempt is still audited', async () => {
  await setEnforcement(true);
  const r = await reached({ geofence: { ...FAR, withinFence: false } });
  assert.equal(r.status, 400);
  assert.match(r.message, /from the job location/i);
  assert.equal(trackInserts().length, 1, 'a blocked attempt must not be the one that leaves no trace');
  assert.equal(trackInserts()[0].params[7], 0);
  assert.equal(trackInserts()[0].params[8], null);
  assert.equal(selfieUpdates().length, 0, 'and the job is NOT mutated');
});

test('HARD mode gates on the SERVER verdict, not the withinFence the client sent', async () => {
  await setEnforcement(true);
  // The device is 1.8 km away but claims it is inside. A client-trusting gate
  // would wave this through — which is every geofence bypass ever written.
  const r = await reached({ geofence: { ...FAR, withinFence: true, distanceMeters: 3 } });
  assert.equal(r.status, 400, 'the server recomputes and blocks');
});

// ── Never block on missing data ────────────────────────────────────────

test('HARD mode never blocks a site that has no coordinates', async () => {
  await setEnforcement(true);
  siteGps = null;
  const r = await reached({ geofence: { ...FAR, withinFence: false } });
  assert.equal(r.ok, true, 'ops never captured a pin — that is not the technician\'s fault');
  assert.equal(trackInserts()[0].params[7], null, 'within_fence NULL = not evaluated, not "outside"');
  assert.equal(selfieUpdates().length, 1);
});

test('HARD mode never blocks on a junk site pin', async () => {
  await setEnforcement(true);
  for (const junk of ['', '0,0', 'null', '12.9', 'abc,def']) {
    siteGps = junk;
    fake.reset();
    const r = await reached({ geofence: { ...FAR, withinFence: false } });
    assert.equal(r.ok, true, 'gps_location = ' + JSON.stringify(junk) + ' must not block');
  }
});

test('a (0,0) device fix is "no fix", not 8000km outside', async () => {
  await setEnforcement(true);
  const r = await reached({ latitude: 0, longitude: 0 });
  assert.equal(r.ok, true);
  assert.equal(trackInserts().length, 0, 'nothing worth recording');
});

// ── Deploy safety ──────────────────────────────────────────────────────

test('a host without the migration records the position and still succeeds', async () => {
  /*
   * The column probe memoises on success (deliberately — it is one
   * INFORMATION_SCHEMA read per process, not per arrival), so by now the
   * modules in this file's registry have it pinned true. Re-require both
   * through a fresh registry rather than exporting a cache-reset that exists
   * only for tests. The fake pool is installed on the shared db singleton, so
   * the fresh copies still dispatch here.
   */
  geofenceColumnsPresent = false;
  delete require.cache[require.resolve('../services/job-location.service')];
  delete require.cache[require.resolve('../services/mobile-job-lifecycle.service')];
  const fresh = require('../services/mobile-job-lifecycle.service');
  try {
    const out = await fresh.saveSelfie(JOB_ID, EFR_ID, { selfieImageId: 777, geofence: { ...NEAR, withinFence: true } });
    assert.deepEqual(out, { ok: true });
    const ins = trackInserts();
    assert.equal(ins.length, 1);
    assert.equal(ins[0].params.length, 6, 'falls back to the six-column INSERT (6 bound params)');
    assert.ok(ins[0].params[5] instanceof Date, 'captured_at is bound as a Date, never SQL NOW()');
    assert.doesNotMatch(ins[0].sql, /NOW\(\)/);
    assert.equal(selfieUpdates().length, 1);
  } finally {
    delete require.cache[require.resolve('../services/job-location.service')];
    delete require.cache[require.resolve('../services/mobile-job-lifecycle.service')];
  }
});

test('an audit-write failure never blocks the technician', async () => {
  const failing = installFakePool([
    [/SELECT\s+job_id,\s*job_status/i, () => [{
      job_id: JOB_ID, job_status: 1, fk_easyfixter_id: EFR_ID,
      fk_customer_id: 1, fk_client_id: 1, otp: null,
    }]],
    [/SELECT\s+ad\.gps_location/i, () => [{ gps_location: SITE }]],
    [/FROM\s+easyfix_properties/i, () => []],
    [/INFORMATION_SCHEMA\.COLUMNS[\s\S]*tbl_job_location_track/i, () => [{ n: 3 }]],
    [/INFORMATION_SCHEMA\.COLUMNS/i, () => [{ 1: 1 }]],
    [/INSERT\s+INTO\s+tbl_job_location_track/i, () => { throw new Error('table is read-only'); }],
    [/UPDATE\s+tbl_job\s+SET\s+tx_selfie_id/i, () => ({ affectedRows: 1 })],
  ]);
  try {
    const out = await lifecycle.saveSelfie(JOB_ID, EFR_ID, { selfieImageId: 777, ...NEAR });
    assert.deepEqual(out, { ok: true });
    assert.equal(
      failing.calls.filter((c) => /UPDATE tbl_job SET tx_selfie_id/i.test(c.sql)).length, 1,
      'the selfie still lands',
    );
  } finally {
    failing.restore();
  }
});

// ── The projection ─────────────────────────────────────────────────────

test('buildGeofence: coordinates in, contract shape out; junk in, null out', async () => {
  const { buildGeofence } = require('../services/job-location.service');
  assert.deepEqual(buildGeofence(SITE), {
    latitude: 12.9716, longitude: 77.5946, radiusMeters: 150,
  });
  for (const junk of [null, undefined, '', '0,0', '12.9', '12.9,', 'a,b', '12.9,77.5,3']) {
    assert.equal(buildGeofence(junk), null, JSON.stringify(junk) + ' must yield null');
  }
});

test('the radius is ops-tunable and a zero/garbage value falls back, never to 0', async () => {
  const { fenceRadiusMeters } = require('../services/job-location.service');
  properties = [{ property_key: 'geofence.radius.meters', property_value: '400' }];
  await props.flushCache();
  assert.equal(fenceRadiusMeters(), 400);
  // A 0 m fence would put every technician on earth outside it — under hard
  // mode that is a full field-work outage from one bad row.
  for (const bad of ['0', '-5', 'soon', '']) {
    properties = [{ property_key: 'geofence.radius.meters', property_value: bad }];
    await props.flushCache();
    assert.equal(fenceRadiusMeters(), 150, 'value ' + JSON.stringify(bad) + ' falls back');
  }
});
