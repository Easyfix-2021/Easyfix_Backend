/*
 * QuickSight — STATE and USER Performance scorecards.
 *
 * These are the CITY Performance report's metrics over a different dimension —
 * built for the new "Performance Report" page's State and User tabs. Every
 * metric definition, period window, filter clause, TAT SLA CASE and rounding
 * rule is IMPORTED from quicksight-city-performance.service.js `_internals`
 * rather than copied, so the three reports can never drift on a parity fix.
 *
 * Metrics per period bucket (identical to City, 3 buckets, most-recent first):
 *   tktCreated · openOrders · processJobs · sdaCount · sdaPercentage · tatPercentage
 *
 * ── STATE ────────────────────────────────────────────────────────────────
 * A clean dimension swap: the city report's joins already reach tbl_city, which
 * carries state_id, so GROUP BY TCY.state_id over the same job set. Every job
 * belongs to exactly one state, so the State tab's totals RECONCILE with the
 * City tab's.
 *
 * ── USER ─────────────────────────────────────────────────────────────────
 * The dimension is a CRM user's "Manage Regions" grant (tbl_user.manage_states,
 * the geo scope introduced by the Manage Regions change), NOT a column on the
 * job. So it is computed as: per-STATE raw counts (one query per period, the
 * whole window) → summed into each user over the states they manage →
 * percentages RECOMPUTED from those sums.
 *
 * ⚠ TWO consequences of that model, both intentional and surfaced to the
 *   operator via the `note` this service returns (do not silently drop it):
 *
 *   1. OVERLAPPING REGIONS DOUBLE-COUNT. Two users who both manage Karnataka
 *      each get all of Karnataka's jobs, so the User tab's column totals can
 *      exceed the City/State tabs'. That is the honest reading of "how much
 *      work sits in this user's regions" — it is a per-user workload view, not
 *      a partition of the jobs.
 *   2. Percentages MUST be recomputed from summed numerators/denominators,
 *      never averaged across states — averaging percentages would weight a
 *      2-job state the same as a 2000-job one.
 *
 * Why summing per-state counts instead of one query per user: users are few but
 * a per-user query would be a textbook N+1 (and each would re-scan tbl_job).
 * This is 3 period queries + 1 user query regardless of how many users exist.
 *
 * `manage_states = '0'` is the legacy ALL sentinel (lib/scope.js parseScope) —
 * such a user covers EVERY state, so they get the window's full totals.
 */

const { pool } = require('../../db');
const logger = require('../../logger');
const { JOB_STATUS } = require('./_shared');
const cityService = require('./quicksight-city-performance.service');

const {
  buildPeriods, plusDaysIso, buildFilterClause, inClause, r0,
  TAT_SLA_CASE, GROUPED_CAP, CITY_PAGE_CAP,
} = cityService._internals;

/*
 * The USER tab's caveat, returned to the FE so the wording lives in ONE place
 * (the report that computes the numbers) instead of being re-invented in the UI.
 */
const USER_OVERLAP_NOTE =
  'Each row counts every job in the regions (states) that user manages. '
  + 'Where two users manage the same region, that region\'s jobs are counted for '
  + 'BOTH — so these column totals can exceed the City and State tabs. Read a row '
  + 'as "the workload sitting in this user\'s regions", not as a share of the total.';

// Legacy verbatim status buckets — identical to the city report's (see its
// getCityPeriodDetails comment for why these are NOT tidied into constants).
const OPEN_EXCLUSION = '3, 5, 6, 7';
const PROGRESS_DENOM = '2, 20, 10, 15, 21, 3, 5';

// The metric SELECT list, parameterised only by the GROUP BY dimension. Raw
// COUNT/SUM only — percentages are derived in JS so they can be recomputed from
// summed counts on the User path.
function metricSelect(dimExpr, dimAlias) {
  const [cA, cB] = JOB_STATUS.COMPLETED; // [3,5]
  return `SELECT ${dimExpr} AS ${dimAlias},
       COUNT(*) AS total_jobs,
       COUNT(CASE WHEN TJ.job_status NOT IN (${OPEN_EXCLUSION}) THEN TJ.job_id END) AS open_job_count,
       COUNT(CASE WHEN TJ.job_status IN (${PROGRESS_DENOM}) THEN TJ.job_id END) AS progress_jobs,
       SUM(CASE WHEN TJ.job_status IN (${PROGRESS_DENOM})
                 AND DATE(TJ.checkin_date_time) IS NOT NULL
                 AND DATE(TJ.original_appointment_date_time) IS NOT NULL
                 AND DATE(TJ.checkin_date_time) <= DATE(TJ.original_appointment_date_time)
                THEN 1 ELSE 0 END) AS sda_count,
       SUM(CASE WHEN TJ.job_status IN (${cA}, ${cB})
                 AND FLOOR(TIMESTAMPDIFF(MINUTE, TJ.ticket_created_date_time, TJ.checkout_date_time) / 1440.0) <= ${TAT_SLA_CASE}
                THEN 1 ELSE 0 END) AS tat_count,
       COUNT(CASE WHEN TJ.job_status IN (${cA}, ${cB}) THEN TJ.job_id END) AS completed_orders`;
}

