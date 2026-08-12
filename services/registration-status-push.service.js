const logger = require('../logger');
const pushDelivery = require('./push-delivery.service');
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
 * Token routing + the send/prune loop live in push-delivery.service.js (the
 * one shared delivery layer); this module only re-derives the authoritative
 * status when neither authoritative status is supplied, builds the message,
 * and shapes the return.
 *
 * Best-effort by contract: swallows its own errors and resolves — a push
 * failure must NEVER break the CRM status update that triggered it.
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
  ACTIVE:               'Your profile is active — open EasyFix to continue.',
  PAUSED:               'Your profile is paused — open EasyFix to review the next steps.',
  INACTIVE:             'Your profile is inactive — open EasyFix for details.',
  REAPPLIED:            'Your re-application was received and is awaiting review.',
  APPLICATION_REJECTED: 'There is an update on your application — open EasyFix for details.',
  BLACKLISTED:          'There is an important update on your EasyFix profile.',
  DORMANT:              'Your profile is dormant — open EasyFix to review the next steps.',
  SUSPENDED:            'Your profile is temporarily suspended — open EasyFix for details.',
  VERIFICATION_REJECTED:'Your verification needs attention — open EasyFix to review it.',
  UNDER_VERIFICATION:   'Your details are under review — open EasyFix to track your status.',
};

function bodyForStatus(status) {
  return STATUS_COPY[status] || 'There is an update on your EasyFix profile — please open the app.';
}

function shouldDeriveStatus(opts = {}) {
  // Either status field is enough for the data-only invalidation contract: the
  // app always refreshes registration status on receipt. Lifecycle transitions
  // already own lifecycleStatus, so re-reading the full gate would add a query
  // per push (and amplify cron load) without changing client behaviour.
  return !opts.status && !opts.lifecycleStatus;
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
    logger.info('Notify registration status changed · efr=' + efrId + ' · status=' + (opts.status || 'derive'));
    if (!efrId) return { delivered: false, reason: 'no efrId' };

    let status = opts.status;
    let lifecycleStatus = opts.lifecycleStatus;
    if (shouldDeriveStatus(opts)) {
      try {
        const gate = await registrationService.getStatus(efrId);
        if (!status) status = gate && gate.status;
        if (!lifecycleStatus) lifecycleStatus = gate?.lifecycle?.status || null;
      } catch (e) {
        // Couldn't derive — still send a generic refresh nudge with no status.
        logger.warn({ efrId, err: e.message }, 'registration-push: status re-derive failed; sending generic refresh');
        status = null;
      }
    }

    const data = { type: 'registration_status' };
    if (status) data.status = String(status);
    if (lifecycleStatus) data.lifecycleStatus = String(lifecycleStatus);
    if (opts.event) data.event = String(opts.event);

    const r = await pushDelivery.deliverToEfr(
      efrId,
      {
        title: opts.title || 'EasyFix',
        body: opts.body || bodyForStatus(lifecycleStatus || status),
        data,
      },
      { channel: 'registration-status', label: `registration-status · efr=${efrId} · status=${lifecycleStatus || status || 'n/a'}` },
    );

    if (r.reason === 'no tokens') {
      logger.info({ efrId, status }, 'registration-push: no device tokens — skipping');
      return { delivered: false, reason: 'no tokens', status, lifecycleStatus };
    }
    return { delivered: r.delivered, deliveredCount: r.deliveredCount, tokenCount: r.tokenCount, status, lifecycleStatus };
  } catch (e) {
    // Absolute backstop — this function is called best-effort from CRM
    // status writes and must never throw into the caller.
    logger.warn({ efrId, err: e.message }, 'registration-push: notify failed (swallowed)');
    return { delivered: false, error: e.message };
  }
}

module.exports = {
  notifyRegistrationStatusChanged,
  // Back-compat shim (dual-source per-efr resolver moved to push-delivery).
  resolveTokens: pushDelivery.resolveTokensForEfr,
  _internals: { bodyForStatus, shouldDeriveStatus },
};
