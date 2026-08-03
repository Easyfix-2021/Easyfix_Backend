/*
 * Characterization tests for POST /admin/calls/:id/reanalyse + the caller-scorecard
 * write-through on a fresh analysis (routes/admin/calls.js).
 *
 * Guards the two constraints that are easy to regress and expensive to get wrong:
 *   1. the transcript reset is scoped to the ONE requested row — never a
 *      status-wide `WHERE transcription_status = 'not_available'` sweep;
 *   2. a fresh analysis rolls up to tbl_caller_score_rollup (the Scorecard tab
 *      reads only that table), and silently skips when no caller resolves.
 *
 * Drives the real Express router via router.handle() with the fake pool + stubbed
 * provider/LLM services, so no network and no DB. Every collaborator is patched
 * BEFORE requiring the route, because calls.js destructures getEffectivePermissions
 * at require time.
 */

const test = require('node:test');
const assert = require('node:assert');
const { installFakePool } = require('./helpers/fake-pool');

const ANALYSIS = { overall_score: 8, dimensions: [{ name: 'Empathy', score: 8 }] };

// Grant the isClickToCall gate. Destructured by calls.js at require time, so this
// MUST be replaced on the module export before the route is required.
require('../services/role.service').getEffectivePermissions = async () => ({
  menuIds: [], actionPermissions: ['isClickToCall'],
});

// Provider + LLM stubs. calls.js keeps namespace references (`const plivo = require(..)`),
// so patching methods on the module object takes effect for the route.
const plivo = require('../services/plivo.service');
const callAnalysis = require('../services/call-analysis.service');
plivo.transcriptionEnabled = () => true;
plivo.fetchRecordingMeta = async () => ({ ok: true, recordingId: 'rec-1', url: 'https://x/rec-1' });
callAnalysis.llmEnabled = () => true;
callAnalysis.analyzeTranscript = async () => ANALYSIS;

// Default: the provider HAS a fresh transcript ready.
const FRESH = 'agent: hello there, how can I help you today? customer: my ac is not cooling at all.';
plivo.fetchTranscription = async () => ({ ok: true, text: FRESH });

function baseRoutes({ callerUserId = 7, jciCallerId = 7 } = {}) {
  return [
    [/SHOW COLUMNS FROM tbl_plivo_call_log/i, [{ Field: 'x' }]],
    [/SELECT caller_id\s+FROM tbl_job_caller_info/i, [{ caller_id: jciCallerId }]],
    [/SELECT call_uuid, caller_user_id/i, [{ call_uuid: 'uuid-1', caller_user_id: callerUserId }]],
    // caller-scorecard.service.rollupForCaller's two reads
    [/SELECT call_analysis, ended_on/i, [{ call_analysis: JSON.stringify(ANALYSIS), ended_on: null, initiated_on: null }]],
    [/SELECT coverage_json FROM tbl_teleprompter_session/i, []],
  ];
}

// Minimal req/res good enough for this router's handlers.
function drive(router, { id, user }) {
  return new Promise((resolve, reject) => {
    const req = { method: 'POST', url: `/${id}/reanalyse`, user, body: {}, query: {}, headers: {} };
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

test('reanalyse resets ONLY the requested row and never sweeps by status', async () => {
  const fake = installFakePool(baseRoutes());
  try {
    const router = require('../routes/admin/calls');
    const res = await drive(router, { id: 5, user: ADMIN });
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.status, 'ready');

    const reset = fake.calls.find((c) => /SET transcription = NULL/i.test(c.sql));
    assert.ok(reset, 'expected the transcript-cache reset UPDATE');
    // The text itself must be cleared — the backfill cron skips rows that still
    // have text, so a status-only reset would never re-fetch.
    assert.match(reset.sql, /transcription_status = NULL/i);
    assert.match(reset.sql, /WHERE job_caller_info_id = \?/i);
    assert.deepEqual(reset.params, [5]);

    // Hard constraint: no blanket reset across the table.
    for (const c of fake.calls) {
      assert.ok(
        !/UPDATE tbl_plivo_call_log[\s\S]*WHERE\s+transcription_status\s*=/i.test(c.sql),
        'reset must never key off transcription_status: ' + c.sql,
      );
    }
  } finally { fake.restore(); }
});

test('reanalyse writes the fresh analysis through to the caller rollup', async () => {
  const fake = installFakePool(baseRoutes({ callerUserId: 7 }));
  try {
    const router = require('../routes/admin/calls');
    await drive(router, { id: 5, user: ADMIN });

    const stored = fake.calls.find((c) => /SET call_analysis = \?/i.test(c.sql));
    assert.ok(stored, 'expected the analysis to be cached on the row');

    const rollup = fake.calls.find((c) => /INSERT INTO tbl_caller_score_rollup/i.test(c.sql));
    assert.ok(rollup, 'expected the scorecard rollup upsert');
    // caller_user_id off the log row is the first param of the upsert.
    assert.equal(rollup.params[0], 7);
  } finally { fake.restore(); }
});

test('rollup falls back to tbl_job_caller_info.caller_id when the log row has no caller', async () => {
  const fake = installFakePool(baseRoutes({ callerUserId: null, jciCallerId: 42 }));
  try {
    const router = require('../routes/admin/calls');
    await drive(router, { id: 5, user: ADMIN });

    const rollup = fake.calls.find((c) => /INSERT INTO tbl_caller_score_rollup/i.test(c.sql));
    assert.ok(rollup, 'expected the fallback-resolved rollup');
    assert.equal(rollup.params[0], 42);
  } finally { fake.restore(); }
});

test('rollup is skipped silently when no caller can be resolved', async () => {
  const fake = installFakePool(baseRoutes({ callerUserId: null, jciCallerId: null }));
  try {
    const router = require('../routes/admin/calls');
    // caller_id null on the jci row → owner check fails → admin still passes.
    const res = await drive(router, { id: 5, user: ADMIN });
    assert.equal(res.body.data.status, 'ready', 'analysis must still succeed without a caller');
    assert.ok(
      !fake.calls.some((c) => /INSERT INTO tbl_caller_score_rollup/i.test(c.sql)),
      'must not roll up an unattributable analysis',
    );
  } finally { fake.restore(); }
});

test('reanalyse reports transcript_pending when the provider has none ready yet', async () => {
  const original = plivo.fetchTranscription;
  plivo.fetchTranscription = async () => ({ ok: true, text: null });
  plivo.createTranscription = async () => ({ ok: true });
  const fake = installFakePool(baseRoutes());
  try {
    const router = require('../routes/admin/calls');
    const res = await drive(router, { id: 5, user: ADMIN });
    assert.equal(res.body.data.status, 'transcript_pending');
    // The previous analysis must survive a re-analyse that couldn't complete.
    assert.ok(
      !fake.calls.some((c) => /SET call_analysis = \?/i.test(c.sql)),
      'must not overwrite the cached analysis when no fresh transcript arrived',
    );
  } finally { fake.restore(); plivo.fetchTranscription = original; }
});

test('a non-owner without Admin cannot re-analyse', async () => {
  const fake = installFakePool(baseRoutes({ jciCallerId: 7 }));
  try {
    const router = require('../routes/admin/calls');
    const res = await drive(router, { id: 5, user: { user_id: 8, user_role: 3 } });
    assert.equal(res.statusCode, 403);
    assert.ok(
      !fake.calls.some((c) => /SET transcription = NULL/i.test(c.sql)),
      'a rejected request must not touch the transcript cache',
    );
  } finally { fake.restore(); }
});
