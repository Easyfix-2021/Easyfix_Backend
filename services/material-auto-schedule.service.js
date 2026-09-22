/*
 * services/material-auto-schedule.service.js — auto-reschedule a job after
 * ANY client material-approval (client portal, public magic-link, or an
 * admin's on-behalf approval). See
 * docs/superpowers/specs/2026-09-21-material-request-flow-v2-design.md, the
 * 2026-09-22 amendment, "Auto-reschedule after ANY client approval".
 *
 * Owner rule: a scheduling failure must NEVER undo or fail the approval that
 * triggered it. scheduleAfterApproval() below therefore never throws — every
 * failure path (no technician, no open slot, an unexpected error) is caught,
 * logged, and recorded as a `needs_scheduling` row on the side table
 * tbl_job_auto_schedule (job.service.js's reschedule() clears it the next
 * time ANYONE successfully reschedules the job — see that function).
 *
 * Two pure helpers (baseDate, findSlot — plus startHourFor) are exported
 * separately because they are the part worth unit-testing in isolation: no
 * DB, no logger, deterministic in and out, same discipline as
 * services/time-slot.js and services/quotation-line-state.js.
 */

const { pool } = require('../db');
const logger = require('../logger');
const timeSlot = require('./time-slot');

// ─── IST wall-clock math — same +330-minute technique as job.service.js's
// _toIstDate / formatMysqlDateTimeIST. Self-contained (no cross-require) so
// this file stays pure and dependency-free like time-slot.js. ─────────────
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

function pad2(n) { return String(n).padStart(2, '0'); }

function istParts(instant) {
  const ist = new Date(instant.getTime() + IST_OFFSET_MS);
  return {
    y: ist.getUTCFullYear(), mo: ist.getUTCMonth() + 1, d: ist.getUTCDate(), h: ist.getUTCHours(),
  };
}

