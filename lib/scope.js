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

const logger = require('../logger');

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

/*
 * VERTICALS → CLIENTS (2026-09-02). Same trick as states→cities above, for a
 * different reason: this one is a QUERY PLAN fix, not a freshness fix.
 *
 * THE PROBLEM. A vertical scope used to be emitted as `cl.vertical_id IN (?)`
 * — a predicate on the JOINED tbl_client alias, not on `j`. Measured with
 * EXPLAIN over the exact SQL job.service.list() generates for the Manage Jobs
 * "All" tab, on QA (10.30.2.30, MySQL 8.4.9) — NOT production, which this repo's
 * .env names as 10.30.3.73. The row counts below are QA's; the PLAN SHAPES are
 * the point, but do not re-quote these as production figures:
 *
 *   Admin (bypasses scope, WHERE touches only `j.`):
 *     tbl=j  type=index key=PRIMARY rows=50   Backward index scan
 *   Project Manager, clients IN (14) + cl.vertical_id IN (2):
 *     tbl=cl type=range key=FKmmx6k5anfy7rodm0soh5ix38c rows=14
 *            extra=Using temporary; Using filesort
 *     tbl=j  type=ref   key=idx_job_client_status_checkout rows=1168
 *   Same PM, vertical clause folded onto j.fk_client_id (this function):
 *     tbl=j  type=index key=PRIMARY  Using where; Backward index scan
 *
 * NOT UNIVERSALLY FASTER — the honest ceiling. The backward PK scan wins only
 * while a vertical's jobs reach near the TOP of the primary key; for a small,
 * older vertical the scan walks further before it fills 50 rows. Vertical 3
 * (7 clients, 2,410 jobs, newest job_id 326,700 of max 482,512) measured SLOWER
 * after the fold — 32ms to 41ms, planning
 * `j: range/FK_tbl_job_client/rows=2411, Using filesort`. The estimate degrades
 * monotonically as a vertical's rows thin out near the top of the PK. Nine
 * milliseconds lost on a small vertical against a 44,206-row temp table removed
 * from a large one is a trade worth making — but it IS a trade.
 *
 * One clause on `cl` flips the join order: MySQL drives from tbl_client
 * instead of tbl_job, which destroys the PRIMARY-key ordering that
 * `ORDER BY j.job_id DESC LIMIT 50` was riding, and it materialises + sorts
 * every in-scope job to return a 50-row first page. For one real PM that temp
 * table is 44,206 rows; for the vertical-only shape it is 205,391 (the whole
 * table is 481,048). 30 of the 41 active role-13 users carry an explicit
 * manage_verticals list and pay this (32 across all roles). Note also that only
 * ONE role-13 user has manage_clients='0', so the large "vertical-only" shape
 * quoted above is a single account, not the common case. It is NOT the city dimension: only 2 of
 * those 41 have manage_states != '0', and the city-scoped plan is byte-for-byte
 * Admin's.
 *
 * WHY THE FOLD IS SAFE. It is a set INTERSECTION, so it can only narrow:
 *   · clients 'allow' → keep the ids that are also in one of the verticals.
 *   · clients 'all'   → the clients in those verticals become the list.
 *   · empty result    → mode 'none' → `1=0`, which is what the unfoldable
 *                       `cl.vertical_id IN (…)` already returned: zero rows.
 *                       Returning 'all' here would hand that user EVERY job.
 *   · clients 'none'  → left untouched so the existing `1=0` still fires.
 * NULL vertical_id (194 of 398 tbl_client rows) must stay EXCLUDED: today
 * `cl.vertical_id IN (2)` is NULL for them and WHERE reads that as false. The
 * `WHERE vertical_id IS NOT NULL` below reproduces that exactly. Drop it and
 * 194 clients silently enter every vertical-scoped operator's view.
 * Orphan jobs (5 rows whose fk_client_id has no tbl_client row; 0 rows with a
 * NULL fk_client_id) are excluded both ways — LEFT JOIN → NULL vertical before,
 * absent from the derived id set after.
 *
 * WHY HERE AND NOT AT THE 13 CALL SITES. Every consumer of scope.verticals
 * (job.service list/counts/attention, job-export, routes/admin/jobs,
 * quotations, advances, clients ×4) already applies the clients dimension
 * beside it, so folding upstream fixes all of them at once and none of them
 * needs to change. It also un-trips the `/\bcl\./` sniff in job.service.js's
 * COUNT-join builder, so the PM's COUNT stops joining tbl_client too — and
 * COUNT/LIST cannot drift, because both halves read the one scope object this
 * function returns.
 *
 * STALENESS IS AN EXPOSURE WINDOW, NOT A FRESHNESS DELAY, and the states→cities
 * analogy does NOT hold. A city is never re-pointed to another state to change
 * who may see it. A client's vertical IS re-pointed from inside this product
 * (client.service.js maps verticalId→vertical_id; PUT /:clientId/verticals
 * exists), and re-pointing it is usually how somebody CHANGES WHO CAN SEE THAT
 * CLIENT. Left to expire, a 60s cache would keep operators scoped to the OLD
 * vertical seeing that client's jobs for up to a minute — rows the live JOIN
 * excluded on the very next request. That is a scope leak with a timer on it.
 * So the cache is INVALIDATED ON WRITE (client.service.js calls
 * invalidateClientsByVertical after any write that can touch vertical_id); the
 * TTL survives only as a backstop for writes that reach the table another way —
 * another Node process, or a manual UPDATE — and 60s is the exposure only then.
 *
 * TWO behaviour changes outside the jobs list, one wanted and one not:
 *
 *   WANTED. services/lookup.service.js::clients ignores scope.verticals but
 *   honours scope.clients, so a vertical-scoped PM's client PICKER now narrows
 *   to their vertical. A narrowing, and it makes the picker agree with the list
 *   that already hid those clients' jobs.
 *
 *   NOT WANTED, and guarded below. assertEntityInScope() treats a dimension
 *   whose value is null as in-scope (`if (id == null) return true`), so a
 *   vertical-scoped operator can reach a client whose vertical_id IS NULL by id
 *   today. Folding drops those 194 clients out of the allow-list and would 404
 *   them — measured, 3 of 32 vertical-scoped users lose by-id reachability that
 *   way. So the PRE-FOLD dimensions ride along as `entityClients` /
 *   `entityVerticals` and assertEntityInScope reads those: row filtering uses
 *   the folded list, entity guards keep exactly the reachability they had.
 */
