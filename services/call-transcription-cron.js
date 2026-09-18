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

// Plivo bills every transcript as at least one full minute ($0.0095), so a call
// this short — operator "number not in service", ring-out, instant hang-up —
// costs the same as a real 60 s conversation and yields nothing to analyse.
// Measured 2026-09-17: 359 of 4,104 transcripts were under 15 s.
const MIN_TRANSCRIBE_SECONDS = 15;

/*
 * The ONE writer for a fetched transcript — used by this cron, the lazy
 * transcript fetch on recording playback and on-demand View Analysis
 * (routes/admin/calls.js). The cost is a SECOND, best-effort statement so a
 * deploy that lands before 2026-09-17-add-plivo-transcription-cost.sql still
 * stores the transcript itself; only the cost is lost until the column exists.
 */
async function saveTranscript(jobCallerInfoId, tx) {
  await pool.query(
    "UPDATE tbl_plivo_call_log SET transcription = ?, transcription_status = 'completed', transcription_fetched_at = ? WHERE job_caller_info_id = ?",
    [tx.text, new Date(), jobCallerInfoId],
  );
  if (tx.cost == null) return;
  await pool.query(
    'UPDATE tbl_plivo_call_log SET transcription_cost_usd = ? WHERE job_caller_info_id = ?',
    [tx.cost, jobCallerInfoId],
  ).catch((e) => logger.warn('transcription cost not stored · jci=' + jobCallerInfoId + ' · ' + e.message));
}

/*
 * Fill transcription_cost_usd for transcripts stored BEFORE the cost was
 * captured (all of them up to 2026-09-17), plus any saved while the column was
 * not yet migrated. The per-transcript GET that saveTranscript() reads is keyed
 * by recording, so instead this walks Plivo's Transcription LIST (newest first,
 * 20 a page, carries call_uuid + transcription_cost) and matches call_uuid to
 * tbl_job_caller_info.unique_id — one pass over the history, not one GET per row.
 *
 * Runs from its OWN scheduler job — once a day, because a transcript stores its
 * own cost as it is saved and this only catches a miss — and not from the
 * transcript cron, because it is
 * independent of plivo.transcription.enabled: a charge Plivo already made
 * belongs on the row even when new transcription is switched off. It only READS
 * Plivo's list — it never requests a transcript, so it cannot spend anything.
 *
 * A call Plivo has no transcription for would send every run back down the whole
 * list, so an unmatched call_uuid is remembered for the life of the process and
 * skipped. That is why this is not a once-per-process flag: rows that appear
 * LATER are still picked up, and a restart re-tries the unmatched ones.
 * Stops at the oldest row still missing a cost (less a day: inserted_time is
 * IST-naive, Plivo's add_time is UTC, and a transcript is requested after the
 * call). Both pcl rows of a conference call share the jci, so both get the cost.
 */
const unmatchedCallUuids = new Set();

async function backfillTranscriptionCosts({ shouldStop = null } = {}) {
  let rows;
  try {
    [rows] = await pool.query(
      `SELECT DISTINCT jci.unique_id AS callUuid, jci.inserted_time AS insertedAt
         FROM tbl_plivo_call_log pcl
         JOIN tbl_job_caller_info jci ON jci.job_caller_info = pcl.job_caller_info_id
        WHERE pcl.transcription_status = 'completed'
          AND pcl.transcription_cost_usd IS NULL
          AND jci.unique_id IS NOT NULL`,
    );
  } catch (e) {
    return { skipped: true, reason: 'transcription_cost_usd missing? ' + e.message };
  }
  const fresh = rows.filter((r) => !unmatchedCallUuids.has(r.callUuid));
  const want = new Set(fresh.map((r) => r.callUuid));
  const result = {
    missing: rows.length, filled: 0, pages: 0, stopped: false,
    knownUnmatched: rows.length - fresh.length,
  };
  if (!want.size) return result;
  const floorMs = Math.min(...fresh.map((r) => new Date(r.insertedAt).getTime())) - 24 * 60 * 60 * 1000;

  for (let offset = 0; want.size; offset += 20) {
    if (typeof shouldStop === 'function' && shouldStop()) { result.stopped = true; break; }
    const objects = await plivo.listPage(`/Transcription/?limit=20&offset=${offset}`);
    result.pages += 1;
    for (const o of objects) {
      // Newest first, so a re-requested transcript's latest charge wins.
      if (!want.has(o.call_uuid) || o.transcription_cost == null) continue;
      want.delete(o.call_uuid);
      const [r] = await pool.query(
        `UPDATE tbl_plivo_call_log pcl
           JOIN tbl_job_caller_info jci ON jci.job_caller_info = pcl.job_caller_info_id
            SET pcl.transcription_cost_usd = ?
          WHERE jci.unique_id = ? AND pcl.transcription_cost_usd IS NULL`,
        [Number(o.transcription_cost), o.call_uuid],
      );
      if (r.affectedRows) result.filled += 1;
    }
    if (objects.length < 20 || plivo.plivoTimeMs(objects[objects.length - 1].add_time) < floorMs) break;
  }
  // Whatever the walk did not find has no transcription on Plivo under that
  // call_uuid; remember it so the next run does not re-read the whole list.
  if (!result.stopped) for (const u of want) unmatchedCallUuids.add(u);
  result.unmatched = want.size;
  return result;
}

