const { pool } = require('../db');

/*
 * Mobile "My Team" — a master technician's downline: the technicians whose
 * tbl_easyfixer.efr_manager_id points at the caller. Legacy parity with the
 * Dropwizard `GET easyfixers/my_team/{id}?membershipType=`, except the {id} is
 * NEVER trusted from the client — the master is derived from req.tech.efr_id by
 * the route (requireTechAuth), so a tech can only ever see their OWN downline.
 *
 * membership_type has no DB column; it's derived ('Member' for a downline row).
 * efr_profile_img is returned as the stored value (an S3 key or legacy path) —
 * the app's Avatar falls back to initials when it isn't directly renderable.
 */
async function getMyTeam(masterEfrId) {
  const [rows] = await pool.query(
    `SELECT e.efr_id          AS efr_id,
            e.efr_name        AS efr_name,
            e.efr_no          AS efr_mobile,
            e.efr_profile_img AS efr_profile_img,
            c.city_name       AS city_name
       FROM tbl_easyfixer e
       LEFT JOIN tbl_city c ON c.city_id = e.efr_cityId
      WHERE e.efr_manager_id = ?
        AND e.efr_status = 1
      ORDER BY e.efr_name ASC`,
    [masterEfrId],
  );
  return rows.map((r) => ({
    efr_id:          r.efr_id,
    efr_name:        r.efr_name,
    efr_mobile:      r.efr_mobile,
    efr_profile_img: r.efr_profile_img,
    city_name:       r.city_name,
    membership_type: 'Member',
  }));
}

module.exports = { getMyTeam };
