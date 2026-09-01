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
  canRunTeleprompter: 'teleprompter.emails',
  canSwitchOtpChannel: 'access.otpchannel.emails',
  canManageJobCharges: 'job.charges.emails',
  // Generate festival ornament art for Settings → Theme & Branding. Outside
  // RBAC because it spends model credits and publishes an image to the
  // UNAUTHENTICATED login page — a blast radius that should follow a person,
  // not a role. Seeded EMPTY = deny-all
  // (migrations/2026-08-18-settings-branding.sql). The rest of the Branding
  // screen is ordinary RBAC (isBrandingView / isBrandingEdit).
  canGenerateBrandArt: 'branding.ai.emails',
  /*
   * Secrets Manager — re-key every encrypted field, and manage the recovery
   * key. Outside RBAC for the same reason the others are, only more so: this
   * screen can decrypt every bank account number in the company and rewrite
   * the key that protects them. That blast radius should follow a PERSON, not
   * a role — a role grant propagates to whoever is given that role next, and
   * nobody re-reads what a role can do when they hand it out.
   *
   * The action keys isFieldRekeyRun / isRecoveryKeyManage still apply on top:
   * RBAC says the screen exists, this allowlist says who may reach it, and
   * BOTH must pass. Seeded with the two named operators
   * (migrations/2026-09-01-hrms-08-secrets-manager-allowlist.sql); an absent
   * or empty property is deny-all, so a fresh environment grants nobody.
   */
  canManageSecrets: 'secrets.manager.emails',
  // (Re)provision a CRM user's Microsoft 365 mailbox — it CREATES an Entra
  // directory account and spends a licence seat, so it stays outside RBAC and
  // is granted per person. Seeded EMPTY = deny-all
  // (migrations/2026-07-30-create-tbl-user-entra-provisioning.sql).
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
