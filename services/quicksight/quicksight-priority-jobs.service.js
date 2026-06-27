/*
 * QuickSight — Priority Jobs (legacy "Hotspot City") — service layer.
 *
 *   registry slug : priorityJobs
 *   legacy title  : "Priority Jobs (hotspot city — city-wise owned jobs aging)"
 *
 * Faithful native port of the legacy ACD_APIs queries. The LIVE legacy
 * endpoint is cityWiseOwnedJobsAgingReport (it superseded the older
 * PM_JOBS_HOTSPOT / openHotspotOrders, which is NOT used by the current
 * priorityJobs page). Three queries are ported:
 *   - getCityWiseJobAgingReport (JobRepository.java:849-887) → grid()  (+ size + esc/unconfirmed)
 *   - getHotspotOpenOrdersJobList (JobRepository.java:933-961) → cityJobs()  (drill-down)
 *   - getHotSpotCityCopyData (JobSecondRepository.java:910-955) → copyData()  (xlsx export)
 *
 * PARITY NOTES (do NOT "clean up" — see /tmp/qs/_registry.json decisions):
 *   - ROLE / OWNERSHIP scoping is by tbl_job.job_client_owner only (NOT the
 *     richer req.scope). Non-admin (user_role !== 2) is forced to own owned
 *     jobs; Admin (user_role === 2) sees ALL unless they pass owner ids.
 *     applyOwnerFilter mirrors the legacy 0/1 flag exactly.
 *   - City FK chain is tbl_job.fk_address_id → tbl_address.city_id → tbl_city
 *     (NOT tbl_client.client_city_id); state via tbl_city.state_id → tbl_state.
 *   - Ownership column is job_client_owner (NOT job_owner).
 *   - GRID + SIZE + DRILL-DOWN filter open jobs: job_status NOT IN (3,5,6,7,9).
 *   - Escalation KPI: NOT IN (3,5,6,7) AND TRC.is_escalated IS NOT NULL.
 *   - Unconfirmed KPI: job_status = 9.
 *   - !!! GENUINE LEGACY INCONSISTENCY (preserved verbatim, flagged to user):
 *     the EXCEL copy-data query uses the OPPOSITE status set —
 *     job_status IN (3,5,6,9) — so "Download Data" exports CLOSED jobs while
 *     the grid shows OPEN jobs. This is replicated EXACTLY (likely a legacy
 *     bug); see copyData() comment + the report's openQuestions.
 *   - THREE DIFFERENT age formulas across the 3 endpoints — preserve each:
 *       grid  : TIMESTAMPDIFF(DAY, ticket_created_date_time, NOW())
 *       drill : DATEDIFF(CURDATE(), ticket_created_date_time)
 *       excel : FLOOR(TIMESTAMPDIFF(MINUTE, ticket_created_date_time, NOW())/1440.0)
 *   - blank-PM / blank-city rows shown via LEFT JOIN (registry decision).
 *   - admin sees ALL — no req.scope row filtering (legacy had none).
 *   - legacy typo columns preserved verbatim: fk_easyfixter_id,
 *     tbl_service_catg, tbl_easyfixer_rating_by_customer.is_escalated, state_user.
 *   - empty-filter safe-list(-1) hack dropped → buildInFilter emits NO clause
 *     for an unset filter (functionally identical: no restriction).
 *   - legacy had NO LIMIT; native adds a HIGH non-truncating safety cap and
 *     logger.warn()s when it is hit (no silent truncation in practice).
 *   - averageTat: N/A for this report (no TAT column) — nothing to ship.
 */

const { pool } = require('../../db');
const logger = require('../../logger');
const { buildInFilter } = require('./_shared');

// High safety caps — far above realistic row counts. A hit is logged, never
// silently swallowed (registry decision: "no silent row drops").
const GRID_LIMIT = 5000;     // grouped (one row per city) — bounded by pageSize anyway
const LIST_LIMIT = 50000;    // job-level drill-down rows for one city
const EXPORT_LIMIT = 50000;  // job-level export rows

