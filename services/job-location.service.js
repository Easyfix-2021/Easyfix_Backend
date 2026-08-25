const { pool } = require('../db');
const logger = require('../logger');

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
 * service's getOwnedJob) BEFORE this runs. captured_at = server NOW()
 * (Asia/Kolkata) per the platform's "store DATETIME, display IST" convention —
 * the pings are frequent enough that receipt time ≈ fix time for a live map,
 * and not trusting a client timestamp avoids tampering + the IST-parse trap.
 */
async function addPing(jobId, efrId, { latitude, longitude, accuracy }) {
  logger.info('Add GPS ping · job_id=' + jobId + ' · efr_id=' + efrId + ' · accuracy=' + (accuracy == null ? 'null' : accuracy));
  await pool.query(
    `INSERT INTO tbl_job_location_track (job_id, efr_id, latitude, longitude, accuracy, captured_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [jobId, efrId, latitude, longitude, accuracy == null ? null : accuracy],
  );
  return { ok: true };
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

module.exports = { addPing, getLatest, getLatestByEfr, getTrack };
