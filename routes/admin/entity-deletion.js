const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { requirePropertyAllowlist } = require('../../middleware/require-property-allowlist');
const { FEATURES } = require('../../services/feature-access.service');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');

const actionOtp = require('../../services/action-otp.service');
const deletion = require('../../services/entity-deletion.service');
const { getProperty } = require('../../services/properties.service');
const emailService = require('../../services/email.service');

/*
 * Admin Actions → Delete Easyfixer/User + Restore (OTP-gated, tombstone).
 *
 * Mounted at /api/admin/entity-deletion (requireAuth + role(['admin']) already
 * applied by the parent admin router). This whole sub-router is gated PER-USER
 * by an easyfix_properties email allowlist (FEATURES.canDeleteEntities) via
 * requirePropertyAllowlist below — the delete/restore flow is restricted to
 * named operators and is NOT grantable from Manage Role / RBAC (it has no
 * menu_action rows). Never trust the FE's button-hiding.
 *
 * Flow:
 *   POST /impact            { entityType, id }            → eligibility + blockers (read-only)
 *   POST /request-otp       { entityType, id }            → 409 if blocked, else OTP to admin's mobile
 *   POST /confirm           { entityType, id, reason, otp}→ verify OTP, tombstone-delete, email notice
 *   GET  /deleted           ?type&limit&offset            → archived (restorable) records
 *   POST /restore/request-otp { archiveId }               → OTP to admin's mobile
 *   POST /restore/confirm   { archiveId, otp }            → verify OTP, restore on the same id
 */

const entityType = Joi.string().valid('easyfixer', 'user');
const intId = Joi.number().integer().positive();
// OTP arrives as a 4-digit code; accept number or numeric string.
const otp = Joi.alternatives(Joi.number().integer(), Joi.string().trim().pattern(/^\d{3,6}$/));

// Per-USER gate for the ENTIRE sub-router: access is restricted to the emails
// on the easyfix_properties allowlist (access.entitydelete.emails), NOT a role
// or RBAC grant — so it can't be granted from Manage Role. The parent admin
// router's role(['admin']) group gate still applies as a floor.
router.use(requirePropertyAllowlist(FEATURES.canDeleteEntities, { label: 'Delete / Restore Easyfixer-User' }));

// ─── Impact (read-only) ─────────────────────────────────────────────
router.post(
  '/impact',
  validate(Joi.object({ entityType: entityType.required(), id: intId.required() })),
  async (req, res, next) => {
    try {
      logger.info('Delete impact check · entityType=' + req.body.entityType + ' id=' + req.body.id);
      const impact = await deletion.getImpact(req.body.entityType, req.body.id);
      logger.info('Delete impact · id=' + req.body.id + ' eligible=' + impact.eligible);
      return modernOk(res, impact);
    } catch (err) {
      if (err.status) { logger.warn('Delete impact check failed · ' + err.message); return modernError(res, err.status, err.message); }
      return next(err);
    }
  },
);

// ─── Request delete OTP ─────────────────────────────────────────────
router.post(
  '/request-otp',
  validate(Joi.object({ entityType: entityType.required(), id: intId.required() })),
  async (req, res, next) => {
    try {
      logger.info('Request delete OTP · entityType=' + req.body.entityType + ' id=' + req.body.id);
      // Re-check eligibility BEFORE sending an OTP — never let an operator OTP
      // their way into deleting an entity with operational history.
      const impact = await deletion.getImpact(req.body.entityType, req.body.id);
      if (!impact.eligible) {
        logger.warn('Delete OTP refused — record has operational history · id=' + req.body.id);
        return modernError(res, 409,
          'This record has operational history and cannot be deleted — deactivate it instead.',
          impact.blockedBy);
      }
      const { delivered, expiresAt } = await actionOtp.sendActionOtp(req.user, 'delete');
      logger.info('Delete OTP sent · id=' + req.body.id + ' delivered=' + delivered);
      return modernOk(res, {
        delivered, expiresAt, label: impact.label,
        message: 'An OTP has been sent to your registered mobile.',
      });
    } catch (err) {
      if (err.status) { logger.warn('Request delete OTP failed · ' + err.message); return modernError(res, err.status, err.message, err.details); }
      return next(err);
    }
  },
);

