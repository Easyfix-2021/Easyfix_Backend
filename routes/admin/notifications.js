const router = require('express').Router();

// In-app inbox sub-routes (list, mark-read, count, templates)
router.use(require('./notifications-inbox'));

const logger = require('../../logger');
const validate = require('../../middleware/validate');
const sms = require('../../services/sms.service');
const email = require('../../services/email.service');
const whatsapp = require('../../services/meta.whatsapp.service');
const fcm = require('../../services/fcm.service');
const { modernOk, modernError } = require('../../utils/response');
const { testBody } = require('../../validators/notification.validator');

/*
 * POST /api/admin/notifications/test
 * Admin-only probe for each outbound channel. Respects NOTIFICATIONS_DISABLE —
 * in dev the response will include { disabled: true } without hitting providers.
 *
 * Bodies:
 *   { channel: "sms",      to: "9812345678", message: "…" }
 *   { channel: "email",    to: "x@y.com",   subject: "…", body: "…" }
 *   { channel: "whatsapp", to: "9812345678", templateName: "…", recipientName: "…", variables: { "1": "…", "2": "…" } }
 *     (legacy `bodyValues` is still accepted as an alias for `variables` — see validator)
 *   { channel: "fcm",      to: "<fcm-token>", title: "…", pushBody: "…", data: {…} }
 */
router.post('/test', validate(testBody), async (req, res, next) => {
  try {
    const { channel, to } = req.body;
    logger.info('Test outbound notification · channel=' + channel);
    let result;
    switch (channel) {
      case 'sms':
        result = await sms.send({ to, message: req.body.message });
        break;
      case 'email':
        result = await email.send({
          to, subject: req.body.subject, text: req.body.body,
        });
        break;
      case 'whatsapp':
        // Accept either `variables` (Meta-native, preferred) or the legacy
        // `bodyValues` key for backward compat with any external probe scripts
        // that pre-date the Gallabox→Meta swap. The Meta service only reads
        // numeric keys, so map-style keys (e.g. {customerName:"X"}) silently
        // drop their non-numeric entries — caller's responsibility.
        result = await whatsapp.sendTemplate({
          to,
          recipientName: req.body.recipientName,
          templateName: req.body.templateName,
          variables: req.body.variables ?? req.body.bodyValues,
          headerVariables: req.body.headerVariables,
          languageCode: req.body.languageCode,
        });
        break;
      case 'fcm':
        result = await fcm.sendPush({
          token: to,
          title: req.body.title,
          body: req.body.pushBody,
          data: req.body.data,
        });
        break;
      default:
        logger.warn('Test notification rejected · unknown channel=' + channel);
        return modernError(res, 400, `unknown channel "${channel}"`);
    }
    logger.info('Test notification dispatched · channel=' + channel);
    modernOk(res, { channel, ...result });
  } catch (e) { next(e); }
});

// ─── /admin/notifications/bulk-sms — marketing SMS blast ────────────
// Mirrors legacy `sendBulkSMSToNosIntbl_bulk_sms_nosTable` +
// `sendBulkSMS.sendSmstoAll`. Sends one SMS per row of
// `tbl_bulk_sms_nos` (verified column: `mobile_no`).
//
// Inline `mobileNumbers` array overrides the table — useful when ops
// wants to send to an ad-hoc list without touching the DB.
//
// Honours NOTIFICATIONS_DISABLE — in dev/staging the loop logs but
// doesn't hit SMSCountry (per sms.service.js semantics).
const { pool } = require('../../db');
const Joi = require('joi');
router.post('/bulk-sms', validate(Joi.object({
  message: Joi.string().trim().min(1).max(500).required(),
  mobileNumbers: Joi.array().items(Joi.string().pattern(/^\d{10,12}$/)).min(1).required(),
})), async (req, res, next) => {
  // Live-DB-verified 2026-05-12: `tbl_bulk_sms_nos` does NOT exist in
  // production. Legacy `sendBulkSMS.java` referenced it for a one-off
  // Diwali promo; the table was dropped years ago. We require inline
  // `mobileNumbers` instead — admin must supply the list explicitly.
  try {
    const numbers = req.body.mobileNumbers;
    logger.info('Bulk SMS blast · recipients=' + numbers.length);
    const results = await Promise.all(numbers.map((n) => sms.send({ to: n, message: req.body.message })
      .then((r) => ({ to: n, delivered: !!r.delivered, error: r.error || null }))
      .catch((err) => ({ to: n, delivered: false, error: err.message }))));
    const deliveredCount = results.filter((r) => r.delivered).length;
    logger.info('Bulk SMS complete · delivered=' + deliveredCount + ' failed=' + (results.length - deliveredCount) + ' of ' + results.length);
    modernOk(res, {
      total: results.length,
      deliveredCount,
      failedCount: results.length - deliveredCount,
      results,
    });
  } catch (e) { next(e); }
});

// ─── /admin/notifications/whatsapp-templates ────────────────────────
// Returns the 11 Gallabox templates wired to lifecycle events. The list
// is the source of truth for which templateName to call sendTemplate
// with from `services/notification-orchestrator.service.js`.
//
// Templates listed in CLAUDE.md (verified against WhatsNotificationUtil.java
// imports): accepted_on_app, tx_accepted_client, order_reject, ota_noo,
// ota_yes, cx_revisit_yes, eta_sent_clone_clone, pm_txreschedule,
// cancel_order, cx_revisit_no, qa_cx_order_confirm.
router.get('/whatsapp-templates', (_req, res) => {
  logger.info('List WhatsApp lifecycle templates');
  modernOk(res, [
    { event: 'job.assigned',          templateName: 'accepted_on_app',        recipient: 'client' },
    { event: 'job.accepted_by_tech',  templateName: 'tx_accepted_client',     recipient: 'client' },
    { event: 'job.rejected_by_tech',  templateName: 'order_reject',           recipient: 'client' },
    { event: 'job.otp.no_attempt',    templateName: 'ota_noo',                recipient: 'customer' },
    { event: 'job.otp.attempted',     templateName: 'ota_yes',                recipient: 'customer' },
    { event: 'job.revisit.confirmed', templateName: 'cx_revisit_yes',         recipient: 'customer' },
    { event: 'job.eta_sent',          templateName: 'eta_sent_clone_clone',   recipient: 'customer' },
    { event: 'job.reschedule_by_pm',  templateName: 'pm_txreschedule',        recipient: 'customer' },
    { event: 'job.cancelled',         templateName: 'cancel_order',           recipient: 'customer' },
    { event: 'job.revisit.refused',   templateName: 'cx_revisit_no',          recipient: 'customer' },
    { event: 'job.confirmed_by_qa',   templateName: 'qa_cx_order_confirm',    recipient: 'customer' },
  ]);
});

module.exports = router;