/*
 * filterZeros — legacy JobServiceImpl.filterZeros parity.
 * null/empty → []; else strip null/undefined & 0; result may be empty → []
 * (no filter). buildInFilter then emits no clause for an empty array, which
 * replicates the legacy `(:scalar IS NULL OR col IN (...))` no-op semantics.
 */
function filterZeros(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((v) => v !== null && v !== undefined && Number(v) !== 0).map(Number);
}

/*
 * resolveOwnerScope(reqUser, ownerIdsFromBody) — legacy role gate parity.
 *
 *   non-admin (user_role !== 2)        → { applyOwnerFilter: 1, ownerIds: [userId] }
 *   admin (user_role === 2), no filter → { applyOwnerFilter: 0, ownerIds: [] }
 *   admin + selected owner ids         → { applyOwnerFilter: 1, ownerIds }
 *
 * The SQL pattern `(? = 0 OR TJ.job_client_owner IN (...))` is built so that
 * when applyOwnerFilter = 0 the owner restriction is a no-op (and we emit NO
 * IN-list placeholders, avoiding IN() syntax errors).
 */
function resolveOwnerScope(reqUser, ownerIdsFromBody) {
  const isAdmin = Number(reqUser && reqUser.user_role) === 2; // legacy Admin role_id=2
  const owners = filterZeros(ownerIdsFromBody);
  if (!isAdmin) {
    return { applyOwnerFilter: 1, ownerIds: [Number(reqUser.user_id)] };
  }
  if (owners.length === 0) {
    return { applyOwnerFilter: 0, ownerIds: [] };
  }
  return { applyOwnerFilter: 1, ownerIds: owners };
}

/*
 * Build the three shared dimension filters used by ALL queries (service
 * category / state / city). Column identifiers are trusted (report code,
 * never user input); only VALUES are parameterised via buildInFilter.
 */
function buildDimensionFilters(filters, params) {
  let where = '';
  where += buildInFilter('TJ.fk_service_catg_id', filterZeros(filters.serviceCategoryId), params);
  where += buildInFilter('TS.state_id', filterZeros(filters.stateId), params);
  where += buildInFilter('TCY.city_id', filterZeros(filters.cityId), params);
  return where;
}

/*
 * Append the owner-scope clause. When applyOwnerFilter = 0 the clause is a
 * pure no-op (`? = 0` is TRUE), and no IN-list placeholders are emitted.
 * When 1, an IN (...) list is parameterised from ownerIds.
 */
function buildOwnerFilter(scope, params) {
  if (scope.applyOwnerFilter === 0) {
    params.push(0); // matches `? = 0` → no-op
    return ' AND (? = 0 OR TJ.job_client_owner IN (-1))';
  }
  params.push(1);
  const placeholders = scope.ownerIds.map(() => '?').join(',');
  for (const id of scope.ownerIds) params.push(id);
  return ` AND (? = 0 OR TJ.job_client_owner IN (${placeholders}))`;
}

/*
 * grid(reqUser, filters, { pageNo, pageSize }) — MAIN report.
 *
 * One row per (city, state) with the 4 aging buckets + total, paginated
 * per-CITY-ROW. Plus the two KPI counts (escalated, unconfirmed) and the
 * total city count. Returns the legacy CityWiseJobAgingResponseDTO shape:
 *   { paginatedData: { data, totalRecords, pageNumber, pageSize, totalPages },
 *     escalatedCount, unconfirmedCount }
 */
