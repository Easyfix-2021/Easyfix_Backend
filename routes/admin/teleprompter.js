/*
 * /api/admin/teleprompter — the AI Teleprompter for Calls (guided, human-led,
 * AI-assisted). Property-gated (teleprompter.emails) AND behind the master flag
 * (teleprompter.enabled) so it is fully additive — OFF ⇒ every route 403s and the
 * feature is invisible. Auth + role(['admin']) come from the parent router.
 *
 *   POST /start          create a session + build the on-screen question list.
 *   GET  /:id            poll: status + current/next highlight + transcript + result.
 *   POST /:id/promote    browser VAD → ops started reading: lock current + record asked.
 *
 * The media capture (Plivo <Stream> → STT) + the live "next question" decision run
 * in the ws relay (services/teleprompter-relay.service.js); this router only owns
 * session lifecycle + the poll surface. Phase 1 uses polling (cross-replica safe);
 * an SSE fast-path (teleprompter-bus) can be layered on later.
 */

const router = require('express').Router();
const Joi = require('joi');
const { pool } = require('../../db');
const logger = require('../../logger');
const validate = require('../../middleware/validate');
const { modernOk, modernError } = require('../../utils/response');
const { requirePropertyAllowlist } = require('../../middleware/require-property-allowlist');
const teleprompter = require('../../services/teleprompter.service');
const { sttUsable } = require('../../services/stt-engines');
const { getFlow } = require('../../services/teleprompter-flows');
const { fetchDeepSkillCatalog } = require('../../services/easyfixer-profile-update-link.service');
const bus = require('../../services/teleprompter-bus');

// Restricted to the teleprompter.emails allowlist (NOT RBAC-grantable).
router.use(requirePropertyAllowlist('teleprompter.emails', { label: 'AI Teleprompter' }));
// Master flag — OFF ⇒ feature disabled (defence-in-depth over the ws-upgrade check).
function requireEnabled(req, res, next) {
  if (!teleprompter.enabled()) return modernError(res, 403, 'AI Teleprompter is not enabled.');
  return next();
}

const intId = Joi.number().integer().positive();
const startBody = Joi.object({
  flow: Joi.string().max(32).default('guided_verification'),
  efrId: intId.required(),
});
const promoteBody = Joi.object({
  questionId: Joi.string().max(64).required(),
  askedSequence: Joi.array().items(Joi.object({
    id: Joi.string().max(64).required(),
    ts: Joi.number().optional(),
    text: Joi.string().max(500).optional(),
  }).unknown(true)).max(1000).optional(),
});

function parseJson(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }
function shape(s) {
  return {
    sessionId: s.session_id,
    flow: s.flow,
    status: s.status,
    targetId: s.target_id,
    callUuid: s.call_uuid,
    currentQuestionId: s.current_question_id || null,
    nextQuestionId: s.next_question_id || null,
    questionList: parseJson(s.question_list_json) || [],
    askedSequence: parseJson(s.asked_sequence_json) || [],
    transcript: s.transcript || '',
    result: parseJson(s.captured_result_json),
    coverage: parseJson(s.coverage_json),
    error: s.error || null,
    createdOn: s.created_on,
  };
}

// ─── POST /start ──────────────────────────────────────────────────────
// Build the ordered question list from the live deep-skill catalog + create the
// session. Does NOT place the call — the FE then runs the existing web-call
// (POST /admin/calls/web-start) passing this sessionId so web-answer forks audio.
router.post('/start', requireEnabled, validate(startBody), async (req, res, next) => {
  try {
    const { flow: flowId, efrId } = req.body;
    const flow = getFlow(flowId);
    if (!flow) return modernError(res, 400, 'Unknown teleprompter flow: ' + flowId);

    // STT is MANDATORY — it powers the live next-question suggestion AND the
    // post-call analysis. Refuse to start (don't place the call) if it isn't
    // available, rather than silently running a degraded manual call.
    if (!sttUsable(teleprompter.sttProvider())) {
      return modernError(res, 409, 'The AI Teleprompter needs the speech-to-text service, which is not configured. Set the STT provider (stt.provider) and STT_SERVICE_URL, then try again.');
    }

    let catalog = [];
    try { catalog = await fetchDeepSkillCatalog(pool); } catch (e) { logger.warn('teleprompter: catalog fetch failed · ' + e.message); }
    let ctx = {};
    if (flow.preload) { try { ctx = (await flow.preload({ targetId: efrId }, pool)) || {}; } catch { ctx = {}; } }
    const questionList = flow.buildQuestionList(catalog, ctx);

    const sessionId = await teleprompter.createSession({
      flow: flowId,
      targetType: flow.targetType || 'easyfixer',
      targetId: efrId,
      callerUserId: req.user.user_id,
      questionList,
    });
    teleprompter.scheduleConnectReaper(sessionId);
    logger.info('Teleprompter session started · ' + sessionId + ' · flow=' + flowId + ' · efrId=' + efrId + ' · questions=' + questionList.length);
    return modernOk(res, { sessionId, flow: flowId, questionList });
  } catch (e) { next(e); }
});

// ─── GET /:id — poll ──────────────────────────────────────────────────
router.get('/:id', requireEnabled, async (req, res, next) => {
  try {
    const s = await teleprompter.getSession(req.params.id);
    if (!s) return modernError(res, 404, 'Teleprompter session not found');
    return modernOk(res, shape(s));
  } catch (e) { next(e); }
});

// ─── POST /:id/promote — browser VAD: ops started reading the "next" question ──
// Locks it as current (the relay never overwrites current) + records the asked step.
router.post('/:id/promote', requireEnabled, validate(promoteBody), async (req, res, next) => {
  try {
    const { questionId, askedSequence } = req.body;
    const s = await teleprompter.getSession(req.params.id);
    if (!s) return modernError(res, 404, 'Teleprompter session not found');
    await teleprompter.promote(req.params.id, questionId, askedSequence || []);
    bus.publish(req.params.id, { type: 'promoted', currentQuestionId: questionId });
    return modernOk(res, { ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
