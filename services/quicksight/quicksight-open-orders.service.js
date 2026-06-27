/*
 * QuickSight — Open Orders (PM open jobs) — service layer.
 *
 *   registry slug : openOrders
 *   legacy title  : "Job Owner Open Orders Quicksight" (default landing report)
 *
 * Faithful native port of the legacy ACD_APIs queries:
 *   - getOwnerOpenOrderSummary  (JobRepository.java:642) → summary()
 *   - getJobDetailsByPmUserId   (JobRepository.java:582) → byOwner()
 *
 * PARITY NOTES (do NOT "clean up" — see /tmp/qs/_registry.json decisions):
 *   - Plain COUNT(...) is preserved (NO DISTINCT) so a job with >1 customer
 *     rating fans out and inflates the bucket counts EXACTLY as legacy did.
 *     The DISTINCT alternative is left as a comment by escalationCount.
 *   - status NOT IN (3,5,7,6) terminal exclusion.
 *   - status 20 paired with 2 in the >12h on-app bucket (JOB_STATUS.ON_APP_IN_PROGRESS).
 *   - status 10 + no_of_req_approval<1 + no_of_req_foh<1 for the 18h audit bucket.
 *   - ownership column is job_client_owner (NOT job_owner).
 *   - summary totalAlerts EXCLUDES escalation; escalationCount is separate;
 *     the drill-down OUTER alert-OR INCLUDES is_escalated=1 → the drill-down
 *     can return MORE rows than the PM's totalAlerts. Asymmetry preserved verbatim.
 *   - cityMappedUser is tbl_user via tbl_city.state_user (the city's zonal
 *     owner), NOT the PM/owner. Label/meaning kept.
 *   - jobAge = DATEDIFF(CURDATE(), ticket_created_date_time).
 *   - blank-PM rows shown via LEFT JOIN to tbl_user (legacy crashed otherwise).
 *   - admin sees ALL — no req.scope row filtering (legacy had none).
 *   - legacy typo columns preserved verbatim: fk_easyfixter_id,
 *     tbl_easyfixer_rating_by_customer.is_escalated.
 *   - empty-filter safe-list(-1) hack dropped → buildInFilter emits NO clause
 *     for an unset filter (functionally identical: no restriction).
 *   - legacy had NO LIMIT; native adds a HIGH non-truncating safety cap and
 *     logger.warn()s when it is hit (no silent truncation in practice).
 */

const { pool } = require('../../db');
const logger = require('../../logger');
const { buildInFilter } = require('./_shared');

// High safety caps — far above realistic row counts. A hit is logged, never
// silently swallowed (registry decision: "no silent row drops").
const SUMMARY_LIMIT = 5000;   // grouped (one row per Job Owner)
const DRILLDOWN_LIMIT = 50000; // list (job-level rows for one PM)

/*
 * filterZeros — legacy JobServiceImpl.filterZeros parity.
 * null/empty → []; else strip null & 0; result may be empty → [] (no filter).
 * buildInFilter then emits no clause for an empty array.
 */
function filterZeros(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((v) => v !== null && v !== undefined && v !== 0);
}

/*
 * Build the four shared dimension filters used by BOTH queries. Column
 * identifiers are trusted (report code, never user input); only VALUES are
 * parameterised via buildInFilter.
 */
function buildSharedFilters(filters, params) {
  const clientId = filterZeros(filters.clientId);
  const serviceCategoryId = filterZeros(filters.serviceCategoryId);
  const verticalId = filterZeros(filters.verticalId);
  const zonalManagerId = filterZeros(filters.zonalManagerId);

  let where = '';
  where += buildInFilter('j.fk_client_id', clientId, params);
  where += buildInFilter('j.fk_service_catg_id', serviceCategoryId, params);
  where += buildInFilter('c.vertical_id', verticalId, params);
  where += buildInFilter('cy.state_user', zonalManagerId, params);
  return where;
}

/*
 * summary(filters) — MAIN Open Orders summary table.
 *
 * One row per Job Owner (tbl_job.job_client_owner) with the 7 alert-bucket
 * counts + escalationCount. Excludes terminal jobs and owner=0/NULL.
 * Sorted totalAlerts DESC. Returns rows shaped to the legacy DTO with
 * pmName null→'NA' and numeric nulls→0.
 */
