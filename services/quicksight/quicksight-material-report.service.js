/*
 * QuickSight — Material Report (slug: materiallist) — service layer.
 *
 *   registry slug : materiallist
 *   urlBase       : material-report
 *   legacy        : POST /downloadMaterialReportForClient?clientId={id}
 *                   (ACD_APIs contoller/PmWorkDetails.java:309-361 →
 *                    service/impl/JobServiceImpl.java:4274 getAllJobsWithMaterials
 *                    + :4387 saveMaterial Excel writer)
 *
 * The legacy endpoint generated a server-side Excel on disk and returned a
 * download URL. The native rebuild splits that into ONE JSON list endpoint
 * (on-screen table) that ALSO honours ?format=xlsx (server-side stream via
 * utils/xlsx-export.js) — same column set, same row-per-element shape.
 *
 * PARITY NOTES (do NOT "clean up" — registry decisions + spec validations):
 *   - job_status IN (3,5) (JOB_STATUS.COMPLETED) — completed jobs only.
 *   - Date upper bound made INCLUSIVE of the whole end day via
 *     checkout_date_time < DATE_ADD(?, INTERVAL 1 DAY) — mirrors legacy
 *     endDate.plusDays(1) + '<' (JobServiceImpl.java:4283).
 *   - 60-day cap is enforced at the router (Joi) — legacy only had it FE-side.
 *   - Element-deployed lines (Service + Material UNION ALL) are batched with
 *     WHERE j.job_id IN (...) instead of the legacy per-job N+1 — functionally
 *     identical; flagged in the report. serviceName null → 'Travel' (legacy
 *     default, JobServiceImpl.java:4302).
 *   - Estimate (sent_on / action_on) fetched ONLY for jobs whose
 *     no_of_req_approval > 0 (JobServiceImpl.java:4330-4348). Batched per the
 *     conditional set; null result → both null.
 *   - A job with ZERO element-deployed lines is EXCLUDED entirely — the legacy
 *     Excel writer skips empty productsDeployed (JobServiceImpl.java:4438 /
 *     4617-4618). The on-screen table matches the Excel for parity (open
 *     question resolved → exclude). Replicated here by dropping such jobs.
 *   - ONE ROW PER element-deployed line; job-level fields repeated across each
 *     line (JobServiceImpl.java:4439 inner loop).
 *   - zonalManager is tbl_user.user_name via tbl_city.state_user (the city's
 *     state-assigned user), NOT a hierarchy manager — legacy semantics kept.
 *   - admin sees ALL — no req.scope row filtering (legacy had none; gated by
 *     ef-QuickSight + the per-report key via requireQuickSight).
 *   - blank-PM/blank-join rows shown via LEFT JOIN (no rows dropped on a
 *     missing address/city/state/zonal-user).
 *   - Image links: native resolves to authenticated/presigned URLs via the
 *     existing job-image helper rather than legacy basePathServer string
 *     concatenation. Category mapping preserved verbatim ('PO','JobSheet',
 *     'feedback' in tbl_job_image.image_category).
 *   - legacy had NO LIMIT; native adds a HIGH non-truncating safety cap and
 *     logger.warn()s when hit (registry decision: "no silent row drops").
 */

const { pool } = require('../../db');
const logger = require('../../logger');
const { JOB_STATUS } = require('./_shared');

// High safety caps — far above realistic counts inside a ≤60-day window. A hit
// is logged, never silently swallowed (registry decision: "no silent drops").
const JOBS_LIMIT = 5000;        // grouped-ish: one row per completed job
const ELEMENTS_LIMIT = 50000;   // list: element-deployed lines across the jobs

