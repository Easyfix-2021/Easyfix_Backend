const { pool } = require('../db');
const logger = require('../logger');
const gradeService = require('./grade.service');

/*
 * Performance metrics — canonical reader for OTA/SDA/grade/rating.
 *
 * NOT BACKED BY A PRE-COMPUTED TABLE.
 *
 * The original handoff spec (notice-board-spec.pdf §2) and the mobile
 * dev's hand-off note both assumed a daily-performance table existed
 * where some CRM-side process pre-computed OTA + SDA per technician
 * per day. Audit against the live DB (2026-05-25) — no such table
 * exists. Candidate tables and why they don't fit:
 *
 *   tbl_performance_matrix         — confidence-matrix lookup only
 *                                    (4 cols: id, name, score,
 *                                    confidance_matrix_id). Not
 *                                    per-tech per-day.
 *   tbl_easyfixer_daily_counter    — per-tech-per-day counter (3 cols),
 *                                    no OTA / SDA / rating breakdowns.
 *   tbl_tx_confidence_score        — PER-JOB candidate score (used by
 *                                    auto-allocation to rank candidates
 *                                    before assignment). Holds a single
 *                                    `performance_score` field — a
 *                                    rolled-up scalar, not the OTA% +
 *                                    SDA% breakdown the spec needs.
 *   tbl_easyfixer_rating_by_customer — per-job customer rating (used
 *                                    by candidate-ranking.service.js for
 *                                    the L3 weighted score). Average is
 *                                    the right source for `rating`.
 *
 * Decision: COMPUTE OTA + SDA on the fly from tbl_job, scoped to the
 * last N completed orders per the spec's "last 100 completed" rule.
 * Cheap on the dev DB (a single per-tech query with LIMIT 100). If
 * the response time becomes a concern, the same query can later be
 * pre-aggregated by a daily cron into a new `tbl_efr_perf_daily` —
 * the function signature stays the same.
 *
 * Definitions (per the spec):
 *   OTA  — % of jobs where `checkin_date_time <= requested_date_time + 60 min`
 *   SDA  — % of jobs where `DATE(checkin_date_time) = DATE(original_appointment_date_time)`
 *   Both computed over the last 100 completed orders (job_status IN 3, 5).
 *
 *   rating — AVG(customer_rating) over the last 90 days from
 *            `tbl_easyfixer_rating_by_customer`. Same window the
 *            candidate-ranking engine already uses.
 *
 *   grade  — STILL STATIC (A) until the analytics team confirms the
 *            cut-off rule. Once confirmed, two lines change here.
 *
 * Consumers:
 *   - Mobile App dashboard → `getForTech(efrId)` per home-screen load.
 *   - Future CRM "Top Technicians" report → `getForTechs([…])` bulk.
 */

const COMPLETED_STATUSES = [3, 5];
const LAST_N_JOBS = 100;
const ON_TIME_WINDOW_MIN = 60;
const RATING_WINDOW_DAYS = 90;

/*
 * Single-tech read. Issues two parallel queries (jobs + ratings).
 * Returns a stable shape even if the tech has no history yet.
 */
async function getForTech(efrId) {
  logger.info('Get tech performance · efrId=' + efrId);
  if (!efrId) return { ota: 0, sda: 0, grade: 'C', rating: 0 };

  const [otaSda, ratingAvg, accept] = await Promise.all([
    computeOtaSda(efrId).catch((e) => {
      logger.warn({ err: e.message, efrId }, 'performance.computeOtaSda failed');
      return { ota: 0, sda: 0, sampleSize: 0 };
    }),
    computeRating(efrId).catch((e) => {
      logger.warn({ err: e.message, efrId }, 'performance.computeRating failed');
      return 0;
    }),
    computeAcceptance(efrId).catch((e) => {
      logger.warn({ err: e.message, efrId }, 'performance.computeAcceptance failed');
      return { acceptanceRate: undefined };
    }),
  ]);

  logger.info('Tech performance computed · efrId=' + efrId + ' ota=' + otaSda.ota + ' sda=' + otaSda.sda + ' sample=' + otaSda.sampleSize);
  return {
    ota:    otaSda.ota,
    sda:    otaSda.sda,
    rating: Number(ratingAvg.toFixed(1)),
    // Real computed grade (snapshot-cached) — replaces the old static 'A'.
    // Drives the mobile dashboard + profile grade pill via performance.grade.
    grade: await gradeService.getGradeLetter(efrId),
    // Acceptance rate is omitted (not 0) when the tech has no offer history
    // yet, so the app can fall back to OTA for brand-new technicians.
    ...(accept.acceptanceRate !== undefined ? { acceptanceRate: accept.acceptanceRate } : {}),
  };
}

/*
 * Compute OTA + SDA % for one technician over their last N completed
 * jobs. Single query, three conditional SUMs + a denominator.
 *
 * NB: only jobs with non-null checkin_date_time are counted — a
 * completed job with no check-in stamp can't contribute to either
 * metric (would skew both downward with NULL-pessimism).
 */
