const logger = require('../logger');
// NOT destructured on purpose. `emailService.send(...)` is resolved at CALL
// time, which is what lets tests swap the sender without a DI seam in
// production code (the same trick tests/helpers/fake-pool uses on db.pool).
const emailService = require('./email.service');

/*
 * ══════════════════════════════════════════════════════════════════════════
 *  "Your EasyFix account is ready" — the credential mail for a NEW CRM user.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * THE GAP THIS CLOSES
 * ───────────────────
 * services/entra-provisioning.service.js mints a 20-char CSPRNG temp password,
 * hands it to Microsoft Graph inside the POST /users body, and drops it. That
 * was deliberate and safe — but it also meant NOBODY could sign in to the
 * mailbox that had just been paid for: the password existed for the duration of
 * one HTTP request and then ceased to exist anywhere. An operator's only route
 * was to reset it by hand in the M365 admin centre, which nobody knew to do.
 * This service is the one and only consumer of that password.
 *
 * WHEN IT SENDS — the single hard gate
 * ────────────────────────────────────
 * ONLY when the provisioning outcome reports `mailboxReady === true`, i.e. the
 * directory account exists AND a licence was assigned. An Entra account without
 * a licence has NO mailbox (Exchange Online never provisions one), so mailing
 * "here are your Outlook and Teams credentials" for it would be actively
 * misleading: neither product would work. That is not hypothetical — user 8737
 * landed on licence_status = 'no_seats_available'. In that state we send
 * NOTHING and let the existing tbl_user_entra_provisioning row plus the amber
 * "mailbox is NOT ready" toast carry the failure, exactly as they do today.
 *
 * PASSWORD HANDLING — non-negotiable
 * ──────────────────────────────────
 * `tempPassword` arrives as a plain argument, goes into the message body, and
 * is never seen again. It is NEVER logged (no logger line in this file
 * interpolates it, on any path including errors), NEVER persisted to any table,
 * and NEVER placed on the returned outcome object — the outcome rides back on
 * the HTTP create response, so anything on it is published. Every field this
 * module returns is enumerated in the MAIL_STATUS/`outcome` shape below and
 * `password` is not among them.
 *
 * FAIL-SOFT
 * ─────────
 * A mail failure must never fail (or roll back) user creation. Nothing here
 * throws; every path resolves to an outcome object the caller reports verbatim.
 *
 * TEST/QA SAFETY
 * ──────────────
 * We go through services/email.service.js, so NOTIFICATIONS_DISABLE
 * short-circuits BEFORE any network call and TEST_EMAILS redirects the whole
 * message (dropping cc) — a QA host can never mail a real person's PERSONAL
 * address. We do not re-implement either rule here; re-implementing it is how
 * the two copies drift.
 */

/*
 * Who gets copied on the credential mail: HR, always.
 *
 * WAS A PROPERTY UNTIL 2026-08-03 (`user.welcome.cc.emails`, seeded
 * 'hr@easyfix.in'). The indirection is gone and the key is deleted. A flag
 * nobody ever changes is not configurability — it is just one more way for the
 * value to go MISSING. Ops asked for hr@easyfix.in, hr@easyfix.in is what they
 * want, and the only realistic states of a never-touched property row are
 * "correct" and "absent"; the second one silently drops the copy HR is relying
 * on to re-share sign-in details when a new joiner misses the mail, and nothing
 * anywhere would report that it had happened.
 *
 * That is not a hypothetical failure mode in this repo. The precedent is one
 * module over: `entra.provisioning.enabled` unset meant mailbox provisioning
 * was silently OFF for EVERY user — the feature looked shipped and did nothing,
 * because an unset property reads as "no" and no one is told. Same class of
 * bug, and the fix for a value that is genuinely constant is to make it a
 * constant. If HR's address ever changes, this is a one-line diff plus the
 * tests that pin it, which is the honest cost of the change.
 */
const WELCOME_MAIL_CC = 'hr@easyfix.in';

/*
 * Outcome vocabulary. Surfaced on POST /api/admin/users so the UI can say what
 * happened without the operator opening a log.
 */
const MAIL_STATUS = Object.freeze({
  SENT:    'sent',      // Graph accepted it (202 = queued; see email.service)
  SKIPPED: 'skipped',   // deliberately not sent — `reason` says why
  FAILED:  'failed',    // we tried and it did not go out — `reason` says why
  PENDING: 'pending',   // provisioning outran the inline deadline; still running
});