async function grid(reqUser, filters = {}, { pageNo = 1, pageSize = 10 } = {}) {
  logger.info('Priority Jobs grid · pageNo=' + pageNo + ' pageSize=' + pageSize);
  const scope = resolveOwnerScope(reqUser, filters.ownerId);
  logger.info('Owner scope resolved · applyOwnerFilter=' + scope.applyOwnerFilter + ' ownerIds=' + JSON.stringify(scope.ownerIds));
  const offset = (pageNo - 1) * pageSize;

  // ── GRID rows (JobRepository.java:849-887) ────────────────────────────
  const gridParams = [];
  const gridDim = buildDimensionFilters(filters, gridParams);
  const gridOwner = buildOwnerFilter(scope, gridParams);
  gridParams.push(pageSize, offset);
  const gridSql = `
    SELECT
      TCY.city_id,
      TCY.city_name,
      TS.state_name,
      COUNT(CASE WHEN TIMESTAMPDIFF(DAY, TJ.ticket_created_date_time, NOW()) = 0 THEN 1 END) AS today_count,
      COUNT(CASE WHEN TIMESTAMPDIFF(DAY, TJ.ticket_created_date_time, NOW()) = 1 THEN 1 END) AS yesterday_count,
      COUNT(CASE WHEN TIMESTAMPDIFF(DAY, TJ.ticket_created_date_time, NOW()) BETWEEN 2 AND 7 THEN 1 END) AS days_2_to_7_count,
      COUNT(CASE WHEN TIMESTAMPDIFF(DAY, TJ.ticket_created_date_time, NOW()) > 7 THEN 1 END) AS greater_than_7_count,
      COUNT(TJ.job_id) AS total_count
    FROM tbl_job TJ
    LEFT JOIN tbl_address TA ON TA.address_id = TJ.fk_address_id
    LEFT JOIN tbl_city TCY ON TCY.city_id = TA.city_id
    LEFT JOIN tbl_state TS ON TS.state_id = TCY.state_id
    WHERE TJ.job_status NOT IN (3, 5, 6, 7, 9)${gridDim}${gridOwner}
    GROUP BY TCY.city_id, TCY.city_name, TS.state_name
    ORDER BY total_count DESC, TCY.city_id ASC
    LIMIT ? OFFSET ?
  `;

  // ── SIZE / totalRecords = COUNT(DISTINCT city_id) (JobRepository.java:911-932) ──
  const sizeParams = [];
  const sizeDim = buildDimensionFilters(filters, sizeParams);
  const sizeOwner = buildOwnerFilter(scope, sizeParams);
  const sizeSql = `
    SELECT COUNT(DISTINCT TCY.city_id) AS total
    FROM tbl_job TJ
    LEFT JOIN tbl_address TA ON TA.address_id = TJ.fk_address_id
    LEFT JOIN tbl_city TCY ON TCY.city_id = TA.city_id
    LEFT JOIN tbl_state TS ON TS.state_id = TCY.state_id
    WHERE TJ.job_status NOT IN (3, 5, 6, 7, 9)${sizeDim}${sizeOwner}
  `;

  // ── Escalated KPI (JobRepository.java:889-899) — owner scope only ─────
  const escParams = [];
  const escOwner = buildOwnerFilter(scope, escParams);
  const escSql = `
    SELECT COUNT(TJ.job_id) AS cnt
    FROM tbl_job TJ
    LEFT JOIN tbl_easyfixer_rating_by_customer TRC ON TJ.job_id = TRC.job_id
    WHERE TJ.job_status NOT IN (3, 5, 6, 7)
      AND TRC.is_escalated IS NOT NULL${escOwner}
  `;

  // ── Unconfirmed KPI (JobRepository.java:901-909) — owner scope only ───
  const uncParams = [];
  const uncOwner = buildOwnerFilter(scope, uncParams);
  const uncSql = `
    SELECT COUNT(TJ.job_id) AS cnt
    FROM tbl_job TJ
    WHERE TJ.job_status = 9${uncOwner}
  `;

  const [[gridRows], [[sizeRow]], [[escRow]], [[uncRow]]] = await Promise.all([
    pool.query(gridSql, gridParams),
    pool.query(sizeSql, sizeParams),
    pool.query(escSql, escParams),
    pool.query(uncSql, uncParams),
  ]);

  if (gridRows.length >= GRID_LIMIT) {
    logger.warn(
      `QuickSight Priority Jobs grid hit the ${GRID_LIMIT}-row safety cap — result may be truncated`
    );
  }

  const totalRecords = Number((sizeRow && sizeRow.total) || 0);
  logger.info('Found ' + gridRows.length + ' city rows · totalCities=' + totalRecords + ' escalated=' + Number((escRow && escRow.cnt) || 0) + ' unconfirmed=' + Number((uncRow && uncRow.cnt) || 0));

  const data = gridRows.map((r) => ({
    cityId: r.city_id == null ? 0 : r.city_id,
    cityName: r.city_name == null ? 'NA' : r.city_name,
    stateName: r.state_name == null ? 'NA' : r.state_name,
    todayCount: r.today_count || 0,
    yesterdayCount: r.yesterday_count || 0,
    days2To7Count: r.days_2_to_7_count || 0,
    greaterThan7Count: r.greater_than_7_count || 0,
    totalCount: r.total_count || 0,
  }));

  return {
    paginatedData: {
      data,
      totalRecords,
      pageNumber: pageNo,
      pageSize,
      totalPages: pageSize > 0 ? Math.ceil(totalRecords / pageSize) : 0,
    },
    escalatedCount: Number((escRow && escRow.cnt) || 0),
    unconfirmedCount: Number((uncRow && uncRow.cnt) || 0),
  };
}