/*
 * Resolve a stored tbl_job_image.image key into a link the FE can render.
 *
 * The legacy report concatenated a base path + the stored image string.
 * EasyFix_Backend serves job images through a Bearer-gated presign endpoint
 * (GET /api/admin/quicksight/material-report/image-url?key=...) that mints a
 * short-TTL presigned S3 URL. We surface a STABLE relative API path here so
 * the FE can request the presigned URL with the authenticated api client and
 * then open/render it (a raw <img src> at this proxy would 401 — no bearer).
 * null/empty stays null (legacy guards at JobServiceImpl.java:4357-4377).
 */
function buildImageLink(imageKey) {
  if (imageKey == null) return null;
  const k = String(imageKey).trim();
  if (!k) return null;
  // Encode so spaces / special chars in the stored key survive the URL.
  return `/api/admin/quicksight/material-report/image-url?key=${encodeURIComponent(k)}`;
}

/*
 * materialReport(clientId, from, to)
 *
 * QUERY 1 (main job rows): completed jobs for one client whose
 * checkout_date_time falls in [from, to] (inclusive end day). LEFT JOINs to
 * address → city → state → zonal user + the three job-image categories
 * (PO / JobSheet / feedback). GROUP BY j.job_id (legacy parity — collapses the
 * 3 single-row image LEFT JOINs).
 *
 * QUERY 2 (element-deployed lines): batched UNION ALL of tbl_job_services +
 * job_material for ALL the job ids (kills the legacy N+1). serviceName null →
 * 'Travel'. Grouped by job_id in JS.
 *
 * QUERY 3 (estimate, conditional): for the subset of jobs with
 * no_of_req_approval > 0, the latest estimate row's sent_on (earliest) +
 * action_on (latest). Batched.
 *
 * Returns ONE flattened object per element-deployed line (job-level fields
 * repeated), jobs with zero elements excluded — matching the legacy Excel.
 */
