const { parseEmailAllowlist } = require('../services/properties.service');
const { modernError } = require('../utils/response');
const logger = require('../logger');

/*
 * Per-user access gate backed by an easyfix_properties CSV-of-emails allowlist.
 *
 *   router.use(requirePropertyAllowlist('access.callmode.emails', { label: 'Switch Call Mode' }));
 *
 * For sensitive admin capabilities that must be restricted to SPECIFIC people
 * and NOT be grantable via RBAC / Manage Role. The property is the sole gate.
 * Matches req.user.official_email (case-insensitive) against the list. Empty /
 * missing property → deny-all (fail CLOSED), same contract as scheduled-jobs.
 * Assumes upstream requireAuth has populated req.user (the standard admin chain
 * does). Stack it UNDER the existing role(['admin']) group gate as a floor.
 */
function requirePropertyAllowlist(propertyKey, opts = {}) {
  if (!propertyKey || typeof propertyKey !== 'string') {
    throw new Error('requirePropertyAllowlist(): propertyKey must be a non-empty string');
  }
  const label = opts.label || propertyKey;
  return function allowlistGuard(req, res, next) {
    const email = req.user && req.user.official_email
      ? String(req.user.official_email).trim().toLowerCase()
      : '';
    if (!email) return modernError(res, 401, 'authentication required');
    if (!parseEmailAllowlist(propertyKey).has(email)) {
      logger.warn({ userId: req.user.user_id, email }, `${label} allowlist denied`);
      return modernError(res, 403, `Not authorised — your account is not on the "${label}" access list.`);
    }
    return next();
  };
}

module.exports = { requirePropertyAllowlist };
