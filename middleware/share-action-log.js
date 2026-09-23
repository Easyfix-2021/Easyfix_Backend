const { pool } = require('../db');
const logger = require('../logger');

/*
 * ─── WHO ACTUALLY DID IT, ON A SHARED JOB ────────────────────────────
 *
 * A delegated job stays assigned to the SHARER, and the delegation lock makes
 * every delegate write run under his identity (require-tech-lifecycle-
 * capability.js) — so the job's own rows say the sharer checked in, uploaded
 * the selfie, closed the job. This middleware writes the REAL actor of each
 * mutating request to tbl_job_share_action_log
 * (migrations/2026-09-21-job-share-action-log.sql):
 *
 *   · a web-link contact (req.shareGuest)      → actor_type 'contact' + number/name
 *   · a technician delegate (req.tech.actual_efr_id) → actor_type 'delegate' + efr_id
 *
 * Mounted after the lock, which is what sets req.jobShare. Written on the
 * response's `finish`, with the status code, so a refused or failed attempt is
 * on record too. BEST-EFFORT: the action has already happened; a missing table
 * (migration not yet run) or a failed insert is logged and dropped.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/* '/jobs/5001/material-request' → 'material-request'; '/uploads/document' → 'upload-document'. */
function actionName(path) {
  const p = String(path || '');
  const upload = /^\/uploads(?:\/(document))?\/?$/.exec(p);
  if (upload) return upload[1] ? 'upload-document' : 'upload';
  const job = /^\/jobs\/\d+(?:\/(.*))?$/.exec(p);
  if (!job) return p.slice(0, 64) || 'unknown';
  return (job[1] || 'job').replace(/\/+$/, '').replace(/\/\d+(?=\/|$)/g, '').slice(0, 64) || 'job';
}

/* The row to write for this request, or null when it is not a delegate's write. */
function actionRow(req, statusCode, now = new Date()) {
  if (SAFE_METHODS.has(String(req.method || '').toUpperCase())) return null;
  const guest = req.shareGuest;
  const delegateEfrId = req.tech && req.tech.actual_efr_id;
  const share = req.jobShare || (guest && guest.share);
  if (!share || (!guest && delegateEfrId == null)) return null;
  const path = String(req.path || req.originalUrl || '').slice(0, 255);
  return {
    share_id: Number(share.share_id),
    job_id: Number(share.job_id),
    actor_type: guest ? 'contact' : 'delegate',
    actor_efr_id: guest ? null : Number(delegateEfrId),
    actor_number: guest ? (guest.contactNumber || null) : null,
    actor_name: guest ? (guest.contactName || null) : null,
    action: actionName(path),
    method: String(req.method).toUpperCase().slice(0, 8),
    path,
    status_code: Number(statusCode) || 0,
    created_on: now,
  };
}

const COLUMNS = ['share_id', 'job_id', 'actor_type', 'actor_efr_id', 'actor_number', 'actor_name',
  'action', 'method', 'path', 'status_code', 'created_on'];

async function writeRow(row, db = pool) {
  try {
    await db.query(
      `INSERT INTO tbl_job_share_action_log (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`,
      COLUMNS.map((c) => row[c]),
    );
  } catch (e) {
    logger.warn(`Share action log write failed · shareId=${row.share_id} · ${row.action} · ${e.message}`);
  }
}

function shareActionLog(req, res, next) {
  // Built NOW, not on `finish`: a sub-router trims req.path/req.url while it
  // handles the request ('/jobs/5001/checkin' → '/5001/checkin'), and a
  // terminating handler leaves it trimmed when the response finishes.
  const row = actionRow(req, 0);
  if (!row) return next();
  res.on('finish', () => {
    row.status_code = Number(res.statusCode) || 0;
    void writeRow(row);
  });
  return next();
}

module.exports = { shareActionLog, actionRow, actionName, writeRow };
