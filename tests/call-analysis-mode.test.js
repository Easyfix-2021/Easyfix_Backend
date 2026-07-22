/*
 * Characterization tests for the call-analysis MODE dispatcher
 * (services/call-analysis-mode.service.js) and its provenance contract.
 *
 * Guards the three things that are cheap to regress and expensive to get wrong:
 *   1. mode resolution — per-call override beats the global property, and an
 *      absent/unrecognised property fails CLOSED to 'transcript';
 *   2. fail-closed fallback — 'recording' with no GEMINI_API_KEY runs the
 *      transcript and REPORTS 'transcript', never a silent claim of 'recording';
 *   3. the stored JSON carries `analysis_mode` (provenance lives inside the
 *      existing column — there is no new column to write it to).
 *
 * No network, no DB: the Gemini/Sophy/S3 collaborators are stubbed on their
 * module objects and the route test drives the real Express router over the fake
 * pool. Every collaborator is patched BEFORE requiring the route, because calls.js
 * destructures getEffectivePermissions at require time.
 */

const test = require('node:test');
const assert = require('node:assert');
const { installFakePool } = require('./helpers/fake-pool');

const ANALYSIS = { overall_score: 8, dimensions: [{ name: 'Empathy', score: 8 }] };
const RECORDING_ANALYSIS = { overall_score: 9, dimensions: [{ name: 'Empathy', score: 9 }] };
const TRANSCRIPT = 'agent: hello there, how can I help you today? customer: my ac is not cooling at all.';

// Grant the isClickToCall gate (destructured by calls.js at require time).
require('../services/role.service').getEffectivePermissions = async () => ({
  menuIds: [], actionPermissions: ['isClickToCall'],
});

const properties = require('../services/properties.service');
const callAnalysis = require('../services/call-analysis.service');
const gemini = require('../services/gemini-call-analysis.service');
const callRecording = require('../services/call-recording.service');
const plivo = require('../services/plivo.service');
const analysisMode = require('../services/call-analysis-mode.service');

callAnalysis.llmEnabled = () => true;
callAnalysis.analyzeTranscript = async () => ({ ...ANALYSIS });
plivo.transcriptionEnabled = () => true;
plivo.fetchRecordingMeta = async () => ({ ok: true, recordingId: 'rec-1', url: 'https://x/rec-1' });
plivo.fetchTranscription = async () => ({ ok: true, text: TRANSCRIPT });

// Per-test knobs for the two collaborators the recording leg depends on.
let geminiKeyPresent = false;
let recordingResult = { ok: true, analysis: { ...RECORDING_ANALYSIS } };
let resolvedKey = { key: 'CallRecordings/call_5', reason: null };
let globalModeValue = undefined;

gemini.geminiEnabled = () => geminiKeyPresent;
gemini.analyzeRecording = async () => recordingResult;
callRecording.resolveRecordingKey = async () => resolvedKey;
properties.getProperty = (k) => (k === 'call.analysis.mode' ? globalModeValue : undefined);

function reset() {
  geminiKeyPresent = false;
  recordingResult = { ok: true, analysis: { ...RECORDING_ANALYSIS } };
  resolvedKey = { key: 'CallRecordings/call_5', reason: null };
  globalModeValue = undefined;
}

// ─── mode resolution: override vs global default ──────────────────────

test('mode defaults to transcript when the property is unset (fail closed)', () => {
  reset();
  assert.equal(analysisMode.globalMode(), 'transcript');
  assert.equal(analysisMode.resolveMode(null).mode, 'transcript');
});

test('an unrecognised property value still reads as transcript', () => {
  reset();
  globalModeValue = 'audio';
  assert.equal(analysisMode.globalMode(), 'transcript');
});

test('the global property selects recording when Gemini is configured', () => {
  reset();
  geminiKeyPresent = true;
  globalModeValue = 'recording';
  const r = analysisMode.resolveMode(null);
  assert.equal(r.mode, 'recording');
  assert.equal(r.fellBack, false);
});

