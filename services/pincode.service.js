const { pool } = require('../db');

/*
 * Generic pincode catalog — `tbl_pincode` (created in
 * migrations/2026-05-01-create-tbl-pincode.sql).
 *
 * Distinct from `pincode_firefox_city_mapping`, which is firefox-client-
 * specific data that we must NOT mutate. firefox-bound flows (zone-pincode
 * coverage in zone.service.js, customer-pincode → zone resolution in
 * auto-assign.service.js) continue to read from the firefox table; this
 * service operates entirely on tbl_pincode.
 *
 * Status model (computed at read time, NOT stored):
 *   LOCAL    — row active AND ≥1 active+verified easyfixer maps to a zone
 *              covering this pincode's city.
 *   TRAVEL   — row active but no qualifying tech.
 *   UNZONED  — pincode missing from this table. This service only lists
 *              rows that ARE present, so UNZONED is detected at job-create
 *              time (job.service.js) and never appears in this list view.
 *
 * Self-correcting status: the join to tbl_easyfixer is live, so onboarding
 * or deactivating a tech in an area flips affected pincodes between
 * LOCAL/TRAVEL on the next read — no migration job, no stale flag.
 */

const STATUS = Object.freeze({ LOCAL: 'LOCAL', TRAVEL: 'TRAVEL', UNZONED: 'UNZONED' });

// Active+verified easyfixer count per pincode, batched.
//
// Changed from the zone-chain join (tbl_pincode → tbl_zone_city_mapping →
// tbl_easyfixer.efr_zone_city_id) to a SERVICEABLE-PINCODE count:
// technicians whose tbl_efr_serviceable_pincodes row explicitly lists the
// pincode value (CSV TEXT column, matched with FIND_IN_SET). This matches
// the exact pattern used by candidate-ranking.service.js to identify
// serviceable technicians for a job pincode — so LOCAL/TRAVEL status now
// directly reflects "can a tech actually service this pincode" rather than
// "is a tech in the same city zone".
//
// Performance: per-page call is ~100 rows; bounded by WHERE p.pincode_id IN (?)
// + FIND_IN_SET scans only the serviceable_pincodes rows, not the full
// tbl_easyfixer table. Acceptable for an ops settings page.
async function pincodeIdToActiveEfrCount(pincodeIds) {
  if (!pincodeIds.length) return new Map();
  const placeholders = pincodeIds.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT p.pincode_id, COUNT(DISTINCT e.efr_id) AS active_efr_count
       FROM tbl_pincode p
       LEFT JOIN tbl_efr_serviceable_pincodes sp
              ON FIND_IN_SET(p.pincode, sp.pincodes) > 0
       LEFT JOIN tbl_easyfixer e
              ON e.efr_id = sp.easyfixer_id
             AND e.efr_status = 1
             AND e.is_technician_verified = 1
      WHERE p.pincode_id IN (${placeholders})
      GROUP BY p.pincode_id`,
    pincodeIds
  );
  const map = new Map();
  for (const r of rows) map.set(Number(r.pincode_id), Number(r.active_efr_count) || 0);
  return map;
}

/*
 * List active+verified technicians who explicitly service a pincode.
 *
 * Reuses the same FIND_IN_SET match as pincodeIdToActiveEfrCount and
 * candidate-ranking.service.js's serviceable-pincodes query. Supports
 * free-text search (q) over efr_name / efr_id / efr_no (mobile).
 *
 * Returns { items: [...], total } where each item has:
 *   efr_id, efr_name, efr_no, zone_name, city_name
 */
async function listTechniciansForPincode(pincodeId, { q = '', limit = 20, offset = 0 } = {}) {
  limit  = Math.min(Math.max(Number(limit)  || 20, 1), 200);
  offset = Math.max(Number(offset) || 0, 0);

  // Resolve the 6-digit pincode string from the id — needed for FIND_IN_SET.
  const [[pinRow]] = await pool.query(
    'SELECT pincode FROM tbl_pincode WHERE pincode_id = ? LIMIT 1',
    [pincodeId]
  );
  if (!pinRow) return { items: [], total: 0 };
  const pincodeVal = String(pinRow.pincode);

  const searchWhere = [];
  const searchParams = [];
  const term = String(q || '').trim();
  if (term) {
    const like = `%${term}%`;
    if (/^[0-9]+$/.test(term)) {
      searchWhere.push('(e.efr_name LIKE ? OR e.efr_no LIKE ? OR e.efr_id = ?)');
      searchParams.push(like, like, Number(term));
    } else {
      searchWhere.push('(e.efr_name LIKE ? OR e.efr_no LIKE ?)');
      searchParams.push(like, like);
    }
  }
  const extraWhere = searchWhere.length ? ` AND ${searchWhere.join(' AND ')}` : '';

  const baseParams = [pincodeVal, ...searchParams];

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(DISTINCT e.efr_id) AS total
       FROM tbl_efr_serviceable_pincodes sp
       JOIN tbl_easyfixer e ON e.efr_id = sp.easyfixer_id
                           AND e.efr_status = 1
                           AND e.is_technician_verified = 1
      WHERE FIND_IN_SET(?, sp.pincodes) > 0${extraWhere}`,
    baseParams
  );

  const [rows] = await pool.query(
    `SELECT e.efr_id,
            e.efr_name,
            e.efr_no,
            MAX(c.city_name)  AS city_name,
            MAX(zm.zone_name) AS zone_name
       FROM tbl_efr_serviceable_pincodes sp
       JOIN tbl_easyfixer e ON e.efr_id = sp.easyfixer_id
                           AND e.efr_status = 1
                           AND e.is_technician_verified = 1
       LEFT JOIN tbl_city              c   ON c.city_id = e.efr_cityId
       LEFT JOIN tbl_zone_city_mapping zcm ON zcm.city_zone_id = e.efr_zone_city_id
       LEFT JOIN tbl_zone_master       zm  ON zm.zone_id = zcm.zone_id
      WHERE FIND_IN_SET(?, sp.pincodes) > 0${extraWhere}
      GROUP BY e.efr_id, e.efr_name, e.efr_no
      ORDER BY e.efr_name ASC
      LIMIT ? OFFSET ?`,
    [...baseParams, limit, offset]
  );

  const items = rows.map((r) => ({
    efr_id:    r.efr_id,
    efr_name:  r.efr_name  ?? null,
    efr_no:    r.efr_no    ?? null,
    city_name: r.city_name ?? null,
    zone_name: r.zone_name ?? null,
  }));

  return { items, total: Number(total) || 0 };
}

