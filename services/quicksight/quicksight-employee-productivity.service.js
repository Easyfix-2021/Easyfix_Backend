/*
 * QuickSight — Employee Productivity (floor discipline) service layer.
 *
 *   registry slug : productivity
 *   urlBase       : employee-productivity
 *   legacy        : ACD_APIs FloorDiscipline* (POST /floorDiscipline/*)
 *
 * Faithful native port of the legacy FloorDisciplineRepository SQL +
 * FloorDisciplineServiceImpl orchestration + MetricsUtil maths. Six
 * endpoints share one filter-processing routine (processFloorFilters) that
 * mirrors the legacy ProcessedFloorFilterDto pipeline exactly.
 *
 * FAITHFUL-MIGRATION decisions (registry `decisions` block) applied here:
 *   - PRESERVE legacy plain COUNT / SUM (NO DISTINCT) for fan-out parity
 *     (the productivity metrics CTE; only legacy's own COUNT(DISTINCT …)
 *     usages are kept verbatim — closed_count, KRA rating/checkout counts).
 *   - Admin sees ALL — no req.scope row filtering (legacy had none; gate is
 *     ef-QuickSight + admin role).
 *   - Blank-PM / zero-metric users SHOWN: the page's user set is fetched
 *     first (STEP1) and LEFT-joined to their metrics in JS so a user with no
 *     activity still renders a 0 row (legacy createEmptyProductivity).
 *   - The legacy scalar IS-NULL sentinel ((:x IS NULL) OR col = :x) is kept
 *     where the legacy SQL used a SCALAR id (verticalId / zonalManagerId pass
 *     a single value, not a list) — these stay as parameterised
 *     `(? IS NULL OR col = ?)` guards. The legacy LIST sentinel
 *     (-1 IN (:ids) OR col IN (:ids)) for manage_clients / rmTeam is
 *     reproduced with buildInFilter + an applyClientFilter flag exactly as
 *     legacy `:applyClientFilter = 0 OR col IN (:manageClientIds)`.
 *   - The +1-day inclusive upper bound is preserved: processFloorFilters
 *     bumps endDate by 1 day (legacy LocalDate.plusDays(1)); the windowed
 *     SQL then uses BETWEEN start AND end (end already exclusive-of-next-day).
 *   - Legacy typo columns kept verbatim: fk_easyfixter_id, tbl_service_catg,
 *     full_fillment_by, original_scheduling_date_time, manage_verticals.
 *   - HIGH non-truncating safety LIMITs with logger.warn when a cap is hit.
 *
 * House rule: every user value is bound via `?`; column identifiers are
 * trusted report code, never user input. logger (not console). Service throws
 * Error with .status for the router to map to modernError.
 */

const { pool } = require('../../db');
const logger = require('../../logger');
const { buildInFilter } = require('./_shared');

// High safety caps — far above realistic counts; a hit is logged, never
// silently swallowed (registry decision: "no silent row drops").
const LIST_CAP = 50000;     // job-level / per-query
const GROUPED_CAP = 5000;   // grouped rows (per-user metrics, RM lists)
const MAX_PAGE_SIZE = 500;  // FE [10,50,80]; legacy used the BE page size as-is

/* ── manage_clients / rmTeam resolution helpers (legacy FloorDisciplineServiceImpl) ── */

/*
 * findUsersByReportingManagerId — UserRepository.java:92-96 verbatim:
 *   SELECT user_id FROM tbl_user
 *    WHERE user_status = 1 AND user_type_id = 5 AND reporting_manager = :rmId
 */
async function findUsersByReportingManagerId(rmId) {
  const sql =
    `SELECT user_id FROM tbl_user
      WHERE user_status = 1
        AND user_type_id = 5
        AND reporting_manager = ?`;
  const [rows] = await pool.query(sql, [rmId]);
  return rows.map((r) => Number(r.user_id));
}

/*
 * findManageClientsByUserId — UserRepository.java:76-77:
 *   SELECT manage_clients FROM tbl_user WHERE user_id = :userId
 * Returns the raw CSV string (or null).
 */
async function findManageClientsByUserId(userId) {
  const [rows] = await pool.query(
    'SELECT manage_clients FROM tbl_user WHERE user_id = ?',
    [userId],
  );
  return rows.length ? rows[0].manage_clients : null;
}

/*
 * Parse a manage_clients CSV into a client-id list.
 * Legacy getManagedClientIdsForUserOnly / getManagedClientIdsForUsers:
 *   null / empty / "0"  → null (= no client restriction = ALL)
 *   else split on ',' → numeric ids
 * A bad / non-numeric token aborts that user's contribution (legacy caught
 * NumberFormatException and skipped that user's ids) — we mirror with a
 * per-user try/skip.
 */
function parseManageClientsCsv(csv) {
  if (csv == null) return null;
  const trimmed = String(csv).trim();
  if (trimmed === '' || trimmed === '0') return null;
  const ids = [];
  for (const part of trimmed.split(',')) {
    const n = Number(part.trim());
    if (!Number.isFinite(n)) return null; // legacy: invalid CSV → null (all)
    ids.push(n);
  }
  return ids;
}

/*
 * processFloorFilters — port of FloorDisciplineServiceImpl.processFloorFilters
 * (lines 341-429). Resolves the raw request filters into the processed set the
 * SQL consumes. Returns:
 *   { dateMode, verticalId, zonalManagerId, startDate, endDate,
 *     userId, reportingManagerId, rmTeamUserIds, managedClientIds,
 *     applyClientFilter }
 *
 * Rules (verbatim):
 *   - dateMode default 'original' (empty/null → 'original').
 *   - verticalId / zonalManagerId: 0 → null (= no restriction).
 *   - endDate: parsed + 1 DAY (inclusive upper bound). startDate as-is.
 *   - userId > 0 WINS over RM: resolve ONLY that user's managed clients.
 *   - userId == 0 / null: managedClientIds reset to null; if RM > 0 then
 *     rmTeam = [rm] + findUsersByReportingManagerId(rm); managedClientIds =
 *     union of every team user's managed clients.
 *   - applyClientFilter = managedClientIds non-empty.
 *   - empty rmTeam → [-1] sentinel (so the LIST guard yields no users).
 */
