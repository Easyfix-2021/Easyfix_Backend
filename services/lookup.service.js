const { pool } = require('../db');
const logger = require('../logger');
const { getProperty } = require('./properties.service');

/*
 * Read-only lookup queries powering dropdowns across CRM_UI / Client_UI / Mobile.
 *
 * Real table-name reconciliation with blueprint §3 (2026-04-17):
 *   - tbl_reschedule_reason  →  reschedule_reason_app (4 rows)
 *   - tbl_bank               →  bank_name (154 rows)
 *   - tbl_cancel_reason      exists (1 row — thin; may need to merge with
 *                            job_cancel_reason_by_easyfixer_app in future)
 *
 * All queries are parameterised. Status/active filtering defaults to ON;
 * pass includeInactive=true for admin tooling that needs the full list.
 */

/*
 * ── Local query helpers (parameterised) ─────────────────────────────
 * toIdArray  — normalise an optional id filter (Joi .single() may hand us
 *              a scalar OR an array) to a clean positive-integer array.
 * inFilter   — build a safe ` AND col IN (?,?)` fragment, pushing each
 *              value onto `params`; returns '' for an empty list so the
 *              clause simply vanishes (unset filter = no restriction).
 * Same contract as services/quicksight/_shared.js::buildInFilter, kept
 * local so this generic lookup layer needn't depend on report code. `col`
 * is ALWAYS a trusted identifier from this file — never user input.
 */
function toIdArray(v) {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map(Number).filter((n) => Number.isInteger(n) && n > 0);
}
function inFilter(col, values, params) {
  if (!Array.isArray(values) || values.length === 0) return '';
  for (const v of values) params.push(v);
  return ` AND ${col} IN (${values.map(() => '?').join(',')})`;
}

