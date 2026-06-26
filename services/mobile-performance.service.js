const { pool } = require('../db');
const logger = require('../logger');
const gradeService = require('./grade.service');
const performanceService = require('./performance.service');

/*
 * Mobile weekly-performance reader — backs `GET /api/mobile/performance/weekly`.
 *
 * The RN technician app's home dashboard renders a per-week OTA/SDA bar
 * chart plus headline OTA / SDA / grade / rating / totals. This service
 * computes everything LIVE from `tbl_job` (there is NO pre-computed
 * performance table — see services/performance.service.js for the full
 * audit note) and reuses that service's exact OTA / SDA / rating /
 * grade definitions so the headline numbers stay consistent with the
 * rest of the platform.
 *
 * Definitions (mirrors performance.service.js):
 *   completed jobs — job_status IN (3, 5)
 *   OTA  — checkin_date_time <= requested_date_time + 60 min
 *   SDA  — DATE(checkin_date_time) = DATE(COALESCE(original_appointment_date_time, requested_date_time))
 *   rating — AVG(customer_rating) over the last 90 days from
 *            tbl_easyfixer_rating_by_customer (same window the
 *            candidate-ranking engine uses)
 *   grade — STILL STATIC ('A') until analytics confirms the cut-off rule.
 *
 * Per-week earnings source: `tbl_job_transaction.efr_charge` — the
 * technician's per-job earning over completed jobs. It is summed via a
 * correlated scalar subquery (NOT a JOIN) so a job with multiple
 * transaction rows can't fan out and inflate the OTA/SDA denominators
 * or the completed-job count.
 *
 * Bucketing uses YEARWEEK(checkin_date_time, 3) — ISO-8601, Monday-
 * anchored, week 01 is the week with the year's first Thursday. The JS
 * layer then derives each bucket's Monday `weekStart` and fills any
 * zero-job weeks in the requested range so the chart has one bar per
 * week.
 *
 * Technician FK on tbl_job is `fk_easyfixter_id` (legacy spelling).
 */

const COMPLETED_STATUSES = [3, 5];
const ON_TIME_WINDOW_MIN = 60;
const RATING_WINDOW_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/*
 * Build per-week buckets + headline aggregates for one technician over
 * the inclusive [from, to] window (both YYYY-MM-DD).
 *
 *   ota / sda      — window-level % (aggregate over all completed jobs
 *                    in the window, NOT an average of the weekly %s).
 *   grade          — static 'A' (from performance.service).
 *   rating         — 90-day avg customer rating.
 *   totalJobs      — completed jobs in the window.
 *   totalEarnings  — sum of weeks[].earnings.
 *   weeks[]        — one entry per ISO week in the range, ascending by
 *                    weekStart, gaps filled with zeros.
 */
async function getWeeklyPerformance(efrId, from, to) {
  if (!efrId) {
    return {
      ota: 0, sda: 0, grade: 'C', rating: 0,
      totalJobs: 0, totalEarnings: 0,
      weeks: buildWeekSkeleton(from, to),
    };
  }

  const [buckets, rating, accept] = await Promise.all([
    queryWeeklyBuckets(efrId, from, to).catch((e) => {
      logger.warn({ err: e.message, efrId }, 'mobile-performance weekly buckets failed');
      return [];
    }),
    computeRating(efrId).catch((e) => {
      logger.warn({ err: e.message, efrId }, 'mobile-performance rating failed');
      return 0;
    }),
    // Acceptance rate (jobs accepted / offered) — reuses performance.service's
    // scheduling_history definition so the Performance screen stays consistent
    // with the dashboard ring. Omitted when the tech has no offer history yet.
    performanceService.computeAcceptance(efrId).catch((e) => {
      logger.warn({ err: e.message, efrId }, 'mobile-performance acceptance failed');
      return { acceptanceRate: undefined };
    }),
  ]);

  // Index the DB rows by their ISO week key so we can merge them onto the
  // dense skeleton (every Monday in the requested range).
  const byKey = new Map();
  for (const r of buckets) {
    byKey.set(String(r.isoWeek), r);
  }

  let aggOnTime = 0;
  let aggSameDay = 0;
  let aggSample = 0;
  let totalJobs = 0;
  let totalEarnings = 0;

  const skeleton = buildWeekSkeleton(from, to);
  const weeks = skeleton.map((wk) => {
    const r = byKey.get(wk.isoWeek);
    if (!r) {
      return { weekStart: wk.weekStart, ota: 0, sda: 0, jobsDone: 0, earnings: 0 };
    }
    const sample = Number(r.sampleSize ?? 0);
    const onTime = Number(r.onTime ?? 0);
    const sameDay = Number(r.sameDay ?? 0);
    const jobs = Number(r.jobsDone ?? 0);
    const earn = Number(r.earnings ?? 0);

    aggOnTime += onTime;
    aggSameDay += sameDay;
    aggSample += sample;
    totalJobs += jobs;
    totalEarnings += earn;

    return {
      weekStart: wk.weekStart,
      ota: sample ? Math.round((onTime / sample) * 100) : 0,
      sda: sample ? Math.round((sameDay / sample) * 100) : 0,
      jobsDone: jobs,
      earnings: earn,
    };
  });

  return {
    ota: aggSample ? Math.round((aggOnTime / aggSample) * 100) : 0,
    sda: aggSample ? Math.round((aggSameDay / aggSample) * 100) : 0,
    // Real computed grade (snapshot-cached) — replaces the old static 'A'.
    grade: await gradeService.getGradeLetter(efrId),
    rating: Number(rating.toFixed(1)),
    // Acceptance rate is omitted (not 0) when the tech has no offer history.
    ...(accept.acceptanceRate !== undefined ? { acceptanceRate: accept.acceptanceRate } : {}),
    totalJobs,
    totalEarnings,
    weeks,
  };
}