async function processFloorFilters(raw) {
  const out = {
    dateMode: 'original',
    verticalId: null,
    zonalManagerId: null,
    startDate: null,
    endDate: null,
    userId: null,
    reportingManagerId: null,
    rmTeamUserIds: null,
    managedClientIds: null,
    applyClientFilter: false,
  };

  // dateMode — empty/null → 'original' (legacy default).
  out.dateMode = raw.findByDateType && String(raw.findByDateType).length
    ? String(raw.findByDateType)
    : 'original';

  // verticalId / zonalManagerId: 0 → null.
  out.verticalId = raw.verticalId && Number(raw.verticalId) !== 0 ? Number(raw.verticalId) : null;
  out.zonalManagerId =
    raw.zonalManagerId && Number(raw.zonalManagerId) !== 0 ? Number(raw.zonalManagerId) : null;

  // Dates — startDate as-is; endDate + 1 DAY (inclusive bound).
  out.startDate = raw.startDate && String(raw.startDate).length ? String(raw.startDate).trim() : null;
  if (raw.endDate && String(raw.endDate).length) {
    out.endDate = addOneDay(String(raw.endDate).trim());
  } else {
    out.endDate = null;
  }

  const rawUserId = raw.userId != null ? Number(raw.userId) : 0;
  const rawRmId = raw.reportingManagerId != null ? Number(raw.reportingManagerId) : 0;

  if (rawUserId === 0) {
    // No user filter: clients reset; userId null. (legacy: managedClientIds null)
    out.managedClientIds = null;
    out.userId = null;
  } else if (rawUserId > 0) {
    // User given — check ONLY this user's managed clients (no RMs).
    out.managedClientIds = parseManageClientsCsv(await findManageClientsByUserId(rawUserId));
    out.userId = rawUserId;
  }

  if (rawRmId === 0) {
    out.reportingManagerId = null;
    out.rmTeamUserIds = null;
  } else if (rawRmId > 0 && (out.userId == null || out.userId === 0)) {
    // RM given AND no user filter — check RM + team's managed clients.
    out.reportingManagerId = rawRmId;
    const teamMembers = await findUsersByReportingManagerId(rawRmId);
    const rmTeam = [rawRmId, ...teamMembers]; // RM itself first (legacy)
    out.rmTeamUserIds = rmTeam;

    // Union of every team user's managed clients.
    const managed = [];
    let anyAll = false;
    for (const uid of rmTeam) {
      const ids = parseManageClientsCsv(await findManageClientsByUserId(uid));
      if (ids == null) { anyAll = true; continue; } // null = that user manages all
      for (const id of ids) managed.push(id);
    }
    // Legacy union: dedupe; if any user manages all, the union still only
    // carries the explicit ids it collected (legacy added nothing for the
    // "all" case). We preserve that: managed is the collected explicit set.
    out.managedClientIds = managed.length ? Array.from(new Set(managed)) : (anyAll ? [] : []);
  } else {
    out.reportingManagerId = rawRmId > 0 ? rawRmId : null;
  }

  // applyClientFilter = managedClientIds non-empty (legacy).
  out.applyClientFilter =
    Array.isArray(out.managedClientIds) && out.managedClientIds.length > 0;

  logger.info('Resolved floor filters · dateMode=' + out.dateMode + ' verticalId=' + out.verticalId
    + ' zonalManagerId=' + out.zonalManagerId + ' userId=' + out.userId
    + ' reportingManagerId=' + out.reportingManagerId + ' applyClientFilter=' + out.applyClientFilter);

  // Empty rmTeam → [-1] sentinel.
  if (!Array.isArray(out.rmTeamUserIds) || out.rmTeamUserIds.length === 0) {
    out.rmTeamUserIds = [-1];
  }

  return out;
}

// Add 1 calendar day to a 'YYYY-MM-DD' string with NO timezone math (the
// legacy LocalDate.plusDays(1) — pure date arithmetic).
function addOneDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/*
 * Build the legacy `(:applyClientFilter = 0 OR col IN (:manageClientIds))`
 * client guard. When applyClientFilter is false the clause is a no-op (1=1).
 * When true, emit `col IN (?,?,…)` with the managed-client ids bound. Avoids
 * the empty-IN syntax error (buildInFilter emits nothing for [] — but
 * applyClientFilter is false in that case anyway, so the guard is skipped).
 */
function clientGuard(col, pf, params) {
  if (!pf.applyClientFilter) return '';
  // applyClientFilter true ⇒ managedClientIds non-empty.
  const placeholders = pf.managedClientIds.map(() => '?').join(',');
  for (const id of pf.managedClientIds) params.push(id);
  return ` AND ${col} IN (${placeholders})`;
}

/* ───────────────────────── 1. employee-productivity ───────────────────────── */

/*
 * getEmployeeProductivity — paginated per-employee productivity table.
 *
 * STEP1 getActiveUserList: the page's user set (user_type_id=5,
 *   user_status=1, user_role NOT IN (1)) scoped by vertical (manage_verticals
 *   FIND_IN_SET) and either a specific userId or the RM-team list, ordered by
 *   name, LIMIT/OFFSET.
 * STEP2 getTotalUserCount: same predicate, COUNT for totalRecords.
 * STEP3 getEmployeeProductivity: the metrics CTE over zonal-scoped
 *   filtered_jobs for ONLY the page's user ids; one COUNT/SUM per metric
 *   (booked / scheduled / cancelled / foh / estimate_sent / _approved /
 *   _rejected / revenue / closed_count). audit = estimate_sent +
 *   estimate_approved + estimate_rejected + foh (summed in JS, legacy line 200).
 *
 * Zero-metric users are LEFT-joined in JS (legacy createEmptyProductivity):
 * every STEP1 user appears, with 0s when they have no STEP3 row.
 */
