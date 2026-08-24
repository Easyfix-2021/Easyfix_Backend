/*
 * easyfixer-sensitive-change.service.js — CRM-side changes to the two
 * technician fields that are worth attacking, plus the audit trail they write.
 *
 *   • MOBILE (tbl_easyfixer.efr_no)  — this IS the login identity. The
 *     technician app resolves an account by this number
 *     (services/tech-auth.service.js::resolveByEfrNo), so changing it changes
 *     who can log in as this technician. Account takeover.
 *   • BANK   (tbl_easyfixer_bank_details) — this is where the technician's
 *     money lands. Payment redirection.
 *
 * Both write `tbl_easyfixer_sensitive_change_log`
 * (migrations/2026-08-17-easyfixer-sensitive-change-log.sql).
 *
 * NOTHING IS RE-IMPLEMENTED HERE.
 *   • Bank verification is services/mobile-kyc.service.js::bankVerify — the
 *     SAME aadhaarkyc.io call the technician app makes for a first-time bank
 *     addition. Reusing it means the CRM path and the app path are verified
 *     identically BY CONSTRUCTION, not by two implementations agreeing today.
 *   • OTP is services/easyfixer-profile-otp.service.js (4-digit code over
 *     Gallabox WhatsApp, stored on tbl_easyfixer.profile_update_otp).
 *   • The bank row is written with the SAME column set the app writes
 *     (routes/mobile/index.js POST /bank-details).
 *
 * CLOCKS: the legacy columns on tbl_easyfixer / tbl_easyfixer_bank_details
 * keep the clock their existing writers use (SQL NOW(), per
 * services/easyfixer-verification.service.js). The NEW audit table is written
 * app-side as new Date(), which the pool's +05:30 session timezone stores as
 * the IST wall clock verbatim. Two clocks, each consistent with its own
 * table's other writers — the same split documented in
 * migrations/executed/2026-08-04-create-tbl-job-conference.sql.
 */

'use strict';

const { pool } = require('../db');
const logger = require('../logger');
const kyc = require('./mobile-kyc.service');
const profileOtp = require('./easyfixer-profile-otp.service');
const { getProperty } = require('./properties.service');
const { matchNames } = require('../utils/name-match');

const SOURCE_CRM = 'crm';
const SOURCE_APP = 'app';
const CHANGE_MOBILE = 'mobile';
const CHANGE_BANK = 'bank';

/*
 * Does a CRM-initiated bank change still require the technician's OTP?
 *
 * DEFAULT NO. An operator making the change on the technician's behalf does
 * not have the technician sitting next to them, so demanding a WhatsApp OTP
 * blocks the very flow the CRM exists to serve (correcting a payout account
 * the technician cannot fix themselves).
 *
 * Kept as a flag rather than deleted so it can be re-tightened without a
 * deploy if finance wants the stricter posture back — same shape as
 * services/easyfixer-profile-update-link.service.js::otpEnabled(), which is
 * the house pattern for exactly this toggle.
 *
 * The APP path has its OWN flag — see appOtpRequired below.
 */
function crmOtpRequired() {
  return String(getProperty('bank.change.crm.otp.required') ?? 'false')
    .trim().toLowerCase() === 'true';
}

/*
 * Does an APP-initiated bank change require the technician's OTP?
 *
 * DEFAULT NO — and ONLY because of client rollout, not because the consent is
 * optional. This gate is meant to be ON.
 *
 * THE ROLLOUT PROBLEM THIS SOLVES. Every technician app already installed
 * predates the OTP and sends no `otp` field. The bank form is reachable in
 * production at withdrawal time (BankDetailsForm), so the moment this backend
 * ships with a hard requirement, every one of those installs starts failing
 * its bank save with a 400 — on the money path, with no way for the technician
 * to understand why. `/public/app-version` for the RN app is FAIL-OPEN, so
 * nobody is forced onto a build that would send the code.
 *
 * WHAT IS STILL ENFORCED WITH THE FLAG OFF — and this is the important part:
 *   • The vendor verification is UNCONDITIONAL. A non-existent account is
 *     still a 422, and the caller can no longer assert `isVerified` itself.
 *     The trust-boundary hole is closed regardless of this flag.
 *   • An OTP that IS supplied is still verified. A new build submitting a
 *     wrong or expired code is rejected exactly as if the flag were on; the
 *     flag only decides whether an ABSENT code is tolerated.
 * So the flag buys old clients a working save, and buys nothing for an
 * attacker that they did not already have before this change.
 *
 * FLIP IT ON once the new build is the floor — the one-line UPDATE is in
 * migrations/2026-08-24-bank-change-app-otp-rollout.sql.
 */
