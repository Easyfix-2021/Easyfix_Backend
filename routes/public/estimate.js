/*
 * /api/public/estimate/* — customer/SPOC-facing estimate approval flow.
 *
 * Threat model & security posture:
 *   (a) No global auth. This sub-router sits ahead of any SPOC/admin
 *       guard (parent routes/public/index.js mounts pre-auth) so the
 *       SPOC can act from a plain SMS/email link with only the JWT.
 *   (b) Token IS the credential. verifyEstimateToken validates the
 *       cryptographic signature (same JWT_SECRET as login tokens) and
 *       extracts `jobId` (+ optional `clientContactId`). The jobId
 *       pins all SQL — there is no body/param path that lets the
 *       caller act on a different job.
 *   (c) Per-token rate limit, 20 req / 10 min keyed on the verified
 *       jobId. The number is intentionally lower than the
 *       /job-completion bucket (which has 30 req/10 min) because the
 *       estimate flow is short — list, view PDF, click one button —
 *       and a burst above 20 reqs is overwhelmingly likely to be
 *       abuse.
 *   (d) Idempotent terminal states. Once `approved_on_date_time` or
 *       `approval_reject_date_time` is set on tbl_job, both action
 *       endpoints 409 — a leaked token can NOT flip the decision
 *       after the fact.
 *
 * Endpoints:
 *   GET   /api/public/estimate/:token            page payload + status
 *   PATCH /api/public/estimate/:token/approve    set approved_*
 *   PATCH /api/public/estimate/:token/reject     set approval_reject_*
 *
 * State mirror: the SPOC-authed flow at PATCH /api/client/jobs/:id/
 * estimate/{approve,reject} writes to the SAME tbl_job columns. Either
 * surface (logged-in dashboard OR email link) reaches the same
 * terminal state, and the idempotency guards stop the other surface
 * from re-acting once one has fired.
 */

const router = require('express').Router();
const { pool } = require('../../db');
const { verifyEstimateToken } = require('../../utils/jwt');
const { modernOk, modernError } = require('../../utils/response');
const { rateLimit } = require('../../middleware/rate-limit');
const logger = require('../../logger');
const emailService = require('../../services/email.service');

// Peek-the-token middleware. Runs the signature check WITHOUT any
// downstream SQL so the rate limiter can key its bucket on jobId.
// Bad/expired tokens leave req.verifiedJobId = null and the per-route
// verify() emits the proper 401 — this is NOT an auth boundary.
function peekToken(req, _res, next) {
  try {
    const { jobId, clientContactId } = verifyEstimateToken(req.params.token);
    req.verifiedJobId = jobId;
    req.verifiedClientContactId = clientContactId;
  } catch (_e) {
    req.verifiedJobId = null;
    req.verifiedClientContactId = null;
  }
  return next();
}

// Per-token rate limit. Falls back to IP when the token can't be
// verified so an attacker can't get a fresh bucket per random forged
// token. Bucket prefix 'est:' keeps these counts isolated from any
// other public surface that limits the same IP.
const tokenRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  key: (req) => (req.verifiedJobId ? `est:${req.verifiedJobId}` : `est-ip:${req.ip}`),
});

// Full per-endpoint verify. Re-runs signature validation (we don't
// trust the peek output downstream — re-verification keeps each route
// individually auditable) and returns the verified claims.
function verify(req) {
  return verifyEstimateToken(req.params.token);
}

// Map known thrown shapes ({status, message}) to modernError. Anything
// without a status falls through to the global error handler.
function mapKnownError(res, next, e) {
  if (e && typeof e.status === 'number') {
    return modernError(res, e.status, e.message || 'request failed');
  }
  return next(e);
}

// Resolve the public PDF URL the FE renders inline. Production serves
// `/easydoc/estimateapproval/Estimate_Approval_<jobId>.pdf` from
// Nginx; we just hand the path down and let the FE join it with its
// FILE_BASE_URL env. Returning a path (not a full URL) means dev/QA
// envs can override via NEXT_PUBLIC_FILE_BASE_URL without redeploying
// the backend.
function estimatePdfPath(jobId) {
  return `/easydoc/estimateapproval/Estimate_Approval_${jobId}.pdf`;
}

