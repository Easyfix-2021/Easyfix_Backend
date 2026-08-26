/*
 * Client Performance book — the NON-TAT aggregates behind
 * GET /api/client/performance.
 *
 * ⚠ TAT IS NOT COMPUTED HERE, AND MUST NOT BE.
 * ------------------------------------------------------------------
 * services/tat.service.js is the one place TAT is computed. This file used to
 * carry a copy of the old category × city-tier day-count thresholds; that
 * definition is retired and every trace of it has been removed rather than
 * left "for reference", because a second definition of TAT sitting in the tree
 * is how two screens end up disagreeing about the same job.
 *
 * The route composes the page from two sources:
 *   TAT / SLA / approval   → tat.forClientWindow()   (the engine, spec v1.0)
 *   everything below       → this file
 *
 * What is left here is deliberately everything the TAT engine does NOT answer:
 *
 *   volume()        completed vs cancelled per month. The engine only loads
 *                   COMPLETED jobs, so it cannot see a cancellation at all.
 *   closureStats()  average age at close and the cancellation count. Age at
 *                   close is a calendar duration, not a segment target — it
 *                   survives the TAT migration untouched.
 *   firstTimeFix()  did the job need a second visit. Independent of TAT: a job
 *                   can hit every segment target and still be a revisit.
 *
 * All three are scoped the same way the engine is — client, calendar window,
 * and optionally one reporting subtree.
 */
const { pool } = require('../db');
const logger = require('../logger');

// Completed = reached a terminal success state. Mirrors tat.service's
// COMPLETED_STATUSES; cancelled is tracked separately because the engine
// never sees it.
const COMPLETED_STATUSES = '(3,5)';
const CANCELLED_STATUS = '6';

/*
 * Shared WHERE for a client + calendar window + optional hierarchy scope.
 *
 * ⚠ THE WINDOW PREDICATE IS DELIBERATELY NOT `COALESCE(checkout, cancel)`.
 *
 * That reads well and is the obvious way to say "whenever this job closed",
 * but wrapping an indexed column in a function makes the comparison
 * NON-SARGABLE: MySQL cannot use an index on checkout_date_time when the
 * column appears inside COALESCE, so the whole client's job history gets
 * scanned no matter what indexes exist.
 *
 * Instead the window is expressed as two OR'd branches, each testing a BARE
 * column, so each can use its own index:
 *
 *   completed (3,5) → checkout_date_time  → idx_job_client_status_checkout
 *   cancelled (6)   → cancel_date_time    → idx_job_client_status_cancel
 *
 * The branches are disjoint by status, so this is semantically identical to
 * the COALESCE form — a completed job closes at checkout, a cancelled one at
 * cancellation, and no job is both.
 *
 * `to` is inclusive: the caller passes a date and a job closed at 18:40 that
 * day belongs to it.
 */
function closedWindowClause() {
  return `(
     (J.job_status IN ${COMPLETED_STATUSES}
        AND J.checkout_date_time >= ? AND J.checkout_date_time < DATE_ADD(?, INTERVAL 1 DAY))
     OR
     (J.job_status = ${CANCELLED_STATUS}
        AND J.cancel_date_time >= ? AND J.cancel_date_time < DATE_ADD(?, INTERVAL 1 DAY))
   )`;
}

/**
 * @param mode 'closed'    — completed OR cancelled in the window (two branches)
 *             'completed' — completed only, so a single bare-column range
 */
