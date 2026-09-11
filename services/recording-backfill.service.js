/*
 * services/recording-backfill.service.js — recover tbl_plivo_call_log.recording_url
 * for calls that requested recording but whose Plivo PUSH callback
 * (<Dial recordingCallbackUrl> → /api/public/plivo/recording-callback) never
 * landed.
 *
 * WHY (observed 2026-07-10): `SELECT SUM(recording_url IS NOT NULL) FROM
 * tbl_plivo_call_log` = 0 — the push has NEVER once populated the column,
 * despite a reachable callback host (answer_url on the same host works, so calls
 * connect + record) and valid call_uuids on every row. So the push mechanism
 * itself is unreliable for `<Dial>` recordings. Instead of depending on it, we
 * PULL each missing row's recording from the Plivo Recording API by call_uuid
 * (plivo.fetchRecordingMeta) and persist via plivoLog.setRecording.
 *
 * Driven by: an admin endpoint (POST /admin/calls/recordings/backfill — works
 * even when CRON_DISABLED) and a scheduler cron for steady-state prod.
 */
const { pool } = require('../db');
const plivo = require('./plivo.service');
const plivoLog = require('./plivo-call-log.service');
const logger = require('../logger');

/*
 * Sweep Plivo rows that have a call_uuid but no recording URL, PULL each from
 * Plivo, and persist. Bounded by `limit` (default 50, hard-capped 200). Sequential — a
 * sweep must not hammer the Plivo Recording API's rate limit. Fail-soft: a bad
 * row is counted and skipped; the columns being pre-migration is a clean no-op.
 * Returns { scanned, recovered, stillMissing, errors, limit }.
 */
/*
 * `shouldStop` is the COOPERATIVE-CANCELLATION checkpoint. server/scheduler.js
 * has offered isCancelRequested() since it was written — its own header
 * promises "any job can READ isCancelRequested() at a checkpoint and bail
 * cleanly" — and until 2026-09-10 no job did, so the cancel contract had a live
 * writer (requestCancel, reachable from a route) and no reader at all. Found by
 * scripts/dead-exports.js.
 *
 * Checked BETWEEN rows, never mid-row: a row is one Plivo fetch plus one write,
 * and abandoning it half-done would leave a recording fetched and unrecorded.
 * Stopping between rows loses nothing — the next run re-selects whatever is
 * still missing.
 *
 * Optional and defaulted, so every existing caller is unaffected.
 */
async function backfillMissingRecordings({ limit = 50, shouldStop = null } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  let rows;
  try {
    // Deliberately does NOT filter on recording_requested: that column is the
    // one commonly NULL / pre-migration, and gating on `= 1` was silently
    // excluding every row (throwing "Unknown column" pre-migration, or matching
    // nothing when the flag was never written). Sweep by what actually exists —
    // any Plivo row with a call_uuid but no recording_url — and let the Plivo
    // pull decide (it returns no URL when recording was off / still processing).
    [rows] = await pool.query(
      `SELECT job_caller_info_id AS jci, call_uuid
         FROM tbl_plivo_call_log
        WHERE recording_url IS NULL AND call_uuid IS NOT NULL
        ORDER BY id DESC
        LIMIT ?`,
      [lim],
    );
  } catch (e) {
    // Pre-migration deploy (recording_url column absent).
    logger.warn({ err: e.message }, 'recording-backfill: query failed (columns may be pre-migration)');
    return { scanned: 0, recovered: 0, stillMissing: 0, errors: 0, skipped: true };
  }

  let recovered = 0;
  let stillMissing = 0;
  let errors = 0;
  let stopped = false;
  for (const r of rows) {
    if (typeof shouldStop === 'function' && shouldStop()) {
      stopped = true;
      logger.warn(`recording-backfill: stop requested — halting after ${recovered + stillMissing + errors} of ${rows.length} row(s)`);
      break;
    }
    try {
      const meta = await plivo.fetchRecordingMeta({ callUuid: r.call_uuid });
      if (meta && meta.ok && meta.url) {
        await plivoLog.setRecording(r.jci, { url: meta.url, id: meta.recordingId, duration: meta.duration });
        recovered++;
      } else {
        // No recording on Plivo for this call_uuid (still processing, recording
        // was off, or it's filed under a different leg — e.g. web/WebRTC calls,
        // which only the push callback could have captured).
        stillMissing++;
      }
    } catch (e) {
      errors++;
      logger.warn({ err: e.message, jci: r.jci }, 'recording-backfill: row failed');
    }
  }
  logger.info(`Recording backfill · scanned=${rows.length} recovered=${recovered} stillMissing=${stillMissing} errors=${errors}`);
  /* `stopped` so the operator can see the Stop took effect — a cancelled run
   * that reports the same shape as a completed one is indistinguishable from
   * a Stop button that did nothing. */
  return { scanned: rows.length, recovered, stillMissing, errors, limit: lim, stopped };
}

module.exports = { backfillMissingRecordings };
