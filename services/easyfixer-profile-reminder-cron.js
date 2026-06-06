const { pool } = require('../db');
const logger = require('../logger');
const gallabox = require('./gallabox.whatsapp.service');

/*
 * Easyfixer Profile-Completion Reminder cron service (2026-06-06).
 *
 * Runs once per day at 10:00 IST (see server/scheduler.js). For every
 * ACTIVE easyfixer whose profile is incomplete, sends a Gallabox
 * WhatsApp message using the pre-approved template
 * `complete_profile_easyfixer`. The template is a generic nudge — no
 * dynamic body values required from our side.
 *
 * "Incomplete profile" definition (verified against tbl_easyfixer
 * column conventions used in services/easyfixer.service.js list
 * projection):
 *
 *   efr_status         = 1                  ← active (soft-delete flag)
 *   AND (
 *        efr_profile_perc < 100             ← legacy completion %
 *        OR final_submission = 0
 *        OR final_submission IS NULL        ← never reached the "I'm done" step
 *   )
 *
 * Plus we require a usable mobile (efr_no) since the WhatsApp send
 * has nothing to dial without it.
 *
 * Per-send error handling: a single rejected WhatsApp message is
 * logged + counted as a failure but does NOT abort the loop —
 * Gallabox rejections are usually per-recipient (invalid number,
 * opt-out, template render error) and the next easyfixer should
 * still get their nudge.
 */

const TEMPLATE_NAME = 'complete_profile_easyfixer';

async function runDailyReminder() {
  // Find every active easyfixer with an incomplete profile + a
  // usable mobile. Curated projection — we only need id / name /
  // mobile for the send loop; rest of the row is ignored.
  const [rows] = await pool.query(`
    SELECT efr_id,
           COALESCE(NULLIF(TRIM(efr_name), ''),
                    TRIM(CONCAT_WS(' ', efr_first_name, efr_last_name)),
                    '') AS name,
           efr_no
      FROM tbl_easyfixer
     WHERE efr_status = 1
       AND (
            (efr_profile_perc IS NULL OR efr_profile_perc < 100)
            OR (final_submission = 0 OR final_submission IS NULL)
       )
       AND efr_no IS NOT NULL
       AND TRIM(efr_no) <> ''
  `);

  const summary = {
    eligible: rows.length,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };

  for (const row of rows) {
    const phone = String(row.efr_no || '').trim();
    if (!phone) { summary.skipped += 1; continue; }
    summary.attempted += 1;
    try {
      const res = await gallabox.sendTemplate({
        to: phone,
        recipientName: row.name || 'EasyFixer',
        templateName: TEMPLATE_NAME,
        // Template has no body placeholders; the generic nudge stands
        // on its own. If Gallabox later requires named variables (e.g.
        // {{1}} for technician's first name), add them here.
        bodyValues: {},
      });
      if (res?.delivered) {
        summary.succeeded += 1;
      } else if (res?.disabled) {
        // NOTIFICATIONS_DISABLE was set — count as skipped, not failed,
        // because the suppression is intentional (dev / staging).
        summary.skipped += 1;
      } else {
        summary.failed += 1;
        logger.warn(
          `profile-reminder · efr_id=${row.efr_id} · phone=${phone} · ` +
          `rejected: ${res?.error || 'unknown'}`
        );
      }
    } catch (err) {
      summary.failed += 1;
      logger.error(
        `profile-reminder · efr_id=${row.efr_id} · phone=${phone} · ` +
        `crashed: ${err.message}`
      );
    }
  }

  return summary;
}

module.exports = { runDailyReminder, TEMPLATE_NAME };