function scopeWhere({ clientId, from, to, reportingContactIds, city }, mode = 'closed') {
  const params = [clientId];
  let clause = 'J.fk_client_id = ?';
  /*
   * `join` is returned ALONGSIDE the clause because these queries select
   * `FROM tbl_job J` with no address join of their own — unlike the TAT
   * engine, whose projection already reads city_name. A caller that
   * interpolates the clause without the join gets a 500 on an unknown alias,
   * so the two travel together and every caller spreads both.
   */
  let join = '';

  if (from && to) {
    if (mode === 'completed') {
      clause += ` AND J.job_status IN ${COMPLETED_STATUSES}
                  AND J.checkout_date_time >= ? AND J.checkout_date_time < DATE_ADD(?, INTERVAL 1 DAY)`;
      params.push(from, to);
    } else {
      clause += ` AND ${closedWindowClause()}`;
      params.push(from, to, from, to);
    }
  }
  if (Array.isArray(reportingContactIds) && reportingContactIds.length) {
    clause += ` AND J.reporting_contact_id IN (${reportingContactIds.map(() => '?').join(',')})`;
    params.push(...reportingContactIds);
  }
  const cityName = String(city || '').trim();
  if (cityName) {
    join = ` LEFT JOIN tbl_address AD ON AD.address_id = J.fk_address_id
             LEFT JOIN tbl_city    CI ON CI.city_id    = AD.city_id`;
    clause += ' AND CI.city_name = ?';
    params.push(cityName);
  }
  return { clause, params, join };
}

/**
 * Average age at close, plus the completed / cancelled split for the window.
 * One query — these three numbers always appear together on the page.
 */
async function closureStats(scope) {
  const { clause, params, join } = scopeWhere(scope, 'closed');
  // `|| {}` guards the destructure: a GROUP-less aggregate always yields one
  // row in MySQL, but a driver returning none would otherwise throw here
  // rather than degrade.
  const [rows] = await pool.query(`
    SELECT
      SUM(CASE WHEN J.job_status IN ${COMPLETED_STATUSES} THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN J.job_status = ${CANCELLED_STATUS} THEN 1 ELSE 0 END)    AS cancelled,
      AVG(CASE WHEN J.job_status IN ${COMPLETED_STATUSES}
               THEN TIMESTAMPDIFF(HOUR, J.ticket_created_date_time, J.checkout_date_time) / 24.0 END) AS avg_age_days
    FROM tbl_job J${join}
    WHERE ${clause}`, params);
  const row = rows[0] || {};

  return {
    completed: Number(row.completed || 0),
    cancelled: Number(row.cancelled || 0),
    avgAgeDays: row.avg_age_days == null ? null : Math.round(Number(row.avg_age_days) * 10) / 10,
  };
}

/*
 * `linked_job(parent_job_id, child_job_id)` is a legacy table that may not
 * exist — job.service.js already treats it as optional. Probed once per
 * process so first-time-fix degrades to null instead of 500ing.
 */
let linkedJobAvailable = null;
async function hasLinkedJob() {
  if (linkedJobAvailable !== null) return linkedJobAvailable;
  try {
    const [rows] = await pool.query("SHOW TABLES LIKE 'linked_job'");
    linkedJobAvailable = rows.length > 0;
  } catch (e) {
    logger.warn('linked_job probe failed (' + e.message + ') — first-time-fix reported as unavailable');
    linkedJobAvailable = false;
  }
  if (!linkedJobAvailable) {
    logger.warn('linked_job absent — first-time-fix and revisit rate will report null');
  }
  return linkedJobAvailable;
}

/**
 * First time fix: completed jobs that did NOT spawn a follow-up visit.
 * Revisit rate is returned as the exact complement, same denominator, so the
 * two can never contradict each other on the page.
 *
 * Returns nulls when linked_job is absent. A null the UI renders as "—" is
 * correct; a fabricated 100% is not.
 */
