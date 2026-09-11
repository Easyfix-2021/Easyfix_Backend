/*
 * TWO INVARIANTS THAT WERE DECLARED AND NEVER ENFORCED — now enforced, and
 * pinned here so they cannot quietly lapse back.
 *
 * Both were found on 2026-09-10 by scripts/dead-exports.js as exports nothing
 * read. In each case the unused export was the only evidence a contract was
 * half-built, which is why the sweep reports its findings instead of deleting
 * them. (The third — OTP_MAX_ATTEMPTS — has its own file,
 * tests/otp-attempt-cap.test.js.)
 *
 *   1. OFFER_CLOSED_REASON_MAX_LENGTH = 40 mirrors tbl_job_offer.closed_reason
 *      VARCHAR(40). Nothing checked it. It is now asserted over the enum at
 *      require time, so a reason that cannot be stored stops the process at
 *      boot instead of truncating an audit column in production.
 *
 *   2. server/scheduler.js offered isCancelRequested() and promised "any job
 *      can READ isCancelRequested() at a checkpoint and bail cleanly". No job
 *      did, so requestCancel() had a live route behind it and no reader. The
 *      recording backfill now polls it between rows.
 *
 * Runner: `node --test` (see npm test).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { installFakePool } = require('./helpers/fake-pool');

const ROOT = path.join(__dirname, '..');

// ─── 1. the closed-reason length guard ────────────────────────────────────
test('every closed_reason fits the column it is written to', () => {
  const m = require('../services/offer-closed-reason');
  const values = Object.values(m.OFFER_CLOSED_REASON);
  assert.ok(values.length > 0, 'positive control: the enum must not be empty');
  for (const v of values) {
    assert.ok(v.length <= m.OFFER_CLOSED_REASON_MAX_LENGTH,
      `"${v}" is ${v.length} chars; the column is VARCHAR(${m.OFFER_CLOSED_REASON_MAX_LENGTH})`);
  }
});

test('a reason too long for the column STOPS the module loading', () => {
  /*
   * The behavioural control. The test above passes today whether or not the
   * guard exists, because every current value is short. So compile the REAL
   * source with one value lengthened past the column and require the throw —
   * proof the guard is load-bearing, not decorative.
   */
  const file = path.join(ROOT, 'services', 'offer-closed-reason.js');
  const src = fs.readFileSync(file, 'utf8');
  const target = "'technician_restricted'";
  assert.ok(src.includes(target), 'positive control: the value being lengthened must exist');
  const tooLong = `'${'x'.repeat(41)}'`;
  const mutated = src.replace(target, tooLong);
  const mod = new Module(file, module);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  assert.throws(() => mod._compile(mutated, file), /VARCHAR\(40\)/,
    'a 41-char reason must refuse to load, naming the column width');
});

// ─── 2. the cooperative-cancellation checkpoint ───────────────────────────
function loadBackfill() {
  /* Stub the two collaborators the loop calls, BEFORE requiring the service —
   * it captures them at require time. */
  const fetched = [];
  const stub = (rel, exp) => {
    const p = require.resolve(path.join(ROOT, 'services', rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports: exp };
  };
  stub('plivo.service', {
    fetchRecordingMeta: async ({ callUuid }) => { fetched.push(callUuid); return { ok: false }; },
  });
  stub('plivo-call-log.service', { setRecording: async () => {} });
  delete require.cache[require.resolve(path.join(ROOT, 'services', 'recording-backfill.service'))];
  return { svc: require('../services/recording-backfill.service'), fetched };
}

const FIVE_ROWS = [1, 2, 3, 4, 5].map((i) => ({ jci: i, call_uuid: `uuid-${i}` }));

test('a stop request halts the backfill BETWEEN rows and says so', async () => {
  const fake = installFakePool([[/FROM tbl_plivo_call_log/, () => FIVE_ROWS]]);
  const { svc, fetched } = loadBackfill();
  let asked = 0;
  // Stop after the first row has been processed.
  const result = await svc.backfillMissingRecordings({ limit: 5, shouldStop: () => (asked++ >= 1) });
  fake.restore();
  assert.equal(fetched.length, 1, 'exactly one row may run before the stop is honoured');
  assert.equal(result.stopped, true, 'a cancelled run must REPORT that it stopped');
});

test('with no stop requested the backfill runs every row — the positive control', async () => {
  // Without this, a loop that always broke on the first row would pass the
  // test above and be indistinguishable from a working checkpoint.
  const fake = installFakePool([[/FROM tbl_plivo_call_log/, () => FIVE_ROWS]]);
  const { svc, fetched } = loadBackfill();
  const result = await svc.backfillMissingRecordings({ limit: 5, shouldStop: () => false });
  fake.restore();
  assert.equal(fetched.length, 5);
  assert.equal(result.stopped, false);
});

test('the scheduler wires the checkpoint AND advertises the job as cancellable', () => {
  /*
   * Both halves, because either alone is a lie: a poll the scheduler never
   * passes in makes Stop do nothing; a cancellable flag without the poll shows
   * a Stop button that does nothing. Comments stripped so prose cannot pass.
   */
  const src = fs.readFileSync(path.join(ROOT, 'server', 'scheduler.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  assert.match(src, /shouldStop:\s*\(\)\s*=>\s*isCancelRequested\('recording-backfill'\)/,
    'the recording backfill must be handed the cancellation check');
  assert.match(src, /cooperativeCancel:\s*true/, 'the job must declare cooperative cancellation');
  assert.match(src, /cancellable:\s*typeof j\.canceller === 'function' \|\| j\.cooperativeCancel === true/,
    'a polling job must be offered a Stop button, or its checkpoint is unreachable');
});
