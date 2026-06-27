const router = require('express').Router();
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');
const Joi = require('joi');
const validate = require('../../middleware/validate');
const logger = require('../../logger');

/*
 * Manage Customers — minimal admin surface over tbl_customer + tbl_address.
 *
 * Legacy `customerList.vm` + `addEditCustomers.vm` had heavy multi-tab forms
 * (personal + multiple addresses + history). The new platform mostly auto-
 * upserts customers via job creation, so this admin surface is read-first
 * with a light upsert path.
 *
 * VERIFIED columns in production (INFORMATION_SCHEMA 2026-05-12):
 *   customer_id, customer_mob_no, customer_name, customer_email,
 *   is_active, insert_date, update_date, created_by, updated_by.
 *   (Earlier comment listed `alt_mob_no` + `customer_status` — neither
 *   exists in production. Removed.)
 */

const listQuery = Joi.object({
  q:               Joi.string().allow('', null).optional(),
  limit:           Joi.number().integer().min(1).max(500).default(100),
  offset:          Joi.number().integer().min(0).default(0),
  sortBy:          Joi.string().valid('customer_id', 'customer_name', 'customer_mob_no').default('customer_id'),
  sortDir:         Joi.string().lowercase().valid('asc', 'desc').default('desc'),
});

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const { q, limit, offset, sortBy, sortDir } = req.query;
    logger.info('List customers · search=' + (q ? 'yes' : 'no') + ' limit=' + limit + ' offset=' + offset + ' sortBy=' + sortBy + ' sortDir=' + sortDir);
    const dir = sortDir === 'desc' ? 'DESC' : 'ASC';
    const where = ['1=1'];
    const params = [];
    if (q) {
      where.push('(customer_name LIKE ? OR customer_mob_no LIKE ? OR customer_email LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const [rows] = await pool.query(
      `SELECT customer_id, customer_name, customer_mob_no, customer_email,
              is_active, insert_date, update_date,
              (SELECT COUNT(*) FROM tbl_job j WHERE j.fk_customer_id = c.customer_id) AS job_count
         FROM tbl_customer c
        WHERE ${where.join(' AND ')}
        ORDER BY ${sortBy} ${dir}
        LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)]
    );
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM tbl_customer c WHERE ${where.join(' AND ')}`, params);
    logger.info('Returning ' + rows.length + ' customers · total=' + total);
    modernOk(res, { items: rows, total });
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    logger.info('Get customer detail · id=' + req.params.id);
    const [[row]] = await pool.query(
      `SELECT * FROM tbl_customer WHERE customer_id = ? LIMIT 1`, [req.params.id]);
    if (!row) {
      logger.warn('Customer not found · id=' + req.params.id);
      return modernError(res, 404, 'Customer not found');
    }
    const [addresses] = await pool.query(
      `SELECT * FROM tbl_address WHERE customer_id = ? ORDER BY address_id DESC LIMIT 50`,
      [req.params.id]);
    logger.info('Returning customer · id=' + req.params.id + ' with ' + addresses.length + ' addresses');
    modernOk(res, { ...row, addresses });
  } catch (e) { next(e); }
});

/*
 * GET /admin/customers/by-mobile?mobile=9999999999
 *
 * Drives the legacy "Book New Call" mobile-first flow: operator types
 * the customer's mobile, the modal looks up whether a customer exists,
 * and either pre-fills their details + lists their addresses (existing
 * customer) or returns 404 so the caller knows to render fresh-customer
 * fields. Mirrors legacy `getCustomerDetailsForJob?mobileNo=X`.
 *
 * Response shape on hit: { customer_id, customer_name, customer_email,
 * customer_mob_no, is_active, addresses: [...] }.
 * On miss: 404 with `customer not found` so the frontend can branch
 * cleanly without parsing an empty-array payload.
 */