async function getEmployeeProductivity({ pf, page, size }) {
  logger.info('Building Employee Productivity · page=' + page + ' size=' + size + ' dateMode=' + pf.dateMode);
  const offset = (page - 1) * size;

  // ── STEP1 — getActiveUserList (FloorDisciplineRepository:182-204) ──
  // verticalId: legacy used (:verticalId IS NULL OR manage_verticals='0' OR
  // FIND_IN_SET(:verticalId, manage_verticals)). userId>0 wins; else the
  // rmTeam list guard (-1 IN (:rmTeam) OR user_id IN (:rmTeam)).
  const userListSql =
    `SELECT TU.user_id, TU.user_name
       FROM tbl_user TU
      WHERE TU.user_type_id = 5
        AND TU.user_status = 1
        AND TU.user_role NOT IN (1)
        AND ( ? IS NULL
              OR TU.manage_verticals = '0'
              OR FIND_IN_SET(?, TU.manage_verticals) )
        AND ( ( ? IS NOT NULL AND ? > 0 AND TU.user_id = ? )
              OR ( ( ? IS NULL OR ? = 0 ) AND ( -1 IN (${placeholders(pf.rmTeamUserIds)}) OR TU.user_id IN (${placeholders(pf.rmTeamUserIds)}) ) ) )
      ORDER BY TU.user_name ASC
      LIMIT ? OFFSET ?`;
  const userListParams = [
    pf.verticalId, pf.verticalId,
    pf.userId, pf.userId, pf.userId,
    pf.userId, pf.userId,
    ...pf.rmTeamUserIds, ...pf.rmTeamUserIds,
    size, offset,
  ];
  const [userRows] = await pool.query(userListSql, userListParams);
  logger.info('Found ' + userRows.length + ' users on this page');

  if (userRows.length >= MAX_PAGE_SIZE) {
    logger.warn(
      { report: 'employee-productivity', returned: userRows.length, cap: MAX_PAGE_SIZE },
      'Employee Productivity page hit the max page-size — verify pagination',
    );
  }

  // ── STEP2 — getTotalUserCount (FloorDisciplineRepository:206-224) ──
  const countSql =
    `SELECT COUNT(TU.user_id) AS total
       FROM tbl_user TU
      WHERE TU.user_type_id = 5
        AND TU.user_status = 1
        AND TU.user_role NOT IN (1)
        AND ( ? IS NULL
              OR TU.manage_verticals = '0'
              OR FIND_IN_SET(?, TU.manage_verticals) )
        AND ( ( ? IS NOT NULL AND ? > 0 AND TU.user_id = ? )
              OR ( ( ? IS NULL OR ? = 0 ) AND ( -1 IN (${placeholders(pf.rmTeamUserIds)}) OR TU.user_id IN (${placeholders(pf.rmTeamUserIds)}) ) ) )`;
  const countParams = [
    pf.verticalId, pf.verticalId,
    pf.userId, pf.userId, pf.userId,
    pf.userId, pf.userId,
    ...pf.rmTeamUserIds, ...pf.rmTeamUserIds,
  ];
  const [countRows] = await pool.query(countSql, countParams);
  const totalRecords = Number(countRows[0]?.total) || 0;

  // Build the page user map (name + zero-row default).
  const userIds = userRows.map((r) => Number(r.user_id));
  const userNameMap = new Map(userRows.map((r) => [Number(r.user_id), r.user_name]));

  // No users on this page → empty data with the real totals.
  if (userIds.length === 0) {
    logger.info('No users on page · totalRecords=' + totalRecords);
    return {
      totalRecords,
      pageNumber: page,
      pageSize: size,
      totalPages: size > 0 ? Math.ceil(totalRecords / size) : 0,
      data: [],
    };
  }

  // ── STEP3 — getEmployeeProductivity metrics CTE (FloorDisciplineRepository:227-329) ──
  // filtered_jobs scoped by zonalManagerId via tbl_city.state_user. Each
  // metric branch counts/sums over the page user ids within the date window.
  // VERBATIM legacy: plain COUNT (booked/scheduled/cancelled/foh/estimates),
  // COUNT(DISTINCT) only for closed_count, IFNULL(SUM total_charge) revenue.
  const userIn = placeholders(userIds);
  const metricsSql =
    `WITH filtered_jobs AS (
        SELECT
            j.job_id,
            j.fk_created_by,
            j.fk_scheduled_by,
            j.cancel_by,
            j.full_fillment_by,
            j.fk_easyfixter_id,
            j.job_status,
            j.created_date_time,
            j.original_scheduling_date_time,
            j.cancel_date_time,
            j.full_fillment_created_time
        FROM tbl_job j
        LEFT JOIN tbl_address a ON a.address_id = j.fk_address_id
        LEFT JOIN tbl_city c ON c.city_id = a.city_id
        WHERE ( ? IS NULL OR c.state_user = ? )
     ),
     metrics AS (
        SELECT fk_created_by AS user_id, COUNT(job_id) AS cnt, 'booked' AS metric
        FROM filtered_jobs
        WHERE fk_created_by IN (${userIn})
          AND created_date_time BETWEEN ? AND ?
        GROUP BY fk_created_by
        UNION ALL
        SELECT fk_scheduled_by, COUNT(job_id), 'scheduled'
        FROM filtered_jobs
        WHERE fk_scheduled_by IN (${userIn})
          AND original_scheduling_date_time BETWEEN ? AND ?
        GROUP BY fk_scheduled_by
        UNION ALL
        SELECT cancel_by, COUNT(job_id), 'cancelled'
        FROM filtered_jobs
        WHERE cancel_by IN (${userIn})
          AND job_status = 6
          AND fk_easyfixter_id IS NOT NULL
          AND cancel_date_time BETWEEN ? AND ?
        GROUP BY cancel_by
        UNION ALL
        SELECT full_fillment_by, COUNT(job_id), 'foh'
        FROM filtered_jobs
        WHERE full_fillment_by IN (${userIn})
          AND full_fillment_created_time BETWEEN ? AND ?
        GROUP BY full_fillment_by
        UNION ALL
        SELECT e.sent_by, COUNT(e.job_id), 'estimate_sent'
        FROM tbl_estimate_details e
        INNER JOIN filtered_jobs fj ON fj.job_id = e.job_id
        WHERE e.sent_by IN (${userIn})
          AND e.sent_on BETWEEN ? AND ?
        GROUP BY e.sent_by
        UNION ALL
        SELECT e.sent_by, COUNT(e.job_id), 'estimate_approved'
        FROM tbl_estimate_details e
        INNER JOIN filtered_jobs fj ON fj.job_id = e.job_id
        WHERE e.sent_by IN (${userIn})
          AND e.STATUS = 1
          AND e.action_on BETWEEN ? AND ?
        GROUP BY e.sent_by
        UNION ALL
        SELECT e.sent_by, COUNT(e.job_id), 'estimate_rejected'
        FROM tbl_estimate_details e
        INNER JOIN filtered_jobs fj ON fj.job_id = e.job_id
        WHERE e.sent_by IN (${userIn})
          AND e.STATUS = 2
          AND e.action_on BETWEEN ? AND ?
        GROUP BY e.sent_by
        UNION ALL
        SELECT jt.updated_by, IFNULL(SUM(jt.total_charge), 0), 'revenue'
        FROM tbl_job_transaction jt
        INNER JOIN filtered_jobs fj ON fj.job_id = jt.fk_job_id
        WHERE jt.updated_by IN (${userIn})
          AND jt.insert_date BETWEEN ? AND ?
        GROUP BY jt.updated_by
        UNION ALL
        SELECT jt.updated_by, COUNT(DISTINCT jt.fk_job_id), 'closed_count'
        FROM tbl_job_transaction jt
        INNER JOIN filtered_jobs fj ON fj.job_id = jt.fk_job_id
        WHERE jt.updated_by IN (${userIn})
          AND jt.insert_date BETWEEN ? AND ?
        GROUP BY jt.updated_by
     )
     SELECT
        user_id,
        COALESCE(SUM(CASE WHEN metric = 'booked' THEN cnt END), 0) AS booked,
        COALESCE(SUM(CASE WHEN metric = 'scheduled' THEN cnt END), 0) AS scheduled,
        COALESCE(SUM(CASE WHEN metric = 'estimate_sent' THEN cnt END), 0) AS estimate_sent,
        COALESCE(SUM(CASE WHEN metric = 'estimate_approved' THEN cnt END), 0) AS estimate_approved,
        COALESCE(SUM(CASE WHEN metric = 'estimate_rejected' THEN cnt END), 0) AS estimate_rejected,
        COALESCE(SUM(CASE WHEN metric = 'closed_count' THEN cnt END), 0) AS closed_count,
        COALESCE(SUM(CASE WHEN metric = 'revenue' THEN cnt END), 0) AS revenue,
        COALESCE(SUM(CASE WHEN metric = 'cancelled' THEN cnt END), 0) AS cancel_count,
        COALESCE(SUM(CASE WHEN metric = 'foh' THEN cnt END), 0) AS foh
     FROM metrics
     GROUP BY user_id
     ORDER BY user_id`;

  // Window: legacy passed startDate/endDate (LocalDate). When the FE omits
  // dates the metrics windows are nullable — MySQL `BETWEEN NULL AND NULL`
  // yields NULL (no match), so an unset range produces zero metrics, exactly
  // like the legacy LocalDate nulls. We bind the processed start/end for every
  // windowed branch (9 windows → but 'cancelled' uses cancel_date_time,
  // others their own column; all 9 share the same start/end pair).
  const s = pf.startDate;
  const e = pf.endDate;
  const metricsParams = [
    pf.zonalManagerId, pf.zonalManagerId,        // filtered_jobs zonal guard
    ...userIds, s, e,                            // booked
    ...userIds, s, e,                            // scheduled
    ...userIds, s, e,                            // cancelled
    ...userIds, s, e,                            // foh
    ...userIds, s, e,                            // estimate_sent
    ...userIds, s, e,                            // estimate_approved
    ...userIds, s, e,                            // estimate_rejected
    ...userIds, s, e,                            // revenue
    ...userIds, s, e,                            // closed_count
  ];
  const [metricRows] = await pool.query(metricsSql, metricsParams);

  const metricMap = new Map();
  for (const r of metricRows) {
    const uid = Number(r.user_id);
    const estimateSent = Number(r.estimate_sent) || 0;
    const estimateApproved = Number(r.estimate_approved) || 0;
    const estimateRejected = Number(r.estimate_rejected) || 0;
    const fohCount = Number(r.foh) || 0;
    metricMap.set(uid, {
      booked: Number(r.booked) || 0,
      scheduled: Number(r.scheduled) || 0,
      // audit = estimate_sent + estimate_approved + estimate_rejected + foh
      // (legacy FloorDisciplineServiceImpl.java:200)
      audit: estimateSent + estimateApproved + estimateRejected + fohCount,
      closedCount: Number(r.closed_count) || 0,
      revenue: Number(r.revenue) || 0,
      cancelCount: Number(r.cancel_count) || 0,
    });
  }

  // LEFT-join in JS: every page user appears (zero-row default for no metrics).
  const data = userIds.map((uid) => {
    const m = metricMap.get(uid);
    return {
      userId: uid,
      userName: userNameMap.get(uid) || '',
      booked: m ? m.booked : 0,
      scheduled: m ? m.scheduled : 0,
      audit: m ? m.audit : 0,
      closedCount: m ? m.closedCount : 0,
      revenue: m ? m.revenue : 0,
      cancelCount: m ? m.cancelCount : 0,
    };
  });

  logger.info('Returning ' + data.length + ' productivity rows · totalRecords=' + totalRecords);
  return {
    totalRecords,
    pageNumber: page,
    pageSize: size,
    totalPages: size > 0 ? Math.ceil(totalRecords / size) : 0,
    data,
  };
}

