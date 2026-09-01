const { pool } = require('../db');
const logger = require('../logger');
const jobService = require('./job.service');
const noticeService = require('./notice.service');
const performanceService = require('./performance.service');
const alertFlags = require('./job-offer-alert-flags');

/*
 * Mobile dashboard orchestrator — composes shared services into the
 * single payload `GET /api/mobile/dashboard` returns.
 *
 * Tier-specific concern (output shape is mobile-only), but ZERO
 * duplication of business logic — every count, list, and metric comes
 * from a function that's also consumed by CRM:
 *
 *   - `jobService.listOfferedForTech(efrId)`           ("New Requests" =
 *     the tech's OPEN OFFERS under the offer-pool model; gated by
 *     jobOfferTableExists() inside job.service, with a legacy status-0
 *     fallback — see fetchNewRequests)
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

/*
 * WHICH DAY A JOB BELONGS TO — one expression, three buckets.
 *
 * "Today" is a question about the APPOINTMENT only until the technician starts
 * the job. After that it is a question about the WORK: statuses 2 (in progress)
 * and 20 (pending to close) mean they have checked in, and the appointment date
 * stops describing anything. Bucketing those by appointment meant checking into
 * a job booked for next week moved it OUT of "Today's Jobs" and into `upcoming`
 * the moment work started — the technician started a job and watched it vanish
 * from the only screen that lists it.
 *
 * But "started" is not the same as "started TODAY", and the difference is not
 * academic: every started job in the QA database was checked into between 132
 * and 287 days ago — abandoned work, not today's. Treating started-on-any-date
 * as today would pin all of them to Home permanently, four of them on one
 * technician. So a started job's day is the day it was STARTED.
 *
 * checkin_date_time carries that, and carries it reliably: of ~260k started or
 * completed jobs, six have no stamp. Those six fall back to the appointment,
 * which is what the column meant before check-in happened.
 *
 * A job the technician marks completed leaves by status, not by date — 3, 5 and
 * 6 are not in the active set at all, so completion removes it from every
 * bucket the same turn.
 *
 * Because all three buckets read this ONE expression, they still partition the
 * technician's active jobs and `allJobs` can go on being their sum.
 */
const ACTIVE_STATUSES = '1,2,20';
const STARTED_STATUSES = '2,20';
const WORK_DATE_SQL = `DATE(CASE WHEN job_status IN (${STARTED_STATUSES})
                                 THEN COALESCE(checkin_date_time, requested_date_time)
                                 ELSE requested_date_time END)`;

const isStarted = (row) => STARTED_STATUSES.split(',').includes(String(row?.job_status));

