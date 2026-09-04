const router = require('express').Router();

const validate = require('../../middleware/validate');
const job = require('../../services/job.service');
const clientRequest = require('../../services/client-request.service');
const candidateRanking = require('../../services/candidate-ranking.service');
const jobLocation = require('../../services/job-location.service');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');
const {
  listQuery, createBody, updateBody, statusBody, assignBody, offerBody, ownerBody, rescheduleBody, idParam,
  candidatesQuery, candidatesSearchQuery, slotRecommendationsQuery,
} = require('../../validators/job.validator');
const { assertEntityInScope } = require('../../lib/scope');
const requireStageForTransition = require('../../middleware/require-stage');
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

      const { pool } = require('../../db');
      const s3Storage = require('../../utils/s3-storage');
      const [[doc]] = await pool.query(
        'SELECT `path`, url FROM document WHERE id = ? LIMIT 1',
        [selfieId],
      );
      if (!doc) return modernOk(res, { selfieId, url: null });

      // S3 key lives in `path`; presign on read. Fall back to a legacy stored url.
      const key = String(doc.path || '').trim();
      let url = null;
      if (key && s3Storage.isEnabled()) {
        try { url = await s3Storage.getPresignedUrl(key); }
        catch (e) { logger.warn('Selfie presign failed · jobId=' + req.params.id + ' · ' + e.message); }
      }
      if (!url && doc.url) url = doc.url;
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
      logger.info('Returning ' + (result?.candidates?.length || 0) + ' ranked candidates · jobId=' + req.params.id + ' offerFlow=' + offerFlowEnabled + (result?.note ? ' note=' + result.note : ''));
      modernOk(res, { ...result, offerFlowEnabled });
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

