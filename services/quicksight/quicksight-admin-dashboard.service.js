/*
 * QuickSight — Admin Dashboard (Floor Discipline / Employee Productivity
 * admin-level dashboard) — service layer.
 *
 *   registry slug : adminDashboard
 *   legacy source : ACD_APIs FloorDisciplineController / FloorDisciplineServiceImpl
 *                   / FloorDisciplineRepository / ManagerServiceImpl /
 *                   ManagerTeamRepository / UserRepository.
 *
 * The legacy `adminDashboard` Angular route is a decoy "Access Denied" stub —
 * the REAL admin-level dashboard is the ProductivityComponent backed by the
 * FloorDiscipline endpoints. This service is a faithful native port of those
 * nine SQL queries + the pre-query filter resolution (processFloorFilters) +
 * the org-chart tree builder (buildOrgChart) + MetricsUtil arithmetic.
 *
 * PARITY NOTES (do NOT "clean up" — see /tmp/qs/_registry.json decisions):
 *   - SQL ported VERBATIM; :named params → mysql2 `?` positional in order.
 *   - applyClientFilter pattern: `(? = 0 OR fk_client_id IN (...))`; when
 *     applyClientFilter=1 with an empty manageClientIds list we fall back to
 *     [-1] (matches the legacy safe-list sentinel) so IN(...) never errors.
 *   - manage_clients resolution: '0' / empty / null ⇒ admin ⇒ no client filter
 *     (applyClientFilter=0). RM expansion = the RM itself + its team users.
 *   - rmTeamUserIds defaults to [-1] (= "all", no RM filter) when empty.
 *   - date upper bound is INCLUSIVE-by-+1-day (endDate input + 1 day); empty
 *     dates flow as NULL.
 *   - dateMode: 'requested' → requested_date_time, else → original_appointment
 *     _date_time (null/empty findByDateType ⇒ 'original' per processFloorFilters).
 *   - legacy typo columns preserved verbatim: fk_easyfixter_id, is_escalated,
 *     escalated_time, efr_charge, full_fillment_by, full_fillment_created_time.
 *   - employee-productivity CTE scopes by zonalManagerId + user-set ONLY
 *     (NO manage_clients client filter) — verbatim asymmetry, NOT a bug.
 *   - call-later bucket emits CORRECTED labels (0-1 / 2-3 / 4-5 / >5 times);
 *     the legacy FE '3-4 times' mismatch is dropped (registry headerAlignment).
 *   - admin sees ALL — no req.scope row filtering (legacy had none).
 *   - legacy had NO LIMIT; native adds a HIGH non-truncating safety cap and
 *     logger.warn()s when it is hit (no silent truncation in practice).
 */

const { pool } = require('../../db');
const logger = require('../../logger');

// Org-chart root (legacy ManagerServiceImpl.rootUserId = 3L, title "CEO").
const ORG_ROOT_USER_ID = 3;

// High safety caps — far above realistic row counts. A hit is logged, never
// silently swallowed (registry decision: "no silent row drops").
const USER_LIST_LIMIT = 5000;    // active-user page candidates
const HIERARCHY_LIMIT = 50000;   // full user hierarchy for the org chart

/* ── MetricsUtil parity (FloorDisciplineServiceImpl helpers) ─────────────
 * percentage(part,total) = '0 %' if total<=0 else round(part/total*100)+' %'
 * average(total,count)    = round1(total/count) (0 if count<=0)
 * marginPercent(rev,tx)   = round((rev-tx)/rev*100)+' %' (0 if rev<=0)
 */
function percentage(part, total) {
  const t = Number(total) || 0;
  if (t <= 0) return '0 %';
  return `${Math.round((Number(part) || 0) / t * 100)} %`;
}
function average(total, count) {
  const c = Number(count) || 0;
  if (c <= 0) return 0;
  return Math.round((Number(total) || 0) / c * 10) / 10;
}
function marginPercent(revenue, txShare) {
  const rev = Number(revenue) || 0;
  if (rev <= 0) return '0 %';
  return `${Math.round((rev - (Number(txShare) || 0)) / rev * 100)} %`;
}

/* ── Date helpers (processFloorFilters parity) ───────────────────────────
 * Empty / null date → NULL (the SQL treats NULL as "no bound" via guards or
 * via empty start meaning the BETWEEN never matches — matching legacy which
 * skips date-filtered calls when dates are empty). endDate gets +1 day for
 * the inclusive upper bound. Inputs are already validated 'YYYY-MM-DD'.
 */
