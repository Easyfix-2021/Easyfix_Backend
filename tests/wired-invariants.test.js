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
 *      recording backfill now polls it between rows; since 2026-09-11 the
 *      transcription backfill does too.
 *
 *      The first version of this file checked the scheduler by SOURCE TOKEN,
 *      and passed while broken: registerJob never destructured
 *      cooperativeCancel, so the flag was dropped on registration and no
 *      polling job ever got a Stop button. The check below now registers a job
 *      through the real registerJob and reads getJobs() — the effect, not the
 *      spelling.
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

// ─── 3. the transcription backfill honours the same checkpoint ────────────
function loadTranscription() {
  /* Same seam as loadBackfill: stub plivo.service BEFORE requiring the service. */
  const fetched = [];
  const p = require.resolve(path.join(ROOT, 'services', 'plivo.service'));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: {
    transcriptionEnabled: () => true,
    fetchRecordingMeta: async ({ callUuid }) => { fetched.push(callUuid); return { ok: true, recordingId: `rec-${callUuid}` }; },
    fetchTranscription: async () => ({ ok: true, text: 'hello' }),
  } };
  delete require.cache[require.resolve(path.join(ROOT, 'services', 'call-transcription-cron'))];
  return { svc: require('../services/call-transcription-cron'), fetched };
}

const FIVE_CALLS = [1, 2, 3, 4, 5].map((i) => ({ id: i, callUuid: `uuid-${i}`, status: null, lastAt: null }));
const TX_WRITE = /UPDATE tbl_plivo_call_log SET transcription = \?/;

test('a stop request halts the transcription backfill BETWEEN rows — the started row still writes', async () => {
  const fake = installFakePool([[/FROM tbl_job_caller_info/, () => FIVE_CALLS]]);
  const { svc, fetched } = loadTranscription();
  let asked = 0;
  const result = await svc.runTranscriptionBackfill({ limit: 5, shouldStop: () => (asked++ >= 1) });
  fake.restore();
  assert.equal(fetched.length, 1, 'exactly one row may run before the stop is honoured');
  assert.equal(fake.calls.filter((c) => TX_WRITE.test(c.sql)).length, 1,
    'the row that started must finish its write — never abandoned mid-row');
  assert.equal(result.stopped, true, 'a cancelled run must REPORT that it stopped');
});

test('with no stop requested the transcription backfill runs every row — the positive control', async () => {
  const fake = installFakePool([[/FROM tbl_job_caller_info/, () => FIVE_CALLS]]);
  const { svc, fetched } = loadTranscription();
  const result = await svc.runTranscriptionBackfill({ limit: 5, shouldStop: () => false });
  fake.restore();
  assert.equal(fetched.length, 5);
  assert.equal(fake.calls.filter((c) => TX_WRITE.test(c.sql)).length, 5);
  assert.equal(result.stopped, false);
});

test('each polling job declares cooperativeCancel and its OWN checkpoint inside its own registration', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'scheduler.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  for (const id of ['recording-backfill', 'transcription-backfill']) {
    const at = src.indexOf(`id: '${id}'`);
    assert.ok(at >= 0, `positive control: no registration found for ${id}`);
    const next = src.indexOf('registerJob(', at);
    const block = src.slice(at, next < 0 ? undefined : next);
    assert.match(block, /cooperativeCancel:\s*true/, `${id} must declare cooperative cancellation`);
    assert.ok(block.includes(`shouldStop: () => isCancelRequested('${id}')`), `${id} must be handed its own cancellation check`);
  }
});

test('registerJob KEEPS cooperativeCancel, so getJobs() offers Stop', () => {
  /*
   * The source checks prove the flag is WRITTEN; this proves it ARRIVES. At
   * e18669a registerJob omitted cooperativeCancel from its destructured list, so
   * the flag was dropped and cancellable was false for every polling job while
   * the source check passed. Compile the real file plus one line exposing
   * registerJob; this copy's `jobs` array is private, so nothing leaks.
   */
  const file = path.join(ROOT, 'server', 'scheduler.js');
  const mod = new Module(file, module);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  mod._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports.__registerJob = registerJob;\n', file);
  const { __registerJob, getJobs } = mod.exports;
  const noop = async () => {};
  __registerJob({ id: 'coop', name: 'c', cron: '* * * * *', runner: noop, cooperativeCancel: true });
  __registerJob({ id: 'plain', name: 'p', cron: '* * * * *', runner: noop });
  __registerJob({ id: 'real', name: 'r', cron: '* * * * *', runner: noop, canceller: () => {} });
  const cancellable = Object.fromEntries(getJobs().map((j) => [j.id, j.cancellable]));
  assert.equal(cancellable.real, true, 'control: a canceller job must be offered Stop (proves the projection is read)');
  assert.equal(cancellable.plain, false, 'control: a job with neither half must NOT be offered Stop');
  assert.equal(cancellable.coop, true, 'cooperativeCancel must survive registerJob into getJobs()');
});
