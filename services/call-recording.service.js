/*
 * Call-recording → S3 resolution, shared by every consumer that needs the AUDIO
 * BYTES of a call (Transcribe Call Analytics backfill, Gemini recording-mode
 * call analysis). Promoted out of call-metrics-cron.js so a second audio consumer
 * doesn't mean a second copy of the same Plivo→S3 dance (see
 * `feedback_easyfix_no_route_duplication`).
 *
 * Contract: return the S3 KEY of the call's recording, fetching it from Plivo and
 * caching it under a stable key on first miss, or null when there's nothing to
 * fetch yet (Plivo lags a few seconds after hangup, or recording was off for the
 * call). Never throws for a "not ready" case — callers treat null as retry-later.
 */

const { pool } = require('../db');
const logger = require('../logger');
const plivo = require('./plivo.service');
const s3 = require('../utils/s3-storage');

/*
 * Ensure the call's recording is in S3; return its key or null.
 *
 * `recordingUrl` is OPTIONAL and additive: the <Dial recordingCallbackUrl> push
 * has proven unreliable for web/WebRTC legs (the recording gets filed under a
 * different leg than the stored call_uuid), so a caller that already holds
 * tbl_plivo_call_log.recording_url can hand it over to skip the lookup. Omitted
 * ⇒ byte-for-byte the original cron behaviour (recording key → call_uuid lookup).
 */
async function ensureRecordingInS3({ jci, recording, callUuid, recordingUrl = null }) {
  if (recording && String(recording).startsWith('CallRecordings/') && (await s3.exists(recording))) {
    return recording;
  }
  if (!s3.isEnabled()) return null;
  let url = recordingUrl || null;
  if (!url) {
    if (!callUuid) return null;
    const meta = await plivo.fetchRecordingMeta({ callUuid });
    if (!meta.ok || !meta.url) return null;
    url = meta.url;
  }
  const dl = await plivo.downloadRecording(url);
  if (!dl.ok || !dl.buffer) return null;
  const key = s3.buildCallRecordingKey(jci);
  await s3.putAtKey({ key, buffer: dl.buffer, contentType: dl.contentType || 'audio/mpeg' });
  await pool.query('UPDATE tbl_job_caller_info SET recording = ? WHERE job_caller_info = ?', [key, jci]);
  return key;
}

/*
 * Same thing keyed only on the call row id — does its own lookups so route
 * handlers don't each re-derive the inputs. Returns { key, reason }: `key` set on
 * success, `reason` a short machine code the caller can surface when it's null.
 *
 * A Kaleyra row stores an external https:// recording URL in `recording` rather
 * than one of our S3 keys; we deliberately do NOT pull those (call analysis lives
 * on tbl_plivo_call_log and is Plivo-only) — 'recording_external' says so plainly
 * instead of silently returning nothing.
 */
async function resolveRecordingKey(jobCallerInfoId) {
  try {
    const [[row]] = await pool.query(
      'SELECT recording, unique_id FROM tbl_job_caller_info WHERE job_caller_info = ? LIMIT 1',
      [jobCallerInfoId],
    );
    if (!row) return { key: null, reason: 'call_not_found' };
    if (row.recording && /^https?:\/\//i.test(String(row.recording))) {
      return { key: null, reason: 'recording_external' };
    }
    if (!s3.isEnabled()) return { key: null, reason: 's3_not_configured' };

    // Column-probed via try/catch so a pre-migration host still resolves through
    // the legacy call_uuid path (same guard as GET /admin/calls/:id/recording).
    let recordingUrl = null;
    try {
      const [[plog]] = await pool.query(
        'SELECT recording_url FROM tbl_plivo_call_log WHERE job_caller_info_id = ? AND recording_url IS NOT NULL ORDER BY id DESC LIMIT 1',
        [jobCallerInfoId],
      );
      recordingUrl = (plog && plog.recording_url) || null;
    } catch (_e) { /* recording_url column absent — fall through to the lookup */ }

    const key = await ensureRecordingInS3({
      jci: jobCallerInfoId, recording: row.recording, callUuid: row.unique_id, recordingUrl,
    });
    return key ? { key, reason: null } : { key: null, reason: 'no_recording' };
  } catch (e) {
    logger.warn('Recording resolve failed · jci=' + jobCallerInfoId + ' · ' + e.message);
    return { key: null, reason: 'recording_error' };
  }
}

module.exports = { ensureRecordingInS3, resolveRecordingKey };
