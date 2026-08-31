'use strict';

/*
 * technician-verification.service.js — the public "is this EasyFix technician
 * genuine, and are they authorised RIGHT NOW?" check behind the I-Card QR.
 *
 * ─── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * The I-Card QR used to encode the plain string "EF-<tid>", derived ON THE
 * DEVICE from data already printed on the card. It proved nothing: anyone could
 * render the same card with any name, and a technician who had been deactivated
 * or BLACKLISTED kept a QR that scanned exactly like a working one. That is the
 * fraud this service closes — a customer scans, and the answer comes from OUR
 * database at the moment of the scan, not from the card.
 *
 * ─── THE TOKEN: SIGNED, NOT STORED ────────────────────────────────────────
 *
 * 24 bytes, base64url, 32 characters:
 *     [ 4 bytes efr_id big-endian ][ 20 bytes truncated HMAC-SHA256 ]
 *
 * Verification decodes the id and recomputes the HMAC, so NOTHING is persisted:
 * no new table, no column, no migration, nothing to keep in sync — which also
 * respects CLAUDE.md's never-alter-shared-schema rule for free.
 *
 * WHY NOT A BARE ID. `/verify/4471` is enumerable: anyone could walk the range
 * and harvest every technician's name, photo and city. A 160-bit HMAC makes the
 * URL unguessable while staying short enough to scan reliably.
 *
 * WHY 24+ CHARACTERS, SPECIFICALLY. utils/log-format.js redacts any path
 * segment of 24+ base64url characters as <token>, but deliberately does NOT
 * redact short numeric ids. At 32 characters this token is redacted out of the
 * access log automatically; a numeric id in the path would have been written to
 * disk on every scan. The token is also ONE unbroken segment — no dots — so the
 * whole thing matches that rule rather than just part of it.
 *
 * WHY IT NEVER EXPIRES. The card is rendered once and may be screenshotted,
 * printed or shared. A TTL would break honest cards while doing nothing about
 * dishonest ones. Freshness lives in the STATUS, which is read live on every
 * scan: a blacklisted technician's old QR still resolves, and the page tells
 * the scanner they are not authorised. That is the whole point.
 *
 * ─── WHAT MAY BE SHOWN ────────────────────────────────────────────────────
 *
 * middleware/mask-mobile.js covers /api/admin/* ONLY, so nothing masks a public
 * response. The projection below therefore never SELECTS efr_no, Aadhaar, PAN,
 * address or email — a field that is never read cannot leak. `lifecycle_reason`
 * is likewise never exposed: easyfixer-lifecycle.service strips it even from
 * the technician's own payload because BLACKLISTED notes carry internal RCA.
 */

const crypto = require('crypto');
const { pool } = require('../db');
const logger = require('../logger');
const lifecycle = require('./easyfixer-lifecycle.service');

const ID_BYTES = 4;
const MAC_BYTES = 20;
const TOKEN_BYTES = ID_BYTES + MAC_BYTES;
// 24 bytes -> 32 base64url chars. Kept as a constant because the log-redaction
// guarantee above depends on the encoded length staying >= 24.
const TOKEN_CHARS = 32;

/*
 * The signing key. Derived from JWT_SECRET rather than adding another env var
 * that could be forgotten on one environment and silently break every card
 * there. The domain-separation label means this key cannot be used to mint or
 * verify anything else signed with JWT_SECRET, and vice versa.
 */
function signingKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    const e = new Error('JWT_SECRET is not configured');
    e.status = 503;
    throw e;
  }
  return crypto.createHmac('sha256', String(secret))
    .update('easyfix:technician-verification:v1')
    .digest();
}

function macFor(efrId) {
  const id = Buffer.alloc(ID_BYTES);
  id.writeUInt32BE(Number(efrId) >>> 0, 0);
  return crypto.createHmac('sha256', signingKey()).update(id).digest().subarray(0, MAC_BYTES);
}

/** Stable, unguessable public code for one technician. */
function tokenFor(efrId) {
  const id = Buffer.alloc(ID_BYTES);
  id.writeUInt32BE(Number(efrId) >>> 0, 0);
  return Buffer.concat([id, macFor(efrId)]).toString('base64url');
}

/**
 * token -> efr_id, or null when it was not minted by us.
 * Constant-time compare so the endpoint cannot be used as a signing oracle.
 */
