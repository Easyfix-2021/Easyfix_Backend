const { pool } = require('../db');
const logger = require('../logger');

/*
 * Mobile Attendance service — backs `GET/POST /api/mobile/attendance`,
 * `POST /api/mobile/leave`, `POST /api/mobile/leave/unmark`.
 *
 * Native rebuild of the legacy ACD_APIs Spring flow (replaces the
 * Dropwizard `/test-api/api/attendance/*` endpoints the Flutter app
 * historically hit). Cross-referenced against:
 *   - ACD_APIs Attendance.java (table + columns)
 *   - ACD_APIs AttendanceServiceImpl.java (create/update semantics)
 *   - ACD_APIs JobRepository.getJobCountFor{Morning,Evening}Slot
 *   - services/mobile-dashboard.service.js (column reality probe)
 *
 * Table: `tbl_easyfixer_attendance` — verified columns (ACD_APIs entity
 * `Attendance`, @Table "tbl_easyfixer_attendance"):
 *   id            INT PK AUTO_INCREMENT
 *   easyfixer_id  INT
 *   morning_slot  BIT/TINYINT  (boolean → coerced at the pool typeCast)
 *   evening_slot  BIT/TINYINT
 *   is_leave_marked BIT/TINYINT
 *   created_on    DATE         (the attendance "day" key)
 *   insert_date   DATETIME
 *   updated_on    DATETIME
 *
 * One row per (easyfixer_id, created_on). The legacy app keyed off
 * `DATE(created_on)` (AttendanceDoaImpl.getAttendanceByEasyfixerId),
 * so our upsert matches on `easyfixer_id = ? AND created_on = ?`.
 *
 * `tbl_easyfixer_attendance` has no DB unique constraint on
 * (easyfixer_id, created_on) in legacy data, so — exactly like the
 * device_info upsert in routes/mobile/index.js — we UPDATE-then-INSERT
 * manually instead of relying on ON DUPLICATE KEY (which would silently
 * always INSERT and grow the row count). The whole multi-day leave write
 * runs inside a single pooled transaction.
 *
 * Job-count per slot (morning/evening) mirrors the legacy
 * JobRepository native queries verbatim:
 *   morning = jobs whose requested_time < '14:00:00'
 *   evening = jobs whose requested_time > '14:00:00'
 *   both filtered to job_status IN (0,1,2,20) for THIS technician on the
 *   given calendar day (DATE(requested_date_time) = the attendance day).
 */

const SLOT_CUTOFF = '14:00:00';
// Statuses the legacy slot-count query considered "active" jobs.
const ACTIVE_JOB_STATUSES = [0, 1, 2, 20];

function mkErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ── helpers ────────────────────────────────────────────────────────────
// Normalise a JS Date / 'YYYY-MM-DD' string to a bare 'YYYY-MM-DD' day
// key. The route layer Joi-validates these as ISO dates, so by the time
// they land here they're either a Date or a date-only string.
function toDayKey(d) {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  // Joi `.iso()` may hand us a full timestamp string — keep the date part.
  return String(d).slice(0, 10);
}