/** The JS mirror of WORK_DATE_SQL, for the list half. */
function workDateOf(row) {
  if (!row) return null;
  const raw = isStarted(row)
    ? (row.checkin_date_time ?? row.requested_date_time)
    : row.requested_date_time;
  return raw == null ? null : raw;
}
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
  logger.info('Build mobile dashboard · noticesLimit=' + noticesLimit);

  // Resolve the IST day once so the "Today's Jobs" SQL range and the
  // defensive same-day slice below read a single consistent day even if
  // the request straddles midnight.
  const today = todayRange();

  // Parallelise everything that doesn't depend on previous results.
  // Cross-pool fan-out + one wait — sub-50ms on the dev DB.
  //
  // NOTE: the tech-scoped getStatusCounts() call was dropped from this
  // fan-out because the only field it fed — the "New Requests" count
  // (byStatus['0']) — is now sourced from the tech's OPEN OFFERS via
  // fetchNewRequests (see below). Under the offer-pool model that
  // byStatus['0'] reads 0 anyway (it keys off fk_easyfixter_id, NULL while
  // offered), so it was actively wrong here, not just redundant.
  const [
    ident,
    newRequests,
    activeJobsList,
    startedJobsList,
    attendance,
    performance,
    notices,
    noticesUnread,
    dateCounts,
  ] = await Promise.all([
    fetchIdentity(efrId),
    // "New Requests" — the technician's OPEN OFFERS under the offer-pool
    // model. While a job is offered to multiple techs it stays
    // job_status=0 with tbl_job.fk_easyfixter_id = NULL (no single owner),
    // so the legacy `list({ easyfixerId, status: 0 })` (which infers the
    // tech's jobs from fk_easyfixter_id) returns EMPTY and the tech can't
    // see their offers on Home. Source from the tech's open offers instead;
    // fall back to the legacy status-0 list when the offer table / function
    // is absent so legacy deploys are unchanged. See fetchNewRequests.
    fetchNewRequests(efrId),
    // "Today's Jobs" preview — constrain to jobs whose REQUESTED
    // (appointment) date is today so the home-screen section doesn't
    // preview overdue/carried-over jobs (those are summarised by the
    // `delayed` count). `list()` supports a date range via
    // dateType:'requested' + startDate/endDate; we bound it to the IST
    // day so it agrees with the activeToday count (CURDATE()) under the
    // platform's "display IST" convention. The defensive same-day slice
    // below is a belt-and-braces guard on the already-constrained rows.
    jobService.list({
      easyfixerId: efrId,
      statuses: '1,2,20',
      dateType: 'requested',
      startDate: today.start,
      endDate: today.end,
      limit: ACTIVE_LIMIT,
    }).catch(() => ({ rows: [], total: 0 })),
    /*
     * Jobs the technician STARTED TODAY — the list half of the same rule the
     * activeToday count applies, keyed on the check-in stamp. A job checked
     * into ahead of its appointment is today's work and the requested-date
     * query above cannot see it; a job checked into months ago is not, and an
     * unbounded query would pin every abandoned one to Home for good.
     * Merged below, started first.
     */
    jobService.list({
      easyfixerId: efrId,
      statuses: STARTED_STATUSES,
      dateType: 'checkin',
      startDate: today.start,
      endDate: today.end,
      limit: ACTIVE_LIMIT,
    }).catch(() => ({ rows: [], total: 0 })),
    fetchAttendance(efrId),
    performanceService.getForTech(efrId),
    noticeService.listActiveForSurface({
      surface: 'technician', readerType: 'efr', readerId: efrId, limit: noticesLimit,
    }).catch(() => []),
    // Accurate unread total across ALL active notices (not bounded by the
    // limited items batch above) — drives the home-screen bell badge.
    noticeService.countUnreadForSurface({
      surface: 'technician', readerType: 'efr', readerId: efrId,
    }).catch(() => 0),
    fetchDateCounts(efrId),
  ]);

  logger.info('Dashboard composed · newRequests=' + newRequests.count + ' · activeToday=' + dateCounts.activeToday + ' · allJobs=' + dateCounts.allJobs + ' · notices=' + (notices || []).length);
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
    // `status` — TODAY's marked attendance. `tomorrow` — the NEXT day's
    // marked status, which seeds the home "Tomorrow" availability toggle
    // (the tech may have pre-marked leave/availability for tomorrow). Both
    // use the same 'present'|'absent'|'on_leave'|'not_marked' enum;
    // 'not_marked' when that day's row is absent. fetchAttendance reads
    // both days in one indexed query.
    attendance: {
      status:   attendanceStatus(attendance.today),
      tomorrow: attendanceStatus(attendance.tomorrow),
    },
    counts: {
      // Under the offer-pool model the "New Requests" tile counts the
      // tech's OPEN OFFERS (jobs offered to them but not yet owned by
      // anyone), NOT status-0 jobs keyed off fk_easyfixter_id — which is
      // NULL while offered, so getStatusCounts.byStatus['0'] (a tech-scoped
      // count) would read 0. fetchNewRequests resolves the offer-aware
      // count and falls back to the status-0 count on legacy deploys.
      newRequests:    newRequests.count,
      activeJobs:     dateCounts.activeToday,
      // `delayed` — same active statuses but appointment date is BEFORE
      // today (overdue/carried-over). Split out of `activeJobs` so the
      // home screen can badge "Today's Jobs" without inflating it with
      // jobs the tech was supposed to finish on a prior day.
      delayed:        dateCounts.delayed,
      overdue:        dateCounts.overdue,
      upcoming:       dateCounts.upcoming,
      // `allJobs` — the tech's TOTAL non-completed (active) jobs across
      // ALL dates, i.e. everything BEFORE Completed. It is exactly the
      // sum of the three date buckets (activeToday + delayed + upcoming),
      // which together partition the tech's active-status jobs (statuses
      // 1,2,20) by requested date into today / before-today / after-today.
      // Drives the home "All Jobs" tile, which previously mis-read the
      // future-only `upcoming` count. (`overdue` is a NOW()-based finer
      // slice that overlaps activeToday/delayed, so it is intentionally
      // NOT part of this sum.)
      allJobs:        dateCounts.allJobs,
      // `send_back_to_tx` column confirmed present on tbl_job (live-DB
      // probe 2026-05-25, type tinyint). Count = jobs CRM has sent
      // back to the tech that are now back in IN_PROGRESS — surfaces
      // as the "Action Required" tile on the home screen.
      actionRequired: dateCounts.actionRequired,
    },
    // Offer-aware "New Requests" preview list (the tech's open offers),
    // already shaped for mobile by fetchNewRequests. Legacy fallback maps
    // the status-0 list rows the same way, so the FE contract is identical.
    newRequests: newRequests.items,
    // Defensive same-IST-day filter on top of the SQL date range, then
    // slice to the preview size — guards against rows whose
    // requested_date_time falls outside the intended day (e.g. NULL or
    // a boundary edge) so "Today's Jobs" only ever previews today.
    // Started jobs lead — that is the work in hand — then today's scheduled
    // ones. Both halves pass through `isTodaysWork`, the JS mirror of the SQL
    // bucket rule, so a row with a NULL or boundary date cannot slip past the
    // date range into a list that claims to be today's.
    activeJobs:  dedupeById([
      ...(startedJobsList.rows || []).filter(isStarted),
      ...(activeJobsList.rows || []),
    ])
      .filter(isTodaysWork)
      .slice(0, ACTIVE_LIMIT)
      .map(mapJobForMobile),
    performance,
    notices: {
      // `items` — the top-N active notices for THIS technician
      //   (pinned first, then newest). The FE picks display style:
      //   single banner / strip-of-many / carousel etc.
      // `latest` — convenience alias for items[0]; lets callers that
      //   only need "show the most recent notice" skip the items
      //   array indexing.
      // `unreadCount` — ACCURATE total of unread active notices for this
      //   technician (counted server-side across ALL active notices, not
      //   bounded by the limited `items` batch). Drives the "N new" badge
      //   on the home-screen bell.
      items:       notices || [],
      latest:      (notices || [])[0] || null,
      unreadCount: Number(noticesUnread) || 0,
    },
    // ─── Server-driven feature flags ───────────────────────────────
    // Top-level `flags` block so the app can change BEHAVIOUR without a store
    // release — ops flips an easyfix_properties row and the next dashboard
    // fetch carries the new value.
    //
    //   loudOfferAlert — BANNER ONLY: render the attention-grabbing full-screen
    //     offer banner for incoming job offers. Mirrors the MASTER
    //     `job.offer.loud_alert.enabled` exactly: the banner is intrinsic to the
    //     loud alert and has NO sub-flag of its own — see job-offer-alert-flags.js.
    //     It does NOT govern the app's own alert sound. That is driven per-push by
    //     `data.loudAlert` on the job-offer push (loudSoundEnabled() = master AND
    //     `job.offer.loud_alert.sound.enabled`), which is what lets ops silence the
    //     sound mid-rollout while this flag — and the banner — stay on. Do not
    //     overload this key with a sound meaning: an app that plays its buzzer off
    //     `flags.loudOfferAlert` defeats the only sound kill-switch there is.
    //
    // The app must treat a MISSING `flags` object / missing key as FALSE, which
    // is the same fail-safe rule the backend applies to a missing property: off
    // means exactly today's behaviour. Read synchronously off the cached
    // property store, so this adds no query to the dashboard fan-out.
    flags: {
      loudOfferAlert: alertFlags.loudAlertMasterEnabled(),
    },
  };
}

