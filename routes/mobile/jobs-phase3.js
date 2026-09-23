const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { modernOk, modernError } = require('../../utils/response');
const claims = require('../../services/mobile-job-claims.service');
const chat = require('../../services/job-chat.service');
const lifecycle = require('../../services/mobile-job-lifecycle.service');
const { HELP_REASONS, MAX_PROOF_IDS } = require('../../services/job-tx-report.service');
const logger = require('../../logger');

/*
 * /api/mobile/jobs/:id/* — V3 Phase 3: what the technician tells us from site
 * (design sheets 09-15). Mounted from routes/mobile/index.js under /jobs,
 * after requireTechAuth / the lifecycle lock / idempotency, like the other
 * /jobs sub-routers. Every path here is /:id/<word>…, one segment deeper than
 * GET /jobs/:id, so nothing collides with it.
 *
 * Every handler is owner-guarded inside the service (mobile-job-lifecycle
 * getOwnedJob → 404 for a job that is not his), so these handlers only
 * validate and shape.
 *
 * All mutations here are LIVE-ONLY on the app (spec: offline manifest) and are
 * idempotent by state on the server — a retried report returns the open one,
 * a retried chat line returns the row its clientMsgId already made.
 */

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });
const proofIds = Joi.array().items(Joi.number().integer().positive()).min(1).max(MAX_PROOF_IDS);

function handleErr(res, next, e) {
  if (e && e.status) return modernError(res, e.status, e.message);
  return next(e);
}

// Money is attributed to a tbl_user where he has one, else to his efr id —
// the same actorId the checkout's visit charge uses.
const actorIdOf = (req) => req.tech.user_id || req.tech.efr_id;

/* ─── Additional work (sheets 09-12) ────────────────────────────────── */

// POST /jobs/:id/additional-work {} → { report, created }
router.post('/:id/additional-work', validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Additional work reported · jobId=' + req.params.id);
    modernOk(res, await claims.reportAdditionalWork(Number(req.params.id), req.tech.efr_id));
  } catch (e) { logger.warn('Additional work report failed · jobId=' + req.params.id + ' · ' + e.message); handleErr(res, next, e); }
});

// POST /jobs/:id/additional-work/booked { answer: 'yes'|'no' } → { report }
router.post('/:id/additional-work/booked', validate(idParam, 'params'),
  validate(Joi.object({ answer: Joi.string().valid('yes', 'no').required() })),
  async (req, res, next) => {
    try {
      logger.info('Booked-meanwhile answer · jobId=' + req.params.id + ' · ' + req.body.answer);
      modernOk(res, await claims.answerBooked(Number(req.params.id), req.tech.efr_id, req.body.answer));
    } catch (e) { handleErr(res, next, e); }
  });

// POST /jobs/:id/additional-work/leave {} → { report }
router.post('/:id/additional-work/leave', validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Leaving site with additional work pending · jobId=' + req.params.id);
    modernOk(res, await claims.leaveSite(Number(req.params.id), req.tech.efr_id));
  } catch (e) { handleErr(res, next, e); }
});

/* ─── Can't complete (sheet 13) ─────────────────────────────────────── */

// POST /jobs/:id/cant-complete { reasonId, proofImageIds[] } → { report, created }
router.post('/:id/cant-complete', validate(idParam, 'params'),
  validate(Joi.object({
    reasonId: Joi.number().integer().positive().required(),
    proofImageIds: proofIds.required(),
  })),
  async (req, res, next) => {
    try {
      logger.info('Cannot complete reported · jobId=' + req.params.id + ' · reasonId=' + req.body.reasonId);
      modernOk(res, await claims.reportCantComplete(
        Number(req.params.id), req.tech.efr_id, req.body, actorIdOf(req)));
    } catch (e) { logger.warn('Cannot complete report failed · jobId=' + req.params.id + ' · ' + e.message); handleErr(res, next, e); }
  });

// POST /jobs/:id/cant-complete/undo {} → { undone, visitCharge:{reversed, reason} }
router.post('/:id/cant-complete/undo', validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Cannot complete undone · jobId=' + req.params.id);
    modernOk(res, await claims.undoCantComplete(Number(req.params.id), req.tech.efr_id));
  } catch (e) { handleErr(res, next, e); }
});

// POST /jobs/:id/cancel/undo {} → { undone, jobStatus, visitCharge }
// (POST /jobs/:id/cancel itself lives in jobs-lifecycle.js, beside the request model.)
router.post('/:id/cancel/undo', validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Cancel request withdrawn · jobId=' + req.params.id);
    modernOk(res, await claims.undoCancel(Number(req.params.id), req.tech.efr_id));
  } catch (e) { handleErr(res, next, e); }
});

/* ─── Need help (sheet 13b) ─────────────────────────────────────────── */

// POST /jobs/:id/help { reason } → { help, created }
router.post('/:id/help', validate(idParam, 'params'),
  validate(Joi.object({ reason: Joi.string().valid(...Object.keys(HELP_REASONS)).required() })),
  async (req, res, next) => {
    try {
      logger.info('Help requested · jobId=' + req.params.id + ' · ' + req.body.reason);
      modernOk(res, await claims.requestHelp(Number(req.params.id), req.tech.efr_id, req.body.reason));
    } catch (e) { handleErr(res, next, e); }
  });

/* ─── Chat (sheet 15) ───────────────────────────────────────────────── */

// Ownership only — the service trusts the job id it is handed.
async function ownJob(req) {
  await lifecycle.getOwnedJob(Number(req.params.id), req.tech.efr_id);
}

// GET /jobs/:id/chat?after=<id> → { items: [{id, senderKind, efrId, userId, body, sentOn}] } (≤100, oldest first)
router.get('/:id/chat', validate(idParam, 'params'),
  validate(Joi.object({ after: Joi.number().integer().min(0).optional() }), 'query'),
  async (req, res, next) => {
    try {
      await ownJob(req);
      modernOk(res, { items: await chat.list(Number(req.params.id), { after: req.query.after || 0 }) });
    } catch (e) { handleErr(res, next, e); }
  });

// POST /jobs/:id/chat { body (1..500), clientMsgId } → the row (the existing one on a retry)
router.post('/:id/chat', validate(idParam, 'params'),
  validate(Joi.object({
    body: Joi.string().trim().min(1).max(chat.BODY_MAX).required(),
    clientMsgId: Joi.string().trim().max(64).optional().allow(null, ''),
  })),
  async (req, res, next) => {
    try {
      await ownJob(req);
      modernOk(res, await chat.post(Number(req.params.id), {
        senderKind: chat.SENDER.TX, efrId: req.tech.efr_id, body: req.body.body, clientMsgId: req.body.clientMsgId,
      }));
    } catch (e) { handleErr(res, next, e); }
  });

/* ─── Where is my money (sheet 14) ──────────────────────────────────── */

// GET /jobs/:id/money → { share, shareEstimated, finishedOn, checking, clientQc, walletOn }
router.get('/:id/money', validate(idParam, 'params'), async (req, res, next) => {
  try {
    modernOk(res, await claims.jobMoney(Number(req.params.id), req.tech.efr_id));
  } catch (e) { handleErr(res, next, e); }
});

module.exports = router;
