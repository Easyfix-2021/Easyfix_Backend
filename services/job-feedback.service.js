const { pool } = require('../db');
const logger = require('../logger');

/*
 * Job Feedback — VERIFIED port of legacy `tbl_customer_feedback`.
 *
 * Schema verified 2026-05-12 against EasyFix_CRM source:
 *   - JobDaoImpl.java line 781: SELECT joins feedb.easyfixer_rating,
 *     feedb.easyfix_rating, feedb.happy_with_service
 *   - CustomerFeedback.java model has fields id, happy_with_service,
 *     handymen_rating (=easyfixer_rating JSON alias), easyfix_rating, customer_rating
 *
 * Confirmed legacy columns on tbl_customer_feedback:
 *   id (PK), job_id, easyfixer_rating, easyfix_rating, happy_with_service
 *
 * NOTE: `customer_rating` exists in the legacy model but is sourced from
 * `tbl_easyfixer_rating_by_customer` (a separate table), NOT
 * tbl_customer_feedback. We do NOT write customer_rating here.
 *
 * Earlier iteration 12 wrongly assumed columns `overall_rating`, `feedback_text`,
 * `customer_name` — those DO NOT EXIST on this table. Bug fixed 2026-05-12.
 */

async function getFeedback(jobId) {
  logger.info('Get job feedback · job_id=' + jobId);
  const [[row]] = await pool.query(
    // VERIFIED 2026-05-12 against live INFORMATION_SCHEMA:
    //   tbl_customer_feedback PK is `feedback_id` (not `id`).
    'SELECT feedback_id AS id, job_id, easyfixer_rating, easyfix_rating, happy_with_service FROM tbl_customer_feedback WHERE job_id = ? LIMIT 1',
    [jobId]
  );
  return row || null;
}

async function upsertFeedback(jobId, { easyfixerRating, easyfixRating, happyWithService }, userId = null) {
  logger.info('Upsert job feedback · job_id=' + jobId);
  // feedback_by (tbl_user FK) — who recorded it, as legacy's feedback SP writes.
  // Try update first; if no row, insert. One row per job_id by convention.
  const [existing] = await pool.query(
    'SELECT feedback_id FROM tbl_customer_feedback WHERE job_id = ? LIMIT 1',
    [jobId]
  );
  if (existing.length > 0) {
    await pool.query(
      `UPDATE tbl_customer_feedback
          SET easyfixer_rating   = COALESCE(?, easyfixer_rating),
              easyfix_rating     = COALESCE(?, easyfix_rating),
              happy_with_service = COALESCE(?, happy_with_service),
              feedback_by        = COALESCE(?, feedback_by)
        WHERE job_id = ?`,
      [easyfixerRating ?? null, easyfixRating ?? null, happyWithService ?? null, userId, jobId]
    );
  } else {
    await pool.query(
      `INSERT INTO tbl_customer_feedback (job_id, easyfixer_rating, easyfix_rating, happy_with_service, feedback_by)
       VALUES (?, ?, ?, ?, ?)`,
      [jobId, easyfixerRating ?? null, easyfixRating ?? null, happyWithService ?? null, userId]
    );
  }
  logger.info('Feedback ' + (existing.length > 0 ? 'updated' : 'created') + ' · job_id=' + jobId);
  return getFeedback(jobId);
}

/*
 * The technician half of legacy's sp_ef_job_save_feedback_job: one
 * tbl_easyfixer_rating_by_customer row carrying the easyfixer rating, which is
 * what computeRating / grade / candidate-ranking average. Called once, when a
 * CRM user moves the job into 5 (setStatus) — a later feedback edit updates
 * tbl_customer_feedback only, so the average never counts a job twice.
 * insert_date_time on the app clock: the 90-day window reads it (see
 * mobile-performance.service.js computeRating).
 */
async function recordTechnicianRating(jobId) {
  const [res] = await pool.query(
    `INSERT INTO tbl_easyfixer_rating_by_customer (easyfixer_id, job_id, customer_rating, insert_date_time)
     SELECT j.fk_easyfixter_id, j.job_id, f.easyfixer_rating, ?
       FROM tbl_job j
       JOIN tbl_customer_feedback f ON f.job_id = j.job_id
      WHERE j.job_id = ? AND j.fk_easyfixter_id IS NOT NULL AND f.easyfixer_rating IS NOT NULL
      LIMIT 1`,
    [new Date(), jobId]
  );
  logger.info('Technician rating recorded · job_id=' + jobId + ' · rows=' + (res?.affectedRows ?? 0));
}

module.exports = { getFeedback, upsertFeedback, recordTechnicianRating };
