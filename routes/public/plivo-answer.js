const router = require('express').Router();
const logger = require('../../logger');
const { pool } = require('../../db');
const plivo = require('../../services/plivo.service');

/*
 * /api/public/plivo/answer — Plivo answer_url callback (truly public, no auth).
 *
 * Plivo GETs this URL the moment the AGENT leg is answered. We must return
 * call-control XML that bridges to the customer leg. The destination customer
 * number is NOT in the URL — it's carried inside the signed `t` JWT (along with
 * the tbl_job_caller_info id) minted by plivo.service.signCallToken when the
 * call was placed. See plivo.service.js header for the full flow.
 *
 * Reaching this route means the agent picked up, so it's the natural moment to
 * flip the audit row to 'answered' and stamp start_time. The DB write is
 * best-effort and wrapped in try/catch — Plivo MUST always receive valid XML,
 * even if the token is expired or the update fails, so the live leg isn't
 * dropped. An invalid/expired token yields an empty <Response/> (no bridge).
 *
 * No JWT/Basic auth here: the signed `t` token IS the authorisation, and the
 * public mount (routes/public/index.js) sits ahead of requireAuth.
 */
router.get('/answer', async (req, res) => {
  const xml = (body) => res.type('text/xml').send(body);

  const claims = plivo.verifyCallToken(req.query.t);
  if (!claims) {
    // Invalid / expired token → return a no-op Response so Plivo doesn't choke,
    // but we cannot (and must not) bridge to an unknown destination.
    return xml('<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>');
  }

  // Best-effort: mark the row answered (agent picked up). COALESCE so a
  // CallUUID that may have already been stamped by the ring callback isn't
  // clobbered with NULL when Plivo omits it here.
  try {
    await pool.query(
      `UPDATE tbl_job_caller_info
          SET caller_status = 'answered',
              start_time = NOW(),
              unique_id = COALESCE(?, unique_id)
        WHERE job_caller_info = ?`,
      [req.query.CallUUID || null, claims.jci]
    );
  } catch (err) {
    logger.warn({ jci: claims.jci, err: err && err.message }, 'plivo answer: audit update failed (returning XML anyway)');
  }

  return xml(plivo.buildAnswerXml(claims.dest));
});

module.exports = router;
