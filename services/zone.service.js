const { pool } = require('../db');
const logger = require('../logger');
const coverage = require('./pincode-coverage.service');

/*
 * Fill technician_count for a page of zones: ONE query for all their pincodes,
 * then a cache lookup per zone. Replaces a per-zone correlated subquery.
 */
async function attachTechnicianCounts(zones) {
  if (!zones.length) return zones;
  const zoneIds = zones.map((z) => z.zone_id);
  const [pins] = await pool.query(
    `SELECT zpm.zone_id, p.pincode
       FROM tbl_zone_pincode_mapping zpm
       JOIN tbl_pincode p ON p.pincode_id = zpm.pincode_id
      WHERE zpm.zone_id IN (${zoneIds.map(() => '?').join(',')})`,
    zoneIds,
  );
  const byZone = new Map();
  for (const r of pins) {
    if (!byZone.has(r.zone_id)) byZone.set(r.zone_id, []);
    byZone.get(r.zone_id).push(r.pincode);
  }
  for (const z of zones) {
    const ids = await coverage.getTechnicianIdsForPincodes(byZone.get(z.zone_id) || []);
    z.technician_count = ids.size;
  }
  return zones;
}

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

// ─── List (server-side paginated) ────────────────────────────────────
/*
 * Returns { items, total }. `q` matches zone name or city name. Pagination
 * is server-side (LIMIT/OFFSET); `total` is the unpaginated row count for
 * the same filter so the shared TablePagination can compute page count.
 * Default limit is generous (1000) so the FE "All" sentinel maps cleanly.
 */
