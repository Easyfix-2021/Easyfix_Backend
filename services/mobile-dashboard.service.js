const { pool } = require('../db');
const logger = require('../logger');
const jobService = require('./job.service');
const noticeService = require('./notice.service');
const performanceService = require('./performance.service');
const alertFlags = require('./job-offer-alert-flags');
const { OPEN_JOB_STATUSES } = require('./easyfixer-lifecycle.service');
const { todayCutoffHour } = require('./mobile-attendance.service');
const properties = require('./properties.service');
const { technicianSharesForJobs } = require('./job-ledger.service');

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
 * technician's active jobs.
 *
 * THE ACTIVE SET IS HIS WORK IN HAND, and it is read from the lifecycle service
 * rather than typed here. Each Home card opens a Bookings chip — Open Jobs → All,
 * Today's Jobs → Today, Delayed → Delayed — and GET /mobile/jobs lists
 * OPEN_JOB_STATUSES, so a card counting a narrower set promises a number the
 * list it opens contradicts. Until 2026-09-11 this was (1, 2, 20): Open Jobs read
 * 1 over a Bookings list of 5, the other four being a revisit owed (10), an
 * estimate pending with the technician on site (15) and a job on hold (21).
 *
 * 10, 15 and 21 are deliberately NOT started statuses for the WORK DATE: the
 * Bookings list dates them by their appointment, and a Home card that dated them
 * differently would disagree with the chip it opens.
 */
const ACTIVE_STATUSES = OPEN_JOB_STATUSES.join(',');
const STARTED_STATUSES = '2,20';
/*
 * "Late" is the Bookings Delayed chip's rule (the app's useMyOrders.bucketOf,
 * through jobStage): the appointment has passed AND the work has not begun.
 * Begun = in progress (2), pending to close (20), revisit (10), or estimate
 * pending (15) WITH a check-in stamp — the list decides "checked in" from
 * checkin_date_time alone, so this does too. Every other open status can be late,
 * including any status added to the open set later: jobStage's default is "not
 * started", the conservative direction, and this matches it.
 *
 * 16 "Pending for Material" (2026-09-18) joins 15 in the checkin_date_time
 * carve-out: it is reachable only from 2/20, so the technician is on-site
 * (already checked in) the entire time the job sits at 16, in either
 * sub-state — same "began, just not by the STARTED_STATUSES definition"
 * shape 15 already had.
 */