// Active-zone count per pincode, batched. Mirrors pincodeIdToActiveEfrCount.
//
// A pincode is now MANY-TO-MANY with zones via tbl_zone_pincode_mapping
// (the scalar tbl_pincode.zone_id is vestigial and deliberately NOT read
// here). We count DISTINCT active zones (tbl_zone_master.zone_status = 1)
// that include each pincode. Pincodes absent from the junction return 0.
//
// Performance: bounded by WHERE zpm.pincode_id IN (?) which hits the
// KEY(pincode_id) index; one query per page regardless of page size.
async function pincodeIdToZoneCount(pincodeIds) {
  if (!pincodeIds.length) return new Map();
  const placeholders = pincodeIds.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT zpm.pincode_id, COUNT(DISTINCT zpm.zone_id) AS zone_count
       FROM tbl_zone_pincode_mapping zpm
       JOIN tbl_zone_master z ON z.zone_id = zpm.zone_id
                             AND z.zone_status = 1
      WHERE zpm.pincode_id IN (${placeholders})
      GROUP BY zpm.pincode_id`,
    pincodeIds
  );
  const map = new Map();
  for (const r of rows) map.set(Number(r.pincode_id), Number(r.zone_count) || 0);
  return map;
}

function deriveStatus(activeEfrCount) {
  return activeEfrCount > 0 ? STATUS.LOCAL : STATUS.TRAVEL;
}

// ─── List with filters + computed status ─────────────────────────────
async function listPincodes({ q, status, cityId, includeInactive = false, limit = 100, offset = 0 } = {}) {
  // Cap limit defensively. Bumped from 500 → 200000 to support the CRM
  // verification page's "load-all" dropdown (~155k rows post-seed). The
  // query is indexed on `pincode` (PK) and runs sub-second; pagination
  // is preserved for callers that still want page-size LIMITs.
  limit  = Math.min(Math.max(Number(limit)  || 100, 1), 200000);
  offset = Math.max(Number(offset) || 0, 0);

  const where = ['1=1'];
  const params = [];
  if (!includeInactive) where.push('p.pincode_status = 1');
  if (q) {
    where.push('(p.pincode LIKE ? OR c.city_name LIKE ? OR p.location LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (cityId) {
    where.push('p.city_id = ?');
    params.push(Number(cityId));
  }

  const [rows] = await pool.query(
    `SELECT
        p.pincode_id,
        p.pincode,
        p.location,
        p.city_id,
        c.city_name,
        COALESCE(p.district, c.district) AS district,
        s.state_name,
        p.pincode_status,
        p.lat,
        p.lng
       FROM tbl_pincode    p
       LEFT JOIN tbl_city  c ON c.city_id  = p.city_id
       LEFT JOIN tbl_state s ON s.state_id = c.state_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.pincode ASC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total
       FROM tbl_pincode p
       LEFT JOIN tbl_city c ON c.city_id = p.city_id
      WHERE ${where.join(' AND ')}`,
    params
  );

  // Batch-compute LOCAL/TRAVEL status + zone count (one query each,
  // regardless of page size).
  const pincodeIds = rows.map((r) => Number(r.pincode_id));
  const activeMap = await pincodeIdToActiveEfrCount(pincodeIds);
  const zoneMap   = await pincodeIdToZoneCount(pincodeIds);
  const items = rows.map((r) => {
    const activeCount = activeMap.get(Number(r.pincode_id)) || 0;
    return {
      pincode_id:       r.pincode_id,
      pincode:          String(r.pincode),
      location:         r.location || null,
      city_id:          r.city_id,
      city_name:        r.city_name || null,
      district:         r.district || null,
      state_name:       r.state_name || null,
      is_active:        Number(r.pincode_status) === 1,
      status:           deriveStatus(activeCount),
      active_efr_count: activeCount,
      zone_count:       zoneMap.get(Number(r.pincode_id)) || 0,
      lat:              r.lat != null ? Number(r.lat) : null,
      lng:              r.lng != null ? Number(r.lng) : null,
    };
  });

  // In-app status filter. Applied after computation since status is virtual.
  // For 100 rows per page this is fine; if pagination ever shows 5k rows in
  // one page, push this into a HAVING clause on the main query.
  const filtered = status
    ? items.filter((it) => it.status === String(status).toUpperCase())
    : items;

  return { items: filtered, total };
}

async function getPincodeById(pincodeId) {
  const [[row]] = await pool.query(
    `SELECT p.pincode_id, p.pincode, p.location, p.city_id, c.city_name,
            COALESCE(p.district, c.district) AS district, s.state_name,
            p.pincode_status
       FROM tbl_pincode    p
       LEFT JOIN tbl_city  c ON c.city_id  = p.city_id
       LEFT JOIN tbl_state s ON s.state_id = c.state_id
      WHERE p.pincode_id = ?
      LIMIT 1`,
    [pincodeId]
  );
  if (!row) return null;
  const activeMap = await pincodeIdToActiveEfrCount([Number(row.pincode_id)]);
  const zoneMap   = await pincodeIdToZoneCount([Number(row.pincode_id)]);
  const activeCount = activeMap.get(Number(row.pincode_id)) || 0;
  return {
    pincode_id:       row.pincode_id,
    pincode:          String(row.pincode),
    location:         row.location || null,
    city_id:          row.city_id,
    city_name:        row.city_name || null,
    district:         row.district || null,
    state_name:       row.state_name || null,
    is_active:        Number(row.pincode_status) === 1,
    status:           deriveStatus(activeCount),
    active_efr_count: activeCount,
    zone_count:       zoneMap.get(Number(row.pincode_id)) || 0,
  };
}

/*
 * Bulk lookup by 6-digit code. Used by the CRM verification page's
 * "Add All Matching Pincodes" bulk-paste flow. De-dupes + sanitises input,
 * caps at 500, runs a single indexed IN(...) scan. Returns
 *   { items: [...], notFound: ['110099', ...] }
 * so the FE can toast the unmatched codes.
 */
async function lookupManyByCode(pincodes) {
  if (!Array.isArray(pincodes) || pincodes.length === 0) {
    return { items: [], notFound: [] };
  }
  const clean = Array.from(new Set(
    pincodes.map((p) => String(p).trim()).filter((p) => /^\d{6}$/.test(p))
  )).slice(0, 500);
  if (clean.length === 0) return { items: [], notFound: pincodes };

  const placeholders = clean.map(() => '?').join(',');
  const [items] = await pool.query(
    `SELECT p.pincode_id, p.pincode, p.location AS pincode_location,
            p.city_id, c.city_name, c.state_id, s.state_name
       FROM tbl_pincode    p
       LEFT JOIN tbl_city  c ON c.city_id  = p.city_id
       LEFT JOIN tbl_state s ON s.state_id = c.state_id
      WHERE p.pincode IN (${placeholders})
        AND p.pincode_status = 1`,
    clean
  );

  const foundSet = new Set(items.map((i) => String(i.pincode)));
  const notFound = clean.filter((p) => !foundSet.has(p));
  return { items, notFound };
}

async function getPincodeByValue(pincode) {
  const [[row]] = await pool.query(
    'SELECT pincode_id FROM tbl_pincode WHERE pincode = ? LIMIT 1', [String(pincode)]
  );
  return row ? getPincodeById(row.pincode_id) : null;
}

// ─── Create / Update / Delete ────────────────────────────────────────
function badReq(msg) {
  const err = new Error(msg);
  err.status = 400;
  return err;
}

async function assertCityExists(cityId) {
  const [[row]] = await pool.query('SELECT city_id FROM tbl_city WHERE city_id = ? LIMIT 1', [cityId]);
  if (!row) throw badReq(`Unknown city_id ${cityId}`);
}

async function createPincode({ pincode, location, city_id, district }, { userId = null } = {}) {
  if (!/^\d{6}$/.test(String(pincode))) throw badReq('Pincode must be exactly 6 digits');
  if (!city_id) throw badReq('city_id is required');
  await assertCityExists(city_id);

  const [[existing]] = await pool.query(
    'SELECT pincode_id FROM tbl_pincode WHERE pincode = ? LIMIT 1', [String(pincode)]
  );
  if (existing) {
    const err = new Error(`Pincode ${pincode} already exists`);
    err.status = 409;
    throw err;
  }

  const [result] = await pool.query(
    `INSERT INTO tbl_pincode
       (pincode, location, city_id, district, pincode_status, created_by, updated_by)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
    [String(pincode), location || null, Number(city_id), district || null, userId, userId]
  );
  return getPincodeById(result.insertId);
}

