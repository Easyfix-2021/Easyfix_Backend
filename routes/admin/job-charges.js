const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { requirePropertyAllowlist } = require('../../middleware/require-property-allowlist');
const { FEATURES } = require('../../services/feature-access.service');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');
const charges = require('../../services/job-charges.service');
const { scopedJob } = require('./jobs');

/*
 * Billing & Charges — job-workspace tab (mounted at /api/admin/jobs).
 *
 * Row scope: every endpoint runs `scopedJob` so a caller can only touch jobs
 * inside their manage_* RBAC scope (404 on out-of-scope, no existence leak).
 *
 * Gating: all MUTATING endpoints are further gated by the property allowlist
 * `job.charges.emails` (FEATURES.canManageJobCharges) — the same fail-closed,
 * NOT-RBAC model as Build Skill Matrix. The READ endpoint is scope-only so the
 * tab can render for any in-scope operator; the FE hides the write controls via
 * the `canManageJobCharges` flag on /auth/me.
 *
 * See services/job-charges.service.js for the legacy column/semantics rationale
 * (job_material typed rows, is_pre_approved=1, client_charge>=tx_charge, IST
 * stamping) and tbl_job_services.approval_by_client billing approval.
 */

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });
const chargeParams = Joi.object({
  id: Joi.number().integer().positive().required(),
  chargeId: Joi.number().integer().positive().required(),
});
const serviceParams = Joi.object({
  id: Joi.number().integer().positive().required(),
  jobServiceId: Joi.number().integer().positive().required(),
});

const penaltyBody = Joi.object({
  txCharge: Joi.number().min(0).required(),
  clientCharge: Joi.number().min(0).required(),
  reason: Joi.string().max(255).allow('', null).optional(),
  isClientApprovalNeeded: Joi.boolean().truthy(1).falsy(0).default(false),
  documentName: Joi.string().max(255).allow('', null).optional(),
});
const travelBody = Joi.object({
  fromCityName: Joi.string().max(255).allow('', null).optional(),
  toCityName: Joi.string().max(255).allow('', null).optional(),
  totalDistance: Joi.number().integer().min(0).required(),
  txUnit: Joi.number().integer().min(0).required(),
  clientUnit: Joi.number().integer().min(0).required(),
  txCharge: Joi.number().min(0).required(),
  clientCharge: Joi.number().min(0).required(),
  isClientApprovalNeeded: Joi.boolean().truthy(1).falsy(0).default(false),
  documentName: Joi.string().max(255).allow('', null).optional(),
});
const incentiveBody = Joi.object({
  reason: Joi.string().max(255).allow('', null).optional(),
  txCharge: Joi.number().min(0).required(),
  clientCharge: Joi.number().min(0).required(),
  isClientApprovalNeeded: Joi.boolean().truthy(1).falsy(0).default(false),
  documentName: Joi.string().max(255).allow('', null).optional(),
});
// Edit is type-agnostic at the route; the service resolves the row's type and
// enforces the per-type required-field set. Superset schema, all optional.
const editBody = Joi.object({
  txCharge: Joi.number().min(0).optional(),
  clientCharge: Joi.number().min(0).optional(),
  reason: Joi.string().max(255).allow('', null).optional(),
  fromCityName: Joi.string().max(255).allow('', null).optional(),
  toCityName: Joi.string().max(255).allow('', null).optional(),
  totalDistance: Joi.number().integer().min(0).optional(),
  txUnit: Joi.number().integer().min(0).optional(),
  clientUnit: Joi.number().integer().min(0).optional(),
  isClientApprovalNeeded: Joi.boolean().truthy(1).falsy(0).optional(),
  documentName: Joi.string().max(255).allow('', null).optional(),
}).min(1);
const approvalBody = Joi.object({
  isClientApprovalNeeded: Joi.boolean().truthy(1).falsy(0).required(),
});
const serviceApprovalBody = Joi.object({
  approvalByClient: Joi.number().integer().valid(0, 1).required(),
});

// Translate a thrown service error carrying a `status` into a modern error.
function fail(res, e, next) {
  if (e && e.status) return modernError(res, e.status, e.message, e.missing ? { missing: e.missing } : undefined);
  return next(e);
}

// ─── READ (scope only — no property gate) ────────────────────────────
router.get('/:id/charges', validate(idParam, 'params'), scopedJob, async (req, res, next) => {
  try {
    return modernOk(res, await charges.getCharges(req.params.id));
  } catch (e) { next(e); }
});

// Property gate for every MUTATING endpoint below. Stacks UNDER the admin
// group's requireAuth + role(['admin']) already applied in routes/admin/index.js.
const gate = requirePropertyAllowlist(FEATURES.canManageJobCharges, { label: 'Manage Job Charges' });

// ─── CREATE charges (job_material typed rows) ────────────────────────
router.post('/:id/penalty', gate, validate(idParam, 'params'), validate(penaltyBody), scopedJob, async (req, res, next) => {
  try {
    const out = await charges.createPenalty(req.params.id, req.body, req.user.user_id);
    res.status(201);
    return modernOk(res, out, 'penalty added');
  } catch (e) { return fail(res, e, next); }
});

router.post('/:id/travel', gate, validate(idParam, 'params'), validate(travelBody), scopedJob, async (req, res, next) => {
  try {
    const out = await charges.createTravel(req.params.id, req.body, req.user.user_id);
    res.status(201);
    return modernOk(res, out, 'travel added');
  } catch (e) { return fail(res, e, next); }
});

router.post('/:id/incentive', gate, validate(idParam, 'params'), validate(incentiveBody), scopedJob, async (req, res, next) => {
  try {
    const out = await charges.createIncentive(req.params.id, req.body, req.user.user_id);
    res.status(201);
    return modernOk(res, out, 'incentive added');
  } catch (e) { return fail(res, e, next); }
});

// ─── EDIT a charge (same fields as its type) ─────────────────────────
router.patch('/:id/charges/:chargeId', gate, validate(chargeParams, 'params'), validate(editBody), scopedJob, async (req, res, next) => {
  try {
    const out = await charges.editCharge(req.params.id, req.params.chargeId, req.body, req.user.user_id);
    return modernOk(res, out, 'charge updated');
  } catch (e) { return fail(res, e, next); }
});

// ─── EDIT only the client-approval flag ──────────────────────────────
router.patch('/:id/charges/:chargeId/approval', gate, validate(chargeParams, 'params'), validate(approvalBody), scopedJob, async (req, res, next) => {
  try {
    const out = await charges.setChargeApproval(req.params.id, req.params.chargeId, req.body.isClientApprovalNeeded, req.user.user_id);
    return modernOk(res, out, 'approval flag updated');
  } catch (e) { return fail(res, e, next); }
});

// ─── DELETE a charge (guarded to Penalty/Travel/Incentive only) ──────
router.delete('/:id/charges/:chargeId', gate, validate(chargeParams, 'params'), scopedJob, async (req, res, next) => {
  try {
    const out = await charges.deleteCharge(req.params.id, req.params.chargeId);
    return modernOk(res, out, 'charge deleted');
  } catch (e) { return fail(res, e, next); }
});

// ─── SERVICE billing approval (tbl_job_services.approval_by_client) ──
router.patch('/:id/services/:jobServiceId/approval', gate, validate(serviceParams, 'params'), validate(serviceApprovalBody), scopedJob, async (req, res, next) => {
  try {
    const out = await charges.setServiceApproval(req.params.id, req.params.jobServiceId, req.body.approvalByClient);
    return modernOk(res, out, 'service approval updated');
  } catch (e) { return fail(res, e, next); }
});

module.exports = router;
