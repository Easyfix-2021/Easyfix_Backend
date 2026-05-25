const logger = require('../logger');

/*
 * Holiday service — feeds the CRM dashboard's "Upcoming Events" rail.
 *
 * History of this file:
 *   v1 (2026-05-22): wrapped the open-source Nager.Date API
 *     (https://date.nager.at/api/v3/PublicHolidays/{year}/IN) with a
 *     24h in-memory cache. Plan rationale was zero-maintenance: a
 *     well-maintained upstream + cache = no DB table.
 *   v2 (2026-05-22, later same day): replaced Nager with a static
 *     inline list. Reason: Nager.Date currently returns HTTP 204 with
 *     an empty body for /IN — they appear to have dropped India
 *     coverage at some point. With no working free upstream that
 *     covers Indian Gazetted + Restricted holidays without an API
 *     key, the cleanest path is a vendored list. Maintenance is
 *     ~1 PR per year, less burden than a `tbl_holiday` table that
 *     ops would have to keep in sync via a UI.
 *
 * The route surface (GET /admin/holidays/upcoming?days=N) stays
 * identical, so the FE rail keeps working without changes.
 *
 * Adding a year: drop a new entry into INDIAN_HOLIDAYS_BY_YEAR. If
 * Nager.Date (or another free API) restores India coverage later,
 * fetchYearFromExternal() can be wired in as the primary source and
 * this static table becomes the fallback — the public API doesn't
 * have to change.
 */

/*
 * Indian holidays — sourced from the Government of India's
 * Gazetted + Restricted holidays list. Includes the major Hindu,
 * Muslim, Christian, Sikh, and Buddhist observances commonly
 * appearing on national calendars.
 *
 * Variable-date holidays (Holi, Eid, Diwali, etc.) are computed from
 * the lunar/Islamic calendar; the values below are pinned to the
 * official Government of India gazette where available, with a
 * conservative best-known-date for entries not yet gazetted.
 *
 * NB: regional holidays vary by state (e.g. Onam in Kerala, Pongal in
 * Tamil Nadu). We list only nationally-observed ones here to avoid
 * surfacing irrelevant entries on the dashboard. State-specific
 * additions can ride on a future `tbl_holiday_override`.
 */