/*
 * Single grouped query over the window. One row per ISO week that has at
 * least one completed, checked-in job. Earnings come from a correlated
 * scalar subquery so multi-row transactions never fan out the counts.
 *
 * `sampleSize` = completed jobs WITH a check-in stamp (the OTA/SDA
 * denominator); `jobsDone` is the same here (we already filter
 * checkin_date_time IS NOT NULL) but kept as a distinct count so the
 * chart's job tally and the metric denominator stay explicit.
 */
async function queryWeeklyBuckets(efrId, from, to) {
  const [rows] = await pool.query(
    `SELECT
        YEARWEEK(j.checkin_date_time, 3) AS isoWeek,
        COUNT(*) AS jobsDone,
        COUNT(*) AS sampleSize,
        SUM(j.checkin_date_time <= DATE_ADD(j.requested_date_time, INTERVAL ? MINUTE)) AS onTime,
        SUM(DATE(j.checkin_date_time) = DATE(COALESCE(j.original_appointment_date_time, j.requested_date_time))) AS sameDay,
        COALESCE(SUM(
          (SELECT COALESCE(SUM(tjt.efr_charge), 0)
             FROM tbl_job_transaction tjt
            WHERE tjt.fk_job_id = j.job_id)
        ), 0) AS earnings
       FROM tbl_job j
      WHERE j.fk_easyfixter_id = ?
        AND j.job_status IN (?)
        AND j.checkin_date_time IS NOT NULL
        AND j.checkin_date_time >= ?
        AND j.checkin_date_time < DATE_ADD(?, INTERVAL 1 DAY)
      GROUP BY isoWeek
      ORDER BY isoWeek ASC`,
    [ON_TIME_WINDOW_MIN, efrId, COMPLETED_STATUSES, from, to],
  );
  return rows;
}

/*
 * 90-day average customer rating — replicates performance.service.js's
 * computeRating (column is `insert_date_time`, NOT `created_date`).
 */
async function computeRating(efrId) {
  const [[row]] = await pool.query(
    `SELECT AVG(customer_rating) AS avgRating
       FROM tbl_easyfixer_rating_by_customer
      WHERE easyfixer_id = ?
        AND customer_rating IS NOT NULL
        AND insert_date_time >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [efrId, RATING_WINDOW_DAYS],
  );
  return Number(row?.avgRating ?? 0);
}

// ─────────────────────────────────────────────────────────────────────
// Week skeleton helpers (pure JS — no DB)
// ─────────────────────────────────────────────────────────────────────

/*
 * Snap a Date to the Monday 00:00 (UTC) of its ISO week.
 * getUTCDay(): 0=Sun..6=Sat → Monday-offset = (day + 6) % 7.
 */
function isoMonday(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const offset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - offset);
  return d;
}

/*
 * ISO-8601 week key matching MySQL YEARWEEK(?, 3) — `YYYYWW` as a string
 * (e.g. "202524"). Week 01 is the week containing the year's first
 * Thursday; the ISO week-year may differ from the calendar year at the
 * boundaries, which the Thursday-of-week trick handles correctly.
 */
function isoWeekKey(monday) {
  // The Thursday of this ISO week determines the ISO week-year.
  const thursday = new Date(monday.getTime() + 3 * MS_PER_DAY);
  const isoYear = thursday.getUTCFullYear();
  const jan1 = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.floor((thursday - jan1) / MS_PER_DAY / 7) + 1;
  return `${isoYear}${String(week).padStart(2, '0')}`;
}

function fmtDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/*
 * Dense list of every ISO week (Monday-anchored) touched by the inclusive
 * [from, to] range — one entry per week so the bar chart never has gaps.
 * Returns [{ isoWeek, weekStart }] ascending. Defensive against bad/empty
 * inputs (returns []) and swapped bounds (treated as empty).
 */
function buildWeekSkeleton(from, to) {
  if (!from || !to) return [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];

  const weeks = [];
  let cursor = isoMonday(start);
  const lastMonday = isoMonday(end);
  // Guard against runaway loops on pathological input (validator caps the
  // range at 26 weeks, but stay defensive).
  let guard = 0;
  while (cursor <= lastMonday && guard < 520) {
    weeks.push({ isoWeek: isoWeekKey(cursor), weekStart: fmtDate(cursor) });
    cursor = new Date(cursor.getTime() + 7 * MS_PER_DAY);
    guard += 1;
  }
  return weeks;
}

module.exports = { getWeeklyPerformance };