function resolveStartDate(raw) {
  if (!raw) return null;
  return `${raw} 00:00:00`;
}
function resolveEndDatePlusOne(raw) {
  if (!raw) return null;
  // +1 day, midnight — half-open / inclusive-of-end-day upper bound.
  const d = new Date(`${raw}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day} 00:00:00`;
}

/*
 * dateMode parity (processFloorFilters:346): findByDateType 'requested' →
 * 'requested'; anything else (incl. null/empty/'original') → 'original'.
 */
function resolveDateMode(findByDateType) {
  return findByDateType === 'requested' ? 'requested' : 'original';
}

/*
 * resolveClientScope(req) — port of processFloorFilters' manage_clients
 * expansion. The native Admin Dashboard gate is Admin-only (role_id===2),
 * and Admin has manage_clients '0'/empty ⇒ no client filter. We STILL read
 * the acting user's manage_clients so the same code path holds if the gate
 * is ever broadened: '0' / empty / null ⇒ applyClientFilter=0 (all clients);
 * otherwise scope to that CSV list of client ids.
 *
 * Returns { applyClientFilter: 0|1, manageClientIds: number[] }.
 */
async function resolveClientScope(userId) {
  if (!userId) return { applyClientFilter: 0, manageClientIds: [] };
  // UserRepository.findManageClientsByUserId (UserRepository.java:76-77).
  const [[row]] = await pool.query(
    'SELECT u.manage_clients FROM tbl_user u WHERE u.user_id = ?',
    [userId]
  );
  const raw = row && row.manage_clients != null ? String(row.manage_clients).trim() : '';
  if (raw === '' || raw === '0') return { applyClientFilter: 0, manageClientIds: [] };
  const ids = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n !== 0);
  if (ids.length === 0) return { applyClientFilter: 0, manageClientIds: [] };
  return { applyClientFilter: 1, manageClientIds: ids };
}

/*
 * Shared filter resolution for the three aggregate endpoints
 * (open-orders / kra-metrics / cancellation-details). Resolves:
 *   verticalId  → null if 0
 *   zonalManagerId → null if 0
 *   client scope (applyClientFilter + manageClientIds, with [-1] fallback)
 */
async function resolveAggregateFilters(filters, actingUserId) {
  const verticalId = Number(filters.verticalId) > 0 ? Number(filters.verticalId) : null;
  const zonalManagerId =
    Number(filters.zonalManagerId) > 0 ? Number(filters.zonalManagerId) : null;
  const { applyClientFilter, manageClientIds } = await resolveClientScope(actingUserId);
  // IN(...) must never be empty: when scoping is on but the list is empty,
  // fall back to [-1] (matches the legacy safe-list sentinel).
  const clientIds =
    applyClientFilter === 1 && manageClientIds.length === 0 ? [-1] : manageClientIds;
  return { verticalId, zonalManagerId, applyClientFilter, clientIds };
}

/* Build the `IN (?,?,…)` placeholder string for a non-empty list. */
function inPlaceholders(list) {
  return list.map(() => '?').join(',');
}

/* ════════════════════════════════════════════════════════════════════════
 * 1) openOrders — three bucket tiles (Open Orders / Call Later / Escalation)
 * ════════════════════════════════════════════════════════════════════════ */
