/*
 * services/pincode-geocode.service.js
 *
 * Pincode → {lat,lng} centroid resolution + great-circle distance helper.
 * Powers the "Distance" column on the My Orders → Schedule & Assign
 * candidate list (services/candidate-ranking.service.js).
 *
 * Cache-first strategy (NEVER blocks the candidate list on Google):
 *   1. Read tbl_pincode.lat/lng for the requested PIN(s). tbl_pincode is
 *      EasyFix-owned (migrations/2026-05-01-create-tbl-pincode.sql), so
 *      adding nullable lat/lng columns to it is allowed under the shared-DB
 *      carve-out (migrations/2026-06-15-add-tbl-pincode-latlng.sql).
 *   2. On a cache miss, call Google Geocoding server-side with the
 *      SERVER-SIDE (non-referer) key, then write the centroid back onto
 *      tbl_pincode so the next read is a cache hit.
 *   3. If the key is unset OR Google fails, return null. Callers render the
 *      distance as null (km hidden) and fall back to the tier label only.
 *
 * Key handling — referer-trap aware (see CLAUDE.md "Google API key referer
 * trap"): HTTP-referer-restricted keys are browser-only and 403 server-to-
 * server. We therefore use a key with App-Restrictions=None (or IP-pinned).
 *   - process.env.GOOGLE_MAPS_API_KEY → the single server-side key, shared
 *                                       with services/maps.service.js (which
 *                                       hard-requires it). One configured key
 *                                       serves every server-to-Google surface.
 * NEXT_PUBLIC_* / referer-restricted keys are intentionally NOT consulted.
 */

const { pool } = require('../db');
const logger = require('../logger');

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

// In-process memo of resolved centroids (1h TTL). tbl_pincode is the durable
// cache; this just avoids re-hitting the DB within a single candidate-list
// render that references the same PIN across many technicians.
const MEM_TTL_MS = 60 * 60 * 1000;
const memCache = new Map(); // pincode → { value: {lat,lng}|null, expires }

function serverApiKey() {
  // Single server-side key, shared with services/maps.service.js.
  return process.env.GOOGLE_MAPS_API_KEY || null;
}