/*
 * CC recipients — always exactly [WELCOME_MAIL_CC], with ONE exception.
 *
 * Normalisation is unchanged from the property era: trimmed and lowercased, so
 * the address on the envelope is byte-identical however it was written. It came
 * back as a Set before, which de-duplicated a comma-separated list; a single
 * constant leaves nothing to de-duplicate WITHIN the list, so the only
 * collision still reachable is with the `to`.
 *
 * SELF-CC: if the user's own personal address IS hr@easyfix.in — someone in HR
 * booked against the shared inbox is the obvious case — return [] rather than
 * putting one mailbox on both lines. Two copies of a live temporary password in
 * one inbox is noise at best, and Graph will happily deliver both. Compared
 * case-insensitively after trimming, which is what the normalisation above is
 * for.
 *
 * NO PROPERTY READ, so this can neither throw nor return "no CC" by accident:
 * an absent easyfix_properties row — or an empty properties table entirely — is
 * simply no longer an input. It could not throw before either, and that must
 * hold, because sendWelcomeMail's fail-soft contract depends on nothing between
 * GATE 3 and the send being able to blow up.
 *
 * @param {string} [recipientEmail] the `to`; pass it to get the self-CC guard.
 */
function ccRecipients(recipientEmail) {
  const to = String(recipientEmail || '').trim().toLowerCase();
  return to === WELCOME_MAIL_CC ? [] : [WELCOME_MAIL_CC];
}

/*
 * Where the CRM lives, per environment: CRM_PUBLIC_BASE_URL wins, then
 * MAGIC_LINK_BASE_URL — the SAME chain every other link-producing call site in
 * this repo uses (easyfixer-profile-update-link.service.js:222,
 * easyfixer-skill-pincode-reminder-cron.js:227, routes/admin/easyfixers.js:734).
 *
 * ⚠ NOT CRM_URL. That variable is the CORS ORIGIN ALLOWLIST: cors.js:46 feeds it
 * through splitOrigins(), so it is legitimately COMMA-SEPARATED, and the
 * checked-in .env sets it to http://localhost:5180 with no CRM_PUBLIC_BASE_URL
 * at all. Using it here put "EasyFix CRM - http://localhost:5180" — or a
 * two-host CSV — into a new joiner's very first mail.
 *
 * If NEITHER is set we return null and the mail simply omits the link rather
 * than guessing a host — a QA box that guessed the production URL would send a
 * brand-new joiner to the wrong system on their first day. The first entry is
 * taken and the trailing slash stripped, so a value that has picked up a
 * comma-separated habit still yields one usable origin.
 */
function crmSignInUrl() {
  const raw = String(process.env.CRM_PUBLIC_BASE_URL || process.env.MAGIC_LINK_BASE_URL || '').trim();
  if (!raw) return null;
  const first = raw.split(',')[0].trim();
  return first ? first.replace(/\/+$/, '') : null;
}

/*
 * Compose the message. PURE — no env reads, no property reads, no I/O — so the
 * unit tests can assert the exact wording (and, in the guard test, that the
 * password appears in the body and NOWHERE else).
 *
 * Plain text only. services/email.service.js wraps `text` into an HTML
 * paragraph and HTML-escapes it on the way, so a name or password containing
 * <, > or & renders correctly and cannot inject markup. Operator-grade prose,
 * no marketing.
 *
 * The CRM paragraph is the important one: CRM sign-in is OTP-based and does
 * NOT use this password. Leaving that implicit is the obvious support ticket,
 * so it is stated outright.
 *
 * The OTP is described as arriving BY EMAIL only. The backend can also deliver
 * it to a registered mobile, but mentioning both here would be wrong for the
 * reader: mobile is now optional on Add User, so a new joiner may not have one,
 * and telling someone to expect an SMS that never comes is worse than telling
 * them one channel that always works. Their official mailbox is guaranteed to
 * exist — this mail is only sent once it does.
 */
function composeWelcomeMail({ userName, officialEmail, tempPassword, crmUrl } = {}) {
  const name = String(userName || '').trim();
  const email = String(officialEmail || '').trim();
  const greeting = name ? `Hi ${name},` : 'Hi,';

  const lines = [
    greeting,
    '',
    'Your EasyFix Microsoft 365 account has been created and licensed, so your',
    'mailbox is live.',
    '',
    `Sign-in address:     ${email}`,
    `Temporary password:  ${tempPassword}`,
    '',
    'You MUST change this password the first time you sign in. The account is set',
    'to require a password change at first sign-in, so you will be prompted for it.',
    '',
    'Where these details work:',
    '  Outlook (email) - https://outlook.office.com',
    '  Teams           - https://teams.microsoft.com',
    '',
    'EasyFix CRM' + (crmUrl ? ` - ${crmUrl}` : ''),
    '  The CRM does NOT use the password above. Signing in to the CRM sends a',
    `  one-time password (OTP) to your official email (${email}).`,
    '  Enter that OTP - there is no password field.',
    '',
    'Keep this mail until you have signed in and set your own password.',
    '',
    'EasyFix IT',
  ];

  return {
    subject: `Your EasyFix account is ready${name ? ` - ${name}` : ''}`,
    text: lines.join('\n'),
  };
}

