/*
 * Admin bulk-job-upload sub-router.
 *
 * All Express/multer/exceljs plumbing + the canonical template + the
 * /upload handler live in utils/jobs-upload-router.js. This file only
 * declares the admin-specific resolvers:
 *
 *   resolveClientId: comes from the form's client picker (req.body.clientId).
 *   resolveActor:    req.user (the authenticated CRM staff user).
 *
 * The matching client SPOC counterpart is routes/client/jobs-upload.js.
 */
const { createJobsUploadRouter } = require('../../utils/jobs-upload-router');
const logger = require('../../logger');

module.exports = createJobsUploadRouter({
  resolveClientId(req) {
    const id = Number(req.body.clientId);
    if (!Number.isInteger(id) || id <= 0) {
      logger.warn('Bulk job upload rejected · invalid clientId=' + req.body.clientId);
      throw Object.assign(
        new Error('clientId is required — pick a client on the upload form'),
        { status: 400 }
      );
    }
    logger.info('Resolved bulk job upload client · clientId=' + id);
    return id;
  },
  resolveActor(req) {
    return req.user;
  },
});