async function openOrders(filters = {}, actingUserId = null) {
  const { verticalId, zonalManagerId, applyClientFilter, clientIds } =
    await resolveAggregateFilters(filters, actingUserId);
  const dateMode = resolveDateMode(filters.findByDateType);
  // applyClientFilter=0 ⇒ IN list unused but must still be a valid placeholder
  // set; we pass a single sentinel so the SQL string stays well-formed.
  const clientList = applyClientFilter === 1 ? clientIds : [-1];
  const clientPH = inPlaceholders(clientList);

  // QUERY A — Open Orders aging buckets (fetchOpenOrders, repo:20-99).
  const openSql = `
    SELECT
      CASE
        WHEN (CASE WHEN ? = 'requested' THEN TJ.requested_date_time WHEN ? = 'original' THEN TJ.original_appointment_date_time ELSE TJ.requested_date_time END) > NOW() THEN 'Future'
        WHEN TIMESTAMPDIFF(MINUTE,(CASE WHEN ? = 'requested' THEN TJ.requested_date_time WHEN ? = 'original' THEN TJ.original_appointment_date_time ELSE TJ.requested_date_time END),NOW()) BETWEEN 0 AND 1440 THEN '0-1 days'
        WHEN TIMESTAMPDIFF(MINUTE,(CASE WHEN ? = 'requested' THEN TJ.requested_date_time WHEN ? = 'original' THEN TJ.original_appointment_date_time ELSE TJ.requested_date_time END),NOW()) BETWEEN 1441 AND 4320 THEN '2-3 days'
        WHEN TIMESTAMPDIFF(MINUTE,(CASE WHEN ? = 'requested' THEN TJ.requested_date_time WHEN ? = 'original' THEN TJ.original_appointment_date_time ELSE TJ.requested_date_time END),NOW()) BETWEEN 4321 AND 7200 THEN '4-5 days'
        ELSE '>5 days'
      END AS date_range,
      COUNT(TJ.job_id) AS job_count
    FROM tbl_job TJ
    LEFT JOIN tbl_client TCL ON TCL.client_id = TJ.fk_client_id
    LEFT JOIN tbl_address TA ON TA.address_id = TJ.fk_address_id
    LEFT JOIN tbl_city TC ON TC.city_id = TA.city_id
    WHERE 1 = 1
      AND TJ.job_status NOT IN (3, 5, 6, 7, 9)
      AND TCL.client_status = 1
      AND ((? IS NULL) OR TCL.vertical_id = ?)
      AND ((? IS NULL) OR TC.state_user = ?)
      AND (? = 0 OR TJ.fk_client_id IN (${clientPH}))
    GROUP BY date_range
    ORDER BY CASE date_range WHEN 'Future' THEN 1 WHEN '0-1 days' THEN 2 WHEN '2-3 days' THEN 3 WHEN '4-5 days' THEN 4 WHEN '>5 days' THEN 5 END`;
  const openParams = [
    dateMode, dateMode, // Future CASE
    dateMode, dateMode, // 0-1
    dateMode, dateMode, // 2-3
    dateMode, dateMode, // 4-5
    verticalId, verticalId,
    zonalManagerId, zonalManagerId,
    applyClientFilter, ...clientList,
  ];
  const [openRows] = await pool.query(openSql, openParams);

  // QUERY B — Call Later buckets (fetchCallLaterOrders, repo:102-143).
  const callLaterSql = `
    SELECT
      CASE
        WHEN COALESCE(TJC.comment_count, 0) BETWEEN 1 AND 1 THEN '0-1 times'
        WHEN COALESCE(TJC.comment_count, 0) BETWEEN 2 AND 3 THEN '2-3 times'
        WHEN COALESCE(TJC.comment_count, 0) BETWEEN 4 AND 5 THEN '4-5 times'
        WHEN COALESCE(TJC.comment_count, 0) > 5 THEN '>5 times'
      END AS label,
      COUNT(TJ.job_id) AS job_count
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
      AND ((? IS NULL) OR TC.state_user = ?)
      AND (? = 0 OR TJ.fk_client_id IN (${clientPH}))
    GROUP BY label
    ORDER BY CASE label WHEN '0-1 times' THEN 1 WHEN '2-3 times' THEN 2 WHEN '4-5 times' THEN 3 WHEN '>5 times' THEN 4 END`;
  const callLaterParams = [
    verticalId, verticalId,
    zonalManagerId, zonalManagerId,
    applyClientFilter, ...clientList,
  ];
  const [callLaterRows] = await pool.query(callLaterSql, callLaterParams);

  // QUERY C — Escalation buckets (fetchEscalationOrders, repo:145-179).
  const escalationSql = `
    SELECT
      CASE
        WHEN TIMESTAMPDIFF(HOUR, TRC.escalated_time, NOW()) <= 24 THEN '0-24 hrs'
        WHEN TIMESTAMPDIFF(HOUR, TRC.escalated_time, NOW()) > 24 AND TIMESTAMPDIFF(HOUR, TRC.escalated_time, NOW()) <= 48 THEN '24-48 hrs'
        WHEN TIMESTAMPDIFF(HOUR, TRC.escalated_time, NOW()) > 48 AND TIMESTAMPDIFF(HOUR, TRC.escalated_time, NOW()) <= 72 THEN '48-72 hrs'
        WHEN TIMESTAMPDIFF(HOUR, TRC.escalated_time, NOW()) > 72 THEN '>72 hrs'
      END AS escalation_bucket,
      COUNT(*) AS COUNT
    FROM tbl_job TJ
    LEFT JOIN tbl_client TCL ON TCL.client_id = TJ.fk_client_id
    LEFT JOIN tbl_address TA ON TA.address_id = TJ.fk_address_id
    LEFT JOIN tbl_city TC ON TC.city_id = TA.city_id
    LEFT JOIN tbl_easyfixer_rating_by_customer TRC ON TJ.job_id = TRC.job_id
    WHERE TJ.job_status NOT IN (3, 5, 6, 7)
      AND TRC.is_escalated = 1
      AND ((? IS NULL) OR TCL.vertical_id = ?)
      AND ((? IS NULL) OR TC.state_user = ?)
      AND (? = 0 OR TJ.fk_client_id IN (${clientPH}))
    GROUP BY escalation_bucket
    ORDER BY CASE escalation_bucket WHEN '0-24 hrs' THEN 1 WHEN '24-48 hrs' THEN 2 WHEN '48-72 hrs' THEN 3 WHEN '>72 hrs' THEN 4 END`;
  const escalationParams = [
    verticalId, verticalId,
    zonalManagerId, zonalManagerId,
    applyClientFilter, ...clientList,
  ];
  const [escalationRows] = await pool.query(escalationSql, escalationParams);

  const mapBuckets = (rows, labelKey, countKey) =>
    rows
      .filter((r) => r[labelKey] != null)
      .map((r) => ({ label: r[labelKey], count: Number(r[countKey]) || 0 }));

  const openBuckets = mapBuckets(openRows, 'date_range', 'job_count');
  const callLaterBuckets = mapBuckets(callLaterRows, 'label', 'job_count');
  const escalationBuckets = mapBuckets(escalationRows, 'escalation_bucket', 'COUNT');

  const sum = (buckets) => buckets.reduce((a, b) => a + (b.count || 0), 0);

  return {
    dashboardDate: new Date().toISOString(),
    tiles: [
      {
        title: 'Open Orders',
        description: 'Open orders by age',
        basedOn: dateMode,
        totalCount: sum(openBuckets),
        buckets: openBuckets,
      },
      {
        title: 'Call Later Orders',
        description: 'Unconfirmed orders by call-later count',
        basedOn: dateMode,
        totalCount: sum(callLaterBuckets),
        buckets: callLaterBuckets,
      },
      {
        title: 'Escalation Order Details',
        description: 'Escalated orders by age since escalation',
        basedOn: dateMode,
        totalCount: sum(escalationBuckets),
        buckets: escalationBuckets,
      },
    ],
  };
}

