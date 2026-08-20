/*
 * Client SPOC access model — role + tri-state overrides.
 *
 * Backed by easyfix_client_spoc_access (see
 * migrations/2026-08-20-client-spoc-access.sql). A role grants a default set of
 * surfaces; per-SPOC override flags sit on top of it and can either ADD a
 * surface the role withholds or REVOKE one the role grants.
 *
 * The three states of an override column matter:
 *   NULL → inherit the role's default   (the common case; no row edited)
 *   1    → granted to this SPOC alone
 *   0    → revoked from this SPOC alone
 *
 * FAIL-CLOSED. A missing or unreadable access ROW resolves to ROLE_STORE, the
 * least-privileged role. A client-facing surface with commercial data on it
 * must never open up because a lookup failed.
 *
 * The one exception is a missing TABLE, which means something different — see
 * LEGACY_GRANTS below. It is a compatibility mode for the deploy window before
 * the migration runs, and it still withholds every genuinely new surface.
 */
const { pool } = require('../db');
const logger = require('../logger');

// Role ids are small integers, not an ENUM, so a new role is an application
// change rather than a schema alteration on a shared DB.
const ROLE_STORE = 1;
const ROLE_REGIONAL = 2;
const ROLE_SENIOR = 3;
const ROLE_FINANCE = 4;

const ROLES = {
  [ROLE_STORE]: {
    id: ROLE_STORE,
    key: 'store',
    name: 'Store SPOC',
    // Surfaces this role grants by default.
    grants: ['home', 'open', 'completed', 'actions'],
    // Whether the role sees the whole client or only its own booking subtree.
    // `false` means the existing reporting-hierarchy filter stays in force.
    allStores: false,
  },
  [ROLE_REGIONAL]: {
    id: ROLE_REGIONAL,
    key: 'regional',
    name: 'Regional Manager',
    grants: ['home', 'open', 'completed', 'actions'],
    allStores: false,
  },
  [ROLE_SENIOR]: {
    id: ROLE_SENIOR,
    key: 'senior',
    name: 'Senior Leader',
    grants: ['home', 'open', 'completed', 'actions', 'performance', 'invoicing'],
    allStores: true,
  },
  [ROLE_FINANCE]: {
    id: ROLE_FINANCE,
    key: 'finance',
    name: 'Finance',
    grants: ['home', 'open', 'completed', 'invoicing'],
    allStores: true,
  },
};

// Override column → the surface it controls. `allStores` is not a surface; it
// widens scope, so it is resolved separately below.
const OVERRIDE_GRANTS = {
  can_view_performance: 'performance',
  can_view_invoicing: 'invoicing',
  can_approve_estimates: 'actions',
};

/** Every surface the access model knows about, in tab order. */
const SURFACES = ['home', 'open', 'completed', 'performance', 'actions', 'invoicing'];

/**
 * Fold a role and its override row into a flat grant set.
 *
 * `row` may be null (no access row → least privilege). Any override column that
 * is null is left to the role; 1 adds the surface, 0 removes it even when the
 * role grants it.
 */
function foldGrants(row) {
  const role = ROLES[Number(row && row.spoc_role)] || ROLES[ROLE_STORE];
  const grants = new Set(role.grants);

  for (const [column, surface] of Object.entries(OVERRIDE_GRANTS)) {
    const value = row ? row[column] : null;
    if (value === null || value === undefined) continue; // inherit
    if (Number(value) === 1) grants.add(surface);
    else grants.delete(surface);
  }

  // Home is the landing page; every authenticated SPOC keeps it, otherwise a
  // misconfigured override row locks someone out of the portal entirely.
  grants.add('home');

  const allStoresOverride = row ? row.can_view_all_stores : null;
  const allStores = allStoresOverride === null || allStoresOverride === undefined
    ? role.allStores
    : Number(allStoresOverride) === 1;

  return {
    role: role.key,
    roleId: role.id,
    roleName: role.name,
    allStores,
    grants: SURFACES.filter((s) => grants.has(s)),
  };
}

