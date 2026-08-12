const { pool } = require('../db');
const deepSkillService = require('./deep-skill.service');
const logger = require('../logger');
const registrationStatusPush = require('./registration-status-push.service');
const lifecycle = require('./easyfixer-lifecycle.service');
const { mapAadhaarUniqueViolation } = require('../utils/aadhaar-uniqueness');

/*
 * Easyfixer Verification — service backing the "Self-Registration
 * verification and profile activation" page (rebuild of legacy
 * EasyFix_CRM/pages/easyfixers/eferVerification.vm).
 *
 * Source of truth for column names + flows:
 *   - Legacy VM: EasyFix_CRM/src/main/webapp/pages/easyfixers/eferVerification.vm
 *   - Legacy DAO: EasyFix_CRM/.../dao/EasyfixerDaoImpl.java
 *
 * Tables touched (all already exist on tbl_easyfixer / easyfixer_comments
 * / tbl_easyfixer_bank_details / tbl_user). No schema migration required —
 * the legacy schema is authoritative and the existing /admin/easyfixers/:id
 * endpoint already projects e.* so every column below is reachable.
 *
 * Section-name constants match the legacy `comment_in_section` strings
 * exactly so the comments thread is interoperable with the legacy CRM
 * during the cutover window.
 */

const SECTION = {
  LEAD:         'Registration Details Section',
  PROFESSIONAL: 'Professional Details Section',
  PERSONAL:     'Personal Details Section',
  BANKING:      'Banking Details Section',
  IDENTITY:     'Identity Details Section',
  ACTIVATION:   'Technician Activation Section',
};

