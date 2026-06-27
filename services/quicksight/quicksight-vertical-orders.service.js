/*
 * QuickSight — Vertical Orders report service.
 *
 *   registry slug : vertical
 *   urlBase       : vertical-orders
 *   legacy source : ACD_APIs JobServiceImpl.getVerticalOpenOrdersList (3891-3988)
 *                   + JobRepository.java native queries (363-501)
 *
 * Faithful native rebuild of the single legacy endpoint
 *   GET /pmJobs/openVerticalOrders?flag=<csv>
 * which powers the 4-toggle "Vertical-Wise Job Count Analysis" page.
 *
 * Parity rules honoured (registry decisions):
 *   - PRESERVE legacy plain COUNT (no DISTINCT) for fan-out.
 *   - admin sees ALL — NO req.scope row-filtering (legacy was global).
 *   - blank verticals: LEFT JOIN tbl_client so jobs with a NULL/absent
 *     client still bucket as 'OEM' (the legacy CASE ... ELSE 'OEM').
 *   - JOB_STATUS gotchas preserved verbatim (status 20 paired with 2 for
 *     "Waiting to Close on App", status 10 for "Under Audit").
 *   - +1-day inclusive upper bound (CURDATE() + INTERVAL 1 DAY) kept.
 *   - vertical bucketing hardcoded TC.vertical_id = 4 -> 'Retail' else 'OEM'
 *     (NOT from tbl_vertical.vertical_name) — legacy behaviour.
 *   - escalatedOrderPercentage computed in JS exactly like the Java code
 *     (0 unless open > 0, then Math.round((escalated / open) * 100)).
 *   - multi-flag selection SUMS buckets across flags.
 *   - HIGH non-truncating safety LIMIT on each grouped query (legacy had
 *     none); logger.warn if the cap is ever hit. The grouped queries emit
 *     at most 2 verticals x 4 age-cats = 8 rows in practice, so the cap is
 *     a pure guard, never a real truncation.
 *
 * All SQL is parameterised; the flag queries take NO user-bound params
 * (every WHERE literal is a constant), but we still run them through
 * pool.query with an explicit empty params array for consistency.
 */

const { pool } = require('../../db');
const logger = require('../../logger');

// Canonical output shape — always 2 verticals x 4 age-categories = 8 rows.
const VERTICALS = ['Retail', 'OEM'];
const AGE_CATEGORIES = ['Today', 'Yesterday', 'TwoToSeven', 'MoreThanSeven'];

// The 4 valid toggle flags (case-insensitive at the router/validator layer).
const FLAGS = ['waitingtx', 'runninglate', 'openonapp', 'underaudit'];

/*
 * Safety cap for the grouped flag queries. The GROUP BY can only emit
 * 2 verticals x 4 age-cats = 8 rows, so 5000 is a pure guard against an
 * unexpected schema change ever fanning the grouping out. A hit is logged,
 * never silently swallowed.
 */
const GROUPED_ROW_CAP = 5000;

/*
 * Per-flag grouped count queries — ported VERBATIM from
 * JobRepository.java:363-487. Each returns rows:
 *   { job_count, job_age_category, vertical_category }
 *
 * Differences vs. the Java strings are ONLY the trailing safety LIMIT and
 * whitespace; every predicate, CASE bucket, GROUP BY and ORDER BY FIELD()
 * is byte-identical so the live numbers match the legacy report.
 */
