/*
 * services/visit-slots.service.js — the client-chosen visit slot picker
 * (Material Request Flow v2, 2026-09-22 owner correction: "never
 * pre-assume the next visit date"). Replaces the same-day auto-reschedule
 * amendment (baseDate/findSlot/3PM rule, tbl_job_auto_schedule) that a
 * PREVIOUS session on this branch built and the owner then rejected —
 * see the design doc's dated 2026-09-22 section for the story. The client
 * now PICKS the visit date/time themselves; this file only tells them
 * which hours are free and validates the one they pick.
 *
 * Reuses, rather than re-derives, two already-owned definitions:
 *   time-slot.js#SLOT_START_HOURS   the 9..18 bookable hours
 *   time-slot.js#conflictFrame      the SAME 1-hour booking-conflict frame
 *                                   candidate-ranking.service.js's hard
 *                                   filter uses (open-status set 0/1/2,
 *                                   midnight-sentinel excluded, this job
 *                                   excluded) — one query over the window,
 *                                   never a per-hour round trip.
 *   utils/ist-calendar.js#todayIst / shiftYmd
 *                                   the IST calendar-date math (Asia/Kolkata
 *                                   EXPLICITLY, never the container TZ,
 *                                   which is UTC on every deployed env).
 */

const { pool } = require('../db');
const timeSlot = require('./time-slot');
const { todayIst, shiftYmd } = require('../utils/ist-calendar');

const WINDOW_DAYS = 30;
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** The current IST hour (0-23) — the ONE thing ist-calendar.js doesn't already give. */
function currentIstHour(now) {
  return new Date(now.getTime() + IST_OFFSET_MS).getUTCHours();
}

/*
 * The technician's OTHER open jobs inside [startDate, endDate], as a
 * `${date}|${hour}` frame Set — the same booking-conflict definition
 * candidate-ranking.service.js's hard filter uses (see its own header for
 * why: SAME 1-hour frame = conflict, not a sliding window; the midnight
 * sentinel and this job itself are excluded). One query for the whole
 * window, never one per hour.
 */
async function busyFramesFor(technicianId, jobId, startDate, endDate) {
  if (!technicianId) return new Set();
  const [rows] = await pool.query(
    `SELECT requested_date_time FROM tbl_job
      WHERE fk_easyfixter_id = ?
        AND job_status IN (0, 1, 2)
        AND job_id <> ?
        AND requested_date_time IS NOT NULL
        AND TIME(requested_date_time) <> '00:00:00'
        AND DATE(requested_date_time) BETWEEN ? AND ?`,
    [technicianId, Number(jobId) || 0, startDate, endDate],
  );
  return new Set(
    rows
      .map((r) => timeSlot.conflictFrame(r.requested_date_time))
      .filter(Boolean)
      .map((f) => `${f.date}|${f.hour}`),
  );
}

/*
 * listVisitSlots(jobId, { days, now }) →
 *   { technician_id, days: [ { date: 'YYYY-MM-DD', hours: [ { hour, free } ] } ] }
 *
 * hours are time-slot.SLOT_START_HOURS (9..18); dates run today..today+days-1
 * in IST. Today's hours at or before the current IST hour are OMITTED — they
 * are already past, not merely "busy". No technician on the job → every hour
 * in the window is free (nothing to conflict with yet).
 */
async function listVisitSlots(jobId, { days = WINDOW_DAYS, now = new Date() } = {}) {
  const [[j]] = await pool.query(
    'SELECT fk_easyfixter_id FROM tbl_job WHERE job_id = ? LIMIT 1', [Number(jobId)],
  );
  if (!j) { const e = new Error('job not found'); e.status = 404; throw e; }
  const technicianId = j.fk_easyfixter_id || null;

  const startDate = todayIst(now);
  const endDate = shiftYmd(startDate, days - 1);
  const currentHour = currentIstHour(now);
  const busy = await busyFramesFor(technicianId, jobId, startDate, endDate);

  const out = [];
  for (let i = 0; i < days; i++) {
    const date = i === 0 ? startDate : shiftYmd(startDate, i);
    const hours = timeSlot.SLOT_START_HOURS
      .filter((h) => !(date === startDate && h <= currentHour))
      .map((h) => ({ hour: h, free: !busy.has(`${date}|${h}`) }));
    out.push({ date, hours });
  }
  return { technician_id: technicianId, days: out };
}

/* 'YYYY-MM-DD HH:00:00' → { date, hour } | null. Any other shape is rejected. */
function parseVisitDateTime(visitDateTime) {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}):00:00$/.exec(String(visitDateTime || '').trim());
  if (!m) return null;
  return { date: m[1], hour: Number(m[2]) };
}

/*
 * assertSlotBookable(jobId, visitDateTime, now) — the ONE gate every approve
 * path runs BEFORE writing anything. Throws {status, message}:
 *   400 "Pick a visit time between 9 AM and 6 PM"   — bad format / hour outside 9..18
 *   400 "Pick a future visit time within 30 days"   — in the past/current hour, or beyond the window
 *   409 "That slot was just booked — pick another"  — the technician's frame is now busy
 * Resolves silently (no throw) when the slot is bookable.
 */
async function assertSlotBookable(jobId, visitDateTime, now = new Date()) {
  const parsed = parseVisitDateTime(visitDateTime);
  if (!parsed || !timeSlot.SLOT_START_HOURS.includes(parsed.hour)) {
    const e = new Error('Pick a visit time between 9 AM and 6 PM'); e.status = 400; throw e;
  }

  const startDate = todayIst(now);
  const maxDate = shiftYmd(startDate, WINDOW_DAYS - 1);
  const currentHour = currentIstHour(now);
  const isPastOrCurrent = parsed.date < startDate
    || (parsed.date === startDate && parsed.hour <= currentHour);
  const isBeyondWindow = parsed.date > maxDate;
  if (isPastOrCurrent || isBeyondWindow) {
    const e = new Error('Pick a future visit time within 30 days'); e.status = 400; throw e;
  }

  const [[j]] = await pool.query(
    'SELECT fk_easyfixter_id FROM tbl_job WHERE job_id = ? LIMIT 1', [Number(jobId)],
  );
  if (!j) { const e = new Error('job not found'); e.status = 404; throw e; }
  if (!j.fk_easyfixter_id) return; // no technician → every hour free

  const [rows] = await pool.query(
    `SELECT 1 FROM tbl_job
      WHERE fk_easyfixter_id = ?
        AND job_status IN (0, 1, 2)
        AND job_id <> ?
        AND requested_date_time IS NOT NULL
        AND TIME(requested_date_time) <> '00:00:00'
        AND DATE(requested_date_time) = ?
        AND HOUR(requested_date_time) = ?
      LIMIT 1`,
    [j.fk_easyfixter_id, Number(jobId) || 0, parsed.date, parsed.hour],
  );
  if (rows.length) {
    const e = new Error('That slot was just booked — pick another'); e.status = 409; throw e;
  }
}

module.exports = {
  WINDOW_DAYS,
  listVisitSlots,
  assertSlotBookable,
  parseVisitDateTime,
};