router.get('/by-mobile/lookup', async (req, res, next) => {
  try {
    const mobile = String(req.query.mobile || '').trim();
    logger.info('Lookup customer by mobile (Book New Call)');
    if (!/^[0-9]{10}$/.test(mobile)) {
      logger.warn('Customer mobile lookup rejected · mobile must be exactly 10 digits');
      return modernError(res, 400, 'mobile must be exactly 10 digits');
    }
    // Prefer ACTIVE rows but fall back to inactive ones if the only
    // match is deactivated — legacy CRM let an operator re-activate
    // by re-using the same mobile in the booking flow.
    const [rows] = await pool.query(
      `SELECT customer_id, customer_name, customer_mob_no, customer_email, is_active
         FROM tbl_customer
        WHERE customer_mob_no = ?
        ORDER BY is_active DESC, customer_id DESC
        LIMIT 1`,
      [mobile]
    );
    if (!rows.length) {
      logger.info('Customer mobile lookup miss · no existing customer');
      return modernError(res, 404, 'customer not found');
    }
    const customer = rows[0];
    // Real columns on tbl_address (verified against insertAddress in
    // services/job.service.js): address, building, landmark, locality,
    // city_id, pin_code, gps_location, mobile_number. Earlier I aliased
    // a non-existent `a.area` + wrong `a.pincode` — both fixed here.
    const [addresses] = await pool.query(
      `SELECT a.address_id, a.address, a.building, a.landmark, a.locality,
              a.city_id, a.pin_code, a.gps_location,
              c.city_name
         FROM tbl_address a
         LEFT JOIN tbl_city c ON c.city_id = a.city_id
        WHERE a.customer_id = ?
        ORDER BY a.address_id DESC
        LIMIT 50`,
      [customer.customer_id]
    );
    logger.info('Customer mobile lookup hit · id=' + customer.customer_id + ' with ' + addresses.length + ' addresses');
    return modernOk(res, { ...customer, addresses });
  } catch (e) { next(e); }
});

/*
 * PATCH /admin/customers/:id/addresses/:addrId
 *
 * Updates one tbl_address row in place. Used by the "Book New Call"
 * address picker's pencil-edit button — operator opens a small
 * inline form pre-filled with the saved address, edits, saves, and
 * the row updates without creating a duplicate.
 *
 * Same column whitelist + validation shape as `insertAddress()` in
 * services/job.service.js. We deliberately don't allow swapping
 * customer_id (that would silently transfer an address between
 * customers — instant data-integrity bug); the URL-path customer_id
 * is the authoritative owner check.
 *
 * gps_location is stored as "lat,lng" string per legacy convention.
 */
const addressEditBody = Joi.object({
  address:       Joi.string().min(1).max(1000).required(),
  building:      Joi.string().max(200).allow('', null).optional(),
  landmark:      Joi.string().max(200).allow('', null).optional(),
  locality:      Joi.string().max(200).allow('', null).optional(),
  city_id:       Joi.number().integer().positive().required(),
  pin_code:      Joi.string().pattern(/^[0-9]{6}$/).required(),
  gps_location:  Joi.string().max(100).allow('', null).optional(),
  mobile_number: Joi.string().pattern(/^[0-9]{10}$/).allow('', null).optional(),
});