/**
 * Send the credential mail for a freshly created CRM user.
 *
 * NEVER throws. Returns the outcome, which the create response carries next to
 * the provisioning outcome:
 *
 *   { status, reason, to?, cc? }
 *
 * `to` / `cc` are echoed so an operator can see where it went; the password is
 * NOT part of this object and must never be added to it.
 *
 * @param {Object}  args
 * @param {number}  args.userId
 * @param {string}  args.userName        tbl_user.user_name
 * @param {string}  args.officialEmail   tbl_user.official_email (the UPN)
 * @param {string}  args.personalEmail   tbl_user_personal_details.personal_email
 * @param {string}  args.tempPassword    the ONE temp password, held locally by
 *                                       the caller for the life of the request
 * @param {Object}  args.provisioning    outcome from provisionUserMailbox()
 */
async function sendWelcomeMail({
  userId, userName, officialEmail, personalEmail, tempPassword, provisioning,
} = {}) {
  const uid = Number(userId) || null;

  // ── GATE 1: the mailbox must genuinely exist. ──────────────────────────
  // account created AND licence assigned. Anything else (feature off, no free
  // seat, unmanaged domain, Graph failure) sends NOTHING.
  if (!provisioning || provisioning.mailboxReady !== true) {
    const why = provisioning
      ? `mailbox is not ready (account=${provisioning.accountStatus} · licence=${provisioning.licenceStatus})`
      : 'no provisioning outcome';
    logger.info('Welcome mail skipped · userId=' + uid + ' · ' + why);
    return { status: MAIL_STATUS.SKIPPED, reason: why };
  }

  // ── GATE 2: somewhere to send it. ──────────────────────────────────────
  const to = String(personalEmail || '').trim();
  if (!to) {
    const why = 'no personal email on record for this user';
    logger.warn('Welcome mail skipped · userId=' + uid + ' · ' + why);
    return { status: MAIL_STATUS.SKIPPED, reason: why };
  }

  /*
   * ── GATE 3: we must actually HOLD a password to share. ────────────────
   * mailboxReady is also true for an account that ALREADY existed and was
   * already licensed (the idempotent re-run path) — in that case provisioning
   * minted nothing and the real password is whatever the user already has. We
   * refuse to send a credential mail with no credential in it, and say so.
   */
  if (!tempPassword) {
    const why = 'no temporary password was issued (the directory account already existed) '
      + '- reset it from the Microsoft 365 admin centre and share it manually';
    logger.warn('Welcome mail skipped · userId=' + uid + ' · ' + why);
    return { status: MAIL_STATUS.SKIPPED, reason: why };
  }

  // `to` is passed so an HR joiner whose personal address IS the CC address is
  // not copied on their own mail.
  const cc = ccRecipients(to);
  const { subject, text } = composeWelcomeMail({
    userName, officialEmail, tempPassword, crmUrl: crmSignInUrl(),
  });

  try {
    /*
     * NOTIFICATIONS_DISABLE and TEST_EMAILS are honoured INSIDE send() — the
     * former short-circuits before any network call, the latter redirects the
     * whole message away from the real personal address. We do not duplicate
     * either check here.
     */
    const res = await emailService.send({
      to,
      cc: cc.length ? cc : undefined,
      subject,
      text,
      category: 'transactional',
      /*
       * The ONE caller that opts out of the Sent-Items copy. This body carries a
       * LIVE temporary password and the sender is a shared IT-helpdesk mailbox
       * (MS_GRAPH_SENDER_EMAIL) that nobody prunes — a permanent copy there is a
       * working credential retrievable by anyone with delegated access, for as
       * long as the user has not completed the forced first sign-in. The two
       * intended copies are the user's own inbox and the HR CC.
       */
      saveToSentItems: false,
    });

    if (res && res.disabled) {
      logger.info('Welcome mail suppressed (NOTIFICATIONS_DISABLE) · userId=' + uid);
      return { status: MAIL_STATUS.SKIPPED, reason: 'notifications are disabled on this host', to, cc };
    }
    if (res && res.accepted) {
      logger.info('Welcome mail queued · userId=' + uid + ' · to=' + to
        + (cc.length ? ' · cc=' + cc.join(',') : '')
        + (res.redirected ? ' · redirected (TEST_EMAILS)' : ''));
      return { status: MAIL_STATUS.SENT, reason: 'accepted for delivery', to, cc };
    }

    const reason = (res && res.error) || 'the mail service did not accept the message';
    // NOTE: `reason` comes from email.service and never contains the body.
    logger.warn('Welcome mail FAILED · userId=' + uid + ' · to=' + to + ' · ' + reason);
    return { status: MAIL_STATUS.FAILED, reason, to, cc };
  } catch (e) {
    // Belt-and-braces: send() is already try/caught internally, so reaching
    // here means a future edit broke that promise. Fail SOFT — the user exists.
    logger.warn('Welcome mail FAILED · userId=' + uid + ' · to=' + to + ' · ' + e.message);
    return { status: MAIL_STATUS.FAILED, reason: e.message, to, cc };
  }
}

module.exports = {
  sendWelcomeMail,
  // pure / config helpers — unit-tested
  composeWelcomeMail,
  ccRecipients,
  crmSignInUrl,
  MAIL_STATUS,
  WELCOME_MAIL_CC,
};
