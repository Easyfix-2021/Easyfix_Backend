const Joi = require('joi');
const {
  ALL_STATUS_VALUES,
  SORTABLE_COLUMNS,
  OFFER_STATE_VALUES,
  MAX_OFFER_RECIPIENTS,
} = require('../services/job.service');

const intId   = Joi.number().integer().positive();
/*
 * csvIds — a filter param that accepts EITHER a single positive integer id OR a
 * comma-separated list of them ("12,34,56"). Backs the Pending-to-Start
 * multi-select filters (clientId / cityId / projectManagerId / zonalManagerId).
 * The single-id alternative preserves back-compat with existing single-select
 * callers; the service layer (toIdArray) normalises both shapes to an IN (...).
 */
/*
 * ⚠ THE LIMIT IS A COUNT OF IDS, NOT A COUNT OF CHARACTERS (fixed 2026-08-18).
 *
 * This was `.max(200)` — 200 CHARACTERS. At roughly 4 chars per id ("123,")
 * that rejected any selection past about FORTY, and there are 398 clients and
 * 11,108 cities. Selecting all clients and unchecking one produced a ~1,592
 * character CSV, Joi 400'd the request, and because useFetch deliberately keeps
 * the previous rows on error (so a transient failure never blanks a populated
 * table) the screen simply did not change. Reported as "data not updating",
 * which is exactly what a silent 400 behind a stale table looks like.
 *
 * 500 covers "every client, minus one" with headroom while still refusing an
 * absurd list — an IN() of 11,000 city ids is a real cost, and a CSV that long
 * would breach common URL limits before it ever reached us. A caller who wants
 * everything should send NO filter rather than enumerate the world.
 */
const CSV_IDS_MAX = 500;
const csvIds  = Joi.alternatives(
  intId,
  Joi.string()
    .pattern(/^\d+(,\d+)*$/)
    .custom((value, helpers) => {
      const n = value.split(',').length;
      if (n > CSV_IDS_MAX) {
        return helpers.message(
          `must not select more than ${CSV_IDS_MAX} ids at once (got ${n}) — clear the filter to include everything`,
        );
      }
      return value;
    }),
);
/*
 * INDIAN_MOBILE_REGEX (2026-06-03): tightened from `/^[0-9]{10}$/` to
 * `/^[6-9]\d{9}$/`. Matches the FE `INDIAN_MOBILE_REGEX` in
 * Easyfix_CRM_UI/src/lib/format.ts — same rule, defence-in-depth so
 * direct API callers (curl, scripts, other clients) can't slip
 * non-Indian-mobile junk through. Custom error message is more useful
 * than Joi's default "fails to match the required pattern".
 *
 * Centralised here as `mobile` so every callsite below
 * (customer_mob_no, additional_number, magic-link mobile_number)
 * picks up the change automatically.
 */
const INDIAN_MOBILE_REGEX = /^[6-9]\d{9}$/;
const mobile  = Joi.string()
  .pattern(INDIAN_MOBILE_REGEX)
  .messages({
    'string.pattern.base': 'Must be a 10-digit Indian mobile starting with 6, 7, 8, or 9',
  });
const pinCode = Joi.string().pattern(/^[0-9]{6}$/);
const gpsPair = Joi.string().pattern(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/);