// ─── Identity row ────────────────────────────────────────────────────
/*
 * Returns ONE technician identity row as a plain object (or {} when the
 * efr_id is unknown / the query fails). Exported + reused by the
 * profile-details service. Result schema (snake_case, straight from the
 * SELECT — `efr_profile_img` absent when the column doesn't exist on the
 * DB, see the fallback branch):
 *
 *   {
 *     efr_id:               number,
 *     efr_name:             string | null,
 *     efr_first_name:       string | null,
 *     efr_no:               string | null,   // mobile
 *     efr_profile_img?:     string | null,   // omitted on legacy DBs
 *     efr_cityId:           number | null,
 *     city_name:            string | null,   // joined from tbl_city
 *     current_balance:      number | null,   // wallet balance
 *     efr_service_category: string | null,   // CSV/pipe-delimited
 *   }
 *
 * Always resolves (never rejects) — callers can read fields defensively.
 */
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
    if (!row) logger.info('Technician identity not found · efrId=' + efrId);
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
/*
 * Reads the technician's marked attendance for BOTH today and tomorrow in
 * a single indexed round-trip and returns { today, tomorrow } rows (each
 * the raw tbl_easyfixer_attendance row or null when unmarked). The home
 * screen renders today's attendance status AND seeds a "Tomorrow"
 * availability toggle from the next day's marked status, so both are
 * needed.
 *
 * `tbl_easyfixer_attendance` confirmed in routes/admin/auxiliary.js;
 * exact column names for morning_slot / is_leave_marked are pending
 * confirmation against the live DB (see backend-changes.md Q1). Use
 * SELECT * + defensive property reads so the call doesn't crash if
 * column names differ from the mobile-dev spec.
 *
 * `created_on` is a DATE column (the attendance "day" key — see
 * mobile-attendance.service.js, which upserts on
 * `easyfixer_id = ? AND created_on = ?`). Because it's already a bare
 * date, comparing the column directly to CURDATE() / CURDATE() + INTERVAL
 * 1 DAY (rather than wrapping it in DATE(...)) stays sargable — lets
 * idx_efr_attendance_efr_date do an index seek over the two-day range
 * instead of a scan. One query covers both days; we sort the (≤2) rows
 * back into today / tomorrow in JS.
 */