router.patch('/:id/addresses/:addrId', validate(addressEditBody), async (req, res, next) => {
  try {
    const customerId = Number(req.params.id);
    const addrId = Number(req.params.addrId);
    logger.info('Update customer address · customerId=' + customerId + ' addrId=' + addrId);
    if (!Number.isInteger(customerId) || !Number.isInteger(addrId)) {
      logger.warn('Address update rejected · invalid id · customerId=' + req.params.id + ' addrId=' + req.params.addrId);
      return modernError(res, 400, 'invalid id');
    }
    // Ownership check — refuse to patch an address that belongs to a
    // different customer (could be an operator-side URL tamper or a
    // race condition with a deleted+recreated row).
    const [[addr]] = await pool.query(
      'SELECT address_id FROM tbl_address WHERE address_id = ? AND customer_id = ? LIMIT 1',
      [addrId, customerId]
    );
    if (!addr) {
      logger.warn('Address not found for customer · customerId=' + customerId + ' addrId=' + addrId);
      return modernError(res, 404, 'address not found for this customer');
    }

    const b = req.body;
    const [r] = await pool.query(
      `UPDATE tbl_address
          SET address = ?, building = ?, landmark = ?, locality = ?,
              city_id = ?, pin_code = ?, gps_location = ?, mobile_number = ?,
              update_date = NOW()
        WHERE address_id = ? AND customer_id = ?`,
      [
        b.address,
        b.building || null, b.landmark || null, b.locality || null,
        b.city_id, b.pin_code, b.gps_location || null,
        b.mobile_number || null,
        addrId, customerId,
      ]
    );
    if (r.affectedRows === 0) {
      logger.warn('Address update affected no rows · customerId=' + customerId + ' addrId=' + addrId);
      return modernError(res, 404, 'no rows updated');
    }

    // Return the fresh row (with city_name joined) so the caller can
    // patch its local state without a follow-up fetch.
    const [[row]] = await pool.query(
      `SELECT a.address_id, a.address, a.building, a.landmark, a.locality,
              a.city_id, a.pin_code, a.gps_location,
              c.city_name
         FROM tbl_address a
         LEFT JOIN tbl_city c ON c.city_id = a.city_id
        WHERE a.address_id = ?
        LIMIT 1`,
      [addrId]
    );
    logger.info('Customer address updated · customerId=' + customerId + ' addrId=' + addrId);
    modernOk(res, row);
  } catch (e) { next(e); }
});

/*
 * DELETE /admin/customers/:id/addresses/:addrId
 *
 * Hard-deletes a single tbl_address row for a customer. Used by the
 * "Book New Call" mobile-gate's address picker × delete button.
 *
 * Guardrails:
 *   - Address must belong to the supplied customer (defence against
 *     IDs from another customer being passed through).
 *   - If the address is referenced by any tbl_job (fk_address_id),
 *     refuse the delete — operator must reassign those jobs first.
 *     Hard-deleting an address with linked jobs would orphan their
 *     `fk_address_id` FK.
 */
router.delete('/:id/addresses/:addrId', async (req, res, next) => {
  try {
    const customerId = Number(req.params.id);
    const addrId = Number(req.params.addrId);
    logger.info('Delete customer address · customerId=' + customerId + ' addrId=' + addrId);
    if (!Number.isInteger(customerId) || !Number.isInteger(addrId)) {
      logger.warn('Address delete rejected · invalid id · customerId=' + req.params.id + ' addrId=' + req.params.addrId);
      return modernError(res, 400, 'invalid id');
    }
    // Ensure address belongs to this customer.
    const [[addr]] = await pool.query(
      'SELECT address_id FROM tbl_address WHERE address_id = ? AND customer_id = ? LIMIT 1',
      [addrId, customerId]
    );
    if (!addr) {
      logger.warn('Address not found for customer · customerId=' + customerId + ' addrId=' + addrId);
      return modernError(res, 404, 'address not found for this customer');
    }
    // FK guard — if any job references this address, refuse.
    const [[{ refCount }]] = await pool.query(
      'SELECT COUNT(*) AS refCount FROM tbl_job WHERE fk_address_id = ?',
      [addrId]
    );
    if (refCount > 0) {
      logger.warn('Address delete blocked · referenced by ' + refCount + ' jobs · addrId=' + addrId);
      return modernError(
        res,
        409,
        `address is referenced by ${refCount} job${refCount === 1 ? '' : 's'} — reassign those before deleting`
      );
    }
    await pool.query('DELETE FROM tbl_address WHERE address_id = ?', [addrId]);
    logger.info('Customer address deleted · customerId=' + customerId + ' addrId=' + addrId);
    modernOk(res, { deleted: true });
  } catch (e) { next(e); }
});

module.exports = router;
