const { pool } = require('../db');
const logger = require('../logger');

/*
 * Manage Zones — junction model (2026-06-15).
 *
 * Data model:
 *   tbl_zone_master(zone_id, zone_name, city_id, zone_status, ...)
 *     — Each zone belongs to ONE city (city_id is the spec's binding).
 *
 *   tbl_pincode(pincode_id, pincode, city_id, zone_id, ...)
 *     — tbl_pincode.zone_id is VESTIGIAL: do NOT read it for coverage and
 *       do NOT write it. Zone membership is now MANY-TO-MANY and lives
 *       entirely in the junction table below.
 *
 *   tbl_zone_pincode_mapping(id PK, zone_id, pincode_id, created_on,
 *                            created_by, UNIQUE(zone_id,pincode_id),
 *                            KEY(pincode_id), KEY(zone_id))
 *     — Source of truth for zone↔pincode coverage. A pincode MAY belong to
 *       MULTIPLE zones. Use INSERT IGNORE for idempotent inserts.
 *
 *   tbl_zone_city_mapping (legacy)
 *     — Kept as a transitional shadow: one row per zone (zone_id + city_id),
 *       mirroring tbl_zone_master.city_id. Required because
 *       tbl_easyfixer.efr_zone_city_id still references its city_zone_id;
 *       deleting it would break legacy auto-assign + integration paths.
 *       New code does NOT join through it for pincode coverage; it's
 *       maintained on writes only so legacy reads keep working.
 *
 *   tbl_easyfixer.efr_zone_city_id → tbl_zone_city_mapping.city_zone_id
 *     — Untouched. Easyfixers still bind to a (zone, city) pair.
 *
 * "No. of technicians" = DISTINCT active+verified easyfixers who SERVICE at
 *   least one pincode in this zone (via tbl_efr_serviceable_pincodes).
 * "No. of pincodes"    = COUNT of tbl_zone_pincode_mapping rows for the zone.
 */

// ─── List ────────────────────────────────────────────────────────────
async function listZones() {
  const [rows] = await pool.query(`
    SELECT
      z.zone_id,
      z.zone_name,
      z.zone_status,
      z.created_date,
      z.city_id,
      c.city_name,
      (SELECT COUNT(*) FROM tbl_zone_pincode_mapping zpm
        WHERE zpm.zone_id = z.zone_id) AS pincode_count,
      (SELECT COUNT(DISTINCT e.efr_id)
         FROM tbl_zone_pincode_mapping zpm
         JOIN tbl_pincode p  ON p.pincode_id = zpm.pincode_id
         JOIN tbl_efr_serviceable_pincodes sp ON FIND_IN_SET(p.pincode, sp.pincodes) > 0
         JOIN tbl_easyfixer e ON e.efr_id = sp.easyfixer_id
              AND e.efr_status = 1 AND e.is_technician_verified = 1
        WHERE zpm.zone_id = z.zone_id) AS technician_count
      FROM tbl_zone_master z
      LEFT JOIN tbl_city   c ON c.city_id = z.city_id
     ORDER BY c.city_name ASC, z.zone_name ASC
  `);
  return rows;
}

// ─── Detail (zone + assigned pincodes) ───────────────────────────────
async function getZoneDetail(zoneId) {
  const [[zone]] = await pool.query(
    `SELECT z.zone_id, z.zone_name, z.zone_status, z.created_date,
            z.city_id, c.city_name
       FROM tbl_zone_master z
       LEFT JOIN tbl_city   c ON c.city_id = z.city_id
      WHERE z.zone_id = ?
      LIMIT 1`,
    [zoneId]
  );
  if (!zone) return null;

  // Pincodes assigned to this zone (source of truth: the junction).
  const [pincodes] = await pool.query(
    `SELECT p.pincode_id, p.pincode, p.location, p.district, p.pincode_status
       FROM tbl_zone_pincode_mapping zpm
       JOIN tbl_pincode p ON p.pincode_id = zpm.pincode_id
      WHERE zpm.zone_id = ?
      ORDER BY p.pincode ASC`,
    [zoneId]
  );

  // Technician count + pincode count (mirrors the list query) — handy for
  // detail-page summary cards without a second round-trip from the UI.
  const [[counts]] = await pool.query(
    `SELECT
        (SELECT COUNT(*) FROM tbl_zone_pincode_mapping zpm
          WHERE zpm.zone_id = ?) AS pincode_count,
        (SELECT COUNT(DISTINCT e.efr_id)
           FROM tbl_zone_pincode_mapping zpm
           JOIN tbl_pincode p  ON p.pincode_id = zpm.pincode_id
           JOIN tbl_efr_serviceable_pincodes sp ON FIND_IN_SET(p.pincode, sp.pincodes) > 0
           JOIN tbl_easyfixer e ON e.efr_id = sp.easyfixer_id
                AND e.efr_status = 1 AND e.is_technician_verified = 1
          WHERE zpm.zone_id = ?) AS technician_count`,
    [zoneId, zoneId]
  );

  return { ...zone, pincodes, ...counts };
}

