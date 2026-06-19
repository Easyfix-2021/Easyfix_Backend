/*
 * Properties service — small DB-backed key/value store for feature flags
 * and other config that ops want to flip without redeploying.
 *
 * Backed by `easyfix_properties` (created by
 * migrations/2026-06-03-easyfix-properties.sql). Property names are
 * Spring-style dotted strings — e.g. `new.crm.visible.menu.ids`,
 * `kaleyra.calling.enabled`. Values are TEXT; parsing (boolean / CSV /
 * JSON) is the caller's responsibility.
 *
 * Loading model (2026-06-03 — TTL refresh + manual flush):
 *   - server.js calls preload() once at boot — primes the cache so the
 *     first request after start serves from memory.
 *   - Cache has a 1-HOUR TTL. The next read after expiry triggers a
 *     background refresh; the stale value is still returned during the
 *     refresh window so request latency is unaffected. This keeps the
 *     hot path synchronous AND eventually-consistent within ≤1h of any
 *     UPDATE on the table.
 *   - flushCache() invalidates the cache immediately. Wired to the
 *     admin POST /api/admin/properties/reload endpoint, which the FE
 *     fires after a 10-quick-clicks gesture on the Easyfix logo.
 *
 * If the table is absent (pre-migration deployment) we cache an empty
 * Map, log a warn, and let callers read `undefined`. Cache survives the
 * failure so we don't hammer MySQL on every read. The next TTL tick
 * retries — so a freshly-migrated host catches up without a restart.
 *
 * 2026-06-03 per ops: easyfix_properties is now the SOLE source of
 * truth for the 4 migrated keys — no process.env fallback in callers.
 */

const { pool } = require('../db');
const logger = require('../logger');

// 1 hour in ms — chosen to balance fresh-config rollout against MySQL
// read load. The 10-click flush gesture is the immediate-rollout path
// when ops doesn't want to wait an hour.
const CACHE_TTL_MS = 60 * 60 * 1000;

let _cache = null;             // Map<key,string> once populated
let _loadedAt = 0;             // epoch ms of the last successful load
let _loadPromise = null;       // dedupes concurrent first-reads / refreshes
let _refreshInFlight = false;  // tracks whether a TTL-driven refresh is running

async function _load() {
  try {
    const [rows] = await pool.query(
      'SELECT property_key, property_value FROM easyfix_properties'
    );
    const m = new Map();
    for (const r of rows) m.set(r.property_key, r.property_value);
    _cache = m;
    _loadedAt = Date.now();
    logger.info(`easyfix_properties loaded — ${m.size} key(s) cached (TTL ${CACHE_TTL_MS / 1000}s)`);
  } catch (err) {
    // Pre-migration deploys (table doesn't exist yet) must still boot —
    // callers handle `undefined` per their own semantics. Cache an empty
    // map so we don't re-hit MySQL on every read. We stamp _loadedAt
    // anyway so the failed load benefits from the same TTL cooldown —
    // the next refresh tick retries automatically when 1h elapses.
    _cache = new Map();
    _loadedAt = Date.now();
    logger.warn(
      `easyfix_properties unavailable — ${err.code || err.message}. ` +
      `Cache primed empty; all keys will resolve to undefined.`
    );
  }
}

/*
 * Background refresh helper — called from getProperty() when the cache
 * is past the TTL. Returns the stale cache immediately while a new
 * `_load()` runs in the background. The next request after the refresh
 * settles will see the fresh values. No promise is awaited on the hot
 * path so request latency is unaffected.
 */
function _maybeRefresh() {
  if (_refreshInFlight) return;
  if (Date.now() - _loadedAt < CACHE_TTL_MS) return;
  _refreshInFlight = true;
  Promise.resolve(_load())
    .catch((e) => logger.warn(`properties refresh failed — ${e.message}`))
    .finally(() => { _refreshInFlight = false; });
}

/**
 * Preload the cache. Called from server.js at boot AFTER the DB
 * connection is verified but BEFORE the HTTP listener accepts traffic.
 * Idempotent: safe to call more than once (the dedupe promise ensures
 * a single round-trip).
 */
async function preload() {
  if (_cache) return;
  if (!_loadPromise) _loadPromise = _load();
  await _loadPromise;
}

/**
 * Look up a property by key. Returns the raw string value, or
 * `undefined` if the key is absent (caller decides default + parsing).
 *
 * Sync after preload() has resolved. Before that — or if preload()
 * was skipped — returns `undefined` synchronously and kicks off a
 * background load so the next call benefits. Callers that need a
 * guaranteed-fresh value can `await getAllProperties()` instead, or
 * call `flushCache()` to force a refresh.
 *
 * Past TTL: returns the STALE cache immediately + fires a background
 * refresh. This keeps the hot path synchronous; callers that need
 * strict freshness can use the 10-click flush gesture or the admin
 * reload endpoint.
 */
function getProperty(key) {
  if (!_cache) {
    // Lazy fire-and-forget so the cache eventually populates without
    // making this function async. The very first reader gets a miss —
    // acceptable since server.js preloads at boot and routes don't
    // fire pre-listen.
    if (!_loadPromise) _loadPromise = _load();
    return undefined;
  }
  _maybeRefresh();
  const v = _cache.get(key);
  return v == null ? undefined : v;
}

/**
 * Returns a plain object snapshot of every cached property. Triggers
 * a load if the cache is cold (so this one is async). Useful for
 * debug / admin endpoints.
 */
async function getAllProperties() {
  await preload();
  const out = {};
  for (const [k, v] of _cache) out[k] = v;
  return out;
}

/**
 * Invalidate the cache + reload synchronously. Returns the freshly
 * loaded count for the admin response. Used by:
 *   - POST /api/admin/properties/reload (operator-triggered via the
 *     10-quick-clicks gesture on the Easyfix logo)
 *   - any future operational tool that mutates easyfix_properties
 *     directly and wants the BE to pick up the change immediately
 */
async function flushCache() {
  _cache = null;
  _loadedAt = 0;
  _loadPromise = _load();
  await _loadPromise;
  return _cache ? _cache.size : 0;
}

/**
 * Upsert a single property (UPDATE-then-INSERT so it works whether or not
 * property_key carries a unique constraint) and keep the in-process cache hot
 * so the change is visible to this process immediately. Other replicas pick it
 * up on their next TTL refresh / flush. Used by admin toggles like the
 * Web↔Mobile calling switch (voice.call.mode).
 */
async function setProperty(key, value) {
  const v = String(value);
  const [r] = await pool.query(
    'UPDATE easyfix_properties SET property_value = ? WHERE property_key = ?',
    [v, key],
  );
  if (!r.affectedRows) {
    await pool.query(
      'INSERT INTO easyfix_properties (property_key, property_value) VALUES (?, ?)',
      [key, v],
    );
  }
  if (_cache) _cache.set(key, v);
  return true;
}

module.exports = {
  preload,
  getProperty,
  getAllProperties,
  flushCache,
  setProperty,
};