/* ════════════════════════════════════════════════════════════════════════
 * 2) employeeProductivity — paginated per-user metric rows.
 * ════════════════════════════════════════════════════════════════════════ */

/*
 * Resolve rmTeamUserIds (RM + its team), defaulting to [-1] (= "all").
 * findUsersByReportingManagerId (UserRepository.java:92-96) + the RM itself.
 */
async function resolveRmTeamUserIds(reportingManagerId) {
  const rmId = Number(reportingManagerId) || 0;
  if (rmId <= 0) return [-1];
  const [rows] = await pool.query(
    'SELECT user_id FROM tbl_user WHERE user_status = 1 AND user_type_id = 5 AND reporting_manager = ?',
    [rmId]
  );
  const ids = rows.map((r) => Number(r.user_id)).filter((n) => Number.isFinite(n));
  ids.push(rmId); // the RM itself is part of its own team scope
  const uniq = Array.from(new Set(ids));
  return uniq.length ? uniq : [-1];
}

async function employeeProductivity(filters = {}, page = 1, size = 10) {
  const verticalId = Number(filters.verticalId) > 0 ? Number(filters.verticalId) : null;
  const zonalManagerId =
    Number(filters.zonalManagerId) > 0 ? Number(filters.zonalManagerId) : null;
  const userId = Number(filters.userId) > 0 ? Number(filters.userId) : 0;
  const rmTeamUserIds = await resolveRmTeamUserIds(filters.reportingManagerId);
  const rmPH = inPlaceholders(rmTeamUserIds);

  const pageNo = Math.max(1, Number(page) || 1);
  const pageSize = Math.max(1, Number(size) || 10);
  const offSet = (pageNo - 1) * pageSize;

  // QUERY B — total count (getTotalUserCount, repo:206-224).
  const countSql = `
    SELECT Count(TU.user_id) AS total
    FROM tbl_user TU
    WHERE TU.user_type_id = 5
      AND TU.user_status = 1
      AND TU.user_role not in (1)
      AND ( ? IS NULL OR TU.manage_verticals = '0' OR FIND_IN_SET(?, TU.manage_verticals) )
      AND (
        (? IS NOT NULL AND ? > 0 AND TU.user_id = ?)
        OR ((? IS NULL OR ? = 0) AND (-1 IN (${rmPH}) OR TU.user_id IN (${rmPH})))
      )`;
  const userIdParam = userId > 0 ? userId : null; // mirrors :userId IS NOT NULL / > 0 logic
  const countParams = [
    verticalId, verticalId,
    userIdParam, userIdParam, userIdParam,
    userIdParam, userIdParam, ...rmTeamUserIds, ...rmTeamUserIds,
  ];
  const [[countRow]] = await pool.query(countSql, countParams);
  const totalRecords = Number(countRow && countRow.total) || 0;

  if (totalRecords === 0) {
    return {
      totalRecords: 0,
      pageNumber: pageNo,
      pageSize,
      totalPages: 0,
      data: [],
    };
  }

  // QUERY A — active-user page (getActiveUserList, repo:181-204).
  const userListSql = `
    SELECT TU.user_id, TU.user_name
    FROM tbl_user TU
    WHERE TU.user_type_id = 5
      AND TU.user_status = 1
      AND TU.user_role not in (1)
      AND ( ? IS NULL OR TU.manage_verticals = '0' OR FIND_IN_SET(?, TU.manage_verticals) )
      AND (
        (? IS NOT NULL AND ? > 0 AND TU.user_id = ?)
        OR ((? IS NULL OR ? = 0) AND (-1 IN (${rmPH}) OR TU.user_id IN (${rmPH})))
      )
    ORDER BY TU.user_name ASC
    LIMIT ? OFFSET ?`;
  const userListParams = [
    verticalId, verticalId,
    userIdParam, userIdParam, userIdParam,
    userIdParam, userIdParam, ...rmTeamUserIds, ...rmTeamUserIds,
    Math.min(pageSize, USER_LIST_LIMIT), offSet,
  ];
  const [userRows] = await pool.query(userListSql, userListParams);

  if (userRows.length >= USER_LIST_LIMIT) {
    logger.warn(
      `QuickSight Admin Dashboard employee-productivity hit the ${USER_LIST_LIMIT}-row user-page cap — result may be truncated`
    );
  }

  const userIds = userRows.map((u) => Number(u.user_id));
  const nameById = new Map(userRows.map((u) => [Number(u.user_id), u.user_name]));

  // Empty page (e.g. offset past the end) → zero rows, but totalRecords known.
  if (userIds.length === 0) {
    return {
      totalRecords,
      pageNumber: pageNo,
      pageSize,
      totalPages: Math.ceil(totalRecords / pageSize),
      data: [],
    };
  }

  const startDate = resolveStartDate(filters.startDate);
  const endDate = resolveEndDatePlusOne(filters.endDate);
  const userPH = inPlaceholders(userIds);

  // QUERY C — productivity metrics CTE (getEmployeeProductivity, repo:227-329).
  // NOTE: scopes by zonalManagerId ONLY (no manage_clients) — verbatim.
  const metricsSql = `
    WITH filtered_jobs AS (
      SELECT j.job_id, j.fk_created_by, j.fk_scheduled_by, j.cancel_by, j.full_fillment_by, j.fk_easyfixter_id, j.job_status, j.created_date_time, j.original_scheduling_date_time, j.cancel_date_time, j.full_fillment_created_time
      FROM tbl_job j
      LEFT JOIN tbl_address a ON a.address_id = j.fk_address_id
      LEFT JOIN tbl_city c ON c.city_id = a.city_id
      WHERE ((? IS NULL) OR c.state_user = ?)
    ),
    metrics AS (
      SELECT fk_created_by AS user_id, COUNT(job_id) AS cnt, 'booked' AS metric FROM filtered_jobs WHERE fk_created_by IN (${userPH}) AND created_date_time BETWEEN ? AND ? GROUP BY fk_created_by
      UNION ALL
      SELECT fk_scheduled_by, COUNT(job_id), 'scheduled' FROM filtered_jobs WHERE fk_scheduled_by IN (${userPH}) AND original_scheduling_date_time BETWEEN ? AND ? GROUP BY fk_scheduled_by
      UNION ALL
      SELECT cancel_by, COUNT(job_id), 'cancelled' FROM filtered_jobs WHERE cancel_by IN (${userPH}) AND job_status = 6 AND fk_easyfixter_id IS NOT NULL AND cancel_date_time BETWEEN ? AND ? GROUP BY cancel_by
      UNION ALL
      SELECT full_fillment_by, COUNT(job_id), 'foh' FROM filtered_jobs WHERE full_fillment_by IN (${userPH}) AND full_fillment_created_time BETWEEN ? AND ? GROUP BY full_fillment_by
      UNION ALL
      SELECT e.sent_by, COUNT(e.job_id), 'estimate_sent' FROM tbl_estimate_details e INNER JOIN filtered_jobs fj ON fj.job_id = e.job_id WHERE e.sent_by IN (${userPH}) AND e.sent_on BETWEEN ? AND ? GROUP BY e.sent_by
      UNION ALL
      SELECT e.sent_by, COUNT(e.job_id), 'estimate_approved' FROM tbl_estimate_details e INNER JOIN filtered_jobs fj ON fj.job_id = e.job_id WHERE e.sent_by IN (${userPH}) AND e.STATUS = 1 AND e.action_on BETWEEN ? AND ? GROUP BY e.sent_by
      UNION ALL
      SELECT e.sent_by, COUNT(e.job_id), 'estimate_rejected' FROM tbl_estimate_details e INNER JOIN filtered_jobs fj ON fj.job_id = e.job_id WHERE e.sent_by IN (${userPH}) AND e.STATUS = 2 AND e.action_on BETWEEN ? AND ? GROUP BY e.sent_by
      UNION ALL
      SELECT jt.updated_by, IFNULL(SUM(jt.total_charge), 0), 'revenue' FROM tbl_job_transaction jt INNER JOIN filtered_jobs fj ON fj.job_id = jt.fk_job_id WHERE jt.updated_by IN (${userPH}) AND jt.insert_date BETWEEN ? AND ? GROUP BY jt.updated_by
      UNION ALL
      SELECT jt.updated_by, COUNT(DISTINCT jt.fk_job_id), 'closed_count' FROM tbl_job_transaction jt INNER JOIN filtered_jobs fj ON fj.job_id = jt.fk_job_id WHERE jt.updated_by IN (${userPH}) AND jt.insert_date BETWEEN ? AND ? GROUP BY jt.updated_by
    )
    SELECT user_id,
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

  // Params in source order: filtered_jobs zonal guard (2), then for each of
  // the 9 UNION arms: the userIds IN-list followed by its (start,end) pair.
  const metricsParams = [zonalManagerId, zonalManagerId];
  for (let i = 0; i < 9; i++) {
    metricsParams.push(...userIds, startDate, endDate);
  }
  const [metricRows] = await pool.query(metricsSql, metricsParams);
  const metricsByUser = new Map(metricRows.map((r) => [Number(r.user_id), r]));

  // Map page users → DTO, filling zeros for users with no metrics
  // (createEmptyProductivity parity).
  const data = userRows.map((u) => {
    const uid = Number(u.user_id);
    const m = metricsByUser.get(uid);
    const estimateSent = m ? Number(m.estimate_sent) || 0 : 0;
    const estimateApproved = m ? Number(m.estimate_approved) || 0 : 0;
    const estimateRejected = m ? Number(m.estimate_rejected) || 0 : 0;
    const foh = m ? Number(m.foh) || 0 : 0;
    return {
      userId: uid,
      userName: nameById.get(uid) || '',
      booked: m ? Number(m.booked) || 0 : 0,
      scheduled: m ? Number(m.scheduled) || 0 : 0,
      // audit = estimate_sent + estimate_approved + estimate_rejected + foh.
      audit: estimateSent + estimateApproved + estimateRejected + foh,
      closedCount: m ? Number(m.closed_count) || 0 : 0,
      revenue: m ? Number(m.revenue) || 0 : 0,
      cancelCount: m ? Number(m.cancel_count) || 0 : 0,
    };
  });

  return {
    totalRecords,
    pageNumber: pageNo,
    pageSize,
    totalPages: Math.ceil(totalRecords / pageSize),
    data,
  };
}

/* ════════════════════════════════════════════════════════════════════════
 * 3) kraMetrics — single aggregate KPI row.
 * ════════════════════════════════════════════════════════════════════════ */
async function kraMetrics(filters = {}, actingUserId = null) {
  const { verticalId, zonalManagerId, applyClientFilter, clientIds } =
    await resolveAggregateFilters(filters, actingUserId);
  const clientList = applyClientFilter === 1 ? clientIds : [-1];
  const clientPH = inPlaceholders(clientList);
  const startDate = resolveStartDate(filters.startDate);
  const endDate = resolveEndDatePlusOne(filters.endDate);

  // KRA aggregate CTE (getKraMetricsData, repo:331-408).
  const sql = `
    WITH filtered_jobs AS (
      SELECT TJ.job_id, TJ.job_status, TJ.checkin_date_time, TJ.checkout_date_time, TJ.original_appointment_date_time, TJ.requested_date_time, TJ.ticket_created_date_time, TJ.call_later, TJ.fk_address_id, TJ.fk_client_id
      FROM tbl_job TJ
      LEFT JOIN tbl_address TA ON TA.address_id = TJ.fk_address_id
      LEFT JOIN tbl_city TC ON TC.city_id = TA.city_id
      LEFT JOIN tbl_client TCL ON TCL.client_id = TJ.fk_client_id
      WHERE ((TJ.job_status IN (3, 5) AND TJ.checkout_date_time BETWEEN ? AND ?) OR (TJ.job_status = 9))
        AND ((? IS NULL) OR TCL.vertical_id = ?)
        AND ((? IS NULL) OR TC.state_user = ?)
        AND (? = 0 OR TJ.fk_client_id IN (${clientPH}))
    ),
    job_transactions AS (
      SELECT TJT.fk_job_id, TJT.total_charge, TJT.efr_charge
      FROM tbl_job_transaction TJT
      WHERE TJT.fk_job_id IN (SELECT job_id FROM filtered_jobs)
    ),
    job_ratings AS (
      SELECT TRC.job_id, TRC.customer_rating
      FROM tbl_easyfixer_rating_by_customer TRC
      WHERE TRC.job_id IN (SELECT job_id FROM filtered_jobs) AND TRC.comment IS NOT NULL
    )
    SELECT
      COUNT(CASE WHEN FJ.job_status IN (3, 5) THEN 1 END) AS total_jobs,
      SUM(CASE WHEN FJ.job_status IN (3, 5) AND DATE(FJ.checkin_date_time) <= DATE(FJ.original_appointment_date_time) THEN 1 ELSE 0 END) AS sda_count,
      SUM(CASE WHEN FJ.job_status IN (3, 5) AND (FJ.checkin_date_time <= FJ.requested_date_time OR TIMESTAMPDIFF(MINUTE, FJ.requested_date_time, FJ.checkin_date_time) <= 15) THEN 1 ELSE 0 END) AS ota_count,
      SUM(CASE WHEN FJ.job_status IN (3, 5) THEN DATEDIFF(FJ.checkout_date_time, FJ.ticket_created_date_time) ELSE 0 END) AS total_tat_days,
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
  const params = [
    startDate, endDate,
    verticalId, verticalId,
    zonalManagerId, zonalManagerId,
    applyClientFilter, ...clientList,
  ];
  const [[row]] = await pool.query(sql, params);

  const totalJobs = Number(row && row.total_jobs) || 0;
  const sdaCount = Number(row && row.sda_count) || 0;
  const otaCount = Number(row && row.ota_count) || 0;
  const totalTatDays = Number(row && row.total_tat_days) || 0;
  const revenue = Number(row && row.revenue) || 0;
  const txShare = Number(row && row.tx_share) || 0;
  const totalRating = Number(row && row.total_rating) || 0;
  const ratingJobCount = Number(row && row.rating_job_count) || 0;
  const checkoutJobCount = Number(row && row.checkout_job_count) || 0;
  const unconfirmed = Number(row && row.unconfirmed) || 0;
  const callLater = Number(row && row.call_later) || 0;

  return {
    sdaPercentage: percentage(sdaCount, totalJobs),
    otaPercentage: percentage(otaCount, totalJobs),
    avgTat: average(totalTatDays, totalJobs),
    avgRating: average(totalRating, ratingJobCount),
    avgTicketSize: average(revenue, checkoutJobCount),
    unconfirmed,
    callLater,
    margin: marginPercent(revenue, txShare),
    revenue,
    otaCount,
    sdaCount,
    totalJobs,
    txShare,
    totalTatDays,
  };
}

