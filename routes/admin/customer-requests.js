const router = require('express').Router();
const Joi = require('joi');

const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');
const validate = require('../../middleware/validate');
const logger = require('../../logger');

/*
 * Customer cancel / reschedule request ops inbox.
 *
 * Mounted at /api/admin/customer-requests under the admin route group, so
 * requireAuth + role(['admin']) + scope attach + maskMobile all apply from
 * routes/admin/index.js. These are GLOBAL inbox endpoints (NOT job-scoped) —
 * the per-job view lives at /api/admin/jobs/:id/customer-requests.
 *
 * Source: tbl_job_customer_request (EasyFix-owned, migration
 * 2026-06-02-job-customer-requests.sql). Rows are written by the public
 * magic-link page; a row is an OPS SIGNAL only — it never mutates job_status.
 * `request_status` tracks the ops workflow: pending → actioned | dismissed.
 *
 * Parameterised SQL throughout; modern {success,data,error} envelope.
 */

// GET /api/admin/customer-requests?status=pending&limit=50&offset=0
const inboxQuery = Joi.object({
  status: Joi.string().valid('pending', 'actioned', 'dismissed').default('pending'),
  limit:  Joi.number().integer().min(1).max(200).default(50),
  offset: Joi.number().integer().min(0).default(0),
});

router.get('/', validate(inboxQuery, 'query'), async (req, res, next) => {
  try {
    const { status, limit, offset } = req.query;
    logger.info('List customer cancel/reschedule requests · status=' + status + ' limit=' + limit + ' offset=' + offset);

    const [[{ total }]] = await pool.query(
      'SELECT COUNT(*) AS total FROM tbl_job_customer_request WHERE request_status = ?',
      [status],
    );

    const [items] = await pool.query(
      `SELECT r.request_id, r.job_id, r.request_type, r.reason, r.remarks,
              r.preferred_datetime, r.request_status, r.created_at,
              COALESCE(j.job_customer_name, cu.customer_name) AS customer_name,
              cl.client_name
         FROM tbl_job_customer_request r
         LEFT JOIN tbl_job      j  ON j.job_id      = r.job_id
         LEFT JOIN tbl_customer cu ON cu.customer_id = j.fk_customer_id
         LEFT JOIN tbl_client   cl ON cl.client_id   = j.fk_client_id
        WHERE r.request_status = ?
        ORDER BY r.created_at DESC
        LIMIT ? OFFSET ?`,
      [status, limit, offset],
    );

    logger.info('Returning ' + items.length + ' customer requests · total=' + total);
    modernOk(res, { items, total });
  } catch (e) { next(e); }
});

// PATCH /api/admin/customer-requests/:id  { request_status: 'actioned'|'dismissed' }
const idParam = Joi.object({
  id: Joi.number().integer().positive().required(),
});
const patchBody = Joi.object({
  request_status: Joi.string().valid('actioned', 'dismissed').required(),
});

router.patch('/:id', validate(idParam, 'params'), validate(patchBody), async (req, res, next) => {
  try {
    logger.info('Update customer request status · id=' + Number(req.params.id) + ' request_status=' + req.body.request_status);
    const [result] = await pool.query(
      'UPDATE tbl_job_customer_request SET request_status = ? WHERE request_id = ?',
      [req.body.request_status, Number(req.params.id)],
    );
    if (!result || result.affectedRows === 0) {
      logger.warn('Customer request not found · id=' + Number(req.params.id));
      return modernError(res, 404, 'Customer request not found');
    }
    logger.info('Customer request updated · id=' + Number(req.params.id) + ' request_status=' + req.body.request_status);
    modernOk(res, { updated: true });
  } catch (e) { next(e); }
});

module.exports = router;
