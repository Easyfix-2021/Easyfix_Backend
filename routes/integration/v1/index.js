const router = require('express').Router();
const multer = require('multer');

const basicAuth = require('../../../middleware/basic-auth');
const { pool } = require('../../../db');
const lookupService = require('../../../services/lookup.service');
const jobService = require('../../../services/job.service');
const { legacyOk, legacyError } = require('../../../utils/response');
const {
  statusLabel,
  parseLegacyDate,
  formatLegacyDate,
  checkFirefoxAvailability,
  checkDecathlonServiceability,
  clientServiceCatalog,
  catalogShapeForRole,
  resolveCityId,
  paymentCollectedByCode,
  jobUiStatus,
  legacyJobEntity,
} = require('../../../services/integration.service');
const { writeBuffer } = require('../../../utils/file-storage');
const logger = require('../../../logger');

// All /v1/* routes require HTTP Basic Auth against tbl_client_website
router.use(basicAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ─── /v1/services — the client's own priced service catalogue ───────
// The `service_id` values in the response are what POST /v1/jobs expects
// back in `service_type.services[]`, so this endpoint is the entry point
// for the whole integration: without it a client cannot book anything.
router.get('/services', async (req, res, next) => {
  try {
    // Shape follows the caller's legacy role — see catalogShapeForRole. Logged
    // because a partner reporting "the response changed" is answered by this
    // line alone.
    const shape = catalogShapeForRole(req.integrationClient.role);
    logger.info('Integration: fetch service catalog · clientId=' + req.integrationClient.id
      + ' · role=' + (req.integrationClient.role || 'unresolved') + ' · shape=' + shape);
    const data = await clientServiceCatalog(pool, {
      clientId: req.integrationClient.id,
      serviceTypeId: req.query.serviceTypeId,
      shape,
    });
    logger.info('Returning ' + data.length + (shape === 'tree' ? ' service categories' : ' service types'));
    legacyOk(res, data);
  } catch (e) { next(e); }
});

// ─── /v1/cities — Active cities ─────────────────────────────────────
router.get('/cities', async (req, res, next) => {
  try {
    logger.info('Integration: fetch active cities');
    const cities = await lookupService.cities({ limit: 1000 });
    logger.info('Found ' + cities.length + ' cities');
    legacyOk(res, cities.map((c) => ({
      city_id: c.city_id, city_name: c.city_name, state_id: c.state_id,
    })));
  } catch (e) { next(e); }
});

router.get('/serviceType', async (req, res, next) => {
  try {
    logger.info('Integration: fetch service-types');
    legacyOk(res, await lookupService.serviceTypes());
  } catch (e) { next(e); }
});

// ─── /v1/jobs — CREATE ───────────────────────────────────────────────
/*
 * ONE handler, two paths. Legacy exposed these as separate methods with
 * DIFFERENT response shapes — /jobs returned the bare entity, /jobs/newJob
 * returned the {status,message,data} envelope. Serving the /jobs shape from
 * both is a deliberate choice: a partner then parses one contract whichever
 * path they call, and can migrate between them without touching their parser.
 *
 * The trade is that existing /jobs/newJob callers see a changed body — the
 * only shape change anywhere in this API — which the client guide calls out.
 */
router.post(['/jobs', '/jobs/newJob'], async (req, res, next) => {
  try {
    const b = req.body || {};
    // Customer + address are inline on the legacy contract
    const customer = b.customer || {};
    const addr = b.address || {};
    const serviceIds = b.service_type?.services?.map((s) => Number(s.service_id)) || [];
    logger.info('Integration: create job · ref=' + (b.reference_id || '-') + ' type=' + (b.jobType || 'Installation') + ' services=' + serviceIds.length);

    // Convert requested_date from "DD-MM-YYYY HH:mm" to JS Date
    const reqDt = parseLegacyDate(b.requested_date);

    /*
     * Clients send the city by NAME ("Gurgaon"); city_id is the exception.
     *
     * An unrecognised name is NOT an error: legacy stored a NULL city_id and
     * created the job anyway, so rejecting it here would fail requests the
     * old service accepted. Logged loudly instead — the job is bookable but
     * harder to route, and ops should see that.
     */
    const { cityId, unknownName } = await resolveCityId(pool, addr.city);
    if (unknownName) {
      logger.warn('Integration: job created with UNRESOLVED city · "' + unknownName + '" · client=' + req.integrationClient.id);
    }

    const created = await jobService.create({
      fk_client_id: req.integrationClient.id,
      job_desc: b.jobDesc,
      job_type: b.jobType || 'Installation',
      source_type: b.sourceType || 'integration',
      requested_date_time: reqDt,
      time_slot: b.timeSlot,
      client_ref_id: b.reference_id,
      client_spoc_name: b.clientSpocName,
      client_spoc_email: b.clientSpocEmail,
      client_spoc: b.clientSpocNumber,
      additional_name: b.additionalName,
      additional_number: b.additionalNumber,
      helper_req: !!b.helperReq,
      // Technician-facing note. Legacy mapped `specialComments` onto
      // tbl_job.efr_special_notes — NOT onto job_desc.
      efr_special_notes: b.specialComments,
      // Legacy stored the raw integer; `bookingCutOffTime: 12` means noon.
      booking_cut_off_time_slot: b.bookingCutOffTime != null ? String(b.bookingCutOffTime) : undefined,
      // "Any" | "Serviceman" | "Easyfix" | "Client" → 0..3
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
      /*
       * Quantity 1 per line, and NO price from the request. Legacy copied the
       * caller's `service_amount` / `job_charge_type` straight into
       * tbl_job_services, so the documented payload (service_id only) booked
       * every job at zero and let a client invent its own price. create()
       * prices from the client's rate card instead — same service_id in,
       * correct money out.
       */
      services: serviceIds.map((id) => ({ service_id: id, quantity: 1 })),
    }, { user_id: null });

    /*
     * paid_by is not a create() input — it is meaningful only on this legacy
     * contract, so it is stamped here rather than widening the shared job
     * creation path for every caller. Same enum as collected_by.
     */
    if (b.paidBy != null && b.paidBy !== '') {
      await pool.query('UPDATE tbl_job SET paid_by = ? WHERE job_id = ?', [Number(b.paidBy), created.job_id]);
    }

    /*
     * jobImageIds — images uploaded BEFORE the job existed (the documented
     * two-step flow) are adopted here. Scoped to this client's own orphan
     * images: legacy did no ownership check at all, so any integrator who
     * guessed an id could attach another client's photograph to their job.
     */
    const imageIds = (Array.isArray(b.jobImageIds) ? b.jobImageIds : []).map(Number).filter(Boolean);
    if (imageIds.length) {
      const [adopted] = await pool.query(
        `UPDATE tbl_job_image
            SET job_id = ?, updated_by = ?, updated_date = NOW()
          WHERE image_id IN (?) AND job_id IS NULL AND created_by = ?`,
        [created.job_id, req.integrationClient.id, imageIds, req.integrationClient.id]
      );
      logger.info('Integration: adopted ' + adopted.affectedRows + '/' + imageIds.length + ' pre-uploaded images');
    }

    logger.info('Integration: job created · id=' + created.job_id + ' ref=' + (created.client_ref_id || '-'));

    /*
     * 201 + the bare job entity + a Location header — NOT the {status,message,
     * data} envelope its sibling endpoints use. That asymmetry is the legacy
     * contract (JobsResource.java:155-167): clients read `id` off the top
     * level, so wrapping it would break every existing integration.
     *
     * Re-read rather than reshaping `created`: the entity carries the resolved
     * customer id, city name and the server-derived requested_time, none of
     * which the create call returns.
     */
    const persisted = await jobService.getById(created.job_id);
    res.setHeader('Location', `${req.baseUrl}${req.path.replace(/\/$/, '')}/${created.job_id}`);
    res.status(201).json(legacyJobEntity(persisted));
  } catch (e) {
    if (e.status) {
      logger.warn('Integration: create job rejected · ' + e.message);
      return legacyError(res, e.status, e.message);
    }
    next(e);
  }
});

// ─── /v1/jobs/jobStatus?jobId=X — GET status by id ─────────────────
router.get('/jobs/jobStatus', async (req, res, next) => {
  try {
    const jobId = Number(req.query.jobId);
    logger.info('Integration: fetch job status · jobId=' + (req.query.jobId || '-'));

    /*
     * Legacy answered HTTP 200 for EVERY outcome here, signalling failure only
     * through the envelope's `status` field (JobsResource.java:605-635):
     *
     *   found            → 200 {status:"200", message:"OK",            data:{jobId, currentStatus}}
     *   unknown / others' → 200 {status:"300", message:"Incorrect jobId", data:{jobId:0}}
     *   jobId absent/<=0  → 200 {} — literally an empty body
     *
     * A client polling this treats a 404 as an outage, so the HTTP codes are
     * reproduced as-is. "Not yours" and "does not exist" deliberately answer
     * identically — that is the legacy behaviour AND it avoids confirming
     * another partner's job ids exist.
     */
    if (!jobId || jobId <= 0) return res.json({});

    const job = await jobService.getById(jobId);
    if (!job || job.fk_client_id !== req.integrationClient.id) {
      logger.warn('Integration: job status not found / not owned · jobId=' + jobId);
      return res.json({ status: '300', message: 'Incorrect jobId', data: { jobId: 0 } });
    }
    legacyOk(res, { jobId: job.job_id, currentStatus: jobUiStatus(job) });
  } catch (e) { next(e); }
});

// ─── /v1/jobs/tracking — search ─────────────────────────────────────
router.get('/jobs/tracking', async (req, res, next) => {
  try {
    logger.info('Integration: track jobs · status=' + (req.query.status ?? 'all') + ' limit=' + (Math.min(Number(req.query.limit) || 50, 500)));
    const { rows } = await jobService.list({
      clientId: req.integrationClient.id,
      status: req.query.status != null ? Number(req.query.status) : undefined,
      limit: Math.min(Number(req.query.limit) || 50, 500),
    });
    logger.info('Returning ' + rows.length + ' tracked jobs');
    legacyOk(res, rows.map((j) => ({
      jobId: j.job_id, status: statusLabel(j.job_status),
      jobType: j.job_type, requestedDateTime: formatLegacyDate(j.requested_date_time),
    })));
  } catch (e) { next(e); }
});

// ─── /v1/jobs/history — date range ──────────────────────────────────
router.get('/jobs/history', async (req, res, next) => {
  try {
    logger.info('Integration: job history · from=' + (req.query.startDate || '-') + ' to=' + (req.query.endDate || '-'));
    const { rows } = await jobService.list({
      clientId: req.integrationClient.id,
      startDate: req.query.startDate, endDate: req.query.endDate,
      limit: 500,
    });
    logger.info('Returning ' + rows.length + ' history jobs');
    legacyOk(res, rows);
  } catch (e) { next(e); }
});

router.get('/jobs/:id', async (req, res, next) => {
  try {
    logger.info('Integration: fetch job · id=' + req.params.id);
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_client_id !== req.integrationClient.id) {
      logger.warn('Integration: job not found / not owned · id=' + req.params.id);
      return legacyError(res, 404, 'Not Found');
    }
    legacyOk(res, {
      jobId: job.job_id,
      status: statusLabel(job.job_status),
      jobType: job.job_type,
      requestedDateTime: formatLegacyDate(job.requested_date_time),
      scheduledDateTime: formatLegacyDate(job.scheduled_date_time),
      easyfixer: job.easyfixer_name,
      clientReferenceId: job.client_ref_id,
    });
  } catch (e) { next(e); }
});