// ─── Pincodes available for assigning to this zone ───────────────────
/*
 * Eligible = ALL active pincodes in the zone's city. Multi-zone membership
 * is now allowed, so a pincode already on another zone is still assignable
 * here. Each row carries `in_this_zone` (boolean) — EXISTS a junction row
 * for (zoneId, pincode_id) — so the FE can pre-tick current membership.
 */
async function listAssignablePincodes(zoneId) {
  const [[zone]] = await pool.query(
    'SELECT city_id FROM tbl_zone_master WHERE zone_id = ? LIMIT 1', [zoneId]
  );
  if (!zone || !zone.city_id) return [];
  const [rows] = await pool.query(
    `SELECT p.pincode_id, p.pincode, p.location, p.district,
            EXISTS (
              SELECT 1 FROM tbl_zone_pincode_mapping zpm
               WHERE zpm.zone_id = ? AND zpm.pincode_id = p.pincode_id
            ) AS in_this_zone
       FROM tbl_pincode p
      WHERE p.city_id = ?
        AND p.pincode_status = 1
      ORDER BY p.pincode ASC`,
    [zoneId, zone.city_id]
  );
  return rows.map((r) => ({ ...r, in_this_zone: !!r.in_this_zone }));
}

// ─── Easyfixers in a zone (with search) ──────────────────────────────
/*
 * Returns DISTINCT active+verified technicians who SERVICE at least one
 * pincode in this zone (serviceable-based, matches technician_count above).
 * The old efr_zone_city_id membership join is intentionally gone from here;
 * candidate-ranking / auto-assign keep their own separate membership queries.
 */
