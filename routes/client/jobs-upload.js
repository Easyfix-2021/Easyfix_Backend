/*
 * Client SPOC bulk-job-upload sub-router.
 *
 * All Express/multer/exceljs plumbing + the canonical template + the
 * /upload handler live in utils/jobs-upload-router.js. This file only
 * declares the SPOC-specific resolvers:
 *
 *   resolveClientId: forced to req.spoc.client_id — a SPOC can ONLY
 *                    upload jobs for their own tenant. Any body field
 *                    is intentionally ignored (security boundary).
 *   resolveActor:    { user_id: null } — SPOCs live in tbl_client_contacts,
 *                    not tbl_user. Same convention used by the existing
 *                    routes/client/index.js job-create handler.
 *
 * The matching admin counterpart is routes/admin/jobs-upload.js.
 */
const { createJobsUploadRouter } = require('../../utils/jobs-upload-router');
const logger = require('../../logger');

module.exports = createJobsUploadRouter({
  resolveClientId(req) {
    const id = req.spoc?.client_id;
    if (!Number.isInteger(id) || id <= 0) {
      logger.warn('SPOC bulk-upload blocked · missing client_id');
      throw Object.assign(
        new Error('SPOC has no associated client_id — re-authenticate'),
        { status: 401 }
      );
    }
    logger.info('SPOC bulk-job-upload scoped · clientId=' + id);
    return id;
  },
  resolveActor() {
    return { user_id: null };
  },
});