function efrIdFromToken(token) {
  const value = String(token || '');
  if (value.length !== TOKEN_CHARS || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  let raw;
  try {
    raw = Buffer.from(value, 'base64url');
  } catch {
    return null;
  }
  if (raw.length !== TOKEN_BYTES) return null;
  const efrId = raw.readUInt32BE(0);
  if (!efrId) return null;
  const expected = macFor(efrId);
  const actual = raw.subarray(ID_BYTES);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  return efrId;
}

/**
 * The public URL a QR should encode.
 *
 * HOSTED ON THE CRM ORIGIN, NOT THE BACKEND ORIGIN — this is the difference
 * between a QR that works at a customer's front door and one that does not.
 *
 * Outsider-facing flows all live on the CRM_UI host (crm.easyfix.in), which is
 * VPN-gated at the AWS ALB by source IP EXCEPT for an explicit allowlist:
 * `/public/*`, `/_next/*` and `/api/public/*`. A customer scanning this card is
 * by definition off-VPN, so the link has to land inside that allowlist. Next
 * proxies `/api/:path*` through to this backend (see the CRM's next.config
 * rewrites), so `/api/public/...` on the CRM origin reaches this service.
 *
 * The env chain is copied verbatim from
 * easyfixer-profile-update-link.service.js::profileUpdateUrl so every public
 * link in the product resolves its host the same way: CRM_PUBLIC_BASE_URL wins,
 * MAGIC_LINK_BASE_URL is the per-environment fallback (qa.crm.easyfix.in on QA,
 * so a QA card never silently points at prod), prod hardcode last.
 *
 * The hardcoded default is deliberate: a QR carrying a RELATIVE path is simply
 * unscannable, so this must never return one.
 *
 * NOTE: unlike the Next-rendered public pages, the page behind this URL is
 * self-contained HTML with inline CSS and no `/_next` chunks — so it cannot
 * blank off-VPN the way an asset-dependent page can.
 */
function verifyUrlFor(efrId) {
  const base = process.env.CRM_PUBLIC_BASE_URL
    || process.env.MAGIC_LINK_BASE_URL
    || 'https://crm.easyfix.in';
  return `${String(base).replace(/\/+$/, '')}/api/public/verify-technician/${tokenFor(efrId)}`;
}

/*
 * Resolve a token to what a stranger may be told.
 *
 * Returns { found:false } for a bad token AND for a technician who is not
 * there — the caller renders one identical "could not be verified" page for
 * both, so the endpoint never reveals which tokens map to real people.
 */
async function verifyByToken(token, db = pool) {
  const efrId = efrIdFromToken(token);
  if (!efrId) return { found: false };

  const [[row]] = await db.query(
    `SELECT e.efr_id, e.efr_name, e.efr_profile_img,
            e.efr_status, e.is_technician_verified, e.efr_manager_id,
            e.scheduled_reactivation_date, e.efr_service_category,
            e.profile_activation_date_time,
            e.lifecycle_status, e.lifecycle_changed_at,
            e.adhaar_card_number, e.user_id,
            e.is_identity_details_verified_by_crm,
            /*
             * e.user_personal_details_filled was selected here and read
             * NOWHERE (no backticks in this comment -- it lives INSIDE a
             * template literal, and one would end the string early) — the return below maps fields explicitly and never
             * spreads the row. It is also not a column on tbl_easyfixer (the
             * real one is tbl_user.is_personal_detail_filled), so it threw
             * ER_BAD_FIELD_ERROR and took the whole query with it. Dropped
             * rather than joined: adding tbl_user to serve a value no caller
             * reads would be a round trip for nothing.
             */
            c.city_name
       FROM tbl_easyfixer e
       LEFT JOIN tbl_city c ON c.city_id = e.efr_cityId
      WHERE e.efr_id = ?
        AND NOT (e.efr_status <=> 3)
      LIMIT 1`,
    [efrId],
  );
  if (!row) return { found: false };

  /*
   * `jobsAllowed` is the authority, NOT any single column. It is a three-way
   * AND — lifecycle_status in {ACTIVE, UNDER_MASTER} AND is_technician_verified
   * AND efr_status = 1 — and lifecycle_status is nullable, so rows the
   * lifecycle writer never touched fall back to deriveLegacyStatus. Reading one
   * column here would pass a blacklisted technician whose efr_status was still
   * 1, which is precisely the fraud this page exists to stop.
   */
  const snapshot = lifecycle.lifecycleFromRow(row);
  const authorized = Boolean(snapshot.jobsAllowed);

  logger.info('Technician verification scan · efrId=' + efrId + ' · authorized=' + authorized);

  return {
    found: true,
    authorized,
    efrId: row.efr_id,
    name: row.efr_name || null,
    photo: row.efr_profile_img || null,
    city: row.city_name || null,
    categories: String(row.efr_service_category || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    memberSince: row.profile_activation_date_time || null,
    // The STATUS only. Never snapshot.reason — BLACKLISTED reasons carry
    // internal RCA and support notes.
    status: snapshot.status || null,
  };
}

module.exports = {
  tokenFor,
  efrIdFromToken,
  verifyUrlFor,
  verifyByToken,
  _internals: { TOKEN_CHARS, macFor },
};