const listQuery = Joi.object({
  q: Joi.string().min(1).max(100).optional(),
  status: Joi.number().integer().valid(...ALL_STATUS_VALUES).optional(),
  /*
   * `statuses` — multi-status filter for composite UI tabs (e.g. Pending to
   * Close = 2 OR 20). Accepted as CSV string ("2,20") or array. Each value
   * must be a known status code. If both `status` and `statuses` are passed,
   * the service layer prefers `statuses`.
   */
  statuses: Joi.alternatives(
    Joi.string().pattern(/^\d+(,\d+)*$/).max(100),
    Joi.array().items(Joi.number().integer().valid(...ALL_STATUS_VALUES)).max(20),
  ).optional(),
  // `assigned` — true → only jobs with a technician; false → only jobs without.
  // Used by the dashboard's BOOKED split. Accepts bool OR the string form that
  // URLSearchParams produces.
  assigned: Joi.alternatives(Joi.boolean(), Joi.string().valid('true', 'false')).optional(),
  // `isEscalated` — drives the legacy CRM header's "Escalated Jobs" filter.
  // Same accepted shape as `assigned` for URLSearchParams compatibility.
  isEscalated: Joi.alternatives(Joi.boolean(), Joi.string().valid('true', 'false')).optional(),
  // `noServices` (2026-05-28) — narrows the list to BOOKED jobs with
  // ZERO active rows in tbl_job_services. Used by the dashboard
  // AttentionSummary "Booked With No Services" tile so the click-through
  // lands ops directly on the anomaly rows rather than a generic BOOKED
  // tab. URLSearchParams ships the value as the string 'true'/'false';
  // accept both shapes for parity with the other boolean-ish filters.
  noServices: Joi.alternatives(Joi.boolean(), Joi.string().valid('true', 'false')).optional(),
  /*
   * `offerState` (2026-07-31) — the Pending-for-Scheduling tab's SUB-STATE
   * filter. That tab is a bucket (status=0 + assigned=false), so every job in
   * it already shares one job_status; the axis worth filtering is the OFFER
   * lifecycle inside the bucket:
   *   'pending' → never offered   'offered' → an OPEN offer exists
   *   'expired' → offers exist, none open
   * It NARROWS — it never replaces the caller's status / assigned pins.
   * `''` is allowed (and ignored) so the FE can clear the control without
   * having to strip the key. Values derive from the service's
   * OFFER_STATE_VALUES so the two sides cannot drift.
   */
  offerState: Joi.string().valid(...OFFER_STATE_VALUES).allow('').optional(),
  // clientId / cityId — single id OR CSV list (Pending-to-Start multi-select
  // Clients / Cities filters). csvIds keeps a lone id valid for back-compat.
  clientId: csvIds.optional(),
  cityId: csvIds.optional(),
  // projectManagerId — the client's mapped PM in tbl_vertical_mapping
  // (user_id where user_type = 1). zonalManagerId — the city's zonal owner
  // (tbl_city.state_user). Both drive the Pending-to-Start page's PM / ZM
  // filters; single id OR CSV list, applied as EXISTS / ci-column IN (...)
  // predicates in service.list().
  projectManagerId: csvIds.optional(),
  zonalManagerId: csvIds.optional(),
  ownerId: intId.optional(),
  easyfixerId: intId.optional(),
  // customerId — drives the "View History" panel in the Book-New-Call
  // modal. Looks up every previous job booked for the same tbl_customer
  // row so the operator can see whether the caller is a repeat / which
  // services they've taken before / outstanding revisits.
  customerId: intId.optional(),
  // Legacy "Filter Job" panel parity (2026-05-19). Each one is
  // narrow + cheap (single column LIKE or FK eq). See service.list().
  customerQ:  Joi.string().min(1).max(100).optional(),
  clientRef:  Joi.string().min(1).max(100).optional(),
  efrMobile:  Joi.string().min(1).max(20).optional(),
  pin:        Joi.string().min(1).max(10).optional(),
  stateId:    intId.optional(),
  categoryId: intId.optional(),
  verticalId: intId.optional(),
  /*
   * `sourceType` (2026-08-07) — exact match on tbl_job.source_type, the
   * booking-CHANNEL label ('website', 'Bulk Upload', 'Client_App',
   * 'New Dashboard', 'PowerMax API', 'manual', …). The column was already
   * projected + sortable on the list endpoint but not filterable.
   *
   * Added for the CRM's "Unmapped Website Bookings" preset, which combines it
   * with `status=9` + `clientId=1` (the RETAIL catch-all) to surface public
   * website bookings whose QR link carried no valid tbl_client.reference_code.
   * Kept GENERIC on purpose — any channel is filterable, not just 'website' —
   * so a future "all Client_App orders" view needs no new param.
   *
   * `max(50)` matches the column width and the create/update validators below.
   * Comparison is a plain `=` in service.list(); MySQL's default collation is
   * case-insensitive, so 'website' matches regardless of stored casing.
   */
  sourceType: Joi.string().max(50).optional(),
  /*
   * `dateType` — MUST list every key of DATE_TYPE_COLUMN (services/job.service.js)
   * that a browser is allowed to send. Joi runs with stripUnknown but valid() is
   * a hard whitelist, so a value present in the map and missing here 400s before
   * the service ever sees it. `cancelled` (2026-09-02) targets
   * tbl_job.cancel_date_time, which is NULL for never-cancelled jobs — the
   * window therefore restricts to cancelled jobs too; see the note on the map.
   * `checkin` is deliberately NOT here: it is an internal dateType used by
   * services/mobile-dashboard.service.js, which calls list() directly and never
   * crosses this layer.
   */
  dateType:   Joi.string().valid('booked', 'scheduled', 'completed', 'ticket', 'requested', 'cancelled').optional(),
  // Phase-2 filters (2026-05-19).
  //   rating  — exact match against tbl_easyfixer_rating_by_customer.customer_rating
  //   reopen  — boolean: jobs with job_reopen_flag = 1
  //   dueTo   — text token (customer|client|easyfix|technician) parsed
  //             from the structured remarks prefix on tbl_job.remarks
  //   zonalId — FK to tbl_zone_master via tbl_zone_city_mapping
  rating:     Joi.number().integer().min(1).max(5).optional(),
  reopen:     Joi.alternatives(Joi.boolean(), Joi.string().valid('true', 'false', '1', '0')).optional(),
  dueTo:      Joi.string().valid('customer', 'client', 'easyfix', 'technician').optional(),
  zonalId:    intId.optional(),
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional(),
  /*
   * `quotationStatus` — filter jobs by the SPOC's action on their
   * estimate. Powers the dashboard AttentionSummary tiles:
   *   approved → quotation_details.status = 1 AND action_on IS NOT NULL,
   *              job not yet executing/closed/cancelled
   *   rejected → quotation_details.status = 0 AND action_on IS NOT NULL,
   *              job not closed/cancelled
   * Implemented via EXISTS subquery on quotation_details (no JOIN
   * multiplication when a job has multiple line items).
   */
  quotationStatus: Joi.string().valid('approved', 'rejected').optional(),

  /*
   * `section` — one of the five My Orders -> Unconfirmed buckets. Valid values
   * come from client-request.service.js so this schema cannot list a section
   * the predicate does not implement (or miss one it does); an unknown value is
   * rejected here rather than quietly returning an unfiltered list.
   */
  section: Joi.string().valid(...require('../services/client-request.service').SECTIONS).optional(),
  /*
   * `requestedBefore` — drives the AttentionSummary's Running Late tile.
   *   'now' → j.requested_date_time IS NOT NULL AND j.requested_date_time < NOW()
   * Other ISO timestamps allowed for future surfaces (e.g. "before
   * end of today" view).
   */
  requestedBefore: Joi.alternatives(
    Joi.string().valid('now'),
    Joi.date().iso(),
  ).optional(),
  /*
   * Server-side sort (whitelisted). sortDir asc|desc. Both optional — absent →
   * default job_id DESC.
   *
   * `sortBy` is derived from the SERVICE's SORTABLE_COLUMNS keys rather than
   * being re-listed here. The two whitelists previously had to be maintained by
   * hand on both sides, and a key present in only one of them is silently
   * dropped — the list then falls back to the default job_id DESC order with no
   * error, which is exactly the regression this endpoint hit before. Deriving
   * makes BE-side drift structurally impossible. (Same pattern as
   * routes/admin/tools.js, service-types.js, users.js, etc.)
   *
   * Includes 'age' — NOT a tbl_job column: the service maps it to
   * JOB_AGE_SECS_EXPR (precise seconds), so same-day jobs order correctly
   * instead of tying on the floored day value the UI displays. The FE keeps its
   * own sortable-column list and must list 'age' there too.
   */
  sortBy: Joi.string().valid(...Object.keys(SORTABLE_COLUMNS)).optional(),
  sortDir: Joi.string().valid('asc', 'desc').optional(),
  limit: Joi.number().integer().min(1).max(500).default(50),
  offset: Joi.number().integer().min(0).default(0),
});

