const { pool } = require('../db');
const logger = require('../logger');
const fcmService = require('./fcm.service');
const registrationService = require('./mobile-registration.service');

/*
 * Registration-status push — fires an FCM data-push to a technician's
 * device(s) whenever the CRM changes a column that alters the result of
 * GET /api/mobile/registration/status (lead accept/deny, identity
 * verify/reject, final activation). The RN app already listens for a
 * foreground push whose data payload is { type: "registration_status" }
 * and re-fetches its onboarding gate on receipt, so this lets the app
 * react instantly instead of polling.
 *
 * Token resolution — TWO sources, unioned + deduped:
 *   1. tbl_easyfixer_app.device_id — the CANONICAL per-technician push
 *      target. Legacy EasyFix_API targeted exactly this column
 *      (Easyfixer @Column(name="device_id", table="tbl_easyfixer_app") →
 *      EasyfixAPIUtils.sendNotification(notification, easyfixer.getDeviceId())).
 *   2. device_info.fire_base_token (is_logged_in='1') — what THIS Node
 *      backend actually writes today on verify-otp + POST /mobile/device.
 *      Read keyed by user_id = efr_id (same key the upsert uses).
 *
 * Reading both keeps fan-out correct during the window where some rows
 * only have a device_info token (older logins) and others have the
 * canonical tbl_easyfixer_app.device_id populated by the additive write
 * added to routes/mobile/index.js.
 *
 * Best-effort by contract: every public function swallows its own errors
 * and resolves — a push failure must NEVER break the CRM status update
 * or any request that triggered it.
 */

// Short, user-facing copy per derived status. Title is always "EasyFix".
// Statuses with no entry get a generic "profile updated" nudge — the data
// payload (type + status) is what actually drives the app re-fetch, so the
// visible text is secondary.
const STATUS_COPY = {
  active:               'Your profile has been approved — open the app to start accepting jobs.',
  rejected:             'Your verification needs attention — open the app to review and resubmit.',
  not_eligible:         'There is an update on your registration — please open the app.',
  under_verification:   'Your details are under review — open the app to track your status.',
  verification_pending: 'Almost there — your profile is awaiting final activation.',
  training_pending:     'Please complete your training — open the app to continue.',
  in_progress:          'Your registration has an update — open the app to continue.',
  personal_pending:     'Please complete your registration — open the app to continue.',
};

function bodyForStatus(status) {
  return STATUS_COPY[status] || 'There is an update on your EasyFix profile — please open the app.';
}

/*
 * Resolve the set of FCM tokens for a technician. Returns a deduped array
 * of non-empty token strings. Never throws — on any DB error logs + returns
 * whatever was gathered (possibly []).
 */
async function resolveTokens(efrId) {
  const tokens = new Set();

  // 1) Canonical: tbl_easyfixer_app.device_id (one row per technician).
  try {
    const [[appRow]] = await pool.query(
      'SELECT device_id FROM tbl_easyfixer_app WHERE efr_id = ? LIMIT 1',
      [efrId],
    );
    const t = appRow && appRow.device_id ? String(appRow.device_id).trim() : '';
    if (t) tokens.add(t);
  } catch (e) {
    logger.warn({ efrId, err: e.message }, 'registration-push: tbl_easyfixer_app token lookup failed');
  }

  // 2) Active device_info rows (the token this backend writes on login).
  //    user_id holds the efr_id for technicians (see verify-otp upsert).
  try {
    const [rows] = await pool.query(
      `SELECT fire_base_token
         FROM device_info
        WHERE user_id = ? AND is_logged_in = '1' AND fire_base_token IS NOT NULL`,
      [efrId],
    );
    for (const r of rows) {
      const t = r.fire_base_token ? String(r.fire_base_token).trim() : '';
      if (t) tokens.add(t);
    }
  } catch (e) {
    logger.warn({ efrId, err: e.message }, 'registration-push: device_info token lookup failed');
  }

  return Array.from(tokens);
}

/*
 * Clear a token FCM has reported as NotRegistered / InvalidRegistration from
 * BOTH token stores so fan-out stops targeting a dead device. Scoped to the
 * technician so it never touches another user's rows. Best-effort — never throws.
 */
async function pruneDeadToken(efrId, token) {
  if (!efrId || !token) return;
  try {
    await pool.query(
      "UPDATE device_info SET fire_base_token = NULL, is_logged_in = '0' WHERE user_id = ? AND fire_base_token = ?",
      [efrId, token],
    );
    await pool.query(
      'UPDATE tbl_easyfixer_app SET device_id = NULL WHERE efr_id = ? AND device_id = ?',
      [efrId, token],
    );
    logger.push(`registration-status · pruned dead token · efr=${efrId}`);
  } catch (e) {
    logger.warn({ efrId, err: e.message }, 'registration-push: dead-token prune failed');
  }
}

/*
 * Notify a technician that their registration/verification status changed.
 * Re-derives the CURRENT status via the same getStatus() the mobile gate
 * endpoint uses, so the pushed `status` is always authoritative (never a
 * stale value computed before the DB write committed). Pass the freshly
 * computed status in `opts.status` to skip the re-derive if the caller
 * already has it.
 *
 * Fire-and-forget: returns a summary object, never rejects.
 */
async function notifyRegistrationStatusChanged(efrId, opts = {}) {
  try {
    if (!efrId) return { delivered: false, reason: 'no efrId' };

    let status = opts.status;
    if (!status) {
      try {
        const gate = await registrationService.getStatus(efrId);
        status = gate && gate.status;
      } catch (e) {
        // Couldn't derive — still send a generic refresh nudge with no status.
        logger.warn({ efrId, err: e.message }, 'registration-push: status re-derive failed; sending generic refresh');
        status = null;
      }
    }

    const tokens = await resolveTokens(efrId);
    if (!tokens.length) {
      logger.info({ efrId, status }, 'registration-push: no device tokens — skipping');
      return { delivered: false, reason: 'no tokens', status };
    }

    const data = { type: 'registration_status' };
    if (status) data.status = String(status);

    const results = await Promise.all(
      tokens.map(async (token) => {
        const r = await fcmService
          .sendPush({ token, title: 'EasyFix', body: bodyForStatus(status), data })
          .catch((e) => ({ delivered: false, error: e.message }));
        // Prune tokens FCM reports as permanently dead so we stop re-pushing to
        // them on every status change. Skip when the send was redirected to a
        // test device — that dead signal is about the test token, not the real one.
        if (r && r.deadToken && !r.redirected) await pruneDeadToken(efrId, token);
        return r;
      }),
    );

    const deliveredCount = results.filter((r) => r && r.delivered).length;
    logger.push(`registration-status · efr=${efrId} · status=${status || 'n/a'} · ${deliveredCount}/${tokens.length} devices`);
    return { delivered: deliveredCount > 0, deliveredCount, tokenCount: tokens.length, status };
  } catch (e) {
    // Absolute backstop — this function is called best-effort from CRM
    // status writes and must never throw into the caller.
    logger.warn({ efrId, err: e.message }, 'registration-push: notify failed (swallowed)');
    return { delivered: false, error: e.message };
  }
}

module.exports = {
  notifyRegistrationStatusChanged,
  resolveTokens,
};
