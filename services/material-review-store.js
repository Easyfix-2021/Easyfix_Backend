/*
 * tbl_job_material_review — one row per job (job_id PRIMARY KEY), holding
 * state that has no room on tbl_job (row-size ceiling — see
 * migrations/2026-09-18-pending-for-material.sql's header). Two independent
 * pieces of state share the table; this file owns only the second:
 *
 *   reject_reason / reviewed_by / reviewed_at — the PM's Material Review
 *     reject reason (sub-project D), written by services/job.service.js
 *     setStatus's `material_reject_reason` extras key.
 *
 *   pre_material_status — the status (1 SCHEDULED / 2 IN_PROGRESS /
 *     20 IN_PROGRESS_ALT) a job left when it FIRST entered 16 or 15 from a
 *     non-request status. "Return to pre-status" (a technician deleting the
 *     last sent line, or a CRM Reject Request) means this value, defaulting
 *     to 2 when unset. See
 *     docs/superpowers/specs/2026-09-21-material-request-flow-v2-design.md
 *     ("Pre-request status").
 *
 * Both services/job.service.js's setStatus (the CRM add-line → 15 path, and
 * the Reject Request → pre-status path) AND
 * services/mobile-job-estimate.service.js (the tech send-for-approval → 16
 * path, which cannot import job.service.js — see that file's header) write or
 * read pre_material_status, so the pair lives here rather than duplicated in
 * either.
 *
 * Independent INSERT .. ON DUPLICATE KEY UPDATE that names ONLY this column,
 * so a write here never disturbs reject_reason/reviewed_by/reviewed_at (or
 * vice versa) — the two pieces of state are updated by different callers at
 * different times and must not clobber each other.
 */
const { pool } = require('../db');

const DEFAULT_PRE_MATERIAL_STATUS = 2;

async function getPreMaterialStatus(jobId, conn = pool) {
  const [[row]] = await conn.query(
    'SELECT pre_material_status FROM tbl_job_material_review WHERE job_id = ? LIMIT 1',
    [jobId],
  );
  const value = row ? Number(row.pre_material_status) : NaN;
  return Number.isFinite(value) ? value : DEFAULT_PRE_MATERIAL_STATUS;
}

async function storePreMaterialStatus(jobId, status, conn = pool) {
  await conn.query(
    `INSERT INTO tbl_job_material_review (job_id, pre_material_status)
          VALUES (?, ?)
     ON DUPLICATE KEY UPDATE pre_material_status = VALUES(pre_material_status)`,
    [jobId, status],
  );
}

module.exports = { getPreMaterialStatus, storePreMaterialStatus, DEFAULT_PRE_MATERIAL_STATUS };
