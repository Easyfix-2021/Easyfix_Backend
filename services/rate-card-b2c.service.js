const { pool } = require('../db');
const logger = require('../logger');

/*
 * Manage B2C Rate Cards — master for tbl_retail_rate_card.
 *
 * Schema columns in use:
 *   rrc_id (PK), rrc_servicetype_id (FK → tbl_service_type),
 *   rrc_service_name, rrc_service_price (INT — UNIQUE to B2C),
 *   insert_date, update_date, updated_by.
 *
 * Difference vs B2B:
 *   B2B (tbl_client_rate_card) stores per-client pricing in
 *   tbl_client_service.total_amount (the junction). B2C stores price
 *   directly on rrc_service_price because retail rates are catalog
 *   prices, not per-customer.
 *
 * Status convention: assumes a `status` column following the legacy
 * convention across master tables (1=active, 0=inactive, 3=soft-deleted).
 * If your DB doesn't have this column for tbl_retail_rate_card, the
 * deactivate UPDATE will fail with "Unknown column 'status'" — drop
 * the WHERE/SET status clauses or add the column.
 */

function mkErr(status, message) { const e = new Error(message); e.status = status; return e; }

const SORTABLE_COLUMNS = Object.freeze({
  rrc_id:               'rc.rrc_id',
  rrc_service_name:     'rc.rrc_ratecard_name',
  rrc_service_price:    'rc.rrc_ratecard_price',
  service_type_name:    'st.service_type_name',
  service_catg_name:    'sc.service_catg_name',
  // `status` is deliberately absent — there is no such column to sort on. An
  // unknown sortBy falls back to rrc_service_name, so an old caller still works.
});

