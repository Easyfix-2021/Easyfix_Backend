'use strict';
/*
 * routes/admin/jobs-phase4.js — V3 Phase 4 on the CRM job: Tools to Carry
 * (D8), Products at Site (D9), the customer's signature (D6) and the desk's
 * Schedule Visit 2 (D7). Mounted under /jobs from routes/admin/index.js beside
 * job-charges / job-documents; every path is /:id/<word>…, disjoint from
 * routes/admin/jobs.js.
 *
 * The tool PICKER needs no route here: GET /admin/tools (routes/admin/tools.js)
 * already lists ACTIVE tbl_tools by default, bounded (limit ≤ 1000, default 200).
 *
 * GATES
 *   reads (GET)          scope only (scopedJob), like GET /jobs/:id.
 *   tools / products     isJobEdit — the key the CRM's Edit Services control
 *   writes                 checks (JobContextPanel canEditServices =
 *                          hasAction(me, 'isJobEdit')), and the key PUT /jobs/:id
 *                          requires for services.
 *   schedule-visit-two   isJobAppRequestResolve (the ops desk's key, see
 *                          ops-desk.js) + Job Stage Access for the 10 → 1 move
 *                          (requireStageForTransition('assign') targets 1).
 * Out of scope is a 404 (scopedJob), never a 403.
 */
const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const requireAction = require('../../middleware/require-action');
const requireStageForTransition = require('../../middleware/require-stage');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');
const extras = require('../../services/job-extras.service');
const signature = require('../../services/job-signature.service');
const { scopedJob } = require('./jobs');

const canEdit = requireAction('isJobEdit');
const idParam = Joi.object({ id: Joi.number().integer().positive().required() });
const rowParam = idParam.keys({ rowId: Joi.number().integer().positive().required() });

function fail(res, next, e) {
  if (e && e.status) return modernError(res, e.status, e.code ? { message: e.message, code: e.code } : e.message);
  return next(e);
}

// ─── GET /jobs/:id/tools → { items: [{id, name}] } ─────────────────────────
router.get('/:id/tools', validate(idParam, 'params'), scopedJob, async (req, res, next) => {
  try { modernOk(res, { items: await extras.listJobTools(req.params.id) }); } catch (e) { fail(res, next, e); }
});

// ─── PUT /jobs/:id/tools { toolIds: int[] } → { items } — replaces the set ──
router.put('/:id/tools', canEdit, validate(idParam, 'params'),
  validate(Joi.object({
    toolIds: Joi.array().items(Joi.number().integer().positive()).max(extras.MAX_TOOLS).unique().required(),
  })),
  scopedJob,
  async (req, res, next) => {
    try {
      logger.info(`Set job tools · jobId=${req.params.id} · count=${req.body.toolIds.length} · by userId=${req.user.user_id}`);
      modernOk(res, { items: await extras.setJobTools(req.params.id, req.body.toolIds, req.user) }, 'tools saved');
    } catch (e) { fail(res, next, e); }
  });

// ─── GET /jobs/:id/site-products → { items: [{id, name, qty, brand}] } ────
router.get('/:id/site-products', validate(idParam, 'params'), scopedJob, async (req, res, next) => {
  try { modernOk(res, { items: await extras.listSiteProducts(req.params.id) }); } catch (e) { fail(res, next, e); }
});

// ─── POST /jobs/:id/site-products { name, qty?, brand? } → the row ─────────
router.post('/:id/site-products', canEdit, validate(idParam, 'params'),
  validate(Joi.object({
    name: Joi.string().trim().min(1).max(160).required(),
    qty: Joi.number().integer().min(1).max(999).default(1),
    brand: Joi.string().trim().max(80).allow('', null).optional(),
  })),
  scopedJob,
  async (req, res, next) => {
    try {
      const row = await extras.addSiteProduct(req.params.id, req.body, req.user);
      res.status(201);
      modernOk(res, row, 'product added');
    } catch (e) { fail(res, next, e); }
  });

// ─── DELETE /jobs/:id/site-products/:rowId → { removed: true } ─────────────
router.delete('/:id/site-products/:rowId', canEdit, validate(rowParam, 'params'), scopedJob, async (req, res, next) => {
  try { modernOk(res, await extras.removeSiteProduct(req.params.id, req.params.rowId, req.user), 'product removed'); } catch (e) { fail(res, next, e); }
});

// ─── GET /jobs/:id/signature → { svg, width, height, signedOn } | null ─────
router.get('/:id/signature', validate(idParam, 'params'), scopedJob, async (req, res, next) => {
  try { modernOk(res, await signature.getSignature(req.params.id)); } catch (e) { fail(res, next, e); }
});

// ─── POST /jobs/:id/schedule-visit-two { visitOn } → the job (10 → 1) ──────
router.post('/:id/schedule-visit-two', requireAction('isJobAppRequestResolve'), validate(idParam, 'params'),
  validate(Joi.object({
    visitOn: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/).required(),
  })),
  scopedJob,
  requireStageForTransition('assign'),
  async (req, res, next) => {
    try {
      logger.info(`Schedule visit 2 · jobId=${req.params.id} · on=${req.body.visitOn} · by userId=${req.user.user_id}`);
      modernOk(res, await extras.scheduleVisitTwo(req.scopedJob, req.body, req.user), 'visit 2 scheduled');
    } catch (e) { fail(res, next, e); }
  });

module.exports = router;