/* ════════════════════════════════════════════════════════════════════════
 * 4) cancellationDetails — time buckets + before/after allocation summary.
 * ════════════════════════════════════════════════════════════════════════ */
async function cancellationDetails(filters = {}, actingUserId = null) {
  const { verticalId, zonalManagerId, applyClientFilter, clientIds } =
    await resolveAggregateFilters(filters, actingUserId);
  const clientList = applyClientFilter === 1 ? clientIds : [-1];
  const clientPH = inPlaceholders(clientList);
  const startDate = resolveStartDate(filters.startDate);
  const endDate = resolveEndDatePlusOne(filters.endDate);

  // QUERY A — cancellation time buckets (findCancelledJobsByTimeBucket, repo:453-485).
  const bucketSql = `
    SELECT
      CASE
        WHEN TIMESTAMPDIFF(MINUTE, J.ticket_created_date_time, J.cancel_date_time) <= 1440 THEN '0-1 days'
        WHEN TIMESTAMPDIFF(MINUTE, J.ticket_created_date_time, J.cancel_date_time) BETWEEN 1441 AND 4320 THEN '2-3 days'
        WHEN TIMESTAMPDIFF(MINUTE, J.ticket_created_date_time, J.cancel_date_time) BETWEEN 4321 AND 7200 THEN '4-5 days'
        ELSE '>5 days'
      END AS time_bucket,
      COUNT(*) AS total_jobs
    FROM tbl_job J
    LEFT JOIN tbl_address TA ON TA.address_id = J.fk_address_id
    LEFT JOIN tbl_city TC ON TC.city_id = TA.city_id
    LEFT JOIN tbl_client TCL ON TCL.client_id = J.fk_client_id
    LEFT JOIN tbl_user TU ON TU.user_id = J.reporting_contact_id
    WHERE J.job_status = 6
      AND J.cancel_date_time >= ?
      AND J.cancel_date_time < ?
      AND ((? IS NULL) OR TCL.vertical_id = ?)
      AND ((? IS NULL) OR TC.state_user = ?)
      AND (? = 0 OR J.fk_client_id IN (${clientPH}))
    GROUP BY time_bucket
    ORDER BY FIELD(time_bucket, '0-1 days', '2-3 days', '4-5 days', '>5 days')`;
  const bucketParams = [
    startDate, endDate,
    verticalId, verticalId,
    zonalManagerId, zonalManagerId,
    applyClientFilter, ...clientList,
  ];
  const [bucketRows] = await pool.query(bucketSql, bucketParams);

  // QUERY B — before/after allocation summary (cancelCountBeforeAfter, repo:488-517).
  const summarySql = `
    SELECT
      COUNT(*) AS total_cancelled,
      SUM(CASE WHEN J.fk_easyfixter_id IS NULL OR J.fk_easyfixter_id = 0 THEN 1 ELSE 0 END) AS before_allocation,
      SUM(CASE WHEN J.fk_easyfixter_id IS NOT NULL AND J.fk_easyfixter_id != 0 THEN 1 ELSE 0 END) AS after_allocation
    FROM tbl_job J
    LEFT JOIN tbl_address TA ON TA.address_id = J.fk_address_id
    LEFT JOIN tbl_city TC ON TC.city_id = TA.city_id
    LEFT JOIN tbl_client TCL ON TCL.client_id = J.fk_client_id
    LEFT JOIN tbl_user TU ON TU.user_id = J.reporting_contact_id
    WHERE J.job_status = 6
      AND J.cancel_date_time >= ?
      AND J.cancel_date_time < ?
      AND ((? IS NULL) OR TCL.vertical_id = ?)
      AND ((? IS NULL) OR TC.state_user = ?)
      AND (? = 0 OR J.fk_client_id IN (${clientPH}))`;
  const summaryParams = [
    startDate, endDate,
    verticalId, verticalId,
    zonalManagerId, zonalManagerId,
    applyClientFilter, ...clientList,
  ];
  const [[summaryRow]] = await pool.query(summarySql, summaryParams);

  // Always emit all 4 buckets defaulting to 0 (impl:610-628).
  const order = ['0-1 days', '2-3 days', '4-5 days', '>5 days'];
  const byLabel = new Map(bucketRows.map((r) => [r.time_bucket, Number(r.total_jobs) || 0]));
  const bucketData = order.map((label) => ({
    timeBucket: label,
    totalJobs: byLabel.get(label) || 0,
  }));

  return {
    summary: {
      totalOrderCancelled: Number(summaryRow && summaryRow.total_cancelled) || 0,
      beforeAllocation: Number(summaryRow && summaryRow.before_allocation) || 0,
      afterAllocation: Number(summaryRow && summaryRow.after_allocation) || 0,
    },
    bucketData,
  };
}

