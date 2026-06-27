/*
 * Shared SQL + date helpers for the native QuickSight reports.
 *
 * Built ONCE in Phase 0 so every report's parameterised SQL stays
 * diff-able and byte-accurate. Three concerns live here:
 *   1. buildInFilter()        — dynamic IN-clause assembly
 *   2. computeLastThreeWeeks() / computeLastThreeMonths() — Asia/Kolkata
 *      date windows used by the 3-period reports (Client Performance et al.)
 *   3. JOB_STATUS             — the legacy status-bucket constants + the
 *      non-obvious gotchas, documented inline so reviewers DON'T "clean
 *      them up" and break parity with the legacy ACD_APIs SQL.
 *
 * No DB access here — pure helpers. Parameterised-SQL house rule is upheld
 * by buildInFilter pushing every value onto the caller's `params` array.
 */

const logger = require('../../logger');

/*
 * ── buildInFilter(col, values, params) ──────────────────────────────
 *
 * Replaces the legacy `(:scalar IS NULL) OR col IN (:list)` sentinel +
 * safe-list(-1) hack. When `values` is a non-empty array, push each value
 * onto `params` and return a clause fragment with one placeholder per
 * value, e.g.  ` AND j.fk_client_id IN (?,?,?)`. When `values` is empty,
 * null, or not an array, return '' (emit NO clause) — functionally an
 * unset filter = no restriction. This avoids both the `IN ()` syntax error
 * and the -1 placeholder.
 *
 * The returned fragment is prefixed with ` AND ` and a leading space so it
 * can be string-concatenated straight onto a WHERE clause. `col` is a
 * trusted column identifier supplied by report code (NEVER user input) —
 * only the VALUES are parameterised, as MySQL placeholders cannot bind
 * identifiers.
 */
function buildInFilter(col, values, params) {
  if (!Array.isArray(values) || values.length === 0) return '';
  logger.info('QuickSight IN-filter applied · col=' + col + ' · values=' + values.length);
  const placeholders = values.map(() => '?').join(',');
  for (const v of values) params.push(v);
  return ` AND ${col} IN (${placeholders})`;
}

/*
 * ── Asia/Kolkata "today" ────────────────────────────────────────────
 *
 * IST is a fixed +05:30 offset with NO daylight saving, so we can derive
 * the IST calendar date deterministically via Intl and then do plain
 * calendar arithmetic on date-only values. We deliberately avoid Date
 * timezone math (which would run in the server's local/UTC zone and drift
 * week/month boundaries by hours near midnight / month-end).
 */
function istToday() {
  // en-CA yields YYYY-MM-DD; parse the parts so we never touch local TZ.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const [y, m, d] = parts.split('-').map(Number);
  // Anchor to a UTC midnight for the SAME calendar date so subsequent
  // UTC-based getters/setters are stable and never cross a TZ boundary.
  return new Date(Date.UTC(y, m - 1, d));
}

