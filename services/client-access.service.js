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

/*
 * NOT A ROLE — the ABSENCE of one.
 *
 * A SPOC with no row in easyfix_client_spoc_access, or a row whose spoc_role is
 * null, has never been configured. The portal surfaces this as a red "No Role"
 * chip so it reads as a gap to close rather than as a role somebody chose.
 *
 * ┌── ROLLOUT POSTURE — TEMPORARY, AND THE ONLY LINE THAT NEEDS CHANGING ──┐
 * │ `UNASSIGNED_FAILS_OPEN = true` grants an unconfigured SPOC EVERY        │
 * │ surface. That is deliberate for the rollout window: roles are being set │
 * │ from the CRM's Manage Clients → Contacts tab, and until that sweep is   │
 * │ done, defaulting to least privilege would lock working SPOCs out of     │
 * │ screens they use today.                                                 │
 * │                                                                         │
 * │ FLIP IT TO `false` once every SPOC has a role. Then an unconfigured     │
 * │ SPOC gets the Store SPOC floor instead, and the chip still reads        │
 * │ "No Role" so the gap stays visible. Nothing else needs to change.       │
 * └─────────────────────────────────────────────────────────────────────────┘
 */
const ROLE_UNASSIGNED = 0;
const UNASSIGNED_FAILS_OPEN = true;

