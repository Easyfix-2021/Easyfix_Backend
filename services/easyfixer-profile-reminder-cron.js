const { pool } = require('../db');
const logger = require('../logger');
const gallabox = require('./gallabox.whatsapp.service');
const profileUpdateLink = require('./easyfixer-profile-update-link.service');

/*
 * Easyfixer Profile-Completion Reminder cron service (2026-06-06).
 *
 * Runs once per day at 10:00 IST (see server/scheduler.js). For every
 * ACTIVE easyfixer whose profile is incomplete, sends a Gallabox
 * WhatsApp message using the pre-approved template
 * `skill_otp_tx1_newvideo`. The template is a generic nudge — no
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

// Re-exported from the link service — ONE owner for the template name so a
// rename can't leave this cron pointing at a retired template.
const { PROFILE_TEMPLATE_NAME: TEMPLATE_NAME } = require('./easyfixer-profile-update-link.service');

async function runDailyReminder() {
  logger.info('Run daily profile-completion reminder · template=' + TEMPLATE_NAME);
  // Find every active easyfixer with an incomplete profile + a
  // usable mobile. Curated projection — we only need id / name /
  // mobile for the send loop; rest of the row is ignored.
  /*
   * 7-day per-easyfixer cooldown (2026-06-11). Treat ALL profile-related
   * nudges as one channel — if any magic-link / reminder went out in the
   * last week we don't pile on. `profile_update_sent_at` is stamped by
   * sendForEasyfixer (skill+pincode cron + manual operator sends); this
   * cron currently doesn't stamp it, so the cooldown is one-directional
   * (this cron suppresses if recently magic-link'd, but a recent
   * profile-completion nudge doesn't suppress a magic-link send). Good
   * enough for ant-spam — symmetric stamping is a follow-up if needed.
   */
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
       AND (profile_update_sent_at IS NULL
            OR profile_update_sent_at < NOW() - INTERVAL 7 DAY)
  `);

  logger.info('Found ' + rows.length + ' eligible easyfixers for reminder');

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
      await profileUpdateLink.sendForEasyfixer(
        row.efr_id,
        { action: 'reminder' },
        null,  // actor: null — system-triggered, no human operator
        pool,
      );
      summary.succeeded += 1;
    } catch (err) {
      summary.failed += 1;
      logger.warn(
        `profile-reminder · efr_id=${row.efr_id} · phone=${phone} · ` +
        `crashed: ${err.message}`
      );
    }
  }

  logger.info('Daily reminder done · eligible=' + summary.eligible + ' · attempted=' + summary.attempted + ' · succeeded=' + summary.succeeded + ' · failed=' + summary.failed + ' · skipped=' + summary.skipped);

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
  logger.info('Run profile-reminder TEST · sourceId=' + (sourceId != null && String(sourceId).trim() !== '' ? sourceId : 'none'));
  const phone = String(mobile || '').trim();
  const cleaned = phone.replace(/\D/g, '');
  if (!(cleaned.length === 10 || (cleaned.length === 12 && cleaned.startsWith('91')))) {
    logger.warn('Profile-reminder TEST rejected · invalid test mobile');
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
      logger.warn('Profile-reminder TEST rejected · invalid sourceId=' + sourceId);
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
      logger.warn('Profile-reminder TEST rejected · no easyfixer found · efrId=' + efrId);
      throw Object.assign(new Error(`No easyfixer found with id ${efrId}.`), {
        status: 404, code: 'EASYFIXER_NOT_FOUND',
      });
    }
    recipientName = rows[0].name || recipientName;
    sourceUsed = { efr_id: rows[0].efr_id, name: rows[0].name || null };
  }

  // Delegate to sendForEasyfixer with override_mobile so the message
  // goes to the operator's number (not the real easyfixer's). This
  // ensures the test send uses the same template + bodyValues as the
  // daily cron — including the profile-update magic link.
  // sourceId=0 (dummy) is accepted; sendForEasyfixer mints a JWT for
  // efr_id=0 which lands on a non-functional but structurally valid link.
  const testEfrId = sourceUsed?.efr_id ?? 0;
  let res;
  try {
    res = await profileUpdateLink.sendForEasyfixer(
      testEfrId,
      // Scheduled Jobs → Test: honour the typed number on every env (bypasses
      // both the prod override-mobile gate and the TEST_MOBILE redirect).
      { action: 'reminder', override_mobile: phone, bypassTestRedirect: true },
      null,
      pool,
    );
  } catch (err) {
    res = { delivered: false, error: err.message };
  }

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
