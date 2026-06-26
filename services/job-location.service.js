const { pool } = require('../db');

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
  await pool.query(
    `INSERT INTO tbl_job_location_track (job_id, efr_id, latitude, longitude, accuracy, captured_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [jobId, efrId, latitude, longitude, accuracy == null ? null : accuracy],
  );
  return { ok: true };
}

/* Latest known location for a job (CRM "locate now"). Null when no ping yet. */
async function getLatest(jobId) {
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
 * Latest known location for a TECHNICIAN, across whatever job they're on (CRM
 * "Manage Easyfixers" live-location pin). Returns the single most recent ping
 * for the efr — null when the tech has never sent one (GPS off / no active job).
 */
async function getLatestByEfr(efrId) {
  const [[row]] = await pool.query(
    `SELECT id, job_id, efr_id, latitude, longitude, accuracy, captured_at
       FROM tbl_job_location_track
      WHERE efr_id = ?
      ORDER BY captured_at DESC, id DESC
      LIMIT 1`,
    [efrId],
  );
  return row || null;
}

/* Recent breadcrumb trail for a job (CRM map), newest-first, capped at 1000. */
async function getTrack(jobId, { limit } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const [rows] = await pool.query(
    `SELECT id, latitude, longitude, accuracy, captured_at
       FROM tbl_job_location_track
      WHERE job_id = ?
      ORDER BY captured_at DESC, id DESC
      LIMIT ?`,
    [jobId, cap],
  );
  return rows;
}

module.exports = { addPing, getLatest, getLatestByEfr, getTrack };
