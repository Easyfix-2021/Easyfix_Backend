/*
 * services/job-share-guest.service.js — the shared-job WEB LINK.
 *
 * A technician shares a job with an outside contact (tbl_job_share_link row with
 * contact_number, or a team technician's efr_no). That person works the job from
 * a web copy of the technician app (Easyfix_Technician_Mobile_Application, built
 * with EXPO_PUBLIC_EASYFIX_SHARE=1, served by the CRM at /public/shared-job/).
 *
 *   WhatsApp link  →  /public/share/<code>  →  /public/shared-job/?t=<link token>
 *   peek(link)     →  job summary for the OTP screen
 *   sendOtp(link)  →  4-digit code to the share's phone
 *   verifyOtp      →  accepts the share, returns a GUEST SESSION token
 *
 * The guest token is accepted by requireTechAuth (middleware/tech-auth.js) and
 * resolved by resolveGuest() below to the SHARER's technician identity — the job
 * never changes hands, exactly like a technician delegate — scoped by
 * requireShareGuestScope to this one job. Every request re-checks that the
 * share is still live, so a sharer cancel, an ops revoke or the completion
 * cuts the guest off on their next tap.
 *
 * WHY AN OTP AND NOT THE LINK ALONE. The link shows the customer's address and
 * lets the holder change the job. WhatsApp messages get forwarded; a forwarded
 * link without the phone is useless.
 */

'use strict';

const { pool } = require('../db');
const logger = require('../logger');
const { signJobShareLinkToken, verifyJobShareLinkToken, signJobShareGuestToken } = require('../utils/jwt');
const { resolveMobileOtp, otpExpiryDate, OTP_RESEND_SECONDS } = require('../utils/otp');
const { istIsPast } = require('../utils/ist-calendar');
const { maskMobile } = require('../utils/mask-mobile');
const { sharedAttemptWindow } = require('./attempt-window.service');
const delegation = require('./job-share-delegation.service');

// 5 wrong codes per share per 30 minutes — the login OTP's rule.
const otpAttempts = sharedAttemptWindow('share-otp');

function httpError(status, message, code, details) {
  const e = new Error(message);
  e.status = status;
  e.details = { code, ...(details || {}) };
  e.code = code;
  return e;
}

const shareEnded = () => httpError(410, 'This job is no longer shared with you.', 'share_ended');

/* The long URL the WhatsApp short link resolves to. Env-aware like the other
 * public links (profile update, magic link). */
function longUrl(shareId) {
  const base = String(
    process.env.CRM_PUBLIC_BASE_URL || process.env.MAGIC_LINK_BASE_URL || 'https://crm.easyfix.in',
  ).replace(/\/+$/, '');
  return `${base}/public/shared-job/?t=${signJobShareLinkToken(shareId)}`;
}

/*
 * The link for the WhatsApp body. Short when the shortener works; the long URL
 * otherwise (same soft fallback as the other senders — a long link still works).
 */
async function shareLink(shareId) {
  const url = longUrl(shareId);
  try {
    const { shortenUrl } = require('./url-shortener.service');
    const { short_url: shortUrl } = await shortenUrl(url, { purpose: 'job_share' }, pool);
    return shortUrl || url;
  } catch (e) {
    logger.warn(`Share link shortening failed — sending the long link · shareId=${shareId} · ${e.message}`);
    return url;
  }
}

/* The phone that proves the recipient: the contact's, or the team technician's. */
function recipientNumber(row) {
  return row.contact_number || row.delegate_no || null;
}

/* Link token → live share row, or throws 404 (bad link) / 410 (ended). */
async function liveShareForLink(linkToken) {
  const shareId = verifyJobShareLinkToken(linkToken);
  const row = await delegation.findShareById(shareId);
  if (!row) throw httpError(404, 'invalid link', 'share_not_found');
  if (!delegation.LIVE_STATUSES.includes(row.status)) throw shareEnded();
  return row;
}

