/*
 * QuickSight — Client Performance (monthly / weekly) service.
 *
 * Native rebuild of the legacy ACD_APIs endpoint
 *   POST /pmJobs/clientPerformanceSummary?dataFlag={monthly|weekly}
 *   (controller PmWorkDetails.java:223-248,
 *    service  JobServiceImpl.java:3576-3829,
 *    repo     JobSecondRepository.java:414-508,
 *    PM lookup VerticalRepository.java:15-16).
 *
 * One row per client that has at least one ticket in the overall 3-period
 * window (the legacy "client list" driver). For each client we emit exactly
 * 3 period buckets (most-recent → oldest), each carrying:
 *   ticketCreated · enquiryPercentage · cancellationAfterAllocation ·
 *   averageTicketSize · sumOfTotalCharge · averageTat · escalationPercentage
 *
 * FAITHFUL-MIGRATION decisions applied (registry `decisions` block):
 *   - PRESERVE legacy plain COUNT / SUM (NO DISTINCT) for fan-out parity.
 *   - averageTat is shipped as 0 (legacy TAT block was commented out). The
 *     revive SQL is kept verbatim in a comment for the future product call.
 *   - Admin sees ALL clients — no per-row scope filtering (legacy had none).
 *   - Blank-PM rows are KEPT via LEFT JOIN (legacy NPE'd; native shows blank).
 *   - The legacy scalar IS-NULL sentinel is replaced with buildInFilter.
 *   - The +1-day inclusive upper bound is preserved exactly via
 *     DATE_ADD(?, INTERVAL 1 DAY).
 *   - HIGH non-truncating safety LIMITs with logger.warn when the cap is hit.
 *   - Legacy typo column names kept verbatim (fk_easyfixter_id, tbl_service_catg).
 *
 * Performance vs legacy: the legacy code did findById + a vertical lookup +
 * 6 count queries PER CLIENT PER PERIOD (N * 6 * 3 round-trips). This rewrite
 * collapses that to a fixed number of set-based queries (one aggregate query
 * per period + revenue + escalation per period + one name/PM query),
 * preserving identical semantics. House rule: every value is bound via `?`.
 */

const { pool } = require('../../db');
const logger = require('../../logger');
const {
  buildInFilter,
  computeLastThreeWeeks,
  computeLastThreeMonths,
  JOB_STATUS,
} = require('./_shared');

// Safety caps — legacy had NONE. These are deliberately high so they never
// truncate a real production run; if one IS hit we logger.warn (no silent drop).
const CLIENT_CAP = 5000;   // grouped client rows
const PER_QUERY_CAP = 50000;

/*
 * Build the period windows + their display labels.
 *   weekly  → last 3 FULL Sun–Sat weeks (excludes current partial week).
 *   monthly → current partial month (1st..today) + 2 prior FULL months.
 * Both come back oldest→newest from _shared; the report renders
 * most-recent→oldest, so we reverse and attach a label.
 *   - weekly label  : "<startDate> - <endDate>" (ISO dates; FE formats)
 *   - monthly label : full month name (e.g. "JUNE") to match legacy enum name
 */
function buildPeriods(period) {
  if (period === 'weekly') {
    const weeks = computeLastThreeWeeks(); // oldest→newest
    return weeks
      .slice()
      .reverse() // most-recent first
      .map((w, idx) => ({
        label: `${w.start} - ${w.end}`,
        week: String(idx + 1), // legacy week '1'|'2'|'3'
        month: null,
        startDate: w.start,
        endDate: w.end,
      }));
  }
  // monthly (default / any non-'weekly' value, mirroring legacy else-branch)
  const months = computeLastThreeMonths(); // oldest→newest
  return months
    .slice()
    .reverse()
    .map((m) => ({
      label: monthName(m.start),
      week: null,
      month: monthName(m.start),
      startDate: m.start,
      endDate: m.end,
    }));
}

// Full month name in UPPER case to match the legacy Month.name() enum (e.g.
// JUNE). Parsed from a 'YYYY-MM-DD' string with NO timezone math.
const MONTH_NAMES = [
  'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
];
function monthName(isoDate) {
  const m = Number(isoDate.slice(5, 7)); // 1..12
  return MONTH_NAMES[m - 1] || '';
}