/* ════════════════════════════════════════════════════════════════════════
 * 5) managerTeam — org-chart tree rooted at user_id=3 ('CEO').
 * ════════════════════════════════════════════════════════════════════════ */
async function managerTeam() {
  // QUERY A — all users hierarchy (getAllUsersHierarchy, ManagerTeamRepository:30-47).
  const hierarchySql = `
    SELECT
      TU.user_id AS userId,
      TU.user_name AS userName,
      TU.reporting_manager AS reportingManagerId,
      TU1.user_name AS reportingManagerName,
      TR.role_name AS designation,
      TU1.reporting_manager AS managerOfManagerId
    FROM tbl_user TU
    LEFT JOIN tbl_role TR ON (TR.role_id = TU.user_role)
    LEFT JOIN tbl_user TU1 ON TU1.user_id = TU.reporting_manager
    WHERE TU.reporting_manager IS NOT NULL
      AND TU.reporting_manager != 0
      AND TU.user_type_id = 5
      AND TU.user_status = 1
      AND TU.user_role NOT IN (1)
    ORDER BY TU.reporting_manager
    LIMIT ${HIERARCHY_LIMIT}`;
  const [rows] = await pool.query(hierarchySql);

  if (rows.length >= HIERARCHY_LIMIT) {
    logger.warn(
      `QuickSight Admin Dashboard manager-team hit the ${HIERARCHY_LIMIT}-row hierarchy cap — tree may be truncated`
    );
  }

  // QUERY B — root user (getUserById, ManagerTeamRepository:50-52).
  const [[rootRow]] = await pool.query(
    'SELECT user_id, user_name FROM tbl_user WHERE user_id = ?',
    [ORG_ROOT_USER_ID]
  );

  if (rows.length === 0) return null; // 204 'No organization data found'

  // Build manager → [children] adjacency. Self-loop guard (managerId==userId).
  const childrenByManager = new Map();
  const designationById = new Map();
  for (const r of rows) {
    const uid = Number(r.userId);
    const mgr = Number(r.reportingManagerId);
    designationById.set(uid, r.designation || 'Employee');
    if (mgr === uid) continue; // self-loop guard (impl:89)
    if (!childrenByManager.has(mgr)) childrenByManager.set(mgr, []);
    childrenByManager.get(mgr).push({ userId: uid, userName: r.userName });
  }

  // Recursive tree build from the fixed root only (orphans dropped).
  function buildNode(userId, name, title) {
    const kids = (childrenByManager.get(userId) || [])
      .slice()
      .sort((a, b) => String(a.userName || '').localeCompare(String(b.userName || '')));
    const children = kids.map((k) =>
      buildNode(k.userId, k.userName, designationById.get(k.userId) || 'Employee')
    );
    return {
      id: userId,
      name: name || (userId === ORG_ROOT_USER_ID ? 'Root User' : 'Manager'),
      title: title || (userId === ORG_ROOT_USER_ID ? 'CEO' : 'Employee'),
      imageUrl: null,
      teamSize: children.length,
      children,
    };
  }

  const rootName = rootRow ? rootRow.user_name : 'Root User';
  return buildNode(ORG_ROOT_USER_ID, rootName, 'CEO');
}

