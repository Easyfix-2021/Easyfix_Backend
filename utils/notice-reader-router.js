/*
 * Notice-reader router factory — shared between every consumer tier.
 *
 * Purpose:
 *   The active-feed read (`GET /active`) + mark-as-read mutation
 *   (`POST /:noticeId/mark-read`) are conceptually identical for CRM
 *   staff, technicians, and client SPOCs — only the "who is reading"
 *   differs:
 *
 *     CRM:        { surface: 'crm',        type: 'crm_user', id: req.user.user_id }
 *     Technician: { surface: 'technician', type: 'efr',      id: req.tech.efr_id }
 *     Client:     { surface: 'client',     type: 'client',   id: req.client.contact_id }
 *
 *   This factory captures the shared handlers ONCE; each tier file
 *   becomes a 10-line wrapper that supplies its actor-resolution hook.
 *   Per the no-route-duplication rule (memory: `feedback_easyfix_no_route_duplication`).
 *
 * Usage:
 *
 *   // routes/admin/notices.js
 *   const makeNoticeReader = require('../../utils/notice-reader-router');
 *   router.use(makeNoticeReader((req) => ({
 *     surface: 'crm', type: 'crm_user', id: req.user.user_id,
 *   })));
 *
 *   // routes/mobile/notices.js
 *   router.use(makeNoticeReader((req) => ({
 *     surface: 'technician', type: 'efr', id: req.tech.efr_id,
 *   })));
 *
 * Anything that touches the active-feed SQL, the read-receipt write,
 * or the response shape lives in `services/notice.service.js` — the
 * factory is purely a route-declaration adapter.
 */

const { Router } = require('express');
const validate = require('../middleware/validate');
const svc = require('../services/notice.service');
const { modernOk, modernError } = require('./response');
const { noticeIdParam, noticeMarkReadBody } = require('../validators/notice.validator');

module.exports = function makeNoticeReader(resolveReader) {
  if (typeof resolveReader !== 'function') {
    throw new Error('makeNoticeReader: resolveReader must be a function');
  }
  const router = Router({ mergeParams: true });

  /*
   * GET /active?limit=N
   *
   * Returns active notices targeted to the resolved surface. Sorted
   * pinned-first, then newest. Each row carries:
   *   - image_keys: raw stored S3 keys (round-trip on edit, not used by app)
   *   - images:     presigned URLs (5-min TTL) ready for direct rendering
   *   - is_read:    per-caller read-receipt flag
   */
  router.get('/active', async (req, res, next) => {
    try {
      const reader = resolveReader(req);
      if (!reader || !reader.surface || !reader.type || reader.id == null) {
        return modernError(res, 400, 'resolveReader returned an incomplete actor');
      }
      const items = await svc.listActiveForSurface({
        surface:    reader.surface,
        readerType: reader.type,
        readerId:   reader.id,
        limit:      Math.min(Math.max(Number(req.query.limit) || 20, 1), 50),
      });
      modernOk(res, { items });
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  });

  /*
   * POST /:noticeId/mark-read   { surface?: 'crm'|'client'|'technician' }
   *
   * Idempotent upsert into tbl_notice_read keyed by (notice_id, surface,
   * reader_type, reader_id). `surface` in the body is optional —
   * defaults to the resolver's surface (which is the correct value
   * almost always; the param is here only to support unusual cases
   * like a CRM admin marking a notice read on behalf of a tech).
   */
  router.post(
    '/:noticeId/mark-read',
    validate(noticeIdParam, 'params'),
    validate(noticeMarkReadBody),
    async (req, res, next) => {
      try {
        const reader = resolveReader(req);
        if (!reader || !reader.surface || !reader.type || reader.id == null) {
          return modernError(res, 400, 'resolveReader returned an incomplete actor');
        }
        await svc.markRead({
          noticeId:   Number(req.params.noticeId),
          surface:    req.body.surface || reader.surface,
          readerType: reader.type,
          readerId:   reader.id,
        });
        modernOk(res, { ok: true });
      } catch (e) {
        if (e.status) return modernError(res, e.status, e.message);
        next(e);
      }
    },
  );

  return router;
};