const customerBlock = Joi.object({
  customer_id: intId.optional(),
  customer_name: Joi.string().max(255).when('customer_id', { is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required() }),
  customer_mob_no: mobile.when('customer_id', { is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required() }),
  customer_email: Joi.string().email().max(255).optional(),
}).required();

const addressBlock = Joi.object({
  address_id: intId.optional(),
  address: Joi.string().max(2000).when('address_id', { is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required() }),
  building: Joi.string().max(500).optional(),
  landmark: Joi.string().max(500).optional(),
  locality: Joi.string().max(500).optional(),
  city_id: intId.when('address_id', { is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required() }),
  pin_code: pinCode.when('address_id', { is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required() }),
  gps_location: gpsPair.optional(),
  mobile_number: mobile.optional(),
  // Free-text landing notes for the technician (tbl_address.address_instruction).
  address_instruction: Joi.string().max(1000).allow('', null).optional(),
}).required();

const serviceItem = Joi.object({
  service_id: intId.required(),
  quantity: Joi.number().integer().min(1).max(1000).default(1),
  service_type_id: intId.optional(),
  service_category_id: intId.optional(),
});

const createBody = Joi.object({
  job_desc: Joi.string().max(5000).optional(),
  job_type: Joi.string().max(100).default('Installation'),
  source_type: Joi.string().max(50).default('manual'),
  fk_client_id: intId.required(),
  fk_service_type_id: intId.optional(),
  fk_service_catg_id: intId.optional(),
  service_type_ids: Joi.alternatives(Joi.array().items(intId), Joi.string().max(500)).optional(),
  // FE-name alias — JobModal.tsx historically sent `fk_service_type_ids`.
  // Accept both names so old + new FE code paths work uniformly. The
  // service layer prefers `service_type_ids`; we copy the alias over
  // when only the legacy name is supplied.
  fk_service_type_ids: Joi.alternatives(Joi.array().items(intId), Joi.string().max(500)).optional(),
  requested_date_time: Joi.date().iso().required(),
  // Legacy column on tbl_job that stores the time portion of the
  // requested datetime as a separate string (e.g. "14:30"). FE may
  // send it explicitly OR we derive it server-side from
  // requested_date_time when omitted.
  requested_time: Joi.string().max(20).allow('', null).optional(),
  time_slot: Joi.string().max(200).optional(),
  // Legacy `booking_cut_off_time_slot` column — written by legacy
  // JobDaoImpl on create. Free-text or "HH:MM" slot label.
  booking_cut_off_time_slot: Joi.string().max(50).allow('', null).optional(),
  reporting_contact_id: intId.optional(),
  job_owner: intId.optional(),
  // Legacy `job_client_owner` column — separate from `job_owner`. The
  // internal CRM user assigned by the client side. Tolerated null.
  job_client_owner: intId.allow(null).optional(),
  // Initial "01" sentinel for `eta_status` matching legacy
  // JobDaoImpl#2387. FE may override; default applied server-side.
  eta_status: Joi.string().max(20).allow('', null).optional(),
  // Collected-By preference for THIS job (1=Easyfixer, 2=Easyfix,
  // 3=Client). Legacy column `collected_by` on tbl_job.
  collected_by: Joi.alternatives(Joi.number().integer(), Joi.string().max(20)).allow(null, '').optional(),
  // Original-appointment snapshot — used when a job is rescheduled to
  // preserve the original promise. Set at create time AND updated on
  // reschedule.
  original_appointment_date_time: Joi.date().iso().allow(null).optional(),
  original_appointment_time:      Joi.string().max(20).allow('', null).optional(),
  client_ref_id: Joi.string().max(100).optional(),
  job_reference_id: Joi.string().max(100).optional(),
  // Multi-category fan-out family link — the job_id of the FIRST sibling
  // created in this booking. When present, create() records a
  // linked_job(parent_job_id=primary, child_job_id=new) row and inherits the
  // parent's custom_property if this sibling didn't send one. Absent on the
  // parent's own create.
  primary_job_id: intId.optional(),
  // Flattened legacy custom-property string ("Label:Value|…", tbl_job
  // .custom_property varchar(510)). CRM bookings usually leave it null (props
  // land in dedicated columns like branch_details); accepted for forwards-compat
  // and so a sibling can carry an inherited value. Coerced to real NULL for
  // empty/'null' by the service layer.
  custom_property: Joi.string().max(2000).allow('', null).optional(),
  // Top-level per-job override of the customer's master name. See
  // services/job.service.js (`job_customer_name` MUTABLE_COLUMNS
  // comment) for why this is distinct from `customer.customer_name`.
  // Accepted alongside the nested customer block; service layer
  // prefers this when both are present.
  job_customer_name: Joi.string().max(255).allow('', null).optional(),
  client_spoc: Joi.string().max(200).optional(),
  client_spoc_name: Joi.string().max(200).optional(),
  client_spoc_email: Joi.string().email().max(200).optional(),
  // Alternate customer contact — operator captures these alongside the
  // primary customer at Book Call time so the technician can reach an
  // alt person if the primary is unreachable. Both columns exist on
  // tbl_job per legacy JobDaoImpl#2379-2383.
  additional_name: Joi.string().max(200).allow('', null).optional(),
  additional_number: Joi.alternatives(mobile, Joi.string().allow('', null)).optional(),
  helper_req: Joi.boolean().default(false),
  remarks: Joi.string().max(2000).optional(),
  // Special notes for the technician — visible in mobile app job
  // detail. Also writable via the update path; create path takes it
  // alongside `remarks` if the operator adds notes at booking time.
  efr_special_notes: Joi.string().max(2000).allow('', null).optional(),
  // initial_status — legacy footer-button parity. Routes the new job
  // to BOOKED (default), ENQUIRY (7), or CALL_LATER (9) at creation
  // time. Service-layer also defends against unexpected values.
  initial_status: Joi.number().integer().valid(0, 7, 9).optional(),
  // Legacy Book-New-Call form fields. All optional; nullable strings.
  // branch_details is the only one that lands in a real tbl_job
  // column (verified 2026-05-14). product_code + building_name are
  // folded into `remarks` server-side via composeRemarks().
  branch_details: Joi.string().max(255).allow('', null).optional(),
  product_code:   Joi.string().max(255).allow('', null).optional(),
  building_name:  Joi.string().max(500).allow('', null).optional(),
  // Per-client questionnaire FK. Stored against tbl_questionaire when
  // the schema supports it; treated as passive otherwise (no-op).
  c_questionaire_id: intId.optional(),
  // job_image_filename — uploaded separately to /shared/upload?category=
  // job_files first; the resulting filename gets persisted to
  // tbl_job_image after the main tbl_job INSERT. Optional; legacy
  // workflows still book jobs with no image. Validated as a filename
  // (no slashes / nulls) by file-storage on the upload step, so by the
  // time it reaches here it's safe to round-trip.
  job_image_filename: Joi.string().max(255).allow('', null).optional(),
  // job_image_filenames (2026-08-07) — plural sibling of the field above,
  // for callers that collect several booking photos in one submission.
  // Each item mirrors the singular rule EXACTLY (string, max 255, ''/null
  // tolerated so a form that pads empty slots isn't 400'd); job.service's
  // normaliseJobImageFilenames() drops the blanks and de-duplicates against
  // the singular field. Capped at 5 to match the public website-booking
  // photo limit (routes/public/website-booking.js MAX_PHOTOS) — the only
  // surface that sends more than one today.
  job_image_filenames: Joi.array().items(Joi.string().max(255).allow('', null)).max(5).optional(),
  customer: customerBlock,
  address: addressBlock,
  services: Joi.array().items(serviceItem).optional(),
});

