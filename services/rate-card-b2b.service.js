const { pool } = require('../db');
const logger = require('../logger');

/*
 * Manage B2B Rate Cards — master for tbl_client_rate_card.
 *
 * Schema columns in use (from legacy DAO, NOT the stale schema file —
 * the file says `crc_service_name` but production code, SP signatures,
 * and downstream readers all use `crc_ratecard_name`):
 *   crc_id (PK), crc_servicetype_id (FK → tbl_service_type),
 *   crc_ratecard_name, status, insert_date, update_date, updated_by.
 *
 * Status convention (legacy ClientRateCardAction):
 *   1 = Active
 *   0 = Inactive (deactivated but kept for audit)
 *   3 = Soft-deleted (legacy "removed" — hidden from every read)
 *
 * B2B is name-only — there is NO price column on tbl_client_rate_card.
 * Per-client pricing lives in tbl_client_service.total_amount + charge_type
 * keyed by rate_card_id. That junction is read at job-creation time via
 * lookup.service.clientServices() and is OUT OF SCOPE for this CRUD;
 * editing it belongs to a separate "Client Services" surface.
 *
 * No bulk import flow in legacy — manual add-one-by-one. Matching that.
 */

function mkErr(status, message) { const e = new Error(message); e.status = status; return e; }

const SORTABLE_COLUMNS = Object.freeze({
  crc_id:              'rc.crc_id',
  crc_ratecard_name:   'rc.crc_ratecard_name',
  service_type_name:   'st.service_type_name',
  service_catg_name:   'sc.service_catg_name',
  status:              'rc.status',
});

