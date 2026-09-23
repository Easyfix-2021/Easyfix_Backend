const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { modernOk, modernError } = require('../../utils/response');
const estimateService = require('../../services/mobile-job-estimate.service');
const { stripClientPrices } = require('./money-split');
const materialRequestService = require('../../services/material-request.service');
const logger = require('../../logger');

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
 *   POST   /api/mobile/jobs/:id/material-required
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
// { items: [{ clientRateCardId, name, serviceTypeId }] }
//
// `price` REMOVED from the wire 2026-09-24 (V3 3.9): it is the CLIENT's rate-card
// price, and the technician no longer prices anything — the desk prices
// additional work from his photos (design sheet 10). The service still reads it
// (its own tests pin the resolver); only the phone stops receiving it. The same
// holds for the material picker's prices and the quotation lines' amounts below.
router.get('/:id/rate-card', validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Fetch rate-card for job · jobId=' + req.params.id);
    const out = await estimateService.getRateCard(Number(req.params.id), req.tech.efr_id);
    logger.info('Returning ' + (out.items ? out.items.length : 0) + ' rate-card items');
    modernOk(res, stripClientPrices(out, ['price']));
  } catch (e) { logger.warn('Fetch rate-card failed · jobId=' + req.params.id + ' · ' + e.message); fail(res, next, e); }
});

// ─── Materials (Material Management phase 2, sub-project B) ───────────
// GET /:id/materials?search= → master-list materials for this job's service
// category, each priced via resolveMaterialPrice() for the job's client +
// state. See docs/superpowers/specs/2026-09-18-app-estimate-material-picker-design.md.
// { items: [{ material_id, material_name, uom_name, pricing_type,
//             brands: [{ brand_id, brand_name, price, price_source }],
//             price, price_source }] }
const materialsQuery = Joi.object({ search: Joi.string().trim().max(200).allow('').optional() });

router.get('/:id/materials', validate(idParam, 'params'), validate(materialsQuery, 'query'), async (req, res, next) => {
  try {
    logger.info('Fetch job materials · jobId=' + req.params.id + ' · search=' + (req.query.search || ''));
    const out = await estimateService.getJobMaterials(Number(req.params.id), req.tech.efr_id, { search: req.query.search });
    logger.info('Returning ' + (out.items ? out.items.length : 0) + ' materials');
    // 3.9 — resolved client prices stay server-side (see the rate card above).
    modernOk(res, stripClientPrices(out, ['price']));
  } catch (e) { logger.warn('Fetch job materials failed · jobId=' + req.params.id + ' · ' + e.message); fail(res, next, e); }
});

// ─── Quotation: add a line ─────────────────────────────────────────────
// POST /:id/quotation { type, itemId?, name?, quantity, amount, materialId?, brandId? }
//   → { lineId }
// materialId/brandId are the technician-app's own field names (camelCase,
// matching this file's existing `itemId` convention) — NOT the snake_case
// material_id/brand_id used in the GET /:id/materials RESPONSE shape above,
// which is the spec's shape and is mapped by the app on the way in.
const quotationBody = Joi.object({
  type:       Joi.string().valid('product', 'material').required(),
  itemId:     Joi.number().integer().positive().optional(),
  materialId: Joi.number().integer().positive().optional(),
  brandId:    Joi.number().integer().positive().optional(),
  name:       Joi.string().trim().min(1).max(255).optional(),
  quantity:   Joi.number().integer().min(1).default(1),
  amount:     Joi.number().min(0).default(0),
})
  // A material line's `materialId` requirement is enforced in the SERVICE
  // (422 — see addQuotationLine) rather than here, because the design calls
  // for a 422 specifically and Joi validation failures are always 400
  // (see middleware/validate.js). `helpers.message()` sets the human-readable
  // reason directly (the `helpers.error('any.custom', …)` form drops the
  // message unless a template is registered).
  .custom((value, helpers) => {
    if (value.type === 'product' && !value.itemId && !value.name) {
      return helpers.message('itemId or name is required for product lines');
    }
    return value;
  }, 'quotation line shape');

router.post('/:id/quotation', validate(idParam, 'params'), validate(quotationBody), async (req, res, next) => {
  try {
    logger.info('Add quotation line · jobId=' + req.params.id + ' · type=' + req.body.type + ' · qty=' + req.body.quantity + ' · amount=' + req.body.amount + ' · materialId=' + (req.body.materialId || null));
    const out = await estimateService.addQuotationLine(Number(req.params.id), req.tech.efr_id, {
      type: req.body.type,
      itemId: req.body.itemId,
      name: req.body.name,
      quantity: req.body.quantity,
      amount: req.body.amount,
      materialId: req.body.materialId,
      brandId: req.body.brandId,
    });
    logger.info('Quotation line created · id=' + out.lineId);
    res.status(201);
    modernOk(res, out);
  } catch (e) { logger.warn('Add quotation line failed · jobId=' + req.params.id + ' · ' + e.message); fail(res, next, e); }
});