async function searchEasyfixersInZone(zoneId, { q, limit = 200, activeOnly = true } = {}) {
  // Base filters applied directly in the JOIN ON clause (literal SQL, no params).
  const efClauses = ['e.efr_status = 1', 'e.is_technician_verified = 1'];
  if (!activeOnly) efClauses.length = 0; // caller opted out — return all who service the zone

  // Params order matches the ? placeholders in the SQL below:
  //   1. zoneId  → WHERE zpm.zone_id = ?
  //   2+. LIKE   → if q provided, three LIKE params in the AND clause
  //   last. limit → LIMIT ?
  const params = [zoneId];
  let searchFilter = '';
  if (q) {
    searchFilter = 'AND (e.efr_name LIKE ? OR e.efr_no LIKE ? OR e.efr_email LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  params.push(Number(limit));

  const efFilter = efClauses.length ? `AND ${efClauses.join(' AND ')}` : '';

  const [rows] = await pool.query(`
    SELECT DISTINCT
      e.efr_id, e.efr_name, e.efr_no, e.efr_email,
      e.efr_cityId, e.is_technician_verified, e.efr_profile_perc,
      e.efr_status,
      c.city_name
      FROM tbl_zone_pincode_mapping zpm
      JOIN tbl_pincode p  ON p.pincode_id = zpm.pincode_id
      JOIN tbl_efr_serviceable_pincodes sp ON FIND_IN_SET(p.pincode, sp.pincodes) > 0
      JOIN tbl_easyfixer e ON e.efr_id = sp.easyfixer_id ${efFilter}
      LEFT JOIN tbl_city c ON c.city_id = e.efr_cityId
     WHERE zpm.zone_id = ?
       ${searchFilter}
     ORDER BY e.efr_name ASC
     LIMIT ?
  `, params);
  return rows;
}

/*
 * Reverse lookup — which easyfixers serve a given pincode? Under the
 * junction model a pincode may map to MULTIPLE zones, so we resolve
 * pincode → zones via tbl_zone_pincode_mapping and UNION the technicians
 * across every matching zone (DISTINCT collapses an easyfixer that serves
 * more than one of those zones to a single row).
 */
async function searchEasyfixersByPincode(pincode, { limit = 200 } = {}) {
  const [rows] = await pool.query(`
    SELECT DISTINCT
      e.efr_id, e.efr_name, e.efr_no, e.efr_email,
      e.is_technician_verified, e.efr_profile_perc, e.efr_status,
      c.city_name,
      z.zone_id, z.zone_name
      FROM tbl_pincode p
      JOIN tbl_zone_pincode_mapping zpm ON zpm.pincode_id = p.pincode_id
      JOIN tbl_zone_master z            ON z.zone_id = zpm.zone_id
      JOIN tbl_zone_city_mapping zcm    ON zcm.zone_id = z.zone_id
      JOIN tbl_easyfixer e              ON e.efr_zone_city_id = zcm.city_zone_id
      LEFT JOIN tbl_city c              ON c.city_id = z.city_id
     WHERE p.pincode = ?
       AND e.efr_status = 1
     ORDER BY e.efr_name ASC
     LIMIT ?
  `, [String(pincode), Number(limit)]);
  return rows;
}

// ─── Create / Update zone ────────────────────────────────────────────
function mkErr(status, message) { const e = new Error(message); e.status = status; return e; }

async function assertCityExists(conn, cityId) {
  const [[r]] = await conn.query('SELECT city_id FROM tbl_city WHERE city_id = ? LIMIT 1', [cityId]);
  if (!r) throw mkErr(400, `Unknown city_id ${cityId}`);
}

/*
 * Zone names are unique WITHIN a city (not globally). "South Delhi" inside
 * Delhi is fine even if "South" exists in another city. Compare against
 * (city_id, lower(zone_name)).
 */
async function createZone({ zone_name, city_id }) {
  const trimmed = String(zone_name || '').trim();
  if (!trimmed) throw mkErr(400, 'zone_name required');
  if (!city_id) throw mkErr(400, 'city_id required');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await assertCityExists(conn, city_id);

    const [[dup]] = await conn.query(
      `SELECT zone_id FROM tbl_zone_master
        WHERE city_id = ? AND LOWER(zone_name) = LOWER(?) LIMIT 1`,
      [city_id, trimmed]
    );
    if (dup) throw mkErr(409, `Zone "${trimmed}" already exists in this city`);

    const [r] = await conn.query(
      `INSERT INTO tbl_zone_master (zone_name, city_id, zone_status, created_date)
       VALUES (?, ?, 1, NOW())`,
      [trimmed, Number(city_id)]
    );
    const zoneId = r.insertId;

    // Maintain the legacy tbl_zone_city_mapping shadow row so any code
    // that still binds via efr_zone_city_id continues to resolve.
    await conn.query(
      `INSERT INTO tbl_zone_city_mapping (zone_id, city_id) VALUES (?, ?)`,
      [zoneId, Number(city_id)]
    );

    await conn.commit();
    return getZoneDetail(zoneId);
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/*
 * Updateable fields: zone_name, zone_status. city_id is NOT updateable —
 * moving a zone to a different city would invalidate every assigned
 * pincode (different city_id) and dangle technicians. To "move" a zone,
 * delete and re-create.
 */
async function updateZone(zoneId, { zone_name, zone_status }) {
  const sets = [];
  const vals = [];
  if (zone_name !== undefined) {
    const trimmed = String(zone_name).trim();
    if (!trimmed) throw mkErr(400, 'zone_name cannot be blank');

    const [[me]] = await pool.query('SELECT city_id FROM tbl_zone_master WHERE zone_id = ? LIMIT 1', [zoneId]);
    if (!me) throw mkErr(404, 'Zone not found');

    const [[dup]] = await pool.query(
      `SELECT zone_id FROM tbl_zone_master
        WHERE city_id = ? AND LOWER(zone_name) = LOWER(?) AND zone_id <> ? LIMIT 1`,
      [me.city_id, trimmed, zoneId]
    );
    if (dup) throw mkErr(409, `Another zone with name "${trimmed}" exists in this city`);

    sets.push('zone_name = ?'); vals.push(trimmed);
  }
  if (zone_status !== undefined) { sets.push('zone_status = ?'); vals.push(zone_status ? 1 : 0); }
  if (sets.length === 0) return getZoneDetail(zoneId);

  vals.push(zoneId);
  await pool.query(`UPDATE tbl_zone_master SET ${sets.join(', ')} WHERE zone_id = ?`, vals);
  return getZoneDetail(zoneId);
}

// ─── Replace the zone's pincode set ──────────────────────────────────
/*
 * Wipe-and-reinsert UX scoped to THIS zone's junction rows only: the editor
 * sends the WHOLE pincode list it wants the zone to own. We make this zone's
 * tbl_zone_pincode_mapping rows exactly equal the accepted set — DELETE the
 * zone's rows not in the set, then INSERT IGNORE the new (zone, pincode)
 * rows. Other zones' rows are never touched (multi-zone is allowed), and we
 * no longer reject pincodes that belong to a different zone.
 *
 * Cross-city safety: only pincodes belonging to this zone's city are
 * accepted. Non-existent or other-city ids are reported as `rejected`.
 */
async function setPincodeMapping(zoneId, pincodeIds, { userId = null } = {}) {
  const ids = Array.from(new Set((pincodeIds || []).map(Number).filter(Number.isFinite)));

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[zone]] = await conn.query(
      'SELECT zone_id, city_id FROM tbl_zone_master WHERE zone_id = ? LIMIT 1', [zoneId]
    );
    if (!zone) throw mkErr(404, 'Zone not found');

    const rejected = [];
    const acceptable = [];
    if (ids.length) {
      // Validate every requested id: must exist and must belong to this
      // zone's city. Membership in OTHER zones is now irrelevant.
      const placeholders = ids.map(() => '?').join(',');
      const [rows] = await conn.query(
        `SELECT pincode_id, pincode, city_id
           FROM tbl_pincode WHERE pincode_id IN (${placeholders})`,
        ids
      );
      const byId = new Map(rows.map((r) => [Number(r.pincode_id), r]));
      for (const id of ids) {
        const r = byId.get(id);
        if (!r) {
          rejected.push({ pincode_id: id, reason: 'Pincode not found' });
        } else if (Number(r.city_id) !== Number(zone.city_id)) {
          rejected.push({ pincode_id: id, pincode: r.pincode, reason: 'Different city than this zone' });
        } else {
          acceptable.push(id);
        }
      }
    }

    // Make this zone's junction rows exactly = acceptable set.
    if (acceptable.length) {
      const ph = acceptable.map(() => '?').join(',');
      // Drop this zone's rows that are no longer wanted (other zones untouched).
      await conn.query(
        `DELETE FROM tbl_zone_pincode_mapping
          WHERE zone_id = ? AND pincode_id NOT IN (${ph})`,
        [zoneId, ...acceptable]
      );
      // Idempotently add the wanted rows for THIS zone.
      const values = acceptable.map(() => '(?, ?, NOW(), ?)').join(', ');
      const params = [];
      for (const id of acceptable) params.push(zoneId, id, userId);
      await conn.query(
        `INSERT IGNORE INTO tbl_zone_pincode_mapping
           (zone_id, pincode_id, created_on, created_by)
         VALUES ${values}`,
        params
      );
    } else {
      // Empty/all-rejected list = clear THIS zone's junction rows only.
      await conn.query(
        'DELETE FROM tbl_zone_pincode_mapping WHERE zone_id = ?', [zoneId]
      );
    }

    await conn.commit();
    const detail = await getZoneDetail(zoneId);
    return { ...detail, rejected };
  } catch (e) {
    await conn.rollback();
    logger.error({ err: e.message, zoneId }, 'setPincodeMapping failed; rolled back');
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = {
  listZones,
  getZoneDetail,
  listAssignablePincodes,
  searchEasyfixersInZone,
  searchEasyfixersByPincode,
  createZone,
  updateZone,
  setPincodeMapping,
};