test('a per-call override beats the global default in both directions', () => {
  reset();
  geminiKeyPresent = true;
  globalModeValue = 'transcript';
  assert.equal(analysisMode.resolveMode('recording').mode, 'recording');
  globalModeValue = 'recording';
  assert.equal(analysisMode.resolveMode('transcript').mode, 'transcript');
});

test('an absent/blank override falls through to the global default', () => {
  reset();
  geminiKeyPresent = true;
  globalModeValue = 'recording';
  assert.equal(analysisMode.resolveMode(undefined).mode, 'recording');
  assert.equal(analysisMode.resolveMode('').mode, 'recording');
});

// ─── fail-closed fallback when Gemini is unavailable ──────────────────

test('recording mode with no GEMINI_API_KEY resolves to transcript', () => {
  reset();
  globalModeValue = 'recording';
  const r = analysisMode.resolveMode('recording');
  assert.equal(r.mode, 'transcript');
  assert.equal(r.requested, 'recording');
  assert.equal(r.fellBack, true);
  assert.equal(analysisMode.modeAvailable().recording, false);
});

test('analyzeCall reports the mode that ACTUALLY ran, never the one asked for', async () => {
  reset();
  const out = await analysisMode.analyzeCall({ jobCallerInfoId: 5, transcript: TRANSCRIPT, mode: 'recording' });
  assert.equal(out.mode, 'transcript', 'must not claim recording without a key');
  assert.equal(out.requested, 'recording');
  assert.equal(out.fellBack, true);
  assert.equal(out.fallbackReason, 'gemini_disabled');
  assert.equal(out.analysis.analysis_mode, 'transcript');
});

test('analyzeCall degrades to transcript when the audio is too large to send inline', async () => {
  reset();
  geminiKeyPresent = true;
  recordingResult = { ok: false, reason: 'audio_too_large' };
  const out = await analysisMode.analyzeCall({ jobCallerInfoId: 5, transcript: TRANSCRIPT, mode: 'recording' });
  assert.equal(out.mode, 'transcript');
  assert.equal(out.fallbackReason, 'audio_too_large');
  assert.equal(out.analysis.overall_score, 8, 'the transcript analysis is what ran');
});

test('analyzeCall degrades to transcript when the call has no recording', async () => {
  reset();
  geminiKeyPresent = true;
  resolvedKey = { key: null, reason: 'no_recording' };
  const out = await analysisMode.analyzeCall({ jobCallerInfoId: 5, transcript: TRANSCRIPT, mode: 'recording' });
  assert.equal(out.mode, 'transcript');
  assert.equal(out.fallbackReason, 'no_recording');
});

test('recording mode never pays for the transcript when the audio succeeds', async () => {
  reset();
  geminiKeyPresent = true;
  let thunkCalls = 0;
  const out = await analysisMode.analyzeCall({
    jobCallerInfoId: 5,
    transcript: async () => { thunkCalls += 1; return TRANSCRIPT; },
    mode: 'recording',
  });
  assert.equal(out.mode, 'recording');
  assert.equal(out.analysis.analysis_mode, 'recording');
  assert.equal(thunkCalls, 0, 'the transcript must stay lazy when the audio carried the analysis');
});

test('a too-short transcript reports no_transcript rather than a failed analysis', async () => {
  reset();
  const out = await analysisMode.analyzeCall({ jobCallerInfoId: 5, transcript: 'ok', mode: 'transcript' });
  assert.equal(out.analysis, null);
  assert.equal(out.reason, 'no_transcript');
});

test('llm_disabled is reported distinctly from a failed generation', async () => {
  reset();
  const original = callAnalysis.llmEnabled;
  callAnalysis.llmEnabled = () => false;
  try {
    const out = await analysisMode.analyzeCall({ jobCallerInfoId: 5, transcript: TRANSCRIPT, mode: 'transcript' });
    assert.equal(out.analysis, null);
    assert.equal(out.reason, 'llm_disabled');
  } finally { callAnalysis.llmEnabled = original; }
});