function fmt(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(date, n) {
  const out = new Date(date.getTime());
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

/*
 * ── computeLastThreeWeeks() ─────────────────────────────────────────
 *
 * The last 3 FULL Sunday–Saturday weeks, EXCLUDING the current (partial)
 * week. Returns oldest → newest:
 *   [{ start: 'YYYY-MM-DD' (Sun), end: 'YYYY-MM-DD' (Sat) }, x3]
 *
 * The `end` is the Saturday DATE; consumers MUST apply the inclusive
 * upper bound as DATE_ADD(?, INTERVAL 1 DAY) in SQL (the legacy
 * `:weekEndDate + INTERVAL '1' DAY` behaviour — covers the entire end
 * day). Computed against IST today so boundaries match legacy.
 */
function computeLastThreeWeeks() {
  const today = istToday();
  const dow = today.getUTCDay();        // 0=Sun … 6=Sat
  // Sunday that starts the CURRENT (partial) week.
  const currentWeekStart = addDays(today, -dow);
  // Saturday that ENDS the most recent FULL week (day before current week).
  const lastFullWeekEnd = addDays(currentWeekStart, -1);

  const weeks = [];
  // i=2 (oldest) … i=0 (most recent full week). 7-day strides back.
  for (let i = 2; i >= 0; i--) {
    const end = addDays(lastFullWeekEnd, -7 * i);
    const start = addDays(end, -6);
    weeks.push({ start: fmt(start), end: fmt(end) });
  }
  logger.info('Computed last 3 weeks · ' + weeks.map((w) => w.start + '..' + w.end).join(', '));
  return weeks;
}

/*
 * ── computeLastThreeMonths() ────────────────────────────────────────
 *
 * The CURRENT partial month (1st .. today) PLUS the 2 prior FULL months.
 * Returns oldest → newest:
 *   [{ start: 'YYYY-MM-01', end: 'YYYY-MM-<lastDay>' }, ...,
 *    { start: 'YYYY-MM-01', end: '<IST today>' }]   // current month is partial
 *
 * As with weeks, `end` is a DATE the consumer makes inclusive via
 * DATE_ADD(?, INTERVAL 1 DAY). The asymmetry (weekly excludes current
 * week; monthly INCLUDES current partial month) is intentional — preserve
 * it. Computed against IST today.
 */
function computeLastThreeMonths() {
  const today = istToday();
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();        // 0-based

  const months = [];
  // i=2 (two months ago) … i=0 (current month).
  for (let i = 2; i >= 0; i--) {
    const start = new Date(Date.UTC(y, m - i, 1));
    let end;
    if (i === 0) {
      end = today;                      // current month is PARTIAL → up to IST today
    } else {
      // Last day of that month = day before the 1st of the next month.
      end = new Date(Date.UTC(y, m - i + 1, 1));
      end = addDays(end, -1);
    }
    months.push({ start: fmt(start), end: fmt(end) });
  }
  logger.info('Computed last 3 months · ' + months.map((m2) => m2.start + '..' + m2.end).join(', '));
  return months;
}

/*
 * ── JOB_STATUS bucket constants ─────────────────────────────────────
 *
 * Ported VERBATIM from the legacy ACD_APIs SQL. Several values are NON-
 * OBVIOUS and are NOT in the EasyFix_Backend quick-reference status list
 * (CLAUDE.md). DO NOT "clean these up" — they are load-bearing for bucket
 * parity against the live legacy report numbers.
 *
 * Quick-ref (EasyFix_Backend CLAUDE.md):
 *   0 BOOKED · 1 SCHEDULED · 2 IN_PROGRESS · 3 COMPLETED · 5 COMPLETED_ALT
 *   6 CANCELLED · 7 ENQUIRY · 9 CALL_LATER · 10 REVISIT
 */
const JOB_STATUS = {
  // Terminal jobs excluded from "open orders" aging buckets.
  //   3 = completed, 5 = completed_alt, 7 = enquiry, 6 = cancelled.
  // Used as:  WHERE j.job_status NOT IN (3,5,7,6)
  TERMINAL_EXCLUSION: [3, 5, 7, 6],

  // Completed-for-revenue/billing/rating eligibility.  IN (3,5)
  COMPLETED: [3, 5],

  // ── GOTCHA: status 20 ────────────────────────────────────────────
  // Status 20 is treated as an ON-APP SIBLING of status 2 (IN_PROGRESS)
  // in the ">12h" / on-app aging bucket. It is NOT in the quick-ref list.
  // DO NOT drop the 20 — legacy buckets pair them:  job_status IN (2,20).
  ON_APP_IN_PROGRESS: [2, 20],

  // ── GOTCHA: status 10 waiting-audit gate ─────────────────────────
  // The 18h "Waiting Audit" bucket is NOT just status 10. It is:
  //   job_status = 10 AND no_of_req_approval < 1 AND no_of_req_foh < 1
  // (status 10 means REVISIT in other contexts — this bucket is
  // context-dependent on the two request counters). Preserve the full
  // 3-part predicate; the constant below only names the status code.
  WAITING_AUDIT_STATUS: 10,

  // ── GOTCHA: cancelled-after-allocation ───────────────────────────
  // A job cancelled AFTER a technician was allocated:
  //   job_status = 6 AND fk_easyfixter_id IS NOT NULL
  // (note the legacy typo column name: fk_easyfixter_id — keep verbatim).
  CANCELLED: 6,
};

/* ── XLSX export helpers (shared by the QuickSight ?format=xlsx branches) ──
 * Hoisted 2026-06-15 from per-route duplicates (DISPLAY_STAMP / FILE_STAMP /
 * FMT_COUNT / decorateColumns had drifted across files). All reports stream
 * via utils/xlsx-styled-export.js — these standardise the date stamps,
 * number formats, and the column-hint decorator so every report's download
 * reads as one family. */

// yyyy-mm-dd stamp for download filenames (e.g. "2026-06-15").
const fileStamp = () => new Date().toISOString().slice(0, 10);

// Human "15 Jun 2026" stamp for the meta band.
const displayStamp = () =>
  new Date().toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  });

// Number formats for streamStyledXlsx column hints. CHECK the service value
// shape before picking a percentage format:
//   COUNT  -> thousands-grouped integer
//   RUPEE  -> ₹ integer
//   PCT    -> WHOLE-number percent (86 -> "86.0%"); NOT a 0..1 fraction
//             (a fraction needs '0.0%', which would render 86 as 8600%)
const FMT = Object.freeze({
  COUNT: '#,##0',
  RUPEE: '"₹"#,##0',
  PCT: '0.0"%"',
});

/*
 * Decorate streamStyledXlsx columns with align / numFmt / dataBar hints
 * WITHOUT renaming any key/header. `rules` is an ordered list of
 *   { match: (key) => boolean, hints: { align?, numFmt?, dataBar?, dataBarColor? } }
 * The FIRST matching rule wins; unmatched columns pass through unchanged.
 * Report-specific rules stay at the call site; only the map/merge boilerplate
 * is hoisted here.
 */
function decorateColumns(columns, rules = []) {
  return columns.map((col) => {
    const rule = rules.find((r) => r.match(col.key));
    return rule ? { ...col, ...rule.hints } : col;
  });
}

module.exports = {
  buildInFilter,
  computeLastThreeWeeks,
  computeLastThreeMonths,
  JOB_STATUS,
  // Shared XLSX export helpers (QuickSight report downloads).
  fileStamp,
  displayStamp,
  FMT,
  decorateColumns,
  // Exposed for reuse/tests; report code rarely needs these directly.
  _dateHelpers: { istToday, fmt, addDays },
};