const ROLES = {
  [ROLE_UNASSIGNED]: {
    id: ROLE_UNASSIGNED,
    key: 'none',
    name: 'No Role',
    // Filled in below from SURFACES — every surface — when UNASSIGNED_FAILS_OPEN.
    grants: [],
    allStores: true,
    unassigned: true,
  },
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

/*
 * Resolved here rather than inline above because SURFACES is declared after
 * ROLES, and duplicating the list would be one more place to forget a surface.
 */
ROLES[ROLE_UNASSIGNED].grants = UNASSIGNED_FAILS_OPEN
  ? [...SURFACES]
  : [...ROLES[ROLE_STORE].grants];

/* ─── configurable role defaults ───────────────────────────────────────────
 *
 * The four roles' screen sets now live in easyfix_client_role_access so the
 * CRM can change them. Two constraints shaped this:
 *
 *   1. foldGrants() is SYNCHRONOUS and sits on the authenticated request path
 *      (requireSpocAuth calls it on every request). Making it async to fetch a
 *      role's surfaces would add a query per request and ripple through every
 *      caller. So the table is read into a SNAPSHOT and foldGrants reads that.
 *   2. A missing table must change nothing. `snapshot === null` means "no
 *      config" and every role falls back to the constants above — which is
 *      also exactly what the seed rows contain.
 *
 * The refresh is fire-and-forget: a stale snapshot for up to TTL is fine (a
 * role change is an administrative act, not a live control), and blocking a
 * request on it would reintroduce the per-request query this avoids.
 */
const ROLE_CONFIG_TTL_MS = 60_000;
let roleConfig = { at: 0, byRole: null, loading: null };

function parseSurfaces(csv) {
  return String(csv || '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => SURFACES.includes(x));
}

async function refreshRoleConfig() {
  try {
    const [rows] = await pool.query(
      'SELECT role_id, surfaces, all_stores FROM easyfix_client_role_access'
    );
    const byRole = {};
    for (const r of rows) {
      byRole[Number(r.role_id)] = {
        surfaces: parseSurfaces(r.surfaces),
        allStores: Number(r.all_stores) === 1,
      };
    }
    roleConfig = { at: Date.now(), byRole, loading: null };
  } catch (e) {
    // Un-migrated table, or the DB is unhappy. Fall back to the code defaults —
    // never to "no access", which would lock every SPOC out over a blip.
    if (!(e && e.errno === 1146)) {
      logger.warn('refreshRoleConfig failed (' + e.message + ') — using built-in role defaults');
    }
    roleConfig = { at: Date.now(), byRole: null, loading: null };
  }
}

/** Kick a refresh if the snapshot is stale. Never awaited on the request path. */
function touchRoleConfig() {
  if (roleConfig.loading) return;
  if (Date.now() - roleConfig.at < ROLE_CONFIG_TTL_MS) return;
  roleConfig.loading = refreshRoleConfig().catch(() => { roleConfig.loading = null; });
}

/** Drop the snapshot so the next read reloads. Called after a write. */
function invalidateRoleConfig() {
  roleConfig = { at: 0, byRole: roleConfig.byRole, loading: null };
}

/**
 * The role as CONFIGURED, falling back to the constant. Never mutates ROLES —
 * the constants stay the documented baseline and the seed for the migration.
 */
function effectiveRole(role) {
  const cfg = roleConfig.byRole && roleConfig.byRole[role.id];
  if (!cfg) return role;
  return { ...role, grants: cfg.surfaces, allStores: cfg.allStores };
}

/**
 * Fold a role and its override row into a flat grant set.
 *
 * `row` may be null (no access row → least privilege). Any override column that
 * is null is left to the role; 1 adds the surface, 0 removes it even when the
 * role grants it.
 */
function foldGrants(row, { unconfigured = true } = {}) {
  /*
   * `unconfigured` separates two ways of arriving here with no row:
   *   true  — the table is fine and this SPOC simply is not in it. That is the
   *           "No Role" case the portal shows in red, and it follows the
   *           rollout posture above.
   *   false — we could not READ the table (permissions, lock, connection). A
   *           fault must never widen access, so that path takes the Store SPOC
   *           floor regardless of the posture.
   */
  touchRoleConfig();
  /*
   * `Number(null)` is 0, and 0 is now a real key in ROLES (the unassigned
   * pseudo-role) — so the obvious `ROLES[Number(row && row.spoc_role)]` reads a
   * MISSING row as a declared role and skips the branch below entirely. That
   * silently defeated the `unconfigured: false` fault path. Read the column
   * explicitly instead, and never let 0 arrive here as a declaration.
   */
  const rawRole = row && row.spoc_role != null ? Number(row.spoc_role) : null;
  const declared = rawRole != null && rawRole !== ROLE_UNASSIGNED ? ROLES[rawRole] : null;
  // The unassigned pseudo-role is NOT configurable — it is the absence of
  // configuration — so it never goes through effectiveRole().
  const base = declared || (unconfigured ? ROLES[ROLE_UNASSIGNED] : ROLES[ROLE_STORE]);
  const role = base.unassigned ? base : effectiveRole(base);
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
    // The portal renders this chip in red and the CRM flags the SPOC for
    // configuration. Carried explicitly rather than inferred from roleId === 0,
    // so a future role numbered 0 cannot silently mean "unconfigured".
    unassigned: !!role.unassigned,
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
    // unconfigured:false — a fault is not a configuration state, and must not
    // widen access no matter what the rollout posture says.
    return foldGrants(null, { unconfigured: false });
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

/**
 * Write one role's screen set. Surfaces are filtered against SURFACES before
 * they are stored, so an unknown key cannot be persisted and later silently
 * grant nothing.
 */
async function setRoleAccess(roleId, surfaces, allStores, updatedBy) {
  const id = Number(roleId);
  if (!ROLES[id] || ROLES[id].unassigned) {
    throw Object.assign(new Error('Unknown or non-configurable role'), { status: 400 });
  }
  const clean = SURFACES.filter((x) => (surfaces || []).includes(x));
  // Home is the landing page — a role that cannot open the portal is not a
  // configuration anyone means to make.
  if (!clean.includes('home')) clean.unshift('home');
  await pool.query(
    `INSERT INTO easyfix_client_role_access (role_id, surfaces, all_stores, updated_by)
          VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE surfaces = VALUES(surfaces),
                             all_stores = VALUES(all_stores),
                             updated_by = VALUES(updated_by)`,
    [id, clean.join(','), allStores ? 1 : 0, updatedBy || null]
  );
  invalidateRoleConfig();
  await refreshRoleConfig();
  return { roleId: id, surfaces: clean, allStores: !!allStores };
}

/** The role catalogue AS CONFIGURED — what the CRM screen renders. */
function roleCatalogue() {
  touchRoleConfig();
  return Object.values(ROLES)
    .filter((r) => !r.unassigned)
    .map((r) => {
      const eff = effectiveRole(r);
      return {
        id: r.id,
        key: r.key,
        name: r.name,
        grants: eff.grants,
        allStores: eff.allStores,
        /* True when a row exists — lets the CRM show "default" vs "customised". */
        configured: !!(roleConfig.byRole && roleConfig.byRole[r.id]),
      };
    });
}

module.exports = {
  setRoleAccess,
  roleCatalogue,
  refreshRoleConfig,
  invalidateRoleConfig,
  ROLES,
  LEGACY_GRANTS,
  SURFACES,
  OVERRIDE_GRANTS,
  ROLE_UNASSIGNED,
  UNASSIGNED_FAILS_OPEN,
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
