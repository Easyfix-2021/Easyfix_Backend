/*
 * pruneConferenceFallback + alertRecordingProblem (2026-10-01).
 *
 * A conference call is recorded twice: the <Record> SAFETY NET (stereo, from
 * operator join, ringback included) and the MPC room recording (mono, from
 * answer). Once the room recording has replaced the fallback, the fallback is
 * deleted from Plivo — PERMANENTLY — so every guard below is a reason to KEEP
 * it, and each is asserted to keep it.
 *
 * Runner: `node --test`.
 */

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

let props = [];
installFakePool([[/FROM easyfix_properties/i, () => props]]);

const properties = require('../services/properties.service');
const plivo = require('../services/plivo.service');
const transcribe = require('../services/transcribe-call-analytics.service');
const email = require('../services/email.service');
const alerts = require('../services/plivo-balance-alert-cron');
const conf = require('../services/plivo-conference.service');

// Recording objects as Plivo returns them (fields verified on the live account
// 2026-10-01: room c631022f… / fallback 03eab857…, conf 8759).
const ROOM = { recording_id: 'room-1', recording_type: 'multipartycall', recording_start_ms: '1790829726362', recording_end_ms: '1790829770602' };
const FALLBACK = { recording_id: 'fb-1', recording_type: 'call', recording_start_ms: '1790829722382', recording_end_ms: '1790829770302' };

let recs;
let deleted;
let mails;
before(async () => { await properties.preload(); });
beforeEach(async () => {
  props = [];
  await properties.flushCache();
  recs = { 'room-1': ROOM, 'fb-1': FALLBACK };
  deleted = [];
  mails = [];
  plivo.getRecording = async (id) => recs[id] || null;
  plivo.deleteRecording = async (id) => { deleted.push(id); return { ok: true, httpStatus: 204 }; };
  transcribe.enabled = () => false;
  email.send = async (m) => { mails.push(m); };
  alerts.enabledForEnvironment = () => true;
  alerts.recipients = () => ['ops@easyfix.in'];
});

const prune = () => conf.pruneConferenceFallback({ roomId: 'room-1', fallbackId: 'fb-1', jci: 5001 });

test('deletes the fallback once the room recording covers the call to its end', async () => {
  const r = await prune();
  assert.equal(r.deleted, true);
  assert.deepEqual(deleted, ['fb-1'], 'the FALLBACK — never the room recording');
});

test('KEEPS it while Call Analytics is on — the room file is mono, analytics needs stereo', async () => {
  transcribe.enabled = () => true;
  assert.equal((await prune()).deleted, false);
  assert.deepEqual(deleted, []);
});

test('KEEPS it when the kill switch is off', async () => {
  props = [{ property_key: 'plivo.recording.prune_fallback', property_value: 'false' }];
  await properties.flushCache();
  assert.equal((await prune()).deleted, false);
  assert.deepEqual(deleted, []);
});

test('KEEPS it when the room recording stopped early — the fallback holds audio it lacks', async () => {
  recs['room-1'] = { ...ROOM, recording_end_ms: String(Number(FALLBACK.recording_end_ms) - 6000) };
  assert.equal((await prune()).deleted, false);
  assert.deepEqual(deleted, []);
});

test('KEEPS it when either recording cannot be read, or the types are not room/call', async () => {
  delete recs['room-1'];
  assert.equal((await prune()).deleted, false);
  recs['room-1'] = { ...ROOM, recording_type: 'call' };
  assert.equal((await prune()).deleted, false);
  recs['room-1'] = ROOM;
  recs['fb-1'] = { ...FALLBACK, recording_type: 'multipartycall' };
  assert.equal((await prune()).deleted, false);
  assert.deepEqual(deleted, []);
});

test('KEEPS it when both ids are the same file', async () => {
  assert.equal((await conf.pruneConferenceFallback({ roomId: 'fb-1', fallbackId: 'fb-1', jci: 5001 })).deleted, false);
  assert.deepEqual(deleted, []);
});

test('a recording problem emails the Plivo ops list — once per hour, Production only, never with no recipients', async () => {
  alerts.enabledForEnvironment = () => false;
  assert.equal((await conf.alertRecordingProblem('x')).why, 'environment');
  alerts.enabledForEnvironment = () => true;
  alerts.recipients = () => [];
  assert.equal((await conf.alertRecordingProblem('x')).why, 'no-recipients');
  alerts.recipients = () => ['ops@easyfix.in'];

  assert.equal((await conf.alertRecordingProblem('Plivo MPCRecordingFailed · jci=5001')).sent, true);
  assert.equal(mails.length, 1);
  assert.deepEqual(mails[0].to, ['ops@easyfix.in']);
  assert.match(mails[0].text, /MPCRecordingFailed · jci=5001/);
  assert.match(mails[0].text, /fallback still records/, 'says calls are NOT being lost — so nobody panics');
  assert.equal((await conf.alertRecordingProblem('again')).why, 'throttled');
  assert.equal(mails.length, 1);
});