async function materialReport(clientId, from, to) {
  // ── QUERY 1 — main job rows (VERBATIM legacy columns + typos preserved) ──
  const jobsSql = `
    SELECT
      j.job_id,
      j.job_desc,
      j.client_ref_id,
      j.branch_details,
      j.job_customer_name,
      a.address,
      j.ticket_created_date_time,
      j.requested_date_time,
      j.requested_time,
      j.checkin_date_time,
      j.app_checkout_date_time,
      j.no_of_req_approval,
      j.checkout_date_time,
      city.city_name,
      ts.state_name,
      j.client_spoc_name,
      tu.user_name AS zonal_manager,
      TJI.created_date AS po_upload_date,
      j.custom_property,
      TJI.image  AS po_image,
      TJI1.image AS jobsheet_image,
      TJI2.image AS feedback_link
    FROM tbl_job j
    LEFT JOIN tbl_address a   ON a.address_id = j.fk_address_id
    LEFT JOIN tbl_city city   ON city.city_id = a.city_id
    LEFT JOIN tbl_state ts    ON ts.state_id = city.state_id
    LEFT JOIN tbl_user tu     ON tu.user_id = city.state_user
    LEFT JOIN tbl_job_image TJI  ON TJI.job_id = j.job_id  AND TJI.image_category = 'PO'
    LEFT JOIN tbl_job_image TJI1 ON TJI1.job_id = j.job_id AND TJI1.image_category = 'JobSheet'
    LEFT JOIN tbl_job_image TJI2 ON TJI2.job_id = j.job_id AND TJI2.image_category = 'feedback'
    WHERE j.fk_client_id = ?
      AND j.job_status IN (${JOB_STATUS.COMPLETED.join(',')})
      AND j.checkout_date_time >= ?
      AND j.checkout_date_time < DATE_ADD(?, INTERVAL 1 DAY)
    GROUP BY j.job_id
    ORDER BY j.checkout_date_time DESC
    LIMIT ${JOBS_LIMIT}
  `;
  const [jobRows] = await pool.query(jobsSql, [clientId, from, to]);

  if (jobRows.length >= JOBS_LIMIT) {
    logger.warn(
      `QuickSight Material Report (clientId=${clientId}) hit the ${JOBS_LIMIT}-job safety cap — result may be truncated`
    );
  }

  if (jobRows.length === 0) return [];

  const jobIds = jobRows.map((r) => r.job_id);

  // ── QUERY 2 — element-deployed lines, batched IN(...) (kills legacy N+1) ──
  // Two IN-lists (one per UNION arm) → duplicate the placeholders + params.
  const inPlaceholders = jobIds.map(() => '?').join(',');
  const elementsSql = `
    SELECT j.job_id, rc.crc_ratecard_name AS service_name, js.quantity AS unit,
           js.total_charge AS cx_charge, js.total_cost AS total_cost, 'Service' AS source_type
      FROM tbl_job j
      LEFT JOIN tbl_job_services js     ON js.job_id = j.job_id AND js.job_service_status = 1
      LEFT JOIN tbl_client_service cs   ON cs.client_service_id = js.service_id
      LEFT JOIN tbl_client_rate_card rc ON rc.crc_id = cs.rate_card_id
     WHERE j.job_id IN (${inPlaceholders})
    UNION ALL
    SELECT j.job_id, jm.name AS service_name, jm.unit AS unit,
           jm.cx_unit AS cx_charge, jm.client_charge AS total_cost, 'Material' AS source_type
      FROM job_material jm
      INNER JOIN tbl_job j ON jm.job_id = j.job_id
     WHERE j.job_id IN (${inPlaceholders})
    LIMIT ${ELEMENTS_LIMIT}
  `;
  const [elementRows] = await pool.query(elementsSql, [...jobIds, ...jobIds]);

  if (elementRows.length >= ELEMENTS_LIMIT) {
    logger.warn(
      `QuickSight Material Report (clientId=${clientId}) hit the ${ELEMENTS_LIMIT}-element safety cap — result may be truncated`
    );
  }

  // Group elements by job_id. The legacy per-job query emitted a single
  // all-NULL row when a job had NO services AND NO materials (the LEFT JOIN
  // arm yields one NULL row); such "phantom" lines are NOT real elements and
  // were skipped by the legacy Excel writer (productsDeployed empty). Drop any
  // line where every element field is null so a serviceless job collapses to
  // zero elements (→ excluded below), matching the Excel exactly.
  const elementsByJob = new Map();
  for (const e of elementRows) {
    const isPhantom =
      e.service_name == null && e.unit == null && e.cx_charge == null && e.total_cost == null;
    if (isPhantom) continue;
    if (!elementsByJob.has(e.job_id)) elementsByJob.set(e.job_id, []);
    elementsByJob.get(e.job_id).push({
      // serviceName null → 'Travel' (legacy default).
      serviceName: e.service_name == null ? 'Travel' : e.service_name,
      serviceType: e.source_type, // 'Service' | 'Material'
      unit: e.unit == null ? 0 : e.unit,
      cxCharge: e.cx_charge == null ? 0 : e.cx_charge,
      totalCost: e.total_cost == null ? 0 : e.total_cost,
    });
  }

  // ── QUERY 3 — estimate info, ONLY for jobs with no_of_req_approval > 0 ──
  const estimateJobIds = jobRows
    .filter((r) => r.no_of_req_approval != null && r.no_of_req_approval > 0)
    .map((r) => r.job_id);

  const estimateByJob = new Map();
  if (estimateJobIds.length > 0) {
    // Per-job correlated lookup mirroring the legacy query
    // (EstimateRepository.fetchEstimateInfoByJobId): sent_on = earliest row's
    // sent_on; action_on = latest row's action_on. Batched as a derived-row
    // set so we issue ONE query for the conditional subset (no per-job N+1).
    const estPlaceholders = estimateJobIds.map(() => '?').join(',');
    const estimateSql = `
      SELECT ed.job_id,
             (SELECT sent_on FROM tbl_estimate_details
               WHERE job_id = ed.job_id ORDER BY id ASC LIMIT 1) AS sent_on,
             ed.action_on
        FROM tbl_estimate_details ed
        INNER JOIN (
          SELECT job_id, MAX(id) AS max_id
            FROM tbl_estimate_details
           WHERE job_id IN (${estPlaceholders})
           GROUP BY job_id
        ) latest ON latest.job_id = ed.job_id AND latest.max_id = ed.id
    `;
    const [estRows] = await pool.query(estimateSql, estimateJobIds);
    for (const er of estRows) {
      estimateByJob.set(er.job_id, {
        estimateSentOn: er.sent_on == null ? null : er.sent_on,
        estimateActionOn: er.action_on == null ? null : er.action_on,
      });
    }
  }

  // ── Assemble flattened rows: one row per element, job fields repeated ──
  const out = [];
  for (const j of jobRows) {
    const elements = elementsByJob.get(j.job_id);
    // Job with ZERO element-deployed lines → excluded (legacy Excel parity).
    if (!elements || elements.length === 0) continue;

    const est = estimateByJob.get(j.job_id) || { estimateSentOn: null, estimateActionOn: null };

    // appointmentDateTime = DATE(requested_date_time) + TIME(requested_time)
    // (legacy LocalDateTime.of(datePart,timePart), JobServiceImpl.java:4322-4327).
    const appointmentDateTime = combineDateTime(j.requested_date_time, j.requested_time);

    const jobBase = {
      jobId: j.job_id,
      clientRefId: j.client_ref_id,
      branchDetails: j.branch_details,
      customerName: j.job_customer_name,
      address: j.address,
      ticketCreatedDateTime: j.ticket_created_date_time,
      appointmentDateTime,
      checkInDateTime: j.checkin_date_time,
      appCheckoutDateTime: j.app_checkout_date_time,
      estimateSentOn: est.estimateSentOn,
      estimateActionOn: est.estimateActionOn,
      checkOutDateTime: j.checkout_date_time,
      jobDesc: j.job_desc,
      clientSpocName: j.client_spoc_name,
      cityName: j.city_name,
      stateName: j.state_name,
      zonalManager: j.zonal_manager,
      poUploadDate: j.po_upload_date == null ? null : j.po_upload_date,
      customProperty: j.custom_property == null ? null : j.custom_property,
      poImageLink: buildImageLink(j.po_image),
      jobSheetLink: buildImageLink(j.jobsheet_image),
      feedbackLink: buildImageLink(j.feedback_link),
    };

    for (const el of elements) {
      out.push({
        ...jobBase,
        serviceType: el.serviceType,
        serviceName: el.serviceName,
        unit: el.unit,
        cxCharge: el.cxCharge,
        totalCost: el.totalCost,
      });
    }
  }

  return out;
}

/*
 * combineDateTime(datePart, timePart) — legacy LocalDateTime.of(...) parity.
 *
 * requested_date_time is a DATETIME (the date portion is used); requested_time
 * is a separate TIME (e.g. "14:30:00"). We combine the date of the former with
 * the time of the latter into a JS Date so the FE renders dd-MM-yyyy HH:mm.
 * Null-guarded (legacy would NPE; native returns null per spec guidance).
 */
function combineDateTime(datePart, timePart) {
  if (datePart == null) return null;
  const d = datePart instanceof Date ? datePart : new Date(datePart);
  if (Number.isNaN(d.getTime())) return null;
  if (timePart == null) return d;

  // mysql2 returns TIME columns as strings ("HH:mm:ss"). Parse defensively.
  let h = 0;
  let m = 0;
  let s = 0;
  if (timePart instanceof Date) {
    h = timePart.getHours();
    m = timePart.getMinutes();
    s = timePart.getSeconds();
  } else {
    const parts = String(timePart).split(':');
    h = Number(parts[0]) || 0;
    m = Number(parts[1]) || 0;
    s = Number(parts[2]) || 0;
  }
  const out = new Date(d.getTime());
  out.setHours(h, m, s, 0);
  return out;
}

module.exports = { materialReport };