// ─── Helpers ────────────────────────────────────────────────────────
function pct(v) {
  const n = Number(v || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/*
 * Per-process guard for the read-time location backfill (see getVerificationPage).
 * The backfill may hit a live Google geocode; a lead whose pincode is
 * un-geocodable would otherwise re-fire that geocode on EVERY page load / every
 * section save, because a failed enrichment leaves efr_cityId blank and the
 * guard condition true. This Set caps the attempt to ONCE per lead per process
 * regardless of outcome. Successful backfills set efr_cityId (which clears the
 * outer condition anyway) — this only bounds the un-resolvable tail. Bounded so
 * it can never grow without limit.
 */
const _locBackfillAttempted = new Set();
function _markLocBackfillAttempted(efrId) {
  if (_locBackfillAttempted.size > 5000) _locBackfillAttempted.clear();
  _locBackfillAttempted.add(efrId);
}

function bool(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (Buffer.isBuffer(v)) return v[0] === 1;
  return Number(v) === 1;
}

// Fetch easyfixer + user/city/state/experience joins required by the
// verification page. Mirrors the legacy getEasyfixerDetailsById query
// shape, projected through the existing tbl_easyfixer + side tables.
async function getEasyfixerForVerification(efrId) {
  const [[row]] = await pool.query(
    `SELECT
        E.*,
        C.city_name                     AS city_name,
        S.state_name                    AS state_name,
        U.user_name                     AS tx_full_name,
        U.city                          AS app_city_name,
        U.state                         AS app_state_name,
        U.pin_code                      AS app_pincode,
        U.district                      AS user_district,
        U.personal_details_filled       AS personal_details_filled,
        U.is_personal_detail_filled     AS is_personal_detail_filled,
        U.update_date                   AS user_update_date,
        UB.user_name                    AS approved_by_user,
        UU.user_name                    AS update_details_by_user,
        ZM.user_name                    AS state_user,
        EX.name                         AS experience_name
       FROM tbl_easyfixer E
       LEFT JOIN tbl_city  C  ON C.city_id  = E.efr_cityId
       LEFT JOIN tbl_state S  ON S.state_id = C.state_id
       LEFT JOIN tbl_user  ZM ON ZM.user_id = C.state_user
       LEFT JOIN tbl_user  U  ON U.user_id  = E.user_id
       LEFT JOIN tbl_user  UB ON UB.user_id = U.updated_by
       LEFT JOIN tbl_user  UU ON UU.user_id = E.updated_by
       LEFT JOIN experience EX ON EX.id     = E.experience_id
      WHERE E.efr_id = ?
      LIMIT 1`,
    [efrId]
  );
  return row || null;
}

async function getBanking(efrId) {
  const [[row]] = await pool.query(
    // Bank-name lookup lives in `bank_name` (id, bank_name, is_easyfix_bank) —
    // the legacy `tbl_easyfix_bank` table does not exist on the live DB
    // (confirmed 2026-06-16; same table the /shared/lookup/banks endpoint reads).
    `SELECT tb.*, eb.bank_name AS easyfix_bank_name, U.user_name AS updated_by_name
       FROM tbl_easyfixer_bank_details tb
       LEFT JOIN bank_name eb ON eb.id = tb.easyfix_bank_name_id
       LEFT JOIN tbl_user U   ON U.user_id = tb.updated_by
      WHERE tb.efr_id = ? LIMIT 1`,
    [efrId]
  );
  return row || null;
}

async function getCommentsBySection(efrId, section) {
  const [rows] = await pool.query(
    `SELECT id, comment, commented_by, comment_in_section,
            commented_on, commented_by_id
       FROM easyfixer_comments
      WHERE easyfixer_id = ? AND comment_in_section = ?
      ORDER BY id DESC`,
    [efrId, section]
  );
  return rows.map((r) => ({
    id: r.id,
    text: r.comment,
    author: r.commented_by,
    authorId: r.commented_by_id,
    section: r.comment_in_section,
    createdAt: r.commented_on,
  }));
}

async function listEasyfixBanks() {
  // `bank_name` is the unified bank table; the EasyFix-curated subset is
  // flagged by `is_easyfix_bank = 1` (there is no `bank_status` column here —
  // that belonged to the non-existent legacy `tbl_easyfix_bank`).
  const [rows] = await pool.query(
    `SELECT id, bank_name FROM bank_name WHERE is_easyfix_bank = 1 ORDER BY bank_name`
  );
  return rows;
}

async function listCitiesForLookup() {
  const [rows] = await pool.query(
    `SELECT city_id, city_name FROM tbl_city WHERE city_status = 1 ORDER BY city_name`
  );
  return rows;
}

// Legacy progress-bar calculations live on tbl_easyfixer as
// efr_professional_details_perc / efr_personal_details_perc /
// efr_bank_details_perc / efr_identity_details_perc — populated by the
// technician mobile app + legacy CRM writes. We surface them verbatim.
// efr_profile_perc is the overall registration-verification roll-up.

// ─── Public: full page payload ──────────────────────────────────────
async function getVerificationPage(efrId) {
  logger.info('Load easyfixer verification page · efrId=' + efrId);
  let e = await getEasyfixerForVerification(efrId);
  if (!e) {
    logger.warn('Verification page not found · efrId=' + efrId);
    return null;
  }

  // Lazy geocode backfill (2026-07-09) — self-registered leads submit only a
  // raw pincode from the app. If the city FK was never resolved (older leads
  // predating the registration-time enrichment), fill it now, ONCE, so City /
  // State / State-User / GPS render on this page and the list. Fail-soft; on
  // success we re-read the joined row so THIS response reflects the backfill
  // without requiring a second page load.
  //
  // Gated to SELF-REGISTERED leads (new_easy_fixer = 1) so opening the
  // verification page for an operator-curated easyfixer never auto-geocodes /
  // creates master data as a side-effect of a read. Guarded to at most ONE
  // attempt per lead per process (_locBackfillAttempted) so an un-geocodable
  // pincode can't re-hit Google on every load / every section-save.
  if (
    Number(e.new_easy_fixer) === 1 &&
    (e.efr_cityId == null || Number(e.efr_cityId) === 0) &&
    e.efr_pin_no && !e.city_name &&
    !_locBackfillAttempted.has(efrId)
  ) {
    _markLocBackfillAttempted(efrId);
    try {
      const { enrichEasyfixerLocationFromPincode } = require('./easyfixer-location.service');
      const res = await enrichEasyfixerLocationFromPincode({
        efrId,
        pincode: e.efr_pin_no,
        userId: e.user_id || null,
      });
      if (res && res.enriched) {
        const fresh = await getEasyfixerForVerification(efrId);
        if (fresh) e = fresh;
      }
    } catch (err) {
      logger.warn('Verification lazy location backfill failed (non-fatal) · efrId=' + efrId + ' · ' + (err && err.message ? err.message : err));
    }
  }

  /*
   * Additional Details counts (2026-06-11) — Deep Skill Option Mapping
   * + Serviceable Pincodes. These drive the section's progress bar so
   * it paints correctly on first render without waiting for child
   * components to mount + fetch their own data. 50% per child:
   *   - deep-skill mappings > 0   → +50
   *   - serviceable pincodes > 0  → +50
   * Both queries are cheap (covering index / single PK lookup).
   */
  const [banking, banks, cities,
    leadComments, profComments, persComments,
    bankComments, idComments, actComments,
    deepSkillCountRow, serviceablePincodesRow] = await Promise.all([
    getBanking(efrId),
    listEasyfixBanks(),
    listCitiesForLookup(),
    getCommentsBySection(efrId, SECTION.LEAD),
    getCommentsBySection(efrId, SECTION.PROFESSIONAL),
    getCommentsBySection(efrId, SECTION.PERSONAL),
    getCommentsBySection(efrId, SECTION.BANKING),
    getCommentsBySection(efrId, SECTION.IDENTITY),
    getCommentsBySection(efrId, SECTION.ACTIVATION),
    pool.query(
      `SELECT COUNT(*) AS cnt FROM tbl_efr_deepskill_mapping
        WHERE easyfixer_id = ? AND is_repairing = 1`,
      [efrId],
    ).then(([rows]) => rows[0] || { cnt: 0 }).catch((e) => { logger.warn({ efrId, err: e }, 'verification: deep-skill mapping count read failed — rendering 0'); return { cnt: 0 }; }),
    pool.query(
      'SELECT pincodes FROM tbl_efr_serviceable_pincodes WHERE easyfixer_id = ?',
      [efrId],
    ).then(([rows]) => rows[0] || { pincodes: '' }).catch((e) => { logger.warn({ efrId, err: e }, 'verification: serviceable pincodes read failed — rendering empty'); return { pincodes: '' }; }),
  ]);

  const deepSkillsCount = Number(deepSkillCountRow.cnt || 0);
  const pincodeCsv = String(serviceablePincodesRow.pincodes || '').trim();
  const serviceablePincodesCount = pincodeCsv
    ? pincodeCsv.split(',').map((p) => p.trim()).filter(Boolean).length
    : 0;

  const fullName = e.tx_full_name || e.efr_name || '';
  const personalDetailsFilled = e.personal_details_filled; // 0 | 1 | 2

  // Verification gate (mirrors legacy isIdentityDetailsVerified == 1).
  const proceedAllowed = Number(e.is_identity_details_verified_by_crm) === 1;

  // Registration age (days since app login_date / insert_date on tbl_user).
  let registrationAgeDays = null;
  if (e.user_update_date || e.insert_date) {
    const start = new Date(e.user_update_date || e.insert_date).getTime();
    if (!Number.isNaN(start)) {
      registrationAgeDays = Math.floor((Date.now() - start) / 86400000);
    }
  }

  return {
    // Header
    header: {
      efr_id: e.efr_id,
      first_name: e.efr_first_name,
      last_name:  e.efr_last_name,
      full_name:  fullName,
      city_name:  e.city_name,
      is_active:  Number(e.efr_status) === 1,
      is_technician_verified: bool(e.is_technician_verified),
      is_existing_easyfixer:  bool(e.is_existing_easyfixer),
      mobile: e.efr_no,
    },

    // ─ Section 1: New Technician Lead ─
    lead: {
      eligibility: {
        primary_mobile:  e.efr_no,
        first_name:      e.efr_first_name,
        last_name:       e.efr_last_name,
        pincode:         e.app_pincode || e.efr_pin_no,
        state_name:      e.app_state_name || e.state_name,
        district:        e.user_district,
        city_name:       e.app_city_name || e.city_name,
        efr_cityId:      e.efr_cityId,
      },
      gps_location:     e.efr_base_gps,
      registration: {
        tx_id:           e.efr_id,
        tx_applied_on:   e.insert_date,
        state_user:      e.state_user,
        approved_by:     e.approved_by_user,
        approved_on:     e.user_update_date,
      },
      status: {
        personal_details_filled: personalDetailsFilled, // 0=new, 1=accepted, 2=denied
        progress: pct(personalDetailsFilled === 1 ? 100 : 0),
      },
      comments: leadComments,
    },

    // ─ Section 2: Registration Verification (4 sub-sections) ─
    registrationVerification: {
      overall_progress: pct(e.efr_profile_perc),
      is_verified: Number(e.is_identity_details_verified_by_crm) === 1,
      proceed_allowed: proceedAllowed,

      professional: {
        progress:               pct(e.efr_professional_details_perc),
        is_verified:            Number(e.efr_professional_details_perc) === 100 && Number(e.tool_rating || 0) > 0,
        // Editable
        experience_id:          e.experience_id,
        experience_name:        e.experience_name,
        skill_rating:           e.skill_rating,
        tool_rating:            e.tool_rating,
        skill_rating_comment:   e.skill_rating_comment_from_crm,
        tool_rating_comment:    e.tool_rating_comment_from_crm,
        // Readonly badges
        service_category:       e.efr_service_category,
        service_type:           e.efr_service_type,
        have_bike:              bool(e.have_bike),
        use_whatsapp:           bool(e.use_whatsapp),
        // Readonly audit
        updated_by_name:        e.update_details_by_user,
        update_date:            e.update_date,
        comments: profComments,
      },

      personal: {
        progress:               pct(e.efr_personal_details_perc),
        is_verified:            Number(e.is_personal_details_verified_by_crm) === 1,
        // Readonly
        date_of_birth:          e.date_of_birth,
        marital_status:         e.efr_marital_status,
        children_count:         e.efr_children,
        emergency_mobile:       e.efr_alt_no,
        // Insurance flags (readonly + lightbox of attached photos — TODO photos)
        health_insurance:       bool(e.health_insurance),
        accidental_insurance:   bool(e.accidental_insurance),
        hobbies:                e.about_yourself2 || e.about_yourself,
        email:                  e.efr_email,
        is_email_verified:      bool(e.is_email_verified),
        verification_comment:   e.personal_details_verification_comment_crm,
        updated_by_name:        e.update_details_by_user,
        update_date:            e.update_date,
        comments: persComments,
      },

      banking: {
        progress:               pct(e.efr_bank_details_perc),
        is_verified:            Number(e.is_bank_details_verified_by_crm) === 1,
        verification_status:    e.is_bank_details_verified_by_crm, // 0/1/2
        bank_name:              banking?.bank_name,
        account_number:         banking?.efr_bank_acc_num,
        account_holder_name:    banking?.efr_bank_acc_name,
        ifsc_code:              banking?.efr_bank_ifsc,
        mode_of_payment:        banking?.mode_of_payment,
        is_verified_by_app:     bool(banking?.is_verified_by_app),
        cancelled_cheque_img:   e.cancelled_chq_img_name,
        verification_comment:   e.bank_details_verification_comment,
        updated_by_name:        e.update_details_by_user,
        update_date:            e.update_date,
        comments: bankComments,
      },

      identity: {
        progress:               pct(e.efr_identity_details_perc),
        is_verified:            Number(e.is_identity_details_verified_by_crm) === 1,
        verification_status:    e.is_identity_details_verified_by_crm, // 0/1/2
        adhaar_card_number:     e.adhaar_card_number,
        pan_card_number:        e.pan_card_number,
        // TODO: aadhaar front/back/pancard photo URLs come from
        // tbl_easyfixer_documents — wire once a document-listing endpoint
        // lands. Frontend currently shows the numbers + "not uploaded" hints.
        driving_lisence_img:    e.driving_lisence_img_name,
        rejected_reason:        e.send_back_to_tx_reason_crm,
        updated_by_name:        e.update_details_by_user,
        update_date:            e.update_date,
        comments: idComments,
      },
    },

    // ─ Section 3: Technician Activation ─
    activation: {
      progress: pct(
        bool(e.is_technician_verified) ? 100 :
        (proceedAllowed ? 50 : 0)
      ),
      is_activated:           bool(e.is_technician_verified),
      payment: {
        easyfix_bank_name_id: banking?.easyfix_bank_name_id || 0,
        easyfix_bank_name:    banking?.easyfix_bank_name,
        beneficiary_id:       banking?.beneficiary_id,
        // Disabled when already populated (matches legacy condition)
        is_locked:            Boolean(banking?.beneficiary_id && banking?.easyfix_bank_name_id && bool(e.is_technician_verified)),
      },
      bgv: {
        is_done:              !!e.bgv_report_img_name,   // proxy until tbl_easyfixer_documents tie-in
        // TODO: file picker upload — wire to S3 once decision is made on
        // bucket key (see project_easyfix_job_image_uploads convention; BGV
        // is technician-scoped, not job-scoped).
      },
      sidebar: {
        profile_img:          e.efr_profile_img,
        registration_age_days: registrationAgeDays,
        ec_date:              e.user_update_date,
        bgv_report_done:      !!e.bgv_report_img_name,
        finance_updated_by:   banking?.updated_by_name,
        finance_updated_on:   banking?.update_date,
      },
      comments: actComments,
    },

    // ─ Section 4: Additional Details (Skill & Service Area Mapping) ─
    additional: {
      deep_skills_count: deepSkillsCount,
      serviceable_pincodes_count: serviceablePincodesCount,
      progress: (deepSkillsCount > 0 ? 50 : 0) + (serviceablePincodesCount > 0 ? 50 : 0),
      is_complete: deepSkillsCount > 0 && serviceablePincodesCount > 0,
    },

    // Lookup data the page needs inline (cheap):
    lookups: {
      cities,
      easyfix_banks: banks,
    },
  };
}

// ─── Comments ───────────────────────────────────────────────────────
async function addComment(efrId, { text, section }, actor) {
  logger.info('Add verification comment · efrId=' + efrId + ' · section=' + section);
  if (!Object.values(SECTION).includes(section)) {
    logger.warn('Add comment rejected · invalid section=' + section + ' · efrId=' + efrId);
    const err = new Error('invalid section');
    err.status = 400;
    throw err;
  }
  const author = actor?.user_name || actor?.name || 'system';
  const authorId = actor?.user_id || null;
  await pool.query(
    `INSERT INTO easyfixer_comments
       (comment, commented_by, comment_in_section, commented_on, commented_by_id, easyfixer_id)
     VALUES (?, ?, ?, NOW(), ?, ?)`,
    [text, author, section, authorId, efrId]
  );
  logger.info('Comment added · efrId=' + efrId + ' · section=' + section);
  return getCommentsBySection(efrId, section);
}

// ─── Section savers (Section 2 sub-sections) ────────────────────────
async function saveProfessional(efrId, body, actor) {
  logger.info('Save professional details · efrId=' + efrId);
  const fields = [];
  const params = [];
  for (const [col, val] of [
    ['skill_rating',                  body.skill_rating],
    ['tool_rating',                   body.tool_rating],
    ['skill_rating_comment_from_crm', body.skill_rating_comment],
    ['tool_rating_comment_from_crm',  body.tool_rating_comment],
    ['experience_id',                 body.experience_id],
    ['efr_professional_details_perc', body.progress],
  ]) {
    if (val !== undefined) { fields.push(`${col} = ?`); params.push(val); }
  }
  if (!fields.length) {
    logger.info('Professional details unchanged (no fields) · efrId=' + efrId);
    return getVerificationPage(efrId);
  }
  fields.push('updated_by = ?', 'update_date = NOW()');
  params.push(actor?.user_id || null, efrId);
  await pool.query(`UPDATE tbl_easyfixer SET ${fields.join(', ')} WHERE efr_id = ?`, params);
  logger.info('Professional details updated · efrId=' + efrId + ' · fields=' + (fields.length - 2));
  return getVerificationPage(efrId);
}

// Personal details verification (matches updatepersonalDetailsVerificationById).
async function savePersonalFamily(efrId, body, actor) {
  logger.info('Save personal details verification · efrId=' + efrId + ' · is_verified=' + (body.is_verified ? 1 : 0));
  await pool.query(
    `UPDATE tbl_easyfixer
        SET is_personal_details_verified_by_crm = ?,
            personal_details_verification_comment_crm = ?,
            updated_by = ?,
            update_date = NOW()
      WHERE efr_id = ?`,
    [
      body.is_verified ? 1 : 0,
      body.verification_comment || null,
      actor?.user_id || null,
      efrId,
    ]
  );
  logger.info('Personal details verification updated · efrId=' + efrId);
  return getVerificationPage(efrId);
}

// Banking details verification (matches updateBankDetailsVerificationStatusById).
async function saveBanking(efrId, body, actor) {
  logger.info('Save banking verification · efrId=' + efrId + ' · verification_status=' + body.verification_status);
  if (Number(body.verification_status) === 1) {
    await pool.query(
      `UPDATE tbl_easyfixer
          SET is_bank_details_verified_by_crm = 1,
              updated_by = ?, update_date = NOW()
        WHERE efr_id = ?`,
      [actor?.user_id || null, efrId]
    );
  } else if (Number(body.verification_status) === 2) {
    await pool.query(
      `UPDATE tbl_easyfixer
          SET is_bank_details_verified_by_crm = 2,
              bank_details_verification_comment = ?,
              updated_by = ?, update_date = NOW()
        WHERE efr_id = ?`,
      [body.verification_comment || null, actor?.user_id || null, efrId]
    );
  }
  logger.info('Banking verification updated · efrId=' + efrId + ' · verification_status=' + body.verification_status);
  return getVerificationPage(efrId);
}

// Identity verification (matches updateIdentityDetailsVerificationStatusById).
async function applyIdentityMutation(db, efrId, body, actor) {
  const status = Number(body.verification_status);
  const sets = [];
  const params = [];
  if (body.adhaar_card_number !== undefined) {
    sets.push('adhaar_card_number = ?');
    params.push(body.adhaar_card_number);
  }
  if (body.pan_card_number !== undefined) {
    sets.push('pan_card_number = ?');
    params.push(body.pan_card_number);
  }
  if (status === 1) {
    sets.push(
      'is_identity_details_verified_by_crm = 1',
      'send_back_to_tx_reason_crm = NULL',
      'efr_identity_details_perc = COALESCE(?, efr_identity_details_perc)',
      'send_to_finance_date_time = NOW()',
    );
    params.push(body.progress ?? null);
  } else if (status === 2) {
    sets.push(
      'is_identity_details_verified_by_crm = 2',
      'send_back_to_tx_reason_crm = ?',
    );
    params.push(body.rejected_reason);
  }
  if (!sets.length) return;
  sets.push('updated_by = ?', 'update_date = NOW()');
  params.push(actor?.user_id || null, Number(efrId));
  await db.query(
    `UPDATE tbl_easyfixer SET ${sets.join(', ')} WHERE efr_id = ?`,
    params,
  );
}

async function saveIdentity(efrId, body, actor) {
  logger.info('Save identity verification · efrId=' + efrId + ' · verification_status=' + body.verification_status);
  const status = Number(body.verification_status);
  try {
    if (status === 1 || status === 2) {
      const installed = await lifecycle.hasLifecycleSchema();
      if (installed) {
        await lifecycle.syncFromVerificationFlagsAtomic(efrId, {
          ...(status === 2
            ? {
              status: 'VERIFICATION_REJECTED',
              reasonCode: 'IDENTITY_VERIFICATION_REJECTED',
              reason: body.rejected_reason || 'Identity verification rejected',
            }
            : {
              reasonCode: 'IDENTITY_VERIFICATION_APPROVED',
              reason: 'Identity verification approved',
            }),
          projectedRow: { is_identity_details_verified_by_crm: status },
          mutate: (conn) => applyIdentityMutation(conn, efrId, body, actor),
        }, actor);
      } else {
        await applyIdentityMutation(pool, efrId, body, actor);
        registrationStatusPush.notifyRegistrationStatusChanged(efrId).catch(() => {});
      }
    } else {
      await applyIdentityMutation(pool, efrId, body, actor);
    }
  } catch (error) {
    throw mapAadhaarUniqueViolation(error);
  }
  logger.info('Identity verification updated · efrId=' + efrId + ' · status=' + status);
  return getVerificationPage(efrId);
}

// ─── Lead step: Accept / Deny / Send back ───────────────────────────
// Mirrors legacy technicianVerification(id, personalDetailsfilled).
//   personalDetailsFilled = 0 → not eligible (new lead)
//                          1 → accepted
//                          2 → denied
async function setLeadVerification(efrId, body, actor) {
  logger.info('Set lead verification · efrId=' + efrId + ' · personal_details_filled=' + body.personal_details_filled);
  const v = Number(body.personal_details_filled);
  if (![0, 1, 2].includes(v)) { logger.warn('Lead verification rejected · invalid personal_details_filled=' + body.personal_details_filled + ' · efrId=' + efrId); const e = new Error('invalid personal_details_filled'); e.status = 400; throw e; }

  // Auto-append the comment line that mirrors legacy "Accepted / Denied / ..."
  const statusText = v === 1 ? 'Accepted' : v === 2 ? 'Denied' : 'Not Eligible To New Lead';
  const comment = `${statusText}${body.reason ? ' <br> ' + body.reason : ''}`;

  const applyLeadMutation = async (conn, row) => {
    if (!row.user_id) {
      const error = new Error('easyfixer has no linked user account — lead status cannot be set');
      error.status = 422;
      throw error;
    }
    if (v === 1 && body.efr_cityId) {
      await conn.query(
        `UPDATE tbl_easyfixer
            SET efr_cityId = ?, updated_by = ?, update_date = NOW()
          WHERE efr_id = ?`,
        [body.efr_cityId, actor?.user_id || null, efrId],
      );
    }
    await conn.query(
      `UPDATE tbl_user
          SET personal_details_filled = ?, updated_by = ?, user_status = 1,
              released_on_date_time = NOW(), update_date = NOW()
        WHERE user_id = ?`,
      [v, actor?.user_id || null, row.user_id],
    );
    // A transport retry sees the locked pre-mutation value already equal to v
    // and therefore cannot append the same status comment twice.
    if (Number(row.user_personal_details_filled) !== v) {
      await conn.query(
        `INSERT INTO easyfixer_comments
           (comment, commented_by, comment_in_section, commented_on, commented_by_id, easyfixer_id)
         VALUES (?, ?, ?, NOW(), ?, ?)`,
        [
          comment,
          actor?.user_name || actor?.name || 'system',
          SECTION.LEAD,
          actor?.user_id || null,
          efrId,
        ],
      );
    }
  };

  const lifecycleInstalled = await lifecycle.hasLifecycleSchema();
  if (lifecycleInstalled) {
    await lifecycle.syncFromVerificationFlagsAtomic(efrId, {
      ...(v === 2
        ? {
          status: 'APPLICATION_REJECTED',
          reasonCode: 'LEAD_APPLICATION_REJECTED',
          reason: body.reason || 'Application rejected during lead verification',
        }
        : {
          reasonCode: v === 1 ? 'LEAD_ACCEPTED' : 'LEAD_RESET',
          reason: body.reason || statusText,
        }),
      projectedRow: { user_personal_details_filled: v },
      mutate: applyLeadMutation,
    }, actor);
  } else {
    const [[row]] = await pool.query(
      'SELECT e.user_id, u.personal_details_filled AS user_personal_details_filled FROM tbl_easyfixer e LEFT JOIN tbl_user u ON u.user_id = e.user_id WHERE e.efr_id = ? LIMIT 1',
      [efrId],
    );
    if (!row) {
      const error = new Error('easyfixer not found');
      error.status = 404;
      throw error;
    }
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await applyLeadMutation(conn, row);
      await conn.commit();
    } catch (error) {
      await conn.rollback().catch(() => {});
      logger.error('Lead verification transaction failed · efrId=' + efrId + ' · ' + error.message);
      throw error;
    } finally {
      conn.release();
    }
    registrationStatusPush.notifyRegistrationStatusChanged(efrId).catch(() => {});
  }

  logger.info('Lead verification set · efrId=' + efrId + ' · status=' + statusText);

  return getVerificationPage(efrId);
}

// ─── Proceed to Tx Activation gate ──────────────────────────────────
// Replicates legacy condition: identity verified == 1.
async function proceedToActivation(efrId) {
  logger.info('Check proceed-to-activation gate · efrId=' + efrId);
  const e = await getEasyfixerForVerification(efrId);
  if (!e) { logger.warn('Proceed-to-activation failed · easyfixer not found · efrId=' + efrId); const err = new Error('easyfixer not found'); err.status = 404; throw err; }

  // Gate checks — all 4 sub-sections plus identity verified flag.
  const ok =
    Number(e.is_identity_details_verified_by_crm) === 1 &&
    Number(e.efr_profile_perc || 0) >= 100;

  if (!ok) {
    logger.warn('Proceed-to-activation blocked · efrId=' + efrId + ' · profile_perc=' + Number(e.efr_profile_perc || 0) + ' · identity_verified=' + (Number(e.is_identity_details_verified_by_crm) === 1));
    const err = new Error('cannot proceed: identity not verified or profile incomplete');
    err.status = 409;
    err.details = {
      efr_profile_perc: Number(e.efr_profile_perc || 0),
      is_identity_verified: Number(e.is_identity_details_verified_by_crm) === 1,
    };
    throw err;
  }
  logger.info('Proceed-to-activation allowed · efrId=' + efrId);
  // Idempotent — the next step (activate) is where state actually changes.
  return { proceed: true };
}

// ─── Activation save (Section 3) ────────────────────────────────────
async function saveActivation(efrId, body, actor) {
  logger.info('Save activation · efrId=' + efrId + ' · activate=' + (body.activate === true));
  let lifecycleInstalled = false;
  if (body.activate === true) {
    lifecycleInstalled = await lifecycle.hasLifecycleSchema();
  }
  // Banking: easyfix_bank_name_id + beneficiary_id (Edit Finance Details).
  if (body.easyfix_bank_name_id !== undefined || body.beneficiary_id !== undefined) {
    const [[existing]] = await pool.query(
      `SELECT id FROM tbl_easyfixer_bank_details WHERE efr_id = ? LIMIT 1`,
      [efrId]
    );
    if (existing) {
      const sets = [];
      const params = [];
      if (body.easyfix_bank_name_id !== undefined) { sets.push('easyfix_bank_name_id = ?'); params.push(body.easyfix_bank_name_id || null); }
      if (body.beneficiary_id        !== undefined) { sets.push('beneficiary_id = ?');        params.push(body.beneficiary_id || null); }
      sets.push('updated_by = ?', 'update_date = NOW()');
      params.push(actor?.user_id || null, efrId);
      await pool.query(`UPDATE tbl_easyfixer_bank_details SET ${sets.join(', ')} WHERE efr_id = ?`, params);
    }
  }

  // Final activation toggle — replicates updateEasyfixerFinalAcceptComment.
  if (body.activate === true) {
    if (lifecycleInstalled) {
      // Lifecycle service owns the transaction: verification flags, legacy
      // efr_status projection and audit row commit atomically, then push fires.
      await lifecycle.activateFromVerification(efrId, body, actor);
    } else {
      await pool.query(
        `UPDATE tbl_easyfixer
            SET final_accept_comment = ?,
                efr_type = COALESCE(?, efr_type),
                is_technician_verified = 1,
                profile_crm_activation_by = ?,
                profile_activation_date_time = NOW(),
                efr_status = 1,
                is_eligible_for_offline_orders = COALESCE(?, is_eligible_for_offline_orders)
          WHERE efr_id = ?`,
        [
          body.final_accept_comment || null,
          body.grade || null,
          actor?.user_id || null,
          body.is_eligible_for_offline_orders ?? null,
          efrId,
        ],
      );
      // Pre-migration fallback: keep the existing app refresh push.
      registrationStatusPush.notifyRegistrationStatusChanged(efrId, { status: 'active' }).catch(() => {});
    }
    logger.info('Technician activated · efrId=' + efrId);
  }
  return getVerificationPage(efrId);
}

// ─── Client mapping (Activation: Allocate Clients + Map clients) ────
// `client_ids` is the FINAL list (set semantics) — we INSERT/UPDATE active
// mappings and soft-disable any not in the list (mapping_status=0).
async function mapClients(efrId, clientIds, actor) {
  const ids = Array.isArray(clientIds) ? clientIds.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  logger.info('Map clients to easyfixer · efrId=' + efrId + ' · clients=' + ids.length);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Soft-disable mappings not in the list.
    await conn.query(
      `UPDATE tbl_client_easyfixer_mapping
          SET mapping_status = 0, updated_by = ?, update_date = NOW()
        WHERE easyfixer_id = ? ${ids.length ? `AND client_id NOT IN (${ids.map(() => '?').join(',')})` : ''}`,
      [actor?.user_id || null, efrId, ...ids]
    );
    // Upsert each id (mapping_status=1).
    for (const cid of ids) {
      await conn.query(
        `INSERT INTO tbl_client_easyfixer_mapping
           (client_id, easyfixer_id, mapping_status, inserted_by, insert_date, update_date)
         VALUES (?, ?, 1, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE mapping_status = 1, updated_by = VALUES(inserted_by), update_date = NOW()`,
        [cid, efrId, actor?.user_id || null]
      );
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback().catch(() => {});
    logger.error('Map clients transaction failed · efrId=' + efrId + ' · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }
  logger.info('Clients mapped · efrId=' + efrId + ' · clients=' + ids.length);
  return getVerificationPage(efrId);
}

// ─── Deep Skill Option Mappings (tbl_efr_deepskill_mapping) ─────────
/*
 * Mapping tier 4 (Service Category → Service Type → Deep Skill →
 * Deep-skill Option) onto a single easyfixer. Persisted in
 * tbl_efr_deepskill_mapping, one row per (easyfixer × option).
 *
 * Schema quirk — see docblock in services/deep-skill.service.js for
 * the full story. TL;DR the two id columns on this table are inverted
 * relative to their names:
 *
 *   physical column     ACTUALLY holds                  semantic name
 *   ─────────────────   ─────────────────────────────   ─────────────────
 *   m.parent_skill_id   tbl_deep_skill.deepskill_id     deep_skill_id
 *   m.deep_skill_id     tbl_deepskill_options.id        option_id
 *
 * SELECTs in this file ALWAYS alias the columns through to their
 * semantic names so the FE consumes readable shapes; WHERE / JOIN /
 * INSERT clauses keep the physical names (MySQL aliases aren't allowed
 * there) with an inline comment marking the inversion.
 *
 * `is_repairing` doubles as the active flag (1 = active, 0 = soft-
 * deleted). We never hard-delete so a re-toggle re-uses the original
 * row instead of creating a duplicate.
 */
async function listOptionMappings(efrId) {
  logger.info('List deep-skill option mappings · efrId=' + efrId);
  const [rows] = await pool.query(
    `SELECT m.id                        AS mapping_id,
            m.category_id,
            sc.service_catg_name        AS category_name,
            m.service_type_id,
            st.service_type_name        AS service_type_name,
            m.parent_skill_id           AS deep_skill_id, -- physical column m.parent_skill_id holds the deep_skill_id
            ds.deepskill_name           AS deep_skill_name,
            ds.deepskill_image          AS deep_skill_image,
            m.deep_skill_id             AS option_id,     -- physical column m.deep_skill_id holds the option id
            o.skill_option              AS option_name
       FROM tbl_efr_deepskill_mapping m
       LEFT JOIN tbl_service_catg     sc ON sc.service_catg_id = m.category_id
       LEFT JOIN tbl_service_type     st ON st.service_type_id = m.service_type_id
       -- INNER JOIN: only deep-skill mappings whose deep skill RESOLVES and is
       -- active. NEW CRM convention: parent_skill_id holds the deepskill_id;
       -- requiring it to match an existing, non-inactive (status <> 0)
       -- tbl_deep_skill row keeps this modal consistent with the "Mapped Deep
       -- Skill" count and candidate-ranking. Orphaned legacy rows (old-catalog
       -- ids, no surviving deep skill) fall out here — to be cleaned and
       -- re-uploaded via the new CRM.
       INNER JOIN tbl_deep_skill      ds ON ds.deepskill_id = m.parent_skill_id
                                        AND (ds.status IS NULL OR ds.status <> 0) -- active, resolvable deep skill only
       LEFT JOIN tbl_deepskill_options o ON o.id               = m.deep_skill_id   -- deep_skill_id is the option FK
      WHERE m.easyfixer_id = ? AND m.is_repairing = 1
      ORDER BY sc.service_catg_name, st.service_type_name, ds.deepskill_name, o.skill_option`,
    [efrId]
  );
  logger.info('Found ' + rows.length + ' deep-skill option mappings');
  // Resolve image keys once per distinct deep_skill_id — option rows for
  // the same skill share the URL. Skips empty keys so we only presign for
  // skills that actually have an image.
  const urlByDeepSkillId = new Map();
  const distinctSkills = [];
  for (const r of rows) {
    const id = r.deep_skill_id;
    if (id == null || urlByDeepSkillId.has(id)) continue;
    const key = String(r.deep_skill_image || '').trim();
    if (!key) { urlByDeepSkillId.set(id, null); continue; }
    distinctSkills.push({ id, key });
    urlByDeepSkillId.set(id, null); // placeholder; overwritten below
  }
  const resolved = await Promise.all(
    distinctSkills.map((s) => deepSkillService.resolveImageUrlFromKey(s.key)),
  );
  for (let i = 0; i < distinctSkills.length; i += 1) {
    urlByDeepSkillId.set(distinctSkills[i].id, resolved[i]);
  }
  return rows.map((r) => {
    const { deep_skill_image, ...rest } = r; // drop raw key from response
    void deep_skill_image;
    return { ...rest, deep_skill_image_url: urlByDeepSkillId.get(r.deep_skill_id) || null };
  });
}

/*
 * Unmap a SINGLE deep-skill option mapping (the X action on the Manage
 * Easyfixers "Mapped Deep Skill" detail modal). Soft-delete by row id —
 * consistent with the no-hard-delete convention in this file; candidate-ranking
 * filters is_repairing=1 so the skill drops from matching immediately. The
 * easyfixer_id guard prevents unmapping a row owned by a different technician.
 */
async function unmapDeepSkill(efrId, rowId) {
  logger.info('Unmap deep-skill mapping · efrId=' + efrId + ' · mappingId=' + rowId);
  const [result] = await pool.query(
    `UPDATE tbl_efr_deepskill_mapping
        SET is_repairing = 0
      WHERE id = ? AND easyfixer_id = ? AND is_repairing = 1`,
    [rowId, efrId]
  );
  if (result.affectedRows === 0) {
    logger.warn('Unmap deep-skill failed · not found or already removed · efrId=' + efrId + ' · mappingId=' + rowId);
    const err = new Error('Deep-skill mapping not found or already removed');
    err.status = 404;
    throw err;
  }
  logger.info('Deep-skill mapping unmapped · efrId=' + efrId + ' · mappingId=' + rowId);
  return { unmapped: true };
}

// Legacy audit-column discovery for tbl_efr_deepskill_mapping. The table
// predates the Node migrations and isn't created here, so its audit-column
// NAMES aren't known statically — and the live DB can be unreachable at probe
// time. We SHOW COLUMNS once (cached) and pick the first matching candidate for
// the "inserted date" + "inserted by" columns across the conventions this
// codebase uses elsewhere (insert_date / inserted_by on tbl_easyfixer,
// tbl_client, tbl_customer …). A missing probe / absent column → null → that
// column is simply omitted from the write (graceful degrade, never a crash).
let _deepskillMappingAudit = null;
async function deepskillMappingAuditCols() {
  if (_deepskillMappingAudit !== null) return _deepskillMappingAudit;
  let names = new Set();
  try {
    const [cols] = await pool.query('SHOW COLUMNS FROM tbl_efr_deepskill_mapping');
    names = new Set(cols.map((c) => c.Field));
  } catch (_e) { /* DB unreachable / table absent → no audit stamping */ }
  const pick = (cands) => cands.find((c) => names.has(c)) || null;
  _deepskillMappingAudit = {
    dateCol: pick(['insert_date', 'inserted_on', 'created_date', 'created_on', 'created_at']),
    byCol:   pick(['inserted_by', 'insert_by', 'created_by']),
  };
  logger.info('tbl_efr_deepskill_mapping audit cols · date=' + (_deepskillMappingAudit.dateCol || '-') + ' · by=' + (_deepskillMappingAudit.byCol || '-'));
  return _deepskillMappingAudit;
}

// Chunk size for the bulk reactivate (PK IN) + bulk INSERT statements. Keeps
// placeholder counts well under MySQL limits even at the Joi cap of 500 items.
const MAPPING_WRITE_CHUNK = 200;

async function replaceOptionMappings(efrId, items, actor, externalConn = null) {
  const list = Array.isArray(items) ? items : [];
  logger.info('Replace deep-skill option mappings · efrId=' + efrId + ' · items=' + list.length);
  // When an external connection is injected (e.g. acceptSubmission's txn) we
  // enroll in the caller's transaction and leave begin/commit/release to them.
  const conn = externalConn || await pool.getConnection();
  const ownTxn = !externalConn;
  // Audit stamping: WHO + WHEN. CRM passes a staff `actor` (its user_id); the
  // PUBLIC profile-update form has no logged-in user (actor=null), so the
  // easyfixer self-acts → stamp their efr_id. Columns discovered defensively.
  const byId = actor?.user_id || efrId;
  const audit = await deepskillMappingAuditCols();

  // Normalise + dedupe the desired set into PHYSICAL-column tuples. INVERSION
  // (preserved verbatim): semantic deep_skill_id → physical parent_skill_id;
  // semantic option_id → physical deep_skill_id. Getting this backwards corrupts
  // candidate-ranking, which filters is_repairing=1 on these columns.
  const seen = new Set();
  const desired = []; // { categoryId, serviceTypeId, parentSkillId, deepSkillId }
  for (const it of list) {
    const categoryId    = Number(it.category_id);
    const serviceTypeId = Number(it.service_type_id);
    const parentSkillId = Number(it.deep_skill_id); // → physical parent_skill_id
    const deepSkillId   = Number(it.option_id);     // → physical deep_skill_id
    if (![categoryId, serviceTypeId, parentSkillId, deepSkillId].every((n) => Number.isInteger(n) && n > 0)) continue;
    const k = categoryId + '|' + serviceTypeId + '|' + parentSkillId + '|' + deepSkillId;
    if (seen.has(k)) continue;
    seen.add(k);
    desired.push({ categoryId, serviceTypeId, parentSkillId, deepSkillId });
  }

  try {
    if (ownTxn) await conn.beginTransaction();

    // 1) Soft-delete every active row for this easyfixer (one statement).
    await conn.query(
      `UPDATE tbl_efr_deepskill_mapping
          SET is_repairing = 0
        WHERE easyfixer_id = ?`,
      [efrId]
    );

    if (desired.length === 0) {
      if (ownTxn) await conn.commit();
      logger.info('Deep-skill option mappings replaced · efrId=' + efrId + ' · updated=0 · by=' + byId);
      return { updated: 0 };
    }

    // 2) One read of this easyfixer's existing rows → map natural key → PK id.
    //    Replaces the per-item reactivate probe with a single round-trip.
    const [existingRows] = await conn.query(
      `SELECT id, category_id, service_type_id, parent_skill_id, deep_skill_id
         FROM tbl_efr_deepskill_mapping
        WHERE easyfixer_id = ?`,
      [efrId]
    );
    const idByKey = new Map();
    for (const row of existingRows) {
      idByKey.set(row.category_id + '|' + row.service_type_id + '|' + row.parent_skill_id + '|' + row.deep_skill_id, row.id);
    }

    // 3) Partition: existing rows reactivate (by PK); the rest INSERT.
    const reactivateIds = [];
    const toInsert = [];
    for (const d of desired) {
      const id = idByKey.get(d.categoryId + '|' + d.serviceTypeId + '|' + d.parentSkillId + '|' + d.deepSkillId);
      if (id != null) reactivateIds.push(id);
      else toInsert.push(d);
    }

    // 4) Bulk reactivate via PK IN (+ refresh audit stamp). One statement per
    //    chunk — turns up to ~43 single-row UPDATEs into ~1 round-trip. PK seek.
    if (reactivateIds.length) {
      const reSets = ['is_repairing = 1'];
      const auditParams = [];
      if (audit.dateCol) reSets.push('`' + audit.dateCol + '` = NOW()');
      if (audit.byCol)   { reSets.push('`' + audit.byCol + '` = ?'); auditParams.push(byId); }
      for (let i = 0; i < reactivateIds.length; i += MAPPING_WRITE_CHUNK) {
        const chunk = reactivateIds.slice(i, i + MAPPING_WRITE_CHUNK);
        await conn.query(
          `UPDATE tbl_efr_deepskill_mapping
              SET ${reSets.join(', ')}
            WHERE id IN (${chunk.map(() => '?').join(',')})`,
          [...auditParams, ...chunk]
        );
      }
    }

    // 5) Bulk INSERT the new mappings — one multi-row INSERT per chunk.
    if (toInsert.length) {
      const insCols = ['easyfixer_id', 'category_id', 'service_type_id', 'parent_skill_id', 'deep_skill_id', 'is_repairing'];
      if (audit.dateCol) insCols.push('`' + audit.dateCol + '`');
      if (audit.byCol)   insCols.push('`' + audit.byCol + '`');
      for (let i = 0; i < toInsert.length; i += MAPPING_WRITE_CHUNK) {
        const chunk = toInsert.slice(i, i + MAPPING_WRITE_CHUNK);
        const rowSql = [];
        const insParams = [];
        for (const d of chunk) {
          // parent_skill_id holds deep_skill_id; deep_skill_id holds option_id (inversion).
          const vals = ['?', '?', '?', '?', '?', '1'];
          insParams.push(efrId, d.categoryId, d.serviceTypeId, d.parentSkillId, d.deepSkillId);
          if (audit.dateCol) vals.push('NOW()');
          if (audit.byCol)   { vals.push('?'); insParams.push(byId); }
          rowSql.push('(' + vals.join(', ') + ')');
        }
        await conn.query(
          `INSERT INTO tbl_efr_deepskill_mapping (${insCols.join(', ')}) VALUES ${rowSql.join(', ')}`,
          insParams
        );
      }
    }

    if (ownTxn) await conn.commit();
    const updated = reactivateIds.length + toInsert.length;
    logger.info('Deep-skill option mappings replaced · efrId=' + efrId + ' · updated=' + updated + ' · by=' + byId);
    return { updated };
  } catch (e) {
    if (ownTxn) { try { await conn.rollback(); } catch (_) { /* swallow rollback failure */ } }
    logger.error('Replace deep-skill option mappings failed · efrId=' + efrId + ' · ' + e.message);
    throw e;
  } finally {
    if (ownTxn) conn.release();
  }
}

// ─── Serviceable Pincodes (tbl_efr_serviceable_pincodes) ───────────
/*
 * Per-easyfixer set of pincodes the technician will accept jobs in.
 * Schema (2026-06-10): single row per easyfixer with a `pincodes` TEXT
 * column holding the CSV of pincode strings directly. PK is easyfixer_id —
 * the CSV itself is a single idempotent upsert. A short transaction also
 * covers catalogue resolution and the immediate pincode-status activation;
 * callers already holding a transaction inject their connection.
 *
 * The FE still talks in pincode IDs (it sources them from the
 * /shared/lookup/pincodes catalogue). On write we resolve IDs → pincode
 * strings via tbl_pincode and persist the CSV. On read we split the CSV
 * back into the joined detail shape the FE expects.
 *
 * EasyFix-owned table — no legacy Java service references it — so adding
 * it via migrations/2026-06-10-create-tbl-efr-serviceable-pincodes.sql is
 * safe under the CLAUDE.md shared-DB carve-out.
 */
async function listServiceablePincodes(efrId) {
  logger.info('List serviceable pincodes · efrId=' + efrId);
  const [[row]] = await pool.query(
    `SELECT pincodes FROM tbl_efr_serviceable_pincodes WHERE easyfixer_id = ? LIMIT 1`,
    [efrId]
  );
  const csv = row?.pincodes;
  if (!csv) return { items: [] };
  const pins = String(csv).split(',').map((s) => s.trim()).filter(Boolean);
  if (pins.length === 0) return { items: [] };
  logger.info('Found ' + pins.length + ' serviceable pincodes');
  const placeholders = pins.map(() => '?').join(',');
  const [items] = await pool.query(
    `SELECT p.pincode_id,
            p.pincode,
            p.location           AS location,
            p.city_id,
            c.city_name,
            c.state_id,
            s.state_name
       FROM tbl_pincode p
       LEFT JOIN tbl_city  c ON c.city_id  = p.city_id
       LEFT JOIN tbl_state s ON s.state_id = c.state_id
      WHERE p.pincode IN (${placeholders})
      ORDER BY p.pincode ASC`,
    pins
  );
  return { items };
}

async function replaceServiceablePincodesOnRunner(
  efrId,
  pincodeIds,
  actor,
  db,
  { representation = 'id' } = {},
) {
  if (representation !== 'id' && representation !== 'value') {
    const error = new Error('serviceable pincode representation must be id or value');
    error.status = 400;
    throw error;
  }
  const list = Array.isArray(pincodeIds)
    ? Array.from(new Set(
      representation === 'value'
        ? pincodeIds.map((value) => String(value).trim()).filter((value) => /^\d{6}$/.test(value))
        : pincodeIds.map(Number).filter((value) => Number.isInteger(value) && value > 0),
    ))
    : [];
  logger.info('Replace serviceable pincodes · efrId=' + efrId + ' · requested=' + list.length);
  // created_by / updated_by: the CRM path passes a staff `actor` (its user_id);
  // the PUBLIC profile-update form has no logged-in user (actor=null), so the
  // easyfixer is acting on their own behalf — stamp their efr_id. (created_by/
  // updated_by are plain INT NULL with no FK, so an efr_id is safe here; the
  // created_date/updated_date columns auto-populate via DB defaults.)
  const userId = actor?.user_id || efrId;
  // Resolve one explicit representation into pincode strings (the schema
  // stores CSV values, not IDs). Never OR pincode_id and pincode together: a
  // six-digit PIN can also be an unrelated row's numeric primary key.
  let csv = '';
  let resolvedCount = 0;
  if (list.length) {
    const placeholders = list.map(() => '?').join(',');
    const lookupColumn = representation === 'value' ? 'pincode' : 'pincode_id';
    const [rows] = await db.query(
      `SELECT DISTINCT pincode FROM tbl_pincode WHERE ${lookupColumn} IN (${placeholders})`,
      list,
    );
    const resolved = Array.from(new Set(rows.map((r) => String(r.pincode)).filter(Boolean)));
    csv = resolved.join(',');
    resolvedCount = resolved.length;
    // Guard: non-empty input that resolves to zero rows means every supplied id
    // is unrecognised. Return 400 rather than silently writing an empty CSV —
    // this is the mechanism that caused blank pincodes for easyfixer_id 1736.
    if (csv === '') {
      logger.warn('Replace serviceable pincodes rejected · no valid pincodes resolved · efrId=' + efrId + ' · requested=' + list.length);
      const err = new Error('No valid pincodes resolved from the provided ids');
      err.statusCode = 400;
      throw err;
    }
    // Partial resolution: some supplied identifiers matched no pincode.
    // Persist the ones that did, but warn so catalogue drift stays visible.
    if (resolvedCount < list.length) {
      logger.warn(
        { efrId, requested: list.length, resolved: resolvedCount },
        'serviceable-pincodes: partial id resolution — some supplied ids matched no pincode',
      );
    }
  }
  // Single-statement atomic upsert keyed on easyfixer_id (PK).
  await db.query(
    `INSERT INTO tbl_efr_serviceable_pincodes
       (easyfixer_id, pincodes, created_by, updated_by)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE pincodes = VALUES(pincodes), updated_by = VALUES(updated_by)`,
    [efrId, csv, userId, userId]
  );
  // Immediate-serviceable hook: flip the just-added pincodes to Serviceable
  // (pincode_status = 1) right away so a technician/ops updating their set
  // sees them go live without waiting for the full nightly recompute. We only
  // ACTIVATE here — deactivation of pincodes no longer in anyone's set is the
  // exclusive responsibility of the full recompute, so we never set status = 0.
  // Runs on `db` (externalConn or pool) to stay inside the caller's txn.
  if (list.length) {
    const placeholders = list.map(() => '?').join(',');
    const lookupColumn = representation === 'value' ? 'pincode' : 'pincode_id';
    await db.query(
      `UPDATE tbl_pincode SET pincode_status = 1
         WHERE ${lookupColumn} IN (${placeholders})
           AND pincode_status = 0`,
      list,
    );
  }
  logger.info('Serviceable pincodes replaced · efrId=' + efrId + ' · updated=' + resolvedCount);
  return { updated: resolvedCount };
}

async function replaceServiceablePincodes(
  efrId,
  pincodeIds,
  actor,
  externalConn = null,
  options = {},
) {
  // A caller-provided connection already owns the surrounding transaction
  // (CRM profile submit and mobile work-area use this path). Never nest or
  // commit it here. Standalone callers receive one short transaction covering
  // catalogue resolution, CSV replacement, and the serviceability flip.
  if (externalConn) {
    return replaceServiceablePincodesOnRunner(efrId, pincodeIds, actor, externalConn, options);
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await replaceServiceablePincodesOnRunner(efrId, pincodeIds, actor, conn, options);
    await conn.commit();
    return result;
  } catch (error) {
    try { await conn.rollback(); } catch (_) { /* retain original failure */ }
    throw error;
  } finally {
    conn.release();
  }
}

// ─── BGV upload (stub) ──────────────────────────────────────────────
// TODO: wire to S3 once the bucket key is finalised. The legacy stores the
// document in tbl_easyfixer_documents with document_type = 'BGV Report'.
// For now we just persist the supplied URL/key if the caller provides one.
async function saveBgvReport(efrId, body, actor) {
  logger.info('Save BGV report · efrId=' + efrId + ' · hasReport=' + !!body.bgv_report_img_name);
  if (body.bgv_report_img_name) {
    await pool.query(
      `UPDATE tbl_easyfixer SET bgv_report_img_name = ?, updated_by = ?, update_date = NOW() WHERE efr_id = ?`,
      [body.bgv_report_img_name, actor?.user_id || null, efrId]
    ).catch(() => {});
    logger.info('BGV report saved · efrId=' + efrId);
  }
  return getVerificationPage(efrId);
}

module.exports = {
  SECTION,
  getVerificationPage,
  addComment,
  saveProfessional,
  savePersonalFamily,
  saveBanking,
  saveIdentity,
  setLeadVerification,
  proceedToActivation,
  saveActivation,
  mapClients,
  saveBgvReport,
  listOptionMappings,
  unmapDeepSkill,
  replaceOptionMappings,
  listServiceablePincodes,
  replaceServiceablePincodes,
};
