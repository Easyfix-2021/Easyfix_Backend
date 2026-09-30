/*
 * /api/public/feedback/* — customer-facing feedback flow.
 *
 * Ported from the legacy Angular customer-feedback.component +
 * customer-feedback.service. The customer hits this from an SMS /
 * WhatsApp / email link AFTER the technician closes the visit, picks
 * a rating, and submits.
 *
 * Security posture:
 *   - NO admin / SPOC auth. Customers don't have accounts, so the link
 *     itself has to carry the authority.
 *   - A per-IP rate limit at the router mount. This comment previously
 *     ASSERTED that limit while routes/public/index.js mounted the router
 *     bare — the sentence was true of nobody. It is now real; see the
 *     rateLimit() on the /feedback mount.
 *   - `?t=` carries a signed, job-scoped feedback token whose jobId must
 *     match the URL. FEEDBACK_TOKEN_REQUIRED=true makes it mandatory.
 *   - The response carries no contact details — see the projection note.
 *
 * Endpoints:
 *   GET  /api/public/feedback/:jobId   — basic job + tech info for the page
 *   POST /api/public/feedback/:jobId   — submit the rating
 *
 * THE jobId IS NOT A SECRET, and treating it as one was the hole. It is a
 * small sequential integer: counting from 1 walked the entire customer book
 * out of this endpoint, unauthenticated and unthrottled, and the projection
 * used to include customer_mob_no. Two changes close that:
 *
 *   1. The response no longer carries contact details at all. The page greets
 *      the customer by FIRST NAME and renders the technician, the category and
 *      the client's branding — so that is all it now receives. The mobile
 *      number was never read by the page; it was pure exhaust, and it was the
 *      single most damaging field to hand out.
 *   2. `?t=` accepts a signed feedback token bound to this jobId.
 *
 * WHY THE TOKEN IS NOT YET MANDATORY BY DEFAULT. Tokenised links exist but are
 * not what customers hold yet. services/feedback-link.service.js mints them
 * (mintFeedbackLink), and the TechVisitComplete SMS in
 * notification-orchestrator appends one — but only while the property
 * `job.feedback_link.enabled` is 'true', which waits on ops registering the
 * URL-bearing body with DLT (unset on QA, 2026-09-30). Until then every link a
 * customer has is a bare /feedback/<jobId> from the legacy sender, which signs
 * with a different secret and cannot mint these. Requiring the token first
 * would break the rating page for all of them, including links already sent.
 * So the gate ships OFF, the enumeration value is removed immediately by (1),
 * and FEEDBACK_TOKEN_REQUIRED=true is the cutover once tokenised links are the
 * ones in circulation. The token also unlocks the technician photo
 * (technicianPhoto below), so photos appear exactly when that happens.
 */

const router = require('express').Router();
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');
const { verifyFeedbackToken } = require('../../utils/jwt');
const imageDelivery = require('../../services/job-image-delivery');
const profileLink = require('../../services/easyfixer-profile-update-link.service');

/*
 * Token gate for BOTH endpoints — read and submit. The submit matters as much
 * as the read: without it, anyone can post a star rating against any job id,
 * which is rating fraud against technicians' scores.
 *
 * A token that does not match the jobId in the URL is rejected, so one
 * customer's link cannot be pointed at another customer's job.
 */
function feedbackGate(req, res, next) {
  const raw = typeof req.query.t === 'string' ? req.query.t.trim() : '';
  const required = String(process.env.FEEDBACK_TOKEN_REQUIRED || '').toLowerCase() === 'true';

  if (!raw) {
    if (required) return modernError(res, 401, 'this feedback link is no longer valid');
    return next();          // legacy bare-id link; see the header note
  }
  try {
    const { jobId } = verifyFeedbackToken(raw);
    if (Number(jobId) !== Number(req.params.jobId)) {
      return modernError(res, 401, 'this feedback link is no longer valid');
    }
    req.feedbackTokenValid = true;   // unlocks the technician photo — see below
    return next();
  } catch (e) {
    // A PRESENT-but-bad token is always rejected, even when the gate is off.
    // Accepting it would make a forged token strictly better than no token.
    return modernError(res, e.status || 401, e.message || 'invalid or expired link');
  }
}
router.use('/:jobId', feedbackGate);

/*
 * The technician's photo, for a SIGNED link only (2026-09-30, owner's call).
 *
 * This endpoint is reachable by guessing an integer, which is why the customer
 * mobile and surname were stripped (header note). A face photo per job id on a
 * bare-id link would be a photo directory of the workforce for anyone counting
 * — 3110 of 4682 active techs have one (QA, 2026-09-30). A valid ?t= token is
 * job-bound and only the customer's own link carries it, so the photo rides
 * with that; bare-id links keep the initials tile.
 *
 * Absolute URLs only, or null: an S3 object (presignProfileImage, which also
 * maps a bare EFRDoc name to easyfixer_documents/), else the HEAD-verified
 * legacy file host. The page used to prefix `/easydoc/upload_jobs/` on its own
 * host — wrong directory, and a host that serves no /easydoc. The
 * `dummy_profile` placeholder is not a photo; initials say more.
 */
async function technicianPhoto(stored) {
  const v = String(stored || '').trim();
  if (!v || /dummy_profile/i.test(v)) return null;
  if (/^https?:\/\//i.test(v)) return null;          // never redirect a public page to an unvetted host
  const s3 = await profileLink.presignProfileImage(v).catch(() => null);
  if (s3) return s3;
  if (v.includes('/')) return null;
  return imageDelivery.resolveLegacyFile('easyfixer_documents', v);
}

// "Mr. Ravi Kumar" -> "Ravi". Mirrors the trimming the feedback page already
// applied to the full name it used to receive.
function firstName(name) {
  if (!name) return null;
  const bare = String(name).replace(/^\s*(?:mr|mrs|ms|dr)\.?\s+/i, '').trim();
  return bare.split(/\s+/)[0] || null;
}

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
    // docs/claude-reference/SCHEMA.md). efr_image / efr_photo do not exist;
    // the photo column is efr_profile_img (S3 key or legacy EFRDoc filename),
    // sent only to a SIGNED link — see technicianPhoto().
    /*
     * customer_mob_no is GONE and must not come back: the page never read it,
     * and on an endpoint reachable by guessing an integer it was a phone book.
     * customer_name is reduced to the first word below for the same reason —
     * the page renders "Hi <first name>," and nothing else needs the rest.
     */
    const [[row]] = await pool.query(
      `SELECT j.job_id, j.job_status, j.fk_customer_id, j.fk_easyfixter_id,
              j.fk_service_catg_id,
              cu.customer_name,
              ef.efr_name AS easyfixer_name,
              ef.efr_profile_img,
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
      /*
       * FIRST NAME ONLY. The page renders "Hi <first name>, please share your
       * experience" and does the same trimming client-side today — so sending
       * the full name gave the page nothing and gave an enumerator a surname.
       * Honorifics are stripped here so the server and the page agree on what
       * "first name" means rather than each having an opinion.
       */
      customer_name:    firstName(row.customer_name),
      easyfixer_id:     row.fk_easyfixter_id,
      easyfixer_name:   row.easyfixer_name,
      easyfixer_image:  req.feedbackTokenValid ? await technicianPhoto(row.efr_profile_img) : null,
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
// Exported for tests: the gate is the whole security contract of this route,
// and the pair of flag states it has to honour is worth asserting directly
// rather than through a booted server.
module.exports.feedbackGate = feedbackGate;
