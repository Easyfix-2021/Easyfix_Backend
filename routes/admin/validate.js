const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { requirePropertyAllowlist } = require('../../middleware/require-property-allowlist');
const { FEATURES } = require('../../services/feature-access.service');
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');
const fcmService = require('../../services/fcm.service');
const smsService = require('../../services/sms.service');
const whatsappService = require('../../services/meta.whatsapp.service');
const { resolveTokens } = require('../../services/job-offer-push.service');
const aiSession = require('../../services/ai-call-session.service');
const aiCall = require('../../services/plivo-ai-call.service');
const plivo = require('../../services/plivo.service');
const { listFlows, DEFAULT_FLOW } = require('../../services/ai-call-flows');
const { listEngines, engineConfigured, ENGINE_NAMES, DEFAULT_ENGINE, voicesForEngine, defaultVoiceForEngine, isValidVoice } = require('../../services/ai-voice-engines');
const { getProperty, setProperty } = require('../../services/properties.service');
const voiceSample = require('../../services/ai-voice-sample.service');
const postCallQueue = require('../../services/ai-post-call-queue');

/*
 * Admin "Validate Flows" utilities — operator smoke-tests for delivery paths
 * (push / SMS / WhatsApp). Property-gated by `validate.flows.emails` (same model
 * as the other Admin-Actions capabilities — NOT an RBAC menu_action). The gate
 * shows/hides the card AND enforces the endpoints.
 */
router.use(requirePropertyAllowlist(FEATURES.canValidateFlows, { label: 'Validate Flows' }));

// Look up a technician by an arbitrary WHERE (any status — this is a debug tool).
async function findTech(where, param) {
  const [[row]] = await pool.query(
    `SELECT efr_id, efr_name, efr_no, efr_email FROM tbl_easyfixer WHERE ${where} LIMIT 1`,
    [param],
  );
  return row || null;
}

// Resolve a technician from efrId | email | mobile (priority in that order).
async function resolveTech({ efrId, email, mobile }) {
  if (efrId) return findTech('efr_id = ?', efrId);
  if (email) return findTech('LOWER(TRIM(efr_email)) = ?', String(email).toLowerCase());
  if (mobile) return findTech('efr_no = ?', mobile);
  return null;
}

// Turn any provider result into a GUARANTEED non-empty, human reason for a
// failure — so the operator never sees a blank "failed" with no explanation.
function failureReason(r) {
  if (!r) return 'No response from the provider.';
  if (r.error) return String(r.error);
  if (r.disabled) return 'Notifications are disabled on this environment (NOTIFICATIONS_DISABLE=true).';
  if (r.testSkipped) return 'Test mode is active (TEST_EMAILS / TEST_MOBILE set) with no TEST_FCM_TOKEN — the real send was suppressed.';
  const provider = String(r.providerResponse || '').slice(0, 300);
  if (provider) return provider;
  if (r.httpStatus) return `Provider rejected the request (HTTP ${r.httpStatus}).`;
  return 'Delivery failed with no reason reported by the provider.';
}

const shortMobile = (m) => {
  const s = String(m || '');
  return s.length >= 6 ? `${s.slice(0, 4)}••••${s.slice(-2)}` : s;
};

// ── POST /push — test FCM push, resolving by efrId | token | email | mobile ──
const pushBody = Joi.object({
  efrId: Joi.number().integer().positive(),
  token: Joi.string().trim().min(10).max(500),
  email: Joi.string().trim().email(),
  mobile: Joi.string().trim().pattern(/^\d{10}$/),
  title: Joi.string().trim().max(100).default('EasyFix — Test Push'),
  body: Joi.string().trim().max(240).default('Test notification from Validate Flows.'),
}).or('efrId', 'token', 'email', 'mobile');

