const { pool } = require('../db');
const logger = require('../logger');
const deepSkillService = require('./deep-skill.service');
const lifecycleService = require('./easyfixer-lifecycle.service');
const registrationProfile = require('./technician-registration-profile.service');
const profileCompletion = require('./profile-completion.service');
// One definition of "mandatory", shared with the mobile training list — two
// copies of this SQL would drift the first time either was touched.
const { mandatoryVideoIdsSql } = require('./lms.service');

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

// "Training complete" = EVERY mandatory training_videos row watched to 100% by
// the tech (see fetchTrainingCompletedTime). The old logic gated on ONLY the last
// video (id=3), so finishing a single video wrongly marked the whole section done
// — which is what the app's `allComplete` gate already requires.

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
  const lifecycleProjection = await lifecycleService.readProjection('e');
  const [[row]] = await pool.query(
    `SELECT e.efr_id,
            e.efr_first_name, e.efr_name, e.efr_no,
            e.efr_profile_img,
            e.efr_profile_perc,
            e.efr_status,
            e.last_inactive_date_time,
            e.scheduled_reactivation_date,
            e.efr_manager_id,
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
            ${lifecycleProjection},
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
    // Complete only when the tech has a 100%-watched row for EVERY mandatory
    // training_videos row (video_id = training_videos.id). Returns the latest
    // completion timestamp, or null while any mandatory video is unfinished.
    /*
     * MANDATORY, not "every row in the table".
     *
     * This counted all of training_videos, which also holds LMS course
     * content. Adding one course video therefore raised `total` for EVERY
     * technician — 3 to 4 on 2026-08-26 — so ~2,600 people who had finished
     * the real three fell to done < total, trainingCompletedTime went NULL,
     * and jobsUnlocked (below) went false platform-wide. The video they were
     * being asked for was a YouTube link the app could not play, so no action
     * available to them could have cleared it.
     *
     * Both halves must use the same set. Scoping only `total` would let a
     * technician who watched an ASSIGNED course video count it towards the
     * mandatory tally and pass the gate without watching a mandatory one.
     */
    // Resolved ONCE and reused for both halves. Two awaits could straddle the
    // probe's TTL and build the two subqueries from different answers, which
    // is the same "both halves must use the same set" rule stated above.
    const mandatorySql = await mandatoryVideoIdsSql();
    const [[row]] = await pool.query(
      `SELECT (SELECT COUNT(*) FROM (${mandatorySql}) m) AS total,
              COUNT(DISTINCT w.video_id)                            AS done,
              MAX(w.update_date)                                    AS last_done
         FROM easyfixer_watched_video w
        WHERE w.easyfixer_id = ?
          AND w.watched_percentage = 100
          AND w.video_id IN (${mandatorySql})`,
      // Three binds: the total subquery, the watcher filter, then the IN subquery.
      [efrId, efrId, efrId],
    );
    const total = Number(row?.total || 0);
    const done = Number(row?.done || 0);
    if (total === 0) {
      /*
       * Nothing is mandatory. Report NOT complete and say so loudly rather
       * than failing open: an empty mandatory set means someone cleared
       * is_global across the catalogue, and silently unlocking earning for
       * everyone is the worse of the two wrong answers.
       */
      logger.warn({ efrId }, 'registration: mandatory training set is EMPTY — check training_videos.is_global');
      return null;
    }
    return done >= total ? (row?.last_done || null) : null;
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
  /*
   * Gate 1 incomplete (personal step + Aadhaar + photo) → merged reg screen.
   *
   * ...UNLESS the CRM has already activated them. Ops verification gates JOB
   * OFFERS, not the home screen: a technician the CRM has vetted and switched
   * on is working, and walling them behind registration because one field is
   * missing from the newer schema strands them in a flow they have already
   * been through. They land on the dashboard instead, where the existing
   * "Your Profile Is Under Review" banner and UnlockChecklist/ProgressNudges
   * ask for whatever is missing — and jobsUnlocked below STILL requires
   * hasSkills + trainingComplete, so nothing about work access is loosened.
   *
   * The bounce this fixes was not the gate router, which already sends an
   * ACTIVE lifecycle to the dashboard. It was _layout.tsx's welcomeEligible,
   * which treats status === 'personal_pending' as "new technician" and whose
   * PostOtpWelcomeModal "Get Started" does
   * router.replace('/(registration)/complete-profile'). Returning a truthful
   * status for this population turns that modal off at the source.
   *
   * The ordering guard this relaxes ("verified checked LAST so an out-of-order
   * flag cannot leak a tech past Gate 1") still holds for everyone who is NOT
   * CRM-activated — which is the population it was written to protect.
   */
  if (!flags.gate1Complete && !flags.isTechnicianVerified) return 'personal_pending';
  // Gate 1 done but CRM hasn't activated → in the app, unverified (non-blocking).
  if (!flags.isTechnicianVerified) return 'pending_verification';
  return 'active';
}

// Skills are declared via the deep-skill picker → tbl_efr_deepskill_mapping
// (is_repairing=1 = active), which is ALSO what candidate-ranking matches jobs on.
// The legacy efr_service_category/efr_service_type CSV columns are NOT written by
// that flow, so checking them alone wrongly reported "no skills" for a tech who
// actually has active deep-skill mappings (the "Add your skills" bug).
async function fetchHasActiveSkills(efrId) {
  try {
    const [rows] = await pool.query(
      `SELECT 1 FROM tbl_efr_deepskill_mapping
        WHERE easyfixer_id = ? AND is_repairing = 1 LIMIT 1`,
      [efrId],
    );
    return rows.length > 0;
  } catch (e) {
    logger.info({ err: e.message, efrId }, 'registration: deep-skill mapping lookup failed; treating as no-skills');
    return false;
  }
}

async function getStatus(efrId, authenticatedLifecycle = null) {
  logger.info('Registration status · efrId=' + efrId);
  const e = await fetchGateRow(efrId);
  if (!e) {
    logger.warn('Registration status: technician not found · efrId=' + efrId);
    const err = new Error('technician not found');
    err.status = 404;
    throw err;
  }

  const [profileImageUrl, trainingCompletedTime, hasActiveSkills] = await Promise.all([
    resolveProfileImageUrl(e.efr_profile_img),
    fetchTrainingCompletedTime(efrId),
    fetchHasActiveSkills(efrId),
  ]);

  const completion = profileCompletion.fromRow({
    ...e,
    has_active_deep_skill: hasActiveSkills,
  });
  const { aadhaarPresent, photoPresent } = completion;
  const panPresent     = present(e.pan_card_number);
  // "Has skills" = the tech declared at least a service category/type (the
  // matching key candidate-ranking needs). Folded into the Gate-2 checklist,
  // no longer a registration wall.
  const hasSkills      = completion.skillsComplete;
  const isPersonalDetailFilled = completion.personalDetailsComplete;
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
  // Auth already owns request-time overlays such as overdue training. Prefer
  // that authoritative snapshot when this is an authenticated mobile request;
  // background callers without req.tech keep the persisted-row projection.
  // This is an in-memory handoff: no second overdue-training query and no
  // duplicate capability logic on the registration hot path.
  const lifecycle = authenticatedLifecycle || lifecycleService.forTechnician(
    lifecycleService.lifecycleFromRow(e),
  );

  /*
   * Deactivation is reported ADDITIVELY — deliberately NOT as a new `status`
   * value. The app maps status through an exhaustive
   * `Record<RegistrationStatus, string>` (app: (registration)/index.tsx), so an
   * unrecognised value would resolve to `undefined` and break the redirect.
   * Shipping a new enum member would therefore require an app release; a new
   * FIELD is ignored by current builds and consumed by the next one.
   *
   * Only an EXPLICIT 0 counts. `efr_status` is NULL on legacy rows that predate
   * the flag, and treating NULL as deactivated would wrongly lock out a large
   * slice of existing technicians.
   */
  const deactivated = e.efr_status != null && Number(e.efr_status) === 0;

  // Gate 2 (earning) unlock: CRM-verified AND the tech has the skills + training
  // the first job needs. PAN is deliberately deferred until the first
  // withdrawal: keep it in the checklist as payout-readiness information, but
  // never block job access on it.
  const trainingComplete = !!trainingCompletedTime;
  // A deactivated technician can never be offered work (candidate-ranking and
  // job.service both require efr_status = 1), so report jobs as locked. This is
  // what makes the deactivated experience correct on TODAY's app build with no
  // client change: they log in, reach the dashboard, and jobs are shown locked
  // instead of appearing available and silently never arriving.
  const jobsUnlocked = lifecycle.capabilities?.receiveNewJobs === true && !deactivated
    && flags.isTechnicianVerified && hasSkills && trainingComplete;

  logger.info('Returning registration status · status=' + status + ' profilePct=' + pct(e.efr_profile_perc) + ' jobsUnlocked=' + jobsUnlocked + ' deactivated=' + deactivated);

  return {
    status,
    verified:             flags.isTechnicianVerified,
    jobsUnlocked,
    /*
     * Additive deactivation block — new fields, existing `status` untouched.
     * A future app build renders a "your account is deactivated, contact
     * support" screen from these; current builds ignore them harmlessly.
     */
    deactivated,
    // `last_inactive_date_time` only — the internal `inactive_reason` FK and
    // `inactive_comment` are Ops notes and are intentionally NOT surfaced to the
    // technician; the app shows a generic "contact support" message instead.
    deactivatedSince:     deactivated ? (e.last_inactive_date_time || null) : null,
    // Additive v5.1 lifecycle contract. Old app versions ignore this field;
    // new versions use it to render PAUSED/DORMANT/re-application experiences.
    lifecycle,
    // Dashboard readiness checklist. `panPresent` is additive payout-readiness
    // information and is not part of the jobsUnlocked predicate.
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
 * efr_personal_details_perc to 100. The legacy personal-details route never
 * writes a numeric city FK from free text. The atomic Work Area contract can
 * pass a catalogue-resolved location and then updates efr_cityId plus the
 * linked user's pincode/city/state through this same helper.
 *
 * COALESCE-guards every optional column so a partial submit never blanks
 * a previously-saved value.
 */
async function persistPersonalDetails(efrId, body, runner, location = null) {
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

  await runner.query(
    `UPDATE tbl_easyfixer
        SET efr_name        = COALESCE(?, efr_name),
            efr_first_name  = COALESCE(?, efr_first_name),
            efr_last_name   = COALESCE(?, efr_last_name),
            efr_pin_no      = COALESCE(?, efr_pin_no),
            efr_cityId      = COALESCE(?, efr_cityId),
            efr_address     = COALESCE(?, efr_address),
            efr_personal_details_perc = 100
      WHERE efr_id = ?`,
    [
      fullName || null,
      firstName,
      lastName,
      body.pincode != null ? String(body.pincode).trim() : null,
      location?.cityId ?? null,
      addressLine,
      efrId,
    ],
  );

  // Mark the personal step as submitted on tbl_user so the gate machine
  // advances out of `personal_pending`. Only writes when a linked user
  // row exists (idle leads with no user account are a no-op).
  const [[row]] = await runner.query(
    'SELECT user_id FROM tbl_easyfixer WHERE efr_id = ? LIMIT 1',
    [efrId],
  );
  if (row?.user_id) {
    await runner.query(
      `UPDATE tbl_user
          SET is_personal_detail_filled = 1,
              pin_code = COALESCE(?, pin_code),
              city = COALESCE(?, city),
              state = COALESCE(?, state)
        WHERE user_id = ?`,
      [
        location?.pincode ?? null,
        location?.city ?? null,
        location?.state ?? null,
        row.user_id,
      ],
    );
  }

  return { userId: row?.user_id || null };
}

async function savePersonalDetails(efrId, body) {
  const { userId } = await persistPersonalDetails(efrId, body, pool);

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
      userId,
      deviceLat: body.latitude,
      deviceLng: body.longitude,
    }).catch((err) => {
      logger.warn('Registration location enrichment failed (non-fatal) · efrId=' + efrId + ' · ' + (err && err.message ? err.message : err));
    });
  }

  logger.info('Personal details saved · efrId=' + efrId + ' personalStepMarked=' + Boolean(userId));
  return { ok: true };
}

// ─── PUT work-area (atomic home + full serviceable set) ─────────────
async function saveWorkArea(efrId, body, database = pool) {
  // Lazy to avoid the verification -> registration-status-push -> this module
  // cycle during process startup.
  // eslint-disable-next-line global-require
  const verificationService = require('./easyfixer-verification.service');
  const name = String(body?.name || '').trim();
  const homePincode = String(body?.homePincode || '').trim();
  const pincodes = Array.isArray(body?.pincodes)
    ? Array.from(new Set(body.pincodes.map((value) => String(value).trim())))
    : [];

  const invalidPincode = pincodes.some((pincode) => !/^\d{6}$/.test(pincode));
  if (name.length > 150) {
    const error = new Error('name must not exceed 150 characters');
    error.status = 400;
    throw error;
  }
  if (!/^\d{6}$/.test(homePincode)) {
    const error = new Error('homePincode must be exactly 6 digits');
    error.status = 400;
    throw error;
  }
  if (pincodes.length === 0 || pincodes.length > 50 || invalidPincode) {
    const error = new Error('pincodes must contain between 1 and 50 valid 6-digit pincodes');
    error.status = 400;
    throw error;
  }
  if (!pincodes.includes(homePincode)) {
    const error = new Error('homePincode must be included in pincodes');
    error.status = 400;
    throw error;
  }

  const ownsConnection = typeof database.getConnection === 'function';
  const conn = ownsConnection ? await database.getConnection() : database;
  let transactionStarted = false;
  let location;
  let replacement;
  try {
    // Resolve through the existing one-query registration lookup before taking
    // write locks. All actual profile + service-area writes remain inside the
    // transaction below.
    location = await registrationProfile.resolvePincode(homePincode, conn);
    if (!location) {
      const error = new Error('home pincode is not available in the pincode directory');
      error.status = 422;
      throw error;
    }
    if (!location.cityId || !location.city || !location.state) {
      const error = new Error('home pincode has no complete city and state mapping');
      error.status = 422;
      throw error;
    }

    await conn.beginTransaction();
    transactionStarted = true;
    await persistPersonalDetails(
      efrId,
      { ...(name ? { name } : {}), pincode: homePincode },
      conn,
      location,
    );
    replacement = await verificationService.replaceServiceablePincodes(
      efrId,
      pincodes,
      null,
      conn,
      { representation: 'value' },
    );
    if (Number(replacement.updated) !== pincodes.length) {
      // The shared CRM helper intentionally tolerates a partial catalogue
      // match. This endpoint is a full-replacement offline contract, so an ACK
      // must mean every requested PIN was persisted. Roll back on catalogue
      // drift instead of letting the app discard a PIN it believes was saved.
      const error = new Error('one or more serviceable pincodes are not available in the pincode directory');
      error.status = 422;
      throw error;
    }
    await conn.commit();
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try { await conn.rollback(); } catch (_) { /* retain original failure */ }
    }
    throw error;
  } finally {
    if (ownsConnection) conn.release();
  }

  // Finalization is deliberately post-commit and derived from persisted gates.
  // It is state-idempotent and simply reports finalized=false while Skills or
  // Identity remain incomplete, so the three profile cards stay order-free.
  const finalization = await finalizeGate1AfterSave(efrId);
  return {
    ok: true,
    name: name || null,
    homePincode,
    pincodes,
    location,
    serviceablePincodesUpdated: replacement.updated,
    finalization,
  };
}

async function finalizeGate1(efrId) {
  logger.info('Finalize registration Gate 1 · efrId=' + efrId);
  const result = await lifecycleService.finalizeMobileRegistrationGate1(efrId);
  if (!result.schemaInstalled) {
    // Before the additive migration the legacy derived gate remains the source
    // of truth, so finalization is an intentional no-op.
    return { finalized: false, schemaInstalled: false, lifecycle: null };
  }
  return {
    finalized: result.changed === true,
    schemaInstalled: true,
    lifecycle: result.lifecycle,
  };
}

/**
 * Automatic finalization runs after every order-independent profile card.
 * Missing cards are expected and return a successful pending projection;
 * transient/system failures still reject so the standalone durable finalize
 * operation remains queued for retry.
 */
async function finalizeGate1IfReady(efrId) {
  try {
    return await finalizeGate1(efrId);
  } catch (error) {
    if (
      Number(error?.status) === 409
      && error?.details?.code === 'REGISTRATION_GATE1_INCOMPLETE'
    ) {
      return {
        finalized: false,
        schemaInstalled: true,
        lifecycle: null,
        pending: true,
        missing: Array.isArray(error.details.missing) ? error.details.missing : [],
      };
    }
    throw error;
  }
}

/**
 * Profile-card domain data has already committed before this derived
 * transition runs. No finalization error may turn that applied write into a
 * client failure: a durable client would otherwise dead-letter the save while
 * the database already contains it. The explicit /registration/finalize
 * endpoint remains strict and is the independently retryable convergence path.
 */
async function finalizeGate1AfterSave(efrId) {
  try {
    return await finalizeGate1IfReady(efrId);
  } catch (error) {
    logger.warn({
      efrId,
      status: Number(error?.status) || 500,
      code: error?.details?.code || error?.code || 'REGISTRATION_FINALIZATION_DEFERRED',
    }, 'Post-save Gate-1 finalization deferred');
    return {
      finalized: false,
      schemaInstalled: null,
      lifecycle: null,
      pending: true,
      errorCode: 'REGISTRATION_FINALIZATION_DEFERRED',
    };
  }
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
async function setLanguage(efrId, language, runner = pool) {
  const lang = String(language || '').trim();
  logger.info('Set preferred language · language=' + (lang || '-'));
  if (!lang) {
    logger.warn('Set language rejected · language is required');
    const err = new Error('language is required');
    err.status = 400;
    throw err;
  }

  const [upd] = await runner.query(
    'UPDATE tbl_easyfixer_app SET language = ? WHERE efr_id = ?',
    [lang, efrId],
  );
  if (upd.affectedRows === 0) {
    // VERIFY: tbl_easyfixer_app PK column is `efr_id` (per legacy
    // EasyfixApp @Entity). Insert a minimal row carrying the language.
    await runner.query(
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
  saveWorkArea,
  finalizeGate1,
  finalizeGate1IfReady,
  finalizeGate1AfterSave,
  setLanguage,
  // Exposed for tests only: deriveStatus decides which route group the app
  // mounts, so its precedence deserves direct assertions rather than being
  // reachable only through a full getStatus fake-pool fixture.
  _internals: { deriveStatus },
};