// ─── Quotation: list (Material Request Flow v2) ────────────────────────
// GET /:id/quotation → { items: [{ lineId, type, name, quantity, amount,
//   materialId, itemId, clientCharge, approvedCharge, sentOn, actionOn,
//   state, quotationNo }] } — each line's `state` from
//   services/quotation-line-state.js; `quotationNo` (owner decision,
//   2026-09-22) is 1..n by ascending distinct sent_on within the job, null
//   for a draft.
router.get('/:id/quotation', validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('List quotation lines · jobId=' + req.params.id);
    const out = await estimateService.listQuotationLines(Number(req.params.id), req.tech.efr_id);
    logger.info('Returning ' + (out.items ? out.items.length : 0) + ' quotation lines');
    // 3.9 — a line keeps its name, quantity and state for the read-only 15/16
    // banners; its amount / clientCharge / approvedCharge are client prices.
    modernOk(res, stripClientPrices(out, ['amount']));
  } catch (e) { logger.warn('List quotation lines failed · jobId=' + req.params.id + ' · ' + e.message); fail(res, next, e); }
});

// ─── Quotation: bulk draft add (Material Request Flow v2) ──────────────
// POST /:id/quotation/draft { lines: [...] } (1..50, same shape as the
// single add) → { lineIds }, one transaction.
const quotationDraftBody = Joi.object({
  lines: Joi.array().items(quotationBody).min(1).max(50).required(),
});

router.post('/:id/quotation/draft', validate(idParam, 'params'), validate(quotationDraftBody), async (req, res, next) => {
  try {
    logger.info('Add quotation lines (bulk draft) · jobId=' + req.params.id + ' · count=' + req.body.lines.length);
    const out = await estimateService.addQuotationLines(Number(req.params.id), req.tech.efr_id, req.body.lines.map((l) => ({
      type: l.type, itemId: l.itemId, name: l.name, quantity: l.quantity, amount: l.amount,
      materialId: l.materialId, brandId: l.brandId,
    })));
    logger.info('Bulk draft lines created · jobId=' + req.params.id + ' · count=' + out.lineIds.length);
    res.status(201);
    modernOk(res, out);
  } catch (e) { logger.warn('Add quotation lines (bulk draft) failed · jobId=' + req.params.id + ' · ' + e.message); fail(res, next, e); }
});

// ─── Quotation: delete ALL technician-editable lines ────────────────────
// DELETE /:id/quotation → { deleted: n } — draft + review_pending lines only.
router.delete('/:id/quotation', validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Delete all technician-editable quotation lines · jobId=' + req.params.id);
    const out = await estimateService.deleteAllQuotationLines(Number(req.params.id), req.tech.efr_id);
    logger.info('Deleted ' + out.deleted + ' quotation lines · jobId=' + req.params.id);
    modernOk(res, out);
  } catch (e) { logger.warn('Delete all quotation lines failed · jobId=' + req.params.id + ' · ' + e.message); fail(res, next, e); }
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
    logger.info('Delete quotation line · jobId=' + req.params.id + ' · lineId=' + req.params.lineId);
    const out = await estimateService.deleteQuotationLine(
      Number(req.params.id), req.tech.efr_id, Number(req.params.lineId),
    );
    logger.info('Quotation line deleted · id=' + req.params.lineId);
    modernOk(res, out);
  } catch (e) { logger.warn('Delete quotation line failed · lineId=' + req.params.lineId + ' · ' + e.message); fail(res, next, e); }
}

router.post('/:id/quotation/:lineId', validate(lineParam, 'params'), handleDeleteLine);
router.delete('/:id/quotation/:lineId', validate(lineParam, 'params'), handleDeleteLine);

// ─── Material Required (Material Management phase 2, sub-project D) ────
// POST /:id/material-required → { ok: true, status: 16 }
// 2/20 → 16 (Pending for Material), material_sub_status = 1 (Quotation
// Pending). See docs/superpowers/specs/2026-09-18-pending-for-material-
// status-16-design.md.
router.post('/:id/material-required', validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Material required · jobId=' + req.params.id);
    const out = await estimateService.materialRequired(Number(req.params.id), req.tech.efr_id);
    logger.info('Job marked material-required · jobId=' + req.params.id);
    modernOk(res, out);
  } catch (e) { logger.warn('Material required failed · jobId=' + req.params.id + ' · ' + e.message); fail(res, next, e); }
});