/*
 * PRE-ACCESS-MODEL COMPATIBILITY.
 *
 * "The table is missing" and "the table has no row for this SPOC" are
 * different facts and need different answers:
 *
 *   no row   → least privilege. Somebody has an access model and this SPOC is
 *              not in it; that is a deliberate absence.
 *   no TABLE → this environment predates the access model entirely. Applying
 *              least privilege here would strip Invoices from every SPOC in
 *              the window between deploying the code and running the
 *              migration. The right answer is what the portal did BEFORE the
 *              access model existed: everyone keeps the surfaces they had,
 *              and Performance — which did not exist — stays closed.
 *
 * That is a compatibility mode, not a weakened gate: no surface opens that was
 * not already open, and the one genuinely new surface stays shut.
 */
const LEGACY_GRANTS = {
  role: 'store',
  roleId: ROLE_STORE,
  roleName: 'Store SPOC',
  allStores: false, // the reporting-hierarchy filter keeps working exactly as it does today
  grants: ['home', 'open', 'completed', 'actions', 'invoicing'],
  preAccessModel: true,
};

/**
 * Shape the access payload for a SPOC row that already carries the joined
 * access columns (see findSpocById). Cheap — no query.
 */
function accessFromSpoc(spoc) {
  if (!spoc) return foldGrants(null);
  // findSpocById stamps 0 when it had to fall back to the un-joined query.
  if (Number(spoc.access_model_available) === 0) return { ...LEGACY_GRANTS };
  // The access model exists, so a null spoc_role really is "no row for this
  // SPOC" — foldGrants treats that as least privilege.
  return foldGrants(spoc.spoc_role == null ? null : spoc);
}

/** Read one SPOC's access row directly. Returns least privilege on any failure. */
async function resolveAccess(contactId) {
  try {
    const [[row]] = await pool.query(
      `SELECT spoc_role, can_view_performance, can_view_invoicing,
              can_approve_estimates, can_view_all_stores
         FROM easyfix_client_spoc_access WHERE contact_id = ? LIMIT 1`,
      [contactId]
    );
    return foldGrants(row || null);
  } catch (e) {
    // Un-migrated table, or the DB is unhappy. Least privilege, and say so
    // loudly enough to notice in logs without spamming per request.
    logger.warn('resolveAccess failed (' + e.message + ') — falling back to least privilege');
    return foldGrants(null);
  }
}

/** True when the SPOC on `req` holds `surface`. */
function hasGrant(req, surface) {
  const access = req.access || accessFromSpoc(req.spoc);
  return access.grants.includes(surface);
}

/**
 * Route guard. Mount on any route that serves a gated surface:
 *   router.get('/performance', requireGrant('performance'), handler)
 *
 * 403 rather than 404: the SPOC is authenticated and the resource exists, they
 * simply may not have it. The message names the flag an administrator would
 * turn on, because the alternative is a support ticket that says "it says no".
 */
function requireGrant(surface) {
  const flag = Object.keys(OVERRIDE_GRANTS).find((k) => OVERRIDE_GRANTS[k] === surface);
  return function grantGuard(req, res, next) {
    if (hasGrant(req, surface)) return next();
    const { modernError } = require('../utils/response');
    logger.warn('Grant denied · surface=' + surface + ' · spoc=' + (req.spoc && req.spoc.id));
    return modernError(
      res,
      403,
      `Your access does not include ${surface}.` + (flag ? ` An administrator can grant it with ${flag}.` : '')
    );
  };
}

module.exports = {
  ROLES,
  LEGACY_GRANTS,
  SURFACES,
  OVERRIDE_GRANTS,
  ROLE_STORE,
  ROLE_REGIONAL,
  ROLE_SENIOR,
  ROLE_FINANCE,
  foldGrants,
  accessFromSpoc,
  resolveAccess,
  hasGrant,
  requireGrant,
};
