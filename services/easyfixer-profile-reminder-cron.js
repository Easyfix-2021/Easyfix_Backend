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

/*
 * Test send (2026-06-06). Fires the SAME Gallabox template the daily cron
 * fires, but to an arbitrary operator-supplied mobile — never to the real
 * easyfixer. Two modes:
 *
 *   - sourceId omitted → recipientName falls back to a dummy
 *     ("Test Easyfixer"). Useful for verifying template approval /
 *     Gallabox connectivity without touching any real row.
 *
 *   - sourceId provided (an efr_id) → we look up THAT row's display name
 *     and use it as the WhatsApp recipientName so the test message looks
 *     identical to what THAT easyfixer would receive. The lookup is
 *     read-only; we do NOT update efr_status, profile_perc, anything.
 *     The WhatsApp still goes to the operator's mobile — under no path
 *     does it reach the real easyfixer's number.
 *
 * The mobile is validated to 10 Indian digits (or 12 with the 91 prefix);
 * an invalid number throws a 400 before any provider call. Returns a
 * structured result the route handler surfaces back to the FE for the
 * "Last Run" panel.
 */
async function runTest({ mobile, sourceId } = {}) {
  const phone = String(mobile || '').trim();
  const cleaned = phone.replace(/\D/g, '');
  if (!(cleaned.length === 10 || (cleaned.length === 12 && cleaned.startsWith('91')))) {
    throw Object.assign(new Error('Mobile must be a valid 10-digit Indian number.'), {
      status: 400, code: 'INVALID_TEST_MOBILE',
    });
  }

  // Optional source lookup — purely for the recipientName field. Read-only.
  let recipientName = 'Test Easyfixer';
  let sourceUsed = null;
  if (sourceId != null && String(sourceId).trim() !== '') {
    const efrId = Number(String(sourceId).trim());
    if (!Number.isInteger(efrId) || efrId <= 0) {
      throw Object.assign(new Error('Easyfixer ID must be a positive integer.'), {
        status: 400, code: 'INVALID_SOURCE_ID',
      });
    }
    const [rows] = await pool.query(
      `SELECT efr_id,
              COALESCE(NULLIF(TRIM(efr_name), ''),
                       NULLIF(TRIM(CONCAT_WS(' ', efr_first_name, efr_last_name)), ''),
                       '') AS name
         FROM tbl_easyfixer
        WHERE efr_id = ? LIMIT 1`,
      [efrId],
    );
    if (rows.length === 0) {
      throw Object.assign(new Error(`No easyfixer found with id ${efrId}.`), {
        status: 404, code: 'EASYFIXER_NOT_FOUND',
      });
    }
    recipientName = rows[0].name || recipientName;
    sourceUsed = { efr_id: rows[0].efr_id, name: rows[0].name || null };
  }

  // Send strictly to the operator's mobile. Gallabox wrapper handles
  // NOTIFICATIONS_DISABLE + TEST_MOBILE itself (the latter would
  // redirect even a test send if set — log either way).
  const res = await gallabox.sendTemplate({
    to: phone,
    recipientName,
    templateName: TEMPLATE_NAME,
    bodyValues: {},
  });

  logger.info(
    `Profile-reminder TEST · target=${phone} · recipientName="${recipientName}" · ` +
    `efr_id=${sourceUsed?.efr_id ?? 'none'} · delivered=${!!res?.delivered}`,
  );

  return {
    test: true,
    target_mobile: phone,
    recipient_name: recipientName,
    source_used: sourceUsed,
    delivered: !!res?.delivered,
    disabled: !!res?.disabled,
    redirected_to_test_mobile: !!res?.redirected,
    intended_to: res?.intendedTo || null,
    http_status: res?.httpStatus || null,
    provider_response: res?.providerResponse ? String(res.providerResponse).slice(0, 240) : null,
    error: res?.error || null,
  };
}

module.exports = { runDailyReminder, runTest, TEMPLATE_NAME };
