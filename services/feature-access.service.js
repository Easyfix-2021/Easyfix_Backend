const { parseEmailAllowlist } = require('./properties.service');
const logger = require('../logger');

/*
 * Property-gated admin CAPABILITIES — a per-user allowlist keyed in
 * easyfix_properties (CSV of official emails), deliberately OUTSIDE the RBAC
 * menu_action / role_menu_action system. Because these features carry no
 * menu_action row, they can NEVER appear in (or be granted from) the Manage
 * Role screen — the easyfix_properties value is the SOLE gate.
 *
 * Each capability maps a FE flag name → its easyfix_properties key. Add a new
 * gated capability by adding ONE entry here + seeding its property (and wiring
 * requirePropertyAllowlist on the route).
 *
 * Consumed by:
 *   - middleware/require-property-allowlist.js — BE enforcement on the routes
 *   - routes/admin/access.js GET /features      — FE show/hide flags per user
 */
const FEATURES = {
  canSwitchCallMode: 'access.callmode.emails',
  canDeleteEntities: 'access.entitydelete.emails',
  canValidateFlows: 'validate.flows.emails',
  canBuildSkillMatrix: 'skill.matrix.emails',
};

// Is `email` on the allowlist held in easyfix_properties[propertyKey]?
function emailAllowed(propertyKey, email) {
  if (!email) return false;
  return parseEmailAllowlist(propertyKey).has(String(email).trim().toLowerCase());
}

// { canSwitchCallMode: bool, canDeleteEntities: bool } for the given tbl_user row.
function featuresForUser(user) {
  const email = user && user.official_email;
  const out = {};
  for (const [flag, key] of Object.entries(FEATURES)) out[flag] = emailAllowed(key, email);
  logger.info('Resolve gated features · enabled=[' + Object.keys(out).filter((f) => out[f]).join(', ') + ']');
  return out;
}

module.exports = { FEATURES, emailAllowed, featuresForUser };