// ─── Send for approval ─────────────────────────────────────────────────
// POST /:id/send-for-approval { checkInImageRefs?, lines? } → { sent: true }
// `lines` (Material Request Flow v2, 2026-09-21) — same shape as the draft
// add — are inserted as drafts in the SAME transaction before the send.
router.post('/:id/send-for-approval', validate(idParam, 'params'), validate(Joi.object({
  checkInImageRefs: Joi.array().items(Joi.string().trim().max(512)).optional(),
  lines: Joi.array().items(quotationBody).max(50).optional(),
})), async (req, res, next) => {
  try {
    logger.info('Send estimate for approval · jobId=' + req.params.id + ' · checkInImageRefs=' + ((req.body.checkInImageRefs && req.body.checkInImageRefs.length) || 0) + ' · lines=' + ((req.body.lines && req.body.lines.length) || 0));
    const out = await estimateService.sendForApproval(
      Number(req.params.id), req.tech.efr_id, {
        checkInImageRefs: req.body.checkInImageRefs,
        lines: req.body.lines && req.body.lines.map((l) => ({
          type: l.type, itemId: l.itemId, name: l.name, quantity: l.quantity, amount: l.amount,
          materialId: l.materialId, brandId: l.brandId,
        })),
      },
    );
    logger.info('Estimate sent for approval · jobId=' + req.params.id);
    modernOk(res, out);
  } catch (e) { logger.warn('Send for approval failed · jobId=' + req.params.id + ' · ' + e.message); fail(res, next, e); }
});

// ─── Job images ────────────────────────────────────────────────────────
// POST /:id/images?category=Booking|Completion|Proof { refs: [<s3-key>...] }
//   → { ok: true, inserted: <n>, imageIds: [<tbl_job_image.image_id>...] }
// Accepts JSON refs[] for now. Multipart byte upload is a // VERIFY: when the
// app moves to multipart, this handler will need multer + the s3-storage
// putJobImage() helper (as in routes/admin/jobs.js); the JSON-refs contract
// stays as the fallback for clients that upload bytes out-of-band.
router.post(
  '/:id/images',
  validate(idParam, 'params'),
  // 'Proof' (V3 3.6a/b): a claim's photo — stored as 'proof', see
  // utils/job-image-buckets.js; its status window is enforced in the service.
  validate(Joi.object({ category: Joi.string().valid('Booking', 'Completion', 'Proof').required() }), 'query'),
  validate(Joi.object({ refs: Joi.array().items(Joi.string().trim().max(512)).default([]) })),
  async (req, res, next) => {
    try {
      logger.info('Record job images · jobId=' + req.params.id + ' · category=' + req.query.category + ' · refs=' + ((req.body.refs && req.body.refs.length) || 0));
      const out = await estimateService.recordImages(
        Number(req.params.id), req.tech.efr_id,
        { category: req.query.category, refs: req.body.refs },
      );
      logger.info('Recorded ' + (out.inserted || 0) + ' job images · jobId=' + req.params.id);
      modernOk(res, out);
    } catch (e) { logger.warn('Record job images failed · jobId=' + req.params.id + ' · ' + e.message); fail(res, next, e); }
  },
);

// ─── Delete ONE before/after photo ─────────────────────────────────────
// DELETE /:id/images/:imageId → { ok: true, imageId, category }
// POST   /:id/images/:imageId → same handler (see below)
//
// The technician took the wrong photo. Both guards live in the service:
// the job must be the caller's AND still in progress, and the row must be a
// before/after PROOF image — a Purchase Order, Job Sheet, feedback PDF or
// customer signature can never be removed through this route, because the
// category allowlist is derived from utils/job-image-buckets.js.
//
// TWO METHODS, ONE HANDLER, and the POST is not laziness: the RN app's HTTP
// client has no `delete()` (src/lib/api.ts exposes get/head/post/patch/put),
// so it posts with `_method: 'DELETE'` — exactly what the quotation-line
// delete above already does. DELETE stays the real verb for curl and the CRM.
//
// The path is one segment deeper than `POST /:id/images` (record), so the two
// cannot shadow each other.
const imageDeleteParams = Joi.object({
  id:      Joi.number().integer().positive().required(),
  imageId: Joi.number().integer().positive().required(),
});

