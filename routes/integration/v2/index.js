const router = require('express').Router();
const multer = require('multer');

const basicAuth = require('../../../middleware/basic-auth');
const { pool } = require('../../../db');
const jobService = require('../../../services/job.service');
const { legacyError } = require('../../../utils/response');
const {
  parseLegacyDate, resolveCityId, paymentCollectedByCode, legacyJobEntity,
} = require('../../../services/integration.service');
const { writeBuffer } = require('../../../utils/file-storage');
const logger = require('../../../logger');

/*
 * ═══════════════════════════════════════════════════════════════════════
 * /api/integration/v2 — one request to book a job WITH its photographs
 * ═══════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS
 *
 * On v1, a partner with three photographs makes FOUR calls: three multipart
 * uploads to /v1/jobImage/addJobImages, collecting an imageId from each, then
 * POST /v1/jobs carrying those ids in jobImageIds. Each upload is its own
 * round trip, its own auth lookup and its own INSERT, and the job does not
 * exist until the last one lands — so a partner whose second upload fails is
 * left holding orphan rows and no job.
 *
 * v2 collapses that to one request. Same field mapping, same response body,
 * same auth. The only difference is the envelope.
 *
 * V1 IS UNTOUCHED AND STAYS THAT WAY. Every existing integration keeps
 * working with no change on their side; v2 is opt-in for whoever wants it.
 *
 * ─── WHY MULTIPART RATHER THAN BASE64 IN JSON ────────────────────────────
 *
 * Repeating a multipart part name is how HTML file inputs have always posted
 * multiple files, so every HTTP client and every language's standard library
 * already does it — nothing to hand-roll. Base64-in-JSON would inflate every
 * image by ~33% on the wire and force the whole payload to be buffered as a
 * string before a single field could be validated. The public
 * website-booking route does accept base64 (it is called from a browser with
 * a 25MB body cap for exactly that reason); a server-to-server partner API
 * has no such constraint and should not pay that tax.
 *
 * A partner with NO photographs can skip multipart entirely and POST plain
 * JSON — see the content-type branch below.
 */

const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/*
 * `upload.array('images', MAX_IMAGES)` — the part name repeats, once per
 * file, and multer collects them into req.files IN ORDER. Exceeding the count
 * raises LIMIT_UNEXPECTED_FILE, which the error branch below turns into a
 * plain 400 rather than multer's own opaque message.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES },
});

router.use(basicAuth);

/*
 * Multer only where the request actually is multipart. Running it over a JSON
 * body would consume the stream and leave req.body empty, so the no-images
 * JSON path has to bypass it entirely.
 */
function acceptImages(req, res, next) {
  const ct = String(req.headers['content-type'] || '');
  if (!ct.toLowerCase().includes('multipart/form-data')) return next();
  return upload.array('images', MAX_IMAGES)(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
      return legacyError(res, 400, `At most ${MAX_IMAGES} images may be attached to one job`);
    }
    if (err.code === 'LIMIT_FILE_SIZE') {
      return legacyError(res, 400, `Each image must be ${MAX_IMAGE_BYTES / (1024 * 1024)}MB or smaller`);
    }
    return legacyError(res, 400, err.message || 'Invalid multipart request');
  });
}

/*
 * The job payload arrives as a `payload` part holding JSON (multipart), or as
 * the whole body (plain JSON, no images). Accepting `job` as an alias because
 * it is the name a partner is equally likely to reach for, and a 400 over a
 * field name is a support ticket nobody needs.
 */
function readPayload(req) {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('multipart/form-data')) {
    return { payload: req.body || {}, error: null };
  }
  const raw = req.body?.payload ?? req.body?.job;
  if (raw === undefined || raw === null || raw === '') {
    return { payload: null, error: 'A `payload` part containing the job JSON is required' };
  }
  if (typeof raw === 'object') return { payload: raw, error: null };
  try {
    return { payload: JSON.parse(raw), error: null };
  } catch (e) {
    return { payload: null, error: 'The `payload` part is not valid JSON: ' + e.message };
  }
}