/*
 * cityJobs(reqUser, filters) — DRILL-DOWN: open jobs for the clicked city.
 *
 * The FE forces cityId = [clickedCityId] before calling, so the city filter
 * scopes the result to a single city. Same open-jobs status set + same owner
 * scope as the grid. Age via DATEDIFF(CURDATE(), ticket_created_date_time).
 * NOT paginated (legacy returns the full list); native adds a safety cap.
 */
async function cityJobs(reqUser, filters = {}) {
  logger.info('Priority Jobs city drill-down · cityId=' + JSON.stringify(filters.cityId || []));
  const scope = resolveOwnerScope(reqUser, filters.ownerId);

  const params = [];
  const dim = buildDimensionFilters(filters, params);
  const owner = buildOwnerFilter(scope, params);
  params.push(LIST_LIMIT);

  const sql = `
    SELECT
      TJ.job_id,
      TJ.job_status,
      TJ.fk_easyfixter_id,
      CASE
        WHEN TJ.job_status = 0 AND TJ.fk_easyfixter_id IS NULL THEN 'Pending For Scheduling'
        WHEN TJ.job_status = 0 AND TJ.fk_easyfixter_id IS NOT NULL THEN 'Pending For Acknowledgment'
        WHEN TJ.job_status = 1 THEN 'Pending to Start'
        ELSE 'Unknown Status'
      END AS status_message,
      UO.user_name AS owner_user,
      UO.user_id,
      TC.client_name,
      e.efr_name,
      DATEDIFF(CURDATE(), TJ.ticket_created_date_time) AS job_age,
      UO.user_name AS job_current_owner
    FROM tbl_job TJ
    LEFT JOIN tbl_address TA ON TA.address_id = TJ.fk_address_id
    LEFT JOIN tbl_easyfixer e ON e.efr_id = TJ.fk_easyfixter_id
    LEFT JOIN tbl_user UO ON UO.user_id = TJ.job_client_owner
    LEFT JOIN tbl_client TC ON TJ.fk_client_id = TC.client_id
    LEFT JOIN tbl_city TCY ON TCY.city_id = TA.city_id
    LEFT JOIN tbl_state TS ON TS.state_id = TCY.state_id
    WHERE TJ.job_status NOT IN (3, 5, 6, 7, 9)${dim}${owner}
    LIMIT ?
  `;

  const [rows] = await pool.query(sql, params);
  logger.info('Found ' + rows.length + ' open jobs for city');

  if (rows.length >= LIST_LIMIT) {
    logger.warn(
      `QuickSight Priority Jobs city drill-down hit the ${LIST_LIMIT}-row safety cap — result may be truncated`
    );
  }

  // Legacy mapper has NO null-coalescing (direct casts). Native keeps the
  // shape but coalesces nulls for safe JSON rendering. row[4] (owner_user)
  // and the trailing job_current_owner are BOTH UO.user_name — identical,
  // preserved verbatim.
  return rows.map((r) => ({
    jobId: r.job_id == null ? 0 : r.job_id,
    jobStatus: r.job_status == null ? 0 : r.job_status,
    easyFixterId: r.fk_easyfixter_id == null ? null : r.fk_easyfixter_id,
    statusMessage: r.status_message == null ? 'Unknown Status' : r.status_message,
    jobOwner: r.owner_user == null ? 'NA' : r.owner_user,
    userId: r.user_id == null ? null : r.user_id,
    clientName: r.client_name == null ? 'NA' : r.client_name,
    easyFixerName: r.efr_name == null ? '' : r.efr_name,
    jobAge: r.job_age == null ? 0 : Number(r.job_age),
    jobCurrentOwner: r.job_current_owner == null ? 'NA' : r.job_current_owner,
  }));
}