// The city report's join chain, verbatim — TCY is what carries state_id, and
// TCY.tier is what TAT_SLA_CASE reads, so the chain cannot be trimmed.
const JOIN_CHAIN = `
       FROM tbl_job TJ
       LEFT JOIN tbl_address TA ON TA.address_id = TJ.fk_address_id
       LEFT JOIN tbl_city TCY ON TCY.city_id = TA.city_id
       LEFT JOIN tbl_client TC ON TC.client_id = TJ.fk_client_id`;

// Zeroed bucket — same null-percentage semantics as the city report.
function zeroBucket(period) {
  return {
    detailsFor: period.label,
    startDate: period.startDate,
    endDate: period.endDate,
    tktCreated: 0,
    openOrders: 0,
    processJobs: 0,
    sdaCount: 0,
    tatCount: 0,
    completedOrders: 0,
    sdaPercentage: null,
    tatPercentage: null,
  };
}

// Raw counts → a display bucket. The ONE place percentages are derived, so the
// State and User paths cannot disagree on the formula.
function bucketFrom(period, raw) {
  if (!raw) return zeroBucket(period);
  const totalJobs = Number(raw.total_jobs) || 0;
  const openJobs = Number(raw.open_job_count) || 0;
  const progressJobs = Number(raw.progress_jobs) || 0;
  const sdaCount = Number(raw.sda_count) || 0;
  const tatCount = Number(raw.tat_count) || 0;
  const completedOrder = Number(raw.completed_orders) || 0;
  return {
    detailsFor: period.label,
    startDate: period.startDate,
    endDate: period.endDate,
    tktCreated: totalJobs,
    openOrders: openJobs,
    processJobs: progressJobs,
    /*
     * The raw SDA/TAT numerators + denominators are surfaced, not just the
     * percentages, so the CHARTS can compute a page-level SDA%/TAT% from summed
     * counts. Averaging the per-row percentages would weight a 2-job state the
     * same as a 2000-job one — the same trap the User dimension avoids server-side.
     */
    sdaCount,
    tatCount,
    completedOrders: completedOrder,
    sdaPercentage: progressJobs > 0 ? r0((sdaCount / progressJobs) * 100) : null,
    tatPercentage: completedOrder > 0 ? r0((tatCount / completedOrder) * 100) : null,
  };
}

// ─── STATE ───────────────────────────────────────────────────────────────

