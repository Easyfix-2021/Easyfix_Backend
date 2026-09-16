/*
 * ═══════════ INTERNAL JOB NOTES — tbl_job_notes ═══════════
 *
 * The legacy Java CRM's free-text ops notepad, re-opened for the new stack.
 * READ AND ADD ONLY: no edit, no delete (the owner's call, 2026-09-16), which
 * is also the only contract the table can honestly support — it has no
 * updated_at, no status, no soft-delete and no author id to check an edit
 * against. A note is a permanent line in a log, not a document.
 *
 * ─── THIS IS NOT tbl_job_comment, AND THE DIFFERENCE IS THE POINT ──────────
 *
 * tbl_job_comment is the AUDITED lifecycle trail: every row is produced by an
 * action (a status change, a reschedule, an Add Remarks submit), carries the
 * reason FK that action chose, and is mirrored onto tbl_job.remarks. This table
 * is the opposite — an operator writing a note to the next operator. Nothing
 * fires off it, nothing reads it back into a workflow, and it has no reason
 * code. Folding one into the other would either pollute the audit trail with
 * chatter or force a reason code onto a sentence that has none.
 *
 * ─── WHAT THE LEGACY WRITER LEFT US, AND WHY WE MATCH IT EXACTLY ───────────
 *
 * Measured on QA 2026-09-16: 3,303 rows, 3,013 distinct jobs, 68 distinct
 * authors, written 2024-01-25 → 2026-04-29 — the date writes stop is the
 * legacy-CRM cutover, which is how we know who wrote them.
 *
 *   note_created_by   a DISPLAY NAME, not a user id. 3,303 of 3,303 rows are
 *                     non-numeric; zero are emails; the strings match
 *                     tbl_user.user_name. So this writes req.user.user_name.
 *                     It is lossy — two people can share a name, and a rename
 *                     orphans the attribution — but writing an id into a column
 *                     whose 3,303 existing rows hold names would make the
 *                     column mean two things, and every reader would have to
 *                     guess which. Matching the convention beats improving it
 *                     in a column we do not own.
 *   job_stage         a LABEL, not a status code: "Pending for scheduling",
 *                     "Pending to start", "Audit & complete", … Every one of
 *                     the 8 distinct values present is an output of
 *                     job-export.service.js's homeJobStatus, which is the
 *                     legacy CRM's own bucket-naming function ported into this
 *                     repo — so that is what stamps it here. No row is empty,
 *                     and none carries a spelling homeJobStatus cannot produce.
 *   note_created_on   plain DATETIME, server time, no default.
 *
 * ⚠ THE STAGE IS A SNAPSHOT, deliberately. It records where the job SAT when
 * the note was written, which is most of why an old note is still readable
 * months later ("Pending for scheduling: waiting on client approval" means
 * something; the same line without the bucket does not). It must never be
 * recomputed from the job's CURRENT status on read.
 */
const { pool } = require('../db');
const logger = require('../logger');

/*
 * The bucket label, from the ONE function that already produces this exact
 * vocabulary for the jobs list, the XLSX export and these rows' legacy writer.
 * Required lazily: job-export.service requires job.service which requires
 * nothing from here, but keeping the require local matches how job.service
 * itself reaches that module and keeps this file loadable in isolation.
 *
 * homeJobStatus returns '' for a status it has no bucket for. Every value in
 * STATUS is mapped, so that is unreachable for a real job — and '' is what the
 * legacy writer would itself have stored, so it is what we store rather than
 * inventing a ninth spelling for "unknown". NOT NULL column; '' satisfies it.
 */
function stageLabelFor(job) {
  try {
    const { homeJobStatus } = require('./job-export.service');
    return homeJobStatus(Number(job.job_status), job.fk_easyfixter_id, job.sub_job_id) || '';
  } catch (e) {
    // A label is context, not the note. Losing it must not cost the operator
    // the line they just typed — the same fail-soft rule the jobs list applies
    // to these very labels.
    logger.warn('Job note stage label derivation failed (stored blank) · ' + ((e && e.message) || e));
    return '';
  }
}

/*
 * One job's notes, newest first.
 *
 * ORDER BY note_created_on DESC, id DESC — id alone would be wrong the moment a
 * backfill or an import lands out of order, and note_created_on alone ties on
 * the two rows a fast operator writes in the same second. Same
 * belt-and-braces ordering job-comment.service.js uses for the comment thread,
 * and for the same reason.
 *
 * NO PAGINATION, deliberately: the measured maximum is a handful of notes per
 * job (3,303 rows over 3,013 jobs), and the read is now index-served by
 * migrations/2026-09-16-index-job-notes-job-id.sql. If a job ever accumulates
 * hundreds, add LIMIT/OFFSET here rather than trimming in the browser.
 */
async function listNotes(jobId) {
  logger.info('List job notes · jobId=' + jobId);
  const [rows] = await pool.query(
    `SELECT id, notes, job_stage, note_created_on, note_created_by
       FROM tbl_job_notes
      WHERE job_id = ?
      ORDER BY note_created_on DESC, id DESC`,
    [jobId],
  );
  logger.info('Found ' + rows.length + ' job notes · jobId=' + jobId);
  return rows;
}

/*
 * Add one note. `job` is the row the route already loaded (req.scopedJob), so
 * the stage snapshot costs no extra query; `actor` is req.user.
 *
 * new Date() rather than SQL NOW(): the pool runs at +05:30, so this is the IST
 * wall clock the rest of tbl_job's datetimes are written in. NOW() would be the
 * server's, and a notes column that disagrees with the job's own timestamps is
 * a support call nobody can resolve.
 *
 * The author NAME is resolved from the actor, never taken from the request: a
 * body-supplied author is an attribution anyone can forge, and this table has
 * no id column to cross-check it against.
 */
async function addNote(jobId, { notes }, job, actor) {
  const text = String(notes ?? '').trim();
  if (!text) {
    const e = new Error('notes is required');
    e.status = 400;
    throw e;
  }
  const jobStage = stageLabelFor(job || {});
  /*
   * A missing display name stores '' rather than 'Unknown' or a user id —
   * consistent with the column's contract (a name, or nothing to show). It
   * cannot happen for an admin bearer, which carries the tbl_user row, but the
   * column is nullable and a null author renders as a blank byline either way.
   */
  const author = String(actor?.user_name ?? '').trim();
  const createdOn = new Date();
  logger.info('Add job note · jobId=' + jobId + ' stage="' + jobStage + '" chars=' + text.length);
  const [r] = await pool.query(
    `INSERT INTO tbl_job_notes (job_id, notes, job_stage, note_created_on, note_created_by)
     VALUES (?, ?, ?, ?, ?)`,
    [jobId, text, jobStage, createdOn, author],
  );
  logger.info('Job note created · id=' + r.insertId + ' · jobId=' + jobId);
  return {
    id: r.insertId,
    notes: text,
    job_stage: jobStage,
    note_created_on: createdOn,
    note_created_by: author,
  };
}

module.exports = { listNotes, addNote, stageLabelFor };