/*
 * GET /api/public/estimate/:token
 *
 * Returns everything the rating-style FE page needs to render:
 *   - job_id, job_status
 *   - customer name (greeting)
 *   - easyfixer name (so "raised by X" reads naturally)
 *   - service category name
 *   - client name (powered-by line)
 *   - pdf_path (under /easydoc — joined with FILE_BASE_URL on the FE)
 *   - status: 'pending' | 'approved' | 'rejected'
 *   - actioned_by_name, actioned_on (when status != 'pending')
 *
 * Status derivation mirrors the legacy estimate.component.ts:
 *   approved_on_date_time → 'approved'
 *   approval_reject_date_time → 'rejected'
 *   neither → 'pending'
 *
 * Cancelled / completed jobs are surfaced as terminal too (the FE
 * shows a friendly "this order is closed" screen), independent of
 * the estimate sub-state.
 */
router.get('/:token', peekToken, tokenRateLimit, async (req, res, next) => {
  try {
    const { jobId } = verify(req);
    // Single query — left-joins all the labels the FE renders. The
    // `approved_by` join attempts to resolve the actioner's name from
    // tbl_client_contacts (where approved_by_client_contact lives).
    const [[row]] = await pool.query(
      `SELECT j.job_id, j.job_status,
              j.approved_on_date_time, j.approved_by_client_contact,
              j.approval_reject_date_time, j.approval_reject_reason,
              cu.customer_name,
              ef.efr_name        AS easyfixer_name,
              sc.service_catg_name,
              cl.client_id, cl.client_name,
              ab.contact_name    AS approved_by_name
         FROM tbl_job j
         LEFT JOIN tbl_customer        cu ON cu.customer_id     = j.fk_customer_id
         LEFT JOIN tbl_easyfixer       ef ON ef.efr_id          = j.fk_easyfixter_id
         LEFT JOIN tbl_service_catg    sc ON sc.service_catg_id = j.fk_service_catg_id
         LEFT JOIN tbl_client          cl ON cl.client_id       = j.fk_client_id
         LEFT JOIN tbl_client_contacts ab ON ab.id              = j.approved_by_client_contact
        WHERE j.job_id = ? LIMIT 1`,
      [jobId]
    );
    if (!row) return modernError(res, 404, 'job not found for this estimate link');

    let status = 'pending';
    if (row.approved_on_date_time) status = 'approved';
    else if (row.approval_reject_date_time) status = 'rejected';

    return modernOk(res, {
      job_id:           row.job_id,
      job_status:       row.job_status,
      customer_name:    row.customer_name,
      easyfixer_name:   row.easyfixer_name,
      service_category: row.service_catg_name,
      client_name:      row.client_name,
      pdf_path:         estimatePdfPath(row.job_id),
      status,
      // Action attribution surfaces the legacy "Estimate is approved
      // by X" / "rejected by X" messages on the FE without an extra
      // round-trip. Null on the pending state.
      actioned_by_name: status === 'pending' ? null : (row.approved_by_name || null),
      actioned_on:      status === 'approved'
        ? row.approved_on_date_time
        : (status === 'rejected' ? row.approval_reject_date_time : null),
      reject_reason:    status === 'rejected' ? row.approval_reject_reason : null,
    });
  } catch (e) {
    return mapKnownError(res, next, e);
  }
});

/*
 * PATCH /api/public/estimate/:token/approve
 *
 * Terminal action. Writes:
 *   approved_by_client_contact = clientContactId (from JWT; null
 *     allowed for legacy tokens that didn't carry the claim)
 *   approved_on_date_time      = NOW()
 *
 * Idempotency: refuses if either approve/reject timestamp is already
 * set. Refuses on cancelled (status 6) or completed (3, 5) jobs to
 * match the SPOC-authed flow in routes/client/index.js.
 */
router.patch('/:token/approve', peekToken, tokenRateLimit, async (req, res, next) => {
  try {
    const { jobId, clientContactId } = verify(req);
    const [[job]] = await pool.query(
      `SELECT job_id, job_status, approved_on_date_time, approval_reject_date_time
         FROM tbl_job WHERE job_id = ? LIMIT 1`,
      [jobId]
    );
    if (!job) return modernError(res, 404, 'job not found for this estimate link');
    if ([3, 5, 6].includes(Number(job.job_status))) {
      return modernError(res, 409,
        `Cannot approve — this order is ${Number(job.job_status) === 6 ? 'cancelled' : 'closed'}.`);
    }
    if (job.approved_on_date_time) {
      return modernError(res, 409, 'Estimate has already been approved.');
    }
    if (job.approval_reject_date_time) {
      return modernError(res, 409, 'Estimate has already been rejected and can\'t be approved.');
    }
    await pool.query(
      `UPDATE tbl_job
          SET approved_by_client_contact = ?,
              approved_on_date_time      = NOW()
        WHERE job_id = ?`,
      [clientContactId, jobId]
    );
    logger.info({ jobId, clientContactId }, 'public-estimate: approved via token link');
    return modernOk(res, { approved: true });
  } catch (e) {
    return mapKnownError(res, next, e);
  }
});