/*
 * Row driver — DISTINCT clients with a ticket in the overall window, with the
 * 5 optional filters applied. Mirrors legacy [A]
 * (JobSecondRepository.java:414-441): zonalManager = tbl_city.state_user,
 * projectManager = tbl_vertical_mapping user_type=1, vertical =
 * tbl_client.vertical_id, serviceCategory = tbl_job.fk_service_catg_id.
 * Legacy IS-NULL sentinels are replaced by buildInFilter (omits the clause
 * entirely when a filter list is empty). Window = overall start .. overall end.
 */
async function getClientDriverSet({ filters, overallStart, overallEnd }) {
  logger.info('Resolving client driver set · window=' + overallStart + '..' + overallEnd);
  const params = [];
  let where = ' WHERE 1=1';
  where += buildInFilter('TJ.fk_client_id', filters.clientId, params);
  where += buildInFilter('TCC.state_user', filters.zonalManagerId, params);
  where += buildInFilter('TC.vertical_id', filters.verticalId, params);
  where += buildInFilter('TVM.user_id', filters.projectManagerId, params);
  where += buildInFilter('TJ.fk_service_catg_id', filters.serviceCategoryId, params);

  // ticket_created window — legacy [A] used a plain BETWEEN (NOT the +1-day
  // inclusive bound). overallEnd already extends to the latest period end day,
  // so the driver set is the union of all 3 period clients. Preserve verbatim.
  where += ' AND TJ.ticket_created_date_time BETWEEN ? AND ?';
  params.push(overallStart, overallEnd);

  const sql =
    `SELECT DISTINCT TJ.fk_client_id AS client_id
       FROM tbl_job TJ
       LEFT JOIN tbl_client TC ON TC.client_id = TJ.fk_client_id
       LEFT JOIN tbl_vertical_mapping TVM ON TVM.client_id = TC.client_id AND TVM.user_type = 1
       LEFT JOIN tbl_address TA ON TA.address_id = TJ.fk_address_id
       LEFT JOIN tbl_city TCC ON TCC.city_id = TA.city_id
       LEFT JOIN tbl_service_catg TSC ON TSC.service_catg_id = TJ.fk_service_catg_id
       LEFT JOIN tbl_user TUZM ON TCC.state_user = TUZM.user_id
       ${where}
       ORDER BY TJ.fk_client_id DESC
       LIMIT ${CLIENT_CAP}`;

  const [rows] = await pool.query(sql, params);
  logger.info('Found ' + rows.length + ' clients in performance driver set');
  if (rows.length >= CLIENT_CAP) {
    logger.warn(
      { report: 'client-performance', cap: CLIENT_CAP, returned: rows.length },
      'Client Performance driver hit the client safety cap — results may be incomplete',
    );
  }
  return rows.map((r) => r.client_id);
}

// Build an `IN (?,?,…)` clause + push the client ids; returns the fragment.
function inClause(ids, params) {
  const placeholders = ids.map(() => '?').join(',');
  for (const id of ids) params.push(id);
  return `(${placeholders})`;
}

/*
 * Per-period count metrics via conditional aggregation across the client set.
 * Semantics MUST equal legacy [B]/[C]/[D]/[E] (one COUNT each, plain — NO
 * DISTINCT). Each predicate carries the +1-day inclusive upper bound exactly
 * (DATE_ADD(?, INTERVAL 1 DAY)) as in the legacy `:weekEndDate + INTERVAL '1' DAY`.
 *
 * Buckets:
 *   ticket_created     : any ticket in the ticket_created window           [B]
 *   enquiry            : job_status=7 in the ticket_created window         [C]
 *   cancel_post_alloc  : job_status=6 AND fk_easyfixter_id NOT NULL …      [D]
 *   completed          : job_status IN (3,5) in the BILLING window         [E]
 * (completed uses billing_checkout_date_time, NOT ticket_created — verbatim.)
 */
