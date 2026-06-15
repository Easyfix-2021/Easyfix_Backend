const router = require('express').Router();

const requireAuth = require('../../middleware/auth');
const { role } = require('../../middleware/role');
const validate = require('../../middleware/validate');
const lookup = require('../../services/lookup.service');
const { modernOk } = require('../../utils/response');
const { pool } = require('../../db');
const { buildRequestScopeWithHierarchy } = require('../../lib/scope');
const {
  citiesQuery, serviceTypesQuery, clientsQuery, clientServicesQuery,
  usersQuery, banksQuery, simpleIncludeInactive, projectManagersQuery,
} = require('../../validators/lookup.validator');

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
  try { modernOk(res, await lookup.states()); } catch (e) { next(e); }
});

// Verticals — drives the Manage Users Verticals picker for RBAC scope.
router.get('/verticals',          async (_req, res, next) => {
  try { modernOk(res, await lookup.verticals()); } catch (e) { next(e); }
});

// Zones — drives the Manage Jobs "Zonal" filter dropdown. Lives here
// (not under /admin) because the Manage Jobs page calls /shared/lookup/*
// for all its filter options and consistency is cheap.
router.get('/zones',              async (_req, res, next) => {
  try { modernOk(res, await lookup.zones()); } catch (e) { next(e); }
});

router.get('/service-categories', validate(simpleIncludeInactive, 'query'), async (req, res, next) => {
  try { modernOk(res, await lookup.serviceCategories(req.query)); } catch (e) { next(e); }
});

router.get('/service-types',      validate(serviceTypesQuery, 'query'),    async (req, res, next) => {
  try { modernOk(res, await lookup.serviceTypes(req.query)); } catch (e) { next(e); }
});

router.get('/cancel-reasons',     async (_req, res, next) => {
  try { modernOk(res, await lookup.cancelReasons()); } catch (e) { next(e); }
});

router.get('/reschedule-reasons', async (_req, res, next) => {
  try { modernOk(res, await lookup.rescheduleReasons()); } catch (e) { next(e); }
});

router.get('/banks',              validate(banksQuery, 'query'),           async (req, res, next) => {
  try { modernOk(res, await lookup.banks(req.query)); } catch (e) { next(e); }
});

router.get('/document-types',     validate(simpleIncludeInactive, 'query'), async (req, res, next) => {
  try { modernOk(res, await lookup.documentTypes(req.query)); } catch (e) { next(e); }
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