/*
 * PATCH /api/public/estimate/:token/reject  { reason }
 *
 * Terminal action. Writes the SPOC-supplied reason text into
 * `approval_reject_reason` and stamps `approval_reject_date_time`.
 *
 * The FE composes the final `reason` string from the dropdown choice
 * plus optional comments ("Price too high — needs negotiation"), so
 * we accept a single free-text payload here. Backend caps it at 500
 * chars defensively (the column is TEXT but we don't want runaway
 * input shipping into ops emails).
 *
 * Best-effort escalation email to ops + the job owner, identical to
 * the SPOC-authed reject flow's fireRejectEscalation. Non-blocking —
 * mail failure must not 500 the API response.
 */
router.patch('/:token/reject', peekToken, tokenRateLimit, async (req, res, next) => {
  try {
    const { jobId, clientContactId } = verify(req);
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    if (reason.length < 3) {
      return modernError(res, 400, 'Please share a brief reason for rejecting the estimate.');
    }
    const [[job]] = await pool.query(
      `SELECT j.job_id, j.job_status, j.approved_on_date_time, j.approval_reject_date_time,
              j.fk_client_id, j.job_owner, j.client_ref_id,
              cu.customer_name, cu.customer_mob_no,
              cl.client_name
         FROM tbl_job j
         LEFT JOIN tbl_customer cu ON cu.customer_id = j.fk_customer_id
         LEFT JOIN tbl_client   cl ON cl.client_id   = j.fk_client_id
        WHERE j.job_id = ? LIMIT 1`,
      [jobId]
    );
    if (!job) return modernError(res, 404, 'job not found for this estimate link');
    if ([3, 5, 6].includes(Number(job.job_status))) {
      return modernError(res, 409,
        `Cannot reject — this order is ${Number(job.job_status) === 6 ? 'cancelled' : 'closed'}.`);
    }
    if (job.approved_on_date_time) {
      return modernError(res, 409, 'Estimate has already been approved and can\'t be rejected now.');
    }
    if (job.approval_reject_date_time) {
      return modernError(res, 409, 'Estimate has already been rejected.');
    }
    await pool.query(
      `UPDATE tbl_job
          SET approval_reject_reason     = ?,
              approval_reject_date_time  = NOW()
        WHERE job_id = ?`,
      [reason, jobId]
    );

    // Fire ops escalation — best-effort, never blocks the response.
    // Lookup the actioner's name from the JWT-extracted contact id so
    // the email body reads "rejected by <SPOC name>". Falls back to
    // "the client" when the legacy token didn't carry the claim.
    (async () => {
      try {
        let actorName = 'the client';
        if (clientContactId) {
          const [[c]] = await pool.query(
            'SELECT contact_name FROM tbl_client_contacts WHERE id = ? LIMIT 1',
            [clientContactId]
          );
          if (c?.contact_name) actorName = c.contact_name;
        }
        const ownerEmail = (await pool.query(
          'SELECT official_email FROM tbl_user WHERE user_id = ?',
          [job.job_owner]
        ))[0]?.[0]?.official_email;
        const opsMailbox = process.env.OPS_ESCALATION_INBOX || 'ops@easyfix.in';
        const to = [opsMailbox];
        if (ownerEmail) to.push(ownerEmail);
        const subject = `[Estimate rejected by client] Job #${job.job_id}` +
          (job.client_ref_id ? ` (${job.client_ref_id})` : '');
        const text =
          `The client SPOC ${actorName} has rejected the estimate via the public link.\n\n` +
          `Job: ${job.job_id}\n` +
          `Client: ${job.client_name || job.fk_client_id}\n` +
          `Customer: ${job.customer_name || ''} (${job.customer_mob_no || ''})\n\n` +
          `Reason given: ${reason}\n\n` +
          `Please follow up.`;
        await emailService.send({ to, subject, text, category: 'client.estimate.reject' });
      } catch (e) {
        logger.warn({ jobId, err: e && e.message },
          'public-estimate: escalation email failed (non-fatal)');
      }
    })();

    return modernOk(res, { rejected: true });
  } catch (e) {
    return mapKnownError(res, next, e);
  }
});

module.exports = router;
