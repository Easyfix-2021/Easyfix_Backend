'use strict';
/*
 * GET /api/mobile/jobs — the technician's Bookings list (2026-09-11).
 *
 * THREE DEFECTS, ONE LIST, measured on Production:
 *
 *   1. Release 0afb837 put `s.delegate_efr_id` in list()'s WHERE while its
 *      migration was still pending, so EVERY GET /api/mobile/jobs answered
 *      500 "Unknown column 's.delegate_efr_id'". The clause is now gated on a
 *      schema probe, and an "absent" answer is re-asked after a short window
 *      because the migration is applied to live servers without a restart.
 *   2. The route dropped `offset`, so load-more got page one back every time;
 *      one device re-requested it 34,348 times in one release.
 *   3. With no `status` the list was every job the technician ever had
 *      (completed and cancelled included), under a dashboard card that counts
 *      only the ACTIVE set.
 *
 * The fake DB models the un-migrated schema the way MySQL does: while
 * `schema === 'absent'`, any query naming a delegation column THROWS
 * ER_BAD_FIELD_ERROR. So a broken gate fails here with the production error
 * itself, not merely with a regex mismatch.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installFakePool } = require('./helpers/fake-pool');

let schema = 'present';   // 'present' | 'absent' — the delegation migration
let fault = null;         // a NON-absent error code for tbl_job_share_link reads

const PROBE = /FROM tbl_job_share_link LIMIT 1/i;
const sqlError = (code, errno, message) => Object.assign(new Error(message), { code, errno });

const fake = installFakePool([
  [/tbl_job_share_link/i, (sql) => {
    if (fault) throw sqlError(fault, undefined, `connect ${fault}`);
    if (schema === 'absent' && /delegate_efr_id|responded_on/.test(sql)) {
      throw sqlError('ER_BAD_FIELD_ERROR', 1054, "Unknown column 's.delegate_efr_id' in 'where clause'");
    }
    return /SELECT COUNT\(\*\) AS total/i.test(sql) ? [{ total: 0 }] : [];
  }],
  [/SELECT COUNT\(\*\) AS total/i, () => [{ total: 0 }]],
]);

// The route half mounts the real router; auth / capability / idempotency are
// not under test, so they are pass-throughs (same seam as mobile-close-pin).
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

const { ACTIVE_STATUSES } = require('../services/mobile-dashboard.service');

const dataCall = () => fake.calls.find((c) => /LIMIT \? OFFSET \?/.test(c.sql));
const countCall = () => fake.calls.find((c) => /SELECT COUNT\(\*\) AS total/i.test(c.sql));
const probeCount = () => fake.calls.filter((c) => PROBE.test(c.sql)).length;

/* The probe's memo is module state, so each scenario gets a FRESH module rather
 * than a test-only reset export. The router keeps the instance it loaded. */
function fresh(...mods) {
  for (const m of mods) delete require.cache[require.resolve(m)];
  return require(mods[mods.length - 1]);
}
const freshList = () => fresh('../services/job.service').list;
const freshDelegation = () => fresh('../services/job.service', '../services/job-share-delegation.service');

beforeEach(() => { schema = 'present'; fault = null; fake.reset(); });

/* ─── 1. The delegation clause survives an un-migrated DB ─────────────── */

const MOBILE_ARGS = { easyfixerId: 7, delegatedToEfrId: 7, limit: 20, offset: 0 };

test('columns ABSENT → the plain assigned-to clause in rows AND total, never a 500', async () => {
  schema = 'absent';
  await freshList()(MOBILE_ARGS);   // rejects with the production error if ungated
  assert.equal(probeCount(), 1, 'the probe must have been asked — else "absent" was never measured');
  for (const [name, call] of [['data', dataCall()], ['COUNT', countCall()]]) {
    assert.ok(call, `the ${name} query must have run — an absent call makes the next lines vacuous`);
    assert.doesNotMatch(call.sql, /delegate_efr_id/, `${name}: no delegation column pre-migration`);
    assert.match(call.sql, /j\.fk_easyfixter_id = \?/, `${name}: still scoped to the technician`);
  }
});