const FLAG_SQL = {
  // waitingtx — Technician Unallocated (JobRepository.java:363-393)
  waitingtx: `
    SELECT COUNT(TJ.job_id) AS job_count,
      CASE
        WHEN DATEDIFF(CURDATE(), TJ.original_appointment_date_time) = 0 THEN 'Today'
        WHEN DATEDIFF(CURDATE(), TJ.original_appointment_date_time) = 1 THEN 'Yesterday'
        WHEN DATEDIFF(CURDATE(), TJ.original_appointment_date_time) BETWEEN 2 AND 7 THEN 'TwoToSeven'
        WHEN DATEDIFF(CURDATE(), TJ.original_appointment_date_time) > 7 THEN 'MoreThanSeven'
      END AS job_age_category,
      CASE
        WHEN TC.vertical_id = 4 THEN 'Retail'
        ELSE 'OEM'
      END AS vertical_category
    FROM tbl_job TJ
    LEFT JOIN tbl_client TC ON TJ.fk_client_id = TC.client_id
    WHERE TJ.job_status IN (0)
      AND TJ.fk_easyfixter_id IS NULL
      AND TJ.original_appointment_date_time < CURDATE() + INTERVAL 1 DAY
    GROUP BY
      CASE
        WHEN DATEDIFF(CURDATE(), TJ.original_appointment_date_time) = 0 THEN 'Today'
        WHEN DATEDIFF(CURDATE(), TJ.original_appointment_date_time) = 1 THEN 'Yesterday'
        WHEN DATEDIFF(CURDATE(), TJ.original_appointment_date_time) BETWEEN 2 AND 7 THEN 'TwoToSeven'
        WHEN DATEDIFF(CURDATE(), TJ.original_appointment_date_time) > 7 THEN 'MoreThanSeven'
      END,
      CASE
        WHEN TC.vertical_id = 4 THEN 'Retail'
        ELSE 'OEM'
      END
    ORDER BY FIELD(job_age_category, 'Today', 'Yesterday', 'TwoToSeven', 'MoreThanSeven'),
             FIELD(vertical_category, 'Retail', 'OEM')
    LIMIT ${GROUPED_ROW_CAP}`,

  // runninglate — Running Late (JobRepository.java:395-425)
  runninglate: `
    SELECT COUNT(TJ.job_id) AS job_count,
      CASE
        WHEN DATEDIFF(CURDATE(), TJ.requested_date_time) = 0 THEN 'Today'
        WHEN DATEDIFF(CURDATE(), TJ.requested_date_time) = 1 THEN 'Yesterday'
        WHEN DATEDIFF(CURDATE(), TJ.requested_date_time) BETWEEN 2 AND 7 THEN 'TwoToSeven'
        WHEN DATEDIFF(CURDATE(), TJ.requested_date_time) > 7 THEN 'MoreThanSeven'
      END AS job_age_category,
      CASE
        WHEN TC.vertical_id = 4 THEN 'Retail'
        ELSE 'OEM'
      END AS vertical_category
    FROM tbl_job TJ
    LEFT JOIN tbl_client TC ON (TJ.fk_client_id = TC.client_id)
    WHERE TJ.job_status IN (0, 1)
      AND TJ.fk_easyfixter_id IS NOT NULL
      AND TJ.requested_date_time < CURDATE() + INTERVAL 1 DAY
    GROUP BY
      CASE
        WHEN DATEDIFF(CURDATE(), TJ.requested_date_time) = 0 THEN 'Today'
        WHEN DATEDIFF(CURDATE(), TJ.requested_date_time) = 1 THEN 'Yesterday'
        WHEN DATEDIFF(CURDATE(), TJ.requested_date_time) BETWEEN 2 AND 7 THEN 'TwoToSeven'
        WHEN DATEDIFF(CURDATE(), TJ.requested_date_time) > 7 THEN 'MoreThanSeven'
      END,
      CASE
        WHEN TC.vertical_id = 4 THEN 'Retail'
        ELSE 'OEM'
      END
    ORDER BY FIELD(job_age_category, 'Today', 'Yesterday', 'TwoToSeven', 'MoreThanSeven'),
             FIELD(vertical_category, 'Retail', 'OEM')
    LIMIT ${GROUPED_ROW_CAP}`,

  // openonapp — Waiting to Close on App (JobRepository.java:427-457)
  openonapp: `
    SELECT COUNT(TJ.job_id) AS job_count,
      CASE
        WHEN DATEDIFF(CURDATE(), TJ.requested_date_time) = 0 THEN 'Today'
        WHEN DATEDIFF(CURDATE(), TJ.requested_date_time) = 1 THEN 'Yesterday'
        WHEN DATEDIFF(CURDATE(), TJ.requested_date_time) BETWEEN 2 AND 7 THEN 'TwoToSeven'
        WHEN DATEDIFF(CURDATE(), TJ.requested_date_time) > 7 THEN 'MoreThanSeven'
      END AS job_age_category,
      CASE
        WHEN TC.vertical_id = 4 THEN 'Retail'
        ELSE 'OEM'
      END AS vertical_category
    FROM tbl_job TJ
    LEFT JOIN tbl_client TC ON (TJ.fk_client_id = TC.client_id)
    WHERE TJ.job_status IN (2, 20)
      AND TJ.requested_date_time < CURDATE() + INTERVAL 1 DAY
      AND TIMESTAMPDIFF(HOUR, TJ.checkin_date_time, NOW()) > 12
    GROUP BY
      CASE
        WHEN DATEDIFF(CURDATE(), TJ.requested_date_time) = 0 THEN 'Today'
        WHEN DATEDIFF(CURDATE(), TJ.requested_date_time) = 1 THEN 'Yesterday'
        WHEN DATEDIFF(CURDATE(), TJ.requested_date_time) BETWEEN 2 AND 7 THEN 'TwoToSeven'
        WHEN DATEDIFF(CURDATE(), TJ.requested_date_time) > 7 THEN 'MoreThanSeven'
      END,
      CASE
        WHEN TC.vertical_id = 4 THEN 'Retail'
        ELSE 'OEM'
      END
    ORDER BY FIELD(job_age_category, 'Today', 'Yesterday', 'TwoToSeven', 'MoreThanSeven'),
             FIELD(vertical_category, 'Retail', 'OEM')
    LIMIT ${GROUPED_ROW_CAP}`,

  // underaudit — Under Audit (JobRepository.java:459-487). NO date-window guard.
  underaudit: `
    SELECT COUNT(TJ.job_id) AS job_count,
      CASE
        WHEN DATEDIFF(CURDATE(), TJ.app_checkout_date_time) = 0 THEN 'Today'
        WHEN DATEDIFF(CURDATE(), TJ.app_checkout_date_time) = 1 THEN 'Yesterday'
        WHEN DATEDIFF(CURDATE(), TJ.app_checkout_date_time) BETWEEN 2 AND 7 THEN 'TwoToSeven'
        WHEN DATEDIFF(CURDATE(), TJ.app_checkout_date_time) > 7 THEN 'MoreThanSeven'
      END AS job_age_category,
      CASE
        WHEN TC.vertical_id = 4 THEN 'Retail'
        ELSE 'OEM'
      END AS vertical_category
    FROM tbl_job TJ
    LEFT JOIN tbl_client TC ON TJ.fk_client_id = TC.client_id
    WHERE TJ.job_status IN (10)
    GROUP BY
      CASE
        WHEN DATEDIFF(CURDATE(), TJ.app_checkout_date_time) = 0 THEN 'Today'
        WHEN DATEDIFF(CURDATE(), TJ.app_checkout_date_time) = 1 THEN 'Yesterday'
        WHEN DATEDIFF(CURDATE(), TJ.app_checkout_date_time) BETWEEN 2 AND 7 THEN 'TwoToSeven'
        WHEN DATEDIFF(CURDATE(), TJ.app_checkout_date_time) > 7 THEN 'MoreThanSeven'
      END,
      CASE
        WHEN TC.vertical_id = 4 THEN 'Retail'
        ELSE 'OEM'
      END
    ORDER BY FIELD(job_age_category, 'Today', 'Yesterday', 'TwoToSeven', 'MoreThanSeven'),
             FIELD(vertical_category, 'Retail', 'OEM')
    LIMIT ${GROUPED_ROW_CAP}`,
};