async function getPeriodCounts({ clientIds, start, end }) {
  const params = [];
  // ticket_created
  params.push(start, end);
  // enquiry
  params.push(start, end);
  // cancel_post_alloc
  params.push(start, end);
  // completed (billing window)
  params.push(start, end);
  const inFrag = inClause(clientIds, params);

  const [completedStatusA, completedStatusB] = JOB_STATUS.COMPLETED; // [3,5]
  const ENQUIRY_STATUS = 7; // legacy [C]: job_status=7 = enquiry (not a named _shared constant)

  const sql =
    `SELECT TJ.fk_client_id AS client_id,
       COUNT(CASE WHEN TJ.ticket_created_date_time BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY) THEN TJ.job_id END) AS ticket_created,
       COUNT(CASE WHEN TJ.job_status = ${ENQUIRY_STATUS} AND TJ.ticket_created_date_time BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY) THEN TJ.job_id END) AS enquiry,
       COUNT(CASE WHEN TJ.job_status = ${JOB_STATUS.CANCELLED} AND TJ.fk_easyfixter_id IS NOT NULL AND TJ.ticket_created_date_time BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY) THEN TJ.job_id END) AS cancel_post_alloc,
       COUNT(CASE WHEN TJ.job_status IN (${completedStatusA},${completedStatusB}) AND TJ.billing_checkout_date_time BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY) THEN TJ.job_id END) AS completed
       FROM tbl_job TJ
      WHERE TJ.fk_client_id IN ${inFrag}
      GROUP BY TJ.fk_client_id
      LIMIT ${PER_QUERY_CAP}`;

  const [rows] = await pool.query(sql, params);
  return indexByClient(rows);
}

/*
 * Per-period revenue = SUM(tbl_job_transaction.total_charge) over completed
 * jobs in the BILLING window. Mirrors legacy [F] (JobSecondRepository.java:480).
 * Plain SUM, no DISTINCT — preserves any multi-transaction fan-out exactly as
 * legacy did (openQuestion flagged tbl_job_transaction may be >1 per job).
 */
async function getPeriodRevenue({ clientIds, start, end }) {
  const params = [start, end];
  const inFrag = inClause(clientIds, params);
  const [a, b] = JOB_STATUS.COMPLETED;
  const sql =
    `SELECT TJ.fk_client_id AS client_id, SUM(TJT.total_charge) AS revenue
       FROM tbl_job_transaction TJT
       JOIN tbl_job TJ ON TJ.job_id = TJT.fk_job_id
      WHERE TJ.job_status IN (${a},${b})
        AND TJ.billing_checkout_date_time BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
        AND TJ.fk_client_id IN ${inFrag}
      GROUP BY TJ.fk_client_id
      LIMIT ${PER_QUERY_CAP}`;
  const [rows] = await pool.query(sql, params);
  const map = new Map();
  for (const r of rows) map.set(r.client_id, Number(r.revenue) || 0);
  return map;
}

/*
 * Per-period escalations = COUNT of jobs with an is_escalated=1 rating row, on
 * the ticket_created window. Mirrors legacy [G] (JobSecondRepository.java:490).
 * Plain COUNT (NO DISTINCT) — preserves rating-table fan-out verbatim.
 */
async function getPeriodEscalations({ clientIds, start, end }) {
  const params = [start, end];
  const inFrag = inClause(clientIds, params);
  const sql =
    `SELECT TJ.fk_client_id AS client_id, COUNT(TJ.job_id) AS escalated
       FROM tbl_job TJ
       LEFT JOIN tbl_easyfixer_rating_by_customer TERBC ON TERBC.job_id = TJ.job_id
      WHERE TERBC.is_escalated = 1
        AND TJ.ticket_created_date_time BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
        AND TJ.fk_client_id IN ${inFrag}
      GROUP BY TJ.fk_client_id
      LIMIT ${PER_QUERY_CAP}`;
  const [rows] = await pool.query(sql, params);
  const map = new Map();
  for (const r of rows) map.set(r.client_id, Number(r.escalated) || 0);
  return map;
}

