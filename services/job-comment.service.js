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
      ORDER BY c.created_on DESC, c.comment_id DESC`,
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

/*
 * Column-probe factory for tbl_job columns the comment-mirror needs.
 * Each probe is cached in its own module-level slot after the first hit
 * — INFORMATION_SCHEMA.COLUMNS is cheap but a hot-path query path
 * shouldn't repeat it once we know the answer. All four follow the same
 * "soft-fail to false on error so legacy deploys don't break" rule.
 *
 *   remarks_date_time   — timestamp paired with the remarks mirror
 *   call_later          — boolean-ish flag stamped when an Unreachable
 *                          (comment_on=16) lands. Set elsewhere by
 *                          setStatus → CALL_LATER; we ALSO stamp it
 *                          here per legacy parity so callers that hit
 *                          /comments without a status PATCH (rare but
 *                          possible) still mark the row.
 *   enum_reason_id      — generic reason FK the legacy CRM stamped on
 *                          tbl_job in addition to the status-specific
 *                          enquiry_reason_id / cancel_reason_id. Only
 *                          stamped when the caller actually sends a
 *                          reason — never overwritten with NULL.
 */
const _colCache = {};
async function hasJobColumn(colName) {
  if (_colCache[colName] != null) return _colCache[colName];
  try {
    const [rows] = await pool.query(
      `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'tbl_job'
          AND COLUMN_NAME  = ?
        LIMIT 1`,
      [colName],
    );
    _colCache[colName] = rows.length > 0;
  } catch {
    _colCache[colName] = false;
  }
  return _colCache[colName];
}

// Back-compat: keep the original named helper used in addComment.
function hasRemarksDateTimeColumn() { return hasJobColumn('remarks_date_time'); }

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

  /*
   * Mirror the latest comment into tbl_job for legacy parity (added
   * 2026-05-28). The legacy CRM kept the most-recent narrative on
   * tbl_job.remarks + tbl_job.remarks_date_time so reports/exports
   * reading off the job row directly saw the freshest context. The
   * Node port had been INSERTing into tbl_job_comment only — fine for
   * the History tab but a gap for every other consumer.
   *
   * Column-probed so deploys without remarks_date_time degrade
   * gracefully (just skip the timestamp, still write remarks).
   *
   * Intentionally does NOT touch tbl_job.last_update_time — that
   * column is reserved for STRUCTURAL edits so the "Draft" pill on
   * the Unconfirmed jobs list stays accurate. remarks_date_time is
   * the comment-specific timestamp.
   *
   * For outcome comments (16=call_later, 17=enquiry) the
   * accompanying setStatus call already stamps the status-specific
   * companion columns (call_later=1 / enquiry_reason_id etc.) so we
   * don't double-write here — only mirror the narrative.
   */
  try {
    // Always mirror the comment text itself.
    const sets = ['remarks = ?'];
    const vals = [text];

    // remarks_date_time — when the column exists. Uses NOW() inline so
    // no extra value slot is consumed.
    if (await hasJobColumn('remarks_date_time')) {
      sets.push('remarks_date_time = NOW()');
    }

    // call_later — stamp the flag whenever the Unreachable comment
    // code (16) lands, IF the column exists on this deploy. setStatus
    // also sets this on the 9 transition; doing it here too is
    // idempotent (always 1) and protects against future call sites
    // that hit /comments without a paired status PATCH.
    if (stage === 16 && await hasJobColumn('call_later')) {
      sets.push('call_later = 1');
    }

    // enum_reason_id — generic reason FK the legacy CRM mirrored on
    // tbl_job in parallel with the status-specific enquiry_reason_id /
    // cancel_reason_id columns. We only stamp when the caller actually
    // sent a reason — never blindly NULL-out a previously-set value on
    // a comment that doesn't carry one.
    if (enum_reason_id != null && await hasJobColumn('enum_reason_id')) {
      sets.push('enum_reason_id = ?');
      vals.push(Number(enum_reason_id));
    }

    vals.push(jobId);
    await pool.query(
      `UPDATE tbl_job SET ${sets.join(', ')} WHERE job_id = ?`,
      vals,
    );
  } catch (mirrorErr) {
    // Soft-fail — the comment row landed successfully; the tbl_job
    // mirror is a convenience, not a correctness gate. Log + continue.
    require('../logger').warn(
      { err: mirrorErr.message, jobId, commentId: r?.insertId },
      'tbl_job.remarks mirror failed (comment still recorded)',
    );
  }

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
