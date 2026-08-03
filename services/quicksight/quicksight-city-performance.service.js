/*
 * QuickSight — City Performance (monthly / weekly) service.
 *
 * Native rebuild of TWO legacy ACD_APIs endpoints that share the same DTO,
 * flag, and date-window helpers, so they MUST migrate together:
 *   1. POST /pmJobs/cityPerformance  → paginated per-city scorecard
 *      (controller PmWorkDetails.java:363-373,
 *       service  JobServiceImpl.java:4655-4834,
 *       repo     JobSecondRepository.java:475-633)
 *   2. POST /pmJobs/cityTatSummary   → the TAT-highlights doughnut widget
 *      (controller PmWorkDetails.java:396-402,
 *       service  JobServiceImpl.java:5188-5281,
 *       repo     JobSecondRepository.java:804-847)
 *
 * Each report row is a city. For each city we emit exactly 3 period buckets
 * (most-recent → oldest), each carrying:
 *   cityTktCreated · citySdaPercentage · cityTatPercentage · cityOpenOrders ·
 *   processJobs · citySdaCount · detailsFor (label) · startDate · endDate
 *
 * FAITHFUL-MIGRATION decisions applied (registry `decisions` block):
 *   - PRESERVE legacy plain COUNT / SUM (NO DISTINCT) for metric parity.
 *   - Admin sees ALL cities — no per-row scope filtering (legacy had none).
 *   - Blank-PM / blank-state rows are KEPT via LEFT JOIN (legacy did N+1
 *     findById().orElseThrow() — native folds state name into a LEFT JOIN so
 *     a city with no resolvable state still renders with a blank state name).
 *   - The legacy scalar IS-NULL sentinel is replaced with buildInFilter
 *     (omits the clause entirely when a filter list is empty — semantically
 *     identical to the legacy element[0] null-flag gate).
 *   - The +1-day inclusive upper bound is preserved exactly via
 *     DATE_ADD(?, INTERVAL 1 DAY) on the per-period predicates (legacy
 *     endDate_i.plusDays(1)); the DISPLAY start/end strip that +1 (DTO stored
 *     end.minusDays(1)) so the bucket startDate/endDate echo the raw window.
 *   - HALF_UP rounding to integer; SDA% null when progressJobs==0, TAT% null
 *     when completedOrder==0, calculatePercentage null when denom==0.
 *   - HIGH non-truncating safety LIMITs with logger.warn when the cap is hit.
 *   - Legacy typo column names kept verbatim (fk_easyfixter_id is NOT used
 *     here, but tbl_service_catg IS — the tat-summary joins it verbatim).
 *
 * ── SCHEMA BLOCKER — RESOLVED (see openQuestions[0]) ─────────────────────
 * The legacy SQL references `TCY.tier` in the TAT SLA CASE. The crosscut DB
 * reference (/tmp/qs/_crosscut.json) listed tbl_city columns but OMITTED
 * `tier`, which raised the question of whether the physical column exists.
 *
 * RESOLVED: tbl_city DOES physically have a `tier` column — the existing
 * production lookup `services/lookup.service.js::cities()` selects it directly
 * (`SELECT city_id, city_name, state_id, city_status, tier, district, …
 * FROM tbl_city`). The crosscut column list was simply incomplete. So we use
 * `TCY.tier` VERBATIM (matching the legacy SQL + the faithful-migration rule
 * to preserve column names exactly). No divergence — the BLOCKER was a stale
 * crosscut reference, not a real schema gap.
 *
 * Performance vs legacy: legacy ran getCityPerformanceDetails 3x PER CITY
 * (3*N round-trips) plus a findById(city)+findById(state) per city. This
 * rewrite collapses each period to ONE GROUP BY city query across the paged
 * city set, joined to tbl_state for the state name — identical metric
 * definitions, far fewer round-trips. House rule: every value bound via `?`.
 */