async function summary(filters = {}) {
  logger.info('Open Orders summary · clientId=' + JSON.stringify(filters.clientId || []) + ' serviceCategoryId=' + JSON.stringify(filters.serviceCategoryId || []) + ' verticalId=' + JSON.stringify(filters.verticalId || []) + ' zonalManagerId=' + JSON.stringify(filters.zonalManagerId || []));
  const params = [];
  const filterWhere = buildSharedFilters(filters, params);

  // NOTE on escalationCount fan-out: the LEFT JOIN to
  // tbl_easyfixer_rating_by_customer multiplies a job row when it has >1
  // rating, inflating every COUNT(...) bucket — legacy has the identical
  // behaviour, so it is PRESERVED. For exact-job-count parity instead, use:
  //   COUNT(DISTINCT CASE WHEN trc.is_escalated=1 THEN j.job_id END)
  // (open question — do NOT switch silently; flagged in the report).
  const sql = `
    SELECT
      j.job_client_owner AS pmUserId,
      u.user_name AS pmName,
      COUNT(CASE WHEN j.job_status = 9 THEN 1 END) AS unconfirmed,
      COUNT(CASE WHEN j.job_status = 0 AND j.fk_easyfixter_id IS NULL AND j.requested_date_time < NOW() THEN 1 END) AS waitingForAllocation,
      COUNT(CASE WHEN j.job_status IN (0,1) AND j.fk_easyfixter_id IS NOT NULL AND j.requested_date_time < NOW() THEN 1 END) AS runningLate,
      COUNT(CASE WHEN j.job_status IN (2,20) AND TIMESTAMPDIFF(HOUR, j.checkin_date_time, NOW()) > 12 THEN 1 END) AS openOnApp,
      COUNT(CASE WHEN j.job_status = 10 AND j.no_of_req_approval < 1 AND j.no_of_req_foh < 1 AND TIMESTAMPDIFF(HOUR, j.app_checkout_date_time, NOW()) > 18 THEN 1 END) AS waitingAudit,
      COUNT(CASE WHEN (
          j.job_status = 9
          OR (j.requested_date_time < NOW() AND (
                (j.job_status = 0 AND j.fk_easyfixter_id IS NULL)
                OR (j.job_status IN (0,1) AND j.fk_easyfixter_id IS NOT NULL)
             ))
          OR (j.job_status IN (2,20) AND TIMESTAMPDIFF(HOUR, j.checkin_date_time, NOW()) > 12)
          OR (j.job_status = 10 AND j.no_of_req_approval < 1 AND j.no_of_req_foh < 1 AND TIMESTAMPDIFF(HOUR, j.app_checkout_date_time, NOW()) > 18)
        ) THEN 1 END) AS totalAlerts,
      COUNT(CASE WHEN trc.is_escalated = 1 THEN 1 END) AS escalationCount
    FROM tbl_job j
    LEFT JOIN tbl_user u ON u.user_id = j.job_client_owner
    LEFT JOIN tbl_client c ON c.client_id = j.fk_client_id
    LEFT JOIN tbl_address a ON a.address_id = j.fk_address_id
    LEFT JOIN tbl_city cy ON cy.city_id = a.city_id
    LEFT JOIN tbl_easyfixer_rating_by_customer trc ON trc.job_id = j.job_id
    WHERE j.job_client_owner > 0
      AND j.job_status NOT IN (3,5,7,6)${filterWhere}
    GROUP BY j.job_client_owner, u.user_name
    ORDER BY totalAlerts DESC
    LIMIT ${SUMMARY_LIMIT}
  `;

  const [rows] = await pool.query(sql, params);
  logger.info('Found ' + rows.length + ' job-owner summary rows');

  if (rows.length >= SUMMARY_LIMIT) {
    logger.warn(
      `QuickSight Open Orders summary hit the ${SUMMARY_LIMIT}-row safety cap — result may be truncated`
    );
  }

  return rows.map((r) => ({
    pmUserId: r.pmUserId == null ? 0 : r.pmUserId,
    pmName: r.pmName == null ? 'NA' : r.pmName,
    unconfirmed: r.unconfirmed || 0,
    waitingForAllocation: r.waitingForAllocation || 0,
    runningLate: r.runningLate || 0,
    openOnApp: r.openOnApp || 0,
    waitingAudit: r.waitingAudit || 0,
    totalAlerts: r.totalAlerts || 0,
    escalationCount: r.escalationCount || 0,
  }));
}