// ─── Confirm delete (verify OTP → tombstone → email notice) ─────────
router.post(
  '/confirm',
  validate(Joi.object({
    entityType: entityType.required(),
    id: intId.required(),
    reason: Joi.string().trim().min(3).max(500).required(),
    otp: otp.required(),
  })),
  async (req, res, next) => {
    try {
      logger.info('Confirm delete · entityType=' + req.body.entityType + ' id=' + req.body.id);
      const { valid, reason: otpReason } = await actionOtp.verifyActionOtp(req.user, 'delete', req.body.otp);
      if (!valid) { logger.warn('Confirm delete — OTP verification failed · id=' + req.body.id + ' · ' + otpReason); return modernError(res, 401, `OTP verification failed: ${otpReason}`); }

      const result = await deletion.tombstoneDelete(
        req.body.entityType, req.body.id, req.body.reason, req.user,
      );
      logger.info(req.body.entityType + ' deleted · id=' + result.id);

      // Best-effort notification — the delete is already committed; an email
      // failure must never surface as a delete failure.
      sendDeletionNotice(req.body.entityType, result, req.body.reason, req.user)
        .catch((e) => logger.warn({ err: e.message }, 'deletion-notice email failed'));

      return modernOk(res, { ...result, message: 'Record deleted and archived for restore.' });
    } catch (err) {
      if (err.status) { logger.warn('Confirm delete failed · id=' + req.body.id + ' · ' + err.message); return modernError(res, err.status, err.message, err.details); }
      return next(err);
    }
  },
);

// ─── List archived (restorable) records ─────────────────────────────
router.get(
  '/deleted',
  async (req, res, next) => {
    try {
      const type = req.query.type === 'easyfixer' || req.query.type === 'user' ? req.query.type : undefined;
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      logger.info('List deleted records · type=' + (type || 'all') + ' limit=' + limit + ' offset=' + offset);
      const data = await deletion.listDeleted({ type, limit, offset });
      logger.info('Found ' + (data.items ? data.items.length : 0) + ' deleted records');
      return modernOk(res, { ...data, limit, offset });
    } catch (err) {
      return next(err);
    }
  },
);

// ─── Request restore OTP ────────────────────────────────────────────
router.post(
  '/restore/request-otp',
  validate(Joi.object({ archiveId: intId.required() })),
  async (req, res, next) => {
    try {
      logger.info('Request restore OTP · archiveId=' + req.body.archiveId);
      const { delivered, expiresAt } = await actionOtp.sendActionOtp(req.user, 'restore');
      logger.info('Restore OTP sent · archiveId=' + req.body.archiveId + ' delivered=' + delivered);
      return modernOk(res, { delivered, expiresAt, message: 'An OTP has been sent to your registered mobile.' });
    } catch (err) {
      if (err.status) { logger.warn('Request restore OTP failed · ' + err.message); return modernError(res, err.status, err.message); }
      return next(err);
    }
  },
);

// ─── Confirm restore (verify OTP → restore on same id) ──────────────
router.post(
  '/restore/confirm',
  validate(Joi.object({ archiveId: intId.required(), otp: otp.required() })),
  async (req, res, next) => {
    try {
      logger.info('Confirm restore · archiveId=' + req.body.archiveId);
      const { valid, reason: otpReason } = await actionOtp.verifyActionOtp(req.user, 'restore', req.body.otp);
      if (!valid) { logger.warn('Confirm restore — OTP verification failed · archiveId=' + req.body.archiveId + ' · ' + otpReason); return modernError(res, 401, `OTP verification failed: ${otpReason}`); }
      const result = await deletion.restore(req.body.archiveId, req.user);
      logger.info((result.entityType || 'record') + ' restored · id=' + result.id);
      return modernOk(res, { ...result, message: 'Record restored on its original id.' });
    } catch (err) {
      if (err.status) { logger.warn('Confirm restore failed · archiveId=' + req.body.archiveId + ' · ' + err.message); return modernError(res, err.status, err.message, err.details); }
      return next(err);
    }
  },
);

/*
 * Email the deletion notice to the recipients configured in easyfix_properties
 * (CSV at key 'deletion.notice.recipient.emails'). Sent per-recipient with
 * allSettled so one bad address never blocks the rest. Best-effort.
 */
async function sendDeletionNotice(entType, result, reason, admin) {
  const raw = String(getProperty('deletion.notice.recipient.emails') || '').trim();
  const recipients = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!recipients.length) {
    logger.warn('deletion-notice: no recipients configured (easyfix_properties deletion.notice.recipient.emails)');
    return;
  }
  logger.info('Sending deletion notice · entityType=' + entType + ' id=' + result.id + ' recipients=' + recipients.length);
  const label = (entType === 'user' ? 'User' : 'Easyfixer');
  const subject = `EasyFix · ${label} Deleted — ${result.label}`;
  const when = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const text =
    `An ${label.toLowerCase()} record was deleted (tombstoned + archived for restore) from the EasyFix CRM.\n\n` +
    `${label}: ${result.label}\n` +
    `ID: ${result.id}\n` +
    `Reason: ${reason}\n` +
    `Deleted by: ${admin.user_name || admin.user_id} (${admin.official_email || 'n/a'})\n` +
    `When: ${when} IST\n\n` +
    `This record can be restored from Admin Actions → Deleted Records (OTP-gated). The id is reserved and will not be reused.`;

  await Promise.allSettled(
    recipients.map((to) =>
      emailService.send({ to, subject, text, category: 'admin.entity-deletion' })),
  );
}

module.exports = router;
