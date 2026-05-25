const { pool } = require('../db');
const logger = require('../logger');
const jobService = require('./job.service');
const noticeService = require('./notice.service');
const performanceService = require('./performance.service');

/*
 * Mobile dashboard orchestrator — composes shared services into the
 * single payload `GET /api/mobile/dashboard` returns.
 *
 * Tier-specific concern (output shape is mobile-only), but ZERO
 * duplication of business logic — every count, list, and metric comes
 * from a function that's also consumed by CRM:
 *
 *   - `jobService.getStatusCounts({ easyfixerId })`   (CRM dashboard
 *     uses the same function with `{ scope, ownerId }`)
 *   - `jobService.list({ easyfixerId, ... })`         (CRM /admin/jobs
 *     uses the same function with admin scope filters)
 *   - `noticeService.listActiveForSurface(...)`        (CRM dashboard
 *     strip uses the same function with surface='crm')
 *   - `performanceService.getForTech(efrId)`           (future CRM
 *     "Technician Performance" report uses bulk variant)
 *
 * The only direct SQL in this file is for tier-specific concerns:
 *   - Technician identity row (one tbl_easyfixer row)
 *   - Today's attendance row (one tbl_easyfixer_attendance row)
 *   - Date-sliced job counts (overdue / upcoming) — these are
 *     finer-grained than getStatusCounts buckets, so a small extra
 *     query covers them.
 *
 * Caveats (see backend-changes.md Open Questions):
 *   - `actionRequired` count requires `send_back_to_tx` column —
 *     currently 0 references in the codebase. Returns 0 until the
 *     column is confirmed against the live DB.
 *   - `efr_profile_img` column may not exist on this DB; we SELECT it
 *     defensively and degrade to `null` on failure.
 */

const NEW_REQUEST_LIMIT = 3;
const ACTIVE_LIMIT = 2;
const DEFAULT_NOTICES_LIMIT = 3;
const MAX_NOTICES_LIMIT = 10;

/*
 * Dashboard payload.
 *
 *   opts.noticesLimit  — how many notices to include in `notices.items`.
 *                        Default 3 (good for the home-screen strip + small
 *                        carousel). Capped at 10 (no abuse, no payload
 *                        bloat). Accepts numeric strings; coerced + clamped.
 *
 *   Response shape:
 *     notices: {
 *       items:        [<Notice>, ...]   // top-N pinned-first/newest
 *       latest:       <Notice> | null   // convenience alias for items[0]
 *       unreadCount:  <number>          // count of unread in items[]
 *     }
 *
 *   The dynamic limit lets the same endpoint serve both "show one
 *   notice on the home strip" and "show a carousel of 5" without a
 *   new endpoint per use case. When the Client UI dashboard lands, it
 *   uses the same orchestrator pattern with `surface: 'client'` (the
 *   notice fetch is already factory-resolved per surface — see
 *   utils/notice-reader-router.js).
 */