async function getStateList({ filters, overallStart, overallEndInclusive, limit, offset }) {
  const params = [];
  let where =
    ' WHERE TJ.ticket_created_date_time >= ?'
    + ' AND TJ.ticket_created_date_time <= ?'
    + ' AND TCY.state_id IS NOT NULL';
  params.push(overallStart, overallEndInclusive);
  where += buildFilterClause(filters, params, { withVertical: true, withProjectManager: true });

  const sql =
    `SELECT DISTINCT TCY.state_id AS state_id, TS.state_name AS state_name
       ${JOIN_CHAIN}
       LEFT JOIN tbl_state TS ON TS.state_id = TCY.state_id
       ${where}
      ORDER BY TS.state_name ASC
      LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  const [rows] = await pool.query(sql, params);
  if (rows.length >= CITY_PAGE_CAP) {
    logger.warn({ report: 'state-performance', cap: CITY_PAGE_CAP }, 'State page hit the safety cap');
  }
  return rows.map((r) => ({ stateId: r.state_id, stateName: r.state_name || '' }));
}

async function getTotalStateCount({ filters, overallStart, overallEndInclusive }) {
  const params = [];
  let where =
    ' WHERE TJ.ticket_created_date_time >= ?'
    + ' AND TJ.ticket_created_date_time <= ?'
    + ' AND TCY.state_id IS NOT NULL';
  params.push(overallStart, overallEndInclusive);
  where += buildFilterClause(filters, params, { withVertical: true, withProjectManager: true });
  const [[row]] = await pool.query(
    `SELECT COUNT(DISTINCT TCY.state_id) AS total ${JOIN_CHAIN} ${where}`,
    params,
  );
  return Number(row && row.total) || 0;
}

/*
 * Per-state raw counts for one period. `stateIds` narrows to the page; pass
 * null to aggregate EVERY state in the window (the User path needs all of them
 * so it can fold states into users).
 */
async function getStatePeriodDetails({ filters, stateIds, start, endInclusive }) {
  if (Array.isArray(stateIds) && stateIds.length === 0) return new Map();
  const params = [start, endInclusive];
  let where =
    ' WHERE TJ.ticket_created_date_time >= ?'
    + ' AND TJ.ticket_created_date_time <= DATE_ADD(?, INTERVAL 1 DAY)'
    + ' AND TCY.state_id IS NOT NULL';
  where += buildFilterClause(filters, params, { withVertical: true, withProjectManager: true });
  if (Array.isArray(stateIds)) where += ` AND TCY.state_id IN ${inClause(stateIds, params)}`;

  const sql = `${metricSelect('TCY.state_id', 'state_id')} ${JOIN_CHAIN} ${where}
      GROUP BY TCY.state_id
      LIMIT ${GROUPED_CAP}`;
  const [rows] = await pool.query(sql, params);
  if (rows.length >= GROUPED_CAP) {
    logger.warn({ report: 'state-performance', cap: GROUPED_CAP }, 'State period aggregate hit the grouped cap');
  }
  const map = new Map();
  for (const r of rows) map.set(Number(r.state_id), r);
  return map;
}

async function getStatePerformance({ flag = 'monthly', page = 1, pageSize = 10, filters = {} } = {}) {
  logger.info('State performance scorecard · flag=' + flag + ' page=' + page + ' pageSize=' + pageSize);
  const periods = buildPeriods(flag);
  const overallStart = periods[periods.length - 1].startDate;
  const overallEndInclusive = plusDaysIso(periods[0].endDate, 1);
  const offset = (page - 1) * pageSize;

  const [states, totalRecords] = await Promise.all([
    getStateList({ filters, overallStart, overallEndInclusive, limit: pageSize, offset }),
    getTotalStateCount({ filters, overallStart, overallEndInclusive }),
  ]);

  if (states.length === 0) {
    return {
      data: [{ stateId: null, stateName: 'No state', periods: periods.map(zeroBucket) }],
      page, pageSize, totalRecords: 0, totalPages: 0,
    };
  }

  const stateIds = states.map((s) => s.stateId);
  const perPeriod = await Promise.all(periods.map(async (p) => ({
    p,
    details: await getStatePeriodDetails({ filters, stateIds, start: p.startDate, endInclusive: p.endDate }),
  })));

  const data = states.map((st) => ({
    stateId: st.stateId,
    stateName: st.stateName,
    periods: perPeriod.map(({ p, details }) => bucketFrom(p, details.get(Number(st.stateId)))),
  }));

  logger.info('Returning ' + data.length + ' state rows (total=' + totalRecords + ')');
  return {
    data, page, pageSize, totalRecords,
    totalPages: Math.ceil(totalRecords / pageSize),
  };
}

// ─── USER (Manage Regions) ───────────────────────────────────────────────

/*
 * Internal users holding a Manage Regions grant. `manage_states = '0'` is the
 * legacy ALL sentinel; '' / NULL means no regions, and those users are excluded
 * (a row of zeros for someone who manages nothing is noise, not information).
 */
async function getRegionUsers() {
  const [rows] = await pool.query(
    `SELECT u.user_id, u.user_name, u.manage_states
       FROM tbl_user u
      WHERE u.user_type_id = 5
        AND u.user_status = 1
        AND u.manage_states IS NOT NULL
        AND TRIM(u.manage_states) <> ''
      ORDER BY u.user_name ASC`,
  );
  return rows.map((r) => {
    const csv = String(r.manage_states || '').trim();
    const all = csv === '0';
    const stateIds = all ? [] : csv.split(',')
      .map((t) => Number(String(t).trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    return { userId: Number(r.user_id), userName: r.user_name || `User #${r.user_id}`, all, stateIds };
  }).filter((u) => u.all || u.stateIds.length > 0);
}