function appOtpRequired() {
  return String(getProperty('bank.change.app.otp.required') ?? 'false')
    .trim().toLowerCase() === 'true';
}

/**
 * Last-four-only rendering of an account number, e.g. "••••4471".
 *
 * Applied inside recordChange() rather than at the call sites, so that a
 * future caller cannot put a full account number into the log by forgetting
 * to mask — the log CANNOT hold one.
 */
function maskAccount(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return null;
  return `••••${digits.slice(-4)}`;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/**
 * Append one row to tbl_easyfixer_sensitive_change_log.
 *
 * @param {object} entry
 * @param {number} entry.efrId
 * @param {'mobile'|'bank'} entry.changeType
 * @param {string|null} entry.oldValue          — full for 'mobile', masked here for 'bank'
 * @param {string|null} entry.newValue          — ditto
 * @param {number|null} entry.changedByUserId   — tbl_user.user_id when ops did it
 * @param {'crm'|'app'} entry.changedBySource
 * @param {string|null} entry.reason
 * @param {string|null} entry.verificationResult
 * @param {boolean|number} entry.otpVerified
 * @param {string|null} entry.ipAddress
 * @param {object} [conn]  — optional mysql2 connection so the row joins the
 *                           caller's transaction. Defaults to the pool.
 * @returns {Promise<{logged: boolean}>}  — NEVER rejects.
 *
 * ⚠ THIS FUNCTION NEVER THROWS INTO THE CALLER'S HAPPY PATH, and the
 * trade-off is deliberate.
 *
 * Losing an audit row is bad. Rolling back a bank change the operator has
 * already been told succeeded is worse: the operator walks away believing the
 * technician's payout account is updated, the payout goes to the OLD account,
 * and the failure is invisible until money lands in the wrong place. Between
 * "the change happened but we failed to write the note" and "the note decided
 * whether the change happened", the first is recoverable from the application
 * log and the second is not.
 *
 * So a logging failure is logged at ERROR — loudly, with everything needed to
 * reconstruct the row by hand — and swallowed. Alert on that log line; it
 * means the audit trail has a hole in it that someone must fill manually.
 *
 * (Inside a transaction this is safe in the ordinary case: a failed statement
 * in MySQL does not abort the surrounding transaction, so the caller's commit
 * still lands. A deadlock or lock-wait timeout DOES roll the transaction back
 * — in that case the caller's commit fails too and the operator correctly
 * sees an error, which is the right outcome.)
 */
async function recordChange(entry, conn) {
  const db = conn || pool;
  const isBank = entry.changeType === CHANGE_BANK;
  // Bank account numbers are masked HERE — see the migration header for why
  // this log must not become a second copy of the payment instructions.
  const oldValue = isBank ? maskAccount(entry.oldValue) : (entry.oldValue ?? null);
  const newValue = isBank ? maskAccount(entry.newValue) : (entry.newValue ?? null);

  try {
    await db.query(
      `INSERT INTO tbl_easyfixer_sensitive_change_log
         (efr_id, change_type, old_value, new_value, changed_by_user_id,
          changed_by_source, reason, verification_result, otp_verified,
          ip_address, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(entry.efrId),
        entry.changeType,
        oldValue,
        newValue,
        entry.changedByUserId ?? null,
        entry.changedBySource || SOURCE_CRM,
        entry.reason ?? null,
        entry.verificationResult ?? null,
        entry.otpVerified ? 1 : 0,
        entry.ipAddress ?? null,
        new Date(),
      ],
    );
    logger.info(
      'Sensitive change logged · efrId=' + entry.efrId + ' · type=' + entry.changeType,
    );
    return { logged: true };
  } catch (err) {
    // Everything needed to reconstruct the row by hand goes in this line —
    // EXCEPT the values themselves for a bank change, which are already
    // masked above and stay masked here.
    logger.error(
      {
        efrId: entry.efrId,
        changeType: entry.changeType,
        oldValue,
        newValue,
        changedByUserId: entry.changedByUserId ?? null,
        changedBySource: entry.changedBySource || SOURCE_CRM,
        otpVerified: entry.otpVerified ? 1 : 0,
        err: err.message,
      },
      'AUDIT WRITE FAILED — sensitive easyfixer change applied but NOT logged. '
      + 'Reconstruct this row in tbl_easyfixer_sensitive_change_log by hand.',
    );
    return { logged: false };
  }
}

// ─── Mobile ─────────────────────────────────────────────────────────

/**
 * Change tbl_easyfixer.efr_no.
 *
 * @param {number} efrId
 * @param {{mobile: string, reason: string}} body
 * @param {object} actor            — req.user (tbl_user row)
 * @param {{ipAddress?: string, db?: object}} [ctx]
 */
async function changeMobile(efrId, body, actor, ctx = {}) {
  const db = ctx.db || pool;
  const mobile = String(body.mobile).trim();
  logger.info('Change easyfixer mobile · efrId=' + efrId);

  const [[current]] = await db.query(
    'SELECT efr_id, efr_no FROM tbl_easyfixer WHERE efr_id = ? LIMIT 1',
    [efrId],
  );
  if (!current) throw httpError(404, 'easyfixer not found');

  /*
   * DUPLICATE GUARD — 409, and it is not optional.
   *
   * efr_no is the technician's LOGIN IDENTITY: tech-auth resolves an account
   * by mobile alone. Two easyfixer rows carrying the same number therefore
   * collapse into one login — whoever holds the SIM lands on whichever row
   * that lookup's tie-breaker picks (verified first, then active, then
   * newest), which may be someone else's record entirely, complete with their
   * jobs and their wallet.
   *
   * Deliberately NOT filtered on efr_status. An INACTIVE duplicate still
   * collides, because identity resolution ignores status by design (see the
   * docblock on services/tech-auth.service.js::resolveByEfrNo) — filtering
   * here would let us hand out a number that still resolves at login.
   */
  const [[clash]] = await db.query(
    'SELECT efr_id FROM tbl_easyfixer WHERE efr_no = ? AND efr_id <> ? LIMIT 1',
    [mobile, efrId],
  );
  if (clash) {
    logger.warn(
      'Change easyfixer mobile rejected · efrId=' + efrId
      + ' · number already held by efrId=' + clash.efr_id,
    );
    throw httpError(
      409,
      `this mobile number is already registered to easyfixer #${clash.efr_id}`,
    );
  }

  const oldValue = current.efr_no == null ? null : String(current.efr_no);
  if (oldValue === mobile) {
    // No-op. Writing an audit row for "changed X to X" only adds noise to the
    // one table an investigator needs to be able to read quickly.
    logger.info('Change easyfixer mobile skipped · efrId=' + efrId + ' · unchanged');
    return { efr_id: Number(efrId), efr_no: mobile, changed: false };
  }

  await db.query(
    'UPDATE tbl_easyfixer SET efr_no = ?, updated_by = ?, update_date = NOW() WHERE efr_id = ?',
    [mobile, actor?.user_id ?? null, efrId],
  );

  await recordChange({
    efrId,
    changeType: CHANGE_MOBILE,
    oldValue,
    newValue: mobile,
    changedByUserId: actor?.user_id ?? null,
    changedBySource: SOURCE_CRM,
    reason: body.reason,
    verificationResult: null,
    // Always 0 on this path, and that is the product decision, not a gap —
    // see the route comment on PATCH /:id/mobile.
    otpVerified: 0,
    ipAddress: ctx.ipAddress ?? null,
  }, db);

  logger.info('Easyfixer mobile changed · efrId=' + efrId);
  return { efr_id: Number(efrId), efr_no: mobile, changed: true };
}

// ─── Bank ───────────────────────────────────────────────────────────

/**
 * Resolve a bank display name to the numeric `bank` FK
 * (tbl_easyfixer_bank_details.bank → bank_name.id), the same id the app sends
 * as `bankId`. An unresolvable name yields null, which leaves the stored
 * `bank` untouched (COALESCE below) rather than blanking a good value.
 */
async function resolveBankId(db, bankName) {
  const name = String(bankName ?? '').trim();
  if (!name) return null;
  const [[row]] = await db.query(
    'SELECT id FROM bank_name WHERE bank_name = ? LIMIT 1',
    [name],
  );
  return row ? row.id : null;
}

/**
 * Change the technician's payout account.
 *
 * ORDER OF OPERATIONS — IT MATTERS:
 *   1. Verify the OTP. The technician consents BEFORE anything else happens;
 *      this is the only step that involves the person whose money it is.
 *   2. Verify the NEW account with the vendor. A typo'd or non-existent
 *      account must never reach the DB, because a payout to it fails silently
 *      days later.
 *   3. Only then write tbl_easyfixer_bank_details.
 *   4. Record the audit row with the vendor's result.
 * Steps 3 and 4 share ONE transaction so the row and its audit land together.
 *
 * A failure at 1 or 2 writes NOTHING — no partial bank row, no audit row for
 * a change that did not happen.
 *
 * ⚠ The OTP is consumed by step 1 whether or not step 2 succeeds (verifyOtp
 * is one-shot by design). If the vendor rejects the account, the operator
 * must send a fresh OTP. That is the correct trade: a reusable OTP would let
 * an operator hold one valid consent and retry account numbers against it.
 *
 * BOTH DOORS COME THROUGH HERE. The CRM (PATCH /api/admin/easyfixers/:id/bank)
 * and the technician app (POST /api/mobile/bank-details) call this ONE
 * function; neither owns any bank SQL of its own. `ctx.source` is the only
 * thing that differs between them, and it drives exactly two things: whether
 * the OTP gate runs, and what lands in the audit row's changed_by_source.
 * That is deliberate — two doors verifying "identically" because two
 * implementations happen to agree today is the bug this shape prevents.
 *
 * @param {number} efrId
 * @param {object} body   — { otp?, accountNumber, ifsc, bankName?, accountHolderName?, reason }
 * @param {object} actor  — req.user (tbl_user row); NULL for app-initiated
 *                          changes, where the technician is the actor and
 *                          there is no tbl_user row to point at.
 * @param {{ipAddress?: string, db?: object, source?: 'crm'|'app'}} [ctx]
 */
async function changeBank(efrId, body, actor, ctx = {}) {
  const db = ctx.db || pool;
  const source = ctx.source === SOURCE_APP ? SOURCE_APP : SOURCE_CRM;
  logger.info('Change easyfixer bank details · efrId=' + efrId + ' · source=' + source);

  // ── 1. OTP ────────────────────────────────────────────────────────
  /*
   * WHO HAS TO CONSENT, AND WHY IT DIFFERS BY DOOR:
   *   app — ALWAYS gated. The technician is redirecting their own money from
   *         their own device. The JWT alone is not consent: it is minted once
   *         and lives for JWT_EXPIRY (default 30d), so a stolen or stale token
   *         would otherwise be enough. The OTP re-proves possession of efr_no
   *         at the moment of the change.
   *   crm — property-driven, default OFF (see crmOtpRequired above). The
   *         controls on that path are the isEasyfixerBankUpdate permission,
   *         the mandatory `reason`, and the audit row.
   */
  /*
   * `body.otp != null` is deliberately part of this: a client that DID send a
   * code always has it verified, whatever the flags say. Otherwise flipping a
   * flag off would silently accept any garbage in the field, which is worse
   * than not asking for one at all.
   */
  const otpRequired = body.otp != null
    || (source === SOURCE_APP ? appOtpRequired() : crmOtpRequired());
  if (otpRequired) {
    const { valid } = await profileOtp.verifyOtp(efrId, body.otp, db);
    if (!valid) {
      logger.warn('Change easyfixer bank rejected · efrId=' + efrId + ' · OTP invalid or expired');
      throw httpError(400, 'Invalid or expired OTP');
    }
  }

  // ── 2. Vendor verification of the NEW account ─────────────────────
  const accountNumber = String(body.accountNumber).trim();
  const ifsc = String(body.ifsc).trim().toUpperCase();
  let vendor;
  try {
    vendor = await kyc.bankVerify(efrId, accountNumber, ifsc);
  } catch (err) {
    /*
     * Status mapping, so an operator sees a sentence they can act on rather
     * than a 500:
     *   503 — SUREPASS_VERIFICATION_KEY is unset. An OUR-side configuration
     *         fault; nothing is wrong with the account. Passed through as-is
     *         (mobile-kyc throws it deliberately clean for exactly this).
     *   504 — the vendor timed out. Also not a verdict on the account; the
     *         operator should retry, not go hunting for a better account
     *         number.
     *   else — the vendor gave a verdict, and it was no. 422 with the
     *         vendor's own message ("Invalid IFSC", "account does not
     *         exist", …), which is far more useful than anything we could
     *         write.
     */
    if (err && (err.status === 503 || err.status === 504)) throw err;
    logger.warn(
      'Change easyfixer bank rejected · efrId=' + efrId + ' · vendor: ' + (err && err.message),
    );
    throw httpError(422, (err && err.message) || 'Bank account could not be verified');
  }

  /*
   * A NEGATIVE VERDICT IS A REJECTION, NOT A FLAG VALUE.
   *
   * The vendor returns `account_exists: false` inside a healthy 200 envelope
   * (see mobile-kyc.service.js::bankVerify), so this is the only place that
   * catch can happen. Storing such an account with a "2 = invalid" flag would
   * satisfy the letter of step 2's promise while breaking its point: a typo'd
   * or closed account must never become the payout destination, because the
   * failure surfaces days later as a silently failed payout, by which time
   * nobody connects it to this edit.
   */
  if (!vendor.verified) {
    logger.warn('Change easyfixer bank rejected · efrId=' + efrId + ' · account does not exist');
    throw httpError(422, vendor.remarks || 'Bank account could not be verified');
  }
  const verifiedFlag = 1;
  // The app already knows the numeric bank id (it picks from a lookup list);
  // the CRM only has the typed name. Accept either rather than forcing the
  // app to round-trip a name back into the id it started from.
  const bankId = Number.isInteger(body.bankId)
    ? body.bankId
    : await resolveBankId(db, body.bankName);
  /*
   * Body first, vendor name as fallback. Blank → null, NEVER '' — a
   * COALESCE(?, col) guards against NULL only; an empty string sails through
   * and BLANKS the stored holder name.
   */
  const holder = (body.accountHolderName && String(body.accountHolderName).trim())
    || vendor.accountHolderName
    || null;

  /*
   * NAME MATCH IS ADVISORY — RECORDED, NEVER A GATE.
   *
   * The bank has already confirmed the account exists; the holder name only
   * tells us WHOSE it is. Blocking on a mismatch would reject a large number
   * of legitimate accounts, because Indian bank records routinely disagree
   * with HR records: initials ("R K Sharma"), honorifics ("Mr. VIKAS  KUMAR"
   * — note the double space the vendor really sends), maiden vs married
   * surnames, and surname-first ordering. So it is stored for CRM review
   * instead, which is where a human can tell "Vikas Kumar" from a genuinely
   * unrelated payee.
   *
   * Reuses utils/name-match.js — the SAME matcher the Aadhaar OCR path uses.
   * It already does NFD/diacritic stripping, honorific removal, token-set
   * comparison and initial expansion, and its max(2, …) divisor is what stops
   * a single shared token ("Kumar") from passing as a match. Do not add a
   * second threshold here; MATCH_THRESHOLD is the one knob.
   */
  const [[techRow]] = await db.query(
    'SELECT efr_name FROM tbl_easyfixer WHERE efr_id = ? LIMIT 1',
    [efrId],
  );
  const nameCheck = matchNames(techRow?.efr_name ?? '', vendor.accountHolderName);
  if (!nameCheck.matched) {
    // Score only — NEVER the names themselves; both sides are PII.
    logger.warn(
      'Change easyfixer bank · name mismatch · efrId=' + efrId
      + ' · score=' + nameCheck.score + ' · source=' + source,
    );
  }

  const verificationSummary = JSON.stringify({
    verified: true,
    accountExists: vendor.accountExists ?? null,
    accountHolderName: vendor.accountHolderName ?? null,
    nameMatch: nameCheck.matched ? 'match' : 'mismatch',
    nameScore: nameCheck.score,
    source,
    otpVerified: otpRequired,
    vendorClientId: vendor.clientId ?? null,
    // The vendor echoes the account number back; it is NOT stored here. The
    // masked pair in old_value/new_value is the record of which account.
    verifiedAt: new Date().toISOString(),
  });

  // ── 3 + 4. Write + audit, atomically ──────────────────────────────
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[existing]] = await conn.query(
      `SELECT efr_bank_id, efr_bank_acc_num
         FROM tbl_easyfixer_bank_details
        WHERE efr_id = ?
        LIMIT 1`,
      [efrId],
    );

    if (existing) {
      await conn.query(
        `UPDATE tbl_easyfixer_bank_details
            SET efr_bank_acc_num = ?,
                efr_bank_acc_name = COALESCE(?, efr_bank_acc_name),
                efr_bank_ifsc = ?,
                bank = COALESCE(?, bank),
                is_verified_by_app = ?,
                updated_by = ?,
                update_date = NOW()
          WHERE efr_id = ?`,
        [accountNumber, holder, ifsc, bankId, verifiedFlag === 1 ? 1 : 0,
          actor?.user_id ?? null, efrId],
      );
    } else {
      await conn.query(
        `INSERT INTO tbl_easyfixer_bank_details
           (efr_id, efr_bank_acc_num, efr_bank_acc_name, efr_bank_ifsc, bank,
            is_verified_by_app, updated_by, insert_date, update_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [efrId, accountNumber, holder, ifsc, bankId, verifiedFlag === 1 ? 1 : 0,
          actor?.user_id ?? null],
      );
    }

    /*
     * is_verified_by_app carries "the account currently stored passed vendor
     * verification". The CRM runs the IDENTICAL vendor call, so it is set
     * from this verification too — leaving a stale 1 from the previous
     * account would make the flag describe an account that is no longer
     * there. The CRM-side flag on tbl_easyfixer is what the verification
     * page reads, and it follows the same vendor result.
     */
    await conn.query(
      `UPDATE tbl_easyfixer
          SET is_bank_details_verified_by_crm = ?,
              efr_bank_details_perc = 100,
              updated_by = ?,
              update_date = NOW()
        WHERE efr_id = ?`,
      [verifiedFlag, actor?.user_id ?? null, efrId],
    );

    await recordChange({
      efrId,
      changeType: CHANGE_BANK,
      oldValue: existing ? existing.efr_bank_acc_num : null,
      newValue: accountNumber,
      changedByUserId: actor?.user_id ?? null,
      changedBySource: source,
      reason: body.reason,
      verificationResult: verificationSummary,
      /*
       * Follows the gate that ACTUALLY ran. Hardcoding 1 here (as this did
       * until 2026-08-24) was safe only while every bank change was
       * OTP-gated; with crmOtpRequired() defaulting off, a hardcoded 1 would
       * make every CRM row claim a technician consent that never happened —
       * an audit trail that lies is worse than no audit trail, because it is
       * believed. NOTE: the executed migration's header still says "ALWAYS 1
       * for bank changes"; that line predates the CRM toggle and cannot be
       * edited (executed migrations are frozen). This is the current truth.
       */
      otpVerified: otpRequired ? 1 : 0,
      ipAddress: ctx.ipAddress ?? null,
    }, conn);

    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    logger.error('Change easyfixer bank failed · efrId=' + efrId + ' · ' + err.message);
    throw err;
  } finally {
    conn.release();
  }

  logger.info('Easyfixer bank details changed · efrId=' + efrId);
  // Last four only — the operator just typed the number; echoing it back in
  // full only creates another place it can be read from.
  return {
    efr_id: Number(efrId),
    account_number_masked: maskAccount(accountNumber),
    ifsc,
    bank_id: bankId,
    account_holder_name: holder,
    verified: verifiedFlag === 1,
    // Advisory — the CRM renders this so an operator can eyeball a mismatch.
    // The mobile route deliberately does NOT echo the vendor's holder name
    // (see routes/mobile/index.js POST /bank-details).
    name_match: nameCheck.matched ? 'match' : 'mismatch',
    name_score: nameCheck.score,
    otp_verified: otpRequired,
    changed: true,
  };
}

module.exports = { recordChange, changeMobile, changeBank, maskAccount, crmOtpRequired, appOtpRequired };