/* ── DEAD CODE / legacy [H] (averageTat) — kept verbatim for the future
 * product decision to revive TAT. The legacy service had this commented out,
 * so averageTat is ALWAYS 0 today. DO NOT wire this in without product sign-off.
 *
 *   SELECT TJ.fk_client_id, SUM(DATEDIFF(TJ.app_checkout_date_time, TJ.ticket_created_date_time)) AS tat_days
 *     FROM tbl_job TJ
 *    WHERE TJ.app_checkout_date_time IS NOT NULL
 *      AND TJ.ticket_created_date_time BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
 *      AND TJ.fk_client_id IN (?)
 *    GROUP BY TJ.fk_client_id;
 *   // averageTat = round(tat_days / completed)   // when revived
 */

/*
 * Client name + Project Manager name resolution for the driver set. Replaces
 * the legacy per-client findById + getVerticalMappingListByClientIdAndUserType
 * loop ([I] / VerticalRepository.java:15-16). PM = tbl_vertical_mapping
 * user_type=1 mapped on the client's OWN vertical (tbl_client.vertical_id),
 * resolved to tbl_user.user_name. LEFT JOINs so a client with no vertical or
 * no user_type=1 SPOC still returns (blank PM) rather than crashing — the
 * blank-PM decision.
 */
async function getClientMeta(clientIds) {
  const params = [];
  const inFrag = inClause(clientIds, params);
  const sql =
    `SELECT TC.client_id, TC.client_name, TU.user_name AS project_manager
       FROM tbl_client TC
       LEFT JOIN tbl_vertical_mapping TVM
         ON TVM.client_id = TC.client_id AND TVM.vertical_id = TC.vertical_id AND TVM.user_type = 1
       LEFT JOIN tbl_user TU ON TU.user_id = TVM.user_id
      WHERE TC.client_id IN ${inFrag}`;
  const [rows] = await pool.query(sql, params);
  const map = new Map();
  for (const r of rows) {
    map.set(r.client_id, {
      clientName: r.client_name || '',
      projectManager: r.project_manager || '',
    });
  }
  return map;
}

function indexByClient(rows) {
  const map = new Map();
  for (const r of rows) map.set(r.client_id, r);
  return map;
}

// Legacy rounding: String.format("%.0f") → integer-valued. Math.round matches.
const r0 = (n) => Math.round(n);

/*
 * Public entrypoint. Returns the modern row shape consumed by the FE + the
 * xlsx exporter:
 *   [{ clientId, clientName, projectManager,
 *      periods: [{ label, week, month, startDate, endDate,
 *                  ticketCreated, enquiryPercentage,
 *                  cancellationAfterAllocation, averageTicketSize,
 *                  sumOfTotalCharge, averageTat, escalationPercentage }, x3] }]
 * Ordered most-recent period first within each client; rows in driver order
 * (client_id DESC), then PM name for the FE rowspan grouping (FE sorts).
 */
