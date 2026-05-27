const { pool } = require('../db');

/*
 * Job Comments — VERIFIED port of legacy `tbl_job_comment`.
 *
 * Schema verified 2026-05-12 against EasyFix_CRM:
 *   - JobDaoImpl.java:3145 INSERT columns:
 *       job_id, comments, comment_on, appointment_on, commented_by,
 *       enum_reason_id, efr_id
 *   - JobDaoImpl.java:3164 SELECT joins:
 *       C.commented_by = U.user_id, C.enum_reason_id = e.enum_id
 *     and reads `created_on` (NOT `insert_date`).
 *
 * `comment_on` is a stage flag (legacy convention):
 *   1 = at creation, 2 = at check-in, 3 = at check-out
 *   (we keep 4 = in_progress as a new-app addition; legacy never used it
 *    but the column accepts any int.)
 *
 * NOTE: Earlier iteration 3 wrongly assumed `user_id` and `insert_date`
 * columns — those DO NOT EXIST. The legacy table uses `commented_by`
 * (FK to tbl_user.user_id) and `created_on`. Bug fixed 2026-05-12.
 */

/*
 * comment_on legacy enum — verified 2026-05-26 against EasyFix_CRM
 * JobAction.java + JobDaoImpl.java + tbl_job_comment dumps:
 *   1  = created / schedule / approval-related (legacy default for
 *        new bookings, approval comments, reschedule timestamps)
 *   2  = check_in
 *   3  = check_out
 *   4  = in_progress (new-app addition; legacy never wrote this)
 *  16  = call_later  (Unreachable outcome — Confirm & Schedule popup)
 *  17  = enquiry     (Enquiry outcome — Confirm & Schedule popup)
 */
const STAGES = Object.freeze({
  1: 'created',
  2: 'check_in',
  3: 'check_out',
  4: 'in_progress',
  16: 'call_later',
  17: 'enquiry',
});

function shapeRow(r) {
  return {
    id: r.id,
    job_id: r.job_id,
    comments: r.comments,
    comment_on: r.comment_on,
    stage: STAGES[r.comment_on] ?? 'unknown',
    created_on: r.created_on,
    appointment_on: r.appointment_on,
    commented_by: r.commented_by,
    user_name: r.user_name,
    efr_id: r.efr_id,
    enum_reason_id: r.enum_reason_id,
    enum_desc: r.enum_desc,
  };
}

async function listComments(jobId) {
  const [rows] = await pool.query(
    `SELECT c.comment_id AS id, c.job_id, c.comments, c.comment_on, c.created_on,
            c.appointment_on, c.commented_by, c.enum_reason_id, c.efr_id,
            u.user_name, e.enum_desc
       FROM tbl_job_comment c
       LEFT JOIN tbl_user u ON u.user_id = c.commented_by
       LEFT JOIN tbl_enum_reason e ON e.enum_id = c.enum_reason_id
      WHERE c.job_id = ?
      ORDER BY c.created_on ASC, c.comment_id ASC`,
    [jobId]
  );
  return rows.map(shapeRow);
}

// Column-probe for the optional `job_stage` column on tbl_job_comment
// (legacy deploys may not have it). Cached after first hit.
let _jobStageColumnExists = null;
async function hasJobStageColumn() {
  if (_jobStageColumnExists != null) return _jobStageColumnExists;
  try {
    const [rows] = await pool.query(
      `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'tbl_job_comment'
          AND COLUMN_NAME  = 'job_stage'
        LIMIT 1`,
    );
    _jobStageColumnExists = rows.length > 0;
  } catch {
    _jobStageColumnExists = false;
  }
  return _jobStageColumnExists;
}

async function addComment(jobId, { comments, comment_on, commented_by, appointment_on, enum_reason_id, efr_id, job_stage }) {
  const text = String(comments || '').trim();
  if (!text) {
    const e = new Error('comment text is required');
    e.status = 400;
    throw e;
  }
  const stage = Number(comment_on);
  if (!STAGES[stage]) {
    const e = new Error('comment_on must be one of: 1 (created/schedule), 2 (check_in), 3 (check_out), 4 (in_progress), 16 (call_later), 17 (enquiry)');
    e.status = 400;
    throw e;
  }
  // Conditionally include job_stage on deploys that carry the column.
  // The base INSERT shape always writes the seven legacy columns; the
  // optional job_stage is appended only when present so older DBs
  // don't break with "Unknown column".
  const withJobStage = await hasJobStageColumn();
  let insertSql;
  let insertVals;
  if (withJobStage) {
    insertSql = `INSERT INTO tbl_job_comment
        (job_id, comments, comment_on, appointment_on, commented_by, enum_reason_id, efr_id, job_stage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    insertVals = [
      jobId, text, stage,
      appointment_on || null,
      commented_by || null,
      enum_reason_id || null,
      efr_id || null,
      job_stage || null,
    ];
  } else {
    insertSql = `INSERT INTO tbl_job_comment
        (job_id, comments, comment_on, appointment_on, commented_by, enum_reason_id, efr_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`;
    insertVals = [
      jobId, text, stage,
      appointment_on || null,
      commented_by || null,
      enum_reason_id || null,
      efr_id || null,
    ];
  }
  const [r] = await pool.query(insertSql, insertVals);
  const [[row]] = await pool.query(
    `SELECT c.comment_id AS id, c.job_id, c.comments, c.comment_on, c.created_on,
            c.appointment_on, c.commented_by, c.enum_reason_id, c.efr_id,
            u.user_name, e.enum_desc
       FROM tbl_job_comment c
       LEFT JOIN tbl_user u ON u.user_id = c.commented_by
       LEFT JOIN tbl_enum_reason e ON e.enum_id = c.enum_reason_id
      WHERE c.comment_id = ? LIMIT 1`,
    [r.insertId]
  );
  return shapeRow(row);
}

module.exports = { listComments, addComment, STAGES };