async function peek(linkToken) {
  const row = await liveShareForLink(linkToken);
  const share = delegation.toShareJson(row);
  const facts = await delegation.shareJobFacts(share);
  return {
    share: {
      id: share.id,
      jobId: share.jobId,
      status: share.status,
      sharedByName: share.sharedByName,
      maskedNumber: maskMobile(recipientNumber(row)),
      service: facts ? facts.service : null,
      area: facts ? facts.area : null,
    },
  };
}

async function sendOtp(linkToken) {
  const row = await liveShareForLink(linkToken);
  const mobile = recipientNumber(row);
  if (!mobile) throw httpError(422, 'This share has no phone number to send a code to.', 'share_no_number');

  const otp = resolveMobileOtp(mobile);
  await pool.query(
    'UPDATE tbl_job_share_link SET otp = ?, otp_valid_up_to = ? WHERE share_id = ?',
    [otp, otpExpiryDate(), row.share_id],
  );
  const { deliverOtp } = require('./otp-delivery.service');
  const result = await deliverOtp({
    identifier: String(mobile), mobile: String(mobile),
    name: row.contact_name || row.delegate_name || '', otp, contextLabel: 'shared-job',
  });
  // deliverOtp's contract: a false finalDelivered must not be reported as sent,
  // unless every channel was merely suppressed on this host (QA/dev).
  if (!result.finalDelivered && !result.disabled) {
    logger.warn(`Share OTP not delivered · shareId=${row.share_id}`);
    throw httpError(502, "We couldn't send the code. Please try again in a minute.", 'otp_not_delivered');
  }
  logger.info(`Share OTP sent · shareId=${row.share_id}`);
  return { sent: true, maskedNumber: maskMobile(mobile), resendAfterSec: OTP_RESEND_SECONDS };
}

async function verifyOtp(linkToken, otp) {
  const row = await liveShareForLink(linkToken);
  const [[stored]] = await pool.query(
    'SELECT otp, otp_valid_up_to FROM tbl_job_share_link WHERE share_id = ? LIMIT 1',
    [row.share_id],
  );
  if (!stored || stored.otp == null || istIsPast(stored.otp_valid_up_to)) {
    throw httpError(400, 'This code has expired. Please request a new one.', 'otp_expired');
  }

  const capKey = 'share:' + row.share_id;
  const claim = await otpAttempts.claim(capKey, pool);
  if (claim.locked) {
    throw httpError(429, 'Too many wrong codes. Please try again later.', 'otp_locked',
      { retryAfterMinutes: claim.retryAfterMinutes });
  }
  if (Number(stored.otp) !== Number(otp)) {
    const after = await otpAttempts.state(capKey, pool);
    if (after.locked) {
      throw httpError(429, 'Too many wrong codes. Please try again later.', 'otp_locked',
        { retryAfterMinutes: after.retryAfterMinutes });
    }
    throw httpError(400, 'That code is not right.', 'otp_invalid', { attemptsRemaining: after.attemptsRemaining });
  }
  await otpAttempts.clear(capKey, pool);
  await pool.query(
    'UPDATE tbl_job_share_link SET otp = NULL, otp_valid_up_to = NULL WHERE share_id = ?',
    [row.share_id],
  );

  const accepted = await delegation.acceptByContact(row.share_id);
  const share = delegation.toShareJson(accepted);
  logger.info(`Share guest session issued · shareId=${row.share_id} · jobId=${share.jobId}`);
  return {
    sessionToken: signJobShareGuestToken({ shareId: share.id, jobId: share.jobId }),
    jobId: share.jobId,
    share,
  };
}

/*
 * Guest token claims → the live share, or null when it has ended. Guests only
 * ever exist on accepted|started shares (verify accepts), so pending counts as
 * ended here too.
 */
async function resolveGuest({ shareId, jobId }) {
  const row = await delegation.findShareById(shareId);
  if (!row || Number(row.job_id) !== Number(jobId)) return null;
  if (row.status !== 'accepted' && row.status !== 'started') return null;
  return row;
}

module.exports = {
  shareLink,
  peek,
  sendOtp,
  verifyOtp,
  resolveGuest,
  recipientNumber,
  _internals: { longUrl, liveShareForLink },
};
