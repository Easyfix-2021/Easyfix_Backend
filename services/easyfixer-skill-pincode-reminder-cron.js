const { pool } = require('../db');
const logger = require('../logger');
const profileUpdateLink = require('./easyfixer-profile-update-link.service');
const { signEasyfixerProfileToken } = require('../utils/jwt');
const whatsappService = require('./gallabox.whatsapp.service');
const urlShortener = require('./url-shortener.service');

const TEMPLATE_NAME = 'tx_complete_profile';

/*
 * Easyfixer Skill+Pincode Reminder cron service (2026-06-11).
 *
 * Sister cron to easyfixer-profile-reminder-cron.js, but targets a
 * DIFFERENT incompleteness signal: easyfixers whose profile shell is
 * filled in (so they don't qualify for the generic profile nudge), but
 * who still lack the two structured datasets that the auto-assignment
 * engine actually USES to pick them for jobs —
 *
 *   1. Deep-skill mappings (tbl_efr_deepskill_mapping with is_repairing=1)
 *   2. Serviceable pincodes (tbl_efr_serviceable_pincodes.pincodes)
 *
 * Both are required for the engine to consider a technician. A profile
 * that's "100% complete" but missing either of these is invisible to
 * the dispatcher — exactly the easyfixers ops most want to nudge.
 *
 * Schedule: 12:30 IST daily (cron `30 12 * * *`, evaluated in
 * Asia/Kolkata by the scheduler wrapper).
 *
 * Schedule rationale:
 *   - WhatsApp open rates for the technician audience peak during the
 *     lunch break.
 *   - The existing easyfixer-profile-reminder cron fires at 10:00 IST
 *     (morning prep). Stacking a second message back-to-back at 10:30
 *     or 11:00 would feel like spam.
 *   - 12:30 puts the message in the lunch-break attention window,
 *     where action-completion rates for a ~2-minute form are highest.
 *   - End-of-day (~19:00) was the alternative slot but technicians on
 *     active jobs often work past 19:00 and only check WhatsApp late
 *     when they're winding down — too far from "I can act on this now".
 *
 * Sending: delegates to easyfixer-profile-update-link.service ::
 * sendForEasyfixer(efrId, { action: 'reminder' }, null, pool). That
 * function already handles JWT minting, URL shortening, audit columns
 * (profile_update_sent_at / profile_update_send_count /
 * profile_update_last_action), and the Gallabox template send with
 * sendText fallback — so this cron stays small and side-effect-free
 * beyond the loop.
 *
 * The `action: 'reminder'` value is one of the three values the existing
 * Joi schema (routes/admin/easyfixers.js :: profileUpdateSendBody)
 * already accepts: 'first' | 'reminder' | 'resend'. It gets stamped to
 * profile_update_last_action so operators can distinguish cron sends
 * from manual admin sends in the audit trail. sendForEasyfixer's
 * internal 'first' → 'resend' coercion does NOT touch 'reminder', so
 * cron sends keep their distinct label even on repeat days.
 *
 * Idempotency: safe to run twice the same minute. The downstream service
 * always overwrites profile_update_sent_at + increments
 * profile_update_send_count atomically — there's no extra dedup needed
 * at this layer.
 *
 * Per-row errors are swallowed + logged at warn level. A single Gallabox
 * rejection (invalid number, opt-out, template render error) MUST NOT
 * abort the loop — the rest of the queue should still be drained.
 */

