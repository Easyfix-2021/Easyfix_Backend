const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { modernOk, modernError } = require('../../utils/response');
const estimateService = require('../../services/mobile-job-estimate.service');

/*
 * /api/mobile/jobs/* — Technician-App "Estimate / Quotation" sub-router.
 *
 * Mounted UNDER /jobs in routes/mobile/index.js, AFTER `router.use(requireTechAuth)`,
 * so every handler here inherits the technician auth guard — `req.tech.efr_id`
 * is always populated. (See routes/mobile/notices.js for the same pattern.)
 *
 * REQUIRED MOUNT (add to routes/mobile/index.js, after the existing
 *   `router.use('/notices', require('./notices'));` line):
 *
 *     router.use('/jobs', require('./jobs-estimate'));
 *
 * Mounting under /jobs means the paths below resolve to:
 *   GET    /api/mobile/jobs/:id/rate-card
 *   POST   /api/mobile/jobs/:id/quotation
 *   POST   /api/mobile/jobs/:id/quotation/:lineId   (delete semantic — RN calls POST)
 *   DELETE /api/mobile/jobs/:id/quotation/:lineId
 *   POST   /api/mobile/jobs/:id/send-for-approval
 *   POST   /api/mobile/jobs/:id/images?category=Booking|Completion
 *   GET    /api/mobile/jobs/:id/questionnaire
 *   POST   /api/mobile/jobs/:id/questionnaire
 *   GET    /api/mobile/jobs/:id/work-progress
 *
 * NOTE: routes/mobile/index.js already defines GET /jobs/:id, /jobs/:id/accept,
 * /jobs/:id/checkin, etc. directly on the parent router. Those are matched
 * first (Express matches in mount order); this sub-router only owns the new
 * estimate-flow leaf paths above, which the parent router does NOT define —
 * so there is no collision.
 *
 * All SQL lives in services/mobile-job-estimate.service.js; handlers here are
 * Joi-validated + modernOk-wrapped only. Every service call self-scopes to
 * "this technician's job" (tbl_job.fk_easyfixter_id = req.tech.efr_id) and
 * throws { status: 404 } when the job isn't the tech's — surfaced via the
 * shared `handle()` helper below.
 */

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

// Translate a service-thrown { status, message } into a modern error; otherwise
// delegate to the Express error pipeline. Keeps every handler a one-liner.
function fail(res, next, e) {
  if (e && e.status) return modernError(res, e.status, e.message);
  return next(e);
}

// ─── Rate card ─────────────────────────────────────────────────────────
// GET /:id/rate-card → product/material rate-card items for the job's client.
// { items: [{ clientRateCardId, name, price, serviceTypeId }] }
router.get('/:id/rate-card', validate(idParam, 'params'), async (req, res, next) => {
  try {
    modernOk(res, await estimateService.getRateCard(Number(req.params.id), req.tech.efr_id));
  } catch (e) { fail(res, next, e); }
});

// ─── Quotation: add a line ─────────────────────────────────────────────
// POST /:id/quotation { type, itemId?, name?, quantity, amount } → { lineId }
const quotationBody = Joi.object({
  type:     Joi.string().valid('product', 'material').required(),
  itemId:   Joi.number().integer().positive().optional(),
  name:     Joi.string().trim().min(1).max(255).optional(),
  quantity: Joi.number().integer().min(1).default(1),
  amount:   Joi.number().min(0).default(0),
})
  // material lines are free-text, so a name is required when there is no
  // rate-card itemId to derive it from. `helpers.message()` sets the
  // human-readable reason directly (the `helpers.error('any.custom', …)`
  // form drops the message unless a template is registered).
  .custom((value, helpers) => {
    if (value.type === 'material' && !value.name) {
      return helpers.message('name is required for material lines');
    }
    if (value.type === 'product' && !value.itemId && !value.name) {
      return helpers.message('itemId or name is required for product lines');
    }
    return value;
  }, 'quotation line shape');

router.post('/:id/quotation', validate(idParam, 'params'), validate(quotationBody), async (req, res, next) => {
  try {
    const out = await estimateService.addQuotationLine(Number(req.params.id), req.tech.efr_id, req.body);
    res.status(201);
    modernOk(res, out);
  } catch (e) { fail(res, next, e); }
});