// ─── provenance: analysis_mode inside the stored JSON (no new column) ──

function baseRoutes({ cachedAnalysis = null } = {}) {
  return [
    [/SHOW COLUMNS FROM tbl_plivo_call_log/i, [{ Field: 'x' }]],
    [/SELECT caller_id\s+FROM tbl_job_caller_info/i, [{ caller_id: 7 }]],
    [/SELECT transcription, transcription_status/i, [{
      transcription: TRANSCRIPT, transcription_status: 'completed',
      call_uuid: 'uuid-1', caller_user_id: 7,
      call_analysis: cachedAnalysis ? JSON.stringify(cachedAnalysis) : null,
    }]],
    [/SELECT call_uuid, caller_user_id/i, [{ call_uuid: 'uuid-1', caller_user_id: 7 }]],
    [/SELECT call_analysis, ended_on/i, [{ call_analysis: JSON.stringify(ANALYSIS), ended_on: null, initiated_on: null }]],
    [/SELECT coverage_json FROM tbl_teleprompter_session/i, []],
  ];
}

function drive(router, { method = 'GET', url, user }) {
  return new Promise((resolve, reject) => {
    const q = url.includes('?') ? Object.fromEntries(new URLSearchParams(url.split('?')[1])) : {};
    const req = { method, url, user, body: {}, query: q, headers: {} };
    const res = {
      statusCode: 200,
      body: null,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; resolve(this); return this; },
    };
    router.handle(req, res, (e) => (e ? reject(e) : resolve(res)));
  });
}

const ADMIN = { user_id: 99, user_role: 2 };

test('a stored transcript analysis carries analysis_mode inside the existing JSON', async () => {
  reset();
  const fake = installFakePool(baseRoutes());
  try {
    const router = require('../routes/admin/calls');
    const res = await drive(router, { url: '/5/analysis', user: ADMIN });
    assert.equal(res.body.data.status, 'ready');
    assert.equal(res.body.data.mode, 'transcript');

    const stored = fake.calls.find((c) => /SET call_analysis = \?/i.test(c.sql));
    assert.ok(stored, 'expected the analysis to be cached on the row');
    const written = JSON.parse(stored.params[0]);
    assert.equal(written.analysis_mode, 'transcript', 'provenance must be inside the JSON');
    // Hard constraint: provenance is a JSON key, never a new column.
    for (const c of fake.calls) {
      assert.ok(!/analysis_mode\s*=/i.test(c.sql), 'analysis_mode must never be a column: ' + c.sql);
      assert.ok(!/ALTER TABLE/i.test(c.sql), 'no schema change may be issued: ' + c.sql);
    }
  } finally { fake.restore(); }
});

test('a stored recording analysis is stamped analysis_mode=recording', async () => {
  reset();
  geminiKeyPresent = true;
  globalModeValue = 'recording';
  const fake = installFakePool(baseRoutes());
  try {
    const router = require('../routes/admin/calls');
    const res = await drive(router, { url: '/5/analysis', user: ADMIN });
    assert.equal(res.body.data.status, 'ready');
    assert.equal(res.body.data.mode, 'recording');
    assert.equal(res.body.data.analysis.analysis_mode, 'recording');

    const stored = fake.calls.find((c) => /SET call_analysis = \?/i.test(c.sql));
    assert.equal(JSON.parse(stored.params[0]).analysis_mode, 'recording');
  } finally { fake.restore(); }
});

test('the response advertises modeAvailable so the FE can disable the audio option', async () => {
  reset();
  const fake = installFakePool(baseRoutes());
  try {
    const router = require('../routes/admin/calls');
    const res = await drive(router, { url: '/5/analysis', user: ADMIN });
    assert.deepEqual(res.body.data.modeAvailable, { transcript: true, recording: false });
  } finally { fake.restore(); }
});