async function runDailyReminder() {
  const t0 = Date.now();

  /*
   * Find every FULLY-ACTIVE easyfixer with a usable mobile who has
   * BOTH datasets empty (2026-06-11, narrowed):
   *
   *   1. `efr_status = 1` AND `is_technician_verified = 1`
   *      — both not-soft-deleted AND verification-complete. Easyfixers
   *      whose registration isn't yet finished ("Registration In
   *      Progress" in the Manage Easyfixers status pills) are handled
   *      by easyfixer-profile-reminder-cron which nudges them to
   *      finish registration first. Pinging them to set deep skills +
   *      pincodes before they've passed verification is operator-
   *      confusing and crosses channel responsibilities.
   *
   *   2. `missing_skills = TRUE AND missing_pincodes = TRUE` —
   *      fully cold profiles only. Partial-progress (data in one of
   *      the two) is intentionally excluded; they've engaged and don't
   *      need a nudge.
   *
   * No per-easyfixer cooldown at this layer (2026-06-11). User wants
   * daily sends initially. The AND filter is the rate gate — as techs
   * fill their data they fall out of the eligible pool naturally.
   * If daily volume turns out noisy in practice, a 7-day cooldown is
   * a one-line addition.
   *
   * MySQL 5.7+ note: `HAVING` may reference SELECT-list aliases for
   * derived expressions, which is what we lean on here for
   * `missing_skills` (a correlated subquery). The `missing_pincodes`
   * flag is purely a column expression off the LEFT JOIN so it would
   * also work in a WHERE — kept in HAVING for symmetry / readability.
   */
  const [rows] = await pool.query(
    `
    SELECT e.efr_id,
           COALESCE(NULLIF(TRIM(e.efr_name), ''),
                    NULLIF(TRIM(CONCAT_WS(' ', e.efr_first_name, e.efr_last_name)), ''),
                    'Easyfixer') AS name,
           e.efr_no,
           (SELECT COUNT(*) FROM tbl_efr_deepskill_mapping m
             WHERE m.easyfixer_id = e.efr_id AND m.is_repairing = 1) = 0
             AS missing_skills,
           COALESCE(NULLIF(TRIM(p.pincodes), ''), '') = '' AS missing_pincodes
      FROM tbl_easyfixer e
      LEFT JOIN tbl_efr_serviceable_pincodes p ON p.easyfixer_id = e.efr_id
     WHERE e.efr_status = 1
       AND e.is_technician_verified = 1
       AND COALESCE(TRIM(e.efr_no), '') <> ''
    HAVING missing_skills = TRUE AND missing_pincodes = TRUE
     ORDER BY e.efr_id
    `,
  );

  const stats = {
    candidates: rows.length,
    sent: 0,
    failed: 0,
    took_ms: 0,
  };

  logger.info(
    `skill-pincode-reminder · run start · candidates=${stats.candidates}`,
  );

  for (const row of rows) {
    try {
      await profileUpdateLink.sendForEasyfixer(
        row.efr_id,
        { action: 'reminder' },
        null,        // actor: null — system-triggered, no human operator
        pool,
      );
      stats.sent += 1;
    } catch (err) {
      stats.failed += 1;
      logger.warn(
        { efrId: row.efr_id, err: err?.message || String(err) },
        'skill-pincode-reminder: send failed for easyfixer',
      );
    }
  }

  stats.took_ms = Date.now() - t0;

  logger.info(
    `skill-pincode-reminder · run done · candidates=${stats.candidates} · ` +
    `sent=${stats.sent} · failed=${stats.failed} · took_ms=${stats.took_ms}`,
  );

  return stats;
}

/*
 * Test send (2026-06-11). Mirrors the runTest pattern from
 * easyfixer-profile-reminder-cron.js but uses the profile-update
 * magic-link template instead of the generic completion nudge.
 *
 * Two modes:
 *   - sourceId omitted → mints a dummy JWT (efr_id=0) and a placeholder
 *     name ("Test Easyfixer"). Useful for verifying Gallabox template
 *     approval / connectivity without touching any real row.
 *   - sourceId provided → looks up that efr_id's display name + mints a
 *     real JWT for it. The WhatsApp link in the test message would land
 *     a tester on a working profile-update page for that easyfixer's
 *     data, which can be useful for QA. Read-only lookup; nothing on
 *     tbl_easyfixer is touched (no audit-column stamping for tests).
 *
 * The WhatsApp goes STRICTLY to the operator-supplied mobile — never to
 * the real easyfixer. Gallabox's NOTIFICATIONS_DISABLE + TEST_MOBILE env
 * intercepts still apply on top, so dev/staging can suppress entirely.
 */
async function runTest({ mobile, sourceId } = {}) {
  const phone = String(mobile || '').trim();
  const cleaned = phone.replace(/\D/g, '');
  if (!(cleaned.length === 10 || (cleaned.length === 12 && cleaned.startsWith('91')))) {
    throw Object.assign(new Error('Mobile must be a valid 10-digit Indian number.'), {
      status: 400, code: 'INVALID_TEST_MOBILE',
    });
  }

  let recipientName = 'Test Easyfixer';
  let sourceUsed = null;
  let efrId = 0;
  if (sourceId != null && String(sourceId).trim() !== '') {
    efrId = Number(String(sourceId).trim());
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

  // Build the SAME shape sendForEasyfixer would build — JWT + short URL.
  const token = signEasyfixerProfileToken(efrId);
  const base = (process.env.CRM_PUBLIC_BASE_URL || 'https://crm.easyfix.in').replace(/\/$/, '');
  const longUrl = `${base}/profile-update/${token}`;
  let shortUrl = longUrl;
  try {
    const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000); // match 30d JWT TTL
    const { short_url } = await urlShortener.shortenUrl(
      longUrl,
      { purpose: 'easyfixer_profile_update', expiresAt, createdBy: null },
      pool,
    );
    shortUrl = short_url;
  } catch (e) {
    logger.warn({ err: e?.message }, 'skill-pincode-reminder TEST: shorten failed, using long URL');
  }

  const res = await whatsappService.sendTemplate({
    to: phone,
    recipientName,
    templateName: TEMPLATE_NAME,
    bodyValues: { 1: recipientName, 2: String(efrId), 3: shortUrl },
  });

  logger.info(
    `skill-pincode-reminder TEST · target=${phone} · recipientName="${recipientName}" · ` +
    `efr_id=${sourceUsed?.efr_id ?? 'none'} · delivered=${!!res?.delivered}`,
  );

  return {
    test: true,
    target_mobile: phone,
    recipient_name: recipientName,
    source_used: sourceUsed,
    short_url: shortUrl,
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
