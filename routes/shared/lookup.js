const router = require('express').Router();

const requireAuth = require('../../middleware/auth');
const { role } = require('../../middleware/role');
const validate = require('../../middleware/validate');
const lookup = require('../../services/lookup.service');
const { modernOk } = require('../../utils/response');
const { cached } = require('../../utils/ttl-cache');
const { pool } = require('../../db');
const { buildRequestScopeWithHierarchy } = require('../../lib/scope');
const {
  citiesQuery, serviceTypesQuery, clientsQuery, clientServicesQuery,
  usersQuery, banksQuery, simpleIncludeInactive, projectManagersQuery,
} = require('../../validators/lookup.validator');

/*
 * Short-TTL in-memory cache for NON-personalized master lists (see
 * utils/ttl-cache.js). Wrapped here are ONLY truly identical-for-everyone
 * reads — static masters (5 min) and the no-arg variants of the two
 * free-text lookups (banks, tools). Cache keys encode EVERY query arg that
 * varies the result so different queries can't collide.
 *
 * NOTHING role-scoped / req.scope-filtered / per-user is cached: cities
 * (unbounded free-text q), clients (req.scope), client-services, users,
 * zonal-managers, project-managers, roles, menu-actions, easyfixers, menus
 * (varies by userEmail), and menu-visibility all bypass the cache and run
 * per-request. Free-text search variants of banks/tools (q present) also
 * bypass to bound key cardinality.
 */
const TTL_STATIC = 300000; // 5 min — static master lists

/*
 * All routes under /api/shared/lookup require a valid JWT.
 * Most are open to any authenticated user (dropdowns for forms).
 * Admin-sensitive lookups (clients, client-services, users) additionally
 * require role(['admin']) — these would leak data if shown to a client SPOC
 * or a technician.
 */

router.use(requireAuth);

// ─── Open to any authenticated principal ────────────────────────────
router.get('/cities',             validate(citiesQuery, 'query'),          async (req, res, next) => {
  try { modernOk(res, await lookup.cities(req.query)); } catch (e) { next(e); }
});

router.get('/states',             async (_req, res, next) => {
  try { modernOk(res, await cached('lookup:states', TTL_STATIC, () => lookup.states())); } catch (e) { next(e); }
});

// Verticals — drives the Manage Users Verticals picker for RBAC scope.
router.get('/verticals',          async (_req, res, next) => {
  try { modernOk(res, await cached('lookup:verticals', TTL_STATIC, () => lookup.verticals())); } catch (e) { next(e); }
});

// Zones — drives the Manage Jobs "Zonal" filter dropdown. Lives here
// (not under /admin) because the Manage Jobs page calls /shared/lookup/*
// for all its filter options and consistency is cheap.
router.get('/zones',              async (_req, res, next) => {
  try { modernOk(res, await cached('lookup:zones', TTL_STATIC, () => lookup.zones())); } catch (e) { next(e); }
});

router.get('/service-categories', validate(simpleIncludeInactive, 'query'), async (req, res, next) => {
  try {
    const inc = req.query.includeInactive ? 1 : 0;
    modernOk(res, await cached(`lookup:service-categories:inc=${inc}`, TTL_STATIC, () => lookup.serviceCategories(req.query)));
  } catch (e) { next(e); }
});

router.get('/service-types',      validate(serviceTypesQuery, 'query'),    async (req, res, next) => {
  try {
    const inc = req.query.includeInactive ? 1 : 0;
    const cat = req.query.categoryId != null ? req.query.categoryId : '';
    modernOk(res, await cached(`lookup:service-types:cat=${cat}:inc=${inc}`, TTL_STATIC, () => lookup.serviceTypes(req.query)));
  } catch (e) { next(e); }
});

router.get('/cancel-reasons',     async (_req, res, next) => {
  try { modernOk(res, await cached('lookup:cancel-reasons', TTL_STATIC, () => lookup.cancelReasons())); } catch (e) { next(e); }
});

router.get('/reschedule-reasons', async (_req, res, next) => {
  try { modernOk(res, await cached('lookup:reschedule-reasons', TTL_STATIC, () => lookup.rescheduleReasons())); } catch (e) { next(e); }
});

router.get('/reject-reasons',     async (_req, res, next) => {
  try { modernOk(res, await cached('lookup:reject-reasons', TTL_STATIC, () => lookup.rejectReasons())); } catch (e) { next(e); }
});

router.get('/problem-reasons',    async (_req, res, next) => {
  try { modernOk(res, await cached('lookup:problem-reasons', TTL_STATIC, () => lookup.problemReasons())); } catch (e) { next(e); }
});

router.get('/collect-cash-reasons', async (_req, res, next) => {
  try { modernOk(res, await cached('lookup:collect-cash-reasons', TTL_STATIC, () => lookup.collectCashReasons())); } catch (e) { next(e); }
});

router.get('/revisit-reasons',    async (_req, res, next) => {
  try { modernOk(res, await cached('lookup:revisit-reasons', TTL_STATIC, () => lookup.revisitReasons())); } catch (e) { next(e); }
});

router.get('/banks',              validate(banksQuery, 'query'),           async (req, res, next) => {
  try {
    // Cache ONLY the full list (no q). Free-text search has unbounded key
    // cardinality, so it bypasses the cache to keep memory bounded.
    if (req.query.q) { modernOk(res, await lookup.banks(req.query)); return; }
    modernOk(res, await cached('lookup:banks', TTL_STATIC, () => lookup.banks(req.query)));
  } catch (e) { next(e); }
});

