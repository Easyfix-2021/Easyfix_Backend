const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * What three schema probes do when the probe ITSELF fails.
 *
 * Not "when the column is missing" — that answer is fine everywhere and is
 * the whole point of probing. This is the other case: information_schema
 * did not answer. A survey of all 23 probes in this backend found 17 that
 * answered "the feature is absent" AND cached that answer for the life of the
 * process, which turns a two-second blip into a degraded mode lasting until
 * someone restarts the container, with nothing in the logs saying so.
 *
 * These three were the live ones, and each degrades differently, so each is
 * pinned differently. The shared rule is only this: a failure is never cached.
 */

const PROBE = /INFORMATION_SCHEMA/i;

const fake = installFakePool();
const clientSvc = require('../services/client.service');
const docsSvc = require('../services/client-documents.service');
const lifecycleSvc = require('../services/mobile-job-lifecycle.service');

after(() => fake.restore());

// Route queries; `probe` is 'throw', or the rows the probe should return.
function withProbe(probe, extra = []) {
  const db = require('../db');
  const previous = db.pool.query;
  let probeCalls = 0;
  db.pool.query = async (sql, params) => {
    const text = Array.isArray(sql) ? String(sql[0]) : String(sql);
    fake.calls.push({ sql: text, params });
    if (PROBE.test(text)) {
      probeCalls++;
      if (probe === 'throw') throw new Error('information_schema unreachable');
      return [probe, []];
    }
    for (const [re, resp] of extra) {
      if (re.test(text)) return [typeof resp === 'function' ? resp(text, params) : resp, []];
    }
    return [[], []];
  };
  return { restore: () => { db.pool.query = previous; }, probes: () => probeCalls };
}

// ─── client.service: a failed probe must not narrow a WRITE ──────────

test('getClientColumns propagates instead of returning a partial column set', async () => {
  const h = withProbe('throw');
  await assert.rejects(() => clientSvc.getClientColumns(),
    'a probe that did not answer must not be reported as "these are the columns" — '
    + 'both callers drop unlisted columns from the statement SILENTLY');
  h.restore();
});

test('a failed client column probe is not remembered', async () => {
  let h = withProbe('throw');
  await assert.rejects(() => clientSvc.getClientColumns());
  h.restore();

  // The next caller must re-probe and succeed, not await the rejected promise.
  h = withProbe([{ COLUMN_NAME: 'client_id' }, { COLUMN_NAME: 'billing_name' }]);
  const cols = await clientSvc.getClientColumns();
  h.restore();
  assert.ok(cols.has('billing_name'),
    'caching the failure is what made every later client save discard billing '
    + 'and KYC fields under a "Client updated." toast');
});

// ─── client-documents: "did not answer" is not "not provisioned" ─────

test('hasTable propagates rather than declaring the table absent', async () => {
  const h = withProbe('throw');
  await assert.rejects(() => docsSvc.hasTable(),
    'a false here does not degrade, it asserts — the portal tells the client '
    + 'their KYC checklist is unprovisioned');
  h.restore();
});

test('a genuinely missing table still answers false, from a real probe', async () => {
  const h = withProbe([]); // probe SUCCEEDS, returns no rows
  const present = await docsSvc.hasTable();
  h.restore();
  assert.equal(present, false,
    'the un-migrated case must be unaffected — that is an ANSWER, not a failure');
});

// ─── mobile-job-lifecycle: soft-fail is right, permanence is not ─────

// Both entry points resolve ownership first; without this they 404 before the
// probe ever runs and the test would pass while proving nothing.
const OWNED = [[
  /SELECT job_id, job_status, fk_easyfixter_id/i,
  [{ job_id: 101, job_status: 2, fk_easyfixter_id: 8379, fk_customer_id: 1, fk_client_id: 1, otp: null }],
]];

test('hasJobColumn still soft-fails to false so cancel() keeps working', async () => {
  const h = withProbe('throw', OWNED);
  const res = await lifecycleSvc.cancel(101, 8379, { reasonId: 4 })
    .then(() => 'ok', (e) => e);
  h.restore();
  // cancel() wraps the mirror in its own try/catch; what matters is that the
  // probe failure did not become the caller's problem.
  assert.ok(!(res instanceof Error) || !/information_schema/.test(res.message),
    'an optional reporting mirror must never fail the cancel it describes');
});

test('a failed tbl_job column probe is not remembered', async () => {
  let h = withProbe('throw', OWNED);
  await lifecycleSvc.saveSelfie(101, 8379, { selfieImageId: 9 }).catch(() => {});
  const firstProbes = h.probes();
  h.restore();
  assert.ok(firstProbes > 0, 'the probe should have run');

  // Same column again: must re-probe, not serve a cached false.
  h = withProbe([{ 1: 1 }], [...OWNED, [/UPDATE tbl_job SET tx_selfie_id/i, { affectedRows: 1 }]]);
  await lifecycleSvc.saveSelfie(101, 8379, { selfieImageId: 9 }).catch(() => {});
  const reProbed = h.probes();
  h.restore();
  assert.ok(reProbed > 0,
    'caching the failure pinned tx_selfie_id as missing, so saveSelfie threw '
    + '501 "column not present on this deployment" — untrue — until restart');
});
