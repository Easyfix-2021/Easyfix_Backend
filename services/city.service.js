const { pool } = require('../db');
const logger = require('../logger');

/*
 * Manage Cities — generic master.
 *
 * Operates on existing tbl_city (NOT a new table — cities have been a
 * shared schema-level entity since the legacy CRM, with five legacy
 * services already reading the same rows). Columns in use:
 *   city_id, city_name, state_id, city_status, tier, district, reference_pincode
 *
 * UX columns (per spec for Manage Cities):
 *   City ID | City Name | State | District | Tier | Status |
 *   No. of Zones | No. of Pincodes | No. of Technicians
 *
 * Counts are computed at read time (no stored flags) so onboarding /
 * deactivating downstream entities reflects on the next page load.
 */

const STATUS_ACTIVE = 1;

function mkErr(status, message) { const e = new Error(message); e.status = status; return e; }

/*
 * Whitelist of sortable columns. Maps the public API key (sortBy=...) to
 * the actual SQL expression. Whitelisting is mandatory — interpolating an
 * arbitrary client-supplied column name into ORDER BY is a SQL injection
 * vector. Computed columns (zone_count, etc.) are valid because MySQL
 * resolves SELECT aliases inside ORDER BY.
 */
const SORTABLE_COLUMNS = Object.freeze({
  city_id:          'c.city_id',
  city_name:        'c.city_name',
  state_name:       's.state_name',
  district:         'c.district',
  tier:             'c.tier',
  zone_count:       'zone_count',
  pincode_count:    'pincode_count',
  technician_count: 'technician_count',
  city_status:      'c.city_status',
});

