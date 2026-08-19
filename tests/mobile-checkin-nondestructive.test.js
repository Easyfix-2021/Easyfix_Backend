/*
 * Mobile check-in must never ERASE a stored location (2026-08-19).
 *
 * The bug: the handler built its stamps as `req.body.gps || null`, so a
 * check-in that carried no coordinates sent an explicit
 * `checkin_gps_location = NULL` into setStatus's extras map. tbl_job holds ONE
 * set of check-in columns for the entire job, so that didn't just fail to
 * record a new reading — it wiped the existing one. Two real paths hit it, both
 * with GPS off or permission denied (which the route's Joi schema deliberately
 * allows, so that check-in stays reachable):
 *   - an app retry moments after a check-in that DID capture coordinates;
 *   - a revisit's second check-in, wiping visit 1's location.
 *
 * These tests assert on the extras map handed to jobService.setStatus, which is
 * exactly where the defect lived. The companion service-level guard (undefined
 * is skipped, explicit null still writes) is pinned in
 * tests/job-service-setstatus.test.js.
 *
 * Runner: `node --test tests/mobile-checkin-nondestructive.test.js`.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { installFakePool } = require('./helpers/fake-pool');

// Never touch a DB: patch the shared pool singleton BEFORE the router (and the
// services it pulls in) capture their `pool` reference.
const fake = installFakePool([]);

// The router mounts requireTechAuth + the lifecycle capability guard + the
// idempotency layer at the top. None of them are under test here, so seed
// require.cache with pass-throughs before requiring the router. Resolved paths
// so the cache keys match what routes/mobile/index.js will ask for.
require.cache[require.resolve('../middleware/tech-auth')] = {
  id: require.resolve('../middleware/tech-auth'),
  filename: require.resolve('../middleware/tech-auth'),
  loaded: true,
  exports: (req, _res, next) => { req.tech = { efr_id: 7 }; next(); },
};
require.cache[require.resolve('../middleware/require-tech-lifecycle-capability')] = {
  id: require.resolve('../middleware/require-tech-lifecycle-capability'),
  filename: require.resolve('../middleware/require-tech-lifecycle-capability'),
  loaded: true,
  exports: {
    requireTechCapability: () => (_req, _res, next) => next(),
    requireTechJobMutationCapability: (_req, _res, next) => next(),
  },
};
require.cache[require.resolve('../middleware/idempotency')] = {
  id: require.resolve('../middleware/idempotency'),
  filename: require.resolve('../middleware/idempotency'),
  loaded: true,
  exports: () => (_req, _res, next) => next(),
};

const jobService = require('../services/job.service');

const JOB = { job_id: 42, fk_easyfixter_id: 7, job_status: 1, otp: null };

let captured = null;
let server;
let baseUrl;

const originalGetById = jobService.getById;
const originalSetStatus = jobService.setStatus;

before(async () => {
  jobService.getById = async () => ({ ...JOB });
  jobService.setStatus = async (jobId, payload) => {
    captured = { jobId, ...payload };
    return { updated: true };
  };

  // eslint-disable-next-line global-require
  const router = require('../routes/mobile/index');
  const app = express();
  app.use(express.json());
  app.use('/mobile', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  jobService.getById = originalGetById;
  jobService.setStatus = originalSetStatus;
  if (server) await new Promise((resolve) => server.close(resolve));
  if (fake.restore) fake.restore();
});

beforeEach(() => { captured = null; });

async function checkin(body) {
  const r = await fetch(`${baseUrl}/mobile/jobs/42/checkin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

// ─── The regression ──────────────────────────────────────────────────

test('check-in with NO location omits the stamps entirely — nothing is nulled', async () => {
  const res = await checkin({});
  assert.equal(res.status, 200, 'a locationless check-in must still succeed');
  assert.ok(captured, 'setStatus should have been called');
  const cols = Object.keys(captured.extras);
  for (const col of ['checkin_gps_location', 'checkin_address', 'checkin_pincode']) {
    assert.ok(!cols.includes(col), `${col} must be absent, not null — presence would erase the stored value`);
  }
  assert.equal(captured.extras.fk_checkin_by, 7, 'fk_checkin_by is unconditional');
  assert.equal(captured.status, 2, 'transition to IN_PROGRESS is unchanged');
});

test('empty-string / blank location is treated as absent, not as a value', async () => {
  // The schema allows gps: '' explicitly. COALESCE-style guards famously miss
  // this — '' is not NULL, so a naive fix would still overwrite the column.
  await checkin({ gps: '', address: '   ' });
  const cols = Object.keys(captured.extras);
  assert.ok(!cols.includes('checkin_gps_location'), 'blank gps must not be written');
  assert.ok(!cols.includes('checkin_address'), 'whitespace-only address must not be written');
});

test('a partial check-in only stamps what was actually supplied', async () => {
  await checkin({ pincode: '560001' });
  assert.equal(captured.extras.checkin_pincode, '560001');
  const cols = Object.keys(captured.extras);
  assert.ok(!cols.includes('checkin_gps_location'), 'the missing gps must not clobber a stored one');
  assert.ok(!cols.includes('checkin_address'), 'the missing address must not clobber a stored one');
});

// ─── The happy path still works ──────────────────────────────────────

test('a full check-in still stamps every supplied location column', async () => {
  await checkin({ gps: '12.9716,77.5946', address: '4th Block, Koramangala', pincode: '560034' });
  const { checkin_date_time: stamp, ...rest } = captured.extras;
  assert.ok(stamp instanceof Date, 'the Segment 1 anchor rides along');
  assert.deepEqual(rest, {
    fk_checkin_by: 7,
    checkin_gps_location: '12.9716,77.5946',
    checkin_address: '4th Block, Koramangala',
    checkin_pincode: '560034',
  });
});

test('supplied values are trimmed before they are stamped', async () => {
  await checkin({ address: '  Indiranagar  ' });
  assert.equal(captured.extras.checkin_address, 'Indiranagar');
});

// ─── The PIN gate is untouched by this change ────────────────────────

test('a wrong customer PIN still blocks check-in before any write', async () => {
  jobService.getById = async () => ({ ...JOB, otp: '1234' });
  const res = await checkin({ otp: '9999', gps: '12.9,77.5' });
  assert.equal(res.status, 409, 'PIN mismatch must still 409');
  assert.equal(res.body?.error?.code ?? res.body?.code, 'INVALID_CHECKIN_PIN');
  assert.equal(captured, null, 'no status write may happen on a PIN mismatch');
  jobService.getById = async () => ({ ...JOB });
});

// ─── Segment 1's anchor (2026-08-19) ─────────────────────────────────
//
// checkin_date_time had NO writer in this backend — only the legacy Java mobile
// API ever stamped it, so any job worked through the new app had no TAT
// Segment 1 clock at all. These pin the write and, more importantly, its
// write-once semantics.

test('check-in stamps checkin_date_time — the TAT Segment 1 anchor', async () => {
  const before = Date.now();
  await checkin({});
  assert.ok(captured.extras.checkin_date_time instanceof Date,
    'the Segment 1 anchor must be written on every check-in');
  const at = captured.extras.checkin_date_time.getTime();
  assert.ok(at >= before && at <= Date.now(),
    'stamped from the SERVER clock — a client-supplied time would let the device being measured forge its own SLA anchor');
});

test('the check-in timestamp is stamped even when no location was supplied', async () => {
  // The location stamps are conditional; the anchor must not be.
  await checkin({});
  assert.ok(captured.extras.checkin_date_time, 'a locationless check-in still anchors Segment 1');
  assert.ok(!Object.keys(captured.extras).includes('checkin_gps_location'));
});
