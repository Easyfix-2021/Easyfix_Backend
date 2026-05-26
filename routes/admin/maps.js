/*
 * Google Maps proxy endpoints — used by Book New Call's address field
 * for autosuggest + GPS auto-fill.
 *
 * Why proxy: keeps GOOGLE_MAPS_API_KEY server-side (never shipped to
 * the browser bundle), centralises request budgeting + caching, and
 * lets us bolt on per-user rate limits later without touching the
 * client. Frontend hits `/admin/maps/autocomplete?q=…` and
 * `/admin/maps/geocode?address=…` with debounced/keyed requests.
 *
 * Cost-control measures here:
 *   1. Joi rejects queries shorter than 3 chars — Google Places
 *      Autocomplete charges per request regardless of result count;
 *      single-char prefixes return garbage and burn credits.
 *   2. In-memory LRU cache (Map with 200-entry ceiling, 10-min TTL)
 *      dedupes repeat queries from the same operator typing pattern.
 *   3. Country bias to `country:in` so we don't return US/UK
 *      addresses (which are useless to EasyFix and inflate API spend).
 */

const router = require('express').Router();
const Joi = require('joi');
const validate = require('../../middleware/validate');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');

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
 * GET /admin/maps/autocomplete?q=<text>
 *
 * Wraps Google Places Autocomplete. Returns a slim shape so the
 * frontend doesn't depend on Google's full response:
 *   { items: [{ place_id, description, primary, secondary }] }
 *
 * `primary` + `secondary` come from structured_formatting (street name
 * vs. neighbourhood/city). Letting the UI render them as a two-line
 * suggestion is what makes Places feel native.
 */
router.get('/autocomplete', validate(Joi.object({
  q: Joi.string().min(3).max(200).required(),
}), 'query'), async (req, res, next) => {
  try {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) return modernError(res, 503, 'Google Maps not configured (GOOGLE_MAPS_API_KEY missing)');
    const q = String(req.query.q).trim();
    const cacheKey = `ac:${q.toLowerCase()}`;
    const cached = cacheGet(cacheKey);
    if (cached) return modernOk(res, cached);

    const url = `${MAPS_BASE}/place/autocomplete/json?input=${encodeURIComponent(q)}&components=country:in&key=${apiKey}`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      // Don't log the full error_message at info level — it may include
      // the API key on quota errors. Trimmed to a few hundred chars.
      logger.warn({ status: data.status, error_message: String(data.error_message || '').slice(0, 200) }, 'Google autocomplete error');
      return modernError(res, 502, `Google autocomplete failed: ${data.status}`);
    }
    const items = (data.predictions || []).map((p) => ({
      place_id:  p.place_id,
      description: p.description,
      primary:   p.structured_formatting?.main_text || p.description,
      secondary: p.structured_formatting?.secondary_text || '',
    }));
    const out = { items };
    cacheSet(cacheKey, out);
    modernOk(res, out);
  } catch (e) { next(e); }
});

/*
 * GET /admin/maps/geocode?place_id=<id>  OR  ?address=<text>
 *
 * Wraps Google Geocoding. Returns:
 *   { lat, lng, formatted_address, address_components: {...} }
 *
 * `address_components` is a flattened map for convenient access:
 *   { postal_code, city, state, country, route, ... }.
 * Frontend uses it to auto-fill PIN code + city when an autosuggest
 * pick lands. Falls back to a raw `address` text query when the
 * place_id-less variant is needed (e.g. re-geocoding a saved address).
 */
router.get('/geocode', validate(Joi.object({
  place_id: Joi.string().min(5).max(300).optional(),
  address:  Joi.string().min(3).max(500).optional(),
  // Reverse-geocode variant — accepts "lat,lng" (CSV). Used by the
  // draggable map marker on Book New Call / Confirm & Schedule so a
  // pin-drop autopopulates PIN / city / formatted address.
  latlng:   Joi.string().pattern(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/).optional(),
}).or('place_id', 'address', 'latlng'), 'query'), async (req, res, next) => {
  try {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) return modernError(res, 503, 'Google Maps not configured');
    const placeId = req.query.place_id ? String(req.query.place_id) : null;
    const addr    = req.query.address  ? String(req.query.address)  : null;
    const latlng  = req.query.latlng   ? String(req.query.latlng)   : null;
    const cacheKey = `gc:${placeId || addr || latlng || ''}`.toLowerCase();
    const cached = cacheGet(cacheKey);
    if (cached) return modernOk(res, cached);

    const param = placeId
      ? `place_id=${encodeURIComponent(placeId)}`
      : latlng
        ? `latlng=${encodeURIComponent(latlng)}`
        : `address=${encodeURIComponent(addr || '')}&components=country:in`;
    const url = `${MAPS_BASE}/geocode/json?${param}&key=${apiKey}`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.status !== 'OK') {
      logger.warn({ status: data.status, error_message: String(data.error_message || '').slice(0, 200) }, 'Google geocode error');
      return modernError(res, 502, `Google geocode failed: ${data.status}`);
    }
    const first = data.results?.[0];
    if (!first) return modernError(res, 404, 'no geocode results');
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
    modernOk(res, out);
  } catch (e) { next(e); }
});

module.exports = router;