router.post('/push', validate(pushBody), async (req, res, next) => {
  try {
    const { efrId, token, email, mobile, title, body } = req.body;
    const via = efrId ? 'efrId' : email ? 'email' : mobile ? 'mobile' : 'token';
    logger.info('Validate Flows · test push · via=' + via);

    let tech = null;
    if (token && !efrId && !email && !mobile) {
      // Reverse-lookup the owning tech from either token store (best-effort).
      const [[appRow]] = await pool.query('SELECT efr_id FROM tbl_easyfixer_app WHERE device_id = ? LIMIT 1', [token]);
      let efr = appRow && appRow.efr_id;
      if (!efr) {
        const [[devRow]] = await pool.query(
          "SELECT user_id AS efr_id FROM device_info WHERE fire_base_token = ? AND is_logged_in = '1' LIMIT 1", [token]);
        efr = devRow && devRow.efr_id;
      }
      if (efr) tech = await findTech('efr_id = ?', efr);
    } else {
      tech = await resolveTech({ efrId, email, mobile });
    }

    if (!tech && !token) return modernError(res, 404, 'No technician found for the supplied ' + via + '.');

    const tokens = token ? [String(token).trim()] : await resolveTokens(tech.efr_id);
    const resolvedTech = tech
      ? { efrId: tech.efr_id, name: tech.efr_name, mobile: tech.efr_no, email: tech.efr_email }
      : null;
    if (!tokens.length) {
      return modernError(res, 404,
        'Technician found but no FCM token is registered (tbl_easyfixer_app.device_id / device_info).',
        { resolvedTech });
    }

    const results = await Promise.all(tokens.map(async (t) => {
      const r = await fcmService.sendPush({ token: t, title, body, data: { type: 'validate_flows_test' } })
        .catch((e) => ({ delivered: false, error: e.message }));
      const notDelivered = !(r && r.delivered);
      const len = String(t).length;
      let reason = notDelivered ? failureReason(r) : undefined;
      // The #1 real-world cause: the stored value isn't an FCM token at all (a
      // legacy device_id / placeholder). Call it out explicitly.
      if (notDelivered && len < 100) {
        const provider = reason && !/valid FCM/.test(reason) ? ` [provider: ${reason}]` : '';
        reason = `Stored value is only ${len} chars — not a valid FCM registration token (real tokens are ~150+ chars); this device never registered a real token.${provider}`;
      }
      return {
        tokenPreview: String(t).slice(0, 18) + '…',
        tokenLength: len,
        delivered: !notDelivered,
        httpStatus: r ? r.httpStatus : undefined,
        deadToken: !!(r && r.deadToken),
        reason,
      };
    }));

    const delivered = results.filter((r) => r.delivered).length;
    logger.push(`validate-flows · test push · ${delivered}/${tokens.length} delivered · via=${via}`);
    const payload = {
      ok: delivered > 0, channel: 'push', resolvedVia: via, resolvedTech,
      delivery: { total: tokens.length, delivered, failed: tokens.length - delivered },
      results,
    };
    return modernOk(res, payload, delivered > 0
      ? `Push delivered to ${delivered}/${tokens.length} device(s).`
      : 'Push attempted but not delivered — see results for the reason.');
  } catch (e) {
    logger.error('Validate Flows test push failed · ' + e.message);
    next(e);
  }
});

// ── POST /message — test SMS or WhatsApp to a technician's mobile ──
const messageBody = Joi.object({
  channel: Joi.string().valid('sms', 'whatsapp').required(),
  efrId: Joi.number().integer().positive(),
  email: Joi.string().trim().email(),
  mobile: Joi.string().trim().pattern(/^\d{10}$/),
  message: Joi.string().trim().max(500), // sms
  templateName: Joi.string().trim().max(120), // whatsapp (required — checked below)
  recipientName: Joi.string().trim().max(120), // whatsapp
  variables: Joi.object().pattern(/^\d+$/, Joi.string().allow('')), // whatsapp { "1": "…" }
  languageCode: Joi.string().trim().max(10), // whatsapp
}).or('efrId', 'email', 'mobile');