// ── KPI count queries (JobRepository.java:489-501), ported verbatim ──
//
// is_escalated is BIT(1); db.js typeCast coerces BIT(1) -> boolean in JS,
// but the `= 1` comparison happens in SQL where MySQL accepts it directly,
// so no Buffer handling is needed.
const KPI_ESCALATED_SQL = `
  SELECT COUNT(TJ.job_id) AS cnt
  FROM tbl_job TJ
  LEFT JOIN tbl_easyfixer_rating_by_customer TERC ON (TERC.job_id = TJ.job_id)
  WHERE TJ.job_status NOT IN (3, 5, 6, 7)
    AND TERC.is_escalated = 1`;

const KPI_UNCONFIRMED_SQL = `
  SELECT COUNT(TJ.job_id) AS cnt
  FROM tbl_job TJ
  WHERE TJ.job_status IN (9)`;

const KPI_OPEN_SQL = `
  SELECT COUNT(TJ.job_id) AS cnt
  FROM tbl_job TJ
  WHERE TJ.job_status NOT IN (3, 5, 6, 7)`;

/*
 * getVerticalOpenOrders(flags)
 *
 * flags — a normalised, lowercased array of valid flag tokens (the router's
 * Joi schema rejects empty / unknown values before we get here, mirroring
 * the legacy IllegalArgumentException guards).
 *
 * Returns the VerticalOpenOrdersResponse-shaped object:
 *   {
 *     openOrderByGroup: OpenVerticalOrderDTO[]  (ALWAYS 8 rows),
 *     countOfEscalatedOrders, countOfUnconfirmedOrders, countOfOpenOrders,
 *     escalatedOrderPercentage,
 *   }
 *
 * Field names match the legacy DTO 1:1 so the FE can pivot identically.
 */