/* ════════════════════════════════════════════════════════════════════════
 * 6) verticalManagers — reporting managers for a vertical (dropdown lookup).
 * ════════════════════════════════════════════════════════════════════════ */
async function verticalManagers(verticalId) {
  const vId = Number(verticalId) || 0;
  // getReportingManagersByVertical (repo:411-424).
  const sql = `
    SELECT DISTINCT TU.reporting_manager, TU1.user_name
    FROM tbl_user TU
    LEFT JOIN tbl_user TU1 ON TU1.user_id = TU.reporting_manager
    WHERE TU1.user_type_id = 5
      AND TU1.user_status = 1
      AND TU.reporting_manager IS NOT NULL
      AND TU.reporting_manager != 0
      AND ( ? = 0 OR TU1.manage_verticals = '0' OR FIND_IN_SET(?, TU1.manage_verticals) > 0 )
    order by TU1.user_name asc`;
  const [rows] = await pool.query(sql, [vId, vId]);
  // Only obj[0],obj[1] mapped (userId, userName).
  return rows
    .filter((r) => r.reporting_manager != null)
    .map((r) => ({ userId: String(r.reporting_manager), userName: r.user_name }));
}

/* ════════════════════════════════════════════════════════════════════════
 * 7) rmTeamUsers — users under an RM in a vertical (dropdown lookup).
 * ════════════════════════════════════════════════════════════════════════ */
