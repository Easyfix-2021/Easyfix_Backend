const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { modernOk, modernError } = require('../../utils/response');
const svc = require('../../services/mobile-profile-extra.service');

/*
 * /api/mobile/profile-extra/* — Technician-app "profile extras" surface.
 *
 * Covers the legacy Dropwizard `easyfixers/*`, `upi-details`,
 * `training-video/*`, `version`, `logout` endpoints, plus the
 * earnings / icard / ratings reads. Maps them onto the new
 * `/api/mobile/*` contract (see docs/migration-blueprint.md §4.2).
 *
 * AUTH: `requireTechAuth` is applied UPSTREAM in routes/mobile/index.js
 * via `router.use(requireTechAuth)` BEFORE this sub-router is mounted —
 * so `req.tech` (and thus `req.tech.efr_id`) is always populated here.
 * Every handler scopes strictly to `req.tech.efr_id`; no technician id
 * is ever accepted from the body/query/params.
 *
 * Mount (added in routes/mobile/index.js AFTER requireTechAuth):
 *   router.use('/profile-extra', require('./profile-extra'));
 *
 * NOTE: the paths in this file are RELATIVE to that mount, so they read
 * e.g. `/profile/editable`, `/earnings`, `/icard`, `/upi-details`.
 */

// ─── Date-window query schema (shared by windowed reads) ─────────────
// `from` / `to` are inclusive YYYY-MM-DD bounds. Both optional.
const dateWindow = Joi.object({
  from: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

// ─────────────────────────────────────────────────────────────────────
// Profile extras
// ─────────────────────────────────────────────────────────────────────

// DUPLICATE REMOVED: `POST /profile/editable` (getEditableProfile) was
// removed — it duplicates the existing `GET /profile`, which returns the
// full tbl_easyfixer row the app reads its editable fields from.

// Update display name.
router.patch('/profile/name', validate(Joi.object({
  name: Joi.string().trim().min(1).max(255).required(),
})), async (req, res, next) => {
  try {
    modernOk(res, await svc.updateName(req.tech.efr_id, req.body.name));
  } catch (e) { next(e); }
});

/*
 * Set the profile image. The binary is uploaded via the generic
 * doc/image upload endpoint first; this call persists the resulting
 * reference (`imageId` = S3 key / file id).
 *
 * VERIFY: the RN app may instead POST the file as multipart directly to
 * this route. If so, swap this JSON body for a multer single-file
 * handler + job-upload.service. For now we take the already-uploaded
 * `imageId` (the simpler, upload-then-link flow).
 */
router.post('/profile/image', validate(Joi.object({
  imageId: Joi.string().trim().min(1).max(1024).required(),
})), async (req, res, next) => {
  try {
    modernOk(res, await svc.setProfileImage(req.tech.efr_id, req.body.imageId));
  } catch (e) { next(e); }
});

// Weekly performance chart.
router.get('/profile/performance/weekly', validate(dateWindow, 'query'), async (req, res, next) => {
  try {
    modernOk(res, await svc.getWeeklyPerformance(req.tech.efr_id, {
      from: req.query.from,
      to: req.query.to,
    }));
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────
// Earnings
// ─────────────────────────────────────────────────────────────────────

router.get('/earnings', validate(dateWindow, 'query'), async (req, res, next) => {
  try {
    modernOk(res, await svc.getEarnings(req.tech.efr_id, {
      from: req.query.from,
      to: req.query.to,
    }));
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────
// I-Card
// ─────────────────────────────────────────────────────────────────────

router.get('/icard', async (req, res, next) => {
  try {
    modernOk(res, await svc.getICard(req.tech.efr_id));
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────
// Ratings
// ─────────────────────────────────────────────────────────────────────

router.get('/ratings', validate(dateWindow, 'query'), async (req, res, next) => {
  try {
    modernOk(res, await svc.getRatings(req.tech.efr_id, {
      from: req.query.from,
      to: req.query.to,
    }));
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────
// Training videos — watched %
// ─────────────────────────────────────────────────────────────────────

router.get('/training-videos/percentage', async (req, res, next) => {
  try {
    modernOk(res, await svc.getTrainingPercentages(req.tech.efr_id));
  } catch (e) { next(e); }
});

router.post('/training-videos/percentage', validate(Joi.object({
  videoId: Joi.number().integer().positive().required(),
  watchedPercentage: Joi.number().integer().min(0).max(100).required(),
})), async (req, res, next) => {
  try {
    modernOk(res, await svc.setTrainingPercentage(
      req.tech.efr_id,
      req.body.videoId,
      req.body.watchedPercentage,
    ));
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────
// App version
// ─────────────────────────────────────────────────────────────────────

router.get('/app-version', (_req, res, next) => {
  try {
    modernOk(res, svc.getAppVersion());
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────
// Logout — device deregister
// ─────────────────────────────────────────────────────────────────────

router.post('/logout', validate(Joi.object({
  deviceId: Joi.string().trim().max(255).optional(),
})), async (req, res, next) => {
  try {
    modernOk(res, await svc.logout(req.tech.efr_id, req.body.deviceId || null));
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────
// UPI details
// ─────────────────────────────────────────────────────────────────────

router.get('/upi-details', async (req, res, next) => {
  try {
    modernOk(res, await svc.getUpiDetails(req.tech.efr_id));
  } catch (e) { next(e); }
});

router.post('/upi-details', validate(Joi.object({
  upiId: Joi.string().trim().min(3).max(255).required(),
  isPrimary: Joi.boolean().optional(),
})), async (req, res, next) => {
  try {
    modernOk(res, await svc.addUpiDetail(
      req.tech.efr_id,
      req.body.upiId,
      req.body.isPrimary === true,
    ));
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────
// KYC — Aadhaar/PAN duplicate-check
// ─────────────────────────────────────────────────────────────────────

/*
 * `:number` is a bare Aadhaar (12 digits) or PAN (ABCDE1234F). We
 * validate the param shape and exclude the caller's own row so a
 * re-save of an unchanged number isn't a false duplicate.
 */
router.get('/kyc/aadhaar-pan-exists/:number', validate(Joi.object({
  number: Joi.string().trim().pattern(/^([0-9]{12}|[A-Za-z]{5}[0-9]{4}[A-Za-z])$/).required(),
}), 'params'), async (req, res, next) => {
  try {
    modernOk(res, await svc.aadhaarPanExists(req.params.number, req.tech.efr_id));
  } catch (e) { next(e); }
});

module.exports = router;