// Build a comma-separated `?` placeholder run for an array (>=1 element).
function placeholders(arr) {
  return arr.map(() => '?').join(',');
}

/* ───────────────────────── 2. kra-metrics ───────────────────────── */

/*
 * getKraMetrics — single-row KRA aggregate (FloorDisciplineRepository:331-408
 * + FloorDisciplineServiceImpl:248-321 maths via MetricsUtil). filtered_jobs =
 * completed (3,5) checked-out in window OR unconfirmed (9), scoped by vertical
 * / zonal / client guard. Derived percentages / averages / margin computed in
 * JS exactly per MetricsUtil.
 */
async function getKraMetrics({ pf }) {
  logger.info('Computing KRA metrics · window=' + pf.startDate + '..' + pf.endDate);
  const params = [];
  // filtered_jobs window + scope. checkout_date_time BETWEEN start AND end.
  params.push(pf.startDate, pf.endDate);     // status IN (3,5) checkout window
  params.push(pf.verticalId, pf.verticalId); // vertical guard
  params.push(pf.zonalManagerId, pf.zonalManagerId); // zonal guard
  const clientFrag = clientGuard('TJ.fk_client_id', pf, params);

  const sql =
    `WITH filtered_jobs AS (
        SELECT
            TJ.job_id, TJ.job_status, TJ.checkin_date_time,
            TJ.checkout_date_time, TJ.original_appointment_date_time,
            TJ.requested_date_time, TJ.ticket_created_date_time,
            TJ.call_later, TJ.fk_address_id, TJ.fk_client_id
        FROM tbl_job TJ
        LEFT JOIN tbl_address TA ON TA.address_id = TJ.fk_address_id
        LEFT JOIN tbl_city TC ON TC.city_id = TA.city_id
        LEFT JOIN tbl_client TCL ON TCL.client_id = TJ.fk_client_id
        WHERE
            ((TJ.job_status IN (3, 5) AND TJ.checkout_date_time BETWEEN ? AND ?)
             OR (TJ.job_status = 9))
            AND ((? IS NULL) OR TCL.vertical_id = ?)
            AND ((? IS NULL) OR TC.state_user = ?)${clientFrag}
     ),
     job_transactions AS (
        SELECT TJT.fk_job_id, TJT.total_charge, TJT.efr_charge
        FROM tbl_job_transaction TJT
        WHERE TJT.fk_job_id IN (SELECT job_id FROM filtered_jobs)
     ),
     job_ratings AS (
        SELECT TRC.job_id, TRC.customer_rating
        FROM tbl_easyfixer_rating_by_customer TRC
        WHERE TRC.job_id IN (SELECT job_id FROM filtered_jobs)
          AND TRC.comment IS NOT NULL
     )
     SELECT
        COUNT(CASE WHEN FJ.job_status IN (3, 5) THEN 1 END) AS total_jobs,
        SUM(CASE
            WHEN FJ.job_status IN (3, 5)
                 AND DATE(FJ.checkin_date_time) <= DATE(FJ.original_appointment_date_time)
            THEN 1 ELSE 0 END) AS sda_count,
        SUM(CASE
            WHEN FJ.job_status IN (3, 5)
                 AND (FJ.checkin_date_time <= FJ.requested_date_time
                      OR TIMESTAMPDIFF(MINUTE, FJ.requested_date_time, FJ.checkin_date_time) <= 15)
            THEN 1 ELSE 0 END) AS ota_count,
        SUM(CASE
            WHEN FJ.job_status IN (3, 5)
            THEN DATEDIFF(FJ.checkout_date_time, FJ.ticket_created_date_time)
            ELSE 0 END) AS total_tat_days,
        COALESCE(SUM(CASE WHEN FJ.job_status IN (3, 5) THEN JT.total_charge END), 0) AS revenue,
        COALESCE(SUM(CASE WHEN FJ.job_status IN (3, 5) THEN JT.efr_charge END), 0) AS tx_share,
        COALESCE(SUM(CASE WHEN FJ.job_status IN (3, 5) THEN JR.customer_rating END), 0) AS total_rating,
        COUNT(DISTINCT CASE WHEN FJ.job_status IN (3, 5) AND JR.job_id IS NOT NULL THEN JR.job_id END) AS rating_job_count,
        COUNT(DISTINCT CASE WHEN FJ.job_status IN (3, 5) AND JT.fk_job_id IS NOT NULL THEN JT.fk_job_id END) AS checkout_job_count,
        COUNT(CASE WHEN FJ.job_status = 9 THEN 1 END) AS unconfirmed,
        COUNT(CASE WHEN FJ.job_status = 9 AND FJ.call_later = 1 THEN 1 END) AS call_later
     FROM filtered_jobs FJ
     LEFT JOIN job_transactions JT ON JT.fk_job_id = FJ.job_id
     LEFT JOIN job_ratings JR ON JR.job_id = FJ.job_id`;

  const [rows] = await pool.query(sql, params);
  const raw = rows[0] || {};

  const sdaCount = num(raw.sda_count);
  const otaCount = num(raw.ota_count);
  const totalJobs = num(raw.total_jobs);
  const totalTatDays = num(raw.total_tat_days);
  const totalRating = num(raw.total_rating);
  const ratingJobCount = num(raw.rating_job_count);
  const checkoutJobCount = num(raw.checkout_job_count);
  const revenue = num(raw.revenue);
  const txShare = num(raw.tx_share);

  logger.info('KRA metrics computed · totalJobs=' + totalJobs + ' revenue=' + revenue);

  // MetricsUtil maths (verbatim semantics; strings preserved as legacy "xx %").
  return {
    sdaPercentage: pct(sdaCount, totalJobs),
    otaPercentage: pct(otaCount, totalJobs),
    avgTat: avg(totalTatDays, totalJobs),
    avgRating: avg(totalRating, ratingJobCount),
    margin: marginPercent(revenue, txShare),
    avgTicketSize: avg(revenue, checkoutJobCount),
    revenue,
    unconfirmed: num(raw.unconfirmed),
    callLater: num(raw.call_later),
    otaCount,
    sdaCount,
    totalJobs,
    txShare,
    totalTatDays,
  };
}

