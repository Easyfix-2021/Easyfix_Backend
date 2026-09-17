const { pool } = require('../db');
const logger = require('../logger');
const { getProperty } = require('./properties.service');

/*
 * Job location track — the real-time GPS trail a technician's app posts while a
 * job is in progress (Start Job/check-in → completion). Backs the EasyFix CRM
 * live "where is my technician" view.
 *
 * Table tbl_job_location_track is EasyFix-owned
 * (migrations/2026-06-26-create-tbl-job-location-track.sql); job_id / efr_id are
 * LOGICAL references (no FK). The single point-in-time fix at check-in still
 * lives on tbl_job.checkin_gps_location — THIS is the continuous trail.
 */

/*
 * Append one GPS ping for a job. Ownership (the job belongs to efrId) is
 * verified by the caller (routes/mobile/jobs-lifecycle.js via the lifecycle
 * service's getOwnedJob) BEFORE this runs. captured_at = a bound new Date()
 * (IST via the pool) per the platform's "store DATETIME, display IST" convention —
 * the pings are frequent enough that receipt time ≈ fix time for a live map,
 * and not trusting a client timestamp avoids tampering + the IST-parse trap.
 */
async function addPing(jobId, efrId, { latitude, longitude, accuracy, geofence } = {}) {
  logger.info('Add GPS ping · job_id=' + jobId + ' · efr_id=' + efrId + ' · accuracy=' + (accuracy == null ? 'null' : accuracy));
  /*
   * `geofence` is OPTIONAL and additive (2026-09-07).
   *
   * A routine ping omits it and runs the SAME six-column INSERT it always ran —
   * byte-identical SQL, so it cannot start failing on a host where
   * migrations/2026-09-07-reached-location-geofence.sql has not been applied.
   * That mattered: the tech app's background tracker treats a failed ping as a
   * reason to stop, so widening this one statement unconditionally would have
   * killed live-location tracking estate-wide the moment the code deployed
   * ahead of the migration.
   *
   * The arrival row from the reached-location path passes the block, and
   * `within_fence IS NOT NULL` is the free discriminator that tells an arrival
   * apart from the trail without a seventh column.
   */
  const g = geofence || null;
  if (g && await hasGeofenceColumns()) {
    await pool.query(
      `INSERT INTO tbl_job_location_track
         (job_id, efr_id, latitude, longitude, accuracy, captured_at,
          distance_meters, within_fence, override_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        jobId, efrId, latitude, longitude, accuracy == null ? null : accuracy, new Date(),
        g.distanceMeters == null ? null : Number(g.distanceMeters),
        // Tri-state on purpose: NULL = not evaluated (no site coordinates),
        // which is NOT the same as 0 = evaluated and outside. Collapsing the
        // two would put every coordinate-less site into the abuse report.
        g.withinFence == null ? null : (g.withinFence ? 1 : 0),
        g.overrideReason ? String(g.overrideReason).slice(0, 500) : null,
      ],
    );
    return { ok: true };
  }
  if (g) {
    // Migration not applied on this host. Still record WHERE the technician
    // was — losing the position too would be a second failure — and make the
    // dropped evaluation loud rather than silent.
    logger.warn('Geofence columns absent · job_id=' + jobId
      + ' — arrival position recorded, evaluation dropped (apply 2026-09-07-reached-location-geofence.sql)');
  }
  await pool.query(
    `INSERT INTO tbl_job_location_track (job_id, efr_id, latitude, longitude, accuracy, captured_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [jobId, efrId, latitude, longitude, accuracy == null ? null : accuracy, new Date()],
  );
  return { ok: true };
}

/*
 * Do the 2026-09-07 geofence columns exist on this deploy? Same probe pattern
 * as job.service / mobile-job-lifecycle.service: INFORMATION_SCHEMA, memoised
 * on SUCCESS ONLY. A probe that errors is NOT cached — caching a transient
 * failure as `false` would permanently downgrade every arrival on the process
 * to the position-only path (the bug the tx_selfie_id probe already learned).
 */
let _hasGeofenceCols = null;
async function hasGeofenceColumns() {
  if (_hasGeofenceCols !== null) return _hasGeofenceCols;
  try {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'tbl_job_location_track'
          AND COLUMN_NAME IN ('distance_meters', 'within_fence', 'override_reason')`,
    );
    _hasGeofenceCols = Number(rows && rows[0] && rows[0].n) === 3;
    return _hasGeofenceCols;
  } catch (e) {
    logger.warn('Geofence column probe failed · ' + e.message + ' — treating as absent for this call only');
    return false;
  }
}

/* Latest known location for a job (CRM "locate now"). Null when no ping yet. */
async function getLatest(jobId) {
  logger.info('Get latest job location · job_id=' + jobId);
  const [[row]] = await pool.query(
    `SELECT id, job_id, efr_id, latitude, longitude, accuracy, captured_at
       FROM tbl_job_location_track
      WHERE job_id = ?
      ORDER BY captured_at DESC, id DESC
      LIMIT 1`,
    [jobId],
  );
  return row || null;
}

/*
 * `location.current_location` is ONE free-text VARCHAR holding "lat,lng" — not
 * two numeric columns — written by a legacy Java service with no format
 * validation. So parse it defensively and treat anything that isn't exactly two
 * finite numbers as "no fix" rather than letting NaN reach the map: a NaN pin
 * renders nowhere and a half-parsed one ("12.9," → lng 0) renders in the Gulf of
 * Guinea, which is worse than an honest "Location unavailable".
 */
function parseLegacyLatLng(text) {
  const parts = String(text == null ? '' : text).split(',');
  if (parts.length !== 2) return null;
  // Number('') === 0, so an empty half must be rejected before the finite test.
  if (!parts[0].trim() || !parts[1].trim()) return null;
  const latitude = Number(parts[0].trim());
  const longitude = Number(parts[1].trim());
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

/*
 * Latest known location for a TECHNICIAN, across whatever job they're on (CRM
 * "Manage Easyfixers" live-location pin). Null when we have no fix at all.
 *
 * TWO SOURCES, because two apps are live:
 *   1. tbl_job_location_track — the NEW Expo app (POST /mobile/jobs/:id/location).
 *      Richest data: real captured_at, accuracy, the job it belongs to.
 *   2. `location` — the LEGACY Flutter app, which is what essentially every
 *      technician still runs. Written by the two Java services (ACD_APIs and
 *      API_AngularClientDashboard). Reading only (1) is why the popover said
 *      "Location unavailable" for everyone: tbl_job_location_track is empty
 *      while `location` holds ~2.5M rows.
 *
 * ⚠ `location.user_id` IS `tbl_user.user_id` — NOT `efr_id`. Proven by the
 * legacy writer, ACD_APIs AddressServiceImpl:198
 * (`location.setUserId(easyfixer.getUser().getUserId())`). The two id spaces
 * overlap numerically, so reading it as an efr_id silently shows one
 * technician's position under another's name. We therefore resolve through
 * tbl_easyfixer.user_id (the technician's tbl_user FK) and never bind efr_id to
 * location.user_id.
 *
 * Returned shape = the job_track row's columns (so the existing CRM keys keep
 * working) plus:
 *   source     'job_track' | 'legacy'
 *   capturedAt the real timestamp for job_track; NULL for legacy
 *   accuracy   NULL for legacy
 *
 * capturedAt/captured_at stay NULL for legacy ON PURPOSE. Those rows carry no
 * timestamp column at all, so their age is genuinely unknown — stamping NOW()
 * would paint a position that may be six months old as a live one, which is the
 * one failure mode worse than showing nothing.
 */
async function getLatestByEfr(efrId) {
  logger.info('Get latest technician location · efr_id=' + efrId);
  const [[row]] = await pool.query(
    `SELECT id, job_id, efr_id, latitude, longitude, accuracy, captured_at
       FROM tbl_job_location_track
      WHERE efr_id = ?
      ORDER BY captured_at DESC, id DESC
      LIMIT 1`,
    [efrId],
  );
  if (row) return { ...row, source: 'job_track', capturedAt: row.captured_at };

  /*
   * Legacy fallback. `id` is auto-increment, so MAX(id) per user is the newest
   * row — that is the only ordering signal the table has (no timestamp).
   *
   * ⚠ COST PRECONDITION: this needs an index on location.user_id
   * (migrations/2026-08-25-location-dedupe-and-upsert.sql adds
   * UNIQUE KEY uq_location_user and collapses the table to one row per user).
   * Without it MySQL full-scans ~2.5M MyISAM rows on every call, and the CRM
   * popover re-polls this every 15s while open. The join is written as an
   * equality on location.user_id precisely so it becomes an eq_ref lookup the
   * moment that key exists; the ORDER BY then sorts a single row and stays
   * correct for any duplicates left over before the swap.
   */
  const [[legacy]] = await pool.query(
    `SELECT l.id, l.current_location, l.user_id
       FROM tbl_easyfixer e
       JOIN location l ON l.user_id = e.user_id
      WHERE e.efr_id = ?
      ORDER BY l.id DESC
      LIMIT 1`,
    [efrId],
  );
  if (!legacy) return null;

  const coords = parseLegacyLatLng(legacy.current_location);
  if (!coords) {
    logger.info('Legacy location row unparseable · efr_id=' + efrId + ' · id=' + legacy.id);
    return null;
  }

  return {
    id: legacy.id,
    job_id: null,
    efr_id: Number(efrId),
    latitude: coords.latitude,
    longitude: coords.longitude,
    accuracy: null,
    captured_at: null,
    capturedAt: null,
    source: 'legacy',
  };
}

// ─── Geofence (2026-09-07) ───────────────────────────────────────────
/*
 * The site's own coordinates live in tbl_address.gps_location — the GPS
 * varchar holding "lat,lng". It is NOT `address` (the booked address TEXT ops
 * types) and NOT the map-search field; those are different column roles on the
 * same polymorphic row, and only this one is machine-usable. parseLegacyLatLng
 * above is already the estate's defensive reader for that exact format, so the
 * geofence reuses it rather than minting a second parser that would drift.
 */

const DEFAULT_RADIUS_M = 150;

/*
 * Fence radius, ops-tunable via easyfix_properties `geofence.radius.meters`.
 * A missing / unparseable / non-positive value falls back to the default
 * rather than to zero — a 0 m fence would put every technician on earth
 * outside it, which under hard mode is a full field-work outage.
 */
function fenceRadiusMeters() {
  const n = Number(getProperty('geofence.radius.meters'));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RADIUS_M;
}

/*
 * Is hard enforcement on? DEFAULT OFF, and deliberately NOT the estate's usual
 * fail-closed property gate — see the long note in
 * migrations/2026-09-07-reached-location-geofence.sql. Short version: the
 * closed position here denies WORK rather than access, and the properties
 * cache primes EMPTY whenever the table is briefly unreadable, so fail-closed
 * would strand the whole field workforce on a transient DB blip. Only the
 * literal string 'true' turns it on.
 */
function enforcementEnabled() {
  return String(getProperty('geofence.enforcement.enabled') ?? 'false').toLowerCase() === 'true';
}

/*
 * buildGeofence(gpsLocation) → { latitude, longitude, radiusMeters } | null
 *
 * NULL when the site has no usable coordinates. The app's contract is to skip
 * validation entirely on null — a job must never be blocked because ops never
 * captured a pin. "0,0" and other junk parse to null via parseLegacyLatLng.
 */
function buildGeofence(gpsLocation) {
  const site = parseLegacyLatLng(gpsLocation);
  if (!site) return null;
  // (0,0) is in the Gulf of Guinea and is what a half-filled legacy row
  // degrades to. It is never a real Indian service address.
  if (site.latitude === 0 && site.longitude === 0) return null;
  return { latitude: site.latitude, longitude: site.longitude, radiusMeters: fenceRadiusMeters() };
}

/*
 * Great-circle distance in metres (haversine). Chosen over the cheaper
 * equirectangular approximation because it is correct at every distance for
 * the same three lines — the approximation's error grows with separation, and
 * "how far outside the fence was he" is exactly the number ops will act on.
 */
const EARTH_RADIUS_M = 6371008.8;
function distanceMeters(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/*
 * evaluateGeofence(gpsLocation, device) → null | { distanceMeters, withinFence, radiusMeters }
 *
 * null means NOT EVALUATED — no site coordinates, or no device fix. Callers
 * must treat that as "skip", never as "outside": the whole product rule is
 * that missing data never blocks a job start.
 *
 * The distance and the inside/outside verdict are computed HERE, from the raw
 * device coordinates, and the client's own `distanceMeters` / `withinFence`
 * claims are never trusted for the enforcement decision. Hard mode gates on
 * this boolean, and a gate that reads a client-supplied boolean is not a gate.
 */
function evaluateGeofence(gpsLocation, device) {
  const fence = buildGeofence(gpsLocation);
  if (!fence) return null;
  if (!device || !Number.isFinite(Number(device.latitude)) || !Number.isFinite(Number(device.longitude))) return null;
  const d = distanceMeters(fence, {
    latitude: Number(device.latitude), longitude: Number(device.longitude),
  });
  return {
    distanceMeters: Math.round(d * 100) / 100,
    withinFence: d <= fence.radiusMeters,
    radiusMeters: fence.radiusMeters,
  };
}

/* Recent breadcrumb trail for a job (CRM map), newest-first, capped at 1000. */
async function getTrack(jobId, { limit } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  logger.info('Get job location track · job_id=' + jobId + ' · cap=' + cap);
  const [rows] = await pool.query(
    `SELECT id, latitude, longitude, accuracy, captured_at
       FROM tbl_job_location_track
      WHERE job_id = ?
      ORDER BY captured_at DESC, id DESC
      LIMIT ?`,
    [jobId, cap],
  );
  logger.info('Found ' + rows.length + ' location pings');
  return rows;
}

module.exports = {
  addPing, getLatest, getLatestByEfr, getTrack,
  // Geofence (2026-09-07) — pure helpers, no DB. buildGeofence feeds the job
  // detail projection; evaluateGeofence is the reached-location decision.
  buildGeofence, evaluateGeofence, enforcementEnabled, fenceRadiusMeters,
  parseLegacyLatLng, distanceMeters,
};
