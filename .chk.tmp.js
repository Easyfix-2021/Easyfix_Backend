require('dotenv').config();
const mysql = require('mysql2/promise');
const pc = require('./services/profile-completion.service');
(async () => {
  const c = await mysql.createConnection({ host: process.env.DB_HOST, port: process.env.DB_PORT,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  const [rows] = await c.query(`
    SELECT e.efr_id, e.efr_service_category, e.efr_service_type, e.efr_profile_perc,
      (e.adhaar_card_number IS NOT NULL AND e.adhaar_card_number <> '') AS lifecycle_aadhaar_present,
      (e.efr_profile_img IS NOT NULL AND e.efr_profile_img <> '') AS lifecycle_photo_present,
      U.is_personal_detail_filled AS lifecycle_personal_submitted,
      (e.date_of_birth IS NOT NULL) AS dob_present,
      EXISTS (SELECT 1 FROM tbl_efr_deepskill_mapping pcm WHERE pcm.easyfixer_id = e.efr_id AND pcm.is_repairing = 1) AS has_active_deep_skill,
      EXISTS (SELECT 1 FROM tbl_efr_serviceable_pincodes sp WHERE sp.easyfixer_id = e.efr_id AND NULLIF(TRIM(sp.pincodes),'') IS NOT NULL) AS serviceable_pincodes_present,
      (SELECT GROUP_CONCAT(DISTINCT dm.category_id) FROM tbl_efr_deepskill_mapping dm WHERE dm.easyfixer_id = e.efr_id AND dm.is_repairing = 1) AS mapped_category_ids
    FROM tbl_easyfixer e LEFT JOIN tbl_user U ON U.user_id = e.user_id
    WHERE e.efr_id IN (10797, 1736, 10795)`);
  const boolish = v => v == null ? false : Buffer.isBuffer(v) ? v[0] === 1 : Number(v) === 1;
  for (const r of rows) {
    const st = pc.strengthFromRow({
      has_active_deep_skill: r.has_active_deep_skill,
      efr_service_category: r.efr_service_category,
      efr_service_type: r.efr_service_type,
      adhaar_card_number: boolish(r.lifecycle_aadhaar_present) ? 'present' : null,
      efr_profile_img: boolish(r.lifecycle_photo_present) ? 'present' : null,
      dob_present: r.dob_present,
      user_is_personal_detail_filled: r.lifecycle_personal_submitted,
      serviceable_pincodes_present: r.serviceable_pincodes_present,
    });
    console.log(`EF ${r.efr_id}: stored perc=${r.efr_profile_perc} -> computed ${st.percent}% | complete=${st.profileComplete} | category: stored=${r.efr_service_category ?? '—'} derived=${r.mapped_category_ids ?? '—'}`);
  }
  await c.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