let _clientsByVerticalCache = null;
let _clientsByVerticalCacheAt = 0;
const CLIENTS_BY_VERTICAL_TTL_MS = 60_000;

async function loadClientsByVertical(pool) {
  const now = Date.now();
  if (_clientsByVerticalCache && (now - _clientsByVerticalCacheAt) < CLIENTS_BY_VERTICAL_TTL_MS) {
    return _clientsByVerticalCache;
  }
  const [rows] = await pool.query(
    'SELECT client_id, vertical_id FROM tbl_client WHERE vertical_id IS NOT NULL'
  );
  const map = new Map(); // vertical_id → [client_id, …]
  for (const r of rows) {
    const vid = Number(r.vertical_id);
    const cid = Number(r.client_id);
    if (!Number.isInteger(vid) || !Number.isInteger(cid)) continue;
    if (!map.has(vid)) map.set(vid, []);
    map.get(vid).push(cid);
  }
  _clientsByVerticalCache = map;
  _clientsByVerticalCacheAt = now;
  return map;
}

/**
 * Intersect a verticals allow-list into the clients dimension.
 * Returns the replacement `clients` scope, or `null` to leave the scope alone.
 */
/**
 * Drop the client→vertical cache. Called by client.service.js after any write
 * that can change vertical_id — see the STALENESS note above: a client's
 * vertical is re-pointed precisely in order to change who can see it, so waiting
 * out the TTL would leave a timed scope leak.
 */
