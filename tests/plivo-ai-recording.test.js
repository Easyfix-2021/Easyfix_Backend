/*
 * AI-call recording round trip: startRecording → Plivo → /ai-recording → DB.
 *
 * Both ends were wired to names Plivo does not use: startRecording sent
 * `recording_callback_url` (the Record API argument is `callback_url`), and the
 * handler read `recording_url` (the callback field is `record_url`). Either alone
 * loses every recording. The names below are copied from Plivo's docs, not from
 * our code — a fixture built from the code under test can only pass.
 *   Record API args + callback params: plivo.com/docs/voice/api/call/record-calls/start-recording-a-call
 *
 * Non-destructive: fetch stubbed, fake pool, no network, no DB.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const SESSION = 'ai_0123456789abcdef01234567';
const fake = installFakePool([
  [/SELECT session_id FROM tbl_ai_call_session WHERE call_uuid/i, (sql, [uuid]) => (uuid === 'cu-ai-1' ? [{ session_id: SESSION }] : [])],
  [/UPDATE tbl_ai_call_session SET recording_url/i, { affectedRows: 1 }],
]);
after(() => fake.restore());

const plivo = require('../services/plivo.service');
const aiCall = require('../services/plivo-ai-call.service');
const aiPostCallQueue = require('../services/ai-post-call-queue');
const router = require('../routes/public/plivo-answer');

// Plivo's documented "Start recording a call" arguments — the whole list.
const RECORD_API_ARGS = new Set(['time_limit', 'file_format', 'transcription_type', 'transcription_url',
  'transcription_report_type', 'callback_url', 'callback_method', 'record_channel_type']);

test('startRecording sends only documented Record API args, with callback_url → the mounted /ai-recording', async () => {
  const saved = { fetch: global.fetch, id: process.env.PLIVO_AUTH_ID, tok: process.env.PLIVO_AUTH_TOKEN, base: process.env.PLIVO_CALLBACK_BASE_URL };
  process.env.PLIVO_AUTH_ID = 'MATESTAUTHID';
  process.env.PLIVO_AUTH_TOKEN = 'test-token';
  process.env.PLIVO_CALLBACK_BASE_URL = 'https://core.easyfix.in';
  let sent = null;
  global.fetch = async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return { status: 202, text: async () => '' }; };
  try {
    assert.equal((await aiCall.startRecording('cu-ai-1')).ok, true);
  } finally {
    global.fetch = saved.fetch;
    for (const [k, v] of [['PLIVO_AUTH_ID', saved.id], ['PLIVO_AUTH_TOKEN', saved.tok], ['PLIVO_CALLBACK_BASE_URL', saved.base]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  assert.ok(sent, 'startRecording never reached fetch');
  assert.match(sent.url, /\/Call\/cu-ai-1\/Record\/$/);
  assert.deepEqual(Object.keys(sent.body).filter((k) => !RECORD_API_ARGS.has(k)), [],
    'an undocumented argument is not a callback Plivo will ever make');
  assert.equal(sent.body.callback_url, 'https://core.easyfix.in/api/public/plivo/ai-recording');
  assert.equal(sent.body.callback_method, 'POST');
  assert.equal(sent.body.time_limit, plivo.RECORD_MAX_SEC, '847743e: the 60 s default cap stays lifted');
  // The receiving end exists at that path (routes/public/index.js mounts this router at /plivo).
  assert.ok(router.stack.some((l) => l.route && l.route.path === '/ai-recording' && l.route.methods.post));
});

// The route's handler with express.urlencoded dropped — the test supplies req.body.
function aiRecordingHandler() {
  const layer = router.stack.find((l) => l.route && l.route.path === '/ai-recording' && l.route.methods.post);
  const kept = layer.route.stack.filter((l) => l.handle.name !== 'urlencodedParser');
  assert.equal(kept.length, 1);
  return kept[0].handle;
}

test('/ai-recording stores record_url + recording_duration (seconds) from the documented callback', async () => {
  const realEnqueue = aiPostCallQueue.enqueueTask;
  const tasks = [];
  aiPostCallQueue.enqueueTask = (t) => tasks.push(t);
  const URL_ = 'https://media.plivo.com/v1/Account/MATESTAUTHID/Recording/48dfaf60-3b2a-11e3.mp3';
  try {
    for (const body of [
      // Record API callback_url params, form-encoded (every value a string).
      { api_id: 'c7b69074-58be-11e1-86da-adf28403fe48', record_url: URL_, call_uuid: 'cu-ai-1',
        recording_id: '48dfaf60-3b2a-11e3', recording_duration: '42', recording_duration_ms: '42000',
        recording_start_ms: '1757571000000', recording_end_ms: '1757571042000' },
      // <Record callbackUrl> names — still accepted.
      { CallUUID: 'cu-ai-1', RecordUrl: URL_, RecordingID: '48dfaf60-3b2a-11e3', RecordingDuration: '42', RecordingDurationMs: '42000' },
    ]) {
      fake.reset();
      tasks.length = 0;
      const res = {
        writes: [], statusCode: 200,
        status(c) { this.statusCode = c; return this; }, type() { return this; },
        send(b) { this.writes.push(b); return this; },
      };
      aiRecordingHandler()({ query: {}, body }, res);
      assert.deepEqual([res.statusCode, res.writes], [200, ['ok']], 'ack 200 once, before any DB work');
      assert.equal(tasks.length, 1, `nothing enqueued for ${Object.keys(body).join(',')}`);
      await tasks[0].run();
      const up = fake.calls.find((c) => /UPDATE tbl_ai_call_session SET recording_url/i.test(c.sql));
      assert.ok(up, 'the recording was never written');
      assert.deepEqual(up.params, [URL_, 42, SESSION], 'url + duration in SECONDS (not the _ms field), keyed by call_uuid');
    }
  } finally {
    aiPostCallQueue.enqueueTask = realEnqueue;
  }
});
