/*
 * Admin Actions → Unlock OTP / PIN. Mounted at /api/admin/otp-locks.
 *
 * Every OTP and the job-closing PIN allow 5 attempts per 30 minutes, then lock
 * until the window ends. That lifts by itself, but a user can be locked out by
 * someone else entering wrong codes against their email or mobile, and a
 * technician standing at a finished job cannot wait half an hour. This is the
 * operator's way to lift a lock now.
 *
 *   GET  /?identifier=<email|mobile>     every OTP lock for that person: one
 *                                         row per otp_details flow (CRM, client
 *                                         and technician login, admin actions,
 *                                         change phone/email); for a mobile, the
 *                                         technician app's per-mobile login
 *                                         limits (code requests 20 / code
 *                                         entries 30 per 10 min — any mobile,
 *                                         registered or onboarding); and, if the
 *                                         mobile is a technician's, the profile/
 *                                         bank-change OTP lock.
 *   POST /unlock        { identifier }   lift all of those at once. The per-IP
 *                                         login limits are never touched here.
 *   GET  /job/:id                        the job's closing-PIN lock.
 *   POST /job/:id/unlock                 lift it.
 *
 * GATING: RBAC action `isOtpUnlock` (menu "Admin Action"; seeded and granted to
 * Admin by migrations/executed/2026-09-11-seed-otp-unlock-action.sql), on top of the
 * admin-group floor every /api/admin route has. The job routes also pass
 * scopedJob — an operator can only unlock a job in their own scope, 404
 * otherwise, as on every other admin job route.
 *
 * Nothing here reveals a code. Every unlock is logged with who did it.
 */

const router = require('express').Router();
const Joi = require('joi');
const validate = require('../../middleware/validate');
const requireAction = require('../../middleware/require-action');
const { modernOk, modernError } = require('../../utils/response');
const { maskMobile } = require('../../utils/mask-mobile');
const logger = require('../../logger');
const { pool } = require('../../db');
const otpAttempts = require('../../services/otp-attempts.service');
const {
  checkoutPin, profileOtp, techLoginLimits, clearTechLoginLimits,
} = require('../../services/attempt-window.service');
const { scopedJob } = require('./jobs');

router.use(requireAction('isOtpUnlock'));

// Emails are stored lower-case; mobiles as 10 bare digits.
function normaliseIdentifier(raw) {
  const s = String(raw || '').trim();
  if (s.includes('@')) return s.toLowerCase();
  const digits = s.replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}
const isMobile = (id) => /^\d{10}$/.test(id);
const forLog = (id) => (isMobile(id) ? maskMobile(id) : id.replace(/^(.).*(@.*)$/, '$1…$2'));

const identifierQuery = Joi.object({
  identifier: Joi.string().trim().min(3).max(150).required()
    .messages({ 'any.required': 'Enter an email or mobile number' }),
});

/* The technician whose login mobile this is — the profile/bank OTP goes to it. */
async function technicianFor(identifier) {
  if (!isMobile(identifier)) return null;
  const [[t]] = await pool.query(
    `SELECT efr_id, efr_name FROM tbl_easyfixer
      WHERE efr_no = ? AND NOT (efr_status <=> 3)
      ORDER BY efr_id DESC LIMIT 1`,
    [identifier],
  );
  return t ? { efrId: t.efr_id, name: t.efr_name } : null;
}

async function lookup(identifier) {
  const login = await otpAttempts.locksForIdentifier(identifier);
  const tech = await technicianFor(identifier);
  return {
    identifier,
    capActive: login.active,
    login: login.rows,
    appLoginLimits: isMobile(identifier) ? await techLoginLimits(identifier) : [],
    technician: tech ? { ...tech, profileOtp: await profileOtp.state('efr:' + tech.efrId) } : null,
  };
}

router.get('/', validate(identifierQuery, 'query'), async (req, res, next) => {
  try {
    const identifier = normaliseIdentifier(req.query.identifier);
    if (!identifier) return modernError(res, 400, 'Enter an email or a 10-digit mobile number');
    logger.info('OTP locks looked up · identifier=' + forLog(identifier));
    modernOk(res, await lookup(identifier));
  } catch (e) { next(e); }
});

router.post('/unlock', validate(identifierQuery), async (req, res, next) => {
  try {
    const identifier = normaliseIdentifier(req.body.identifier);
    if (!identifier) return modernError(res, 400, 'Enter an email or a 10-digit mobile number');
    const loginRows = await otpAttempts.unlockIdentifier(identifier);
    const appLimits = isMobile(identifier);
    if (appLimits) await clearTechLoginLimits(identifier);
    const tech = await technicianFor(identifier);
    if (tech) await profileOtp.clear('efr:' + tech.efrId);
    logger.warn(`OTP UNLOCKED by user_id=${req.user && req.user.user_id} · identifier=${forLog(identifier)}`
      + ` · login rows cleared=${loginRows}` + (appLimits ? ' · app login limits cleared' : '')
      + (tech ? ` · technician efr_id=${tech.efrId} profile/bank OTP cleared` : ''));
    modernOk(res, {
      unlocked: true, loginRowsCleared: loginRows, appLoginLimitsCleared: appLimits, technicianCleared: !!tech,
      ...(await lookup(identifier)),
    }, 'Unlocked');
  } catch (e) { next(e); }
});

router.get('/job/:id', validate(Joi.object({ id: Joi.number().integer().positive().required() }), 'params'),
  scopedJob, async (req, res, next) => {
    try {
      const jobId = req.scopedJob.job_id;
      modernOk(res, { jobId, hasPin: req.scopedJob.otp != null && String(req.scopedJob.otp).trim() !== '',
        pin: await checkoutPin.state('job:' + jobId) });
    } catch (e) { next(e); }
  });

router.post('/job/:id/unlock', validate(Joi.object({ id: Joi.number().integer().positive().required() }), 'params'),
  scopedJob, async (req, res, next) => {
    try {
      const jobId = req.scopedJob.job_id;
      await checkoutPin.clear('job:' + jobId);
      logger.warn(`Closing PIN UNLOCKED by user_id=${req.user && req.user.user_id} · job_id=${jobId}`);
      modernOk(res, { unlocked: true, jobId, pin: await checkoutPin.state('job:' + jobId) }, 'Unlocked');
    } catch (e) { next(e); }
  });

module.exports = router;