async function getDashboard(efrId, opts = {}) {
  if (!efrId) {
    const err = new Error('efrId is required');
    err.status = 400;
    throw err;
  }
  const noticesLimit = Math.min(
    Math.max(Number(opts.noticesLimit) || DEFAULT_NOTICES_LIMIT, 1),
    MAX_NOTICES_LIMIT,
  );

  // Parallelise everything that doesn't depend on previous results.
  // 8-query fan-out + one cross-pool wait — sub-50ms on the dev DB.
  const [
    counts,
    ident,
    newRequestsList,
    activeJobsList,
    attendance,
    performance,
    notices,
    dateCounts,
  ] = await Promise.all([
    jobService.getStatusCounts({ easyfixerId: efrId }).catch((e) => {
      logger.warn({ err: e.message, efrId }, 'getStatusCounts failed; returning empty');
      return { total: 0, byStatus: {}, bookedUnassigned: 0, bookedAssigned: 0 };
    }),
    fetchIdentity(efrId),
    jobService.list({ easyfixerId: efrId, status: 0, limit: NEW_REQUEST_LIMIT }).catch(() => ({ rows: [], total: 0 })),
    jobService.list({ easyfixerId: efrId, statuses: '1,2,20', limit: ACTIVE_LIMIT }).catch(() => ({ rows: [], total: 0 })),
    fetchAttendance(efrId),
    performanceService.getForTech(efrId),
    noticeService.listActiveForSurface({
      surface: 'technician', readerType: 'efr', readerId: efrId, limit: noticesLimit,
    }).catch(() => []),
    fetchDateCounts(efrId),
  ]);

  return {
    // Identity + grade/rating merged into one object per the mobile-app
    // spec — the technician card on the home screen renders all of
    // these together. `grade` + `rating` ALSO appear on `performance`
    // below for callers that want them grouped with OTA/SDA; both
    // mirrors stay in sync because they read from the same source.
    technician: {
      ...shapeTechnician(ident),
      grade:  performance.grade,
      rating: performance.rating,
    },
    wallet: { balance: Number(ident?.current_balance ?? 0) },
    attendance: { status: attendanceStatus(attendance) },
    counts: {
      newRequests:    Number(counts.byStatus?.['0'] ?? 0),
      activeJobs:     dateCounts.activeToday,
      overdue:        dateCounts.overdue,
      upcoming:       dateCounts.upcoming,
      // `send_back_to_tx` column confirmed present on tbl_job (live-DB
      // probe 2026-05-25, type tinyint). Count = jobs CRM has sent
      // back to the tech that are now back in IN_PROGRESS — surfaces
      // as the "Action Required" tile on the home screen.
      actionRequired: dateCounts.actionRequired,
    },
    newRequests: (newRequestsList.rows || []).map(mapJobForMobile),
    activeJobs:  (activeJobsList.rows  || []).map(mapJobForMobile),
    performance,
    notices: {
      // `items` — the top-N active notices for THIS technician
      //   (pinned first, then newest). The FE picks display style:
      //   single banner / strip-of-many / carousel etc.
      // `latest` — convenience alias for items[0]; lets callers that
      //   only need "show the most recent notice" skip the items
      //   array indexing.
      // `unreadCount` — bounded by the fetched batch; useful for the
      //   "2 new" badge on the home-screen bell.
      items:       notices || [],
      latest:      (notices || [])[0] || null,
      unreadCount: (notices || []).filter((n) => !n.is_read).length,
    },
  };
}

// ─── Identity row ────────────────────────────────────────────────────
async function fetchIdentity(efrId) {
  // First try with `efr_profile_img` — the column might not exist on
  // this DB (see backend-changes.md Q1). On "Unknown column" error,
  // retry without it. This keeps the orchestrator robust across DB
  // variants without a schema-probe round trip on every request.
  try {
    const [[row]] = await pool.query(
      `SELECT e.efr_id, e.efr_name, e.efr_first_name, e.efr_no,
              e.efr_profile_img,
              e.efr_cityId, c.city_name,
              e.current_balance, e.efr_service_category
         FROM tbl_easyfixer e
         LEFT JOIN tbl_city c ON c.city_id = e.efr_cityId
        WHERE e.efr_id = ? LIMIT 1`,
      [efrId],
    );
    return row || {};
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      // Fallback without efr_profile_img.
      try {
        const [[row]] = await pool.query(
          `SELECT e.efr_id, e.efr_name, e.efr_first_name, e.efr_no,
                  e.efr_cityId, c.city_name,
                  e.current_balance, e.efr_service_category
             FROM tbl_easyfixer e
             LEFT JOIN tbl_city c ON c.city_id = e.efr_cityId
            WHERE e.efr_id = ? LIMIT 1`,
          [efrId],
        );
        return row || {};
      } catch (e2) {
        logger.warn({ err: e2.message, efrId }, 'fetchIdentity fallback failed');
        return {};
      }
    }
    logger.warn({ err: e.message, efrId }, 'fetchIdentity failed');
    return {};
  }
}

function shapeTechnician(ident) {
  return {
    efrId:     ident?.efr_id ?? null,
    name:      ident?.efr_name ?? null,
    firstName: ident?.efr_first_name ?? null,
    mobile:    ident?.efr_no ?? null,
    photoUrl:  ident?.efr_profile_img || null,
    city:      ident?.city_name ?? null,
    categories: ident?.efr_service_category
      ? String(ident.efr_service_category).split(/[,|]/).map((s) => s.trim()).filter(Boolean)
      : [],
    // `grade` + `rating` come from performance.service — appended below
    // by the caller. Kept here for shape stability if a consumer reads
    // `technician.*` directly without reading `performance.*`.
  };
}

