const { pool } = require('../db');
const logger = require('../logger');
const deepSkillService = require('./deep-skill.service');

/*
 * Mobile Registration gate machine — collapses three legacy polls
 * (`users/{id}`, `profile-final-submission-status`, and the email/
 * verification-status fetch) into a SINGLE derived status the RN app
 * drives its onboarding stepper from.
 *
 * Technician is implicit: efrId === req.tech.efr_id.
 *
 * Source of truth for column names + the gate logic:
 *   - Legacy ProfileServiceImpl.getProfileFinalStatus() (API_Angular-
 *     ClientDashboard) — final-submission + verification flags.
 *   - Legacy ProfileServiceImpl.getProfileFieldCheckNew() — the
 *     authoritative "remaining fields" list.
 *   - services/easyfixer-verification.service.js (this backend) — the
 *     CRM-side column reference for the same flags.
 *
 * tbl_easyfixer columns used (all verified against SCHEMA.md +
 * easyfixer-verification.service.js):
 *   efr_profile_perc                          overall %  (0-100)
 *   efr_profile_img                           profile image key/url
 *   is_technician_verified                    1 = fully activated
 *   is_identity_details_verified_by_crm       0 new / 1 verified / 2 rejected
 *   is_personal_details_verified_by_crm       0 / 1 / 2
 *   send_back_to_tx_reason_crm                rejection reason text
 *   efr_first_name / efr_no / adhaar_card_number / efr_service_type /
 *   efr_service_category / efr_cityId / efr_pin_no
 *   user_id                                   FK → tbl_user
 *
 * tbl_user columns used:
 *   personal_details_filled        0 new lead / 1 accepted / 2 denied
 *   is_personal_detail_filled      boolean — tech submitted personal step
 *   is_released                    boolean — released into the workforce
 */

const EASYFIX_MANAGER_FALLBACK_NUMBER = '9810833037'; // legacy ProfilePercentageDto default

// THIRD/last training video gates "training complete" in legacy
// getProfileFinalStatus. VERIFY: confirm the canonical last-video id
// against training_videos on the live DB (legacy AppConstant.THIRD_TRAINING_VIDEO).
const TRAINING_VIDEO_ID_FOR_COMPLETION = 3;

function bool(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (Buffer.isBuffer(v)) return v[0] === 1;
  return Number(v) === 1;
}