router.post('/message', validate(messageBody), async (req, res, next) => {
  try {
    const { channel, efrId, email, mobile } = req.body;
    const via = efrId ? 'efrId' : email ? 'email' : 'mobile';
    logger.info('Validate Flows · test ' + channel + ' · via=' + via);

    if (channel === 'whatsapp' && !req.body.templateName) {
      return modernError(res, 400, 'templateName is required for a WhatsApp test.');
    }

    const tech = await resolveTech({ efrId, email, mobile });
    // A raw mobile is sendable even without a matching tech row.
    const to = mobile || (tech && tech.efr_no);
    const resolvedTech = tech
      ? { efrId: tech.efr_id, name: tech.efr_name, mobile: tech.efr_no, email: tech.efr_email }
      : null;
    if (!to) {
      if (!tech) return modernError(res, 404, 'No technician found for the supplied ' + via + '.');
      return modernError(res, 404, 'Technician found but has no mobile number on record.', { resolvedTech });
    }

    let r;
    if (channel === 'sms') {
      r = await smsService.send({ to, message: req.body.message || 'EasyFix test SMS from Validate Flows.' })
        .catch((e) => ({ delivered: false, error: e.message }));
    } else {
      r = await whatsappService.sendTemplate({
        to,
        recipientName: req.body.recipientName,
        templateName: req.body.templateName,
        variables: req.body.variables,
        languageCode: req.body.languageCode,
      }).catch((e) => ({ delivered: false, error: e.message }));
    }

    const delivered = !!(r && r.delivered);
    logger.push(`validate-flows · test ${channel} · ${delivered ? 'sent' : 'failed'} · via=${via}`);
    const label = channel === 'sms' ? 'SMS' : 'WhatsApp';
    const payload = {
      ok: delivered, channel, resolvedVia: via, resolvedTech, to: shortMobile(to),
      result: { delivered, httpStatus: r ? r.httpStatus : undefined, reason: delivered ? undefined : failureReason(r) },
    };
    return modernOk(res, payload, delivered
      ? `${label} sent to ${payload.to}.`
      : `${label} not sent — see reason.`);
  } catch (e) {
    logger.error('Validate Flows test message failed · ' + e.message);
    next(e);
  }
});

// ── AI Calling → Profile Update (TEST flow) ─────────────────────────────────
// Places an AI voice call that converses in the technician's language, asks for
// their skills + serviceable areas, then maps the transcript to Deep-Skill
// options + pincodes (DISPLAY ONLY — nothing is written to real profile tables).
// Gated by ai.calling.enabled + an OpenAI Realtime key; hard concurrency cap.
// Flow set is driven by the registry (services/ai-call-flows.js) — adding a flow
// there makes it a valid `flow` here with no change to this route.
const AI_FLOW_IDS = listFlows().map((f) => f.id);
const aiStartBody = Joi.object({
  flow: Joi.string().valid(...AI_FLOW_IDS).default(DEFAULT_FLOW),
  engine: Joi.string().valid(...ENGINE_NAMES), // default resolved from the property
  voice: Joi.string(), // validated per-engine in the handler (voice names differ by engine)
  efrId: Joi.number().integer().positive(),
  mobile: Joi.string().trim().pattern(/^\d{10}$/),
}).or('efrId', 'mobile');

// The default engine = the DB property (`ai.calling.engine`), else the code default.
function defaultEngine() {
  const p = String(getProperty('ai.calling.engine') || '').trim().toLowerCase();
  return ENGINE_NAMES.includes(p) ? p : DEFAULT_ENGINE;
}
// The default VOICE for automated calls, per engine = property `ai.calling.voice.<engine>`.
function defaultVoice(engine) {
  const p = String(getProperty('ai.calling.voice.' + engine) || '').trim();
  return isValidVoice(engine, p) ? p : defaultVoiceForEngine(engine);
}

// List the available AI-calling flows / engines / voices (for the UI selectors).
router.get('/ai-calling/flows', (req, res) => modernOk(res, { flows: listFlows() }));
router.get('/ai-calling/engines', (req, res) => modernOk(res, { engines: listEngines(), default: defaultEngine() }));
// Per-engine voice lists + the current default of each.
router.get('/ai-calling/voices', (req, res) => modernOk(res, {
  engines: Object.fromEntries(ENGINE_NAMES.map((e) => [e, { voices: voicesForEngine(e), default: defaultVoice(e) }])),
}));

