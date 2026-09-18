/*
 * Plivo transcription COST capture + the short-call floor.
 *
 *   1. fetchTranscription surfaces Plivo's per-transcript `cost` (USD). The
 *      response shape is the one the live account returned on 2026-09-17 —
 *      { api_id, cost, rate, recording_duration_ms, recording_start_ms, status,
 *      transcription } — not an invented one.
 *   2. saveTranscript writes the cost in a SECOND statement whose failure (the
 *      column not migrated yet) must never lose the transcript itself.
 *   3. The backfill cron never requests a transcript for a call shorter than
 *      MIN_TRANSCRIBE_SECONDS — Plivo bills those as a full minute.
 *
 * Runner: `node --test` (see npm test).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

process.env.PLIVO_AUTH_ID = process.env.PLIVO_AUTH_ID || 'MATEST';
process.env.PLIVO_AUTH_TOKEN = process.env.PLIVO_AUTH_TOKEN || 'token';

const LIVE_BODY = {
  api_id: '0564e288-fdd7-487b-8e5f-5c757d5c4c49',
  cost: 0.0285,
  rate: 0.0095,
  recording_duration_ms: 128240,
  recording_start_ms: 1789630356973,
  status: 'success',
  transcription: 'Speaker 0: Hello.',
};

async function fetchWith(body) {
  const plivo = require('../services/plivo.service');
  const original = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => body });
  try { return await plivo.fetchTranscription({ recordingId: 'rec-1' }); } finally { global.fetch = original; }
}

test('fetchTranscription returns the live response cost; missing or null cost is null, never 0', async () => {
  assert.equal((await fetchWith(LIVE_BODY)).cost, 0.0285);
  assert.equal((await fetchWith({ ...LIVE_BODY, cost: '0.00950' })).cost, 0.0095);
  const { cost: _c, ...noCost } = LIVE_BODY;
  assert.equal((await fetchWith(noCost)).cost, null);
  assert.equal((await fetchWith({ ...LIVE_BODY, cost: null })).cost, null);
});

const TX_WRITE = /SET transcription = \?/;
const COST_WRITE = /SET transcription_cost_usd = \?/;

test('saveTranscript writes transcript then cost; skips the cost statement when Plivo sent none', async () => {
  const fake = installFakePool();
  const { saveTranscript } = require('../services/call-transcription-cron');
  try {
    await saveTranscript(7, { text: 'hi', cost: 0.0285 });
    assert.deepEqual(fake.calls.map((c) => (TX_WRITE.test(c.sql) ? 'tx' : COST_WRITE.test(c.sql) ? 'cost' : c.sql)), ['tx', 'cost']);
    assert.deepEqual(fake.calls[1].params, [0.0285, 7]);
    fake.reset();
    await saveTranscript(7, { text: 'hi', cost: null });
    assert.equal(fake.calls.filter((c) => COST_WRITE.test(c.sql)).length, 0);
  } finally { fake.restore(); }
});

test('a failing cost write (column not migrated) still stores the transcript and does not throw', async () => {
  const fake = installFakePool([[COST_WRITE, () => { throw new Error("Unknown column 'transcription_cost_usd'"); }]]);
  const { saveTranscript } = require('../services/call-transcription-cron');
  try {
    await saveTranscript(7, { text: 'hi', cost: 0.0095 });
    assert.equal(fake.calls.filter((c) => TX_WRITE.test(c.sql)).length, 1);
    assert.equal(fake.calls.filter((c) => COST_WRITE.test(c.sql)).length, 1, 'the cost write must have been attempted');
  } finally { fake.restore(); }
});

/*
 * A conference call has one tbl_plivo_call_log row per LEG, all sharing the
 * job_caller_info_id, so an ungrouped JOIN hands the cron the same call once per
 * leg. Verified read-only against the QA database with every log row duplicated:
 * ungrouped 18 -> 36 rows, grouped stays 18, and `LIMIT 10` ungrouped covered
 * only 5 distinct calls — the duplicates ate the batch.
 */
test('the eligibility query returns ONE row per call, not one per conference leg', async () => {
  const plivo = require('../services/plivo.service');
  const originalEnabled = plivo.transcriptionEnabled;
  plivo.transcriptionEnabled = () => true;
  const fake = installFakePool();
  const cron = require('../services/call-transcription-cron');
  try {
    await cron.runTranscriptionBackfill({ limit: 5 });
    const select = fake.calls.find((c) => /FROM tbl_job_caller_info/.test(c.sql));
    assert.match(select.sql, /GROUP BY\s+jci\.job_caller_info/, 'one row per call');
    // The grouped columns must be aggregated, or MySQL's ONLY_FULL_GROUP_BY rejects the query.
    assert.match(select.sql, /MAX\(pcl\.transcription_status\)/);
    assert.match(select.sql, /MAX\(pcl\.transcription_fetched_at\)/);
  } finally { fake.restore(); plivo.transcriptionEnabled = originalEnabled; }
});