// ─── POST /v2/jobs — create a job and attach its images in one request ──
router.post('/jobs', acceptImages, async (req, res, next) => {
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    const { payload, error } = readPayload(req);
    if (error) return legacyError(res, 400, error);

    const b = payload || {};
    const customer = b.customer || {};
    const addr = b.address || {};
    const serviceIds = b.service_type?.services?.map((s) => Number(s.service_id)) || [];

    logger.info('Integration v2: create job · ref=' + (b.reference_id || '-')
      + ' · type=' + (b.jobType || 'Installation')
      + ' · services=' + serviceIds.length + ' · images=' + files.length);

    const reqDt = parseLegacyDate(b.requested_date);
    const { cityId, unknownName } = await resolveCityId(pool, addr.city);
    if (unknownName) {
      logger.warn('Integration v2: job created with UNRESOLVED city · "' + unknownName + '"');
    }

    /*
     * Field mapping is intentionally identical to v1's POST /jobs. v2 changes
     * the envelope, never the semantics — a partner moving from v1 to v2 must
     * not have to re-learn what any field does.
     */
    const created = await jobService.create({
      fk_client_id: req.integrationClient.id,
      job_desc: b.jobDesc,
      job_type: b.jobType || 'Installation',
      source_type: b.sourceType || 'integration_v2',
      requested_date_time: reqDt,
      time_slot: b.timeSlot,
      client_ref_id: b.reference_id,
      client_spoc_name: b.clientSpocName,
      client_spoc_email: b.clientSpocEmail,
      client_spoc: b.clientSpocNumber,
      additional_name: b.additionalName,
      additional_number: b.additionalNumber,
      helper_req: !!b.helperReq,
      efr_special_notes: b.specialComments,
      booking_cut_off_time_slot: b.bookingCutOffTime != null ? String(b.bookingCutOffTime) : undefined,
      collected_by: paymentCollectedByCode(b.paymentCollectedBy),
      service_type_ids: serviceIds.join(','),
      customer: {
        customer_name: customer.name,
        customer_mob_no: customer.mobile,
        customer_email: customer.email,
      },
      address: {
        address: addr.address,
        building: addr.building,
        city_id: cityId,
        pin_code: addr.pinCode,
        gps_location: addr.gps,
      },
      services: serviceIds.map((id) => ({ service_id: id, quantity: 1 })),
    }, { user_id: null });

    if (b.paidBy != null && b.paidBy !== '') {
      await pool.query('UPDATE tbl_job SET paid_by = ? WHERE job_id = ?', [Number(b.paidBy), created.job_id]);
    }

    /*
     * Images are attached AFTER the job exists, in ONE batched INSERT rather
     * than v1's insert-per-upload.
     *
     * A failure here does NOT fail the request. The job is already committed
     * and the partner needs to know its id — telling them "500" would leave
     * them re-posting a job that already exists, which is far worse than a
     * missing photograph. Per-image outcomes are reported in the response so
     * a partner can retry just the ones that did not land, via v1's
     * /jobImage/addJobImages against the job id they now hold.
     */
    const images = [];
    if (files.length) {
      const rows = [];
      for (const f of files) {
        try {
          const saved = writeBuffer('job_files', f.buffer, f.originalname, f.mimetype);
          rows.push([created.job_id, saved.filename, req.integrationClient.id, req.integrationClient.id]);
          images.push({ image: saved.filename, originalName: f.originalname, status: 'attached' });
        } catch (e) {
          logger.warn('Integration v2: image store failed · ' + (f.originalname || '?') + ' · ' + e.message);
          images.push({ originalName: f.originalname, status: 'failed', reason: 'could not be stored' });
        }
      }
      if (rows.length) {
        try {
          const [ins] = await pool.query(
            `INSERT INTO tbl_job_image (job_id, image, image_category, job_stage, status, created_by, updated_by, created_date)
             VALUES ${rows.map(() => "(?, ?, 'unconfirmed', 0, 1, ?, ?, NOW())").join(', ')}`,
            rows.flat(),
          );
          // mysql2 returns the FIRST id of a multi-row insert; the rest follow
          // sequentially, which is what lets us report an id per image.
          let id = ins.insertId;
          for (const img of images) {
            if (img.status === 'attached') { img.imageId = id; id += 1; }
          }
        } catch (e) {
          logger.error('Integration v2: image rows failed for job ' + created.job_id + ' · ' + e.message);
          for (const img of images) {
            if (img.status === 'attached') { img.status = 'failed'; img.reason = 'could not be linked'; }
          }
        }
      }
    }

    logger.info('Integration v2: job created · id=' + created.job_id
      + ' · images attached=' + images.filter((i) => i.status === 'attached').length + '/' + files.length);

    const persisted = await jobService.getById(created.job_id);
    res.setHeader('Location', `${req.baseUrl}/jobs/${created.job_id}`);
    // Same body as v1's create, plus the per-image outcomes. A v1 client
    // moving across can keep reading `id` exactly as it does today.
    res.status(201).json({ ...legacyJobEntity(persisted), images });
  } catch (e) {
    if (e.status) {
      logger.warn('Integration v2: create job rejected · ' + e.message);
      return legacyError(res, e.status, e.message);
    }
    return next(e);
  }
});

module.exports = router;
