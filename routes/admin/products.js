const router = require('express').Router();
const Joi = require('joi');
const validate = require('../../middleware/validate');
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');

/*
 * Client product catalog CRUD. A "product" is a SKU offered for a
 * specific client_service (e.g. a particular refrigerator model that a
 * client like Decathlon ships for installation).
 *
 * VERIFIED 2026-05-12 against legacy EasyFix_CRM ProductDaoImpl.java:
 *   product            (id, name, created_on, service_id, primary_img_id)
 *   product_code       (product_id, code)
 *   product_additional_image (product_id, document_id)
 *   document           (id, url, file_name)  — image registry
 *
 * Notable: legacy `product` table has NO `tbl_` prefix — predates the
 * naming convention. Preserve it.
 *
 * ⚠ LIVE-DB CHECK 2026-05-12: these tables do NOT exist in the
 * production `easyfix` schema. The legacy DAO referenced them but
 * they were never created. Until the migrations land
 * (`migrations/202X-create-product-tables.sql`), every endpoint here
 * fails with ER_NO_SUCH_TABLE — which is the correct, loud behaviour.
 * We deliberately do NOT swallow that error: ops needs to see the
 * failure if anyone tries to use this feature before migrations run.
 */

router.get('/', async (req, res, next) => {
  try {
    const serviceId = req.query.serviceId ? Number(req.query.serviceId) : null;
    logger.info('List products · serviceId=' + serviceId);
    if (!serviceId) return modernError(res, 400, 'serviceId required');
    const [rows] = await pool.query(
      `SELECT p.id, p.name, p.created_on, p.service_id, p.primary_img_id,
              st.service_type_name, sc.service_catg_name,
              doc.id AS doc_id, doc.url AS image_url, doc.file_name AS image_filename
         FROM product p
         LEFT JOIN tbl_client_service cs ON cs.client_service_id = p.service_id
         LEFT JOIN tbl_service_type   st ON st.service_type_id    = cs.service_type_id
         LEFT JOIN tbl_service_catg   sc ON sc.service_catg_id    = st.service_catg_id
         LEFT JOIN document           doc ON doc.id = p.primary_img_id
        WHERE p.service_id = ?
        ORDER BY p.id DESC`,
      [serviceId]
    );
    logger.info('Found ' + rows.length + ' products');

    // Eager-load codes per product (avoid N+1)
    const ids = rows.map((r) => r.id);
    const codesByProduct = new Map();
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const [codes] = await pool.query(
        `SELECT product_id, code FROM product_code WHERE product_id IN (${placeholders})`,
        ids
      );
      for (const c of codes) {
        if (!codesByProduct.has(c.product_id)) codesByProduct.set(c.product_id, []);
        codesByProduct.get(c.product_id).push(c.code);
      }
    }
    modernOk(res, rows.map((r) => ({ ...r, product_codes: codesByProduct.get(r.id) || [] })));
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    logger.info('Get product · id=' + req.params.id);
    const [[p]] = await pool.query(
      `SELECT p.id, p.name, p.created_on, p.service_id, p.primary_img_id,
              st.service_type_name, sc.service_catg_name,
              doc.url AS image_url, doc.file_name AS image_filename
         FROM product p
         LEFT JOIN tbl_client_service cs ON cs.client_service_id = p.service_id
         LEFT JOIN tbl_service_type   st ON st.service_type_id    = cs.service_type_id
         LEFT JOIN tbl_service_catg   sc ON sc.service_catg_id    = st.service_catg_id
         LEFT JOIN document           doc ON doc.id = p.primary_img_id
        WHERE p.id = ?`,
      [req.params.id]
    );
    if (!p) return modernError(res, 404, 'product not found');

    const [codes] = await pool.query(
      'SELECT code FROM product_code WHERE product_id = ?',
      [req.params.id]
    );
    const [imgs] = await pool.query(
      `SELECT pai.document_id, doc.url, doc.file_name
         FROM product_additional_image pai
         LEFT JOIN document doc ON doc.id = pai.document_id
        WHERE pai.product_id = ?`,
      [req.params.id]
    );
    modernOk(res, {
      ...p,
      product_codes: codes.map((c) => c.code),
      additional_images: imgs,
    });
  } catch (e) { next(e); }
});

const createBody = Joi.object({
  name: Joi.string().trim().min(1).max(255).required(),
  service_id: Joi.number().integer().positive().required(),
  primary_img_id: Joi.number().integer().min(0).default(0),
  product_codes: Joi.array().items(Joi.string().trim().min(1).max(100)).default([]),
  additional_image_ids: Joi.array().items(Joi.number().integer().positive()).default([]),
});

