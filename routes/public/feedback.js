/*
 * /api/public/feedback/* — customer-facing feedback flow.
 *
 * Ported from the legacy Angular customer-feedback.component +
 * customer-feedback.service. The customer hits this from an SMS /
 * WhatsApp / email link AFTER the technician closes the visit, picks
 * a rating, and submits.
 *
 * Security posture:
 *   - NO admin / SPOC auth. Customers don't have accounts.
 *   - This is rate-limited per-IP at the router mount so a single
 *     attacker can't pound the endpoint.
 *   - The submit only INSERTs / UPDATEs the rating row tied to the
 *     specific jobId in the URL — no privilege escalation surface.
 *
 * Endpoints:
 *   GET  /api/public/feedback/:jobId   — basic job + tech info for the page
 *   POST /api/public/feedback/:jobId   — submit the rating
 *
 * Future hardening (TODO when ops ask): mint a magic-link JWT at job-
 * complete time and require it on both endpoints, same pattern as
 * /api/public/job-completion. Until then, anyone with the jobId can
 * read + submit — acceptable for the typical SMS-link customer flow
 * where the jobId is the "secret".
 */

const router = require('express').Router();
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');

/*
 * GET /api/public/feedback/:jobId
 *
 * Returns the bits the rating page renders:
 *   - jobId, jobOrderId, jobStatus
 *   - customer name (so we can greet them)
 *   - easyfixer (technician) id, name, photo
 *   - service category name
 *   - client name + vertical (so "Powered by ABC Brand" works)
 *   - alreadyRated flag — if a rating row already exists with
 *     review_comment populated, the FE redirects to the "already
 *     submitted" page (matches legacy ratingExpired flow).
 */
router.get('/:jobId', async (req, res, next) => {
  try {
    const jobId = Number(req.params.jobId);
    if (!Number.isInteger(jobId) || jobId <= 0) {
      return modernError(res, 400, 'invalid jobId');
    }
    // Project only columns verified to exist on prod (see
    // docs/claude-reference/SCHEMA.md). efr_image / efr_photo were
    // initially added but neither exists — kept the avatar as an
    // initials tile on the FE, no photo URL is sent down.
    const [[row]] = await pool.query(
      `SELECT j.job_id, j.job_status, j.fk_customer_id, j.fk_easyfixter_id,
              j.fk_service_catg_id,
              cu.customer_name, cu.customer_mob_no,
              ef.efr_name AS easyfixer_name,
              sc.service_catg_name,
              cl.client_id, cl.client_name
         FROM tbl_job j
         LEFT JOIN tbl_customer    cu ON cu.customer_id     = j.fk_customer_id
         LEFT JOIN tbl_easyfixer   ef ON ef.efr_id          = j.fk_easyfixter_id
         LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = j.fk_service_catg_id
         LEFT JOIN tbl_client      cl ON cl.client_id       = j.fk_client_id
        WHERE j.job_id = ? LIMIT 1`,
      [jobId]
    );
    if (!row) return modernError(res, 404, 'job not found');

    // alreadyRated — look up the canonical rating row for this job.
    // Legacy logic: if reviewComments is set (i.e. a real rating exists),
    // the page should redirect to "already submitted". no_of_escalations
    // > 0 or escalated_time isn't a rating signal — those are escalations.
    const [[rated]] = await pool.query(
      `SELECT table_id, customer_rating, review_comment, comment
         FROM tbl_easyfixer_rating_by_customer
        WHERE job_id = ?
        ORDER BY table_id DESC LIMIT 1`,
      [jobId]
    );
    const alreadyRated = !!(rated && (rated.review_comment || rated.comment));

    modernOk(res, {
      job_id:           row.job_id,
      job_status:       row.job_status,
      customer_name:    row.customer_name,
      easyfixer_id:     row.fk_easyfixter_id,
      easyfixer_name:   row.easyfixer_name,
      easyfixer_image:  null, // no photo column on this DB; FE falls back to initials
      service_category: row.service_catg_name,
      client_name:      row.client_name,
      already_rated:    alreadyRated,
      existing_rating:  rated?.customer_rating ?? null,
    });
  } catch (e) { next(e); }
});

/*
 * POST /api/public/feedback/:jobId
 * body: { rating: 1..5, comments: string, reviewComments: string }
 *
 * Stores the rating in tbl_easyfixer_rating_by_customer. Mirrors the
 * legacy /create endpoint's contract:
 *   { jobId, easyfixerId, customerRating, comments, reviewComments }
 * but jobId comes from the URL (not the body) so a client can't post
 * to a different job than they're viewing.
 *
 * Idempotency: if a row already exists for this job_id (either an
 * earlier rating or a SPOC-side escalation), we UPDATE it. Otherwise
 * INSERT a fresh row. Either way, only one row per job_id ends up
 * with the rating data.
 */
router.post('/:jobId', async (req, res, next) => {
  try {
    const jobId = Number(req.params.jobId);
    if (!Number.isInteger(jobId) || jobId <= 0) {
      return modernError(res, 400, 'invalid jobId');
    }
    const { rating, comments, reviewComments } = req.body || {};
    const r = Number(rating);
    if (!Number.isInteger(r) || r < 1 || r > 5) {
      return modernError(res, 400, 'rating must be 1..5');
    }
    const reviewText = String(reviewComments || '').slice(0, 1000).trim();
    const commentText = String(comments || '').slice(0, 2000).trim();

    // Resolve easyfixer_id from the job — we never trust an
    // easyfixerId sent from the customer's browser.
    const [[job]] = await pool.query(
      'SELECT job_id, fk_easyfixter_id FROM tbl_job WHERE job_id = ? LIMIT 1',
      [jobId]
    );
    if (!job) return modernError(res, 404, 'job not found');
    const easyfixerId = job.fk_easyfixter_id || null;

    const [[existing]] = await pool.query(
      'SELECT table_id FROM tbl_easyfixer_rating_by_customer WHERE job_id = ? LIMIT 1',
      [jobId]
    );

    // Only touch columns confirmed to exist on prod
    // (tbl_easyfixer_rating_by_customer: customer_rating, review_comment,
    // comment — verified via existing reads in services/job.service.js
    // and the escalation INSERT in routes/client/index.js). rating_date
    // was tempting but not in the schema reference; skip it to avoid
    // an "Unknown column" 500.
    if (existing) {
      await pool.query(
        `UPDATE tbl_easyfixer_rating_by_customer
            SET easyfixer_id    = ?,
                customer_rating = ?,
                review_comment  = ?,
                comment         = ?
          WHERE table_id = ?`,
        [easyfixerId, r, reviewText, commentText, existing.table_id]
      );
    } else {
      await pool.query(
        `INSERT INTO tbl_easyfixer_rating_by_customer
           (job_id, easyfixer_id, customer_rating, review_comment, comment)
         VALUES (?, ?, ?, ?, ?)`,
        [jobId, easyfixerId, r, reviewText, commentText]
      );
    }
    modernOk(res, { saved: true, rating: r }, 'feedback recorded');
  } catch (e) { next(e); }
});

module.exports = router;
