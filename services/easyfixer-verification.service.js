const { pool } = require('../db');
const deepSkillService = require('./deep-skill.service');
const logger = require('../logger');
const registrationStatusPush = require('./registration-status-push.service');

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
  const e = await getEasyfixerForVerification(efrId);
  if (!e) {
    logger.warn('Verification page not found · efrId=' + efrId);
    return null;
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
async function saveIdentity(efrId, body, actor) {
  logger.info('Save identity verification · efrId=' + efrId + ' · verification_status=' + body.verification_status);
  // Allow updating Aadhaar/Pan numbers inline.
  if (body.adhaar_card_number !== undefined || body.pan_card_number !== undefined) {
    const sets = [];
    const params = [];
    if (body.adhaar_card_number !== undefined) { sets.push('adhaar_card_number = ?'); params.push(body.adhaar_card_number); }
    if (body.pan_card_number    !== undefined) { sets.push('pan_card_number = ?');    params.push(body.pan_card_number); }
    sets.push('updated_by = ?', 'update_date = NOW()');
    params.push(actor?.user_id || null, efrId);
    await pool.query(`UPDATE tbl_easyfixer SET ${sets.join(', ')} WHERE efr_id = ?`, params);
  }

  const status = Number(body.verification_status);
  if (status === 1) {
    await pool.query(
      `UPDATE tbl_easyfixer
          SET is_identity_details_verified_by_crm = 1,
              send_back_to_tx_reason_crm = NULL,
              efr_identity_details_perc = COALESCE(?, efr_identity_details_perc),
              updated_by = ?, update_date = NOW(),
              send_to_finance_date_time = NOW()
        WHERE efr_id = ?`,
      [body.progress ?? null, actor?.user_id || null, efrId]
    );
  } else if (status === 2 && body.rejected_reason) {
    await pool.query(
      `UPDATE tbl_easyfixer
          SET is_identity_details_verified_by_crm = 2,
              send_back_to_tx_reason_crm = ?,
              updated_by = ?, update_date = NOW()
        WHERE efr_id = ?`,
      [body.rejected_reason, actor?.user_id || null, efrId]
    );
  }
  // Identity verify/reject flips is_identity_details_verified_by_crm, which
  // changes the registration-status gate (→ rejected, or clears it). Push
  // the technician's app to re-fetch. Best-effort — never blocks the save.
  if (status === 1 || status === 2) {
    registrationStatusPush.notifyRegistrationStatusChanged(efrId).catch(() => {});
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

  // Resolve user_id via tbl_easyfixer.user_id (needed to update tbl_user row).
  const [[row]] = await pool.query(`SELECT user_id FROM tbl_easyfixer WHERE efr_id = ? LIMIT 1`, [efrId]);
  if (!row) { logger.warn('Lead verification failed · easyfixer not found · efrId=' + efrId); const e = new Error('easyfixer not found'); e.status = 404; throw e; }
  // Idle bucket is user_id IS NULL OR = 0 — with no linked user account there's
  // no tbl_user row to flip, so the lead-status write would silently no-op.
  if (!row.user_id) { logger.warn('Lead verification failed · no linked user account · efrId=' + efrId); const e = new Error('easyfixer has no linked user account — lead status cannot be set'); e.status = 422; throw e; }

  // Auto-append the comment line that mirrors legacy "Accepted / Denied / ..."
  const statusText = v === 1 ? 'Accepted' : v === 2 ? 'Denied' : 'Not Eligible To New Lead';
  const comment = `${statusText}${body.reason ? ' <br> ' + body.reason : ''}`;

  // All three writes are atomic on one connection — a partial apply would leave
  // tbl_easyfixer / tbl_user / the comment thread inconsistent.
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    if (v === 1 && body.efr_cityId) {
      await conn.query(`UPDATE tbl_easyfixer SET efr_cityId = ?, updated_by = ?, update_date = NOW() WHERE efr_id = ?`,
        [body.efr_cityId, actor?.user_id || null, efrId]);
    }
    await conn.query(
      `UPDATE tbl_user
          SET personal_details_filled = ?, updated_by = ?, user_status = 1,
              released_on_date_time = NOW(), update_date = NOW()
        WHERE user_id = ?`,
      [v, actor?.user_id || null, row.user_id]
    );

    // Inline the comment INSERT on conn (addComment uses pool + returns a
    // list, so it can't enroll in this txn). Mirrors addComment's columns.
    await conn.query(
      `INSERT INTO easyfixer_comments
         (comment, commented_by, comment_in_section, commented_on, commented_by_id, easyfixer_id)
       VALUES (?, ?, ?, NOW(), ?, ?)`,
      [comment, actor?.user_name || actor?.name || 'system', SECTION.LEAD, actor?.user_id || null, efrId]
    );

    await conn.commit();
  } catch (e) {
    await conn.rollback().catch(() => {});
    logger.error('Lead verification transaction failed · efrId=' + efrId + ' · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }

  logger.info('Lead verification set · efrId=' + efrId + ' · status=' + statusText);

  // Lead accept/deny changes tbl_user.personal_details_filled, which drives
  // the registration-status gate (under_verification / not_eligible /
  // in_progress). Nudge the app to re-fetch. Best-effort — never blocks.
  registrationStatusPush.notifyRegistrationStatusChanged(efrId).catch(() => {});

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
      ]
    );
    // Final activation sets is_technician_verified = 1 → gate flips to
    // `active`. Push the technician's app so it leaves the onboarding gate
    // immediately. Best-effort — never blocks the activation.
    registrationStatusPush.notifyRegistrationStatusChanged(efrId, { status: 'active' }).catch(() => {});
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

async function replaceOptionMappings(efrId, items, actor, externalConn = null) {
  const list = Array.isArray(items) ? items : [];
  logger.info('Replace deep-skill option mappings · efrId=' + efrId + ' · items=' + list.length);
  // When an external connection is injected (e.g. acceptSubmission's txn) we
  // enroll in the caller's transaction and leave begin/commit/release to them.
  const conn = externalConn || await pool.getConnection();
  const ownTxn = !externalConn;
  try {
    if (ownTxn) await conn.beginTransaction();

    // 1) Soft-delete every active row for this easyfixer.
    await conn.query(
      `UPDATE tbl_efr_deepskill_mapping
          SET is_repairing = 0
        WHERE easyfixer_id = ?`,
      [efrId]
    );

    // 2) For each desired item: try reactivate, INSERT if no matching row.
    let updated = 0;
    for (const it of list) {
      const categoryId    = Number(it.category_id);
      const serviceTypeId = Number(it.service_type_id);
      const deepSkillId   = Number(it.deep_skill_id);  // semantic name; goes into the physical column `parent_skill_id`
      const optionId      = Number(it.option_id);      // semantic name; goes into the physical column `deep_skill_id`
      if (![categoryId, serviceTypeId, deepSkillId, optionId].every((n) => Number.isInteger(n) && n > 0)) {
        continue;
      }
      const [r] = await conn.query(
        `UPDATE tbl_efr_deepskill_mapping
            SET is_repairing = 1
          WHERE easyfixer_id    = ?
            AND category_id     = ?
            AND service_type_id = ?
            AND parent_skill_id = ?    -- holds deep_skill_id (inversion, see docblock)
            AND deep_skill_id   = ?`,  /* holds option_id (inversion, see docblock) */
        [efrId, categoryId, serviceTypeId, deepSkillId, optionId]
      );
      if (r.affectedRows === 0) {
        await conn.query(
          `INSERT INTO tbl_efr_deepskill_mapping
             (easyfixer_id, category_id, service_type_id,
              parent_skill_id, -- physical column name; holds deep_skill_id
              deep_skill_id,   -- physical column name; holds option_id
              is_repairing)
           VALUES (?, ?, ?, ?, ?, 1)`,
          [efrId, categoryId, serviceTypeId, deepSkillId, optionId]
        );
      }
      updated += 1;
    }

    if (ownTxn) await conn.commit();
    // actor is accepted for future audit columns; today the table has no
    // updated_by / updated_on columns so we just log the actor for trail.
    void actor;
    logger.info('Deep-skill option mappings replaced · efrId=' + efrId + ' · updated=' + updated);
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
 * so INSERT … ON DUPLICATE KEY UPDATE is atomic and needs no transaction.
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
            p.location           AS pincode_location,
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

async function replaceServiceablePincodes(efrId, pincodeIds, actor, externalConn = null) {
  const list = Array.isArray(pincodeIds)
    ? Array.from(new Set(pincodeIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)))
    : [];
  logger.info('Replace serviceable pincodes · efrId=' + efrId + ' · requested=' + list.length);
  const userId = actor?.user_id || null;
  // Single-statement upsert — no begin/commit here. When an external
  // connection is injected we run on it so the write joins the caller's txn.
  const db = externalConn || pool;
  // Resolve pincode IDs → pincode strings (the schema stores CSV of strings,
  // not IDs). Dedupe + join. Empty list ⇒ persist empty CSV (legitimate clear).
  // The WHERE clause matches on EITHER pincode_id PK (normal FE path) OR the
  // 6-digit pincode value itself (Swagger / direct-API callers), so both
  // representations resolve correctly.
  let csv = '';
  let resolvedCount = 0;
  if (list.length) {
    const placeholders = list.map(() => '?').join(',');
    const [rows] = await db.query(
      `SELECT pincode FROM tbl_pincode WHERE pincode_id IN (${placeholders}) OR pincode IN (${placeholders})`,
      [...list, ...list]
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
    // Partial resolution: some supplied ids matched no pincode (by PK or value).
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
    await db.query(
      `UPDATE tbl_pincode SET pincode_status = 1
         WHERE (pincode_id IN (${placeholders}) OR pincode IN (${placeholders}))
           AND pincode_status = 0`,
      [...list, ...list]
    );
  }
  logger.info('Serviceable pincodes replaced · efrId=' + efrId + ' · updated=' + resolvedCount);
  return { updated: resolvedCount };
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