const updateBody = Joi.object({
  job_desc: Joi.string().max(5000).optional(),
  job_type: Joi.string().max(100).optional(),
  source_type: Joi.string().max(50).optional(),
  fk_client_id: intId.optional(),
  fk_service_type_id: intId.optional(),
  fk_service_catg_id: intId.optional(),
  requested_date_time: Joi.date().iso().optional(),
  // Companion time text col (stored as "HH:MM"). Like original_appointment_time
  // above, update() projects this via formatTimeIST before the DB write, so the
  // validator must accept the pre-projection shape — a caller that sends the
  // full ISO (~24 chars) instead of HH:MM must not be 400'd here. max(40) covers
  // ISO + offset variants; the persisted value is always <=5 chars.
  requested_time: Joi.string().max(40).allow('', null).optional(),
  expected_date_time: Joi.date().iso().optional(),
  time_slot: Joi.string().max(200).optional(),
  booking_cut_off_time_slot: Joi.string().max(50).allow('', null).optional(),
  reporting_contact_id: intId.optional(),
  job_owner: intId.optional(),
  job_client_owner: intId.allow(null).optional(),
  /*
   * `eta_status` is intentionally NOT accepted on the update path.
   * BE write happens ONCE at Book Call time (defaults '01'); status
   * transitions through the dedicated mobile /eta endpoint. Adding
   * it here would let any PATCH overwrite the value, which ops has
   * explicitly excluded (2026-05-25).
   */
  collected_by: Joi.alternatives(Joi.number().integer(), Joi.string().max(20)).allow(null, '').optional(),
  original_appointment_date_time: Joi.date().iso().allow(null).optional(),
  // Confirm & Schedule sends this as a FULL ISO datetime
  // (new Date(requested_date_time).toISOString(), ~24 chars) and lets the
  // server own the projection: update() reduces it to "HH:MM" via
  // formatTimeIST before the DB write (TIME_COLS in services/job.service.js).
  // So this validator must accept the pre-projection ISO, not the 20-char
  // stored form — the persisted value is always <=5 chars regardless.
  original_appointment_time:      Joi.string().max(40).allow('', null).optional(),
  client_spoc: Joi.string().max(200).optional(),
  client_spoc_name: Joi.string().max(200).optional(),
  client_spoc_email: Joi.string().email().max(200).optional(),
  additional_name: Joi.string().max(200).allow('', null).optional(),
  additional_number: Joi.alternatives(mobile, Joi.string().allow('', null)).optional(),
  client_ref_id: Joi.string().max(100).optional(),
  job_reference_id: Joi.string().max(100).optional(),
  // Per-job override of the customer's master name. Mirrors the
  // createBody entry (~line 183). Accepted on PATCH so Confirm &
  // Schedule can backfill the column on legacy-created parent rows
  // where it was previously NULL. See services/job.service.js
  // MUTABLE_COLUMNS list which already whitelists it.
  job_customer_name: Joi.string().max(255).allow('', null).optional(),
  fk_service_type_ids: Joi.alternatives(Joi.array().items(intId), Joi.string().max(500)).optional(),
  service_type_ids: Joi.alternatives(Joi.array().items(intId), Joi.string().max(500)).optional(),
  helper_req: Joi.boolean().optional(),
  remarks: Joi.string().max(2000).optional(),
  efr_special_notes: Joi.string().max(2000).optional(),
  exp_tat: Joi.string().max(50).optional(),
  booking_cut_off_time: Joi.number().integer().optional(),
  /*
   * booking_cut_off_time_slot was declared TWICE in this same object — once
   * above as `.max(50).allow('', null)` and again here as `.max(100)`. The
   * later key wins in an object literal, so the one in force was this one, and
   * `.allow('', null)` was silently discarded: a caller sending '' or null for
   * that legacy column got a 400 that the author 40 lines up had explicitly
   * allowed. Found by ESLint's no-dupe-keys the first time this repo was linted.
   *
   * Removed rather than merged: the two sibling declarations of this key (here
   * and in the create schema) both use max(50).allow('', null), so that is the
   * intent, and the column is COALESCE-backfilled and routinely empty.
   */
  // Services replacement — when present, tbl_job_services rows for this job
  // are wiped and these inserted. Used by the Unconfirmed-order Confirm flow.
  services: Joi.array().items(serviceItem).optional(),
  // Nested edits for the Confirm & Schedule flow. Both blocks are optional;
  // within each, every field is optional so the UI can send only what changed.
  // IDs (customer_id, address_id) aren't needed — the service resolves them
  // from the current job row.
  customer: Joi.object({
    customer_name: Joi.string().max(255).optional(),
    customer_email: Joi.string().email().max(255).allow('').optional(),
  }).optional(),
  address: Joi.object({
    address: Joi.string().max(2000).optional(),
    building: Joi.string().max(500).allow('').optional(),
    landmark: Joi.string().max(500).allow('').optional(),
    address_instruction: Joi.string().max(1000).allow('', null).optional(),
    city_id: intId.optional(),
    pin_code: pinCode.optional(),
    gps_location: gpsPair.allow('').optional(),
  }).optional(),
}).min(1);

