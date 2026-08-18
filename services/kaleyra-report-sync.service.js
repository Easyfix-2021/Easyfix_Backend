const { pool } = require('../db');
const logger = require('../logger');
const kaleyra = require('./kaleyra.service');

/*
 * Periodic backfill of Kaleyra call metadata into tbl_job_caller_info.
 *
 * Click2call only returns a uniqueId synchronously — duration, recording,
 * status, start/end timestamps land in Kaleyra's report endpoint and have
 * to be polled. Legacy CRM ran this hourly; we run every 4 hours per
 * operator preference, set by the scheduler in server/scheduler.js.
 *
 * Query window: rows inserted within the last 4 days where is_updated=0.
 * The 4-day cap protects against the table accumulating forever-stuck
 * rows from calls that Kaleyra never reports on (e.g. test calls, calls
 * placed during a Kaleyra outage). After 4 days a row stays at
 * is_updated=0 forever; ops can manually mark them or just ignore.
 *
 * Throttle: ~200ms between Kaleyra calls so a 100-row backfill doesn't
 * burst-spam their API.
 *
 * Idempotency: the cron is safe to run concurrently with the legacy CRM
 * scheduler. Both query `WHERE is_updated=0`; last writer wins. Field
 * values come from the same Kaleyra response so the result is identical.
 * See plan file production-cutover-prerequisites for the full analysis.
 */

const WINDOW_DAYS = 4;
const THROTTLE_MS = 200;
const MAX_PER_RUN = 200;   // safety belt — if 200 rows piled up between runs
                           // we still finish in ~40s rather than minutes

async function syncPendingReports() {
  logger.info(`Kaleyra report sync starting · windowDays=${WINDOW_DAYS} · maxPerRun=${MAX_PER_RUN}`);
  // Fetch the work list. ORDER BY oldest-first so a row that has been
  // pending the longest gets attention first if MAX_PER_RUN clips us.
  // provider filter (2026-06-17): only reconcile Kaleyra rows here. Plivo rows
  // carry a Plivo CallUUID in unique_id and are kept current by the Plivo
  // status webhooks (ring/answer/hangup) — querying Kaleyra's report endpoint
  // with a Plivo uuid would always miss. `provider IS NULL` covers legacy rows
  // written before the provider column was populated (all Kaleyra historically).
  const [rows] = await pool.query(
    `SELECT job_caller_info, unique_id, inserted_time
       FROM tbl_job_caller_info
      WHERE is_updated = 0
        AND unique_id IS NOT NULL
        AND (provider = 'kaleyra' OR provider IS NULL)
        AND inserted_time >= NOW() - INTERVAL ? DAY
      ORDER BY inserted_time ASC
      LIMIT ?`,
    [WINDOW_DAYS, MAX_PER_RUN]
  );

  logger.info(`Found ${rows.length} pending caller-info rows to reconcile`);
  let updated = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const { ok, report } = await kaleyra.getCallReport({ uniqueId: row.unique_id });
      // Kaleyra returns a 200 with empty data[] for calls it hasn't
      // reconciled yet — distinguish that from a hard failure so we
      // don't flip is_updated=1 prematurely.
      if (!ok || !report) {
        failed += 1;
        continue;
      }
      await applyReportToRow(row.job_caller_info, report);
      updated += 1;
    } catch (err) {
      failed += 1;
      logger.warn(`Kaleyra sync row ${row.job_caller_info} failed: ${err.message}`);
    }
    // Throttle BEFORE next iteration (not after last) — but the cost of
    // an extra 200ms on the final row is negligible vs. the complexity
    // of an early-exit guard.
    await sleep(THROTTLE_MS);
  }
  logger.info(`Kaleyra report sync done · checked=${rows.length} · updated=${updated} · failed=${failed}`);
  return { checked: rows.length, updated, failed };
}

async function applyReportToRow(jobCallerInfoId, report) {
  // Column mapping mirrors the legacy ContactUserServiceImpl.
  // Kaleyra's response keys vary slightly between API versions; we read
  // multiple candidate keys for each column and take the first non-empty
  // one, matching the legacy parser's defensiveness.
  const startTime  = report.callstart || report.start_time || null;
  const endTime    = report.callend   || report.end_time   || null;
  const duration   = pickInt(report.billsec, report.duration);
  const callerSt   = report.callerstate   || report.caller_status   || null;
  const receiverSt = report.calleestate   || report.receiver_status || report.reciever_status || null;
  const recording  = report.recording || report.recording_url || null;
  const location   = report.location  || null;
  /*
   * `report.provider` is DELIBERATELY NOT READ (2026-08-19).
   *
   * It is Kaleyra's TELECOM CARRIER for the leg — 'JIO', 'Airtel', 'Vodafone',
   * 'IDEA', 'BSNL' — not the voice VENDOR that placed the call, which is the
   * only thing tbl_job_caller_info.provider means to the rest of the system.
   * Writing it through `provider = COALESCE(?, provider)` could overwrite a
   * correct 'kaleyra' stamp with 'Airtel', and that is almost certainly where
   * the ~2,721 carrier-valued rows measured in 2021 came from (the count and
   * the analysis live above PROVIDER_RULE in
   * services/quicksight/quicksight-call-tracking.service.js).
   *
   * There is nothing to lose by dropping the write: the work-list query above
   * only ever selects rows that are ALREADY known to be Kaleyra's
   * (provider = 'kaleyra' OR provider IS NULL), so this cron can never learn a
   * vendor it did not already know. Every write it could make is either a
   * no-op or the corruption described.
   *
   * It does NOT back-stamp 'kaleyra' onto the NULL rows either. "Unstamped
   * means Kaleyra" is an INFERENCE the report makes and marks as inferred; a
   * cron that wrote it into the column would turn that inference into an
   * assertion no later reader could tell apart from a real stamp.
   */

  await pool.query(
    `UPDATE tbl_job_caller_info
        SET start_time      = ?,
            end_time        = ?,
            duration        = ?,
            caller_status   = ?,
            reciever_status = ?,
            recording       = ?,
            location        = ?,
            is_updated      = 1
      WHERE job_caller_info = ?`,
    [startTime, endTime, duration, callerSt, receiverSt, recording, location, jobCallerInfoId]
  );
  logger.info(`Caller-info updated · id=${jobCallerInfoId} · duration=${duration ?? '—'}`);
}

function pickInt(...values) {
  for (const v of values) {
    if (v == null || v === '') continue;
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { syncPendingReports };