async function listZones({ q, limit = 1000, offset = 0, includeInactive = false } = {}) {
  logger.info('Listing zones · q=' + (q || '') + ' limit=' + limit + ' offset=' + offset + ' includeInactive=' + includeInactive);
  const lim = Math.min(Math.max(Number(limit) || 1000, 1), 5000);
  const off = Math.max(Number(offset) || 0, 0);

  // WHERE built once and shared by the page + COUNT queries so filtered
  // `total` always matches the rows actually returned.
  const where = [];
  const whereParams = [];
  // Active-by-default: the Manage Zones list hides inactive zones unless the
  // operator opts in via "Show Inactive Zones" (so they can reactivate them).
  if (!(includeInactive === true || includeInactive === 'true')) {
    where.push('z.zone_status = 1');
  }
  const term = (q || '').trim();
  if (term) {
    where.push('(z.zone_name LIKE ? OR c.city_name LIKE ?)');
    const like = `%${term}%`;
    whereParams.push(like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  /*
   * technician_count used to be a correlated subquery running
   * FIND_IN_SET as a JOIN CONDITION across three tables — PER ZONE ROW, inside
   * this paginated list. That is an unbounded nested product with no early exit
   * and no row cap: the worst-shaped query in this file. It also lacked the
   * REPLACE(pincodes,' ','') normalisation, so a technician whose CSV was saved
   * with spaces contributed coverage for only their FIRST pincode.
   *
   * It is now two bounded reads: this list query (no supply join at all), then
   * one pincode fetch for the page's zones, resolved against the shared
   * coverage cache. Cost no longer scales with the number of zones on the page.
   */
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
      NULL AS technician_count   -- filled in below; see the note above
      FROM tbl_zone_master z
      LEFT JOIN tbl_city   c ON c.city_id = z.city_id
      ${whereSql}
     ORDER BY c.city_name ASC, z.zone_name ASC
     LIMIT ? OFFSET ?
  `, [...whereParams, lim, off]);

  const [[{ total }]] = await pool.query(`
    SELECT COUNT(*) AS total
      FROM tbl_zone_master z
      LEFT JOIN tbl_city c ON c.city_id = z.city_id
      ${whereSql}
  `, whereParams);

  await attachTechnicianCounts(rows);
  logger.info('Returning ' + rows.length + ' zones (total=' + Number(total) + ')');
  return { items: rows, total: Number(total) };
}

// ─── Detail (zone + assigned pincodes) ───────────────────────────────
async function getZoneDetail(zoneId) {
  logger.info('Fetching zone detail · id=' + zoneId);
  const [[zone]] = await pool.query(
    `SELECT z.zone_id, z.zone_name, z.zone_status, z.created_date,
            z.city_id, c.city_name
       FROM tbl_zone_master z
       LEFT JOIN tbl_city   c ON c.city_id = z.city_id
      WHERE z.zone_id = ?
      LIMIT 1`,
    [zoneId]
  );
  if (!zone) logger.warn('Zone not found · id=' + zoneId);
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
  // Same rewrite as the list query — the pincodes are already in hand from the
  // SELECT above, so the technician count is a cache lookup, not a third join.
  const technicianIds = await coverage.getTechnicianIdsForPincodes(pincodes.map((r) => r.pincode));
  const counts = { pincode_count: pincodes.length, technician_count: technicianIds.size };

  logger.info('Found ' + pincodes.length + ' pincodes for zone · id=' + zoneId);
  return { ...zone, pincodes, ...counts };
}

// ─── Pincodes available for assigning to this zone ───────────────────
/*
 * Eligible = ALL active pincodes anywhere (the zone-city restriction is
 * GONE — a zone may now contain pincodes from any city, and a zone with
 * "No City" must still be able to map pincodes). `q` searches across
 * pincode / location / city_name / district. Results are paginated
 * (capped ~200 per page) so the editor stays usable against the full
 * catalog. Each row carries `in_this_zone` (boolean) — EXISTS a junction
 * row for (zoneId, pincode_id) — so the FE pre-ticks current membership.
 *
 * `total` is the unpaginated count for the same filter; the FE shows it
 * and can drive a "load more" / paging affordance if needed.
 */
async function listAssignablePincodes(zoneId, { q, limit = 50, offset = 0, inZoneOnly = false } = {}) {
  logger.info('Listing assignable pincodes · zoneId=' + zoneId + ' q=' + (q || '') + ' limit=' + limit + ' offset=' + offset + ' inZoneOnly=' + inZoneOnly);
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  const onlyInZone = inZoneOnly === true || inZoneOnly === 'true';

  // Shared WHERE for page + COUNT. Only the active catalog is offered.
  const where = ['p.pincode_status = 1'];
  const whereParams = [];
  const term = (q || '').trim();
  if (term) {
    where.push('(p.pincode LIKE ? OR p.location LIKE ? OR c.city_name LIKE ? OR p.district LIKE ?)');
    const like = `%${term}%`;
    whereParams.push(like, like, like, like);
  }
  // "Show In Zone Only" — restrict to pincodes already mapped to THIS zone.
  // Appended AFTER the LIKE params so it lines up with the shared whereParams
  // order consumed by BOTH the page query (zoneId, ...whereParams, lim, off)
  // and the COUNT query (whereParams).
  if (onlyInZone) {
    where.push('EXISTS (SELECT 1 FROM tbl_zone_pincode_mapping zpm2 WHERE zpm2.zone_id = ? AND zpm2.pincode_id = p.pincode_id)');
    whereParams.push(zoneId);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const [rows] = await pool.query(
    `SELECT p.pincode_id, p.pincode, p.location, p.district, c.city_name,
            EXISTS (
              SELECT 1 FROM tbl_zone_pincode_mapping zpm
               WHERE zpm.zone_id = ? AND zpm.pincode_id = p.pincode_id
            ) AS in_this_zone
       FROM tbl_pincode p
       LEFT JOIN tbl_city c ON c.city_id = p.city_id
       ${whereSql}
      ORDER BY p.pincode ASC
      LIMIT ? OFFSET ?`,
    [zoneId, ...whereParams, lim, off]
  );

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total
       FROM tbl_pincode p
       LEFT JOIN tbl_city c ON c.city_id = p.city_id
       ${whereSql}`,
    whereParams
  );

  logger.info('Found ' + rows.length + ' assignable pincodes (total=' + Number(total) + ')');
  return {
    items: rows.map((r) => ({ ...r, in_this_zone: !!r.in_this_zone })),
    total: Number(total),
  };
}

// ─── Easyfixers in a zone (with search) ──────────────────────────────
/*
 * Returns DISTINCT active+verified technicians who SERVICE at least one
 * pincode in this zone (serviceable-based, matches technician_count above).
 * The old efr_zone_city_id membership join is intentionally gone from here;
 * candidate-ranking / auto-assign keep their own separate membership queries.
 */
async function searchEasyfixersInZone(zoneId, { q, limit = 200, activeOnly = true } = {}) {
  logger.info('Searching easyfixers in zone · zoneId=' + zoneId + ' q=' + (q || '') + ' limit=' + limit + ' activeOnly=' + activeOnly);
  /*
   * Resolve WHICH technicians service this zone from the shared coverage cache,
   * then fetch just those rows. Replaces a FIND_IN_SET join across
   * tbl_zone_pincode_mapping x tbl_pincode x tbl_efr_serviceable_pincodes that
   * could not use an index and had no row cap — and that, lacking the
   * REPLACE(' ') normalisation, silently dropped every serviceable pincode
   * after the first for any technician whose CSV contained spaces.
   */
  const [zonePins] = await pool.query(
    `SELECT p.pincode
       FROM tbl_zone_pincode_mapping zpm
       JOIN tbl_pincode p ON p.pincode_id = zpm.pincode_id
      WHERE zpm.zone_id = ?`,
    [zoneId],
  );
  const ids = [...await coverage.getTechnicianIdsForPincodes(
    zonePins.map((r) => r.pincode),
    { activeOnly },
  )];
  if (!ids.length) {
    logger.info('Found 0 easyfixers in zone · zoneId=' + zoneId);
    return [];
  }

  const params = [...ids];
  let searchFilter = '';
  if (q) {
    searchFilter = 'AND (e.efr_name LIKE ? OR e.efr_no LIKE ? OR e.efr_email LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  params.push(Number(limit));

  const [rows] = await pool.query(`
    SELECT
      e.efr_id, e.efr_name, e.efr_no, e.efr_email,
      e.efr_cityId, e.is_technician_verified, e.efr_profile_perc,
      e.efr_status,
      c.city_name
      FROM tbl_easyfixer e
      LEFT JOIN tbl_city c ON c.city_id = e.efr_cityId
     WHERE e.efr_id IN (${ids.map(() => '?').join(',')})
       ${searchFilter}
     ORDER BY e.efr_name ASC
     LIMIT ?
  `, params);
  logger.info('Found ' + rows.length + ' easyfixers in zone · zoneId=' + zoneId);
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
  logger.info('Searching easyfixers by pincode · pincode=' + pincode + ' limit=' + limit);
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
  logger.info('Found ' + rows.length + ' easyfixers for pincode · pincode=' + pincode);
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
  logger.info('Creating zone · zone_name=' + (zone_name || '') + ' city_id=' + city_id);
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
    if (dup) logger.warn('Zone create rejected · duplicate name in city · city_id=' + city_id);
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
    logger.info('Zone created · id=' + zoneId);
    return getZoneDetail(zoneId);
  } catch (e) {
    await conn.rollback();
    logger.warn('Zone create failed · rolled back · ' + e.message);
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
  logger.info('Updating zone · id=' + zoneId + ' zone_name=' + (zone_name === undefined ? '(unchanged)' : zone_name) + ' zone_status=' + (zone_status === undefined ? '(unchanged)' : zone_status));
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
  if (zone_status !== undefined) {
    // Restrict deactivation: a zone that still has pincodes mapped to it must
    // not be deactivated. This keeps the invariant "inactive zone ⟹ 0 mapped
    // pincodes" (the pincode side already refuses to map a pincode to an
    // inactive zone), so candidate-ranking's active-zone filter never silently
    // drops a pincode that operators believe is covered.
    if (!zone_status) {
      const [[{ cnt }]] = await pool.query(
        'SELECT COUNT(*) AS cnt FROM tbl_zone_pincode_mapping WHERE zone_id = ?',
        [zoneId]
      );
      if (Number(cnt) > 0) {
        logger.warn('Zone deactivation blocked · id=' + zoneId + ' mappedPincodes=' + cnt);
        throw mkErr(409, `Cannot deactivate this zone — ${cnt} pincode(s) are still mapped to it. Remove all its pincodes first.`);
      }
    }
    sets.push('zone_status = ?'); vals.push(zone_status ? 1 : 0);
  }
  if (sets.length === 0) return getZoneDetail(zoneId);

  vals.push(zoneId);
  await pool.query(`UPDATE tbl_zone_master SET ${sets.join(', ')} WHERE zone_id = ?`, vals);
  logger.info('Zone updated · id=' + zoneId);
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
 * City is NO LONGER a constraint: a zone may contain pincodes from any city
 * (including a zone with "No City"). The ONLY rejection is not-found — an id
 * that doesn't exist in tbl_pincode. Such ids are reported as `rejected`.
 */
async function setPincodeMapping(zoneId, pincodeIds, { userId = null } = {}) {
  const ids = Array.from(new Set((pincodeIds || []).map(Number).filter(Number.isFinite)));
  logger.info('Replacing zone pincode mapping · zoneId=' + zoneId + ' requested=' + ids.length);

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
      // Validate every requested id: it must EXIST in tbl_pincode. City and
      // other-zone membership are no longer constraints (multi-city,
      // multi-zone are both allowed).
      const placeholders = ids.map(() => '?').join(',');
      const [rows] = await conn.query(
        `SELECT pincode_id, pincode
           FROM tbl_pincode WHERE pincode_id IN (${placeholders})`,
        ids
      );
      const byId = new Map(rows.map((r) => [Number(r.pincode_id), r]));
      for (const id of ids) {
        const r = byId.get(id);
        if (!r) {
          rejected.push({ pincode_id: id, reason: 'Pincode not found' });
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
    logger.info('Zone pincode mapping replaced · zoneId=' + zoneId + ' accepted=' + acceptable.length + ' rejected=' + rejected.length);
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