/*
 * byOwner(pmUserId, filters) — drill-down: individual open jobs for one PM.
 *
 * Same shared filters as summary() PLUS a hard scope to job_client_owner =
 * pmUserId and the OUTER alert-membership guard that ALSO admits
 * is_escalated=1 (asymmetry vs summary totalAlerts — preserved verbatim).
 * Sorted escalated-first then newest job_id.
 */
async function byOwner(pmUserId, filters = {}) {
  logger.info('Open Orders drill-down · pmUserId=' + pmUserId);
  const params = [pmUserId];
  const filterWhere = buildSharedFilters(filters, params);

  const sql = `
    SELECT
      j.job_id AS jobID,
      DATEDIFF(CURDATE(), j.ticket_created_date_time) AS jobAge,
      c.client_name AS clientName,
      j.client_spoc_name AS clientSpocName,
      u.user_name AS cityMappedUser,
      j.fk_easyfixter_id AS efrID,
      e.efr_name AS efrName,
      CASE
        WHEN j.job_status = 9 THEN 'Unconfirmed'
        WHEN (j.job_status = 0 AND j.fk_easyfixter_id IS NULL AND j.requested_date_time < NOW()) THEN 'Waiting for Allocation'
        WHEN (j.job_status IN (0,1) AND j.fk_easyfixter_id IS NOT NULL AND j.requested_date_time < NOW()) THEN 'Running Late'
        WHEN (j.job_status IN (2,20) AND TIMESTAMPDIFF(HOUR, j.checkin_date_time, NOW()) > 12) THEN 'Open on App > 12 hrs'
        WHEN (j.job_status = 10 AND j.no_of_req_approval < 1 AND j.no_of_req_foh < 1 AND TIMESTAMPDIFF(HOUR, j.app_checkout_date_time, NOW()) > 18) THEN 'Waiting Audit > 18 hrs'
        ELSE 'N/A'
      END AS jobBucketStatus,
      CASE WHEN trc.is_escalated = 1 THEN 1 ELSE 0 END AS isEscalated
    FROM tbl_job j
    LEFT JOIN tbl_client c ON c.client_id = j.fk_client_id
    LEFT JOIN tbl_easyfixer_rating_by_customer trc ON trc.job_id = j.job_id
    LEFT JOIN tbl_address a ON a.address_id = j.fk_address_id
    LEFT JOIN tbl_city cy ON cy.city_id = a.city_id
    LEFT JOIN tbl_user u ON u.user_id = cy.state_user
    LEFT JOIN tbl_easyfixer e ON e.efr_id = j.fk_easyfixter_id
    WHERE j.job_client_owner = ?
      AND j.job_status NOT IN (3,5,7,6)${filterWhere}
      AND (
        j.job_status = 9
        OR (j.requested_date_time < NOW() AND (
              (j.job_status = 0 AND j.fk_easyfixter_id IS NULL)
              OR (j.job_status IN (0,1) AND j.fk_easyfixter_id IS NOT NULL)
           ))
        OR (j.job_status IN (2,20) AND TIMESTAMPDIFF(HOUR, j.checkin_date_time, NOW()) > 12)
        OR (j.job_status = 10 AND j.no_of_req_approval < 1 AND j.no_of_req_foh < 1 AND TIMESTAMPDIFF(HOUR, j.app_checkout_date_time, NOW()) > 18)
        OR trc.is_escalated = 1
      )
    ORDER BY isEscalated DESC, j.job_id DESC
    LIMIT ${DRILLDOWN_LIMIT}
  `;

  const [rows] = await pool.query(sql, params);
  logger.info('Found ' + rows.length + ' open jobs for owner');

  if (rows.length >= DRILLDOWN_LIMIT) {
    logger.warn(
      `QuickSight Open Orders drill-down (pmUserId=${pmUserId}) hit the ${DRILLDOWN_LIMIT}-row safety cap — result may be truncated`
    );
  }

  return rows.map((r) => ({
    jobID: r.jobID == null ? 0 : r.jobID,
    jobAge: r.jobAge == null ? 0 : r.jobAge,
    clientName: r.clientName == null ? 'NA' : r.clientName,
    clientSpocName: r.clientSpocName == null ? 'NA' : r.clientSpocName,
    cityMappedUser: r.cityMappedUser == null ? 'NA' : r.cityMappedUser,
    efrID: r.efrID == null ? null : r.efrID,
    efrName: r.efrName == null ? '' : r.efrName,
    jobBucketStatus: r.jobBucketStatus == null ? 'N/A' : r.jobBucketStatus,
    isEscalated: r.isEscalated || 0,
  }));
}

module.exports = { summary, byOwner };