async function rmTeamUsers(verticalId, reportingManagerId) {
  const vId = Number(verticalId) || 0;
  const rmId = Number(reportingManagerId) || 0;
  // getRmTeamUserList (repo:426-450).
  const sql = `
    SELECT TU.user_id, TU.user_name, TU.manage_verticals, TU.reporting_manager, TU1.user_name AS rm_name
    FROM tbl_user TU
    LEFT JOIN tbl_user TU1 ON TU1.user_id = TU.reporting_manager
    WHERE TU.user_type_id = 5
      AND TU.user_role not in (1)
      AND TU.user_status = 1
      AND ( ? = 0 OR TU.manage_verticals = '0' OR FIND_IN_SET(?, TU.manage_verticals) > 0 )
      AND ( ? = 0 OR TU.reporting_manager = ? )
    ORDER BY TU.user_name ASC`;
  const [rows] = await pool.query(sql, [vId, vId, rmId, rmId]);
  // obj[0],[1],[2],[4] mapped (userId, userName, manageVerticals, rmName);
  // obj[3] reporting_manager skipped.
  return rows.map((r) => ({
    userId: String(r.user_id),
    userName: r.user_name,
    manageVerticals: r.manage_verticals,
    rmName: r.rm_name,
  }));
}

module.exports = {
  openOrders,
  employeeProductivity,
  kraMetrics,
  cancellationDetails,
  managerTeam,
  verticalManagers,
  rmTeamUsers,
  // exposed for testing / reuse
  _internals: { percentage, average, marginPercent, resolveDateMode, resolveClientScope },
};
