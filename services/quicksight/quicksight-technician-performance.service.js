/*
 * QuickSight — Technician Performance (monthly / weekly) service.
 *
 * Native rebuild of the legacy ACD_APIs endpoints:
 *   POST /pmJobs/technicianPerformance
 *     controller PmWorkDetails.java:375-384
 *     service    JobServiceImpl.java:4838-5091
 *     repos      JobSecondRepository.getTechnicianList (635-670),
 *                getTechnicianCount (671-701),
 *                getTechnicianPerformanceDetails (703-754)
 *   GET  /pmJobs/technicianPerformanceCategoryWise
 *     controller PmWorkDetails.java:386-394
 *     service    JobServiceImpl.java:5106-5186
 *     repo       JobSecondRepository.getTxPerformancePerCategory (757-802)
 *
 * One page of technicians (paginated over DISTINCT fk_easyfixter_id) each
 * carrying 3 period buckets (most-recent → oldest by display, but ordered
 * oldest→newest in the array to match the legacy DTO list — see below) plus
 * per-tech enrichment (city/state/status/balance/attendance). The category
 * drill-down returns per-category aggregates for ONE tech across the 3 periods.
 *
 * FAITHFUL-MIGRATION decisions applied (registry `decisions` block):
 *   - PRESERVE legacy plain COUNT / SUM (NO DISTINCT) for fan-out parity.
 *   - Admin sees ALL technicians — no per-row scope filtering (legacy had
 *     none server-side; gated only by requireQuickSight at the router).
 *   - Blank-enrichment rows are KEPT via LEFT JOIN (legacy NPE'd on a tech
 *     with no city/state; native guards nulls and shows blank cells).
 *   - The legacy scalar IS-NULL sentinel is replaced with buildInFilter.
 *   - The +1-day inclusive upper bound is preserved exactly: the SQL binds
 *     `sqlEnd = periodEnd + 1 day` against `<= ?`; the DTO stores the display
 *     end as `periodEnd` (sqlEnd - 1).
 *   - HIGH non-truncating safety LIMITs with logger.warn when the cap is hit.
 *   - Legacy typo column names kept verbatim (fk_easyfixter_id,
 *     is_technician_Verified, tbl_service_catg, TCY.tier).
 *   - The two SDA% denominators are DIFFERENT and both preserved:
 *       main list      → worked_jobs
 *       category drill → checked_orders
 *   - The category SDA-count CASE omits the IS NOT NULL guards present in the
 *     main query (legacy parity: DATE(NULL) comparison ⇒ NULL ⇒ not counted).
 *   - Period selection by `flag`: anything !== 'weekly' (case-insensitive) is
 *     monthly (legacy JobServiceImpl:4886 else-branch).
 *
 * Performance note: the legacy code ran getTechnicianPerformanceDetails once
 * per (tech, period) — an N*3 round-trip N+1. This rewrite keeps the SQL byte-
 * faithful but batches each PERIOD into ONE query across the whole page's tech
 * set (3 queries total instead of N*3), preserving identical per-(tech,period)
 * aggregates because the GROUP BY key is fk_easyfixter_id and every filter /
 * status bucket is unchanged. House rule: every value is bound via `?`.
 */

const { pool } = require('../../db');
const logger = require('../../logger');
const {
  buildInFilter,
  computeLastThreeWeeks,
  computeLastThreeMonths,
} = require('./_shared');

// Safety caps — legacy had NONE. Deliberately high so they never truncate a
// real production run; if one IS hit we logger.warn (no silent drop).
const TECH_LIST_CAP = 50000;   // distinct technician ids (unpaginated count guard)
const GROUPED_CAP = 5000;      // grouped per-period aggregate rows

const MONTH_NAMES = [
  'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
];
function monthName(isoDate) {
  const m = Number(isoDate.slice(5, 7)); // 1..12
  return MONTH_NAMES[m - 1] || '';
}