// ─── Quotation: delete a line ──────────────────────────────────────────
// The RN client calls POST to quotation/:lineId to DELETE the line, so we
// implement delete semantics on BOTH POST and DELETE for the same path.
const lineParam = Joi.object({
  id:     Joi.number().integer().positive().required(),
  lineId: Joi.number().integer().positive().required(),
});

async function handleDeleteLine(req, res, next) {
  try {
    modernOk(res, await estimateService.deleteQuotationLine(
      Number(req.params.id), req.tech.efr_id, Number(req.params.lineId),
    ));
  } catch (e) { fail(res, next, e); }
}

router.post('/:id/quotation/:lineId', validate(lineParam, 'params'), handleDeleteLine);
router.delete('/:id/quotation/:lineId', validate(lineParam, 'params'), handleDeleteLine);

// ─── Send for approval ─────────────────────────────────────────────────
// POST /:id/send-for-approval { checkInImageRefs? } → { sent: true }
router.post('/:id/send-for-approval', validate(idParam, 'params'), validate(Joi.object({
  checkInImageRefs: Joi.array().items(Joi.string().trim().max(512)).optional(),
})), async (req, res, next) => {
  try {
    modernOk(res, await estimateService.sendForApproval(
      Number(req.params.id), req.tech.efr_id, { checkInImageRefs: req.body.checkInImageRefs },
    ));
  } catch (e) { fail(res, next, e); }
});

// ─── Job images ────────────────────────────────────────────────────────
// POST /:id/images?category=Booking|Completion { refs: [<s3-key>...] }
//   → { ok: true, inserted: <n> }
// Accepts JSON refs[] for now. Multipart byte upload is a // VERIFY: when the
// app moves to multipart, this handler will need multer + the s3-storage
// putJobImage() helper (as in routes/admin/jobs.js); the JSON-refs contract
// stays as the fallback for clients that upload bytes out-of-band.
router.post(
  '/:id/images',
  validate(idParam, 'params'),
  validate(Joi.object({ category: Joi.string().valid('Booking', 'Completion').required() }), 'query'),
  validate(Joi.object({ refs: Joi.array().items(Joi.string().trim().max(512)).default([]) })),
  async (req, res, next) => {
    try {
      modernOk(res, await estimateService.recordImages(
        Number(req.params.id), req.tech.efr_id,
        { category: req.query.category, refs: req.body.refs },
      ));
    } catch (e) { fail(res, next, e); }
  },
);

// ─── Questionnaire ─────────────────────────────────────────────────────
// GET  /:id/questionnaire → { questions: [...] }
router.get('/:id/questionnaire', validate(idParam, 'params'), async (req, res, next) => {
  try {
    modernOk(res, await estimateService.getQuestionnaire(Number(req.params.id), req.tech.efr_id));
  } catch (e) { fail(res, next, e); }
});

// POST /:id/questionnaire { answers: [{ questionId, answer, comments? }] }
//   → { submitted: true, count: <n> }
router.post('/:id/questionnaire', validate(idParam, 'params'), validate(Joi.object({
  answers: Joi.array().items(Joi.object({
    questionId: Joi.number().integer().positive().required(),
    answer:     Joi.string().allow('', null).max(4000).optional(),
    comments:   Joi.string().allow('', null).max(4000).optional(),
  })).default([]),
})), async (req, res, next) => {
  try {
    modernOk(res, await estimateService.submitQuestionnaire(
      Number(req.params.id), req.tech.efr_id, req.body.answers,
    ));
  } catch (e) { fail(res, next, e); }
});

// ─── Work progress (lifecycle timeline) ────────────────────────────────
// GET /:id/work-progress → { stages: [{ key, label, done, at }] }
router.get('/:id/work-progress', validate(idParam, 'params'), async (req, res, next) => {
  try {
    modernOk(res, await estimateService.getWorkProgress(Number(req.params.id), req.tech.efr_id));
  } catch (e) { fail(res, next, e); }
});

module.exports = router;
