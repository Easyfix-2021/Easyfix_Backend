const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { modernOk, modernError } = require('../../utils/response');
const lifecycle = require('../../services/mobile-job-lifecycle.service');
const claims = require('../../services/mobile-job-claims.service');
const { MAX_PROOF_IDS } = require('../../services/job-tx-report.service');
const logger = require('../../logger');

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

// ─── Cancel REQUEST (legacy actionType 27) ──────────────────────────
// POST /jobs/:id/cancel { reasonId, proofImageIds[], reason? } → records the
// technician's ASK. It does NOT cancel the job — ops actions it later from the
// CRM. See THE REQUEST MODEL in services/mobile-job-lifecycle.service.js.
//
// `reasonId` comes from GET /shared/lookup/app-cancel-reasons
// (action_taken_reason, action_type 27, user_type 4).
//
// V3 3.6b (design sheet 08c, 2026-09-24): "proof is required, and EasyFix
// verifies with the customer before anything closes — a cancellation reported
// by a technician is a claim, not a decision." So:
//   · proofImageIds is REQUIRED (≥1 'Proof' photo on this job) and checked
//     BEFORE the ask is recorded, so a bad photo id never leaves a half-ask;
//   · the remark became optional on the sheet (it always was on the wire);
//   · he reached → ₹250 visit charge, recorded with the proof on a 'cancel'
//     tbl_job_tx_report row (mobile-job-claims recordCancelClaim).
// The job row is read BEFORE lifecycle.cancel() because the request model
// parks the job at 1, and both the ₹250 test and the undo need the status he
// was really in.
router.post(
  '/:id/cancel',
  validate(idParam, 'params'),
  validate(Joi.object({
    reason:   Joi.string().trim().max(500).optional().allow('', null),
    reasonId: Joi.number().integer().positive().required(),
    proofImageIds: Joi.array().items(Joi.number().integer().positive()).min(1).max(MAX_PROOF_IDS).required(),
  })),
  async (req, res, next) => {
    try {
      const jobId = Number(req.params.id);
      logger.info('Cancel request · jobId=' + jobId + ' · reasonId=' + req.body.reasonId);
      const before = await lifecycle.getOwnedJob(jobId, req.tech.efr_id);
      await claims.assertProofOnJob(jobId, req.body.proofImageIds);
      const out = await lifecycle.cancel(
        jobId,
        req.tech.efr_id,
        { reason: req.body.reason || null, reasonId: req.body.reasonId },
      );
      const claim = await claims.recordCancelClaim(before, req.tech.efr_id, {
        reasonId: req.body.reasonId, proofImageIds: req.body.proofImageIds,
      }, req.tech.user_id || req.tech.efr_id);
      logger.info('Cancel request recorded · id=' + jobId);
      modernOk(res, { ...out, ...claim });
    } catch (e) { logger.warn('Cancel request failed · jobId=' + req.params.id + ' · ' + e.message); handleErr(res, next, e); }
  },
);

// DUPLICATES REMOVED: `start-work` (duplicated POST /jobs/:id/checkin —
// already transitions BOOKED/SCHEDULED → 2 IN_PROGRESS) and `complete`
// (duplicated POST /jobs/:id/checkout — already transitions → 3 COMPLETED).
// The app consumes those existing routes. `checkout` persists the full
// problem/cash/revisit body (incl. otherRemark → check-out job comment and
// revisit_date + revisit_time_slot) and routes a next-visit to status 10.

// ─── Check-in PIN SMS ────────────────────────────────────────────────
// POST /jobs/:id/checkin-sms → (re)send the customer the check-in PIN.
router.post(
  '/:id/checkin-sms',
  validate(idParam, 'params'),
  async (req, res, next) => {
    try {
      logger.info('Send check-in PIN SMS · jobId=' + req.params.id);
      const out = await lifecycle.sendCheckinSms(Number(req.params.id), req.tech.efr_id);
      logger.info('Check-in PIN SMS dispatched · jobId=' + req.params.id);
      modernOk(res, out);
    } catch (e) { logger.warn('Send check-in SMS failed · jobId=' + req.params.id + ' · ' + e.message); handleErr(res, next, e); }
  },
);

