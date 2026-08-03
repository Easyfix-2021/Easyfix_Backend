/*
 * Call-metrics backfill — drives Amazon Transcribe Call Analytics for completed
 * Plivo calls. Two phases per run:
 *   B) RETRIEVE — poll in-flight Transcribe jobs; on COMPLETED, fetch + parse the
 *      result JSON from S3 and store the metrics; on FAILED, mark failed.
 *   A) START    — for completed calls with no metrics job yet, ensure the
 *      recording is cached in S3 (fetch from Plivo if needed), then start a
 *      Call Analytics job and mark it 'processing'.
 *
 * Gated by transcribe.enabled() (property + AWS config). Best-effort per row —
 * one bad call never aborts the batch. Returns counts for the scheduler.
 */

const { pool } = require('../db');
const logger = require('../logger');
const transcribe = require('./transcribe-call-analytics.service');
// Recording→S3 resolution was promoted here into a shared service when the
// Gemini recording-mode analysis became a second audio consumer.
const { ensureRecordingInS3 } = require('./call-recording.service');

async function runCallMetrics({ startLimit = 10, pollLimit = 25 } = {}) {
  if (!transcribe.enabled()) {
    return { skipped: true, reason: 'transcribe.analytics not enabled/configured' };
  }
  const result = { started: 0, ready: 0, failed: 0, inProgress: 0, noRecording: 0 };

  // ── Phase B: retrieve results for in-flight jobs first ──
  let processing = [];
  try {
    [processing] = await pool.query(
      `SELECT job_caller_info_id AS jci, call_analytics_job_name AS jobName
         FROM tbl_plivo_call_log
        WHERE call_metrics_status = 'processing' AND call_analytics_job_name IS NOT NULL
        LIMIT ?`,
      [pollLimit],
    );
  } catch (e) {
    // Columns missing (pre-migration) → no-op.
    logger.warn('call-metrics query failed (columns present?) · ' + e.message);
    return { skipped: true, reason: 'call_metrics columns missing' };
  }
  for (const r of processing) {
    try {
      const j = await transcribe.getJob({ jobName: r.jobName });
      if (!j.ok) continue;
      if (j.status === 'COMPLETED' && j.outputUri) {
        const out = await transcribe.fetchResultJson(j.outputUri);
        if (out) {
          await pool.query(
            "UPDATE tbl_plivo_call_log SET call_metrics = ?, call_metrics_status = 'ready' WHERE job_caller_info_id = ?",
            [JSON.stringify(transcribe.parseMetrics(out)), r.jci],
          );
          result.ready += 1;
        } else {
          await pool.query("UPDATE tbl_plivo_call_log SET call_metrics_status = 'failed' WHERE job_caller_info_id = ?", [r.jci]);
          result.failed += 1;
        }
      } else if (j.status === 'FAILED') {
        await pool.query("UPDATE tbl_plivo_call_log SET call_metrics_status = 'failed' WHERE job_caller_info_id = ?", [r.jci]);
        result.failed += 1;
      } else {
        result.inProgress += 1;
      }
    } catch (e) {
      logger.warn('call-metrics poll failed · jci=' + r.jci + ' · ' + e.message);
    }
  }

  // ── Phase A: start jobs for completed calls with no metrics yet ──
  let pending = [];
  try {
    [pending] = await pool.query(
      `SELECT jci.job_caller_info AS jci, jci.unique_id AS callUuid, jci.recording AS recording
         FROM tbl_plivo_call_log pcl
         JOIN tbl_job_caller_info jci ON jci.job_caller_info = pcl.job_caller_info_id
        WHERE pcl.call_metrics_status IS NULL
          AND jci.provider = 'plivo'
          AND jci.unique_id IS NOT NULL
          AND jci.caller_status IN ('completed', 'hungup')
          AND jci.inserted_time > DATE_SUB(NOW(), INTERVAL 7 DAY)
        ORDER BY jci.inserted_time DESC
        LIMIT ?`,
      [startLimit],
    );
  } catch (e) {
    pending = [];
  }
  for (const r of pending) {
    try {
      const key = await ensureRecordingInS3({ jci: r.jci, recording: r.recording, callUuid: r.callUuid });
      if (!key) {
        // Recording not ready yet — leave NULL so a later run retries.
        result.noRecording += 1;
        continue;
      }
      const jobName = ('easyfix-callmetrics-' + r.jci + '-' + Date.now()).replace(/[^0-9A-Za-z._-]/g, '-').slice(0, 200);
      const started = await transcribe.startJob({ jobName, recordingKey: key });
      if (started.ok) {
        await pool.query(
          "UPDATE tbl_plivo_call_log SET call_analytics_job_name = ?, call_metrics_status = 'processing' WHERE job_caller_info_id = ?",
          [jobName, r.jci],
        );
        result.started += 1;
      } else {
        result.failed += 1;
      }
    } catch (e) {
      result.failed += 1;
      logger.warn('call-metrics start failed · jci=' + r.jci + ' · ' + e.message);
    }
  }

  logger.info('call-metrics cron done · ' + JSON.stringify(result));
  return result;
}

module.exports = { runCallMetrics };