// ─── /v1/jobs — PATCH update (reschedule/schedule/checkin/checkout/reject) ──
router.patch('/jobs', async (req, res, next) => {
  try {
    const { jobId, action } = req.body || {};
    logger.info('Integration: update job · jobId=' + (jobId || '-') + ' action=' + (action || '-'));
    if (!jobId || !action) return legacyError(res, 400, 'jobId and action required');
    const job = await jobService.getById(jobId);
    if (!job || job.fk_client_id !== req.integrationClient.id) {
      logger.warn('Integration: update target not found / not owned · jobId=' + jobId);
      return legacyError(res, 404, 'Not Found');
    }

    const map = { schedule: 1, checkin: 2, checkout: 3, reject: 6, reschedule: 1 };
    const newStatus = map[action];
    if (newStatus == null) {
      logger.warn('Integration: unknown action · "' + action + '"');
      return legacyError(res, 400, `unknown action "${action}"`);
    }

    const updated = await jobService.setStatus(jobId, { status: newStatus, comment: req.body.comment }, { user_id: null });
    logger.info('Integration: job status updated · id=' + updated.job_id + ' status=' + updated.job_status);
    legacyOk(res, { jobId: updated.job_id, status: statusLabel(updated.job_status) });
  } catch (e) { next(e); }
});