async function computeOtaSda(efrId) {
  const [[row]] = await pool.query(
    `WITH recent AS (
       SELECT checkin_date_time, requested_date_time, original_appointment_date_time
         FROM tbl_job
        WHERE fk_easyfixter_id = ?
          AND job_status IN (?)
          AND checkin_date_time IS NOT NULL
        ORDER BY checkin_date_time DESC
        LIMIT ?
     )
     SELECT
       COUNT(*) AS sampleSize,
       SUM(checkin_date_time <= DATE_ADD(requested_date_time, INTERVAL ? MINUTE)) AS onTime,
       SUM(DATE(checkin_date_time) = DATE(COALESCE(original_appointment_date_time, requested_date_time))) AS sameDay
       FROM recent`,
    [efrId, COMPLETED_STATUSES, LAST_N_JOBS, ON_TIME_WINDOW_MIN],
  );
  const sampleSize = Number(row?.sampleSize ?? 0);
  if (sampleSize === 0) return { ota: 0, sda: 0, sampleSize: 0 };
  const onTime  = Number(row?.onTime ?? 0);
  const sameDay = Number(row?.sameDay ?? 0);
  return {
    ota:        Math.round((onTime  / sampleSize) * 100),
    sda:        Math.round((sameDay / sampleSize) * 100),
    sampleSize,
  };
}

/*
 * Compute Acceptance Rate = jobs ACCEPTED / jobs OFFERED for one
 * technician, from the legacy `scheduling_history` table. Every
 * assignment/offer to a tech inserts a row; a tech DECLINE (or admin
 * unassign) inserts a row carrying a NON-EMPTY `reschedule_reason`.
 * We treat a non-empty `reschedule_reason` as the canonical 'declined'
 * signal — the exact definition candidate-ranking.service.js already
 * trusts for its rejection filter.
 *
 * CAVEAT: scheduling_history's unassign path is shared by a tech
 * self-reject AND an admin force-unassign (there is no column that
 * distinguishes the two), so `declined` may slightly over-count — this
 * is the same proxy candidate-ranking already relies on.
 *
 * Returns { acceptanceRate: undefined } when the tech has never been
 * offered a job, so callers can omit the field and fall back to OTA for
 * brand-new technicians.
 */
async function computeAcceptance(efrId) {
  const [[row]] = await pool.query(
    `SELECT COUNT(DISTINCT job_id) AS offered,
            COUNT(DISTINCT CASE WHEN reschedule_reason IS NOT NULL AND reschedule_reason <> '' THEN job_id END) AS declined
       FROM scheduling_history
      WHERE easyfixer_id = ?`,
    [efrId],
  );
  const offered = Number(row?.offered) || 0;
  const declined = Number(row?.declined) || 0;
  logger.info('Acceptance computed · efrId=' + efrId + ' offered=' + offered + ' declined=' + declined);
  if (offered === 0) return { acceptanceRate: undefined };
  const rate = Math.round(((offered - declined) / offered) * 100);
  return { acceptanceRate: Math.max(0, Math.min(100, rate)) };
}

/*
 * Compute customer-rating average for one technician over the last
 * N days. Matches the window candidate-ranking.service.js uses for
 * the L3 weighted score — same source of truth.
 */
async function computeRating(efrId) {
  // Column is `insert_date_time` (audited live 2026-05-25), NOT
  // `created_date` — common gotcha across EasyFix tables. Window
  // matches candidate-ranking.service.js (90 days) for consistency
  // with the auto-allocation engine's rating computation.
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

/*
 * Bulk variant — for the CRM "Top Technicians" report. Same logic,
 * batched across many techs in two queries (one for jobs, one for
 * ratings). Returns a Map<efr_id, perfShape>.
 *
 * Cost: O(N) techs × O(100) jobs each, but executed as a single
 * GROUP BY with LIMIT-per-tech is awkward in MySQL. We instead fan
 * out a per-tech call when bulk is requested — acceptable up to
 * ~50 techs. For a hundred-tech report, pre-aggregate via cron.
 */
async function getForTechs(efrIds) {
  logger.info('Get bulk tech performance · count=' + (Array.isArray(efrIds) ? efrIds.length : 0));
  const map = new Map();
  if (!Array.isArray(efrIds) || efrIds.length === 0) return map;
  // Parallel fan-out, capped at 25 concurrent. Small batch keeps the
  // pool happy.
  const CONCURRENCY = 25;
  for (let i = 0; i < efrIds.length; i += CONCURRENCY) {
    const slice = efrIds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(slice.map((id) => getForTech(id)));
    slice.forEach((id, idx) => map.set(Number(id), results[idx]));
  }
  logger.info('Returning ' + map.size + ' tech performance records');
  return map;
}

module.exports = { getForTech, getForTechs, computeAcceptance };
