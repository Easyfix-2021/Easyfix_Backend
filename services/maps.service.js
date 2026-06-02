/*
 * services/maps.service.js
 *
 * Google Maps proxy logic (autocomplete + geocode + config-key). This
 * used to live inline in `routes/admin/maps.js` and was extracted on
 * 2026-05-28 so the customer-facing magic-link page (token-gated
 * `/api/public/maps/*`) can call the SAME underlying Google calls
 * without duplicating cache / error-mapping logic.
 *
 * Why proxy at all: keeps GOOGLE_MAPS_API_KEY server-side (never
 * shipped to the browser bundle), centralises request budgeting +
 * caching, and lets us bolt on per-user rate limits later without
 * touching the client.
 *
 * Cost-control measures:
 *   1. Callers validate min-length on `q` (≥3) — Google Places
 *      Autocomplete charges per request regardless of result count;
 *      single-char prefixes return garbage and burn credits.
 *   2. In-memory LRU cache (Map with 200-entry ceiling, 10-min TTL)
 *      dedupes repeat queries from the same operator/customer typing
 *      pattern. Cache is shared across admin + public mounts — same
 *      `q` string benefits from a hit regardless of which surface
 *      asked first.
 *   3. Country bias to `country:in` so we don't return US/UK
 *      addresses (which are useless to EasyFix and inflate API spend).
 *
 * Error contract: functions THROW `{ status, message }` shapes (NOT
 * Error instances) on Google-side failures so the route handlers can
 * choose to surface via `modernError(res, e.status, e.message)` and
 * fall through to `next(e)` only for genuine 500-class bugs.
 */

const logger = require('../logger');