/*
 * PATCH /api/admin/jobs/:id/status — the ONLY consumer of this schema
 * (routes/admin/jobs.js:1471; validators/easyfixer.validator.js has its own
 * unrelated `statusBody`). It hands `req.body` straight to
 * services/job.service.js#setStatus, which destructures
 * `{ status, reasonId, comment, extras }`.
 *
 * `extras` HAD to be declared here (2026-08-20). middleware/validate.js runs Joi
 * with `stripUnknown: true`, so an undeclared key is not rejected — it is
 * silently deleted. setStatus reads `extras.revisit_reason_id` when a job moves
 * into REVISIT, both to stamp tbl_job.revisit_reason_id and to name the reason
 * on the tbl_job_logs 'Re-visit Required' row, and from this route that read was
 * unconditionally `undefined`: every CRM "Mark InComplete" landed a revisit with
 * no reason attached and nothing anywhere said why.
 *
 * ── Why a nested object and not a top-level `revisitReasonId` ───────────────
 * setStatus's parameter is `extras`, and this validator cannot reshape a body
 * into a shape the service does not read.
 *
 * ── Why exactly ONE key, and why NOT derived from `reasonId` ────────────────
 * `extras` is a column→value map applied to tbl_job. setStatus whitelists the
 * column NAMES (STATUS_EXTRAS_ALLOWLIST) against SQL injection, but that list
 * spans the whole mobile check-in / check-out / ETA surface — GPS readings,
 * check-in timestamps, cash amounts. Accepting a free-form object here would
 * hand an operator endpoint the technician app's entire stamp set, so only the
 * one key this route legitimately carries is declared; `stripUnknown` removes
 * the rest, exactly as it removed `extras` itself before.
 *
 * It is deliberately NOT auto-filled from the sibling `reasonId`, even though
 * that would spare the FE a change. They are ids in DIFFERENT namespaces:
 * `reasonId` is an `action_taken_reason.id` (cancel / enquiry dropdowns, stored
 * as enum_reason_id), while `revisit_reason_id` is FK to `revisit_reason_by_app`.
 * Copying one into the other would silently store a cross-namespace id in an FK
 * column and rename someone's revisit reason on the legacy screen.
 */
