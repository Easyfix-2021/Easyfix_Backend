const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { requirePropertyAllowlist } = require('../../middleware/require-property-allowlist');
const { FEATURES } = require('../../services/feature-access.service');
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');
const fcmService = require('../../services/fcm.service');
const smsService = require('../../services/sms.service');
const whatsappService = require('../../services/meta.whatsapp.service');
const { resolveTokens } = require('../../services/job-offer-push.service');

/*
 * Admin "Validate Flows" utilities — operator smoke-tests for delivery paths
 * (push / SMS / WhatsApp). Property-gated by `validate.flows.emails` (same model
 * as the other Admin-Actions capabilities — NOT an RBAC menu_action). The gate
 * shows/hides the card AND enforces the endpoints.
 */
router.use(requirePropertyAllowlist(FEATURES.canValidateFlows, { label: 'Validate Flows' }));

// Look up a technician by an arbitrary WHERE (any status — this is a debug tool).
async function findTech(where, param) {
  const [[row]] = await pool.query(
    `SELECT efr_id, efr_name, efr_no, efr_email FROM tbl_easyfixer WHERE ${where} LIMIT 1`,
    [param],
  );
  return row || null;
}

// Resolve a technician from efrId | email | mobile (priority in that order).
async function resolveTech({ efrId, email, mobile }) {
  if (efrId) return findTech('efr_id = ?', efrId);
  if (email) return findTech('LOWER(TRIM(efr_email)) = ?', String(email).toLowerCase());
  if (mobile) return findTech('efr_no = ?', mobile);
  return null;
}

// Turn any provider result into a GUARANTEED non-empty, human reason for a
// failure — so the operator never sees a blank "failed" with no explanation.
function failureReason(r) {
  if (!r) return 'No response from the provider.';
  if (r.error) return String(r.error);
  if (r.disabled) return 'Notifications are disabled on this environment (NOTIFICATIONS_DISABLE=true).';
  if (r.testSkipped) return 'Test mode is active (TEST_EMAILS / TEST_MOBILE set) with no TEST_FCM_TOKEN — the real send was suppressed.';
  const provider = String(r.providerResponse || '').slice(0, 300);
  if (provider) return provider;
  if (r.httpStatus) return `Provider rejected the request (HTTP ${r.httpStatus}).`;
  return 'Delivery failed with no reason reported by the provider.';
}

const shortMobile = (m) => {
  const s = String(m || '');
  return s.length >= 6 ? `${s.slice(0, 4)}••••${s.slice(-2)}` : s;
};

// ── POST /push — test FCM push, resolving by efrId | token | email | mobile ──
const pushBody = Joi.object({
  efrId: Joi.number().integer().positive(),
  token: Joi.string().trim().min(10).max(500),
  email: Joi.string().trim().email(),
  mobile: Joi.string().trim().pattern(/^\d{10}$/),
  title: Joi.string().trim().max(100).default('EasyFix — Test Push'),
  body: Joi.string().trim().max(240).default('Test notification from Validate Flows.'),
}).or('efrId', 'token', 'email', 'mobile');

