const { pool } = require('../db');
const logger = require('../logger');

/*
 * Easyfixer auto-reactivation cron (2026-07-13).
 *
 * Daily job that reactivates technicians set "Temporarily Inactive" with a
 * scheduled_reactivation_date that has arrived. Companion to the Manage
 * Easyfixers deactivate flow (Admin-only), which stamps the date; this flips
 * efr_status back to 1 on/after it and clears the date so a row is processed
 * once and never re-fires.
 *
 * Guards:
 *  - is_technician_verified = 1 → a stray date on a mid-onboarding lead can't
 *    flip an unverified tech to Active (returns them to the exact "Active" label).
 *  - scheduled_reactivation_date <= today (IST) → catch-up safe: a missed cron
 *    day still reactivates on the next run.
 * Best-effort: the whole run is try/caught so a bad tick can't crash the process;
 * a pre-migration column (scheduled_reactivation_date absent) is a clean no-op.
 */

// IST calendar date (NOT the DB server's CURDATE(), which may be UTC). en-CA → YYYY-MM-DD.
function istDateString(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

/*
 * The shared UPDATE — reactivate every due, verified, temp-inactive technician.
 * `onlyEfrId` lets runTest() target a single efr_id regardless of the date.
 * Returns the number of rows reactivated.
 */
async function reactivate({ today, onlyEfrId = null } = {}) {
  const clauses = [
    'efr_status = 0',
    'is_technician_verified = 1',
    'scheduled_reactivation_date IS NOT NULL',
  ];
  const params = [];
  if (onlyEfrId != null) {
    clauses.push('efr_id = ?');
    params.push(onlyEfrId);
  } else {
    clauses.push('scheduled_reactivation_date <= ?');
    params.push(today);
  }
  const [result] = await pool.query(
    `UPDATE tbl_easyfixer
        SET efr_status = 1,
            inactive_reason = NULL,
            inactive_comment = NULL,
            scheduled_reactivation_date = NULL,
            update_date = NOW()
      WHERE ${clauses.join(' AND ')}`,
    params,
  );
  return result.affectedRows || 0;
}

// Daily runner. Returns { date, reactivated } (skipped:true if the column is absent).
async function runDailyReactivation() {
  const today = istDateString(0);
  try {
    const reactivated = await reactivate({ today });
    logger.info(`Easyfixer auto-reactivation cron · date=${today} · reactivated=${reactivated}`);
    return { date: today, reactivated };
  } catch (e) {
    // Pre-migration deploy (scheduled_reactivation_date column absent) or a
    // transient DB error — never throw out of a cron tick.
    logger.warn({ err: e.message }, 'easyfixer-reactivation cron: run failed (column may be pre-migration)');
    return { date: today, reactivated: 0, skipped: true };
  }
}

/*
 * Manual test from the Scheduled Jobs admin page: reactivate ONE efr_id that is
 * currently temporarily inactive (ignores the scheduled date) so ops can verify
 * the wiring end-to-end. No-ops safely if the tech isn't a verified temp-inactive row.
 */
async function runTest({ sourceId } = {}) {
  const efrId = Number(sourceId);
  if (!Number.isInteger(efrId) || efrId <= 0) {
    return { ok: false, error: 'A valid Easyfixer ID (efr_id) is required.' };
  }
  try {
    const reactivated = await reactivate({ today: istDateString(0), onlyEfrId: efrId });
    return {
      ok: true,
      efr_id: efrId,
      reactivated,
      note: reactivated
        ? 'Technician reactivated (was temporarily inactive + verified).'
        : 'No change — the technician is not a verified, temporarily-inactive row (efr_status=0 + scheduled_reactivation_date set).',
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { runDailyReactivation, runTest, istDateString };