// ─── Attendance ──────────────────────────────────────────────────────
async function fetchAttendance(efrId) {
  // `tbl_easyfixer_attendance` confirmed in routes/admin/auxiliary.js;
  // exact column names for morning_slot / is_leave_marked are pending
  // confirmation against the live DB (see backend-changes.md Q1). Use
  // SELECT * + defensive property reads so the call doesn't crash if
  // column names differ from the mobile-dev spec.
  try {
    const [[row]] = await pool.query(
      `SELECT *
         FROM tbl_easyfixer_attendance
        WHERE easyfixer_id = ? AND DATE(created_on) = CURDATE()
        LIMIT 1`,
      [efrId],
    );
    return row || null;
  } catch (e) {
    logger.info({ err: e.message, efrId }, 'fetchAttendance failed; treating as not-marked');
    return null;
  }
}

function attendanceStatus(row) {
  if (!row) return 'not_marked';
  if (row.is_leave_marked) return 'on_leave';
  // Mobile-dev spec uses `morning_slot` as the canonical "present"
  // signal. If the column doesn't exist, `row.morning_slot` is
  // undefined and we fall through to absent — safer than guessing.
  return row.morning_slot ? 'present' : 'absent';
}

// ─── Date-sliced counts ──────────────────────────────────────────────
/*
 * Four counts that go BEYOND what getStatusCounts() returns —
 * time-sliced + send-back-flagged buckets the generic engine doesn't
 * carry. Single SQL round-trip with conditional sums — cheap, stays
 * consistent with the rest of the dashboard via the same
 * `fk_easyfixter_id = ?` filter.
 *
 *   activeToday    — IN_PROGRESS / SCHEDULED / IN_PROGRESS_ALT jobs
 *                    whose appointment is today or earlier
 *                    (excludes sent-back jobs — those surface in
 *                    `actionRequired` instead).
 *   overdue        — same statuses, requested_date_time already
 *                    passed.
 *   upcoming       — same statuses, requested_date_time in the future.
 *   actionRequired — CRM has flagged a returned job for the tech to
 *                    re-handle (`send_back_to_tx = 1` AND `job_status
 *                    = 2`). Confirmed against live DB 2026-05-25 —
 *                    column is a tinyint on tbl_job.
 */
async function fetchDateCounts(efrId) {
  try {
    const [[row]] = await pool.query(
      `SELECT
         SUM(job_status IN (1,2,20) AND (send_back_to_tx = 0 OR send_back_to_tx IS NULL)
             AND DATE(requested_date_time) <= CURDATE())            AS activeToday,
         SUM(job_status IN (1,2,20) AND (send_back_to_tx = 0 OR send_back_to_tx IS NULL)
             AND requested_date_time < NOW())                       AS overdue,
         SUM(job_status IN (1,2,20)
             AND DATE(requested_date_time) > CURDATE())             AS upcoming,
         SUM(send_back_to_tx = 1 AND job_status = 2)                AS actionRequired
       FROM tbl_job
       WHERE fk_easyfixter_id = ?`,
      [efrId],
    );
    return {
      activeToday:    Number(row?.activeToday ?? 0),
      overdue:        Number(row?.overdue ?? 0),
      upcoming:       Number(row?.upcoming ?? 0),
      actionRequired: Number(row?.actionRequired ?? 0),
    };
  } catch (e) {
    logger.warn({ err: e.message, efrId }, 'fetchDateCounts failed; returning zeros');
    return { activeToday: 0, overdue: 0, upcoming: 0, actionRequired: 0 };
  }
}

// ─── Job row shape for the mobile preview lists ──────────────────────
function mapJobForMobile(j) {
  // Tier-specific re-shape. The CRM consumes the raw j.* / joined
  // shape; the app prefers camelCase + a precomputed
  // `minsToAppointment` (negative = late, positive = remaining).
  const reqTs = j.requested_date_time ? new Date(j.requested_date_time).getTime() : null;
  const minsToAppointment = reqTs != null
    ? Math.round((reqTs - Date.now()) / 60_000)
    : null;
  return {
    jobId:             j.job_id,
    jobStatus:         j.job_status ?? null,
    customerName:      j.customer_name ?? null,
    clientName:        j.client_name ?? null,
    city:              j.city_name ?? null,
    serviceType:       j.service_type ?? null,            // populated when projection includes it
    requestedAt:       j.requested_date_time ?? null,
    minsToAppointment,
    // Pass through any free/paid signal the projection happens to
    // expose; mobile app can also derive these from j.total_amount /
    // services[].job_charge_type on the detail call.
    totalAmount:       j.total_amount ?? null,
    helperReq:         j.helper_req ?? null,
  };
}

module.exports = { getDashboard };