// ─── /v1/jobs/{id} — DELETE (cancel) ────────────────────────────────
router.delete('/jobs/:id', async (req, res, next) => {
  try {
    logger.info('Integration: cancel job · id=' + req.params.id);
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_client_id !== req.integrationClient.id) {
      logger.warn('Integration: cancel target not found / not owned · id=' + req.params.id);
      return legacyError(res, 404, 'Not Found');
    }
    await jobService.setStatus(job.job_id, { status: 6, comment: 'cancelled via /v1 API' }, { user_id: null });
    logger.info('Integration: job cancelled · id=' + job.job_id);
    legacyOk(res, { jobId: job.job_id, status: 'Cancelled' });
  } catch (e) { next(e); }
});

// ─── /v1/jobImage/addJobImages — multipart upload ───────────────────
router.post('/jobImage/addJobImages', upload.single('file'), async (req, res, next) => {
  try {
    logger.info('Integration: add job image · jobId=' + (req.body.JobId || req.body.jobId || '-'));
    if (!req.file) return legacyError(res, 400, 'file required');
    /*
     * JobId is OPTIONAL — the documented contract is "any one or both".
     * Omitting it stores an unattached image whose id the client passes to
     * POST /v1/jobs as `jobImageIds`, which is how photographs get attached
     * to a job that does not exist yet. Both spellings accepted: legacy
     * bound the multipart part as `jobId` while the published document says
     * `JobId`, so real integrator traffic exists in both casings.
     */
    const jobId = Number(req.body.JobId || req.body.jobId) || null;
    if (jobId) {
      const job = await jobService.getById(jobId);
      if (!job || job.fk_client_id !== req.integrationClient.id) {
        logger.warn('Integration: image upload target not found / not owned · jobId=' + jobId);
        return legacyError(res, 404, 'Not Found');
      }
    }

    const saved = writeBuffer('job_files', req.file.buffer, req.file.originalname, req.file.mimetype);
    // created_by is what scopes a later `jobImageIds` adoption to the client
    // that actually uploaded the file, so it must be stamped here.
    const [ins] = await pool.query(
      `INSERT INTO tbl_job_image (job_id, image, image_category, job_stage, status, created_by, updated_by, created_date)
       VALUES (?, ?, 'unconfirmed', 0, 1, ?, ?, NOW())`,
      [jobId, saved.filename, req.integrationClient.id, req.integrationClient.id]
    );
    logger.info('Integration: job image saved · jobId=' + (jobId || 'unattached') + ' imageId=' + ins.insertId);
    legacyOk(res, {
      imageId: ins.insertId, jobStage: 0, image: saved.filename,
      status: 1, createdTimestamp: formatLegacyDate(new Date()),
      imageCategory: 'unconfirmed',
      createdBy: req.integrationClient.id, updatedBy: req.integrationClient.id,
    });
  } catch (e) { next(e); }
});