async function getClientPerformance({ period = 'monthly', filters = {} } = {}) {
  logger.info('Building Client Performance report · period=' + period);
  const periods = buildPeriods(period); // most-recent first, length 3
  const overallStart = periods[periods.length - 1].startDate; // oldest start
  const overallEnd = periods[0].endDate; // most-recent end

  const clientIds = await getClientDriverSet({ filters, overallStart, overallEnd });
  if (clientIds.length === 0) logger.info('No clients matched · returning 0 rows');
  if (clientIds.length === 0) return [];

  // One aggregate set per period (counts + revenue + escalations), plus the
  // single name/PM resolution. Periods are independent → fire in parallel.
  const perPeriod = await Promise.all(
    periods.map(async (p) => {
      const [counts, revenue, escalations] = await Promise.all([
        getPeriodCounts({ clientIds, start: p.startDate, end: p.endDate }),
        getPeriodRevenue({ clientIds, start: p.startDate, end: p.endDate }),
        getPeriodEscalations({ clientIds, start: p.startDate, end: p.endDate }),
      ]);
      return { p, counts, revenue, escalations };
    }),
  );
  const meta = await getClientMeta(clientIds);

  logger.info('Returning ' + clientIds.length + ' client performance rows · periods=' + periods.length);
  return clientIds.map((id) => {
    const m = meta.get(id) || { clientName: '', projectManager: '' };
    const buckets = perPeriod.map(({ p, counts, revenue, escalations }) => {
      const c = counts.get(id) || {};
      const ticketCreated = Number(c.ticket_created) || 0;
      const enquiry = Number(c.enquiry) || 0;
      const cancelPostAlloc = Number(c.cancel_post_alloc) || 0;
      const completed = Number(c.completed) || 0;
      const rev = revenue.get(id) || 0;
      const esc = escalations.get(id) || 0;

      // Derived fields — preserve legacy guards + rounding EXACTLY.
      const enquiryPercentage =
        ticketCreated > 0 && enquiry > 0 ? r0((enquiry / ticketCreated) * 100) : 0;
      const escalationPercentage =
        ticketCreated > 0 ? (esc > 0 ? r0((esc / ticketCreated) * 100) : 0) : 0;
      const cancellationAfterAllocation = ticketCreated > 0 ? cancelPostAlloc : 0;
      const sumOfTotalCharge = completed > 0 ? rev : 0;
      const averageTicketSize = completed > 0 ? r0(rev / completed) : 0;
      const averageTat = 0; // legacy parity — TAT block commented out. See [H].

      return {
        label: p.label,
        week: p.week,
        month: p.month,
        startDate: p.startDate,
        endDate: p.endDate,
        ticketCreated,
        enquiryPercentage,
        cancellationAfterAllocation,
        averageTicketSize,
        sumOfTotalCharge,
        averageTat,
        escalationPercentage,
      };
    });

    return {
      clientId: id,
      clientName: m.clientName,
      projectManager: m.projectManager,
      periods: buckets,
    };
  });
}

/*
 * Flatten the grouped rows into the xlsx column set (Copy-Data canonical
 * intent — the CORRECTED label/field alignment, not the legacy display bug).
 * Columns: Project Manager, Client, then per period (most-recent first):
 *   Tkt Received, Enq%, Canc Post Allocation, Avg Tkt Size, Revenue, TAT, ESC%
 * Period headers are prefixed with the period label so all 3 blocks are
 * distinguishable in the flat sheet.
 */
function toXlsx(rows, period) {
  const periodLabels =
    rows[0]?.periods.map((p) => p.label) ||
    buildPeriods(period).map((p) => p.label);

  const columns = [
    { key: 'projectManager', header: 'Project Manager', width: 26 },
    { key: 'clientName', header: 'Client', width: 28 },
  ];
  periodLabels.forEach((lbl, i) => {
    columns.push(
      { key: `p${i}_ticketCreated`, header: `${lbl} · Tkt Received`, width: 16 },
      { key: `p${i}_enquiryPercentage`, header: `${lbl} · Enq%`, width: 10 },
      { key: `p${i}_cancellationAfterAllocation`, header: `${lbl} · Canc Post Allocation`, width: 20 },
      { key: `p${i}_averageTicketSize`, header: `${lbl} · Avg Tkt Size`, width: 14 },
      { key: `p${i}_sumOfTotalCharge`, header: `${lbl} · Revenue`, width: 14 },
      { key: `p${i}_averageTat`, header: `${lbl} · TAT`, width: 10 },
      { key: `p${i}_escalationPercentage`, header: `${lbl} · ESC%`, width: 10 },
    );
  });

  const flatRows = rows.map((row) => {
    const out = { projectManager: row.projectManager, clientName: row.clientName };
    row.periods.forEach((p, i) => {
      out[`p${i}_ticketCreated`] = p.ticketCreated;
      out[`p${i}_enquiryPercentage`] = p.enquiryPercentage;
      out[`p${i}_cancellationAfterAllocation`] = p.cancellationAfterAllocation;
      out[`p${i}_averageTicketSize`] = p.averageTicketSize;
      out[`p${i}_sumOfTotalCharge`] = p.sumOfTotalCharge;
      out[`p${i}_averageTat`] = p.averageTat;
      out[`p${i}_escalationPercentage`] = p.escalationPercentage;
    });
    return out;
  });

  return { columns, rows: flatRows };
}

module.exports = { getClientPerformance, toXlsx };
