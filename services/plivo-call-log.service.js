const { pool } = require('../db');
const logger = require('../logger');

/*
 * services/plivo-call-log.service.js — writes the dedicated Plivo call-detail
 * log (tbl_plivo_call_log) ALONGSIDE the generic tbl_job_caller_info audit, so
 * Plivo calls can be reconciled/sliced on their own (count Plivo vs all, by
 * mode / flow / status / QA-redirect). EVERY function is FAIL-SOFT: a logging
 * error is swallowed (warn) and never propagates — call placement and the Plivo
 * callbacks must never break because of the log. Timestamps use SQL NOW() to
 * match tbl_job_caller_info's clock.
 *
 * Lifecycle: record() at start → markRinging/markAnswered on callbacks →
 * markTerminalByJci / markTerminalByCallUuid on hangup. Keyed off
 * job_caller_info_id (always known) or the Plivo CallUUID (web-hangup has no jci).
 */

const RECORD_COLS = [
  'job_caller_info_id', 'job_id', 'call_mode', 'call_flow', 'caller_user_id',
  'caller_name', 'receiver_name', 'receiver_number', 'dialed_number',
  'call_uuid', 'status',
];

// Insert one row at call start (initiated_on = NOW()). Returns id or null.
async function record(fields = {}) {
  try {
    const cols = RECORD_COLS.filter((c) => fields[c] !== undefined);
    const params = cols.map((c) => fields[c]);
    const sql = `INSERT INTO tbl_plivo_call_log (${cols.concat('initiated_on').join(', ')}) `
      + `VALUES (${cols.map(() => '?').concat('NOW()').join(', ')})`;
    const [r] = await pool.query(sql, params);
    return r.insertId;
  } catch (e) {
    logger.warn({ err: e.message, jci: fields.job_caller_info_id }, 'plivo-call-log: record failed (non-fatal)');
    return null;
  }
}

async function markRinging(jci, callUuid) {
  if (jci == null) return;
  try {
    await pool.query(
      `UPDATE tbl_plivo_call_log
          SET status = 'ringing', call_uuid = COALESCE(?, call_uuid), updated_on = NOW()
        WHERE job_caller_info_id = ?`,
      [callUuid || null, jci],
    );
  } catch (e) { logger.warn({ err: e.message, jci }, 'plivo-call-log: markRinging failed (non-fatal)'); }
}

async function markAnswered(jci, callUuid) {
  if (jci == null) return;
  try {
    await pool.query(
      `UPDATE tbl_plivo_call_log
          SET status = 'answered', answered_on = NOW(),
              call_uuid = COALESCE(?, call_uuid), updated_on = NOW()
        WHERE job_caller_info_id = ?`,
      [callUuid || null, jci],
    );
  } catch (e) { logger.warn({ err: e.message, jci }, 'plivo-call-log: markAnswered failed (non-fatal)'); }
}

async function markTerminalByJci(jci, { status, duration = null, hangupCause = null, callUuid = null } = {}) {
  if (jci == null) return;
  try {
    await pool.query(
      `UPDATE tbl_plivo_call_log
          SET status = ?, ended_on = NOW(), duration = ?, hangup_cause = ?,
              call_uuid = COALESCE(?, call_uuid), updated_on = NOW()
        WHERE job_caller_info_id = ?`,
      [status, duration, hangupCause, callUuid, jci],
    );
  } catch (e) { logger.warn({ err: e.message, jci }, 'plivo-call-log: markTerminalByJci failed (non-fatal)'); }
}

async function markTerminalByCallUuid(callUuid, { status, duration = null, hangupCause = null } = {}) {
  if (!callUuid) return;
  try {
    await pool.query(
      `UPDATE tbl_plivo_call_log
          SET status = ?, ended_on = NOW(), duration = ?, hangup_cause = ?, updated_on = NOW()
        WHERE call_uuid = ?`,
      [status, duration, hangupCause, callUuid],
    );
  } catch (e) { logger.warn({ err: e.message, callUuid }, 'plivo-call-log: markTerminalByCallUuid failed (non-fatal)'); }
}

module.exports = { record, markRinging, markAnswered, markTerminalByJci, markTerminalByCallUuid };