/*
 * copyData(reqUser, filters) — EXCEL export (job-level rows).
 *
 * Filter (CORRECTED 2026-06-15): job_status NOT IN (3,5,6,7,9) — i.e. OPEN
 * jobs, matching the grid / drill-down exactly. The legacy query filtered
 * job_status IN (3,5,6,9) (CLOSED jobs), so "Download Data" exported the
 * OPPOSITE of the grid it sits under — a legacy bug. It was initially
 * replicated verbatim under the migration-faithfulness rule, then corrected
 * on user request so the export reflects the same OPEN jobs as the report.
 * (The status_message CASE below already labels the OPEN statuses 0/1, which
 * only now actually apply.)
 *
 * Age via FLOOR(TIMESTAMPDIFF(MINUTE, ...) / 1440.0). Appointment columns
 * combine date + time parts server-side, formatted dd-MM-yyyy HH:mm (IST).
 * Returns rows shaped to the 18-column legacy "Hotspot_Job_Data" sheet.
 */
async function copyData(reqUser, filters = {}) {
  logger.info('Priority Jobs export · serviceCategoryId=' + JSON.stringify(filters.serviceCategoryId || []) + ' stateId=' + JSON.stringify(filters.stateId || []) + ' cityId=' + JSON.stringify(filters.cityId || []));
  const scope = resolveOwnerScope(reqUser, filters.ownerId);

  const params = [];
  const dim = buildDimensionFilters(filters, params);
  const owner = buildOwnerFilter(scope, params);
  params.push(EXPORT_LIMIT);

  const sql = `
    SELECT
      TJ.job_id,
      TCY.city_name,
      TU.user_name AS zonal_manager,
      CASE
        WHEN TCY.city_type = 1 THEN 'Local'
        WHEN TCY.city_type = 0 THEN 'Up Country'
        ELSE 'Unknown'
      END AS city_type,
      TJ.fk_easyfixter_id,
      TE.efr_name,
      TSC.service_catg_name,
      TJ.requested_date_time,
      TJ.requested_time,
      TJ.original_appointment_date_time,
      ATR.user_type,
      ATR.action_desc,
      TJ.remarks,
      CASE
        WHEN ATR.user_type = 1 THEN 'Easyfixer'
        WHEN ATR.user_type = 2 THEN 'Customer'
        WHEN ATR.user_type = 3 THEN 'Client'
        WHEN ATR.user_type = 4 THEN 'Technician'
        ELSE 'NA'
      END AS due_to,
      CASE
        WHEN TJ.job_status = 0 AND TJ.fk_easyfixter_id IS NULL THEN 'unallocated'
        WHEN TJ.job_status = 0 AND TJ.fk_easyfixter_id IS NOT NULL THEN 'Pending For Ack'
        WHEN TJ.job_status = 1 THEN 'Pending to Start'
        ELSE 'Unknown Status'
      END AS job_status,
      TJ.original_appointment_time,
      TJ.remarks_date_time,
      TJ.job_desc,
      TC.client_name,
      FLOOR(TIMESTAMPDIFF(MINUTE, TJ.ticket_created_date_time, NOW()) / 1440.0) AS job_age,
      TU1.user_name AS job_current_owner
    FROM tbl_job TJ
    LEFT JOIN tbl_easyfixer TE ON TE.efr_id = TJ.fk_easyfixter_id
    LEFT JOIN tbl_address TA ON TA.address_id = TJ.fk_address_id
    LEFT JOIN tbl_city TCY ON TCY.city_id = TA.city_id
    LEFT JOIN tbl_state TS ON TS.state_id = TCY.state_id
    LEFT JOIN tbl_service_catg TSC ON TSC.service_catg_id = TJ.fk_service_catg_id
    LEFT JOIN action_taken_reason ATR ON ATR.id = TJ.enum_reason_id
    LEFT JOIN tbl_user TU ON TU.user_id = TCY.state_user
    LEFT JOIN tbl_user TU1 ON TU1.user_id = TJ.job_client_owner
    LEFT JOIN tbl_client TC ON TC.client_id = TJ.fk_client_id
    WHERE TJ.job_status NOT IN (3, 5, 6, 7, 9)${dim}${owner}
    ORDER BY TJ.job_id DESC
    LIMIT ?
  `;

  const [rows] = await pool.query(sql, params);
  logger.info('Found ' + rows.length + ' export rows');

  if (rows.length >= EXPORT_LIMIT) {
    logger.warn(
      `QuickSight Priority Jobs export hit the ${EXPORT_LIMIT}-row safety cap — result may be truncated`
    );
  }

  // Per-row try/catch parity (legacy logged & dropped bad rows). Appointment
  // combine guards: only set when BOTH date and time parts are present.
  const out = [];
  for (const r of rows) {
    try {
      out.push({
        job_id: r.job_id == null ? 0 : r.job_id,
        jobAge: r.job_age == null ? 0 : Number(r.job_age),
        jobCurrentOwner: r.job_current_owner == null ? 'NA' : r.job_current_owner,
        clientName: r.client_name == null ? 'NA' : r.client_name,
        jobDescription: r.job_desc == null ? '' : r.job_desc,
        cityName: r.city_name == null ? 'NA' : r.city_name,
        zonalManager: r.zonal_manager == null ? 'NA' : r.zonal_manager,
        cityType: r.city_type == null ? 'Unknown' : r.city_type,
        jobStatus: r.job_status == null ? 'Unknown Status' : r.job_status,
        efr_id: r.fk_easyfixter_id == null ? null : r.fk_easyfixter_id,
        efr_name: r.efr_name == null ? '' : r.efr_name,
        catgName: r.service_catg_name == null ? '' : r.service_catg_name,
        appointmentDateTime: combineDateTime(r.requested_date_time, r.requested_time),
        originalAppointmentDateTime: combineDateTime(r.original_appointment_date_time, r.original_appointment_time),
        pendingDueTo: r.due_to == null ? 'NA' : r.due_to,
        reason: r.action_desc == null ? '' : r.action_desc,
        remarks: r.remarks == null ? '' : r.remarks,
        lastUpdatedRemarksDateTime: r.remarks_date_time == null ? '' : formatDateTime(r.remarks_date_time),
      });
    } catch (err) {
      logger.warn(`QuickSight Priority Jobs export: skipping bad row job_id=${r && r.job_id}: ${err.message}`);
    }
  }
  logger.info('Returning ' + out.length + ' export rows');
  return out;
}