async function listRateCards({
  q, serviceTypeId, serviceCatgId, includeInactive = false,
  limit = 200, offset = 0,
  sortBy = 'crc_ratecard_name', sortDir = 'asc',
} = {}) {
  limit  = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  offset = Math.max(Number(offset) || 0, 0);

  logger.info('List B2B rate cards · q=' + (q || '-') + ' · serviceTypeId=' + (serviceTypeId || '-') + ' · serviceCatgId=' + (serviceCatgId || '-') + ' · includeInactive=' + includeInactive + ' · limit=' + limit + ' · offset=' + offset);

  const sortExpr = SORTABLE_COLUMNS[sortBy] || SORTABLE_COLUMNS.crc_ratecard_name;
  const dir      = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const orderBy  = `${sortExpr} ${dir}, rc.crc_id ASC`;

  const where  = ['rc.status <> 3'];
  const params = [];
  if (!includeInactive) where.push('rc.status = 1');
  if (serviceTypeId)    { where.push('rc.crc_servicetype_id = ?'); params.push(Number(serviceTypeId)); }
  if (serviceCatgId)    { where.push('st.service_catg_id = ?');    params.push(Number(serviceCatgId)); }
  if (q) {
    where.push('(rc.crc_ratecard_name LIKE ? OR st.service_type_name LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }

  const [rows] = await pool.query(
    `SELECT rc.crc_id, rc.crc_servicetype_id, rc.crc_ratecard_name, rc.status,
            st.service_type_name, st.service_catg_id, sc.service_catg_name
       FROM tbl_client_rate_card rc
       LEFT JOIN tbl_service_type st ON st.service_type_id = rc.crc_servicetype_id
       LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = st.service_catg_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total
       FROM tbl_client_rate_card rc
       LEFT JOIN tbl_service_type st ON st.service_type_id = rc.crc_servicetype_id
       LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = st.service_catg_id
      WHERE ${where.join(' AND ')}`,
    params
  );

  logger.info('Found ' + rows.length + ' B2B rate cards · total=' + total);
  return { items: rows, total };
}

async function getRateCardById(id) {
  const [[row]] = await pool.query(
    `SELECT rc.crc_id, rc.crc_servicetype_id, rc.crc_ratecard_name, rc.status,
            st.service_type_name, st.service_catg_id, sc.service_catg_name
       FROM tbl_client_rate_card rc
       LEFT JOIN tbl_service_type st ON st.service_type_id = rc.crc_servicetype_id
       LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = st.service_catg_id
      WHERE rc.crc_id = ? AND rc.status <> 3 LIMIT 1`,
    [id]
  );
  return row || null;
}

async function createRateCard({ crc_ratecard_name, crc_servicetype_id, createdBy }) {
  const name = String(crc_ratecard_name || '').trim();
  logger.info('Create B2B rate card · name="' + name + '" · serviceTypeId=' + (crc_servicetype_id || '-'));
  if (!name)                throw mkErr(400, 'crc_ratecard_name is required');
  if (!crc_servicetype_id)  throw mkErr(400, 'crc_servicetype_id is required');

  // Validate service_type exists + active.
  const [[st]] = await pool.query(
    'SELECT service_type_id FROM tbl_service_type WHERE service_type_id = ? AND service_type_status = 1 LIMIT 1',
    [crc_servicetype_id]
  );
  if (!st) throw mkErr(400, `Unknown or inactive service_type_id ${crc_servicetype_id}`);

  // Uniqueness within (service_type, name) — legacy doesn't enforce this in
  // DB but allowing duplicates would surface ambiguous picker entries when
  // assigning a client to a rate card. App-level guard is enough.
  const [[dup]] = await pool.query(
    `SELECT crc_id FROM tbl_client_rate_card
      WHERE crc_servicetype_id = ?
        AND LOWER(crc_ratecard_name) = LOWER(?)
        AND status <> 3
      LIMIT 1`,
    [crc_servicetype_id, name]
  );
  if (dup) throw mkErr(409, `B2B rate card "${name}" already exists for this service type`);

  const [r] = await pool.query(
    `INSERT INTO tbl_client_rate_card
       (crc_servicetype_id, crc_ratecard_name, status, insert_date, update_date, updated_by)
     VALUES (?, ?, 1, NOW(), NOW(), ?)`,
    [Number(crc_servicetype_id), name, createdBy || null]
  );
  logger.info('B2B rate card created · id=' + r.insertId);
  return getRateCardById(r.insertId);
}

async function updateRateCard(id, fields, updatedBy) {
  logger.info('Update B2B rate card · id=' + id + ' · fields=' + Object.keys(fields || {}).join(','));
  const [[me]] = await pool.query(
    'SELECT crc_id FROM tbl_client_rate_card WHERE crc_id = ? AND status <> 3 LIMIT 1',
    [id]
  );
  if (!me) throw mkErr(404, 'B2B Rate Card not found');

  const sets   = [];
  const params = [];
  if (fields.crc_ratecard_name !== undefined) {
    const name = String(fields.crc_ratecard_name).trim();
    if (!name) throw mkErr(400, 'crc_ratecard_name cannot be blank');
    sets.push('crc_ratecard_name = ?'); params.push(name);
  }
  if (fields.crc_servicetype_id !== undefined) {
    const [[st]] = await pool.query(
      'SELECT service_type_id FROM tbl_service_type WHERE service_type_id = ? AND service_type_status = 1 LIMIT 1',
      [fields.crc_servicetype_id]
    );
    if (!st) throw mkErr(400, `Unknown or inactive service_type_id ${fields.crc_servicetype_id}`);
    sets.push('crc_servicetype_id = ?'); params.push(Number(fields.crc_servicetype_id));
  }
  if (fields.is_active !== undefined) {
    sets.push('status = ?'); params.push(fields.is_active ? 1 : 0);
  }
  if (!sets.length) throw mkErr(400, 'No mutable fields supplied');

  sets.push('update_date = NOW()', 'updated_by = ?');
  params.push(updatedBy || null, id);
  await pool.query(`UPDATE tbl_client_rate_card SET ${sets.join(', ')} WHERE crc_id = ?`, params);
  logger.info('B2B rate card updated · id=' + id);
  return getRateCardById(id);
}

async function deactivateRateCard(id, updatedBy) {
  logger.info('Delete (soft) B2B rate card · id=' + id);
  // Soft-delete via status=3 (legacy "removed" — fully hidden) rather than
  // status=0 (inactive). Matches the legacy ClientRateCardDaoImpl
  // addDeleteClientRateCard which sets status=3 directly.
  const [r] = await pool.query(
    `UPDATE tbl_client_rate_card
        SET status = 3, update_date = NOW(), updated_by = ?
      WHERE crc_id = ? AND status <> 3`,
    [updatedBy || null, id]
  );
  logger.info('B2B rate card deleted · id=' + id + ' · affected=' + r.affectedRows);
  return r.affectedRows > 0;
}

module.exports = {
  listRateCards,
  getRateCardById,
  createRateCard,
  updateRateCard,
  deactivateRateCard,
  SORTABLE_COLUMNS,
};