// Set the GLOBAL default voice (per engine) for all automated calls.
const voiceDefaultBody = Joi.object({
  engine: Joi.string().valid(...ENGINE_NAMES).required(),
  voice: Joi.string().required(),
});
router.post('/ai-calling/voice-default', validate(voiceDefaultBody), async (req, res, next) => {
  try {
    const { engine, voice } = req.body;
    if (!isValidVoice(engine, voice)) return modernError(res, 400, `Voice "${voice}" is not valid for engine "${engine}".`);
    await setProperty('ai.calling.voice.' + engine, voice);
    logger.info('Validate Flows · ai-calling · default ' + engine + ' voice set to ' + voice);
    return modernOk(res, { engine, default: voice }, `Default ${engine} voice set to ${voice} for all automated calls.`);
  } catch (e) {
    logger.error('Validate Flows · ai-calling · set default voice failed · ' + e.message);
    next(e);
  }
});

// Synthesize a short SAMPLE of a voice (REST TTS) so operators can hear it before
// selecting. Streams audio (wav/mp3); the FE fetches authenticated → Blob → <audio>.
router.get('/ai-calling/voice-sample', async (req, res, next) => {
  try {
    const engine = ENGINE_NAMES.includes(String(req.query.engine)) ? String(req.query.engine) : DEFAULT_ENGINE;
    const voice = String(req.query.voice || '');
    if (!isValidVoice(engine, voice)) return modernError(res, 400, 'Invalid voice for the selected engine.');
    const out = await voiceSample.synthesize(engine, voice);
    if (!out.ok || !out.buffer) return modernError(res, 502, 'Could not synthesize a sample: ' + (out.error || 'unknown'));
    res.type(out.contentType || 'audio/mpeg');
    return res.send(out.buffer);
  } catch (e) {
    logger.error('Validate Flows · ai-calling · voice-sample failed · ' + e.message);
    next(e);
  }
});

// Operational stats — live call slots + the bounded post-call mapping queue. Lets
// ops watch load and tune MAX_CONCURRENT_AI_CALLS / AI_POST_CALL_CONCURRENCY.
router.get('/ai-calling/stats', (req, res) => modernOk(res, {
  liveCalls: { active: aiSession.activeCount(), max: aiSession.MAX_CONCURRENT },
  postCall: postCallQueue.stats(),
  engineDefault: defaultEngine(),
}));