// Active tools master (tbl_tools) — the technician app's "Your Tools" picker
// selects from this list. Reuses the Manage-Tools service (admin owns writes);
// this is a read-only lookup, mounted under /shared so the mobile JWT is accepted.
router.get('/tools', async (req, res, next) => {
  try {
    const toolService = require('../../services/tool.service');
    const fetchTools = async () => {
      const { items } = await toolService.listTools({ q: req.query.q, includeInactive: false, limit: 1000 });
      return items.map((t) => ({ id: t.tool_id, name: t.tool_name, img: t.tool_img || null }));
    };
    // Cache ONLY the full active list (no q). Free-text search bypasses the
    // cache (unbounded key cardinality).
    if (req.query.q) { modernOk(res, await fetchTools()); return; }
    modernOk(res, await cached('lookup:tools', TTL_STATIC, fetchTools));
  } catch (e) { next(e); }
});

router.get('/document-types',     validate(simpleIncludeInactive, 'query'), async (req, res, next) => {
  try {
    const inc = req.query.includeInactive ? 1 : 0;
    modernOk(res, await cached(`lookup:document-types:inc=${inc}`, TTL_STATIC, () => lookup.documentTypes(req.query)));
  } catch (e) { next(e); }
});

// ─── Admin-only ─────────────────────────────────────────────────────
// The client + user lists are admin-facing dropdowns. A ClientDashboard User
// MUST NOT be able to enumerate all clients or internal staff — that's a
// data-leak bug waiting to happen. /api/client/* will expose a scoped view.
router.get('/clients',          role(['admin']), validate(clientsQuery, 'query'),        async (req, res, next) => {
  try {
    // Compute scope here because /shared/* isn't mounted under the admin
    // middleware that pre-attaches req.scope. Hierarchy-aware so a
    // reporting manager's picker shows the union of own + downstream
    // reports' manage_clients. Lookup-permissive default — see
    // services/lookup.service.js::clients for the NULL/empty rule.
    const scope = await buildRequestScopeWithHierarchy(req, pool);
    modernOk(res, await lookup.clients({ ...req.query, scope }));
  } catch (e) { next(e); }
});

router.get('/client-services',  role(['admin']), validate(clientServicesQuery, 'query'), async (req, res, next) => {
  try { modernOk(res, await lookup.clientServices(req.query)); } catch (e) { next(e); }
});

router.get('/users',            role(['admin']), validate(usersQuery, 'query'),          async (req, res, next) => {
  try { modernOk(res, await lookup.users(req.query)); } catch (e) { next(e); }
});

// Zonal Managers picker — admin-only. Returns the distinct set of users
// referenced as tbl_city.state_user (i.e. owners of at least one city).
// Drives the Manage Easyfixers "User Mapped To City" filter.
router.get('/zonal-managers',   role(['admin']),                                         async (_req, res, next) => {
  try { modernOk(res, await lookup.zonalManagers()); } catch (e) { next(e); }
});

// Project Managers picker — admin-only. Returns DISTINCT internal users
// mapped as SPOCs in tbl_vertical_mapping. Optional ?userType=1|2 narrows
// to Primary / Secondary SPOC (QuickSight Open Orders uses user_type=2;
// Client Performance uses user_type=1). Drives the QuickSight report
// "Project Manager" filter dropdown.
router.get('/project-managers', role(['admin']), validate(projectManagersQuery, 'query'), async (req, res, next) => {
  try { modernOk(res, await lookup.projectManagers(req.query)); } catch (e) { next(e); }
});

// Roles dropdown — admin-only. Used by the Manage Users form to fill the
// "Role" picker, and by Manage Roles itself for the picker on related
// screens. Optional `group` filter (admin|client|mobile|default) narrows
// the list to roles valid for a specific user type.
router.get('/roles',            role(['admin']),                                         async (req, res, next) => {
  try { modernOk(res, await lookup.roles(req.query)); } catch (e) { next(e); }
});

// Menu-action catalogue — drives the per-menu action checkboxes on the
// Manage Roles edit form. Admin-only since exposing the full action key
// list reveals every gated capability in the CRM.
router.get('/menu-actions',     role(['admin']),                                         async (_req, res, next) => {
  try { modernOk(res, await lookup.menuActions()); } catch (e) { next(e); }
});

// Compact easyfixer picker for "Assign Technician" dropdowns. Admin-only: client
// SPOCs and technicians themselves have no business enumerating the full bench.
router.get('/easyfixers',       role(['admin']),                                          async (req, res, next) => {
  try { modernOk(res, await lookup.easyfixers(req.query)); } catch (e) { next(e); }
});

// Sidebar menu tree — any authenticated principal gets the tree; the frontend
// filters per-role after the fact (no role column on tbl_menu). Per-env
// allowlist + email override applied inside the service (see lookup.service.js
// docblock on `menus`) — legacy Java CRM reads tbl_menu directly and is
// unaffected. req.user.official_email is the bypass key.
router.get('/menus',                                                                       async (req, res, next) => {
  try {
    modernOk(res, await lookup.menus({ userEmail: req.user?.official_email }));
  } catch (e) { next(e); }
});

// Companion to /menus — returns the legacy URL slugs of menus that ARE
// being hidden by the env allowlist. Consumed by the Next.js middleware
// in Easyfix_CRM_UI to server-side redirect direct URL navigation to
// /coming-soon, so users can't bypass the sidebar by pasting a URL.
// Non-sensitive payload (just slugs); the parent `/shared` mount keeps
// the JWT requirement so the answer can't leak the WIP backlog publicly.
router.get('/menu-visibility',                                                             async (_req, res, next) => {
  try { modernOk(res, await lookup.menuVisibility()); } catch (e) { next(e); }
});

module.exports = router;