router.post('/push', validate(pushBody), async (req, res, next) => {
  try {
    const { efrId, token, email, mobile, title, body } = req.body;
    const via = efrId ? 'efrId' : email ? 'email' : mobile ? 'mobile' : 'token';
    logger.info('Validate Flows · test push · via=' + via);

    let tech = null;
    if (token && !efrId && !email && !mobile) {
      // Reverse-lookup the owning tech from either token store (best-effort).
      const [[appRow]] = await pool.query('SELECT efr_id FROM tbl_easyfixer_app WHERE device_id = ? LIMIT 1', [token]);
      let efr = appRow && appRow.efr_id;
      if (!efr) {
        const [[devRow]] = await pool.query(
          "SELECT user_id AS efr_id FROM device_info WHERE fire_base_token = ? AND is_logged_in = '1' LIMIT 1", [token]);
        efr = devRow && devRow.efr_id;
      }
      if (efr) tech = await findTech('efr_id = ?', efr);
    } else {
      tech = await resolveTech({ efrId, email, mobile });
    }

    if (!tech && !token) return modernError(res, 404, 'No technician found for the supplied ' + via + '.');

    const tokens = token ? [String(token).trim()] : await resolveTokens(tech.efr_id);
    const resolvedTech = tech
      ? { efrId: tech.efr_id, name: tech.efr_name, mobile: tech.efr_no, email: tech.efr_email }
      : null;
    if (!tokens.length) {
      return modernError(res, 404,
        'Technician found but no FCM token is registered (tbl_easyfixer_app.device_id / device_info).',
        { resolvedTech });
    }

    const results = await Promise.all(tokens.map(async (t) => {
      const r = await fcmService.sendPush({ token: t, title, body, data: { type: 'validate_flows_test' } })
        .catch((e) => ({ delivered: false, error: e.message }));
      const notDelivered = !(r && r.delivered);
      const len = String(t).length;
      let reason = notDelivered ? failureReason(r) : undefined;
      // The #1 real-world cause: the stored value isn't an FCM token at all (a
      // legacy device_id / placeholder). Call it out explicitly.
      if (notDelivered && len < 100) {
        const provider = reason && !/valid FCM/.test(reason) ? ` [provider: ${reason}]` : '';
        reason = `Stored value is only ${len} chars — not a valid FCM registration token (real tokens are ~150+ chars); this device never registered a real token.${provider}`;
      }
      return {
        tokenPreview: String(t).slice(0, 18) + '…',
        tokenLength: len,
        delivered: !notDelivered,
        httpStatus: r ? r.httpStatus : undefined,
        deadToken: !!(r && r.deadToken),
        reason,
      };
    }));

    const delivered = results.filter((r) => r.delivered).length;
    logger.push(`validate-flows · test push · ${delivered}/${tokens.length} delivered · via=${via}`);
    const payload = {
      ok: delivered > 0, channel: 'push', resolvedVia: via, resolvedTech,
      delivery: { total: tokens.length, delivered, failed: tokens.length - delivered },
      results,
    };
    return modernOk(res, payload, delivered > 0
      ? `Push delivered to ${delivered}/${tokens.length} device(s).`
      : 'Push attempted but not delivered — see results for the reason.');
  } catch (e) {
    logger.error('Validate Flows test push failed · ' + e.message);
    next(e);
  }
});

// ── POST /message — test SMS or WhatsApp to a technician's mobile ──
const messageBody = Joi.object({
  channel: Joi.string().valid('sms', 'whatsapp').required(),
  efrId: Joi.number().integer().positive(),
  email: Joi.string().trim().email(),
  mobile: Joi.string().trim().pattern(/^\d{10}$/),
  message: Joi.string().trim().max(500), // sms
  templateName: Joi.string().trim().max(120), // whatsapp (required — checked below)
  recipientName: Joi.string().trim().max(120), // whatsapp
  variables: Joi.object().pattern(/^\d+$/, Joi.string().allow('')), // whatsapp { "1": "…" }
  languageCode: Joi.string().trim().max(10), // whatsapp
}).or('efrId', 'email', 'mobile');

router.post('/message', validate(messageBody), async (req, res, next) => {
  try {
    const { channel, efrId, email, mobile } = req.body;
    const via = efrId ? 'efrId' : email ? 'email' : 'mobile';
    logger.info('Validate Flows · test ' + channel + ' · via=' + via);

    if (channel === 'whatsapp' && !req.body.templateName) {
      return modernError(res, 400, 'templateName is required for a WhatsApp test.');
    }

    const tech = await resolveTech({ efrId, email, mobile });
    // A raw mobile is sendable even without a matching tech row.
    const to = mobile || (tech && tech.efr_no);
    const resolvedTech = tech
      ? { efrId: tech.efr_id, name: tech.efr_name, mobile: tech.efr_no, email: tech.efr_email }
      : null;
    if (!to) {
      if (!tech) return modernError(res, 404, 'No technician found for the supplied ' + via + '.');
      return modernError(res, 404, 'Technician found but has no mobile number on record.', { resolvedTech });
    }

    let r;
    if (channel === 'sms') {
      r = await smsService.send({ to, message: req.body.message || 'EasyFix test SMS from Validate Flows.' })
        .catch((e) => ({ delivered: false, error: e.message }));
    } else {
      r = await whatsappService.sendTemplate({
        to,
        recipientName: req.body.recipientName,
        templateName: req.body.templateName,
        variables: req.body.variables,
        languageCode: req.body.languageCode,
      }).catch((e) => ({ delivered: false, error: e.message }));
    }

    const delivered = !!(r && r.delivered);
    logger.push(`validate-flows · test ${channel} · ${delivered ? 'sent' : 'failed'} · via=${via}`);
    const label = channel === 'sms' ? 'SMS' : 'WhatsApp';
    const payload = {
      ok: delivered, channel, resolvedVia: via, resolvedTech, to: shortMobile(to),
      result: { delivered, httpStatus: r ? r.httpStatus : undefined, reason: delivered ? undefined : failureReason(r) },
    };
    return modernOk(res, payload, delivered
      ? `${label} sent to ${payload.to}.`
      : `${label} not sent — see reason.`);
  } catch (e) {
    logger.error('Validate Flows test message failed · ' + e.message);
    next(e);
  }
});

module.exports = router;
