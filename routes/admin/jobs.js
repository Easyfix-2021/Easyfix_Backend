const router = require('express').Router();

const validate = require('../../middleware/validate');
const job = require('../../services/job.service');
// Material Request Flow v2 (2026-09-21) — the single line-state derivation,
// used by the material-review completeness check and the new quotation-lines
// add endpoint below.
const quotationLineState = require('../../services/quotation-line-state');
// tbl_job_notes — the legacy free-text ops notepad, read+add only. Deliberately
// separate from jobComments below: audit trail vs. operator-to-operator notes.
const jobNotes = require('../../services/job-notes.service');
// The one-list services editor (Uplifted tab): catalog read + complete-set PUT.
const servicesEditor = require('../../services/job-services-editor.service');
const clientRequest = require('../../services/client-request.service');
const bookingQueue = require('../../services/booking-queue.service');
const candidateRanking = require('../../services/candidate-ranking.service');
const jobLocation = require('../../services/job-location.service');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');
const {
  listQuery, createBody, updateBody, statusBody, assignBody, offerBody, ownerBody, rescheduleBody, idParam,
  appRequestRejectBody, candidatesQuery, candidatesSearchQuery, slotRecommendationsQuery,
  pendingSchedulingCountsQuery, pendingStartCountsQuery,
  dashboardCountsQuery, dashboardAttentionQuery, DASHBOARD_FILTERS,
} = require('../../validators/job.validator');
const { assertEntityInScope } = require('../../lib/scope');
const requireStageForTransition = require('../../middleware/require-stage');
const requireAction = require('../../middleware/require-action');
const { getEffectivePermissions } = require('../../services/role.service');
const { transitionAllowed } = require('../../lib/job-stages');
// Job delegation (technician shares a job with another technician). Ops-side
// force-release only — see POST /:id/share/release at the bottom of this file.
const jobShareDelegation = require('../../services/job-share-delegation.service');
const { rateLimit } = require('../../middleware/rate-limit');
// Reused (NOT re-implemented) for POST /:id/resend-customer-pin — see that route.
const mobileLifecycle = require('../../services/mobile-job-lifecycle.service');
// tbl_job_logs writer — the same one job.service uses. See the resend route.
const jobLog = require('../../services/job-log.service');
// Still used by GET /escalated/export.xlsx (small, styled, buffered — fine
// at that size). The big Manage Job Report uses the streaming writer below.
const { streamStyledXlsx } = require('../../utils/xlsx-styled-export');
const { streamRowsToXlsx } = require('../../utils/xlsx-stream-export');
const {
  EXPORT_COLUMNS, fetchExportChunk, mapExportRow, UNAPPLIED_FILTERS, buildExportWhere,
} = require('../../services/job-export.service');
const { todayIst } = require('../../utils/ist-calendar');
const { proofBucketOf } = require('../../utils/job-image-buckets');
const ttlCache = require('../../utils/ttl-cache');

/*
 * Row-level scope guard for every /:id endpoint. Fetches the job once,
 * confirms (client_id, city_id, vertical_id) all sit within the caller's
 * manage_* scope. Returns 404 (not 403) on scope failure to avoid leaking
 * existence of out-of-scope job_ids. Attaches the row at req.scopedJob
 * so downstream handlers can use it without a second fetch.
 */
async function scopedJob(req, res, next) {
  try {
    const j = await job.getById(req.params.id);
    if (!j) return modernError(res, 404, 'job not found');
    const guard = assertEntityInScope(req, {
      client_id:   j.fk_client_id,
      city_id:     j.city_id,
      vertical_id: j.vertical_id,
    });
    if (!guard.ok) return modernError(res, 404, 'job not found');
    req.scopedJob = j;
    return next();
  } catch (e) { next(e); }
}

// The CRM's isJobClosed: a completed job's service lines are its billing lines.
const CLOSED_STATUSES = new Set([job.STATUS.COMPLETED, job.STATUS.COMPLETED_ALT]);

/*
 * Who may PUT/PATCH /:id (2026-09-11). Until now nothing but the admin group
 * and scope: any admin-group user could write any field of any in-scope job,
 * and ?action=edit opened a keyless form that did. One branch per CRM caller,
 * so nobody loses what the CRM lets them do today (QA role matrix, 2026-09-11):
 *   isJobEdit              description, address, S&A details and services
 *   isJobConfirm on a 9    Confirm & Schedule: Book Call, Draft, Unreachable,
 *   whose 9 → 0 is allowed   Enquiry. Its PATCH lands before PATCH /status.
 *   { job_type } alone     the View modal's Services tab (keyless) retypes the
 *   on a job not closed    job after adding lines; the services routes below
 *                          carry the same status rule.
 * Deliberately NOT any-of(isJobEdit, isJobConfirm): that would let a
 * confirm-only user write every field at every status. After scopedJob, which
 * supplies the status and 404s an out-of-scope job first.
 */
async function canPatchJob(req, res, next) {
  try {
    if (!req.user.permissions) req.user.permissions = await getEffectivePermissions(req.user.user_id);
    const perms = (req.user.permissions && req.user.permissions.actionPermissions) || [];
    const status = Number(req.scopedJob.job_status);
    if (perms.includes('isJobEdit')) return next();
    if (perms.includes('isJobConfirm') && status === job.STATUS.UNCONFIRMED
      && transitionAllowed(req.allowedStages, status, job.STATUS.BOOKED)) return next();
    const keys = Object.keys(req.body || {});
    if (keys.length === 1 && keys[0] === 'job_type' && !CLOSED_STATUSES.has(status)) return next();
    logger.warn('Job edit refused · jobId=' + req.params.id + ' status=' + status + ' fields=' + keys.join(','));
    return modernError(res, 403, 'Missing permission: isJobEdit');
  } catch (e) { next(e); }
}

// Service-line writes on a completed job: the CRM hides them, the server refuses them.
function servicesEditable(req, res, next) {
  if (CLOSED_STATUSES.has(Number(req.scopedJob.job_status))) {
    return modernError(res, 409, 'Services cannot be changed on a completed job');
  }
  return next();
}

/*
 * Past-appointment gate (2026-07-29).
 *
 * Two things ops could do that shouldn't be possible: reschedule a job INTO a
 * moment that has already gone, and offer a job whose promised slot has already
 * passed (e.g. a 9 AM appointment still being offered at 12:44). Both put a
 * technician on the hook for a time nobody can meet; the second also produces
 * offers that are stale the instant they are sent.
 *
 * ROUTE LAYER ONLY — deliberately not inside job.service. `offerToTechnicians`
 * is shared with assign() and the on-create auto-assign path, where a
 * back-dated import must still be allowed to land. Same reasoning as
 * middleware/require-stage.js. NOT applied to /assign either: reassigning a
 * running-late job (tech no-show at 9 AM, swap at 12:44) is a legitimate
 * recovery ops must keep.
 *
 * The "effective" appointment is the body's requestedDateTime when present —
 * both /offer and /reschedule can carry a schedule edit — otherwise the job's
 * stored one. So fixing the time in the SAME call is always allowed; only a
 * stale time left stale is refused.
 */
function appointmentIsPast(value) {
  const raw = String(value || '').trim().replace('T', ' ');
  if (!raw) return false;                       // nothing to judge → don't block
  const nowIst = job.formatMysqlDateTimeIST(new Date()); // 'YYYY-MM-DD HH:MM:SS' IST
  if (!nowIst) return false;
  // Date-only carries no promised time, so judge it by DATE alone — otherwise
  // "today, time unspecified" would read as 00:00 and be wrongly called past.
  // Zero-padded fixed-width strings, so lexicographic compare IS chronological.
  if (raw.length <= 10) return raw.slice(0, 10) < nowIst.slice(0, 10);
  return raw.slice(0, 16) < nowIst.slice(0, 16);
}

function blockPastAppointment(message) {
  return function pastAppointmentGuard(req, res, next) {
    const effective = req.body?.requestedDateTime
      || (req.scopedJob && req.scopedJob.requested_date_time);
    if (appointmentIsPast(effective)) {
      logger.warn('Past-appointment blocked · jobId=' + req.params.id + ' · appointment=' + effective);
      return modernError(res, 400, message);
    }
    return next();
  };
}

// Upload sub-router (POST /upload) — isolated because of multer middleware.
router.use(require('./jobs-upload'));

/*
 * GET /api/admin/jobs/:id/candidates?limit=50
 *
 * Returns ranked technicians for the Assign / Reassign modal on /my-orders
 * and /jobs. Same layered pipeline used by on-create auto-assign — see
 * services/candidate-ranking.service.js. Returns per-candidate breakdowns
 * (Rating, TAT, SDA, Worked-for-Client, Worked-for-Vertical, Attendance)
 * plus account balance for sorting tie-break.
 *
 * If no technician passes the deep-skill filter, the response includes
 * `note: 'no_deep_skill_match'` and the candidates list is the same query
 * with the skill predicate dropped — so the modal can show a banner and
 * still let ops pick someone.
 *
 * Listed BEFORE `/:id/assign` and other `/:id/*` so Express matches the
 * literal `candidates` segment first.
 */
/*
 * GET /api/admin/jobs/:id/location[?limit=] — real-time technician location for
 * the CRM live view. Returns the latest fix + a recent breadcrumb trail from
 * tbl_job_location_track (posted by the tech app during the job). scopedJob
 * enforces the operator's manage_* scope (404 out-of-scope).
 */
