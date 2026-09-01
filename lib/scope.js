/*
 * RBAC scope helper — translates the legacy `manage_*` CSV columns on
 * `tbl_user` into SQL row-filters.
 *
 * Legacy convention (verified against production data 2026-05-12):
 *   manage_clients   = "0"           → access ALL clients (wildcard)
 *   manage_clients   = "1,3,10,..."  → access only those client_ids
 *   manage_clients   = NULL or ""    → access NOTHING (no scope assigned)
 *
 * Same shape for manage_cities, manage_states, manage_verticals.
 *
 * Usage (in a query builder):
 *
 *   const scope = parseScope(me.manage_clients);
 *   if (scope.mode === 'allow') {
 *     clauses.push(`j.fk_client_id IN (${scope.placeholders})`);
 *     params.push(...scope.ids);
 *   } else if (scope.mode === 'none') {
 *     // user has no client scope — block all rows
 *     clauses.push('1=0');
 *   }
 *   // scope.mode === 'all' → no clause needed
 */

function parseScope(csv) {
  const s = String(csv ?? '').trim();
  if (!s) return { mode: 'none', ids: [], placeholders: '' };
  if (s === '0') return { mode: 'all', ids: [], placeholders: '' };
  const ids = s.split(',')
    .map((t) => Number(String(t).trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return { mode: 'none', ids: [], placeholders: '' };
  return { mode: 'allow', ids, placeholders: ids.map(() => '?').join(',') };
}

/**
 * Convenience: append a `column IN (...)` clause to an existing
 * { clauses: [], params: [] } SQL builder, honouring the wildcard.
 * Returns true if the user has any access at all (caller can short-
 * circuit with an empty-result return on false).
 */
function applyScope({ clauses, params }, columnExpr, csv) {
  const scope = parseScope(csv);
  if (scope.mode === 'all') return true;
  if (scope.mode === 'none') { clauses.push('1=0'); return false; }
  clauses.push(`${columnExpr} IN (${scope.placeholders})`);
  params.push(...scope.ids);
  return true;
}

/**
 * THE RBAC CITY-SCOPE PREDICATE. One place, because six call sites need it and
 * they have to agree: the easyfixer roster, its counts strip, its aggregate
 * fill, attendance, the registered queue, the LMS course list, the LMS action
 * tool, advances, easyfixer transactions and payouts.
 *
 * A TECHNICIAN WITH NO CITY IS VISIBLE UNDER EVERY SCOPE.
 *
 * `e.efr_cityId IN (…)` is never true for NULL — it is NULL, which WHERE
 * treats as false. So 2,427 technicians with no city belonged to no operator's
 * scope and were invisible to all of them, including the people whose job is
 * to give them one. Nobody owning a row is not a reason to hide it from
 * everybody.
 *
 * WHY THE ANCHOR ARGUMENT IS MANDATORY. Most of these queries reach the
 * technician through `LEFT JOIN tbl_easyfixer e`, where `e.efr_cityId IS NULL`
 * means one of TWO different things:
 *
 *   1. the technician exists and has no city   → must be visible (the point)
 *   2. no technician row matched at all        → must NOT become visible
 *
 * Case 2 is not hypothetical: tbl_easyfixer_transaction and tbl_service_payout
 * outlive the technicians they reference, so a bare `OR … IS NULL` would hand
 * every city-scoped operator the money rows of admin-deleted technicians.
 * Anchoring on the technician's own key separates the two, and costs nothing
 * where the row IS the technician (a PK is never NULL).
 *
 * THIS DOES NOT WIDEN THE USER'S OWN City / State FILTERS, and cannot: those
 * add `e.efr_cityId = ?` and `c.state_id = ?`, which do not match NULL either.
 * A city-less technician therefore surfaces only when City and State are both
 * "All" — the intended rule, asserted in tests/easyfixer-city-scope.test.js.
 *
 * Placeholder arity is unchanged: the caller still pushes exactly `ids`.
 */
function cityScopeSql(cityColumn, presentColumn, ids) {
  const placeholders = ids.map(() => '?').join(',');
  return `(${cityColumn} IN (${placeholders})`
    + ` OR (${presentColumn} IS NOT NULL AND ${cityColumn} IS NULL))`;
}

/**
 * Bypass list — role names that should not be scope-filtered at all
 * (they're privileged enough to see everything). Mirrors the legacy
 * CRM's "Admin sees all" + "Finance sees all" implicit behaviour.
 * Edit cautiously — adding a role here removes its row-level RBAC.
 */
const SCOPE_BYPASS_ROLES = new Set(['Admin', 'Finance']);

function bypassesScope(roleName) {
  return SCOPE_BYPASS_ROLES.has(String(roleName || '').trim());
}

/*
 * Manage Regions (2026-07): a user's geo scope is now the STATE ("Region")
 * list on `manage_states`; their effective CITY scope is ALL cities in those
 * states, derived LIVE from tbl_city — so it is never a stale stored list and
 * a newly-added city is instantly in scope. For region-scoped users
 * `manage_cities` is stored as "0" (all) and ignored for geo purposes.
 *
 * Cache: tbl_city (city_id, state_id) is a small static master — cache the
 * state→cities map in-process for 60s (mirrors the hierarchy-adjacency cache
 * in user.service.js) so scope-building never hits the DB per request.
 */
let _cityByStateCache = null;
let _cityByStateCacheAt = 0;
const CITY_BY_STATE_TTL_MS = 60_000;

async function loadCityByState(pool) {
  const now = Date.now();
  if (_cityByStateCache && (now - _cityByStateCacheAt) < CITY_BY_STATE_TTL_MS) {
    return _cityByStateCache;
  }
  const [rows] = await pool.query(
    'SELECT city_id, state_id FROM tbl_city WHERE city_status = 1'
  );
  const map = new Map(); // state_id → [city_id, …]
  for (const r of rows) {
    const sid = Number(r.state_id);
    const cid = Number(r.city_id);
    if (!Number.isInteger(sid) || !Number.isInteger(cid)) continue;
    if (!map.has(sid)) map.set(sid, []);
    map.get(sid).push(cid);
  }
  _cityByStateCache = map;
  _cityByStateCacheAt = now;
  return map;
}

/*
 * Expand a states/Regions scope into the equivalent CITY scope.
 *   'all' / 'none' / absent → { mode:'all' } (no city narrowing — callers
 *      only invoke this for mode 'allow', but stay defensive)
 *   'allow' [5,12]          → { mode:'allow', ids: all active cities in 5,12 }
 *   a region with zero active cities → { mode:'none' } (blocks — that region
 *      genuinely has no serviceable cities)
 */
async function expandStatesToCities(pool, statesScope) {
  if (!statesScope || statesScope.mode !== 'allow') {
    return { mode: 'all', ids: [], placeholders: '' };
  }
  const byState = await loadCityByState(pool);
  const set = new Set();
  for (const sid of statesScope.ids) {
    const cs = byState.get(Number(sid));
    if (cs) for (const c of cs) set.add(c);
  }
  const ids = Array.from(set).sort((a, b) => a - b);
  if (ids.length === 0) return { mode: 'none', ids: [], placeholders: '' };
  return { mode: 'allow', ids, placeholders: ids.map(() => '?').join(',') };
}

/**
 * Build the scope object for the current request, parsing all four
 * dimensions off `req.user.manage_*` CSVs. Returns `undefined` for
 * bypass roles (Admin / Finance) so consumers can short-circuit.
 *
 * Usage:
 *   const scope = buildRequestScope(req);
 *   const { rows } = await service.list({ ...req.query, scope });
 *
 * Services accepting `scope` are responsible for translating each
 * dimension into the right column expression (job → fk_client_id,
 * easyfixer → efr_cityId, invoice → fk_client_id, etc.) and respecting
 * `mode='none'` by short-circuiting to zero rows.
 */
function buildRequestScope(req) {
  // Prefer the precomputed hierarchy-aware scope attached by the admin
  // middleware (routes/admin/index.js). If it's set (or explicitly
  // undefined for bypass roles), use that. Falls back to own-scope-only
  // for callers that haven't passed through the middleware (e.g. some
  // unit-tested handlers).
  if (Object.prototype.hasOwnProperty.call(req, 'scope')) return req.scope;
  if (bypassesScope(req.userRole?.role_name)) return undefined;
  return {
    clients:   parseScope(req.user?.manage_clients),
    cities:    parseScope(req.user?.manage_cities),
    states:    parseScope(req.user?.manage_states),
    verticals: parseScope(req.user?.manage_verticals),
  };
}

/**
 * Async variant — unions the caller's scope with the scope of every
 * direct/indirect report (hierarchy DFS). Use this on data-list endpoints
 * so a reporting manager sees their team's data automatically.
 *
 * Cost: one extra SELECT against tbl_user (cheap; hierarchy adjacency is
 * cached for 60s in services/user.service.js::_loadHierarchyAdjacency).
 *
 * Caller must `await` it. Returns the same `{ clients, cities, states,
 * verticals }` shape as `buildRequestScope` so consumers don't care
 * whether the data was unioned or not.
 */
async function buildRequestScopeWithHierarchy(req, pool) {
  if (bypassesScope(req.userRole?.role_name)) return undefined;
  const own = buildRequestScope(req);
  if (!own) return undefined;
  let result = own;
  try {
    const { findDescendantUserIds } = require('../services/user.service');
    const { descendants } = await findDescendantUserIds(req.user.user_id);
    if (descendants.length > 0) {
      const placeholders = descendants.map(() => '?').join(',');
      const [rows] = await pool.query(
        `SELECT manage_clients, manage_cities, manage_states, manage_verticals
           FROM tbl_user WHERE user_id IN (${placeholders})`,
        descendants
      );
      // Cap each dimension at the caller's OWN explicit list. A direct
      // or indirect report with broader access (e.g. manage_clients = "0")
      // must NOT widen the manager's visibility on a dimension the manager
      // was deliberately restricted on. See `mergeScopeRespectingCap` for
      // the full rationale + behaviour table.
      let merged = own;
      for (const r of rows) {
        merged = {
          clients:   mergeScopeRespectingCap(merged.clients,   parseScope(r.manage_clients)),
          cities:    mergeScopeRespectingCap(merged.cities,    parseScope(r.manage_cities)),
          states:    mergeScopeRespectingCap(merged.states,    parseScope(r.manage_states)),
          verticals: mergeScopeRespectingCap(merged.verticals, parseScope(r.manage_verticals)),
        };
      }
      result = merged;
    }
  } catch {
    // If the hierarchy lookup fails for any reason, fall back to own
    // scope so we don't accidentally widen access on a stale cache.
    result = own;
  }
  // Manage Regions: when the user (after the hierarchy merge) is scoped to
  // specific states/Regions, their effective CITY scope becomes ALL cities in
  // those states — derived live so it never goes stale. Applied at the single
  // exit so BOTH the own-only and merged paths are covered. Only when states is
  // an explicit allow-list; states all/none keeps the legacy manage_cities
  // scope, so non-region users are unchanged and nobody is locked out.
  if (result && result.states && result.states.mode === 'allow') {
    result = { ...result, cities: await expandStatesToCities(pool, result.states) };
  }
  return result;
}

/**
 * Assert a single entity is reachable under the caller's scope.
 *
 * `entityFields` is a plain object with whichever of these keys are
 * relevant to the entity:
 *   { client_id, city_id, state_id, vertical_id, easyfixer_id }
 *
 * Returns `{ ok: true }` if every present dimension is in-scope (or
 * the caller bypasses scope). Returns `{ ok: false, reason }` otherwise.
 * Use the reason in your 404/403 response — we recommend 404 to avoid
 * leaking existence of out-of-scope ids.
 *
 * Usage (route handler):
 *   const job = await jobService.getById(id);
 *   if (!job) return modernError(res, 404, 'not found');
 *   const guard = assertEntityInScope(req, {
 *     client_id: job.fk_client_id, city_id: job.address_city_id,
 *   });
 *   if (!guard.ok) return modernError(res, 404, 'not found');
 */
function assertEntityInScope(req, entityFields) {
  if (bypassesScope(req.userRole?.role_name)) return { ok: true };
  const scope = buildRequestScope(req);
  if (!scope) return { ok: true };

  function inDim(dim, id) {
    if (id == null) return true; // dimension absent on this entity
    if (dim.mode === 'all') return true;
    if (dim.mode === 'none') return false;
    return dim.ids.includes(Number(id));
  }
  if (!inDim(scope.clients,   entityFields.client_id))   return { ok: false, reason: 'client out of scope' };
  if (!inDim(scope.cities,    entityFields.city_id))     return { ok: false, reason: 'city out of scope' };
  if (!inDim(scope.states,    entityFields.state_id))    return { ok: false, reason: 'state out of scope' };
  if (!inDim(scope.verticals, entityFields.vertical_id)) return { ok: false, reason: 'vertical out of scope' };
  return { ok: true };
}

/**
 * Merge two `parseScope` results into one — the symmetric union of
 * their access.
 *   ('all', anything)         → 'all'
 *   ('none', X)               → X
 *   ('allow', 'allow')        → 'allow' with deduped union of ids
 *
 * Pure union. Use this when both sides are peers (e.g. composing
 * scopes of two unrelated users). For the hierarchy union where the
 * caller's own list must remain a hard cap on visibility, prefer
 * `mergeScopeRespectingCap` (below).
 */
function mergeScope(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.mode === 'all' || b.mode === 'all') return { mode: 'all', ids: [], placeholders: '' };
  if (a.mode === 'none') return b;
  if (b.mode === 'none') return a;
  const merged = Array.from(new Set([...a.ids, ...b.ids])).sort((x, y) => x - y);
  return { mode: 'allow', ids: merged, placeholders: merged.map(() => '?').join(',') };
}

/**
 * Merge a downstream subordinate's scope into the caller's own — but
 * cap at the caller's own when explicit.
 *
 * Semantic difference vs. plain `mergeScope`:
 *
 *   own = { mode: 'allow', ids: [10, 17] }     // hard cap — 2 clients
 *   sub = { mode: 'all',   ids: [] }           // subordinate sees all
 *   ───────────────────────────────────────────────
 *   mergeScope(own, sub)                  → { mode: 'all',   ids: [] }  // WIDENS → leak
 *   mergeScopeRespectingCap(own, sub)     → { mode: 'allow', ids: [10, 17] }  // capped
 *
 * Rationale: when an operator (e.g. a Project Manager) is deliberately
 * scoped to a specific client list on their `tbl_user.manage_clients`
 * row, that list is the AUTHORITATIVE upper bound. A direct/indirect
 * report having broader visibility (e.g. `manage_clients = "0"`) must
 * NOT transitively widen the manager's view to all-clients — the
 * manager's explicit list is the cap.
 *
 * Behaviour table:
 *   own.mode = 'allow' → returns own unchanged (cap holds; sub ignored)
 *   own.mode = 'all'   → returns 'all'         (already widest; no-op)
 *   own.mode = 'none'  → returns sub           (manager has no scope of
 *                                                their own; lend the
 *                                                subordinate's access)
 *
 * The 'none' branch preserves the original "PM with empty manage_*
 * inherits team scope" affordance — only the explicit-cap case
 * (Priyanka's situation, fixed 2026-06-04) changes behaviour.
 */
function mergeScopeRespectingCap(own, sub) {
  if (!own) return sub;
  if (!sub) return own;
  if (own.mode === 'allow') return own; // hard cap; subordinate cannot widen
  return mergeScope(own, sub);
}

module.exports = {
  parseScope, applyScope, cityScopeSql, bypassesScope, SCOPE_BYPASS_ROLES,
  buildRequestScope, buildRequestScopeWithHierarchy, expandStatesToCities,
  assertEntityInScope, mergeScope, mergeScopeRespectingCap,
};