function dateStr(y, mo, d) {
  // Route the (y, mo-1, d) triple back through Date.UTC so an out-of-range
  // day (e.g. d=32) rolls into the next month correctly — used by both
  // baseDate (approval day + 1/+2) and addDaysToDateStr (day-rollover in
  // findSlot).
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/*
 * baseDate(approvedAtIST) → 'YYYY-MM-DD', the IST calendar date the
 * auto-reschedule search STARTS from.
 *
 * approvedAtIST is the approval INSTANT (a JS Date / anything `new Date()`
 * accepts) — explicitly converted to IST here (never the container TZ,
 * which on every deployed environment is UTC; see time-slot.js's header for
 * why this codebase never trusts the process timezone).
 *
 * Rule: approval day + 1, or + 2 when the IST wall-clock time is >= 15:00
 * (an approval that lands late in the day skips straight to day-after-next —
 * "+1 day" would otherwise offer a slot only a few hours away).
 */
function baseDate(approvedAtIST) {
  const at = (approvedAtIST instanceof Date) ? approvedAtIST : new Date(approvedAtIST);
  const p = istParts(at);
  const addDays = p.h >= 15 ? 2 : 1;
  return dateStr(p.y, p.mo, p.d + addDays);
}

function addDaysToDateStr(dateStrValue, n) {
  const [y, mo, d] = dateStrValue.split('-').map(Number);
  return dateStr(y, mo, d + n);
}

/*
 * startHourFor(requestedDateTime) → the hour (9-18) the slot search starts
 * on its FIRST day, or 9 when there is nothing usable to anchor on:
 *   - the midnight sentinel / no time-of-day at all (time-slot.hasTimeOfDay)
 *   - a hour outside time-slot.SLOT_START_HOURS (9..18) — a legacy row with
 *     an odd stored hour, or an After-Hours booking.
 */
function startHourFor(requestedDateTime) {
  if (!timeSlot.hasTimeOfDay(requestedDateTime)) return 9;
  const h = timeSlot.slotHour(requestedDateTime);
  if (h == null || !timeSlot.SLOT_START_HOURS.includes(h)) return 9;
  return h;
}

/*
 * findSlot(startDate, startHour, busyFrames, days=7) → { date, hour } | null
 *
 * Pure search: try (startDate, startHour), then later hours the SAME day up
 * to 18, then each subsequent day from 9 through 18, for `days` calendar
 * days total. Returns the first (date, hour) frame not present in
 * `busyFrames`; null when every frame in the window is busy.
 *
 * `busyFrames` is a Set (or any iterable) of `${date}|${hour}` keys — the
 * caller builds it from time-slot.conflictFrame() over the technician's
 * other open jobs, so this function never has to know what a "conflict" is.
 */
function findSlot(startDate, startHour, busyFrames, days = 7) {
  const busy = busyFrames instanceof Set ? busyFrames : new Set(busyFrames);
  for (let dayOffset = 0; dayOffset < days; dayOffset++) {
    const date = dayOffset === 0 ? startDate : addDaysToDateStr(startDate, dayOffset);
    const fromHour = dayOffset === 0 ? startHour : 9;
    for (let h = fromHour; h <= 18; h++) {
      const key = `${date}|${h}`;
      if (!busy.has(key)) return { date, hour: h };
    }
  }
  return null;
}

// ─── DB-backed orchestration ──────────────────────────────────────────────

// The exact reason text the design spec gives, seeded into action_taken_reason
// (action_type = 8 — the same "Reschedule" bucket services/lookup.service.js's
// rescheduleReasons() reads) by
// migrations/2026-09-22-material-approval-auto-schedule.sql. Deliberately NOT
// the string "Auto Rescheduled" the magic-link-open feature's chip detector
// matches on (job.service.js LIST_COLUMNS `auto_rescheduled`) — that is a
// different feature with its own stable token; this one is its own.
const AUTO_RESCHEDULE_REASON = 'Material Approved — Auto Reschedule';

async function autoRescheduleReasonId() {
  try {
    const [[row]] = await pool.query(
      `SELECT id FROM action_taken_reason WHERE action_type = 8 AND action_desc = ? LIMIT 1`,
      [AUTO_RESCHEDULE_REASON],
    );
    return row ? row.id : null;
  } catch (e) {
    logger.warn({ err: e && e.message }, 'material-auto-schedule: reason lookup failed (non-fatal)');
    return null;
  }
}

/*
 * Best-effort upsert of the needs_scheduling flag. job_id is the PK, so a
 * second raise (a job that fails to schedule twice) replaces the row rather
 * than erroring, and re-opens cleared_at (a job that was cleared and then
 * needs scheduling again must not still read as cleared).
 */
async function setNeedsScheduling(jobId, reason) {
  await pool.query(
    `INSERT INTO tbl_job_auto_schedule (job_id, status, reason, created_at, cleared_at)
     VALUES (?, 'needs_scheduling', ?, ?, NULL)
     ON DUPLICATE KEY UPDATE status = 'needs_scheduling', reason = VALUES(reason),
       created_at = VALUES(created_at), cleared_at = NULL`,
    [jobId, String(reason || '').slice(0, 250), new Date()],
  );
}

/*
 * scheduleAfterApproval(jobId) → { rescheduled, requestedDateTime, needsScheduling }
 *
 * NEVER THROWS — every failure path is caught, logged, and recorded via
 * setNeedsScheduling so the job is never silently dropped. Callers (the
 * shared approval helper, services/job-estimate-approval.js) can therefore
 * call this unconditionally right after an approval commits.
 */
async function scheduleAfterApproval(jobId) {
  try {
    const [[j]] = await pool.query(
      `SELECT job_id, fk_easyfixter_id, requested_date_time FROM tbl_job WHERE job_id = ? LIMIT 1`,
      [jobId],
    );
    if (!j) throw new Error('job not found');
    if (!j.fk_easyfixter_id) {
      await setNeedsScheduling(jobId, 'No technician assigned');
      return { rescheduled: false, requestedDateTime: null, needsScheduling: true };
    }

    const startDate = baseDate(new Date());
    const startHour = startHourFor(j.requested_date_time);
    const windowEnd = addDaysToDateStr(startDate, 6);

    // Same OPEN-job conflict definition candidate-ranking.service.js uses:
    // job_status IN (0,1,2), the midnight-sentinel excluded
    // (TIME(...) <> '00:00:00'), this job excluded (job_id <> ?). One query
    // over the whole 7-day window.
    const [busyRows] = await pool.query(
      `SELECT requested_date_time FROM tbl_job
        WHERE fk_easyfixter_id = ?
          AND job_status IN (0, 1, 2)
          AND job_id <> ?
          AND requested_date_time IS NOT NULL
          AND TIME(requested_date_time) <> '00:00:00'
          AND DATE(requested_date_time) BETWEEN ? AND ?`,
      [j.fk_easyfixter_id, jobId, startDate, windowEnd],
    );
    const busyFrames = new Set(
      busyRows
        .map((r) => timeSlot.conflictFrame(r.requested_date_time))
        .filter(Boolean)
        .map((f) => `${f.date}|${f.hour}`),
    );

    const slot = findSlot(startDate, startHour, busyFrames, 7);
    if (!slot) {
      await setNeedsScheduling(jobId, 'No available slot in the next 7 days');
      return { rescheduled: false, requestedDateTime: null, needsScheduling: true };
    }

    const requestedDateTime = `${slot.date} ${pad2(slot.hour)}:00`;
    const reasonId = await autoRescheduleReasonId();
    // System-initiated — no tbl_user actor (and never a client-contact id in
    // a tbl_user FK; see reschedule()'s own actor handling). reschedule()
    // already COALESCEs a null actor's user_id, preserving the prior
    // scheduler on fk_scheduled_by.
    // eslint-disable-next-line global-require
    await require('./job.service').reschedule(
      jobId,
      {
        requestedDateTime,
        reasonId,
        rescheduleReason: AUTO_RESCHEDULE_REASON,
        remarks: 'Auto-rescheduled after the material quotation was approved.',
      },
      null,
    );
    return { rescheduled: true, requestedDateTime, needsScheduling: false };
  } catch (e) {
    logger.warn({ jobId, err: e && e.message }, 'material-auto-schedule: scheduling failed — flagging needs_scheduling');
    try {
      await setNeedsScheduling(jobId, `Auto-schedule failed: ${e && e.message ? e.message : e}`);
    } catch (e2) {
      logger.warn({ jobId, err: e2 && e2.message }, 'material-auto-schedule: failed to record needs_scheduling flag');
    }
    return { rescheduled: false, requestedDateTime: null, needsScheduling: true };
  }
}

module.exports = {
  AUTO_RESCHEDULE_REASON,
  baseDate,
  startHourFor,
  findSlot,
  addDaysToDateStr,
  scheduleAfterApproval,
};