const { pool } = require('../../db');
const logger = require('../../logger');
const {
  buildInFilter,
  computeLastThreeWeeks,
  computeLastThreeMonths,
  JOB_STATUS,
  _dateHelpers,
} = require('./_shared');

// Add N calendar days to a 'YYYY-MM-DD' string (no TZ math). Used to apply
// the legacy outer-window inclusive upper bound (endDate.plusDays(1)).
function plusDaysIso(isoDate, n) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return _dateHelpers.fmt(_dateHelpers.addDays(new Date(Date.UTC(y, m - 1, d)), n));
}

// Safety caps — legacy had NONE. Deliberately high so they never truncate a
// real production run; if one IS hit we logger.warn (no silent row drop).
const CITY_PAGE_CAP = 200;     // matches the Joi pageSize.max — a single page
const GROUPED_CAP = 50000;     // grouped per-city rows across one period

/*
 * TAT SLA "on-time threshold (days)" matrix — service category × city tier.
 * Used IDENTICALLY by the table (endpoint 1) and the tat-summary (endpoint 2).
 *
 *   fk_service_catg_id IN (1,5,21,12): tier IN (1,2) → 3 days; tier=3 → 5
 *   fk_service_catg_id = 15:           tier=1 → 3; tier=2 → 5; tier=3 → 7
 *   ELSE → NULL, then COALESCE(...,3) → default 3 days
 *
 * On-time = FLOOR(TIMESTAMPDIFF(MINUTE, ticket_created, checkout)/1440.0)
 *           <= threshold, only for completed jobs (job_status IN (3,5)).
 *
 * `TCY.tier` is preserved VERBATIM from the legacy SQL (the physical column
 * exists — see the BLOCKER-RESOLVED note above). No user values are
 * interpolated here — pure trusted SQL fragment.
 */
const TAT_SLA_CASE =
  'COALESCE((' +
  ' CASE' +
  ' WHEN TJ.fk_service_catg_id IN (1, 5, 21, 12) AND TCY.tier IN (1, 2) THEN 3' +
  ' WHEN TJ.fk_service_catg_id IN (1, 5, 21, 12) AND TCY.tier = 3 THEN 5' +
  ' WHEN TJ.fk_service_catg_id = 15 AND TCY.tier = 1 THEN 3' +
  ' WHEN TJ.fk_service_catg_id = 15 AND TCY.tier = 2 THEN 5' +
  ' WHEN TJ.fk_service_catg_id = 15 AND TCY.tier = 3 THEN 7' +
  ' ELSE NULL END), 3)';

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
 * Build the 3 period windows + their display labels.
 *   weekly  → last 3 FULL Sun–Sat weeks (excludes current partial week).
 *   monthly → current partial month (1st..today) + 2 prior FULL months.
 * Both come back oldest→newest from _shared; the report renders
 * most-recent→oldest, so we reverse and attach a label:
 *   - weekly label  : "Week 1|2|3" (legacy "Week i", i=1 most recent)
 *   - monthly label : full month name (e.g. "JUNE") to match legacy enum name
 */
function buildPeriods(flag) {
  if (flag === 'weekly') {
    const weeks = computeLastThreeWeeks(); // oldest→newest
    return weeks
      .slice()
      .reverse() // most-recent first
      .map((w, idx) => ({
        label: `Week ${idx + 1}`,
        startDate: w.start,
        endDate: w.end,
      }));
  }
  // monthly (default / any non-'weekly' value, mirroring the legacy
  // else-branch: only "weekly" selects weekly, everything else → monthly).
  const months = computeLastThreeMonths(); // oldest→newest
  return months
    .slice()
    .reverse()
    .map((m) => ({
      label: monthName(m.start),
      startDate: m.start,
      endDate: m.end,
    }));
}