async function handleDeleteImage(req, res, next) {
  try {
    logger.info('Delete job image · jobId=' + req.params.id + ' · imageId=' + req.params.imageId);
    const out = await estimateService.deleteImage(
      Number(req.params.id), req.tech.efr_id, Number(req.params.imageId),
    );
    logger.info('Job image deleted · jobId=' + req.params.id + ' · imageId=' + req.params.imageId);
    modernOk(res, out);
  } catch (e) {
    logger.warn('Delete job image failed · jobId=' + req.params.id + ' · imageId=' + req.params.imageId + ' · ' + e.message);
    fail(res, next, e);
  }
}

router.delete('/:id/images/:imageId', validate(imageDeleteParams, 'params'), handleDeleteImage);
router.post('/:id/images/:imageId', validate(imageDeleteParams, 'params'), handleDeleteImage);

// ─── Questionnaire ─────────────────────────────────────────────────────
// GET  /:id/questionnaire → { questions: [...] }
router.get('/:id/questionnaire', validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Fetch questionnaire · jobId=' + req.params.id);
    const out = await estimateService.getQuestionnaire(Number(req.params.id), req.tech.efr_id);
    logger.info('Returning ' + (out.questions ? out.questions.length : 0) + ' questions');
    modernOk(res, out);
  } catch (e) { logger.warn('Fetch questionnaire failed · jobId=' + req.params.id + ' · ' + e.message); fail(res, next, e); }
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
    logger.info('Submit questionnaire · jobId=' + req.params.id + ' · answers=' + ((req.body.answers && req.body.answers.length) || 0));
    const out = await estimateService.submitQuestionnaire(
      Number(req.params.id), req.tech.efr_id, req.body.answers,
    );
    logger.info('Questionnaire submitted · jobId=' + req.params.id + ' · saved=' + (out.count || 0));
    modernOk(res, out);
  } catch (e) { logger.warn('Submit questionnaire failed · jobId=' + req.params.id + ' · ' + e.message); fail(res, next, e); }
});

// ─── Work progress (lifecycle timeline) ────────────────────────────────
// GET /:id/work-progress → { stages: [{ key, label, done, at }] }
router.get('/:id/work-progress', validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Fetch work-progress timeline · jobId=' + req.params.id);
    const out = await estimateService.getWorkProgress(Number(req.params.id), req.tech.efr_id);
    logger.info('Returning ' + (out.stages ? out.stages.length : 0) + ' lifecycle stages');
    modernOk(res, out);
  } catch (e) { logger.warn('Fetch work-progress failed · jobId=' + req.params.id + ' · ' + e.message); fail(res, next, e); }
});

// ─── Material Add Requests (Material Management phase 2, sub-project A) ──
// The Estimate material picker offers master-list materials ONLY, plus
// "Others" — "Others" raises a request here instead of a free-text
// quotation line. See docs/superpowers/specs/2026-09-18-material-add-requests-design.md.
// service_catg_id is stamped from the job server-side; nothing in this body
// can set it. Idempotency-Key is honoured the same way every other mutation
// under /api/mobile/* is — the shared `router.use(idempotency())` mounted in
// routes/mobile/index.js already wraps this route, so a retried key replays
// the first response instead of creating a second request.
// camelCase like every other mobile body in this file (quotationBody's itemId)
// — the app speaks camelCase on the wire; the service and the table keep
// snake_case, so the route maps at the boundary.
const materialRequestBody = Joi.object({
  materialName:  Joi.string().trim().min(1).max(200).required(),
  brandName:     Joi.string().trim().max(150).allow('', null).optional(),
  expectedPrice: Joi.number().min(0).allow(null).optional(),
  quantity:      Joi.number().min(0).allow(null).optional(),
  note:          Joi.string().trim().max(500).allow('', null).optional(),
});

router.post('/:id/material-request', validate(idParam, 'params'), validate(materialRequestBody), async (req, res, next) => {
  try {
    logger.info('Raise material add request · jobId=' + req.params.id + ' · name=' + req.body.materialName);
    const out = await materialRequestService.createFromJob(Number(req.params.id), req.tech.efr_id, {
      material_name: req.body.materialName,
      brand_name: req.body.brandName,
      expected_price: req.body.expectedPrice,
      qty: req.body.quantity,
      note: req.body.note,
    });
    res.status(201);
    modernOk(res, out);
  } catch (e) { logger.warn('Raise material add request failed · jobId=' + req.params.id + ' · ' + e.message); fail(res, next, e); }
});

router.get('/:id/material-requests', validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Fetch material add requests · jobId=' + req.params.id);
    const out = await materialRequestService.listForJob(Number(req.params.id), req.tech.efr_id);
    modernOk(res, out);
  } catch (e) { logger.warn('Fetch material add requests failed · jobId=' + req.params.id + ' · ' + e.message); fail(res, next, e); }
});

module.exports = router;