router.post('/ai-calling/start', validate(aiStartBody), async (req, res, next) => {
  try {
    if (!aiSession.enabled()) {
      return modernError(res, 400, 'AI calling is not enabled. Set property ai.calling.enabled=true.');
    }
    // Which engine? explicit body override → DB property default → code default.
    const engine = req.body.engine || defaultEngine();
    if (!engineConfigured(engine)) {
      const keyVar = engine === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_REALTIME_API_KEY (or OPENAI_API_KEY)';
      return modernError(res, 400, `AI-calling engine "${engine}" is not configured — set ${keyVar}.`);
    }
    // Rule 2 — cap pre-check at start (the authoritative acquire happens when the
    // media socket connects). Protects the shared backend from over-admission.
    if (aiSession.activeCount() >= aiSession.MAX_CONCURRENT) {
      return modernError(res, 503,
        `Capacity reached — ${aiSession.activeCount()}/${aiSession.MAX_CONCURRENT} AI calls already active. Try again shortly.`);
    }

    const { efrId, mobile } = req.body;
    const via = efrId ? 'efrId' : 'mobile';
    const tech = await resolveTech({ efrId, mobile });
    const to = mobile || (tech && tech.efr_no);
    const resolvedTech = tech
      ? { efrId: tech.efr_id, name: tech.efr_name, mobile: tech.efr_no, email: tech.efr_email }
      : null;
    if (!to) {
      if (!tech) return modernError(res, 404, 'No technician found for the supplied ' + via + '.');
      return modernError(res, 404, 'Technician found but has no mobile number on record.', { resolvedTech });
    }

    let sessionId;
    try {
      sessionId = await aiSession.createSession({ mobile: to, efrId: tech ? tech.efr_id : null, flow: req.body.flow, engine });
    } catch (e) {
      logger.error('Validate Flows · ai-calling · session store not ready · ' + e.message);
      return modernError(res, 503,
        'AI-calling storage is not ready — run migrations/2026-07-06-create-tbl-ai-call-session.sql, then retry.');
    }

    // Per-call voice → rides in the JWT (no DB column). Explicit body override, else
    // the global default (property ai.calling.voice), else the code default.
    const voice = req.body.voice && isValidVoice(engine, req.body.voice) ? req.body.voice : defaultVoice(engine);
    const token = aiSession.signToken(sessionId, { voice });
    const placed = await aiCall.placeAiCall({ to, token });
    if (!placed.ok) {
      await aiSession.setStatus(sessionId, 'failed', { error: placed.error });
      return modernError(res, 502, 'Could not place the AI call: ' + placed.error, { sessionId });
    }
    await aiSession.setStatus(sessionId, 'calling', { callUuid: placed.callId || null });
    // Backstop: if the media stream never connects, fail the session (and unstick
    // the polling UI) after a timeout instead of leaving it stuck at 'calling'.
    aiSession.scheduleConnectReaper(sessionId);

    logger.info('Validate Flows · ai-calling · placed · session=' + sessionId + ' · engine=' + engine
      + ' · via=' + via + ' · active=' + aiSession.activeCount());
    return modernOk(res, {
      sessionId,
      engine,
      voice,
      resolvedVia: via,
      resolvedTech,
      to: shortMobile(to),
      callId: placed.callId || null,
    }, 'Calling now — pick up your phone. The panel will update once the call ends.');
  } catch (e) {
    logger.error('Validate Flows · ai-calling · start failed · ' + e.message);
    next(e);
  }
});

// Poll the durable session (any replica — state lives in tbl_ai_call_session).
router.get('/ai-calling/:sessionId', async (req, res, next) => {
  try {
    const s = await aiSession.getSession(req.params.sessionId);
    if (!s) return modernError(res, 404, 'Session not found (or AI-calling storage is not ready).');
    let result = null;
    if (s.result_json) { try { result = JSON.parse(s.result_json); } catch { result = null; } }
    return modernOk(res, {
      sessionId: s.session_id,
      status: s.status,
      error: s.error || null,
      mobile: shortMobile(s.mobile),
      efrId: s.efr_id || null,
      transcript: s.transcript || '',
      result,
      // Recording flag only (the raw Plivo URL needs auth — play it via the proxy
      // route below, never expose the URL to the browser).
      recordingAvailable: !!s.recording_url,
      recordingDuration: s.recording_duration || null,
      createdOn: s.created_on,
    });
  } catch (e) {
    logger.error('Validate Flows · ai-calling · poll failed · ' + e.message);
    next(e);
  }
});

// Stream a call recording for playback (proxied from Plivo, which needs Basic auth
// the browser can't send). Property-gated by the Validate-Flows allowlist above.
router.get('/ai-calling/:sessionId/recording', async (req, res, next) => {
  try {
    const s = await aiSession.getSession(req.params.sessionId);
    if (!s || !s.recording_url) return modernError(res, 404, 'No recording for this session.');
    const dl = await plivo.downloadRecording(s.recording_url);
    if (!dl.ok || !dl.buffer) return modernError(res, 502, 'Could not fetch the recording from Plivo.');
    res.type(dl.contentType || 'audio/mpeg');
    return res.send(dl.buffer);
  } catch (e) {
    logger.error('Validate Flows · ai-calling · recording proxy failed · ' + e.message);
    next(e);
  }
});

module.exports = router;