const NOT_STARTED_SQL = `(job_status NOT IN (2, 10, 20)
                          AND NOT (job_status IN (15, 16) AND checkin_date_time IS NOT NULL))`;
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
    techFacts,
    skills,
    homeJobs,
    bestDay,
    review,
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
      statuses: ACTIVE_STATUSES,
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
    // V3 Phase 4 (4.2) — the new Home. Each always resolves; see its function.
    fetchTechFacts(efrId),
    fetchSkills(efrId),
    fetchHomeJobs(efrId),
    fetchBestDay(efrId),
    fetchLatestReview(efrId),
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
      // V3 Phase 4 header tiles and chips (4.2).
      earnedLifetime: techFacts.earnedLifetime,
      points:         techFacts.points,
      workArea:       techFacts.workArea,
      skills,
    },
    workingHours: workingHours(attendance.today),
    escalation:   homeJobs.escalation,
    home:         homeJobs.home,
    yesterday:    { ...homeJobs.yesterday, bestDay, review },
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
      // IST hour from which TODAY can no longer be marked present (24 = never
      // locks). The app greys out Today with it; markDay() is the real gate.
      todayCutoffHour: todayCutoffHour(),
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
      // `allJobs` — the tech's TOTAL open jobs across ALL dates: every job
      // in ACTIVE_STATUSES, counted directly. Drives the home "Open Jobs"
      // tile, which opens the Bookings All list — the same statuses, so the
      // number on the tile is the number of jobs the list holds.
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
 *     home_location:        string | null,   // the home PIN's locality (tbl_pincode.location)
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
              e.efr_cityId, c.city_name, hp.location AS home_location,
              e.current_balance, e.efr_service_category
         FROM tbl_easyfixer e
         LEFT JOIN tbl_city c ON c.city_id = e.efr_cityId
         LEFT JOIN tbl_pincode hp ON hp.pincode = e.efr_pin_no
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
                  e.efr_cityId, c.city_name, hp.location AS home_location, hp.location AS home_location,
                  e.current_balance, e.efr_service_category
             FROM tbl_easyfixer e
             LEFT JOIN tbl_city c ON c.city_id = e.efr_cityId
             LEFT JOIN tbl_pincode hp ON hp.pincode = e.efr_pin_no
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
    // Header line "EFR ID 99001 · <home locality>" (owner, 2026-09-24): the
    // named locality of his home PIN (efr_pin_no), never the PIN itself.
    homeLocation: ident?.home_location?.trim() || null,
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
/*
 * The IST calendar day of a DATETIME/DATE value that came out of the database.
 *
 * ⚠ DO NOT "SIMPLIFY" THIS BACK TO Intl.format(new Date(value)). That is what
 * it used to be, and it was wrong twice over:
 *
 *   db.js sets `dateStrings: true`, so MySQL DATETIME arrives as the literal
 *   string "YYYY-MM-DD HH:mm:ss" and that string is ALREADY IST — the column
 *   stores IST wall-clock verbatim. `new Date("2026-09-07 18:53:00")` parses a
 *   space-separated stamp as the SERVER'S LOCAL time, and Intl then converts
 *   that instant into Asia/Kolkata. Two wrongs that cancel only when the server
 *   happens to run in IST.
 *
 *   The container runs UTC. So an 18:53 IST check-in was read as 18:53 UTC and
 *   re-rendered as 00:23 the NEXT day — and every job started after 18:30 IST
 *   silently left "Today's Jobs". That is the exact regression the header of
 *   tests/mobile-dashboard-today.test.js says this code exists to prevent; it
 *   came back through the conversion rather than through the bucket rule.
 *
 * A real Date is a different case and is still converted: it denotes an
 * instant, so asking which IST day it falls on is the right question. Only an
 * already-IST STRING must be read verbatim.
 */
function istDayOf(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
    if (m) return m[1];              // already IST — take it, do not convert
  }
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime())
    ? null
    : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