// ─── Reached location ────────────────────────────────────────────────
// POST /jobs/:id/selfie           { selfieImageId, … } → store tx_selfie_id ref
// POST /jobs/:id/reached-location { selfieImageId, … } → same handler
//
// TWO PATHS, ONE HANDLER (not a duplicated route — Express takes the array).
// `/selfie` is the path the shipped app calls (ApiJobService.reachedLocation)
// and the one the legacy Flutter contract named (`jobs/upload-selfie`); it can
// never be renamed away. `/reached-location` is the name the 2026-09-07
// merged-screen contract uses. Aliasing costs one array literal; standing up a
// second handler would fork the ownership guard and the geofence gate.
//
// GEOFENCE (2026-09-07) — every new field is OPTIONAL and the body without them
// behaves exactly as before. Note that `latitude`/`longitude` were ALREADY
// being sent by the shipped app and silently discarded: validate() runs Joi
// with stripUnknown:true, so an unlisted field is dropped, not rejected.
// Listing them here starts recording data that was previously thrown away — it
// cannot break a caller, because no caller was ever 400'd for sending them.
router.post(
  ['/:id/selfie', '/:id/reached-location'],
  validate(idParam, 'params'),
  validate(Joi.object({
    selfieImageId: Joi.number().integer().positive().required(),
    // Bare device fix — the shape the shipped app already sends.
    latitude:  Joi.number().min(-90).max(90).optional().allow(null),
    longitude: Joi.number().min(-180).max(180).optional().allow(null),
    // Contract block. distanceMeters/withinFence are ACCEPTED but advisory:
    // the server recomputes both from the coordinates and its own verdict is
    // what the enforcement gate reads (see recordArrivalGeofence).
    geofence: Joi.object({
      latitude:       Joi.number().min(-90).max(90).required(),
      longitude:      Joi.number().min(-180).max(180).required(),
      distanceMeters: Joi.number().min(0).optional().allow(null),
      withinFence:    Joi.boolean().optional().allow(null),
      overrideReason: Joi.string().trim().max(500).optional().allow('', null),
    }).optional().allow(null),
  })),
  async (req, res, next) => {
    try {
      logger.info('Save reached-location selfie · jobId=' + req.params.id + ' · selfieImageId=' + req.body.selfieImageId);
      const out = await lifecycle.saveSelfie(
        Number(req.params.id),
        req.tech.efr_id,
        {
          selfieImageId: req.body.selfieImageId,
          latitude:      req.body.latitude,
          longitude:     req.body.longitude,
          geofence:      req.body.geofence,
        },
      );
      logger.info('Selfie saved · jobId=' + req.params.id);
      modernOk(res, out);
    } catch (e) { logger.warn('Save selfie failed · jobId=' + req.params.id + ' · ' + e.message); handleErr(res, next, e); }
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
      logger.info('Search job by id · jobId=' + req.query.jobId);
      const job = await lifecycle.searchByJobId(Number(req.query.jobId), req.tech.efr_id);
      if (!job) { logger.warn('Search job not found · jobId=' + req.query.jobId); return modernError(res, 404, 'job not found'); }
      logger.info('Returning job summary · jobId=' + req.query.jobId);
      modernOk(res, job);
    } catch (e) { logger.warn('Search job failed · jobId=' + req.query.jobId + ' · ' + e.message); handleErr(res, next, e); }
  },
);

// ─── Real-time location ping ────────────────────────────────────────
// POST /jobs/:id/location { latitude, longitude, accuracy? } → append a GPS fix
// to the job's live track (tbl_job_location_track) for the CRM map. Sent
// periodically by the app while a job is in progress; ownership-guarded.
router.post(
  '/:id/location',
  validate(idParam, 'params'),
  validate(Joi.object({
    latitude:  Joi.number().min(-90).max(90).required(),
    longitude: Joi.number().min(-180).max(180).required(),
    accuracy:  Joi.number().min(0).optional().allow(null),
  })),
  async (req, res, next) => {
    try {
      logger.info('Record location ping · jobId=' + req.params.id + ' · accuracy=' + (req.body.accuracy != null ? req.body.accuracy : 'n/a'));
      const data = await lifecycle.recordLocationPing(
        Number(req.params.id), req.tech.efr_id, req.body,
      );
      modernOk(res, data);
    } catch (e) { logger.warn('Record location ping failed · jobId=' + req.params.id + ' · ' + e.message); handleErr(res, next, e); }
  },
);

// ─── Questionnaire (recce checklist) ────────────────────────────────
// GET /jobs/:id/questionnaire → { items:[{id,question,mandatory,answer?,remark?}] }
router.get(
  '/:id/questionnaire',
  validate(idParam, 'params'),
  async (req, res, next) => {
    try {
      logger.info('Fetch recce questionnaire · jobId=' + req.params.id);
      const items = await lifecycle.getQuestionnaire(Number(req.params.id), req.tech.efr_id);
      logger.info('Returning ' + (items ? items.length : 0) + ' questionnaire items');
      modernOk(res, { items });
    } catch (e) { logger.warn('Fetch recce questionnaire failed · jobId=' + req.params.id + ' · ' + e.message); handleErr(res, next, e); }
  },
);

// POST /jobs/:id/questionnaire { answers:[{questionId, answer(bool), remark?}] }
router.post(
  '/:id/questionnaire',
  validate(idParam, 'params'),
  validate(Joi.object({
    answers: Joi.array().items(Joi.object({
      questionId: Joi.number().integer().positive().required(),
      answer:     Joi.boolean().required(),
      remark:     Joi.string().max(1000).allow('', null).optional(),
    })).min(1).required(),
  })),
  async (req, res, next) => {
    try {
      logger.info('Submit recce questionnaire · jobId=' + req.params.id + ' · answers=' + ((req.body.answers && req.body.answers.length) || 0));
      const data = await lifecycle.submitQuestionnaire(
        Number(req.params.id), req.tech.efr_id, req.body.answers,
      );
      logger.info('Recce questionnaire submitted · jobId=' + req.params.id);
      modernOk(res, data);
    } catch (e) { logger.warn('Submit recce questionnaire failed · jobId=' + req.params.id + ' · ' + e.message); handleErr(res, next, e); }
  },
);

// ─── Work progress ──────────────────────────────────────────────────
// GET /jobs/:id/work-progress → the completion-stage snapshot (problem/cash/revisit).
router.get(
  '/:id/work-progress',
  validate(idParam, 'params'),
  async (req, res, next) => {
    try {
      logger.info('Fetch work-progress snapshot · jobId=' + req.params.id);
      const data = await lifecycle.getWorkProgress(Number(req.params.id), req.tech.efr_id);
      modernOk(res, data);
    } catch (e) { logger.warn('Fetch work-progress snapshot failed · jobId=' + req.params.id + ' · ' + e.message); handleErr(res, next, e); }
  },
);

module.exports = router;
