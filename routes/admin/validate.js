const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { requirePropertyAllowlist } = require('../../middleware/require-property-allowlist');
const { FEATURES } = require('../../services/feature-access.service');
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');
const fcmService = require('../../services/fcm.service');
const { resolveTokens } = require('../../services/job-offer-push.service');

/*
 * Admin "Validate Flows" utilities — operator smoke-tests for delivery paths.
 * Property-gated by `validate.flows.emails` (same model as the other Admin-Actions
 * capabilities — NOT an RBAC menu_action; see feature-access.service.js). The gate
 * shows/hides the card AND enforces the endpoint, so a forged FE flag buys nothing.
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

const pushBody = Joi.object({
  efrId: Joi.number().integer().positive(),
  token: Joi.string().trim().min(10).max(500),
  email: Joi.string().trim().email(),
  mobile: Joi.string().trim().pattern(/^\d{10}$/),
  title: Joi.string().trim().max(100).default('EasyFix — Test Push'),
  body: Joi.string().trim().max(240).default('Test notification from Validate Flows.'),
}).or('efrId', 'token', 'email', 'mobile');

/*
 * POST /api/admin/validate/push — send a TEST FCM push, resolving the target from
 * ANY of efrId | token | email | mobile. Returns the resolved technician + a
 * per-token provider result so an operator can debug delivery without DB access.
 * A delivery FAILURE comes back as 200 { ok:false, results:[…] } WITH the reason
 * (bad token / not configured / disabled) — not a 500 — because the point is to
 * SEE why it didn't land.
 */
router.post('/push', validate(pushBody), async (req, res, next) => {
  try {
    const { efrId, token, email, mobile, title, body } = req.body;
    const via = efrId ? 'efrId' : email ? 'email' : mobile ? 'mobile' : 'token';
    logger.info('Validate Flows · test push · via=' + via);

    // 1) Resolve the technician (skippable when a raw token is supplied directly).
    let tech = null;
    if (efrId) {
      tech = await findTech('efr_id = ?', efrId);
    } else if (email) {
      tech = await findTech('LOWER(TRIM(efr_email)) = ?', String(email).toLowerCase());
    } else if (mobile) {
      tech = await findTech('efr_no = ?', mobile);
    } else if (token) {
      const [[appRow]] = await pool.query(
        'SELECT efr_id FROM tbl_easyfixer_app WHERE device_id = ? LIMIT 1', [token],
      );
      let efr = appRow && appRow.efr_id;
      if (!efr) {
        const [[devRow]] = await pool.query(
          "SELECT user_id AS efr_id FROM device_info WHERE fire_base_token = ? AND is_logged_in = '1' LIMIT 1",
          [token],
        );
        efr = devRow && devRow.efr_id;
      }
      if (efr) tech = await findTech('efr_id = ?', efr);
    }

    if (!tech && !token) {
      return modernError(res, 404, 'No technician found for the supplied ' + via + '.');
    }

    // 2) Target token(s): an explicit token wins; otherwise the tech's stores.
    const tokens = token ? [String(token).trim()] : await resolveTokens(tech.efr_id);
    const resolvedTech = tech
      ? { efrId: tech.efr_id, name: tech.efr_name, mobile: tech.efr_no, email: tech.efr_email }
      : null;
    if (!tokens.length) {
      return modernError(
        res, 404,
        'Technician found but no FCM token is registered (tbl_easyfixer_app.device_id / device_info).',
        { resolvedTech },
      );
    }

    // 3) Push to every token; capture the provider verdict per token.
    const results = await Promise.all(
      tokens.map(async (t) => {
        const r = await fcmService
          .sendPush({ token: t, title, body, data: { type: 'validate_flows_test' } })
          .catch((e) => ({ delivered: false, error: e.message }));
        const notDelivered = !(r && r.delivered);
        return {
          tokenPreview: String(t).slice(0, 18) + '…',
          tokenLength: String(t).length,
          delivered: !notDelivered,
          httpStatus: r ? r.httpStatus : undefined,
          deadToken: !!(r && r.deadToken),
          disabled: !!(r && r.disabled),
          reason: r && (r.error
            || (r.disabled ? 'notifications disabled (NOTIFICATIONS_DISABLE)' : undefined)
            || (notDelivered ? String(r.providerResponse || '').slice(0, 300) : undefined)),
        };
      }),
    );

    const delivered = results.filter((r) => r.delivered).length;
    logger.push(`validate-flows · test push · ${delivered}/${tokens.length} delivered · via=${via}`);

    const payload = {
      ok: delivered > 0,
      resolvedVia: via,
      resolvedTech,
      delivery: { total: tokens.length, delivered, failed: tokens.length - delivered },
      results,
    };
    return modernOk(
      res,
      payload,
      delivered > 0
        ? `Push delivered to ${delivered}/${tokens.length} device(s).`
        : 'Push attempted but not delivered — see results for the reason.',
    );
  } catch (e) {
    logger.error('Validate Flows test push failed · ' + e.message);
    next(e);
  }
});

module.exports = router;