// MetricsUtil.percentage: "0 %" when total<=0, else round to int + " %".
function pct(part, total) {
  if (total <= 0) return '0 %';
  return `${Math.round((part / total) * 100)} %`;
}
// MetricsUtil.average: round to 1 decimal (Java rounds *10/10).
function avg(total, count) {
  if (count <= 0) return 0.0;
  return Math.round((total / count) * 10) / 10;
}
// MetricsUtil.marginPercent: "0 %" when revenue<=0, else round((rev-tx)/rev*100).
function marginPercent(revenue, txShare) {
  if (revenue <= 0) return '0 %';
  return `${Math.round(((revenue - txShare) / revenue) * 100)} %`;
}
function num(v) {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/* ───────────────────────── 3. dashboard-counts ───────────────────────── */

/*
 * getDashboardCounts — the 3 open-order tiles (open / call-later /
 * escalation), each a zero-filled labelled bucket list. Mirrors
 * FloorDisciplineServiceImpl.getOpenOrdersResponse + fetchOpenOrders /
 * fetchCallLaterOrders / fetchEscalationOrders. Open Orders honours dateMode
 * (requested|original) for its aging buckets.
 */
async function getDashboardCounts({ pf }) {
  logger.info('Building dashboard counts · dateMode=' + pf.dateMode);
  const [open, callLater, escalation] = await Promise.all([
    fetchOpenOrders(pf),
    fetchCallLaterOrders(pf),
    fetchEscalationOrders(pf),
  ]);

  logger.info('Dashboard tiles ready · open=' + open.reduce((a, b) => a + b.count, 0)
    + ' callLater=' + callLater.reduce((a, b) => a + b.count, 0)
    + ' escalation=' + escalation.reduce((a, b) => a + b.count, 0));
  return {
    dashboardDate: new Date().toISOString(),
    tiles: [
      {
        title: 'Open Orders',
        description: 'Details of open orders',
        basedOn: pf.dateMode,
        buckets: open,
        totalCount: open.reduce((a, b) => a + b.count, 0),
      },
      {
        title: 'Call Later Orders',
        description: 'Details of call later history',
        buckets: callLater,
        totalCount: callLater.reduce((a, b) => a + b.count, 0),
      },
      {
        title: 'Escalation Order Details',
        description: 'Open Orders escalated with a breakup',
        buckets: escalation,
        totalCount: escalation.reduce((a, b) => a + b.count, 0),
      },
    ],
  };
}

// fetchOpenOrders (FloorDisciplineRepository:20-99) — aging buckets keyed on
// requested_date_time OR original_appointment_date_time per dateMode. Legacy
// scalar guards for vertical/zonal; LIST guard for manage_clients. Zero-fill
// the canonical bucket order.
async function fetchOpenOrders(pf) {
  const dm = pf.dateMode;
  // Date-source expression: requested vs original by dateMode (legacy CASE).
  const dateExpr =
    `(CASE WHEN ? = 'requested' THEN TJ.requested_date_time
           WHEN ? = 'original' THEN TJ.original_appointment_date_time
           ELSE TJ.requested_date_time END)`;

  // Param order MUST match placeholder order in the SQL below:
  //   dateExpr appears 5× (Future + 4 TIMESTAMPDIFF branches), each binding
  //   :dateMode twice ⇒ 10 dateMode binds; then vertical ×2, zonal ×2, then
  //   the manage_clients ids (via clientGuard which appends to `params`).
  const params = [];
  for (let i = 0; i < 10; i++) params.push(dm);
  params.push(pf.verticalId, pf.verticalId, pf.zonalManagerId, pf.zonalManagerId);
  const clientFrag = clientGuard('TJ.fk_client_id', pf, params); // pushes client ids

  const sql =
    `SELECT date_range, COUNT(job_id) AS job_count FROM (
        SELECT TJ.job_id,
          CASE
            WHEN ${dateExpr} > NOW() THEN 'Future'
            WHEN TIMESTAMPDIFF(MINUTE, ${dateExpr}, NOW()) BETWEEN 0 AND 1440 THEN '0-1 days'
            WHEN TIMESTAMPDIFF(MINUTE, ${dateExpr}, NOW()) BETWEEN 1441 AND 4320 THEN '2-3 days'
            WHEN TIMESTAMPDIFF(MINUTE, ${dateExpr}, NOW()) BETWEEN 4321 AND 7200 THEN '4-5 days'
            ELSE '>5 days'
          END AS date_range
        FROM tbl_job TJ
        LEFT JOIN tbl_client TCL ON TCL.client_id = TJ.fk_client_id
        LEFT JOIN tbl_address TA ON TA.address_id = TJ.fk_address_id
        LEFT JOIN tbl_city TC ON TC.city_id = TA.city_id
        WHERE 1 = 1
          AND TJ.job_status NOT IN (3, 5, 6, 7, 9)
          AND TCL.client_status = 1
          AND ((? IS NULL) OR TCL.vertical_id = ?)
          AND ((? IS NULL) OR TC.state_user = ?)${clientFrag}
     ) sub
     GROUP BY date_range
     ORDER BY CASE date_range
        WHEN 'Future' THEN 1
        WHEN '0-1 days' THEN 2
        WHEN '2-3 days' THEN 3
        WHEN '4-5 days' THEN 4
        WHEN '>5 days' THEN 5
     END
     LIMIT ${GROUPED_CAP}`;

  const [rows] = await pool.query(sql, params);
  return zeroFill(rows, ['Future', '0-1 days', '2-3 days', '4-5 days', '>5 days']);
}

// fetchCallLaterOrders (FloorDisciplineRepository:102-143) — unconfirmed (9)
// jobs bucketed by their call-later (comment_on=16) comment count.
async function fetchCallLaterOrders(pf) {
  const params = [];
  const clientFrag = clientGuard('TJ.fk_client_id', pf, params);
  // Order params: vertical x2, zonal x2 must come BEFORE the client ids that
  // clientGuard pushed. clientGuard already pushed client ids into `params`,
  // so prepend the scalar guards instead.
  const scalarParams = [pf.verticalId, pf.verticalId, pf.zonalManagerId, pf.zonalManagerId];
  const finalParams = [...scalarParams, ...params];
  const sql =
    `SELECT label, COUNT(TJ.job_id) AS job_count FROM (
        SELECT TJ.job_id,
          CASE
            WHEN COALESCE(TJC.comment_count, 0) BETWEEN 1 AND 1 THEN '0-1 times'
            WHEN COALESCE(TJC.comment_count, 0) BETWEEN 2 AND 3 THEN '2-3 times'
            WHEN COALESCE(TJC.comment_count, 0) BETWEEN 4 AND 5 THEN '4-5 times'
            WHEN COALESCE(TJC.comment_count, 0) > 5 THEN '>5 times'
          END AS label
        FROM tbl_job TJ
        LEFT JOIN tbl_address TA ON TA.address_id = TJ.fk_address_id
        LEFT JOIN tbl_city TC ON TC.city_id = TA.city_id
        LEFT JOIN tbl_client TCL ON TCL.client_id = TJ.fk_client_id
        LEFT JOIN (
          SELECT job_id, COUNT(*) AS comment_count
          FROM tbl_job_comment
          WHERE comment_on = 16
          GROUP BY job_id
        ) TJC ON TJC.job_id = TJ.job_id
        WHERE TJ.job_status IN (9)
          AND TJC.comment_count > 0
          AND ((? IS NULL) OR TCL.vertical_id = ?)
          AND ((? IS NULL) OR TC.state_user = ?)${clientFrag}
     ) sub
     GROUP BY label
     ORDER BY CASE label
        WHEN '0-1 times' THEN 1
        WHEN '2-3 times' THEN 2
        WHEN '4-5 times' THEN 3
        WHEN '>5 times' THEN 4
     END
     LIMIT ${GROUPED_CAP}`;
  const [rows] = await pool.query(sql, finalParams);
  return zeroFill(rows, ['0-1 times', '2-3 times', '4-5 times', '>5 times'], 'label');
}

// fetchEscalationOrders (FloorDisciplineRepository:145-179) — escalated open
// jobs bucketed by hours-since-escalation.
async function fetchEscalationOrders(pf) {
  const params = [];
  const clientFrag = clientGuard('TJ.fk_client_id', pf, params);
  const scalarParams = [pf.verticalId, pf.verticalId, pf.zonalManagerId, pf.zonalManagerId];
  const finalParams = [...scalarParams, ...params];
  const sql =
    `SELECT escalation_bucket, COUNT(*) AS COUNT FROM (
        SELECT
          CASE
            WHEN TIMESTAMPDIFF(HOUR, TRC.escalated_time, NOW()) <= 24 THEN '0-24 hrs'
            WHEN TIMESTAMPDIFF(HOUR, TRC.escalated_time, NOW()) > 24
              AND TIMESTAMPDIFF(HOUR, TRC.escalated_time, NOW()) <= 48 THEN '24-48 hrs'
            WHEN TIMESTAMPDIFF(HOUR, TRC.escalated_time, NOW()) > 48
              AND TIMESTAMPDIFF(HOUR, TRC.escalated_time, NOW()) <= 72 THEN '48-72 hrs'
            WHEN TIMESTAMPDIFF(HOUR, TRC.escalated_time, NOW()) > 72 THEN '>72 hrs'
          END AS escalation_bucket
        FROM tbl_job TJ
        LEFT JOIN tbl_client TCL ON TCL.client_id = TJ.fk_client_id
        LEFT JOIN tbl_address TA ON TA.address_id = TJ.fk_address_id
        LEFT JOIN tbl_city TC ON TC.city_id = TA.city_id
        LEFT JOIN tbl_easyfixer_rating_by_customer TRC ON TJ.job_id = TRC.job_id
        WHERE TJ.job_status NOT IN (3, 5, 6, 7)
          AND TRC.is_escalated = 1
          AND ((? IS NULL) OR TCL.vertical_id = ?)
          AND ((? IS NULL) OR TC.state_user = ?)${clientFrag}
     ) sub
     GROUP BY escalation_bucket
     ORDER BY CASE escalation_bucket
        WHEN '0-24 hrs' THEN 1
        WHEN '24-48 hrs' THEN 2
        WHEN '48-72 hrs' THEN 3
        WHEN '>72 hrs' THEN 4
     END
     LIMIT ${GROUPED_CAP}`;
  const [rows] = await pool.query(sql, finalParams);
  return zeroFill(rows, ['0-24 hrs', '24-48 hrs', '48-72 hrs', '>72 hrs'], 'escalation_bucket', 'COUNT');
}

// Zero-fill a labelled bucket set into the canonical order (legacy
// fillMissingBuckets / default LinkedHashMap). Maps to { label, count }.
function zeroFill(rows, order, labelKey = 'date_range', countKey = 'job_count') {
  const got = new Map();
  for (const r of rows) {
    const lbl = r[labelKey];
    if (lbl == null) continue;
    got.set(lbl, Number(r[countKey]) || 0);
  }
  return order.map((label) => ({ label, count: got.get(label) || 0 }));
}

/* ───────────────────────── 4. cancellation-details ───────────────────────── */

/*
 * getCancellationDetails — 4 cancellation aging buckets + a before/after
 * allocation summary. Mirrors findCancelledJobsByTimeBucket (453-485) +
 * cancelCountBeforeAfter (488-517). Both window on cancel_date_time
 * (>= start AND < end). The +1-day endDate makes that range inclusive of the
 * picked end day. Buckets zero-filled to the canonical 4.
 */
async function getCancellationDetails({ pf }) {
  logger.info('Building cancellation details · window=' + pf.startDate + '..' + pf.endDate);
  // The legacy queries use `>= :startDate AND < :endDate`; endDate is already
  // +1 day (inclusive of the picked last day). Both share the same params.
  const bucketParams = [pf.startDate, pf.endDate, pf.verticalId, pf.verticalId, pf.zonalManagerId, pf.zonalManagerId];
  const bucketClient = clientGuard('J.fk_client_id', pf, bucketParams);
  const bucketSql =
    `SELECT
        CASE
          WHEN TIMESTAMPDIFF(MINUTE, J.ticket_created_date_time, J.cancel_date_time) <= 1440 THEN '0-1 days'
          WHEN TIMESTAMPDIFF(MINUTE, J.ticket_created_date_time, J.cancel_date_time) BETWEEN 1441 AND 4320 THEN '2-3 days'
          WHEN TIMESTAMPDIFF(MINUTE, J.ticket_created_date_time, J.cancel_date_time) BETWEEN 4321 AND 7200 THEN '4-5 days'
          ELSE '>5 days'
        END AS time_bucket,
        COUNT(*) AS total_jobs
     FROM tbl_job J
       LEFT JOIN tbl_address TA  ON TA.address_id = J.fk_address_id
       LEFT JOIN tbl_city    TC  ON TC.city_id    = TA.city_id
       LEFT JOIN tbl_client  TCL ON TCL.client_id = J.fk_client_id
       LEFT JOIN tbl_user    TU  ON TU.user_id    = J.reporting_contact_id
     WHERE J.job_status = 6
       AND J.cancel_date_time >= ?
       AND J.cancel_date_time <  ?
       AND ((? IS NULL) OR TCL.vertical_id = ?)
       AND ((? IS NULL) OR TC.state_user = ?)${bucketClient}
     GROUP BY time_bucket
     ORDER BY FIELD(time_bucket, '0-1 days', '2-3 days', '4-5 days', '>5 days')
     LIMIT ${GROUPED_CAP}`;
  const [bucketRows] = await pool.query(bucketSql, bucketParams);

  const summaryParams = [pf.startDate, pf.endDate, pf.verticalId, pf.verticalId, pf.zonalManagerId, pf.zonalManagerId];
  const summaryClient = clientGuard('J.fk_client_id', pf, summaryParams);
  const summarySql =
    `SELECT
        COUNT(*) AS total_cancelled,
        SUM(CASE WHEN J.fk_easyfixter_id IS NULL OR J.fk_easyfixter_id = 0 THEN 1 ELSE 0 END) AS before_allocation,
        SUM(CASE WHEN J.fk_easyfixter_id IS NOT NULL AND J.fk_easyfixter_id != 0 THEN 1 ELSE 0 END) AS after_allocation
     FROM tbl_job J
       LEFT JOIN tbl_address TA  ON TA.address_id = J.fk_address_id
       LEFT JOIN tbl_city    TC  ON TC.city_id    = TA.city_id
       LEFT JOIN tbl_client  TCL ON TCL.client_id = J.fk_client_id
       LEFT JOIN tbl_user    TU  ON TU.user_id    = J.reporting_contact_id
     WHERE J.job_status = 6
       AND J.cancel_date_time >= ?
       AND J.cancel_date_time <  ?
       AND ((? IS NULL) OR TCL.vertical_id = ?)
       AND ((? IS NULL) OR TC.state_user = ?)${summaryClient}`;
  const [summaryRows] = await pool.query(summarySql, summaryParams);
  const sr = summaryRows[0] || {};

  logger.info('Cancellation details ready · buckets=' + bucketRows.length + ' totalCancelled=' + (num(sr.total_cancelled)));
  // FE snake_case shape (legacy JobCancellationResponseDTO).
  return {
    bucketData: zeroFill(bucketRows, ['0-1 days', '2-3 days', '4-5 days', '>5 days'], 'time_bucket', 'total_jobs')
      .map((b) => ({ time_bucket: b.label, total_jobs: b.count })),
    summary: {
      total_cancelled: num(sr.total_cancelled),
      before_allocation: num(sr.before_allocation),
      after_allocation: num(sr.after_allocation),
    },
  };
}

/* ───────────────────────── 5. reporting-managers ───────────────────────── */

/*
 * getReportingManagers — distinct reporting managers, filtered by vertical
 * (verticalId=0 = all). Mirrors getReportingManagersByVertical (411-424).
 */
async function getReportingManagers({ verticalId }) {
  logger.info('Listing reporting managers · verticalId=' + (verticalId != null ? Number(verticalId) : 0));
  const v = verticalId != null ? Number(verticalId) : 0;
  const sql =
    `SELECT DISTINCT TU.reporting_manager AS user_id, TU1.user_name
       FROM tbl_user TU
       LEFT JOIN tbl_user TU1 ON TU1.user_id = TU.reporting_manager
      WHERE TU1.user_type_id = 5
        AND TU1.user_status = 1
        AND TU.reporting_manager IS NOT NULL
        AND TU.reporting_manager != 0
        AND ( ? = 0
              OR TU1.manage_verticals = '0'
              OR FIND_IN_SET(?, TU1.manage_verticals) > 0 )
      ORDER BY TU1.user_name ASC
      LIMIT ${GROUPED_CAP}`;
  const [rows] = await pool.query(sql, [v, v]);
  logger.info('Found ' + rows.length + ' reporting managers');
  return rows.map((r) => ({ user_id: Number(r.user_id), user_name: r.user_name || '' }));
}

/* ───────────────────────── 6. rm-team-users ───────────────────────── */

/*
 * getRmTeamUsers — users in a vertical / RM's team. Mirrors getRmTeamUserList
 * (426-450). verticalId=0 = all verticals; reportingManagerId=0 = all RMs.
 */
async function getRmTeamUsers({ verticalId, reportingManagerId }) {
  const v = verticalId != null ? Number(verticalId) : 0;
  const rm = reportingManagerId != null ? Number(reportingManagerId) : 0;
  logger.info('Listing RM team users · verticalId=' + v + ' reportingManagerId=' + rm);
  const sql =
    `SELECT TU.user_id, TU.user_name, TU.manage_verticals, TU.reporting_manager, TU1.user_name AS rm_name
       FROM tbl_user TU
       LEFT JOIN tbl_user TU1 ON TU1.user_id = TU.reporting_manager
      WHERE TU.user_type_id = 5
        AND TU.user_role NOT IN (1)
        AND TU.user_status = 1
        AND ( ? = 0
              OR TU.manage_verticals = '0'
              OR FIND_IN_SET(?, TU.manage_verticals) > 0 )
        AND ( ? = 0
              OR TU.reporting_manager = ? )
      ORDER BY TU.user_name ASC
      LIMIT ${GROUPED_CAP}`;
  const [rows] = await pool.query(sql, [v, v, rm, rm]);
  logger.info('Found ' + rows.length + ' RM team users');
  return rows.map((r) => ({
    user_id: Number(r.user_id),
    user_name: r.user_name || '',
    manage_verticals: r.manage_verticals,
    reporting_manager: r.reporting_manager == null ? null : Number(r.reporting_manager),
    rm_name: r.rm_name || '',
  }));
}

/* ───────────────────────── 7. spoc-revenue ───────────────────────── */

/*
 * getSpocRevenue — revenue and completed-job count aggregated by Primary SPOC.
 *
 * Primary SPOC = tbl_vertical_mapping rows with user_type = 1, joined to
 * tbl_user (user_status = 1) for the name. A job maps to its SPOC via
 * tbl_job.fk_client_id = tbl_vertical_mapping.client_id.
 *
 * Completed = job_status IN (3, 5).
 * Window    = checkout_date_time BETWEEN pf.startDate AND pf.endDate
 *             (endDate already +1 day from processFloorFilters).
 * Revenue   = COALESCE(SUM(tbl_job_transaction.total_charge), 0) — pre-tax,
 *             matching the KRA Revenue tile.
 * Scope guards replicated verbatim from getKraMetrics:
 *   - vertical   : (? IS NULL) OR TCL.vertical_id = ?
 *   - zonal      : (? IS NULL) OR TC.state_user = ?
 *   - clientGuard: applyClientFilter OR fk_client_id IN (managedClientIds)
 */
async function getSpocRevenue({ pf }) {
  logger.info('Building SPOC revenue · window=' + pf.startDate + '..' + pf.endDate);
  const params = [];

  // Build the client guard fragment (pushes managed-client ids into params).
  const clientFrag = clientGuard('TJ.fk_client_id', pf, params);

  // Scope-guard params pushed BEFORE the window params (mirrors getKraMetrics
  // param order: vertical ×2, zonal ×2, then client ids already in params).
  // We build params incrementally here so the order is explicit.
  const verticalParams = [pf.verticalId, pf.verticalId];
  const zonalParams    = [pf.zonalManagerId, pf.zonalManagerId];
  // window params
  const windowParams   = [pf.startDate, pf.endDate];

  // Final param array: window, vertical, zonal, client ids (same fragment
  // pattern as getKraMetrics — clientFrag is already in the string and its
  // ids were pushed into the `params` array above via clientGuard).
  const finalParams = [
    ...windowParams,    // checkout_date_time BETWEEN ? AND ?
    ...verticalParams,  // (? IS NULL) OR TCL.vertical_id = ?
    ...zonalParams,     // (? IS NULL) OR TC.state_user = ?
    ...params,          // client guard ids (may be empty when applyClientFilter=false)
  ];

  const sql =
    `SELECT
        TU.user_id                           AS userId,
        TU.user_name                         AS userName,
        COUNT(DISTINCT TJ.job_id)            AS jobs_completed,
        COALESCE(SUM(TJT.total_charge), 0)   AS revenue
     FROM tbl_vertical_mapping TVM
     INNER JOIN tbl_user   TU  ON TU.user_id  = TVM.user_id
                               AND TU.user_status = 1
     INNER JOIN tbl_job    TJ  ON TJ.fk_client_id = TVM.client_id
     LEFT  JOIN tbl_job_transaction TJT ON TJT.fk_job_id = TJ.job_id
     LEFT  JOIN tbl_address         TA  ON TA.address_id = TJ.fk_address_id
     LEFT  JOIN tbl_city            TC  ON TC.city_id    = TA.city_id
     LEFT  JOIN tbl_client          TCL ON TCL.client_id = TJ.fk_client_id
     WHERE TVM.user_type = 1
       AND TJ.job_status IN (3, 5)
       AND TJ.checkout_date_time BETWEEN ? AND ?
       AND ((? IS NULL) OR TCL.vertical_id = ?)
       AND ((? IS NULL) OR TC.state_user = ?)${clientFrag}
     GROUP BY TU.user_id, TU.user_name
     ORDER BY revenue DESC
     LIMIT ${GROUPED_CAP}`;

  const [rows] = await pool.query(sql, finalParams);
  logger.info('Found ' + rows.length + ' SPOCs with revenue');

  if (rows.length >= GROUPED_CAP) {
    logger.warn(
      { report: 'spoc-revenue', returned: rows.length, cap: GROUPED_CAP },
      'SPOC Revenue hit the grouped-rows cap — verify date range',
    );
  }

  const spocs = rows.map((r) => ({
    userId:        Number(r.userId),
    userName:      r.userName || '',
    jobsCompleted: Number(r.jobs_completed) || 0,
    revenue:       Number(r.revenue)        || 0,
  }));

  const spocCount    = spocs.length;
  const totalRevenue = spocs.reduce((sum, s) => sum + s.revenue, 0);
  const totalJobs    = spocs.reduce((sum, s) => sum + s.jobsCompleted, 0);
  const avgRevenue   = spocCount > 0 ? Math.round(totalRevenue / spocCount) : 0;

  return { spocs, totalRevenue, avgRevenue, totalJobs, spocCount };
}

module.exports = {
  processFloorFilters,
  getEmployeeProductivity,
  getKraMetrics,
  getDashboardCounts,
  getCancellationDetails,
  getReportingManagers,
  getRmTeamUsers,
  getSpocRevenue,
  // Cap surfaced so the route's xlsx export can request the full set
  // symbolically (avoids a hardcoded 5000 literal drifting from this cap).
  GROUPED_CAP,
};