function normalisePin(pin) {
  const s = String(pin ?? '').trim();
  return /^[0-9]{6}$/.test(s) ? s : null;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/*
 * getCentroids(pincodes) — batch resolver.
 *
 * Returns a Map<pincode(string), {lat,lng} | null>. Geocodes only
 * cache-misses (DB lat/lng NULL AND not in mem cache). Cache hits and
 * non-geocodable PINs are returned as their cached value / null without
 * any Google call. Never throws — every failure path logs a warn and
 * yields null for that PIN so one bad PIN can't blank the whole column.
 */
async function getCentroids(pincodes) {
  const result = new Map();
  const wanted = [];
  const seen = new Set();
  for (const raw of pincodes || []) {
    const pin = normalisePin(raw);
    if (!pin || seen.has(pin)) continue;
    seen.add(pin);
    // Serve from in-process memo when fresh.
    const memo = memCache.get(pin);
    if (memo && memo.expires > Date.now()) {
      result.set(pin, memo.value);
      continue;
    }
    wanted.push(pin);
  }
  if (wanted.length === 0) return result;

  // ── 1. DB cache lookup ───────────────────────────────────────────
  const dbHits = new Map(); // pin → {lat,lng}
  try {
    const placeholders = wanted.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT pincode, lat, lng FROM tbl_pincode
        WHERE pincode IN (${placeholders})`,
      wanted,
    );
    for (const r of rows) {
      const lat = toNum(r.lat);
      const lng = toNum(r.lng);
      if (lat != null && lng != null) dbHits.set(String(r.pincode), { lat, lng });
    }
  } catch (e) {
    // Missing lat/lng columns (pre-migration) or DB blip — degrade to
    // geocoding everything (which may itself be skipped if no key).
    logger.warn({ err: e.message }, 'pincode-geocode: tbl_pincode lat/lng read failed; falling through to Google');
  }

  const misses = [];
  for (const pin of wanted) {
    if (dbHits.has(pin)) {
      const v = dbHits.get(pin);
      result.set(pin, v);
      memCache.set(pin, { value: v, expires: Date.now() + MEM_TTL_MS });
    } else {
      misses.push(pin);
    }
  }
  if (misses.length === 0) return result;

  // ── 2. Google geocode for cache-misses ───────────────────────────
  const apiKey = serverApiKey();
  if (!apiKey) {
    logger.warn(
      { missCount: misses.length },
      'pincode-geocode: GOOGLE_MAPS_API_KEY unset — distance km will be null',
    );
    for (const pin of misses) {
      result.set(pin, null);
      memCache.set(pin, { value: null, expires: Date.now() + MEM_TTL_MS });
    }
    return result;
  }

  // Geocode sequentially-but-non-blocking via Promise.all; each call is
  // independently fail-soft. A single PIN's failure yields null for that
  // PIN only.
  await Promise.all(misses.map(async (pin) => {
    const centroid = await geocodeOne(pin, apiKey);
    result.set(pin, centroid);
    memCache.set(pin, { value: centroid, expires: Date.now() + MEM_TTL_MS });
    if (centroid) await persistCentroid(pin, centroid);
  }));

  return result;
}

/*
 * getCentroid(pincode) — single-PIN convenience wrapper over getCentroids.
 * Returns {lat,lng} or null.
 */
async function getCentroid(pincode) {
  const pin = normalisePin(pincode);
  if (!pin) return null;
  const m = await getCentroids([pin]);
  return m.get(pin) ?? null;
}

// One Google Geocoding call for a single PIN. Returns {lat,lng} | null.
async function geocodeOne(pin, apiKey) {
  try {
    const url = `${GEOCODE_URL}?components=${encodeURIComponent(`postal_code:${pin}|country:IN`)}&key=${apiKey}`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.status !== 'OK') {
      // Don't echo error_message verbatim — it can contain the key on
      // quota errors. Trim hard.
      logger.warn(
        { pin, status: data.status, error_message: String(data.error_message || '').slice(0, 120) },
        'pincode-geocode: Google geocode non-OK',
      );
      return null;
    }
    const loc = data.results?.[0]?.geometry?.location;
    const lat = toNum(loc?.lat);
    const lng = toNum(loc?.lng);
    if (lat == null || lng == null) return null;
    return { lat, lng };
  } catch (e) {
    logger.warn({ pin, err: e.message }, 'pincode-geocode: Google geocode threw');
    return null;
  }
}

/*
 * Write a resolved centroid back onto tbl_pincode. Fail-soft: a write
 * failure (e.g. the PIN row doesn't exist yet, or the lat/lng columns are
 * missing pre-migration) must NOT break the candidate list — we already
 * have the value in-memory for this render.
 */
async function persistCentroid(pin, { lat, lng }) {
  try {
    await pool.query(
      'UPDATE tbl_pincode SET lat = ?, lng = ? WHERE pincode = ?',
      [lat, lng, pin],
    );
  } catch (e) {
    logger.warn({ pin, err: e.message }, 'pincode-geocode: failed to persist centroid to tbl_pincode');
  }
}

// Pull a named component's long_name out of a Google address_components[].
function pickComponent(components, type) {
  const c = (components || []).find((x) => Array.isArray(x.types) && x.types.includes(type));
  return c ? c.long_name : null;
}

/*
 * geocodePincodeDetail(pincode) — for the Manage Pincodes "auto-fetch" flow.
 * Unlike getCentroid (lat/lng only), this ALSO parses address_components to
 * return the Google state / district / city so the FE can map them to our
 * tbl_state / tbl_city (or flag 'New'). Fresh Google call (we need the
 * components, which the lat/lng cache doesn't store), but still memo+persists
 * the centroid. Fail-soft: returns nulls + geocoded:false on any failure.
 * Returns { lat, lng, state, district, city, country, country_code, geocoded }.
 *
 * `country` / `country_code` are surfaced so callers (ensurePincode) can
 * hard-reject non-India results at the service layer. The geocode request URL
 * already pins `|country:IN`, so a well-behaved Google response is India-only —
 * but the explicit country field lets the caller enforce that contract instead
 * of trusting the URL component implicitly.
 */
async function geocodePincodeDetail(pincode) {
  const pin = normalisePin(pincode);
  if (!pin) return null;
  const empty = { lat: null, lng: null, state: null, district: null, city: null, country: null, country_code: null, geocoded: false };
  const apiKey = serverApiKey();
  if (!apiKey) {
    logger.warn('pincode-geocode: GOOGLE_MAPS_API_KEY unset — cannot auto-fetch pincode detail');
    return empty;
  }
  try {
    const url = `${GEOCODE_URL}?components=${encodeURIComponent(`postal_code:${pin}|country:IN`)}&key=${apiKey}`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.status !== 'OK' || !data.results?.length) {
      logger.warn({ pin, status: data.status }, 'pincode-geocode: detail geocode non-OK');
      return empty;
    }
    const res = data.results[0];
    const lat = toNum(res.geometry?.location?.lat);
    const lng = toNum(res.geometry?.location?.lng);
    const comps = res.address_components || [];
    const state = pickComponent(comps, 'administrative_area_level_1');
    const district = pickComponent(comps, 'administrative_area_level_2');
    // City: prefer the most specific place name, falling back to the district.
    const city = pickComponent(comps, 'locality')
      || pickComponent(comps, 'postal_town')
      || pickComponent(comps, 'sublocality_level_1')
      || district;
    // Country long_name ("India") + the ISO short_code ("IN") so callers can
    // reject non-India results regardless of localised long_name spelling.
    const country = pickComponent(comps, 'country');
    const countryComp = (comps || []).find(
      (x) => Array.isArray(x.types) && x.types.includes('country'),
    );
    const country_code = countryComp ? countryComp.short_name : null;
    if (lat != null && lng != null) {
      memCache.set(pin, { value: { lat, lng }, expires: Date.now() + MEM_TTL_MS });
      await persistCentroid(pin, { lat, lng }); // no-op if the pincode row doesn't exist yet
    }
    return { lat, lng, state, district, city, country, country_code, geocoded: true };
  } catch (e) {
    logger.warn({ pin, err: e.message }, 'pincode-geocode: detail geocode threw');
    return empty;
  }
}

/*
 * haversineKm(a, b) — great-circle distance in kilometres between two
 * {lat,lng} points. Returns null when either point is missing/invalid.
 */
function haversineKm(a, b) {
  if (!a || !b) return null;
  const lat1 = toNum(a.lat); const lng1 = toNum(a.lng);
  const lat2 = toNum(b.lat); const lng2 = toNum(b.lng);
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return null;
  const R = 6371; // Earth radius km
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  return R * c;
}

module.exports = {
  getCentroid,
  getCentroids,
  geocodePincodeDetail,
  haversineKm,
};