async function updatePincode(pincodeId, fields, { userId = null } = {}) {
  // Whitelist of mutable fields. `pincode` is intentionally excluded — the
  // value is the user-meaningful key; changing it would orphan downstream
  // job rows that reference it. Delete + re-add is the explicit path.
  const sets = [];
  const params = [];
  if (fields.location !== undefined)       { sets.push('location = ?');       params.push(fields.location || null); }
  if (fields.city_id !== undefined)        { sets.push('city_id = ?');        params.push(Number(fields.city_id)); await assertCityExists(fields.city_id); }
  if (fields.district !== undefined)       { sets.push('district = ?');       params.push(fields.district || null); }
  if (fields.is_active !== undefined)      { sets.push('pincode_status = ?'); params.push(fields.is_active ? 1 : 0); }
  if (!sets.length) throw badReq('No mutable fields supplied');
  sets.push('updated_by = ?');
  params.push(userId);

  const [result] = await pool.query(
    `UPDATE tbl_pincode SET ${sets.join(', ')} WHERE pincode_id = ?`,
    [...params, pincodeId]
  );
  if (!result.affectedRows) return null;
  return getPincodeById(pincodeId);
}

/*
 * Soft-delete. We never DELETE rows because tbl_job (and other downstream
 * tables) reference pincodes by string value; a hard delete would orphan
 * historical jobs. Setting pincode_status = 0 hides the row from default
 * lists while preserving join integrity.
 */
async function deletePincode(pincodeId, { userId = null } = {}) {
  const [result] = await pool.query(
    'UPDATE tbl_pincode SET pincode_status = 0, updated_by = ? WHERE pincode_id = ?',
    [userId, pincodeId]
  );
  return result.affectedRows > 0;
}

module.exports = {
  STATUS,
  listPincodes,
  getPincodeById,
  getPincodeByValue,
  lookupManyByCode,
  createPincode,
  updatePincode,
  deletePincode,
  listTechniciansForPincode,
};