router.get('/counts', async (req, res, next) => {
  try {
    const ownerId = req.query.ownerId ? Number(req.query.ownerId) : undefined;
    logger.info('Fetch job status counts · ownerId=' + (Number.isFinite(ownerId) ? ownerId : '-'));
    // Dashboard cards must respect the caller's RBAC scope (hierarchy-
    // unioned). req.scope is attached by the global admin middleware
    // (routes/admin/index.js). Admin/Finance get undefined → no row filter.
    const counts = await job.getStatusCounts({
      ownerId: Number.isFinite(ownerId) ? ownerId : undefined,
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
 */
router.get('/attention-summary', async (req, res, next) => {
  try {
    logger.info('Fetch attention summary');
    const data = await job.getAttentionSummary({ scope: req.scope, allowedStages: req.allowedStages });
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
      15: 'Estimate Pending', 20: 'Pending to Close', 21: 'Followup',
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
 * escalation_closed_time = NOW(). When set to 16 (Re-Open), clear
 * the closed_time so the row goes back to the "open" filter.
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
        sets.push('escalation_closed_time = NOW()');
        // also mark resolved_time so the "closed" filter picks it up
        sets.push('resolved_time = COALESCE(resolved_time, NOW())');
      } else if (v === 16) {
        // Re-Open: clear closed_time + bump no_of_escalations so the
        // row falls back into the "open" filter. Legacy did the same.
        sets.push('escalation_closed_time = NULL');
        sets.push('no_of_escalations = COALESCE(no_of_escalations, 0) + 1');
        sets.push('escalated_time = NOW()');
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
const { DUE_TO_USER_TYPE, ACTION_TYPE_BY_MODE, ACTION_TYPE } = require('../../services/reason-codes');

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
 * Route-order note: declared BEFORE `/:id` so Express doesn't try to
 * validate the literal string "action-reasons" as a numeric job id —
 * same gotcha as `/bulk` vs `/:jobId` in routes/admin/auto-assign.js.
 */
router.get('/action-reasons', async (req, res, next) => {
  try {
    const type = String(req.query.type || '').trim().toLowerCase();
    logger.info('Fetch action reasons · type=' + (type || '-') + ' dueTo=' + (req.query.dueTo || '-'));
    if (!type) return modernError(res, 400, 'type is required (unreachable|enquiry)');
    // Strip whitespace/underscores/dashes so 'un_reachable' / 'un-reachable' /
    // 'unreachable' / 'Un Reachable' all map to the same bucket.
    const modeKey = type.replace(/[\s_-]/g, '');
    const actionTypeId = ACTION_TYPE_BY_MODE[modeKey];
    if (!actionTypeId) return modernOk(res, []);

    const dueRaw = String(req.query.dueTo || '').toLowerCase().replace(/\s+/g, '');
    const userType = DUE_TO_USER_TYPE[dueRaw] || 2; // default = Customer (user_type 2); matches the pre-checked "By Customer" radio

    const [reasonRows] = await pool.query(
      `SELECT id, action_desc FROM action_taken_reason
        WHERE action_type = ? AND user_type = ?
              AND (status IS NULL OR status = 1)
        ORDER BY id ASC`,
      [actionTypeId, userType],
    );
    const items = reasonRows
      .map((r) => ({ id: r.id, label: String(r.action_desc || '').trim() }))
      .filter((x) => x.label);
    logger.info('Returning ' + items.length + ' action reasons · type=' + type);
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
router.put('/:id',   validate(idParam, 'params'), validate(updateBody), scopedJob, updateHandler);
router.patch('/:id', validate(idParam, 'params'), validate(updateBody), scopedJob, updateHandler);

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

router.patch('/:id/assign', validate(idParam, 'params'), validate(assignBody), scopedJob, requireStageForTransition('assign'), async (req, res, next) => {
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
 * on My Orders). Each item: { efr_id, efr_name, offered_at }. Returns an empty
 * list when the offer table is absent (service falls back to legacy behaviour).
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
    modernOk(res, { items });
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
              full_fillment_created_time = NOW(),
              no_of_req_foh = COALESCE(no_of_req_foh, 0) + 1
        WHERE job_id = ? AND COALESCE(no_of_req_foh, 0) = 0`,
      [req.body.reason, req.body.appointment_time, req.user.user_id, req.params.id]
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
     */
    await pool.query('UPDATE tbl_job SET job_status = 10 WHERE job_id = ?', [req.params.id]);
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
    const [services] = await pool.query(
      `SELECT js.job_service_id, js.quantity, js.total_charge, js.material_charge,
              CR.crc_ratecard_name AS service_name
         FROM tbl_job_services js
         LEFT JOIN tbl_client_service   CS ON CS.client_service_id = js.service_id
         LEFT JOIN tbl_client_rate_card CR ON CR.crc_id = CS.rate_card_id
        WHERE js.job_id = ? AND js.job_service_status = 1
        ORDER BY js.job_service_id`,
      [jobId]
    );
    const lines = services.map((s) => ({
      ...s,
      line_total: Number(s.total_charge || 0) * Number(s.quantity || 1) + Number(s.material_charge || 0),
    }));
    const grand_total = lines.reduce((sum, l) => sum + l.line_total, 0);
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
    const { calculateCharges } = require('../../services/client-rate-cards.service');
    const jobId = Number(req.params.id);
    logger.info('Compute service breakdown · jobId=' + jobId);
    const [rows] = await pool.query(
      `SELECT js.job_service_id, js.service_id, js.quantity, js.total_charge,
              cs.total_amount,
              cs.easyfix_direct_fixed, cs.easyfix_direct_variable,
              cs.overhead_fixed, cs.overhead_variable,
              cs.client_fixed, cs.client_variable,
              st.service_type_name,
              sc.service_catg_name
         FROM tbl_job_services js
         LEFT JOIN tbl_client_service cs ON cs.client_service_id = js.service_id
         LEFT JOIN tbl_service_type   st ON st.service_type_id   = js.service_type_id
         LEFT JOIN tbl_service_catg   sc ON sc.service_catg_id   = js.service_category_id
        WHERE js.job_id = ?
          AND (js.job_service_status IS NULL OR js.job_service_status <> 0)
        ORDER BY js.job_service_id ASC`,
      [jobId],
    );

    const lineItems = rows.map((r) => {
      const qty = Number(r.quantity) || 1;
      // Per-unit cascade — uses tbl_client_service.total_amount as the
      // single-unit total. Falls back to js.total_charge/qty if the
      // client_service row is missing the cost cols (legacy rows).
      const perUnitTotal = Number(r.total_amount)
        || (Number(r.total_charge) / qty)
        || 0;
      const perUnit = calculateCharges({
        totalCharge:           perUnitTotal,
        easyfixDirectFixed:    r.easyfix_direct_fixed,
        easyfixDirectVariable: r.easyfix_direct_variable,
        overheadFixed:         r.overhead_fixed,
        overheadVariable:      r.overhead_variable,
        clientFixed:           r.client_fixed,
        clientVariable:        r.client_variable,
      });
      const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
      const scale = (b) => ({
        variableAmt: round2(b.variableAmt * qty),
        fixedAmt:    round2(b.fixedAmt * qty),
        total:       round2(b.total * qty),
      });
      return {
        job_service_id: r.job_service_id,
        service_id: r.service_id,
        service_type_name: r.service_type_name,
        service_category_name: r.service_catg_name,
        quantity: qty,
        perUnit,
        lineTotal: {
          totalCharge:   round2(perUnit.totalCharge * qty),
          easyfixDirect: scale(perUnit.easyfixDirect),
          overhead:      scale(perUnit.overhead),
          clientShare:   scale(perUnit.clientShare),
          remainder:     round2(perUnit.remainder * qty),
        },
      };
    });

    // Aggregate totals across all line items.
    const totals = lineItems.reduce((acc, li) => {
      acc.totalCharge += li.lineTotal.totalCharge;
      acc.easyfixDirect += li.lineTotal.easyfixDirect.total;
      acc.overhead      += li.lineTotal.overhead.total;
      acc.clientShare   += li.lineTotal.clientShare.total;
      acc.remainder     += li.lineTotal.remainder;
      return acc;
    }, { totalCharge: 0, easyfixDirect: 0, overhead: 0, clientShare: 0, remainder: 0 });
    const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
    for (const k of Object.keys(totals)) totals[k] = round2(totals[k]);

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
 * No permission middleware applied — same as the rest of /admin/jobs
 * which rely on FE permission gating + scopedJob ownership check.
 */
router.post('/:id/services/:jobServiceId/restore',
  validate(require('joi').object({
    id: require('joi').number().integer().positive().required(),
    jobServiceId: require('joi').number().integer().positive().required(),
  }), 'params'),
  scopedJob,
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
                  approval_sent_on_date_time = NOW(),
                  no_of_req_approval = COALESCE(no_of_req_approval, 0) + 1
            WHERE job_id = ?`,
          [jobId]
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
  const [services] = await pool.query(
    `SELECT js.quantity, js.total_charge, js.material_charge,
            CR.crc_ratecard_name AS service_name
       FROM tbl_job_services js
       LEFT JOIN tbl_client_service   CS ON CS.client_service_id = js.service_id
       LEFT JOIN tbl_client_rate_card CR ON CR.crc_id = CS.rate_card_id
      WHERE js.job_id = ? AND js.job_service_status = 1`,
    [jobId]
  );

  const total = services.reduce((s, x) => s + Number(x.total_charge || 0) * Number(x.quantity || 1) + Number(x.material_charge || 0), 0);
  const lineBlock = services
    .map((s) => `  ${s.service_name || '—'} × ${s.quantity}  =  ${(Number(s.total_charge || 0) * Number(s.quantity || 1) + Number(s.material_charge || 0)).toFixed(2)}`)
    .join('\n');

  // Recipient resolution mirrors legacy `confirmApprovejob`:
  // reporting contact's manager_name CSV (legacy stores emails here, not
  // names) + contact_email, owner email. Skip clearly malformed entries
  // so a typo in one CSV field doesn't poison the whole send.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const recipients = new Set();
  const skipped = [];
  const addIfValid = (raw, source) => {
    const v = String(raw || '').trim();
    if (!v) return;
    if (EMAIL_RE.test(v)) recipients.add(v);
    else skipped.push({ value: v, source });
  };
  addIfValid(j.client_spoc_email, 'job.client_spoc_email');
  addIfValid(j.owner_email,       'owner.official_email');
  if (j.reporting_contact_id) {
    const [[c]] = await pool.query(
      'SELECT contact_email, manager_name FROM tbl_client_contacts WHERE id = ?',
      [j.reporting_contact_id]
    );
    if (c) {
      addIfValid(c.contact_email, 'contact.contact_email');
      if (c.manager_name) {
        for (const m of String(c.manager_name).split(',')) {
          addIfValid(m, 'contact.manager_name[]');
        }
      }
    }
  }
  if (recipients.size === 0) {
    require('../../logger').warn(
      `Estimate email skipped — no valid recipients for job ${jobId}` +
      (skipped.length ? ` (rejected ${skipped.length} malformed entries)` : '')
    );
    return;
  }

  await emailServiceForJobs.send({
    to: [...recipients],
    subject: `Client_Estimate Approval_${j.job_id}_${j.customer_name || ''}_${j.customer_mob_no || ''}`,
    text: `Hi ${j.client_name || ''},\n\n`
      + `Please find below the estimate for job ${j.job_reference_id || j.job_id}.\n\n`
      + `Services:\n${lineBlock}\n\n`
      + `Grand total: ${total.toFixed(2)}\n\n`
      + `Kindly approve via the client portal.\n\nRegards,\nEasyFix`,
    category: 'estimate.send-for-approval',
  });
  logger.info('Estimate email sent · jobId=' + jobId + ' recipients=' + recipients.size);
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
router.post('/:id/notify-unreachable', validate(idParam, 'params'), scopedJob, async (req, res, next) => {
  try {
    logger.info('Notify customer unreachable · jobId=' + req.params.id);
    const result = await job.notifyCustomerNotReachable(req.params.id);
    modernOk(res, result, result.sent ? 'Customer notified' : 'SMS not sent');
  } catch (e) { logger.error('Notify unreachable failed · jobId=' + req.params.id + ' · ' + e.message); next(e); }
});

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
    const [rows] = await pool.query(
      `SELECT request_id, request_type, reason, remarks,
              preferred_datetime, request_status, created_at
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

router.post(
  '/:id/images',
  validate(idParam, 'params'),
  scopedJob,
  imageUpload.single('file'),
  async (req, res, next) => {
    const jobId = Number(req.params.id);
    try {
      // Shared with the client Book-a-service route — one implementation of
      // S3 (JobSupportings/Booking_<jobId>_<seq>) + local fallback + the
      // tbl_job_image insert.
      const result = await require('../../services/job-image.service').uploadJobImage({
        jobId, file: req.file, category: 'Booking',
      });
      uploadLogger.upload({ jobId, imageId: result.image_id, storage: result.storage, image: result.image }, 'job image row inserted');
      modernOk(res, result, 'image uploaded');
    } catch (e) {
      if (e?.code === 'LIMIT_FILE_SIZE') {
        uploadLogger.warn({ jobId, bytes: req.file?.size }, 'job image upload rejected — exceeds 10MB');
        return modernError(res, 400, 'file exceeds 10MB');
      }
      if (e?.status === 400) return modernError(res, 400, e.message);
      uploadLogger.error({ jobId, err: e }, 'job image upload failed');
      next(e);
    }
  }
);

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
    const fs = require('fs');
    const path = require('path');
    const stored = String(row.image || '').trim();

    // (1) S3 attempt — keep the existing presigned-URL behaviour.
    if (s3Storage.isEnabled()) {
      const candidates = [stored];
      if (!stored.startsWith('Job_Images/') && !stored.startsWith('JobSupportings/')) {
        candidates.push(`JobSupportings/${path.basename(stored)}`);
        candidates.push(`Job_Images/${path.basename(stored)}`);
      }
      for (const key of candidates) {
        try {
          if (await s3Storage.exists(key)) {
            const url = await s3Storage.getPresignedUrl(key);
            return res.redirect(url);
          }
        } catch (e) {
          uploadLogger.warn({ key, err: e?.message }, 's3 lookup failed during image redirect — falling through to local');
          break;
        }
      }
    }

    // (2) Local-file streaming — covers writeBuffer-fallback uploads
    // and pre-S3 legacy files. Try the configured job-files dir AND a
    // few common siblings so older rows (some written to `general` /
    // `easyfixer_documents`) still resolve.
    const rootCandidates = [
      process.env.UPLOAD_JOB_FILES,
      process.env.UPLOAD_ROOT_PATH,
      './uploads/upload_jobs',
      './uploads',
    ].filter(Boolean);
    // If the stored value contains a slash it's already a sub-path
    // (e.g. `upload_jobs/foo.jpg`); try it under each root verbatim
    // before falling back to basename-only resolution.
    const relForms = [stored, path.basename(stored)];
    for (const root of rootCandidates) {
      const absRoot = path.resolve(root);
      for (const rel of relForms) {
        const candidate = path.resolve(absRoot, rel.replace(/^\/+/, ''));
        // Path-traversal guard: candidate MUST sit inside absRoot.
        if (!candidate.startsWith(absRoot + path.sep) && candidate !== absRoot) continue;
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return res.sendFile(candidate);
        }
      }
    }

    // (3) Absolute FILE_BASE_URL (prod Nginx) — only redirect when the
    // base is absolute, never to a relative `/easydoc` that bounces
    // back to this BE.
    const fileBase = process.env.FILE_BASE_URL || '';
    if (/^https?:\/\//i.test(fileBase)) {
      const url = stored.includes('/')
        ? `${fileBase.replace(/\/+$/, '')}/${stored.replace(/^\/+/, '')}`
        : `${fileBase.replace(/\/+$/, '')}/upload_jobs/${stored}`;
      return res.redirect(url);
    }

    // (4) Genuinely unresolvable. 404 instead of a redirect-to-nowhere
    // so the FE renders the empty state instead of a broken-image icon.
    uploadLogger.warn(
      { imageId, jobId: row.job_id, stored, s3Enabled: s3Storage.isEnabled(), fileBase },
      'job image unresolvable — not in S3, no local file, no absolute FILE_BASE_URL',
    );
    return modernError(res, 404, 'image file not found in S3 or on local disk');
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

module.exports = router;
module.exports.scopedJob = scopedJob;