async function firstTimeFix(scope) {
  if (!(await hasLinkedJob())) {
    return { ftfrPct: null, revisitPct: null, available: false };
  }
  const { clause, params, join } = scopeWhere(scope, 'completed');
  const [rows] = await pool.query(`
    SELECT COUNT(*) AS completed,
           SUM(CASE WHEN lj.parent_job_id IS NULL THEN 1 ELSE 0 END) AS first_time_fixed
      FROM tbl_job J${join}
      LEFT JOIN (SELECT DISTINCT parent_job_id FROM linked_job) lj ON lj.parent_job_id = J.job_id
     WHERE ${clause}`, params);
  const row = rows[0] || {};

  const completed = Number(row.completed || 0);
  if (!completed) return { ftfrPct: null, revisitPct: null, available: true };
  const ftfr = Math.round((Number(row.first_time_fixed || 0) / completed) * 1000) / 10;
  return { ftfrPct: ftfr, revisitPct: Math.round((100 - ftfr) * 10) / 10, available: true };
}

/**
 * Completed vs cancelled per calendar month, most recent `months` months.
 * Grouped on the closing date for the same reason the window is — a month's
 * bar is the work that concluded in it.
 *
 * Deliberately NOT windowed by `scope.from`/`to`: the series is a trend behind
 * the selected period, so it always looks back from today.
 */
async function volume(scope, months = 6) {
  /*
   * `months` arrives off the query string, so it can be absent, junk, zero or
   * negative. `Math.max(Number(months) || 6, 1)` LOOKS like a clamp but is not:
   * -5 is truthy, so `|| 6` never fires, Math.max pins it to 1, and the series
   * silently collapses to the current month alone.
   *
   * Anything that is not a positive finite number falls back to 6; anything
   * that is gets truncated and capped at 24.
   */
  const raw = Number(months);
  const n = Number.isFinite(raw) && raw > 0 ? Math.min(Math.trunc(raw), 24) : 6;
  const params = [scope.clientId];
  let clause = 'J.fk_client_id = ?';
  let join = '';
  if (Array.isArray(scope.reportingContactIds) && scope.reportingContactIds.length) {
    clause += ` AND J.reporting_contact_id IN (${scope.reportingContactIds.map(() => '?').join(',')})`;
    params.push(...scope.reportingContactIds);
  }
  /*
   * City applies here too, even though this series deliberately ignores the
   * WINDOW ("Rolling, not this period" on the page). Those are different
   * decisions: the span is intentionally wider than the selection, but the
   * SUBJECT must not be — a trend for the whole client sitting under KPIs
   * scoped to one city would be two populations on one card. No caller drives
   * a city here yet; leaving the one scope-blind query in a service that now
   * takes city is how they drift apart later.
   */
  const cityName = String(scope.city || '').trim();
  if (cityName) {
    join = ` LEFT JOIN tbl_address AD ON AD.address_id = J.fk_address_id
             LEFT JOIN tbl_city    CI ON CI.city_id    = AD.city_id`;
    clause += ' AND CI.city_name = ?';
    params.push(cityName);
  }

  /*
   * COALESCE appears in the SELECT (grouping the surviving rows by month) but
   * NEVER in the WHERE — the range filter stays on bare columns so both
   * branches remain index-eligible. Grouping a filtered set is cheap; filtering
   * with a function is not.
   */
  const [rows] = await pool.query(`
    SELECT DATE_FORMAT(COALESCE(J.checkout_date_time, J.cancel_date_time), '%Y-%m') AS ym,
           SUM(CASE WHEN J.job_status IN ${COMPLETED_STATUSES} THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN J.job_status = ${CANCELLED_STATUS} THEN 1 ELSE 0 END)    AS cancelled
      FROM tbl_job J${join}
     WHERE ${clause}
       AND (
         (J.job_status IN ${COMPLETED_STATUSES} AND J.checkout_date_time >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL ${n - 1} MONTH))
         OR
         (J.job_status = ${CANCELLED_STATUS} AND J.cancel_date_time >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL ${n - 1} MONTH))
       )
     GROUP BY ym
     ORDER BY ym ASC`, params);

  return rows.map((r) => ({
    month: r.ym,
    completed: Number(r.completed || 0),
    cancelled: Number(r.cancelled || 0),
  }));
}

module.exports = { closureStats, firstTimeFix, volume };
