const { pool } = require('../db');
const logger = require('../logger');
const fcmService = require('./fcm.service');
// Reuse the canonical dual-source token resolver (tbl_easyfixer_app.device_id +
// device_info.fire_base_token) rather than cloning it a 4th time.
const { resolveTokens } = require('./registration-status-push.service');

/*
 * Attendance-reminder cron (2026-06-28).
 *
 * Daily morning push that nudges every ACTIVE + VERIFIED technician who has NOT
 * yet marked their attendance for TODAY to open the app and mark it — so the
 * auto-assignment engine has an accurate availability picture.
 *
 * Companion to the in-app "mark attendance" popup the technician app shows on
 * open (both read the same predicate: attendance unmarked for the IST day).
 *
 * Token routing: the canonical dual-source resolver (resolveTokens) — reads
 * tbl_easyfixer_app.device_id first, then device_info.fire_base_token. Dead
 * tokens FCM reports (404 UNREGISTERED) are pruned from both stores.
 *
 * Best-effort by contract: per-tech failures are counted + logged, never abort
 * the loop; the top level swallows so a cron tick can't crash the process.
 */

const PUSH_TITLE = 'Mark Your Attendance';
const PUSH_BODY = "You haven't marked your attendance for today. Tap to mark it and keep receiving jobs.";
const PUSH_DATA = { type: 'attendance_reminder' };

// Attendance day key is the IST calendar date (the app marks with the IST day,
// NOT the DB server's CURDATE() which may be UTC). en-CA → YYYY-MM-DD.
function istDateString(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

// Clear a token FCM reported as dead from BOTH stores so fan-out stops
// targeting it (registration-status-push keeps this private, so a small local
// copy — same statements).
async function pruneDeadToken(efrId, token) {
  if (!efrId || !token) return;
  try {
    await pool.query(
      "UPDATE device_info SET fire_base_token = NULL, is_logged_in = '0' WHERE user_id = ? AND fire_base_token = ?",
      [efrId, token],
    );
    await pool.query(
      'UPDATE tbl_easyfixer_app SET device_id = NULL WHERE efr_id = ? AND device_id = ?',
      [efrId, token],
    );
    logger.push('attendance-reminder · pruned dead token · efr=' + efrId);
  } catch (e) {
    logger.warn({ efrId, err: e.message }, 'attendance-reminder: dead-token prune failed');
  }
}

// Push the reminder to ONE technician across all their device tokens. Returns
// { delivered } — delivered true if at least one token took the push.
async function pushTo(efrId) {
  const tokens = await resolveTokens(efrId);
  if (!tokens.length) return { delivered: false, skipped: true };

  const results = await Promise.all(
    tokens.map((token) =>
      fcmService
        .sendPush({ token, title: PUSH_TITLE, body: PUSH_BODY, data: PUSH_DATA })
        // Pair the token back with its result — sendPush() doesn't echo it, and
        // pruneDeadToken needs to know WHICH token died.
        .then((r) => ({ token, ...(r || {}) }))
        .catch((e) => ({ token, delivered: false, error: e.message })),
    ),
  );

  let delivered = 0;
  for (const r of results) {
    if (r.deadToken && !r.redirected) await pruneDeadToken(efrId, r.token);
    if (r.delivered) delivered += 1;
  }
  return { delivered: delivered > 0, deliveredCount: delivered };
}

/*
 * Daily run — find techs who haven't marked TODAY (IST) and push them a reminder.
 * "Marked" = an attendance row for the IST day with a slot present OR leave set;
 * leave-markers are excluded (they've already declared their availability).
 */
async function runDailyReminder() {
  const t0 = Date.now();
  const today = istDateString(0);
  logger.info('Run attendance-reminder cron · day=' + today);

  let rows;
  try {
    [rows] = await pool.query(
      `SELECT e.efr_id,
              COALESCE(NULLIF(TRIM(e.efr_name), ''),
                       NULLIF(TRIM(CONCAT_WS(' ', e.efr_first_name, e.efr_last_name)), ''),
                       'Technician') AS name
         FROM tbl_easyfixer e
        WHERE e.efr_status = 1
          AND COALESCE(e.is_technician_verified, 0) = 1
          AND e.efr_no IS NOT NULL
          AND TRIM(e.efr_no) <> ''
          AND NOT EXISTS (
                SELECT 1
                  FROM tbl_easyfixer_attendance ea
                 WHERE ea.easyfixer_id = e.efr_id
                   AND ea.created_on = ?
                   AND (ea.morning_slot = 1 OR ea.evening_slot = 1 OR ea.is_leave_marked = 1)
              )`,
      [today],
    );
  } catch (e) {
    logger.error('attendance-reminder: eligibility query failed · ' + e.message);
    return { eligible: 0, attempted: 0, succeeded: 0, failed: 0, skipped: 0, error: e.message };
  }

  logger.info('Found ' + rows.length + ' technicians unmarked for ' + today);

  const summary = { eligible: rows.length, attempted: 0, succeeded: 0, failed: 0, skipped: 0 };
  // Bounded concurrency — fan out in fixed-size chunks (mirrors notice-push) so a
  // few-thousand-tech audience drains in tens of seconds, not minutes, without
  // opening thousands of simultaneous DB/FCM calls.
  const CONCURRENCY = 15;
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const chunk = rows.slice(i, i + CONCURRENCY);
    const outcomes = await Promise.all(
      chunk.map(async (row) => {
        try {
          const res = await pushTo(row.efr_id);
          return res.skipped ? 'skipped' : res.delivered ? 'succeeded' : 'failed';
        } catch (err) {
          logger.warn('attendance-reminder · efr_id=' + row.efr_id + ' · push crashed: ' + err.message);
          return 'failed';
        }
      }),
    );
    summary.attempted += chunk.length;
    for (const o of outcomes) summary[o] += 1;
  }

  logger.info(
    'Attendance-reminder cron complete · eligible=' + summary.eligible +
    ' · succeeded=' + summary.succeeded + ' · failed=' + summary.failed +
    ' · skipped=' + summary.skipped + ' · took_ms=' + (Date.now() - t0),
  );
  return summary;
}