function invalidateClientsByVertical() {
  _clientsByVerticalCache = null;
  _clientsByVerticalCacheAt = 0;
}

async function foldVerticalsIntoClients(pool, clients, verticals) {
  if (!verticals || verticals.mode !== 'allow' || !verticals.ids.length) return null;
  if (clients && clients.mode === 'none') return null; // `1=0` already blocks
  let byVertical;
  try {
    byVertical = await loadClientsByVertical(pool);
  } catch (err) {
    // tbl_client.vertical_id absent on this deploy (or the read failed) → FAIL
    // OPEN, matching job.service.js::hasClientVerticalIdColumn, which skips the
    // vertical clause rather than 500ing when the column is missing. Leaving
    // `verticals` as 'allow' also keeps that existing guard in charge.
    //
    // LOGGED, because failing open silently is how an optimisation stops working
    // for good with nobody noticing: one transient pool error and every later
    // request in this process takes the slow path, indistinguishable from the
    // fix never having shipped.
    logger.warn({ err: err && err.message },
      '[scope] verticals→clients fold unavailable; falling back to the '
      + 'cl.vertical_id predicate (slower plan, identical rows)');
    return null;
  }
  const set = new Set();
  for (const vid of verticals.ids) {
    for (const cid of (byVertical.get(Number(vid)) || [])) set.add(cid);
  }
  const ids = (clients && clients.mode === 'allow')
    ? clients.ids.filter((x) => set.has(Number(x)))
    : Array.from(set).sort((a, b) => a - b);
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
  // Verticals: same single-exit placement, for the query-plan reason spelled out
  // on foldVerticalsIntoClients. Once folded, `verticals` becomes 'all' so every
  // `cl.vertical_id IN (…)` branch downstream stops firing — the restriction now
  // rides on the clients dimension, which names only `j.fk_client_id`.
  if (result && result.verticals && result.verticals.mode === 'allow') {
    const folded = await foldVerticalsIntoClients(pool, result.clients, result.verticals);
    if (folded) {
      result = {
        ...result,
        // Row filtering rides the folded list; ENTITY guards keep the pre-fold
        // dimensions, so a client with a NULL vertical_id stays reachable by id
        // exactly as it is today. See assertEntityInScope.
        entityClients: result.clients,
        entityVerticals: result.verticals,
        clients: folded,
        verticals: { mode: 'all', ids: [], placeholders: '' },
      };
    }
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
  /*
   * `entityClients` / `entityVerticals` are the PRE-FOLD dimensions, present
   * only when foldVerticalsIntoClients() rewrote the clients list for the query
   * planner. Row filtering wants the folded list; a by-id guard does not,
   * because the fold necessarily drops every client whose vertical_id is NULL —
   * and inDim() treats a null dimension ON THE ENTITY as in-scope, which is how
   * those clients are reachable today. Reading the folded list here would 404
   * them. Falls back to the live dimensions when no fold happened.
   */
  const clientsDim   = scope.entityClients   || scope.clients;
  const verticalsDim = scope.entityVerticals || scope.verticals;
  if (!inDim(clientsDim,   entityFields.client_id))   return { ok: false, reason: 'client out of scope' };
  if (!inDim(scope.cities, entityFields.city_id))     return { ok: false, reason: 'city out of scope' };
  if (!inDim(scope.states, entityFields.state_id))    return { ok: false, reason: 'state out of scope' };
  if (!inDim(verticalsDim, entityFields.vertical_id)) return { ok: false, reason: 'vertical out of scope' };
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
  foldVerticalsIntoClients,
  assertEntityInScope, mergeScope, mergeScopeRespectingCap,
  invalidateClientsByVertical,
};