const statusBody = Joi.object({
  status: Joi.number().integer().valid(...ALL_STATUS_VALUES).required(),
  reasonId: intId.optional(),
  comment: Joi.string().max(500).optional(),
  extras: Joi.object({
    revisit_reason_id: intId.optional(),
  }).optional(),
});

const assignBody = Joi.object({
  easyfixerId: intId.required(),
  reasonId: intId.optional(),
  rescheduleReason: Joi.string().max(500).optional(),
  // Schedule & Assign — optional schedule edit applied atomically with the
  // assign. When provided, the job's requested_date_time (+ time_slot when
  // also supplied) is updated in the same transaction as the assignment.
  // IST WALL-CLOCK string (datetime-local "YYYY-MM-DDTHH:mm" or date-only),
  // NOT Joi.date() — coercing to a JS Date and round-tripping through
  // toISOString() shifts the day/time across the UTC↔IST boundary (the DB
  // stores IST wall-clock literals). Keep it a string end-to-end.
  requestedDateTime: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/).max(40).optional(),
  timeSlot: Joi.string().max(200).allow('', null).optional(),
});

/*
 * Offer body — POST /:id/offer. The offer-pool model fans a single job out to
 * MULTIPLE technicians at once, so the payload carries an `easyfixerIds` array
 * (1..50) rather than the single `easyfixerId` that legacy direct-assign uses.
 * `requestedDateTime` + `timeSlot` reuse assignBody's definitions verbatim so
 * the optional schedule edit rides along with the offer exactly as it does on
 * /assign (IST wall-clock string — see the assignBody note above).
 */