const INDIAN_HOLIDAYS_BY_YEAR = {
  2025: [
    { date: '2025-01-01', name: "New Year's Day",         holiday_type: 'restricted' },
    { date: '2025-01-14', name: 'Makar Sankranti',        holiday_type: 'restricted' },
    { date: '2025-01-26', name: 'Republic Day',           holiday_type: 'national'   },
    { date: '2025-03-14', name: 'Holi',                   holiday_type: 'national'   },
    { date: '2025-03-31', name: 'Eid-ul-Fitr',            holiday_type: 'national'   },
    { date: '2025-04-10', name: 'Mahavir Jayanti',        holiday_type: 'restricted' },
    { date: '2025-04-14', name: 'Ambedkar Jayanti',       holiday_type: 'restricted' },
    { date: '2025-04-18', name: 'Good Friday',            holiday_type: 'national'   },
    { date: '2025-05-01', name: 'Labour Day',             holiday_type: 'restricted' },
    { date: '2025-05-12', name: 'Buddha Purnima',         holiday_type: 'national'   },
    { date: '2025-06-07', name: 'Eid-ul-Zuha (Bakrid)',   holiday_type: 'restricted' },
    { date: '2025-07-06', name: 'Muharram',               holiday_type: 'restricted' },
    { date: '2025-08-15', name: 'Independence Day',       holiday_type: 'national'   },
    { date: '2025-08-16', name: 'Janmashtami',            holiday_type: 'restricted' },
    { date: '2025-09-05', name: 'Milad-un-Nabi',          holiday_type: 'restricted' },
    { date: '2025-10-02', name: 'Gandhi Jayanti',         holiday_type: 'national'   },
    { date: '2025-10-02', name: 'Dussehra',               holiday_type: 'national'   },
    { date: '2025-10-20', name: 'Diwali',                 holiday_type: 'national'   },
    { date: '2025-11-05', name: 'Guru Nanak Jayanti',     holiday_type: 'national'   },
    { date: '2025-12-25', name: 'Christmas Day',          holiday_type: 'national'   },
  ],
  2026: [
    { date: '2026-01-01', name: "New Year's Day",         holiday_type: 'restricted' },
    { date: '2026-01-14', name: 'Makar Sankranti',        holiday_type: 'restricted' },
    { date: '2026-01-26', name: 'Republic Day',           holiday_type: 'national'   },
    { date: '2026-03-04', name: 'Holi',                   holiday_type: 'national'   },
    { date: '2026-03-20', name: 'Eid-ul-Fitr',            holiday_type: 'national'   },
    { date: '2026-03-31', name: 'Mahavir Jayanti',        holiday_type: 'restricted' },
    { date: '2026-04-03', name: 'Good Friday',            holiday_type: 'national'   },
    { date: '2026-04-14', name: 'Ambedkar Jayanti',       holiday_type: 'restricted' },
    { date: '2026-05-01', name: 'Labour Day',             holiday_type: 'restricted' },
    { date: '2026-05-31', name: 'Buddha Purnima',         holiday_type: 'national'   },
    { date: '2026-05-27', name: 'Eid-ul-Zuha (Bakrid)',   holiday_type: 'restricted' },
    { date: '2026-06-26', name: 'Muharram',               holiday_type: 'restricted' },
    { date: '2026-08-15', name: 'Independence Day',       holiday_type: 'national'   },
    { date: '2026-09-04', name: 'Janmashtami',            holiday_type: 'restricted' },
    { date: '2026-08-26', name: 'Milad-un-Nabi',          holiday_type: 'restricted' },
    { date: '2026-10-02', name: 'Gandhi Jayanti',         holiday_type: 'national'   },
    { date: '2026-10-20', name: 'Dussehra',               holiday_type: 'national'   },
    { date: '2026-11-08', name: 'Diwali',                 holiday_type: 'national'   },
    { date: '2026-11-24', name: 'Guru Nanak Jayanti',     holiday_type: 'national'   },
    { date: '2026-12-25', name: 'Christmas Day',          holiday_type: 'national'   },
  ],
  2027: [
    { date: '2027-01-01', name: "New Year's Day",         holiday_type: 'restricted' },
    { date: '2027-01-14', name: 'Makar Sankranti',        holiday_type: 'restricted' },
    { date: '2027-01-26', name: 'Republic Day',           holiday_type: 'national'   },
    { date: '2027-03-23', name: 'Holi',                   holiday_type: 'national'   },
    { date: '2027-03-26', name: 'Good Friday',            holiday_type: 'national'   },
    { date: '2027-05-01', name: 'Labour Day',             holiday_type: 'restricted' },
    { date: '2027-08-15', name: 'Independence Day',       holiday_type: 'national'   },
    { date: '2027-10-02', name: 'Gandhi Jayanti',         holiday_type: 'national'   },
    { date: '2027-10-30', name: 'Diwali',                 holiday_type: 'national'   },
    { date: '2027-12-25', name: 'Christmas Day',          holiday_type: 'national'   },
  ],
};

function getYear(year) {
  const rows = INDIAN_HOLIDAYS_BY_YEAR[year];
  if (!rows) {
    logger.info({ year }, 'No holiday data seeded for year — add to INDIAN_HOLIDAYS_BY_YEAR');
    return [];
  }
  return rows;
}

/*
 * Public: upcoming holidays within the next `days` days, starting
 * from today (server local). Sorted by date ascending. Cross-year
 * safe — when `days` spans Dec→Jan we read both years and merge.
 */
function getUpcoming({ days = 7 } = {}) {
  days = Math.max(1, Math.min(Number(days) || 7, 30));

  // Compare against today's date in LOCAL time (server TZ assumed IST
  // per the rest of the app). Dates in the seed are calendar dates
  // with no timezone, so a string compare against the local YYYY-MM-DD
  // is the right semantic.
  const today = new Date();
  const todayStr = formatLocalDateStr(today);

  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() + days);
  const endStr = formatLocalDateStr(endDate);

  const yearsNeeded = new Set([
    today.getFullYear(),
    endDate.getFullYear(),
  ]);

  const merged = [];
  for (const y of yearsNeeded) {
    const rows = getYear(y);
    for (const r of rows) {
      if (r.date >= todayStr && r.date <= endStr) {
        merged.push({
          date: r.date,
          name: r.name,
          holiday_type: r.holiday_type,
          description: null,
        });
      }
    }
  }

  // Stable sort by date then name (matters when two holidays share a
  // date — e.g. 2 Oct 2025 had both Gandhi Jayanti and Dussehra).
  merged.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  return Promise.resolve(merged);                      // keep async signature
}

/* YYYY-MM-DD in the server's local timezone. */
function formatLocalDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

module.exports = { getUpcoming };