// ─── List ────────────────────────────────────────────────────────────
async function listCities({
  q, stateId, includeInactive = false,
  limit = 200, offset = 0,
  sortBy = 'city_name', sortDir = 'asc',
} = {}) {
  limit  = Math.min(Math.max(Number(limit)  || 200, 1), 1000);
  offset = Math.max(Number(offset) || 0, 0);

  logger.info('List cities · q=' + (q || '-') + ' stateId=' + (stateId || '-') + ' includeInactive=' + includeInactive + ' sortBy=' + sortBy + ' sortDir=' + sortDir + ' limit=' + limit + ' offset=' + offset);

  const sortExpr = SORTABLE_COLUMNS[sortBy] || SORTABLE_COLUMNS.city_name;
  const dir      = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  // Stable secondary sort on city_id keeps row order deterministic when
  // the primary sort key has duplicates (e.g. many cities with empty
  // district). Without it, paginated results can shuffle on each page-load.
  const orderBy  = `${sortExpr} ${dir}, c.city_id ASC`;

  const where = ['1=1'];
  const params = [];
  if (!includeInactive) where.push('c.city_status = 1');
  if (q) {
    where.push('(c.city_name LIKE ? OR c.district LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  if (stateId) { where.push('c.state_id = ?'); params.push(Number(stateId)); }

  const [rows] = await pool.query(
    `SELECT
        c.city_id,
        c.city_name,
        c.state_id,
        s.state_name,
        c.district,
        c.tier,
        c.reference_pincode,
        c.city_status,
        (SELECT COUNT(*) FROM tbl_zone_master z
          WHERE z.city_id = c.city_id AND z.zone_status = 1)        AS zone_count,
        (SELECT COUNT(*) FROM tbl_pincode p
          WHERE p.city_id = c.city_id AND p.pincode_status = 1)     AS pincode_count,
        (SELECT COUNT(*) FROM tbl_easyfixer e
          WHERE e.efr_cityId = c.city_id AND e.efr_status = 1)      AS technician_count
       FROM tbl_city  c
       LEFT JOIN tbl_state s ON s.state_id = c.state_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  logger.info('Found ' + rows.length + ' cities');

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM tbl_city c WHERE ${where.join(' AND ')}`,
    params
  );

  logger.info('Returning ' + rows.length + ' cities · total=' + total);
  return { items: rows, total };
}

async function getCityById(cityId) {
  logger.info('Get city by id · id=' + cityId);
  const [[row]] = await pool.query(
    `SELECT c.city_id, c.city_name, c.state_id, s.state_name,
            c.district, c.tier, c.reference_pincode, c.city_status,
            (SELECT COUNT(*) FROM tbl_zone_master z
              WHERE z.city_id = c.city_id AND z.zone_status = 1)        AS zone_count,
            (SELECT COUNT(*) FROM tbl_pincode p
              WHERE p.city_id = c.city_id AND p.pincode_status = 1)     AS pincode_count,
            (SELECT COUNT(*) FROM tbl_easyfixer e
              WHERE e.efr_cityId = c.city_id AND e.efr_status = 1)      AS technician_count
       FROM tbl_city  c
       LEFT JOIN tbl_state s ON s.state_id = c.state_id
      WHERE c.city_id = ? LIMIT 1`,
    [cityId]
  );
  return row || null;
}

// ─── Create ──────────────────────────────────────────────────────────
async function createCity({ city_name, state_id, district, tier, reference_pincode }) {
  logger.info('Create city · city_name=' + (city_name || '-') + ' state_id=' + (state_id || '-') + ' district=' + (district || '-') + ' tier=' + (tier || '-'));
  const trimmed = String(city_name || '').trim();
  if (!trimmed) throw mkErr(400, 'city_name is required');
  if (!state_id) throw mkErr(400, 'state_id is required');

  // City names are unique within a state — a "Hyderabad" in Telangana
  // and a hypothetical same-named entry in another state are distinct.
  const [[stateRow]] = await pool.query(
    'SELECT state_id FROM tbl_state WHERE state_id = ? LIMIT 1', [state_id]
  );
  if (!stateRow) throw mkErr(400, `Unknown state_id ${state_id}`);

  const [[dup]] = await pool.query(
    `SELECT city_id FROM tbl_city
      WHERE state_id = ? AND LOWER(city_name) = LOWER(?) LIMIT 1`,
    [state_id, trimmed]
  );
  if (dup) throw mkErr(409, `City "${trimmed}" already exists in this state`);

  const [r] = await pool.query(
    `INSERT INTO tbl_city
       (city_name, state_id, district, tier, reference_pincode, city_status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      trimmed,
      Number(state_id),
      district || null,
      tier || null,
      reference_pincode || null,
      STATUS_ACTIVE,
    ]
  );
  logger.info('City created · id=' + r.insertId);
  return getCityById(r.insertId);
}

// ─── Update ──────────────────────────────────────────────────────────
async function updateCity(cityId, fields) {
  logger.info('Update city · id=' + cityId + ' fields=[' + Object.keys(fields || {}).join(',') + ']');
  const sets = [];
  const params = [];

  if (fields.city_name !== undefined) {
    const trimmed = String(fields.city_name).trim();
    if (!trimmed) throw mkErr(400, 'city_name cannot be blank');
    // Uniqueness check needs the current state_id (or the new one if also updating).
    const [[me]] = await pool.query('SELECT state_id FROM tbl_city WHERE city_id = ? LIMIT 1', [cityId]);
    if (!me) throw mkErr(404, 'City not found');
    const targetStateId = fields.state_id !== undefined ? Number(fields.state_id) : me.state_id;
    const [[dup]] = await pool.query(
      `SELECT city_id FROM tbl_city
        WHERE state_id = ? AND LOWER(city_name) = LOWER(?) AND city_id <> ? LIMIT 1`,
      [targetStateId, trimmed, cityId]
    );
    if (dup) throw mkErr(409, `Another city named "${trimmed}" exists in this state`);
    sets.push('city_name = ?'); params.push(trimmed);
  }
  if (fields.state_id !== undefined) {
    const [[s]] = await pool.query('SELECT state_id FROM tbl_state WHERE state_id = ? LIMIT 1', [fields.state_id]);
    if (!s) throw mkErr(400, `Unknown state_id ${fields.state_id}`);
    sets.push('state_id = ?'); params.push(Number(fields.state_id));
  }
  if (fields.district !== undefined)          { sets.push('district = ?');          params.push(fields.district || null); }
  if (fields.tier !== undefined)              { sets.push('tier = ?');              params.push(fields.tier || null); }
  if (fields.reference_pincode !== undefined) { sets.push('reference_pincode = ?'); params.push(fields.reference_pincode || null); }
  if (fields.is_active !== undefined)         { sets.push('city_status = ?');       params.push(fields.is_active ? 1 : 0); }

  if (!sets.length) throw mkErr(400, 'No mutable fields supplied');

  params.push(cityId);
  const [r] = await pool.query(`UPDATE tbl_city SET ${sets.join(', ')} WHERE city_id = ?`, params);
  if (!r.affectedRows) return null;
  logger.info('City updated · id=' + cityId);
  return getCityById(cityId);
}

// ─── Soft-delete (status flag) ───────────────────────────────────────
/*
 * No hard delete. tbl_city is referenced by tbl_pincode, tbl_zone_master,
 * tbl_easyfixer, address tables, etc. — orphaning rows would break joins
 * across legacy services. Setting city_status = 0 hides the row from
 * default lists while preserving every historical reference.
 */
async function deactivateCity(cityId) {
  logger.info('Deactivate city · id=' + cityId);
  const [r] = await pool.query(
    'UPDATE tbl_city SET city_status = 0 WHERE city_id = ?',
    [cityId]
  );
  logger.info('City deactivated · id=' + cityId + ' affected=' + r.affectedRows);
  return r.affectedRows > 0;
}

module.exports = {
  listCities,
  getCityById,
  createCity,
  updateCity,
  deactivateCity,
  SORTABLE_COLUMNS,
};