async function getVerticalOpenOrders(flags) {
  logger.info('Vertical Orders · flags=' + (Array.isArray(flags) ? flags.join(',') : flags));
  // jobCountsMap[vertical][age] = summed count; verticalSums / ageCategorySums
  // are the per-vertical and per-age-column grand totals (replicates the Java
  // merge() accumulation across multiple selected flags).
  const jobCountsMap = {};
  const verticalSums = {};
  const ageCategorySums = {};

  for (const flag of flags) {
    const sql = FLAG_SQL[flag];
    // Defensive: router validation guarantees a known flag, but never run an
    // undefined query.
    if (!sql) continue;

    const [rows] = await pool.query(sql, []);
    if (rows.length >= GROUPED_ROW_CAP) {
      logger.warn(
        { report: 'quicksight-vertical-orders', flag, rowCount: rows.length, cap: GROUPED_ROW_CAP },
        'QuickSight Vertical Orders grouped query hit the safety LIMIT — counts may be incomplete',
      );
    }

    for (const r of rows) {
      const vertical = r.vertical_category;
      const age = r.job_age_category;
      // job_count comes back as a JS number (COUNT) or string depending on
      // driver; coerce to Number for safe arithmetic.
      const count = Number(r.job_count) || 0;
      // Guard against an unexpected NULL bucket (a NULL date would yield a
      // NULL age via the CASE with no ELSE) — skip it rather than crash, same
      // net effect as the legacy map which only keyed on present categories.
      if (vertical == null || age == null) continue;

      if (!jobCountsMap[vertical]) jobCountsMap[vertical] = {};
      jobCountsMap[vertical][age] = (jobCountsMap[vertical][age] || 0) + count;
      verticalSums[vertical] = (verticalSums[vertical] || 0) + count;
      ageCategorySums[age] = (ageCategorySums[age] || 0) + count;
    }
  }

  // Normalise to the fixed 2x4 grid — force both verticals and all 4 age
  // categories to exist, defaulting missing cells to 0 (Java lines 3963-3978).
  const openOrderByGroup = [];
  for (const vertical of VERTICALS) {
    for (const age of AGE_CATEGORIES) {
      openOrderByGroup.push({
        jobCount: (jobCountsMap[vertical] && jobCountsMap[vertical][age]) || 0,
        jobAgeCategory: age,
        verticalCategory: vertical,
        totalCount: verticalSums[vertical] || 0,
        ageCategoryTotalCount: ageCategorySums[age] || 0,
      });
    }
  }

  // KPIs run unconditionally (legacy ran all 3 regardless of flags).
  const [
    [escalatedRows],
    [unconfirmedRows],
    [openRows],
  ] = await Promise.all([
    pool.query(KPI_ESCALATED_SQL, []),
    pool.query(KPI_UNCONFIRMED_SQL, []),
    pool.query(KPI_OPEN_SQL, []),
  ]);

  const countOfEscalatedOrders = Number(escalatedRows[0].cnt) || 0;
  const countOfUnconfirmedOrders = Number(unconfirmedRows[0].cnt) || 0;
  const countOfOpenOrders = Number(openRows[0].cnt) || 0;

  // escalatedOrderPercentage — 0 unless open > 0 (avoids divide-by-zero),
  // then Math.round((escalated / open) * 100) (Java lines 3907-3910).
  const escalatedOrderPercentage = countOfOpenOrders > 0
    ? Math.round((countOfEscalatedOrders / countOfOpenOrders) * 100)
    : 0;

  logger.info('Returning ' + openOrderByGroup.length + ' vertical/age cells · openOrders=' + countOfOpenOrders + ' escalated=' + countOfEscalatedOrders + ' unconfirmed=' + countOfUnconfirmedOrders);
  return {
    openOrderByGroup,
    countOfEscalatedOrders,
    countOfUnconfirmedOrders,
    countOfOpenOrders,
    escalatedOrderPercentage,
  };
}

