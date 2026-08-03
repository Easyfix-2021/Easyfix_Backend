/*
 * Transcription backfill — ensures EVERY completed Plivo call gets a transcript
 * (not just calls whose recording someone happened to play). Plivo does NOT
 * auto-transcribe, so per call we: resolve the recording → GET the transcript →
 * if none exists yet, POST to REQUEST one (mark 'processing') and pick up the
 * text on a later run once Plivo finishes. Runs from the scheduler; gated by
 * plivo.transcription.enabled. Best-effort per row — one bad call never aborts
 * the batch. Returns counts for the scheduler's lastResult.
 *
 * Only processes calls that already have a tbl_plivo_call_log row (so there is a
 * row to store the transcript on) and a resolvable CallUUID. A call stuck in
 * 'processing' past PROCESSING_MAX_AGE_MS is marked 'not_available' so it stops
 * being re-checked forever.
 */

const { pool } = require('../db');
const logger = require('../logger');
const plivo = require('./plivo.service');

// Give up re-checking a 'processing' transcript after this long (Plivo usually
// finishes in seconds–minutes; a call with no speech may never produce one).
const PROCESSING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function runTranscriptionBackfill({ limit = 50 } = {}) {
  if (!plivo.transcriptionEnabled()) {
    return { skipped: true, reason: 'plivo.transcription.enabled is off' };
  }

  let rows;
  try {
    [rows] = await pool.query(
      `SELECT jci.job_caller_info AS id, jci.unique_id AS callUuid,
              pcl.transcription_status AS status, pcl.transcription_fetched_at AS lastAt
         FROM tbl_job_caller_info jci
         JOIN tbl_plivo_call_log pcl ON pcl.job_caller_info_id = jci.job_caller_info
        WHERE jci.provider = 'plivo'
          AND jci.unique_id IS NOT NULL
          AND jci.caller_status IN ('completed', 'hungup')
          AND jci.duration > 0
          AND (pcl.transcription IS NULL OR pcl.transcription = '')
          AND (pcl.transcription_status IS NULL OR pcl.transcription_status NOT IN ('completed', 'not_available'))
        ORDER BY jci.inserted_time DESC
        LIMIT ?`,
      [limit],
    );
  } catch (e) {
    // Columns may not exist yet (pre-migration) — treat as a no-op.
    logger.warn('transcription-backfill query failed (columns present?) · ' + e.message);
    return { skipped: true, reason: 'transcription columns missing' };
  }

  const result = { eligible: rows.length, completed: 0, requested: 0, notAvailable: 0, pending: 0, failed: 0 };
  for (const r of rows) {
    try {
      const meta = await plivo.fetchRecordingMeta({ callUuid: r.callUuid });
      if (!meta.ok || !meta.recordingId) {
        // Recording not ready yet — leave pending for a later run.
        result.pending += 1;
        continue;
      }
      const tx = await plivo.fetchTranscription({ recordingId: meta.recordingId });
      if (tx.ok && tx.text) {
        await pool.query(
          "UPDATE tbl_plivo_call_log SET transcription = ?, transcription_status = 'completed', transcription_fetched_at = NOW() WHERE job_caller_info_id = ?",
          [tx.text, r.id],
        );
        result.completed += 1;
      } else if (tx.ok) {
        // No transcript yet. Plivo doesn't auto-transcribe, so REQUEST one if we
        // haven't already; if it's already 'processing', wait for Plivo (give up
        // after PROCESSING_MAX_AGE_MS so a speechless call isn't retried forever).
        if (r.status === 'processing') {
          const ageMs = r.lastAt ? (Date.now() - new Date(r.lastAt).getTime()) : 0;
          if (r.lastAt && ageMs > PROCESSING_MAX_AGE_MS) {
            await pool.query(
              "UPDATE tbl_plivo_call_log SET transcription_status = 'not_available' WHERE job_caller_info_id = ?",
              [r.id],
            );
            result.notAvailable += 1;
          } else {
            result.pending += 1; // still processing on Plivo's side
          }
        } else {
          const created = await plivo.createTranscription({ recordingId: meta.recordingId });
          if (created.ok) {
            await pool.query(
              "UPDATE tbl_plivo_call_log SET transcription_status = 'processing', transcription_fetched_at = NOW() WHERE job_caller_info_id = ?",
              [r.id],
            );
            result.requested += 1;
          } else if (created.notEnabled) {
            await pool.query(
              "UPDATE tbl_plivo_call_log SET transcription_status = 'not_available' WHERE job_caller_info_id = ?",
              [r.id],
            );
            result.notAvailable += 1;
          } else {
            result.failed += 1;
          }
        }
      } else {
        result.failed += 1;
      }
    } catch (e) {
      result.failed += 1;
      logger.warn('transcription-backfill row failed · id=' + r.id + ' · ' + e.message);
    }
  }
  logger.info('transcription-backfill done · ' + JSON.stringify(result));
  return result;
}

module.exports = { runTranscriptionBackfill };
