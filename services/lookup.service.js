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

// ─── Cities / States ─────────────────────────────────────────────────
async function cities({ stateId, q, limit = 500, includeInactive = false } = {}) {
  const clauses = [];
  const params = [];
  if (!includeInactive) clauses.push('city_status = 1');
  if (stateId != null)  { clauses.push('state_id = ?'); params.push(stateId); }
  if (q)                { clauses.push('city_name LIKE ?'); params.push(`%${q}%`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(Number(limit));
  const [rows] = await pool.query(
    `SELECT city_id, city_name, state_id, city_status, tier, district, reference_pincode
       FROM tbl_city ${where}
       ORDER BY city_name ASC LIMIT ?`,
    params
  );
  return rows;
}

async function states() {
  const [rows] = await pool.query(
    `SELECT state_id, state_code, state_name, country_id
       FROM tbl_state ORDER BY state_name ASC`
  );
  return rows;
}

// Verticals — drives the Manage Users "Verticals" picker for RBAC
// scope. Only active rows; the master CRUD lives at /admin/verticals.
async function verticals() {
  const [rows] = await pool.query(
    `SELECT vertical_id, vertical_name, vertical_desc, status
       FROM tbl_vertical
      WHERE status = 1
      ORDER BY vertical_name ASC`
  );
  return rows;
}

// Zones — drives the Manage Jobs "Zonal" filter. tbl_zone_master has
// no canonical active flag, but legacy convention treats every row as
// usable. tbl_zone_city_mapping does the actual zone↔city resolution
// at filter time; this endpoint is purely for the dropdown options.
async function zones() {
  const [rows] = await pool.query(
    `SELECT zone_id, zone_name
       FROM tbl_zone_master
      ORDER BY zone_name ASC`
  );
  return rows;
}

// ─── Services ───────────────────────────────────────────────────────
async function serviceCategories({ includeInactive = false } = {}) {
  const where = includeInactive ? '' : 'WHERE service_catg_status = 1';
  const [rows] = await pool.query(
    `SELECT service_catg_id, service_catg_name, service_catg_desc, service_catg_status
       FROM tbl_service_catg ${where}
       ORDER BY service_catg_name ASC`
  );
  return rows;
}

async function serviceTypes({ categoryId, includeInactive = false } = {}) {
  const clauses = [];
  const params = [];
  if (!includeInactive) clauses.push('service_type_status = 1');
  if (categoryId != null) { clauses.push('service_catg_id = ?'); params.push(categoryId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [rows] = await pool.query(
    `SELECT service_type_id, service_type_name, service_type_desc,
            service_type_status, service_catg_id
       FROM tbl_service_type ${where}
       ORDER BY service_type_name ASC`,
    params
  );
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
  const [rows] = await pool.query(
    `SELECT client_id, client_name, client_email, client_status,
            client_city_id, client_type, reference_code,
            vertical_id
       FROM tbl_client ${where}
       ORDER BY client_name ASC LIMIT ? OFFSET ?`,
    params
  );
  return rows;
}

async function clientServices({ clientId, includeInactive = false }) {
  if (clientId == null) throw Object.assign(new Error('clientId is required'), { status: 400 });
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
  return rows;
}

// ─── Users (admin-scoped) ───────────────────────────────────────────
async function users({ q, roleGroup, limit = 100, offset = 0, includeInactive = false } = {}) {
  const clauses = [];
  const params = [];
  if (!includeInactive) clauses.push('u.user_status = 1');
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
  const [rows] = await pool.query(
    `SELECT ma.id, ma.menu_id, m.menu_name, ma.name, ma.action_name
       FROM menu_action ma
       LEFT JOIN tbl_menu m ON m.menu_id = ma.menu_id
      WHERE (ma.status IS NULL OR ma.status = 1)
        AND (ma.delete_status IS NULL OR ma.delete_status = 0)
      ORDER BY m.sequence ASC, m.menu_name ASC, ma.name ASC`
  );
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
    // 2026-06-03 per ops: easyfix_properties is now the SOLE source of
    // truth. Env fallback dropped so a stale env var on a pod can't
    // override a fresh DB value.
    getProperty('new.crm.visible.menu.ids') ?? ''
  ).trim();
  if (!raw) return null;                       // null = filter inactive, show all
  const ids = raw.split(',')
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length ? new Set(ids) : null;
}

function resolveMenuOverrideEmails() {
  const raw = String(
    // easyfix_properties is the SOLE source of truth (2026-06-03).
    getProperty('new.crm.menu.override.emails') ?? ''
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
  // `menu_status` is also returned (even though we filter on it) so the
  // frontend can re-assert the active-only contract defensively — protects
  // the sidebar if a future caller forgets the WHERE clause.
  const [rows] = await pool.query(
    `SELECT menu_id, menu_name, parent_menu, menu_depth, has_child, url, icons, sequence, menu_status
       FROM tbl_menu
      WHERE menu_status = 1
      ORDER BY COALESCE(sequence, 999) ASC, menu_id ASC`
  );
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
  return { enabled: true, hiddenMenuIds, hiddenLegacyUrls };
}

// ─── Easyfixers (technician picker) ─────────────────────────────────
/*
 * Compact projection — just what a picker dropdown needs. Full list is ~4,254
 * active rows; at ~60 bytes per row that's <300 KB, well within a cacheable
 * single lookup response. Search by name / mobile / email for typeahead.
 */
async function easyfixers({ q, limit = 5000, includeInactive = false } = {}) {
  const clauses = [];
  const params = [];
  if (!includeInactive) clauses.push('e.efr_status = 1');
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
  return rows;
}

// ─── Small lookups ──────────────────────────────────────────────────
async function cancelReasons() {
  const [rows] = await pool.query(
    `SELECT cancel_id AS id, cancel_reason AS reason, status
       FROM tbl_cancel_reason WHERE status = 1
       ORDER BY cancel_reason ASC`
  );
  return rows;
}

async function rescheduleReasons() {
  // Actual table is reschedule_reason_app (blueprint's tbl_reschedule_reason doesn't exist).
  const [rows] = await pool.query(
    `SELECT id, reschedule_reason AS reason FROM reschedule_reason_app ORDER BY id ASC`
  );
  return rows;
}

async function banks({ q } = {}) {
  // Actual table is bank_name (blueprint's tbl_bank doesn't exist).
  const clauses = [];
  const params = [];
  if (q) { clauses.push('bank_name LIKE ?'); params.push(`%${q}%`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [rows] = await pool.query(
    `SELECT id, bank_name, is_easyfix_bank FROM bank_name ${where} ORDER BY bank_name ASC`,
    params
  );
  return rows;
}

async function documentTypes({ includeInactive = false } = {}) {
  const where = includeInactive ? '' : 'WHERE document_type_status = 1';
  const [rows] = await pool.query(
    `SELECT document_type_id, document_name, document_mandatory,
            document_type_status, document_catg_id
       FROM tbl_document_type ${where}
       ORDER BY document_name ASC`
  );
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
  roles,
  menuActions,
  easyfixers,
  menus,
  menuVisibility,
  cancelReasons,
  rescheduleReasons,
  banks,
  documentTypes,
  verticals,
  zones,
  // Test-only helpers (do NOT call from production code paths).
  _test: { applyMenuFilter, resolveVisibleMenuIds, resolveMenuOverrideEmails },
};