/*
 * Compose the shared dimension-filter WHERE fragment + push values.
 * Mirrors the legacy IS-NULL sentinel set, but via buildInFilter (omits the
 * clause entirely when a list is empty):
 *   clientId          → TJ.fk_client_id
 *   zonalManagerId    → TCY.state_user        (a city's zonal owner user_id)
 *   projectManagerId  → TJ.fk_created_by
 *   serviceCategoryId → TJ.fk_service_catg_id
 *   verticalId        → TC.vertical_id        (via tbl_client)
 *   stateId           → TCY.state_id
 *
 * `opts.withVertical` / `opts.withProjectManager` gate the two filters the
 * tat-summary endpoint deliberately IGNORES (legacy asymmetry — vertical &
 * PM affect the TABLE only, not the highlights widget).
 */
function buildFilterClause(filters, params, opts = {}) {
  let where = '';
  where += buildInFilter('TJ.fk_client_id', filters.clientId, params);
  where += buildInFilter('TCY.state_user', filters.zonalManagerId, params);
  where += buildInFilter('TJ.fk_service_catg_id', filters.serviceCategoryId, params);
  where += buildInFilter('TCY.state_id', filters.stateId, params);
  if (opts.withProjectManager) {
    where += buildInFilter('TJ.fk_created_by', filters.projectManagerId, params);
  }
  if (opts.withVertical) {
    where += buildInFilter('TC.vertical_id', filters.verticalId, params);
  }
  return where;
}

// Build an `IN (?,?,…)` clause + push the city ids; returns the fragment.
function inClause(ids, params) {
  const placeholders = ids.map(() => '?').join(',');
  for (const id of ids) params.push(id);
  return `(${placeholders})`;
}

// Legacy HALF_UP integer rounding (BigDecimal.setScale(0, HALF_UP)). For the
// non-negative ratios here, Math.round matches HALF_UP exactly.
const r0 = (n) => Math.round(n);

/*
 * calculatePercentage — legacy JobServiceImpl:5466-5473.
 *   denominator == 0 → null; else round(num/den*100, HALF_UP).
 */
function calculatePercentage(num, den) {
  if (!den || den === 0) return null;
  return r0((num / den) * 100);
}

/* ── ENDPOINT 1: City Performance (paginated table) ──────────────────── */

/*
 * (A) getCityList — pages the CITY dimension. DISTINCT city_id over the outer
 * window (period3 start .. period1 end +1 day inclusive), ORDER BY city_name
 * ASC, LIMIT/OFFSET on cities. Mirrors JobSecondRepository.java:510-544.
 * Requires TCY.city_id IS NOT NULL (excludes jobs with no resolvable city).
 */