// ─── /v1/easyfixers/availability-status ─────────────────────────────
// Real impl. Mirrors EasyFix_API EasyfixerResource:279 — uses
// pincode_firefox_city_mapping + firefox_city_mapping to find the slot
// capacity for the pincode's city, then counts scheduled jobs in the
// same date/time-slot to decide. Returns the verbatim legacy shape:
// `{"isAvailabil": "Yes" | "No"}`  (preserve the typo — Decathlon parsers
// rely on it literally).
router.get('/easyfixers/availability-status', async (req, res, next) => {
  try {
    logger.info('Integration: check availability · pincode=' + (req.query.pincode || '-') + ' date=' + (req.query.requestedDate || '-') + ' slot=' + (req.query.timeSlot || '-'));
    const available = await checkFirefoxAvailability(pool, {
      pincode: req.query.pincode,
      requestedDate: req.query.requestedDate,
      timeSlot: req.query.timeSlot,
    });
    logger.info('Integration: availability result · isAvailabil=' + (available ? 'Yes' : 'No'));
    legacyOk(res, { isAvailabil: available ? 'Yes' : 'No' });
  } catch (e) { next(e); }
});

// ─── /v1/easyfixers/availability-status-check (Decathlon variant) ───
// Mirrors EasyfixerResource:309 — gates on client_name = "Decathlon
// Sports India Private Limited" and then checks pincode_decathlon.
// Returns legacy shape with `null` when not applicable (matches legacy).
router.get('/easyfixers/availability-status-check', async (req, res, next) => {
  try {
    logger.info('Integration: Decathlon serviceability check · pincode=' + (req.query.pincode || '-'));
    const result = await checkDecathlonServiceability(pool, {
      pincode: req.query.pincode,
      clientName: req.integrationClient.name,
    });
    if (result === null) return legacyOk(res, null);
    logger.info('Integration: Decathlon serviceability result · isAvailabil=' + (result ? 'Yes' : 'No'));
    legacyOk(res, { isAvailabil: result ? 'Yes' : 'No' });
  } catch (e) { next(e); }
});
// ─── /v1/easyfixers/* — INTERNAL-only legacy endpoints ──────────────
// VERIFIED 2026-05-12 against EasyFix_API/EasyfixerResource.java:
//   - /transactions, /recharges, /city, /teamTransactions all carry
//     `@RolesAllowed({"crm","androidApp"})`. External Basic-Auth clients
//     never had access to them. The new app's CRM users hit /api/admin/*
//     and technicians hit /api/mobile/* — those routes carry the real
//     implementations. These stubs exist only to satisfy any stale URL
//     a misbehaving caller might probe; an empty list is the legacy's
//     own response shape when no rows match.
//   - /login is technician-app auth → use /api/auth/login-otp.
//   - /logout was a no-op stamp.
router.get('/easyfixers', async (_req, res) => legacyOk(res, { note: 'internal-only; use /api/admin/easyfixers', easyfixers: [] }));
router.get('/easyfixers/login', async (_req, res) => legacyError(res, 501, 'Not Implemented — use /api/auth/login-otp'));
router.get('/easyfixers/logout', async (_req, res) => legacyOk(res, { loggedOut: true }));
router.patch('/easyfixers', async (req, res) => legacyOk(res, { note: 'internal-only; use /api/admin/easyfixers', ...req.body }));
router.get('/easyfixers/transactions', async (_req, res) => legacyOk(res, []));
router.post('/easyfixers/transactions', async (_req, res) => legacyOk(res, { accepted: true }));
router.get('/easyfixers/recharges', async (_req, res) => legacyOk(res, []));
router.get('/easyfixers/city', async (_req, res) => legacyOk(res, []));
router.get('/easyfixers/teamTransactions', async (_req, res) => legacyOk(res, []));