async function fetchAttendance(efrId) {
  try {
    const [rows] = await pool.query(
      `SELECT *
         FROM tbl_easyfixer_attendance
        WHERE easyfixer_id = ?
          AND created_on IN (?, ?)`,
      [efrId, istTodayString(), istTomorrowString()],
    );
    const todayStr    = istTodayString();
    const tomorrowStr = istTomorrowString();
    const onDay = (target) => (rows || []).find((r) => attendanceRowDay(r) === target) || null;
    return { today: onDay(todayStr), tomorrow: onDay(tomorrowStr) };
  } catch (e) {
    logger.info({ err: e.message, efrId }, 'fetchAttendance failed; treating as not-marked');
    return { today: null, tomorrow: null };
  }
}

// Normalise a tbl_easyfixer_attendance row's `created_on` DATE to the
// IST YYYY-MM-DD string so it can be matched against istTodayString() /
// istTomorrowString() regardless of how the driver hands back the DATE
// value (Date object vs string).
function attendanceRowDay(row) {
  if (!row || row.created_on == null) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' })
    .format(new Date(row.created_on));
}

function attendanceStatus(row) {
  if (!row) return 'not_marked';
  if (row.is_leave_marked) return 'on_leave';
  // Mobile-dev spec uses `morning_slot` as the canonical "present"
  // signal. If the column doesn't exist, `row.morning_slot` is
  // undefined and we fall through to absent — safer than guessing.
  return row.morning_slot ? 'present' : 'absent';
}