// Sum raw metric rows — the ONLY safe way to combine states into a user (the
// percentages are recomputed from these sums by bucketFrom).
function sumRaw(rows) {
  if (rows.length === 0) return null;
  const acc = {
    total_jobs: 0, open_job_count: 0, progress_jobs: 0,
    sda_count: 0, tat_count: 0, completed_orders: 0,
  };
  for (const r of rows) {
    for (const k of Object.keys(acc)) acc[k] += Number(r[k]) || 0;
  }
  return acc;
}

async function getUserPerformance({ flag = 'monthly', page = 1, pageSize = 10, filters = {} } = {}) {
  logger.info('User (regions) performance scorecard · flag=' + flag + ' page=' + page);
  const periods = buildPeriods(flag);

  const users = await getRegionUsers();
  const totalRecords = users.length;
  if (totalRecords === 0) {
    return {
      data: [{ userId: null, userName: 'No user with regions', regionCount: 0, periods: periods.map(zeroBucket) }],
      page, pageSize, totalRecords: 0, totalPages: 0, note: USER_OVERLAP_NOTE,
    };
  }

  /*
   * Page the USER dimension IN MEMORY. Users are a few hundred at most and the
   * expensive part (the job scan) is per-PERIOD, not per-user — so paging in SQL
   * would save nothing while making the fold-states-into-users step harder.
   */
  const offset = (page - 1) * pageSize;
  const pageUsers = users.slice(offset, offset + pageSize);

  // stateIds:null → every state in the window, so any user's region set can be
  // served from this one aggregate per period.
  const perPeriod = await Promise.all(periods.map(async (p) => ({
    p,
    details: await getStatePeriodDetails({ filters, stateIds: null, start: p.startDate, endInclusive: p.endDate }),
  })));

  const data = pageUsers.map((u) => ({
    userId: u.userId,
    userName: u.userName,
    // 'All' users cover every state present in the window, not a fixed count.
    regionCount: u.all ? null : u.stateIds.length,
    allRegions: u.all,
    periods: perPeriod.map(({ p, details }) => {
      const rows = u.all
        ? [...details.values()]
        : u.stateIds.map((sid) => details.get(Number(sid))).filter(Boolean);
      return bucketFrom(p, sumRaw(rows));
    }),
  }));

  logger.info('Returning ' + data.length + ' user rows (total=' + totalRecords + ')');
  return {
    data, page, pageSize, totalRecords,
    totalPages: Math.ceil(totalRecords / pageSize),
    note: USER_OVERLAP_NOTE,
  };
}

// ─── XLSX ────────────────────────────────────────────────────────────────

/*
 * Flat rows for the download, mirroring the city exporter's period-suffixed
 * column shape (p0_* = most recent).
 */
function toXlsx(payload, flag, dimension) {
  const labels = buildPeriods(flag).map((p) => p.label);
  const isUser = dimension === 'user';
  const columns = [
    isUser
      ? { key: 'userName', header: 'User', width: 26 }
      : { key: 'stateName', header: 'State', width: 26 },
  ];
  if (isUser) columns.push({ key: 'regionLabel', header: 'Regions', width: 12 });
  labels.forEach((label, i) => {
    columns.push(
      { key: `p${i}_tkt`, header: `${label} — Tickets`, width: 16 },
      { key: `p${i}_sda`, header: `${label} — SDA %`, width: 14 },
      { key: `p${i}_tat`, header: `${label} — TAT %`, width: 14 },
      { key: `p${i}_open`, header: `${label} — Open`, width: 14 },
    );
  });

  const pct = (v) => (v == null ? '' : v / 100);
  const rows = (payload.data || []).map((row) => {
    const out = isUser
      ? { userName: row.userName, regionLabel: row.allRegions ? 'All' : String(row.regionCount ?? '') }
      : { stateName: row.stateName };
    (row.periods || []).forEach((p, i) => {
      out[`p${i}_tkt`] = p.tktCreated;
      out[`p${i}_sda`] = pct(p.sdaPercentage);
      out[`p${i}_tat`] = pct(p.tatPercentage);
      out[`p${i}_open`] = p.openOrders;
    });
    return out;
  });
  return { columns, rows };
}

module.exports = { getStatePerformance, getUserPerformance, toXlsx, USER_OVERLAP_NOTE };
