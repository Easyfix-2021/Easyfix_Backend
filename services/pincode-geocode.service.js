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

// Max simultaneous Google Geocoding calls per batch. Matches the delivery
// pool in services/job-offer-push.service.js — same reasoning, same order of
// magnitude of third-party fan-out.
const GEOCODE_CONCURRENCY = 8;

function serverApiKey() {
  // Single server-side key, shared with services/maps.service.js.
  return process.env.GOOGLE_MAPS_API_KEY || null;
}

function normalisePin(pin) {
  const s = String(pin ?? '').trim();
  return /^[0-9]{6}$/.test(s) ? s : null;
}

function toNum(v) {
  // NB: Number(null) === 0 and Number('') === 0 (not NaN) — without this guard a
  // SQL-NULL lat/lng read from tbl_pincode would coerce to 0 and be mistaken for a
  // valid cached centroid, so the row would never be treated as a cache-miss and
  // never get geocoded. Treat null/undefined/'' as "absent".
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/*
 * Does tbl_pincode carry the provenance stamp yet?
 * (migrations/2026-08-13-pincode-coords-provenance.sql)
 *
 * Probed ONCE per process and memoised, so this costs one INFORMATION_SCHEMA
 * read at startup rather than a join on every candidate-list render. Cached as
 * a promise, not a value, so N concurrent first-callers share one query.
 *
 * Deliberately fails CLOSED to the old behaviour: if the probe itself errors we
 * report "no column", which trusts existing coordinates exactly as before.
 * Reporting "column present" on a DB blip would treat every row as a cache miss
 * and geocode the whole candidate list on every render, with the persist write
 * failing too — an unbounded Google bill to fix a wrong number. A stale
 * distance is the lesser failure.
 */
let provenanceProbe = null;
async function hasProvenanceColumn() {
  if (provenanceProbe) return provenanceProbe;
  provenanceProbe = (async () => {
    try {
      const [rows] = await pool.query(
        `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'tbl_pincode'
            AND COLUMN_NAME = 'coords_geocoded_at'`,
      );
      const present = Number(rows?.[0]?.n || 0) > 0;
      if (!present) {
        logger.warn(
          'pincode-geocode: tbl_pincode.coords_geocoded_at missing — centroid provenance OFF, '
          + 'legacy (wrong) coordinates still trusted. Apply '
          + 'migrations/2026-08-13-pincode-coords-provenance.sql to enable the fix.',
        );
      }
      return present;
    } catch (e) {
      logger.warn({ err: e.message }, 'pincode-geocode: provenance-column probe failed; assuming absent');
      return false;
    }
  })();
  return provenanceProbe;
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
  logger.info('Resolving pincode centroids · count=' + (Array.isArray(pincodes) ? pincodes.length : 0));
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
  //
  // A ROW IS ONLY A CACHE HIT IF WE GEOCODED IT OURSELVES.
  //
  // The original design read "lat/lng NOT NULL" as "already resolved", because
  // the 2026-06-15 migration that added the columns assumed nothing else ever
  // wrote them. The legacy pincode master import had: 10,889 of 11,024
  // populated rows carry its values, and they are wrong by tens to hundreds of
  // km (413006 by 127 km, 413606 by 339 km — measured 2026-08-13). Trusting
  // "non-NULL" made that permanent, since the lazy backfill only ever filled
  // NULLs and had no way to CORRECT a populated-but-wrong row. Every Schedule
  // & Assign "GPS Distance" off a legacy PIN was wrong, and wrong in a way
  // that silently reorders the candidate list rather than showing an error.
  //
  // No plausibility check can substitute here. Both of those bad coordinates
  // are valid latitudes and longitudes inside India — a bounding box, a range
  // check, a NaN guard all pass them. Only provenance separates a coordinate
  // we resolved from one we inherited.
  const dbHits = new Map(); // pin → {lat,lng}
  const stamped = await hasProvenanceColumn();
  try {
    const placeholders = wanted.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT pincode, lat, lng${stamped ? ', coords_geocoded_at' : ''} FROM tbl_pincode
        WHERE pincode IN (${placeholders})`,
      wanted,
    );
    for (const r of rows) {
      // Pre-migration the stamp doesn't exist, so behaviour is byte-identical
      // to before: trust any populated coordinate. That keeps deploy order
      // free — the fix switches on when the migration lands, not before.
      if (stamped && r.coords_geocoded_at == null) continue;
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
  logger.info('Pincode centroid cache misses · geocoding ' + misses.length);

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

  // Bounded fan-out; each call is independently fail-soft, so a single PIN's
  // failure yields null for that PIN only.
  //
  // This used to be an unbounded Promise.all, which was fine when misses meant
  // "the handful of PINs nobody has geocoded yet". Provenance-gating the cache
  // changes the cold-start shape: until a PIN has been resolved once, EVERY
  // distinct reference pincode in a candidate list is a miss, so a wide list
  // would open one Google connection per technician simultaneously and risk
  // OVER_QUERY_LIMIT — which fails soft to null and would show blank distances
  // instead of wrong ones. Better, but still not the answer. A small pool keeps
  // the warm-up orderly; it only costs latency on the first render per PIN.
  const queue = misses.slice();
  const worker = async () => {
    for (;;) {
      const pin = queue.shift();
      if (pin === undefined) return;
      const centroid = await geocodeOne(pin, apiKey);
      result.set(pin, centroid);
      memCache.set(pin, { value: centroid, expires: Date.now() + MEM_TTL_MS });
      if (centroid) await persistCentroid(pin, centroid);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(GEOCODE_CONCURRENCY, queue.length) }, worker),
  );

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
    // Stamp provenance alongside the value. Writing the coordinate WITHOUT the
    // stamp would re-geocode this PIN on every render forever, so the two
    // writes belong in one statement.
    //
    // `new Date()` (not NOW()): the pool runs at timezone '+05:30', so the
    // driver serialises this as the IST wall-clock time, matching every other
    // DATETIME in this schema.
    const stamped = await hasProvenanceColumn();
    if (stamped) {
      await pool.query(
        'UPDATE tbl_pincode SET lat = ?, lng = ?, coords_geocoded_at = ? WHERE pincode = ?',
        [lat, lng, new Date(), pin],
      );
    } else {
      await pool.query(
        'UPDATE tbl_pincode SET lat = ?, lng = ? WHERE pincode = ?',
        [lat, lng, pin],
      );
    }
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
  logger.info('Geocoding pincode detail · pincode=' + pin);
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
    logger.info('Pincode detail geocoded · pincode=' + pin + ' state=' + (state || '-') + ' city=' + (city || '-'));
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