test('columns PRESENT → the delegated-to-me EXISTS in rows AND total', async () => {
  await freshList()(MOBILE_ARGS);
  for (const [name, call] of [['data', dataCall()], ['COUNT', countCall()]]) {
    assert.ok(call, `the ${name} query must have run`);
    assert.match(call.sql, /j\.fk_easyfixter_id = \? OR EXISTS \([\s\S]*s\.delegate_efr_id = \?/,
      `${name}: a delegate must see the job he was asked to do`);
  }
});

test('"absent" is re-asked within 60s of a live migration; "present" is kept for good', async (t) => {
  let now = 1_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const list = freshList();
  const run = async () => {
    fake.reset();
    await list(MOBILE_ARGS);
    return { probed: probeCount(), delegated: /delegate_efr_id/.test(dataCall().sql) };
  };

  schema = 'absent';
  assert.deepEqual(await run(), { probed: 1, delegated: false }, 'first ask: absent');

  schema = 'present';                       // the migration lands, no restart
  now += 1_000;
  assert.deepEqual(await run(), { probed: 0, delegated: false },
    'inside the window the answer is cached — no probe per request on the hot path');

  now += 59_000;                            // 60s after the first ask
  assert.deepEqual(await run(), { probed: 1, delegated: true },
    'after the window the probe is asked again and delegation switches on');

  now += 24 * 3600 * 1000;
  assert.deepEqual(await run(), { probed: 0, delegated: true },
    '"present" is permanent — a column does not un-exist, so it is never re-asked');
});

test('a probe FAULT (not an absent-answer) is not cached at all', async () => {
  const list = freshList();
  fault = 'ETIMEDOUT';
  await list(MOBILE_ARGS);
  assert.doesNotMatch(dataCall().sql, /delegate_efr_id/, 'a blip reads as absent for THIS call');
  fault = null;
  fake.reset();
  await list(MOBILE_ARGS);
  assert.equal(probeCount(), 1, 'the very next call asks again');
  assert.match(dataCall().sql, /s\.delegate_efr_id = \?/);
});

/* ─── 2. Every other delegation reader, pre-migration ─────────────────── */

test('columns ABSENT → share reads answer "not shared" instead of 500ing', async () => {
  schema = 'absent';
  const delegation = freshDelegation();
  const shareSelects = () => fake.calls.filter((c) => /FROM tbl_job_share_link s\b/.test(c.sql)).length;

  assert.equal(await delegation.getShareForViewer(4321, 7), null, 'GET /jobs/:id/share → { share: null }');
  assert.equal(await delegation.resolveLock(4321, 7), null, 'the lock falls through, no warn per request');
  await assert.rejects(delegation.acceptShare(4321, 7), { status: 404 }, 'accept → 404, not 500');
  assert.equal(shareSelects(), 0, 'SHARE_SELECT must not run against absent columns');

  // Positive control: the locator above really matches SHARE_SELECT.
  schema = 'present';
  const migrated = freshDelegation();
  fake.reset();
  await migrated.getShareForViewer(4321, 7);
  assert.equal(shareSelects(), 1, 'post-migration the share IS read');
});

test('the TTL sweep skips a table that lacks its delegation columns, and still throws a real fault', async () => {
  const delegation = freshDelegation();
  schema = 'absent';
  assert.deepEqual(await delegation.expireStaleShares(), { eligible: 0, expired: 0, skipped: true });
  schema = 'present';
  fault = 'ETIMEDOUT';
  await assert.rejects(delegation.expireStaleShares(), { code: 'ETIMEDOUT' },
    'only an absent-answer is swallowed; a connection fault must still surface');
});

/* ─── 3. The route: offset and the default status set ────────────────── */

let server;
let baseUrl;
before(async () => {
  const app = express();
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

async function getJobs(qs) {
  fake.reset();
  const r = await fetch(`${baseUrl}/mobile/jobs${qs}`);
  assert.equal(r.status, 200, `GET /mobile/jobs${qs} → ${r.status} ${await r.clone().text()}`);
  const data = dataCall();
  const count = countCall();
  assert.ok(data && count, 'both queries must have run');
  return { data, count };
}

test('offset reaches the query; anything that is not a non-negative integer is 0', async () => {
  for (const [qs, want] of [
    ['?limit=20&offset=20', 20],
    ['?offset=40', 40],
    ['', 0],
    ['?offset=abc', 0],
    ['?offset=-20', 0],
    ['?offset=1.5', 0],
    ['?offset=1e400', 0],
  ]) {
    const { data } = await getJobs(qs);
    assert.equal(data.params.at(-1), want, `${qs || '(none)'} → OFFSET ${want}`);
  }
});

test('NO status → the dashboard\'s ACTIVE set, in rows AND total', async () => {
  const want = ACTIVE_STATUSES.split(',').map(Number);
  const inList = new RegExp(`j\\.job_status IN \\(${want.map(() => '\\?').join(',')}\\)`);
  const { data, count } = await getJobs('?limit=20&offset=0');
  for (const [name, call] of [['data', data], ['COUNT', count]]) {
    assert.match(call.sql, inList, `${name}: completed/cancelled jobs are not Bookings`);
    assert.deepEqual(call.params.slice(0, want.length), want, `${name}: bound to ${ACTIVE_STATUSES}`);
    assert.doesNotMatch(call.sql, /j\.job_status = \?/);
  }
});

test('an explicit status behaves exactly as before: `= ?`, and no IN', async () => {
  for (const status of [3, 0]) {
    const { data, count } = await getJobs(`?status=${status}&limit=20`);
    for (const [name, call] of [['data', data], ['COUNT', count]]) {
      assert.match(call.sql, /j\.job_status = \?/, `${name}: status=${status}`);
      assert.doesNotMatch(call.sql, /j\.job_status IN/, `${name}: status=${status} must not widen`);
      assert.equal(call.params[0], status);
    }
  }
});