async function getCityList({ filters, overallStart, overallEndInclusive, limit, offset }) {
  const params = [];
  let where =
    ' WHERE TJ.ticket_created_date_time >= ?' +
    ' AND TJ.ticket_created_date_time <= ?' +
    ' AND TCY.city_id IS NOT NULL';
  params.push(overallStart, overallEndInclusive);
  where += buildFilterClause(filters, params, { withVertical: true, withProjectManager: true });

  const sql =
    `SELECT DISTINCT TCY.city_id AS city_id, TCY.city_name AS city_name
       FROM tbl_job TJ
       LEFT JOIN tbl_address TA ON TA.address_id = TJ.fk_address_id
       LEFT JOIN tbl_city TCY ON TCY.city_id = TA.city_id
       LEFT JOIN tbl_client TC ON TC.client_id = TJ.fk_client_id
       ${where}
      ORDER BY TCY.city_name ASC
      LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const [rows] = await pool.query(sql, params);
  logger.info('Found ' + rows.length + ' cities for performance page');
  if (rows.length >= CITY_PAGE_CAP) {
    logger.warn(
      { report: 'city-performance', cap: CITY_PAGE_CAP, returned: rows.length },
      'City Performance city page hit the safety cap — page size may be truncated',
    );
  }
  return rows.map((r) => ({ cityId: r.city_id, cityName: r.city_name }));
}

/*
 * (C) getTotalCityCount — pagination total = COUNT(DISTINCT city_id) over the
 * outer window. Mirrors JobSecondRepository.java:605-633.
 */
async function getTotalCityCount({ filters, overallStart, overallEndInclusive }) {
  const params = [];
  let where =
    ' WHERE TJ.ticket_created_date_time >= ?' +
    ' AND TJ.ticket_created_date_time <= ?' +
    ' AND TCY.city_id IS NOT NULL';
  params.push(overallStart, overallEndInclusive);
  where += buildFilterClause(filters, params, { withVertical: true, withProjectManager: true });

  const sql =
    `SELECT COUNT(DISTINCT TCY.city_id) AS total
       FROM tbl_job TJ
       LEFT JOIN tbl_address TA ON TA.address_id = TJ.fk_address_id
       LEFT JOIN tbl_city TCY ON TCY.city_id = TA.city_id
       LEFT JOIN tbl_client TC ON TC.client_id = TJ.fk_client_id
       ${where}`;
  const [rows] = await pool.query(sql, params);
  return Number(rows[0]?.total) || 0;
}

/*
 * (B) getCityPerformanceDetails — per-city × per-period aggregate metrics for
 * ONE period, across the paged city set. Mirrors JobSecondRepository.java
 * 547-602 but set-based (GROUP BY city_id over the city IN-list) instead of
 * one query per city. Identical metric definitions:
 *   total_jobs      = COUNT(*) of all jobs in the window               [1]
 *   open_job_count  = job_status NOT IN (3,5,6,7)                       [2]
 *   progress_jobs   = job_status IN (2,20,10,15,21,3,5)  (sda denom)    [3]
 *   sda_count       = progress job AND DATE(checkin) <= DATE(orig appt) [4]
 *   tat_count       = completed (3,5) AND on-time via TAT_SLA_CASE      [5]
 *   completed_orders= job_status IN (3,5)                               [6]
 * The ticket_created window uses the +1-day inclusive upper bound exactly
 * (DATE_ADD(?, INTERVAL 1 DAY) — legacy endDate_i.plusDays(1)).
 *
 * Status buckets are spelled out verbatim (NOT cleaned up): the legacy
 * progress/sda-denom set IN (2,20,10,15,21,3,5) and open-exclusion NOT IN
 * (3,5,6,7) are reproduced literally. JOB_STATUS._shared constants are used
 * where they map cleanly (COMPLETED [3,5]); the bespoke 7-value progress set
 * has no _shared constant so it is inlined verbatim with a comment.
 */
async function getCityPeriodDetails({ filters, cityIds, start, endInclusive }) {
  if (cityIds.length === 0) return new Map();
  const params = [];
  // Per-period ticket_created window (inclusive +1 day on the upper bound).
  params.push(start, endInclusive);
  let where =
    ' WHERE TJ.ticket_created_date_time >= ?' +
    ' AND TJ.ticket_created_date_time <= DATE_ADD(?, INTERVAL 1 DAY)' +
    ' AND TCY.city_id IS NOT NULL';
  where += buildFilterClause(filters, params, { withVertical: true, withProjectManager: true });
  // City scope — only the cities on this page.
  where += ` AND TCY.city_id IN ${inClause(cityIds, params)}`;

  const [cA, cB] = JOB_STATUS.COMPLETED; // [3,5]
  // Legacy verbatim buckets — NOT _shared constants (the 7-value progress set
  // and the 4-value open-exclusion set are bespoke to this report).
  const OPEN_EXCLUSION = '3, 5, 6, 7';            // open = NOT IN these
  const PROGRESS_DENOM = '2, 20, 10, 15, 21, 3, 5'; // progress / sda denominator

  const sql =
    `SELECT TCY.city_id AS city_id,
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
       COUNT(CASE WHEN TJ.job_status IN (${cA}, ${cB}) THEN TJ.job_id END) AS completed_orders
       FROM tbl_job TJ
       LEFT JOIN tbl_address TA ON TA.address_id = TJ.fk_address_id
       LEFT JOIN tbl_city TCY ON TCY.city_id = TA.city_id
       LEFT JOIN tbl_client TC ON TC.client_id = TJ.fk_client_id
       ${where}
      GROUP BY TCY.city_id
      LIMIT ${GROUPED_CAP}`;

  const [rows] = await pool.query(sql, params);
  if (rows.length >= GROUPED_CAP) {
    logger.warn(
      { report: 'city-performance', cap: GROUPED_CAP, returned: rows.length },
      'City Performance period aggregate hit the grouped safety cap — results may be incomplete',
    );
  }
  const map = new Map();
  for (const r of rows) map.set(r.city_id, r);
  return map;
}

/*
 * Resolve cityName + stateId + stateName for the paged city set in ONE query.
 * Replaces the legacy per-city findById(city) + findById(state).orElseThrow()
 * N+1 loop. LEFT JOIN tbl_state so a city with an unresolvable state still
 * returns (blank state name) — the blank-row decision (legacy crashed).
 */
async function getCityMeta(cityIds) {
  if (cityIds.length === 0) return new Map();
  const params = [];
  const inFrag = inClause(cityIds, params);
  const sql =
    `SELECT TCY.city_id AS city_id, TCY.city_name AS city_name,
            TCY.state_id AS state_id, TS.state_name AS state_name
       FROM tbl_city TCY
       LEFT JOIN tbl_state TS ON TS.state_id = TCY.state_id
      WHERE TCY.city_id IN ${inFrag}`;
  const [rows] = await pool.query(sql, params);
  const map = new Map();
  for (const r of rows) {
    map.set(r.city_id, {
      cityName: r.city_name || '',
      stateId: r.state_id ?? null,
      stateName: r.state_name || '',
    });
  }
  return map;
}

/*
 * Build one zeroed period bucket (used for both the synthetic "No city" row
 * and any city that has no jobs in a given period). Preserves the legacy
 * null-percentage semantics (citySdaPercentage / cityTatPercentage = null).
 */
function zeroBucket(period) {
  return {
    detailsFor: period.label,
    startDate: period.startDate,
    endDate: period.endDate,
    cityTktCreated: 0,
    cityOpenOrders: 0,
    processJobs: 0,
    citySdaCount: 0,
    citySdaPercentage: null,
    cityTatPercentage: null,
  };
}

/*
 * Public entrypoint #1 — the paginated per-city scorecard.
 *
 * Returns the modern paginated shape consumed by the FE + the xlsx exporter:
 *   { data: CityPerformanceDto[], page, pageSize, totalRecords, totalPages }
 * CityPerformanceDto = { cityId, cityName, stateId, stateName,
 *                        cityPerformanceDataDateWise: bucket[3] }  (most-recent first)
 *
 * Empty city list → ONE synthetic row { cityId:null, cityName:'No city',
 * stateId:null, stateName:'No state', 3 zeroed periods } (legacy 4699-4729).
 */
async function getCityPerformance({ flag = 'monthly', page = 1, pageSize = 10, filters = {} } = {}) {
  logger.info('City performance scorecard · flag=' + flag + ' page=' + page + ' pageSize=' + pageSize);
  const periods = buildPeriods(flag); // most-recent first, length 3
  const overallStart = periods[periods.length - 1].startDate; // oldest period start
  // Outer-window upper bound: legacy passes endDate.plusDays(1) as the value
  // and the SQL uses `<= :endDate` (effectively inclusive of the whole end
  // day). We pre-shift the value here so the helpers keep a plain `<= ?`
  // (legacy 4684-4685).
  const overallEndInclusive = plusDaysIso(periods[0].endDate, 1);
  const offset = (page - 1) * pageSize;

  const [cities, totalRecords] = await Promise.all([
    getCityList({ filters, overallStart, overallEndInclusive, limit: pageSize, offset }),
    getTotalCityCount({ filters, overallStart, overallEndInclusive }),
  ]);

  // Empty → synthetic "No city / No state" row with 3 zeroed periods.
  if (cities.length === 0) {
    logger.info('No cities in window · returning synthetic No-city row (totalRecords=0)');
    const syntheticPeriods = periods.map((p) => zeroBucket(p));
    return {
      data: [
        {
          cityId: null,
          cityName: 'No city',
          stateId: null,
          stateName: 'No state',
          cityPerformanceDataDateWise: syntheticPeriods,
        },
      ],
      page,
      pageSize,
      totalRecords: 0,
      totalPages: 0,
    };
  }

  const cityIds = cities.map((c) => c.cityId);

  // One aggregate per period (independent → parallel) + the meta resolution.
  const perPeriod = await Promise.all(
    periods.map(async (p) => ({
      p,
      details: await getCityPeriodDetails({
        filters,
        cityIds,
        start: p.startDate,
        endInclusive: p.endDate, // SQL applies DATE_ADD(?, INTERVAL 1 DAY)
      }),
    })),
  );
  const meta = await getCityMeta(cityIds);

  const data = cities.map((city) => {
    const id = city.cityId;
    const m = meta.get(id) || { cityName: city.cityName || '', stateId: null, stateName: '' };

    const buckets = perPeriod.map(({ p, details }) => {
      const d = details.get(id);
      if (!d) {
        // cityData empty branch (legacy 4766-4770): only TktCreated /
        // OpenOrders / SDA% are zeroed/null there. Preserve: a fully zeroed
        // bucket is the superset and matches the empty-city numbers.
        return zeroBucket(p);
      }
      const totalJobs = Number(d.total_jobs) || 0;
      const openJobs = Number(d.open_job_count) || 0;
      const progressJobs = Number(d.progress_jobs) || 0;
      const sdaCount = Number(d.sda_count) || 0;
      const tatCount = Number(d.tat_count) || 0;
      const completedOrder = Number(d.completed_orders) || 0;

      const citySdaPercentage = progressJobs > 0 ? r0((sdaCount / progressJobs) * 100) : null;
      const cityTatPercentage = completedOrder > 0 ? r0((tatCount / completedOrder) * 100) : null;

      return {
        detailsFor: p.label,
        startDate: p.startDate,
        endDate: p.endDate,
        cityTktCreated: totalJobs,
        cityOpenOrders: openJobs,
        processJobs: progressJobs,
        citySdaCount: sdaCount,
        citySdaPercentage,
        cityTatPercentage,
      };
    });

    return {
      cityId: id,
      cityName: m.cityName || city.cityName || '',
      stateId: m.stateId,
      stateName: m.stateName || '',
      cityPerformanceDataDateWise: buckets,
    };
  });

  const totalPages = pageSize > 0 ? Math.ceil(totalRecords / pageSize) : 0;
  logger.info('Returning ' + data.length + ' city rows · totalRecords=' + totalRecords);
  return { data, page, pageSize, totalRecords, totalPages };
}

/* ── ENDPOINT 2: City TAT Summary (highlights widget) ────────────────── */

/*
 * getCityTatSummaryPeriod — one GROUP BY city row per period. Mirrors
 * JobSecondRepository.java:804-847. Per the legacy asymmetry this endpoint
 * IGNORES verticalId and projectManagerId (vertical commented out in repo).
 *   COUNT(job_id)   = total tickets in the window (unused downstream)
 *   failed_order    = job_status IN (6,7)
 *   tat_count       = completed (3,5) AND on-time via TAT_SLA_CASE
 *   completed_order = job_status IN (3,5)
 * GROUP BY city_id, DISTINCT city_id. NOTE: NO `TCY.city_id IS NOT NULL`
 * guard here (legacy divergence from endpoint 1 — jobs with an unresolved
 * city group under a NULL city_id). Preserved verbatim.
 */
async function getCityTatSummaryPeriod({ filters, start, endInclusive }) {
  const params = [];
  let where =
    ' WHERE TJ.ticket_created_date_time >= ?' +
    ' AND TJ.ticket_created_date_time <= DATE_ADD(?, INTERVAL 1 DAY)';
  params.push(start, endInclusive);
  // Only client / zonal / category / state — NO vertical, NO project manager.
  where += buildFilterClause(filters, params, { withVertical: false, withProjectManager: false });

  const [cA, cB] = JOB_STATUS.COMPLETED; // [3,5]

  const sql =
    `SELECT DISTINCT(TCY.city_id) AS city_id, TCY.city_name AS city_name,
       COUNT(TJ.job_id) AS job_count,
       SUM(CASE WHEN TJ.job_status IN (6, 7) THEN 1 ELSE 0 END) AS failed_order,
       SUM(CASE WHEN TJ.job_status IN (${cA}, ${cB})
                 AND FLOOR(TIMESTAMPDIFF(MINUTE, TJ.ticket_created_date_time, TJ.checkout_date_time) / 1440.0) <= ${TAT_SLA_CASE}
                THEN 1 ELSE 0 END) AS tat_count,
       SUM(CASE WHEN TJ.job_status IN (${cA}, ${cB}) THEN 1 ELSE 0 END) AS completed_order
       FROM tbl_job TJ
       LEFT JOIN tbl_address TA ON TA.address_id = TJ.fk_address_id
       LEFT JOIN tbl_city TCY ON TCY.city_id = TA.city_id
       LEFT JOIN tbl_service_catg TSC ON TSC.service_catg_id = TJ.fk_service_catg_id
       ${where}
      GROUP BY TCY.city_id
      LIMIT ${GROUPED_CAP}`;

  const [rows] = await pool.query(sql, params);
  if (rows.length >= GROUPED_CAP) {
    logger.warn(
      { report: 'city-tat-summary', cap: GROUPED_CAP, returned: rows.length },
      'City TAT summary aggregate hit the grouped safety cap — results may be incomplete',
    );
  }
  return rows;
}

/*
 * Public entrypoint #2 — the 3-period TAT highlights widget.
 *
 * Returns { periodSummaries: CityTatSummaryDto[3] } (most-recent first).
 * CityTatSummaryDto = { summaryOf, startDate, endDate, tatMoreThan85,
 *   tatLessThan85, tatMoreThan85Percentage, tatLessThan85Percentage,
 *   failedOrders, failedOrderPercentage }.
 *
 * Per-period logic (legacy 5210-5278):
 *   - CityCountInMonth = #city rows; if a city has completedOrder==0 →
 *     CityCountInMonth-- (exclude no-completed cities from the denominator).
 *   - For cities with completedOrder>0: tat% = calculatePercentage(tat,
 *     completed); >=85 → tatMoreThan85++, else tatLessThan85++.
 *   - tatMoreThan85Percentage = calculatePercentage(tatMoreThan85, CityCountInMonth).
 *   - failedOrders = the LAST grouped city's failed_order (overwritten each
 *     iteration — legacy 5253). PRESERVED VERBATIM (almost certainly a bug;
 *     flagged in the report — the correct value is SUM(failed) across cities).
 *   - failedOrderPercentage = 0 (legacy never populates it meaningfully).
 */
async function getCityTatSummary({ flag = 'monthly', filters = {} } = {}) {
  logger.info('City TAT summary widget · flag=' + flag);
  const periods = buildPeriods(flag); // most-recent first, length 3

  const periodSummaries = await Promise.all(
    periods.map(async (p) => {
      const rows = await getCityTatSummaryPeriod({
        filters,
        start: p.startDate,
        endInclusive: p.endDate,
      });

      let cityCountInMonth = rows.length;
      let tatMoreThan85 = 0;
      let tatLessThan85 = 0;
      let failedOrders = 0; // ends as the LAST grouped city's failed_order (legacy bug, preserved)

      for (const row of rows) {
        const completedOrder = Number(row.completed_order) || 0;
        const tatCount = Number(row.tat_count) || 0;
        failedOrders = Number(row.failed_order) || 0; // overwritten each iter — verbatim 5253

        if (completedOrder > 0) {
          const tatPercentage = calculatePercentage(tatCount, completedOrder);
          if (tatPercentage !== null && tatPercentage >= 85) tatMoreThan85 += 1;
          else tatLessThan85 += 1;
        } else {
          // exclude cities with no completed orders from the denominator
          cityCountInMonth -= 1;
        }
      }

      return {
        summaryOf: p.label,
        startDate: p.startDate,
        endDate: p.endDate,
        tatMoreThan85,
        tatLessThan85,
        tatMoreThan85Percentage: calculatePercentage(tatMoreThan85, cityCountInMonth),
        tatLessThan85Percentage: calculatePercentage(tatLessThan85, cityCountInMonth),
        failedOrders,
        failedOrderPercentage: 0, // legacy: never populated meaningfully
      };
    }),
  );

  logger.info('Returning ' + periodSummaries.length + ' TAT period summaries');
  return { periodSummaries };
}

/* ── XLSX flattening ─────────────────────────────────────────────────── */

/*
 * Flatten the paginated city rows into the xlsx column set.
 *
 * Columns: State, City, then per period (most-recent first):
 *   Ticket Created, SDA%, TAT%, Open Orders
 *
 * DECISION: column order is ALIGNED TO THE ON-SCREEN order
 * (Tkt Created, SDA%, TAT%, Open Orders) — NOT the legacy "Copy Data" order
 * (Tkt, Open, SDA, TAT). The legacy export/screen mismatch was a display bug;
 * per the registry headerAlignment decision we ship the CORRECTED alignment.
 * (Flagged in the report as an intentional fix.)
 *
 * null percentages render as '-' (matching the on-screen empty cell).
 */
function toXlsx(payload, flag) {
  const rows = (payload && payload.data) || [];
  const periodLabels =
    rows[0]?.cityPerformanceDataDateWise.map((p) => p.detailsFor) ||
    buildPeriods(flag).map((p) => p.label);

  const columns = [
    { key: 'stateName', header: 'State', width: 22 },
    { key: 'cityName', header: 'City', width: 22 },
  ];
  periodLabels.forEach((lbl, i) => {
    columns.push(
      { key: `p${i}_tkt`, header: `${lbl} · Ticket Created`, width: 16 },
      { key: `p${i}_sda`, header: `${lbl} · SDA%`, width: 10 },
      { key: `p${i}_tat`, header: `${lbl} · TAT%`, width: 10 },
      { key: `p${i}_open`, header: `${lbl} · Open Orders`, width: 14 },
    );
  });

  const pct = (v) => (v == null ? '-' : `${v}%`);
  const flatRows = rows.map((row) => {
    const out = { stateName: row.stateName, cityName: row.cityName };
    row.cityPerformanceDataDateWise.forEach((p, i) => {
      out[`p${i}_tkt`] = p.cityTktCreated;
      out[`p${i}_sda`] = pct(p.citySdaPercentage);
      out[`p${i}_tat`] = pct(p.cityTatPercentage);
      out[`p${i}_open`] = p.cityOpenOrders;
    });
    return out;
  });

  return { columns, rows: flatRows };
}

module.exports = {
  getCityPerformance, getCityTatSummary, toXlsx,
  /*
   * Internals shared with quicksight-region-performance.service.js (the State +
   * User scorecards), which are the SAME metrics over a different GROUP BY
   * dimension. Exported rather than copied so the period windows, the legacy
   * filter clause, the TAT SLA CASE and the rounding rules have exactly ONE
   * definition — a parity fix here lands in all three reports.
   *
   * Nothing ABOVE this line changed when the new dimensions were added: this
   * file is a faithful migration of two legacy endpoints with documented parity
   * decisions and no test coverage, so it stays byte-identical by design.
   */
  _internals: {
    buildPeriods, plusDaysIso, buildFilterClause, inClause, r0,
    TAT_SLA_CASE, GROUPED_CAP, CITY_PAGE_CAP,
  },
};