const offerBody = Joi.object({
  easyfixerIds: Joi.array().items(intId).min(1).max(MAX_OFFER_RECIPIENTS).required(),
  requestedDateTime: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/).max(40).optional(),
  timeSlot: Joi.string().max(200).allow('', null).optional(),
  // Where the offer was made from — the CRM sends `source` when the whole batch
  // shares one origin (Top-10 list vs Search Result), or `sourceByEfr` to tag
  // each tech individually when a selection mixes both lists. Stored on
  // tbl_job_offer.offer_source. `sourceByEfr` overrides `source` per tech.
  source: Joi.string().valid('top10', 'search', 'auto').optional(),
  sourceByEfr: Joi.object().pattern(/^\d+$/, Joi.string().valid('top10', 'search', 'auto')).optional(),
});

/*
 * Query schema for GET /:id/candidates (ranked top-N) — limit + optional
 * proposed-schedule overrides so the modal can recompute attendance /
 * concurrent / same-slot against the date/slot the ops user is editing.
 */
const candidatesQuery = Joi.object({
  limit: Joi.number().integer().min(1).max(200).default(10),
  // Wall-clock string (see requestedDateTime note) — service slices to the
  // date-only prefix for DATE() comparisons; must NOT be UTC-converted.
  jobDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/).max(40).optional(),
  timeSlot: Joi.string().max(200).optional(),
});