// ─── IST "today" helpers ─────────────────────────────────────────────
/*
 * The platform stores DATETIME and displays IST (see CLAUDE.md coding
 * rule 7 + job-location.service.js). "Today" for the technician's home
 * screen is therefore the IST calendar day, derived with the same
 * `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' })` idiom
 * candidate-ranking.service.js uses — robust regardless of the Node
 * process timezone.
 */
function istTodayString() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

// IST calendar day AFTER today (YYYY-MM-DD), used to match the tomorrow
// attendance row. Adds 24h to "now" then formats in IST so it stays
// correct across DST-free IST and the Node process timezone.
function istTomorrowString() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' })
    .format(new Date(Date.now() + 86_400_000));
}

// Inclusive datetime bounds for the IST day, in the literal string form
// jobService.list() compares against requested_date_time (>= start,
// <= end). Returned fresh each call so a request that straddles
// midnight still reads a single consistent day.
function todayRange() {
  const d = istTodayString();
  return { start: `${d} 00:00:00`, end: `${d} 23:59:59` };
}

// Defensive guard for the preview slice: true when the row's
// requested_date_time falls on the IST "today" date. Compares date
// strings (YYYY-MM-DD) so it stays correct irrespective of the value's
// time portion or the server timezone.
/** First occurrence of each job_id wins — the caller orders by priority. */
function dedupeById(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const id = row?.job_id;
    if (id == null || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * Is this row today's work? The JS half of the bucket rule in `fetchDateCounts`
 * — a started job is dated by its CHECK-IN, everything else by its appointment.
 * Kept as one predicate so the list and the count cannot answer differently.
 */
function isTodaysWork(j) {
  const workDate = workDateOf(j);
  if (workDate == null) return false;
  const rowDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' })
    .format(new Date(workDate));
  return rowDay === istTodayString();
}

// ─── Date-sliced counts ──────────────────────────────────────────────
/*
 * Four counts that go BEYOND what getStatusCounts() returns —
 * time-sliced + send-back-flagged buckets the generic engine doesn't
 * carry. Single SQL round-trip with conditional sums — cheap, stays
 * consistent with the rest of the dashboard via the same
 * `fk_easyfixter_id = ?` filter.
 *
 *   activeToday    — active jobs whose WORK DATE is today (see
 *                    WORK_DATE_SQL: check-in for a started job, the
 *                    appointment otherwise). Excludes sent-back jobs —
 *                    those surface in `actionRequired` instead.
 *   delayed        — same statuses, work date BEFORE today: carried-over
 *                    work the tech still owns, including a job started on
 *                    an earlier day and never closed. Distinct from
 *                    `overdue` below, which is the finer-grained
 *                    "appointment instant already passed" (NOW()) signal
 *                    and can include today's earlier slots.
 *
 *                    ⚠ NOTHING READS `delayed` (audited 2026-09-01 across
 *                    every repo). The technician app's "Delayed" banner on
 *                    the Jobs tab reads `counts.overdue`, not this. It
 *                    exists to keep `allJobs` a sum, so if the bucket rule
 *                    changes again, `overdue` is the count with a UI
 *                    behind it and the one to re-check.
 *   overdue        — same statuses, requested_date_time already passed.
 *                    Deliberately still keyed on the APPOINTMENT, not the
 *                    work date: "am I late" is a different question from
 *                    "which day is this job's work", and a job started
 *                    today against a Tuesday slot really is late.
 *   upcoming       — same statuses, work date in the future.
 *   allJobs        — DERIVED (no extra SQL): activeToday + delayed +
 *                    upcoming — the tech's TOTAL non-completed/active jobs
 *                    across all dates (everything before Completed). All
 *                    three read the SAME work-date expression, so they
 *                    partition the active statuses and their sum holds.
 *   actionRequired — CRM has flagged a returned job for the tech to
 *                    re-handle (`send_back_to_tx = 1` AND `job_status
 *                    = 2`). Confirmed against live DB 2026-05-25 —
 *                    column is a tinyint on tbl_job.
 */
async function fetchDateCounts(efrId) {
  try {
    const [[row]] = await pool.query(
      `SELECT
         COUNT(CASE WHEN job_status IN (${ACTIVE_STATUSES})
                     AND (send_back_to_tx = 0 OR send_back_to_tx IS NULL)
                     AND ${WORK_DATE_SQL} = CURDATE() THEN 1 END) AS activeToday,
         COUNT(CASE WHEN job_status IN (${ACTIVE_STATUSES})
                     AND (send_back_to_tx = 0 OR send_back_to_tx IS NULL)
                     AND ${WORK_DATE_SQL} < CURDATE() THEN 1 END) AS \`delayed\`,
         COUNT(CASE WHEN job_status IN (${ACTIVE_STATUSES})
                     AND requested_date_time < NOW() THEN 1 END)  AS overdue,
         COUNT(CASE WHEN job_status IN (${ACTIVE_STATUSES})
                     AND ${WORK_DATE_SQL} > CURDATE() THEN 1 END) AS upcoming,
         COUNT(CASE WHEN send_back_to_tx = 1 AND job_status = 2 THEN 1 END) AS actionRequired
       FROM tbl_job
       WHERE fk_easyfixter_id = ?`,
      [efrId],
    );
    const activeToday = Number(row?.activeToday ?? 0);
    const delayed     = Number(row?.delayed ?? 0);
    const upcoming    = Number(row?.upcoming ?? 0);
    return {
      activeToday,
      delayed,
      overdue:        Number(row?.overdue ?? 0),
      upcoming,
      // Total non-completed (active-status) jobs across all dates — the
      // three requested-date buckets together partition the tech's
      // statuses 1,2,20, so their sum is the "All Jobs" count.
      allJobs:        activeToday + delayed + upcoming,
      actionRequired: Number(row?.actionRequired ?? 0),
    };
  } catch (e) {
    logger.warn({ err: e.message, efrId }, 'fetchDateCounts failed; returning zeros');
    return { activeToday: 0, delayed: 0, overdue: 0, upcoming: 0, allJobs: 0, actionRequired: 0 };
  }
}

// ─── "New Requests" — offer-pool aware ───────────────────────────────
/*
 * Resolves the home-screen "New Requests" section under THE OFFER MODEL.
 *
 * In the offer-pool model a job can be offered to MULTIPLE technicians at
 * once. While offered it stays job_status=0 (BOOKED) and
 * tbl_job.fk_easyfixter_id STAYS NULL (no single owner) — so the legacy
 * source `jobService.list({ easyfixerId, status: 0 })`, which infers the
 * tech's jobs from fk_easyfixter_id, returns EMPTY and the tech can't see
 * the requests offered to them. The correct source is the tech's OPEN
 * OFFERS: `jobService.listOfferedForTech(efrId)` → { items: JobPreview[] }.
 *
 * GATED on the offer flow — falls back to the legacy status-0 list so
 * legacy deploys are unchanged — when ANY of these hold:
 *   - jobService doesn't expose listOfferedForTech (older module on a
 *     coexisting deploy), or
 *   - the tbl_job_offer table is absent (jobOfferTableExists() === false), or
 *   - listOfferedForTech yields nothing usable (no items / it throws).
 *
 * Always resolves (never rejects). Returns the shape the orchestrator
 * spreads into the payload:
 *   { items: <mobile-shaped preview[]>, count: <number> }
 *   - items: preview rows shaped by mapJobForMobile, capped at
 *            NEW_REQUEST_LIMIT (the home-screen preview size).
 *   - count: number of open offers for the tech (full list length, NOT the
 *            previewed slice) — drives the "New Requests" tile badge. On the
 *            legacy path this mirrors the old status-0 count.
 */
async function fetchNewRequests(efrId) {
  // Primary gate is whether the offer-list function is wired in at all —
  // `listOfferedForTech` is itself gated by jobOfferTableExists() inside
  // job.service, so it returns nothing on deploys without the table. We
  // ALSO consult jobOfferTableExists() here (when exported) to tell two
  // empty cases apart: "table present, zero open offers" → render an empty
  // section (correct truth); "table absent" → fall back to the legacy
  // status-0 list. If the probe isn't exported, an empty offer result is
  // treated as the legacy fallback signal, which is safe — the status-0
  // list is empty too while jobs are offered (fk_easyfixter_id NULL).
  if (typeof jobService.listOfferedForTech === 'function') {
    try {
      const offered = await jobService.listOfferedForTech(efrId);
      const items = (offered && offered.items) || [];
      if (items.length) {
        logger.info('New requests from open offers · count=' + items.length);
        return {
          items: items.slice(0, NEW_REQUEST_LIMIT).map(toMobilePreview),
          count: items.length,
        };
      }
      // Empty offer set. Only short-circuit to an empty section when we can
      // positively confirm the offer table exists (offer flow live, the
      // tech simply has no open offers). Otherwise fall through to legacy.
      const offerTableLive = typeof jobService.jobOfferTableExists === 'function'
        ? await jobService.jobOfferTableExists().catch(() => false)
        : false;
      if (offerTableLive) return { items: [], count: 0 };
    } catch (e) {
      logger.warn({ err: e.message, efrId }, 'listOfferedForTech failed; falling back to status-0 list');
      // fall through to legacy path
    }
  }

  // Legacy fallback — offer table/function absent (or errored): preview the
  // tech's status-0 jobs (owner-keyed) exactly as before. Count comes from
  // the same query's `total` so the tile badge isn't capped by the preview.
  const legacy = await jobService
    .list({ easyfixerId: efrId, status: 0, limit: NEW_REQUEST_LIMIT })
    .catch(() => ({ rows: [], total: 0 }));
  return {
    items: (legacy.rows || []).map(mapJobForMobile),
    count: Number(legacy.total ?? (legacy.rows || []).length),
  };
}

// Normalise a JobPreview from listOfferedForTech into the mobile preview
// shape. The offer-pool list may already emit camelCase mobile previews
// (a `jobId` present) — pass those through untouched; otherwise it's a raw
// snake_case job row, so reshape it via mapJobForMobile. Keeps this file
// correct regardless of which shape the offer-list producer returns.
function toMobilePreview(p) {
  if (p && p.jobId != null) return p;
  return mapJobForMobile(p || {});
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
    // Offer countdown (offer rows only — see listOfferedForTech). Deliberately
    // kept in the projection's own snake_case rather than camelCased, so the
    // SAME two field names appear on this preview, on GET /jobs/offered, and in
    // the app's offer model. Spread CONDITIONALLY: a non-offer preview (Today's
    // Jobs) has no offer, and emitting `offered_at: null` there would imply one
    // exists but is unknown. Sent regardless of any loud-alert flag — the
    // countdown is useful on its own.
    ...(j.offered_at != null ? { offered_at: j.offered_at, expires_at: j.expires_at ?? null } : {}),
  };
}

// `fetchIdentity` is exported so the profile-details service can reuse
// the exact same identity row + defensive efr_profile_img fallback
// WITHOUT duplicating the SQL. Behaviour is unchanged for getDashboard's
// internal use.
/*
 * `_internals` exposes the "is this today's work" predicates so the rule can be
 * asserted without a database. The count half lives in SQL and the list half in
 * JS; these are the JS half, and they are the half that silently drops a job.
 */
module.exports = { getDashboard, fetchIdentity, _internals: { dedupeById, isStarted, isTodaysWork, workDateOf } };