// ─── /v1/users/* — INTERNAL (website/CRM) endpoints ─────────────────
// VERIFIED 2026-05-12 against EasyFix_API/UserResource.java:
//   /findUser, /getRecieverByjobId, /saveUserCallInfo, /contactUsers
//   all carry @RolesAllowed({"website"}) — internal CRM website token
//   only, never an external Basic-Auth client. /all and /ById are not
//   role-gated in legacy but expose internal user metadata; external
//   clients have never had a documented reason to call them.
// Real implementations for the new app live under /api/admin/users.
router.get('/users/all', async (_req, res) => legacyOk(res, []));
router.get('/users/ById', async (_req, res) => legacyOk(res, []));
router.get('/users/findUser', async (_req, res) => legacyOk(res, null));
router.get('/users/getRecieverByjobId', async (_req, res) => legacyOk(res, null));
router.post('/users/saveUserCallInfo', async (_req, res) => legacyOk(res, { saved: true }));
router.post('/users/contactUsers', async (_req, res) => legacyOk(res, { accepted: true }));

// ─── /v1/utils/* — DEAD CODE in legacy ──────────────────────────────
// VERIFIED 2026-05-12: EasyFixUtilsResource.java has `//@Path("/v1/utils")`
// commented out → Jersey never exposed these (except /utils/test which
// is exempted by ResponseFilter for liveness probes). generateOtp/
// validateOtp/notification are internal-only; OTP delivery now lives
// at /api/auth/login-otp + /verify-otp on the modern stack.
router.get('/utils/test', async (_req, res) => legacyOk(res, { message: 'ok' }));
router.get('/utils/generateOtp', async (_req, res) => legacyError(res, 501, 'Not Implemented — use /api/auth/login-otp'));
router.get('/utils/validateOtp', async (_req, res) => legacyError(res, 501, 'Not Implemented — use /api/auth/verify-otp'));
router.post('/utils/notification', async (_req, res) => legacyOk(res, { sent: true }));
router.post('/utils/uploadFile', upload.single('file'), async (req, res, next) => {
  try {
    logger.info('Integration: upload general file');
    if (!req.file) return legacyError(res, 400, 'file required');
    const saved = writeBuffer('general', req.file.buffer, req.file.originalname, req.file.mimetype);
    logger.info('Integration: file saved · ' + saved.filename);
    legacyOk(res, { filename: saved.filename, url: saved.url });
  } catch (e) { next(e); }
});

