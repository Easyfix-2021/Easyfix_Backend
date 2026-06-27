const router = require('express').Router();
const logger = require('../../logger');
const { pool } = require('../../db');
const plivo = require('../../services/plivo.service');
const plivoLog = require('../../services/plivo-call-log.service');

/*
 * Plivo voice status callbacks (Plivo → us). Mounted at /api/webhook/plivo.
 *
 *   POST /ring    ← Plivo ring_url   (the agent leg is ringing)
 *   POST /hangup  ← Plivo hangup_url (the call ended, with final CallStatus)
 *
 * Auth: like the rest of the webhook group there is no JWT/Basic check; the
 * signed `t` query token (minted by plivo.service.signCallToken) IS the
 * authorisation — it self-identifies which tbl_job_caller_info row to update
 * without trusting any provider-supplied id. An invalid/expired token → we
 * still 200 OK (no update) so Plivo doesn't retry-storm.
 *
 * Body parsing: Plivo posts application/x-www-form-urlencoded. The global
 * express.urlencoded() middleware in server.js already populates req.body for
 * this group (same as routes/webhook/whatsapp.js, which reads req.body
 * directly). No per-router body parser needed.
 *
 * We always return 200 quickly; real processing errors are logged server-side
 * only.
 */

/*
 * Map Plivo's terminal CallStatus + HangupCause to our normalized status enum.
 * Normalized terminal set (kept in sync with routes/admin/calls.js
 * TERMINAL_STATUSES): completed | busy | no_answer | failed | hungup.
 *
 * Plivo CallStatus values on the hangup callback: 'completed', 'busy',
 * 'no-answer', 'failed', 'cancel', 'timeout' (and occasionally 'ringing'/
 * 'in-progress' on non-final events, which we never reach here). HangupCause
 * refines a generic/absent status (e.g. 'NORMAL_CLEARING' → completed,
 * 'NO_ANSWER'/'NO_USER_RESPONSE' → no_answer, 'USER_BUSY' → busy).
 */
function mapPlivoStatus(callStatus, hangupCause) {
  const s = String(callStatus || '').trim().toLowerCase();
  switch (s) {
    case 'completed':            return 'completed';
    case 'busy':                 return 'busy';
    case 'no-answer':            return 'no_answer';
    case 'failed':               return 'failed';
    case 'cancel':               return 'hungup';   // caller/agent cancelled before bridge
    case 'timeout':              return 'no_answer'; // rang out
    default: break;
  }
  // Fall back to HangupCause when CallStatus is absent/unrecognised.
  const c = String(hangupCause || '').trim().toUpperCase();
  if (!c) return 'completed';
  if (c.includes('NO_ANSWER') || c.includes('NO_USER_RESPONSE')) return 'no_answer';
  if (c.includes('BUSY')) return 'busy';
  if (c.includes('NORMAL_CLEARING') || c.includes('NORMAL') || c.includes('ANSWER')) return 'completed';
  if (c.includes('CANCEL') || c.includes('ORIGINATOR_CANCEL')) return 'hungup';
  return 'failed';
}

// ─── POST /ring — agent leg ringing ────────────────────────────────────
router.post('/ring', async (req, res) => {
  const claims = plivo.verifyCallToken(req.query.t);
  if (!claims) { logger.warn('Plivo ring webhook · invalid/expired token, no-op'); return res.json({ ok: true }); } // expired/invalid token → no-op

  logger.info('Plivo ring webhook · jci=' + claims.jci);
  try {
    await pool.query(
      `UPDATE tbl_job_caller_info
          SET caller_status = 'ringing',
              unique_id = COALESCE(?, unique_id)
        WHERE job_caller_info = ?`,
      [req.body.CallUUID || null, claims.jci]
    );
  } catch (err) {
    logger.warn({ jci: claims.jci, err: err && err.message }, 'plivo ring webhook: update failed');
  }
  await plivoLog.markRinging(claims.jci, req.body.CallUUID || null);
  logger.info('Plivo ring recorded · jci=' + claims.jci);
  return res.json({ ok: true });
});

// ─── POST /hangup — call ended (final status) ──────────────────────────
router.post('/hangup', async (req, res) => {
  const claims = plivo.verifyCallToken(req.query.t);
  if (!claims) { logger.warn('Plivo hangup webhook · invalid/expired token, no-op'); return res.json({ ok: true }); } // expired/invalid token → no-op

  const status = mapPlivoStatus(req.body.CallStatus, req.body.HangupCause);
  const durRaw = req.body.Duration;
  const duration = durRaw != null && durRaw !== '' && Number.isFinite(parseInt(durRaw, 10))
    ? parseInt(durRaw, 10)
    : null;

  logger.info('Plivo hangup webhook · jci=' + claims.jci + ' status=' + status + ' duration=' + (duration != null ? duration : 'n/a'));
  try {
    await pool.query(
      `UPDATE tbl_job_caller_info
          SET caller_status = ?,
              end_time = NOW(),
              duration = ?,
              is_updated = 1,
              unique_id = COALESCE(?, unique_id)
        WHERE job_caller_info = ?`,
      [status, duration, req.body.CallUUID || null, claims.jci]
    );
  } catch (err) {
    logger.warn({ jci: claims.jci, err: err && err.message }, 'plivo hangup webhook: update failed');
  }
  await plivoLog.markTerminalByJci(claims.jci, {
    status, duration, hangupCause: req.body.HangupCause || null, callUuid: req.body.CallUUID || null,
  });
  logger.info('Plivo call finalized · jci=' + claims.jci + ' status=' + status);
  return res.json({ ok: true });
});

// ─── POST /web-hangup — Web (browser WebRTC) call ended (audit) ────────
// The Web Call Voice Application's Hangup URL. There's no signed `t` token on
// this path (the opaque dialId was one-time-consumed at web-answer), so we
// correlate by CallUUID — which web-answer stamped onto the row's unique_id when
// it bridged. Best-effort; never overwrites an already-terminal row; always 200.
router.post('/web-hangup', async (req, res) => {
  const callUuid = req.body.CallUUID || null;
  if (!callUuid) { logger.warn('Plivo web-hangup webhook · missing CallUUID, no-op'); return res.json({ ok: true }); }

  const status = mapPlivoStatus(req.body.CallStatus, req.body.HangupCause);
  const durRaw = req.body.Duration;
  const duration = durRaw != null && durRaw !== '' && Number.isFinite(parseInt(durRaw, 10))
    ? parseInt(durRaw, 10)
    : null;

  logger.info('Plivo web-hangup webhook · callUuid=' + callUuid + ' status=' + status + ' duration=' + (duration != null ? duration : 'n/a'));
  try {
    await pool.query(
      `UPDATE tbl_job_caller_info
          SET caller_status = ?, end_time = NOW(), duration = ?, is_updated = 1
        WHERE unique_id = ?
          AND caller_status NOT IN ('completed','busy','no_answer','failed','hungup')`,
      [status, duration, callUuid]
    );
  } catch (err) {
    logger.warn({ callUuid, err: err && err.message }, 'plivo web-hangup webhook: update failed');
  }
  await plivoLog.markTerminalByCallUuid(callUuid, {
    status, duration, hangupCause: req.body.HangupCause || null,
  });
  logger.info('Plivo web call finalized · callUuid=' + callUuid + ' status=' + status);
  return res.json({ ok: true });
});

module.exports = router;
