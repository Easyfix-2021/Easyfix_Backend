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

// Active+verified easyfixer count per pincode, batched. The chain is the
// same as the firefox flow but keyed off tbl_pincode.city_id (FK-style)
// instead of pincode_firefox_city_mapping.city_name (string join).
async function pincodeIdToActiveEfrCount(pincodeIds) {
  if (!pincodeIds.length) return new Map();
  const placeholders = pincodeIds.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT p.pincode_id, COUNT(DISTINCT e.efr_id) AS active_efr_count
       FROM tbl_pincode              p
       LEFT JOIN tbl_zone_city_mapping zcm ON zcm.city_id = p.city_id
       LEFT JOIN tbl_easyfixer       e   ON e.efr_zone_city_id = zcm.city_zone_id
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
        p.pincode_status
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

  // Batch-compute LOCAL/TRAVEL status (one query, regardless of page size).
  const activeMap = await pincodeIdToActiveEfrCount(rows.map((r) => Number(r.pincode_id)));
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
};