// /v1/clients/*
router.get('/clients', async (req, res) => legacyOk(res, []));
router.get('/clients/:id', async (req, res, next) => {
  try {
    logger.info('Integration: fetch client · id=' + req.params.id);
    if (Number(req.params.id) !== req.integrationClient.id) {
      logger.warn('Integration: client id mismatch · id=' + req.params.id);
      return legacyError(res, 404, 'Not Found');
    }
    const [[c]] = await pool.query('SELECT client_id, client_name, client_email FROM tbl_client WHERE client_id = ?', [req.params.id]);
    legacyOk(res, c || null);
  } catch (e) { next(e); }
});
// VERIFIED 2026-05-12 against ClientResource.java: both endpoints
// carry @RolesAllowed("androidApp") → only the technician app, never
// an external integrator. Real impl belongs under /api/mobile/jobs/*.
router.get('/clients/getQuestionaireDetailsList', async (_req, res) => legacyOk(res, []));
router.post('/clients/saveQuestionaireAnswers', async (_req, res) => legacyOk(res, { saved: true }));

// /v1/customer/*
router.get('/customer/getCustomer', async (req, res, next) => {
  try {
    const { mobile, id } = req.query;
    logger.info('Integration: lookup customer · by=' + (mobile ? 'mobile' : (id ? 'id' : 'none')));
    if (!mobile && !id) return legacyError(res, 400, 'mobile or id required');
    const [[cust]] = await pool.query(
      mobile
        ? 'SELECT customer_id AS id, customer_name AS name, customer_mob_no AS mobile, customer_email AS email FROM tbl_customer c WHERE c.customer_mob_no = ? AND EXISTS (SELECT 1 FROM tbl_job j WHERE j.fk_customer_id = c.customer_id AND j.fk_client_id = ?) LIMIT 1'
        : 'SELECT customer_id AS id, customer_name AS name, customer_mob_no AS mobile, customer_email AS email FROM tbl_customer c WHERE c.customer_id = ? AND EXISTS (SELECT 1 FROM tbl_job j WHERE j.fk_customer_id = c.customer_id AND j.fk_client_id = ?) LIMIT 1',
      [mobile || id, req.integrationClient.id]
    );
    legacyOk(res, cust || null);
  } catch (e) { next(e); }
});
router.post('/customer/addCustomer', async (req, res, next) => {
  try {
    const { name, mobile, email } = req.body || {};
    logger.info('Integration: add customer');
    if (!name || !mobile) return legacyError(res, 400, 'name and mobile required');
    const [ins] = await pool.query(
      'INSERT INTO tbl_customer (customer_name, customer_mob_no, customer_email, is_active, insert_date, update_date) VALUES (?, ?, ?, 1, NOW(), NOW())',
      [name, mobile, email || null]
    );
    logger.info('Integration: customer created · id=' + ins.insertId);
    legacyOk(res, { id: ins.insertId });
  } catch (e) { next(e); }
});
router.put('/customer', async (req, res, next) => {
  try {
    const { id, name, email } = req.body || {};
    logger.info('Integration: update customer · id=' + (id || '-'));
    if (!id) return legacyError(res, 400, 'id required');
    await pool.query('UPDATE tbl_customer SET customer_name = COALESCE(?, customer_name), customer_email = COALESCE(?, customer_email), update_date = NOW() WHERE customer_id = ?', [name, email, id]);
    logger.info('Integration: customer updated · id=' + id);
    legacyOk(res, { updated: true });
  } catch (e) { next(e); }
});
router.get('/customer/jobs', async (req, res, next) => {
  try {
    const custId = Number(req.query.customerId);
    logger.info('Integration: list customer jobs · customerId=' + (req.query.customerId || '-'));
    const [rows] = await pool.query('SELECT job_id, job_status, created_date_time FROM tbl_job WHERE fk_customer_id = ? AND fk_client_id = ? ORDER BY job_id DESC LIMIT 100', [custId, req.integrationClient.id]);
    logger.info('Found ' + rows.length + ' customer jobs');
    legacyOk(res, rows.map((j) => ({ ...j, status: statusLabel(j.job_status) })));
  } catch (e) { next(e); }
});