// ─── Cities / States ─────────────────────────────────────────────────
async function cities({ stateId, q, ids, limit = 500, includeInactive = false } = {}) {
  // Preselect resolve: fetch specific cities by id (the async CitySelect uses
  // this to show a saved job's city name without preloading the whole table).
  // NOT status-filtered — a preselected/legacy city must still resolve its name
  // even if it has since been deactivated.
  if (Array.isArray(ids) && ids.length) {
    const [rows] = await pool.query(
      `SELECT city_id, city_name, state_id FROM tbl_city
        WHERE city_id IN (${ids.map(() => '?').join(',')})
        ORDER BY city_name ASC`,
      ids.map(Number)
    );
    logger.info(`Lookup cities · ids=[${ids.join(',')}] · found=${rows.length}`);
    return rows;
  }
  const clauses = [];
  const params = [];
  if (!includeInactive) clauses.push('city_status = 1');
  if (stateId != null)  { clauses.push('state_id = ?'); params.push(stateId); }
  if (q)                { clauses.push('city_name LIKE ?'); params.push(`%${q}%`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(Number(limit));
  logger.info(`Lookup cities · stateId=${stateId ?? '—'} · q=${q ?? '—'} · limit=${limit} · includeInactive=${includeInactive}`);
  // Trimmed projection: every consumer of this lookup uses only id + name
  // (+ state_id for manage-users / zones scope math). tier / district /
  // reference_pincode / city_status are read from the admin Manage-Cities
  // endpoint, never from this lookup — so we don't ship them here.
  const [rows] = await pool.query(
    `SELECT city_id, city_name, state_id FROM tbl_city ${where}
       ORDER BY city_name ASC LIMIT ?`,
    params
  );
  logger.info(`Found ${rows.length} cities`);
  return rows;
}

async function states() {
  logger.info('Lookup states');
  const [rows] = await pool.query(
    `SELECT state_id, state_code, state_name, country_id
       FROM tbl_state ORDER BY state_name ASC`
  );
  logger.info(`Found ${rows.length} states`);
  return rows;
}

// Verticals — drives the Manage Users "Verticals" picker for RBAC
// scope. Only active rows; the master CRUD lives at /admin/verticals.
async function verticals() {
  logger.info('Lookup verticals');
  const [rows] = await pool.query(
    `SELECT vertical_id, vertical_name, vertical_desc, status
       FROM tbl_vertical
      WHERE status = 1
      ORDER BY vertical_name ASC`
  );
  logger.info(`Found ${rows.length} verticals`);
  return rows;
}

// Zones — drives the Manage Jobs "Zonal" filter. Only ACTIVE zones
// (zone_status = 1) are offered as filter options; inactive zones are hidden
// from the dropdown. tbl_zone_city_mapping does the actual zone↔city
// resolution at filter time; this endpoint is purely for the dropdown options.
async function zones() {
  logger.info('Lookup zones');
  const [rows] = await pool.query(
    `SELECT zone_id, zone_name
       FROM tbl_zone_master
      WHERE zone_status = 1
      ORDER BY zone_name ASC`
  );
  logger.info(`Found ${rows.length} zones`);
  return rows;
}

// ─── Services ───────────────────────────────────────────────────────
async function serviceCategories({ includeInactive = false } = {}) {
  // Default: active only (status 1). includeInactive widens to active+inactive
  // but ALWAYS excludes soft-deleted (status 3) so deleted categories never
  // leak into any dropdown/filter that feeds Service Type pickers.
  const where = includeInactive ? 'WHERE service_catg_status <> 3' : 'WHERE service_catg_status = 1';
  logger.info(`Lookup service categories · includeInactive=${includeInactive}`);
  const [rows] = await pool.query(
    `SELECT service_catg_id, service_catg_name, service_catg_desc, service_catg_status
       FROM tbl_service_catg ${where}
       ORDER BY service_catg_name ASC`
  );
  logger.info(`Found ${rows.length} service categories`);
  return rows;
}

async function serviceTypes({ categoryId, includeInactive = false, display } = {}) {
  const clauses = [];
  const params = [];
  if (!includeInactive) clauses.push('service_type_status = 1');
  if (categoryId != null) { clauses.push('service_catg_id = ?'); params.push(categoryId); }
  // OPT-IN display filter. tbl_service_type.display: 1=All, 0=CRM-only, 2=Tx-app.
  // Deep-skill pickers pass display=2 so only Tx-app/deep-skill types surface
  // (matches mobile-deepskill.service.js getHierarchy). Omitted ⇒ ALL display
  // types returned — required by rate cards, client tabs, and the external
  // Decathlon /v1 integration (NO-CLIENT-CHANGE rule), so NEVER hard-code it.
  if (display != null) { clauses.push('display = ?'); params.push(display); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  logger.info(`Lookup service types · categoryId=${categoryId ?? '—'} · includeInactive=${includeInactive} · display=${display ?? '—'}`);
  const [rows] = await pool.query(
    `SELECT service_type_id, service_type_name, service_type_desc,
            service_type_status, service_catg_id, display
       FROM tbl_service_type ${where}
       ORDER BY service_type_name ASC`,
    params
  );
  logger.info(`Found ${rows.length} service types`);
  return rows;
}

// ─── Clients ────────────────────────────────────────────────────────
/*
 * Scope semantics for THIS lookup (deliberately permissive — see notes):
 *
 *   - Bypass roles (Admin / Finance)            → all clients
 *   - manage_clients = "0" wildcard             → all clients
 *   - manage_clients = "1,5,10,..." specific    → ONLY those client_ids
 *   - manage_clients = NULL / empty (legacy)    → all clients
 *
 * Last bullet is the difference vs the strict parseScope() semantics in
 * lib/scope.js: there, NULL/empty means "none". For a *picker* that
 * gates booking creation, "none" is too aggressive — legacy CRM users
 * with NULL manage_clients (the historical default) still expect to see
 * client options in the Booking form. Actual writes (POST /admin/jobs)
 * still enforce the strict scope on `fk_client_id`, so widening the
 * picker doesn't widen data access; an out-of-scope create gets rejected
 * at the mutation layer.
 *
 * `scope` is the precomputed object attached by routes/admin/index.js
 * via buildRequestScopeWithHierarchy. Lookups are mounted under /shared
 * so we accept the scope as a function argument rather than reading req.
 */
async function clients({ q, limit = 100, offset = 0, includeInactive = false, scope } = {}) {
  const clauses = [];
  const params = [];
  if (!includeInactive) clauses.push('client_status = 1');
  if (q)                { clauses.push('client_name LIKE ?'); params.push(`%${q}%`); }
  // Apply scope only when the caller has SPECIFIC clients assigned.
  // 'all' (wildcard "0"), 'none' (NULL/empty), or undefined (bypass) all
  // skip the filter — picker stays populated.
  if (scope && scope.clients && scope.clients.mode === 'allow' && scope.clients.ids.length > 0) {
    clauses.push(`client_id IN (${scope.clients.placeholders})`);
    params.push(...scope.clients.ids);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(Number(limit), Number(offset));
  logger.info(`Lookup clients · q=${q ?? '—'} · limit=${limit} · offset=${offset} · includeInactive=${includeInactive} · scoped=${!!(scope && scope.clients && scope.clients.mode === 'allow' && scope.clients.ids.length > 0)}`);
  const [rows] = await pool.query(
    `SELECT client_id, client_name, client_email, client_status,
            client_city_id, client_type, reference_code,
            vertical_id
       FROM tbl_client ${where}
       ORDER BY client_name ASC LIMIT ? OFFSET ?`,
    params
  );
  logger.info(`Found ${rows.length} clients`);
  return rows;
}

async function clientServices({ clientId, includeInactive = false }) {
  if (clientId == null) throw Object.assign(new Error('clientId is required'), { status: 400 });
  logger.info(`Lookup client services · clientId=${clientId} · includeInactive=${includeInactive}`);
  const clauses = ['cs.client_id = ?'];
  const params = [clientId];
  if (!includeInactive) clauses.push('cs.service_status = 1');
  const [rows] = await pool.query(
    `SELECT cs.client_service_id, cs.client_id, cs.service_type_id, cs.service_catg_id,
            cs.rate_card_id, cs.charge_type, cs.total_amount, cs.service_status,
            st.service_type_name, sc.service_catg_name, rc.crc_ratecard_name
       FROM tbl_client_service cs
       LEFT JOIN tbl_service_type   st ON st.service_type_id = cs.service_type_id
       LEFT JOIN tbl_service_catg   sc ON sc.service_catg_id = cs.service_catg_id
       LEFT JOIN tbl_client_rate_card rc ON rc.crc_id        = cs.rate_card_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY st.service_type_name ASC
      LIMIT 1000`,
    params
  );
  logger.info(`Found ${rows.length} client services`);
  return rows;
}

// ─── Users (admin-scoped) ───────────────────────────────────────────
async function users({ q, roleGroup, limit = 100, offset = 0, includeInactive = false } = {}) {
  logger.info(`Lookup users · q=${q ?? '—'} · roleGroup=${roleGroup ?? '—'} · limit=${limit} · offset=${offset} · includeInactive=${includeInactive}`);
  const clauses = [];
  const params = [];
  if (!includeInactive) clauses.push('u.user_status = 1');
  else clauses.push('NOT (u.user_status <=> 3)'); // never surface tombstoned (deleted) users — NULL-safe
  if (q) {
    clauses.push('(u.user_name LIKE ? OR u.official_email LIKE ? OR u.mobile_no LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (roleGroup) {
    const { ROLE_ID_TO_GROUP } = require('./role.service');
    const ids = Object.entries(ROLE_ID_TO_GROUP).filter(([, g]) => g === roleGroup).map(([id]) => Number(id));
    if (ids.length === 0) return [];
    clauses.push(`u.user_role IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(Number(limit), Number(offset));
  const [rows] = await pool.query(
    `SELECT u.user_id, u.user_code, u.user_name, u.official_email,
            u.mobile_no, u.user_role, r.role_name, u.city_id, u.user_status
       FROM tbl_user u
       LEFT JOIN tbl_role r ON r.role_id = u.user_role
      ${where}
      ORDER BY u.user_name ASC LIMIT ? OFFSET ?`,
    params
  );
  logger.info(`Found ${rows.length} users`);
  return rows;
}

// ─── Zonal Managers (admin-scoped) ──────────────────────────────────
/*
 * Zonal Managers picker. A zonal manager is a tbl_user row referenced by at
 * least one tbl_city.state_user (the zonal owner of some city). Active users
 * only. TWO modes:
 *
 *  • UNSCOPED (no clientId/verticalId) → every zonal manager platform-wide.
 *    Back-compat path for the Manage Easyfixers "User Mapped To City" filter,
 *    which calls this with no args.
 *
 *  • SCOPED (clientId and/or verticalId) → only zonal owners of cities that
 *    actually back jobs for the selected client(s)/vertical(s). Drives the
 *    QuickSight Open Orders / City Performance / Client Performance "Zonal
 *    Managers" dropdowns so the picker narrows to owners present in the report
 *    once a client/vertical is chosen. Mirrors those reports' own row-scoping
 *    chain exactly: job → address → city.state_user, and client → vertical.
 */
async function zonalManagers({ clientId, verticalId } = {}) {
  const clients   = toIdArray(clientId);
  const verticals = toIdArray(verticalId);

  if (!clients.length && !verticals.length) {
    logger.info('Lookup zonal managers · global');
    const [rows] = await pool.query(`
      SELECT DISTINCT u.user_id, u.user_name
        FROM tbl_user u
        JOIN tbl_city c ON c.state_user = u.user_id
       WHERE u.user_status = 1
       ORDER BY u.user_name ASC
    `);
    logger.info(`Found ${rows.length} zonal managers`);
    return rows;
  }

  const params = [];
  let where = 'WHERE u.user_status = 1';
  where += inFilter('j.fk_client_id', clients, params);
  where += inFilter('c.vertical_id', verticals, params);
  logger.info(`Lookup zonal managers · scoped · clients=${clients.length} verticals=${verticals.length}`);
  const [rows] = await pool.query(`
    SELECT DISTINCT u.user_id, u.user_name
      FROM tbl_job j
      JOIN tbl_address a ON a.address_id = j.fk_address_id
      JOIN tbl_city cy ON cy.city_id = a.city_id
      JOIN tbl_user u ON u.user_id = cy.state_user
      LEFT JOIN tbl_client c ON c.client_id = j.fk_client_id
    ${where}
    ORDER BY u.user_name ASC
  `, params);
  logger.info(`Found ${rows.length} zonal managers (scoped)`);
  return rows;
}

/*
 * Project Managers picker — drives the QuickSight report "Project Manager"
 * filter. A project manager is a tbl_user row referenced by at least one
 * tbl_vertical_mapping row at the requested user_type (the SPOC role on a
 * client+vertical):
 *   user_type = 1 → Primary SPOC   (Client Performance PM filter)
 *   user_type = 2 → Secondary SPOC (Open Orders pmlist)
 * DISTINCT internal active users, returned as {user_id, user_name}.
 *
 * NOTE: tbl_vertical_mapping.user_type is DISTINCT from tbl_user.user_type_id
 * — do not conflate. When `userType` is omitted, both 1 and 2 are returned.
 */
async function projectManagers({ userType, clientId, verticalId } = {}) {
  const clients   = toIdArray(clientId);
  const verticals = toIdArray(verticalId);
  logger.info(`Lookup project managers · userType=${userType ?? '—'} · clients=${clients.length} verticals=${verticals.length}`);
  const clauses = ['u.user_status = 1'];
  const params = [];
  if (userType != null) {
    clauses.push('vm.user_type = ?');
    params.push(userType);
  } else {
    clauses.push('vm.user_type IN (1, 2)');
  }
  // SCOPED: narrow the SPOC picker to the selected client(s)/vertical(s) using
  // the mapping's own keys (tbl_vertical_mapping carries client_id + vertical_id).
  // Empty list ⇒ no clause ⇒ unchanged global behaviour (back-compat).
  let where = `WHERE ${clauses.join(' AND ')}`;
  where += inFilter('vm.client_id', clients, params);
  where += inFilter('vm.vertical_id', verticals, params);
  const [rows] = await pool.query(
    `SELECT DISTINCT u.user_id, u.user_name
       FROM tbl_vertical_mapping vm
       JOIN tbl_user u ON u.user_id = vm.user_id
      ${where}
      ORDER BY u.user_name ASC`,
    params
  );
  logger.info(`Found ${rows.length} project managers`);
  return rows;
}

// ─── Roles (admin-scoped) ───────────────────────────────────────────
/*
 * Picker projection for tbl_role. The Manage Users form needs this to fill
 * the "Role" dropdown; we also surface the classification group so the
 * frontend can hide non-admin roles when assigning to internal staff.
 *
 * Active-only by default — the Manage Roles screen passes
 * `includeInactive=true` when the operator toggles "Include inactive".
 */
async function roles({ q, includeInactive = false, group } = {}) {
  logger.info(`Lookup roles · q=${q ?? '—'} · group=${group ?? '—'} · includeInactive=${includeInactive}`);
  const { ROLE_ID_TO_GROUP } = require('./role.service');
  const clauses = [];
  const params = [];
  if (!includeInactive) clauses.push('r.role_status = 1');
  if (q) {
    clauses.push('(r.role_name LIKE ? OR r.role_desc LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  if (group) {
    // Filter by group classification (admin/client/mobile/default). Reads
    // the same in-code map the middleware uses — single source of truth.
    const ids = Object.entries(ROLE_ID_TO_GROUP)
      .filter(([, g]) => g === group)
      .map(([id]) => Number(id));
    if (ids.length === 0) return [];
    clauses.push(`r.role_id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [rows] = await pool.query(
    `SELECT r.role_id, r.role_name, r.role_desc, r.role_status
       FROM tbl_role r
      ${where}
      ORDER BY r.role_name ASC`,
    params
  );
  logger.info(`Found ${rows.length} roles`);
  return rows.map((r) => ({
    ...r,
    role_status: r.role_status === 1 || r.role_status === true ? 1 : 0,
    group: ROLE_ID_TO_GROUP[r.role_id] ?? 'unknown',
  }));
}

// ─── Menu actions (menu_action) — for Manage Roles editor ────────────
/*
 * Returns the full menu_action catalogue grouped by menu_id. Drives the
 * per-menu action-permission checkboxes on the Manage Roles edit form.
 *
 *   menu_action.action_name  is the free-text permission key checked at
 *                            button-render time (e.g. "isUserEdit").
 *   menu_action.name         is the human label ("Edit User") shown in the
 *                            checkbox UI.
 *
 * Active-only by default (`status = 1` AND `delete_status = 0` matches
 * legacy MenuActionDaoImpl). Whole list is small (~100–300 rows in legacy
 * prod), so we return everything and let the frontend filter by menu.
 */
async function menuActions() {
  logger.info('Lookup menu actions');
  const [rows] = await pool.query(
    `SELECT ma.id, ma.menu_id, m.menu_name, ma.name, ma.action_name
       FROM menu_action ma
       LEFT JOIN tbl_menu m ON m.menu_id = ma.menu_id
      WHERE (ma.status IS NULL OR ma.status = 1)
        AND (ma.delete_status IS NULL OR ma.delete_status = 0)
      ORDER BY m.sequence ASC, m.menu_name ASC, ma.name ASC`
  );
  logger.info(`Found ${rows.length} menu actions`);
  return rows;
}

// ─── Sidebar menus (tbl_menu) ───────────────────────────────────────
/*
 * Returns the active menu tree as a flat list sorted by sequence. Frontend
 * rebuilds the nest from parent_menu FKs. `url='javascript:;'` rows are
 * parent-only nodes (children provide the actual navigation). We don't encode
 * per-role visibility at the DB level — consumer applies a hardcoded allowlist
 * after fetching (see Sidebar.tsx) so role changes don't need a SQL migration.
 *
 * Per-environment visibility filter (added 2026-06-02): some new-CRM flows are
 * not yet 100% complete while the legacy CRM still works fine on the same data.
 * We filter THIS endpoint only — the legacy Java CRM reads tbl_menu directly
 * via its own DAO and is unaffected. Two env vars drive the filter:
 *
 *   NEW_CRM_VISIBLE_MENU_IDS=1,2,3,…   allowlist; unset/empty = show all rows
 *   NEW_CRM_MENU_OVERRIDE_EMAILS=a@x   comma-list of emails that bypass the
 *                                       allowlist and see every menu (super-
 *                                       viewers — useful for QA / smoke).
 *
 * Allowlist is checked first; if the requesting user's email is in the override
 * list, they see every menu_status=1 row. Remove an id from the allowlist in
 * the same deploy that ships the underlying flow as production-ready.
 */
function resolveVisibleMenuIds() {
  const raw = String(
    // easyfix_properties is the primary source of truth (2026-06-03 per
    // ops) — a fresh DB value always wins over the env var. The env var
    // is the FALLBACK when the property is absent (pre-migration deploys,
    // DB outage, and the hermetic test suite, which runs without MySQL).
    getProperty('new.crm.visible.menu.ids') ??
      process.env.NEW_CRM_VISIBLE_MENU_IDS ?? ''
  ).trim();
  if (!raw) return null;                       // null = filter inactive, show all
  const ids = raw.split(',')
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length ? new Set(ids) : null;
}

function resolveMenuOverrideEmails() {
  const raw = String(
    // easyfix_properties primary, env fallback (same contract as
    // resolveVisibleMenuIds above).
    getProperty('new.crm.menu.override.emails') ??
      process.env.NEW_CRM_MENU_OVERRIDE_EMAILS ?? ''
  ).trim();
  if (!raw) return new Set();
  return new Set(
    raw.split(',')
       .map((s) => String(s).trim().toLowerCase())
       .filter(Boolean)
  );
}

function applyMenuFilter(rows, { userEmail } = {}) {
  const visible = resolveVisibleMenuIds();
  if (!visible) return rows;                   // no allowlist → all rows pass
  const overrides = resolveMenuOverrideEmails();
  if (userEmail && overrides.has(String(userEmail).toLowerCase())) {
    return rows;                               // override email → bypass filter
  }
  return rows.filter((r) => visible.has(Number(r.menu_id)));
}

// Boot-time visibility log — fires once when this module is first required
// (during route registration at server start). Surfaces the resolved filter
// so "why is menu X missing in prod?" is answerable from logs without DB diving.
(function logMenuFilterAtBoot() {
  const visible = resolveVisibleMenuIds();
  const overrides = resolveMenuOverrideEmails();
  if (!visible) {
    logger.info('menu filter disabled — /api/shared/lookup/menus returns every menu_status=1 row');
    return;
  }
  const sortedIds = [...visible].sort((a, b) => a - b);
  logger.info(
    { visibleMenuIds: sortedIds, overrideEmails: overrides.size },
    `menu filter active — ${sortedIds.length} id(s) allowed${overrides.size ? `, ${overrides.size} override email(s) bypass` : ''}`,
  );
})();

async function menus({ userEmail } = {}) {
  logger.info('Lookup menus');
  // `menu_status` is also returned (even though we filter on it) so the
  // frontend can re-assert the active-only contract defensively — protects
  // the sidebar if a future caller forgets the WHERE clause.
  const [rows] = await pool.query(
    `SELECT menu_id, menu_name, parent_menu, menu_depth, has_child, url, icons, sequence, menu_status
       FROM tbl_menu
      WHERE menu_status = 1
      ORDER BY COALESCE(sequence, 999) ASC, menu_id ASC`
  );
  logger.info(`Found ${rows.length} active menus before filter`);
  return applyMenuFilter(rows, { userEmail });
}

/*
 * Companion lookup that returns the legacy URL slugs (raw `tbl_menu.url`)
 * of menus that ARE hidden by the env allowlist. Used by the Next.js
 * middleware in Easyfix_CRM_UI to server-side redirect direct navigation
 * to those flows to /coming-soon — single source of truth so the FE
 * guard stays in sync with the BE filter without env duplication.
 *
 * `enabled=false` means the allowlist is OFF; the FE treats this as
 * "no paths to guard". Email-override doesn't apply here — the API
 * returns the FILTER itself, not the current user's view of it.
 */
async function menuVisibility() {
  logger.info('Lookup menu visibility filter');
  const visible = resolveVisibleMenuIds();
  if (!visible) return { enabled: false, hiddenMenuIds: [], hiddenLegacyUrls: [] };
  const [rows] = await pool.query(
    'SELECT menu_id, url FROM tbl_menu WHERE menu_status = 1'
  );
  const hiddenRows = rows.filter((r) => !visible.has(Number(r.menu_id)));
  // hiddenMenuIds — every hidden row (including parent-only `javascript:;`
  // placeholders). Consumed by the Manage Role tree in Easyfix_CRM_UI to
  // render a "Hidden in new CRM" pill on each row that's currently filtered
  // out of the sidebar — admins still need to manage those menus' role
  // access for the legacy Java CRM.
  // hiddenLegacyUrls — same set but limited to navigable URLs (no parents,
  // no nulls). Consumed by Next.js middleware for direct-URL redirects to
  // /coming-soon.
  const hiddenMenuIds = hiddenRows.map((r) => Number(r.menu_id));
  const hiddenLegacyUrls = hiddenRows
    .map((r) => r.url)
    .filter((u) => u && u !== 'javascript:;');
  logger.info(`Menu visibility · ${hiddenMenuIds.length} hidden menu id(s) · ${hiddenLegacyUrls.length} hidden legacy url(s)`);
  return { enabled: true, hiddenMenuIds, hiddenLegacyUrls };
}

// ─── Easyfixers (technician picker) ─────────────────────────────────
/*
 * Compact projection — just what a picker dropdown needs. Full list is ~4,254
 * active rows; at ~60 bytes per row that's <300 KB, well within a cacheable
 * single lookup response. Search by name / mobile / email for typeahead.
 */
async function easyfixers({ q, limit = 5000, includeInactive = false } = {}) {
  logger.info(`Lookup easyfixers · q=${q ?? '—'} · limit=${limit} · includeInactive=${includeInactive}`);
  const clauses = [];
  const params = [];
  if (!includeInactive) clauses.push('e.efr_status = 1');
  else clauses.push('NOT (e.efr_status <=> 3)'); // never surface tombstoned (deleted) easyfixers — NULL-safe (keeps NULL-status leads)
  if (q) {
    clauses.push('(e.efr_name LIKE ? OR e.efr_no LIKE ? OR e.efr_email LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(Number(limit));
  const [rows] = await pool.query(
    `SELECT e.efr_id, e.efr_name, e.efr_no, e.efr_email,
            e.efr_cityId, c.city_name,
            e.is_technician_verified, e.efr_status
       FROM tbl_easyfixer e
       LEFT JOIN tbl_city c ON c.city_id = e.efr_cityId
      ${where}
      ORDER BY e.efr_name ASC
      LIMIT ?`,
    params
  );
  logger.info(`Found ${rows.length} easyfixers`);
  return rows;
}

// ─── Small lookups ──────────────────────────────────────────────────
async function cancelReasons() {
  logger.info('Lookup cancel reasons');
  const [rows] = await pool.query(
    `SELECT cancel_id AS id, cancel_reason AS reason, status
       FROM tbl_cancel_reason WHERE status = 1
       ORDER BY cancel_reason ASC`
  );
  logger.info(`Found ${rows.length} cancel reasons`);
  return rows;
}

async function rescheduleReasons() {
  logger.info('Lookup reschedule reasons');
  // Actual table is reschedule_reason_app (blueprint's tbl_reschedule_reason doesn't exist).
  const [rows] = await pool.query(
    `SELECT id, reschedule_reason AS reason FROM reschedule_reason_app ORDER BY id ASC`
  );
  logger.info(`Found ${rows.length} reschedule reasons`);
  return rows;
}

// Reject reasons live in the unified action_taken_reason table (the legacy CRM
// EnumReasonDaoImpl source-of-truth), discriminated by action_type + user_type.
// App reasons are user_type 4; reject = action_type 31 (confirmed against the
// live table). status=1 + is_new=1 mirror the legacy active filter.
async function rejectReasons() {
  logger.info('Lookup reject reasons');
  const [rows] = await pool.query(
    `SELECT id, action_desc AS reason
       FROM action_taken_reason
      WHERE action_type = 31 AND user_type = 4 AND status = 1 AND is_new = 1
      ORDER BY action_desc ASC`
  );
  logger.info(`Found ${rows.length} reject reasons`);
  return rows;
}

// Checkout-flow reasons each live in their own thin (id, reason) table — no
// status column, so every row is active. FK targets: tbl_job.problem_reason_id,
// .collect_cash_reason_id, .revisit_reason_id respectively.
async function problemReasons() {
  logger.info('Lookup problem reasons');
  const [rows] = await pool.query(
    `SELECT id, reason FROM problem_with_job_reason ORDER BY id ASC`
  );
  logger.info(`Found ${rows.length} problem reasons`);
  return rows;
}

async function collectCashReasons() {
  logger.info('Lookup collect cash reasons');
  const [rows] = await pool.query(
    `SELECT id, reason FROM collect_cash_reason_by_app ORDER BY id ASC`
  );
  logger.info(`Found ${rows.length} collect cash reasons`);
  return rows;
}

async function revisitReasons() {
  logger.info('Lookup revisit reasons');
  const [rows] = await pool.query(
    `SELECT id, reason FROM revisit_reason_by_app ORDER BY id ASC`
  );
  logger.info(`Found ${rows.length} revisit reasons`);
  return rows;
}

async function banks({ q } = {}) {
  logger.info(`Lookup banks · q=${q ?? '—'}`);
  // Actual table is bank_name (blueprint's tbl_bank doesn't exist).
  const clauses = [];
  const params = [];
  if (q) { clauses.push('bank_name LIKE ?'); params.push(`%${q}%`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [rows] = await pool.query(
    `SELECT id, bank_name, is_easyfix_bank FROM bank_name ${where} ORDER BY bank_name ASC`,
    params
  );
  logger.info(`Found ${rows.length} banks`);
  return rows;
}

async function documentTypes({ includeInactive = false } = {}) {
  logger.info(`Lookup document types · includeInactive=${includeInactive}`);
  const where = includeInactive ? '' : 'WHERE document_type_status = 1';
  const [rows] = await pool.query(
    `SELECT document_type_id, document_name, document_mandatory,
            document_type_status, document_catg_id
       FROM tbl_document_type ${where}
       ORDER BY document_name ASC`
  );
  logger.info(`Found ${rows.length} document types`);
  return rows;
}

module.exports = {
  cities,
  states,
  serviceCategories,
  serviceTypes,
  clients,
  clientServices,
  users,
  zonalManagers,
  projectManagers,
  roles,
  menuActions,
  easyfixers,
  menus,
  menuVisibility,
  cancelReasons,
  rescheduleReasons,
  rejectReasons,
  problemReasons,
  collectCashReasons,
  revisitReasons,
  banks,
  documentTypes,
  verticals,
  zones,
  // Test-only helpers (do NOT call from production code paths).
  _test: { applyMenuFilter, resolveVisibleMenuIds, resolveMenuOverrideEmails },
};
