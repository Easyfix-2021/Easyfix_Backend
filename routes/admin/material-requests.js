const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const requireAction = require('../../middleware/require-action');
const svc = require('../../services/material-request.service');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');

/*
 * Settings › Manage Materials › Material Requests (Material Management
 * phase 2, sub-project A). See
 * docs/superpowers/specs/2026-09-18-material-add-requests-design.md.
 *
 * GET routes reuse isMaterialView; approve/reject require isMaterialAddNew
 * (same key phase-1 "Add Material" uses — approving a request IS adding a
 * material). No new action keys are seeded for this sub-project.
 */

const userIdOf = (req) => (req.user && req.user.user_id) || null;

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const listQuery = Joi.object({
  status: Joi.string().valid('pending', 'approved', 'rejected', 'all').default('pending'),
  search: Joi.string().allow('', null).optional(),
  page:   Joi.number().integer().min(0).default(0),
  limit:  Joi.number().integer().min(1).max(1000).default(20),
});

// Same group-payload shape as phase-1 "Add Material" (routes/admin/materials.js
// writeBody) — the reviewer can edit everything the request pre-filled. All
// optional at the Joi layer: link_material_id skips material creation
// entirely, and material.service.createMaterial() enforces its own
// business-rule requirements (name/category/pricing_type) with the
// appropriate status codes when no link is given.
const stateEntry = Joi.object({
  price: Joi.number().min(0).allow(null).optional(),
  state_ids: Joi.array().items(Joi.number().integer().positive()).min(1).required(),
});
const groupEntry = Joi.object({
  price: Joi.number().min(0).allow(null).optional(),
  brand_ids: Joi.array().items(Joi.number().integer().positive()).default([]),
  states: Joi.array().items(stateEntry).default([]),
});
const approveBody = Joi.object({
  link_material_id: Joi.number().integer().positive().optional(),
  material_name: Joi.string().trim().min(1).max(200).optional(),
  description: Joi.string().trim().max(1000).allow('', null).optional(),
  service_catg_id: Joi.number().integer().positive().optional(),
  uom_id: Joi.number().integer().positive().allow(null).optional(),
  pricing_type: Joi.string().valid('FIXED', 'DYNAMIC').optional(),
  groups: Joi.array().items(groupEntry).default([]),
});

// reject_reason is intentionally NOT `.required()` here — a missing reason
// must surface as the spec's 422 (a business rule), not Joi's generic 400.
const rejectBody = Joi.object({
  reject_reason: Joi.string().trim().max(500).allow('', null).optional(),
});

function sendSvcError(res, next, e) {
  if (e.status) return modernError(res, e.status, e.message, e.existing_material_id ? { existing_material_id: e.existing_material_id } : undefined);
  return next(e);
}

router.get('/', requireAction('isMaterialView'), validate(listQuery, 'query'), async (req, res, next) => {
  try { modernOk(res, await svc.listRequests(req.query)); } catch (e) { next(e); }
});

router.get('/count', requireAction('isMaterialView'), validate(Joi.object({ status: Joi.string().valid('pending', 'approved', 'rejected', 'all').default('pending') }), 'query'), async (req, res, next) => {
  try { modernOk(res, await svc.countRequests(req.query)); } catch (e) { next(e); }
});

router.post('/:id/approve', requireAction('isMaterialAddNew'), validate(idParam, 'params'), validate(approveBody), async (req, res, next) => {
  logger.info('Approve material request · id=' + req.params.id);
  try { modernOk(res, await svc.approveRequest(Number(req.params.id), req.body, { userId: userIdOf(req) })); }
  catch (e) { sendSvcError(res, next, e); }
});

router.post('/:id/reject', requireAction('isMaterialAddNew'), validate(idParam, 'params'), validate(rejectBody), async (req, res, next) => {
  logger.info('Reject material request · id=' + req.params.id);
  try { modernOk(res, await svc.rejectRequest(Number(req.params.id), req.body, { userId: userIdOf(req) })); }
  catch (e) { sendSvcError(res, next, e); }
});

module.exports = router;