/*
 * combineDateTime(datePart, timePart) — legacy appointment combine.
 * Only produces a value when BOTH parts are non-null; formatted dd-MM-yyyy
 * HH:mm in IST. The DATE part supplies y/m/d, the TIME part supplies H:m.
 */
function combineDateTime(datePart, timePart) {
  if (datePart == null || timePart == null) return '';
  const d = datePart instanceof Date ? datePart : new Date(datePart);
  if (Number.isNaN(d.getTime())) return '';
  // timePart from mysql2 is a "HH:mm:ss" string for a TIME column.
  let hh = '00';
  let mm = '00';
  if (typeof timePart === 'string') {
    const m = timePart.match(/(\d{1,2}):(\d{2})/);
    if (m) { hh = m[1].padStart(2, '0'); mm = m[2]; }
  } else if (timePart instanceof Date) {
    hh = String(timePart.getHours()).padStart(2, '0');
    mm = String(timePart.getMinutes()).padStart(2, '0');
  }
  const dd = String(d.getDate()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const yy = d.getFullYear();
  return `${dd}-${mo}-${yy} ${hh}:${mm}`;
}

/*
 * formatDateTime(dt) — dd-MM-yyyy HH:mm (IST) for a single DATETIME value.
 */
function formatDateTime(dt) {
  if (dt == null) return '';
  const d = dt instanceof Date ? dt : new Date(dt);
  if (Number.isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const yy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${dd}-${mo}-${yy} ${hh}:${mm}`;
}

module.exports = { grid, cityJobs, copyData };
