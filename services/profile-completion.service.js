const { pool } = require('../db');

/*
 * Canonical Complete Profile definition shared by Registration, Rewards and
 * the CRM referral report.
 *
 * Keep these SQL expressions and the JS projection together. The technician
 * app renders the same three cards:
 *   1. Skills     — an active deep-skill option, with legacy category/type as
 *                   the compatibility fallback;
 *   2. Identity   — Aadhaar and profile photo are both present;
 *   3. Work Area  — the linked user's personal/work-area step was submitted.
 *
 * A referral qualifies only when all three are true. Centralising the rule
 * prevents the nightly reconciliation, mobile attribution read and CRM list
 * from drifting into subtly different definitions.
 */

function present(value) {
  return value != null && String(value).trim() !== '';
}

function asBool(value) {
  if (value == null) return false;
  if (typeof value === 'boolean') return value;
  if (Buffer.isBuffer(value)) return value[0] === 1;
  return Number(value) === 1;
}

function sqlPredicates({ technicianAlias = 'e', userAlias = 'u' } = {}) {
  const e = technicianAlias;
  const u = userAlias;
  const activeDeepSkill = `EXISTS (
    SELECT 1
      FROM tbl_efr_deepskill_mapping pcm
     WHERE pcm.easyfixer_id = ${e}.efr_id
       AND pcm.is_repairing = 1
  )`;
  const legacySkill = `(
    NULLIF(TRIM(${e}.efr_service_category), '') IS NOT NULL
    OR NULLIF(TRIM(${e}.efr_service_type), '') IS NOT NULL
  )`;
  const skillsComplete = `((${activeDeepSkill}) OR ${legacySkill})`;
  const aadhaarPresent = `(NULLIF(TRIM(${e}.adhaar_card_number), '') IS NOT NULL)`;
  const photoPresent = `(NULLIF(TRIM(${e}.efr_profile_img), '') IS NOT NULL)`;
  const identityComplete = `(${aadhaarPresent} AND ${photoPresent})`;
  const personalDetailsComplete = `(COALESCE(${u}.is_personal_detail_filled, 0) = 1)`;
  const profileComplete = `(${skillsComplete} AND ${identityComplete} AND ${personalDetailsComplete})`;
  return {
    activeDeepSkill,
    skillsComplete,
    aadhaarPresent,
    photoPresent,
    identityComplete,
    personalDetailsComplete,
    profileComplete,
  };
}

function fromRow(row = {}) {
  const skillsComplete = asBool(row.has_active_deep_skill)
    || present(row.efr_service_category)
    || present(row.efr_service_type);
  const aadhaarPresent = present(row.adhaar_card_number);
  const photoPresent = present(row.efr_profile_img);
  const identityComplete = aadhaarPresent && photoPresent;
  const personalDetailsComplete = asBool(row.user_is_personal_detail_filled);
  return {
    skillsComplete,
    aadhaarPresent,
    photoPresent,
    identityComplete,
    personalDetailsComplete,
    profileComplete: skillsComplete && identityComplete && personalDetailsComplete,
  };
}

function projectionSql({ technicianAlias = 'e', userAlias = 'u' } = {}) {
  const p = sqlPredicates({ technicianAlias, userAlias });
  return `${p.activeDeepSkill} AS has_active_deep_skill,
          ${technicianAlias}.efr_service_category,
          ${technicianAlias}.efr_service_type,
          ${technicianAlias}.adhaar_card_number,
          ${technicianAlias}.efr_profile_img,
          ${userAlias}.is_personal_detail_filled AS user_is_personal_detail_filled`;
}

async function read(efrId, { database = pool } = {}) {
  const [[row]] = await database.query(
    `SELECT e.efr_id, e.efr_name, e.efr_no,
            ${projectionSql()}
       FROM tbl_easyfixer e
       LEFT JOIN tbl_user u ON u.user_id = e.user_id
      WHERE e.efr_id = ?
      LIMIT 1`,
    [Number(efrId)],
  );
  if (!row) return null;
  return {
    efrId: Number(row.efr_id),
    name: row.efr_name || null,
    mobile: row.efr_no || null,
    ...fromRow(row),
  };
}

module.exports = {
  fromRow,
  projectionSql,
  read,
  sqlPredicates,
  _internals: { asBool, present },
};