// Expand an inclusive [start, end] date range into bare day keys.
// Capped defensively so a fat-fingered range can't fan out unbounded.
const MAX_LEAVE_DAYS = 366;
function enumerateDays(startDate, endDate) {
  const start = new Date(`${toDayKey(startDate)}T00:00:00Z`);
  const end = new Date(`${toDayKey(endDate)}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw mkErr(400, 'invalid date range');
  }
  if (end < start) throw mkErr(400, 'endDate must be on or after startDate');
  const days = [];
  for (let cur = start; cur <= end; cur.setUTCDate(cur.getUTCDate() + 1)) {
    days.push(cur.toISOString().slice(0, 10));
    if (days.length > MAX_LEAVE_DAYS) throw mkErr(400, `date range too large (max ${MAX_LEAVE_DAYS} days)`);
  }
  return days;
}

// Per-day job counts for the two slots. One round-trip with conditional
// sums — cheaper than the legacy two separate COUNT queries while
// preserving the same status + time-cutoff semantics.
async function fetchSlotCountsForDays(efrId, dayKeys) {
  if (!dayKeys.length) return {};
  const placeholders = dayKeys.map(() => '?').join(',');
  const statusPlaceholders = ACTIVE_JOB_STATUSES.map(() => '?').join(',');
  try {
    const [rows] = await pool.query(
      `SELECT DATE(requested_date_time) AS day,
              SUM(requested_time < ?)  AS morning,
              SUM(requested_time > ?)  AS evening
         FROM tbl_job
        WHERE fk_easyfixter_id = ?
          AND job_status IN (${statusPlaceholders})
          AND DATE(requested_date_time) IN (${placeholders})
        GROUP BY DATE(requested_date_time)`,
      [SLOT_CUTOFF, SLOT_CUTOFF, efrId, ...ACTIVE_JOB_STATUSES, ...dayKeys],
    );
    const byDay = {};
    for (const r of rows) {
      byDay[toDayKey(r.day)] = {
        morning: Number(r.morning || 0),
        evening: Number(r.evening || 0),
      };
    }
    return byDay;
  } catch (e) {
    // Slot counts are decorative on the attendance grid — degrade to
    // zeros rather than failing the whole attendance read.
    logger.warn({ err: e.message, efrId }, 'fetchSlotCountsForDays failed; returning zero counts');
    return {};
  }
}

// ── GET /attendance?from&to ────────────────────────────────────────────
/*
 * Returns the marked-attendance days in [from, to] for the technician,
 * each enriched with the live morning/evening job counts.
 *
 * Shape (camelCase, per blueprint §4.2):
 *   { days: [ { date, morningSlot, eveningSlot,
 *               jobCountMorning, jobCountEvening, isLeave } ] }
 */
async function getAttendance(efrId, { from, to } = {}) {
  if (!efrId) throw mkErr(400, 'efrId is required');
  const fromKey = toDayKey(from);
  const toKey = toDayKey(to);
  logger.info('Get attendance · from=' + fromKey + ' · to=' + toKey);
  if (toKey < fromKey) throw mkErr(400, 'to must be on or after from');

  const [rows] = await pool.query(
    `SELECT id, easyfixer_id, morning_slot, evening_slot, is_leave_marked, created_on
       FROM tbl_easyfixer_attendance
      WHERE easyfixer_id = ?
        AND created_on BETWEEN ? AND ?
      ORDER BY created_on ASC`,
    [efrId, fromKey, toKey],
  );

  logger.info('Found ' + rows.length + ' marked attendance days');
  const dayKeys = rows.map((r) => toDayKey(r.created_on));
  const counts = await fetchSlotCountsForDays(efrId, dayKeys);

  const days = rows.map((r) => {
    const dateKey = toDayKey(r.created_on);
    const c = counts[dateKey] || { morning: 0, evening: 0 };
    return {
      date: dateKey,
      // BIT(1)/TINYINT columns are coerced to booleans by db.js typeCast.
      morningSlot: Boolean(r.morning_slot),
      eveningSlot: Boolean(r.evening_slot),
      jobCountMorning: c.morning,
      jobCountEvening: c.evening,
      isLeave: Boolean(r.is_leave_marked),
    };
  });

  logger.info('Returning ' + days.length + ' attendance days');
  return { days };
}

// ── POST /attendance — upsert one day ──────────────────────────────────
/*
 * Marks (or re-marks) attendance for a single day. UPDATE-then-INSERT on
 * the (easyfixer_id, created_on) natural key. Marking attendance clears
 * any leave flag on that day (present ⇒ not on leave).
 *
 *   { marked: true }
 */
async function markDay(efrId, { date, morningSlot, eveningSlot }) {
  if (!efrId) throw mkErr(400, 'efrId is required');
  const dayKey = toDayKey(date);
  const morning = morningSlot ? 1 : 0;
  const evening = eveningSlot ? 1 : 0;
  logger.info('Mark attendance day · date=' + dayKey + ' · morning=' + morning + ' · evening=' + evening);

  const [upd] = await pool.query(
    `UPDATE tbl_easyfixer_attendance
        SET morning_slot = ?, evening_slot = ?, is_leave_marked = 0,
            updated_on = NOW()
      WHERE easyfixer_id = ? AND created_on = ?`,
    [morning, evening, efrId, dayKey],
  );
  if (upd.affectedRows === 0) {
    await pool.query(
      `INSERT INTO tbl_easyfixer_attendance
         (easyfixer_id, morning_slot, evening_slot, is_leave_marked, created_on, insert_date)
       VALUES (?, ?, ?, 0, ?, NOW())`,
      [efrId, morning, evening, dayKey],
    );
  }
  logger.info('Attendance ' + (upd.affectedRows === 0 ? 'inserted' : 'updated') + ' · date=' + dayKey);
  return { marked: true };
}

// ── POST /leave — mark leave across a range ────────────────────────────
/*
 * Marks leave for every day in the inclusive [startDate, endDate] range.
 * On a leave day both slots are forced to 0 (on leave ⇒ neither slot
 * present), matching the legacy un-mark/mark-leave toggle. Runs inside a
 * single transaction so a partial range can't be committed.
 *
 *   { marked: true }
 */
async function markLeave(efrId, { startDate, endDate }) {
  if (!efrId) throw mkErr(400, 'efrId is required');
  logger.info('Mark leave · from=' + toDayKey(startDate) + ' · to=' + toDayKey(endDate));

  // Block going unavailable on a day that already has an assigned, not-yet-
  // finished job. Attendance feeds the Candidate Ranking + auto-allocation, so
  // silently freeing up a tech who's committed to a job would unfairly reshuffle
  // other technicians and force ops to reassign by hand. The tech must get the
  // job reassigned (via support) first. 409 → the app shows a "contact support"
  // popup. (status 3/5 completed, 6 cancelled are excluded — those are done.)
  const [[clash]] = await pool.query(
    `SELECT COUNT(*) AS n FROM tbl_job
      WHERE fk_easyfixter_id = ?
        AND job_status NOT IN (3, 5, 6)
        AND DATE(scheduled_date_time) BETWEEN ? AND ?`,
    [efrId, toDayKey(startDate), toDayKey(endDate)],
  );
  if (clash && Number(clash.n) > 0) {
    logger.warn('Mark leave blocked · ' + Number(clash.n) + ' assigned job(s) in range');
    throw mkErr(
      409,
      'You have a job assigned on this date. Please contact support to get it reassigned before marking yourself unavailable.',
    );
  }

  const days = enumerateDays(startDate, endDate);
  logger.info('Marking leave across ' + days.length + ' days');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const dayKey of days) {
      const [upd] = await conn.query(
        `UPDATE tbl_easyfixer_attendance
            SET is_leave_marked = 1, morning_slot = 0, evening_slot = 0,
                updated_on = NOW()
          WHERE easyfixer_id = ? AND created_on = ?`,
        [efrId, dayKey],
      );
      if (upd.affectedRows === 0) {
        await conn.query(
          `INSERT INTO tbl_easyfixer_attendance
             (easyfixer_id, morning_slot, evening_slot, is_leave_marked, created_on, insert_date)
           VALUES (?, 0, 0, 1, ?, NOW())`,
          [efrId, dayKey],
        );
      }
    }
    await conn.commit();
    logger.info('Leave marked · ' + days.length + ' days');
    return { marked: true };
  } catch (e) {
    await conn.rollback();
    logger.warn('Mark leave failed; rolled back · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }
}

// ── POST /leave/unmark — clear leave across a range ────────────────────
/*
 * Clears the leave flag for every EXISTING attendance row in the
 * inclusive [startDate, endDate] range. We deliberately do NOT INSERT
 * rows here — clearing leave on a day that was never marked is a no-op,
 * not a reason to create an empty present/absent row. Single transaction.
 *
 *   { unmarked: true }
 */
async function unmarkLeave(efrId, { startDate, endDate }) {
  if (!efrId) throw mkErr(400, 'efrId is required');
  const startKey = toDayKey(startDate);
  const endKey = toDayKey(endDate);
  logger.info('Unmark leave · from=' + startKey + ' · to=' + endKey);
  if (endKey < startKey) throw mkErr(400, 'endDate must be on or after startDate');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `UPDATE tbl_easyfixer_attendance
          SET is_leave_marked = 0, updated_on = NOW()
        WHERE easyfixer_id = ?
          AND created_on BETWEEN ? AND ?
          AND is_leave_marked = 1`,
      [efrId, startKey, endKey],
    );
    await conn.commit();
    logger.info('Leave unmarked · range ' + startKey + '..' + endKey);
    return { unmarked: true };
  } catch (e) {
    await conn.rollback();
    logger.warn('Unmark leave failed; rolled back · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = {
  getAttendance,
  markDay,
  markLeave,
  unmarkLeave,
};
