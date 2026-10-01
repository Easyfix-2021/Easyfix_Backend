/*
 * Call Analytics on CONFERENCE calls uses the STEREO fallback (2026-10-01).
 *
 * A conference leg stores and plays the MPC room recording, which is MONO;
 * Call Analytics' ChannelDefinitions need ch0 agent / ch1 customer — the
 * <Record> safety-net file. These pin which audio each kind of call is sent
 * with, and that a conference with no stereo file left stops taking a slot.
 *
 * Runner: `node --test`.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

let pending = [];
const fake = installFakePool([
  [/call_metrics_status = 'processing' AND call_analytics_job_name IS NOT NULL/i, () => []],
  [/WHERE pcl\.call_metrics_status IS NULL/i, () => pending],
  [/^\s*UPDATE /i, () => ({ affectedRows: 1 })],
]);

// Stubbed BEFORE the cron is required — it destructures these at load.
const rec = require('../services/call-recording.service');
const calls = [];
rec.ensureRecordingInS3 = async (a) => { calls.push(['mono', a.jci]); return 'CallRecordings/call_' + a.jci; };
let stereoKey = 'CallRecordings/call_X_stereo';
rec.ensureStereoRecordingInS3 = async (a) => { calls.push(['stereo', a.jci, a.callUuid]); return stereoKey; };
const transcribe = require('../services/transcribe-call-analytics.service');
transcribe.enabled = () => true;
const started = [];
transcribe.startJob = async (j) => { started.push(j.recordingKey); return { ok: true }; };

const { runCallMetrics } = require('../services/call-metrics-cron');

beforeEach(() => { fake.reset(); calls.length = 0; started.length = 0; stereoKey = 'CallRecordings/call_X_stereo'; });

test('a conference call is analysed from the STEREO fallback; a 1:1 call is unchanged', async () => {
  pending = [
    { jci: 1, callUuid: 'op-leg-uuid', recording: null, conferenceId: 77, recordingUrl: 'https://media.plivo.com/room.mp3' },
    { jci: 2, callUuid: 'bridge-uuid', recording: null, conferenceId: null, recordingUrl: null },
  ];
  const r = await runCallMetrics();
  assert.deepEqual(calls, [['stereo', 1, 'op-leg-uuid'], ['mono', 2]]);
  assert.deepEqual(started, ['CallRecordings/call_X_stereo', 'CallRecordings/call_2']);
  assert.equal(r.started, 2);
});

test('only the OPERATOR leg of a conference is picked up — not one job per leg', async () => {
  pending = [];
  await runCallMetrics();
  const sel = fake.calls.find((c) => /WHERE pcl\.call_metrics_status IS NULL/i.test(c.sql));
  assert.match(sel.sql, /pcl\.conference_id IS NULL OR pcl\.participant_role = 'operator'/);
});

test('a conference with its room recording in but NO stereo file is failed, not retried for 7 days', async () => {
  stereoKey = null;
  pending = [{ jci: 3, callUuid: 'op', recording: null, conferenceId: 78, recordingUrl: 'https://media.plivo.com/room.mp3' }];
  const r = await runCallMetrics();
  assert.equal(r.failed, 1);
  assert.equal(started.length, 0);
  const upd = fake.calls.find((c) => /SET call_metrics_status = 'failed'/.test(c.sql));
  assert.ok(upd && upd.params.includes(3));
});

test('…but one whose recordings are not in yet is left for the next run', async () => {
  stereoKey = null;
  pending = [{ jci: 4, callUuid: 'op', recording: null, conferenceId: 79, recordingUrl: null }];
  const r = await runCallMetrics();
  assert.equal(r.noRecording, 1);
  assert.equal(fake.calls.some((c) => /SET call_metrics_status = 'failed'/.test(c.sql)), false);
});
