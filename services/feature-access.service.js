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
  // canManageJobCharges RETIRED 2026-09-09 — moved to the RBAC action
  // `isJobChargesManage` so it can be granted from Manage Role. It lived here
  // as an email allowlist that no migration ever seeded, which denied every
  // user and gave no screen a way to fix it. The flag of the same name is
  // still on /auth/me; only its resolution changed.
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
  /*
   * Triage the Reported Issues queue — read any issue, comment on any
   * issue, close any issue. Two locks, like canManageSecrets: the RBAC key
   * isIssueManage says the screen exists, this allowlist says who may reach
   * it, and BOTH must pass (services/issue.service.js resolveActor).
   *
   * Outside RBAC alone because the queue carries SCREENSHOTS taken from
   * other people's CRM sessions — job pages, client pages, customer
   * numbers. That reach should follow a person, not a role that propagates
   * to whoever is given it next. Seeded with the triage team in
   * migrations/2026-09-10-crm-issue-reporter-v2.sql; an absent or empty
   * property is deny-all, so a fresh environment grants nobody.
   *
   * Reporting an issue, and reading or commenting on your OWN, needs
   * neither lock — every CRM user may raise a bug.
   */
  canManageIssues: 'access.issues.emails',
  /*
   * Transfer a QuickSight Custom Report to a new owner. Outside RBAC on
   * purpose, and it is the SOLE gate for that one route — the Custom Reports
   * administrator key (isQuickSightDynamicReportAdmin) does NOT grant it.
   *
   * Two reasons it is a person, not a role. (1) It is the escape hatch: a
   * report whose owner later loses QuickSight access is only rescuable by
   * whoever can re-point its owner, so that capability must not itself sit
   * behind a role grant that the same reorganisation can revoke. (2) It hands
   * a report — including one restricted to a role the new owner is not in —
   * to somebody else; that reach should follow a named operator rather than
   * propagate to whoever is given the Admin role next.
   *
   * Unlike canManageSecrets/canManageIssues this is ONE lock, not two: the
   * route's QuickSight gates already establish that the caller may be here at
   * all, and requiring the Admin key on top would re-introduce the role
   * dependency this exists to avoid. Seeded with the named operators in
   * migrations/2026-09-23-quicksight-dynamic-report-owner-allowlist.sql; an
   * absent or empty property is deny-all, so a fresh environment grants
   * nobody and Transfer Owner simply does not appear.
   */
  canTransferReportOwner: 'access.dynamicreport.owner.emails',
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