function attendanceRowDay(row) {
  if (!row || row.created_on == null) return null;
  return istDayOf(row.created_on);
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
  return istDayOf(workDate) === istTodayString();
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
 *   overdue        — same statuses, requested_date_time already passed AND
 *                    the work not begun (NOT_STARTED_SQL). Keyed on the
 *                    APPOINTMENT, not the work date. It is the Home "Delayed"
 *                    tile, which opens the Bookings Delayed chip, so it uses
 *                    that chip's rule: late means late and not started. It
 *                    used to count begun work too (2, 20), so the tile could
 *                    read 1 over a Delayed chip that listed nothing.
 *   upcoming       — same statuses, work date in the future.
 *   allJobs        — every job in the active statuses, counted DIRECTLY. It
 *                    was activeToday + delayed + upcoming, but those two
 *                    exclude sent-back jobs, which the Bookings list shows —
 *                    so the sum undercounted the list the tile opens.
 *   actionRequired — CRM has flagged a returned job for the tech to
 *                    re-handle (`send_back_to_tx = 1` AND `job_status
 *                    = 2`). Confirmed against live DB 2026-05-25 —
 *                    column is a tinyint on tbl_job.
 */
async function fetchDateCounts(efrId) {
  try {
    const now = new Date();
    const [[row]] = await pool.query(
      `SELECT
         COUNT(CASE WHEN job_status IN (${ACTIVE_STATUSES})
                     AND (send_back_to_tx = 0 OR send_back_to_tx IS NULL)
                     AND ${WORK_DATE_SQL} = DATE(?) THEN 1 END) AS activeToday,
         COUNT(CASE WHEN job_status IN (${ACTIVE_STATUSES})
                     AND (send_back_to_tx = 0 OR send_back_to_tx IS NULL)
                     AND ${WORK_DATE_SQL} < DATE(?) THEN 1 END) AS \`delayed\`,
         COUNT(CASE WHEN job_status IN (${ACTIVE_STATUSES})
                     AND requested_date_time < ?
                     AND ${NOT_STARTED_SQL} THEN 1 END)           AS overdue,
         COUNT(CASE WHEN job_status IN (${ACTIVE_STATUSES})
                     AND ${WORK_DATE_SQL} > DATE(?) THEN 1 END) AS upcoming,
         COUNT(CASE WHEN job_status IN (${ACTIVE_STATUSES}) THEN 1 END) AS allJobs,
         COUNT(CASE WHEN send_back_to_tx = 1 AND job_status = 2 THEN 1 END) AS actionRequired
       FROM tbl_job
       WHERE fk_easyfixter_id = ?`,
      [now, now, now, now, efrId],
    );
    return {
      activeToday:    Number(row?.activeToday ?? 0),
      delayed:        Number(row?.delayed ?? 0),
      overdue:        Number(row?.overdue ?? 0),
      upcoming:       Number(row?.upcoming ?? 0),
      allJobs:        Number(row?.allJobs ?? 0),
      actionRequired: Number(row?.actionRequired ?? 0),
    };
  } catch (e) {
    logger.warn({ err: e.message, efrId }, 'fetchDateCounts failed; returning zeros');
    return { activeToday: 0, delayed: 0, overdue: 0, upcoming: 0, allJobs: 0, actionRequired: 0 };
  }
}

// ─── V3 Phase 4 — the new Home (4.2) ─────────────────────────────────
/*
 * QUERY BUDGET, fixed whatever the technician holds: techFacts 1 (+1 cities
 * lookup when he has PINs) · skills 1 · home jobs 1 + technicianSharesForJobs
 * 1-3 · best day 1 per technician per hour (cached) · review 1. Every piece
 * resolves to an empty shape on failure — a missing tile must not take Home
 * down — and every read is keyed on this technician's efr_id.
 */
const HOME_JOB_CAP = 500;
const UPCOMING_DAYS = 7;
const BEST_DAY_WINDOW_DAYS = 90;
const BEST_DAY_TTL_MS = 60 * 60 * 1000;
const BEST_DAY_CACHE_MAX = 10000;
const WORKING_HOURS_PROP = 'technician.working_hours.default';
const WORKING_HOURS_DEFAULT = '10:00-20:00';
const DAY_MS = 86_400_000;

const istDayAt = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(ms));

/*
 * The instant a DB DATETIME denotes. db.js hands DATETIMEs back as the IST
 * wall-clock STRING (see istDayOf) — so it is read as +05:30, never as the
 * server's local time. A Date is already an instant.
 */