// sqlEnd = displayEnd + 1 day (preserve legacy +1-day inclusive upper bound).
function nextDay(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/*
 * Build the 3 period windows + their display labels, oldest→newest (matching
 * the legacy DTO list order — FE reads technicianPerformanceDataDateWise[0..2]
 * left→right and the legacy service appended periods in iteration order).
 *   weekly  → last 3 FULL Sun–Sat weeks (excludes current partial week).
 *   monthly → current partial month (1st..today) + 2 prior FULL months.
 * _shared returns both oldest→newest already.
 *   - weekly label  : "<start> - <end>" (ISO dates; FE formats)
 *   - monthly label : full month name (e.g. "JUNE") to match legacy Month enum
 * detailsFor mirrors the legacy DTO: month name (monthly) or "Week i" (weekly).
 */
function buildPeriods(flag) {
  const weekly = String(flag).toLowerCase() === 'weekly';
  if (weekly) {
    const weeks = computeLastThreeWeeks(); // oldest→newest, length 3
    return weeks.map((w, idx) => ({
      detailsFor: `Week ${idx + 1}`,
      label: `${w.start} - ${w.end}`,
      startDate: w.start,        // display start
      endDate: w.end,            // display end (inclusive)
      sqlStart: w.start,
      sqlEnd: nextDay(w.end),    // +1-day inclusive upper bound
    }));
  }
  const months = computeLastThreeMonths(); // oldest→newest, length 3
  return months.map((m) => ({
    detailsFor: monthName(m.start),
    label: monthName(m.start),
    startDate: m.start,
    endDate: m.end,
    sqlStart: m.start,
    sqlEnd: nextDay(m.end),
  }));
}

/*
 * ── RM-team client-scoping ──────────────────────────────────────────
 *
 * Mirrors JobServiceImpl 4873-4882 + FloorDisciplineServiceImpl 431-450 /
 * 499-545. When reportingManagerId > 0:
 *   rmTeam        = [rm] + active user_type_id=5 users with reporting_manager=rm
 *   mappedClients = union of each team user's manage_clients CSV
 *   applyClientMapping = mappedClients non-empty AND NO team user is "admin"
 *                        (manage_clients NULL / '' / '0' ⇒ admin ⇒ no restriction)
 * Returns { applyClientMapping:boolean, mappedClientIds:number[] }. When the RM
 * is unset / <=0, returns applyClientMapping=false (no restriction). The FE
 * clears clientId when an RM is selected (mutually exclusive); the caller
 * ignores clientId in that branch.
 */
async function resolveRmScoping(reportingManagerId) {
  const rmId = Number(reportingManagerId);
  if (!rmId || rmId <= 0) return { applyClientMapping: false, mappedClientIds: [] };

  // rmTeam = RM + their direct reports (active, user_type_id=5). UserRepository
  // .java:92-96 findUsersByReportingManagerId verbatim predicate.
  const [teamRows] = await pool.query(
    `SELECT user_id FROM tbl_user
      WHERE user_status = 1 AND user_type_id = 5 AND reporting_manager = ?`,
    [rmId],
  );
  const teamIds = [rmId, ...teamRows.map((r) => r.user_id)];

  // manage_clients per team user (UserRepository.java:76-77 findManageClients-
  // ByUserId). If ANY team user is admin (manage_clients NULL/''/'0'), the
  // whole mapping returns "no restriction" (legacy getManagedClientIdsForUsers
  // returns null in that case → applyClientMapping stays false).
  const placeholders = teamIds.map(() => '?').join(',');
  const [mcRows] = await pool.query(
    `SELECT manage_clients FROM tbl_user WHERE user_id IN (${placeholders})`,
    teamIds,
  );

  const mapped = new Set();
  for (const row of mcRows) {
    const raw = row.manage_clients;
    if (raw == null || String(raw).trim() === '' || String(raw).trim() === '0') {
      // Admin team member ⇒ no client restriction at all.
      return { applyClientMapping: false, mappedClientIds: [] };
    }
    for (const part of String(raw).split(',')) {
      const t = part.trim();
      if (t === '' || t === '0') continue;
      const n = Number(t);
      if (Number.isFinite(n)) mapped.add(n);
    }
  }

  const mappedClientIds = Array.from(mapped);
  return {
    applyClientMapping: mappedClientIds.length > 0,
    mappedClientIds,
  };
}

/*
 * Shared WHERE fragment for the technician-LIST driver (getTechnicianList /
 * getTechnicianCount). Mirrors JobSecondRepository.java:635-701. The legacy
 * scalar IS-NULL sentinels are replaced by buildInFilter (omits the clause
 * when a filter list is empty). zonalManagerId/cityId/stateId join against the
 * TECHNICIAN's city (tbl_easyfixer.efr_cityId → tbl_city). serviceCategoryId
 * uses ONLY the first element in the legacy tech-list query (categId scalar
 * IN(:categId)) — preserved: we pass [first] to buildInFilter.
 *
 * NOTE the +1-day inclusive bound: window is sqlStart .. sqlEnd where sqlEnd =
 * overallDisplayEnd + 1 day, with the predicate `<= ?` (verbatim legacy
 * `ticket_created_date_time <= :endDate` where endDate = end.plusDays(1)).
 */
function buildListWhere({ filters, rmScope, overallStart, overallSqlEnd, params }) {
  let where =
    ' WHERE TJ.ticket_created_date_time >= ?' +
    ' AND TJ.ticket_created_date_time <= ?' +
    ' AND TJ.fk_easyfixter_id IS NOT NULL';
  params.push(overallStart, overallSqlEnd);

  // Client filter — IGNORED when an RM is set (mutually exclusive). Legacy:
  // clientId path only when reportingManagerId null/0.
  if (!rmScope.applyClientMapping && rmScope.rmActive !== true) {
    where += buildInFilter('TJ.fk_client_id', filters.clientId, params);
  }
  // RM client mapping (applyClientMapping branch): TJ.fk_client_id IN (mapped).
  if (rmScope.applyClientMapping) {
    where += buildInFilter('TJ.fk_client_id', rmScope.mappedClientIds, params);
  }

  where += buildInFilter('TCY.state_user', filters.zonalManagerId, params);
  // serviceCategoryId: legacy tech-list uses ONLY the first element (categId).
  const firstCateg =
    Array.isArray(filters.serviceCategoryId) && filters.serviceCategoryId.length
      ? [filters.serviceCategoryId[0]]
      : [];
  where += buildInFilter('TJ.fk_service_catg_id', firstCateg, params);
  where += buildInFilter('TCY.city_id', filters.cityId, params);
  where += buildInFilter('TCY.state_id', filters.stateId, params);
  return where;
}

/*
 * (1) getTechnicianList — paginated DISTINCT technician ids. Verbatim joins
 * from JobSecondRepository.java:635-652; ORDER BY fk_easyfixter_id DESC, LIMIT
 * pageSize OFFSET offset.
 * (2) getTechnicianCount — total distinct techs for pagination (671-686).
 */
async function getTechnicianPage({ filters, rmScope, overallStart, overallSqlEnd, page, pageSize }) {
  const offset = (page - 1) * pageSize;

  const listParams = [];
  const listWhere = buildListWhere({ filters, rmScope, overallStart, overallSqlEnd, params: listParams });
  const listSql =
    `SELECT DISTINCT(TJ.fk_easyfixter_id) AS tx_id
       FROM tbl_job TJ
       LEFT JOIN tbl_easyfixer TE ON (TE.efr_id = TJ.fk_easyfixter_id)
       LEFT JOIN tbl_city TCY ON (TCY.city_id = TE.efr_cityId)
       LEFT JOIN tbl_state TS ON (TS.state_id = TCY.state_id)
       LEFT JOIN tbl_client TC ON (TC.client_id = TJ.fk_client_id)
       ${listWhere}
       ORDER BY TJ.fk_easyfixter_id DESC
       LIMIT ? OFFSET ?`;
  listParams.push(pageSize, offset);

  const countParams = [];
  const countWhere = buildListWhere({ filters, rmScope, overallStart, overallSqlEnd, params: countParams });
  const countSql =
    `SELECT COUNT(DISTINCT(TJ.fk_easyfixter_id)) AS total
       FROM tbl_job TJ
       LEFT JOIN tbl_easyfixer TE ON (TE.efr_id = TJ.fk_easyfixter_id)
       LEFT JOIN tbl_city TCY ON (TCY.city_id = TE.efr_cityId)
       LEFT JOIN tbl_state TS ON (TS.state_id = TCY.state_id)
       LEFT JOIN tbl_client TC ON (TC.client_id = TJ.fk_client_id)
       ${countWhere}`;

  const [[listRows], [countRows]] = await Promise.all([
    pool.query(listSql, listParams),
    pool.query(countSql, countParams),
  ]);

  const totalRecords = Number(countRows[0]?.total) || 0;
  if (totalRecords >= TECH_LIST_CAP) {
    logger.warn(
      { report: 'technician-performance', cap: TECH_LIST_CAP, total: totalRecords },
      'Technician Performance distinct-tech count hit the safety cap — results may be incomplete',
    );
  }
  return { txIds: listRows.map((r) => r.tx_id), totalRecords };
}

/*
 * (3) getTechnicianPerformanceDetails — per-tech aggregates for ONE period,
 * batched across the page's tech set. Verbatim CASE buckets from
 * JobSecondRepository.java:703-741; only the `WHERE fk_easyfixter_id = :txId`
 * scalar is replaced by `IN (page tech ids)` + a GROUP BY so we collapse the
 * N*3 N+1 into one query per period with identical per-(tech) aggregates.
 *
 * Buckets (verbatim):
 *   total_jobs     : COUNT(job_id)
 *   open_jobs      : job_status IN (1,2,20)
 *   completed_jobs : job_status IN (3,5)
 *   cancelled_jobs : job_status = 6
 *   worked_jobs    : job_status NOT IN (0,1,6,7,9)
 *   sda_count      : job_status IN (2,20,10,15,21,3,5)
 *                    AND DATE(checkin) IS NOT NULL AND DATE(orig_appt) IS NOT NULL
 *                    AND DATE(checkin) <= DATE(orig_appt)
 *   tat_count      : job_status IN (3,5)
 *                    AND FLOOR(TIMESTAMPDIFF(MINUTE, ticket_created, checkout)/1440.0)
 *                        <= COALESCE(tier-threshold CASE, 3)
 * Filters mirror the per-period legacy detail query (clientId/zonalManagerId/
 * cityId/stateId — NOTE: legacy detail query did NOT re-apply categId). When an
 * RM mapping is active we still scope clientId to the mapped set for parity.
 */
async function getPeriodDetails({ txIds, filters, rmScope, sqlStart, sqlEnd }) {
  if (txIds.length === 0) return new Map();
  const params = [];
  const inFrag = txIds.map(() => '?').join(',');
  for (const id of txIds) params.push(id);
  params.push(sqlStart, sqlEnd);

  let where = '';
  if (rmScope.applyClientMapping) {
    where += buildInFilter('TJ.fk_client_id', rmScope.mappedClientIds, params);
  } else if (rmScope.rmActive !== true) {
    where += buildInFilter('TJ.fk_client_id', filters.clientId, params);
  }
  where += buildInFilter('TCY.state_user', filters.zonalManagerId, params);
  where += buildInFilter('TCY.city_id', filters.cityId, params);
  where += buildInFilter('TCY.state_id', filters.stateId, params);

  const sql =
    `SELECT TJ.fk_easyfixter_id AS tx_id,
       COUNT(TJ.job_id) AS total_jobs,
       SUM(CASE WHEN TJ.job_status IN (1,2,20) THEN 1 ELSE 0 END) AS open_jobs,
       SUM(CASE WHEN TJ.job_status IN (3, 5) THEN 1 ELSE 0 END) AS completed_jobs,
       SUM(CASE WHEN TJ.job_status IN (6) THEN 1 ELSE 0 END) AS cancelled_jobs,
       SUM(CASE WHEN TJ.job_status NOT IN (0,1,6,7,9) THEN 1 ELSE 0 END) AS worked_jobs,
       SUM(CASE
             WHEN TJ.job_status IN (2, 20, 10, 15, 21, 3, 5)
                  AND DATE(TJ.checkin_date_time) IS NOT NULL
                  AND DATE(TJ.original_appointment_date_time) IS NOT NULL
                  AND DATE(TJ.checkin_date_time) <= DATE(TJ.original_appointment_date_time)
             THEN 1 ELSE 0 END) AS sda_count,
       SUM(CASE
             WHEN TJ.job_status IN (3, 5)
                  AND FLOOR(TIMESTAMPDIFF(MINUTE, TJ.ticket_created_date_time, TJ.checkout_date_time) / 1440.0) <=
                      COALESCE((
                        CASE
                          WHEN TJ.fk_service_catg_id IN (1, 5, 21, 12) AND TCY.tier IN (1, 2) THEN 3
                          WHEN TJ.fk_service_catg_id IN (1, 5, 21, 12) AND TCY.tier = 3 THEN 5
                          WHEN TJ.fk_service_catg_id = 15 AND TCY.tier = 1 THEN 3
                          WHEN TJ.fk_service_catg_id = 15 AND TCY.tier = 2 THEN 5
                          WHEN TJ.fk_service_catg_id = 15 AND TCY.tier = 3 THEN 7
                          ELSE NULL
                        END), 3)
             THEN 1 ELSE 0 END) AS tat_count
       FROM tbl_job TJ
       LEFT JOIN tbl_easyfixer TE ON (TE.efr_id = TJ.fk_easyfixter_id)
       LEFT JOIN tbl_city TCY ON (TCY.city_id = TE.efr_cityId)
       LEFT JOIN tbl_state TS ON (TS.state_id = TCY.state_id)
       LEFT JOIN tbl_client TC ON (TC.client_id = TJ.fk_client_id)
       WHERE TJ.fk_easyfixter_id IN (${inFrag})
         AND TJ.ticket_created_date_time >= ?
         AND TJ.ticket_created_date_time <= ?
         ${where}
       GROUP BY TJ.fk_easyfixter_id
       LIMIT ${GROUPED_CAP}`;

  const [rows] = await pool.query(sql, params);
  if (rows.length >= GROUPED_CAP) {
    logger.warn(
      { report: 'technician-performance', cap: GROUPED_CAP, returned: rows.length },
      'Technician Performance per-period aggregate hit the grouped safety cap',
    );
  }
  const map = new Map();
  for (const r of rows) map.set(r.tx_id, r);
  return map;
}

/*
 * Per-tech enrichment — city/state/status/balance from tbl_easyfixer +
 * tbl_city(efr_cityId) + tbl_state, batched across the page. Replaces the
 * legacy per-tech easyfixerRepository.findById loop (4954-4999). LEFT JOINs +
 * null-guards (legacy NPE'd on a tech with null efr_cityId / null state).
 *   txStatus '1' only if is_technician_Verified=1 AND efr_status=1, else '0'
 *   txCurrentBalance = current_balance ?? 0
 * Legacy typo column name is_technician_Verified preserved verbatim.
 */
async function getTechEnrichment(txIds) {
  if (txIds.length === 0) return new Map();
  const params = [];
  const inFrag = txIds.map(() => '?').join(',');
  for (const id of txIds) params.push(id);

  const sql =
    `SELECT ef.efr_id,
            ef.efr_name,
            ef.current_balance,
            ef.is_technician_Verified,
            ef.efr_status,
            ci.city_name,
            st.state_name
       FROM tbl_easyfixer ef
       LEFT JOIN tbl_city ci ON ci.city_id = ef.efr_cityId
       LEFT JOIN tbl_state st ON st.state_id = ci.state_id
      WHERE ef.efr_id IN (${inFrag})`;
  const [rows] = await pool.query(sql, params);

  const map = new Map();
  for (const r of rows) {
    // BIT(1) columns can arrive as Buffer / number / boolean — normalise to 1/0.
    const verified = toBool(r.is_technician_Verified);
    const active = toBool(r.efr_status);
    map.set(r.efr_id, {
      txName: r.efr_name || '',
      txCity: r.city_name || 'NA',
      stateName: r.state_name || 'NA',
      txStatus: verified && active ? '1' : '0',
      txCurrentBalance: Number(r.current_balance) || 0,
    });
  }
  return map;
}

// Normalise a MySQL BIT(1) / TINYINT / boolean to a JS boolean.
function toBool(v) {
  if (v == null) return false;
  if (Buffer.isBuffer(v)) return v[0] === 1;
  if (typeof v === 'boolean') return v;
  return Number(v) === 1;
}

/*
 * Attendance for today + tomorrow, batched across the page. Mirrors the legacy
 * AttendanceRepository.findByEasyfixerIdAndCreatedOnBetween(txId, today,
 * today+1) per-tech loop (4963-4982). getAttendanceStatus():
 *   'L' if is_leave_marked, 'P' if morning_slot||evening_slot, else 'A'.
 *   default 'NA' when no attendance row for that date.
 * We pull all attendance rows for the page's techs in the [today .. tomorrow]
 * window and index by (efr_id, date). tbl_attendance columns confirmed via
 * _crosscut.json: easyfixer_id, morning_slot, evening_slot, is_leave_marked,
 * created_on.
 */
async function getAttendance(txIds) {
  const empty = new Map();
  if (txIds.length === 0) return empty;
  const params = [];
  const inFrag = txIds.map(() => '?').join(',');
  for (const id of txIds) params.push(id);

  // Window: CURDATE() .. CURDATE()+2 days (covers today + tomorrow rows).
  const sql =
    `SELECT easyfixer_id,
            DATE(created_on) AS att_date,
            is_leave_marked,
            morning_slot,
            evening_slot
       FROM tbl_easyfixer_attendance
      WHERE easyfixer_id IN (${inFrag})
        AND created_on >= CURDATE()
        AND created_on < DATE_ADD(CURDATE(), INTERVAL 2 DAY)`;
  const [rows] = await pool.query(sql, params);

  // Resolve today's + tomorrow's ISO dates (server local date for DATE()).
  const todayIso = isoDate(new Date());
  const tomorrowIso = isoDate(new Date(Date.now() + 86400000));

  // Map<efr_id, { today: status, tomorrow: status }>
  const out = new Map();
  for (const id of txIds) out.set(id, { today: 'NA', tomorrow: 'NA' });

  for (const r of rows) {
    const status = attendanceStatus(r);
    const dateIso = isoDate(new Date(r.att_date));
    const slot = out.get(r.easyfixer_id);
    if (!slot) continue;
    if (dateIso === todayIso) slot.today = status;
    else if (dateIso === tomorrowIso) slot.tomorrow = status;
  }
  return out;
}

function attendanceStatus(row) {
  if (toBool(row.is_leave_marked)) return 'L';
  if (toBool(row.morning_slot) || toBool(row.evening_slot)) return 'P';
  return 'A';
}

function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// Legacy SDA%/TAT% rounding: round(count/denominator*100) HALF_UP, null when
// the denominator <= 0. Math.round matches HALF_UP for the non-negative ratios
// produced here.
function pct(count, denom) {
  if (!(denom > 0)) return null;
  return Math.round((count / denom) * 100);
}

/*
 * ── ENDPOINT 1: getTechnicianPerformance ────────────────────────────
 *
 * Returns the PaginatedResponse-shaped payload:
 *   { data: TechnicianPerformanceDto[], page, pageSize, totalRecords, totalPages }
 * TechnicianPerformanceDto = {
 *   txId, txName, txCity, stateName, txStatus, txCurrentBalance,
 *   txTodayAttendance, txTomAttendance, technicianPerformanceDataDateWise:[ x3 ]
 * }
 * TechnicianPerformanceDataDateWise = {
 *   txTktCreated, txOpenOrder, txSdaPercentage, txTatPercentage, txCancelOrder,
 *   txSdaCount, txCompletedOrder, workedOrder, detailsFor, startDate, endDate
 * }
 *
 * Empty-tech-list ⇒ ONE synthetic "No Technician" row (txId=null) with 3 zeroed
 * periods (legacy 4908-4946) so the FE always has [0] and [1] to read labels
 * from. period startDate/endDate are the DISPLAY dates (sqlEnd - 1).
 */
async function getTechnicianPerformance({ flag = 'monthly', page = 1, pageSize = 10, filters = {} } = {}) {
  logger.info('Technician Performance · flag=' + flag + ' page=' + page + ' pageSize=' + pageSize);
  const periods = buildPeriods(flag); // oldest→newest, length 3

  const reportingManagerId = filters.reportingManagerId;
  const rmActive = Number(reportingManagerId) > 0;
  const rmScopeBase = await resolveRmScoping(reportingManagerId);
  const rmScope = { ...rmScopeBase, rmActive };

  // Overall window = oldest period start .. (most-recent period sqlEnd).
  const overallStart = periods[0].sqlStart;
  const overallSqlEnd = periods[periods.length - 1].sqlEnd;

  const { txIds, totalRecords } = await getTechnicianPage({
    filters, rmScope, overallStart, overallSqlEnd, page, pageSize,
  });

  const totalPages = pageSize > 0 ? Math.ceil(totalRecords / pageSize) : 0;
  logger.info('Found ' + txIds.length + ' technicians on page · totalRecords=' + totalRecords);

  // Empty-list synthetic "No Technician" row (legacy parity).
  if (txIds.length === 0) {
    logger.info('Returning synthetic No-Technician row · 0 technicians');
    const zeroed = periods.map((p) => zeroPeriod(p));
    return {
      data: [{
        txId: null,
        txName: 'No Technician',
        txCity: 'NA',
        stateName: 'NA',
        txStatus: '0',
        txCurrentBalance: 0,
        txTodayAttendance: 'NA',
        txTomAttendance: 'NA',
        technicianPerformanceDataDateWise: zeroed,
      }],
      page, pageSize, totalRecords, totalPages,
    };
  }

  // Per-period aggregates (3 queries, batched across the page's techs) +
  // enrichment + attendance — all independent → fire in parallel.
  const [perPeriod, enrichment, attendance] = await Promise.all([
    Promise.all(
      periods.map(async (p) => ({
        p,
        details: await getPeriodDetails({
          txIds, filters, rmScope, sqlStart: p.sqlStart, sqlEnd: p.sqlEnd,
        }),
      })),
    ),
    getTechEnrichment(txIds),
    getAttendance(txIds),
  ]);

  const data = txIds.map((txId) => {
    const e = enrichment.get(txId) || {
      txName: '', txCity: 'NA', stateName: 'NA', txStatus: '0', txCurrentBalance: 0,
    };
    const att = attendance.get(txId) || { today: 'NA', tomorrow: 'NA' };

    const dateWise = perPeriod.map(({ p, details }) => {
      const d = details.get(txId);
      if (!d) return zeroPeriod(p);
      const total = Number(d.total_jobs) || 0;
      const open = Number(d.open_jobs) || 0;
      const completed = Number(d.completed_jobs) || 0;
      const cancelled = Number(d.cancelled_jobs) || 0;
      const worked = Number(d.worked_jobs) || 0;
      const sda = Number(d.sda_count) || 0;
      const tat = Number(d.tat_count) || 0;
      return {
        txTktCreated: total,
        txOpenOrder: open,
        txSdaPercentage: pct(sda, worked),       // denominator = worked_jobs
        txTatPercentage: pct(tat, completed),    // denominator = completed_jobs
        txCancelOrder: cancelled,
        txSdaCount: sda,
        txCompletedOrder: completed,
        workedOrder: worked,
        detailsFor: p.detailsFor,
        startDate: p.startDate,
        endDate: p.endDate,
      };
    });

    return {
      txId,
      txName: e.txName,
      txCity: e.txCity,
      stateName: e.stateName,
      txStatus: e.txStatus,
      txCurrentBalance: e.txCurrentBalance,
      txTodayAttendance: att.today,
      txTomAttendance: att.tomorrow,
      technicianPerformanceDataDateWise: dateWise,
    };
  });

  logger.info('Returning ' + data.length + ' technicians · totalRecords=' + totalRecords);
  return { data, page, pageSize, totalRecords, totalPages };
}

function zeroPeriod(p) {
  return {
    txTktCreated: 0,
    txOpenOrder: 0,
    txSdaPercentage: null,
    txTatPercentage: null,
    txCancelOrder: 0,
    txSdaCount: 0,
    txCompletedOrder: 0,
    workedOrder: 0,
    detailsFor: p.detailsFor,
    startDate: p.startDate,
    endDate: p.endDate,
  };
}

/*
 * ── ENDPOINT 2: getTxPerformanceCategoryWise ────────────────────────
 *
 * Per-category aggregates for ONE tech across the 3 periods. Verbatim SQL from
 * JobSecondRepository.java:757-797 — note the tier join is against the JOB
 * ADDRESS city (tbl_address.city_id → tbl_city), NOT the technician's city; and
 * the SDA-count CASE omits the IS NOT NULL guards present in the main query.
 *   SDA% denominator = checked_orders (DIFFERENT from main list = worked_jobs)
 *   TAT% denominator = completed_orders
 *
 * Returns TxCategoryWiseDataDto = {
 *   technicianId,
 *   performanceData: [{ detailsFor, startDate, endDate, categories:[...] } x3]
 * }
 * TxCategoryWisePerformanceDTO = {
 *   categoryId, categoryName, tktCount, tktCompleted, tktSdaCount, tktTatCount,
 *   txOpenOrderOnApp, sdaPercentage, tatPercentage
 * }
 */
async function getTxPerformanceCategoryWise({ flag = 'monthly', txId } = {}) {
  logger.info('Technician category-wise performance · flag=' + flag + ' txId=' + txId);
  const periods = buildPeriods(flag); // oldest→newest, length 3

  const performanceData = await Promise.all(
    periods.map(async (p) => {
      const rows = await getCategoryRows({ txId, sqlStart: p.sqlStart, sqlEnd: p.sqlEnd });
      const categories = rows.map((r) => {
        const total = Number(r.total_jobs) || 0;
        const completed = Number(r.completed_orders) || 0;
        const checked = Number(r.checked_orders) || 0;
        const sda = Number(r.sda_count) || 0;
        const tat = Number(r.tat_count) || 0;
        const openApp = Number(r.open_app_order) || 0;
        return {
          categoryId: r.service_catg_id,
          categoryName: r.service_catg_name || '',
          tktCount: total,
          tktCompleted: completed,
          tktSdaCount: sda,
          tktTatCount: tat,
          txOpenOrderOnApp: openApp,
          sdaPercentage: pct(sda, checked),       // denominator = checked_orders
          tatPercentage: pct(tat, completed),     // denominator = completed_orders
        };
      });
      return {
        detailsFor: p.detailsFor,
        startDate: p.startDate,
        endDate: p.endDate,
        categories,
      };
    }),
  );

  logger.info('Returning category-wise performance · txId=' + txId + ' periods=' + performanceData.length);
  return { technicianId: txId, performanceData };
}

async function getCategoryRows({ txId, sqlStart, sqlEnd }) {
  const params = [txId, sqlStart, sqlEnd];
  const sql =
    `SELECT TSC.service_catg_id,
            TSC.service_catg_name,
            COUNT(TJ.job_id) AS total_jobs,
            SUM(CASE WHEN TJ.job_status IN (1, 2, 20) THEN 1 ELSE 0 END) AS open_app_order,
            SUM(CASE WHEN TJ.job_status IN (3, 5) THEN 1 ELSE 0 END) AS completed_orders,
            SUM(CASE WHEN TJ.job_status IN (2, 3, 5, 10, 15, 20, 21) THEN 1 ELSE 0 END) AS checked_orders,
            SUM(CASE
                  WHEN TJ.job_status IN (2, 3, 5, 10, 15, 20, 21)
                       AND DATE(TJ.checkin_date_time) <= DATE(TJ.original_appointment_date_time)
                  THEN 1 ELSE 0 END) AS sda_count,
            SUM(CASE
                  WHEN TJ.job_status IN (3, 5)
                       AND FLOOR(TIMESTAMPDIFF(MINUTE, TJ.ticket_created_date_time, TJ.checkout_date_time) / 1440.0) <=
                           COALESCE((
                             CASE
                               WHEN TJ.fk_service_catg_id IN (1, 5, 21, 12) AND TCY.tier IN (1, 2) THEN 3
                               WHEN TJ.fk_service_catg_id IN (1, 5, 21, 12) AND TCY.tier = 3 THEN 5
                               WHEN TJ.fk_service_catg_id = 15 AND TCY.tier = 1 THEN 3
                               WHEN TJ.fk_service_catg_id = 15 AND TCY.tier = 2 THEN 5
                               WHEN TJ.fk_service_catg_id = 15 AND TCY.tier = 3 THEN 7
                               ELSE NULL
                             END), 3)
                  THEN 1 ELSE 0 END) AS tat_count
       FROM tbl_job TJ
       LEFT JOIN tbl_address TA ON TA.address_id = TJ.fk_address_id
       LEFT JOIN tbl_city TCY ON TCY.city_id = TA.city_id
       LEFT JOIN tbl_service_catg TSC ON TSC.service_catg_id = TJ.fk_service_catg_id
      WHERE TJ.fk_easyfixter_id = ?
        AND TJ.ticket_created_date_time >= ?
        AND TJ.ticket_created_date_time <= ?
      GROUP BY TJ.fk_service_catg_id, TSC.service_catg_name
      ORDER BY TSC.service_catg_name ASC
      LIMIT ${GROUPED_CAP}`;
  const [rows] = await pool.query(sql, params);
  return rows;
}

/*
 * Flatten the paginated main-list rows into the xlsx column set (replaces the
 * legacy clipboard "Copy Data"). One row per technician; per period (1..3) the
 * 4 metric columns prefixed with the period label so all 3 blocks read apart.
 * Header order mirrors the legacy Copy-Data intent (CORRECTED alignment):
 *   State, City, Tx Id, Tx Name, Current Balance, Today Attendance,
 *   Tomorrow Attendance, then per period: detailsFor, Ticket Assigned, SDA%,
 *   TAT%, Open Order In App.
 */
function toXlsx(payload) {
  const rows = (payload && payload.data) || [];
  const sample = rows[0]?.technicianPerformanceDataDateWise || [];
  const periodLabels = sample.map((d) => d.detailsFor);

  const columns = [
    { key: 'stateName', header: 'State', width: 18 },
    { key: 'txCity', header: 'City', width: 18 },
    { key: 'txId', header: 'Tx Id', width: 10 },
    { key: 'txName', header: 'Tx Name', width: 24 },
    { key: 'txCurrentBalance', header: 'Current Balance', width: 16 },
    { key: 'txTodayAttendance', header: 'Today Attendance', width: 16 },
    { key: 'txTomAttendance', header: 'Tomorrow Attendance', width: 18 },
  ];
  periodLabels.forEach((lbl, i) => {
    columns.push(
      { key: `p${i}_ticketAssigned`, header: `${lbl} · Ticket Assigned`, width: 18 },
      { key: `p${i}_sda`, header: `${lbl} · SDA%`, width: 10 },
      { key: `p${i}_tat`, header: `${lbl} · TAT%`, width: 10 },
      { key: `p${i}_openApp`, header: `${lbl} · Open Order In App`, width: 18 },
    );
  });

  const flatRows = rows.map((row) => {
    const out = {
      stateName: row.stateName,
      txCity: row.txCity,
      txId: row.txId,
      txName: row.txName,
      txCurrentBalance: row.txCurrentBalance,
      txTodayAttendance: row.txTodayAttendance,
      txTomAttendance: row.txTomAttendance,
    };
    (row.technicianPerformanceDataDateWise || []).forEach((d, i) => {
      out[`p${i}_ticketAssigned`] = d.txTktCreated;
      // null SDA/TAT render as '-' in the export (legacy '-' display rule).
      out[`p${i}_sda`] = d.txSdaPercentage == null ? '-' : d.txSdaPercentage;
      out[`p${i}_tat`] = d.txTatPercentage == null ? '-' : d.txTatPercentage;
      out[`p${i}_openApp`] = d.txOpenOrder;
    });
    return out;
  });

  return { columns, rows: flatRows };
}

module.exports = {
  getTechnicianPerformance,
  getTxPerformanceCategoryWise,
  toXlsx,
  // Cap surfaced so the route's xlsx export can request the full set
  // symbolically (avoids a hardcoded 50000 literal drifting from this cap).
  TECH_LIST_CAP,
  // Exposed for tests / reuse.
  buildPeriods,
  resolveRmScoping,
};