async function listRateCards({
  q, serviceTypeId, serviceCatgId, includeInactive = false,
  limit = 200, offset = 0,
  sortBy = 'rrc_service_name', sortDir = 'asc',
} = {}) {
  limit  = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  offset = Math.max(Number(offset) || 0, 0);

  logger.info('List B2C rate cards · q=' + (q || '-') + ' · serviceTypeId=' + (serviceTypeId || '-') + ' · serviceCatgId=' + (serviceCatgId || '-') + ' · includeInactive=' + includeInactive + ' · limit=' + limit + ' · offset=' + offset);

  const sortExpr = SORTABLE_COLUMNS[sortBy] || SORTABLE_COLUMNS.rrc_service_name;
  const dir      = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const orderBy  = `${sortExpr} ${dir}, rc.rrc_id ASC`;

  /*
   * NO STATUS FILTER. tbl_retail_rate_card has seven columns and none of them
   * is `status` — this file's own header predicted the failure ("drop the
   * WHERE/SET status clauses or add the column"), and every read here threw
   * ER_BAD_FIELD_ERROR until now.
   *
   * Dropped rather than added: easyfix_core is the shared legacy database and
   * CLAUDE.md's standing rule is never to alter its schema. Adding a column to
   * a table five other services read is not a call this fix gets to make.
   *
   * `includeInactive` therefore has nothing to filter and is accepted as a
   * no-op rather than removed, so the route contract and the CRM stay unchanged.
   */
  const where  = ['1=1'];
  const params = [];
  void includeInactive;
  if (serviceTypeId)    { where.push('rc.rrc_servicetype_id = ?'); params.push(Number(serviceTypeId)); }
  if (serviceCatgId)    { where.push('st.service_catg_id = ?');    params.push(Number(serviceCatgId)); }
  if (q) {
    where.push('(rc.rrc_ratecard_name LIKE ? OR st.service_type_name LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }

  const [rows] = await pool.query(
    `SELECT rc.rrc_id, rc.rrc_servicetype_id,
            rc.rrc_ratecard_name  AS rrc_service_name,
            rc.rrc_ratecard_price AS rrc_service_price,
            NULL AS status,
            st.service_type_name, st.service_catg_id, sc.service_catg_name
       FROM tbl_retail_rate_card rc
       LEFT JOIN tbl_service_type st ON st.service_type_id = rc.rrc_servicetype_id
       LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = st.service_catg_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total
       FROM tbl_retail_rate_card rc
       LEFT JOIN tbl_service_type st ON st.service_type_id = rc.rrc_servicetype_id
       LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = st.service_catg_id
      WHERE ${where.join(' AND ')}`,
    params
  );

  logger.info('Found ' + rows.length + ' B2C rate cards · total=' + total);
  return { items: rows, total };
}

async function getRateCardById(id) {
  const [[row]] = await pool.query(
    `SELECT rc.rrc_id, rc.rrc_servicetype_id,
            rc.rrc_ratecard_name  AS rrc_service_name,
            rc.rrc_ratecard_price AS rrc_service_price,
            NULL AS status,
            st.service_type_name, st.service_catg_id, sc.service_catg_name
       FROM tbl_retail_rate_card rc
       LEFT JOIN tbl_service_type st ON st.service_type_id = rc.rrc_servicetype_id
       LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = st.service_catg_id
      WHERE rc.rrc_id = ? LIMIT 1`,
    [id]
  );
  return row || null;
}

async function createRateCard({ rrc_service_name, rrc_servicetype_id, rrc_service_price, createdBy }) {
  const name = String(rrc_service_name || '').trim();
  logger.info('Create B2C rate card · name="' + name + '" · serviceTypeId=' + (rrc_servicetype_id || '-') + ' · price=' + (rrc_service_price == null ? '-' : rrc_service_price));
  if (!name)                                throw mkErr(400, 'rrc_service_name is required');
  if (!rrc_servicetype_id)                  throw mkErr(400, 'rrc_servicetype_id is required');
  if (rrc_service_price == null)            throw mkErr(400, 'rrc_service_price is required');
  const price = Number(rrc_service_price);
  if (!Number.isFinite(price) || price < 0) throw mkErr(400, 'rrc_service_price must be a non-negative number');

  const [[st]] = await pool.query(
    'SELECT service_type_id FROM tbl_service_type WHERE service_type_id = ? AND service_type_status = 1 LIMIT 1',
    [rrc_servicetype_id]
  );
  if (!st) throw mkErr(400, `Unknown or inactive service_type_id ${rrc_servicetype_id}`);

  const [[dup]] = await pool.query(
    `SELECT rrc_id FROM tbl_retail_rate_card
      WHERE rrc_servicetype_id = ?
        AND LOWER(rrc_ratecard_name) = LOWER(?)
      LIMIT 1`,
    [rrc_servicetype_id, name]
  );
  if (dup) throw mkErr(409, `B2C rate card "${name}" already exists for this service type`);

  const [r] = await pool.query(
    `INSERT INTO tbl_retail_rate_card
       (rrc_servicetype_id, rrc_ratecard_name, rrc_ratecard_price,
        insert_date, update_date, updated_by)
     VALUES (?, ?, ?, NOW(), NOW(), ?)`,
    [Number(rrc_servicetype_id), name, Math.round(price), createdBy || null]
  );
  logger.info('B2C rate card created · id=' + r.insertId);
  return getRateCardById(r.insertId);
}

async function updateRateCard(id, fields, updatedBy) {
  logger.info('Update B2C rate card · id=' + id + ' · fields=' + Object.keys(fields || {}).join(','));
  const [[me]] = await pool.query(
    'SELECT rrc_id FROM tbl_retail_rate_card WHERE rrc_id = ? AND (status IS NULL OR status <> 3) LIMIT 1',
    [id]
  );
  if (!me) throw mkErr(404, 'B2C Rate Card not found');

  const sets   = [];
  const params = [];
  if (fields.rrc_service_name !== undefined) {
    const name = String(fields.rrc_service_name).trim();
    if (!name) throw mkErr(400, 'rrc_service_name cannot be blank');
    sets.push('rrc_ratecard_name = ?'); params.push(name);
  }
  if (fields.rrc_servicetype_id !== undefined) {
    const [[st]] = await pool.query(
      'SELECT service_type_id FROM tbl_service_type WHERE service_type_id = ? AND service_type_status = 1 LIMIT 1',
      [fields.rrc_servicetype_id]
    );
    if (!st) throw mkErr(400, `Unknown or inactive service_type_id ${fields.rrc_servicetype_id}`);
    sets.push('rrc_servicetype_id = ?'); params.push(Number(fields.rrc_servicetype_id));
  }
  if (fields.rrc_service_price !== undefined) {
    const price = Number(fields.rrc_service_price);
    if (!Number.isFinite(price) || price < 0) throw mkErr(400, 'rrc_service_price must be a non-negative number');
    sets.push('rrc_ratecard_price = ?'); params.push(Math.round(price));
  }
  if (fields.is_active !== undefined) {
    /*
     * There is no `status` column on tbl_retail_rate_card, so this cannot be
     * honoured. It used to emit `SET status = ?`, which failed the WHOLE
     * update — a caller changing the name AND the flag lost the name too.
     *
     * Refused explicitly instead. 501 says "this deployment cannot do that",
     * which is true and actionable, where ER_BAD_FIELD_ERROR said nothing.
     */
    throw mkErr(501, 'Activating or deactivating a B2C rate card is not supported on this '
      + 'schema — tbl_retail_rate_card has no status column.');
  }
  if (!sets.length) throw mkErr(400, 'No mutable fields supplied');

  sets.push('update_date = NOW()', 'updated_by = ?');
  params.push(updatedBy || null, id);
  await pool.query(`UPDATE tbl_retail_rate_card SET ${sets.join(', ')} WHERE rrc_id = ?`, params);
  logger.info('B2C rate card updated · id=' + id);
  return getRateCardById(id);
}

/*
 * SOFT DELETE IS NOT AVAILABLE HERE, and saying so beats failing at the driver.
 *
 * This wrote `SET status = 3` to a table with no status column, so every call
 * threw ER_BAD_FIELD_ERROR and the operator saw a 500 with no explanation.
 *
 * The column is not being ADDED: easyfix_core is the shared legacy database and
 * CLAUDE.md's standing rule is never to alter its schema — five other services
 * read this table. If retiring a B2C rate card becomes a real requirement, that
 * is a migration and an owner decision, not a line in this file.
 */
async function deactivateRateCard(id) {
  logger.warn('B2C rate card deactivate refused · id=' + id + ' · no status column on tbl_retail_rate_card');
  throw mkErr(501, 'Retiring a B2C rate card is not supported on this schema — '
    + 'tbl_retail_rate_card has no status column.');
}

module.exports = {
  listRateCards,
  getRateCardById,
  createRateCard,
  updateRateCard,
  deactivateRateCard,
  SORTABLE_COLUMNS,
};