function istInstantMs(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/.exec(String(value).trim());
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2].length === 5 ? m[2] + ':00' : m[2]}+05:30`);
  return Number.isNaN(ms) ? null : ms;
}

/* JS mirror of NOT_STARTED_SQL — the Bookings Delayed chip's "not begun". */
function notStarted(row) {
  const s = Number(row.job_status);
  if ([2, 10, 20].includes(s)) return false;
  return !([15, 16].includes(s) && row.checkin_date_time != null);
}

/*
 * Lifetime earned (the PHE overview's own figure: Σ tbl_job_transaction
 * .efr_charge over his 3/5 jobs), reward points (Σ reward_points_ledger.delta,
 * rewards balanceFor) and the PIN CSV, in ONE round trip; then the cities those
 * PINs sit in, most-covered first, so the chip reads "<first> +N · <pins> PIN".
 */
async function fetchTechFacts(efrId) {
  const empty = { earnedLifetime: null, points: null, workArea: { cities: [], pinCount: 0 } };
  try {
    const [[row]] = await pool.query(
      `SELECT
         (SELECT COALESCE(SUM(t.efr_charge), 0)
            FROM tbl_job j JOIN tbl_job_transaction t ON t.fk_job_id = j.job_id
           WHERE j.fk_easyfixter_id = ? AND j.job_status IN (3, 5)) AS earned_lifetime,
         (SELECT COALESCE(SUM(delta), 0) FROM reward_points_ledger WHERE easyfixer_id = ?) AS points,
         (SELECT pincodes FROM tbl_efr_serviceable_pincodes WHERE easyfixer_id = ? LIMIT 1) AS pincodes`,
      [efrId, efrId, efrId],
    );
    // Same parse as getServiceablePincodes, so the chip and the PIN screen agree.
    const pins = [...new Set(String(row?.pincodes || '').split(',').map((p) => p.trim())
      .filter((p) => /^[0-9]{6}$/.test(p)))];
    let cities = [];
    if (pins.length) {
      const [rows] = await pool.query(
        `SELECT c.city_name, COUNT(*) AS n
           FROM tbl_pincode p JOIN tbl_city c ON c.city_id = p.city_id
          WHERE p.pincode IN (?)
          GROUP BY c.city_id, c.city_name
          ORDER BY n DESC, c.city_name
          LIMIT 20`,
        [pins],
      );
      cities = rows.map((r) => r.city_name).filter(Boolean);
    }
    return {
      earnedLifetime: Math.round(Number(row?.earned_lifetime) || 0),
      points: Math.trunc(Number(row?.points) || 0),
      workArea: { cities, pinCount: pins.length },
    };
  } catch (e) {
    logger.warn({ err: e.message, efrId }, 'fetchTechFacts failed; header tiles empty');
    return empty;
  }
}

/*
 * The skills chip: the category holding most of his ACTIVE deep-skill picks
 * (tbl_efr_deepskill_mapping, is_repairing = 1 — the table auto-assign matches
 * on) and how many categories he has in all. The chip opens deep skills, so it
 * reads the same rows.
 */
async function fetchSkills(efrId) {
  try {
    const [rows] = await pool.query(
      `SELECT sc.service_catg_name AS name, COUNT(*) AS n
         FROM tbl_efr_deepskill_mapping m
         JOIN tbl_service_catg sc ON sc.service_catg_id = m.category_id
        WHERE m.easyfixer_id = ? AND m.is_repairing = 1
        GROUP BY sc.service_catg_id, sc.service_catg_name
        ORDER BY n DESC, sc.service_catg_name
        LIMIT 50`,
      [efrId],
    );
    return { primary: rows[0]?.name ?? null, count: rows.length };
  } catch (e) {
    logger.warn({ err: e.message, efrId }, 'fetchSkills failed');
    return { primary: null, count: 0 };
  }
}

/*
 * D4: no per-technician window exists, so the COMPANY window from the property
 * (a code default when the row is absent or malformed). workingToday is
 * today's marked attendance — the same 'present' the attendance card shows.
 */
function workingHours(todayRow) {
  const parse = (v) => /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(String(v ?? '').trim());
  const m = parse(properties.getProperty(WORKING_HOURS_PROP)) || parse(WORKING_HOURS_DEFAULT);
  return {
    start: `${m[1]}:${m[2]}`,
    end: `${m[3]}:${m[4]}`,
    workingToday: attendanceStatus(todayRow) === 'present',
  };
}

/*
 * Critical · Today · Upcoming (D3), GO FIRST (D2), the escalation banner and
 * yesterday's count and ₹ — from ONE read of his open jobs (bounded) plus
 * yesterday's completions, then ONE technicianSharesForJobs over them. Sums are
 * his share, never a client price.
 *
 *   critical  open, not started (NOT_STARTED_SQL's rule), and the appointment
 *             has passed OR the job is escalated (latest rating row, the rule
 *             decorateEscalation and the CRM use).
 *   today     not critical, and its WORK DATE is today (appointment; check-in
 *             for a started job — workDateOf, so Home and the Bookings chips
 *             cannot disagree).
 *   upcoming  not critical, work date in the next 7 days after today.
 *   goFirstJobId  among not-started critical/today jobs: escalated first, then
 *             the earliest appointment — which is both "most overdue" and
 *             "earliest upcoming", one ascending order.
 *   escalation    that job, when it is escalated; else null.
 *   comingUpThisWeek  the upcoming count — the same 7-day window, named for
 *             its own card so the app never re-derives it.
 */
async function fetchHomeJobs(efrId, now = Date.now()) {
  const bucket = () => ({ count: 0, share: 0 });
  const blank = () => ({
    home: { critical: bucket(), today: bucket(), upcoming: bucket(), goFirstJobId: null, comingUpThisWeek: 0 },
    escalation: null,
    yesterday: { jobs: 0, earned: 0 },
  });
  try {
    const today = istDayAt(now);
    const yesterday = istDayAt(now - DAY_MS);
    const lastUpcoming = istDayAt(now + UPCOMING_DAYS * DAY_MS);
    const [rows] = await pool.query(
      `SELECT j.job_id, j.job_status, j.requested_date_time, j.checkin_date_time, j.checkout_date_time,
              COALESCE(st.service_type_name, sc.service_catg_name) AS title,
              COALESCE(NULLIF(TRIM(ad.locality), ''), ci.city_name) AS area,
              COALESCE(esc.is_escalated, 0) AS is_escalated
         FROM tbl_job j
         LEFT JOIN tbl_address ad ON ad.address_id = j.fk_address_id
         LEFT JOIN tbl_city ci ON ci.city_id = ad.city_id
         LEFT JOIN tbl_service_type st ON st.service_type_id = j.fk_service_type_id
         LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = j.fk_service_catg_id
         LEFT JOIN (SELECT r.job_id, MAX(r.table_id) AS table_id
                      FROM tbl_easyfixer_rating_by_customer r
                      JOIN tbl_job rj ON rj.job_id = r.job_id
                     WHERE rj.fk_easyfixter_id = ? AND rj.job_status IN (${ACTIVE_STATUSES})
                     GROUP BY r.job_id) latest ON latest.job_id = j.job_id
         LEFT JOIN tbl_easyfixer_rating_by_customer esc ON esc.table_id = latest.table_id
        WHERE j.fk_easyfixter_id = ?
          AND (j.job_status IN (${ACTIVE_STATUSES})
               OR (j.job_status IN (3, 5) AND j.checkout_date_time >= ? AND j.checkout_date_time < ?))
        ORDER BY j.requested_date_time, j.job_id
        LIMIT ${HOME_JOB_CAP}`,
      [efrId, efrId, `${yesterday} 00:00:00`, `${today} 00:00:00`],
    );
    // ponytail: HOME_JOB_CAP open jobs; a technician holding more reads truncated sums.
    const shares = rows.length ? await technicianSharesForJobs(pool, rows.map((r) => r.job_id)) : new Map();
    const shareOf = (r) => Number(shares.get(Number(r.job_id))?.amount) || 0;
    const out = blank();
    const candidates = [];
    for (const r of rows) {
      const status = Number(r.job_status);
      if (status === 3 || status === 5) {
        out.yesterday.jobs += 1;
        out.yesterday.earned += shareOf(r);
        continue;
      }
      const escalated = Number(r.is_escalated) === 1;
      const appointment = istInstantMs(r.requested_date_time);
      const day = istDayOf(workDateOf(r));
      let b = null;
      if (notStarted(r) && ((appointment != null && appointment < now) || escalated)) b = 'critical';
      else if (day === today) b = 'today';
      else if (day && day > today && day <= lastUpcoming) b = 'upcoming';
      if (!b) continue;
      out.home[b].count += 1;
      out.home[b].share += shareOf(r);
      if (b !== 'upcoming' && notStarted(r)) candidates.push({ r, escalated, appointment });
    }
    candidates.sort((a, b) => (Number(b.escalated) - Number(a.escalated))
      || ((a.appointment ?? Infinity) - (b.appointment ?? Infinity))
      || (Number(a.r.job_id) - Number(b.r.job_id)));
    const first = candidates[0];
    out.home.goFirstJobId = first ? Number(first.r.job_id) : null;
    out.escalation = first && first.escalated
      ? { jobId: Number(first.r.job_id), title: first.r.title ?? null, area: first.r.area ?? null }
      : null;
    out.home.comingUpThisWeek = out.home.upcoming.count;
    for (const k of ['critical', 'today', 'upcoming']) out.home[k].share = Math.round(out.home[k].share);
    out.yesterday.earned = Math.round(out.yesterday.earned);
    return out;
  } catch (e) {
    logger.warn({ err: e.message, efrId }, 'fetchHomeJobs failed; Home sections empty');
    return blank();
  }
}

/*
 * "Your best day is N jobs" — the most jobs he completed (3/5, by checkout) on
 * one IST day in the last 90. It moves at most once a day, so it is cached per
 * technician for an hour: in-process, keyed by efr_id and never shared across
 * technicians, same TTL shape as properties.service. A failure is not cached.
 */
const bestDayCache = new Map(); // efrId → { value, at }
async function fetchBestDay(efrId, now = Date.now()) {
  const key = Number(efrId);
  const hit = bestDayCache.get(key);
  if (hit && now - hit.at < BEST_DAY_TTL_MS) return hit.value;
  try {
    const [[row]] = await pool.query(
      `SELECT MAX(t.n) AS best
         FROM (SELECT COUNT(*) AS n FROM tbl_job
                WHERE fk_easyfixter_id = ? AND job_status IN (3, 5) AND checkout_date_time >= ?
                GROUP BY DATE(checkout_date_time)) t`,
      [key, `${istDayAt(now - BEST_DAY_WINDOW_DAYS * DAY_MS)} 00:00:00`],
    );
    const value = Number(row?.best) || 0;
    // ponytail: wholesale clear at the cap — bounded memory; an LRU if it ever matters.
    if (bestDayCache.size >= BEST_DAY_CACHE_MAX) bestDayCache.clear();
    bestDayCache.set(key, { value, at: now });
    return value;
  } catch (e) {
    logger.warn({ err: e.message, efrId }, 'fetchBestDay failed');
    return null;
  }
}

/* "Anita Mehra" → "Anita M." — the card names the customer, not their surname. */
function shortName(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

/*
 * His latest customer rating with words, who gave it and when. The reviewer is
 * the name booked on that job (JOB_CUSTOMER_NAME_EXPR — the job's own name,
 * master as fallback), shortened. The text is the customer's comment, else the
 * review comment. table_id is the PK, so "latest" is the newest row.
 */
async function fetchLatestReview(efrId) {
  try {
    const [[row]] = await pool.query(
      `SELECT r.customer_rating, r.comment, r.review_comment, r.insert_date_time,
              ${jobService.JOB_CUSTOMER_NAME_EXPR} AS customer_name
         FROM tbl_easyfixer_rating_by_customer r
         LEFT JOIN tbl_job j ON j.job_id = r.job_id
         LEFT JOIN tbl_customer cu ON cu.customer_id = j.fk_customer_id
        WHERE r.easyfixer_id = ? AND r.customer_rating > 0
        ORDER BY r.table_id DESC
        LIMIT 1`,
      [efrId],
    );
    if (!row) return null;
    const text = [row.comment, row.review_comment].map((t) => String(t ?? '').trim()).find(Boolean) || null;
    return {
      rating: Number(row.customer_rating),
      text,
      reviewer: shortName(row.customer_name),
      at: row.insert_date_time ?? null,
    };
  } catch (e) {
    logger.warn({ err: e.message, efrId }, 'fetchLatestReview failed');
    return null;
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
    // totalAmount (j.total_amount) REMOVED 2026-09-24 — V3 3.9: a client
    // price never reaches the technician's phone. His figure is
    // technician_share on GET /jobs; routes/mobile/money-split.js also strips
    // the key from this payload in case a projection brings it back.
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
module.exports = {
  getDashboard, fetchIdentity,
  _internals: {
    istDayOf, dedupeById, isStarted, isTodaysWork, workDateOf, fetchDateCounts, ACTIVE_STATUSES,
    // V3 Phase 4 — asserted without a database in tests/v4-a-dashboard.test.js.
    fetchTechFacts, fetchSkills, fetchHomeJobs, fetchBestDay, fetchLatestReview, workingHours,
    istInstantMs, shortName, bestDayCache,
  },
};
