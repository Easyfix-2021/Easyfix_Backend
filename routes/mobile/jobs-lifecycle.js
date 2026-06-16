const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { modernOk, modernError } = require('../../utils/response');
const lifecycle = require('../../services/mobile-job-lifecycle.service');

/*
 * /api/mobile/jobs/* — Technician-app order lifecycle sub-router.
 *
 * Auth: requireTechAuth is applied UPSTREAM in routes/mobile/index.js via
 * `router.use(requireTechAuth)` BEFORE this router is mounted, so by the
 * time a request lands here `req.tech` is populated. Every handler scopes
 * to `req.tech.efr_id`; the service ALSO pins `fk_easyfixter_id = ?` on
 * each mutation as a second ownership guard.
 *
 * Mounts (added in routes/mobile/index.js):
 *   router.use('/jobs', require('./jobs-lifecycle'));
 *
 * Sits ALONGSIDE the existing /jobs/:id/{accept,reject,eta,checkin,checkout,
 * reschedule} handlers in routes/mobile/index.js — Express merges the two
 * routers on the shared /jobs prefix; the paths here don't collide with
 * those.
 *
 * Response envelope: modern { success, data }. Mutations return a small
 * ack ({ cancelled:true } / { ok:true } / { completed:true }); search
 * returns the compact job detail summary (or 404 when not the tech's job).
 */

// Shared param schema — :id must be a positive integer.
const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

// Small helper: map a tagged service error (.status) to a modern error,
// else hand off to the Express error pipeline. Mirrors the pattern used
// throughout routes/mobile/index.js.
function handleErr(res, next, e) {
  if (e && e.status) return modernError(res, e.status, e.message);
  return next(e);
}

// ─── Cancel (legacy actionType 27) ──────────────────────────────────
// POST /jobs/:id/cancel { reason, reasonId } → job_status 6 + reason.
router.post(
  '/:id/cancel',
  validate(idParam, 'params'),
  validate(Joi.object({
    reason:   Joi.string().trim().max(500).optional().allow('', null),
    reasonId: Joi.number().integer().positive().required(),
  })),
  async (req, res, next) => {
    try {
      const out = await lifecycle.cancel(
        Number(req.params.id),
        req.tech.efr_id,
        { reason: req.body.reason || null, reasonId: req.body.reasonId },
      );
      modernOk(res, out);
    } catch (e) { handleErr(res, next, e); }
  },
);

// DUPLICATES REMOVED: `start-work` (duplicated POST /jobs/:id/checkin —
// already transitions BOOKED/SCHEDULED → 2 IN_PROGRESS) and `complete`
// (duplicated POST /jobs/:id/checkout — already transitions → 3 COMPLETED).
// The app consumes those existing routes. The problem/cash/revisit body +
// revisit(→10) routing will be added to `checkout` in a later iteration.

// ─── Check-in PIN SMS ────────────────────────────────────────────────
// POST /jobs/:id/checkin-sms → (re)send the customer the check-in PIN.
router.post(
  '/:id/checkin-sms',
  validate(idParam, 'params'),
  async (req, res, next) => {
    try {
      const out = await lifecycle.sendCheckinSms(Number(req.params.id), req.tech.efr_id);
      modernOk(res, out);
    } catch (e) { handleErr(res, next, e); }
  },
);

// ─── Reached-location selfie ─────────────────────────────────────────
// POST /jobs/:id/selfie { selfieImageId } → store tx_selfie_id ref.
router.post(
  '/:id/selfie',
  validate(idParam, 'params'),
  validate(Joi.object({
    selfieImageId: Joi.number().integer().positive().required(),
  })),
  async (req, res, next) => {
    try {
      const out = await lifecycle.saveSelfie(
        Number(req.params.id),
        req.tech.efr_id,
        { selfieImageId: req.body.selfieImageId },
      );
      modernOk(res, out);
    } catch (e) { handleErr(res, next, e); }
  },
);

// ─── Dashboard search by job id ─────────────────────────────────────
// GET /jobs/search?jobId= → compact job detail summary (tech-scoped).
//
// ROUTE-ORDERING REQUIREMENT (see the mount-line report): this sub-router
// MUST be mounted in routes/mobile/index.js BEFORE the existing
// `router.get('/jobs/:id', ...)` handler (currently ~line 177). Express
// matches in registration order, and `/jobs/:id` would otherwise capture
// "search" as the :id (then 404, since Number('search') is NaN). Mounting
// `router.use('/jobs', require('./jobs-lifecycle'))` right after the
// `/notices` mount (~line 133) puts every literal path in this file
// (/cancel, /start-work, /complete, /search, …) ahead of the parametric
// `/jobs/:id` GET — no collision. The contract uses the `jobId` QUERY
// param: callers hit GET /jobs/search?jobId=123.
router.get(
  '/search',
  validate(Joi.object({
    jobId: Joi.number().integer().positive().required(),
  }), 'query'),
  async (req, res, next) => {
    try {
      const job = await lifecycle.searchByJobId(Number(req.query.jobId), req.tech.efr_id);
      if (!job) return modernError(res, 404, 'job not found');
      modernOk(res, job);
    } catch (e) { handleErr(res, next, e); }
  },
);

module.exports = router;
