const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { pool } = require('../../db');
const { modernOk } = require('../../utils/response');
const logger = require('../../logger');
const { todayIst, shiftYmd } = require('../../utils/ist-calendar');
const { INTERNAL_USER_TYPE_ID } = require('../../services/user.service');

/*
 * /api/admin/birthdays — the dashboard's "Upcoming Events" rail: BIRTHDAYS and
 * WORK ANNIVERSARIES.
 *
 * The mount is still /birthdays because it is a public URL the CRM already
 * calls; renaming it would buy accuracy at the cost of a coordinated
 * FE/BE deploy. The response grew a second array instead — `items` (birthdays)
 * is untouched, so an older CRM build keeps working against a newer backend.
 *
 * Reads date_of_birth out of tbl_user_personal_details (set by the user through
 * /api/profile, or by HR approving a correction).
 *
 * ── WHAT THIS DELIBERATELY DOES NOT RETURN ──────────────────────────────
 * The birth YEAR and the AGE. Never. The feature is "wish Priya on Thursday",
 * and a colleague's age is not something a birthday rail needs to publish to
 * the whole company. The SQL projects only DATE_FORMAT(…, '%m-%d'), so the year
 * never leaves the database, and the date each row carries is the occurrence
 * inside the CURRENT window, not the date of birth.
 *
 * ── THE YEAR WRAP ───────────────────────────────────────────────────────
 * A 7-day window opened on 28 Dec has to return someone born on 2 Jan. Doing
 * that with date arithmetic in SQL means a UNION or an OR across two ranges,
 * and gets leap years wrong. Instead the window is expanded in JS into the
 * literal list of MM-DD strings it covers (at most 32) and matched with an IN.
 * The wrap then costs nothing — 12-31 and 01-01 are just two more strings — and
 * the same map turns each matched MM-DD back into the real YYYY-MM-DD in the
 * window, which is what the response carries.
 *
 * Gate: the inherited /api/admin mount (requireAuth + role(['admin'])). No
 * action key — the HRMS RBAC migration seeds keys for the APPROVAL queue only,
 * and a birthday list is not a permissioned decision. If one is ever wanted,
 * add requireAction('isBirthdayView') here and seed the key in the same change.
 */

const upcomingQuery = Joi.object({
  // A month is the longest window anyone has asked for, and it also keeps the
  // generated MM-DD list (and therefore the IN clause) bounded and duplicate-free.
  days: Joi.number().integer().min(1).max(31).default(7),
});

/*
 * Every MM-DD in [today, today+days] mapped to its real date in this window.
 * First occurrence wins, which only matters if the window were ever long enough
 * to repeat an MM-DD — it cannot be, given the 31-day cap.
 */
function windowByMonthDay(days, from = todayIst()) {
  const byMd = new Map();
  for (let i = 0; i <= days; i++) {
    const date = shiftYmd(from, i);
    const md = date.slice(5);
    if (!byMd.has(md)) byMd.set(md, date);
  }
  /*
   * 29 February. In a non-leap year the generated window steps 02-28 → 03-01,
   * so '02-29' never appears and everyone born on it would be silently skipped
   * every year but one. The convention is to observe them on 1 March, which is
   * exactly the date already in the map. In a LEAP year '02-29' is a real day in
   * the window and is already present, so this adds nothing.
   */
  if (byMd.has('03-01') && !byMd.has('02-29')) byMd.set('02-29', byMd.get('03-01'));
  return byMd;
}