router.get('/:id/location',
  validate(idParam, 'params'),
  scopedJob,
  async (req, res, next) => {
    try {
      logger.info('Fetch job location · jobId=' + req.params.id + ' limit=' + req.query.limit);
      const [latest, track] = await Promise.all([
        jobLocation.getLatest(req.params.id),
        jobLocation.getTrack(req.params.id, { limit: req.query.limit }),
      ]);
      logger.info('Returning job location · jobId=' + req.params.id + ' trackPoints=' + (track ? track.length : 0));
      modernOk(res, { latest, track });
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  });

/*
 * GET /api/admin/jobs/:id/selfie-url — resolve the technician's reached-location
 * selfie to a short-TTL presigned URL for the CRM. tbl_job.tx_selfie_id is an int
 * FK to document.id; the mobile upload stored the S3 key in document.path, so we
 * presign it on read (5-min TTL, re-minted per view — nothing cached). Returns
 * { selfieId, url } with url=null when there is no selfie / no resolvable key, so
 * the CRM can render the tile unconditionally and simply hide it on null. scopedJob
 * enforces the operator's manage_* scope.
 */
router.get('/:id/selfie-url',
  validate(idParam, 'params'),
  scopedJob,
  async (req, res, next) => {
    try {
      const selfieId = req.scopedJob.tx_selfie_id;
      if (!selfieId) return modernOk(res, { selfieId: null, url: null });

      // One HEAD per selfie view — opened by a human looking at one job, not a
      // list. The resolver (and why it HEADs before presigning) is shared with
      // the technician's GET /mobile/jobs/:id.
      const url = (await job.resolveSelfie(selfieId, req.params.id))?.url ?? null;
      logger.info('Resolved selfie url · jobId=' + req.params.id + ' · has=' + !!url);
      modernOk(res, { selfieId, url });
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  });

router.get('/:id/candidates',
  validate(idParam, 'params'),
  validate(candidatesQuery, 'query'),
  scopedJob,
  async (req, res, next) => {
    try {
      const { limit, jobDate, timeSlot } = req.query;
      logger.info('Rank candidates for job · jobId=' + req.params.id + ' limit=' + limit + ' jobDate=' + (jobDate || '-') + ' timeSlot=' + (timeSlot || '-'));
      // Lazy offer-expiry (job-scoped) BEFORE ranking. l1Eligibility EXCLUDES techs
      // with an OPEN offer, so a >30-min stale offer (cron off / between ticks)
      // would wrongly keep an already-re-offerable tech OUT of the pool. Expiring
      // first (0→3) lets them re-rank. undefined = default 30-min TTL. Idempotent.
      await job.expireStaleOffers(undefined, Number(req.params.id));
      const result = await candidateRanking.rankCandidatesForJob(req.params.id, {
        limit,
        // jobDate is a validated IST wall-clock string — pass it through
        // verbatim. The service slices the date-only prefix for DATE()
        // comparisons; do NOT new Date()/toISOString() it (UTC↔IST shift).
        jobDate: jobDate || undefined,
        timeSlot,
        // Schedule & Assign top-10 hard filters per the API contract:
        // concurrent is a displayed column (not a hard filter), COD enforces
        // the balance floor.
        enforceMaxConcurrent: false,
        enforceCodBalance: true,
        // Manual picker: attendance is SOFT — present techs rank first, absent
        // techs (shown with the ✗ column) backfill the list to `limit` instead
        // of being excluded, so the Top-10 is never empty when eligible techs
        // exist. (Auto-assign keeps attendance a HARD gate — it omits this.)
        softAttendance: true,
        // scopedJob already loaded this job — hand it over so the service
        // doesn't run a second (redundant) getById on the hot path.
        preloadedJob: req.scopedJob,
      });
      // Tell the CRM modal which commit mode to render: offer-pool (multi-select
      // + "Offer to N") when the offer flow is effectively active, else single
      // direct-assign ("Assign"). Mirrors the BE's own assign-vs-offer gate so
      // the UI never lies about what the commit will do. The candidate LIST is
      // unchanged — this only flags the commit mode.
      const offerFlowEnabled = await job.isOfferFlowActive();
      /*
       * OFFERABILITY — answered by the SAME predicate the offer guard enforces
       * (job.jobOfferability), off the row scopedJob already loaded, so it costs
       * no extra query. The modal used to re-derive this from job_status alone
       * and therefore rendered a commit button that could only 409 for a BOOKED
       * job that still carried an owner; see the helper's own comment.
       *
       * Sent as two flat fields beside offerFlowEnabled, matching that
       * neighbour rather than introducing a nested shape on this payload.
       * releasesOwner is NOT sent: the CRM needs the outgoing technician's NAME
       * to say anything useful, and that only exists on the job-detail probe it
       * already issues for the header.
       */
      const offerability = job.jobOfferability(req.scopedJob);
      /*
       * ASSIGNABILITY too, from its own predicate. The Assign / Reassign modal
       * reads the same /candidates payload, and /assign refuses a DIFFERENT set
       * from /offer — only the closed states, so a SCHEDULED job is assignable
       * while never being offerable. One flag for both would have made every
       * reassign look refused.
       */
      const assignability = job.jobAssignability(req.scopedJob);
      logger.info('Returning ' + (result?.candidates?.length || 0) + ' ranked candidates · jobId=' + req.params.id + ' offerFlow=' + offerFlowEnabled + ' offerable=' + offerability.offerable + (result?.note ? ' note=' + result.note : ''));
      modernOk(res, {
        ...result,
        offerFlowEnabled,
        offerable: offerability.offerable,
        offerBlockReason: offerability.reason,
        assignable: assignability.assignable,
        assignBlockReason: assignability.reason,
      });
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  });

/*
 * GET /api/admin/jobs/:id/header
 *
 * The Schedule & Assign console's job header with NONE of the ranking work
 * /candidates does: no stale-offer expiry, no technician ranking, no offer-flow
 * or offerability resolution. Accepted jobs (status 1) are the main consumer —
 * they already have a technician, so ranking the pool to draw their header was
 * pure cost.
 *
 *   { job }   where job =
 *     exactly the object buildJobHeader produces for /candidates (services with
 *     unit_price / line_total, timeline, managers, age, payment), PLUS
 *     job_status, is_cancelled_by_app, is_rescheduled_by_app, cancel_date_time,
 *     reschedule_at_app, reschedule_date_time_app, app_request_reason — under
 *     the /admin/jobs LIST's names, so the CRM's appRequestOf(job) works on it
 *     unchanged — PLUS efr_id, efr_name, efr_mobile for the assigned technician
 *     (nulls while unassigned; efr_mobile masked in transit).
 *
 * Guarded exactly as /candidates is: the /api/admin/* chain plus scopedJob,
 * which 404s a job outside the caller's scope before the header is built. Not a
 * write, so no stage or action guard — the same as /candidates.
 *
 * Read-only by construction: /candidates' lazy expireStaleOffers is a WRITE and
 * is deliberately NOT called here. A header is drawn on every console open, and
 * a GET that mutates offer state on a mouse-driven path is the hover-card bug
 * listOffers' `sweep:false` was added to avoid.
 *
 * Literal second segment "header", so no collision with `/:id`.
 */
router.get('/:id/header',
  validate(idParam, 'params'),
  scopedJob,
  async (req, res, next) => {
    try {
      logger.info('Build console header · jobId=' + req.params.id);
      const header = await candidateRanking.consoleHeaderForJob(req.scopedJob);
      modernOk(res, { job: header });
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  });

/*
 * GET /api/admin/jobs/:id/slot-recommendations?date=YYYY-MM-DD
 *
 * Which of the four booking windows can actually be STAFFED on that date.
 * Ops otherwise pick a slot from a static list with nothing to say whether
 * anyone is free — the cost of which shows up later as failed assignments and
 * reschedules.
 *
 * Advice only: every window is returned (with a reason when it is poor), the FE
 * keeps them all selectable, and nothing here blocks a booking.
 *
 * CACHED for 30s on (jobId, date). The CRM calls this on every date pick and
 * the underlying work is a full ranking pass; this backend is shared with the
 * client portal and the mobile app, so a repeat pick of the same date must not
 * re-run it. ttl-cache also JOINS in-flight callers, so two operators opening
 * the same job at once cost one computation, not two.
 */
router.get('/:id/slot-recommendations',
  validate(idParam, 'params'),
  validate(slotRecommendationsQuery, 'query'),
  scopedJob,
  async (req, res, next) => {
    try {
      const day = String(req.query.date).slice(0, 10);
      const result = await ttlCache.cached(
        `slot-rec:${req.params.id}:${day}`,
        30_000,
        () => candidateRanking.recommendSlotsForJob(req.params.id, { date: day }),
      );
      modernOk(res, result);
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  });

/*
 * GET /api/admin/jobs/:id/candidates/search?term=<q>&jobDate=&timeSlot=
 *
 * Match-anyone variant of /:id/candidates — finds technicians by
 * efr_id / efr_name / efr_no(mobile) / city_name / efr_pin_no (single `term`
 * box — no per-field params) with NO top-10 hard filters and NO
 * ranking exclusion, returning the same widened row shape (distance,
 * attendance, concurrent, skill state, …) so ops can assign anyone.
 * Capped at 50; the service logger.warns when the cap is hit.
 *
 * Declared BEFORE `/:id/assign` and `/:id` so Express matches the literal
 * `candidates/search` segments first.
 */
router.get('/:id/candidates/search',
  validate(idParam, 'params'),
  validate(candidatesSearchQuery, 'query'),
  scopedJob,
  async (req, res, next) => {
    try {
      const { term, limit, jobDate, timeSlot } = req.query;
      logger.info('Search technicians for job · jobId=' + req.params.id + ' term="' + (term || '') + '" limit=' + limit);
      // Lazy offer-expiry (job-scoped) so search reflects the same fresh offer
      // state as the ranked list (see the /candidates note). Idempotent no-op when
      // nothing is stale / the offer table is absent.
      await job.expireStaleOffers(undefined, Number(req.params.id));
      const result = await candidateRanking.searchTechniciansForJob(req.params.id, {
        term,
        limit,
        // Pass the validated IST wall-clock string through verbatim (no UTC
        // round-trip) — the service slices the date prefix for DATE() math.
        jobDate: jobDate || undefined,
        timeSlot,
        // Reuse scopedJob's already-loaded job row (skip the redundant getById).
        preloadedJob: req.scopedJob,
      });
      logger.info('Returning ' + (result?.candidates?.length || 0) + ' matched technicians · jobId=' + req.params.id);
      modernOk(res, result);
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  });

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    /*
     * Resolve the client-request reason ids ONCE per request, only when a
     * section filter is actually in play. sectionPredicate needs them and is
     * synchronous; this is the async boundary. Cached in the service after the
     * first hit, so the cost is one query on the first sectioned request per
     * process.
     *
     * ⚠ INSIDE THE try, AND THAT IS LOAD-BEARING. It was written above it, and
     * an await above a handler's try is not a style choice here — it is a
     * process crash. Express 4 does not attach a .catch to the promise an async
     * handler returns, this repo registers no process-level
     * 'unhandledRejection' listener (server.js has only SIGTERM/SIGINT), and
     * the image runs Node 20, whose default is --unhandled-rejections=throw.
     * So a rejection from this ONE line — a DB blip, a pool timeout — would
     * take the whole server down instead of returning a 500 for one request.
     * Reproduced against this repo's own express before moving it.
     */
    if (req.query.section) {
      const { pool } = require('../../db');
      req.query.sectionIds = await clientRequest.reasonIds(pool);
    }
    /*
     * The Booking-queue bucket's "has the customer answered" test reads
     * tbl_job_customer_request, which does not exist on every deploy. Probe
     * ONCE here (memoised in job.service) and hand the answer down, so the
     * predicate degrades to customer_submitted_at instead of 500ing the list.
     */
    if (req.query.bucket || req.query.customerRescheduled) {
      req.query.bucketHasRequestTable = await job.customerRequestTableExists();
    }
    // Row-level RBAC + reporting hierarchy: row-filter the list by the
    // UNION of (caller's own manage_* scope) ∪ (every direct/indirect
    // report's manage_* scope). Admin/Finance bypass via the bypass
    // list in lib/scope.js.
    const { buildRequestScopeWithHierarchy } = require('../../lib/scope');
    const { pool } = require('../../db');
    logger.info('List jobs · status=' + (req.query.status ?? '-') + ' clientId=' + (req.query.clientId ?? '-') + ' cityId=' + (req.query.cityId ?? '-') + ' limit=' + req.query.limit + ' offset=' + req.query.offset);
    const scope = await buildRequestScopeWithHierarchy(req, pool);
    // Job Stage Access — req.allowedStages is attached by routes/admin/index.js
    // (bypass roles / no-rows → {mode:'all'} = unrestricted). list() intersects
    // the visible statuses with any tab/status filter.
    const { rows, total } = await job.list({ ...req.query, scope, allowedStages: req.allowedStages });
    logger.info('Returning ' + rows.length + ' jobs (total=' + total + ')');
    modernOk(res, { items: rows, total, limit: req.query.limit, offset: req.query.offset });
  } catch (e) { next(e); }
});

/*
 * GET /api/admin/jobs/export.xlsx
 *
 * STREAMING XLSX export of the Filter-Job panel result set — the full
 * 74-column Manage Job Report. Accepts every filter the list endpoint
 * accepts (validated by the same listQuery schema, with pagination
 * params dropped) and applies the same RBAC scope, so the operator's
 * export reflects exactly what they see in the table — minus the page
 * boundary.
 *
 * ⚠ THAT PARAGRAPH DESCRIBED AN INTENTION, NOT THE CODE, UNTIL 2026-08-20.
 * The service spoke only the legacy Java panel's filter vocabulary, so
 * every listQuery filter arrived undefined and the no-filter guard
 * substituted "open jobs, last 6 months" for the request — a Closed-job
 * export returned exactly the Open jobs. RBAC was passed in and never
 * read. Both are fixed in services/job-export.service.js; the
 * authoritative per-key ledger is FILTER_COVERAGE at the top of that
 * file, and tests/job-export-filters.test.js derives its checks from
 * the listQuery schema so a key added there cannot be dropped here in
 * silence. If you change what this endpoint honours, change that ledger
 * and this docblock in the same commit — a docblock that lies is worse
 * than no docblock.
 *
 * Memory model (this is the whole point of the rewrite): rows are pulled
 * in keyset-paginated chunks and handed to the writer one at a time, so
 * heap holds ONE chunk, never the result set. The previous version
 * called job.list({ limit: 100000 }) and materialised the rows, the
 * mapped rows, and a fully-built workbook simultaneously; the legacy
 * Java exporter did the same with POI and took the box down.
 *
 * Keyset (job_id > cursor) rather than LIMIT/OFFSET: OFFSET 98000 makes
 * MySQL walk and discard 98,000 rows on every page, so the last chunks
 * of a big export cost the most. It also can't skip or duplicate rows
 * when the underlying table changes mid-export.
 *
 * Free-text `q` is honoured here unlike the escalated export — on the
 * jobs list `q` IS the operator-supplied filter, not an in-table
 * client-side search. (True since 2026-08-20: buildClauses did not even
 * destructure `q` before that.)
 *
 * Mounted BEFORE `/:id` so Express doesn't try to parse "export" as a
 * job id (same gotcha as `/counts`, `/escalated`, `/comment-reasons`).
 */

// One DB round-trip per 2,000 rows. Sized against the two costs that pull
// in opposite directions: mysql2 buffers a whole result set in memory
// before we see it (so a chunk of 2,000 × ~74 columns is a few MB — bounded
// and predictable), while a smaller chunk would turn a 100k-row export into
// hundreds of round-trips, each paying the joins' fixed setup cost. 2,000
// keeps a 100k export at ~50 queries with a flat memory profile.
const EXPORT_CHUNK_SIZE = 2000;

// Hard ceiling. Legacy had NO cap: a mis-set (or empty) filter would try to
// stream the entire tbl_job history, which is how the old exporter took the
// server down. The stream stops here and logs a warning rather than running
// unbounded; 200k is comfortably above any legitimate operator export.
const EXPORT_ROW_CEILING = 200000;

router.get('/export.xlsx', validate(listQuery, 'query'), async (req, res, next) => {
  const startedAt = Date.now();
  try {
    /*
     * Log the filters the operator ACTUALLY sent, `statuses` included. The old
     * line read only `status`, so the production evidence for the
     * ignored-filters bug looked like this — the URL carrying
     * `statuses=3,5&startDate=…` and the very next line printing `status=-`.
     * A log that cannot show the filter that was dropped is a log that hides
     * the bug it exists to catch.
     */
    logger.info('Export jobs xlsx · statuses=' + (req.query.statuses ?? req.query.status ?? '-')
      + ' clientId=' + (req.query.clientId ?? '-')
      + ' cityId=' + (req.query.cityId ?? '-')
      + ' from=' + (req.query.startDate || '-') + ' to=' + (req.query.endDate || '-')
      + ' q=' + (req.query.q ? 'yes' : '-')
      + ' scoped=' + (req.scope ? 'yes' : 'bypass')
      + ' stages=' + (req.allowedStages?.mode ?? '-'));

    /*
     * Say out loud which supplied filters the sheet does NOT reflect. See
     * FILTER_COVERAGE in services/job-export.service.js for why each one is on
     * the list. The original bug was invisible precisely because nothing ever
     * announced that a filter had been dropped; "my filter did nothing" must
     * be answerable from the log, not from a code read.
     *
     * `zonalId` is not unapplied — it IS honoured, under the LEGACY reading
     * (tbl_city.state_user), which is not the reading list() gives the same
     * name. Logged separately so the collision can never be silent.
     */
    const dropped = UNAPPLIED_FILTERS.filter((k) => req.query[k] !== undefined && req.query[k] !== '');
    if (dropped.length) {
      logger.warn('Jobs export cannot apply these filters, they are NOT reflected in the sheet: ' + dropped.join(', '));
    }
    if (req.query.zonalId !== undefined && req.query.zonalId !== '') {
      logger.warn('Jobs export received zonalId=' + req.query.zonalId
        + ' and read it as a ZONAL MANAGER (tbl_city.state_user), which is the legacy meaning — the jobs LIST reads the same name as a ZONE. See ZONAL_ID_COLLISION in services/job-export.service.js.');
    }

    /*
     * RBAC must survive the rewrite. req.scope is the hierarchy-unioned scope
     * attached by routes/admin/index.js (the same buildRequestScopeWithHierarchy
     * the old handler called inline), and req.allowedStages is Job Stage
     * Access. Drop either one and the export silently leaks rows the operator
     * cannot see in the table.
     *
     * ⚠ THAT IS NOT HYPOTHETICAL — it is what shipped. Both were passed here
     * and the service never read them (`grep allowedStages
     * services/job-export.service.js` returned nothing), so until 2026-08-20 a
     * scope-restricted operator's sheet carried every client's rows. The
     * consumer side is the RBAC block in buildClauses(); if you add a
     * dimension to req.scope, add its predicate there too and keep
     * tests/job-export-filters.test.js green — that test is what turns this
     * comment into an enforced property instead of a hope.
     */
    const filters = { ...req.query, scope: req.scope, allowedStages: req.allowedStages };
    /*
     * ⚠ AND SAY WHEN WE NARROWED IT OURSELVES — *AFTER* `filters` EXISTS.
     *
     * An export with no bounding filter gets a default window (and, when the
     * caller pinned no status, the open-jobs floor). That is still a constraint
     * the operator did not ask for, and an unexplained short sheet is the
     * complaint that started this work, so it is logged on the request.
     *
     * THIS BLOCK SAT 25 LINES ABOVE THE `const filters` DECLARATION and read it
     * from the temporal dead zone: every single export threw
     * "ReferenceError: Cannot access 'filters' before initialization" and the
     * operator saw "Export failed: Internal Server Error". `const` is not
     * hoisted the way `var` is — reading it before its declaration line is a
     * throw, not undefined. Nothing caught it because the module still IMPORTS
     * cleanly (the TDZ only fires when the handler RUNS) and the export suite
     * exercises the service, never the route. Keep this below the declaration.
     */
    const imposed = buildExportWhere(filters).appliedDefaults || [];
    if (imposed.length) {
      logger.info('Jobs export applied DEFAULT bounds the operator did not ask for: ' + imposed.join(' · '));
    }

    let capped = false;

    async function* exportRows() {
      let afterJobId = null; // keyset cursor — null = first chunk
      let seq = 1;           // 1-based serial number column
      for (;;) {
        const chunk = await fetchExportChunk({ filters, afterJobId, chunkSize: EXPORT_CHUNK_SIZE });
        if (!Array.isArray(chunk) || chunk.length === 0) return;

        for (const raw of chunk) {
          if (seq > EXPORT_ROW_CEILING) {
            capped = true;
            logger.warn('Jobs export hit the ' + EXPORT_ROW_CEILING.toLocaleString('en-IN') + '-row safety ceiling — file truncated. Narrow the filters.');
            return;
          }
          yield mapExportRow(raw, seq++);
        }

        // Short chunk = last page. Advance the cursor otherwise.
        if (chunk.length < EXPORT_CHUNK_SIZE) return;
        afterJobId = chunk[chunk.length - 1].job_id;
      }
    }

    await streamRowsToXlsx(res, {
      filename: `ManageJobReport_${todayIst()}.xlsx`,
      sheetName: 'Report',
      columns: EXPORT_COLUMNS,
      rowSource: exportRows(),
      onFinish: ({ rowCount, elapsedMs }) => {
        logger.info('Jobs export finished · ' + rowCount.toLocaleString('en-IN') + ' rows in ' + elapsedMs + 'ms' + (capped ? ' (CAPPED)' : ''));
      },
    });
  } catch (e) {
    // Once bytes are on the wire the 200 + attachment headers are already
    // sent, so there is no JSON error to fall back to — streamRowsToXlsx has
    // logged the cause and destroyed the response. Handing it to next() here
    // would only make Express attempt a second, impossible send.
    // A failure on the FIRST chunk (nothing written yet) does NOT carry this
    // flag, so a dead DB still produces a normal JSON 500.
    if (e && e.xlsxStreamAborted) {
      logger.warn('Jobs export ended without a complete file after ' + (Date.now() - startedAt) + 'ms');
      return;
    }
    next(e);
  }
});

/*
 * GET /api/admin/jobs/counts
 * Returns status-bucket totals + grand total in ONE query. Replaces the
 * dashboard's 6 parallel list-with-limit-1 calls (which each spent 2 DB
 * connections on COUNT + data queries — ~12 concurrent connections just for
 * stats, enough to saturate a 20-connection pool when combined with /auth/me
 * and recent-jobs on the same page load). Single GROUP BY = 1 connection.
 */
/*
 * Accepts optional `?ownerId=<user_id>` to scope the buckets to jobs owned
 * by that user (drives the "My Orders" sidebar flow on the CRM). Invalid or
 * missing ownerId falls through to org-wide counts — same response shape,
 * different WHERE clause. Frontend passes `ownerId = currentUser.user_id`
 * when it detects `?scope=mine` on the URL.
 *
 * Also accepts the dashboard filter bar's four params — clientId, cityId,
 * projectManagerId, zonalManagerId, each an id or a CSV of ids — validated by
 * keys EXTRACTED from listQuery and applied with the very same SQL list() uses,
 * so a card's number and the grid the operator opens next agree. Sending none
 * of them leaves the response byte-identical to before, which is what keeps the
 * Navbar's unfiltered call sharing the dashboard's cache entry.
 */
/*
 * GET /api/admin/jobs/unconfirmed-sections?ids=1,2,3
 *
 * Which of the five My Orders -> Unconfirmed sections each job belongs to.
 * Deliberately a SEPARATE call rather than two derived columns on the generic
 * jobs list: that list feeds eleven tabs, and neither the subqueries nor the
 * reason-id lookup they need should be paid by ten tabs that never read the
 * answer.
 *
 * Mounted beside /counts because it is a one-segment static path and must be
 * declared before the bare `/:id` route below — Express matches in order, and
 * `idParam` would reject "unconfirmed-sections" as a non-integer.
 *
 * The membership rules and the precedence chain live in
 * services/client-request.service.js, so this page cannot drift from the writer
 * that creates the rows it groups on.
 */
/*
 * One page of the Unconfirmed tab, with headroom. Named rather than written
 * twice: the cap appeared in the check AND in the operator's message, and the
 * message-literal audit flagged it — correctly, even though the value it
 * collided with was unrelated. A limit spelt out in its own error text is one
 * edit away from telling the operator a number the code no longer enforces.
 */
const MAX_SECTION_IDS = 1000;

router.get('/unconfirmed-sections', async (req, res, next) => {
  try {
    const ids = String(req.query.ids || '').split(',')
      .map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return modernOk(res, { sections: {}, meta: clientRequest.SECTION_META });
    if (ids.length > MAX_SECTION_IDS) {
      return modernError(res, 400, `too many ids (max ${MAX_SECTION_IDS})`);
    }

    /*
     * ONE `today` for the whole response, in IST. Reading the clock per row
     * would let a request that straddles midnight put two identical jobs in
     * different sections; IST because the section a job sits in has to match
     * the date ops reads off the row.
     */
    // Required INSIDE the handler, as five sibling handlers in this file do.
    // There IS a module-scope `pool`, but it is declared ~1300 lines BELOW
    // this route; a bare reference happens to work only because `const` is
    // hoisted into the temporal dead zone and this body runs long after the
    // module finished evaluating. Depending on that across 1300 lines is
    // invisible to a reader and one reorder away from a ReferenceError, so
    // this follows the local convention instead.
    const { pool } = require('../../db');
    const todayYmd = new Date(Date.now() + (5.5 * 60 * 60 * 1000)).toISOString().slice(0, 10);
    const sections = await clientRequest.sectionsFor(pool, ids, todayYmd);
    modernOk(res, { sections, meta: clientRequest.SECTION_META, today: todayYmd });
  } catch (e) { next(e); }
});

/*
 * GET /api/admin/jobs/booking-queue?ownerId=
 *
 * Every number on the Booking-queue tile strip (My Orders -> Unconfirmed, the
 * new tab), in ONE query.
 *
 *   open.*              open orders per bucket. The five sum to `total`, and
 *                       each matches the grid's row count for that tile.
 *   days.<bucket>.*     that bucket split by ticket age: Day 0/1/2/3+, summing
 *                       to the bucket. '3plus' is three-or-MORE, so the oldest
 *                       orders have a pill instead of falling out of the sum.
 *   response_breakdown  what the customers who answered asked for.
 *   links_sent          how many of these orders have had a link go out.
 *
 * NO DATE WINDOW, deliberately: this route once defaulted to `period=today`,
 * and when the page stopped sending a period every tile silently read 0 while
 * 149 orders sat open. The age lives in the day pills now.
 *
 * The bucket definitions are NOT duplicated here: the same module supplies the
 * counts and the `bucket=` filter the grid below sends to GET /admin/jobs, so
 * a tile and its rows cannot describe different populations. Same reason the
 * RBAC row filter is job.jobScopeFragment rather than a second copy.
 */
router.get('/booking-queue', async (req, res, next) => {
  try {
    const ownerId = Number(req.query.ownerId);
    logger.info('Booking-queue counts · ownerId=' + (Number.isFinite(ownerId) ? ownerId : '-'));

    // Required inside the handler, as the sibling handlers in this file do.
    const { pool } = require('../../db');
    const { buildRequestScopeWithHierarchy } = require('../../lib/scope');
    const scope = await buildRequestScopeWithHierarchy(req, pool);
    const hasVerticalCol = await job.hasClientVerticalIdColumn();
    const frag = job.jobScopeFragment(
      { scope, allowedStages: req.allowedStages, hasVerticalCol }, 'j',
    );

    /*
     * THE SEARCH NARROWS THE TILES TOO (ops, 2026-09-25). Typing a client name
     * narrowed the rows while every tile kept the whole board's number, so the
     * strip stopped adding up to the list under it — the one thing these
     * counts exist to do.
     *
     * The predicate is job.searchClause(), the SAME builder the grid's own
     * WHERE uses, plus the joins that clause needs and this query does not
     * otherwise have.
     */
    const search = job.searchClause(req.query.q);
    const searchJoins = search.needsAliases.length ? `
      LEFT JOIN tbl_customer  cu ON cu.customer_id   = j.fk_customer_id
      LEFT JOIN tbl_client    cl ON cl.client_id     = j.fk_client_id
      LEFT JOIN tbl_address   adq ON adq.address_id  = j.fk_address_id
      LEFT JOIN tbl_city      ci ON ci.city_id       = adq.city_id
      LEFT JOIN tbl_easyfixer ef ON ef.efr_id        = j.fk_easyfixter_id
      LEFT JOIN tbl_user      ow ON ow.user_id       = j.job_owner` : '';

    const counts = await bookingQueue.counts({
      searchSql: search.sql,
      searchParams: search.params,
      searchJoins,
      ownerId: Number.isFinite(ownerId) ? ownerId : undefined,
      scopeSql: frag.clauses.join(' AND '),
      scopeParams: frag.params,
      scopeJoins: frag.joins,
      // Same probe the list route runs, so the tiles and the rows agree on
      // what "the customer answered" means.
      hasRequestTable: await job.customerRequestTableExists(),
    });
    modernOk(res, counts);
  } catch (e) { next(e); }
});

/*
 * The dashboard filter bar's four params, lifted off an ALREADY-VALIDATED query
 * in one place so /counts and /attention-summary cannot come to disagree about
 * which filters the dashboard has. DASHBOARD_FILTERS is the validator's own key
 * list, so a fifth filter added there reaches both endpoints at once — and a
 * key that is not in it has already been stripped by validate() before we get
 * here, so this can only ever pass through what the schema accepted.
 */
function dashboardFilters(query) {
  const out = {};
  for (const key of DASHBOARD_FILTERS) {
    if (query[key] != null && query[key] !== '') out[key] = query[key];
  }
  return out;
}

router.get('/counts', validate(dashboardCountsQuery, 'query'), async (req, res, next) => {
  try {
    const ownerId = req.query.ownerId ? Number(req.query.ownerId) : undefined;
    const filters = dashboardFilters(req.query);
    logger.info('Fetch job status counts · ownerId=' + (Number.isFinite(ownerId) ? ownerId : '-')
      + ' · dashFilters=' + (Object.keys(filters).length ? Object.keys(filters).join('+') : '-'));
    // Dashboard cards must respect the caller's RBAC scope (hierarchy-
    // unioned). req.scope is attached by the global admin middleware
    // (routes/admin/index.js). Admin/Finance get undefined → no row filter.
    // `filters` is the operator's own narrowing on top of that — it can only
    // subtract from what scope already allows, never add to it.
    const counts = await job.getStatusCounts({
      ownerId: Number.isFinite(ownerId) ? ownerId : undefined,
      scope: req.scope,
      allowedStages: req.allowedStages,
      filters,
    });
    modernOk(res, counts);
  } catch (e) { next(e); }
});

/*
 * GET /api/admin/jobs/pending-scheduling/counts
 *
 * The four tab counts above My Orders → Pending for Scheduling:
 *
 *   { all, pending, offered, expired }        all = pending + offered + expired
 *
 * The keys ARE the `offerState` values the list endpoint takes, so each tab is
 * one query-string change on the grid beneath it:
 *   all      → (no offerState)   the bucket, unfiltered
 *   pending  → offerState=pending   "Not offered"      nobody asked yet
 *   offered  → offerState=offered   "Offered-waiting"  an offer is still open
 *   expired  → offerState=expired   "No takers"        offered, none open
 *
 * Accepts the SAME filters the grid sends (q, categoryId, cityId, clientId,
 * zonalManagerId — validated by schemas extracted from listQuery itself) and
 * NOT offerState, which would collapse three of the four numbers to zero; the
 * schema drops it rather than 400ing a client that forwards its whole query
 * string. The bucket (status 0 + unassigned), the RBAC scope and Job Stage
 * Access are applied by the service through job.list()'s own WHERE, so the
 * strip and the page can never describe different populations.
 *
 * `all` is the sum of the three rather than a COUNT(*) — see
 * getPendingSchedulingCounts for the one row shape where those differ.
 *
 * Mounted beside /counts, i.e. ABOVE the bare `/:id` route: two static segments,
 * so `idParam` never sees "pending-scheduling" (the /counts, /escalated and
 * /export.xlsx gotcha).
 */
router.get('/pending-scheduling/counts', validate(pendingSchedulingCountsQuery, 'query'), async (req, res, next) => {
  try {
    logger.info('Fetch pending-for-scheduling tab counts · clientId=' + (req.query.clientId ?? '-')
      + ' cityId=' + (req.query.cityId ?? '-') + ' q=' + (req.query.q ? 'yes' : '-'));
    /*
     * req.scope — the hierarchy-unioned scope the global admin middleware
     * already built for THIS request (routes/admin/index.js), the same value
     * the list handler recomputes from the same function on the same request.
     * Admin/Finance get undefined → no row filter. Same source as the sibling
     * /counts and /attention-summary handlers.
     */
    const counts = await job.getPendingSchedulingCounts({
      ...req.query,
      scope: req.scope,
      allowedStages: req.allowedStages,
    });
    modernOk(res, counts);
  } catch (e) { next(e); }
});

/*
 * GET /api/admin/jobs/pending-start/counts
 *
 * The six tab counts above My Orders → Pending to Start:
 *
 *   { all, cancel, reschedule, missed, today, future }   all = sum of the five
 *
 * Each key (bar `all`) IS a `ptsState` value the list endpoint takes, so each
 * tab is one query-string change on the grid beneath it, and the five partition
 * status-1 jobs — every accepted job is counted in exactly one tab, in the
 * priority order cancel → reschedule → missed → today → future. Day boundaries
 * are IST, computed server-side. See ptsStateSql in services/job.service.js for
 * the predicates, and why a job with no appointment counts as `missed`.
 *
 * Accepts the grid's filters — q, categoryId, cityId, clientId, zonalManagerId,
 * ownerId — validated by schemas extracted from listQuery; NOT ptsState, which
 * the schema strips. Status 1, RBAC scope and Job Stage Access are applied by
 * the service through job.list()'s own WHERE, and the counts are ONE GROUP BY
 * whose CASE arms are the ptsState filter fragments, so a tab's number and the
 * rows that tab lists are the same SQL.
 *
 * Two static segments, mounted beside /counts and /pending-scheduling/counts,
 * above the bare `/:id` route.
 */
router.get('/pending-start/counts', validate(pendingStartCountsQuery, 'query'), async (req, res, next) => {
  try {
    logger.info('Fetch pending-to-start tab counts · clientId=' + (req.query.clientId ?? '-')
      + ' cityId=' + (req.query.cityId ?? '-') + ' ownerId=' + (req.query.ownerId ?? '-')
      + ' q=' + (req.query.q ? 'yes' : '-'));
    // req.scope: the hierarchy-unioned scope routes/admin/index.js built for
    // THIS request — the same source the pending-scheduling strip reads.
    const counts = await job.getPendingStartCounts({
      ...req.query,
      scope: req.scope,
      allowedStages: req.allowedStages,
    });
    modernOk(res, counts);
  } catch (e) { next(e); }
});

/*
 * GET /api/admin/jobs/attention-summary
 *
 * Drives the dashboard's "Orders Needing Immediate Attention" card —
 * replaces the older Recent Jobs widget which surfaced raw activity
 * rather than actionable items. Returns 5 operator-action counts in
 * one round-trip (runs the 5 sub-queries in parallel):
 *
 *   runningLate         booked/scheduled jobs past requested_date_time
 *   estimateApproved    quotations SPOC-approved, job not yet executing
 *   estimateRejected    quotations SPOC-rejected, ops follow-up needed
 *   pendingTechAccept   tech assigned but app-ack still pending
 *   customerUnreachable status=9 CALL_LATER bucket
 *
 * Sub-query failures are swallowed inside the service (returning 0 for
 * the failed metric + logging a warn) so a missing column doesn't
 * blank-out the whole card. Each tile on the FE deep-links to the
 * corresponding /jobs filter.
 *
 * Takes the dashboard filter bar's four params (clientId / cityId /
 * projectManagerId / zonalManagerId) on the same terms as /counts. The bar
 * drives BOTH dashboard rows, so every tile here narrows with the funnel cards
 * above it; a bar that filtered the cards while this card kept reporting
 * org-wide numbers would mislead on exactly the row operators act on.
 */
router.get('/attention-summary', validate(dashboardAttentionQuery, 'query'), async (req, res, next) => {
  try {
    // Takes the SAME four filters as /counts (see dashboardFilters above): the
    // bar drives both rows of the dashboard, so the tiles and the funnel cards
    // above them always describe the same slice.
    const filters = dashboardFilters(req.query);
    logger.info('Fetch attention summary · dashFilters='
      + (Object.keys(filters).length ? Object.keys(filters).join('+') : '-'));
    const data = await job.getAttentionSummary({
      scope: req.scope,
      allowedStages: req.allowedStages,
      filters,
    });
    modernOk(res, data);
  } catch (e) { next(e); }
});

/*
 * GET /api/admin/jobs/escalated
 *
 * Ported from legacy ACD action `getEscalatedJobs` (JobDaoImpl.java:4690).
 * Returns the same enriched shape the Angular Client Dashboard's
 * "Escalated Jobs" modal renders.
 *
 * Data sources (verified against legacy SQL):
 *   - tbl_easyfixer_rating_by_customer (alias e)  : the canonical
 *       escalation record. Columns: table_id, job_id, easyfixer_id,
 *       is_escalated (0/1), escalated_by (user_id FK), escalated_time,
 *       resolved_time, escalated_comments, no_of_escalations,
 *       escalated_from, completed_action, inprogress_action,
 *       closed_action, escalation_closed_time.
 *   - tbl_job_escalation_info (alias i)           : per-stage history.
 *       Aggregated into job_stage (CSV of "date + stage") so each row
 *       shows where the job sat at each escalation moment.
 *   - tbl_job (j), tbl_address (a), tbl_city (c), tbl_client (cl),
 *     tbl_user (u) — joined for client name, city, owner, etc.
 *
 * Filter param `status` ∈ {open, closed, pending}:
 *   - open    : escalated_time IS NOT NULL AND
 *               (resolved_time IS NULL OR escalated_time > resolved_time
 *                OR closed_action = 16)
 *   - closed  : escalated_time + resolved_time + escalation_closed_time
 *               all NOT NULL AND closed_action != 16
 *   - pending : escalated > resolved, no closed_action=15
 *
 * RBAC: respects req.scope (clients × cities × verticals).
 */
router.get('/escalated', async (req, res, next) => {
  try {
    const status = String(req.query.status || 'open').toLowerCase();
    const q = String(req.query.q || '').trim();
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    logger.info('List escalated jobs · status=' + status + ' q="' + q + '" limit=' + limit + ' offset=' + offset);

    const clauses = ['e.is_escalated = 1', 'e.escalated_time IS NOT NULL'];
    const params = [];

    if (status === 'open') {
      clauses.push('(e.resolved_time IS NULL OR e.escalated_time > e.resolved_time OR e.closed_action = 16)');
    } else if (status === 'closed') {
      clauses.push('e.resolved_time IS NOT NULL');
      clauses.push('e.escalation_closed_time IS NOT NULL');
      clauses.push('(e.closed_action IS NULL OR e.closed_action != 16)');
    } else if (status === 'pending') {
      clauses.push('e.resolved_time IS NOT NULL');
      clauses.push('e.escalated_time < e.resolved_time');
      clauses.push('(e.escalation_closed_time IS NULL OR e.closed_action != 15)');
    }

    if (q) {
      clauses.push('(j.job_id = ? OR cl.client_name LIKE ? OR c.city_name LIKE ?)');
      params.push(Number(q) || 0, `%${q}%`, `%${q}%`);
    }

    // RBAC scope — same shape as the main list. We only filter when scope
    // is set; Admin/Finance bypass via the lib/scope.js bypass list.
    const sc = req.scope;
    if (sc) {
      if (sc.clients) {
        if (sc.clients.mode === 'none') clauses.push('1=0');
        else if (sc.clients.mode === 'allow' && sc.clients.ids.length) {
          clauses.push(`j.fk_client_id IN (${sc.clients.ids.map(() => '?').join(',')})`);
          params.push(...sc.clients.ids);
        }
      }
      if (sc.cities) {
        if (sc.cities.mode === 'none') clauses.push('1=0');
        else if (sc.cities.mode === 'allow' && sc.cities.ids.length) {
          clauses.push(`a.city_id IN (${sc.cities.ids.map(() => '?').join(',')})`);
          params.push(...sc.cities.ids);
        }
      }
      if (sc.verticals) {
        if (sc.verticals.mode === 'none') clauses.push('1=0');
        else if (sc.verticals.mode === 'allow' && sc.verticals.ids.length) {
          // Guarded: only emit the WHERE clause when tbl_client.vertical_id
          // actually exists on this DB. Same probe as services/job.service.js.
          if (await job.hasClientVerticalIdColumn()) {
            clauses.push(`cl.vertical_id IN (${sc.verticals.ids.map(() => '?').join(',')})`);
            params.push(...sc.verticals.ids);
          }
        }
      }
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    // Aggregated job_stage subquery — for each job, concatenates every
    // (escalation_time, job_stage) pair from tbl_job_escalation_info.
    // Mirrors the legacy group_concat in JobDaoImpl line 4705.
    const baseFrom = `
      FROM tbl_easyfixer_rating_by_customer e
      LEFT JOIN tbl_job     j  ON j.job_id = e.job_id
      LEFT JOIN tbl_address a  ON a.address_id = j.fk_address_id
      LEFT JOIN tbl_city    c  ON c.city_id = a.city_id
      LEFT JOIN tbl_client  cl ON cl.client_id = j.fk_client_id
      LEFT JOIN tbl_user    u  ON u.user_id = e.escalated_by
      LEFT JOIN (
        SELECT job_id,
               GROUP_CONCAT(
                 CONCAT(
                   DATE_FORMAT(escalation_time, '%d %M %Y %h:%i %p'),
                   ' · ', COALESCE(job_stage, '—')
                 )
                 ORDER BY escalation_time
                 SEPARATOR ' / '
               ) AS job_stage_history
          FROM tbl_job_escalation_info
         GROUP BY job_id
      ) j1 ON j1.job_id = j.job_id
    `;

    const { pool } = require('../../db');
    const [rows] = await pool.query(
      `SELECT
         e.table_id, e.job_id, j.job_status, j.fk_easyfixter_id,
         e.escalated_time, e.resolved_time, e.escalation_closed_time,
         e.escalated_by, u.user_name AS escalated_by_name,
         e.escalated_comments, e.no_of_escalations, e.escalated_from,
         e.closed_action, e.completed_action, e.inprogress_action,
         j.requested_date_time, j.job_reference_id, j.client_ref_id, j.sub_job_id,
         cl.client_name, c.city_name,
         j1.job_stage_history
       ${baseFrom}
       ${where}
       ORDER BY e.escalated_time DESC, e.table_id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total ${baseFrom} ${where}`, params
    );
    logger.info('Returning ' + rows.length + ' escalated jobs (total=' + total + ')');
    modernOk(res, { items: rows, total, limit, offset });
  } catch (e) { next(e); }
});

/*
 * GET /api/admin/jobs/escalated/export.xlsx
 *
 * Styled XLSX export of the escalated-jobs list. Same SQL as the list
 * endpoint above (JOINs + status filter + RBAC scope) — only the
 * pagination is dropped: the export always returns the entire status-
 * filtered set up to a 5,000-row safety ceiling.
 *
 * Filter param `status` ∈ {open, closed, pending}. Free-text `q` is
 * intentionally NOT honoured here — the FE search box is a UI-only
 * filter over the loaded page (matches the CallInfoModal contract:
 * "exports reflect the dataset the operator asked the BACKEND for,
 * not the in-table search").
 *
 * Output shape is hand-translated for readability — action enums →
 * human labels, escalated duration humanised, date/time split into
 * two columns. The styled workbook uses the shared
 * utils/xlsx-styled-export recipe so the brand band, header band, and
 * row banding match Call History.
 */
router.get('/escalated/export.xlsx', async (req, res, next) => {
  try {
    const status = String(req.query.status || 'open').toLowerCase();
    logger.info('Export escalated jobs xlsx · status=' + status);

    const clauses = ['e.is_escalated = 1', 'e.escalated_time IS NOT NULL'];
    const params = [];

    if (status === 'open') {
      clauses.push('(e.resolved_time IS NULL OR e.escalated_time > e.resolved_time OR e.closed_action = 16)');
    } else if (status === 'closed') {
      clauses.push('e.resolved_time IS NOT NULL');
      clauses.push('e.escalation_closed_time IS NOT NULL');
      clauses.push('(e.closed_action IS NULL OR e.closed_action != 16)');
    } else if (status === 'pending') {
      clauses.push('e.resolved_time IS NOT NULL');
      clauses.push('e.escalated_time < e.resolved_time');
      clauses.push('(e.escalation_closed_time IS NULL OR e.closed_action != 15)');
    }

    // Same RBAC clauses as the list endpoint — keep these in sync if
    // either is ever changed. (Pulling into a helper is overkill until
    // a third escalation route appears.)
    const sc = req.scope;
    if (sc) {
      if (sc.clients) {
        if (sc.clients.mode === 'none') clauses.push('1=0');
        else if (sc.clients.mode === 'allow' && sc.clients.ids.length) {
          clauses.push(`j.fk_client_id IN (${sc.clients.ids.map(() => '?').join(',')})`);
          params.push(...sc.clients.ids);
        }
      }
      if (sc.cities) {
        if (sc.cities.mode === 'none') clauses.push('1=0');
        else if (sc.cities.mode === 'allow' && sc.cities.ids.length) {
          clauses.push(`a.city_id IN (${sc.cities.ids.map(() => '?').join(',')})`);
          params.push(...sc.cities.ids);
        }
      }
      if (sc.verticals) {
        if (sc.verticals.mode === 'none') clauses.push('1=0');
        else if (sc.verticals.mode === 'allow' && sc.verticals.ids.length) {
          // Guarded: only emit the WHERE clause when tbl_client.vertical_id
          // actually exists on this DB. Same probe as services/job.service.js.
          if (await job.hasClientVerticalIdColumn()) {
            clauses.push(`cl.vertical_id IN (${sc.verticals.ids.map(() => '?').join(',')})`);
            params.push(...sc.verticals.ids);
          }
        }
      }
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const baseFrom = `
      FROM tbl_easyfixer_rating_by_customer e
      LEFT JOIN tbl_job     j  ON j.job_id = e.job_id
      LEFT JOIN tbl_address a  ON a.address_id = j.fk_address_id
      LEFT JOIN tbl_city    c  ON c.city_id = a.city_id
      LEFT JOIN tbl_client  cl ON cl.client_id = j.fk_client_id
      LEFT JOIN tbl_user    u  ON u.user_id = e.escalated_by
      LEFT JOIN (
        SELECT job_id,
               GROUP_CONCAT(
                 CONCAT(
                   DATE_FORMAT(escalation_time, '%d %M %Y %h:%i %p'),
                   ' · ', COALESCE(job_stage, '—')
                 )
                 ORDER BY escalation_time
                 SEPARATOR ' / '
               ) AS job_stage_history
          FROM tbl_job_escalation_info
         GROUP BY job_id
      ) j1 ON j1.job_id = j.job_id
    `;

    const { pool } = require('../../db');
    const [rows] = await pool.query(
      `SELECT
         e.table_id, e.job_id, j.job_status, j.fk_easyfixter_id,
         e.escalated_time, e.resolved_time, e.escalation_closed_time,
         e.escalated_by, u.user_name AS escalated_by_name,
         e.escalated_comments, e.no_of_escalations, e.escalated_from,
         e.closed_action, e.completed_action, e.inprogress_action,
         j.requested_date_time,
         cl.client_name, c.city_name,
         j1.job_stage_history
       ${baseFrom}
       ${where}
       ORDER BY e.escalated_time DESC, e.table_id DESC
       LIMIT 5000`,
      params
    );
    logger.info('Found ' + rows.length + ' escalated jobs for export · status=' + status);

    // Enum-to-label maps mirror the FE's TEAM_ACTIONS / COMPLETED_ACTIONS /
    // CLOSED_ACTIONS in EscalatedJobsModal.tsx. If either list changes,
    // both ends need updating — the values are stamped legacy enums
    // from escalateSearchResult.vm so they shouldn't drift.
    const TEAM_LABEL = {
      1: 'Easy Fixer is Scheduled',
      2: 'Convinced Customer For New Date',
      3: 'Pending from client',
      4: 'Fake Reschedule & OTA expected',
      5: 'Customer Reschedule',
    };
    const COMPLETED_LABEL = {
      11: 'Work Completed',
      12: 'Grievance Resolved & on-the-same-page',
    };
    const CLOSED_LABEL = { 15: 'Resolved', 16: 'Re-Open' };
    const STATUS_LABEL = {
      0: 'Booked', 1: 'Scheduled', 2: 'In Progress',
      3: 'Completed', 5: 'Completed', 6: 'Cancelled',
      7: 'Enquiry', 9: 'Unconfirmed', 10: 'Revisit',
      15: 'Estimate Pending', 16: 'Pending for Material', 20: 'Pending to Close', 21: 'Followup',
    };

    // Humanise an ISO/MySQL DATETIME → "29 Apr 2026" and "10:07 am"
    // pieces so the XLSX shows the same two-line layout the modal does.
    function dateOnly(d) {
      if (!d) return '';
      const dt = new Date(d);
      if (Number.isNaN(+dt)) return String(d);
      return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    }
    function timeOnly(d) {
      if (!d) return '';
      const dt = new Date(d);
      if (Number.isNaN(+dt)) return '';
      return dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true });
    }
    /*
     * "Now" as an IST WALL-CLOCK string — the same 'YYYY-MM-DD HH:MM:SS' shape
     * mysql2 hands back for a DATETIME (the pool runs `dateStrings: true`).
     *
     * WHY THIS EXISTS. `new Date('2026-08-03 16:02:29')` parses a space-separated
     * datetime as SERVER LOCAL time. When BOTH ends of a duration come from the
     * database that is harmless — both are misread by the same offset and it
     * cancels. It stops cancelling the moment one end is a real instant:
     * `new Date()` is the true now, while the stored end has been shifted.
     *
     * Measured on the actual code, for an escalation raised 3 hours ago:
     *     container TZ=Asia/Kolkata → 180 mins  ✅
     *     container TZ=UTC          →   0 mins  ❌   (production runs UTC)
     * `Math.max(0, …)` clamps the negative result, so an unresolved escalation
     * reads "0 mins" for its first five and a half hours and understates by
     * 5h30m for ever after — silently, since 0 is a plausible-looking answer.
     *
     * Formatting through Intl with an explicit timeZone (rather than adding
     * 5.5h to a Date) follows the same rule as services/quicksight/_shared.js
     * istToday(): never do timezone arithmetic on a Date, because it runs in the
     * server's own zone. 'sv-SE' is used only because its locale format IS
     * 'YYYY-MM-DD HH:MM:SS'.
     */
    function istNowWallClock() {
      return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' });
    }
    function durationLabel(start, end) {
      if (!start) return '';
      const s = new Date(start);
      if (Number.isNaN(+s)) return '';
      // Both ends must be read in the SAME frame — see istNowWallClock above.
      const e = new Date(end || istNowWallClock());
      const ms = Math.max(0, +e - +s);
      const totalMins = Math.floor(ms / 60000);
      const days = Math.floor(totalMins / (60 * 24));
      const hours = Math.floor((totalMins % (60 * 24)) / 60);
      const mins = totalMins % 60;
      if (days > 0) return `${days} day${days === 1 ? '' : 's'} ${hours} hour${hours === 1 ? '' : 's'}`;
      if (hours > 0) return `${hours} hour${hours === 1 ? '' : 's'} ${mins} min${mins === 1 ? '' : 's'}`;
      return `${mins} min${mins === 1 ? '' : 's'}`;
    }

    const xlsxRows = rows.map((r) => ({
      date_escalated:  dateOnly(r.escalated_time),
      time_escalated:  timeOnly(r.escalated_time),
      job_id:          r.job_id ?? '',
      client:          r.client_name || '',
      city:            r.city_name || '',
      job_stage:       r.job_stage_history || '',
      current_status:  r.job_status != null
        ? (STATUS_LABEL[r.job_status] || `Status ${r.job_status}`)
        : '',
      no_of_escal:     r.no_of_escalations ?? 0,
      escalated_from:  r.escalated_from || '',
      reason:          r.escalated_comments || '',
      escalated_by:    r.escalated_by_name || '',
      team_action:      TEAM_LABEL[r.inprogress_action] || '',
      completed_action: COMPLETED_LABEL[r.completed_action] || '',
      closed_action:    CLOSED_LABEL[r.closed_action] || '',
      escalated_hours:  durationLabel(r.escalated_time, r.resolved_time),
      orig_appt_date:   r.requested_date_time ? dateOnly(r.requested_date_time) : '',
      orig_appt_time:   r.requested_date_time ? timeOnly(r.requested_date_time) : '',
      reopened:         (r.no_of_escalations ?? 0) > 1 ? 'Yes' : '',
    }));

    const today = new Date().toISOString().slice(0, 10);
    const statusTitle = status.charAt(0).toUpperCase() + status.slice(1);
    const meta = [
      `Status: ${statusTitle}`,
      `Generated: ${new Date().toLocaleString('en-IN')}`,
      `Total: ${xlsxRows.length} escalation${xlsxRows.length === 1 ? '' : 's'}`,
    ].join('    ·    ');

    await streamStyledXlsx(res, `escalated-jobs_${status}_${today}.xlsx`, {
      title: 'EasyFix  ·  Escalated Jobs',
      meta,
      sheetName: 'Escalated Jobs',
      columns: [
        { header: 'Date Escalated',          key: 'date_escalated',   width: 14, align: 'left' },
        { header: 'Time Escalated',          key: 'time_escalated',   width: 12, align: 'center' },
        { header: 'Job ID',                  key: 'job_id',           width: 10, align: 'center' },
        { header: 'Client',                  key: 'client',           width: 24, align: 'left' },
        { header: 'City',                    key: 'city',             width: 16, align: 'left' },
        { header: 'Job Stage',               key: 'job_stage',        width: 42, align: 'left' },
        { header: 'Current Status',          key: 'current_status',   width: 14, align: 'center' },
        { header: 'No of Escalations',       key: 'no_of_escal',      width: 12, align: 'center' },
        { header: 'Escalated From',          key: 'escalated_from',   width: 16, align: 'left' },
        { header: 'Reason For Escalation',   key: 'reason',           width: 42, align: 'left' },
        { header: 'Escalated By',            key: 'escalated_by',     width: 20, align: 'left' },
        { header: 'Team Action',             key: 'team_action',      width: 28, align: 'left' },
        { header: 'Completed Action',        key: 'completed_action', width: 30, align: 'left' },
        { header: 'Closed Action',           key: 'closed_action',    width: 14, align: 'center' },
        { header: 'Escalated Hours',         key: 'escalated_hours',  width: 18, align: 'left' },
        { header: 'Original Appointment Date', key: 'orig_appt_date', width: 14, align: 'left' },
        { header: 'Original Appointment Time', key: 'orig_appt_time', width: 12, align: 'center' },
        { header: 'Reopened',                key: 'reopened',         width: 10, align: 'center' },
      ],
      rows: xlsxRows,
      emptyMessage: `No ${status} escalations found.`,
    });
  } catch (e) { next(e); }
});

/*
 * PATCH /api/admin/jobs/escalated/:tableId
 *
 * Updates one escalation workflow row (`tbl_easyfixer_rating_by_customer`).
 * Drives the inline Team Action / Completed Action / Closed Action +
 * Comment controls in the EscalatedJobsModal. Allowed fields:
 *
 *   inprogress_action : 1..5 (Team Action enum, legacy values from
 *                       escalateSearchResult.vm:64-71)
 *   completed_action  : 11..12 (Completed Action enum)
 *   closed_action     : 15 (Resolved) | 16 (Re-Open)
 *   escalated_comments: free text appended/replaced (legacy let
 *                       supply team add an inline comment per row)
 *
 * When closed_action transitions to 15 (Resolved), also stamp
 * escalation_closed_time. When set to 16 (Re-Open), clear the closed_time
 * so the row goes back to the "open" filter.
 */
router.patch('/escalated/:tableId', async (req, res, next) => {
  try {
    const { pool } = require('../../db');
    const tableId = Number(req.params.tableId);
    if (!Number.isInteger(tableId) || tableId <= 0) {
      return modernError(res, 400, 'invalid tableId');
    }
    logger.info('Update escalation row · tableId=' + tableId);
    const sets = [];
    const params = [];
    const b = req.body || {};

    // Team Action — `inprogress_action` column.
    if (b.inprogress_action !== undefined) {
      const v = Number(b.inprogress_action);
      if (!Number.isInteger(v) || v < 0 || v > 5) {
        return modernError(res, 400, 'inprogress_action must be 0..5');
      }
      sets.push('inprogress_action = ?');
      params.push(v || null);
    }
    // Completed Action.
    if (b.completed_action !== undefined) {
      const v = Number(b.completed_action);
      if (!Number.isInteger(v) || (v !== 0 && v !== 11 && v !== 12)) {
        return modernError(res, 400, 'completed_action must be 11 or 12');
      }
      sets.push('completed_action = ?');
      params.push(v || null);
    }
    // Closed Action — also stamps / clears escalation_closed_time.
    if (b.closed_action !== undefined) {
      const v = Number(b.closed_action);
      if (!Number.isInteger(v) || (v !== 0 && v !== 15 && v !== 16)) {
        return modernError(res, 400, 'closed_action must be 15 (Resolved) or 16 (Re-Open)');
      }
      sets.push('closed_action = ?');
      params.push(v || null);
      if (v === 15) {
        const closedAt = new Date();
        sets.push('escalation_closed_time = ?');
        params.push(closedAt);
        // also mark resolved_time so the "closed" filter picks it up
        sets.push('resolved_time = COALESCE(resolved_time, ?)');
        params.push(closedAt);
      } else if (v === 16) {
        // Re-Open: clear closed_time + bump no_of_escalations so the
        // row falls back into the "open" filter. Legacy did the same.
        sets.push('escalation_closed_time = NULL');
        sets.push('no_of_escalations = COALESCE(no_of_escalations, 0) + 1');
        sets.push('escalated_time = ?');
        params.push(new Date());
      }
    }
    if (b.escalated_comments !== undefined) {
      const txt = String(b.escalated_comments || '').slice(0, 2000);
      sets.push('escalated_comments = ?');
      params.push(txt || null);
    }
    if (sets.length === 0) {
      return modernError(res, 400, 'no editable fields supplied');
    }
    params.push(tableId);
    const [r] = await pool.query(
      `UPDATE tbl_easyfixer_rating_by_customer SET ${sets.join(', ')} WHERE table_id = ?`,
      params
    );
    if (r.affectedRows === 0) {
      logger.warn('Escalation row not found · tableId=' + tableId);
      return modernError(res, 404, 'escalation row not found');
    }
    logger.info('Escalation updated · tableId=' + tableId + ' fields=' + sets.length);
    modernOk(res, { updated: true });
  } catch (e) { next(e); }
});

/*
 * GET /api/admin/jobs/comment-reasons?dueTo=customer|client|easyfix|technician
 *
 * Reason list for the legacy "Job CheckOut Remarks" popup
 * (surfaced as the "Add Remarks" button on the Job Transaction view).
 *
 * Source-of-truth (confirmed by ops 2026-05-19):
 *   SELECT * FROM action_taken_reason WHERE action_type = 5 AND user_type = ?
 *
 *   action_type = 5 is the legacy Job CheckOut bucket (its `type`
 *   column literally reads 'test' but it IS the right bucket — verified
 *   by exact-label match against the legacy dropdown screenshot).
 *
 *   user_type is tied 1:1 to the operator's "Open Due To" radio:
 *     user_type = 1 → Customer   (e.g. "Customer is not responding")
 *     user_type = 2 → Client     (e.g. "Phone not reachable",
 *                                  "Reschedule – CX request")
 *     user_type = 3 → EasyFix    (e.g. "Spare not available",
 *                                  "Pending Authorisation")
 *     user_type = 4 → Technician (e.g. "Tx No-Show",
 *                                  "Estimate not received from Technician")
 *
 *   The FE refetches whenever the radio changes so the dropdown
 *   narrows to the bucket the operator just picked. If no `dueTo`
 *   query param is supplied we default to user_type=2 (Client) to
 *   match what legacy shows on initial popup mount.
 *
 * Route-order: declared BEFORE `/:id` (same gotcha as /transaction,
 * /action-reasons, /escalated).
 */
// DUE_TO_USER_TYPE + ACTION_TYPE_BY_MODE now live in services/reason-codes.js
// — promoted from this file 2026-06-04 so cross-tier callers share one map.
const {
  DUE_TO_USER_TYPE, ACTION_TYPE_BY_MODE, ACTION_TYPE, DUE_TO_ANY, MODES_ALLOWING_DUE_TO_ANY,
} = require('../../services/reason-codes');

router.get('/comment-reasons', async (req, res, next) => {
  try {
    const dueRaw = String(req.query.dueTo || '').toLowerCase().replace(/\s+/g, '');
    const userType = DUE_TO_USER_TYPE[dueRaw] || 2; // default = Customer (user_type 2); matches the pre-checked "By Customer" radio
    logger.info('Fetch comment reasons · dueTo=' + (dueRaw || '-') + ' userType=' + userType);
    const [rows] = await imagePool.query(
      `SELECT id, action_desc FROM action_taken_reason
        WHERE action_type = ? AND user_type = ?
              AND (status IS NULL OR status = 1)
        ORDER BY id ASC`,
      [ACTION_TYPE.ADD_REMARKS, userType]
    );
    const items = rows
      .map((r) => ({ id: r.id, label: String(r.action_desc || '').trim() }))
      .filter((x) => x.label);
    logger.info('Returning ' + items.length + ' comment reasons');
    modernOk(res, items);
  } catch (e) { next(e); }
});

/*
 * GET /api/admin/jobs/cancel-reasons?dueTo=customer|client|easyfix|technician
 *
 * Reason list for the Cancel Job popup — the cancel-flow twin of
 * /comment-reasons. Reads action_taken_reason WHERE action_type = 1 (the Cancel
 * bucket, ACTION_TYPE.CANCEL) AND user_type = the "Cancellation Due To" radio,
 * so the dropdown narrows as the operator switches the radio (same as Add
 * Remarks). The picked id lands in tbl_job.enum_reason_id + the tbl_job_comment
 * audit row on submit. Default user_type = 1 (EasyFix) — CRM-staff-initiated
 * cancel. Replaces the deprecated tbl_cancel_reason source.
 * Route-order: declared BEFORE `/:id`.
 */
router.get('/cancel-reasons', async (req, res, next) => {
  try {
    const dueRaw = String(req.query.dueTo || '').toLowerCase().replace(/\s+/g, '');
    const userType = DUE_TO_USER_TYPE[dueRaw] || 1; // default = EasyFix (user_type 1)
    logger.info('Fetch cancel reasons · dueTo=' + (dueRaw || '-') + ' userType=' + userType);
    // is_new = MAX(is_new) → "curated-else-legacy": prefer the curated new set
    // (is_new=1), but fall back to the migrated legacy rows (is_new=0) for any
    // bucket that has NO curated rows. A blanket `AND is_new = 1` would EMPTY
    // such a bucket (the documented action_taken_reason gotcha — e.g. reschedule
    // has only is_new=0 rows), which for a mandatory reason dropdown = a dead
    // Cancel flow. The correlated subquery keeps this per (action_type,user_type).
    const [rows] = await imagePool.query(
      `SELECT id, action_desc FROM action_taken_reason ar
        WHERE action_type = ? AND user_type = ?
              AND (status IS NULL OR status = 1)
              AND is_new = (
                SELECT MAX(is_new) FROM action_taken_reason
                 WHERE action_type = ar.action_type AND user_type = ar.user_type
                       AND (status IS NULL OR status = 1)
              )
        ORDER BY id ASC`,
      [ACTION_TYPE.CANCEL, userType]
    );
    const items = rows
      .map((r) => ({ id: r.id, label: String(r.action_desc || '').trim() }))
      .filter((x) => x.label);
    logger.info('Returning ' + items.length + ' cancel reasons');
    modernOk(res, items);
  } catch (e) { next(e); }
});

/*
 * GET /api/admin/jobs/:id/transaction
 *
 * Read-only, all-data payload for the legacy "Job Transaction" view
 * surfaced on Unconfirmed orders in CRM_UI. Wraps `getById` and
 * enriches with feedback, comments, quotations, scheduling history,
 * reschedule count, decoded enum reasons, and images-bucketed-by-stage.
 *
 * Route order: declared BEFORE `/:id` so Express doesn't capture the
 * literal "transaction" segment as a job id and try to validate it
 * against `idParam` (same gotcha as `/escalated`, `/action-reasons`,
 * `/bulk` in auto-assign).
 *
 * Defensive: each enrichment runs in its own try/catch via
 * Promise.allSettled. A failing sub-query logs a warn and yields the
 * neutral fallback (`[]` / `null`) — the page can render every other
 * section even if (e.g.) `quotation_details` is empty.
 *
 * Schema notes (verified 2026-05-19 against easyfix DB):
 *   scheduling_history columns: id, job_id, schedule_time, easyfixer_id,
 *                                reason_id, reschedule_reason
 *   quotation_details   columns: id, job_id, name, type, status (bit),
 *                                sent_on, sent_by, ... (no `attachment`)
 *   tbl_job_image       columns: image_id, job_id, job_stage (int),
 *                                image_category (text), image, ...
 *   tbl_customer_feedback: feedback_id, job_id, easyfixer_rating,
 *                          easyfix_rating, happy_with_service, ...
 */
router.get('/:id/transaction', validate(idParam, 'params'), scopedJob, async (req, res, next) => {
  const jobId = Number(req.params.id);
  try {
    logger.info('Fetch job transaction view · jobId=' + jobId);
    const detail = req.scopedJob; // populated by `scopedJob` middleware

    // Image-stage bucketing key. Prefer the text `image_category`
    // column when it carries a recognisable label; fall back to the
    // numeric `job_stage` enum. Buckets that don't appear in the rows
    // stay as `[]` in the response.
    const STAGE_MAP = {
      0: 'start_job',     start_job: 'start_job',
      1: 'site_inspection', site_inspection: 'site_inspection', siteinspection: 'site_inspection',
      2: 'job_sheet',     job_sheet: 'job_sheet', jobsheet: 'job_sheet',
      3: 'material_used', material_used: 'material_used', material: 'material_used',
      4: 'signature',     signature: 'signature', cx_sign: 'signature', cxsign: 'signature',
      5: 'checkout',      checkout: 'checkout', checkin: 'start_job',
    };
    /*
     * Before/after comes from the SHARED classifier (utils/job-image-buckets),
     * so 'booking' / 'unconfirmed' / 'completion' land in the right tile here
     * by their own label instead of by the numeric fallback below — the same
     * fallback that put a feedback PDF in the technician app's "after photos".
     * The remaining five-way stage buckets stay local: they are the CRM's own
     * taxonomy, not a proof-of-work question.
     */
    const bucketFor = (row) => {
      const proof = proofBucketOf(row);
      if (proof) return proof === 'after' ? 'checkout' : 'start_job';
      const cat = String(row.image_category || '').toLowerCase().replace(/\s+/g, '_');
      if (cat && STAGE_MAP[cat]) return STAGE_MAP[cat];
      const st = Number(row.job_stage);
      return STAGE_MAP[st] || 'start_job';
    };

    const [
      feedbackRes, commentsRes, quotesRes, rescheduleCountRes,
      imagesRes, openReasonRes, revisitReasonRes, historyRes,
    ] = await Promise.allSettled([
      // feedback
      require('../../services/job-feedback.service').getFeedback(jobId),
      // comments
      require('../../services/job-comment.service').listComments(jobId),
      // quotations
      imagePool.query(
        `SELECT id, job_id, name, type, status, sent_on, action_on, client_charge, easyfxer_id AS easyfixer_id
           FROM quotation_details WHERE job_id = ? ORDER BY id DESC`,
        [jobId]
      ),
      // reschedule count
      imagePool.query(
        `SELECT COUNT(*) AS c FROM scheduling_history
          WHERE job_id = ? AND reschedule_reason IS NOT NULL AND reschedule_reason <> ''`,
        [jobId]
      ),
      // images (we'll bucket below)
      imagePool.query(
        `SELECT image_id, job_id, job_stage, image_category, image, created_date
           FROM tbl_job_image WHERE job_id = ? ORDER BY image_id ASC`,
        [jobId]
      ),
      // open job reason (decode enquiry_reason_id)
      detail?.enquiry_reason_id
        ? imagePool.query(
            'SELECT enum_desc FROM tbl_enum_reason WHERE enum_id = ? LIMIT 1',
            [detail.enquiry_reason_id]
          )
        : Promise.resolve([[]]),
      // revisit reason (decode revisit_reason_id)
      detail?.revisit_reason_id
        ? imagePool.query(
            'SELECT enum_desc FROM tbl_enum_reason WHERE enum_id = ? LIMIT 1',
            [detail.revisit_reason_id]
          )
        : Promise.resolve([[]]),
      // scheduling history — no fk_scheduled_by column; just enumerate
      // (sub-)schedules and the easyfixer they targeted.
      imagePool.query(
        `SELECT sh.id AS table_id, sh.job_id, sh.schedule_time AS scheduled_date_time,
                sh.easyfixer_id, sh.reason_id, sh.reschedule_reason,
                ef.efr_name AS easyfixer_name
           FROM scheduling_history sh
           LEFT JOIN tbl_easyfixer ef ON ef.efr_id = sh.easyfixer_id
          WHERE sh.job_id = ?
          ORDER BY sh.schedule_time DESC, sh.id DESC`,
        [jobId]
      ),
    ]);

    function safe(res, fallback, label) {
      if (res.status === 'fulfilled') return res.value;
      uploadLogger.warn({ err: res.reason?.message, label, jobId }, 'job/transaction enrichment failed');
      return fallback;
    }

    const feedback = safe(feedbackRes, null, 'feedback');
    const comments = safe(commentsRes, [], 'comments');
    const quotesRows = safe(quotesRes, [[]], 'quotations')[0] || [];
    const rescheduleRows = safe(rescheduleCountRes, [[]], 'rescheduleCount')[0] || [];
    const imageRows = safe(imagesRes, [[]], 'images')[0] || [];
    const openRows = safe(openReasonRes, [[]], 'open_reason')[0] || [];
    const revisitRows = safe(revisitReasonRes, [[]], 'revisit_reason')[0] || [];
    const historyRows = safe(historyRes, [[]], 'scheduling_history')[0] || [];

    // Quotation status is BIT(1) → boolean after the typeCast in db.js.
    // Render as a human label so the FE doesn't need to know the codes.
    const quotations = quotesRows.map((q) => ({
      id: q.id,
      attachment: q.name || null, // legacy stored the filename in `name`
      type: q.type || null,
      date: q.sent_on || q.action_on || null,
      status: q.status === true ? 'Approved' : q.status === false ? 'Pending' : null,
      easyfixer_id: q.easyfixer_id || null,
      client_charge: q.client_charge ?? null,
    }));

    // Bucket images by stage. Empty buckets retained so the FE always
    // has the same key set to read against — fewer null guards.
    const images_by_stage = {
      start_job: [], site_inspection: [], job_sheet: [],
      material_used: [], signature: [], checkout: [],
    };
    for (const r of imageRows) {
      const k = bucketFor(r);
      if (!images_by_stage[k]) images_by_stage[k] = [];
      images_by_stage[k].push(r);
    }

    logger.info('Returning job transaction view · jobId=' + jobId + ' comments=' + comments.length + ' quotations=' + quotations.length + ' images=' + imageRows.length + ' history=' + historyRows.length);
    modernOk(res, {
      job: detail,
      feedback,
      rescheduledCount: Number(rescheduleRows[0]?.c || 0),
      quotations,
      comments,
      images_by_stage,
      open_job_reason: openRows[0]?.enum_desc || null,
      revisit_reason: revisitRows[0]?.enum_desc || null,
      scheduling_history: historyRows,
    });
  } catch (e) { next(e); }
});

/*
 * GET /api/admin/jobs/action-reasons?type=<unreachable|enquiry>&dueTo=<customer|client|easyfix|technician>
 *
 * Drives the dropdown inside the Confirm & Schedule "Job Unreachable" /
 * "Job Enquiry" popup (legacy CRM parity). Reasons come from
 * `action_taken_reason` filtered by BOTH action_type AND user_type, so
 * the list narrows to the operator's "Pending Due To" / "Open Due To"
 * pick — mirrors the comment-reasons (Add Remarks) endpoint above.
 *
 * Schema (verified 2026-05-18 against easyfix DB):
 *   action_type         { id, type ("Un Reachable"|"Enquiry"|...), description }
 *   action_taken_reason { id, action_type (FK→action_type.id), action_desc,
 *                         status (1=active), user_type, is_new }
 *
 * action_type IDs (confirmed by ops 2026-06-04):
 *   25 → Unreachable  (legacy `action_type.type` was 'Un Reachable')
 *   24 → Enquiry      (legacy `action_type.type` was 'Enquiry')
 * Previously this endpoint did a fragile LOWER(REPLACE(...)) string match
 * against the legacy `type` column. Hardcoded integers are explicit + safe
 * against legacy label drift; the string column stays untouched as a
 * human-readable label only.
 *
 * user_type mapping is shared with the comment-reasons endpoint above —
 * `DUE_TO_USER_TYPE` constant. Missing/unknown `dueTo` defaults to
 * user_type=2 (Client) so older callers without the param still get a
 * sensible list (matches the comment-reasons default).
 *
 * `type=reschedule` serves action_type 29 ("Reschedule Before Start from CRM"),
 * whose 16 rows cover all four parties — NOT action_type 8, which
 * /reschedule-reasons below still serves unfiltered for the older dialog. The
 * evidence for that split is in services/reason-codes.js.
 *
 * ONE EXCEPTION, AND IT IS TEMPORARY: `?type=reschedule&dueTo=any` returns that
 * mode's WHOLE bucket with no user_type filter. It was added while the mode
 * pointed at 8, whose rows all sit under one party; on 29 nothing needs it, and
 * it is kept only so a CRM already calling it keeps working. See DUE_TO_ANY in
 * services/reason-codes.js. `any` is NOT a general value: on every other mode
 * it is an unrecognised string and behaves exactly as one.
 *
 * Route-order note: declared BEFORE `/:id` so Express doesn't try to
 * validate the literal string "action-reasons" as a numeric job id —
 * same gotcha as `/bulk` vs `/:jobId` in routes/admin/auto-assign.js.
 */
router.get('/action-reasons', async (req, res, next) => {
  try {
    const type = String(req.query.type || '').trim().toLowerCase();
    logger.info('Fetch action reasons · type=' + (type || '-') + ' dueTo=' + (req.query.dueTo || '-'));
    /*
     * The accepted modes are LISTED FROM THE MAP, not typed out. The literal
     * read "(unreachable|enquiry)" and was already one mode short the moment
     * `reschedule` was registered — an error message that names a smaller set
     * than the code accepts sends the caller looking for an endpoint that is
     * right in front of them.
     */
    if (!type) {
      return modernError(res, 400, 'type is required (' + Object.keys(ACTION_TYPE_BY_MODE).join('|') + ')');
    }
    // Strip whitespace/underscores/dashes so 'un_reachable' / 'un-reachable' /
    // 'unreachable' / 'Un Reachable' all map to the same bucket.
    const modeKey = type.replace(/[\s_-]/g, '');
    const actionTypeId = ACTION_TYPE_BY_MODE[modeKey];
    if (!actionTypeId) return modernOk(res, []);

    const dueRaw = String(req.query.dueTo || '').toLowerCase().replace(/\s+/g, '');
    const userType = DUE_TO_USER_TYPE[dueRaw] || 2; // default = Customer (user_type 2); matches the pre-checked "By Customer" radio
    /*
     * `dueTo=any` — the WHOLE bucket, no party filter. TEMPORARY, and scoped to
     * the modes that opt in (reschedule alone today). See DUE_TO_ANY in
     * services/reason-codes.js for why it exists — the action_type = 8 rows'
     * user_types were seeded against a mapping this repo later disproved, so
     * dueTo=customer is legitimately empty until the catalogue is corrected —
     * and delete both halves together when it is.
     *
     * The mode gate is what keeps this from leaking: for addremarks / enquiry /
     * unreachable, `any` is not in DUE_TO_USER_TYPE and not in the opt-in list,
     * so it falls through to the user_type = 2 default exactly as any other
     * unrecognised value does today. Their behaviour is unchanged.
     */
    const unfiltered = dueRaw === DUE_TO_ANY && MODES_ALLOWING_DUE_TO_ANY.includes(modeKey);

    const [reasonRows] = await pool.query(
      `SELECT id, action_desc FROM action_taken_reason
        WHERE action_type = ?${unfiltered ? '' : ' AND user_type = ?'}
              AND (status IS NULL OR status = 1)
        ORDER BY id ASC`,
      unfiltered ? [actionTypeId] : [actionTypeId, userType],
    );
    const items = reasonRows
      .map((r) => ({ id: r.id, label: String(r.action_desc || '').trim() }))
      .filter((x) => x.label);
    logger.info('Returning ' + items.length + ' action reasons · type=' + type
      + (unfiltered ? ' · dueTo=any (unfiltered)' : ' · userType=' + userType));
    modernOk(res, items);
  } catch (e) { next(e); }
});

/*
 * GET /api/admin/jobs/reschedule-reasons
 *
 * Reason list for the Schedule & Assign → Reschedule dialog. Returns the same
 * `{ id, label }[]` shape as /action-reasons so the CRM renders it identically.
 *
 * Source: action_taken_reason, action_type = 8 (the CRM "Reschedule" bucket —
 * seeded by migrations/2026-07-10-seed-reschedule-reasons-action-type-8.sql).
 * UNLIKE /action-reasons this deliberately does NOT filter by user_type — the
 * Reschedule dialog has a single reason dropdown (no "due to" Customer/Client/
 * EasyFix/Technician radio), so ALL active action_type=8 reasons are offered.
 *
 * ⚠ THE DUE-TO-FILTERED ANSWER EXISTS, IT IS NOT THIS ENDPOINT, AND IT IS NOT
 * EVEN THIS BUCKET.
 *     GET /action-reasons?type=reschedule&dueTo=<customer|client|easyfix|technician>
 * serves action_type 29, whose 16 rows cover all four parties correctly. This
 * endpoint deliberately stays on action_type 8: its 7 rows all sit under
 * user_type 1, so it can only ever be served unfiltered, and the Current tab's
 * dialog calls it that way today. Repointing it at 29 would swap the list under
 * a live screen; narrowing it in place would shrink that list to one party.
 * Both buckets stand until the owner retires this one. See the `reschedule`
 * note in services/reason-codes.js for the row-by-row evidence.
 *
 * Literal-segment route — declared before the `/:id` wildcard (same reason as
 * /action-reasons above, so Express doesn't try to parse "reschedule-reasons"
 * as a numeric job id).
 */
router.get('/reschedule-reasons', async (_req, res, next) => {
  try {
    logger.info('Fetch reschedule reasons (Schedule & Assign)');
    const [reasonRows] = await pool.query(
      `SELECT id, action_desc FROM action_taken_reason
        WHERE action_type = ? AND (status IS NULL OR status = 1)
        ORDER BY id ASC`,
      [8],
    );
    const items = reasonRows
      .map((r) => ({ id: r.id, label: String(r.action_desc || '').trim() }))
      .filter((x) => x.label);
    logger.info('Returning ' + items.length + ' reschedule reasons');
    modernOk(res, items);
  } catch (e) { next(e); }
});

router.get('/:id', validate(idParam, 'params'), scopedJob, async (req, res) => {
  logger.info('Fetch job detail · jobId=' + req.params.id);
  modernOk(res, req.scopedJob);
});

router.post('/', validate(createBody), async (req, res, next) => {
  try {
    logger.info('Create job · clientId=' + req.body.fk_client_id + ' cityId=' + (req.body.address?.city_id ?? '-') + ' initialStatus=' + (req.body.initial_status ?? 0) + ' services=' + (Array.isArray(req.body.services) ? req.body.services.length : 0));
    // Scope check on create: caller can only create jobs for a client/city
    // within their manage_* scope. Same guard runs on subsequent edits via
    // the `scopedJob` middleware.
    const guard = assertEntityInScope(req, {
      client_id: req.body.fk_client_id,
      city_id:   req.body.address?.city_id,
    });
    if (!guard.ok) {
      logger.warn('Create job denied · clientId=' + req.body.fk_client_id + ' out of scope');
      return modernError(res, 403, 'cannot create a job outside your assigned scope');
    }

    /*
     * Services-required gate (added 2026-05-28 after Job #482453 was
     * booked with zero services).
     *
     * A job created in BOOKED status (initial_status undefined or 0)
     * MUST carry at least one service row. Without this the
     * technician arrives on-site with no scope to execute against;
     * legacy CRM enforced this and the migration missed it.
     *
     * Outcome variants (Enquiry=7, Unconfirmed/CallLater=9) are
     * intentionally exempt — those represent pre-confirmation states
     * where the operator hasn't collected service intent yet.
     */
    const isBookedStatus = req.body.initial_status === undefined || req.body.initial_status === 0;
    const hasServices = Array.isArray(req.body.services) && req.body.services.length > 0;
    if (isBookedStatus && !hasServices) {
      logger.warn('Create job rejected · BOOKED status with zero services · clientId=' + req.body.fk_client_id);
      return modernError(
        res,
        400,
        'At least one service is required to create a job in BOOKED status. '
        + 'Provide services[] in the payload, or set initial_status to 7 (Enquiry) '
        + 'or 9 (Unconfirmed) to defer service selection.',
      );
    }

    const created = await job.create(req.body, req.user);
    logger.info('Job created · id=' + (created?.job_id ?? created?.id ?? '?'));
    res.status(201);
    modernOk(res, created, 'job created');
  } catch (e) { next(e); }
});

/*
 * Update — exposed as BOTH PUT and PATCH to the same handler. The CRM_UI
 * edit flow uses PATCH semantically (partial update) while some integration
 * callers use PUT; both land on the same validator + service call so we
 * don't fork behaviour.
 */
const updateHandler = async (req, res, next) => {
  try {
    logger.info('Update job · jobId=' + req.params.id + ' fields=' + Object.keys(req.body || {}).join(','));
    const updated = await job.update(req.params.id, req.body, req.user);
    logger.info('Job updated · id=' + req.params.id);
    modernOk(res, updated, 'job updated');
  } catch (e) { next(e); }
};
router.put('/:id',   validate(idParam, 'params'), validate(updateBody), scopedJob, canPatchJob, updateHandler);
router.patch('/:id', validate(idParam, 'params'), validate(updateBody), scopedJob, canPatchJob, updateHandler);

/*
 * GET /admin/jobs/:id/completion-ledger — what completing this job would post
 * (the job transaction row, the technician / EasyFix / client ledger moves),
 * whether it can, and whether it already has. Read-only; the CRM's Complete
 * Audit dialog shows it before ops confirm. The post itself happens inside
 * PATCH /:id/status → setStatus (services/job-ledger.service.js).
 */
router.get('/:id/completion-ledger', validate(idParam, 'params'), scopedJob, async (req, res, next) => {
  try {
    modernOk(res, await require('../../services/job-ledger.service').previewCompletionLedger(Number(req.params.id)));
  } catch (e) { next(e); }
});

router.patch('/:id/status', validate(idParam, 'params'), validate(statusBody), scopedJob, requireStageForTransition('status'), async (req, res, next) => {
  try {
    logger.info('Change job status · jobId=' + req.params.id + ' status=' + req.body?.status);
    /*
     * Services-required gate on the BOOKED transition (added 2026-05-28).
     * When a job is being promoted to status=0 (typically 9 → 0 from the
     * Confirm & Schedule flow), require at least one tbl_job_services row.
     * The FE Confirm flow PATCHes services on /:id immediately before
     * this status call, so by the time we get here the rows should be
     * there; if not, we reject with a clear message rather than allow a
     * service-less BOOKED row to land. Mirrors the create-flow guard
     * above. Pairs with the FE confirmBookReady gate.
     */
    if (Number(req.body?.status) === 0) {
      const { pool } = require('../../db');
      const [rows] = await pool.query(
        'SELECT COUNT(*) AS n FROM tbl_job_services WHERE job_id = ?',
        [req.params.id],
      );
      const serviceCount = Number(rows?.[0]?.n ?? 0);
      if (serviceCount === 0) {
        logger.warn('Status change to BOOKED rejected · jobId=' + req.params.id + ' zero services');
        return modernError(
          res,
          400,
          'Cannot transition to BOOKED with zero services attached. '
          + 'Add at least one service to the job (PATCH /:id with services[]) '
          + 'before promoting the status.',
        );
      }
    }

    const updated = await job.setStatus(req.params.id, req.body, req.user);
    logger.info('Job status updated · jobId=' + req.params.id + ' status=' + req.body?.status);
    modernOk(res, updated, 'job status updated');
  } catch (e) { next(e); }
});

/*
 * PAST-APPOINTMENT GATE ON ASSIGN / REASSIGN (owner decision, 2026-09-17).
 *
 * This route used to stay open on a passed appointment so ops could swap a
 * technician on a running-late job. That reasoning belonged to the old DIRECT
 * assign. With the offer flow on, an assign here is an OFFER (and a reassign
 * releases the current technician and offers the job to the new one), so it
 * would send a technician an offer for a time that has already gone — exactly
 * what /offer already refuses. The rule is now the same everywhere: reschedule
 * first. A future requestedDateTime in the same body still passes (fixing the
 * time and assigning in one call).
 */
router.patch('/:id/assign', validate(idParam, 'params'), validate(assignBody), scopedJob, requireStageForTransition('assign'),
  blockPastAppointment('This job\'s appointment time has already passed. Reschedule it to a future slot before assigning or reassigning a technician.'),
  async (req, res, next) => {
  try {
    logger.info('Assign technician · jobId=' + req.params.id + ' efrId=' + (req.body?.easyfixerId ?? req.body?.efr_id ?? '-'));
    const updated = await job.assign(req.params.id, req.body, req.user);
    logger.info('Technician assigned · jobId=' + req.params.id);
    modernOk(res, updated, 'technician assigned');
  } catch (e) { next(e); }
});

/*
 * PATCH /api/admin/jobs/:id/reschedule
 *
 * Explicit, audited reschedule from the Schedule & Assign modal — its Date/Time
 * fields are read-only, so this is the ONLY way to move the appointment.
 * Persists the new requested_date_time + the two derived slot columns, logs
 * reason + remarks to scheduling_history and tbl_job_comment, and expires any
 * open offers (made for the old slot). Reason + remarks are mandatory
 * (rescheduleBody). Literal second segment "reschedule" disambiguates from the
 * `/:id` wildcard.
 */
router.patch('/:id/reschedule', validate(idParam, 'params'), validate(rescheduleBody), scopedJob, requireStageForTransition('reschedule'),
  blockPastAppointment('Cannot reschedule to a date and time that has already passed. Pick a future appointment.'),
  async (req, res, next) => {
  try {
    logger.info('Reschedule job · jobId=' + req.params.id + ' reasonId=' + (req.body?.reasonId ?? '-'));
    const updated = await job.reschedule(Number(req.params.id), req.body, req.user);
    logger.info('Job rescheduled · jobId=' + req.params.id);
    modernOk(res, updated, 'job rescheduled');
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

/*
 * PATCH /api/admin/jobs/:id/app-request/reject
 *
 * Decline a technician's cancellation or reschedule ask (the Reject button on
 * the CRM's Technician Requests rows). There is no matching /approve: APPROVE
 * is the ordinary cancel (PATCH /:id/status → 6) or reschedule
 * (PATCH /:id/reschedule) above, both of which now clear the flag they answer.
 * Adding an approve alias would be a second cancel implementation to keep in
 * step with the first.
 *
 * GATED ON ITS OWN ACTION KEY. Both approve paths are already gated — cancel by
 * requireStageForTransition('status') (a stage-restricted user without 6 in its
 * allowed targets cannot cancel), reschedule by
 * requireStageForTransition('reschedule'). A reject is NOT a transition, so
 * neither guard is reachable here and without requireAction this would be the
 * one job write on this router any admin-group role could make. Seeded by
 * migrations/2026-09-15-seed-job-app-request-action.sql.
 *
 * scopedJob stays for the usual reason: geo/client scope, so an operator
 * cannot reject an ask on a job outside their patch.
 */
router.patch('/:id/app-request/reject',
  validate(idParam, 'params'),
  validate(appRequestRejectBody),
  requireAction('isJobAppRequestResolve'),
  scopedJob,
  async (req, res, next) => {
    try {
      logger.info('Reject app request · jobId=' + req.params.id + ' kind=' + req.body?.kind);
      const updated = await job.rejectAppRequest(Number(req.params.id), req.body, req.user);
      modernOk(res, updated, 'request rejected');
    } catch (e) {
      // 409 APP_REQUEST_NOT_PENDING carries a code the CRM branches on, so it
      // goes out through the shape that preserves one (plain modernError drops it).
      if (e.code) return modernError(res, e.status || 400, { message: e.message, code: e.code });
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  });

/*
 * POST /api/admin/jobs/:id/offer
 *
 * Offer-pool model: fans a single job out to MULTIPLE technicians at once.
 * Unlike /:id/assign (legacy single direct-assign, kept unchanged above), the
 * job stays BOOKED (job_status=0, fk_easyfixter_id NULL — no single owner)
 * while each offered tech gets a tbl_job_offer row (OFFERED) + an FCM push.
 * First tech to ACCEPT wins the job (race-safe in the service). All
 * offer-aware behaviour is gated by jobOfferTableExists() inside the service.
 *
 * The optional schedule edit (requestedDateTime + timeSlot) rides along with
 * the offer exactly as it does on /assign — passed through only when present.
 *
 * Literal-segment route under `/:id/`; its distinct second segment ("offer")
 * keeps it from colliding with the bare `/:id` wildcard.
 */
router.post('/:id/offer', validate(idParam, 'params'), validate(offerBody), scopedJob, requireStageForTransition('offer'),
  blockPastAppointment('This job\'s appointment time has already passed. Reschedule it to a future slot before offering it to technicians.'),
  async (req, res, next) => {
  try {
    const { easyfixerIds, requestedDateTime, timeSlot, source, sourceByEfr } = req.body;
    logger.info('Offer job to technicians · jobId=' + req.params.id + ' count=' + (Array.isArray(easyfixerIds) ? easyfixerIds.length : 0));
    const opts = {};
    if (requestedDateTime !== undefined) opts.requestedDateTime = requestedDateTime;
    if (timeSlot !== undefined) opts.timeSlot = timeSlot;
    if (source !== undefined) opts.source = source;
    if (sourceByEfr !== undefined) opts.sourceByEfr = sourceByEfr;
    const result = await job.offerToTechnicians(Number(req.params.id), easyfixerIds, req.user, opts);
    logger.info('Job offered to technicians · jobId=' + req.params.id + ' offered=' + (Array.isArray(easyfixerIds) ? easyfixerIds.length : 0));
    modernOk(res, result, 'job offered to technicians');
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

/*
 * GET /api/admin/jobs/:id/offers
 *
 * Lists the technicians a job has been offered to (the "Offered to Tx" panel
 * on My Orders), live + rejected + expired. Returns an empty list when the
 * offer table is absent (service falls back to legacy behaviour).
 *
 * An EXPIRED row also carries `closed_reason` and `closed_reason_label` — WHY
 * it closed, which the status cannot say on its own: eight code paths write
 * EXPIRED and only one is the timeout. Both are null on an offer closed before
 * the column existed, and the label is null for a token this deploy has no
 * wording for. See listOffers + services/offer-closed-reason.js.
 *
 * Literal-segment route under `/:id/` — second segment "offers" disambiguates
 * it from `/:id` and from the sibling POST `/:id/offer`.
 */
router.get('/:id/offers', validate(idParam, 'params'), scopedJob, async (req, res, next) => {
  try {
    logger.info('List job offers · jobId=' + req.params.id);
    /*
     * `?sweep=0` makes this a PURE read — no lazy expiry of stale offers.
     * Used by the Pending-for-Scheduling hover card, which fires on mouse-over:
     * without this, merely pointing at a row would mutate offer state and flip
     * the list's own chip under the cursor. Default stays sweep-on so the
     * Schedule & Assign modal (a surface that acts on offers) is unchanged.
     */
    const sweep = !['0', 'false', 'no'].includes(String(req.query.sweep || '').toLowerCase());
    const items = await job.listOffers(Number(req.params.id), { sweep });
    logger.info('Returning ' + items.length + ' job offers · jobId=' + req.params.id);
    /*
     * `offer_expiry_enabled` tells the CRM which regime is in force, because
     * the modal's caption used to assert "open offers expire after 30 minutes"
     * unconditionally — and in production that flag is 'false', so nothing
     * times an offer out at all.
     *
     * The caption mattered more than it looks. EXPIRED is written by NINE code
     * paths and only ONE (expireStaleOffers) honours the flag; the rest close
     * an offer because the job was assigned, rescheduled, released, withdrawn,
     * or superseded by a sibling accepting. An operator reading "expired" next
     * to a 23-hour-old offer reasonably concludes the technician ignored it —
     * which is a fairness claim about a person, and it was wrong. Reported
     * 2026-09-10 for job 538177, where two offers closed in the same second a
     * re-offer went out.
     */
    modernOk(res, { items, offer_expiry_enabled: job.offerExpiryEnabled() });
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

/*
 * GET /api/admin/jobs/:id/activity — the job's event stream (V3 plan 3.1).
 *
 * WHAT IS NEW HERE IS THE READING, NOT THE WRITING. tbl_job_logs has been
 * written since 2015 and this backend has written it since services/
 * job-log.service.js landed; no screen has ever shown it. The CRM's five
 * existing history surfaces each answer ONE question (why was this
 * rescheduled, who called, when was it scheduled) from a DIFFERENT table.
 * This answers "what has happened to this job", once, in order.
 *
 * `scopedJob` is the same guard every other /:id/* route on this router uses,
 * so a job outside the operator's geo/client scope 404s here exactly as it
 * does on /header and /offers. This route adds NO new permission surface: if
 * you can open the job you can read its history, which is the same rule the
 * Audit & History card on the Summary tab already follows.
 *
 * NOT PAGINATED, CAPPED INSTEAD. A job's history is tens of rows, not
 * thousands — the busiest jobs in the archive sit in the low hundreds — so a
 * cap with a stated ceiling is honest where a pager would imply a depth that
 * does not exist. The service takes the MOST RECENT `limit` and returns them
 * oldest-first; `truncated` tells the screen to say so rather than silently
 * presenting a partial life as a whole one.
 */
router.get('/:id/activity', validate(idParam, 'params'), scopedJob, async (req, res, next) => {
  try {
    logger.info('List job activity · jobId=' + req.params.id);
    const limit = Number(req.query.limit) || undefined;
    const items = await jobLog.listForJob(Number(req.params.id), { limit });
    logger.info('Returning ' + items.length + ' job activity rows · jobId=' + req.params.id);
    modernOk(res, { items, truncated: items.length >= jobLog.ACTIVITY_LIMIT_MAX });
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

router.patch('/:id/owner', validate(idParam, 'params'), validate(ownerBody), scopedJob, async (req, res, next) => {
  try {
    logger.info('Change job owner · jobId=' + req.params.id + ' newOwnerId=' + (req.body?.newOwnerId ?? '-'));
    const updated = await job.changeOwner(req.params.id, req.body, req.user);
    logger.info('Job owner changed · jobId=' + req.params.id);
    modernOk(res, updated, 'job owner changed');
  } catch (e) { next(e); }
});

/*
 * POST /api/admin/jobs/bulk-owner-transfer
 *
 * Admin-only bulk variant of the single-job /owner endpoint. Two
 * modes of selecting which jobs to transfer:
 *   - `jobIds: [.., ..]`  — explicit list (max 500 per call)
 *   - `filters: {...}`     — same shape as the listQuery validator;
 *                            applies the same WHERE clauses + RBAC
 *                            scope as the LIST endpoint, then
 *                            iterates up to a 1000-row cap.
 *
 * Both modes require `fromOwnerId` and `toOwnerId`. fromOwnerId
 * narrows so an operator can't accidentally transfer jobs that
 * AREN'T currently owned by the source user (defends against ops
 * mistakes when the filter set crosses owners).
 *
 * Per-row results so partial failures are visible. We never roll
 * back successful transfers — each is its own changeOwner() call.
 *
 * Mounted via roleByName(['Admin']) — only the canonical Admin role
 * can bulk-transfer ownership. Other admin-group roles (Project
 * Manager, Finance, etc.) see the list but not the button.
 */
/*
 * TERMINAL (non-transferable) job statuses.
 *
 *   3, 5 — completed (two historical completion codes, both live)
 *   6    — cancelled
 *   7    — enquiry (never became a real job)
 *
 * A job in one of these states is FINISHED: nobody works it again, so handing
 * it to a new owner only rewrites history and pollutes the new owner's queue
 * and load figures. The product rule is "closed and completed orders can not
 * be transferred".
 *
 * This is deliberately the SAME set as TERMINAL_STATUSES in
 * services/job-export.service.js (~line 751), which is what the export and the
 * Closed filter already mean by "closed". Kept as a LOCAL constant rather than
 * an import on purpose: this route must not take a dependency on the export
 * service just to read four integers, and a drifting copy is loud (four
 * literals next to a comment) where a wrong import would be silent. If the
 * platform's definition of closed ever changes, both places change together.
 */
const NON_TRANSFERABLE_JOB_STATUSES = Object.freeze([3, 5, 6, 7]);
const NON_TRANSFERABLE_REASON = 'completed/cancelled jobs cannot be transferred';

const bulkOwnerBody = require('joi').object({
  fromOwnerId: require('joi').number().integer().positive().required(),
  toOwnerId:   require('joi').number().integer().positive().required(),
  reason:      require('joi').string().trim().min(2).max(500).required(),
  jobIds:      require('joi').array().items(require('joi').number().integer().positive()).min(1).max(500).optional(),
  filters:     require('joi').object().optional(),
}).xor('jobIds', 'filters');
router.post('/bulk-owner-transfer',
  require('../../middleware/role').roleByName(['Admin']),
  validate(bulkOwnerBody),
  async (req, res, next) => {
    try {
      const { fromOwnerId, toOwnerId, reason, jobIds, filters: bodyFilters } = req.body;
      logger.info('Bulk owner transfer · fromOwnerId=' + fromOwnerId + ' toOwnerId=' + toOwnerId + ' mode=' + (Array.isArray(jobIds) && jobIds.length ? 'explicit(' + jobIds.length + ')' : 'filters'));
      if (fromOwnerId === toOwnerId) {
        logger.warn('Bulk owner transfer rejected · from and to owner identical (' + fromOwnerId + ')');
        return modernError(res, 400, 'fromOwnerId and toOwnerId cannot be the same');
      }

      // Resolve the target job set. Explicit jobIds short-circuit;
      // filters mode reuses service.list() with the same RBAC scope
      // the LIST endpoint applies.
      let targetIds = [];
      if (Array.isArray(jobIds) && jobIds.length) {
        targetIds = jobIds;
      } else {
        const { buildRequestScopeWithHierarchy } = require('../../lib/scope');
        const { pool } = require('../../db');
        const scope = await buildRequestScopeWithHierarchy(req, pool);
        const { rows } = await job.list({
          ...bodyFilters,
          ownerId: fromOwnerId, // pin to source owner — see comment above
          limit: 1000,
          offset: 0,
          scope,
        });
        targetIds = rows.map((r) => r.job_id);
      }
      logger.info('Bulk owner transfer resolved ' + targetIds.length + ' target jobs');

      if (targetIds.length === 0) {
        return modernOk(res, {
          summary: { total: 0, transferred: 0, failed: 0, skipped: 0 },
          results: [],
        }, 'no jobs matched');
      }

      const results = [];
      let transferred = 0; let failed = 0; let skipped = 0;
      for (const id of targetIds) {
        try {
          // service.changeOwner validates the source ownership via
          // the existing job_owner column — if the row's current
          // owner doesn't match fromOwnerId, we skip rather than
          // throw. Lets the explicit-jobIds caller pass mixed sets
          // without aborting on the first mismatch.
          const { pool } = require('../../db');
          const [[row]] = await pool.query(
            'SELECT job_client_owner, job_status FROM tbl_job WHERE job_id = ? LIMIT 1',
            [id]
          );
          if (!row) {
            skipped++;
            results.push({ jobId: id, status: 'skipped', reason: 'not found' });
            continue;
          }
          /*
           * TERMINAL-STATUS GUARD — the ONE choke point for both modes.
           *
           * It lives here, in the per-job loop, rather than in the target-id
           * resolution above, because both modes converge on `targetIds` and
           * every id then passes through this single fresh read of tbl_job.
           * Guarding at resolution would need TWO implementations (one for the
           * explicit-jobIds array, which has no status at all, and one over
           * job.list()'s projection), and the filters-mode half would be
           * trusting a projected field on rows the caller's own `filters` can
           * shape — including pinning `status` to a terminal code. This read
           * asks the table directly, one row at a time, at the moment of
           * transfer, so neither a caller-chosen filter nor a projection change
           * can route around it.
           *
           * Counted as `skipped`, not `failed`: the job was found and is simply
           * ineligible. The summary stays truthful either way — every id lands
           * in exactly one of transferred/failed/skipped.
           *
           * Number() because a driver/column change that hands back '3' as a
           * string would make `includes` miss and silently reopen the hole.
           */
          if (NON_TRANSFERABLE_JOB_STATUSES.includes(Number(row.job_status))) {
            skipped++;
            results.push({ jobId: id, status: 'skipped', reason: NON_TRANSFERABLE_REASON });
            continue;
          }
          /*
           * job_client_owner, NOT job_owner — this must read the SAME column
           * services/job.service.js changeOwner() writes. Reading one and
           * writing the other would let a bulk transfer select jobs by one
           * owner and reassign a different owner's jobs.
           */
          if (row.job_client_owner !== fromOwnerId) {
            skipped++;
            results.push({ jobId: id, status: 'skipped', reason: `current owner ${row.job_client_owner ?? 'NULL'} ≠ source ${fromOwnerId}` });
            continue;
          }
          await job.changeOwner(id, { newOwnerId: toOwnerId, reason }, req.user);
          transferred++;
          results.push({ jobId: id, status: 'transferred' });
        } catch (e) {
          failed++;
          results.push({ jobId: id, status: 'failed', error: e.status ? e.message : 'transfer failed' });
        }
      }

      logger.info('Bulk owner transfer complete · total=' + targetIds.length + ' transferred=' + transferred + ' failed=' + failed + ' skipped=' + skipped);
      modernOk(res, {
        summary: { total: targetIds.length, transferred, failed, skipped },
        results,
      }, 'bulk owner transfer complete');
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  }
);

// ─── Fulfillment hold ───────────────────────────────────────────────
// Mirrors legacy `addEditFullFillmentHold` + `confirmFullfillmentHold`.
//
// VERIFIED tbl_job columns (JobDaoImpl.java:4587):
//   full_fillment_reason, full_fillment_time, full_fillment_by,
//   full_fillment_created_time, no_of_req_foh, job_status
//
// State machine:
//   PUT  /jobs/:id/hold     → job_status = 21, stamp hold fields,
//                              increment no_of_req_foh
//   POST /jobs/:id/hold/release → job_status = 10 (REVISIT)
const { pool } = require('../../db');
const holdBody = require('joi').object({
  reason: require('joi').string().trim().min(1).max(500).required(),
  appointment_time: require('joi').date().iso().required(),
});
router.put('/:id/hold', validate(idParam, 'params'), validate(holdBody), scopedJob, async (req, res, next) => {
  try {
    logger.info('Place fulfillment hold · jobId=' + req.params.id);
    /*
     * ONE HOLD PER JOB, EVER — the guard legacy enforced at
     * EasyFix_CRM JobDaoImpl.java:6106 (`if (j.getNoOffullfillments() == 0)`).
     *
     * Note what it does NOT gate on: status. A hold can be placed from any
     * state. This counter is the whole state machine, and it is what makes
     * the release safe — hold/release is a single 10 → 21 → 10 round trip, so
     * releasing to a hardcoded 10 restores the job to where it started.
     *
     * Without the guard a job that had moved on could be dragged back to 21
     * and then released to 10, rewriting its status to a state it had already
     * left. Legacy skipped the write silently; this is an admin route rather
     * than the frozen partner contract, so it reports the refusal instead of
     * pretending to succeed.
     */
    const [[current]] = await pool.query(
      'SELECT COALESCE(no_of_req_foh, 0) AS holds FROM tbl_job WHERE job_id = ?',
      [req.params.id]
    );
    if (!current) return modernError(res, 404, 'Job not found');
    if (Number(current.holds) > 0) {
      logger.warn('Fulfillment hold refused · already held once · jobId=' + req.params.id);
      return modernError(res, 409, 'This job has already been placed on fulfillment hold once.');
    }
    await pool.query(
      `UPDATE tbl_job
          SET job_status = 21,
              full_fillment_reason = ?,
              full_fillment_time = ?,
              full_fillment_by = ?,
              full_fillment_created_time = ?,
              no_of_req_foh = COALESCE(no_of_req_foh, 0) + 1
        WHERE job_id = ? AND COALESCE(no_of_req_foh, 0) = 0`,
      [req.body.reason, req.body.appointment_time, req.user.user_id, new Date(), req.params.id]
    );
    logger.info('Fulfillment hold placed · jobId=' + req.params.id + ' status=21');
    modernOk(res, { on_hold: true, status: 21 });
  } catch (e) { next(e); }
});
router.post('/:id/hold/release', validate(idParam, 'params'), scopedJob, async (req, res, next) => {
  try {
    logger.info('Release fulfillment hold · jobId=' + req.params.id);
    /*
     * Written directly rather than through jobService.setStatus(), and that is
     * deliberate: status 10 maps to the TechVisitInComplete webhook, which the
     * client ALREADY received when the job first reached 10 before the hold.
     * Routing this through setStatus would re-fire it and tell Decathlon /
     * PowerMax / Green Soul that a second visit failed. Releasing a hold is a
     * restoration, not a new lifecycle event.
     *
     * But 10 is a CLOSED state, and a hold can be placed from any state — so
     * Check In → Hold → Release reached Check Out with no photo, around the
     * every-close proof rule in setStatus (2026-09-11). So: only a job that IS on
     * hold (21) can be released, and it needs an after-work photo like any close.
     */
    if (Number(req.scopedJob.job_status) !== 21) {
      return modernError(res, 409, 'This job is not on fulfillment hold.');
    }
    if (!(await job.hasAfterWorkPhoto(req.params.id))) {
      logger.warn('Hold release refused, no after-work photo · jobId=' + req.params.id);
      return next(job.afterPhotoRequiredError());
    }
    const [upd] = await pool.query('UPDATE tbl_job SET job_status = 10 WHERE job_id = ? AND job_status = 21', [req.params.id]);
    if (!upd.affectedRows) return modernError(res, 409, 'This job is not on fulfillment hold.');
    logger.info('Fulfillment hold released · jobId=' + req.params.id + ' status=10');
    modernOk(res, { released: true, status: 10 });
  } catch (e) { next(e); }
});

// ─── Multi-step estimate approval workflow ──────────────────────────
// Mirrors legacy JobAction.java `requestApproval` (preview) +
// `confirmApprovejob` (send-for-approval) pair.
//
// VERIFIED tbl_job columns (JobDaoImpl.java:2473 + 4587):
//   approve_job_doc, approval_sent_on_date_time, no_of_req_approval
//
// Two steps:
//   GET  /admin/jobs/:id/estimate/preview         — service breakdown + grand total
//   POST /admin/jobs/:id/estimate/send-for-approval — stamp approval_sent_on_date_time,
//                                                     job_status = 15, increment counter,
//                                                     email PDF to client SPOC
//
// PDF generation reuses `utils/pdf-invoice.js` rendering style but
// produces an estimate-approval doc. For now we send a plain-text
// email with the estimate breakdown; PDF attachment can be wired
// when ops requests it (the SP and audit trail are already in place).
const emailServiceForJobs = require('../../services/email.service');
router.get('/:id/estimate/preview', validate(idParam, 'params'), scopedJob, async (req, res, next) => {
  try {
    const jobId = Number(req.params.id);
    logger.info('Preview estimate · jobId=' + jobId);
    // One definition of what a job's services are worth — see
    // services/job-line-total.js. This formula used to be written out here and
    // in six other places, in three variants that disagreed.
    const { estimateLinesForJob } = require('../../services/job-line-total');
    const { lines, totals } = await estimateLinesForJob(jobId);
    const grand_total = totals.grand_total;
    logger.info('Returning estimate preview · jobId=' + jobId + ' services=' + lines.length + ' grandTotal=' + grand_total);
    modernOk(res, { job_id: jobId, services: lines, grand_total });
  } catch (e) { next(e); }
});

/*
 * GET /admin/jobs/:id/service-breakdown
 *
 * Per-service cost cascade for the Services tab tooltip. Joins
 * tbl_job_services → tbl_client_service (where the 6 cost columns
 * live) → tbl_service_type (for display name). Each row's totalCharge
 * is run through `calculateCharges` (the documented Variable→Fixed
 * cascade, see services/client-rate-cards.service.js) at per-unit
 * level and multiplied by quantity for the line total.
 *
 * Performance: 1 SQL query + N synchronous JS computations (N = #
 * services on the job; typically ≤10).
 */
router.get('/:id/service-breakdown', validate(idParam, 'params'), scopedJob, async (req, res, next) => {
  try {
    /*
     * The computation moved to services/job-service-breakdown.service.js on
     * 2026-09-09 so the Billing & Charges tab can render the SAME numbers.
     * It used to live here, which made it reachable by this route alone — and
     * the Billing tab, needing a per-service technician charge it could not
     * get, hardcoded zero. The response shape is unchanged.
     */
    const { breakdownForJob } = require('../../services/job-service-breakdown.service');
    const jobId = Number(req.params.id);
    logger.info('Compute service breakdown · jobId=' + jobId);
    const { lineItems, totals } = await breakdownForJob(jobId);
    logger.info('Returning service breakdown · jobId=' + jobId + ' lineItems=' + lineItems.length);
    modernOk(res, { job_id: jobId, lineItems, totals });
  } catch (e) { next(e); }
});

/*
 * POST /admin/jobs/:id/services/:jobServiceId/restore
 *
 * Soft-undelete a single tbl_job_services row by flipping its
 * job_service_status from 0 back to 1. Mirror of the soft-delete
 * pattern used by the services PATCH path (see job.service.js#update
 * around line 1187). Idempotent — restoring an already-active row
 * is a no-op (affectedRows=0) and still returns 200.
 *
 * No permission key: the View modal's Services tab offers it with none.
 * scopedJob + servicesEditable (no writes on a completed job) guard all four
 * service-line routes.
 */
router.post('/:id/services/:jobServiceId/restore',
  validate(require('joi').object({
    id: require('joi').number().integer().positive().required(),
    jobServiceId: require('joi').number().integer().positive().required(),
  }), 'params'),
  scopedJob,
  servicesEditable,
  async (req, res, next) => {
    try {
      const jobId = Number(req.params.id);
      const jobServiceId = Number(req.params.jobServiceId);
      logger.info('Restore job service · jobId=' + jobId + ' jobServiceId=' + jobServiceId);
      if (!Number.isFinite(jobServiceId) || jobServiceId <= 0) {
        return res.status(400).json({ error: 'Invalid jobServiceId' });
      }
      const [r] = await pool.query(
        `UPDATE tbl_job_services
            SET job_service_status = 1
          WHERE job_id = ?
            AND job_service_id = ?
            AND (job_service_status IS NULL OR job_service_status = 0)`,
        [jobId, jobServiceId],
      );
      logger.info('Job service restore · jobServiceId=' + jobServiceId + ' restored=' + (r.affectedRows > 0));
      modernOk(res, { restored: r.affectedRows > 0, job_id: jobId, job_service_id: jobServiceId });
    } catch (e) { next(e); }
  });

/*
 * DELETE /admin/jobs/:id/services/:jobServiceId
 *
 * Soft-delete a single tbl_job_services row (status → 0). Idempotent;
 * pair with the /restore endpoint above to bring it back. We use
 * soft-delete instead of a hard DELETE so the row stays visible
 * behind the "Show Inactive" toggle and audit history is preserved.
 */
router.delete('/:id/services/:jobServiceId',
  validate(require('joi').object({
    id: require('joi').number().integer().positive().required(),
    jobServiceId: require('joi').number().integer().positive().required(),
  }), 'params'),
  scopedJob,
  servicesEditable,
  async (req, res, next) => {
    try {
      const jobId = Number(req.params.id);
      const jobServiceId = Number(req.params.jobServiceId);
      logger.info('Soft-delete job service · jobId=' + jobId + ' jobServiceId=' + jobServiceId);
      if (!Number.isFinite(jobServiceId) || jobServiceId <= 0) {
        return res.status(400).json({ error: 'Invalid jobServiceId' });
      }
      const [r] = await pool.query(
        `UPDATE tbl_job_services
            SET job_service_status = 0
          WHERE job_id = ?
            AND job_service_id = ?
            AND (job_service_status IS NULL OR job_service_status = 1)`,
        [jobId, jobServiceId],
      );
      logger.info('Job service soft-delete · jobServiceId=' + jobServiceId + ' removed=' + (r.affectedRows > 0));
      modernOk(res, { removed: r.affectedRows > 0, job_id: jobId, job_service_id: jobServiceId });
    } catch (e) { next(e); }
  });

/*
 * PATCH /admin/jobs/:id/services/:jobServiceId
 *
 * Update the quantity on a single active tbl_job_services row. Carved
 * out of the Services tab redesign — previously the only way to fix a
 * wrong qty was Delete + re-Add, which lost row identity (PK churn) and
 * broke any downstream rate-card breakdown that keyed off
 * `job_service_id`. The PATCH preserves the row and just bumps qty.
 *
 * Soft-deleted rows (job_service_status = 0) are explicitly NOT updatable
 * here: they should be restored first via /restore, then edited. We
 * return 404 in that case to make the FE flow obvious.
 *
 * Validator + scopedJob mirror the sibling DELETE/restore endpoints
 * above so authz and shape behaviour stay symmetric.
 */
const { describe: describeJobsRoute } = require('../../docs/openapi-autogen');
router.patch('/:id/services/:jobServiceId',
  describeJobsRoute('Update quantity on a job service line (recomputes charges)', {
    description: [
      'Bumps the quantity on a single active tbl_job_services row AND',
      'recomputes the 5 charge columns (total_charge, total_cost,',
      'client_charge, easyfix_charge, easyfixer_charge) via the shared',
      'rate-card cascade (utils/rate-card-calc.js).',
      '',
      'Quantity change matters because `total_cost` = per-unit × qty,',
      'and the variable% layers cascade off the per-unit price — so a',
      'qty bump scales all dependent shares proportionally.',
      '',
      'Returns the updated row\'s computed `charges` object so the FE',
      'can render the breakdown without a refetch.',
    ].join('\n'),
    tags: ['Admin — Jobs'],
  }),
  validate(require('joi').object({
    id: require('joi').number().integer().positive().required(),
    jobServiceId: require('joi').number().integer().positive().required(),
  }), 'params'),
  validate(require('joi').object({
    quantity: require('joi').number().integer().min(1).max(100).required(),
  })),
  scopedJob,
  servicesEditable,
  async (req, res, next) => {
    try {
      const jobId = Number(req.params.id);
      const jobServiceId = Number(req.params.jobServiceId);
      const { quantity } = req.body;
      logger.info('Update job service quantity · jobId=' + jobId + ' jobServiceId=' + jobServiceId + ' quantity=' + quantity);
      // Quantity change → all 5 charge columns recompute via the shared
      // cascade helper (utils/rate-card-calc.js). Look up the existing
      // row's service_id (= client_service_id) so we can fetch the rate
      // card and re-run the math.
      const [existing] = await pool.query(
        `SELECT service_id FROM tbl_job_services WHERE job_service_id = ? AND job_id = ? LIMIT 1`,
        [jobServiceId, jobId],
      );
      if (!existing.length) {
        logger.warn('Update job service quantity · jobServiceId=' + jobServiceId + ' not found');
        return res.status(404).json({ error: 'service not found' });
      }
      const { loadRateCardRow, computeJobServiceCharges } = require('../../utils/rate-card-calc');
      const rateCard = await loadRateCardRow(pool, existing[0].service_id);
      const ch = computeJobServiceCharges(rateCard, quantity);
      const [r] = await pool.query(
        `UPDATE tbl_job_services
            SET quantity = ?,
                total_charge = ?,
                total_cost = ?,
                client_charge = ?,
                easyfix_charge = ?,
                easyfixer_charge = ?
          WHERE job_id = ?
            AND job_service_id = ?
            AND (job_service_status IS NULL OR job_service_status = 1)`,
        [quantity, ch.total_charge, ch.total_cost, ch.client_charge, ch.easyfix_charge, ch.easyfixer_charge,
         jobId, jobServiceId],
      );
      if (!r.affectedRows) {
        logger.warn('Update job service quantity · jobServiceId=' + jobServiceId + ' not found or inactive');
        return res.status(404).json({ error: 'service not found or inactive' });
      }
      logger.info('Job service quantity updated · jobServiceId=' + jobServiceId + ' quantity=' + quantity);
      modernOk(res, { updated: true, job_id: jobId, job_service_id: jobServiceId, quantity, charges: ch });
    } catch (e) { next(e); }
  });

/*
 * POST /admin/jobs/:id/services
 *
 * Append a NEW service row to tbl_job_services without touching the
 * other rows on the job. Body:
 *   { service_id, service_type_id, service_category_id, quantity }
 *
 * If a soft-deleted (status=0) row for the same {job_id, service_id}
 * already exists, we reactivate it in place (status=1 + quantity bump)
 * instead of inserting a duplicate. The companion soft-delete endpoint
 * above keeps the row around so the operator can re-add later via this
 * endpoint without losing the original PK.
 */
router.post('/:id/services',
  describeJobsRoute('Append a service line to a job (computes charges)', {
    description: [
      'Appends a NEW row to tbl_job_services OR reactivates a previously',
      'soft-deleted row for the same (job_id, service_id) pair. Either way,',
      'the 5 charge columns (total_charge, total_cost, client_charge,',
      'easyfix_charge, easyfixer_charge) are populated from the rate-card',
      'cascade — see utils/rate-card-calc.js for the formula.',
      '',
      '`service_id` is the tbl_client_service.client_service_id from the',
      'client\'s rate card. The endpoint looks up that row to drive the',
      'cascade; missing/invalid IDs yield all-zero charges (degenerate but',
      'non-fatal so the row still lands).',
      '',
      'Returns the new/reactivated `job_service_id` + the computed',
      '`charges` object for the FE to render without a refetch.',
    ].join('\n'),
    tags: ['Admin — Jobs'],
  }),
  validate(idParam, 'params'),
  validate(require('joi').object({
    service_id:          require('joi').number().integer().positive().required(),
    service_type_id:     require('joi').number().integer().positive().allow(null).optional(),
    service_category_id: require('joi').number().integer().positive().allow(null).optional(),
    quantity:            require('joi').number().integer().min(1).default(1),
  })),
  scopedJob,
  servicesEditable,
  async (req, res, next) => {
    try {
      const jobId = Number(req.params.id);
      const { service_id, service_type_id, service_category_id, quantity } = req.body;
      logger.info('Append job service · jobId=' + jobId + ' serviceId=' + service_id + ' quantity=' + quantity);
      // Reactivate existing soft-deleted row if present.
      const [existing] = await pool.query(
        `SELECT job_service_id, job_service_status, quantity FROM tbl_job_services
          WHERE job_id = ? AND service_id = ?
          ORDER BY job_service_id DESC LIMIT 1`,
        [jobId, service_id],
      );
      // Rate-card lookup + cascade — single source of truth for the 5
      // charge columns (see utils/rate-card-calc.js). Applied to both the
      // reactivate-existing path and the fresh-insert path so the row
      // always carries up-to-date financials.
      const { loadRateCardRow, computeJobServiceCharges } = require('../../utils/rate-card-calc');
      const rateCard = await loadRateCardRow(pool, service_id);
      const ch = computeJobServiceCharges(rateCard, quantity);
      if (existing.length > 0) {
        const row = existing[0];
        await pool.query(
          `UPDATE tbl_job_services
              SET job_service_status = 1,
                  quantity = ?,
                  total_charge = ?,
                  total_cost = ?,
                  client_charge = ?,
                  easyfix_charge = ?,
                  easyfixer_charge = ?
            WHERE job_service_id = ?`,
          [quantity, ch.total_charge, ch.total_cost, ch.client_charge, ch.easyfix_charge, ch.easyfixer_charge,
           row.job_service_id],
        );
        logger.info('Job service reactivated · jobId=' + jobId + ' jobServiceId=' + row.job_service_id);
        return modernOk(res, { reactivated: true, job_service_id: row.job_service_id, charges: ch });
      }
      const [ins] = await pool.query(
        `INSERT INTO tbl_job_services
           (job_id, service_id, service_type_id, service_category_id, quantity, job_service_status,
            total_charge, total_cost, client_charge, easyfix_charge, easyfixer_charge)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        [jobId, service_id, service_type_id || null, service_category_id || null, quantity,
         ch.total_charge, ch.total_cost, ch.client_charge, ch.easyfix_charge, ch.easyfixer_charge],
      );
      logger.info('Job service added · jobId=' + jobId + ' jobServiceId=' + ins.insertId);
      res.status(201);
      modernOk(res, { added: true, job_service_id: ins.insertId, charges: ch });
    } catch (e) { next(e); }
  });

/*
 * ─── THE ONE-LIST SERVICES EDITOR (Uplifted tab) ──────────────────────────
 *
 *   GET /api/admin/jobs/:id/service-catalog[?categoryId=]
 *     → { category, categories, types, products, foreign }
 *   PUT /api/admin/jobs/:id/services   { categoryId?, services: [{ service_id, quantity }] }
 *     → { added, updated, removed }
 *
 * A NEW editor for the Schedule & Assign Uplifted tab only. POST /:id/services
 * above and every other services writer are deliberately untouched — including
 * POST's silent quantity overwrite, which is exactly what this pair avoids by
 * taking the COMPLETE desired set and diffing it against the ACTIVE rows.
 * services/job-services-editor.service.js carries the rules and the QA
 * measurements that shaped them.
 *
 * Guards match the existing services endpoints: the /api/admin/* chain plus
 * scopedJob (404 outside the caller's scope). The write also takes
 * servicesEditable, so a completed job's services — its billing lines — cannot
 * be changed, and the service re-checks that on the row it locks.
 */
/*
 * require('joi') inline, as the neighbouring services routes do: this file's
 * `const Joi` is declared further down, and these schemas are built at module
 * load — reading it here would be a temporal-dead-zone ReferenceError at
 * require time.
 */
const serviceCatalogQuery = require('joi').object({
  // Used ONLY while the job resolves no category of its own (see the service).
  categoryId: require('joi').number().integer().positive().optional(),
});

router.get('/:id/service-catalog',
  validate(idParam, 'params'),
  validate(serviceCatalogQuery, 'query'),
  scopedJob,
  async (req, res, next) => {
    try {
      const catalog = await servicesEditor.getServiceCatalog(req.scopedJob, { categoryId: req.query.categoryId });
      modernOk(res, catalog);
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  });

/*
 * Joi guards the SHAPE; the service owns the business rules and answers them in
 * plain sentences (an empty set, a duplicate service, a foreign add, a category
 * that cannot change). `services: []` is therefore valid here on purpose — it is
 * refused one layer down with "A job needs at least one service." rather than
 * as an opaque "Validation failed".
 */
const QUANTITY_MESSAGE = 'Quantity must be a whole number from 1 to 100.';
const replaceServicesBody = require('joi').object({
  categoryId: require('joi').number().integer().positive().allow(null).optional(),
  services: require('joi').array().items(require('joi').object({
    service_id: require('joi').number().integer().positive().required(),
    quantity: require('joi').number().integer().min(1).max(100).required().messages({
      'number.base': QUANTITY_MESSAGE, 'number.integer': QUANTITY_MESSAGE,
      'number.min': QUANTITY_MESSAGE, 'number.max': QUANTITY_MESSAGE,
    }),
  })).max(200).required(),
});

router.put('/:id/services',
  validate(idParam, 'params'),
  validate(replaceServicesBody),
  scopedJob,
  servicesEditable,
  async (req, res, next) => {
    try {
      const result = await servicesEditor.replaceJobServices(req.params.id, req.body, req.user);
      modernOk(res, result, 'Services saved');
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  });

router.post('/:id/estimate/send-for-approval',
  validate(idParam, 'params'),
  validate(require('joi').object({
    comments: require('joi').string().max(1000).allow('', null).optional(),
  }).optional()),
  scopedJob,
  async (req, res, next) => {
    try {
      const jobId = Number(req.params.id);
      logger.info('Send estimate for approval · jobId=' + jobId);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        // Stamp tbl_job — mirrors legacy `JobApproveDetails` second UPDATE.
        await conn.query(
          `UPDATE tbl_job
              SET job_status = 15,
                  approval_sent_on_date_time = ?,
                  no_of_req_approval = COALESCE(no_of_req_approval, 0) + 1
            WHERE job_id = ?`,
          [new Date(), jobId]
        );
        await conn.commit();
      } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }

      // Fire email asynchronously — failure shouldn't roll back the
      // state transition. Reporting contact email lives on tbl_client_contacts.
      sendEstimateEmail(jobId, req.user.user_id).catch(() => {});
      logger.info('Estimate sent for approval · jobId=' + jobId + ' status=15');
      modernOk(res, { sent: true, status: 15 });
    } catch (e) { next(e); }
  }
);

/*
 * Customer name on a JOB surface (2026-08-03).
 *
 * The name typed on the booking page lands on tbl_job.job_customer_name — a
 * per-job override of the customer-master tbl_customer.customer_name (see the
 * MUTABLE_COLUMNS note in services/job.service.js). Anywhere a name is shown
 * as "the customer on THIS JOB" it must prefer the job-row copy; the master
 * name is only the fallback. Customer-MASTER surfaces (Manage Customers,
 * customer lookup/dedupe) keep reading cu.customer_name directly.
 *
 * NULLIF(TRIM(...), '') is load-bearing. MySQL COALESCE only guards NULL, so
 * COALESCE('', cu.customer_name) returns '' and would render a BLANK name.
 * Both job write paths can store '': validators/job.validator.js declares
 * `job_customer_name: Joi.string().allow('', null)` on create AND update,
 * job.service.js create() binds it through `??` (which does not catch ''),
 * and the update() MUTABLE_COLUMNS loop binds input[col] verbatim.
 */
async function sendEstimateEmail(jobId, userId) {
  const [[j]] = await pool.query(
    `SELECT j.job_id, j.job_reference_id, j.client_ref_id, j.reporting_contact_id,
            j.client_spoc_email, j.fk_client_id,
            cl.client_name,
            COALESCE(NULLIF(TRIM(j.job_customer_name), ''), cu.customer_name) AS customer_name,
            cu.customer_mob_no,
            u.official_email AS owner_email
       FROM tbl_job j
       LEFT JOIN tbl_client   cl ON cl.client_id   = j.fk_client_id
       LEFT JOIN tbl_customer cu ON cu.customer_id = j.fk_customer_id
       LEFT JOIN tbl_user      u ON u.user_id      = j.job_owner
      WHERE j.job_id = ? LIMIT 1`,
    [jobId]
  );
  if (!j) {
    logger.warn('Estimate email skipped — job not found · jobId=' + jobId);
    return;
  }
  /*
   * Same helper the preview above uses, and deliberately so: the client
   * compares the email against the portal, and until today they were two
   * hand-written copies of one formula that nothing kept in step.
   */
  const { estimateLinesForJob } = require('../../services/job-line-total');
  const { lines: services, totals } = await estimateLinesForJob(jobId);

  const total = totals.grand_total;
  const lineBlock = services
    .map((s) => `  ${s.service_name || '—'} × ${s.quantity}  =  ${s.line_total.toFixed(2)}`)
    .join('\n');

  // Recipient resolution mirrors legacy `confirmApprovejob`:
  // reporting contact's manager_name CSV (legacy stores emails here, not
  // names) + contact_email, owner email. Skip clearly malformed entries
  // so a typo in one CSV field doesn't poison the whole send. Validation +
  // dedupe lives in services/email-address.util.js, shared with
  // services/material-client-request.service.js's own (narrower) recipient
  // rule — this route keeps its own recipient SET (owner included).
  const { collectValidEmails } = require('../../services/email-address.util');
  const candidates = [
    { value: j.client_spoc_email, source: 'job.client_spoc_email' },
    { value: j.owner_email,       source: 'owner.official_email' },
  ];
  if (j.reporting_contact_id) {
    const [[c]] = await pool.query(
      'SELECT contact_email, manager_name FROM tbl_client_contacts WHERE id = ?',
      [j.reporting_contact_id]
    );
    if (c) {
      candidates.push({ value: c.contact_email, source: 'contact.contact_email' });
      if (c.manager_name) {
        for (const m of String(c.manager_name).split(',')) {
          candidates.push({ value: m, source: 'contact.manager_name[]' });
        }
      }
    }
  }
  const { recipients, skipped } = collectValidEmails(candidates);
  if (recipients.length === 0) {
    require('../../logger').warn(
      `Estimate email skipped — no valid recipients for job ${jobId}` +
      (skipped.length ? ` (rejected ${skipped.length} malformed entries)` : '')
    );
    return;
  }

  await emailServiceForJobs.send({
    to: recipients,
    subject: `Client_Estimate Approval_${j.job_id}_${j.customer_name || ''}_${j.customer_mob_no || ''}`,
    text: `Hi ${j.client_name || ''},\n\n`
      + `Please find below the estimate for job ${j.job_reference_id || j.job_id}.\n\n`
      + `Services:\n${lineBlock}\n\n`
      + `Grand total: ${total.toFixed(2)}\n\n`
      + `Kindly approve via the client portal.\n\nRegards,\nEasyFix`,
    category: 'estimate.send-for-approval',
  });
  logger.info('Estimate email sent · jobId=' + jobId + ' recipients=' + recipients.length);
}

// ─── Job Comments sub-resource (legacy tbl_job_comment) ──────────────
const jobComments = require('../../services/job-comment.service');
const Joi = require('joi');
/*
 * commentBody — the `comment_on` field is a legacy enum that the
 * CRM uses to classify the comment shape. Values verified against
 * legacy `tbl_job_comment` data (full map in services/job-comment.service.js):
 *   1  = created / schedule / approval
 *   2  = check_in
 *   3  = check_out
 *   4  = in_progress (new-app addition)
 *  16  = call_later  (Unreachable outcome)
 *  17  = enquiry     (Enquiry outcome)
 *
 * `job_stage` is the human-readable label persisted alongside the
 * numeric code on deploys that carry the column (column-probed in the
 * service layer). Optional; legacy DBs ignore it.
 */
const commentBody = Joi.object({
  comments:       Joi.string().trim().min(1).max(2000).required(),
  comment_on:     Joi.number().integer().valid(1, 2, 3, 4, 16, 17).required(),
  appointment_on: Joi.date().iso().optional(),
  enum_reason_id: Joi.number().integer().positive().optional(),
  efr_id:         Joi.number().integer().positive().optional(),
  job_stage:      Joi.string().max(60).allow('', null).optional(),
});

router.get('/:id/comments', validate(idParam, 'params'), scopedJob, async (req, res, next) => {
  try {
    logger.info('List job comments · jobId=' + req.params.id);
    const comments = await jobComments.listComments(req.params.id);
    logger.info('Returning ' + comments.length + ' job comments · jobId=' + req.params.id);
    modernOk(res, comments);
  } catch (e) { next(e); }
});

router.post('/:id/comments',
  validate(idParam, 'params'),
  validate(commentBody),
  scopedJob,
  async (req, res, next) => {
    try {
      logger.info('Add job comment · jobId=' + req.params.id + ' commentOn=' + req.body?.comment_on);
      const created = await jobComments.addComment(req.params.id, {
        ...req.body,
        commented_by: req.user?.user_id,
      });
      logger.info('Job comment added · jobId=' + req.params.id);
      res.status(201);
      modernOk(res, created, 'Comment added');
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  }
);

// Customer "Unreachable" SMS — legacy parity with EasyFix_CRM
// sendSmsToNotReachableCustomer. Fired by the Confirm modal's "Unreachable"
// submit (after the status + comment writes). scopedJob ensures the job is in
// the caller's scope. Non-fatal on the FE: a provider failure must not fail the
// operator's outcome, so the FE wraps this call in try/catch.
/*
 * ─── INTERNAL JOB NOTES — GET/POST /api/admin/jobs/:id/notes ───────────────
 *
 * The legacy CRM's free-text ops notepad (tbl_job_notes), re-opened. READ AND
 * ADD ONLY — no PATCH, no DELETE (the owner's call, and the only contract the
 * table can honestly support: it has no updated_at, no status column and no
 * author id to check an edit against). A note is a line in a log.
 *
 * NOT the comment thread. tbl_job_comment is the audited lifecycle trail —
 * every row produced by an action, carrying that action's reason FK, mirrored
 * onto tbl_job.remarks. These are operators writing to each other. See
 * services/job-notes.service.js for why the two stay apart.
 *
 * GUARDED EXACTLY AS THE COMMENT ENDPOINTS ARE: the /api/admin/* chain
 * (requireAuth → role(['admin']) → maskMobile → scope) plus `scopedJob`, which
 * 404s a job outside the operator's client/city/vertical patch before either
 * handler runs. No requireAction, for the same reason GET/POST /:id/comments
 * has none — reading and appending narrative on a job you can already open is
 * not a separately-granted capability in this CRM.
 *
 * Literal second segment "notes", so no collision with `/:id`.
 */
/*
 * `notes` is the only field a caller supplies. Everything else on the row is
 * derived server-side and deliberately NOT accepted: the author is the acting
 * user (a body-supplied name is a forgeable byline on a table with no id to
 * check it against), the stage is a snapshot of the job's own status, and the
 * timestamp is the server's.
 *
 * `.trim()` before `.min(1)`, so a body of spaces is a 400 and not a blank row
 * in the log. The 2000-char cap matches commentBody above rather than the
 * column's TEXT ceiling: these are operator one-liners, the CRM renders them in
 * a list, and an unbounded free-text field behind an authenticated POST is a
 * storage-growth problem with no owner.
 */
const noteBody = Joi.object({
  notes: Joi.string().trim().min(1).max(2000).required(),
});

router.get('/:id/notes', validate(idParam, 'params'), scopedJob, async (req, res, next) => {
  try {
    const notes = await jobNotes.listNotes(req.params.id);
    modernOk(res, notes);
  } catch (e) { next(e); }
});

router.post('/:id/notes',
  validate(idParam, 'params'),
  validate(noteBody),
  scopedJob,
  async (req, res, next) => {
    try {
      /*
       * req.scopedJob is the row the guard already fetched — the note's stage
       * snapshot comes off it, so recording "where this job sat when the note
       * was written" costs no second read. req.user supplies the author NAME
       * (the column holds names, not ids); a body-supplied author would be an
       * attribution anyone could forge.
       */
      const created = await jobNotes.addNote(req.params.id, req.body, req.scopedJob, req.user);
      res.status(201);
      modernOk(res, created, 'Note added');
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  });

/*
 * PATCH /jobs/:id/notes/:noteId/pin  { pinned: boolean }
 *
 * The one change a note allows after it is written: pin it on top, or unpin
 * it. The TEXT stays read-and-add-only — a pin changes where a note sits, not
 * what it says or who wrote it — so the log contract above still holds.
 * Same guard chain as the two note routes; the note must belong to :id.
 */
const notePinParams = Joi.object({
  id: Joi.number().integer().positive().required(),
  noteId: Joi.number().integer().positive().required(),
});
const notePinBody = Joi.object({ pinned: Joi.boolean().required() });

router.patch('/:id/notes/:noteId/pin',
  validate(notePinParams, 'params'),
  validate(notePinBody),
  scopedJob,
  async (req, res, next) => {
    try {
      const result = await jobNotes.setPinned(req.params.id, req.params.noteId, req.body.pinned, req.user);
      modernOk(res, result, req.body.pinned ? 'Note pinned' : 'Note unpinned');
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  });

router.post('/:id/notify-unreachable', validate(idParam, 'params'), scopedJob, async (req, res, next) => {
  try {
    logger.info('Notify customer unreachable · jobId=' + req.params.id);
    const result = await job.notifyCustomerNotReachable(req.params.id);
    modernOk(res, result, result.sent ? 'Customer notified' : 'SMS not sent');
  } catch (e) { logger.error('Notify unreachable failed · jobId=' + req.params.id + ' · ' + e.message); next(e); }
});

// ─── Re-send the customer PIN (ops escape hatch) ─────────────────────
/*
 * POST /jobs/:id/resend-customer-pin
 *
 * WHY IT EXISTS
 *   tbl_job.otp is the 4-digit code minted on the BOOKED transition
 *   (job.service setStatus) and read back by the customer at the door. It is
 *   moving from a START control to a CLOSE control, which changes the cost of
 *   a technician who cannot get it: he used to be unable to start (annoying);
 *   he is now unable to CLOSE a job he has already finished — work done,
 *   customer gone, job stuck open and unbillable. His only self-serve escape
 *   is the app's own POST /mobile/jobs/:id/checkin-sms. When that fails (wrong
 *   number on file, customer deleted the SMS) ops needs a way to help. There
 *   are two, both deliberate (owner's decision, 2026-09-11): the CRM job
 *   detail SHOWS the PIN (JobModal "Customer PIN (Closes the Job)", while the
 *   job is Pending to Start or Pending to Close), so an operator on the phone
 *   can read it out; and this route re-sends it by SMS to the customer's own
 *   number.
 *
 * WHY THE NAME IS NOT "checkin-sms"
 *   The mobile route is named for the transition that consumed the PIN. Once
 *   the PIN gates CLOSE instead of START, "check-in" names the wrong moment
 *   and would read wrong within the week. This one is named for the artifact
 *   and the act — re-send the customer PIN — which stays true whichever
 *   transition consumes it.
 *
 * OWNERSHIP: mobileLifecycle.sendCheckinSms() opens with getOwnedJob(jobId,
 *   efrId), which is the technician-app guard ("is this MY job?"). Ops is not
 *   a technician, and that service belongs to the mobile flow — adding an
 *   admin bypass inside it would put an "or the caller is staff" hole in the
 *   one check that stops a technician touching another technician's job. So
 *   the bypass is resolved HERE, from the caller's side: we pass the job's own
 *   assigned technician (tbl_job.fk_easyfixter_id), which satisfies the guard
 *   by being true rather than by being skipped. Authorisation for ops is the
 *   requireAction + scopedJob pair below, which is the admin tier's own model.
 *
 * NO TECHNICIAN ASSIGNED is a normal state for an unscheduled job, so it must
 *   not reach the service at all. Passing NULL through would satisfy
 *   getOwnedJob only by coincidence — Number(null) === Number(null) === 0 —
 *   i.e. the guard would pass because both sides are junk, and any future
 *   tightening there would turn this into a silent 404 for ops. We answer 409
 *   with an actionable sentence instead: nothing to close, nobody to read the
 *   PIN back, assign first.
 *
 * THE RESPONSE NEVER CARRIES THE PIN. It has no need to — CRM users already
 *   see it in the job detail — and a SEND action that also returned the code
 *   would make every caller of it a reader of it. The payload is rebuilt here
 *   as a literal instead of spreading the service's return value, so a later
 *   change in that file (which this route does not own) cannot widen it.
 *   (The TECHNICIAN app is the other way round: it must never receive the PIN
 *   — see routes/mobile/index.js GET /jobs/:id.)
 */

// Bound: 3 ATTEMPTS per job per 5 minutes — charged on the way in, before the
// scope read, so it can over-count a refusal but can never under-count a send.
// Keyed on the JOB, not the operator —
// what needs protecting is one customer's phone, and a per-operator key would
// let a second operator (or the same person in a second tab) start a fresh
// budget against the same customer. A legitimate "they didn't get it, try
// again" is 1-2 sends; thirty is a stuck button. Module scope, once:
// rateLimit() closes over its own Map, so building it per-request caps
// nothing. Per-process, like every limiter here — with N replicas the real
// ceiling is 3N per window, which is a backstop, not an exact quota.
const customerPinResendLimiter = rateLimit({
  windowMs: 5 * 60_000,
  max: 3,
  key: (req) => `job-pin-resend:${req.params.id}`,
});

router.post('/:id/resend-customer-pin',
  requireAction('isJobCustomerPinResend'),
  validate(idParam, 'params'),
  customerPinResendLimiter,
  scopedJob,
  async (req, res, next) => {
    try {
      const jobId = Number(req.params.id);
      const efrId = Number(req.scopedJob.fk_easyfixter_id || 0);
      logger.info('Re-send customer PIN · jobId=' + jobId + ' by userId=' + (req.user?.user_id ?? '-'));

      if (!efrId) {
        logger.warn('Re-send customer PIN refused · jobId=' + jobId + ' · no technician assigned');
        return modernError(
          res,
          409,
          'No technician is assigned to this job yet — assign one, then re-send the PIN',
        );
      }

      // Reuse: the service owns the customer-mobile lookup, the WhatsApp
      // template with its SMS fallback, and the 422s for "no mobile on file" /
      // "no PIN minted". Its e.status flows through middleware/error-handler as
      // a real 4xx with its own message.
      const outcome = await mobileLifecycle.sendCheckinSms(jobId, efrId);

      /*
       * NOW IT REPORTS WHAT ACTUALLY HAPPENED.
       *
       * The note that stood here said this route could not tell delivery from
       * dispatch, because sendCheckinSms() discarded smsService.send()'s
       * result and returned { sent: true } either way — and it closed with
       * "fixing it means threading `delivered` out of the service, which lives
       * in a file this change does not own — reported, not patched".
       *
       * It is patched now. That service returns { sent, channel, delivered },
       * so ops sees which channel carried the PIN and whether the provider
       * accepted it. That matters more than it used to: every one of these was
       * being REJECTED by DLT while this endpoint answered "triggered", which
       * is precisely how a technician ended up unable to close a job with the
       * CRM insisting the PIN had gone out.
       */
      /*
       * Into JOB HISTORY, not just the application log. The line above is
       * invisible on the job, unattributed to a person there, and rolls off —
       * and "why couldn't this job close?" is a question asked on the job.
       *
       * FAIL OPEN. The SMS has already gone to the customer; a failed history
       * row must not turn that into a 500 that has ops press the button again
       * (and spend another slot of the 3-per-5-minutes budget) for a message
       * that was already sent. jobLog.write() swallows its own errors, but this
       * route does not depend on a promise made in another file.
       */
      try {
        await jobLog.logCustomerPinResent(jobId, req.user);
      } catch (le) {
        logger.warn('PIN re-send history row failed (non-fatal) · jobId=' + jobId + ' · ' + le.message);
      }

      logger.info(
        'Customer PIN re-send dispatched · jobId=' + jobId
        + ' · channel=' + outcome.channel + ' · delivered=' + Boolean(outcome.delivered),
      );
      return modernOk(
        res,
        { sent: Boolean(outcome.sent), channel: outcome.channel, delivered: Boolean(outcome.delivered) },
        outcome.delivered
          ? `PIN re-sent on ${outcome.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'}`
          : 'PIN re-send attempted, but the provider did not accept it — check the number and try again',
      );
    } catch (e) {
      logger.warn('Re-send customer PIN failed · jobId=' + req.params.id + ' · ' + e.message);
      return next(e);
    }
  },
);

// ─── Ops check-in (on the assigned technician's behalf) ──────────────
/*
 * POST /jobs/:id/checkin
 *
 * WHY IT EXISTS
 *   Check-in is the TAT anchor: `checkin_date_time` starts Segment 2 and
 *   `fk_checkin_by` says whose visit it was. The only CRM path that reached
 *   status 2 was PATCH /:id/status {status:2}, which moves the code and writes
 *   NEITHER — so every job started from My Orders → Pending to Start looked, to
 *   every downstream report, like a visit that never began. Ops needs the
 *   escape hatch (dead phone, app not installed, technician mid-drive), and the
 *   escape hatch has to leave the same trail the app leaves.
 *
 * WHOSE ID GOES IN fk_checkin_by
 *   The JOB'S OWN technician — `tbl_job.fk_easyfixter_id` — never the operator.
 *   Same resolution as POST /:id/resend-customer-pin above: satisfy the
 *   technician-shaped contract by passing the job's real technician rather than
 *   by adding a staff bypass to it. This matches the one other live writer,
 *   routes/mobile/index.js POST /jobs/:id/checkin, which stamps req.tech.efr_id.
 *
 *   ⚠ THE COLUMN'S HISTORICAL CONTENTS ARE A DIFFERENT ID SPACE, measured
 *   2026-09-08 on `easyfix`: of 307,293 populated rows joinable to their
 *   technician, 223,012 hold `tbl_easyfixer.user_id` (the technician's
 *   tbl_user id) and exactly ONE holds an efr_id. Every one of the 1,799
 *   distinct values is a valid tbl_user.user_id. So legacy stored the
 *   TECHNICIAN, but by their tbl_user id — not, as is sometimes assumed, an
 *   operator. All 348,626 of those rows predate cutover (newest check-in
 *   2026-04-29); this backend has written the column zero times so far.
 *   Writing an efr_id here therefore agrees with the current code and
 *   disagrees with the history, and any report joining fk_checkin_by to
 *   tbl_user will mis-resolve the new rows. That is a decision for the mobile
 *   route (which set the precedent) and this one TOGETHER — flagged, not
 *   silently forked: what must never happen is the CRM and the app disagreeing
 *   about which id a check-in records.
 *
 * SO HOW IS "OPS DID THIS" RECOVERABLE?
 *   From the two rows this writes, not from a flag column (there is none, and
 *   adding one to a shared legacy table is not on the table):
 *     - tbl_job_logs 'status change' — actor is `req.user`, so job-log's
 *       resolveActor puts the operator's user_id in `changed_by` with
 *       comments 'Changed by New CRM'. A technician check-in lands
 *       changed_by = 0 / 'Changed by App', so the two are never confusable.
 *     - tbl_job_comment comment_on = 2 (check_in) carrying the REASON, with
 *       commented_by = the operator. No LIVE writer produces a 2: the 108,118
 *       existing rows are all legacy, newest 2026-04-28, none since cutover
 *       (measured 2026-09-08). So a 2 dated after cutover is unambiguously an
 *       ops check-in with a typed justification.
 *
 * WHY THE REASON IS REQUIRED
 *   An ops check-in moves an SLA anchor for work the operator did not witness.
 *   The one thing that makes that auditable rather than merely convenient is a
 *   sentence saying why it wasn't the technician. Joi enforces it; there is no
 *   default and no blank.
 *
 * NO COORDINATES, DELIBERATELY. The operator is not at the site, so
 *   checkin_gps_location / checkin_address / checkin_pincode are simply not
 *   passed (setStatus skips an absent extra rather than NULLing it, so a
 *   technician's earlier reading survives). Nothing here touches the arrival
 *   geofence either — that lives on the reached-location/selfie path
 *   (mobile-job-lifecycle.saveSelfie), behind `if (device)`, and is not on the
 *   check-in path at all.
 *
 * checkin_date_time is WRITE-ONCE in setStatus (WRITE_ONCE_EXTRAS → COALESCE),
 *   so an ops check-in AFTER a technician's cannot move the anchor forward.
 */
const opsCheckinBody = require('joi').object({
  reason: require('joi').string().trim().min(1).max(500).required(),
});

router.post('/:id/checkin',
  validate(idParam, 'params'),
  validate(opsCheckinBody),
  scopedJob,
  // Fixed target 2 — see the 'checkin' kind in middleware/require-stage.js.
  requireStageForTransition('checkin'),
  requireAction('isJobStatusChange'),
  async (req, res, next) => {
    try {
      const jobId  = Number(req.params.id);
      const efrId  = Number(req.scopedJob.fk_easyfixter_id || 0);
      const source = Number(req.scopedJob.job_status);
      logger.info('Ops check-in · jobId=' + jobId + ' by userId=' + (req.user?.user_id ?? '-'));

      // No technician = nobody whose visit this could be, so there is no id to
      // put in fk_checkin_by. Passing NULL would satisfy nothing and leave the
      // anchor attributed to no one — refuse with the action to take instead.
      if (!efrId) {
        logger.warn('Ops check-in refused · jobId=' + jobId + ' · no technician assigned');
        return modernError(
          res,
          409,
          'No technician is assigned to this job yet — assign one, then check the job in',
        );
      }
      // SCHEDULED only. A job already in progress has its anchor (and a second
      // call could not move it anyway); anything else has not been scheduled.
      if (source !== 1 /* SCHEDULED */) {
        logger.warn('Ops check-in refused · jobId=' + jobId + ' · job_status=' + source);
        return modernError(
          res,
          409,
          'Only a scheduled job can be checked in — this job is in status ' + source,
        );
      }

      /*
       * fk_checkin_by IS A tbl_user.user_id — MEASURED, not inferred.
       *
       * Counted on the live schema 2026-09-08, joining each job to its own
       * technician: of 348,619 populated rows, 223,012 equal
       * tbl_easyfixer.user_id and 29 equal efr_id — and those 29 are noise,
       * since the two id ranges overlap and membership is not identity. The
       * legacy CRM agrees, rendering the actor through
       * `LEFT JOIN tbl_user checkIn_by ON checkIn_by.user_id = J.fk_checkin_by`.
       *
       * So the value is the TECHNICIAN'S CRM user id, not their efr_id. Every
       * populated row predates cutover (newest 2026-04-29) and this backend has
       * written the column zero times, so nothing has forked yet — an efr_id
       * here would open a second namespace in a column with 348k consistent
       * rows, and resolve to a DIFFERENT PERSON wherever it is joined.
       *
       * NOTE: routes/mobile/index.js still writes req.tech.efr_id here. That is
       * the same defect and it has also never fired; it needs the same fix, but
       * it is the technician app's path and is not changed from here.
       */
      // Required here, not at module scope — the convention this file already
      // follows (see the other handlers that touch the pool directly).
      const { pool } = require('../../db');
      const [[tech]] = await pool.query(
        'SELECT user_id FROM tbl_easyfixer WHERE efr_id = ? LIMIT 1', [efrId],
      );
      const checkinById = Number(tech?.user_id || 0);
      if (!checkinById) {
        /*
         * A technician with no tbl_user row cannot be represented in this
         * column. Refuse rather than stamp 0, which would read as "no one" and
         * silently detach the TAT anchor from whoever actually attended.
         */
        logger.warn('Ops check-in refused · jobId=' + jobId + ' · efr=' + efrId + ' has no tbl_user row');
        return modernError(
          res,
          409,
          'This technician has no CRM user record, so the check-in cannot be attributed — contact support',
        );
      }

      const updated = await job.setStatus(
        jobId,
        { status: 2 /* IN_PROGRESS */, extras: { fk_checkin_by: checkinById, checkin_date_time: new Date() } },
        req.user, // no efr_id → job-log records the OPERATOR, not the technician
      );

      /*
       * FAIL OPEN, and after the transition — same rule as the cancel audit
       * comment in setStatus() and the history row on /resend-customer-pin. The
       * status has already committed; a comment failure must not turn that into
       * a 500 that has ops press the button again on a job that is already
       * checked in. The reason is then only in the warn line below, which is
       * the cost of not double-checking-in a job.
       */
      try {
        await jobComments.addComment(jobId, {
          comments: req.body.reason,
          comment_on: 2, // check_in
          commented_by: req.user?.user_id ?? null,
        });
      } catch (ce) {
        logger.warn('Ops check-in reason comment failed (non-fatal) · jobId=' + jobId
          + ' · reason=' + req.body.reason + ' · ' + ce.message);
      }

      logger.info('Ops check-in done · jobId=' + jobId + ' · status->IN_PROGRESS · efrId=' + efrId);
      // Same payload as PATCH /:id/status (the refreshed job) so the CRM reuses
      // its existing refresh path rather than growing a second one.
      return modernOk(res, updated, 'job checked in');
    } catch (e) {
      logger.warn('Ops check-in failed · jobId=' + req.params.id + ' · ' + e.message);
      return next(e);
    }
  },
);

// ─── Material Review (Material Management phase 2, sub-project D) ─────
// POST /:id/material-review { decision: 'approve'|'reject', reason?, permission_required? }
//
// PM review of a technician's material estimate. The job must be at 16
// (Pending for Material) — anything else 409s, since there is nothing to
// review otherwise:
//   approve → 15 (ESTIMATE_PENDING_APPROVAL), clears material_sub_status,
//             stores permission_required (0/1 — "Appointment / Permission
//             Required", ticked at approval time — see the design's "Flow").
//   reject  → 16, material_sub_status = 1 (back to Quotation Pending) so the
//             quote stays editable; the reason is recorded for the
//             technician via the existing job-comment channel (comment_on=1,
//             the same "approval-related" bucket the legacy vocabulary
//             already uses — see services/job-comment.service.js STAGES).
//
// Goes through jobService.setStatus() (not the hold/release path at
// PUT/POST /:id/hold[/release] above, which is a different transition
// entirely and sets 10) so the transition logs + fires webhooks like every
// other status move. See
// docs/superpowers/specs/2026-09-18-pending-for-material-status-16-design.md.
//
// Sub-project E (2026-09-18) adds the per-material-line review — see
// docs/superpowers/specs/2026-09-18-ops-material-approval-design.md
// "Backend". `lines` is only meaningful when the outer `decision` is
// 'approve'; a whole-review reject leaves every quotation_details row
// untouched exactly like before, so its Joi shape stays a bare array with
// per-item type checks — the coverage / amount rules the spec calls out
// (missing, unknown, duplicate line_id; a negative or misplaced
// approved_amount) are business-content errors, so they 422 out of the
// handler below rather than 400 out of this schema.
//
// STATUS VALUES — reused verbatim from routes/admin/quotations.js PATCH
// /:id/approve|reject, NOT the 3-value scheme the design doc's prose
// describes (0 pending/1 approved/2 rejected — that mapping appears nowhere
// in this codebase; grep finds no reader of quotation_details.status = 2
// anywhere, while services/job.service.js's dashboard filters, job-export.
// service.js, and quotations.js itself all agree on a DIFFERENT, 2-value
// one: status 1 = active/approved, status 0 = rejected, and `action_on`
// (NULL vs stamped) is what actually distinguishes "never reviewed" from
// "approved" — see mobile-job-estimate.service.js's own
// `quotation_actioned_on` for a third confirming reader).  A technician's
// material line is INSERTED at status = 1 (mobile-job-estimate.service.js
// addQuotationLine) with action_on NULL, so PENDING here is
// `status = 1 AND action_on IS NULL` — approve stamps action_on (status
// stays 1, matching quotations.js's approve exactly); reject sets
// status = 0 (matching quotations.js's reject exactly, not an invented 2).
const materialLineBody = require('joi').object({
  line_id: require('joi').number().integer().positive().required(),
  decision: require('joi').string().valid('approve', 'reject').required(),
  approved_amount: require('joi').number().optional(),
  // quoted_unit_price (2026-09-24): optional, approve-only — updates
  // quotation_details.unit_price (a legacy INT column) in the same
  // transaction, before approval. Left as a bare number here (not
  // .integer()) so a fractional value 422s from validateMaterialLineContent
  // below with the design's own message, rather than a generic 400.
  quoted_unit_price: require('joi').number().min(0).optional(),
});

const materialReviewBody = require('joi').object({
  decision: require('joi').string().valid('approve', 'reject').required(),
  reason: require('joi').string().trim().max(500).when('decision', {
    is: 'reject', then: require('joi').required(), otherwise: require('joi').optional(),
  }),
  permission_required: require('joi').number().integer().valid(0, 1).default(0),
  lines: require('joi').array().items(materialLineBody).default([]),
});

/*
 * Every PENDING (status = 1, action_on NULL — see the STATUS VALUES note
 * above) type='material' quotation_details row on the job must appear in
 * `lines` exactly once — reused as the "did Ops half-review this job" guard
 * the design calls for.
 *
 * Material Request Flow v2 (2026-09-21) splits the old single validator in
 * two, with different HTTP outcomes:
 *   - COVERAGE (a missing or an unknown/extra line_id) means the quote
 *     changed under the reviewer — a technician (or the CRM) added or
 *     removed a line while this review screen was open. That is a 409, with
 *     the exact contract message the CRM shows: "New materials were added —
 *     reload and review again".
 *   - CONTENT (duplicate line_id, a missing/negative approved_amount, an
 *     amount on a rejected line) is a malformed submission from the SAME
 *     screen — 422, unchanged from before.
 *
 * Column semantics (approved_charge / status / action_by / action_on) are
 * the SAME ones routes/admin/quotations.js PATCH /:id/approve|reject
 * already write — reused, not reinvented.
 */
const MATERIAL_LINES_CHANGED_MESSAGE = 'New materials were added — reload and review again';

function findMaterialLinesCoverageError(pendingIds, lines) {
  const submittedIds = new Set(lines.map((l) => Number(l.line_id)));
  const hasExtra = [...submittedIds].some((id) => !pendingIds.has(id));
  const hasMissing = [...pendingIds].some((id) => !submittedIds.has(id));
  return (hasExtra || hasMissing) ? MATERIAL_LINES_CHANGED_MESSAGE : null;
}

function validateMaterialLineContent(lines) {
  const seen = new Map();
  for (const line of lines) {
    const lid = Number(line.line_id);
    if (seen.has(lid)) return `duplicate line_id ${lid} in lines`;
    seen.set(lid, line);
  }
  for (const [lid, line] of seen) {
    if (line.decision === 'approve') {
      if (line.approved_amount === undefined || line.approved_amount === null) {
        return `approved_amount is required for approved line ${lid}`;
      }
      if (Number(line.approved_amount) < 0) {
        return `approved_amount must be >= 0 for line ${lid}`;
      }
      // quoted_unit_price (2026-09-24) — optional, updates the legacy INT
      // unit_price column: a fractional value would be TRUNCATED by MySQL
      // with no error, so it 422s here instead, same rule
      // mobile-job-estimate.service.js already enforces on the technician's
      // own quote.
      if (line.quoted_unit_price !== undefined && line.quoted_unit_price !== null) {
        if (!Number.isInteger(Number(line.quoted_unit_price))) {
          return `quoted_unit_price must be a whole number for line ${lid}`;
        }
      }
    } else if (line.approved_amount !== undefined) {
      return `approved_amount is forbidden on rejected line ${lid}`;
    }
  }
  return null;
}

router.post(
  '/:id/material-review',
  validate(idParam, 'params'),
  validate(materialReviewBody),
  scopedJob,
  requireAction('isJobMaterialReview'),
  async (req, res, next) => {
    try {
      const jobId = Number(req.params.id);
      const { decision, reason, permission_required: permissionRequired, lines: submittedLines } = req.body;
      logger.info('Material review · jobId=' + jobId + ' · decision=' + decision + ' by userId=' + (req.user?.user_id ?? '-'));

      if (Number(req.scopedJob.job_status) !== job.STATUS.PENDING_FOR_MATERIAL) {
        logger.warn('Material review refused · jobId=' + jobId + ' · job_status=' + req.scopedJob.job_status);
        return modernError(res, 409, 'This job is not pending material review — it is in status ' + req.scopedJob.job_status);
      }

      let updated;
      if (decision === 'approve') {
        // Line writes (quotation_details) AND the job's move to 15 happen on
        // ONE connection/transaction — a failing line write must leave the
        // job at 16, never partway approved. See job.service.js setStatus's
        // `conn` option, added for exactly this caller.
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          // Material Request Flow v2 (2026-09-21): "pending" now ALSO requires
          // sent_on IS NOT NULL — a draft line (added but never sent) is not
          // under review at all and must never be forced into this payload.
          // This is exactly quotationLineState's `review_pending` predicate,
          // narrowed to type='material' (this endpoint's own scope).
          const [pendingRows] = await conn.query(
            `SELECT id FROM quotation_details
              WHERE job_id = ? AND type = 'material'
                AND ${quotationLineState.statePredicateSql('quotation_details', quotationLineState.STATE.REVIEW_PENDING)}
              FOR UPDATE`,
            [jobId],
          );
          const pendingIds = new Set(pendingRows.map((r) => Number(r.id)));
          const lines = Array.isArray(submittedLines) ? submittedLines : [];
          const coverageError = findMaterialLinesCoverageError(pendingIds, lines);
          if (coverageError) {
            try { await conn.rollback(); } catch { /* nothing was written yet */ }
            logger.warn('Material review approve refused (coverage) · jobId=' + jobId + ' · ' + coverageError);
            return modernError(res, 409, coverageError);
          }
          const contentError = validateMaterialLineContent(lines);
          if (contentError) {
            try { await conn.rollback(); } catch { /* nothing was written yet */ }
            logger.warn('Material review approve refused (content) · jobId=' + jobId + ' · ' + contentError);
            return modernError(res, 422, contentError);
          }

          const now = new Date();
          for (const line of lines) {
            if (line.decision === 'approve') {
              // quoted_unit_price (2026-09-24) updates unit_price in the SAME
              // transaction, BEFORE the approval columns below — content
              // validation above already 422'd a fractional value.
              if (line.quoted_unit_price !== undefined && line.quoted_unit_price !== null) {
                await conn.query(
                  `UPDATE quotation_details SET unit_price = ? WHERE id = ? AND job_id = ?`,
                  [Math.round(Number(line.quoted_unit_price)), line.line_id, jobId],
                );
              }
              await conn.query(
                `UPDATE quotation_details
                    SET approved_charge = ?, status = 1, action_by = ?, action_on = ?
                  WHERE id = ? AND job_id = ?`,
                [line.approved_amount, req.user.user_id, now, line.line_id, jobId],
              );
            } else {
              // status = 0, exactly what quotations.js PATCH /:id/reject
              // writes — see the STATUS VALUES note above this route.
              await conn.query(
                `UPDATE quotation_details
                    SET status = 0, action_by = ?, action_on = ?
                  WHERE id = ? AND job_id = ?`,
                [req.user.user_id, now, line.line_id, jobId],
              );
            }
          }

          // The same status move the pre-existing approve path always made —
          // now issued on OUR connection (via setStatus's `conn` option) so
          // it commits or rolls back with the line writes above.
          await job.setStatus(
            jobId,
            {
              status: job.STATUS.ESTIMATE_PENDING_APPROVAL,
              // Clear any stale reject reason from a PREVIOUS review round —
              // an approved estimate must not still show the tech an old
              // rejection message.
              extras: { material_sub_status: null, permission_required: permissionRequired, material_reject_reason: null },
            },
            req.user,
            { conn },
          );
          await conn.commit();
        } catch (e) {
          try { await conn.rollback(); } catch { /* connection may already be gone */ }
          throw e;
        } finally {
          conn.release();
        }
        // setStatus's own return value reads the job via the pool, which — for
        // the instant before the commit() above — can still see the PRE-move
        // row (a separate connection under REPEATABLE READ never sees our
        // uncommitted UPDATE). Re-read now that the transaction is durable so
        // the response reflects the real, committed status.
        updated = await job.getById(jobId);

        // "Send Request to Client" — fire-and-forget, exactly like
        // send-for-approval's sendEstimateEmail: AFTER commit, never
        // awaited, and a failure here must never undo or fail this
        // response (see services/material-client-request.service.js).
        require('../../services/material-client-request.service')
          .sendMaterialClientRequest(jobId)
          .catch((err) => {
            logger.warn('Material client request failed (non-fatal) · jobId=' + jobId + ' · ' + err.message);
          });
      } else {
        // "Reject Request" (Material Request Flow v2, 2026-09-21): every
        // review_pending material line on the job is rejected AND the job
        // returns to its PRE-request status (1/2/20, default 2) — NOT back
        // to 16/1 "Quotation Pending" as sub-project D originally shipped.
        // Line writes + the status move happen on ONE connection, same
        // reasoning as the approve branch above: a failing line write must
        // leave the job at 16, never partway reverted.
        const preStatus = await require('../../services/material-review-store').getPreMaterialStatus(jobId);
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          const [pendingRows] = await conn.query(
            `SELECT id FROM quotation_details
              WHERE job_id = ? AND type = 'material'
                AND ${quotationLineState.statePredicateSql('quotation_details', quotationLineState.STATE.REVIEW_PENDING)}
              FOR UPDATE`,
            [jobId],
          );
          const now = new Date();
          for (const row of pendingRows) {
            await conn.query(
              `UPDATE quotation_details
                  SET status = 0, action_by = ?, action_on = ?
                WHERE id = ? AND job_id = ?`,
              [req.user.user_id, now, row.id, jobId],
            );
          }
          updated = await job.setStatus(
            jobId,
            {
              status: preStatus,
              // material_reject_reason is the CONTRACT field the technician
              // app reads (see the migration header) — the primary channel
              // for "why was this rejected", not a nicety.
              extras: { material_sub_status: null, material_reject_reason: reason },
            },
            req.user,
            { conn },
          );
          await conn.commit();
        } catch (e) {
          try { await conn.rollback(); } catch { /* connection may already be gone */ }
          throw e;
        } finally {
          conn.release();
        }
        // See the approve branch's identical comment above: re-read now that
        // the transaction is durable, rather than trust setStatus's own
        // pre-commit read.
        updated = await job.getById(jobId);
        // Also mirrored onto the CRM History tab, fail-soft and after the
        // status has already committed — same rule as the ops check-in
        // reason comment above: a comment failure must not turn a landed
        // transition into a 500 that has the PM press the button again.
        try {
          await jobComments.addComment(jobId, {
            comments: reason,
            comment_on: 1, // 'created/schedule/approval-related' — see STAGES
            commented_by: req.user?.user_id ?? null,
          });
        } catch (ce) {
          logger.warn('Material review reject reason comment failed (non-fatal) · jobId=' + jobId + ' · ' + ce.message);
        }
      }

      logger.info('Material review done · jobId=' + jobId + ' · decision=' + decision + ' · status->' + updated.job_status);
      return modernOk(res, updated, decision === 'approve' ? 'material estimate approved' : 'material estimate rejected');
    } catch (e) {
      logger.warn('Material review failed · jobId=' + req.params.id + ' · ' + e.message);
      return next(e);
    }
  },
);

// ─── NEW — CRM add a material line (Material Request Flow v2, 2026-09-21) ──
// POST /:id/quotation-lines { materialId, brandId?, quantity, approvedAmount }
// behind scopedJob + requireAction('isJobMaterialReview') → { lineId, job_status }.
//
// The line is born REVIEWED — Ops added it, so it needs no further internal
// review, only the client's: sent_on = action_on = now, status = 1,
// approved_charge = the entered amount. unit_price = round(approvedAmount)
// (same INT-column rule mobile-job-estimate.service.js's addQuotationLine
// already enforces); client_charge = the resolved rate-card price, a
// snapshot, NULL when the resolver has none; name = the master material's
// own name, never whatever the caller sent.
//
// Job-status transition (design's "Transitions", "CRM add line"): allowed
// from 1/2/20/16/15 (not closed/cancelled) — 16 stays 16; 15 stays 15 and the
// client request is RE-sent; 1/2/20 move to 15, storing the job's pre-status
// so a later Reject Request can restore it. Anything else → 409.
const quotationLinesBody = Joi.object({
  materialId: Joi.number().integer().positive().required(),
  brandId: Joi.number().integer().positive().optional(),
  quantity: Joi.number().integer().min(1).required(),
  approvedAmount: Joi.number().min(0).required(),
});

const CRM_ADD_LINE_ALLOWED_STATUSES = new Set([
  1, job.STATUS.IN_PROGRESS, job.STATUS.IN_PROGRESS_ALT,
  job.STATUS.PENDING_FOR_MATERIAL, job.STATUS.ESTIMATE_PENDING_APPROVAL,
]);
const CRM_ADD_LINE_ENTRY_STATUSES = new Set([1, job.STATUS.IN_PROGRESS, job.STATUS.IN_PROGRESS_ALT]);

router.post(
  '/:id/quotation-lines',
  validate(idParam, 'params'),
  validate(quotationLinesBody),
  scopedJob,
  requireAction('isJobMaterialReview'),
  async (req, res, next) => {
    const { pool } = require('../../db');
    try {
      const jobId = Number(req.params.id);
      const jobStatus = Number(req.scopedJob.job_status);
      logger.info('CRM add quotation line · jobId=' + jobId + ' · materialId=' + req.body.materialId + ' by userId=' + (req.user?.user_id ?? '-'));

      if (!CRM_ADD_LINE_ALLOWED_STATUSES.has(jobStatus)) {
        logger.warn('CRM add quotation line refused · jobId=' + jobId + ' · job_status=' + jobStatus);
        return modernError(res, 409, 'This job cannot take a new material line in its current status');
      }

      const [[material]] = await pool.query(
        `SELECT material_id, material_name, CAST(status AS SIGNED) AS status
           FROM tbl_material_master WHERE material_id = ? LIMIT 1`,
        [req.body.materialId],
      );
      if (!material || material.status !== 1) {
        logger.warn('CRM add quotation line refused · material not found/active · jobId=' + jobId + ' · materialId=' + req.body.materialId);
        return modernError(res, 422, 'material not found');
      }

      const [[addr]] = await pool.query(
        `SELECT ci.state_id
           FROM tbl_job j
           LEFT JOIN tbl_address ad ON ad.address_id = j.fk_address_id
           LEFT JOIN tbl_city    ci ON ci.city_id    = ad.city_id
          WHERE j.job_id = ? LIMIT 1`,
        [jobId],
      );
      const { resolveMaterialPrice, defaultTxShare } = require('../../services/material-price-resolver');
      const resolvedPrice = await resolveMaterialPrice({
        clientId: req.scopedJob.fk_client_id, materialId: req.body.materialId,
        brandId: req.body.brandId || null, stateId: addr ? addr.state_id : null,
      });
      const clientCharge = resolvedPrice.source === 'none' ? null : (Number(resolvedPrice.price) || 0);

      const approvedAmount = Number(req.body.approvedAmount);
      const unitPrice = Math.round(approvedAmount);
      // Tx Share (2026-09-24) snapshot for this unit — the resolver's own
      // figure, falling back to 20% of the BILLED unit_price when the
      // resolver had no price at all ('none').
      const txShare = (resolvedPrice.tx_share !== null && resolvedPrice.tx_share !== undefined)
        ? Number(resolvedPrice.tx_share) : defaultTxShare(unitPrice);
      const now = new Date();
      const entersEstimatePending = CRM_ADD_LINE_ENTRY_STATUSES.has(jobStatus);

      const conn = await pool.getConnection();
      let lineId;
      try {
        await conn.beginTransaction();
        // tx_charge appended LAST in the column list (not its native table
        // position) so every existing positional param index above is
        // unchanged — see tests/material-request-flow-v2-admin.test.js's
        // INSERT INTO quotation_details destructuring.
        const [ins] = await conn.query(
          `INSERT INTO quotation_details
             (type, name, unit, unit_price, client_charge, approved_charge, margin,
              status, action_by, sent_by, sent_on, action_on,
              job_id, material_id, tx_charge)
           VALUES ('material', ?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?, ?, ?)`,
          [
            material.material_name, req.body.quantity, unitPrice,
            clientCharge, approvedAmount,
            req.user.user_id, req.user.user_id, now, now,
            jobId, req.body.materialId, txShare,
          ],
        );
        lineId = ins.insertId;

        if (entersEstimatePending) {
          await require('../../services/material-review-store').storePreMaterialStatus(jobId, jobStatus, conn);
          await job.setStatus(jobId, { status: job.STATUS.ESTIMATE_PENDING_APPROVAL }, req.user, { conn });
        }
        await conn.commit();
      } catch (e) {
        try { await conn.rollback(); } catch { /* connection may already be gone */ }
        throw e;
      } finally {
        conn.release();
      }

      const updated = await job.getById(jobId);

      // "Client request sent" (entering 15) / "re-sent" (already at 15) —
      // fire-and-forget, same rule as the material-review approve path above:
      // never awaited, never allowed to fail this response. Not fired for a
      // line landing at 16 — the client hasn't been notified about this job
      // at all yet, so there is nothing to (re-)send.
      if (entersEstimatePending || jobStatus === job.STATUS.ESTIMATE_PENDING_APPROVAL) {
        require('../../services/material-client-request.service')
          .sendMaterialClientRequest(jobId)
          .catch((err) => {
            logger.warn('Material client request failed (non-fatal) · jobId=' + jobId + ' · ' + err.message);
          });
      }

      logger.info('CRM quotation line created · id=' + lineId + ' · jobId=' + jobId + ' · job_status=' + updated.job_status);
      res.status(201);
      return modernOk(res, { lineId, job_status: updated.job_status });
    } catch (e) {
      logger.warn('CRM add quotation line failed · jobId=' + req.params.id + ' · ' + e.message);
      return next(e);
    }
  },
);

// ─── NEW — Admin "approve on client's behalf" (Material Request Flow v2)
// ─────────────────────────────────────────────────────────────────────────
// POST /:id/client-approval-on-behalf (multipart/form-data)
//   comment          : string, trimmed, 10..1000 chars, required
//   files            : 1..5 files, each <=10MB — audio (mp3/m4a/wav/aac/ogg),
//                       image (jpeg/png/webp/heic) or application/pdf,
//                       validated by BOTH mimetype AND extension.
//                       Deliberately NOT job-image.service's byte-sniff gate
//                       (assertUploadableFile) — that allowlist is image/PDF
//                       only (see its own header) and every one of its four
//                       callers is a photo or a document upload; this is the
//                       first caller that can legitimately carry a
//                       phone-call recording, so widening the shared
//                       sniffer for everyone was rejected in favour of this
//                       route validating its own (wider) allowlist and
//                       handing job-image.service an already-resolved
//                       contentType.
//   visit_date_time  : 'YYYY-MM-DD HH:00:00' (IST) — validated by
//                       services/visit-slots.service.js#assertSlotBookable.
//   permission       : 'now' | 'later' | 'not_required'.
//   permission_file  : one file, required iff permission='now' — pdf / jpeg
//                       / png / webp / heic, <=10MB — validated by
//                       services/job-estimate-approval.js's OWN table (see
//                       its header for why that's separate from the one
//                       above: heic isn't in job-image.service's byte-sniff
//                       allowlist either).
//
// Ops sometimes gets a client's approval over a phone call or a WhatsApp
// voice note rather than through the portal/magic-link — this endpoint lets
// an authorised PM (isJobMaterialReview) record that proof and apply the
// SAME approval the client would have applied themselves, including the
// visit date/time and site-access permission choice the client gave over
// that same call. Guarded to status 15 (ESTIMATE_PENDING_APPROVAL) exactly
// like every other estimate-approval surface
// (services/job-estimate-approval.js's isEstimateApprovable), with its own
// 409 message per the API contract.
//
// Storage: routes/admin/job-documents.js's own storage path —
// job-image.service's storeJobImageFile (the shared S3-or-local helper) +
// tbl_job_image (the SAME table Job Sheet / Purchase Order documents use)
// under a NEW category, 'ClientApprovalProof'.
// utils/job-image-buckets.js#DOCUMENT_CATEGORIES classifies it as a
// document, not a before/after work photo — same treatment as 'jobsheet' /
// 'po'. Categories are a plain in-code allowlist (job-charges.service.js's
// DOC_CATEGORIES is the Billing-tab example), not a DB table, so adding one
// is a code change, not a migration.
//
// Then: a job comment (services/job-comment.service.js#addComment,
// comment_on=1) prefixed "Approved on client's behalf: <comment>", and the
// SAME shared writer every approve surface uses
// (services/job-estimate-approval.js#approveWithVisitSchedule) — never a
// second approval writer.
const clientApprovalMulter = require('multer');
const clientApprovalUpload = clientApprovalMulter({
  storage: clientApprovalMulter.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 6 },
});

// mimetype -> allowed extension(s). Both must agree — a mismatched pair (a
// .wav renamed .mp3, or vice versa) is refused rather than guessed at.
const CLIENT_APPROVAL_PROOF_TYPES = {
  'audio/mpeg': ['.mp3'],
  'audio/mp3': ['.mp3'],
  'audio/x-m4a': ['.m4a'],
  'audio/m4a': ['.m4a'],
  'audio/mp4': ['.m4a'],
  'audio/wav': ['.wav'],
  'audio/x-wav': ['.wav'],
  'audio/wave': ['.wav'],
  'audio/aac': ['.aac'],
  'audio/x-aac': ['.aac'],
  'audio/ogg': ['.ogg'],
  'application/ogg': ['.ogg'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'image/heic': ['.heic'],
  'image/heif': ['.heic', '.heif'],
  'application/pdf': ['.pdf'],
};

function clientApprovalProofError(file) {
  const mime = String(file.mimetype || '').trim().toLowerCase();
  const exts = CLIENT_APPROVAL_PROOF_TYPES[mime];
  if (!exts) return `"${file.originalname}": unsupported file type (${file.mimetype})`;
  const ext = require('node:path').extname(file.originalname || '').toLowerCase();
  if (!exts.includes(ext)) return `"${file.originalname}": file extension does not match its declared type (${file.mimetype})`;
  return null;
}

// Two named fields now: the existing proof recording(s) ('files', 1..5) and
// the NEW site-access permission document ('permission_file', 0..1 — its
// OWN requiredness rule, checked in the handler once `permission` is known).
// Same MulterError-mapping reason as imageUploadOr400 below: a size/count
// rejection throws from INSIDE multer's own middleware, before the handler's
// try/catch can see it, and MulterError has no .status.
function clientApprovalUploadOr400(req, res, next) {
  clientApprovalUpload.fields([
    { name: 'files', maxCount: 5 },
    { name: 'permission_file', maxCount: 1 },
  ])(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return modernError(res, 400, 'each file must be 10MB or smaller');
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return modernError(res, 400, 'attach between 1 and 5 files');
    }
    return next(err);
  });
}

const clientApprovalOnBehalfBody = Joi.object({
  comment: Joi.string().trim().min(10).max(1000).required(),
  // Format/range validated by assertSlotBookable inside approveWithVisitSchedule
  // (its own 400 messages) — Joi only guards "present at all" here.
  visit_date_time: Joi.string().trim().required(),
  permission: Joi.string().valid('now', 'later', 'not_required').required(),
});

router.post(
  '/:id/client-approval-on-behalf',
  validate(idParam, 'params'),
  scopedJob,
  requireAction('isJobMaterialReview'),
  clientApprovalUploadOr400,
  validate(clientApprovalOnBehalfBody),
  async (req, res, next) => {
    const jobId = Number(req.params.id);
    try {
      if (Number(req.scopedJob.job_status) !== job.STATUS.ESTIMATE_PENDING_APPROVAL) {
        logger.warn('Client-approval-on-behalf refused · jobId=' + jobId + ' · job_status=' + req.scopedJob.job_status);
        return modernError(res, 409, 'This job is not waiting for client approval');
      }

      const files = req.files?.files || [];
      const permissionFile = req.files?.permission_file?.[0] || null;
      if (files.length < 1) return modernError(res, 400, 'attach at least 1 file (up to 5)');
      for (const file of files) {
        const fileErr = clientApprovalProofError(file);
        if (fileErr) return modernError(res, 400, fileErr);
      }

      // Validate visit_date_time/permission/permission_file AND re-check slot
      // availability BEFORE writing ANYTHING — including this route's OWN
      // proof-file storage and comment below, which otherwise land before
      // approveWithVisitSchedule gets a chance to validate them itself.
      const jobEstimateApproval = require('../../services/job-estimate-approval');
      const visitSlots = require('../../services/visit-slots.service');
      jobEstimateApproval.validatePermissionChoice(req.body.permission, permissionFile);
      await visitSlots.assertSlotBookable(jobId, req.body.visit_date_time, new Date());

      logger.info('Client-approval-on-behalf · jobId=' + jobId + ' · files=' + files.length
        + ' by userId=' + (req.user?.user_id ?? '-'));

      const { storeJobImageFile } = require('../../services/job-image.service');
      for (const file of files) {
        const mime = String(file.mimetype || '').trim().toLowerCase();
        await storeJobImageFile({ jobId, file, category: 'ClientApprovalProof', contentType: mime });
      }

      // Required, not best-effort: the comment IS the recorded proof text —
      // a failure here must surface (500), unlike the material-review reject
      // reason comment above, which is a nicety on an already-committed move.
      await jobComments.addComment(jobId, {
        comments: `Approved on client's behalf: ${req.body.comment}`,
        comment_on: 1,
        commented_by: req.user?.user_id ?? null,
      });

      // Re-validates (cheap — no write) then does the real work; see its
      // header for the transaction boundary and post-commit surfacing rules.
      const result = await jobEstimateApproval.approveWithVisitSchedule(jobId, req.user, {
        visitDateTime: req.body.visit_date_time,
        permissionChoice: req.body.permission,
        permissionFile,
        technicianId: req.scopedJob.fk_easyfixter_id,
        rescheduleActor: req.user, // the CRM user — never a client-contact id
        permissionSpocId: null,    // no client contact on this path
      });

      // A desk-priced additional-work claim is approved with the estimate (V3
      // 3.3) — the desk's "Approve as client". Post-commit, fail-soft.
      await require('../../services/ops-desk.service').settleAdditionalWork(jobId, true, req.user);
      const updated = await job.getById(jobId);
      logger.info('Client-approval-on-behalf done · jobId=' + jobId + ' · status->' + updated.job_status
        + ' · rescheduled=' + result.rescheduled + ' · permission=' + result.permission.choice);
      return modernOk(res, {
        job_status: updated.job_status,
        visit_date_time: result.visitDateTime,
        permission: { choice: result.permission.choice, request_id: result.permission.requestId },
        schedule_error: result.scheduleError,
        permission_error: result.permissionError,
      }, "approved on client's behalf");
    } catch (e) {
      logger.warn('Client-approval-on-behalf failed · jobId=' + req.params.id + ' · ' + e.message);
      return next(e);
    }
  },
);

// ─── GET /:id/visit-slots — the technician's free hours for the next 30
// days (Material Request Flow v2, 2026-09-22 correction). Same payload shape
// on all three surfaces (admin/client/public) — see
// services/visit-slots.service.js#listVisitSlots.
router.get(
  '/:id/visit-slots',
  validate(idParam, 'params'),
  scopedJob,
  requireAction('isJobMaterialReview'),
  async (req, res, next) => {
    try {
      const visitSlots = require('../../services/visit-slots.service');
      const slots = await visitSlots.listVisitSlots(Number(req.params.id));
      return modernOk(res, slots);
    } catch (e) { return next(e); }
  },
);

// ─── Job Feedback sub-resource (legacy tbl_customer_feedback) ─────────
const jobFeedback = require('../../services/job-feedback.service');
// VERIFIED against tbl_customer_feedback (see services/job-feedback.service.js).
// Legacy columns: easyfixer_rating, easyfix_rating, happy_with_service.
// `happyWithService` is a tinyint (0/1) per legacy convention.
const feedbackBody = Joi.object({
  easyfixerRating:   Joi.number().min(1).max(5).optional(),
  easyfixRating:     Joi.number().min(1).max(5).optional(),
  happyWithService:  Joi.number().integer().valid(0, 1).optional(),
}).min(1);

router.get('/:id/feedback', validate(idParam, 'params'), scopedJob, async (req, res, next) => {
  try {
    logger.info('Fetch job feedback · jobId=' + req.params.id);
    modernOk(res, await jobFeedback.getFeedback(req.params.id));
  } catch (e) { next(e); }
});

router.put('/:id/feedback',
  validate(idParam, 'params'),
  validate(feedbackBody),
  scopedJob,
  async (req, res, next) => {
    try {
      logger.info('Save job feedback · jobId=' + req.params.id);
      const row = await jobFeedback.upsertFeedback(Number(req.params.id), req.body);
      logger.info('Job feedback saved · jobId=' + req.params.id);
      modernOk(res, row, 'Feedback saved');
    } catch (e) { next(e); }
  }
);

// ─── Customer cancel / reschedule requests for ONE job ───────────────
// Surfaces the rows a customer logged from the public magic-link page
// (tbl_job_customer_request) so CRM ops can see them on the order detail.
// scopedJob enforces the same row-level scope as every other /:id route.
router.get('/:id/customer-requests', validate(idParam, 'params'), scopedJob, async (req, res, next) => {
  try {
    logger.info('List customer requests · jobId=' + req.params.id);
    // preferred_slot exists only after its migration — NULL alias until then.
    const slotCol = (await job.customerRequestSlotColumnExists()) ? 'preferred_slot' : 'NULL AS preferred_slot';
    const [rows] = await pool.query(
      `SELECT request_id, request_type, reason, remarks,
              preferred_datetime, ${slotCol}, request_status, created_at
         FROM tbl_job_customer_request
        WHERE job_id = ?
        ORDER BY created_at DESC`,
      [Number(req.params.id)],
    );
    logger.info('Returning ' + rows.length + ' customer requests · jobId=' + req.params.id);
    modernOk(res, rows);
  } catch (e) { next(e); }
});

/*
 * ─── Job Image upload (S3 with local fallback) ─────────────────────
 *
 * POST /api/admin/jobs/:id/images   multipart/form-data; field=file
 *   - Uploads the binary to S3 at Job_Images/<jobId>_<seq>.
 *   - seq is computed server-side as (current_image_count + 1) so the
 *     keys line up deterministically with the ops spec.
 *   - INSERTs into tbl_job_image with the FULL S3 key in the `image`
 *     column; this is what distinguishes S3-stored rows from legacy
 *     bare-filename rows on read.
 *   - If S3 is disabled (no S3_BUCKET_NAME), falls back to the local
 *     writeBuffer() path under UPLOAD_JOB_FILES so dev / single-host
 *     deploys keep working.
 *
 * GET  /api/admin/jobs/images/:imageId/file
 *   - 302-redirects to either the S3 presigned URL (if the file
 *     exists in the bucket) or the local /easydoc/upload_jobs/<file>
 *     URL. Read priority: S3 first, then local — matches the ops
 *     migration rule of 2026-05-14.
 *   - Imageid is global (not scoped to a job) because every image row
 *     carries its own job_id which we resolve internally; this keeps
 *     the URL simple for <img src="…"> bindings.
 */
const multerForImages = require('multer');
const { pool: imagePool } = require('../../db');
const { writeBuffer } = require('../../utils/file-storage');
const s3Storage = require('../../utils/s3-storage');
const uploadLogger = require('../../logger');
const imageUpload = multerForImages({
  storage: multerForImages.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

/*
 * `category` (a multipart text field): 'Booking' — the default, today's
 * Book-New-Call attachment — or 'Completion', an AFTER-WORK PHOTO an operator
 * adds so a job can be closed (2026-09-11: every close needs one, see
 * setStatus). Stored lowercased as 'completion', an after category
 * (utils/job-image-buckets.js); S3 key JobSupportings/Completion_<job>_<seq>.
 *
 * Completion is PROOF, so it takes its own RBAC key (isJobAfterPhotoUpload,
 * migrations/2026-09-11-seed-job-after-photo-action.sql) and must be an image
 * by its BYTES: the key has no extension, so the proof check's "not a PDF"
 * test cannot see a PDF stored under it.
 */
const IMAGE_CATEGORIES = new Set(['Booking', 'Completion']);
const afterPhotoGuard = requireAction('isJobAfterPhotoUpload');
function imageCategory(req, res, next) {
  const category = req.body && req.body.category ? String(req.body.category) : 'Booking';
  if (!IMAGE_CATEGORIES.has(category)) return modernError(res, 400, 'category must be Booking or Completion');
  req.imageCategory = category;
  if (category !== 'Completion') return next();
  const sniffed = req.file && require('../../services/job-image.service').sniffMime(req.file.buffer);
  if (req.file && !(sniffed && sniffed.startsWith('image/'))) {
    return modernError(res, 400, 'An after-work photo must be an image (PNG, JPEG, WEBP or GIF).');
  }
  return afterPhotoGuard(req, res, next);
}

/*
 * multer rejects an oversize file with next(MulterError) from INSIDE its own
 * middleware, so it never reaches the handler's catch — and MulterError has no
 * .status, so the error handler answered 500 "Internal Server Error" and the
 * CRM toast said nothing useful. Mapped here, where the error actually surfaces
 * (the routes/mobile/kyc.js aadhaarUploadOr400 shape).
 */
function imageUploadOr400(req, res, next) {
  imageUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      uploadLogger.warn({ jobId: req.params.id }, 'job image upload rejected — exceeds 10MB');
      return modernError(res, 400, 'file exceeds 10MB');
    }
    return next(err);
  });
}

router.post(
  '/:id/images',
  validate(idParam, 'params'),
  scopedJob,
  imageUploadOr400,
  imageCategory,
  async (req, res, next) => {
    const jobId = Number(req.params.id);
    try {
      // Shared with the client Book-a-service route — one implementation of
      // S3 (JobSupportings/<Category>_<jobId>_<seq>) + local fallback + the
      // tbl_job_image insert.
      const result = await require('../../services/job-image.service').uploadJobImage({
        jobId, file: req.file, category: req.imageCategory,
      });
      uploadLogger.upload({ jobId, imageId: result.image_id, storage: result.storage, image: result.image }, 'job image row inserted');
      modernOk(res, result, 'image uploaded');
    } catch (e) {
      if (e?.status === 400) return modernError(res, 400, e.message);
      uploadLogger.error({ jobId, err: e }, 'job image upload failed');
      next(e);
    }
  }
);

const imageDelivery = require('../../services/job-image-delivery');

router.get('/images/:imageId/file', async (req, res, next) => {
  try {
    const imageId = Number(req.params.imageId);
    if (!Number.isInteger(imageId) || imageId <= 0) {
      return modernError(res, 400, 'invalid imageId');
    }
    logger.info('Serve job image file · imageId=' + imageId);
    const [[row]] = await imagePool.query(
      'SELECT image_id, job_id, image FROM tbl_job_image WHERE image_id = ? LIMIT 1',
      [imageId]
    );
    if (!row || !row.image) return modernError(res, 404, 'image not found');

    // RBAC: confirm the job is in this user's scope. Reuse the
    // existing per-job scope assertion so out-of-scope ids 404 the
    // same as an unknown imageId would.
    const j = await job.getById(row.job_id);
    if (!j) return modernError(res, 404, 'image not found');
    const guard = assertEntityInScope(req, {
      client_id:   j.fk_client_id,
      city_id:     j.city_id,
      vertical_id: j.vertical_id,
    });
    if (!guard.ok) return modernError(res, 404, 'image not found');

    /*
     * Opt-in lazy migration. When S3_MIGRATE_LEGACY_TO_S3=true and the
     * row still has a bare filename (legacy local-only), upload the
     * local file to S3 at Job_Images/<jobId>_<seq>, UPDATE the row
     * to point at the new key, and (inside migrateLegacyToS3) unlink
     * the local file. The next read of this image will hit S3.
     *
     * `seq` is this row's 1-based ordinal among its job's images
     * ordered by image_id. Counting `image_id <= row.image_id` keeps
     * the seq stable across re-renders even when sibling rows
     * migrate at different times.
     *
     * Migration failure is non-fatal: we fall through and serve the
     * local URL. resolveImageUrl already handles that case. The
     * local-file unlink itself is also best-effort — see
     * utils/s3-storage.js::migrateLegacyToS3 for the cleanup contract.
     */
    if (s3Storage.shouldMigrateLegacy() && !String(row.image).includes('/')) {
      const [[{ seq }]] = await imagePool.query(
        `SELECT COUNT(*) AS seq
           FROM tbl_job_image
          WHERE job_id = ? AND image_id <= ?`,
        [row.job_id, row.image_id]
      );
      const newKey = await s3Storage.migrateLegacyToS3({
        storedValue: row.image,
        jobId: row.job_id,
        seq: Number(seq) || 1,
      });
      if (newKey) {
        await imagePool.query(
          'UPDATE tbl_job_image SET image = ? WHERE image_id = ?',
          [newKey, row.image_id]
        );
        row.image = newKey;
      }
    }

    /*
     * Resolution order (fixed 2026-05-18 — dev was 404ing on every
     * locally-stored image because the old `/easydoc/...` redirect
     * target has no handler outside production Nginx):
     *
     *   1. If S3 has the object (either at the stored key or under
     *      `JobSupportings/<basename>` / `Job_Images/<basename>` for
     *      legacy rows) → 302 to a presigned URL. Browser fetches
     *      directly from S3.
     *
     *   2. Else if a local file exists for the stored value (this
     *      includes images that were uploaded via the local-fallback
     *      path when S3 was transiently unreachable) → stream it
     *      directly with res.sendFile. Works in dev AND prod without
     *      a separate static handler.
     *
     *   3. Else if FILE_BASE_URL is set to an ABSOLUTE URL (production
     *      with Nginx-served /easydoc) → 302 to that absolute URL so
     *      the browser hits Nginx. Skipped when FILE_BASE_URL is the
     *      default relative `/easydoc` because that would redirect to
     *      the BE origin itself (which has no handler).
     *
     *   4. Else → 404 with a clear message instead of a redirect-to-
     *      nowhere that surfaces as a broken-image icon.
     */
    /*
     * Resolution moved to services/job-image-delivery.js on 2026-09-10 so the
     * new /url route below resolves IDENTICALLY. Two copies of a four-branch
     * fallback chain would have drifted the first time one was touched.
     */
    const delivery = await imageDelivery.resolve(row.image, { logger: uploadLogger });
    switch (delivery.kind) {
      case 's3':
      case 'base-url':
        return res.redirect(delivery.url);
      case 'legacy':
        uploadLogger.info(
          { imageId, jobId: row.job_id, verdict: delivery.verdict },
          'job image served from the legacy file host',
        );
        return res.redirect(delivery.url);
      case 'local':
        return res.sendFile(delivery.path);
      default:
        uploadLogger.warn(
          { imageId, jobId: row.job_id, stored: String(row.image || ''), reason: delivery.reason },
          'job image unresolvable',
        );
        return modernError(res, 404, 'image file not found in S3 or on local disk');
    }
  } catch (e) { next(e); }
});

/*
 * GET /api/admin/jobs/images/:imageId/url
 *
 * The same resolution as /file, returned as JSON instead of a redirect, so the
 * CRM can stop putting the session JWT in an image URL.
 *
 * An <img src> sends no Authorization header, so /file accepts `?token=<jwt>` —
 * which writes a LIVE SESSION TOKEN into browser history, the Referer header,
 * and every proxy and access log along the way. Calling this endpoint with the
 * header (where it belongs) and rendering <img src={url}> removes that.
 *
 * Why not fetch() the bytes and use a Blob instead: /file redirects to S3, and
 * fetch() is a CORS request while <img> is not — a Blob approach would need a
 * bucket CORS policy allowing the CRM origin, and would break every image if
 * that policy is absent. Handing back a URL keeps <img>'s no-CORS behaviour.
 *
 * `url: null` means genuinely unresolvable, so the CRM renders its empty state
 * from a JSON answer rather than from a failed image request — which is how
 * ERR_BLOCKED_BY_ORB came to look like a mystery instead of a missing file.
 *
 * `local` is the one kind with no browser-reachable URL (the bytes only exist
 * on this host), so it points back at /file. That path is the S3-write-failure
 * fallback and is rare; it is the only case still carrying a token.
 */
router.get('/images/:imageId/url', async (req, res, next) => {
  try {
    const imageId = Number(req.params.imageId);
    if (!Number.isInteger(imageId) || imageId <= 0) {
      return modernError(res, 400, 'invalid imageId');
    }
    const [[row]] = await imagePool.query(
      'SELECT image_id, job_id, image FROM tbl_job_image WHERE image_id = ? LIMIT 1',
      [imageId]
    );
    if (!row || !row.image) return modernOk(res, { imageId, url: null, mode: 'missing' });

    // Same scope assertion as /file — an out-of-scope id must look identical
    // to an unknown one, or this endpoint becomes a job-existence oracle.
    const j = await job.getById(row.job_id);
    if (!j) return modernOk(res, { imageId, url: null, mode: 'missing' });
    const guard = assertEntityInScope(req, {
      client_id:   j.fk_client_id,
      city_id:     j.city_id,
      vertical_id: j.vertical_id,
    });
    if (!guard.ok) return modernOk(res, { imageId, url: null, mode: 'missing' });

    const delivery = await imageDelivery.resolve(row.image, { logger: uploadLogger });
    if (delivery.kind === 'local') {
      return modernOk(res, { imageId, url: null, mode: 'stream' });
    }
    if (delivery.kind === 'none') {
      uploadLogger.warn(
        { imageId, jobId: row.job_id, stored: String(row.image || ''), reason: delivery.reason },
        'job image unresolvable (url endpoint)',
      );
      return modernOk(res, { imageId, url: null, mode: 'missing' });
    }
    return modernOk(res, { imageId, url: delivery.url, mode: delivery.kind });
  } catch (e) { next(e); }
});

/*
 * GET /api/admin/jobs/videos/:mediaId/file
 *
 * Customer-shared video redirect (from the conversational WhatsApp flow,
 * stored in tbl_job_media). Mirrors the /images/:imageId/file pattern but
 * S3-only — videos are always uploaded server-side by the conversation
 * service via putJobImage with category 'BookingVideo', so they ALWAYS have a
 * real S3 key. RBAC: same per-job scope assertion as the image endpoint.
 *
 * 200 → 302 to a presigned S3 URL; the browser follows it and the <a>/<video>
 * tag receives the bytes. 404 when the row is missing, out-of-scope, or the
 * S3 object is gone.
 */
router.get('/videos/:mediaId/file', async (req, res, next) => {
  try {
    const mediaId = Number(req.params.mediaId);
    if (!Number.isInteger(mediaId) || mediaId <= 0) {
      return modernError(res, 400, 'invalid mediaId');
    }
    logger.info('Serve job video file · mediaId=' + mediaId);
    const [[row]] = await imagePool.query(
      'SELECT media_id, job_id, s3_key FROM tbl_job_media WHERE media_id = ? LIMIT 1',
      [mediaId],
    );
    if (!row || !row.s3_key) return modernError(res, 404, 'video not found');

    const j = await job.getById(row.job_id);
    if (!j) return modernError(res, 404, 'video not found');
    const guard = assertEntityInScope(req, {
      client_id:   j.fk_client_id,
      city_id:     j.city_id,
      vertical_id: j.vertical_id,
    });
    if (!guard.ok) return modernError(res, 404, 'video not found');

    if (!s3Storage.isEnabled()) {
      return modernError(res, 503, 'video storage not configured');
    }
    try {
      if (await s3Storage.exists(row.s3_key)) {
        const url = await s3Storage.getPresignedUrl(row.s3_key);
        return res.redirect(url);
      }
    } catch (e) {
      uploadLogger.warn({ mediaId, jobId: row.job_id, key: row.s3_key, err: e?.message }, 'video s3 lookup failed');
    }
    return modernError(res, 404, 'video file not found in S3');
  } catch (e) { next(e); }
});

/*
 * DELETE /api/admin/jobs/images/:imageId
 *
 * Operator-driven image removal (2026-05-28). Mirrors the staging-tile
 * X on JobModal's Confirm/Edit picker so already-uploaded images can be
 * removed from the Images tab in view mode too.
 *
 * Flow:
 *   1. Resolve tbl_job_image row → owning job_id → scope check.
 *   2. Best-effort remove the underlying file:
 *        - S3 key  → s3Storage.deleteObject(key)
 *        - Bare filename (legacy local-only) → fs.unlinkSync under
 *          UPLOAD_JOB_FILES with path-traversal guard.
 *      Failure here is logged but NOT fatal — orphan files are cheaper
 *      than dangling DB rows on a half-failed delete.
 *   3. DELETE FROM tbl_job_image WHERE image_id = ?
 *
 * Hard-delete on the DB side: `tbl_job_image` has no soft-delete column
 * (verified via the INSERT shape at the POST handler above), and the
 * row no longer being referenced anywhere makes a hard delete safe.
 *
 * Concurrent reads/writes: a deleted row reappearing in the same
 * second is fine — `seq` is recomputed from COUNT(*) at next INSERT,
 * so removing image #2 and immediately uploading a replacement gives
 * it `seq=existing+1`, NOT the freed `_2` slot. That's intentional —
 * the operator's intent on delete is "this file shouldn't be in the
 * set", not "let me free a numbered slot for re-use".
 */
router.delete(
  '/images/:imageId',
  async (req, res, next) => {
    try {
      const imageId = Number(req.params.imageId);
      if (!Number.isInteger(imageId) || imageId <= 0) {
        return modernError(res, 400, 'invalid imageId');
      }
      const [[row]] = await imagePool.query(
        'SELECT image_id, job_id, image FROM tbl_job_image WHERE image_id = ? LIMIT 1',
        [imageId]
      );
      if (!row) return modernError(res, 404, 'image not found');

      // RBAC: same per-job scope assertion the GET handler uses so the
      // out-of-scope path 404s identically (no info leak about
      // existence).
      const j = await job.getById(row.job_id);
      if (!j) return modernError(res, 404, 'image not found');
      const guard = assertEntityInScope(req, {
        client_id:   j.fk_client_id,
        city_id:     j.city_id,
        vertical_id: j.vertical_id,
      });
      if (!guard.ok) return modernError(res, 404, 'image not found');

      const stored = String(row.image || '').trim();

      // Storage cleanup — best-effort. S3-stored rows have a path-with-
      // slash; legacy local-only rows are bare filenames.
      if (stored) {
        if (stored.includes('/')) {
          // S3 path. deleteObject already soft-fails internally.
          await s3Storage.deleteObject(stored);
        } else {
          // Local file path under UPLOAD_JOB_FILES. Path-traversal
          // guarded — refuse anything that doesn't resolve inside
          // the configured root.
          try {
            const fs = require('fs');
            const path = require('path');
            const root = process.env.UPLOAD_JOB_FILES;
            if (root) {
              const resolvedRoot = path.resolve(root);
              const localPath = path.resolve(resolvedRoot, stored);
              if (
                localPath === resolvedRoot ||
                localPath.startsWith(resolvedRoot + path.sep)
              ) {
                if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
              }
            }
          } catch (unlinkErr) {
            uploadLogger.warn(
              { imageId, jobId: row.job_id, stored, err: unlinkErr?.message },
              'job image local unlink failed (continuing with DB delete)',
            );
          }
        }
      }

      await imagePool.query(
        'DELETE FROM tbl_job_image WHERE image_id = ?',
        [imageId]
      );

      uploadLogger.upload(
        { imageId, jobId: row.job_id, stored },
        'job image deleted',
      );

      return modernOk(res, { image_id: imageId, deleted: true }, 'image deleted');
    } catch (e) { next(e); }
  }
);

/*
 * ─── POST /:id/share/release — ops force-ends a job DELEGATION ────────
 *
 * A technician can share a job with another technician; while that share is
 * live the original is read-only on the app. Before the delegate starts, the
 * original can cancel it himself and the TTL sweep expires it if nobody acts.
 * ONCE THE DELEGATE HAS STARTED there is no self-service exit — by the owner's
 * decision — so this is the only way out, and it exists for the case ops gets
 * the phone call about: the delegate went dark mid-job.
 *
 * Gated on `isJobStatusChange`, the same action as ops check-in and the status
 * change beside it, rather than a new key: this decides who may act on a job,
 * which is what that grant already governs, and a new menu_action nobody seeds
 * denies everyone (see migrations/2026-09-09-job-charges-rbac-action.sql for
 * how that goes). scopedJob keeps it inside the operator's client/city/vertical
 * scope like every other /:id route here.
 */
router.post('/:id/share/release',
  validate(idParam, 'params'),
  scopedJob,
  requireAction('isJobShareRelease'),
  // Its OWN key, seeded by migrations/executed/2026-09-10-job-share-release-action.sql.
  // Borrowing isJobStatusChange would let anyone who can move a status seize a
  // job another technician delegated — and this is the only way to break a
  // share after the delegate has started work.
  async (req, res, next) => {
    try {
      const jobId = Number(req.params.id);
      logger.info('Ops release job share · jobId=' + jobId + ' by userId=' + (req.user?.user_id ?? '-'));
      const share = await jobShareDelegation.releaseShare(jobId, { userId: req.user?.user_id ?? null });
      return modernOk(res, { share }, 'share released');
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message, e.details);
      return next(e);
    }
  },
);

module.exports = router;
module.exports.scopedJob = scopedJob;
