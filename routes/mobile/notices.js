const router = require('express').Router();
const makeNoticeReader = require('../../utils/notice-reader-router');

/*
 * /api/mobile/notices/* — Notice consumption for the Technician App.
 *
 * Implementation is ZERO duplication: the shared factory in
 * `utils/notice-reader-router.js` exposes `GET /active` and
 * `POST /:noticeId/mark-read`. We just supply the actor-resolution
 * hook telling the factory who's reading.
 *
 * Auth: requireTechAuth is applied upstream in routes/mobile/index.js
 * via `router.use(requireTechAuth)` before this router is mounted —
 * so by the time a request lands here, `req.tech` is populated.
 *
 * Same handlers + same SQL as `/api/admin/notices/{active,mark-read}` —
 * the only difference is the resolved actor:
 *   - CRM:        { surface: 'crm',        type: 'crm_user', id: req.user.user_id }
 *   - Technician: { surface: 'technician', type: 'efr',      id: req.tech.efr_id }   ← this file
 *   - Client:     { surface: 'client',     type: 'client',   id: req.client.contact_id } (Phase 4)
 */
router.use(makeNoticeReader((req) => ({
  surface: 'technician',
  type:    'efr',
  id:      req.tech?.efr_id,
})));

module.exports = router;