// ─── /v1/clientInvoice — date-range invoice list ────────────────────
// VERIFIED 2026-05-12 against EasyFix_API (Invoice.java + InvoiceDAO.java):
//   tbl_client_invoice columns:
//     id (PK), fk_client_id, billing_from_date, billing_to_date,
//     current_due_amount, previous_due_amount, total_invoice_amount,
//     is_paid, is_raised, amount_due_date, file_path_excel, file_path_pdf
//   Filter: billing_from_date >= startDate AND billing_to_date <= endDate
//   Order:  billing_to_date DESC
//   Legacy JSON field aliases (must preserve):
//     invoiceId, billingStartDate, billingEndDate, currentamountDues,
//     previousamountDues, totalInvoiceAmount, isPaid, israised,
//     amountDueDate, invoiceMasterSheet, invoicePdf
//
// Authenticated client gets only their own rows; explicit clientId query
// is honoured only if it matches their own id (defensive — legacy didn't
// enforce this but we should, since Basic Auth is per-client).
router.get('/clientInvoice', async (req, res, next) => {
  try {
    const callerClientId = req.integrationClient.id;
    const requestedClientId = req.query.clientId ? Number(req.query.clientId) : callerClientId;
    logger.info('Integration: list client invoices · from=' + (req.query.startDate || '-') + ' to=' + (req.query.endDate || '-'));
    if (requestedClientId !== callerClientId) {
      logger.warn('Integration: invoice clientId mismatch · requested=' + requestedClientId);
      return legacyError(res, 403, 'Forbidden');
    }
    const { startDate, endDate } = req.query;
    const args = [callerClientId];
    let where = 'fk_client_id = ?';
    if (startDate && endDate) {
      where += ' AND billing_from_date >= ? AND billing_to_date <= ?';
      args.push(startDate, endDate);
    }
    const [rows] = await pool.query(
      `SELECT id, fk_client_id, billing_from_date, billing_to_date,
              current_due_amount, previous_due_amount, total_invoice_amount,
              is_paid, is_raised, amount_due_date, file_path_excel, file_path_pdf
         FROM tbl_client_invoice
        WHERE ${where}
        ORDER BY billing_to_date DESC`,
      args
    );
    logger.info('Found ' + rows.length + ' client invoices');
    const data = rows.map((r) => ({
      invoiceId: r.id,
      client: { clientId: r.fk_client_id },
      billingStartDate: formatLegacyDate(r.billing_from_date),
      billingEndDate: formatLegacyDate(r.billing_to_date),
      currentamountDues: r.current_due_amount,
      previousamountDues: r.previous_due_amount,
      totalInvoiceAmount: r.total_invoice_amount,
      isPaid: r.is_paid,
      israised: r.is_raised,
      amountDueDate: formatLegacyDate(r.amount_due_date),
      invoiceMasterSheet: r.file_path_excel,
      invoicePdf: r.file_path_pdf,
    }));
    legacyOk(res, data);
  } catch (e) { next(e); }
});

// ─── /v1/userLog/* — DEAD CODE in legacy ────────────────────────────
// VERIFIED 2026-05-12: EasyFix_API/UserLogResource.java has its @Path
// annotation commented out (`//@Path("/v1/userLog")`), meaning Jersey
// never exposed these endpoints. They're registered but unreachable.
// Therefore external clients have never been able to call /v1/userLog/*.
// We keep contract-shape stubs in case a misbehaving integrator probes.
router.get('/userLog/findAll', async (_req, res) => legacyOk(res, []));
router.get('/userLog/download', async (_req, res) => legacyOk(res, []));

module.exports = router;