/*
 * `shouldStop` — the cooperative-cancellation checkpoint, same contract as
 * services/recording-backfill.service.js. Polled BETWEEN rows, never mid-row: a
 * row is up to three sequential Plivo calls (recording lookup → transcript GET →
 * create POST) and a write, and abandoning it after the POST but before the
 * 'processing' UPDATE would request a second transcription next run. Stopping
 * between rows loses nothing — the next run re-selects whatever is still
 * un-transcribed. Optional and defaulted; existing callers are unaffected.
 */
async function runTranscriptionBackfill({ limit = 50, shouldStop = null } = {}) {
  if (!plivo.transcriptionEnabled()) {
    return { skipped: true, reason: 'plivo.transcription.enabled is off' };
  }

  let rows;
  try {
    [rows] = await pool.query(
      /*
       * ONE ROW PER CALL. A conference call has a tbl_plivo_call_log row per LEG
       * — services/plivo-conference.service.js inserts the participant's leg with
       * the SAME job_caller_info_id, and idx_plivo_log_jci is deliberately a plain
       * KEY (2026-08-04-create-tbl-job-conference.sql) — so an ungrouped JOIN
       * returns that call once per leg. Each duplicate re-ran the whole row: two
       * more Plivo GETs and a repeat UPDATE, and the duplicates ate the LIMIT, so
       * a batch of 50 could cover fewer than 50 calls. The writes are all keyed on
       * job_caller_info_id, so one pass still fills every leg's row.
       */
      `SELECT jci.job_caller_info AS id, jci.unique_id AS callUuid,
              MAX(pcl.transcription_status) AS status, MAX(pcl.transcription_fetched_at) AS lastAt
         FROM tbl_job_caller_info jci
         JOIN tbl_plivo_call_log pcl ON pcl.job_caller_info_id = jci.job_caller_info
        WHERE jci.provider = 'plivo'
          AND jci.unique_id IS NOT NULL
          AND jci.caller_status IN ('completed', 'hungup')
          AND jci.duration >= ?
          AND (pcl.transcription IS NULL OR pcl.transcription = '')
          AND (pcl.transcription_status IS NULL OR pcl.transcription_status NOT IN ('completed', 'not_available'))
        GROUP BY jci.job_caller_info, jci.unique_id, jci.inserted_time
        ORDER BY jci.inserted_time DESC
        LIMIT ?`,
      [MIN_TRANSCRIBE_SECONDS, limit],
    );
  } catch (e) {
    // Columns may not exist yet (pre-migration) — treat as a no-op.
    logger.warn('transcription-backfill query failed (columns present?) · ' + e.message);
    return { skipped: true, reason: 'transcription columns missing' };
  }

  const result = { eligible: rows.length, completed: 0, requested: 0, notAvailable: 0, pending: 0, failed: 0, stopped: false };
  for (const [i, r] of rows.entries()) {
    // First statement of the body, so the `continue` on the not-ready path
    // cannot skip it.
    if (typeof shouldStop === 'function' && shouldStop()) {
      result.stopped = true;
      logger.warn(`transcription-backfill: stop requested — halting after ${i} of ${rows.length} row(s)`);
      break;
    }
    try {
      const meta = await plivo.fetchRecordingMeta({ callUuid: r.callUuid });
      if (!meta.ok || !meta.recordingId) {
        // Recording not ready yet — leave pending for a later run.
        result.pending += 1;
        continue;
      }
      const tx = await plivo.fetchTranscription({ recordingId: meta.recordingId });
      if (tx.ok && tx.text) {
        await saveTranscript(r.id, tx);
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
              "UPDATE tbl_plivo_call_log SET transcription_status = 'processing', transcription_fetched_at = ? WHERE job_caller_info_id = ?",
              [new Date(), r.id],
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

module.exports = { runTranscriptionBackfill, saveTranscript, backfillTranscriptionCosts, MIN_TRANSCRIBE_SECONDS };