const MAPS_BASE = 'https://maps.googleapis.com/maps/api';
// 10-minute in-memory cache. Maps a normalised query string to a
// `{value, expires}` pair. LRU-ish behaviour: when we hit the cap we
// drop the oldest insert order (Map iteration order).
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_CAP    = 200;
const cache = new Map();
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) { cache.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value) {
  if (cache.size >= CACHE_CAP) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

/*
 * autocomplete(q)
 *
 * Wraps Google Places Autocomplete. Returns a slim shape so callers
 * don't depend on Google's full response:
 *   { items: [{ place_id, description, primary, secondary }] }
 *
 * `primary` + `secondary` come from structured_formatting (street name
 * vs. neighbourhood/city). Letting the UI render them as a two-line
 * suggestion is what makes Places feel native.
 *
 * Throws `{ status, message }` for caller-mappable errors:
 *   - 503 when GOOGLE_MAPS_API_KEY isn't configured
 *   - 502 when Google returns a non-OK / non-ZERO_RESULTS status
 */
async function autocomplete(q) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw { status: 503, message: 'Google Maps not configured (GOOGLE_MAPS_API_KEY missing)' };
  const cacheKey = `ac:${q.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const url = `${MAPS_BASE}/place/autocomplete/json?input=${encodeURIComponent(q)}&components=country:in&key=${apiKey}`;
  const r = await fetch(url);
  const data = await r.json();
  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    // Don't log the full error_message at info level — it may include
    // the API key on quota errors. Trimmed to a few hundred chars.
    logger.warn({ status: data.status, error_message: String(data.error_message || '').slice(0, 200) }, 'Google autocomplete error');
    throw { status: 502, message: `Google autocomplete failed: ${data.status}` };
  }
  const items = (data.predictions || []).map((p) => ({
    place_id:  p.place_id,
    description: p.description,
    primary:   p.structured_formatting?.main_text || p.description,
    secondary: p.structured_formatting?.secondary_text || '',
  }));
  const out = { items };
  cacheSet(cacheKey, out);
  return out;
}

/*
 * geocode({ place_id, address, latlng })
 *
 * Wraps Google Geocoding. Returns:
 *   { lat, lng, formatted_address, address_components: {...} }
 *
 * `address_components` is a flattened map for convenient access:
 *   { postal_code, city, state, country, route, ... }.
 * Callers use it to auto-fill PIN code + city when an autosuggest
 * pick lands. Falls back to a raw `address` text query when the
 * place_id-less variant is needed (e.g. re-geocoding a saved
 * address), and to `latlng` for reverse-geocoding a draggable
 * map-marker drop.
 *
 * Throws `{ status, message }` with actionable operator hints —
 * `REQUEST_DENIED` typically means "Geocoding API not enabled on this
 * key" and we surface that specific guidance rather than a bare 502.
 */
async function geocode({ place_id, address, latlng }) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw { status: 503, message: 'Google Maps not configured' };
  const placeId = place_id || null;
  const addr    = address  || null;
  const ll      = latlng   || null;
  const cacheKey = `gc:${placeId || addr || ll || ''}`.toLowerCase();
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const param = placeId
    ? `place_id=${encodeURIComponent(placeId)}`
    : ll
      ? `latlng=${encodeURIComponent(ll)}`
      : `address=${encodeURIComponent(addr || '')}&components=country:in`;
  const url = `${MAPS_BASE}/geocode/json?${param}&key=${apiKey}`;
  const r = await fetch(url);
  const data = await r.json();
  if (data.status !== 'OK') {
    logger.warn({ status: data.status, error_message: String(data.error_message || '').slice(0, 200) }, 'Google geocode error');
    /*
     * Map common Google failure codes to actionable operator hints
     * (2026-05-28). The bare `REQUEST_DENIED` we used to surface was
     * indistinguishable from a genuine quota / outage — but in
     * practice it almost always means "Geocoding API is not
     * enabled on this key" because Places Autocomplete shares the
     * same key but enables independently in GCP. Returning a
     * specific message lets the FE toast something operators can act
     * on instead of opening a ticket.
     */
    let msg;
    if (data.status === 'REQUEST_DENIED') {
      msg = 'Geocoding API rejected this key — enable "Geocoding API" on the same GCP key that already serves Places Autocomplete (Console → APIs & Services → Library → Geocoding API → Enable), then check API key restrictions still allow this server\'s IP / referer.';
    } else if (data.status === 'OVER_QUERY_LIMIT' || data.status === 'OVER_DAILY_LIMIT') {
      msg = 'Geocoding API quota/limit reached — check billing or raise the cap.';
    } else if (data.status === 'INVALID_REQUEST') {
      msg = 'Geocoding API rejected the request — likely empty or malformed params.';
    } else {
      msg = `Google geocode failed: ${data.status}`;
    }
    throw { status: 502, message: msg };
  }
  const first = data.results?.[0];
  if (!first) throw { status: 404, message: 'no geocode results' };
  const loc = first.geometry?.location || {};
  const components = {};
  for (const c of (first.address_components || [])) {
    if (c.types.includes('postal_code'))            components.postal_code = c.long_name;
    if (c.types.includes('locality'))                components.city = c.long_name;
    if (c.types.includes('administrative_area_level_1')) components.state = c.long_name;
    if (c.types.includes('country'))                 components.country = c.long_name;
    if (c.types.includes('route'))                   components.route = c.long_name;
    if (c.types.includes('sublocality_level_1'))     components.sublocality = c.long_name;
  }
  const out = {
    lat: loc.lat ?? null,
    lng: loc.lng ?? null,
    formatted_address: first.formatted_address || '',
    address_components: components,
  };
  cacheSet(cacheKey, out);
  return out;
}

/*
 * getConfigKey() — runtime fallback for the FE's Google Maps JS API key.
 *
 * Next.js bakes NEXT_PUBLIC_* env vars at BUILD time — so a QA deploy
 * that ships without the key in its build env cannot pick it up later
 * from a runtime env change. This lets the FE fetch the key at
 * component mount as a backstop:
 *
 *   - GOOGLE_MAPS_API_KEY_PUBLIC → the browser-safe key
 *   - null                        → FE shows "Map unavailable", the
 *                                   address form still works
 *
 * Why no fallback to GOOGLE_MAPS_API_KEY (server key) anymore
 * (changed 2026-05-28): the server key is intended to be IP-restricted
 * (or App-Restrictions=None + API-allowlist; see the Google referer-
 * trap memory in CLAUDE.md). Either way it is NOT referer-restricted
 * to easyfix.in, so leaking it to a browser bundle would expose a
 * higher-trust credential than necessary. The public key in
 * GOOGLE_MAPS_API_KEY_PUBLIC is the only thing safe to ship to a
 * customer's tab — it should be HTTP-referer-restricted to the
 * easyfix.in domains on the GCP side. If GOOGLE_MAPS_API_KEY_PUBLIC
 * is unset we degrade gracefully (FE hides the map) rather than fall
 * back to a key with broader privileges.
 */
function getConfigKey() {
  return process.env.GOOGLE_MAPS_API_KEY_PUBLIC || null;
}

/*
 * In-process city-name → city_id memo (1h TTL). tbl_city is small (~hundreds of
 * rows) and effectively static, so the lookup is cheap — but the conversational
 * WhatsApp flow can hit it many times per minute, so we cache after the first
 * miss to avoid repeated SELECTs. Case-insensitive key.
 */
const CITY_TTL_MS = 60 * 60 * 1000;
const cityIdCache = new Map(); // name(lc) → { id|null, expires }

async function resolveCityIdByName(cityName, pool) {
  const name = String(cityName || '').trim();
  if (!name || !pool) return null;
  const key = name.toLowerCase();
  const hit = cityIdCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.id;
  try {
    // Tolerant match: exact (case-insensitive) first, then a LIKE fallback so a
    // Google return of "New Delhi" still matches a tbl_city row stored as
    // "New Delhi " or with trailing whitespace etc. Limit 1 keeps it deterministic.
    const [rows] = await pool.query(
      `SELECT city_id FROM tbl_city
        WHERE LOWER(TRIM(city_name)) = ? OR LOWER(TRIM(city_name)) LIKE ?
        ORDER BY (LOWER(TRIM(city_name)) = ?) DESC, city_id ASC
        LIMIT 1`,
      [key, `${key}%`, key],
    );
    const id = rows[0]?.city_id || null;
    cityIdCache.set(key, { id, expires: Date.now() + CITY_TTL_MS });
    return id;
  } catch (e) {
    logger.warn(`resolveCityIdByName failed for "${name}" — ${e && e.message ? e.message : e}`);
    return null;
  }
}

/*
 * reverseGeocode(lat, lng, pool?)
 *
 * Thin wrapper over geocode({ latlng }) for the WhatsApp conversation flow:
 * a customer shares a location pin → we turn it into a usable address.
 * Returns a slim, null-safe shape the caller can write straight onto a job:
 *   { gps_location: "lat,lng", formatted_address, pin_code, city_name, city_id }
 *
 * When a `pool` is supplied, also resolves `city_id` from `tbl_city` by name
 * (case-insensitive + prefix fallback, memoised). Without a pool, city_id is
 * always null — keeps the function pool-free for tests/admin callers.
 *
 * Never throws — geocode's `{status,message}` rejections are swallowed and a
 * gps-only result is returned so a flaky Google call can't break the chat
 * (the raw pin still persists; ops can fill the rest).
 */
async function reverseGeocode(lat, lng, pool = null) {
  const latNum = Number(lat);
  const lngNum = Number(lng);
  const gps_location = (Number.isFinite(latNum) && Number.isFinite(lngNum)) ? `${latNum},${lngNum}` : null;
  const out = { gps_location, formatted_address: null, pin_code: null, city_name: null, city_id: null };
  if (!gps_location) return out;
  try {
    const g = await geocode({ latlng: gps_location });
    out.formatted_address = g.formatted_address || null;
    out.pin_code = g.address_components?.postal_code || null;
    out.city_name = g.address_components?.city || null;
    if (out.city_name && pool) {
      out.city_id = await resolveCityIdByName(out.city_name, pool);
    }
  } catch (e) {
    logger.warn(`reverseGeocode failed for ${gps_location} — ${e && e.message ? e.message : e}; returning gps-only`);
  }
  return out;
}

module.exports = {
  autocomplete,
  geocode,
  reverseGeocode,
  getConfigKey,
};