function pct(v) {
  const n = Number(v || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// Non-empty presence check for text-ish columns (Aadhaar/PAN numbers,
// image keys, service category). Used by the Gate-1 + Gate-2 checklists.
function present(v) {
  return v != null && String(v).trim() !== '';
}

// ─── Identity + flags fetch ─────────────────────────────────────────
async function fetchGateRow(efrId) {
  const [[row]] = await pool.query(
    `SELECT e.efr_id,
            e.efr_first_name, e.efr_name, e.efr_no,
            e.efr_profile_img,
            e.efr_profile_perc,
            e.is_technician_verified,
            e.is_identity_details_verified_by_crm,
            e.is_personal_details_verified_by_crm,
            e.send_back_to_tx_reason_crm,
            e.adhaar_card_number,
            e.pan_card_number,
            e.efr_service_type,
            e.efr_service_category,
            e.efr_cityId,
            e.efr_pin_no,
            e.user_id,
            u.personal_details_filled       AS user_personal_details_filled,
            u.is_personal_detail_filled      AS user_is_personal_detail_filled,
            u.is_released                    AS user_is_released
       FROM tbl_easyfixer e
       LEFT JOIN tbl_user u ON u.user_id = e.user_id
      WHERE e.efr_id = ?
      LIMIT 1`,
    [efrId],
  );
  return row || null;
}

// Profile-image presigned URL. The column may hold an S3 key (Skills/
// easyfixer documents) or a plain string; resolve via the catalogue
// presigner when it looks like a key, else pass the raw value through.
async function resolveProfileImageUrl(raw) {
  const key = String(raw || '').trim();
  if (!key) return null;
  try {
    const url = await deepSkillService.resolveImageUrlFromKey(key);
    if (url) return url;
  } catch (_) { /* fall through to raw */ }
  // Not a resolvable S3 key — return the stored value verbatim (legacy
  // rows store a relative doc path the FE prefixes itself).
  return key;
}

// Training-completed timestamp — last training video watched to 100%.
// Table is `easyfixer_watched_video` (NO `tbl_` prefix — confirmed against
// live easyfix_core 2026-06-16; same table mobile-profile-extra reads).
// Columns: easyfixer_id, video_id, watched_percentage, update_date (legacy
// EasyfixerDaoImpl). We degrade to null on any error so the gate never
// crashes if the row/column set ever drifts.
async function fetchTrainingCompletedTime(efrId) {
  try {
    const [[row]] = await pool.query(
      `SELECT update_date
         FROM easyfixer_watched_video
        WHERE easyfixer_id = ?
          AND video_id = ?
          AND watched_percentage = 100
        ORDER BY update_date DESC
        LIMIT 1`,
      [efrId, TRAINING_VIDEO_ID_FOR_COMPLETION],
    );
    return row?.update_date || null;
  } catch (e) {
    logger.info(
      { err: e.message, efrId },
      'registration: training-completed lookup failed; treating as not-complete',
    );
    return null;
  }
}

/*
 * Derive the single onboarding status from the flags. Order matters —
 * earlier branches take precedence.
 *
 * REDESIGN (2026-07): the old flow blocked the technician behind FOUR walls
 * — under_verification (CRM lead-accept), in_progress (4-card profile),
 * training_pending, verification_pending (CRM activation) — each a dead-end
 * screen. The new model collapses these into ONE non-blocking in-app state
 * and lets the technician reach the dashboard immediately after Gate 1, doing
 * profile/training there while Ops verifies in the background. Job assignment
 * stays gated on is_technician_verified (enforced in candidate-ranking +,
 * now, the assign/offer/accept write endpoints), so letting an unverified
 * tech into the app is safe — they simply can't be offered work yet.
 *
 * States:
 *   not_eligible          — CRM explicitly denied the lead
 *                           (personal_details_filled = 2). Terminal.
 *   rejected              — identity rejected by CRM
 *                           (is_identity_details_verified_by_crm = 2);
 *                           rejectedReason carries the why. Tech resubmits.
 *   personal_pending      — Gate 1 not yet complete: the merged registration
 *                           screen (name + pincode + photo + Aadhaar) hasn't
 *                           been submitted. Stays in the (registration) group.
 *   pending_verification  — Gate 1 done, in the app, but not CRM-activated
 *                           (is_technician_verified != 1). Dashboard is fully
 *                           usable; jobs stay locked until verified. Replaces
 *                           the old under_verification / in_progress /
 *                           training_pending / verification_pending walls.
 *   active                — CRM-activated (is_technician_verified = 1).
 *                           Checked LAST so a premature flag can't skip Gate 1.
 */
function deriveStatus(flags) {
  // Denied lead — terminal until CRM re-accepts.
  if (Number(flags.personalDetailsFilled) === 2) return 'not_eligible';
  // Identity rejected by CRM — show the reason, let the tech resubmit.
  if (Number(flags.identityVerifiedByCrm) === 2) return 'rejected';
  // Gate 1 incomplete (personal step + Aadhaar + photo) → merged reg screen.
  if (!flags.gate1Complete) return 'personal_pending';
  // Gate 1 done but CRM hasn't activated → in the app, unverified (non-blocking).
  if (!flags.isTechnicianVerified) return 'pending_verification';
  // CRM-activated. Verified is checked LAST so an out-of-order flag can never
  // leak a tech past Gate 1 straight to active.
  return 'active';
}

async function getStatus(efrId) {
  logger.info('Registration status · efrId=' + efrId);
  const e = await fetchGateRow(efrId);
  if (!e) {
    logger.warn('Registration status: technician not found · efrId=' + efrId);
    const err = new Error('technician not found');
    err.status = 404;
    throw err;
  }

  const [profileImageUrl, trainingCompletedTime] = await Promise.all([
    resolveProfileImageUrl(e.efr_profile_img),
    fetchTrainingCompletedTime(efrId),
  ]);

  const aadhaarPresent = present(e.adhaar_card_number);
  const photoPresent   = present(e.efr_profile_img);
  const panPresent     = present(e.pan_card_number);
  // "Has skills" = the tech declared at least a service category/type (the
  // matching key candidate-ranking needs). Folded into the Gate-2 checklist,
  // no longer a registration wall.
  const hasSkills      = present(e.efr_service_category) || present(e.efr_service_type);
  const isPersonalDetailFilled = bool(e.user_is_personal_detail_filled);
  // Gate 1 = the merged registration screen: personal step submitted AND
  // Aadhaar + photo on file. All three are written together by that screen;
  // requiring all three defends against legacy rows that set the personal
  // flag before Aadhaar/photo existed.
  const gate1Complete  = isPersonalDetailFilled && aadhaarPresent && photoPresent;

  const flags = {
    isPersonalDetailFilled,
    gate1Complete,
    // Lead status as stored on tbl_user (0 new / 1 accepted / 2 denied).
    personalDetailsFilled:      e.user_personal_details_filled != null
      ? Number(e.user_personal_details_filled) : null,
    personalDetailVerifiedByCrm: Number(e.is_personal_details_verified_by_crm) === 1,
    identityVerifiedByCrm:      e.is_identity_details_verified_by_crm != null
      ? Number(e.is_identity_details_verified_by_crm) : null,
    isReleased:                 bool(e.user_is_released),
    isTechnicianVerified:       bool(e.is_technician_verified),
    aadhaarPresent,
    photoPresent,
    panPresent,
    hasSkills,
    trainingCompletedTime,
    profilePercentage:          pct(e.efr_profile_perc),
  };

  const status = deriveStatus(flags);

  // Gate 2 (earning) unlock: CRM-verified AND the tech has the full identity
  // + skills + training the first job needs. Surfaced as a dashboard checklist
  // so the tech sees exactly what's left; job offers stay locked until true.
  const trainingComplete = !!trainingCompletedTime;
  const jobsUnlocked = flags.isTechnicianVerified && panPresent && hasSkills && trainingComplete;

  logger.info('Returning registration status · status=' + status + ' profilePct=' + pct(e.efr_profile_perc) + ' jobsUnlocked=' + jobsUnlocked);

  return {
    status,
    verified:             flags.isTechnicianVerified,
    jobsUnlocked,
    // Gate-2 unlock checklist for the dashboard (all true ⇒ jobsUnlocked).
    checklist: {
      verified:         flags.isTechnicianVerified,
      panPresent,
      hasSkills,
      trainingComplete,
    },
    profilePercentage:    pct(e.efr_profile_perc),
    profileImageUrl:      profileImageUrl || null,
    // Only surface a rejection reason when the gate is actually rejected.
    rejectedReason:       status === 'rejected'
      ? (e.send_back_to_tx_reason_crm || null) : null,
    easyfixManagerNumber: EASYFIX_MANAGER_FALLBACK_NUMBER,
    flags,
  };
}

// ─── GET remaining (missing-field labels) ───────────────────────────
/*
 * Authoritative "what's left to fill" list, ported from legacy
 * getProfileFieldCheckNew(). Each present/complete field is dropped;
 * the returned array is the human-readable labels of what's STILL
 * missing. Bank completeness reuses the legacy precedence (added →
 * account number → IFSC → bank name).
 */
async function getRemaining(efrId) {
  logger.info('Registration remaining-fields · efrId=' + efrId);
  const e = await fetchGateRow(efrId);
  if (!e) {
    logger.warn('Registration remaining-fields: technician not found · efrId=' + efrId);
    const err = new Error('technician not found');
    err.status = 404;
    throw err;
  }

  const [[bank]] = await pool.query(
    `SELECT b.efr_bank_acc_num, b.efr_bank_ifsc, b.bank
       FROM tbl_easyfixer_bank_details b
      WHERE b.efr_id = ? LIMIT 1`,
    [efrId],
  );

  const present = (v) => v != null && String(v).trim() !== '';

  const missing = [];
  if (!present(e.efr_first_name))       missing.push('First Name');
  if (!present(e.efr_no))               missing.push('Mobile Number');
  if (!present(e.efr_profile_img))      missing.push('Profile Image');

  // Banking — single label, legacy precedence for the reason.
  let bankOk = true;
  if (!bank) bankOk = false;
  else if (!present(bank.efr_bank_acc_num)) bankOk = false;
  else if (!present(bank.efr_bank_ifsc))    bankOk = false;
  else if (bank.bank == null)               bankOk = false;
  if (!bankOk) missing.push('Bank Details');

  if (!present(e.adhaar_card_number))   missing.push('Aadhaar Card Number');
  if (!present(e.efr_service_type))     missing.push('Service Type');
  if (!present(e.efr_service_category)) missing.push('Service Category');
  // efr_cityId is numeric; treat 0/null as missing.
  if (!(Number(e.efr_cityId) > 0))      missing.push('City');
  if (!present(e.efr_pin_no))           missing.push('Pincode');

  logger.info('Returning ' + missing.length + ' remaining field(s)');
  return missing;
}

// ─── POST personal-details (initial save) ───────────────────────────
/*
 * Persist the initial personal-details step. Splits `name` into
 * efr_first_name / efr_last_name (and keeps the full efr_name in sync),
 * stamps pincode (efr_pin_no) + address lines, and bumps
 * efr_personal_details_perc to 100. Optional city/state are textual
 * hints from the app — efr_cityId is a numeric FK, so we DON'T overwrite
 * it from a free-text city string here (CRM resolves the city FK during
 * lead verification). The textual city/state ride into efr_address only
 * if no explicit address line is provided.
 *
 * COALESCE-guards every optional column so a partial submit never blanks
 * a previously-saved value.
 */
async function savePersonalDetails(efrId, body) {
  logger.info('Save personal details · hasName=' + Boolean(body.name) + ' hasPincode=' + (body.pincode != null) + ' hasAddress=' + Boolean(body.addressLine1 || body.addressLine2));
  const fullName  = String(body.name || '').trim();
  const firstName = fullName ? fullName.split(/\s+/)[0] : null;
  const lastName  = fullName && fullName.includes(' ')
    ? fullName.slice(firstName.length).trim() : null;

  // Compose an address line from the supplied lines (or fall back to the
  // textual city/state hint) so the CRM lead screen has something to show.
  const addressLine = [body.addressLine1, body.addressLine2]
    .map((s) => (s == null ? '' : String(s).trim()))
    .filter(Boolean)
    .join(', ') || null;

  await pool.query(
    `UPDATE tbl_easyfixer
        SET efr_name        = COALESCE(?, efr_name),
            efr_first_name  = COALESCE(?, efr_first_name),
            efr_last_name   = COALESCE(?, efr_last_name),
            efr_pin_no      = COALESCE(?, efr_pin_no),
            efr_address     = COALESCE(?, efr_address),
            efr_personal_details_perc = 100
      WHERE efr_id = ?`,
    [
      fullName || null,
      firstName,
      lastName,
      body.pincode != null ? String(body.pincode).trim() : null,
      addressLine,
      efrId,
    ],
  );

  // Mark the personal step as submitted on tbl_user so the gate machine
  // advances out of `personal_pending`. Only writes when a linked user
  // row exists (idle leads with no user account are a no-op).
  const [[row]] = await pool.query(
    'SELECT user_id FROM tbl_easyfixer WHERE efr_id = ? LIMIT 1',
    [efrId],
  );
  if (row?.user_id) {
    await pool.query(
      'UPDATE tbl_user SET is_personal_detail_filled = 1 WHERE user_id = ?',
      [row.user_id],
    );
  }

  // Best-effort location enrichment (2026-07-09): resolve the submitted
  // pincode into a city FK + state + GPS centroid so the CRM Registered-
  // Easyfixers list and Self-Registration Verification screen show City /
  // State / State-User / GPS instead of dashes.
  //
  // DETACHED (not awaited): enrichment may hit a live Google geocode for an
  // uncataloged pincode, and the technician's submit must not wait on that.
  // Fail-soft by contract — a geocode miss or Google outage must never fail
  // the submit (the raw pincode is already saved above; the CRM verification
  // page also backfills lazily, and an operator can resolve the FK by hand).
  if (body.pincode != null) {
    const { enrichEasyfixerLocationFromPincode } = require('./easyfixer-location.service');
    enrichEasyfixerLocationFromPincode({
      efrId,
      pincode: body.pincode,
      userId: row?.user_id || null,
      deviceLat: body.latitude,
      deviceLng: body.longitude,
    }).catch((err) => {
      logger.warn('Registration location enrichment failed (non-fatal) · efrId=' + efrId + ' · ' + (err && err.message ? err.message : err));
    });
  }

  logger.info('Personal details saved · efrId=' + efrId + ' personalStepMarked=' + Boolean(row?.user_id));
  return { ok: true };
}

// ─── PATCH language ─────────────────────────────────────────────────
/*
 * Persist the technician's preferred language (English NAME, e.g.
 * "Hindi", "English") on tbl_easyfixer_app — the canonical per-
 * technician device/app row keyed by efr_id (same table that drives
 * push routing; see the push-device-routing memory). The legacy
 * `PATCH language?language=` setter wrote EXACTLY this column.
 *
 * UPDATE-then-INSERT upsert: a technician who has never logged in via
 * the legacy app may not have a row yet, and tbl_easyfixer_app has no
 * usable unique constraint beyond the efr_id PK, so we update first and
 * insert only when no row was touched.
 */
async function setLanguage(efrId, language) {
  const lang = String(language || '').trim();
  logger.info('Set preferred language · language=' + (lang || '-'));
  if (!lang) {
    logger.warn('Set language rejected · language is required');
    const err = new Error('language is required');
    err.status = 400;
    throw err;
  }

  const [upd] = await pool.query(
    'UPDATE tbl_easyfixer_app SET language = ? WHERE efr_id = ?',
    [lang, efrId],
  );
  if (upd.affectedRows === 0) {
    // VERIFY: tbl_easyfixer_app PK column is `efr_id` (per legacy
    // EasyfixApp @Entity). Insert a minimal row carrying the language.
    await pool.query(
      `INSERT INTO tbl_easyfixer_app (efr_id, language, last_login_time)
       VALUES (?, ?, NOW())`,
      [efrId, lang],
    );
  }

  logger.info('Preferred language saved · language=' + lang + ' inserted=' + (upd.affectedRows === 0));
  return { ok: true };
}

module.exports = {
  getStatus,
  getRemaining,
  savePersonalDetails,
  setLanguage,
};