test('a cached analysis reports the mode that produced it, not the current default', async () => {
  reset();
  geminiKeyPresent = true;
  globalModeValue = 'recording';
  const fake = installFakePool(baseRoutes({ cachedAnalysis: { ...ANALYSIS, analysis_mode: 'transcript' } }));
  try {
    const router = require('../routes/admin/calls');
    const res = await drive(router, { url: '/5/analysis', user: ADMIN });
    assert.equal(res.body.data.status, 'ready');
    assert.equal(res.body.data.mode, 'transcript', 'must not relabel a cached transcript analysis');
    assert.ok(
      !fake.calls.some((c) => /SET call_analysis = \?/i.test(c.sql)),
      'a cache hit must not regenerate',
    );
  } finally { fake.restore(); }
});

test('an explicit ?mode= that differs from the cache regenerates in the asked-for mode', async () => {
  reset();
  geminiKeyPresent = true;
  const fake = installFakePool(baseRoutes({ cachedAnalysis: { ...ANALYSIS, analysis_mode: 'transcript' } }));
  try {
    const router = require('../routes/admin/calls');
    const res = await drive(router, { url: '/5/analysis?mode=recording', user: ADMIN });
    assert.equal(res.body.data.mode, 'recording');
    assert.equal(JSON.parse(fake.calls.find((c) => /SET call_analysis = \?/i.test(c.sql)).params[0]).analysis_mode, 'recording');
  } finally { fake.restore(); }
});

test('an unavailable recording override serves the cache instead of regenerating every view', async () => {
  reset();
  const fake = installFakePool(baseRoutes({ cachedAnalysis: { ...ANALYSIS, analysis_mode: 'transcript' } }));
  try {
    const router = require('../routes/admin/calls');
    const res = await drive(router, { url: '/5/analysis?mode=recording', user: ADMIN });
    assert.equal(res.body.data.mode, 'transcript');
    assert.ok(
      !fake.calls.some((c) => /SET call_analysis = \?/i.test(c.sql)),
      'no key ⇒ the resolved mode is transcript, which the cache already is',
    );
  } finally { fake.restore(); }
});

test('an unrecognised mode is a 400, never a silent default', async () => {
  reset();
  const fake = installFakePool(baseRoutes());
  try {
    const router = require('../routes/admin/calls');
    const res = await drive(router, { url: '/5/analysis?mode=audio', user: ADMIN });
    assert.equal(res.statusCode, 400);
  } finally { fake.restore(); }
});

test('the call list projects analysis_mode so every scored row can show its provenance', async () => {
  reset();
  const fake = installFakePool([
    [/SHOW COLUMNS FROM tbl_plivo_call_log/i, [{ Field: 'x' }]],
    [/COUNT\(\*\) AS total/i, [{ total: 0 }]],
  ]);
  try {
    const router = require('../routes/admin/calls');
    await drive(router, { url: '/', user: ADMIN });
    const list = fake.calls.find((c) => /FROM tbl_job_caller_info jci/i.test(c.sql) && /LIMIT \? OFFSET \?/i.test(c.sql));
    assert.ok(list, 'expected the paged list query');
    // Extracted from the existing JSON alongside the score — no new column.
    assert.match(list.sql, /JSON_EXTRACT\(pcl\.call_analysis, '\$\.analysis_mode'\)\)/);
    assert.match(list.sql, /END AS analysis_mode/);
    assert.match(list.sql, /JSON_EXTRACT\(pcl\.call_analysis, '\$\.overall_score'\)\) AS score/);
    /*
     * An analysis with no marker predates recording mode, so it IS transcript —
     * resolve it here rather than leaving it null, or the same row reads "no
     * chip" in the list and "Transcript" in the modal (analysisModeOf() defaults
     * the same way). NULL keeps its one honest meaning: no analysis at all.
     */
    assert.match(list.sql, /COALESCE\(JSON_UNQUOTE\(JSON_EXTRACT\(pcl\.call_analysis, '\$\.analysis_mode'\)\), 'transcript'\)/);
    assert.match(list.sql, /CASE WHEN pcl\.call_analysis IS NULL THEN NULL/);
  } finally { fake.restore(); }
});