/*
 * Query schema for GET /:id/candidates/search (match-anyone). `term` is
 * required and is the ONLY search input — it matches efr_id / efr_name /
 * efr_no / city_name / efr_pin_no, so no per-field (city=/pin=) params exist.
 * Same optional schedule overrides as the ranked list.
 */
const candidatesSearchQuery = Joi.object({
  term: Joi.string().trim().min(1).max(100).required(),
  // 250 (2026-07-15): the modal paginates the result client-side, so a bigger
  // page is a nicer list rather than a longer scroll. Still CAPPED — an
  // unbounded LIKE over ~4.7k technicians would serialise the whole table into
  // one payload on a 1-char term.
  limit: Joi.number().integer().min(1).max(250).default(250),
  jobDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/).max(40).optional(),
  timeSlot: Joi.string().max(200).optional(),
});

const ownerBody = Joi.object({
  newOwnerId: intId.required(),
  reason: Joi.string().min(3).max(500).required(),
});

/*
 * Reschedule body — PATCH /:id/reschedule. The Schedule & Assign modal locks the
 * job's Date/Time and changes them ONLY via the explicit Reschedule dialog, where
 * reason + remarks are MANDATORY (audited to scheduling_history + a job comment).
 * All three fields required. `requestedDateTime` is an IST WALL-CLOCK string
 * exactly like assignBody's (never Joi.date() — see that note). `rescheduleReason`
 * is the selected reason's label (mirrored into scheduling_history.reschedule_reason
 * alongside `reasonId`).
 */
const rescheduleBody = Joi.object({
  requestedDateTime: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/).max(40).required(),
  reasonId: intId.required(),
  rescheduleReason: Joi.string().max(500).optional(),
  remarks: Joi.string().trim().min(1).max(500).required(),
});

/*
 * Query schema for GET /:id/slot-recommendations. `date` is a wall-clock IST
 * date — the service compares it as a plain string against DATE() values, so it
 * must NOT be UTC-converted anywhere on the way in.
 */
const slotRecommendationsQuery = Joi.object({
  date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/).max(40).required(),
});

const idParam = Joi.object({ id: intId.required() });

module.exports = {
  listQuery, createBody, updateBody, statusBody, assignBody, offerBody, ownerBody, idParam,
  rescheduleBody, candidatesQuery, candidatesSearchQuery, slotRecommendationsQuery,
};