router.get('/upcoming', validate(upcomingQuery, 'query'), async (req, res, next) => {
  try {
    const days = req.query.days;
    const byMd = windowByMonthDay(days);
    const monthDays = [...byMd.keys()];

    const placeholders = monthDays.map(() => '?').join(', ');

    const [rows] = await pool.query(
      `SELECT u.user_id, u.user_name, DATE_FORMAT(p.date_of_birth, '%m-%d') AS md
         FROM tbl_user_personal_details p
         JOIN tbl_user u ON u.user_id = p.user_id
        WHERE p.date_of_birth IS NOT NULL
          AND u.user_status = 1
          AND u.user_type_id = ?
          AND DATE_FORMAT(p.date_of_birth, '%m-%d') IN (${placeholders})`,
      [INTERNAL_USER_TYPE_ID, ...monthDays],
    );

    const items = rows
      .map((r) => ({
        user_id:   r.user_id,
        user_name: r.user_name,
        date:      byMd.get(r.md) || null,
      }))
      .filter((r) => r.date)
      .sort((a, b) => a.date.localeCompare(b.date)
        || String(a.user_name || '').localeCompare(String(b.user_name || '')));

    /*
     * ── WORK ANNIVERSARIES ────────────────────────────────────────────
     * Same window, same MM-DD trick, same year-wrap and 29-February rules —
     * date_of_joining instead of date_of_birth.
     *
     * WHAT LEAVES THE DATABASE IS DIFFERENT, AND DELIBERATELY SO. The birthday
     * rows above project only MM-DD because a colleague's age is nobody's
     * business. A work anniversary is the opposite: "5 Years" IS the message,
     * and length of service is already public — it is on the org chart and in
     * every introduction. So the joining YEAR is read here, but only to
     * subtract: the response carries the ORDINAL, never the joining date. Two
     * different rules for two different facts, not an inconsistency.
     *
     * The year comes from the WINDOW date, not from today: a window opened on
     * 28 December that reaches 2 January must count that anniversary against
     * the new year, or everyone who joined in early January is reported one
     * year short for those few days.
     */
    /*
     * FAIL-SOFT on a missing COLUMN (1054), and only on that.
     *
     * date_of_joining ships as a PENDING migration while this code deploys
     * through GitHub Actions, so there is a real window in which the column
     * does not exist. Without this catch the anniversary query throws and
     * takes the BIRTHDAY rail down with it — a rail that worked yesterday
     * disappears because a feature nobody has data for yet cannot query its
     * column. An empty array is the honest answer in that window: there are no
     * anniversaries on this host.
     *
     * A connection failure or a genuine SQL error still propagates.
     */
    let annivRows = [];
    try {
      [annivRows] = await pool.query(
        `SELECT u.user_id, u.user_name,
                DATE_FORMAT(p.date_of_joining, '%m-%d') AS md,
                YEAR(p.date_of_joining) AS joined_year
           FROM tbl_user_personal_details p
           JOIN tbl_user u ON u.user_id = p.user_id
          WHERE p.date_of_joining IS NOT NULL
            AND u.user_status = 1
            AND u.user_type_id = ?
            AND DATE_FORMAT(p.date_of_joining, '%m-%d') IN (${placeholders})`,
        [INTERNAL_USER_TYPE_ID, ...monthDays],
      );
    } catch (e) {
      if (e && (e.code === 'ER_BAD_FIELD_ERROR' || e.errno === 1054)) {
        // Bare filename, no directory: the migration has already moved from
        // migrations/ into migrations/executed/, so a path here would send the
        // operator to an empty directory and read as a stale hint.
        logger.warn('Work anniversaries skipped — date_of_joining is missing on this host. '
          + 'Apply the 2026-09-02-add-hr-identifiers-user-personal-details.sql migration');
      } else {
        throw e;
      }
    }

    const anniversaries = annivRows
      .map((r) => {
        const date = byMd.get(r.md) || null;
        return {
          user_id:   r.user_id,
          user_name: r.user_name,
          date,
          years:     date ? Number(date.slice(0, 4)) - Number(r.joined_year) : 0,
        };
      })
      /*
       * years >= 1 drops two cases that are not anniversaries: the person who
       * JOINS on a day inside the window (0 years — that is a start date, and
       * "congratulations on 0 years" is the kind of thing that gets a feature
       * switched off), and a future-dated joiner, whose subtraction goes
       * negative. Both are legitimate rows in the table; neither belongs here.
       */
      .filter((r) => r.date && r.years >= 1)
      .sort((a, b) => a.date.localeCompare(b.date)
        || String(a.user_name || '').localeCompare(String(b.user_name || '')));

    logger.info('Upcoming events · days=' + days
      + ' birthdays=' + items.length + ' anniversaries=' + anniversaries.length);
    modernOk(res, { items, anniversaries });
  } catch (e) { next(e); }
});

// Exported for tests — the year-wrap and leap-day rules are the whole feature
// and testing them through HTTP would prove less with more machinery.
module.exports = router;
module.exports.windowByMonthDay = windowByMonthDay;