test('the backfill cron binds MIN_TRANSCRIBE_SECONDS as its call-duration floor', async () => {
  const plivo = require('../services/plivo.service');
  const originalEnabled = plivo.transcriptionEnabled;
  plivo.transcriptionEnabled = () => true;
  const fake = installFakePool();
  const cron = require('../services/call-transcription-cron');
  try {
    await cron.runTranscriptionBackfill({ limit: 5 });
    const select = fake.calls.find((c) => /FROM tbl_job_caller_info/.test(c.sql));
    assert.ok(select, 'the eligibility SELECT must have run');
    assert.match(select.sql, /jci\.duration >= \?/);
    assert.equal(cron.MIN_TRANSCRIBE_SECONDS, 15);
    assert.deepEqual(select.params, [15, 5]);
  } finally { fake.restore(); plivo.transcriptionEnabled = originalEnabled; }
});

// ─── cost backfill for transcripts stored before the cost was captured ───
test('backfillTranscriptionCosts matches Plivo list call_uuid to jci.unique_id and stops at the oldest missing row', async () => {
  const plivo = require('../services/plivo.service');
  const cron = require('../services/call-transcription-cron');
  const newest = Date.UTC(2026, 8, 17, 8, 0, 0);
  const ts = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00:00');
  // 100 transcriptions, one per hour going back; two of them are ours.
  const list = Array.from({ length: 100 }, (_, i) => ({
    call_uuid: `u${i}`, transcription_cost: i === 3 ? '0.02850' : '0.00950', add_time: ts(newest - i * 3600_000),
  }));
  const originalList = plivo.listPage;
  const requested = [];
  plivo.listPage = async (path) => {
    requested.push(path);
    const offset = Number(/offset=(\d+)/.exec(path)[1]);
    return list.slice(offset, offset + 20);
  };
  const fake = installFakePool([
    [/SELECT DISTINCT jci\.unique_id/, () => [
      { callUuid: 'u3', insertedAt: new Date(newest - 3 * 3600_000) },
      { callUuid: 'u25', insertedAt: new Date(newest - 25 * 3600_000) },
      { callUuid: 'gone', insertedAt: new Date(newest - 30 * 3600_000) },
    ]],
    [/SET pcl\.transcription_cost_usd = \?/, () => ({ affectedRows: 1 })],
  ]);
  try {
    const r = await cron.backfillTranscriptionCosts();
    const updates = fake.calls.filter((c) => /SET pcl\.transcription_cost_usd/.test(c.sql)).map((c) => c.params);
    assert.deepEqual(updates, [[0.0285, 'u3'], [0.0095, 'u25']]);
    assert.equal(r.filled, 2);
    assert.equal(r.unmatched, 1, 'a row Plivo has no transcription for is reported, not retried forever');
    // oldest missing row is 30h back → floor 54h back → page 3 (items 40–59, down to 59h) is the last read.
    assert.equal(requested.length, 3);
  } finally { fake.restore(); plivo.listPage = originalList; }
});

test('backfillTranscriptionCosts reads nothing from Plivo when no row is missing a cost', async () => {
  const plivo = require('../services/plivo.service');
  const cron = require('../services/call-transcription-cron');
  const originalList = plivo.listPage;
  let pages = 0;
  plivo.listPage = async () => { pages += 1; return []; };
  const fake = installFakePool([[/SELECT DISTINCT jci\.unique_id/, () => []]]);
  try {
    const r = await cron.backfillTranscriptionCosts();
    assert.equal(r.missing, 0);
    assert.equal(pages, 0);
  } finally { fake.restore(); plivo.listPage = originalList; }
});

test('a second run does not re-read Plivo for a call it already failed to match', async () => {
  const plivo = require('../services/plivo.service');
  const cron = require('../services/call-transcription-cron');
  const originalList = plivo.listPage;
  let pages = 0;
  // Plivo has no transcription for this call_uuid — the first run walks to its
  // floor and finds nothing; the second must not walk at all.
  plivo.listPage = async (path) => {
    pages += 1;
    const offset = Number(/offset=(\d+)/.exec(path)[1]);
    return offset === 0 ? [{ call_uuid: 'someone-else', transcription_cost: '0.00950', add_time: '2026-09-17 08:00:00+00:00' }] : [];
  };
  const rows = [{ callUuid: 'no-transcript-on-plivo', insertedAt: new Date('2026-09-17T07:00:00Z') }];
  const fake = installFakePool([[/SELECT DISTINCT jci\.unique_id/, () => rows]]);
  try {
    const first = await cron.backfillTranscriptionCosts();
    assert.equal(first.unmatched, 1);
    assert.equal(first.knownUnmatched, 0);
    assert.ok(pages > 0, 'the first run must actually read the list');

    pages = 0;
    const second = await cron.backfillTranscriptionCosts();
    assert.equal(pages, 0, 'a known-unmatched row must never re-read Plivo');
    assert.equal(second.missing, 1);
    assert.equal(second.knownUnmatched, 1);
    assert.equal(second.filled, 0);
  } finally { fake.restore(); plivo.listPage = originalList; }
});