router.post('/', validate(createBody), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    logger.info('Create product · service_id=' + req.body.service_id + ' codes=' + req.body.product_codes.length);
    await conn.beginTransaction();
    const [ins] = await conn.query(
      'INSERT INTO product (name, created_on, service_id, primary_img_id) VALUES (?, NOW(), ?, ?)',
      [req.body.name, req.body.service_id, req.body.primary_img_id]
    );
    const productId = ins.insertId;
    for (const code of req.body.product_codes) {
      await conn.query('INSERT INTO product_code (product_id, code) VALUES (?, ?)', [productId, code]);
    }
    for (const imgId of req.body.additional_image_ids) {
      await conn.query('INSERT INTO product_additional_image (product_id, document_id) VALUES (?, ?)',
        [productId, imgId]);
    }
    await conn.commit();
    logger.info('Product created · id=' + productId);
    res.status(201);
    modernOk(res, { id: productId }, 'product created');
  } catch (e) { await conn.rollback(); logger.error('Create product failed · ' + e.message); next(e); } finally { conn.release(); }
});

router.patch('/:id', validate(Joi.object({
  name: Joi.string().trim().min(1).max(255).optional(),
  service_id: Joi.number().integer().positive().optional(),
  primary_img_id: Joi.number().integer().min(0).optional(),
  product_codes: Joi.array().items(Joi.string().trim().min(1).max(100)).optional(),
  additional_image_ids: Joi.array().items(Joi.number().integer().positive()).optional(),
}).min(1)), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    logger.info('Update product · id=' + req.params.id + ' fields=' + Object.keys(req.body).join(','));
    await conn.beginTransaction();
    const sets = [], vals = [];
    if (req.body.name)            { sets.push('name = ?');           vals.push(req.body.name); }
    if (req.body.service_id)      { sets.push('service_id = ?');     vals.push(req.body.service_id); }
    if (req.body.primary_img_id !== undefined) { sets.push('primary_img_id = ?'); vals.push(req.body.primary_img_id); }
    if (sets.length > 0) {
      vals.push(req.params.id);
      const [r] = await conn.query(`UPDATE product SET ${sets.join(', ')} WHERE id = ?`, vals);
      if (r.affectedRows === 0) { await conn.rollback(); return modernError(res, 404, 'product not found'); }
    }
    if (req.body.product_codes) {
      // Legacy replaces all codes on update
      await conn.query('DELETE FROM product_code WHERE product_id = ?', [req.params.id]);
      for (const code of req.body.product_codes) {
        await conn.query('INSERT INTO product_code (product_id, code) VALUES (?, ?)', [req.params.id, code]);
      }
    }
    if (req.body.additional_image_ids) {
      await conn.query('DELETE FROM product_additional_image WHERE product_id = ?', [req.params.id]);
      for (const imgId of req.body.additional_image_ids) {
        await conn.query('INSERT INTO product_additional_image (product_id, document_id) VALUES (?, ?)',
          [req.params.id, imgId]);
      }
    }
    await conn.commit();
    logger.info('Product updated · id=' + req.params.id);
    modernOk(res, { updated: true });
  } catch (e) { await conn.rollback(); logger.error('Update product failed · id=' + req.params.id + ' · ' + e.message); next(e); } finally { conn.release(); }
});

router.delete('/:id', async (req, res, next) => {
  // Legacy has no soft-delete column on `product`; the safest delete is
  // to cascade child rows in one transaction. Codes + additional images
  // are FK children with no audit value beyond the parent row.
  const conn = await pool.getConnection();
  try {
    logger.info('Delete product · id=' + req.params.id);
    await conn.beginTransaction();
    await conn.query('DELETE FROM product_code WHERE product_id = ?', [req.params.id]);
    await conn.query('DELETE FROM product_additional_image WHERE product_id = ?', [req.params.id]);
    const [r] = await conn.query('DELETE FROM product WHERE id = ?', [req.params.id]);
    if (r.affectedRows === 0) { await conn.rollback(); return modernError(res, 404, 'product not found'); }
    await conn.commit();
    logger.info('Product deleted · id=' + req.params.id);
    modernOk(res, { deleted: true });
  } catch (e) { await conn.rollback(); logger.error('Delete product failed · id=' + req.params.id + ' · ' + e.message); next(e); } finally { conn.release(); }
});

module.exports = router;