/*
 * Trigger-Now test. Sends the SAME reminder push for a given easyfixer (efr_id)
 * to THEIR registered device — in a test environment with TEST_FCM_TOKEN set,
 * fcm.service redirects every send to that operator token, so the push lands on
 * the operator's device, never the real tech. Read-only otherwise (no prune).
 */
async function runTest({ sourceId } = {}) {
  const idRaw = sourceId == null ? '' : String(sourceId).trim();
  if (!idRaw) {
    logger.warn('attendance-reminder TEST rejected · sourceId (efr_id) required');
    throw Object.assign(new Error('Easyfixer ID (efr_id) is required to test the attendance reminder push.'), {
      status: 400, code: 'SOURCE_ID_REQUIRED',
    });
  }
  const efrId = Number(idRaw);
  if (!Number.isInteger(efrId) || efrId <= 0) {
    throw Object.assign(new Error('Easyfixer ID must be a positive integer.'), {
      status: 400, code: 'INVALID_SOURCE_ID',
    });
  }

  const [[row]] = await pool.query(
    `SELECT efr_id,
            COALESCE(NULLIF(TRIM(efr_name), ''), 'Technician') AS name
       FROM tbl_easyfixer WHERE efr_id = ? LIMIT 1`,
    [efrId],
  );
  if (!row) {
    throw Object.assign(new Error('No easyfixer found with id ' + efrId + '.'), {
      status: 404, code: 'EASYFIXER_NOT_FOUND',
    });
  }

  const tokens = await resolveTokens(efrId);
  logger.info('attendance-reminder TEST · efr_id=' + efrId + ' · tokens=' + tokens.length);
  if (!tokens.length) {
    return { test: true, source: { efr_id: efrId, name: row.name }, tokens: 0, delivered: false, note: 'no device tokens for this easyfixer' };
  }

  let delivered = false;
  let last = null;
  for (const token of tokens) {
    last = await fcmService.sendPush({ token, title: PUSH_TITLE, body: PUSH_BODY, data: PUSH_DATA })
      .catch((e) => ({ delivered: false, error: e.message }));
    if (last && last.delivered) delivered = true;
  }
  return {
    test: true,
    source: { efr_id: efrId, name: row.name },
    tokens: tokens.length,
    delivered,
    disabled: !!(last && last.disabled),
    redirected_to_test_token: !!(last && last.redirected),
    http_status: (last && last.httpStatus) || null,
    error: (last && last.error) || null,
  };
}

module.exports = { runDailyReminder, runTest };
