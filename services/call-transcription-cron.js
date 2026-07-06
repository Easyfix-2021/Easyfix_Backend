/*
 * Transcription backfill — fetches + stores the Plivo transcription for EVERY
 * completed Plivo call that doesn't have one yet (not just calls whose recording
 * someone happened to play). Runs from the scheduler; gated by
 * plivo.transcription.enabled. Best-effort per row — one bad call never aborts
 * the batch. Returns counts for the scheduler's lastResult.
 *
 * Only processes calls that already have a tbl_plivo_call_log row (so there is a
 * row to store the transcript on) and a resolvable CallUUID.
 */

const { pool } = require('../db');
const logger = require('../logger');
const plivo = require('./plivo.service');

async function runTranscriptionBackfill({ limit = 50 } = {}) {
  if (!plivo.transcriptionEnabled()) {
    return { skipped: true, reason: 'plivo.transcription.enabled is off' };
  }

  let rows;
  try {
    [rows] = await pool.query(
      `SELECT jci.job_caller_info AS id, jci.unique_id AS callUuid
         FROM tbl_job_caller_info jci
         JOIN tbl_plivo_call_log pcl ON pcl.job_caller_info_id = jci.job_caller_info
        WHERE jci.provider = 'plivo'
          AND jci.unique_id IS NOT NULL
          AND jci.caller_status IN ('completed', 'hungup')
          AND (pcl.transcription IS NULL OR pcl.transcription = '')
          AND (pcl.transcription_status IS NULL OR pcl.transcription_status NOT IN ('completed', 'not_available'))
          AND jci.inserted_time > DATE_SUB(NOW(), INTERVAL 7 DAY)
        ORDER BY jci.inserted_time DESC
        LIMIT ?`,
      [limit],
    );
  } catch (e) {
    // Columns may not exist yet (pre-migration) — treat as a no-op.
    logger.warn('transcription-backfill query failed (columns present?) · ' + e.message);
    return { skipped: true, reason: 'transcription columns missing' };
  }

  const result = { eligible: rows.length, completed: 0, notAvailable: 0, pending: 0, failed: 0 };
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
        await pool.query(
          "UPDATE tbl_plivo_call_log SET transcription_status = 'not_available' WHERE job_caller_info_id = ?",
          [r.id],
        );
        result.notAvailable += 1;
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