/*
 * buildExportRows(openOrderByGroup)
 *
 * Reshapes the 8 cell-rows into the legacy on-screen pivot for the xlsx
 * export: one row per vertical with the 4 age columns + the per-vertical
 * Total Count, plus a synthetic 'Total' row summing each age column across
 * verticals (replicates the Angular client-side reshape, vertical.component.ts
 * 104-137). The 'Total' row leaves Total Count blank — legacy parity.
 *
 * Excel export is an ENHANCEMENT (legacy had none) but supported here per
 * the registry `exporter` decision that every endpoint exposes ?format=xlsx.
 */
function buildExportRows(openOrderByGroup) {
  // Pivot cells -> { vertical: { age: count, total } }.
  const byVertical = {};
  for (const cell of openOrderByGroup) {
    const v = cell.verticalCategory;
    if (!byVertical[v]) byVertical[v] = { TotalCount: cell.totalCount };
    byVertical[v][cell.jobAgeCategory] = cell.jobCount;
  }

  const rows = [];
  const colTotals = { Today: 0, Yesterday: 0, TwoToSeven: 0, MoreThanSeven: 0 };

  for (const vertical of VERTICALS) {
    const v = byVertical[vertical] || {};
    const row = {
      verticalCategory: vertical,
      Today: v.Today || 0,
      Yesterday: v.Yesterday || 0,
      TwoToSeven: v.TwoToSeven || 0,
      MoreThanSeven: v.MoreThanSeven || 0,
      TotalCount: v.TotalCount || 0,
    };
    for (const age of AGE_CATEGORIES) colTotals[age] += row[age];
    rows.push(row);
  }

  // Synthetic Total row — sums each age column; Total Count left blank (null)
  // to match legacy.
  rows.push({
    verticalCategory: 'Total',
    Today: colTotals.Today,
    Yesterday: colTotals.Yesterday,
    TwoToSeven: colTotals.TwoToSeven,
    MoreThanSeven: colTotals.MoreThanSeven,
    TotalCount: null,
  });

  return rows;
}

// Column set for the xlsx export (header order = on-screen order).
const EXPORT_COLUMNS = [
  { key: 'verticalCategory', header: 'Vertical Category', width: 22 },
  { key: 'Today', header: 'Today', width: 12 },
  { key: 'Yesterday', header: 'Yesterday', width: 12 },
  { key: 'TwoToSeven', header: '2-7 Days', width: 12 },
  { key: 'MoreThanSeven', header: 'More Than 7 Days', width: 18 },
  { key: 'TotalCount', header: 'Total Count', width: 14 },
];

module.exports = {
  getVerticalOpenOrders,
  buildExportRows,
  EXPORT_COLUMNS,
  // Exposed for the router's Joi schema + tests.
  FLAGS,
};
