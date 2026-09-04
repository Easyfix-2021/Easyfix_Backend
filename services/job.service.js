const { pool } = require('../db');
const logger = require('../logger');
const { isAbsentAnswer } = require('../utils/schema-absent-error');
// Job-OTP generator — shared with the auth flow so we're not
// duplicating the cryptographically-safe 4-digit primitive. See
// utils/otp.js::generateOtp() for the implementation. Used at
// order-confirmation time (see create() + setStatus() below).
const { generateOtp } = require('../utils/otp');
// Property-flag reader for THE OFFER MODEL toggle (`job.offer.flow.enabled`).
// Synchronous, cache-backed — see services/properties.service.js::getProperty.
const { getProperty } = require('./properties.service');
const addressService = require('./address.service');
// Job Stage Access — pure stage/status helpers (no DB). stageVisibleStatuses
// turns a user's allowed stage keys into the union of visible job_status codes,
// AND-combined (intersected) with the tab/status filters in list/counts/attention.
const { stageVisibleStatuses } = require('../lib/job-stages');
const {
  JOB_AGE_STATUS,
  JOB_AGE_END_EXPR,
  JOB_AGE_SECS_EXPR,
  JOB_AGE_DAYS_EXPR,
  JOB_AGE_COLUMNS,
} = require('../utils/job-age-sql');
// Appointment time-slot model (pure, no DB) — see services/time-slot.js for
// what tbl_job.time_slot / requested_time / requested_date_time each mean and
// why the slot STRING is no longer load-bearing anywhere.
const { deriveTimeSlot, resolveTimeSlot, hasTimeOfDay, wallClockTime } = require('./time-slot');
const easyfixerLifecycle = require('./easyfixer-lifecycle.service');
const easyfixerWorkEligibility = require('./easyfixer-work-eligibility.service');
const {
  persistJobOfferBatch,
  MAX_OFFER_RECIPIENTS,
} = require('./job-offer-persistence.service');
// tbl_job_logs — the platform's job-history archive, written by the legacy Java
// stack since 2015. Every convention (log_for vocabulary, new_data shape,
// eta_status code, actor scheme) lives in that module; every call below is
// FAIL-SOFT and post-COMMIT by its contract, so none of them can fail a mutation.
const jobLog = require('./job-log.service');

/*
 * THE OFFER MODEL feature flag. ON by default — only the literal string
 * "false" (case-insensitive) in easyfix_properties disables it. When ON *and*
 * tbl_job_offer exists, a CRM/auto assign offers the job (stays BOOKED + push)
 * instead of hard-scheduling it. Kept as a tiny helper so assign() and the
 * accept/reject paths share one source of truth.
 */
function offerFlowEnabled() {
  return String(getProperty('job.offer.flow.enabled') ?? 'true').toLowerCase() !== 'false';
}

/*
 * Auto-ensure a job's pincode exists in tbl_pincode (geocoded + state/city) so
 * distance ranking works and an admin can zone-map it — closes the gap where
 * jobs are created with pincodes absent from the pincode catalog. Reuses the
 * idempotent pincode.service.ensurePincode (existing pincode ⇒ one indexed
 * SELECT, no geocode/write). Best-effort + fire-and-forget: called AFTER the
 * job txn commits and NEVER throws — a bad / non-India pincode, a Google
 * outage, or a missing API key just logs. Does NOT create zone mappings (those
 * stay admin-curated). Gated by easyfix_properties 'job.ensure.pincode.enabled'
 * (DEFAULT OFF — flip to 'true' to enable after monitoring).
 */
function ensurePincodeEnabled() {
  return String(getProperty('job.ensure.pincode.enabled') ?? 'false').toLowerCase() === 'true';
}
async function ensureJobPincode(pincode, actor) {
  if (!ensurePincodeEnabled()) return;
  const pin = String(pincode ?? '').trim();
  if (!/^\d{6}$/.test(pin)) return;
  try {
    const { ensurePincode } = require('./pincode.service');
    const res = await ensurePincode(pin, { userId: actor?.user_id ?? null });
    logger.info('Job pincode ensured · pincode=' + pin + ' · ' + (res?.created ? 'created+geocoded' : 'already existed'));
  } catch (e) {
    logger.warn('Job pincode auto-ensure failed (non-fatal) · pincode=' + pin + ' · ' + e.message);
  }
}

/*
 * EFFECTIVE offer-flow state = the property flag AND tbl_job_offer actually
 * existing (the real activation gate). This is the SAME condition assign() /
 * offerToTechnicians() use to choose offer-vs-direct-assign, exposed so the CRM
 * Schedule & Assign modal can MIRROR it: offer-pool (multi-select + "Offer to N")
 * when active, single direct-assign (single-select + "Assign") when not. Async
 * because the table-existence check is. jobOfferTableExists() is a hoisted
 * function declaration (defined below), so referencing it here is safe.
 */
async function isOfferFlowActive() {
  return offerFlowEnabled() && (await jobOfferTableExists());
}

// Open offers auto-expire after this many minutes. ONE source of truth shared
// by the scheduler sweep (expireStaleOffers) and acceptOffer()'s freshness gate
// so the two can never drift. See server/scheduler.js 'job-offer-expiry'.
const OFFER_TTL_MINUTES = 30;

/*
 * Is offer auto-expiry TURNED ON? `job.offer_expiry.enabled` in
 * easyfix_properties, DEFAULT-ON: only the literal string 'false' disables it,
 * exactly matching how server/scheduler.js gates the expiry cron and how the
 * seed migration (migrations/executed/2026-07-14-seed-per-cron-enable-flags.sql)
 * documents the key. Synchronous + cache-backed (properties.service).
 *
 * This is a BUSINESS switch, and it is NOT the same thing as CRON_DISABLED:
 *   CRON_DISABLED (env)                = "no schedulers run in THIS process"
 *                                        (dev/local). Offers still expire — the
 *                                        lazy on-read sweep compensates, and
 *                                        that is legitimate.
 *   job.offer_expiry.enabled = 'false' = "offers must not expire AT ALL".
 *                                        Nothing may expire one, by cron or
 *                                        lazily, and the CRM must not render a
 *                                        still-open offer as if it had.
 * Read it through this ONE helper so the sweep, the row chip and the list
 * filter can never disagree about which regime is in force.
 */
function offerExpiryEnabled() {
  return String(getProperty('job.offer_expiry.enabled') ?? '').toLowerCase() !== 'false';
}

// Named tbl_job_offer.offer_status codes (see services/offer-status.js) — every
// query below interpolates ${OFFER_STATUS.X} instead of a bare 0/1/2/3.
const { OFFER_STATUS } = require('./offer-status');

/*
 * Bulk-expire OPEN offers older than OFFER_TTL_MINUTES (offer_status 0 → 3
 * EXPIRED). Reuses acceptOffer()'s exact expire shape (status=3 + responded_at).
 * Touches ONLY tbl_job_offer — the job legitimately stays BOOKED/owner-less
 * (fk_easyfixter_id NULL) so it remains re-offerable. Tolerant of a missing
 * table (no-op on un-migrated deploys).
 *
 * Two callers:
 *   • the every-2-min scheduler cron — no jobId, a global sweep.
 *   • listOffers() (and the candidate-ranking / tech-search routes) — pass jobId
 *     for a lazy, on-read, job-scoped sweep so the 30-min TTL is honoured in the
 *     CRM even when the schedulers don't run in this process (CRON_DISABLED) or
 *     a tech's offer crosses 30 min between ticks. The UPDATE is idempotent, so
 *     the two paths can never double-expire.
 *
 * ⚠ BOTH callers are gated on `job.offer_expiry.enabled`. The cron is gated at
 * REGISTRATION (server/scheduler.js, decided once at boot), which used to leave
 * the lazy path as a SIDE DOOR: with expiry switched off in properties, merely
 * OPENING Schedule & Assign still performed the very write the business had
 * disabled — and that is how job #521866's 92-minute-old offer flipped to
 * EXPIRED at the exact moment an operator opened the modal, while the list
 * (correctly, for that regime) still read "Offered to Tx". The gate lives HERE,
 * in the one function that issues the UPDATE, so every caller inherits it.
 * CRON_DISABLED is deliberately NOT consulted here — see offerExpiryEnabled().
 */
async function expireStaleOffers(maxAgeMinutes = OFFER_TTL_MINUTES, jobId = null) {
  if (!offerExpiryEnabled()) return { skipped: true, expired: 0, reason: 'offer_expiry_disabled' };
  if (!(await jobOfferTableExists())) return { skipped: true, expired: 0 };
  const params = [maxAgeMinutes];
  let jobClause = '';
  if (jobId != null) { jobClause = ' AND job_id = ?'; params.push(Number(jobId)); }
  const [r] = await pool.query(
    `UPDATE tbl_job_offer
        SET offer_status = ${OFFER_STATUS.EXPIRED}, responded_at = NOW()
      WHERE offer_status = ${OFFER_STATUS.OFFERED}
        AND offered_at < NOW() - INTERVAL ? MINUTE${jobClause}`,
    params,
  );
  return { expired: r.affectedRows || 0 };
}

/*
 * WITHDRAW the open offers on a job that has just reached a state where they
 * can no longer be accepted.
 *
 * ── THE BUG THIS EXISTS FOR ──────────────────────────────────────────
 * A technician was shown "Accept job / Reject" for work that was already
 * finished. Nothing ever closed an offer when its JOB ended: expireStaleOffers
 * closes them on AGE, and `job.offer_expiry.enabled` is "false" in production,
 * so in practice nothing closed them at all. Measured: 1,606 open offers on
 * jobs already completed or cancelled, the youngest ~40 hours old, the oldest
 * ~38 days.
 *
 * ── WHY THIS IS NOT GATED ON job.offer_expiry.enabled ────────────────
 * That flag governs EXPIRY — "the technician did not answer in time" — and was
 * switched off deliberately after an offer flipped to EXPIRED under an operator
 * mid-conversation (see expireStaleOffers). This is a different fact: the job
 * is over, so there is nothing left to accept. Gating this on that flag would
 * tie "stop timing technicians out" to "keep advertising cancelled work", which
 * are unrelated decisions that happen to touch one column.
 *
 * Re-enabling the TTL would ALSO not fix this: a job cancelled two minutes
 * after an offer went out leaves that offer live for the rest of the window,
 * and the technician can accept work that no longer exists.
 *
 * EXPIRED rather than a new code: "closed without a response, superseded by
 * something outside the technician's control" is exactly what offer-status.js
 * documents for EXPIRED. It also matters for fairness — candidate-ranking
 * counts OFFERED and REJECTED when scoring acceptance, so a withdrawn offer
 * must not read as a decline. An EXPIRED row correctly does not.
 *
 * FAIL-SOFT, like the log writes it sits beside: a status transition that has
 * already committed must not report failure because a follow-up UPDATE on a
 * different table did not land.
 */
async function withdrawOffersForClosedJob(jobId, status) {
  if (!OFFER_WITHDRAWAL_STATES.has(Number(status))) return { withdrawn: 0, skipped: true };
  try {
    if (!(await jobOfferTableExists())) return { withdrawn: 0, skipped: true };
    const [r] = await pool.query(
      `UPDATE tbl_job_offer
          SET offer_status = ${OFFER_STATUS.EXPIRED}, responded_at = NOW()
        WHERE job_id = ? AND offer_status = ${OFFER_STATUS.OFFERED}`,
      [Number(jobId)],
    );
    const withdrawn = r.affectedRows || 0;
    if (withdrawn > 0) {
      logger.info('Withdrew open offers on a closed job · jobId=' + jobId
        + ' · status=' + status + ' · offers=' + withdrawn);
    }
    return { withdrawn };
  } catch (e) {
    logger.warn('Offer withdrawal skipped · jobId=' + jobId + ' · '
      + ((e && e.code) || (e && e.message)));
    return { withdrawn: 0, failed: true };
  }
}

/*
 * Job CRUD + status + assignment.
 *
 * Schema notes (tbl_job, 141 cols, ~384k rows as of 2026-04-17):
 *   - fk_easyfixter_id  ← legacy typo. Do NOT "fix" to easyfixer — 5 services depend on the spelling.
 *   - Efr_dis_travelled ← capital E, preserved.
 *   - source_type (varchar) is the human-readable source ("manual", "excel",
 *     "dashboard", "decathlon API"); `source` (tinyint) is legacy.
 *
 * Writes: create + assign + certain status transitions are multi-row and
 * wrapped in a transaction. Simple column updates (update, most status
 * changes) use the pool directly.
 */

// ─── Status glossary (blueprint §3) ─────────────────────────────────
/*
 * Canonical job_status codes (truth from legacy DB, documented 2026-04-20):
 *
 *   0  BOOKED          — default on create. Sub-states:
 *                         • fk_easyfixter_id IS NULL  → "Pending for Scheduling"
 *                         • fk_easyfixter_id NOT NULL → "Pending App Acknowledge"
 *   1  SCHEDULED       — accepted by tech on app, pending check-in
 *   2  IN_PROGRESS     — technician checked in on app
 *   3  COMPLETED       — closed (QA path)
 *   5  COMPLETED_ALT   — closed (legacy alternative completion)
 *   6  CANCELLED       — cancelled by ops
 *   7  ENQUIRY         — information request only (legacy; keep)
 *   9  UNCONFIRMED     — job booked from website / API / dashboard / bulk
 *                        upload, customer not yet confirmed
 *  10  CLOSED_FROM_APP — closed from tech app / estimate approved or rejected
 *  15  ESTIMATE_PENDING_APPROVAL — estimate sent, awaiting customer decision
 *  20  IN_PROGRESS_ALT — second IN_PROGRESS state used by some app paths
 *  21  ON_HOLD         — fulfilment on hold
 *
 * Kept existing NAMES (BOOKED / SCHEDULED / CALL_LATER / REVISIT) as aliases
 * so the 20+ files referencing STATUS.CALL_LATER / STATUS.REVISIT keep
 * compiling without a churn-wide rename. The new CANONICAL names live as
 * separate properties — prefer them in new code.
 */
const STATUS = {
  BOOKED: 0, SCHEDULED: 1, IN_PROGRESS: 2,
  COMPLETED: JOB_AGE_STATUS.COMPLETED,
  COMPLETED_ALT: JOB_AGE_STATUS.COMPLETED_ALT,
  CANCELLED: JOB_AGE_STATUS.CANCELLED,
  ENQUIRY: JOB_AGE_STATUS.ENQUIRY,
  CALL_LATER: 9, REVISIT: 10,
  // Canonical additions (DB-truth per 2026-04-20):
  UNCONFIRMED: 9,                 // alias for CALL_LATER
  CLOSED_FROM_APP: 10,            // alias for REVISIT
  ESTIMATE_PENDING_APPROVAL: 15,
  IN_PROGRESS_ALT: 20,
  ON_HOLD: 21,
};
const ALL_STATUS_VALUES = new Set(Object.values(STATUS));
// Composite buckets for multi-status queries and UI tabs.
const CHECKED_IN_STATES = new Set([STATUS.IN_PROGRESS, STATUS.IN_PROGRESS_ALT]);
const CLOSED_STATES = new Set([STATUS.COMPLETED, STATUS.COMPLETED_ALT]);

// Terminal states — `setStatus` to these sets stamp timestamps
const COMPLETED_STATES = new Set([STATUS.COMPLETED, STATUS.COMPLETED_ALT]);
// A completed/cancelled job must never be revived by the assignment endpoint.
// Keep this deliberately aligned with the established public-share liveness
// rule: statuses 3, 5 and 6 are the terminal states in the legacy job model.
const NON_ASSIGNABLE_STATES = new Set([...COMPLETED_STATES, STATUS.CANCELLED]);

/*
 * Statuses after which an OPEN offer can never be accepted, so it is withdrawn.
 *
 * Derived from NON_ASSIGNABLE_STATES rather than restating 3/5/6: both answer
 * "can a technician still be put on this job?", and a second hand-written list
 * is how the two drift apart.
 *
 * CLOSED_FROM_APP (10) is added on top. It is absent from NON_ASSIGNABLE_STATES
 * on purpose — that set guards the ASSIGNMENT endpoint, where 10 has never been
 * refused — but lib/job-stages.js gives status 10 no outgoing transitions, so it
 * is terminal for THIS question. Production carried 9 open offers on status-10
 * jobs. Widening the withdrawal set is safe in a way widening the assignment set
 * would not be: the only consequence is closing an offer nobody can act on.
 */
const OFFER_WITHDRAWAL_STATES = new Set([...NON_ASSIGNABLE_STATES, STATUS.CLOSED_FROM_APP]);
// Reject is a pre-start acknowledgement, not a generic lifecycle rewind.
// Dedicated endpoints own every state after SCHEDULED.
const DIRECT_REJECTABLE_STATES = new Set([STATUS.BOOKED, STATUS.SCHEDULED]);

// ─── Job Age ────────────────────────────────────────────────────────
/*
 * JOB AGE — elapsed time from ticket creation to the job's TERMINAL event, or
 * to NOW() while the job is still open. Defined ONCE here and reused by the
 * LIST projection, the DETAIL projection and the ORDER BY, so the number an
 * operator reads and the key the list sorts on can never diverge. Same
 * discipline as DAY_EXPR in services/quicksight/quicksight-call-tracking.service.js.
 *
 * Anchors (verified against the live DB 2026-07-31, 481,027 tbl_job rows):
 *   START — j.ticket_created_date_time  (0 NULL)
 *   END   — job_status 3 / 5 (Completed / Completed-alt) → j.checkout_date_time (0 NULL)
 *           job_status 6     (Cancelled)                 → j.cancel_date_time   (0 NULL)
 *           job_status 7     (Enquiry)                   → j.enquiry_date_time  (1 NULL)
 *           anything else    (OPEN)                      → NOW(), keeps ticking
 *
 * The CASE has NO ELSE on purpose: an open job falls out as NULL and the
 * COALESCE turns it into NOW(). That same fall-through is also the robustness
 * net for a terminal row whose anchor is somehow NULL (there is exactly one
 * such enquiry row) — it ages against NOW() instead of emitting NULL.
 *
 * TIMESTAMPDIFF(DAY, …) — NOT DATEDIFF(). TIMESTAMPDIFF counts whole 24-hour
 * spans with the TIME included, which is the agreed granularity: a job created
 * today at 11 AM is age 1 tomorrow at 11 AM (23h59m → 0, 24h00m → 1). DATEDIFF
 * counts calendar-date boundaries, so 11 PM → 1 AM two hours later would wrongly
 * report 1. Verified in SQL — see tests/job-age.test.js for the pure-JS mirror.
 *
 * GREATEST(…, 0) clamps: 59 legacy rows have a terminal timestamp a few seconds
 * BEFORE their ticket_created_date_time (back-dated corrections), and "-3 days"
 * must never render.
 *
 * IST: the pool session timezone is +05:30 and these DATETIMEs are stored as IST
 * wall-clock, so SQL NOW() is already IST and directly comparable. No conversion.
 *
 * PURE COLUMN ARITHMETIC — no placeholders — so it is safe to interpolate into
 * both the SELECT list and the ORDER BY. Every expression is qualified with the
 * `j` alias (tbl_job), which is present in LIST_JOIN, DETAIL_JOIN and the COUNT
 * join alike, so it introduces NO new join and cannot break COUNT/data parity.
 */
// The executable SQL fragments live in utils/job-age-sql.js so bounded mobile
// reads and this CRM service cannot drift. They are imported above and kept
// exported below for backward compatibility with existing consumers/tests.

// ─── The customer name shown ON A JOB ───────────────────────────────
/*
 * A JOB's customer name is the name TYPED ON THAT BOOKING —
 * `tbl_job.job_customer_name` — not the customer-master name. The master row
 * (`tbl_customer`) is keyed on the mobile number and is shared by every job that
 * number ever booked, so it drifts from what was actually entered for THIS
 * order (a shared building number, a relative booking on someone's behalf, a
 * bulk-upload sheet carrying its own name). The master is the FALLBACK: it is
 * used only when the job carries no name of its own.
 *
 * ⚠ NULLIF(TRIM(...), '') IS LOAD-BEARING — do not "simplify" it back to a plain
 * COALESCE. MySQL's COALESCE skips NULL and nothing else, so
 * COALESCE('', cu.customer_name) returns '' — a BLANK customer name on screen,
 * not the fallback. The empty string is reachable, not hypothetical:
 *   · validators/job.validator.js declares job_customer_name as
 *     `Joi.string().max(255).allow('', null)` on BOTH the create and update
 *     schemas — '' is an accepted request value, twice over;
 *   · create() stores `input.job_customer_name ?? input.customer?.customer_name`
 *     and `??` only falls through on null/undefined, so a '' passes straight in;
 *   · services/job-magic-link.service.js writes
 *     `job_customer_name = COALESCE(?, job_customer_name)`, which likewise
 *     stores '' verbatim when the public form posts an empty name.
 * TRIM additionally catches the whitespace-only variant of the same paste.
 *
 * ONE definition, used by the LIST projection, the DETAIL projection, the
 * `customer_name` sort key and the customer-name search terms — so what is
 * displayed, what rows are ordered by and what a search matches cannot drift
 * apart (a search that matched the MASTER name while the row displayed the JOB
 * name would return rows the CRM's client-side re-filter then hides).
 *
 * Pure column arithmetic — no placeholders — so it is safe to interpolate into a
 * SELECT list, an ORDER BY or a WHERE. It names only `j` and `cu`, both
 * unconditionally present in LIST_JOIN / DETAIL_JOIN, and `cu.` stays textually
 * inside it so the COUNT query's alias sniffing still adds the tbl_customer join
 * wherever this expression appears in the WHERE.
 *
 * ⚠ SCOPE: this is "the customer ON THIS JOB". Customer-MASTER surfaces —
 * Manage Customers, customer detail, customer lookup / autocomplete,
 * dedupe-by-mobile — are keyed on tbl_customer, not tbl_job, and must keep
 * reading `cu.customer_name` directly. Do not spread this expression there.
 */
/*
 * Shortest digits-only term treated as a PHONE fragment rather than a job id.
 * Indian mobiles are 10 digits; job ids are currently 6. Nine keeps the two
 * apart without needing to know how long ids will grow.
 */
const MOBILE_MIN_DIGITS = 9;

const JOB_CUSTOMER_NAME_EXPR =
  `COALESCE(NULLIF(TRIM(j.job_customer_name), ''), cu.customer_name)`;

// ─── Server-side sort whitelist ─────────────────────────────────────
/*
 * Maps the FE sort key → the qualified SQL expression the list ORDER BY uses.
 * The list sorts the WHOLE result set in SQL (before LIMIT/OFFSET) so paging and
 * sorting agree; a client-side reorder would only touch the current page. An
 * unknown/absent key falls back to the default newest-first. NEVER interpolate
 * raw sortBy/sortDir — only values FROM this map reach the SQL string, and
 * `j.job_id DESC` is always appended as a stable tiebreaker.
 *
 * All the aliases used here (j / cl / ci / cu / ef / ow) are unconditionally
 * joined by LIST_JOIN. Sorting never touches the COUNT query (which has no
 * ORDER BY at all), so nothing here can break COUNT/data join parity.
 *
 * ⚠ BOTH-SIDES WHITELIST: `validators/job.validator.js` derives its `sortBy`
 * valid() list from Object.keys() of this map, so BE-side drift is now
 * structurally impossible. The FE keeps its own sortable-column list — a key
 * added here still has to be added there, or the column simply won't offer
 * sorting (it can no longer be silently dropped by the API, which is the
 * regression this endpoint hit before).
 *
 * Module scope (not rebuilt per call) so it is exportable and unit-testable.
 */
const SORTABLE_COLUMNS = {
  job_id: 'j.job_id',
  job_reference_id: 'j.job_reference_id',
  client_ref_id: 'j.client_ref_id',
  created_date_time: 'j.created_date_time',
  client_name: 'cl.client_name',
  city_name: 'ci.city_name',
  job_status: 'j.job_status',
  job_type: 'j.job_type',
  requested_date_time: 'j.requested_date_time',
  scheduled_date_time: 'j.scheduled_date_time',
  checkin_date_time: 'j.checkin_date_time',
  checkout_date_time: 'j.checkout_date_time',
  /*
   * Customer name. Sorts on the SAME expression the projection emits, so the
   * column the operator reads and the key the rows are ordered by are one
   * definition. Sorting on `cu.customer_name` while displaying the job-row name
   * would look like a broken sort on every job that overrides it.
   */
  customer_name: JOB_CUSTOMER_NAME_EXPR,
  customer_mob_no: 'cu.customer_mob_no',
  source_type: 'j.source_type',
  easyfixer_name: 'ef.efr_name',
  owner_name: 'ow.user_name',
  /*
   * Job Age. Sorts on the SECONDS expression, never the floored days: sorting by
   * the day value would make every job created on the same day tie and order
   * arbitrarily, and would also collapse the whole sub-day population into one
   * bucket. It is the SAME constant the projection emits as `ageSecs`, so the
   * value on screen and the key rows are ordered by are one definition — they
   * cannot diverge.
   */
  age: JOB_AGE_SECS_EXPR,
};

// ─── Projections ────────────────────────────────────────────────────
// Note: extra columns (ticket_created_date_time, time_slot, client_spoc*,
// remarks) are included on the LIST projection because the Unconfirmed
// tab on /jobs and /my-orders surfaces them in dedicated columns. All
// fields live on tbl_job — no extra JOINs needed. Kept on the default
// LIST to avoid having to split the projection per tab.
const LIST_COLUMNS = `
  j.job_id, j.job_reference_id, j.client_ref_id,
  j.job_status, j.job_type, j.source_type,
  LEFT(j.job_desc, 200) AS job_desc,
  j.created_date_time, j.requested_date_time, j.scheduled_date_time,
  j.checkin_date_time, j.checkout_date_time,
  j.ticket_created_date_time, j.time_slot,
  /*
   * last_update_time exposed on LIST (added 2026-05-28) so the FE can
   * derive a "Draft" indicator for Unconfirmed (status=9) rows whose
   * last_update_time is meaningfully later than created_date_time —
   * a sign that an operator clicked Save Draft on the Confirm modal.
   * No new column needed; just SELECTing an existing tbl_job column.
   */
  j.last_update_time,
  j.client_spoc, j.client_spoc_name,
  LEFT(j.remarks, 500) AS remarks,
  j.original_appointment_date_time,
  /* Auto-reschedule marker — was this job's appointment auto-shifted +1 day by
     the after-3pm magic-link-open rule? Drives the "Auto Rescheduled" chip +
     the "Original: <date>" line on the Unconfirmed list. Keyed on
     scheduling_history (rows persist — unlike j.remarks, which the next comment
     overwrites) via the idx_sched_hist_job covering index (job_id, …,
     reschedule_reason), so it's a cheap indexed EXISTS per row. */
  (EXISTS (SELECT 1 FROM scheduling_history sh
     WHERE sh.job_id = j.job_id
       AND sh.reschedule_reason LIKE '%Auto Rescheduled%')) AS auto_rescheduled,
  /* customer_name = the name booked ON THIS JOB, master name as fallback.
     Alias is unchanged (customer_name) — the CRM row key, the client-side
     search field and the XLSX export all read that key. See
     JOB_CUSTOMER_NAME_EXPR for why the NULLIF/TRIM guard is mandatory. */
  j.fk_customer_id, ${JOB_CUSTOMER_NAME_EXPR} AS customer_name, cu.customer_mob_no,
  j.fk_client_id, cl.client_name,
  j.fk_service_catg_id, sc.service_catg_name AS service_category,
  j.fk_easyfixter_id, ef.efr_name AS easyfixer_name,
  /*
   * easyfixer_mobile — the assigned technician's phone (tbl_easyfixer.efr_no),
   * surfaced so the Pending-to-Start Technician column can offer click-to-call.
   * This exact alias is already listed in utils/mask-mobile.js MOBILE_FIELDS
   * (and deliberately NOT in CUSTOMER_MOBILE_FIELDS), so the mask middleware
   * auto-masks it to first-4-then-bullets and keeps it masked even when the
   * customer-number-visible flag is ON — do NOT add any other masking here, and
   * do NOT rename the alias (a different key would bypass the mask and leak the
   * staff number).
   */
  ef.efr_no AS easyfixer_mobile,
  j.job_owner, ow.user_name AS owner_name,
  j.fk_address_id, ci.city_name, ad.address, ad.gps_location,
  /*
   * service_count — count of ACTIVE rows on tbl_job_services for this
   * job. Powers the FE "Booked but no services" pill (added
   * 2026-05-28), mirrors the existing Draft-pill pattern on
   * UnconfirmedJobsTable. Counts only job_service_status = 1 so a
   * job whose only services were soft-deleted is still flagged.
   *
   * Performance: correlated subquery on the indexed job_id column.
   * For a 384k-row tbl_job with typical per-job service rows (1-5),
   * adds ~2-3ms over the base list query — verified at QA. If this
   * ever becomes hot enough to dominate cost, swap to a LATERAL JOIN
   * or join-on-derived-table.
   */
  (SELECT COUNT(*) FROM tbl_job_services js
    WHERE js.job_id = j.job_id AND js.job_service_status = 1) AS service_count,
  /*
   * Customer Magic-Link Completion (added 2026-05-28) — drives the
   * three FE pills on the Unconfirmed Jobs list (Customer Submitted /
   * Link Sent / none) plus the Trigger / Retrigger action button.
   *
   *   customer_submitted_at      — non-null once the customer hits the
   *                                magic-link landing page and submits.
   *   magic_link_sent_at         — last time we dispatched the link.
   *   magic_link_send_count      — number of dispatches so far; the FE
   *                                uses this to label the button as
   *                                Trigger (0) vs Retrigger (>=1).
   *   magic_link_last_action     — short string (e.g. sent, viewed,
   *                                submitted) for tooltip / audit only.
   *
   * client_opted_in is derived via EXISTS on tbl_client_custom_properties
   * with c_prop_name = auto_process_unconfirmed_order and a truthy
   * (lowercase true) c_prop_values. Returned as 0/1 so the FE can gate
   * the action button without a second round-trip. Correlated subquery
   * on the indexed client_id column — cost is negligible.
   *
   * Schema note (2026-05-30): the live table uses the legacy c_prop_*
   * column names — c_prop_name, c_prop_values (plural), c_prop_mandatory,
   * plus status for soft-delete (1=active, 0=deleted). Earlier drafts of
   * this file referenced property_name/property_value which don't exist
   * on the schema — fixed in-place. (Note: no backticks in this comment
   * because the surrounding LIST_COLUMNS is itself a JS template literal,
   * so backticks would close the literal early and break parsing.)
   */
  j.customer_submitted_at,
  j.magic_link_sent_at,
  j.magic_link_send_count,
  j.magic_link_last_action,
  /*
   * magic_link_max_send_count — per-client configurable cap on how many
   * magic-link sends are allowed before the Trigger button locks for
   * non-Admin operators. Read from tbl_client_custom_properties under
   * c_prop_name='max_magic_link_send_count' (same shape pattern as the
   * auto_process_unconfirmed_order toggle). Defaults to 3 when the
   * client hasn't set a custom value.
   *
   * CAST UNSIGNED guards against ops storing the value as '3 ' or
   * 'three' — NULL bubbles to the COALESCE, keeping the default safe.
   */
  COALESCE(
    (SELECT CAST(NULLIF(ccp_max.c_prop_values, '') AS UNSIGNED)
       FROM tbl_client_custom_properties ccp_max
      WHERE ccp_max.client_id    = j.fk_client_id
        /*
         * Case-insensitive comparison that normalises BOTH '_' and '-' to
         * spaces on both sides, so the same row matches whether c_prop_name was
         * stored as legacy snake_case ('max_magic_link_send_count'),
         * lower-case-with-spaces ('max magic-link send count'), or the Title
         * Case canonical form ('Max Magic-Link Send Count'). MUST stay identical
         * to the copy in services/job-magic-link.service.js or the FE-displayed
         * cap and the BE-enforced cap will diverge. (Was '_'-only — the hyphen
         * in the literal never matched snake_case rows → cap fell back to 3.)
         */
        AND LOWER(REPLACE(REPLACE(ccp_max.c_prop_name, '_', ' '), '-', ' '))
            = LOWER(REPLACE('Max Magic-Link Send Count', '-', ' '))
        AND (ccp_max.status IS NULL OR ccp_max.status = 1)
      LIMIT 1),
    3
  ) AS magic_link_max_send_count,
  (EXISTS (
     SELECT 1 FROM tbl_client_custom_properties ccp
      WHERE ccp.client_id = j.fk_client_id
        AND LOWER(TRIM(REPLACE(ccp.c_prop_name, '_', ' '))) = LOWER('Auto Process Unconfirmed Order')
        AND LOWER(TRIM(ccp.c_prop_values)) = 'true'
        AND ccp.status = 1
   )) AS client_opted_in
`;

/*
 * Join map — the LIST data query pulls these for display columns. For COUNT
 * queries we include only the joins that the actual WHERE clause references,
 * which on a 384k-row table is the difference between a 6-way join full-scan
 * (~6s) and a single-table count over an indexed column (~50ms).
 */
const LIST_JOIN = `
  FROM tbl_job j
  LEFT JOIN tbl_customer    cu ON cu.customer_id = j.fk_customer_id
  LEFT JOIN tbl_address     ad ON ad.address_id  = j.fk_address_id
  LEFT JOIN tbl_city        ci ON ci.city_id     = ad.city_id
  LEFT JOIN tbl_client      cl ON cl.client_id   = j.fk_client_id
  LEFT JOIN tbl_easyfixer   ef ON ef.efr_id      = j.fk_easyfixter_id
  LEFT JOIN tbl_user        ow ON ow.user_id     = j.job_owner
  LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = j.fk_service_catg_id
`;

/*
 * ─── ESCALATION (2026-08-26) ────────────────────────────────────────────────
 *
 * The escalation record lives on tbl_easyfixer_rating_by_customer, keyed by
 * job_id: is_escalated (0/1), escalated_by (tbl_user FK), escalated_time,
 * no_of_escalations, escalated_comments.
 *
 * BOTH HALVES ARE OPT-IN, appended only when the caller actually filters by
 * escalation. That is what let this land without changing one byte of any
 * other caller's payload — the previous author left `isEscalated` as a
 * documented no-op precisely because "implementing the proper join would touch
 * the LIST projection too", and this is the way it does not.
 *
 * ⚠ THE FILTER IS AN `EXISTS`, NOT THIS JOIN. job_id is not unique on that
 * table (routes/public/feedback.js probes with LIMIT 1 before deciding
 * INSERT vs UPDATE, so nothing guarantees one row), and filtering through a
 * JOIN would multiply a job's row per rating and inflate both the list and its
 * COUNT. EXISTS is also why the COUNT query needs no escalation join at all:
 * the subquery is self-contained.
 *
 * The PROJECTION join picks MAX(table_id) — the latest rating row — so the
 * columns are deterministic rather than whichever row the optimiser reached
 * first.
 */
function escalationColumns(want) {
  if (!want) return '';
  return `,
  esc.is_escalated, esc.no_of_escalations, esc.escalated_time, esc.escalated_comments,
  escu.user_name AS escalated_by_name`;
}

function escalationJoin(want) {
  if (!want) return '';
  return `
  LEFT JOIN tbl_easyfixer_rating_by_customer esc ON esc.table_id = (
    SELECT MAX(e2.table_id) FROM tbl_easyfixer_rating_by_customer e2
     WHERE e2.job_id = j.job_id)
  LEFT JOIN tbl_user escu ON escu.user_id = esc.escalated_by`;
}

/*
 * `tbl_client.vertical_id` is referenced by the verticals-scope filter
 * below. Some DB instances don't have this column — the canonical
 * client↔vertical mapping there lives in `tbl_vertical_mapping`
 * instead. We probe at startup, cache the answer, and silently skip
 * the vertical filter when the column is absent rather than 500ing
 * the entire jobs list.
 *
 * If your DB uses tbl_vertical_mapping, vertical filtering for the
 * jobs list is unavailable until that JOIN is wired (separate
 * follow-up). Admin-group users bypass scope entirely so this
 * affects only operators with verticals = 'allow' in their RBAC
 * scope.
 */
/*
 * Column-probe for `tbl_job.otp` (verified legacy column — see
 * EasyFix_CRM JobDaoImpl.java:4418 `update tbl_job set otp =?`). The
 * Node BE generates a 4-digit OTP at order-confirmation time
 * (create() with BOOKED status, or setStatus() transitioning TO
 * BOOKED) so the technician can verify on check-in. Legacy generated
 * the OTP at check-in (saveCheckInJob), but ops moved the contract
 * forward to confirmation so the customer can be told the code
 * earlier in the cycle — see the 2026-05-28 ask.
 *
 * Column is present on every deploy verified so far, but we probe
 * (and cache) so a partially-migrated DB doesn't break booking.
 */
let _hasOtpColumn = null;
async function hasOtpColumn() {
  if (_hasOtpColumn !== null) return _hasOtpColumn;
  try {
    const [rows] = await pool.query("SHOW COLUMNS FROM tbl_job LIKE 'otp'");
    _hasOtpColumn = rows.length > 0;
  } catch (e){
    // A failure is NOT cached — the memo above is for the ANSWER. Freezing a transient information_schema error would disable this until restart.
    logger.warn('job: schema probe failed · _hasOtpColumn · ' + e.message
      + ' — treating as absent for this call only');
    return false;
  }
  return _hasOtpColumn;
}

/*
 * Probe for tbl_job_services.created_by / fk_created_by. Older deploys may
 * not have either column; we conditionally stamp the actor's user_id when
 * the column exists so audit fields are populated without breaking inserts
 * on un-migrated DBs. Returns the resolved column name or null.
 * Memoised once per process. Mirrors the hasOtpColumn pattern above.
 */
let _jobServicesCreatedByCol = undefined; // undefined=unprobed, null=absent
async function jobServicesCreatedByColumn() {
  if (_jobServicesCreatedByCol !== undefined) return _jobServicesCreatedByCol;
  try {
    const [rows] = await pool.query(
      "SHOW COLUMNS FROM tbl_job_services WHERE Field IN ('created_by', 'fk_created_by')"
    );
    if (rows.length === 0) { _jobServicesCreatedByCol = null; return null; }
    // Prefer fk_created_by when both exist (matches tbl_job convention).
    const names = rows.map((r) => r.Field);
    _jobServicesCreatedByCol = names.includes('fk_created_by') ? 'fk_created_by'
                              : names.includes('created_by')   ? 'created_by'
                              : null;
  } catch {
    _jobServicesCreatedByCol = null;
  }
  return _jobServicesCreatedByCol;
}

/*
 * IST timezone helpers (2026-06-04).
 *
 * Platform convention (CLAUDE.md "Coding rules" §7):
 *   "Dates stored as MySQL DATETIME, displayed IST on frontend."
 *
 * That means tbl_job.requested_date_time / original_appointment_date_time
 * must land as a NATIVE MySQL DATETIME literal — `'YYYY-MM-DD HH:MM:SS'`
 * — and the wall-clock time MUST be IST. Otherwise mysql2 default-binds a
 * JS Date as an ISO 8601 UTC string with a Z suffix
 * (e.g. `'2026-06-15T15:00:00.000Z'`) which (a) MySQL stores as the UTC
 * wall-clock not IST, and (b) breaks downstream legacy reports that parse
 * the column as the IST literal.
 *
 * IST is a fixed +05:30 offset (no DST), so we shift the parsed UTC
 * instant by +330 minutes and then read the resulting Date's UTC getters
 * (which now represent IST clock time). Bypasses JS Date's local-tz
 * sensitivity entirely — same output regardless of whether the server
 * runs in UTC, IST, or any other TZ.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
function _toIstDate(d) {
  const date = (d instanceof Date) ? d : new Date(d);
  if (Number.isNaN(+date)) return null;
  return new Date(date.getTime() + IST_OFFSET_MS);
}
function _pad(n) { return String(n).padStart(2, '0'); }

/*
 * formatMysqlDateTimeIST(d) → 'YYYY-MM-DD HH:MM:SS' (IST clock time)
 * Returns null on falsy / unparseable input.
 */
function formatMysqlDateTimeIST(d) {
  if (!d) return null;
  const ist = _toIstDate(d);
  if (!ist) return null;
  return (
    ist.getUTCFullYear() + '-' +
    _pad(ist.getUTCMonth() + 1) + '-' +
    _pad(ist.getUTCDate()) + ' ' +
    _pad(ist.getUTCHours()) + ':' +
    _pad(ist.getUTCMinutes()) + ':' +
    _pad(ist.getUTCSeconds())
  );
}

/*
 * formatTimeIST(d) → 'HH:MM' (IST clock time)
 * Used for the legacy `requested_time` / `original_appointment_time`
 * columns which store the time portion separately from the DATETIME.
 */
function formatTimeIST(d) {
  if (!d) return null;
  const ist = _toIstDate(d);
  if (!ist) return null;
  return _pad(ist.getUTCHours()) + ':' + _pad(ist.getUTCMinutes());
}

/*
 * combineDateTime(dt, timeStr) → 'YYYY-MM-DD HH:MM:SS' (IST)
 *
 * Returns the IST-formatted MySQL DATETIME literal for `dt`.
 *
 * Bonus behaviour: if the parsed instant is UTC midnight (the common
 * "FE sent a date-only ISO" sentinel — e.g. `'2026-06-15T00:00:00.000Z'`
 * with the actual time-of-day shipped separately in `timeStr`), splice
 * the timeStr in as IST clock time. We pull the date portion from the
 * IST-shifted projection of `dt` and concatenate with the explicit
 * timeStr — bypasses any JS Date `setHours` (which is local-tz-dependent
 * and produces inconsistent results across server timezones).
 *
 * Used by create() to repair Book-New-Call payloads where
 * `requested_date_time` arrived without a real time portion and the
 * time was sent separately in `requested_time`.
 */
function combineDateTime(dt, timeStr) {
  if (!dt) return null;
  const d = (dt instanceof Date) ? dt : new Date(dt);
  if (Number.isNaN(+d)) return null;

  const isUtcMidnight =
    d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
  if (isUtcMidnight && timeStr && /^\d{1,2}:\d{2}/.test(timeStr)) {
    const ist = _toIstDate(d);
    const [hh, mm, ss = '0'] = String(timeStr).split(':');
    return (
      ist.getUTCFullYear() + '-' +
      _pad(ist.getUTCMonth() + 1) + '-' +
      _pad(ist.getUTCDate()) + ' ' +
      _pad(Number(hh) || 0) + ':' +
      _pad(Number(mm) || 0) + ':' +
      _pad(Number(ss) || 0)
    );
  }
  return formatMysqlDateTimeIST(d);
}

/*
 * Derive booking_cut_off_time_slot — the legacy "H AM - H PM" appointment
 * window — from an IST 'YYYY-MM-DD HH:MM:SS' datetime string. The new-CRM
 * create flow only ever set the named `time_slot` ("Morning 9 to 2" …) and
 * left booking_cut_off_time_slot NULL; ops want BOTH columns populated, so we
 * backfill this from the same appointment time. Values (buckets + the one-word
 * "AfterHours") verified against tbl_job's existing legacy rows. Callers MUST
 * pass a wall-clock STRING (createJob's combineDateTime output, or a
 * DATE_FORMAT'd column) so slice(11,13) is the IST hour regardless of the
 * mysql2 connection timezone. Returns null for an absent/unparseable value.
 */
function deriveBookingCutoffSlot(dt) {
  if (!dt) return null;
  const h = Number(String(dt).slice(11, 13)); // 'YYYY-MM-DD HH:...' → HH
  if (!Number.isFinite(h)) return null;
  if (h >= 9  && h < 12) return '9 AM - 12 PM';
  if (h >= 12 && h < 15) return '12 PM - 3 PM';
  if (h >= 15 && h < 19) return '3 PM - 7 PM';
  return 'AfterHours';
}

/*
 * ── `time_slot` = the BROAD BOOKING BAND, and nothing else ────────────────
 *
 * deriveTimeSlot(dt) returns the BAND containing an IST 'YYYY-MM-DD HH:MM:SS'
 * appointment time — one of exactly four values ('9AM to 12PM', '12PM to 3PM',
 * '3PM to 7PM', 'After Hours'). It lives in services/time-slot.js, the single
 * module that owns the model; re-exported from here because every existing
 * caller (and the module export surface) reaches for it via job.service.
 *
 * REVERSED 2026-07-31 — the 1-HOUR slot vocabulary is GONE from this column.
 * deriveOneHourSlot() / LEGACY_TIME_SLOT_BANDS / rederiveTimeSlot(), added
 * earlier the same day so reschedule would PRESERVE a 1-hour label, are
 * deleted. The 1-hour frame ops/the customer picks now lives where it belongs:
 * its START is requested_date_time's time-of-day (and requested_time), and
 * time_slot only ever records the band containing it. resolveTimeSlot() is the
 * one writer-side gate that guarantees it.
 *
 * The old four bands this function used to emit ('Morning 9 to 2' …) were a
 * SECOND vocabulary the backend wrote while the CRM picker wrote a third —
 * which is why `time_slot = ?` equality could never be trusted. Historical
 * rows are deliberately NOT migrated; nothing matches on the string any more.
 *
 * (deriveTimeSlot / resolveTimeSlot are imported at the top of this file.)
 */

let _hasClientVerticalIdColumn = null;
async function hasClientVerticalIdColumn() {
  if (_hasClientVerticalIdColumn !== null) return _hasClientVerticalIdColumn;
  try {
    const [rows] = await pool.query("SHOW COLUMNS FROM tbl_client LIKE 'vertical_id'");
    _hasClientVerticalIdColumn = rows.length > 0;
  } catch (e) {
    // SHOW COLUMNS itself failed — be conservative and treat as missing.
    // eslint-disable-next-line no-console
    console.warn('[job.service] could not probe tbl_client.vertical_id:', e?.message);
    // A failure is NOT cached. This asks the SCHEMA, so absence is zero rows and
    // any error is a genuine fault — freezing it would disable this until restart.
    return false;
  }
  if (!_hasClientVerticalIdColumn) {
    // eslint-disable-next-line no-console
    console.warn('[job.service] tbl_client.vertical_id not present — verticals scope filter will be skipped on jobs list/count queries. Client→vertical mapping may live in tbl_vertical_mapping; wire that JOIN if vertical-based RBAC matters.');
  }
  return _hasClientVerticalIdColumn;
}

// tbl_address.address_instruction is column-probed (present per deploy — the
// same guard the write paths use). getByIdCore must branch the SELECT so DBs
// without the column don't 500 on job-detail reads. Memoised + degrades to
// "absent" on probe failure: a read must never 500 over a missing column.
function hasAddressInstructionColumn() {
  return addressService.hasAddressInstructionColumn(pool, {
    cache: true,
    onProbeError: 'assume-absent',
  });
}

/*
 * job_primary_spoc — a snapshot of WHICH USER was the client's primary SPOC
 * when this job was created. It stores `tbl_user.user_id`.
 *
 * WHAT IT IS FOR. Ownership follows the SPOC of the day: the jobs booked while
 * X is the client's primary SPOC belong to X forever, and the day the mapping
 * moves to Y, only jobs created from then on belong to Y. That is why this is
 * stamped ONCE at create and deliberately never re-stamped (see the note in
 * changeOwner) — re-stamping would retroactively hand X's history to Y.
 *
 * IT IS AN ID, NOT A PHONE — verified against the legacy consumer, not assumed.
 * EasyFix_CRM's Jobs.java:395 declares `private int jobPrimarySpoc;` against
 * @JsonProperty("job_primary_spoc"), so the legacy CRM has always read this as
 * a numeric id. A previous revision of this function stamped the head's
 * mobile_no here; an Indian mobile is 10 digits starting 6-9, i.e. at least
 * 6,000,000,000, which OVERFLOWS Java's int ceiling of 2,147,483,647 — so every
 * such row was a deserialize failure waiting for the legacy CRM to read it.
 * Before that it stamped the JOB OWNER's phone, wrong on every row for a
 * second reason: the owner (the CRM operator holding the job) and the client's
 * head are different people by definition.
 *
 * PROD-only legacy column (absent on some DBs incl. QA), so probe once + no-op
 * where missing. Pending migration:
 * migrations/2026-07-03-add-job-primary-spoc.sql.
 */
let _hasJobPrimarySpocColumn = null;
async function hasJobPrimarySpocColumn() {
  if (_hasJobPrimarySpocColumn !== null) return _hasJobPrimarySpocColumn;
  try {
    const [rows] = await pool.query("SHOW COLUMNS FROM tbl_job LIKE 'job_primary_spoc'");
    _hasJobPrimarySpocColumn = rows.length > 0;
  } catch (_e) {
    // A failure is NOT cached. This asks the SCHEMA, so absence is zero rows and
    // any error is a genuine fault — freezing it would disable this until restart.
    logger.warn('schema probe failed · tbl_job.job_primary_spoc · ' + _e.message
      + ' — treating as absent for this call only');
    return false;
  }
  return _hasJobPrimarySpocColumn;
}
/*
 * tbl_vertical_mapping.inserted_on is NOT written by the INSERTs in
 * client-verticals.service.js — it is a DB default where it exists at all, and
 * absent on some deploys. So probe it exactly the way the column above is
 * probed, and pick the ORDER BY accordingly. Memoised per process; degrades to
 * "absent" on probe failure, which only costs us the better ordering.
 */
let _hasVerticalMappingInsertedOn = null;
async function hasVerticalMappingInsertedOnColumn() {
  if (_hasVerticalMappingInsertedOn !== null) return _hasVerticalMappingInsertedOn;
  try {
    const [rows] = await pool.query("SHOW COLUMNS FROM tbl_vertical_mapping LIKE 'inserted_on'");
    _hasVerticalMappingInsertedOn = rows.length > 0;
  } catch (_e) {
    // A failure is NOT cached. This asks the SCHEMA, so absence is zero rows and
    // any error is a genuine fault — freezing it would disable this until restart.
    logger.warn('schema probe failed · tbl_vertical_mapping.inserted_on · ' + _e.message
      + ' — treating as absent for this call only');
    return false;
  }
  return _hasVerticalMappingInsertedOn;
}
/*
 * Stamp the snapshot for `jobId` from `clientId`'s vertical HEAD
 * (tbl_vertical_mapping.user_type = 1; 2 is Project Manager — see
 * services/client-verticals.service.js).
 *
 * WHY latest-wins when a client has several heads: the mapping is per
 * (client, vertical) and A JOB HAS NO VERTICAL OF ITS OWN — a job's vertical is
 * only ever derived as "this job's CLIENT is mapped to that vertical" (see the
 * verticalId EXISTS clause in the list filter above). So there is no per-job
 * way to choose between two heads, and latest-wins is the owner's deliberate
 * tie-break. Do NOT "improve" this into a per-vertical join: that join has no
 * job-side column to hang off and cannot exist.
 *
 * Ordering is always explicit — never a bare LIMIT 1. An unordered pick returns
 * a different person on different days, which is indistinguishable from the
 * owner-instead-of-head bug this replaced. Where `inserted_on` is missing we
 * fall back to the mapping's own PK `id` (the same column the job_client_owner
 * SPOC lookup in create() orders by), DESC because "latest" is the rule.
 *
 * LEFT JOIN, not JOIN: if the chosen head has no tbl_user row we want the
 * LATEST head's (null) id, not silently the next-latest head's real one.
 *
 * The status filter mirrors the job_client_owner SPOC lookup in create() on the
 * same table: NULL tolerated (older mappings predate the column), 1 = active.
 *
 * Whole body is fail-soft: a job create must NEVER fail because this snapshot
 * could not be resolved. On any error the column is left NULL — no owner is
 * better than a wrong one, because a wrong one looks right.
 */
/*
 * Snapshot the job's Local/Travel classification into tbl_job_tat_locality.
 *
 * Deliberately NOT awaited and deliberately outside the job transaction — see
 * the call site. Swallows every error: the table is a new EasyFix-owned one and
 * an environment where the migration has not run must still be able to create
 * jobs.
 */
function stampJobLocality(jobId, pinCode) {
  if (!jobId) return;
  (async () => {
    try {
      const coverage = require('./pincode-coverage.service');
      const covered = await coverage.getCoveredPincodes([pinCode]);
      const isLocal = pinCode && covered.has(String(pinCode).trim()) ? 1 : 0;
      await pool.query(
        `INSERT INTO tbl_job_tat_locality (job_id, is_local, pincode, snapshot_source, resolved_on)
         VALUES (?, ?, ?, 'booking', ?)
         ON DUPLICATE KEY UPDATE job_id = job_id`,
        [jobId, isLocal, pinCode || null, new Date()],
      );
    } catch (e) {
      logger.warn('Job locality snapshot skipped · jobId=' + jobId + ' · ' + e.message);
    }
  })();
}

/*
 * The client's Primary SPOC (tbl_vertical_mapping.user_type = 1), as a
 * tbl_user.user_id, or null when none resolves.
 *
 * ONE definition, because THREE columns are stamped from it: job_primary_spoc,
 * job_client_owner, and job_owner on a booking with no acting operator. There
 * were two copies of this lookup and they disagreed in two ways — the create
 * path ordered by `id ASC` (the OLDEST mapping) and read vm.user_id directly,
 * while the stamp ordered newest-first THROUGH a LEFT JOIN.
 *
 * Latent rather than live: no client currently has more than one user_type = 1
 * mapping (checked across all 204 that have any, 0 disagreements). But the day
 * a client's SPOC is reassigned, the same job would carry the OLD owner in one
 * column and the NEW one in another — and nothing would report an error.
 *
 * u.user_id, NOT vm.user_id: the same number when the mapping points at a live
 * user, different in exactly the case that matters — a mapping whose user was
 * deleted yields NULL, so we stamp no owner rather than one that resolves to
 * nobody. A dangling owner is worse than no owner.
 */
async function resolveClientPrimarySpoc(clientId, conn) {
  if (!clientId) return null;
  const db = conn || pool;
  const orderBy = (await hasVerticalMappingInsertedOnColumn())
    ? 'vm.inserted_on DESC, vm.id DESC'
    : 'vm.id DESC';
  const [[head]] = await db.query(
    `SELECT u.user_id
       FROM tbl_vertical_mapping vm
       LEFT JOIN tbl_user u ON u.user_id = vm.user_id
      WHERE vm.client_id = ? AND vm.user_type = 1
        AND (vm.status IS NULL OR vm.status = 1)
      ORDER BY ${orderBy}
      LIMIT 1`,
    [clientId],
  );
  return head?.user_id ?? null;
}

async function stampJobPrimarySpoc(jobId, clientId, conn) {
  if (!jobId || !(await hasJobPrimarySpocColumn())) return;
  const db = conn || pool;
  try {
    const headUserId = await resolveClientPrimarySpoc(clientId, db);
    await db.query('UPDATE tbl_job SET job_primary_spoc = ? WHERE job_id = ?', [headUserId, jobId]);
  } catch (e) {
    logger.warn(
      { jobId, clientId, err: e.message },
      'job_primary_spoc stamp failed — leaving the snapshot untouched',
    );
  }
}

/*
 * `linked_job` is a LEGACY table (columns: parent_job_id, child_job_id) written
 * by the old Java CRM to relate multi-category sibling jobs. The new stack links
 * siblings by shared client_ref_id + job_reference_id, but we also mirror the
 * legacy row so any tooling/report that reads `linked_job` keeps working. The
 * table is absent on some deploys (e.g. QA), so probe once + no-op where missing.
 */
let _hasLinkedJobTable = null;
async function hasLinkedJobTable() {
  if (_hasLinkedJobTable !== null) return _hasLinkedJobTable;
  try {
    const [rows] = await pool.query("SHOW TABLES LIKE 'linked_job'");
    _hasLinkedJobTable = rows.length > 0;
  } catch (_e) {
    // A failure is NOT cached. This asks the SCHEMA, so absence is zero rows and
    // any error is a genuine fault — freezing it would disable this until restart.
    logger.warn('schema probe failed · linked_job table · ' + _e.message
      + ' — treating as absent for this call only');
    return false;
  }
  return _hasLinkedJobTable;
}
/*
 * Record a parent→child family link in `linked_job`. Best-effort + idempotent:
 * no-ops where the table is absent, skips a duplicate (parent,child) pair on a
 * retry, and NEVER throws — a linking failure must not affect the already-
 * committed job. Mirrors legacy JobDaoImpl's
 * `INSERT INTO linked_job(parent_job_id, child_job_id)`.
 */
async function linkJobToParent(parentJobId, childJobId) {
  try {
    if (!parentJobId || !childJobId || parentJobId === childJobId) return;
    if (!(await hasLinkedJobTable())) return;
    const [[existing]] = await pool.query(
      'SELECT 1 AS ok FROM linked_job WHERE parent_job_id = ? AND child_job_id = ? LIMIT 1',
      [parentJobId, childJobId],
    );
    if (existing) return;
    await pool.query(
      'INSERT INTO linked_job (parent_job_id, child_job_id) VALUES (?, ?)',
      [parentJobId, childJobId],
    );
    logger.info('Linked sibling job · parent=' + parentJobId + ' child=' + childJobId);
  } catch (e) {
    logger.warn('linked_job insert skipped for child ' + childJobId + ': ' + e.message);
  }
}

/*
 * Probe ONCE per process for the presence of `tbl_job_customer_request`.
 * That table only exists on deploys where migration
 * `2026-06-02-job-customer-requests.sql` has run. The LIST projection
 * surfaces the latest PENDING cancel/reschedule request per job via two
 * correlated subqueries; if those reference a non-existent table EVERY
 * unconfirmed-list query 500s. So we probe, memoise, and build the two
 * projection columns conditionally (NULL aliases when the table is absent),
 * making the feature a transparent no-op on un-migrated deploys.
 * Mirrors the hasOtpColumn / hasClientVerticalIdColumn probes above.
 */
let _hasCustomerRequestTable = null;
async function customerRequestTableExists() {
  if (_hasCustomerRequestTable !== null) return _hasCustomerRequestTable;
  try {
    await pool.query('SELECT 1 FROM tbl_job_customer_request LIMIT 1');
    _hasCustomerRequestTable = true;
  } catch (e){
    /*
     * This probes by TRYING THE QUERY, so "it is not there" arrives as an
     * error — ER_NO_SUCH_TABLE / ER_BAD_FIELD_ERROR IS the answer, and caching
     * it is right: the alternative re-probes on every hot-path call forever.
     *
     * Any OTHER error is not an answer. A connection blip or a lock timeout
     * returns false for THIS call without being written into the memo, so the
     * next call asks again instead of the feature staying off until restart.
     */
    if (isAbsentAnswer(e)) {
      _hasCustomerRequestTable = false;
      return _hasCustomerRequestTable;
    }
    logger.warn('schema probe failed · _hasCustomerRequestTable · ' + e.message
      + ' — treating as absent for this call only');
    return false;
  }
  return _hasCustomerRequestTable;
}

/*
 * Mark a job's PENDING customer requests as 'actioned' — called when Ops takes a
 * deliberate action on the job (confirm/cancel/enquiry via setStatus, assign,
 * offer, reschedule). Scenario: a customer submits a cancel request, then phones
 * in to schedule instead; Ops confirms via Confirm & Schedule. Without this the
 * 'pending' cancel row lingers and every surface keeps flagging "1 pending
 * customer request" — even though Ops already handled it, per the customer's own
 * new instruction.
 *
 * 'actioned' is the existing terminal status the manual "Mark Actioned" button
 * writes (domain: pending | actioned | dismissed) — no schema change, no new
 * status. Every count/chip filters `request_status = 'pending'`, so this clears
 * them all; the yellow tbl_job_comment history is a SEPARATE table and is
 * untouched, so the audit trail stays.
 *
 * Keyed by job_id (not request_id) so one call clears every pending ask. Best-
 * effort + existence-gated: a failure here must never fail the Ops action, and
 * it's a no-op on un-migrated deploys. Deliberately NOT called from update() — a
 * plain field edit / draft-save is not "handling the request"; only a real
 * confirm/assign/offer/reschedule is.
 */
async function resolveCustomerRequests(jobId, runner = pool) {
  if (!(await customerRequestTableExists())) return;
  try {
    await runner.query(
      `UPDATE tbl_job_customer_request
          SET request_status = 'actioned'
        WHERE job_id = ? AND request_status = 'pending'`,
      [jobId],
    );
  } catch (e) {
    logger.warn('resolveCustomerRequests failed (non-fatal) · id=' + jobId + ' · ' + (e && e.message));
  }
}

// Same memoised existence probe for tbl_job_media — new EasyFix-owned table
// (videos shared via the conversational WhatsApp flow, see
// migrations/2026-06-03-whatsapp-conversation.sql). On deploys without that
// migration applied, getById() returns videos:[] silently so the CRM Confirm
// view doesn't 500.
let _hasJobMediaTable = null;
async function jobMediaTableExists() {
  if (_hasJobMediaTable !== null) return _hasJobMediaTable;
  try {
    await pool.query('SELECT 1 FROM tbl_job_media LIMIT 1');
    _hasJobMediaTable = true;
  } catch (e){
    /*
     * This probes by TRYING THE QUERY, so "it is not there" arrives as an
     * error — ER_NO_SUCH_TABLE / ER_BAD_FIELD_ERROR IS the answer, and caching
     * it is right: the alternative re-probes on every hot-path call forever.
     *
     * Any OTHER error is not an answer. A connection blip or a lock timeout
     * returns false for THIS call without being written into the memo, so the
     * next call asks again instead of the feature staying off until restart.
     */
    if (isAbsentAnswer(e)) {
      _hasJobMediaTable = false;
      return _hasJobMediaTable;
    }
    logger.warn('schema probe failed · _hasJobMediaTable · ' + e.message
      + ' — treating as absent for this call only');
    return false;
  }
  return _hasJobMediaTable;
}

// Same memoised existence probe for tbl_job_offer — new EasyFix-owned table
// (migrations/2026-06-27-create-tbl-job-offer.sql) backing THE OFFER MODEL.
// On deploys without that migration applied, the LIST projection emits NULL
// is_offered / offered_efr_name aliases and assign() falls back to the legacy
// bump-to-SCHEDULED behaviour — so the offer flow is a transparent no-op.
let _hasJobOfferTable = null;
async function jobOfferTableExists() {
  if (_hasJobOfferTable !== null) return _hasJobOfferTable;
  try {
    await pool.query('SELECT 1 FROM tbl_job_offer LIMIT 1');
    _hasJobOfferTable = true;
  } catch (e){
    /*
     * This probes by TRYING THE QUERY, so "it is not there" arrives as an
     * error — ER_NO_SUCH_TABLE / ER_BAD_FIELD_ERROR IS the answer, and caching
     * it is right: the alternative re-probes on every hot-path call forever.
     *
     * Any OTHER error is not an answer. A connection blip or a lock timeout
     * returns false for THIS call without being written into the memo, so the
     * next call asks again instead of the feature staying off until restart.
     */
    if (isAbsentAnswer(e)) {
      _hasJobOfferTable = false;
      return _hasJobOfferTable;
    }
    logger.warn('schema probe failed · _hasJobOfferTable · ' + e.message
      + ' — treating as absent for this call only');
    return false;
  }
  return _hasJobOfferTable;
}

// Memoised COLUMN-existence probe for the WhatsApp delivery-status columns
// (migrations/2026-07-14-magic-link-delivery-status.sql). Selecting a missing
// column parse-errors and 500s the WHOLE jobs list, so — like the table probes
// above — we probe once and emit NULL aliases when the columns are absent,
// keeping the LIST projection a transparent no-op on un-migrated deploys.
let _hasMagicLinkDeliveryCols = null;
async function magicLinkDeliveryColsExist() {
  if (_hasMagicLinkDeliveryCols !== null) return _hasMagicLinkDeliveryCols;
  try {
    await pool.query('SELECT magic_link_delivery_status FROM tbl_job LIMIT 1');
    _hasMagicLinkDeliveryCols = true;
  } catch (e){
    /*
     * This probes by TRYING THE QUERY, so "it is not there" arrives as an
     * error — ER_NO_SUCH_TABLE / ER_BAD_FIELD_ERROR IS the answer, and caching
     * it is right: the alternative re-probes on every hot-path call forever.
     *
     * Any OTHER error is not an answer. A connection blip or a lock timeout
     * returns false for THIS call without being written into the memo, so the
     * next call asks again instead of the feature staying off until restart.
     */
    if (isAbsentAnswer(e)) {
      _hasMagicLinkDeliveryCols = false;
      return _hasMagicLinkDeliveryCols;
    }
    logger.warn('schema probe failed · _hasMagicLinkDeliveryCols · ' + e.message
      + ' — treating as absent for this call only');
    return false;
  }
  return _hasMagicLinkDeliveryCols;
}

/*
 * Builds the pending-customer-request projection columns for the LIST
 * query. When the table exists, emits correlated subqueries selecting the
 * latest PENDING request's type, reason + preferred (requested) datetime;
 * otherwise emits NULL aliases so the column shape stays identical.
 * Parameterised SQL — the literal 'pending' is the only constant and it is
 * bound as a parameter list the caller appends, but since it's a fixed
 * string we inline it safely (no user input). Returns a leading-comma
 * fragment ready to append after client_opted_in.
 *
 * `pending_request_preferred_datetime` is what the customer asked to move
 * the appointment TO (job-completion.js reschedule-request stores it in
 * tbl_job_customer_request.preferred_datetime; NULL when the customer did
 * not pick a specific date). It is intentionally distinct from
 * j.requested_date_time (the current/live appointment) — a reschedule
 * REQUEST does not move the live appointment until Ops actions it, so the
 * UI must surface the requested date separately or the row looks stale.
 * All three subqueries share the same ORDER BY created_at DESC LIMIT 1, so
 * they resolve to the same latest-pending row.
 */
function pendingRequestColumns(tableExists) {
  if (!tableExists) {
    return `,
  NULL AS pending_request_type,
  NULL AS pending_request_reason,
  NULL AS pending_request_preferred_datetime`;
  }
  return `,
  (SELECT cr.request_type FROM tbl_job_customer_request cr
    WHERE cr.job_id = j.job_id AND cr.request_status = 'pending'
    ORDER BY cr.created_at DESC LIMIT 1) AS pending_request_type,
  (SELECT cr.reason FROM tbl_job_customer_request cr
    WHERE cr.job_id = j.job_id AND cr.request_status = 'pending'
    ORDER BY cr.created_at DESC LIMIT 1) AS pending_request_reason,
  (SELECT cr.preferred_datetime FROM tbl_job_customer_request cr
    WHERE cr.job_id = j.job_id AND cr.request_status = 'pending'
    ORDER BY cr.created_at DESC LIMIT 1) AS pending_request_preferred_datetime`;
}

// Builds the two WhatsApp delivery-state projection columns. NULL aliases when
// the columns are absent (pre-migration) so the row shape is identical. LEADING-
// COMMA fragment, appended after offerColumns().
function magicLinkDeliveryColumns(colsExist) {
  if (!colsExist) {
    return `, NULL AS magic_link_delivery_status, NULL AS magic_link_delivery_reason`;
  }
  return `, j.magic_link_delivery_status, j.magic_link_delivery_reason`;
}

/*
 * ═══════════ THE OFFER SUB-STATE — ONE canonical definition ═══════════
 *
 * Three surfaces answer "does this job have an open offer?" — the LIST row chip
 * (offerColumns below), the `offerState` LIST filter (offerStateClause below)
 * and the Schedule & Assign modal (listOffers). They used to answer it three
 * different ways and contradicted each other in production: job #521866 showed
 * an orange "Offered to Tx" chip on Pending-for-Scheduling while the modal
 * showed that job's single offeree badged EXPIRED, "offered 2 hr ago".
 *
 * ── ROOT CAUSE: expiry is a BATCH JOB, not a property of time ──
 * An offer is advertised (and enforced by acceptOffer) as living for
 * OFFER_TTL_MINUTES. The ROW, however, only flips to offer_status = EXPIRED
 * when expireStaleOffers() sweeps it — the every-2-min scheduler cron, or
 * listOffers()'s lazy per-job sweep. On #521866 the sweep landed ~2 hours after
 * the offer was made (offered_at 15:39:39, responded_at 17:41:24, TTL 30 min),
 * so for ~90 minutes the row sat at offer_status = 0 while being, by the
 * product's own rule, already dead. The list faithfully reported
 * EXISTS(offer_status = 0) → "Offered to Tx"; the modal was truthful only
 * because it sweeps before it reads. Neither query was wrong — the DATA was
 * stale, and any definition of "open" that reads offer_status alone inherits
 * that staleness.
 *
 * ── THE RULE: open-ness is a function of TIME — WHEN EXPIRY IS ON ──
 * The rule is CONDITIONAL on `job.offer_expiry.enabled` (offerExpiryEnabled()),
 * because that property decides whether offers expire at all:
 *
 *   expiry ON (the default, and the normal configuration)
 *     An offer is EFFECTIVELY OPEN only while a technician could still actually
 *     accept it — exactly acceptOffer()'s race-safe claim gate:
 *         offer_status = OFFERED  AND  offered_at >= NOW() - INTERVAL <TTL> MINUTE
 *     Same comparison, same OFFER_TTL_MINUTES constant, so the chip can never
 *     promise an offer the accept path would refuse, and it stays correct no
 *     matter how far behind the expiry sweep is. EFFECTIVELY DEAD is the exact
 *     complement — EXPIRED, or still OFFERED but past the TTL (expireStaleOffers
 *     sweeps with `offered_at < NOW() - INTERVAL ? MINUTE`) — so a row can never
 *     be neither.
 *
 *   expiry OFF (`job.offer_expiry.enabled` = 'false')
 *     The business has said offers must NOT expire; they are meant to stay open
 *     indefinitely and nothing (cron or lazy sweep) may retire them. Rendering a
 *     30-minute-old offer as "Expired" would then misreport the system's actual
 *     behaviour — the offer really IS still live. So the time component is
 *     dropped entirely: OPEN is simply offer_status = OFFERED, and DEAD is
 *     simply offer_status = EXPIRED (rows an earlier, enabled regime already
 *     swept). Still exact complements.
 *
 * The property is resolved ONCE per request (list() reads it and hands the same
 * boolean to both the projection and the filter), then baked into a constant SQL
 * fragment. NEVER a per-row subquery against easyfix_properties.
 *
 * ── THE SUB-STATES (mutually exclusive; they partition the bucket) ──
 *   'offered'  ≥1 effectively-open offer                      → "Offered to Tx"
 *   'expired'  no open, none accepted, ≥1 effectively-dead     → "Expired/Rejected"
 *   'pending'  no open, none accepted, none dead               → "Pending to Scheduling"
 *
 * DEAD includes REJECTED as well as EXPIRED (2026-08-03, owner's rule). So
 * 'pending' now means literally "no offer has ever been made", and a job whose
 * offers were all declined reads as Expired/Rejected. The previous rule sent
 * rejected-only jobs to 'pending' on the theory that a decline returns the job
 * to the pool — but that made "nobody has been asked yet" and "everyone we asked
 * said no" render identically, hiding the second. A job whose only offer rows
 * are UNRESOLVABLE (see the technician guard below) still falls to 'pending':
 * nobody is holding it and nothing was really offered.
 *
 * ⚠ "all expired" is NOT "none open". Open-ness is an EXISTS over rows, never
 * MAX(offer_status) and never a count comparison: a job holding 3 dead offers
 * and 1 effectively-open one is 'offered', full stop.
 *
 * ACCEPTED is carved out rather than folded into 'expired': accepting sets
 * fk_easyfixter_id, which evicts the job from the Pending-for-Scheduling
 * bucket, so it should be unreachable here. If one ever is, it drops out of all
 * three filters (and projects offer_state = 'none') instead of being
 * mislabelled a dead offer.
 *
 * ── Two defensive guards, both matching what the MODAL shows ──
 *  1. LATEST ROW PER TECHNICIAN. listOffers() collapses to MAX(job_offer_id)
 *     per tech, so the list must too or the two can disagree. The re-offer path
 *     tries to UPDATE in place and collapse strays, but that "one row per (job,
 *     tech)" invariant is NOT enforced by any constraint and is NOT guaranteed
 *     in production — do not re-simplify these subqueries on the assumption
 *     that it holds.
 *  2. TECHNICIAN RESOLVABLE. listOffers() INNER JOINs tbl_easyfixer, so a row
 *     with a NULL or dangling fk_easyfixter_id is invisible there; without this
 *     guard the list would count it and diverge. (tbl_job_offer has a recorded
 *     NULL-fk trap — candidate ranking needed the same explicit guard.)
 *
 * ── Shape rules ──
 * CORRELATED SUBQUERIES, never a JOIN onto the outer list: a job accrues many
 * offer rows, and a JOIN would fan out the LIST rows and inflate the paginated
 * COUNT (a recorded 500 in this codebase). The fragments reference only the `j`
 * alias plus their own locals, so the COUNT query's alias detection
 * (needsCu/needsAd/…) is untouched and COUNT + data keep identical WHERE/params.
 */

/*
 * Guard for the values we INLINE into SQL. The offerState FILTER binds its
 * constants as `?` params, but offerColumns() is a PROJECTION fragment that
 * list() appends with NO params at all, so there the same constants must be
 * rendered literally. Both renderings come out of the builders below, so they
 * cannot drift; this just makes the inlined branch structurally incapable of
 * emitting anything but a plain integer.
 */
function offerSqlInt(n) {
  const v = Number(n);
  if (!Number.isInteger(v)) throw new Error('offer-state SQL expects an integer, got ' + n);
  return String(v);
}

/*
 * Row scope shared by EVERY fragment: correlate to the outer job, require a
 * resolvable technician, and keep only that technician's LATEST row. See guards
 * 1 + 2 in the docblock above. `a` is the outer offer alias; its two children
 * are `<a>e` (the technician probe) and `<a>m` (the latest-row probe), so
 * callers only ever have to keep `a` unique.
 */
function offerRowScope(a) {
  return `${a}.job_id = j.job_id`
       + ` AND ${a}.fk_easyfixter_id IS NOT NULL`
       + ` AND EXISTS (SELECT 1 FROM tbl_easyfixer ${a}e WHERE ${a}e.efr_id = ${a}.fk_easyfixter_id)`
       + ` AND ${a}.job_offer_id = (SELECT MAX(${a}m.job_offer_id) FROM tbl_job_offer ${a}m`
       + ` WHERE ${a}m.job_id = ${a}.job_id AND ${a}m.fk_easyfixter_id = ${a}.fk_easyfixter_id)`;
}

/*
 * The status/freshness predicate for one offer KIND:
 *   'live'      effectively open — acceptOffer()'s exact freshness gate
 *   'dead'      already-swept EXPIRED, plus (when expiry is ON) still-OFFERED
 *               but past the TTL. The exact complement of 'live' within
 *               offer_status = OFFERED, NULL offered_at included.
 *   'accepted'  the documented anomaly carve-out
 *   'any'       no status predicate — "this technician has offer history"
 *
 * `expiry` is offerExpiryEnabled() for this request: false drops the time
 * component entirely (see the docblock — offers that the business says never
 * expire must not be rendered as expired). `bind` chooses `?` placeholders
 * (WHERE fragments) vs inlined integers (projection fragments, which carry no
 * params). Params come out in placeholder order.
 */
function offerKindPredicate(kind, a, bind, expiry) {
  const params = [];
  const v = (n) => { if (!bind) return offerSqlInt(n); params.push(n); return '?'; };
  switch (kind) {
    case 'live':
      // expiry OFF ⇒ no TTL term at all: an OFFERED row is open, full stop.
      return {
        sql: `${a}.offer_status = ${v(OFFER_STATUS.OFFERED)}`
           + (expiry ? ` AND ${a}.offered_at >= NOW() - INTERVAL ${v(OFFER_TTL_MINUTES)} MINUTE` : ''),
        params,
      };
    case 'dead':
      /*
       * DEAD = the offer is spent. REJECTED counts, alongside EXPIRED.
       *
       * ⚠ This changed on 2026-08-03 and reverses the earlier rule. It used to
       * be EXPIRED only, so a job whose offers were all REJECTED fell through to
       * 'pending' and its chip read "Pending to Scheduling" — on the theory that
       * a declined offer puts the job back in the pool. The owner's rule is the
       * opposite and is what ops actually triage on:
       *   no offer rows at all            -> Pending to Scheduling
       *   offers exist, none still open   -> Expired/Rejected
       *   at least one open offer         -> Offered to Tx
       * "Nobody has been asked yet" and "everyone we asked said no" are
       * different problems, and collapsing them hid the second one.
       *
       * 'pending' is the exact complement of this predicate (see offerStateSql),
       * so adding REJECTED here moves rejected-only jobs out of pending
       * automatically — the two states cannot drift apart.
       */
      // expiry OFF ⇒ only rows an earlier ENABLED regime already swept are dead
      // (plus rejections, which are a technician's answer, not a timer).
      if (!expiry) {
        return {
          sql: `${a}.offer_status IN (${v(OFFER_STATUS.EXPIRED)}, ${v(OFFER_STATUS.REJECTED)})`,
          params,
        };
      }
      return {
        sql: `(${a}.offer_status IN (${v(OFFER_STATUS.EXPIRED)}, ${v(OFFER_STATUS.REJECTED)})`
           + ` OR (${a}.offer_status = ${v(OFFER_STATUS.OFFERED)}`
           + ` AND (${a}.offered_at IS NULL`
           + ` OR ${a}.offered_at < NOW() - INTERVAL ${v(OFFER_TTL_MINUTES)} MINUTE)))`,
        params,
      };
    case 'accepted':
      return { sql: `${a}.offer_status = ${v(OFFER_STATUS.ACCEPTED)}`, params };
    case 'any':
      return { sql: '', params };
    default:
      throw new Error('unknown offer kind: ' + kind);
  }
}

// scope + kind predicate — the WHERE body of every offer subquery. Exposed on
// its own because the COUNT projections need the body without the EXISTS wrap.
function offerRowWhere(kind, a, bind, expiry) {
  const k = offerKindPredicate(kind, a, bind, expiry);
  return { sql: offerRowScope(a) + (k.sql ? ` AND ${k.sql}` : ''), params: k.params };
}

function offerRowExists(kind, a, { bind = true, negate = false, expiry = true } = {}) {
  const w = offerRowWhere(kind, a, bind, expiry);
  return {
    sql: `${negate ? 'NOT ' : ''}EXISTS (SELECT 1 FROM tbl_job_offer ${a} WHERE ${w.sql})`,
    params: w.params,
  };
}

/*
 * THE sub-state predicate. `offerStateClause` (the WHERE filter) and
 * offerColumns' `offer_state` CASE are both built from this, so the filter and
 * the chip are the same boolean algebra by construction, not by hand-sync:
 *   offered = live
 *   expired = ¬live ∧ ¬accepted ∧ dead
 *   pending = ¬live ∧ ¬accepted ∧ ¬dead
 * Returns { sql, params }, or null for an unknown state.
 */
function offerStateSql(state, { bind = true, alias = 'jos', expiry = true } = {}) {
  const [a1, a2, a3] = [alias, alias + '2', alias + '3'];
  const o = { bind, expiry };
  const all = (...parts) => ({
    sql: `(${parts.map((p) => p.sql).join(' AND ')})`,
    params: parts.flatMap((p) => p.params),
  });
  switch (state) {
    case 'offered':
      return all(offerRowExists('live', a1, o));
    case 'expired':
      return all(
        offerRowExists('live', a1, { ...o, negate: true }),
        offerRowExists('accepted', a2, { ...o, negate: true }),
        offerRowExists('dead', a3, o),
      );
    case 'pending':
      return all(
        offerRowExists('live', a1, { ...o, negate: true }),
        offerRowExists('accepted', a2, { ...o, negate: true }),
        offerRowExists('dead', a3, { ...o, negate: true }),
      );
    default:
      return null;
  }
}

/*
 * `expiryEnabled` is passed in by list() so ONE property read serves both the
 * projection and the filter in a request (they must describe the same regime or
 * the chip and the filter disagree again). Defaulted for standalone callers.
 */
function offerColumns(tableExists, expiryEnabled = offerExpiryEnabled()) {
  if (!tableExists) {
    // The NULL aliases MUST mirror the real branch column-for-column so the row
    // shape is identical on un-migrated deploys.
    return `, NULL AS is_offered, NULL AS offered_efr_name, NULL AS offered_count`
         + `, NULL AS total_offer_count, NULL AS expired_offer_count, NULL AS offer_state`;
  }
  /*
   * `offer_state` is THE authoritative sub-state — the same boolean algebra the
   * offerState FILTER uses (offerStateSql), rendered with inlined constants
   * because a projection fragment carries no params. The FE renders this string
   * directly instead of re-deriving the rule from counts; that second
   * implementation is what let the chip and the filter disagree (a rejected-only
   * job listed under the Expired filter but rendered a different chip).
   *
   * The CASE ladder is exclusive top-down, which makes it identical to the three
   * filter fragments:
   *   live                      → 'offered'
   *   ¬live ∧ accepted          → 'none'      (documented anomaly; no filter matches it)
   *   ¬live ∧ ¬accepted ∧ dead  → 'expired'
   *   otherwise                 → 'pending'
   *
   * The counts stay for the FE tooltips only — offered_count feeds "Offered to N
   * technicians", expired/total feed the Expired tooltip. They now use the SAME
   * effectively-open / effectively-dead / latest-resolvable-row semantics, so a
   * count can never contradict the state beside it. total_offer_count is one per
   * TECHNICIAN with offer history (latest row per tech), which is exactly what
   * the Schedule & Assign modal lists.
   *
   * offered_efr_name — most recent effectively-open offeree, for the
   * single-offer common case. The tbl_easyfixer JOIN lives INSIDE this scalar
   * subquery, so it cannot fan out the LIST.
   */
  const e        = { bind: false, expiry: expiryEnabled };
  const live     = (a) => offerRowExists('live', a, e).sql;
  const accepted = (a) => offerRowExists('accepted', a, e).sql;
  const dead     = (a) => offerRowExists('dead', a, e).sql;
  const where    = (kind, a) => offerRowWhere(kind, a, false, expiryEnabled).sql;
  return `, (${live('jo')}) AS is_offered`
       + `, (SELECT ef2.efr_name FROM tbl_job_offer jo2 JOIN tbl_easyfixer ef2 ON ef2.efr_id = jo2.fk_easyfixter_id`
       + `    WHERE ${where('live', 'jo2')}`
       + `    ORDER BY jo2.job_offer_id DESC LIMIT 1) AS offered_efr_name`
       + `, (SELECT COUNT(*) FROM tbl_job_offer jo3 WHERE ${where('live', 'jo3')}) AS offered_count`
       + `, (SELECT COUNT(*) FROM tbl_job_offer jo4 WHERE ${where('any', 'jo4')}) AS total_offer_count`
       + `, (SELECT COUNT(*) FROM tbl_job_offer jo5 WHERE ${where('dead', 'jo5')}) AS expired_offer_count`
       + `, (CASE WHEN ${live('jo6')} THEN 'offered'`
       + `        WHEN ${accepted('jo7')} THEN 'none'`
       + `        WHEN ${dead('jo8')} THEN 'expired'`
       + `        ELSE 'pending' END) AS offer_state`;
}

/*
 * ── `offerState` — the Pending-for-Scheduling SUB-STATE filter (2026-07-31) ──
 *
 * The CRM's "Pending for Scheduling" tab is a BUCKET, not a status tab:
 *   job_status = 0 (BOOKED)  AND  fk_easyfixter_id IS NULL
 * (the list endpoint receives it as status=0 + assigned=false). EVERY job in it
 * therefore has job_status = 0 by definition, which makes a job-status filter on
 * that tab meaningless — the axis operators actually triage on is where the job
 * sits in the OFFER lifecycle *within* the bucket:
 *
 *   'pending'  Pending to Scheduling  — nobody is holding it (never offered,
 *                                       only rejected, or only unresolvable rows)
 *   'offered'  Offered to Tx          — ≥1 EFFECTIVELY OPEN offer (within TTL)
 *   'expired'  Expired / No Response  — none open, none accepted, ≥1 dead offer
 *
 * The filter is nothing but `offerStateSql(state)` — the SAME predicate the
 * `offer_state` projection column is built from, so the chip a row renders and
 * the filter that would return that row can no longer disagree. All semantics,
 * the TTL-derived definition of "open", the latest-row-per-technician and
 * technician-resolvable guards, and the correlated-subquery shape rule live in
 * the canonical docblock above offerColumns — read that, not this.
 *
 * Returns { sql, params } or null for "no filter" (absent / '' / unknown value).
 * Exported so validators/job.validator.js derives its valid() list from
 * OFFER_STATE_VALUES — one source of truth, and the FE/BE literal can't drift.
 */
const OFFER_STATE_VALUES = Object.freeze(['pending', 'offered', 'expired']);

function offerStateClause(offerState, expiryEnabled = offerExpiryEnabled()) {
  if (!OFFER_STATE_VALUES.includes(offerState)) return null;
  return offerStateSql(offerState, { bind: true, alias: 'jos', expiry: expiryEnabled });
}

// Kept for getById(), which does select these as part of the full detail payload.
const DETAIL_JOIN = LIST_JOIN + `
  LEFT JOIN tbl_user        cr ON cr.user_id     = j.fk_created_by
`;

// ─── List ───────────────────────────────────────────────────────────
// `scope` (optional) is the parsed RBAC scope from /auth/me:
//   { clients:{mode,ids}, cities:{mode,ids}, verticals:{mode,ids} }
// When supplied, the list is row-filtered to the caller's allowed
// clients + cities + verticals. mode='all' means no filter for that
// dimension; mode='none' returns zero rows; mode='allow' adds an
// IN(...) clause. See lib/scope.js. Admin/Finance bypass scope —
// the caller decides whether to pass it.
/*
 * `dateType` controls which column `startDate` / `endDate` are applied
 * to. Matches the legacy CRM's Date Type filter:
 *   booked    → j.created_date_time (default, backward-compat)
 *   scheduled → j.scheduled_date_time
 *   completed → j.checkout_date_time
 *   ticket    → j.ticket_created_date_time
 *   requested → j.requested_date_time
 *   cancelled → j.cancel_date_time
 * Unknown values silently fall back to `created_date_time` rather
 * than 400 — keeps URL bookmarks robust across vocab changes.
 */
const DATE_TYPE_COLUMN = {
  booked:    'j.created_date_time',
  scheduled: 'j.scheduled_date_time',
  completed: 'j.checkout_date_time',
  ticket:    'j.ticket_created_date_time',
  requested: 'j.requested_date_time',
  // When the technician actually STARTED the job. For a job in progress this is
  // the only date that means "now" — its appointment may be days either side,
  // and the mobile Home screen has to ask "what am I working on today", not
  // "what was booked for today". Written on every check-in and populated on
  // essentially every started job (6 unstamped rows in 260k).
  checkin:   'j.checkin_date_time',
  /*
   * THIS ONE ALSO FILTERS, not just re-aims the window.
   *
   * cancel_date_time is stamped only when a job moves to status 6 CANCELLED
   * (docs/claude-reference/SCHEMA.md — alongside cancel_reason_id /
   * cancel_comment / cancel_by; setStatus() is the single writer). It is NULL
   * for every job that was never cancelled, and `NULL >= DATE(?)` evaluates to
   * NULL, which WHERE treats as false. So a date range on dateType=cancelled
   * silently drops every non-cancelled job — the window is simultaneously a
   * `job_status = 6` filter.
   *
   * That is the INTENDED behaviour ("what did we cancel last week" wants
   * exactly that set), and it is the reason this is written down: every other
   * dateType above re-aims the window without changing which jobs are
   * eligible, so an operator combining dateType=cancelled with a status tab
   * gets an intersection, and combining it with the "All" tab gets cancelled
   * jobs only. Nothing here special-cases that; it falls out of NULL semantics.
   */
  cancelled: 'j.cancel_date_time',
};

/*
 * Normalise a filter param that may arrive as a single number, a single-id
 * string, a CSV string ("12,34") or an array into a clean number[]. Mirrors the
 * `statuses` CSV-split pattern above so the Pending-to-Start multi-select
 * filters (clientId / cityId / projectManagerId / zonalManagerId) can each build
 * an IN (?, ?, …) clause. Back-compatible: a lone id still yields a 1-element
 * array, so pre-existing single-select callers keep working unchanged.
 */
function toIdArray(v) {
  if (v == null || v === '') return [];
  const raw = Array.isArray(v) ? v : String(v).split(',');
  return raw.map((s) => Number(String(s).trim())).filter((n) => Number.isFinite(n));
}

async function list({
  q, status, statuses, assigned, clientId, cityId, ownerId, easyfixerId,
  /*
   * `readyForBilling` (2026-08-26) — the client portal's "In-Warranty Orders"
   * tab. Two predicates, always together: ready_for_billing = 'Yes' AND
   * sub_job_id IS NULL. They travel as ONE filter because the second is not a
   * refinement of the first — a sub-job inherits its parent's billing flag, so
   * without it every billable parent is counted twice.
   */
  readyForBilling,
  clientOwnerIds,            // number[] — restrict to jobs owned (job_client_owner) by these client users (reporting-manager scope)
  reportingContactIds,       // number[] — restrict to jobs booked by these SPOC contacts (tbl_job.reporting_contact_id) — client-app hierarchy scope
  customerId,
  jobIds,                    // number[] — restrict to an explicit set of job ids
  isEscalated,
  // New filter params (2026-05-19) — match the legacy CRM "Filter Job"
  // panel. See the validator + the FE filter card.
  customerQ,                 // text — separate from `q`, narrower scope
  clientRef,                 // text — LIKE on j.client_ref_id
  efrMobile,                 // text — LIKE on tbl_easyfixer.efr_no
  pin,                       // text — LIKE on tbl_address.pin_code
  stateId,                   // FK   — tbl_city.state_id
  categoryId,                // FK   — j.fk_service_catg_id
  sourceType,                // text — exact match on j.source_type (booking channel)
  verticalId,                // FK   — via EXISTS on tbl_vertical_mapping
  projectManagerId,          // FK   — tbl_vertical_mapping.user_id where user_type = 1
  zonalManagerId,            // FK   — tbl_city.state_user (the city's zonal owner)
  dateType,                  // enum — see DATE_TYPE_COLUMN above
  // Phase-2 filters (2026-05-19).
  rating,                    // 1..5 — tbl_easyfixer_rating_by_customer.customer_rating
  reopen,                    // bool — tbl_job.job_reopen_flag = 1
  dueTo,                     // enum — customer|client|easyfix|technician
  zonalId,                   // FK   — tbl_zone_master via tbl_zone_city_mapping
  // Dashboard AttentionSummary tile drill-downs (2026-05-22):
  quotationStatus,           // enum — 'approved' | 'rejected'
  requestedBefore,           // 'now' or ISO date — Running Late tile
  /*
   * `noServices` (2026-05-28) — Booked-No-Services tile drill-down.
   * When truthy, restricts the list to BOOKED rows that have zero
   * ACTIVE tbl_job_services entries. Mirrors the predicate used by
   * the attention-summary count + the LIST projection's service_count
   * subquery, so counts and rows agree by construction.
   */
  noServices,
  /*
   * `offerState` (2026-07-31) — Pending-for-Scheduling SUB-STATE filter:
   * 'pending' | 'offered' | 'expired'. NARROWS the caller's bucket, never
   * replaces it (the tab keeps sending status=0 + assigned=false). Absent /
   * '' / unknown = no filter. See offerStateClause() above for the semantics
   * and why it's EXISTS-based rather than a JOIN.
   */
  offerState,
  startDate, endDate,
  scope,
  allowedStages,             // Job Stage Access — { mode:'all'|'list', stages }
  sortBy, sortDir,           // server-side sort — whitelisted column + asc|desc
  /*
   * `countOnly` (2026-08-26) — return { rows: [], total } and skip the data
   * query. For a caller that wants a TAB COUNT rather than a page: the count
   * then comes from this function's own WHERE, so a badge and the list it sits
   * above cannot describe different populations. The client portal's Order
   * History had exactly that bug — a hand-written COUNT is a copy of the WHERE
   * that has to be kept in step by hand, and it was not.
   */
  countOnly = false,
  limit = 50, offset = 0,
} = {}) {
  logger.info('List jobs · status=' + (status ?? statuses ?? 'any') + ' · clientId=' + (clientId ?? '-') + ' · easyfixerId=' + (easyfixerId ?? '-') + ' · limit=' + limit + ' · offset=' + offset);
  const clauses = [];
  const params = [];

  // Probe ONCE per process for tbl_client.vertical_id presence.
  // See declaration above for the rationale.
  const hasVerticalCol = await hasClientVerticalIdColumn();

  // Probe ONCE per process for tbl_job_customer_request presence, then build
  // the LIST projection with the pending-request columns appended (NULL
  // aliases when the table is absent). Keeps the unconfirmed list from 500ing
  // on un-migrated deploys. See pendingRequestColumns() above.
  const hasCustomerRequestTable = await customerRequestTableExists();
  // Probe ONCE for tbl_job_offer presence too, appending the offer projection
  // (is_offered / offered_efr_name, or NULL aliases). See offerColumns() above.
  const hasJobOffer = await jobOfferTableExists();
  /*
   * Resolve `job.offer_expiry.enabled` ONCE for this request and hand the SAME
   * boolean to the offer PROJECTION and the offerState FILTER below. Reading it
   * twice would let a mid-request property-cache refresh render a row's chip
   * under one regime and filter it under the other — the exact chip/filter
   * divergence this whole definition exists to eliminate. Synchronous +
   * cache-backed, so this is a memory read, not a query.
   */
  const offerExpiry = offerExpiryEnabled();
  // Probe ONCE for the WhatsApp delivery-status columns, appending them (or NULL
  // aliases) so a SPOC/unconfirmed list never 500s pre-migration. See
  // magicLinkDeliveryColumns() above.
  const hasMagicLinkDeliveryCols = await magicLinkDeliveryColsExist();
  /*
   * '' / undefined / 'false' / '0' all mean "not filtering by escalation".
   * A URL carries booleans as text, so `isEscalated=false` arrives as the
   * STRING 'false', which is truthy — the one coercion worth spelling out.
   */
  const wantsEscalation = isEscalated !== undefined && isEscalated !== ''
    && isEscalated !== false && String(isEscalated) !== 'false' && String(isEscalated) !== '0';
  const listColumns =
    LIST_COLUMNS + pendingRequestColumns(hasCustomerRequestTable) + offerColumns(hasJobOffer, offerExpiry)
    + magicLinkDeliveryColumns(hasMagicLinkDeliveryCols)
    // Job Age (ageDays + ageSecs) — unconditional; every column it touches is a
    // long-standing tbl_job column, so there is nothing to existence-probe.
    + JOB_AGE_COLUMNS
    + escalationColumns(wantsEscalation);
  const listJoin = LIST_JOIN + escalationJoin(wantsEscalation);

  // Apply RBAC scope FIRST so any explicit clientId/cityId filter
  // narrows within the allowed set (caller can't widen scope by passing
  // a clientId outside their manage_clients).
  if (scope) {
    const c = scope.clients, ci = scope.cities, v = scope.verticals;
    if (c) {
      if (c.mode === 'none') { clauses.push('1=0'); }
      else if (c.mode === 'allow' && c.ids.length) {
        clauses.push(`j.fk_client_id IN (${c.ids.map(() => '?').join(',')})`);
        params.push(...c.ids);
      }
    }
    if (ci) {
      if (ci.mode === 'none') { clauses.push('1=0'); }
      else if (ci.mode === 'allow' && ci.ids.length) {
        clauses.push(`ad.city_id IN (${ci.ids.map(() => '?').join(',')})`);
        params.push(...ci.ids);
      }
    }
    if (v) {
      if (v.mode === 'none') { clauses.push('1=0'); }
      else if (v.mode === 'allow' && v.ids.length && hasVerticalCol) {
        // Vertical lives on tbl_client; LIST_JOIN already pulls
        // tbl_client cl, so cl.vertical_id is reachable. Only
        // applied when the column exists in this DB (see
        // hasClientVerticalIdColumn).
        clauses.push(`cl.vertical_id IN (${v.ids.map(() => '?').join(',')})`);
        params.push(...v.ids);
      }
    }
  }

  // Job Stage Access — restrict the visible rows to the union of statuses
  // across the caller's allowed stages, AND-combined (intersected) with any
  // tab/status filter below. mode 'all' (unrestricted / bypass) = no clause.
  // References only `j.` so it doesn't affect the COUNT-join detection. Empty
  // union (shouldn't happen for a 'list' with valid keys) → 1=0.
  if (allowedStages && allowedStages.mode === 'list') {
    const visible = [...stageVisibleStatuses(allowedStages.stages)];
    if (visible.length === 0) {
      clauses.push('1=0');
    } else {
      clauses.push(`j.job_status IN (${visible.map(() => '?').join(',')})`);
      params.push(...visible);
    }
  }

  // `statuses` (array/CSV) takes priority over single `status` — supports UI
  // tabs that bucket multiple codes (e.g. "Pending to Close" = 2 OR 20,
  // "Audit & Complete" = 3 OR 5). Single `status` still works for backward
  // compat with existing callers.
  if (statuses != null) {
    const arr = Array.isArray(statuses)
      ? statuses
      : String(statuses).split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
    if (arr.length) {
      clauses.push(`j.job_status IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    }
  } else if (status != null) {
    clauses.push('j.job_status = ?');
    params.push(status);
  }
  if (readyForBilling) {
    clauses.push("j.ready_for_billing = 'Yes'");
    clauses.push('j.sub_job_id IS NULL');
  }
  /*
   * `assigned` splits BOOKED (and any other status) by whether a technician
   * is currently on the job. Used by the dashboard's Pending-for-Scheduling
   * (assigned=false) vs Pending-App-Acknowledge (assigned=true) cards.
   * Accepts boolean true/false or string "true"/"false" from query params.
   */
  if (assigned !== undefined && assigned !== null && assigned !== '') {
    const wantAssigned = assigned === true || assigned === 'true' || assigned === 1 || assigned === '1';
    // Pool-offered jobs stay job_status=0 with fk_easyfixter_id NULL until a
    // tech ACCEPTS (which sets fk + bumps to SCHEDULED). So fk presence IS the
    // accepted/assigned signal: assigned=false (Pending for Scheduling) = fk
    // NULL = ALL status-0 jobs INCLUDING those currently offered (they carry
    // the "Offered to Tx" chip via the is_offered projection); assigned=true =
    // accepted. On accept the job leaves this bucket for Pending-to-Start (1).
    clauses.push(wantAssigned ? 'j.fk_easyfixter_id IS NOT NULL' : 'j.fk_easyfixter_id IS NULL');
  }
  /*
   * `offerState` — offer-lifecycle sub-state WITHIN whatever bucket the caller
   * already pinned. It is an ADDITIONAL AND-ed clause: it can only ever remove
   * rows, never re-open the status / assigned pins above (that inversion is
   * exactly the bug this filter replaced on the CRM side).
   *
   * Degrades to a no-op when tbl_job_offer is absent on this deploy — the same
   * memoised probe (`hasJobOffer`) that gates the offer PROJECTION gates the
   * filter, so an un-migrated environment returns the unfiltered bucket instead
   * of 500ing on an unknown table.
   */
  if (offerState && hasJobOffer) {
    const oc = offerStateClause(offerState, offerExpiry);
    if (oc) { clauses.push(oc.sql); params.push(...oc.params); }
  }
  /*
   * Booked-No-Services filter (2026-05-28). Forces both job_status = 0
   * (so callers don't need to set status separately) AND an anti-join
   * against tbl_job_services. The implicit status pin matches the
   * attention-summary counter's predicate exactly — a deep-link from
   * the tile must produce the same set the tile counted, not a superset.
   */
  if (noServices === true || noServices === 'true' || noServices === 1 || noServices === '1') {
    clauses.push('j.job_status = 0');
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM tbl_job_services js
       WHERE js.job_id = j.job_id AND js.job_service_status = 1
    )`);
  }
  // clientId — single id OR CSV/array (Pending-to-Start multi-select Clients
  // filter). Builds j.fk_client_id IN (...) — the `j` alias is always present,
  // so no COUNT-join change. Narrows within any RBAC clients scope applied above.
  const clientIdList = toIdArray(clientId);
  if (clientIdList.length) {
    clauses.push(`j.fk_client_id IN (${clientIdList.map(() => '?').join(',')})`);
    params.push(...clientIdList);
  }
  if (easyfixerId != null) { clauses.push('j.fk_easyfixter_id = ?'); params.push(easyfixerId); }
  if (ownerId != null)     { clauses.push('j.job_client_owner = ?');        params.push(ownerId); }
  if (Array.isArray(clientOwnerIds) && clientOwnerIds.length) {
    clauses.push(`j.job_client_owner IN (${clientOwnerIds.map(() => '?').join(',')})`);
    params.push(...clientOwnerIds);
  }
  // Client-app reporting hierarchy: restrict to jobs whose booking SPOC
  // (reporting_contact_id) is in the caller's subtree. Empty array → zero rows
  // (never silently widen to the whole client when the subtree is empty).
  if (Array.isArray(reportingContactIds)) {
    if (reportingContactIds.length === 0) { clauses.push('1=0'); }
    else {
      clauses.push(`j.reporting_contact_id IN (${reportingContactIds.map(() => '?').join(',')})`);
      params.push(...reportingContactIds);
    }
  }
  // cityId — single id OR CSV/array (Pending-to-Start multi-select Cities
  // filter). The `ad.` literal keeps needsAd tripped below so the COUNT query
  // still joins tbl_address (join parity — a WHERE referencing `ad.` without the
  // matching COUNT join is the known scoped-user-500 regression).
  const cityIdList = toIdArray(cityId);
  if (cityIdList.length) {
    clauses.push(`ad.city_id IN (${cityIdList.map(() => '?').join(',')})`);
    params.push(...cityIdList);
  }
  if (customerId != null)  { clauses.push('j.fk_customer_id = ?');   params.push(customerId); }
  // Explicit job-id set — used by listOfferedForTech() to reuse this LIST
  // projection for a tech's open-offer jobs. Empty array short-circuits to
  // zero rows so callers never accidentally fetch the whole table.
  if (Array.isArray(jobIds)) {
    if (jobIds.length === 0) { clauses.push('1=0'); }
    else {
      clauses.push(`j.job_id IN (${jobIds.map(() => '?').join(',')})`);
      params.push(...jobIds);
    }
  }
  if (categoryId != null)  { clauses.push('j.fk_service_catg_id = ?'); params.push(categoryId); }
  /*
   * sourceType — booking-channel filter (see the listQuery validator). Exact
   * `=` rather than LIKE: the stored values are a small closed set of labels,
   * so equality is both precise and index-friendly, and MySQL's default
   * case-insensitive collation already makes 'website' match any casing.
   *
   * References only the `j` alias, so the COUNT-join detection below is
   * unaffected — no extra join is needed for the COUNT query to stay
   * WHERE-consistent with the data query.
   */
  if (sourceType) { clauses.push('j.source_type = ?'); params.push(sourceType); }
  if (stateId != null)     { clauses.push('ci.state_id = ?');        params.push(stateId); }
  // Vertical filter — tbl_vertical_mapping is many-to-many across
  // (client_id, vertical_id, [user_id]). EXISTS is cheaper than a
  // JOIN because it short-circuits on first match per row and avoids
  // row multiplication when a client maps to multiple verticals.
  if (verticalId != null) {
    clauses.push('EXISTS (SELECT 1 FROM tbl_vertical_mapping vm WHERE vm.client_id = j.fk_client_id AND vm.vertical_id = ?)');
    params.push(verticalId);
  }
  // Project Manager — the PM is the user mapped to the job's client in
  // tbl_vertical_mapping with user_type = 1. EXISTS mirrors the verticalId
  // shape above; the subquery is self-contained (references only vm + the
  // outer j alias), so it introduces NO new outer alias and the COUNT-join
  // detection below is unaffected.
  const pmIdList = toIdArray(projectManagerId);
  if (pmIdList.length) {
    clauses.push(`EXISTS (SELECT 1 FROM tbl_vertical_mapping vm WHERE vm.client_id = j.fk_client_id AND vm.user_type = 1 AND vm.user_id IN (${pmIdList.map(() => '?').join(',')}))`);
    params.push(...pmIdList);
  }
  // Zonal Manager — a city's zonal owner is tbl_city.state_user. `ci` is the
  // tbl_city alias already joined in LIST_JOIN; the `ci.` literal here trips
  // the needsCi detection below so the COUNT query also joins tbl_address +
  // tbl_city, keeping main-query and COUNT-query WHERE join-consistent.
  const zmIdList = toIdArray(zonalManagerId);
  if (zmIdList.length) {
    clauses.push(`ci.state_user IN (${zmIdList.map(() => '?').join(',')})`);
    params.push(...zmIdList);
  }
  // Text LIKE filters — use the customary `%val%` wrap. Each adds its
  // referenced alias to the COUNT-join detection regex below via the
  // `ad.` / `ef.` / `cu.` literal in the SQL string.
  if (clientRef) {
    clauses.push('j.client_ref_id LIKE ?');
    params.push(`%${clientRef}%`);
  }
  if (efrMobile) {
    clauses.push('ef.efr_no LIKE ?');
    params.push(`%${efrMobile}%`);
  }
  if (pin) {
    clauses.push('ad.pin_code LIKE ?');
    params.push(`%${pin}%`);
  }
  if (customerQ) {
    /*
     * Matches the name the row DISPLAYS (job-row name, master as fallback), not
     * the master name alone — otherwise typing the name visible on screen would
     * return nothing for every job that overrides it. Still exactly TWO
     * placeholders / two bound params, and `cu.` remains textually present so
     * the COUNT-join sniffing below still adds the tbl_customer join.
     */
    clauses.push(`(${JOB_CUSTOMER_NAME_EXPR} LIKE ? OR cu.customer_mob_no LIKE ?)`);
    params.push(`%${customerQ}%`, `%${customerQ}%`);
  }
  // Reopen — direct column on tbl_job, super cheap. Accepts boolean or
  // its URLSearchParams string form (matches `assigned`/`isEscalated`).
  if (reopen !== undefined && reopen !== '' && reopen !== null) {
    const wantReopen = reopen === true || reopen === 'true' || reopen === '1' || reopen === 1;
    clauses.push(wantReopen ? 'j.job_reopen_flag = 1' : '(j.job_reopen_flag = 0 OR j.job_reopen_flag IS NULL)');
  }
  // Rating — EXISTS keeps row cardinality stable (a job can have
  // multiple rating rows over its lifetime; we want jobs that ever
  // received the given rating, not duplicated rows). Restricts to
  // tbl_easyfixer_rating_by_customer.customer_rating exact match.
  if (rating != null) {
    clauses.push('EXISTS (SELECT 1 FROM tbl_easyfixer_rating_by_customer ercf WHERE ercf.job_id = j.job_id AND ercf.customer_rating = ?)');
    params.push(Number(rating));
  }
  // Zonal — the zone lives on the EASYFIXER, not on the address.
  // `tbl_easyfixer.efr_zone_city_id` FKs to
  // `tbl_zone_city_mapping.city_zone_id` (the PK of the mapping row,
  // confusingly named), and that row's `zone_id` is the actual zone.
  //
  // Why the address mapping is wrong: `tbl_zone_city_mapping` carries
  // 57,750 rows where every city is mapped to every zone (legacy data
  // bug — the earlier version of this filter used `city_id = ad.city_id`
  // and every zone returned all 453,656 jobs because the mapping is
  // effectively a cross-join). The real zone-of-record is the
  // technician's `efr_zone_city_id` — verified 2026-05-19: 3,004
  // easyfixers carry 1,016 distinct values.
  //
  // Trade-off: jobs WITHOUT an assigned technician (Pending for
  // Scheduling) won't match any zone filter — which is correct because
  // those jobs have no zone of record yet.
  if (zonalId != null) {
    clauses.push('EXISTS (SELECT 1 FROM tbl_zone_city_mapping zcm WHERE zcm.city_zone_id = ef.efr_zone_city_id AND zcm.zone_id = ?)');
    params.push(Number(zonalId));
  }
  /*
   * quotationStatus — drives the AttentionSummary tile drill-down.
   *   'approved' → EXISTS approved line item (status=1 + action_on set)
   *                AND job is still actionable (not executing/closed/cancelled)
   *   'rejected' → EXISTS rejected line item (status=0 + action_on set)
   *                AND job is not closed/cancelled
   * EXISTS keeps row cardinality stable when a job has multiple quotation
   * line items.
   */
  if (quotationStatus === 'approved') {
    clauses.push(
      'EXISTS (SELECT 1 FROM quotation_details qd WHERE qd.job_id = j.job_id AND qd.status = 1 AND qd.action_on IS NOT NULL)',
    );
    clauses.push('j.job_status NOT IN (2, 3, 5, 6)');
  } else if (quotationStatus === 'rejected') {
    clauses.push(
      'EXISTS (SELECT 1 FROM quotation_details qd WHERE qd.job_id = j.job_id AND qd.status = 0 AND qd.action_on IS NOT NULL)',
    );
    clauses.push('j.job_status NOT IN (3, 5, 6)');
  }
  // requestedBefore — Running Late tile filter.
  if (requestedBefore === 'now') {
    clauses.push('j.requested_date_time IS NOT NULL AND j.requested_date_time < NOW()');
  } else if (requestedBefore) {
    clauses.push('j.requested_date_time IS NOT NULL AND j.requested_date_time < ?');
    params.push(requestedBefore);
  }
  // Open Due To — accepts both shapes of remark:
  //   (a) Structured tag from the AddRemarks dialog:
  //       "[Unreachable · Pending Due To: Client · Reason: …] free text"
  //   (b) Loose legacy free-text: "… due to client said no …"
  // MySQL default collation is case-insensitive, so the LIKE comparison
  // matches "Due to Client" / "DUE TO CLIENT" / "due to client" alike.
  // The loose-match arm risks false positives ("due to customer issue"
  // for dueTo=customer) — acceptable given the legacy data has no
  // structured tag yet; tightening to brackets-only would zero-out the
  // filter entirely until the AddRemarks-dialog data lands.
  if (dueTo) {
    const lower = String(dueTo).toLowerCase();
    const label = lower === 'easyfix' ? 'EasyFix'
      : lower.charAt(0).toUpperCase() + lower.slice(1);
    clauses.push('(j.remarks LIKE ? OR j.remarks LIKE ?)');
    //   1st: structured tag exact ("Due To: Client")
    //   2nd: loose free-text ("due to client")
    params.push(`%Due To: ${label}%`, `%due to ${lower}%`);
  }
  /*
   * `isEscalated` — WIRED 2026-08-26. There is no j.is_escalated column (the
   * legacy CRM had it commented out across JobDaoImpl.java); the real flag is
   * tbl_easyfixer_rating_by_customer.is_escalated, keyed by job_id.
   *
   * This was a deliberate no-op for a long time, which meant the client
   * portal's /tickets/escalated listed EVERY job while its header promised
   * only escalated ones — telling a client their whole book is escalated. See
   * escalationColumns/escalationJoin above for why EXISTS rather than a join.
   */
  if (wantsEscalation) {
    clauses.push(`EXISTS (
      SELECT 1 FROM tbl_easyfixer_rating_by_customer esc_f
       WHERE esc_f.job_id = j.job_id AND esc_f.is_escalated = 1)`);
  }
  // `dateType` selects which date column the start/end range applies
  // to. Defaults to `created_date_time` for backward-compat with
  // callers that don't pass dateType.
  const dateCol = DATE_TYPE_COLUMN[String(dateType || '').toLowerCase()] || 'j.created_date_time';
  /*
   * IST CALENDAR-DAY BOUNDS, not raw instants (fixed 2026-08-18).
   *
   * `startDate`/`endDate` are Joi.date().iso(), so '2026-08-17' is parsed as
   * UTC midnight and mysql2 then serialises that Date at the pool's +05:30 —
   * MySQL actually received '2026-08-17 05:30:00'. Measured, not inferred.
   *
   * Two consequences, one visible and one not:
   *   • start = end returned NOTHING, because the range collapsed to a single
   *     instant at 05:30. That is the reported bug.
   *   • EVERY range was skewed 5.5h: 17th→18th meant 17th 05:30 → 18th 05:30,
   *     dropping the 17th's first 5.5 hours and including the 18th's. Silent,
   *     and it applied to the export too.
   *
   * DATE(?) truncates the parameter to its IST calendar day (+05:30 never
   * crosses midnight for a UTC-midnight input), and the upper bound becomes
   * EXCLUSIVE next-day so the whole final day is inside the range — including
   * 23:59:59, which a `<= DATE(?)` would have excluded just as surely.
   *
   * DATE() is applied to the PARAMETER, never the column, so the index on
   * created_date_time (and every other dateType target) is still usable.
   */
  if (startDate)           { clauses.push(`${dateCol} >= DATE(?)`); params.push(startDate); }
  if (endDate)             { clauses.push(`${dateCol} < DATE(?) + INTERVAL 1 DAY`); params.push(endDate); }
  if (q) {
    /*
     * `j.job_id` added (2026-06-10 fix) — operators routinely search by
     * the numeric job id on the Unconfirmed tab to triage a specific
     * order. Earlier this clause only matched against text fields
     * (reference id, client ref, customer name + mobile), so a search
     * like "12345" returned zero rows even when job_id=12345 was on
     * the very page being viewed. Now job_id is a CAST AS CHAR + LIKE
     * so partial numeric matches (e.g. "1234" → 12340..12349) work,
     * matching operator expectations.
     */
    // Search covers every field the client-side filter (job-tabs.ts filterJobRows)
    // matches, so the two layers agree: job id / reference / client ref /
    // customer name+mobile PLUS client name, city, technician, and owner. The
    // cl/ci/ef/ow aliases are already in the data-query LIST_JOIN, and the COUNT
    // query's alias-detection below auto-adds their joins once they appear here.
    // client_spoc_name / client_spoc are denormalised snapshots ON tbl_job (alias
    // j) — captured at booking, shown in the "Client SPOC" column of the
    // Unconfirmed + Pending-to-Scheduling tabs. They were displayed but NOT
    // searchable; added here so a SPOC-name search matches. No new JOIN (alias j
    // is always present), and since COUNT + data share this where/params the two
    // OR terms apply to both.
    // The customer-name term is JOB_CUSTOMER_NAME_EXPR, not `cu.customer_name`:
    // the row displays (and the CRM's client-side re-filter reads) the job-row
    // name, so matching the master name alone would return rows the browser then
    // hides — the precise failure tests/job-search-parity.test.js exists to
    // prevent. Placeholder count is unchanged (11), so the params.push below
    // still binds exactly one value per LIKE. NOTE: that test's source-scraping
    // regex only detects bare `alias.col LIKE ?` terms, so this one no longer
    // shows up in its BE column list — the parity it asserts still holds (both
    // sides now key on the same effective name), it simply cannot see it.
    /*
     * ⚠ A PURELY NUMERIC TERM IS AN IDENTIFIER, NOT A SUBSTRING.
     *
     * Reported from production: searching 530280 returned THREE jobs. #530280
     * was the one wanted; the other two matched because the floating LIKE hit
     * their PHONE NUMBERS mid-digit — 98453028|06 and 93|530280|25 both contain
     * "530280". Any 6-digit id has roughly five landing spots inside a 10-digit
     * mobile, so the false-match rate grows with how many customers exist, not
     * with how unusual the term is. At 153k jobs an id search nearly always
     * drags in strangers.
     *
     * It was also slow for the same reason: eleven '%term%' predicates cannot
     * use an index, so every search full-scanned tbl_job and five joined tables.
     *
     * So a digits-only term takes a typed path:
     *   - j.job_id = ?  — a PRIMARY KEY lookup, exact and instant. This is what
     *     the operator meant, and it is the whole reason the search felt slow.
     *   - the two reference columns keep a substring match: they are opaque
     *     client strings (WO1024566, 171-2677513-3675553) where a fragment is a
     *     legitimate way to search.
     *   - the mobile matches only a term long enough to BE a phone fragment
     *     (>= MOBILE_MIN_DIGITS), and is anchored so it cannot match mid-number.
     *   - name/city/client/owner columns are skipped entirely — a digits-only
     *     term is never a person's name, and each one was a full scan.
     * Anything containing a non-digit keeps the original eleven-column search.
     */
    const digitsOnly = /^\d+$/.test(q);
    if (digitsOnly) {
      const idTerms = ['j.job_id = ?', 'j.job_reference_id LIKE ?', 'j.client_ref_id LIKE ?'];
      const idParams = [Number(q), `%${q}%`, `%${q}%`];
      // A phone fragment, not an id. Anchored at the START so "530280" can
      // never match the middle of 9845302806 — the reported bug.
      if (q.length >= MOBILE_MIN_DIGITS) {
        /*
         * ── THE MOBILE BRANCH IS A SET LOOKUP, NOT A JOINED COLUMN ──
         * (2026-08-20, measured against the 481k-row table — see the numbers
         * in the block below.)
         *
         * It used to read `cu.customer_mob_no LIKE ?`, i.e. a column of the
         * OUTER LEFT JOIN. Because it sat inside an OR with three tbl_job
         * predicates, MySQL could not decide the row until tbl_customer had
         * been joined, so EXPLAIN showed `cu eq_ref … Using where` and the
         * server paid ~481k PK probes into tbl_customer for one search —
         * whether or not any of them could match. That is what made a phone
         * search the slowest thing on the page (2.0s data + 1.9s count).
         *
         * Written as an uncorrelated IN (…), the same rows come back but the
         * predicate is now pure-`j`: MySQL runs the subquery ONCE as
         * `range` on the customer_mob_no index (EXPLAIN: `2 SUBQUERY qmob
         * type=range key=mobile_unique … Using index`) and probes the result.
         * The prefix anchor is what makes the range possible — it is a
         * correctness rule first (see above) and an index rule second.
         *
         * SAME ROWS, three-valued logic included: customer_id is the PK of
         * tbl_customer, so `cu.customer_mob_no LIKE 't%'` is true for exactly
         * the jobs whose fk_customer_id is in that set. A NULL or orphan
         * fk_customer_id yields NULL/false on both sides (`NULL IN (…)` is
         * UNKNOWN, `NULL LIKE …` is NULL) and OR-composes identically.
         * ⚠ This is IN, never NOT IN — the NOT-IN/NULL trap does not apply,
         * and must not be introduced here by "simplifying" it later.
         *
         * SIDE EFFECT, deliberate: the WHERE no longer names `cu.`, so the
         * COUNT query's alias sniffing below stops adding the tbl_customer
         * join to it as well. The subquery is self-contained, so COUNT and
         * the data query still filter on exactly the same predicate — the
         * totals were verified equal on real data for every term shape.
         *
         * Measured, min-of-5 interleaved, q = a real 10-digit mobile:
         *              data query      COUNT query
         *   before      2027 ms         1864 ms
         *   after       1088 ms          865 ms
         * and unchanged (~31 ms) on the selective tabs, because the plan is
         * still free to drive from idx_tbl_job_status.
         */
        idTerms.push(
          'j.fk_customer_id IN (SELECT qmob.customer_id FROM tbl_customer qmob WHERE qmob.customer_mob_no LIKE ?)'
        );
        idParams.push(`${q}%`);
      }
      /*
       * ═══ WHY THIS IS STILL AN `OR`, AND NOT A UNION OF INDEXED BRANCHES ═══
       *
       * The obvious next move — and the one docs/migrations for the
       * customer_mob_no index proposed — is to stop OR-ing indexable and
       * non-indexable branches and instead feed the outer query a UNION of
       * per-branch id lookups:
       *
       *   FROM tbl_job j … JOIN (
       *        SELECT job_id FROM tbl_job WHERE job_id = ?
       *   UNION SELECT job_id FROM tbl_job WHERE job_reference_id LIKE ?
       *                                        OR client_ref_id LIKE ?
       *   UNION SELECT … FROM tbl_customer … JOIN tbl_job …
       *   ) qs ON qs.job_id = j.job_id
       *
       * It was built and MEASURED against the real 481k-row table before
       * being rejected. Both halves of the premise turn out to be false:
       *
       * 1. IT CANNOT MAKE EVERY BRANCH INDEX-USABLE. job_reference_id and
       *    client_ref_id are matched with a LEADING wildcard, which no index
       *    shape can serve — not in an OR, not in a UNION branch, not
       *    anywhere. Moving them into a subquery changes where the scan
       *    happens, never whether it happens. (Neither column is indexed at
       *    all today; even a covering index would only turn the clustered
       *    scan into a narrower index-only one — measured 600 ms → 137 ms for
       *    an equivalent full scan of a narrow secondary index. Worth doing
       *    on its own merits; it does not change this conclusion.)
       *
       * 2. IT TAKES THE PLAN CHOICE AWAY FROM THE OPTIMISER. The derived
       *    table has to be materialised before the join, so the UNION shape
       *    costs one full scan of tbl_job — ~690 ms — NO MATTER WHAT ELSE IS
       *    IN THE WHERE. The current OR is an ordinary per-row predicate, so
       *    MySQL is free to drive from whichever filter is selective and
       *    check the term on the few rows that survive. Quick search almost
       *    always ships with a tab filter, and 9 of the 12 tabs are tiny
       *    (status 0=430 rows, 1=432, 10=259, 21=78, 15=66, 2+20=48 …).
       *
       *    Endpoint latency, min-of-5 interleaved, real data, q=482507:
       *                       today (OR)      UNION shape
       *      no tab ('All')      896 ms          694 ms   ← UNION 1.3× better
       *      status=5 (332k)    1259 ms          694 ms   ← UNION 1.8× better
       *      status=0 (430)       33 ms          706 ms   ← UNION 21× WORSE
       *      status=20 (4)        35 ms          729 ms   ← UNION 21× WORSE
       *
       *    A 1.3–1.8× win on two tabs bought with a 21× loss on nine is not a
       *    trade worth making. Result parity was never the problem — the
       *    UNION returned identical rows on every term shape tested — the
       *    physics is.
       *
       * 3. `j.job_id IN (SELECT … UNION …)` — the same idea kept in the
       *    WHERE so the optimiser could still choose — is worse than either:
       *    MySQL 8.4 refuses to flatten a UNION subquery into a semi-join and
       *    executes it as a DEPENDENT SUBQUERY, re-running the union per
       *    outer row. Measured 5.1 s / 10.3 s. Do not resurrect it.
       *
       * THE `REF-` REDUNDANCY QUESTION. job_reference_id is normally
       * `REF-{job_id}` (utils/job-reference.js), which makes it tempting to
       * drop `j.job_reference_id LIKE ?` for a digits-only term as
       * "already covered by j.job_id = ?". It is NOT covered, on two
       * independent grounds:
       *   • SEMANTICS. On auto rows the branch is effectively
       *     `CAST(job_id AS CHAR) LIKE '%t%'` — a SUBSTRING match over the id
       *     digits, strictly wider than equality. Searching "5302" returns
       *     261 jobs today (453027, 415302, …); equality returns none of them.
       *   • PROVENANCE. The value is only auto-generated when the caller
       *     supplies neither `job_reference_id` nor `reuse_client_ref`
       *     (create(), ~line 3255). On this database 3,768 rows of 481,043
       *     carry a ref that is NOT `REF-{job_id}`, and a live search proves
       *     the branch earns its place: q=999998 matches job 298642 even
       *     though no such job id exists (max id is 482507).
       * So the branch stays, and with it the one scan nothing can remove.
       */
      clauses.push(`(${idTerms.join(' OR ')})`);
      params.push(...idParams);
    } else {
      clauses.push(`(CAST(j.job_id AS CHAR) LIKE ? OR j.job_reference_id LIKE ? OR j.client_ref_id LIKE ? OR ${JOB_CUSTOMER_NAME_EXPR} LIKE ? OR cu.customer_mob_no LIKE ? OR cl.client_name LIKE ? OR ci.city_name LIKE ? OR ef.efr_name LIKE ? OR ow.user_name LIKE ? OR j.client_spoc_name LIKE ? OR j.client_spoc LIKE ?)`);
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  // Build a minimal join set for COUNT based on which aliases are referenced
  // in the WHERE clause. If the filter only hits tbl_job columns (the common
  // case: status tabs, no extra filter), we can count over tbl_job alone —
  // a single-table indexed scan vs. a full 6-way join.
  const needsCu = /\bcu\./.test(where);
  const needsAd = /\bad\./.test(where);
  const needsCl = /\bcl\./.test(where);
  const needsCi = /\bci\./.test(where);
  const needsEf = /\bef\./.test(where);
  const needsOw = /\bow\./.test(where);
  const countJoin = `
    FROM tbl_job j
    ${needsCu ? 'LEFT JOIN tbl_customer cu ON cu.customer_id = j.fk_customer_id' : ''}
    ${needsAd || needsCi ? 'LEFT JOIN tbl_address  ad ON ad.address_id  = j.fk_address_id' : ''}
    ${needsCi ? 'LEFT JOIN tbl_city     ci ON ci.city_id     = ad.city_id' : ''}
    ${needsCl ? 'LEFT JOIN tbl_client   cl ON cl.client_id   = j.fk_client_id' : ''}
    ${needsEf ? 'LEFT JOIN tbl_easyfixer ef ON ef.efr_id     = j.fk_easyfixter_id' : ''}
    ${needsOw ? 'LEFT JOIN tbl_user     ow ON ow.user_id     = j.job_owner' : ''}
  `;

  // Server-side sort — see SORTABLE_COLUMNS at module scope for the whitelist
  // and why sorting can't affect the COUNT join. hasOwnProperty guards against
  // inherited keys ('constructor', '__proto__') reaching the SQL string even if
  // a caller ever bypasses the Joi layer.
  const sortCol = Object.prototype.hasOwnProperty.call(SORTABLE_COLUMNS, sortBy)
    ? SORTABLE_COLUMNS[sortBy]
    : undefined;
  const sortDirSql = String(sortDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const orderBy = sortCol
    ? `ORDER BY ${sortCol} ${sortDirSql}, j.job_id DESC`
    : 'ORDER BY j.job_id DESC';

  if (countOnly) {
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${countJoin} ${where}`, params);
    logger.info('Counted ' + total + ' jobs (countOnly)');
    return { rows: [], total };
  }

  // Run COUNT and data query in parallel — they're independent, no reason to
  // serialize. Roughly halves wall-clock time on cold caches.
  const dataParams = [...params, Number(limit), Number(offset)];
  const [[[{ total }]], [rows]] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS total ${countJoin} ${where}`, params),
    pool.query(
      `SELECT ${listColumns} ${listJoin} ${where}
       ${orderBy} LIMIT ? OFFSET ?`,
      dataParams
    ),
  ]);
  logger.info('Found ' + rows.length + ' jobs (total=' + total + ')');
  return { rows, total };
}

// ─── Detail ─────────────────────────────────────────────────────────
/*
 * Fetches job detail + services + images in parallel. Each query is independent;
 * running them serially wastes ~2× the wall-clock time for zero benefit. The
 * main detail query is still the expensive one (7-way join); the other two are
 * cheap child lookups on indexed job_id.
 *
 * Returns null if the job row doesn't exist (preserved from prior behaviour).
 * Services + images default to [] if the main row is missing — no point paying
 * for those lookups when we're about to 404.
 */
/*
 * getByIdCore — the job's DETAIL_JOIN scalar row ONLY (no services / images /
 * videos sub-fetches). Callers that need just the job's own fields (scope
 * assertion, candidate-ranking's enrichedJob, status/label reads) should use
 * this: it skips the tbl_job_image lookup, which — with no index on
 * tbl_job_image.job_id — full-scans ~1.4M rows (~1.1s) for images those paths
 * never render. `getById` composes this with the three child lookups for the
 * full detail payload.
 *
 * Returns null if the job row doesn't exist (same contract as getById's row).
 */
async function getByIdCore(jobId) {
  // Gate `cl.vertical_id` in the SELECT projection on column presence.
  // When the column isn't on this DB's tbl_client, fall back to a NULL
  // alias so the projection stays stable for downstream consumers
  // (image redirect endpoint reads `j.vertical_id` for scope assert).
  // Without this gate, the query throws "Unknown column" and EVERY
  // job-detail-dependent flow (view modal, image redirect, etc.)
  // 500s for this DB.
  const hasVerticalCol = await hasClientVerticalIdColumn();
  const verticalSelect = hasVerticalCol ? 'cl.vertical_id' : 'NULL AS vertical_id';
  const hasAddrInstr = await hasAddressInstructionColumn();
  const addrInstrSelect = hasAddrInstr ? 'ad.address_instruction' : 'NULL AS address_instruction';
  // "Closed as enquiry" (status 7) reason — enquiry_* columns don't exist on
  // every deploy, so probe before referencing enquiry_reason_id. enquiry_comment
  // comes through j.* when present. cancel_by is the actor for enquiry too, so
  // cancelled_by_name already covers "closed by".
  const hasEnq = await hasEnquiryColumns();
  const enquiryReasonSelect = hasEnq
    ? `(SELECT atr.action_desc FROM action_taken_reason atr WHERE atr.id = j.enquiry_reason_id LIMIT 1) AS enquiry_reason_name`
    : `NULL AS enquiry_reason_name`;
  const [jobRows] = await pool.query(
    `SELECT j.*,
            /* customer_name = the name booked ON THIS JOB, master as fallback —
               same JOB_CUSTOMER_NAME_EXPR the list projects, so the modal and
               the row it opened from can never show different names. tbl_job has
               no customer_name column (only job_customer_name), so the j.* above
               cannot shadow this alias; job_customer_name still arrives raw via
               j.* for the Confirm-mode form fields that edit it. */
            ${JOB_CUSTOMER_NAME_EXPR} AS customer_name, cu.customer_mob_no, cu.customer_email,
            ad.address, ad.building, ad.landmark, ad.locality, ad.pin_code,
            ad.gps_location, ${addrInstrSelect}, ad.city_id, ci.city_name,
            sc.service_catg_name AS service_category,
            cl.client_name, cl.client_email, ${verticalSelect},
            ef.efr_name AS easyfixer_name, ef.efr_no AS easyfixer_mobile,
            ow.user_name AS owner_name,
            cr.user_name AS created_by_name,
            (SELECT u2.user_name FROM tbl_user u2 WHERE u2.user_id = j.cancel_by LIMIT 1) AS cancelled_by_name,
            (SELECT atr.action_desc FROM action_taken_reason atr WHERE atr.id = j.cancel_reason_id LIMIT 1) AS cancel_reason_name,
            /* From Production: enquiry reason, NULL-aliased on deploys that
               predate the enquiry columns (hasEnquiryColumns probe above). */
            ${enquiryReasonSelect}
            /* Job Age — same two derived fields the LIST emits, from the SAME
               constant, so the detail modal and the list row always agree.
               JOB_AGE_COLUMNS is a LEADING-comma fragment, so the line above
               must NOT end in one. */
            ${JOB_AGE_COLUMNS}
     ${DETAIL_JOIN}
     WHERE j.job_id = ? LIMIT 1`,
    [jobId]
  );
  const job = jobRows[0];
  if (!job) { logger.warn('Job detail not found · id=' + jobId); return null; }
  // Decode the custom-property fields folded into `remarks` on write so the
  // Book-New-Call form repopulates them when a draft/job reopens (product_code
  // + building_name are NOT tbl_job columns). branch_details is a real column
  // and already present on the row.
  const decodedProps = decomposeRemarks(job.remarks);
  if (job.product_code == null) job.product_code = decodedProps.product_code || null;
  if (job.building_name == null) job.building_name = decodedProps.building_name || null;
  // Decode the flattened `custom_property` string (Label:Value|…, written by the
  // client booking apps) into structured rows so the CRM Job Transaction view can
  // prepopulate the client custom-property values on reopen. Pure string parse —
  // no extra query — so getByIdCore stays lean for the scope/status hot paths.
  job.custom_properties = parseCustomPropertyString(job.custom_property);
  return job;
}

async function getById(jobId) {
  logger.info('Get job detail · id=' + jobId);

  const [job, services, images] = await Promise.all([
    getByIdCore(jobId),
    pool.query(
      // Return ALL service rows including soft-deleted (status=0). The FE
      // hides them by default but exposes a "Show Inactive" toggle that
      // lets the operator restore a row they removed by mistake. Filtering
      // them out here would deny the restore path. (Updated 2026-05-26.)
      // ADDITIVE (2026-07-10): charge_type + effective_charge are NEW alias keys
      // for the mobile order-detail (line price usually lives on the client-service
      // row, not js.total_charge which is often 0, so the app showed every order as
      // "Free"/blank). Existing columns — incl. js.total_charge the CRM reads — are
      // unchanged, so the CRM Job Transaction view is unaffected.
      `SELECT js.job_service_id, js.service_id, js.quantity, js.total_charge,
              js.job_service_status, js.service_category_id, js.service_type_id,
              st.service_type_name, sc.service_catg_name,
              CR.crc_ratecard_name AS service_name,
              CS.charge_type,
              COALESCE(NULLIF(js.total_charge, 0), CS.total_amount) AS effective_charge
         FROM tbl_job_services js
         LEFT JOIN tbl_service_type st ON st.service_type_id = js.service_type_id
         LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = js.service_category_id
         LEFT JOIN tbl_client_service   CS ON CS.client_service_id = js.service_id
         LEFT JOIN tbl_client_rate_card CR ON CR.crc_id = CS.rate_card_id
        WHERE js.job_id = ?
        ORDER BY js.job_service_id ASC`,
      [jobId]
    ),
    pool.query(
      `SELECT image_id, image, image_category, job_stage, created_date
         FROM tbl_job_image
        WHERE job_id = ?
        ORDER BY image_id ASC`,
      [jobId]
    ),
  ]);
  // getByIdCore already logged the not-found warn; bail before the child
  // lookups (services/images were fetched in parallel but are discarded).
  if (!job) return null;

  // Customer-shared videos (via the WhatsApp conversational order-confirmation
  // flow) live in tbl_job_media — a separate EasyFix-owned table because
  // tbl_job_image is image-only by convention. Probe-gated so a deploy without
  // the 2026-06-03 migration applied returns videos:[] silently. Same shape
  // the FE can render with a play icon next to the photos grid.
  let videos = [];
  if (await jobMediaTableExists()) {
    const [vRows] = await pool.query(
      `SELECT media_id, s3_key, content_type, source, created_at
         FROM tbl_job_media
        WHERE job_id = ?
        ORDER BY media_id ASC`,
      [jobId],
    );
    videos = vRows;
  }
  /*
   * billing_label — per-service Free/Paid, derived (not stored). ADDITIVE
   * 2026-07-15 for the Schedule & Assign modal's per-service Free/Paid chip.
   *
   * Same rule as the customer-facing magic-link bundle (job-magic-link.service.js
   * fetchPrefill: `total_amount null or 0 → 'Free', else 'Paid'`) so Free/Paid
   * means exactly one thing on every surface. Keyed off `effective_charge` —
   * the COALESCE(NULLIF(js.total_charge,0), CS.total_amount) alias above —
   * because js.total_charge is usually 0 and the real price sits on the
   * client-service row (that mismatch is what made the mobile app render every
   * order as "Free"; see the comment on the SELECT).
   *
   * ⚠ Free/Paid is billing_label, and it is PER-SERVICE. It is NOT collected_by
   * — that's a per-JOB enum for WHO collects the money (1=Easyfixer, 2=Easyfix,
   * 3=Client) and lives on tbl_job. Neither tbl_job_services nor
   * tbl_client_service carries a collected-by column.
   */
  const shapedServices = (services[0] || []).map((s) => ({
    ...s,
    billing_label:
      (s.effective_charge == null || Number(s.effective_charge) === 0) ? 'Free' : 'Paid',
  }));

  // Resolve each stored image (an S3 key like `JobSupportings/Booking_<id>_<seq>`
  // or a legacy filename) into a directly-renderable URL: a short-lived S3
  // presigned URL when the object is in the bucket, else the legacy media-host
  // URL. The app renders `image_url` and no longer guesses the path itself.
  const s3Storage = require('../utils/s3-storage');
  const shapedImages = await Promise.all((images[0] || []).map(async (im) => {
    let image_url = null;
    try { image_url = await s3Storage.resolveImageUrl(im.image); } catch { image_url = null; }
    return { ...im, image_url };
  }));

  return { ...job, services: shapedServices, images: shapedImages, videos };
}

/*
 * Lightweight existence + status check. Used by setStatus / assign before they
 * mutate — skipping the 7-way join saves ~150-300ms per status change and
 * avoids loading services+images we don't use in those paths.
 */
/* `otp` is included here (added 2026-05-28) so setStatus() can decide
 * whether to mint a new OTP on the BOOKED transition without a second
 * round-trip. A NULL/empty existing value triggers generation; an
 * already-set value is preserved (idempotent re-confirm doesn't
 * change the code the customer was already told). */
async function getJobMeta(jobId) {
  // `otp` selection is wrapped in a probe-driven concat so older deploys
  // that lack the column don't break the meta read. The downstream
  // setStatus() only reads meta.otp when the probe says the column
  // exists, but explicitly emitting NULL keeps the shape stable.
  const otpCol = (await hasOtpColumn()) ? 'otp' : 'NULL AS otp';
  const [[row]] = await pool.query(
    // requested_date_time as a STRING (DATE_FORMAT) so setStatus's slot
    // derivation reads the IST wall-clock hour regardless of connection tz;
    // booking_cut_off_time_slot so the BOOKED confirm can COALESCE-backfill it.
    `SELECT job_id, job_status, fk_easyfixter_id, fk_customer_id, fk_client_id,
            DATE_FORMAT(requested_date_time, '%Y-%m-%d %H:%i:%s') AS requested_date_time,
            booking_cut_off_time_slot, ${otpCol}
       FROM tbl_job WHERE job_id = ? LIMIT 1`,
    [jobId]
  );
  return row || null;
}

/*
 * Returns a single object with all status bucket totals + grand total, in ONE
 * DB round-trip. The dashboard used to make 6 separate /admin/jobs requests to
 * compute these — each of which ran a COUNT + data query in parallel server
 * side — causing ~12 concurrent pool connections for stats alone.
 *
 * Shape:
 *   { total, byStatus: { "0": 525, "1": 357, "2": 67, "3": 5702, "6": 65094, ... } }
 *
 * The grand total comes from the same query via a WITH ROLLUP or a small client
 * side sum — we use client-side sum because MySQL 5.7's WITH ROLLUP syntax is
 * fussy and the row count is always tiny (≤ 10 status codes).
 */
async function getStatusCounts({ ownerId, easyfixerId, scope, allowedStages } = {}) {
  logger.info('Compute job status counts · ownerId=' + (ownerId ?? '-') + ' · easyfixerId=' + (easyfixerId ?? '-'));
  /*
   * Two queries run in parallel:
   *   1. GROUP BY job_status — the raw count per code.
   *   2. BOOKED split by fk_easyfixter_id IS NULL — gives the dashboard the
   *      two derived buckets (Pending for Scheduling vs Pending App Ack) in
   *      one round-trip instead of a follow-up COUNT.
   *
   * `ownerId` scopes both queries to `job_owner = ?` (My Orders flow).
   * `scope`   row-filters by the caller's manage_clients × manage_cities
   *           × manage_verticals — drives the Dashboard cards so a PM only
   *           sees counts within their assigned scope (including downstream
   *           hierarchy when scope was built with buildRequestScopeWithHierarchy).
   * When scope is needed we LEFT JOIN tbl_address (for city) + tbl_client
   * (for vertical) — same join shape as LIST_JOIN.
   */
  const clauses = [];
  const params = [];

  // Probe tbl_client.vertical_id presence — same as list(). See the
  // declaration up top for the full rationale.
  const hasVerticalCol = await hasClientVerticalIdColumn();
  // OFFER MODEL: split BOOKED into Pending-for-Scheduling vs Pending-App-Ack by
  // open-offer EXISTS rather than the fk (a pool-offered job keeps fk NULL).
  // Falls back to the fk test on un-migrated deploys (offer table absent).
  const hasJobOffer = await jobOfferTableExists();

  if (ownerId) { clauses.push('j.job_client_owner = ?'); params.push(ownerId); }
  // `easyfixerId` — scope counts to a single technician. Enables the
  // Mobile App's dashboard to reuse this exact counts engine (instead
  // of duplicating the SUM-CASE pattern in a tier-specific service).
  // Per the no-route-duplication / single-source-of-truth rule: one
  // status-counts implementation serves CRM dashboard, Mobile dashboard,
  // and any future surface that needs status tallies.
  if (easyfixerId != null) {
    clauses.push('j.fk_easyfixter_id = ?');
    params.push(easyfixerId);
  }
  if (scope) {
    const c = scope.clients, ci = scope.cities, st = scope.states, v = scope.verticals;
    if (
      (c  && c.mode  === 'none') ||
      (ci && ci.mode === 'none') ||
      (st && st.mode === 'none') ||
      (v  && v.mode  === 'none')
    ) {
      clauses.push('1=0');
    }
    if (c && c.mode === 'allow' && c.ids.length) {
      clauses.push(`j.fk_client_id IN (${c.ids.map(() => '?').join(',')})`);
      params.push(...c.ids);
    }
    if (ci && ci.mode === 'allow' && ci.ids.length) {
      clauses.push(`ad.city_id IN (${ci.ids.map(() => '?').join(',')})`);
      params.push(...ci.ids);
    }
    // States filter (2026-06-03) — previously dropped silently, which
    // meant operators with state-scoped permissions saw every job in
    // every state. Joins tbl_city via the address's city_id to read
    // its state_id. Only fires when scope.states is set + 'allow';
    // 'all' means the operator can see all states + no filter needed.
    if (st && st.mode === 'allow' && st.ids.length) {
      clauses.push(`ct.state_id IN (${st.ids.map(() => '?').join(',')})`);
      params.push(...st.ids);
    }
    if (v && v.mode === 'allow' && v.ids.length && hasVerticalCol) {
      clauses.push(`cl.vertical_id IN (${v.ids.map(() => '?').join(',')})`);
      params.push(...v.ids);
    }
  }

  // Job Stage Access — same intersection as list() so tab counts respect the
  // caller's visible stages. Added to the shared `clauses`, so it flows into
  // BOTH the GROUP BY status query and the BOOKED-split query (a user who can't
  // see the pending-scheduling stage gets 0 for the booked buckets too).
  if (allowedStages && allowedStages.mode === 'list') {
    const visible = [...stageVisibleStatuses(allowedStages.stages)];
    if (visible.length === 0) {
      clauses.push('1=0');
    } else {
      clauses.push(`j.job_status IN (${visible.map(() => '?').join(',')})`);
      params.push(...visible);
    }
  }

  // Only JOIN tables we actually filter against — cheap on the indexed FKs.
  // tbl_address is needed whenever cities OR states is restricted (states
  // joins through city → tbl_city). tbl_city is needed only for states.
  // tbl_client is needed only for verticals.
  const needsAd = scope?.cities?.mode === 'allow' || scope?.states?.mode === 'allow';
  const needsCt = scope?.states?.mode === 'allow';
  const needsCl = scope?.verticals?.mode === 'allow' && hasVerticalCol;
  const joins = [
    needsAd ? 'LEFT JOIN tbl_address ad ON ad.address_id = j.fk_address_id' : '',
    needsCt ? 'LEFT JOIN tbl_city    ct ON ct.city_id    = ad.city_id'      : '',
    needsCl ? 'LEFT JOIN tbl_client  cl ON cl.client_id  = j.fk_client_id'  : '',
  ].filter(Boolean).join(' ');

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const bookedWhere = clauses.length
    ? `WHERE j.job_status = ${STATUS.BOOKED} AND ${clauses.join(' AND ')}`
    : `WHERE j.job_status = ${STATUS.BOOKED}`;

  // Escalated count is intentionally NOT queried here. The legacy CRM
  // sourced this from `tbl_easyfixer_rating_by_customer.is_escalated`
  // joined by job_id — NOT from a `tbl_job.is_escalated` column (which
  // doesn't exist). The legacy header itself commented out the
  // getEscalatedJobsbyUser() call, so the badge was already a no-op
  // upstream. Returning `escalated: 0` keeps the navbar contract stable
  // (it conditionally hides the badge when count is 0) without forcing
  // an extra JOIN to a table that may not be reliably populated.
  // Wire the rating-table join in a focused follow-up when the
  // escalation workflow is actually re-activated.

  // "unassigned" (Pending for Scheduling) = fk_easyfixter_id NULL. A pool-
  // offered job stays status 0 / fk NULL until accepted, so it correctly
  // counts here (matching the my-orders Pending-for-Scheduling list + its
  // "Offered to Tx" chip). On accept the fk is set and the job moves to the
  // Pending-to-Start (status 1) bucket.
  const unassignedExpr = 'j.fk_easyfixter_id IS NULL';
  const [statusRows, bookedSplitRows] = await Promise.all([
    pool.query(`SELECT j.job_status, COUNT(*) AS c FROM tbl_job j ${joins} ${where} GROUP BY j.job_status`, params),
    pool.query(
      `SELECT ${unassignedExpr} AS unassigned, COUNT(*) AS c
         FROM tbl_job j ${joins} ${bookedWhere}
        GROUP BY unassigned`,
      params
    ),
  ]);
  const byStatus = {};
  let total = 0;
  for (const r of statusRows[0]) {
    byStatus[String(r.job_status)] = Number(r.c);
    total += Number(r.c);
  }
  let bookedUnassigned = 0;
  let bookedAssigned = 0;
  for (const r of bookedSplitRows[0]) {
    // mysql2 returns the BIT(1) from `IS NULL` as 0/1 int here (no typeCast
    // needed since it's a computed boolean, not a BIT column).
    if (Number(r.unassigned) === 1) bookedUnassigned = Number(r.c);
    else bookedAssigned = Number(r.c);
  }
  // See comment above — escalated badge is stubbed to 0 until the
  // rating-table join lands.
  logger.info('Status counts ready · total=' + total + ' · bookedUnassigned=' + bookedUnassigned + ' · bookedAssigned=' + bookedAssigned);
  return { total, byStatus, bookedUnassigned, bookedAssigned, escalated: 0 };
}

/*
 * Attention summary — drives the dashboard's "Orders Needing Immediate
 * Attention" card (replaces the old Recent Jobs widget).
 *
 * Returns 5 operator-action counts in a single round-trip. Each sub-
 * query is run in parallel; a failure of one is logged + the metric
 * returns 0 so a single missing column or table doesn't break the card.
 *
 *   runningLate         booked/scheduled jobs past requested_date_time
 *   estimateApproved    quotations approved by SPOC, job not yet in
 *                       execution/done — ops should align a tx
 *   estimateRejected    quotations rejected by SPOC — ops follow-up
 *   pendingTechAccept   tech assigned but app-ack still pending
 *                       (proxy = bookedAssigned, status=0 + tech set)
 *   customerUnreachable status=9 CALL_LATER bucket
 *
 * All counts respect req.scope just like getStatusCounts. Bypass roles
 * (Admin/Finance) see the full count; scoped users see only their
 * hierarchy-unioned slice.
 */
async function getAttentionSummary({ scope, allowedStages } = {}) {
  const hasVerticalCol = await hasClientVerticalIdColumn();
  // OFFER MODEL: when tbl_job_offer exists, "pending tech accept" keys off an
  // OPEN offer EXISTS rather than the fk (a pool-offered job keeps fk NULL).
  // Probed once here, reused by the pendingTechAccept sub-query below.
  const hasJobOffer = await jobOfferTableExists();

  // Build the scope clauses + needed joins ONCE — reused across all
  // five queries so we don't double-scan tbl_address / tbl_client.
  function buildScopeFragment(jobAlias = 'j') {
    const clauses = [];
    const params = [];
    if (scope) {
      const c = scope.clients, ci = scope.cities, st = scope.states, v = scope.verticals;
      if (
        (c  && c.mode  === 'none') ||
        (ci && ci.mode === 'none') ||
        (st && st.mode === 'none') ||
        (v  && v.mode  === 'none')
      ) {
        clauses.push('1=0');
      }
      if (c && c.mode === 'allow' && c.ids.length) {
        clauses.push(`${jobAlias}.fk_client_id IN (${c.ids.map(() => '?').join(',')})`);
        params.push(...c.ids);
      }
      if (ci && ci.mode === 'allow' && ci.ids.length) {
        clauses.push(`ad.city_id IN (${ci.ids.map(() => '?').join(',')})`);
        params.push(...ci.ids);
      }
      // States filter (2026-06-03) — kept in sync with getStatusCounts.
      // Joins tbl_city via the address's city_id to read state_id.
      if (st && st.mode === 'allow' && st.ids.length) {
        clauses.push(`ct.state_id IN (${st.ids.map(() => '?').join(',')})`);
        params.push(...st.ids);
      }
      if (v && v.mode === 'allow' && v.ids.length && hasVerticalCol) {
        clauses.push(`cl.vertical_id IN (${v.ids.map(() => '?').join(',')})`);
        params.push(...v.ids);
      }
    }
    // Job Stage Access — intersect every tile's own status predicate with the
    // caller's visible-status union so the tiles respect the same restriction
    // as the list + counts. References only the job alias → no extra join.
    if (allowedStages && allowedStages.mode === 'list') {
      const visible = [...stageVisibleStatuses(allowedStages.stages)];
      if (visible.length === 0) {
        clauses.push('1=0');
      } else {
        clauses.push(`${jobAlias}.job_status IN (${visible.map(() => '?').join(',')})`);
        params.push(...visible);
      }
    }
    // Same JOIN strategy as getStatusCounts: tbl_address needed
    // whenever cities OR states filter is on; tbl_city only for states;
    // tbl_client only for verticals. Each is LEFT JOIN so missing FKs
    // don't drop the row from the count.
    const needsAd = scope?.cities?.mode === 'allow' || scope?.states?.mode === 'allow';
    const needsCt = scope?.states?.mode === 'allow';
    const needsCl = scope?.verticals?.mode === 'allow' && hasVerticalCol;
    const joins = [
      needsAd ? `LEFT JOIN tbl_address ad ON ad.address_id = ${jobAlias}.fk_address_id` : '',
      needsCt ? `LEFT JOIN tbl_city    ct ON ct.city_id    = ad.city_id`                : '',
      needsCl ? `LEFT JOIN tbl_client  cl ON cl.client_id  = ${jobAlias}.fk_client_id`  : '',
    ].filter(Boolean).join(' ');
    return { clauses, params, joins };
  }

  // Helper: run a count safely. On any error, log + return 0 so the
  // attention card stays usable even if a single sub-query misfires
  // (e.g. a column rename that hasn't been caught by tests yet).
  // Inline require — matches the existing convention in this file (the
  // module top doesn't import the logger; each call-site requires it
  // locally to keep the dependency surface explicit per-feature).
  const logger = require('../logger');
  logger.info('Compute attention summary · scoped=' + (scope ? 'yes' : 'no'));
  async function safeCount(label, sql, params) {
    try {
      const [[row]] = await pool.query(sql, params);
      return Number(row?.c) || 0;
    } catch (e) {
      logger.warn({ err: e.message, metric: label }, 'attention-summary sub-query failed; returning 0');
      return 0;
    }
  }

  // 1. Running Late
  const runningLatePromise = (async () => {
    const f = buildScopeFragment('j');
    const where = ['j.requested_date_time IS NOT NULL',
                   'j.requested_date_time < NOW()',
                   'j.job_status IN (0, 1)',
                   ...f.clauses].join(' AND ');
    return safeCount(
      'runningLate',
      `SELECT COUNT(*) AS c FROM tbl_job j ${f.joins} WHERE ${where}`,
      f.params,
    );
  })();

  // 2. Estimate Approved (awaiting Tx)
  //    status=1 + action_on NOT NULL = SPOC-approved (vs default 0 on insert).
  //    job not yet in execution/closed/cancelled → ops should still act.
  const estimateApprovedPromise = (async () => {
    const f = buildScopeFragment('j');
    const where = ['qd.status = 1',
                   'qd.action_on IS NOT NULL',
                   'j.job_status NOT IN (2, 3, 5, 6)',
                   ...f.clauses].join(' AND ');
    return safeCount(
      'estimateApproved',
      `SELECT COUNT(DISTINCT qd.job_id) AS c
         FROM quotation_details qd
         JOIN tbl_job j ON j.job_id = qd.job_id
         ${f.joins}
        WHERE ${where}`,
      f.params,
    );
  })();

  // 3. Estimate Rejected — SPOC rejected (action_on set + status=0).
  //    Filtering out closed/cancelled jobs since those don't need action.
  const estimateRejectedPromise = (async () => {
    const f = buildScopeFragment('j');
    const where = ['qd.status = 0',
                   'qd.action_on IS NOT NULL',
                   'j.job_status NOT IN (3, 5, 6)',
                   ...f.clauses].join(' AND ');
    return safeCount(
      'estimateRejected',
      `SELECT COUNT(DISTINCT qd.job_id) AS c
         FROM quotation_details qd
         JOIN tbl_job j ON j.job_id = qd.job_id
         ${f.joins}
        WHERE ${where}`,
      f.params,
    );
  })();

  // 4. Pending Tech Acceptance — booked (status=0) with tech assigned.
  //    Proxy for "ack pending"; our schema doesn't have a separate
  //    accepted_at flag yet (per dashboard comment).
  const pendingTechAcceptPromise = (async () => {
    const f = buildScopeFragment('j');
    /*
     * OFFER MODEL: a job awaiting tech acceptance now has an EFFECTIVELY OPEN
     * offer rather than a set fk. Fall back to the legacy fk-NOT-NULL proxy on
     * un-migrated deploys (offer table absent).
     *
     * Uses the SHARED offer-state builder, not a hand-written
     * `EXISTS(offer_status = 0)`. The naive form counts rows the expiry sweep
     * has not reached yet, so with expiry ON this tile disagreed with the
     * "Offered to Tx" chip and filter on exactly the stale offers the operator
     * is chasing. One builder = one definition of "open" across dashboard,
     * chip and filter, in BOTH expiry regimes.
     */
    const openOffer = offerRowExists('live', 'jo', { bind: true, expiry: offerExpiryEnabled() });
    const acceptClause = hasJobOffer ? openOffer.sql : 'j.fk_easyfixter_id IS NOT NULL';
    const where = ['j.job_status = 0',
                   acceptClause,
                   ...f.clauses].join(' AND ');
    return safeCount(
      'pendingTechAccept',
      `SELECT COUNT(*) AS c FROM tbl_job j ${f.joins} WHERE ${where}`,
      // The offer predicate's placeholders come FIRST — it is spliced into the
      // WHERE ahead of the scope fragment's clauses.
      hasJobOffer ? [...openOffer.params, ...f.params] : f.params,
    );
  })();

  // 5. Customer Unreachable / Call Later — status 9
  const customerUnreachablePromise = (async () => {
    const f = buildScopeFragment('j');
    const where = ['j.job_status = 9', ...f.clauses].join(' AND ');
    return safeCount(
      'customerUnreachable',
      `SELECT COUNT(*) AS c FROM tbl_job j ${f.joins} WHERE ${where}`,
      f.params,
    );
  })();

  /*
   * 6. Booked-No-Services (added 2026-05-28) — counts BOOKED jobs that
   * have ZERO active rows in tbl_job_services. Surfaces the legacy
   * data-quality gap (ref Job #482453) where ops promote an Unconfirmed
   * job to BOOKED before adding any service line items. Same predicate
   * as the FE "No Services" pill so the tile count matches what the
   * operator will see on /jobs.
   *
   * NOT EXISTS subquery is preferred over a LEFT JOIN + IS NULL
   * because tbl_job_services has indexes on job_id; MySQL's optimiser
   * resolves the anti-join cheaply.
   *
   * `job_service_status = 1` mirrors the LIST projection's
   * active-only restriction — soft-deleted rows don't mask the anomaly.
   */
  const bookedNoServicesPromise = (async () => {
    const f = buildScopeFragment('j');
    const where = [
      'j.job_status = 0',
      `NOT EXISTS (
        SELECT 1 FROM tbl_job_services js
         WHERE js.job_id = j.job_id AND js.job_service_status = 1
      )`,
      ...f.clauses,
    ].join(' AND ');
    return safeCount(
      'bookedNoServices',
      `SELECT COUNT(*) AS c FROM tbl_job j ${f.joins} WHERE ${where}`,
      f.params,
    );
  })();

  const [
    runningLate,
    estimateApproved,
    estimateRejected,
    pendingTechAccept,
    customerUnreachable,
    bookedNoServices,
  ] = await Promise.all([
    runningLatePromise,
    estimateApprovedPromise,
    estimateRejectedPromise,
    pendingTechAcceptPromise,
    customerUnreachablePromise,
    bookedNoServicesPromise,
  ]);

  logger.info('Attention summary ready · runningLate=' + runningLate + ' · estApproved=' + estimateApproved + ' · estRejected=' + estimateRejected + ' · pendingTechAccept=' + pendingTechAccept + ' · unreachable=' + customerUnreachable + ' · bookedNoServices=' + bookedNoServices);
  return {
    runningLate,
    estimateApproved,
    estimateRejected,
    pendingTechAccept,
    customerUnreachable,
    bookedNoServices,
  };
}

// ─── Customer + Address helpers (used by create) ───────────────────
async function upsertCustomer(conn, { customer_id, customer_name, customer_mob_no, customer_email }, actor) {
  if (customer_id) {
    const [[found]] = await conn.query(
      'SELECT customer_id FROM tbl_customer WHERE customer_id = ? LIMIT 1',
      [customer_id]
    );
    if (!found) {
      const err = new Error(`customer_id ${customer_id} not found`);
      err.status = 400;
      throw err;
    }
    return customer_id;
  }
  // Lookup by mobile — reuse existing
  const [[existing]] = await conn.query(
    'SELECT customer_id FROM tbl_customer WHERE customer_mob_no = ? LIMIT 1',
    [customer_mob_no]
  );
  if (existing) return existing.customer_id;

  const [ins] = await conn.query(
    `INSERT INTO tbl_customer (customer_name, customer_mob_no, customer_email, is_active, created_by, insert_date, update_date)
     VALUES (?, ?, ?, 1, ?, ?, ?)`,
    [customer_name, customer_mob_no, customer_email || null, actor?.user_id || null, new Date(), new Date()]
  );
  return ins.insertId;
}

/*
 * composeRemarks — combines the operator's free-text remarks with the
 * two legacy Book-New-Call fields (product_code, building_name) into
 * a single string with named prefixes. Used because those two columns
 * don't exist on the production tbl_job schema (verified 2026-05-14
 * via INFORMATION_SCHEMA — only `branch_details` exists; the other
 * two return zero rows). `branch_details` has been promoted to a
 * dedicated INSERT column.
 *
 * Format:
 *   <user remarks>
 *   [Product Code] <product_code>
 *   [Building / Property] <building_name>
 */
function composeRemarks(input) {
  const parts = [];
  if (input.remarks) parts.push(String(input.remarks));
  if (input.product_code)   parts.push(`[Product Code] ${input.product_code}`);
  if (input.building_name)  parts.push(`[Building / Property] ${input.building_name}`);
  return parts.length ? parts.join('\n') : null;
}

/*
 * decomposeRemarks — inverse of composeRemarks. Pulls product_code +
 * building_name back OUT of the `remarks` prefix lines so the Book-New-Call
 * form can repopulate those fields when a draft reopens (they aren't real
 * tbl_job columns, so SELECT j.* can't surface them). Non-destructive: we do
 * NOT strip the prefixes from `remarks` here — the write paths keep the
 * composed string intact, so re-saving a reopened job never loses or
 * double-encodes the values.
 */
function decomposeRemarks(raw) {
  const s = raw == null ? '' : String(raw);
  let product_code = '';
  let building_name = '';
  for (const line of s.split('\n')) {
    let m = line.match(/^\[Product Code\]\s?(.*)$/);
    if (m) { product_code = m[1].trim(); continue; }
    m = line.match(/^\[Building \/ Property\]\s?(.*)$/);
    if (m) { building_name = m[1].trim(); continue; }
  }
  return { product_code, building_name };
}

/*
 * parseCustomPropertyString — decode the flattened `tbl_job.custom_property`
 * VARCHAR(510) column back into structured rows so the CRM Job Transaction view
 * (JobTransactionView reads `job.custom_properties`) prepopulates the client
 * custom-property values a SPOC entered at booking.
 *
 * The client booking apps compose this column as `Label:Value|Label:Value`,
 * keyed by the property's display LABEL, dropping empties
 * (Easyfix_client_UI src/app/(authed)/jobs/new/page.tsx and Easyfix_Client_App
 * app/jobs/new.tsx); createJob stores it verbatim. Nothing ever parsed it back,
 * so previously-entered values rendered blank on reopen — this is the inverse.
 *
 * Rules mirror the writers + the legacy data quirks seen in the DB:
 *  - split on '|', then on the FIRST ':' only (so a value like "12:30" survives)
 *  - `(NULL)` (legacy Java `String.valueOf(null)` sentinel) and a literal `null`
 *    value → unset
 *  - degenerate `null:` / empty-label tokens are dropped
 *  - only rows with a real value are returned (matches the writer's empty-drop,
 *    keeps legacy `Store Name:(NULL)|Ageing:(NULL)` noise out of the view)
 * Pure string parse — no DB round-trip — so callers (incl. the lean getByIdCore
 * hot path) pay nothing. Returns [] for null/empty/'null'.
 */
function parseCustomPropertyString(raw) {
  if (raw == null) return [];
  const s = String(raw).trim();
  if (!s || s.toLowerCase() === 'null') return [];
  const out = [];
  for (const token of s.split('|')) {
    const seg = token.trim();
    if (!seg) continue;
    const idx = seg.indexOf(':');
    if (idx === -1) continue;
    const label = seg.slice(0, idx).trim();
    let value = seg.slice(idx + 1).trim();
    if (!label || label.toLowerCase() === 'null') continue;
    if (value === '(NULL)' || value.toLowerCase() === 'null') value = '';
    if (!value) continue;
    out.push({ name: label.toLowerCase().replace(/\s+/g, ' ').trim(), label, value });
  }
  return out;
}

/*
 * Rebuild tbl_job.client_services CSV from current ACTIVE tbl_job_services
 * rows. Called from every job-services mutator (create + update + magic-link
 * acceptSubmission) so the flat legacy column stays in sync with the
 * normalized table — legacy CRM reads + reports rely on it. Querying the
 * DB rather than computing from the input payload keeps the helper robust
 * against partial updates and soft-deleted rows.
 */
async function recomputeClientServicesCsv(conn, jobId) {
  if (!jobId) return;
  const [rows] = await conn.query(
    `SELECT service_id FROM tbl_job_services
      WHERE job_id = ? AND job_service_status = 1
      ORDER BY job_service_id ASC`,
    [jobId],
  );
  const ids = rows.map((r) => Number(r.service_id))
    .filter((n) => Number.isFinite(n) && n > 0);
  const csv = ids.length > 0 ? ids.join(',') : null;
  await conn.query(
    'UPDATE tbl_job SET client_services = ? WHERE job_id = ?',
    [csv, jobId],
  );
}

// The INSERT itself (column-probe branch + the is_instruction_added invariant)
// lives in address.service — tbl_address is shared/polymorphic and every writer
// has to probe it the same way. Free-text instruction is persisted directly on
// tbl_address.address_instruction, no companion-table write needed (2026-06-04
// simplification: dropped the legacy `address_instruction` table writes in
// favour of a single column on tbl_address).
const insertAddress = addressService.insertCustomerAddress;

/*
 * Normalise the booking-time image field(s) on a create() payload into an
 * ordered, de-duplicated list of filenames (or full S3 keys).
 *
 * TWO ACCEPTED SHAPES, both optional — a caller may send either, both, or
 * neither:
 *   · `job_image_filename`  — STRING. The original, pre-2026-08 field. A
 *                             caller sending only this behaves EXACTLY as it
 *                             always has: one entry out, one row written.
 *   · `job_image_filenames` — ARRAY of strings. Added 2026-08-07 for callers
 *                             that collect several photos in one submission
 *                             (public website booking takes up to 5). Every
 *                             entry becomes a `tbl_job_image` row inside the
 *                             job's OWN transaction.
 *
 * The two are UNIONed (singular first, then the array in submission order)
 * rather than one overriding the other, so a caller that populates both can't
 * silently lose an image. Blank / non-string / whitespace-only entries are
 * dropped and exact duplicates collapse, which keeps `null`, `undefined`,
 * `''`, `[]` and `['']` all as the historical no-op.
 *
 * No cap here on purpose — the ceiling is a per-surface product decision and
 * lives in the validators (createBody caps the array at 5, matching the
 * website-booking photo limit). Silently truncating in the service would drop
 * objects already written to storage with nothing pointing at them.
 */
function normaliseJobImageFilenames(input) {
  const raw = [];
  if (input.job_image_filename != null) raw.push(input.job_image_filename);
  if (Array.isArray(input.job_image_filenames)) raw.push(...input.job_image_filenames);
  const out = [];
  for (const entry of raw) {
    if (entry == null) continue;
    const name = String(entry).trim();
    if (!name) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

// ─── Create ─────────────────────────────────────────────────────────
async function create(input, actor) {
  logger.info('Create job · clientId=' + (input.fk_client_id ?? '-') + ' · jobType=' + (input.job_type || 'Installation') + ' · initialStatus=' + (input.initial_status ?? 0) + ' · source=' + (input.source_type || 'manual') + ' · services=' + (Array.isArray(input.services) ? input.services.length : 0));
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const customerId = await upsertCustomer(conn, input.customer, actor);

    let addressId = input.address?.address_id;
    if (!addressId) {
      addressId = await insertAddress(conn, customerId, input.address, actor);
    }

    // service_type_ids: accept both the canonical name AND the
    // FE-legacy alias `fk_service_type_ids` (JobModal.tsx historically
    // sent that key). Whichever arrives, stringify as CSV for the
    // tbl_job CSV column.
    const rawServiceTypeIds = input.service_type_ids ?? input.fk_service_type_ids;
    const serviceTypeIds = Array.isArray(rawServiceTypeIds)
      ? rawServiceTypeIds.join(',')
      : (rawServiceTypeIds || null);

    // requested_time: legacy column stores the time portion as a
    // separate string. If FE didn't send it explicitly, derive from
    // requested_date_time so the column isn't NULL.
    //
    // IST-aware (2026-06-04). The previous implementation used
    // `new Date(...).toTimeString().slice(0,5)` which returns the
    // server's local-tz clock time — UTC inside our Docker
    // containers, which produced the wrong "HH:MM" (e.g. 15:00 instead
    // of the user-intended 20:30 IST). formatTimeIST() shifts to IST
    // first.
    const requestedTime = input.requested_time
      || (input.requested_date_time ? formatTimeIST(input.requested_date_time) : null);

    // requested_date_time + original_appointment_date_time time-repair
    // (2026-06-04). FE callers (Book-New-Call) sometimes send the date
    // portion as `YYYY-MM-DDT00:00:00.000Z` with the actual appointment
    // time-of-day in a separate `requested_time` field. Without this
    // combining step the DATETIME column lands as midnight which breaks
    // every downstream "running late" / scheduling calculation.
    // combineDateTime() only stitches the time in when the parsed date
    // is exactly local midnight (so an operator who DID send a real
    // time isn't silently overwritten).
    const requestedDateTime = combineDateTime(input.requested_date_time, requestedTime);

    // original_appointment_date_time/time: snapshot at create time so
    // future reschedules can preserve the original promise. Default to
    // the requested values when the operator hasn't overridden. Apply
    // the same time-repair so both columns carry the actual appointment
    // time, not midnight.
    const originalApptDt   = combineDateTime(
      input.original_appointment_date_time || input.requested_date_time || null,
      input.original_appointment_time || requestedTime,
    );
    const originalApptTime = input.original_appointment_time      || requestedTime || null;

    // collected_by: per-job preference. Integer enum (1=Easyfixer,
    // 2=Easyfix, 3=Client) — accept numbers or numeric strings from the FE.
    //
    // A NON-numeric string (e.g. a label like 'Easyfix' the FE forgot to code)
    // must fall to NULL, NOT be written verbatim: the column is INT, so MySQL
    // silently coerces 'Easyfix' → 0, and 0 = "Any" blocks the job from ever
    // checking out. NULL is an honest "unset" and doesn't masquerade as a real
    // choice. (The FE codes this correctly; this is defence against the next
    // caller that doesn't — a real bug shipped exactly this way, see the Book
    // New Call per-tab override in JobModal.)
    let collectedBy = null;
    if (input.collected_by != null && input.collected_by !== '') {
      const n = Number(input.collected_by);
      collectedBy = Number.isFinite(n) ? n : null;
    }

    // Resolve the effective initial status once so the OTP gate below
    // and the eta_status default both branch off the same value.
    const effectiveStatus = [STATUS.ENQUIRY, STATUS.CALL_LATER].includes(Number(input.initial_status))
      ? Number(input.initial_status)
      : STATUS.BOOKED;

    // eta_status: legacy 2-char sentinel. Per JobDaoImpl#2387 "01" is
    // the unconfirmed default; once a job is promoted to BOOKED via
    // eta_status (reverted 2026-06-05 per ops): default to '01'
    // unconditionally across every create path. Book-New-Call,
    // C&S sibling fan-out, and direct-to-ENQUIRY all land as '01'
    // — the legacy default that the rest of the platform expects.
    // If a future flow needs to override (e.g. a "confirmed" sentinel
    // like '02' for a different lifecycle stage), the caller passes
    // input.eta_status explicitly; the BE no longer infers from status.
    const etaStatus = input.eta_status ?? '01';

    /*
     * Job OTP (2026-05-28). Legacy CRM (JobDaoImpl.java:4418) stamps
     * `tbl_job.otp` at check-in time via `saveCheckInJob`. Ops moved the
     * stamping forward to ORDER-CONFIRMATION so the customer can be
     * informed of the code earlier in the cycle. The technician then
     * verifies the code at start-of-job (check-in) as before.
     *
     * Rules:
     *   - Generate only when the job lands in BOOKED (status=0).
     *     Direct-to-ENQUIRY (7) / direct-to-CALL_LATER (9) bookings
     *     skip — those aren't confirmed orders yet.
     *   - 4-digit cryptographically-random (utils/otp.js::generateOtp),
     *     stored as STRING (legacy column is varchar-ish; we match).
     *   - Conditionally included in INSERT when the `otp` column
     *     exists on this deploy (column-probed, cached). Older DBs
     *     without it gracefully degrade — no OTP stored but the
     *     booking still lands.
     */
    const withOtpColumn = await hasOtpColumn();
    const shouldStampOtp = withOtpColumn && effectiveStatus === STATUS.BOOKED;
    const jobOtp = shouldStampOtp ? String(generateOtp()) : null;

    /*
     * job_client_owner auto-resolution (2026-06-04). When the caller
     * doesn't pass an explicit owner, we look up the client's Primary
     * SPOC from tbl_vertical_mapping (user_type=1 = Primary per the
     * legacy CRM convention). Doing this server-side rather than
     * forcing every caller (Book-New-Call, mobile, integration) to
     * fetch + send the same value keeps the rule in one place and
     * survives clients who don't know the SPOC model.
     *
     * status filter tolerates NULL (older mappings predate the column)
     * and 1 (active). Inactive mappings are skipped.
     */
    let resolvedJobClientOwner = input.job_client_owner;
    if ((resolvedJobClientOwner == null || resolvedJobClientOwner === '') && input.fk_client_id) {
      try {
        /* The SAME lookup job_primary_spoc is stamped from — see
         * resolveClientPrimarySpoc. The two must not drift: they describe one
         * person, and this row writes both columns. */
        const uid = Number(await resolveClientPrimarySpoc(input.fk_client_id, conn));
        if (Number.isFinite(uid) && uid > 0) resolvedJobClientOwner = uid;
      } catch (e) {
        // Non-fatal — leave null and let the booking proceed.
        require('../logger').warn(
          { clientId: input.fk_client_id, err: e.message },
          'Primary-SPOC lookup failed for job_client_owner (continuing with null)',
        );
      }
    }

    /*
     * job_reference_id resolution (2026-06-04, format confirmed by ops:
     * `REF-{job_id}`).
     *
     * The legacy format embeds the AUTO_INCREMENT job_id, so the value
     * can only be computed AFTER the INSERT completes. The flow:
     *   1. Resolve a PRE-INSERT value here. If caller supplied an
     *      explicit `input.job_reference_id` OR opted into the legacy
     *      reuse-of-client_ref via `input.reuse_client_ref = true`,
     *      bind that value during the original INSERT and skip the
     *      post-INSERT formatter step.
     *   2. Otherwise bind NULL during INSERT, capture `jobId =
     *      ins.insertId`, then UPDATE the row with
     *      `formatJobReferenceId(jobId)` → `REF-{jobId}`. Both writes
     *      live inside the same open transaction so they commit
     *      atomically.
     */
    const { formatJobReferenceId } = require('../utils/job-reference');
    const callerProvidedRef =
      input.job_reference_id
      || (input.reuse_client_ref && input.client_ref_id ? input.client_ref_id : null);
    const jobReferenceId = callerProvidedRef ?? null; // INSERTed as-is; null → auto-fill below

    // Build INSERT shape — `otp` column is appended ONLY when present
    // on the deploy. Two paths to keep the column list + placeholder
    // count + values array perfectly aligned (mismatched lengths here
    // produced silent NULL writes pre-refactor in some legacy ports).
    // Normalise Branch Details to the dedicated column across ALL booking
    // surfaces. The CRM sends `branch_details` directly, but the client web/
    // mobile apps fold every custom prop (incl. branch) into the flattened
    // `custom_property` string. If branch_details wasn't set but a branch token
    // is present in custom_property, hoist its value into branch_details and
    // strip it from the string so reports/views reading tbl_job.branch_details
    // stay consistent regardless of where the job was booked.
    //
    // Multi-category sibling inheritance (2026-08-11): when this create is a
    // sibling in a booking family (the FE fan-out passes the FIRST sibling's id
    // as primary_job_id), inherit the parent's flattened custom_property when
    // the caller didn't send one. CRM bookings usually leave custom_property
    // null (props live in dedicated columns), so this is a no-op there; it
    // matters for families whose parent DID carry a value. Runs BEFORE the
    // branch-hoist so an inherited branch token is normalised too. Owner + SPOC
    // already flow via job_owner. Read via pool — the parent committed in an
    // earlier request.
    const primaryJobId = Number(input.primary_job_id) > 0 ? Number(input.primary_job_id) : null;
    if (primaryJobId
        && (input.custom_property == null
            || String(input.custom_property).trim() === ''
            || input.custom_property === 'null')) {
      try {
        const [[parentRow]] = await pool.query(
          'SELECT custom_property FROM tbl_job WHERE job_id = ? LIMIT 1', [primaryJobId],
        );
        const parentCp = parentRow && parentRow.custom_property;
        if (parentCp != null && String(parentCp).trim() !== '' && parentCp !== 'null') {
          input.custom_property = parentCp;
        }
      } catch (_e) { /* best-effort — leave custom_property as-is */ }
    }

    if ((input.branch_details == null || String(input.branch_details).trim() === '') && input.custom_property) {
      const isBranchKey = (s) => {
        const k = String(s || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
        return k === 'branch' || k === 'branch details';
      };
      const decoded = parseCustomPropertyString(input.custom_property);
      const hit = decoded.find((p) => isBranchKey(p.name) || isBranchKey(p.label));
      if (hit && hit.value) {
        input.branch_details = hit.value;
        const rest = decoded.filter((p) => p !== hit).map((p) => `${p.label || p.name}:${p.value}`);
        input.custom_property = rest.length ? rest.join('|') : null;
      }
    }

    // Server-side mandatory enforcement for Branch Details (belt-and-braces over
    // the FE gate — blocks API-direct / tampered / bulk bookings that skip it).
    // Fires ONLY for clients configured branch-mandatory in Manage Clients (a
    // mandatory `branch_details` custom-property row), so every other client and
    // non-branch flow is untouched. Runs AFTER the hoist above, so a branch value
    // supplied via the custom_property string already satisfies it.
    // The mobile Client App does not collect custom properties at all, so the
    // branch-mandatory gate can never be satisfied there — skip it for that
    // surface only. CRM / client-web bookings keep the enforcement.
    const isClientApp = String(input.source_type || '').toLowerCase() === 'client_app';
    if (!isClientApp && input.fk_client_id && (input.branch_details == null || String(input.branch_details).trim() === '')) {
      let clientProps = [];
      try {
        clientProps = await require('./client.service').listCustomProperties(input.fk_client_id);
      } catch (_e) { clientProps = []; }
      const isBranchKey = (s) => {
        const k = String(s || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
        return k === 'branch' || k === 'branch details';
      };
      const truthy = (v) => v === 1 || v === '1' || v === true || String(v).toLowerCase() === 'true';
      const branchRow = clientProps.find((r) => isBranchKey(r.property_name ?? r.c_prop_name ?? r.name));
      if (branchRow && truthy(branchRow.is_mandatory ?? branchRow.c_prop_mandatory ?? branchRow.mandatory ?? branchRow.required)) {
        const err = new Error('Branch Details is required for this client.');
        err.status = 400; err.code = 'BRANCH_DETAILS_REQUIRED';
        throw err;
      }
    }

    const sharedCols = `
         job_desc, fk_customer_id, fk_address_id, fk_client_id,
         fk_service_type_id, fk_service_catg_id, service_type_ids,
         reporting_contact_id,
         requested_date_time, requested_time, time_slot, booking_cut_off_time_slot,
         created_date_time, ticket_created_date_time,
         fk_created_by, job_status, job_owner, job_client_owner,
         job_type, source_type, client_ref_id, job_reference_id,
         job_customer_name, client_spoc, client_spoc_name, client_spoc_email,
         additional_name, additional_number,
         collected_by, eta_status,
         original_appointment_date_time, original_appointment_time,
         helper_req, remarks, efr_special_notes, branch_details,
         custom_property,
         last_update_time
    `;
    const sharedValues = [
        input.job_desc || '', // job_desc is NOT NULL in tbl_job; default to empty string
        customerId, addressId, input.fk_client_id,
        input.fk_service_type_id || null, input.fk_service_catg_id || null, serviceTypeIds,
        input.reporting_contact_id || null,
        requestedDateTime, requestedTime,
        // time_slot is ALWAYS one of the four broad bands. The appointment time
        // decides it (the band CONTAINING requested_date_time) — a caller-sent
        // label only matters for a date-only booking, where it is canonicalised
        // rather than stored verbatim. That is what stops a 1-hour frame label
        // (or any of the ~12 legacy vocabularies) from landing in the column.
        // booking_cut_off_time_slot stays on its own legacy "H AM - H PM"
        // derivation — nothing matches on it.
        resolveTimeSlot(input.time_slot, requestedDateTime),
        input.booking_cut_off_time_slot || deriveBookingCutoffSlot(requestedDateTime),
        new Date(), new Date(),
        // fk_created_by (2026-06-04): explicit Number() coercion. JWT
        // claims encode `user_id` as a string (see CLAUDE.md "Auth
        // reality") and tbl_job.fk_created_by is INT. MySQL DOES
        // implicitly coerce numeric strings on INSERT, but if a
        // future JWT issuer accidentally ships a non-numeric subject
        // (or an integration caller passes `actor` from a different
        // identity shape) the implicit coercion silently writes 0 or
        // NULL. Number()-coerce + falsy guard makes the binding
        // explicit and matches the runtime intent.
        (() => { const n = Number(actor?.user_id); return Number.isFinite(n) && n > 0 ? n : null; })(),
        // initial_status — legacy footer-button parity. Defaults to
        // BOOKED (0); operators can pick ENQUIRY (7) or CALL_LATER (9)
        // at the booking modal's footer to route the new row to the
        // appropriate dashboard bucket without an extra status-change
        // call. Validation: only allow the three known codes; anything
        // else falls through to BOOKED so a typo can't accidentally
        // mark a job COMPLETED.
        effectiveStatus,
        /*
         * job_owner precedence: an explicit owner, else the CRM operator who
         * placed the booking, else the client's Primary SPOC.
         *
         * That last arm is new (2026-08-26). Website, Website Bot and partner
         * API bookings have NO acting operator, so they fell straight to null
         * and landed in nobody's queue — measured on QA: 173 of 185 'website'
         * jobs, and every 'partner API' and 'integration_v2' row. Operator-placed
         * bookings are untouched: the actor still wins, and CRM / manual / excel
         * sources already show zero missing owners.
         *
         * resolvedJobClientOwner is the same Primary SPOC job_client_owner gets,
         * resolved a few lines above — so an unattended booking now belongs to
         * the person who owns that client, rather than to no one. It is still a
         * FALLBACK, not a merge: the two columns keep their distinct meanings
         * wherever a real operator exists.
         */
        input.job_owner || actor?.user_id || resolvedJobClientOwner || null,
        resolvedJobClientOwner ?? null,
        input.job_type || 'Installation', input.source_type || 'manual',
        // job_reference_id (2026-06-03 per ops): the legacy DB column
        // ops queries for the family-reference id. Falls back to
        // `client_ref_id` when the caller didn't send a dedicated
        // `job_reference_id` — the new-CRM FE sends `client_ref_id`
        // for the cross-job family tag, and ops want the same value
        // reflected here so existing reports stay coherent. When the
        // FE sends BOTH explicitly, the explicit `job_reference_id`
        // wins (preserves backwards-compat with any caller that
        // distinguishes them).
        input.client_ref_id || null,
        jobReferenceId,
        // job_customer_name (2026-06-04): prefer the top-level
        // `job_customer_name` when the caller explicitly supplies it,
        // falling back to the nested customer.customer_name.
        //
        // Why both: tbl_job.job_customer_name is a per-job override of
        // tbl_customer.customer_name (see UPDATE-flow comment at the
        // 'job_customer_name' entry in MUTABLE_COLUMNS). Some FE flows
        // pass the per-job name distinct from the customer-master
        // name; routing both through `customer.customer_name` would
        // silently overwrite the master. Accepting both shapes keeps
        // siblings created from Confirm & Schedule (which now sends
        // an explicit top-level job_customer_name) from landing as
        // NULL when the form state happens to clear customer.customer_name.
        input.job_customer_name ?? input.customer?.customer_name ?? null,
        input.client_spoc || null, input.client_spoc_name || null, input.client_spoc_email || null,
        input.additional_name || null, input.additional_number || null,
        collectedBy, etaStatus,
        originalApptDt, originalApptTime,
        input.helper_req ? 1 : 0,
        // remarks: still composed via composeRemarks because
        // product_code + building_name don't exist as columns
        // (only branch_details was verified). They get folded into
        // remarks with named prefixes.
        composeRemarks(input),
        // efr_special_notes: dedicated column for technician-facing
        // notes; optional at booking time, also writable via update.
        input.efr_special_notes || null,
        // branch_details: dedicated column on tbl_job.
        input.branch_details || null,
        // custom_property (2026-06-04): legacy varchar(510) column.
        // The schema carries a DEFAULT of the literal 4-char string
        // 'null' (a relic of legacy Java's `String.valueOf(null)` →
        // "null" stringification path). Omitting the column from the
        // INSERT lets that bad default land, producing the
        // operator-visible "null text instead of NULL" symptom. We
        // bind explicit SQL NULL here so mysql2 overrides the schema
        // default. Accept caller-supplied input.custom_property for
        // forwards-compat with any integration that legitimately uses
        // the field (none do today), still coercing falsy/string
        // "null" to real NULL.
        (input.custom_property && input.custom_property !== 'null')
          ? input.custom_property
          : null,
        new Date(),
    ];
    const insertSql = jobOtp != null
      ? `INSERT INTO tbl_job (${sharedCols.trim()}, otp)
         VALUES (${sharedValues.map(() => '?').join(', ')}, ?)`
      : `INSERT INTO tbl_job (${sharedCols.trim()})
         VALUES (${sharedValues.map(() => '?').join(', ')})`;
    const insertValues = jobOtp != null ? [...sharedValues, jobOtp] : sharedValues;
    const [ins] = await conn.query(insertSql, insertValues);
    const jobId = ins.insertId;

    /*
     * job_reference_id auto-fill (2026-06-04). When the caller didn't
     * supply an explicit ref AND didn't opt into reuse_client_ref, the
     * INSERT above bound NULL for job_reference_id. Now that we have
     * the AUTO_INCREMENT job_id, format the legacy `REF-{job_id}`
     * value and patch the row in the same open transaction. The two
     * statements commit atomically.
     */
    if (callerProvidedRef == null) {
      const autoRef = formatJobReferenceId(jobId);
      if (autoRef) {
        await conn.query(
          'UPDATE tbl_job SET job_reference_id = ? WHERE job_id = ?',
          [autoRef, jobId],
        );
      }
    }

    // Snapshot WHICH USER is the client's vertical head into job_primary_spoc
    // (legacy-compat; no-op where the column is absent). The client id is
    // passed rather than re-read from tbl_job inside the helper: it is the
    // exact value the INSERT above just bound, so a re-read would only spend a
    // query to learn what we already know. A client-less job stamps NULL.
    await stampJobPrimarySpoc(jobId, input.fk_client_id || null, conn);

    /*
     * Freeze whether this job is LOCAL or TRAVEL — i.e. whether any active,
     * verified technician covers its pincode right now.
     *
     * This does NOT wire TAT into job creation: the dependency is on
     * pincode-coverage.service, a general platform fact ("is this pincode
     * serviceable?") that also drives Settings → Manage Pincodes. The TAT
     * engine happens to be its first consumer; nothing here knows about
     * segments, targets or scores.
     *
     * It is frozen because coverage CHANGES. Onboarding a technician into an
     * area would otherwise retroactively re-classify every past job there, and
     * a scorecard nobody can reproduce is not a scorecard.
     *
     * Fire-and-forget, outside the transaction's success path: a job must never
     * fail to be created because a reporting snapshot could not be written. A
     * missing row simply falls back to live classification.
     */
    stampJobLocality(jobId, input.pin_code || null);

    if (Array.isArray(input.services) && input.services.length > 0) {
      // Batch-load rate-card rows for all picked services in ONE query
      // (avoids N+1) — then compute the 5 charge columns per row via
      // the shared cascade helper. See utils/rate-card-calc.js for the
      // formula (sequential variable→fixed per layer; bundles overhead
      // into easyfix_charge to preserve sum-to-total invariant).
      const { loadRateCardRows, computeJobServiceCharges } = require('../utils/rate-card-calc');
      const rateCardById = await loadRateCardRows(conn, input.services.map((s) => s.service_id));

      /*
       * Stamp audit `created_by` (or legacy `fk_created_by`) on every
       * tbl_job_services row so post-mortems can trace who booked the
       * line item. Probed once per process — older deploys without
       * either column degrade gracefully to the unaugmented column set
       * (no failure, just no audit field).
       */
      const createdByCol = await jobServicesCreatedByColumn();
      const actorId = actor?.user_id || null;

      // Single multi-row INSERT instead of N sequential round-trips. Only wins
      // for jobs with 3+ services but costs nothing for smaller sets.
      const values = input.services.map((svc) => {
        const ch = computeJobServiceCharges(rateCardById.get(Number(svc.service_id)), svc.quantity || 1);
        const row = [
          jobId, svc.service_id, svc.quantity || 1,
          svc.service_type_id || null, svc.service_category_id || null, 1,
          ch.total_charge, ch.total_cost,
          ch.client_charge, ch.easyfix_charge, ch.easyfixer_charge,
        ];
        if (createdByCol) row.push(actorId);
        return row;
      });
      const insertCols = createdByCol
        ? `(job_id, service_id, quantity, service_type_id, service_category_id, job_service_status,
            total_charge, total_cost, client_charge, easyfix_charge, easyfixer_charge, ${createdByCol})`
        : `(job_id, service_id, quantity, service_type_id, service_category_id, job_service_status,
            total_charge, total_cost, client_charge, easyfix_charge, easyfixer_charge)`;
      await conn.query(
        `INSERT INTO tbl_job_services ${insertCols} VALUES ?`,
        [values]
      );
      // Mirror onto tbl_job.client_services CSV — single source of truth
      // via the helper so every services mutator stays in sync.
      await recomputeClientServicesCsv(conn, jobId);
    }

    /*
     * Optional booking-time image(s).
     *
     * 2026-05-14: the canonical CRM job-image upload moved to the
     * dedicated endpoint `POST /admin/jobs/:id/images` which writes
     * to S3 at Job_Images/<jobId>_<seq>. The CRM frontend uses that
     * endpoint as a SECOND step after this create() commits.
     *
     * 2026-08-07: this branch now takes N images, not one. It accepts
     * BOTH the original scalar `job_image_filename` and the new array
     * `job_image_filenames` (see normaliseJobImageFilenames above for
     * the exact union/dedupe rules). The reason is atomicity: the
     * public website booking accepts up to five photos, and inserting
     * 2..N *after* create() returned meant a failure between COMMIT and
     * those inserts left objects in S3 with no row pointing at them.
     * Every row now lands inside the job's own transaction, so the
     * booking and its photos survive or roll back together.
     *
     * ONE round trip regardless of N — a multi-row VALUES list rather
     * than a loop of queries. The per-row column set and bound values
     * are UNCHANGED from the single-image version (job_id, image,
     * image_category='booking', job_stage=0, created_date=NOW()), so a
     * caller sending only the scalar emits byte-identical SQL to
     * before. `status` stays out of the column list deliberately:
     * tbl_job_image.status is `int NULL DEFAULT 1`, and every existing
     * image_category='booking' row carries status 1, so omitting it
     * yields the same data. (routes/integration/v1/index.js names the
     * column explicitly; that is the odd one out, not this.)
     */
    const jobImageFilenames = normaliseJobImageFilenames(input);
    if (jobImageFilenames.length > 0) {
      await conn.query(
        `INSERT INTO tbl_job_image (job_id, image, image_category, job_stage, created_date)
         VALUES ${jobImageFilenames.map(() => '(?, ?, ?, ?, NOW())').join(', ')}`,
        jobImageFilenames.flatMap((name) => [jobId, name, 'booking', 0])
      );
    }

    await conn.commit();
    logger.info('Job created · id=' + jobId + ' · status=' + effectiveStatus);

    // 'new job' in tbl_job_logs — the same row the legacy CRM writes at the end
    // of createJob(). Post-commit and on the shared pool, never `conn`.
    await jobLog.logNewJob(jobId, actor);

    /*
     * Flag-based auto-assignment on job creation.
     *
     * Setting: tbl_autoallocation_setting.running_frequency (per-client via
     * tbl_client_setting). Values:
     *   'instant'  → run the 3-layer pipeline now, assign the top candidate
     *   'schedule' (default) → do nothing; a daily batch picks it up instead
     *
     * Fire-and-forget via setImmediate so the create API returns the new
     * job row immediately — auto-assign happens in the background and
     * the subsequent assign() call takes care of status bump + scheduling
     * history + TechAssigned webhook + FCM push to the chosen technician.
     *
     * Errors are logged, not bubbled: a failed auto-assign should never
     * roll back a successfully-created job.
     */
    setImmediate(() => {
      tryAutoAssignOnCreate(jobId, input.fk_client_id, actor).catch((err) => {
        const logger = require('../logger');
        logger.warn(`Auto-assign on create failed for job ${jobId}: ${err.message}`);
      });
      // Best-effort, post-commit: add this job's pincode to the pincode catalog
      // (geocoded) if it's new. Idempotent + never throws — see ensureJobPincode.
      ensureJobPincode(input.address?.pin_code, actor);
      // Best-effort, post-commit: record the multi-category family link
      // (parent→child) in the legacy `linked_job` table so tooling that reads it
      // sees the sibling relationship. Guarded (table may be absent on QA) +
      // never throws — see linkJobToParent.
      if (Number(input.primary_job_id) > 0 && Number(input.primary_job_id) !== jobId) {
        linkJobToParent(Number(input.primary_job_id), jobId);
      }
    });
    // NOTE: enquiry WhatsApp is intentionally NOT fired here for a direct
    // book-as-ENQUIRY (initial_status=7). create() never stamps
    // enquiry_reason_id, so this path would send a blank-reason template; and
    // legacy only notified on the "mark as Enquiry" transition. The CRM books
    // at BOOKED(0) then transitions via setStatus(7) — see the setStatus hook.

    return getById(jobId);
  } catch (e) {
    await conn.rollback();
    logger.error('Create job failed, rolled back · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }
}

// ─── Update ─────────────────────────────────────────────────────────
const MUTABLE_COLUMNS = [
  'job_desc', 'job_type', 'source_type',
  'requested_date_time', 'requested_time', 'time_slot', 'expected_date_time',
  'job_owner', 'job_client_owner',
  'fk_client_id', 'fk_service_type_id', 'fk_service_catg_id',
  // service_type_ids (2026-06-05): CSV column carrying every picked
  // service_type_id on a multi-pick job. Kept in sync with the
  // singular fk_service_type_id by FE call sites (Book-New-Call
  // basePayload, C&S sibling POST, C&S parent PATCH). Array input
  // is normalised to a comma-joined string inside the update() loop
  // — mirrors the create()-flow serviceTypeIds normalisation.
  'service_type_ids',
  'reporting_contact_id', 'client_spoc', 'client_spoc_name', 'client_spoc_email',
  'additional_name', 'additional_number',
  'collected_by',
  'original_appointment_date_time', 'original_appointment_time',
  'client_ref_id', 'job_reference_id',
  'helper_req', 'remarks', 'efr_special_notes',
  // job_customer_name — Confirm-mode edits write to this job-row
  // copy of the customer name instead of mutating the master
  // tbl_customer.customer_name. Lets the same mobile carry a
  // different per-job display name (legacy parity + the new bulk-
  // upload flow where the sheet supplies a name distinct from the
  // master record).
  'job_customer_name',
  'exp_tat', 'booking_cut_off_time', 'booking_cut_off_time_slot',
  // branch_details — verified to exist on tbl_job in prod
  // (INFORMATION_SCHEMA returned 1 row 2026-05-14, VARCHAR(255)
  // NULLABLE). Promoted off composeRemarks() to a dedicated column.
  // product_code / building_name DO NOT exist in prod; they're still
  // folded into the `remarks` column with named prefixes (see
  // composeRemarks above).
  'branch_details',
  /*
   * eta_status DELIBERATELY OMITTED — per direction 2026-05-25, the
   * BE writes '01' only on Book Call (the create flow). Update paths
   * must never touch it. Status transitions through the mobile /eta
   * endpoint use STATUS_EXTRAS_ALLOWLIST separately. If you find
   * yourself wanting to add eta_status here, talk to ops first.
   */
];

async function update(jobId, input, actor) {
  logger.info('Update job · id=' + jobId + ' · services=' + (Array.isArray(input.services) ? 'yes' : 'no') + ' · customer=' + (input.customer ? 'yes' : 'no') + ' · address=' + (input.address ? 'yes' : 'no'));
  const existing = await getById(jobId);
  if (!existing) {
    logger.warn('Update job not found · id=' + jobId);
    const err = new Error('job not found'); err.status = 404; throw err;
  }
  const sets = [];
  const values = [];
  // Track which columns are actually being changed so we can decide
  // whether to bump `last_update_time` below. Comment-like fields
  // (remarks, efr_special_notes) are excluded from the bump — they're
  // narrative additions, not structural edits, and downstream consumers
  // like the FE "Draft" indicator on Unconfirmed jobs use the timestamp
  // to detect Save-Draft progress. If a remarks-only edit ticked the
  // timestamp, every Add-Remarks click would falsely mark the row as a
  // draft. Comments have their own audit trail in tbl_job_comment.
  const changedCols = [];
  /*
   * Date/time projection (2026-06-05). create() runs every datetime
   * input through combineDateTime() so the DATETIME columns land as
   * `'YYYY-MM-DD HH:MM:SS'` IST literals (not the JS-Date default of
   * UTC ISO with a `Z` suffix, which legacy MySQL reports parse as
   * the wrong wall-clock). PATCH must apply the same transform —
   * otherwise C&S confirms write the raw ISO into a DATETIME column
   * and the time portion is lost / mis-stored. Same helper set:
   *   - combineDateTime  → MySQL DATETIME string in IST
   *   - formatTimeIST    → "HH:MM" string in IST for the legacy
   *                         requested_time / original_appointment_time
   *                         text columns
   * `requested_time` is derived from `requested_date_time` when the
   * caller doesn't pass it explicitly (mirrors create()).
   */
  const DATETIME_COLS = new Set([
    'requested_date_time', 'expected_date_time', 'original_appointment_date_time',
  ]);
  const TIME_COLS = new Set([
    'requested_time', 'original_appointment_time',
  ]);
  // Derive requested_time from requested_date_time if FE didn't send it
  // alongside (legacy companion column). Only fills if requested_time
  // is undefined in input — never overwrites an explicit value.
  if (input.requested_date_time !== undefined && input.requested_time === undefined) {
    input.requested_time = formatTimeIST(input.requested_date_time);
  }
  /*
   * time_slot is a BAND, never the 1-hour frame the picker offers (see
   * services/time-slot.js). PATCH is a live slot writer — the Confirm &
   * Schedule modal edits the appointment through here — so the same
   * writer-side gate create()/assign()/reschedule() use applies. Normalised
   * against the SAME datetime projection the SET loop below will store, so the
   * two columns can never disagree.
   *
   * ⚠ ONLY ON A REAL EDIT. JobModal sends `requested_date_time` AND `time_slot`
   * on EVERY non-outcome PATCH, touched or not — so re-deriving unconditionally
   * turned an open-and-save-nothing into a silent slot rewrite: a job holding
   * the legacy 'Morning 9 to 2' at 10:00 came back as '9AM to 12PM', narrowing a
   * 5-hour promise to a 3-hour one with no operator action. That breaks the
   * backward-compatibility contract both new modules state as mandatory
   * (src/lib/job-slots.ts: "an untouched open-and-save must persist it
   * unchanged"; JobModal's load-time heal deliberately leaves a non-empty slot
   * alone for the same reason).
   *
   * So we compare against what is STORED and re-derive only when the caller
   * actually moved the appointment or actually picked a different slot. A
   * no-op save drops time_slot out of the patch entirely — the column is not
   * even written. Historical rows are never migrated by a side effect.
   */
  if (input.time_slot !== undefined || input.requested_date_time !== undefined) {
    const projectedDt = input.requested_date_time !== undefined
      ? combineDateTime(input.requested_date_time, null)
      : null;
    // Both stored values come back from getById() as IST wall-clock literals
    // (dateStrings:true). Compared to MINUTE precision: no picker in the app
    // emits seconds, but legacy rows carry them, and a stray ':30' must not read
    // as "the operator moved the appointment".
    const toMinute   = (v) => (v ? String(v).slice(0, 16) : null);
    const storedDt   = existing.requested_date_time ? String(existing.requested_date_time) : null;
    const storedSlot = existing.time_slot == null ? '' : String(existing.time_slot).trim();
    const dtMoved    = projectedDt != null && toMinute(projectedDt) !== toMinute(storedDt);
    const slotPicked = input.time_slot !== undefined
      && String(input.time_slot ?? '').trim() !== storedSlot;
    if (dtMoved) {
      // The appointment moved: the band is a function of the time, so it moves
      // with it and any label the caller echoed is discarded.
      const band = resolveTimeSlot(input.time_slot, projectedDt);
      if (band != null) input.time_slot = band;
    } else if (slotPicked) {
      // The operator deliberately picked a DIFFERENT slot without moving the
      // appointment. Honour that pick — canonicalised where we can read it,
      // verbatim otherwise. Deriving from the (unchanged) stored datetime here
      // would store neither what they picked nor what was there.
      const band = resolveTimeSlot(input.time_slot, null);
      if (band != null) input.time_slot = band;
    } else if (input.time_slot !== undefined) {
      // Untouched echo of the stored value — leave the column entirely alone.
      delete input.time_slot;
    }
  }
  for (const col of MUTABLE_COLUMNS) {
    if (input[col] !== undefined) {
      sets.push(`${col} = ?`);
      let v = input[col];
      if (DATETIME_COLS.has(col)) v = combineDateTime(v, null);
      else if (TIME_COLS.has(col)) v = formatTimeIST(v) ?? v;
      /*
       * CSV columns (2026-06-05): tbl_job.service_type_ids stores a
       * comma-separated list. FE callers may send it as either an
       * array OR an already-joined string — coerce to string here
       * so the SET clause binds a scalar VARCHAR. Empty array →
       * NULL (an empty CSV is meaningless). Mirrors the
       * `serviceTypeIds` normalisation inside create().
       */
      else if (col === 'service_type_ids') {
        if (Array.isArray(v)) v = v.length > 0 ? v.join(',') : null;
        else v = (v == null || v === '') ? null : String(v);
      }
      values.push(v);
      changedCols.push(col);
    }
  }

  const hasServicesEdit = Array.isArray(input.services);
  const hasCustomerEdit = input.customer && typeof input.customer === 'object' && Object.keys(input.customer).length > 0;
  const hasAddressEdit  = input.address  && typeof input.address  === 'object' && Object.keys(input.address).length  > 0;

  // Early-exit only when NOTHING is being touched.
  if (sets.length === 0 && !hasServicesEdit && !hasCustomerEdit && !hasAddressEdit) return existing;

  /*
   * Structural-change detector. Bumps last_update_time only when one of
   * the following is true:
   *   - At least one MUTABLE column other than `remarks`/`efr_special_notes`
   *   - Services were edited (add/remove rows)
   *   - Customer was edited
   *   - Address was edited
   * Remarks-only / efr_special_notes-only edits intentionally skip the
   * timestamp bump (rationale above). Service/customer/address edits
   * trigger their own timestamp bumps later in this function but the
   * scalar UPDATE branch needs the gate here.
   */
  const COMMENT_ONLY_COLS = new Set(['remarks', 'efr_special_notes']);
  const isStructuralEdit =
    changedCols.some((c) => !COMMENT_ONLY_COLS.has(c))
    || hasServicesEdit
    || hasCustomerEdit
    || hasAddressEdit;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    if (sets.length > 0) {
      if (isStructuralEdit) {
        // created_date_time = the Book-Now moment. PUT/PATCH /:id is ONLY the
        // booking-form submit — reschedule / assign / status / owner / hold each
        // have their own route that never reaches update() — so re-stamping it
        // here means "when the order was (re)booked". For a bulk-uploaded row
        // that is when ops actually confirms it via Confirm & Schedule (also a
        // PATCH /:id); its ticket_created_date_time stays the upload time.
        // Gated on a STRUCTURAL edit, exactly like last_update_time: a
        // remarks-only quick-note is not a booking and must move neither stamp.
        const bookedAt = new Date();
        sets.push('last_update_time = ?', 'created_date_time = ?');
        const scalarValues = [...values, bookedAt, bookedAt, jobId];
        await conn.query(`UPDATE tbl_job SET ${sets.join(', ')} WHERE job_id = ?`, scalarValues);
      } else {
        // Comment-only path — write the remarks/efr_special_notes without
        // touching last_update_time.
        const scalarValues = [...values, jobId];
        await conn.query(`UPDATE tbl_job SET ${sets.join(', ')} WHERE job_id = ?`, scalarValues);
      }
    }

    /*
     * job_reference_id back-fill on update (2026-06-06).
     *
     * Jobs created by the legacy Client Dashboard / bulk-upload /
     * integration callers landed without a `job_reference_id` (those
     * code paths predate the 2026-06-04 `REF-{job_id}` auto-gen
     * convention). When ops promotes such a row to BOOKED via the
     * Confirm & Schedule modal (the standard "Book Call" path), the
     * caller-supplied PATCH typically doesn't include job_reference_id
     * — so the column stays NULL forever.
     *
     * Fix: AFTER the scalar UPDATE lands, if the row's current
     * job_reference_id is NULL/empty AND the caller didn't supply
     * one in this PATCH, backfill `REF-{jobId}` in the same open
     * transaction. The conditional WHERE clause makes this safe to
     * run on already-populated rows (no-op).
     *
     * Skipped when the caller explicitly passed `job_reference_id`
     * in `input` — preserves backward-compat with integration
     * callers minting their own ref ids.
     */
    if (input.job_reference_id === undefined) {
      const existingRef = String(existing.job_reference_id || '').trim();
      if (!existingRef) {
        const { formatJobReferenceId } = require('../utils/job-reference');
        const autoRef = formatJobReferenceId(jobId);
        if (autoRef) {
          await conn.query(
            `UPDATE tbl_job
                SET job_reference_id = ?
              WHERE job_id = ?
                AND (job_reference_id IS NULL OR TRIM(job_reference_id) = '')`,
            [autoRef, jobId],
          );
        }
      }
    }

    /*
     * Customer update — resolves tbl_customer row from job.fk_customer_id.
     * Only the editable fields (name, email) are accepted; mobile is the
     * key and treated as immutable here (callers must use the dedicated
     * customer swap flow if they truly need a different number).
     */
    if (hasCustomerEdit && existing.fk_customer_id) {
      const custSets = [];
      const custVals = [];
      if (input.customer.customer_name  !== undefined) { custSets.push('customer_name = ?');  custVals.push(input.customer.customer_name); }
      if (input.customer.customer_email !== undefined) { custSets.push('customer_email = ?'); custVals.push(input.customer.customer_email || null); }
      if (custSets.length > 0) {
        custVals.push(existing.fk_customer_id);
        await conn.query(`UPDATE tbl_customer SET ${custSets.join(', ')} WHERE customer_id = ?`, custVals);
      }
    }

    /*
     * Address update — resolves tbl_address row from job.fk_address_id.
     * Full field set (line, building, landmark, city, pin, GPS). For the
     * Unconfirmed → Scheduled flow ops may clean up a bulk-imported address
     * before confirming, so every column is editable here.
     */
    if (hasAddressEdit && existing.fk_address_id) {
      const addrSets = [];
      const addrVals = [];
      if (input.address.address      !== undefined) { addrSets.push('address = ?');      addrVals.push(input.address.address); }
      if (input.address.building     !== undefined) { addrSets.push('building = ?');     addrVals.push(input.address.building || null); }
      if (input.address.landmark     !== undefined) { addrSets.push('landmark = ?');     addrVals.push(input.address.landmark || null); }
      if (input.address.city_id      !== undefined) { addrSets.push('city_id = ?');      addrVals.push(input.address.city_id); }
      if (input.address.pin_code     !== undefined) { addrSets.push('pin_code = ?');     addrVals.push(input.address.pin_code); }
      if (input.address.gps_location !== undefined) { addrSets.push('gps_location = ?'); addrVals.push(input.address.gps_location || null); }
      // address_instruction is column-probed per the matching guard in
      // insertAddress(). We skip the SET if the column doesn't exist on
      // the deploy so the UPDATE doesn't fail with Unknown column.
      // Probed uncached on the txn conn, and a probe failure ABORTS this
      // edit rather than degrading it — dropping an operator's instruction
      // text silently is worse here than rolling the whole update back.
      if (input.address.address_instruction !== undefined) {
        const hasAddrInstr = await addressService.hasAddressInstructionColumn(conn, {
          cache: false,
          onProbeError: 'throw',
        });
        if (hasAddrInstr) {
          // is_instruction_added is pinned to 0, NOT kept in sync with the
          // text — see address.service IS_INSTRUCTION_ADDED for the ops
          // rationale. We still WRITE it so a row previously flipped to 1
          // by older code resets to 0.
          addrSets.push('address_instruction = ?');
          addrVals.push(input.address.address_instruction || null);
          addrSets.push('is_instruction_added = ?');
          addrVals.push(addressService.IS_INSTRUCTION_ADDED);
        }
      }
      if (addrSets.length > 0) {
        // Preserve the CLIENT-ENTERED address BEFORE we overwrite tbl_address in
        // place. tbl_job.client_entered_address is a pending EasyFix column, so
        // guard on its presence (no-op where the migration hasn't run). Capture
        // only on the FIRST edit (IS NULL) so later edits don't clobber the
        // original the client/portal booked with. No change needed in the old
        // Client Dashboard — we snapshot at the moment the new CRM edits.
        const [ceCols] = await conn.query(
          `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_job'
              AND COLUMN_NAME = 'client_entered_address' LIMIT 1`
        );
        if (ceCols.length > 0) {
          await conn.query(
            `UPDATE tbl_job j
               JOIN tbl_address a ON a.address_id = j.fk_address_id
                SET j.client_entered_address = a.address
              WHERE j.job_id = ? AND j.client_entered_address IS NULL AND a.address IS NOT NULL`,
            [existing.job_id]
          );
        }
        addrVals.push(existing.fk_address_id);
        await conn.query(`UPDATE tbl_address SET ${addrSets.join(', ')} WHERE address_id = ?`, addrVals);
      }
    }

    /*
     * Services reconciliation — SOFT-DELETE pattern (2026-05-25, per ops):
     *
     *   When services change on an update, we must NOT hard-delete the
     *   removed rows. Instead:
     *
     *     1. Mark every existing tbl_job_services row for this job_id
     *        as status=0 (soft-deleted).
     *     2. For each service in the new payload, look for an existing
     *        row matching (job_id, service_id) — including the just-
     *        soft-deleted ones — and UPDATE status back to 1, refreshing
     *        quantity / service_type_id / service_category_id.
     *     3. Insert any service_id from the payload that has no
     *        existing row.
     *
     *   Effect: removed services persist as status=0 (recoverable for
     *   audit / "re-add" flows); re-added services reactivate the same
     *   row (preserving any rate-card linkage); brand-new services land
     *   as fresh rows. Matches the legacy "re-submit the whole list"
     *   semantics but without losing history.
     */
    if (hasServicesEdit) {
      // 1. Snapshot existing rows so we know which ones to reactivate.
      const [existing] = await conn.query(
        'SELECT job_service_id, service_id FROM tbl_job_services WHERE job_id = ?',
        [jobId],
      );
      const existingByService = new Map();
      for (const r of existing) {
        // If multiple historical rows share the same service_id, keep
        // the highest job_service_id (most recent) — that's the one we
        // reactivate. Older duplicates stay status=0.
        if (!existingByService.has(r.service_id) ||
            r.job_service_id > existingByService.get(r.service_id)) {
          existingByService.set(r.service_id, r.job_service_id);
        }
      }
      // 2. Soft-delete all current rows for the job. Cheaper than a
      //    per-row diff and matches "remove == status=0".
      await conn.query(
        'UPDATE tbl_job_services SET job_service_status = 0 WHERE job_id = ?',
        [jobId],
      );
      // Batch-load rate cards once for the whole edit — same cascade
      // helper as create(). N+1-safe; see utils/rate-card-calc.js docs.
      const { loadRateCardRows, computeJobServiceCharges } = require('../utils/rate-card-calc');
      const rateCardById = await loadRateCardRows(conn, input.services.map((s) => s.service_id));

      // 3. Re-apply each service in the new payload — UPDATE existing
      //    row if it was previously known, else INSERT. Recompute the
      //    5 charge columns from the rate card so quantity changes pick
      //    up the new total_cost / shares.
      for (const svc of input.services) {
        const ch = computeJobServiceCharges(rateCardById.get(Number(svc.service_id)), svc.quantity || 1);
        const existingId = existingByService.get(svc.service_id);
        if (existingId) {
          await conn.query(
            `UPDATE tbl_job_services
                SET job_service_status = 1,
                    quantity = ?,
                    service_type_id = ?,
                    service_category_id = ?,
                    total_charge = ?,
                    total_cost = ?,
                    client_charge = ?,
                    easyfix_charge = ?,
                    easyfixer_charge = ?
              WHERE job_service_id = ?`,
            [
              svc.quantity || 1,
              svc.service_type_id || null,
              svc.service_category_id || null,
              ch.total_charge, ch.total_cost,
              ch.client_charge, ch.easyfix_charge, ch.easyfixer_charge,
              existingId,
            ],
          );
        } else {
          await conn.query(
            `INSERT INTO tbl_job_services
               (job_id, service_id, quantity, service_type_id, service_category_id, job_service_status,
                total_charge, total_cost, client_charge, easyfix_charge, easyfixer_charge)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
            [
              jobId, svc.service_id, svc.quantity || 1,
              svc.service_type_id || null, svc.service_category_id || null,
              ch.total_charge, ch.total_cost,
              ch.client_charge, ch.easyfix_charge, ch.easyfixer_charge,
            ],
          );
        }
      }
      // Mirror onto tbl_job.client_services CSV — same helper as create() +
      // magic-link acceptSubmission so every services mutator stays in sync
      // with the normalized table. Legacy CRM reports read the flat column.
      await recomputeClientServicesCsv(conn, jobId);
    }

    // Touch last_update_time if only non-scalar edits happened (services,
    // customer, address). Downstream consumers (webhooks, audit) see the
    // nested edit as a meaningful change to the job record.
    if (sets.length === 0 && (hasServicesEdit || hasCustomerEdit || hasAddressEdit)) {
      // Nested-only booking edit (services/customer/address changed, no scalar
      // column). Stamp created_date_time = the Book-Now moment alongside
      // last_update_time — same rationale as the scalar branch above.
      const bookedAt = new Date();
      await conn.query(
        'UPDATE tbl_job SET last_update_time = ?, created_date_time = ? WHERE job_id = ?',
        [bookedAt, bookedAt, jobId],
      );
    }

    await conn.commit();
    logger.info('Job updated · id=' + jobId);
  } catch (err) {
    await conn.rollback();
    logger.error('Update job failed, rolled back · id=' + jobId + ' · ' + err.message);
    throw err;
  } finally {
    conn.release();
  }
  // Post-commit, best-effort: ensure a newly-set/changed pincode is in the
  // pincode catalog (geocoded). Only when the address — including a pincode —
  // was part of this edit (e.g. the bulk-upload Confirm & Schedule step).
  if (hasAddressEdit && input.address?.pin_code) ensureJobPincode(input.address.pin_code, actor);
  return getById(jobId);
}

// ─── Webhook + notification firing (fire-and-forget) ────────────────
// Lazy-require avoids circular dependency.
function fireWebhook(eventName, jobId) {
  try {
    const { dispatch } = require('./webhook.service');
    dispatch({ eventName, jobId }).catch((err) =>
      require('../logger').warn({ eventName, jobId, err: err.message }, 'webhook dispatch error'));
  } catch (err) {
    require('../logger').warn({ eventName, jobId, err: err.message }, 'webhook wiring error');
  }
  // Also fire the notification orchestrator (inbox + SMS/email/WA)
  fireNotification(eventName, jobId);
}

function fireNotification(eventName, jobId) {
  setImmediate(async () => {
    try {
      const job = await getById(jobId);
      if (!job) return;
      const { onJobEvent } = require('./notification-orchestrator.service');
      await onJobEvent(eventName, job);
    } catch (err) {
      require('../logger').warn({ eventName, jobId, err: err.message }, 'notification orchestrator wiring error');
    }
  });
}

function statusToEventName(prevStatus, newStatus) {
  // Map tbl_job.job_status transition → webhook event name.
  // No-op re-submit (same status) is not a transition — never re-fire
  // webhooks/SMS. Mobile /eta and /reschedule deliberately call
  // setStatus with the existing status to ride the extras path and
  // rely on NO event firing (see routes/mobile/index.js).
  if (Number(prevStatus) === Number(newStatus)) return null;
  if (newStatus === STATUS.IN_PROGRESS)   return 'TechStart';
  if (COMPLETED_STATES.has(newStatus))    return 'TechVisitComplete';
  if (newStatus === STATUS.CANCELLED)     return 'CancelJob';
  if (newStatus === STATUS.REVISIT)       return 'TechVisitInComplete';
  // Unreachable outcome → CustomerNotReachable. Legacy CRM didn't
  // dispatch a webhook for this transition, but the same orchestrator
  // also gates the customer-facing SMS (CUSTOMER_NOT_REACHABLE
  // template). Returning a named event lets us hook either or both
  // from notification-orchestrator.service.js without forking the
  // dispatch path. Enquiry doesn't get an event because legacy CRM
  // doesn't notify the customer when an order is marked Enquiry.
  if (newStatus === STATUS.CALL_LATER)    return 'CustomerNotReachable';
  return null;
}

// ─── Status change ──────────────────────────────────────────────────
/*
 * Performance notes:
 *   - Use getJobMeta (single row, no joins) for the existence + prev-status
 *     check instead of the full getById. Saves one 7-way-join + services + images
 *     fetch per status change (the caller gets the fresh state below).
 *   - Webhook + notification dispatch is fire-and-forget via setImmediate inside
 *     fireWebhook, so the HTTP response returns as soon as UPDATE commits.
 */
/*
 * Whitelist of tier-specific columns the caller may stamp via the
 * `extras` map (see setStatus signature below). The whitelist is the
 * SQL-injection guard — only these column names ever interpolate into
 * the UPDATE statement. New entries land here only after confirming
 * the column exists on tbl_job + the write is genuinely a status-
 * transition side-effect (not unrelated mutation that should go
 * through a different endpoint).
 *
 * Use cases:
 *   - Mobile /jobs/:id/checkin   → checkin_gps_location, checkin_address,
 *                                  checkin_pincode, fk_checkin_by
 *   - Mobile /jobs/:id/checkout  → app_checkout_date_time
 *   - Mobile /jobs/:id/eta       → eta_status, eta_requested_time
 *   - Mobile /jobs/:id/reschedule → reschedule_reason_id, reschedule_remarks,
 *                                  reschedule_at_app, is_rescheduled_by_app
 */
const STATUS_EXTRAS_ALLOWLIST = new Set([
  // Check-in stamps (mobile /checkin path)
  'checkin_date_time',
  'checkin_gps_location', 'checkin_address', 'checkin_pincode', 'fk_checkin_by',
  // Check-out stamps (mobile /checkout path)
  'app_checkout_date_time',
  // Check-out completion details — cash / problem / revisit (mobile /checkout
  // extended body). All exist on tbl_job; a revisit flips job_status to 10
  // (handled by setStatus), and these stamp the accompanying reason/amount cols.
  'is_collected_cash_by_app', 'material_charge', 'collect_cash_reason_id',
  'problem_reason_id', 'revisit_reason_id', 'revisit_date', 'revisit_time_slot',
  // ETA stamps
  'eta_status', 'eta_requested_time',
  // Reschedule-from-app stamps
  'reschedule_reason_id', 'reschedule_remarks', 'reschedule_at_app',
  'is_rescheduled_by_app', 'resch_job_count',
  // Tech-side reassignment trigger
  'requested_date_time',
]);

/*
 * Extras columns that must keep their FIRST value, written with COALESCE.
 *
 * `checkin_date_time` anchors TAT Segment 1 (ticket created → check-in), which
 * measures the FIRST visit. A revisit re-checks-in on the same job row, and an
 * app retry can fire the endpoint twice within seconds — either would move the
 * anchor forward and silently improve a Visit TAT that was already breached.
 * Legacy avoided this with a `currentStatus == 1` gate rather than write-once
 * semantics; write-once is the stronger guarantee because it does not depend on
 * the caller reaching the endpoint in a particular state.
 *
 * (`checkout_date_time` gets the same treatment, but in the COMPLETED_STATES
 * branch above, because it is stamped by the transition itself rather than
 * passed through extras.)
 */
const WRITE_ONCE_EXTRAS = new Set(['checkin_date_time']);

/*
 * Cached probe for `tbl_job.send_back_to_tx` column existence. The
 * column is referenced by the Mobile App's "Action Required" lifecycle
 * (CRM sets `send_back_to_tx=1` + `job_status=2`; tech re-closes →
 * resets to 0). It doesn't appear elsewhere in this codebase — likely
 * a legacy column from the pre-migration CRM. We probe once on first
 * setStatus call + cache the result so the UPDATE conditionally
 * includes the reset clause only when the column actually exists.
 *
 * When the column lands (or is confirmed already-present), the reset
 * happens automatically on the IN_PROGRESS → COMPLETED transition with
 * no further code change.
 */
let _sendBackColumnExists = null;
async function hasSendBackToTxColumn() {
  if (_sendBackColumnExists != null) return _sendBackColumnExists;
  try {
    const [rows] = await pool.query(
      `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'tbl_job'
          AND COLUMN_NAME  = 'send_back_to_tx'
        LIMIT 1`,
    );
    _sendBackColumnExists = rows.length > 0;
    return _sendBackColumnExists;
  } catch (e) {
    // A failure is NOT cached. The success answer is frozen for the process because a column that exists does not vanish; a failure frozen the same way turns a two-second information_schema blip into a degraded mode that lasts until the container restarts, with nothing in the logs saying so.
    logger.warn('job: send_back_to_tx probe failed · ' + e.message
      + ' — treating as absent for this call only');
    return false;
  }
}

/*
 * Column-presence probe for the ENQUIRY enrichment trio on tbl_job:
 *   enquiry_reason_id, enquiry_comment, enquiry_date_time.
 *
 * Cached in module-scope after the first hit. Probes all three at once
 * (single SELECT) and returns true only if ALL three are present —
 * partial-deploy state would cause SQL "Unknown column" errors mid-
 * UPDATE, so it's safer to treat any missing one as the legacy shape.
 */
let _enquiryColumnsExist = null;
async function hasEnquiryColumns() {
  if (_enquiryColumnsExist != null) return _enquiryColumnsExist;
  try {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'tbl_job'
          AND COLUMN_NAME IN ('enquiry_reason_id', 'enquiry_comment', 'enquiry_date_time')`,
    );
    _enquiryColumnsExist = rows[0].n === 3;
    return _enquiryColumnsExist;
  } catch (e) {
    // A failure is NOT cached. The success answer is frozen for the process because a column that exists does not vanish; a failure frozen the same way turns a two-second information_schema blip into a degraded mode that lasts until the container restarts, with nothing in the logs saying so.
    logger.warn('job: enquiry column trio probe failed · ' + e.message
      + ' — treating as legacy shape for this call only');
    return false;
  }
}

/*
 * Column-presence probe for `tbl_job.call_later` — flag set to 1 when
 * the Unreachable outcome transition lands. Legacy CRM persisted this
 * flag for downstream reports; new deploys may not have the column
 * yet, in which case we still transition the status but skip the flag.
 */
let _callLaterColumnExists = null;
async function hasCallLaterColumn() {
  if (_callLaterColumnExists != null) return _callLaterColumnExists;
  try {
    const [rows] = await pool.query(
      `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'tbl_job'
          AND COLUMN_NAME  = 'call_later'
        LIMIT 1`,
    );
    _callLaterColumnExists = rows.length > 0;
    return _callLaterColumnExists;
  } catch (e) {
    // A failure is NOT cached. The success answer is frozen for the process because a column that exists does not vanish; a failure frozen the same way turns a two-second information_schema blip into a degraded mode that lasts until the container restarts, with nothing in the logs saying so.
    logger.warn('job: call_later probe failed · ' + e.message
      + ' — treating as absent for this call only');
    return false;
  }
}

async function setStatus(jobId, { status, reasonId, comment, extras }, actor) {
  logger.info('Set job status · id=' + jobId + ' · status=' + status + (reasonId != null ? ' · reasonId=' + reasonId : ''));
  if (!ALL_STATUS_VALUES.has(Number(status))) {
    logger.warn('Set status rejected, invalid status · id=' + jobId + ' · status=' + status);
    const err = new Error(`invalid status ${status}; allowed: ${[...ALL_STATUS_VALUES].join(',')}`);
    err.status = 400; throw err;
  }
  const existing = await getJobMeta(jobId);
  if (!existing) {
    logger.warn('Set status job not found · id=' + jobId);
    const err = new Error('job not found'); err.status = 404; throw err;
  }

  const sets = ['job_status = ?', 'last_update_time = ?'];
  const values = [status, new Date()];
  const actorId = actor?.user_id || null;

  if (Number(status) === STATUS.CANCELLED) {
    // enum_reason_id mirrors the picked action_taken_reason id — the same column
    // the job-comment History JOIN resolves against — so the cancel reason renders
    // there; cancel_reason_id keeps the legacy cancel-audit column populated too.
    sets.push('cancel_date_time = ?', 'cancel_reason_id = ?', 'cancel_comment = ?', 'cancel_by = ?', 'enum_reason_id = ?');
    values.push(new Date(), reasonId || null, comment || null, actorId, reasonId || null);
  } else if (Number(status) === STATUS.CALL_LATER) {
    // UNREACHABLE / CALL_LATER outcome — set the call_later flag (if
    // the column exists) and stamp `cancel_by` so the audit trail
    // captures WHO marked it. Legacy CRM also persisted reason +
    // comment, but only on tbl_job_comment (comment_on=16) — no
    // dedicated tbl_job columns for unreachable in the legacy schema.
    if (await hasCallLaterColumn()) {
      sets.push('call_later = ?');
      values.push(1);
    }
    sets.push('cancel_by = ?');
    values.push(actorId);
  } else if (Number(status) === STATUS.ENQUIRY) {
    // ENQUIRY stamps a parallel set of columns to CANCELLED:
    //   enquiry_date_time = NOW()
    //   enquiry_reason_id  = action_taken_reason.id picked in the dialog
    //   enquiry_comment    = the prefix string the FE built
    //   cancel_by          = actor (same column reused — legacy ops use it
    //                        as a generic "who actioned this" stamp for
    //                        both ENQUIRY and CANCELLED transitions)
    //
    // Column-probe at runtime: enquiry_* columns may not exist on every
    // deploy (legacy DBs without the 2024 ENQUIRY enrichment). Only
    // append a SET when the column is actually present so the UPDATE
    // doesn't fail with "Unknown column" — the status itself still
    // lands even on older deploys.
    if (await hasEnquiryColumns()) {
      sets.push('enquiry_date_time = ?', 'enquiry_reason_id = ?', 'enquiry_comment = ?', 'cancel_by = ?');
      values.push(new Date(), reasonId || null, comment || null, actorId);
    } else {
      // Older deploy: at minimum stamp `cancel_by` (the column is
      // documented on every deploy) so audit trail still records WHO
      // did the ENQUIRY transition.
      sets.push('cancel_by = ?');
      values.push(actorId);
    }
  } else if (Number(status) === STATUS.BOOKED) {
    /*
     * BOOKED transition = order confirmation. Stamp a 4-digit OTP so
     * the technician can verify on check-in. Legacy CRM did this at
     * check-in (JobDaoImpl.java:4418); ops moved the contract forward
     * to confirmation so the customer learns the code earlier.
     *
     * Idempotency: only stamp when `existing.otp` is null/empty. A
     * re-confirm (e.g. operator promotes Unconfirmed → Booked → CANCELLED
     * → Booked) keeps the original code rather than churning. This
     * matches the customer's mental model — the code they were told
     * doesn't change unless ops explicitly clears it (manual ops path,
     * not currently exposed via API).
     *
     * Column-probed: skip silently on deploys without `tbl_job.otp`.
     */
    if (await hasOtpColumn()) {
      const hasExistingOtp =
        existing.otp != null && String(existing.otp).trim() !== '';
      if (!hasExistingOtp) {
        sets.push('otp = ?');
        values.push(String(generateOtp()));
      }
    }
    // Stamp fk_created_by on confirmation when the row has none yet — e.g. an
    // Unconfirmed/integration job, or one created by a technician (no tbl_user
    // creator). COALESCE preserves a real creator already set by create()
    // (Book-New-Call). fk_created_by is a tbl_user FK, so coerce the actor id
    // the same way create() does: a technician actor ("efr:NNN" → NaN) resolves
    // to null rather than corrupting the column. This also fixes the legacy
    // "Booking Confirmed" window, which shows the name via
    // fk_created_by → tbl_user.user_name (so a NULL left the name blank).
    const bookedActorId = (() => { const n = Number(actorId); return Number.isFinite(n) && n > 0 ? n : null; })();
    if (bookedActorId) {
      sets.push('fk_created_by = COALESCE(fk_created_by, ?)');
      values.push(bookedActorId);
    }
    /*
     * eta_status (ops 2026-07-08): order confirmation lands the job as '01' —
     * the platform's "booked/confirmed" sentinel (verified: status-0 rows are
     * overwhelmingly '01'; the later '11' is stamped downstream as the job
     * progresses). create() already writes '01' on Book-New-Call; this covers
     * the OTHER booking entry point — Book Now / Confirm & Schedule (9 → 0).
     * (Supersedes the earlier "update paths must never touch eta_status" note:
     * this is setStatus, and the confirm transition is a booking action.)
     */
    sets.push('eta_status = ?');
    values.push('01');
    /*
     * booking_cut_off_time_slot backfill: unconfirmed rows (often website /
     * integration sourced) frequently arrive with the named time_slot but a
     * NULL cut-off window. Derive it from the appointment time on confirm so
     * BOTH slot columns are populated. COALESCE keeps any value already set.
     */
    const cutoffSlot = deriveBookingCutoffSlot(existing.requested_date_time);
    if (cutoffSlot) {
      sets.push('booking_cut_off_time_slot = COALESCE(booking_cut_off_time_slot, ?)');
      values.push(cutoffSlot);
    }
  } else if (COMPLETED_STATES.has(Number(status))) {
    sets.push('checkout_date_time = COALESCE(checkout_date_time, ?)', 'fk_checkout_by = COALESCE(fk_checkout_by, ?)');
    values.push(new Date(), actorId);
    // Sent-back lifecycle (mobile app spec): when a tech re-closes a
    // job that was sent back from the CRM, reset the flag so the
    // "Action Required" tile stops counting it. Conditionally
    // included — see hasSendBackToTxColumn() rationale.
    if (await hasSendBackToTxColumn()) {
      sets.push('send_back_to_tx = 0');
    }
  }

  // Tier-specific extras — caller passes a map of column→value pairs
  // for transition side-effects that don't generalise (mobile GPS
  // checkin, app_checkout_date_time, etc.). Whitelisted to prevent
  // SQL injection via the column name; values bind parameterised.
  if (extras && typeof extras === 'object') {
    for (const [col, val] of Object.entries(extras)) {
      if (!STATUS_EXTRAS_ALLOWLIST.has(col)) {
        // Non-whitelisted column — silently skip (defence against
        // accidentally-passed unrelated fields). Logged at debug
        // level via an inline require so we don't add a module-scope
        // logger import just for this one safety message.
        try { require('../logger').debug?.({ col, jobId }, 'setStatus: ignoring non-whitelisted extras column'); } catch {}
        continue;
      }
      /*
       * WRITE-ONCE columns keep the FIRST value they were given. See
       * WRITE_ONCE_EXTRAS for why each one is in there.
       */
      if (WRITE_ONCE_EXTRAS.has(col)) {
        if (val === undefined) continue;
        sets.push(`${col} = COALESCE(${col}, ?)`);
        values.push(val);
        continue;
      }
      /*
       * `undefined` means the caller had nothing to say about this column —
       * NOT "clear it". Binding it would throw (mysql2 rejects undefined bind
       * params) or, worse, coerce to NULL and silently wipe a stored value.
       * The mobile check-in path shipped exactly that bug: an optional stamp
       * absent from the request nulled the previous visit's reading.
       *
       * An explicit `null` still writes NULL — that is a caller stating the
       * column has no value for THIS event, which some stamps legitimately do
       * (reschedule_remarks clears on each new reschedule).
       */
      if (val === undefined) continue;
      sets.push(`${col} = ?`);
      values.push(val);
    }
  }

  values.push(jobId);
  await pool.query(`UPDATE tbl_job SET ${sets.join(', ')} WHERE job_id = ?`, values);

  /*
   * tbl_job_logs. Three rows are possible on one transition and they answer
   * different questions, so they are not collapsed:
   *   'status change'      — NEW event (the legacy stack never logged a generic
   *                          transition; only CANCELLED left a dated row).
   *                          Skipped by logStatusChange when nothing moved, which
   *                          is what the mobile ETA / reschedule routes do when
   *                          they pass the CURRENT status to ride the extras path.
   *   'checkout'           — legacy vocabulary, on the visit being closed out.
   *   'Re-visit Required'  — legacy vocabulary, on the visit needing another one.
   * All three are fail-soft and run after the UPDATE has already committed.
   */
  await jobLog.logStatusChange(jobId, { from: existing.job_status, to: Number(status) }, actor);
  if (COMPLETED_STATES.has(Number(status)) && !COMPLETED_STATES.has(Number(existing.job_status))) {
    await jobLog.logCheckout(jobId, actor);
  }
  if (Number(status) === STATUS.REVISIT && Number(existing.job_status) !== STATUS.REVISIT) {
    await jobLog.logRevisitRequired(jobId, { reasonId: extras?.revisit_reason_id }, actor);
  }

  const eventName = statusToEventName(existing.job_status, Number(status));
  logger.info('Job status updated · id=' + jobId + ' · ' + existing.job_status + '->' + Number(status) + (eventName ? ' · event=' + eventName : ''));
  if (eventName) fireWebhook(eventName, jobId);

  // Enquiry WhatsApp (2026-07-09): ENQUIRY has no status→event mapping
  // (statusToEventName returns null), so fire the customer + SPOC WhatsApp
  // directly on the "mark as Enquiry" TRANSITION (the sole trigger — see the
  // create() note above). Guard on a real transition INTO enquiry so a 7→7
  // re-submit doesn't double-send. Fire-and-forget — never blocks the
  // response. Runs after the UPDATE above, so enquiry_reason_id /
  // enquiry_date_time are already persisted when the send reads them.
  if (Number(status) === STATUS.ENQUIRY && Number(existing.job_status) !== STATUS.ENQUIRY) {
    require('./enquiry-notification.service').fireEnquiryWhatsapp(jobId);
  }

  // Cancel audit comment (2026-07-27): mirror Add Remarks — record the
  // cancellation on the job comment / History timeline so it isn't only in the
  // cancel_* columns. comment_on = 1 is the lifecycle/audit bucket (no cancel-
  // specific stage code exists; reschedule + Add Remarks use 1 too). Guard on a
  // real transition INTO cancelled so a 6→6 re-submit doesn't double-write. The
  // reason renders in History via enum_reason_id. Non-fatal — a comment failure
  // must never block the cancellation (the UPDATE above already persisted it).
  if (Number(status) === STATUS.CANCELLED && Number(existing.job_status) !== STATUS.CANCELLED) {
    try {
      await require('./job-comment.service').addComment(jobId, {
        comments: (comment && String(comment).trim()) || 'Job cancelled',
        comment_on: 1,
        commented_by: actorId,
        enum_reason_id: reasonId || null,
      });
    } catch (e) {
      logger.warn('Cancel audit comment failed (non-fatal) · id=' + jobId + ' · ' + e.message);
    }

  }

  /*
   * CLOSE THE OPEN OFFERS when the job ENTERS a state where they can no longer
   * be accepted. This used to live inside the CANCELLED branch above and fired
   * only on cancellation (2026-07-29); it now covers every terminal status,
   * because the same defect was reported against a COMPLETED job — the
   * technician app still offering Accept / Reject for finished work.
   *
   * ENTERING-only, exactly as the cancel version was: a 6→6 re-submit, or a
   * 3→5 move between two terminal codes, must not re-stamp responded_at on
   * rows a previous transition already closed.
   */
  if (OFFER_WITHDRAWAL_STATES.has(Number(status))
      && !OFFER_WITHDRAWAL_STATES.has(Number(existing.job_status))) {
    await withdrawOffersForClosedJob(jobId, Number(status));
  }

  // Ops took a deliberate status action (confirm 9→0, cancel, enquiry, …) — any
  // pending customer request on this job is now handled. See resolveCustomerRequests.
  await resolveCustomerRequests(jobId);
  return getById(jobId);
}

// ─── Assign / Reassign technician ───────────────────────────────────
// ─── Offer a job to a POOL of technicians (THE OFFER MODEL) ─────────
/*
 * offerToTechnicians(jobId, efrIds, actor, opts?)
 *
 * The pool-offer primitive: a single job is offered to MANY technicians at
 * once. The job STAYS BOOKED (job_status = 0) and fk_easyfixter_id is left
 * NULL/untouched — there is no single owner during the offer window. Each
 * efrId gets a tbl_job_offer OFFERED (0) row + an FCM push. ACCEPT later
 * (acceptOffer) is first-wins race-safe and stamps the winning fk.
 *
 *   jobId  : the job to offer
 *   efrIds : number[] (length >= 1) — technicians to offer to
 *   actor  : { user_id?: number | null } — stamps fk_scheduled_by audit
 *   opts   : { requestedDateTime?, timeSlot? } — OPTIONAL schedule edit applied
 *            in the SAME transaction (mirrors assign()'s Schedule & Offer flow)
 *
 * Re-opens the latest historical row per technician and expires stray older
 * OPEN duplicates, so a re-offer never creates multiple live offers. Fires one
 * bounded, set-based job-offer push batch after commit.
 *
 * Returns the full getById() payload.
 */
async function offerToTechnicians(jobId, efrIds, actor, { requestedDateTime, timeSlot, source, sourceByEfr } = {}) {
  const ids = Array.from(new Set((Array.isArray(efrIds) ? efrIds : [efrIds])
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n > 0)))
    .sort((a, b) => a - b);
  logger.info('Offer job to technicians · id=' + jobId + ' · techCount=' + ids.length + (requestedDateTime ? ' · reschedule=yes' : ''));
  if (!ids.length) {
    logger.warn('Offer rejected, no valid easyfixer · id=' + jobId);
    const err = new Error('at least one easyfixer is required to offer a job'); err.status = 400; throw err;
  }
  if (ids.length > MAX_OFFER_RECIPIENTS) {
    const err = new Error(`a job can be offered to at most ${MAX_OFFER_RECIPIENTS} technicians at once`);
    err.status = 400;
    err.code = 'TOO_MANY_OFFER_RECIPIENTS';
    throw err;
  }

  const existing = await getJobMeta(jobId);
  if (!existing) {
    logger.warn('Offer job not found · id=' + jobId);
    const err = new Error('job not found'); err.status = 404; throw err;
  }

  // KILL-SWITCH + PRE-MIGRATION SAFETY NET. The pool-offer model only exists
  // when the feature is ON (property job.offer.flow.enabled) AND tbl_job_offer
  // has actually been migrated in. If either is false, INSERTing into
  // tbl_job_offer below would 500 the CRM's POST /admin/jobs/:id/offer and
  // hamper legacy flows. So when the flow is OFF (or the table is absent) we
  // degrade GRACEFULLY to the legacy behaviour: a plain DIRECT single-assign
  // of the FIRST selected technician. assign() itself does the legacy
  // bump-to-SCHEDULED when offer mode is off/table absent, so there is NO
  // recursion back into the offer path here.
  if (!offerFlowEnabled() || !(await jobOfferTableExists())) {
    return assign(jobId, { easyfixerId: ids[0], requestedDateTime, timeSlot }, actor);
  }

  // Normalise the OPTIONAL schedule edit exactly as assign() does — an IST
  // wall-clock string stored as a literal "YYYY-MM-DD HH:mm:ss" (never a JS
  // Date, which would tz-shift on a UTC host). See assign() for the rationale.
  const editSchedule = requestedDateTime != null && requestedDateTime !== '';
  let newRequested = null;
  if (editSchedule) {
    const m = String(requestedDateTime).match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(:\d{2})?)?$/);
    if (!m) {
      const err = new Error('requestedDateTime is not a valid date'); err.status = 400; throw err;
    }
    const timePart = m[2] ? `${m[2]}${m[3] || ':00'}` : '00:00:00';
    newRequested = `${m[1]} ${timePart}`;
  }
  const hasSlot = timeSlot !== undefined && timeSlot !== null && timeSlot !== '';

  // Resolve the schema-dependent projection before opening the transaction;
  // the actual eligibility read happens under row locks below.
  const lifecycleProjection = await easyfixerLifecycle.readProjection('e');
  const conn = await pool.getConnection();
  const offeredIds = [];
  // Who is putting this offer out — the SAME actor stamped onto the job's
  // schedule-audit columns below, but captured PER OFFER ROW so re-offers by
  // different people (and the report's "Offered By") attribute correctly. NULL
  // for a system/auto offer with no actor (e.g. the auto-assign engine).
  const offeredBy = (actor && actor.user_id != null) ? actor.user_id : null;
  try {
    await conn.beginTransaction();

    // Lifecycle and offer creation serialize on the technician rows. A status
    // change between candidate-list load and submit therefore cannot leak a new
    // offer to a PAUSED/INACTIVE/etc technician.
    await assertTechniciansCanReceiveJobs(ids, conn, {
      forUpdate: true,
      lifecycleProjection,
    });

    // Lock order is technician(s), then job across offer/assign/accept. The
    // earlier getJobMeta only selected the branch; this locked row is the
    // authority for the write and closes the schedule-vs-assign race.
    const [[lockedJob]] = await conn.query(
      `SELECT job_id, job_status, fk_easyfixter_id
         FROM tbl_job
        WHERE job_id = ?
        FOR UPDATE`,
      [jobId],
    );
    if (!lockedJob) {
      const err = new Error('job not found'); err.status = 404; throw err;
    }
    if (Number(lockedJob.job_status) !== STATUS.BOOKED || lockedJob.fk_easyfixter_id != null) {
      const err = new Error('job must be BOOKED and unassigned before it can be offered');
      err.status = 409;
      err.code = 'JOB_NOT_OFFERABLE';
      throw err;
    }

    // The pool offer IS the ops "Schedule & Assign" action, so the schedule
    // AUDIT columns must be stamped here — scheduled_date_time ("Schedule On"),
    // fk_scheduled_by ("Schedule By") and first_scheduled_by. The legacy
    // direct-assign path (assign()) stamps these in one UPDATE; when Schedule &
    // Assign moved onto the offer flow that stamp was dropped, so both columns
    // silently stopped populating from the modal. We stamp them on EVERY offer.
    // Crucially we STILL do NOT touch job_status or fk_easyfixter_id — the job
    // stays BOOKED with no owner while the pool offer is live (a tech ACCEPT is
    // what flips it to SCHEDULED + sets the fk). Uses new Date() (pool tz +05:30
    // → IST wall-clock, stored verbatim), never SQL NOW(). Optional schedule
    // edit (requested_date_time / time_slot) rides in the same UPDATE.
    {
      const now = new Date();
      const actorId = (actor && actor.user_id != null) ? actor.user_id : null;
      const sets = [
        'last_update_time = ?',
        'scheduled_date_time = ?',
        'fk_scheduled_by = ?',
        'first_scheduled_by = COALESCE(first_scheduled_by, ?)',
        // original_scheduling_date_time — the FIRST time this job was scheduled.
        // Captured ONCE (COALESCE preserves it across re-offers and later
        // reschedules), mirroring the legacy "SET original_scheduling_date_time
        // = NOW() WHERE it IS NULL" rule. Pairs with first_scheduled_by.
        'original_scheduling_date_time = COALESCE(original_scheduling_date_time, ?)',
      ];
      const values = [now, now, actorId, actorId, now];
      if (editSchedule) { sets.push('requested_date_time = ?'); values.push(newRequested); }
      // The schedule edit carries the 1-HOUR frame in its time-of-day, so
      // requested_time (the legacy HH:MM twin) moves with it. Guarded on a real
      // time-of-day: a date-only edit must not blank a good requested_time.
      if (editSchedule && hasTimeOfDay(newRequested)) {
        sets.push('requested_time = ?'); values.push(wallClockTime(newRequested));
      }
      // time_slot is written as a BAND — never the raw picker label. The
      // appointment time decides it when the edit supplies a REAL time-of-day;
      // otherwise an FE-sent label is canonicalised. See resolveTimeSlot.
      //
      // ⚠ The datetime is gated on hasTimeOfDay for the same reason the
      // requested_time write above is. offerBody/assignBody accept a DATE-ONLY
      // requestedDateTime (validators/job.validator.js), which becomes
      // '<date> 00:00:00' — and resolveTimeSlot(null, '<date> 00:00:00') returns
      // 'After Hours', so a date-only schedule edit used to CLOBBER a perfectly
      // good stored '9AM to 12PM' with 'After Hours'. reschedule() never had the
      // bug because it passes the job's existing slot as the fallback; here we
      // simply write nothing when there is nothing to derive from.
      const slotSource  = (editSchedule && hasTimeOfDay(newRequested)) ? newRequested : null;
      const slotToStore = (slotSource || hasSlot)
        ? resolveTimeSlot(hasSlot ? timeSlot : null, slotSource)
        : null;
      if (slotToStore) { sets.push('time_slot = ?'); values.push(slotToStore); }
      values.push(jobId);
      await conn.query(`UPDATE tbl_job SET ${sets.join(', ')} WHERE job_id = ?`, values);
    }

    // Preserve the existing re-offer semantics, but keep SQL work constant for
    // every supported batch size: one latest-row read plus at most three bulk
    // writes. The technician locks above serialize overlapping batches.
    offeredIds.push(...await persistJobOfferBatch(conn, {
      jobId,
      efrIds: ids,
      source,
      sourceByEfr,
      offeredBy,
    }));

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    logger.error('Offer job failed, rolled back · id=' + jobId + ' · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }

  logger.info('Job offered · id=' + jobId + ' · newOffers=' + offeredIds.length);
  // Fire-and-forget offer pushes AFTER commit. Token resolution is set-based
  // (two queries for up to 50 technicians) and FCM concurrency is bounded.
  if (offeredIds.length) {
    require('./job-offer-push.service')
      .sendJobOfferPushBatch(offeredIds, { jobId })
      .catch(() => {});
  }

  // Offering the job out is Ops handling it — clear any pending customer request.
  await resolveCustomerRequests(jobId);
  return getById(jobId);
}

/*
 * Server-authoritative receiveNewJobs gate for assign/offer/accept writes.
 * Candidate rows are advisory and can be stale by submit time; this guard
 * projects lifecycle state for the whole submitted set in ONE query and can
 * lock those technician rows inside the caller's transaction.
 */
async function assertTechniciansCanReceiveJobs(
  efrIds,
  runner = pool,
  { forUpdate = false, lifecycleProjection = null } = {},
) {
  const ids = Array.from(new Set(
    (Array.isArray(efrIds) ? efrIds : [efrIds])
      .map((v) => Number(v))
      .filter((n) => Number.isInteger(n) && n > 0),
  )).sort((a, b) => a - b);
  if (!ids.length) return;
  const projection = lifecycleProjection || await easyfixerLifecycle.readProjection('e');
  const [rows] = await runner.query(
    `SELECT e.efr_id, e.efr_status, e.is_technician_verified, e.efr_manager_id,
            ${projection}
      FROM tbl_easyfixer e
      WHERE e.efr_id IN (?)
      ORDER BY e.efr_id ASC
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [ids],
  );
  const byId = new Map(rows.map((row) => [Number(row.efr_id), row]));
  const blocked = ids.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return [{ efrId: id, status: 'NOT_FOUND', reasonCode: null, reason: 'easyfixer not found' }];
    const { lifecycle, canOffer } = easyfixerWorkEligibility.fromRow(row);
    if (canOffer) return [];
    return [{
      efrId: id,
      status: lifecycle.status,
      reasonCode: lifecycle.reasonCode,
      reason: lifecycle.reason,
    }];
  });
  if (blocked.length) {
    const idsText = blocked.map((item) => item.efrId).join(',');
    const first = blocked[0];
    logger.warn(
      'Assign/offer rejected, technician lifecycle blocks new jobs · efrIds=' + idsText
      + ' · statuses=' + blocked.map((item) => item.status).join(','),
    );
    const reasonText = first.reason ? `: ${first.reason}` : '';
    const err = new Error(blocked.length === 1
      ? `easyfixer ${first.efrId} cannot receive new jobs while status is ${first.status}${reasonText}`
      : `easyfixers ${idsText} cannot receive new jobs in their current lifecycle status`);
    err.status = 400;
    err.code = blocked.every((item) => {
      const row = byId.get(item.efrId);
      return row && Number(row.is_technician_verified) !== 1;
    }) ? 'TECH_NOT_VERIFIED' : 'TECH_CANNOT_RECEIVE_JOBS';
    err.details = { technicians: blocked };
    throw err;
  }
}

/*
 * Hand an OWNED job back to the pool so it can be re-offered.
 *
 * offerToTechnicians() refuses a job that still has an owner
 * (JOB_NOT_OFFERABLE) and acceptOffer()'s first-wins claim is gated on
 * `job_status = BOOKED AND fk_easyfixter_id IS NULL` — so a reassign can only
 * become an offer if the outgoing technician's claim is released FIRST.
 * Reuses applyUnassignLocked (the mobile-reject primitive): fk cleared,
 * scheduled_date_time cleared, job back to BOOKED, plus the outgoing
 * technician's scheduling_history row and their own still-open offer row.
 *
 * Runs in its own short transaction and COMMITS before the offer goes out,
 * because offerToTechnicians() opens its own. The gap is safe by construction:
 * anything that claims the job in between makes the follow-up offer fail its
 * own locked JOB_NOT_OFFERABLE check instead of overwriting a live assignment.
 *
 * Returns the released technician id (never null — the caller gates on an
 * owner being present).
 */
async function releaseOwnedJobForReoffer(jobId, preloadedJob, { reasonId, rescheduleReason }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[lockedJob]] = await conn.query(
      `SELECT job_id, job_status, fk_easyfixter_id
         FROM tbl_job
        WHERE job_id = ?
        FOR UPDATE`,
      [jobId],
    );
    if (!lockedJob) {
      const err = new Error('job not found'); err.status = 404; throw err;
    }
    // Same drift guard the direct path applies: the unlocked read only SELECTED
    // this branch, so an accept/unassign/cancel racing in between must 409
    // rather than be silently overwritten by this stale request.
    const lockedOwner = lockedJob.fk_easyfixter_id == null
      ? null
      : Number(lockedJob.fk_easyfixter_id);
    if (Number(lockedJob.job_status) !== Number(preloadedJob.job_status)
        || lockedOwner !== Number(preloadedJob.fk_easyfixter_id)) {
      const err = new Error('job assignment changed; refresh and try again');
      err.status = 409;
      err.code = 'JOB_ASSIGNMENT_CHANGED';
      throw err;
    }
    const releasedTechId = await applyUnassignLocked(conn, jobId, lockedJob, {
      // The CRM reassign sends no reason (it is not a technician rejection), so
      // scheduling_history would otherwise record the release with a NULL
      // reason and read as an unexplained unassignment in the audit trail.
      reason: rescheduleReason || 'Reassigned to another technician',
      reasonId,
      hasOfferTable: true,
    });
    /*
     * Close every OTHER technician's still-open offer from the previous round
     * while the job lock is held. persistJobOfferBatch only touches rows for
     * the technicians being offered to, so a stale open decision would
     * otherwise survive the release and let a third technician claim the job
     * out from under the incoming offer.
     *
     * ── THIS WAS EXPLICITLY DECIDED, TWICE ──────────────────────────
     * The owner first asked for the opposite (leave the old offers open and let
     * whoever accepts first win), then confirmed this sweep instead
     * (2026-09-04). Both are defensible — acceptOffer()'s claim is gated on
     * `job_status = BOOKED AND fk_easyfixter_id IS NULL` under a row lock, so a
     * free-for-all race would also have been SAFE, just less predictable for
     * ops. Recorded because the code reads like an over-cautious tidy-up and is
     * not: a future reader who "fixes" it back changes agreed behaviour.
     *
     * The outgoing technician's own row is already handled by
     * applyUnassignLocked above, which rejects only the latest row for that
     * technician — this sweep covers everyone else.
     */
    await conn.query(
      `UPDATE tbl_job_offer
          SET offer_status = ${OFFER_STATUS.EXPIRED}, responded_at = NOW()
        WHERE job_id = ? AND offer_status = ${OFFER_STATUS.OFFERED}`,
      [jobId],
    );
    await conn.commit();
    return releasedTechId;
  } catch (e) {
    await conn.rollback();
    logger.error('Release job for re-offer failed, rolled back · id=' + jobId + ' · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }
}

/*
 * assign(jobId, body, actor)
 *
 * body:
 *   easyfixerId       — tech to assign (required)
 *   reasonId          — reschedule reason FK (reassign only)
 *   rescheduleReason  — free-text reschedule reason (reassign only)
 *   requestedDateTime — OPTIONAL new requested datetime. When present, the
 *                       job's schedule is edited IN THE SAME TRANSACTION as
 *                       the assign (the "Schedule & Assign" atomic flow).
 *   timeSlot          — OPTIONAL new time slot, paired with requestedDateTime.
 *
 * When requestedDateTime/timeSlot are omitted the assign behaviour + webhooks
 * are unchanged.
 *
 * OFFER MODEL: when the flag is ON *and* tbl_job_offer exists, a single-tech
 * assign() is reinterpreted as a 1-element POOL OFFER — it delegates to
 * offerToTechnicians() (job stays BOOKED, fk stays NULL, the tech gets an
 * offer + push) and the legacy hard-schedule path below is skipped entirely.
 * auto-assign.service.js calls assign() unchanged and transparently offers.
 *
 * A REASSIGN (the job already has a different technician, pre-start) is offered
 * the same way: the outgoing claim is released back to the pool first, then the
 * incoming technician is offered the job. The direct hard-schedule path below
 * is therefore reached only with the flag OFF, without tbl_job_offer, when the
 * same technician is re-assigned, or once the job has started.
 */
async function assign(jobId, { easyfixerId, reasonId, rescheduleReason, requestedDateTime, timeSlot }, actor) {
  logger.info('Assign job to technician · id=' + jobId + ' · easyfixerId=' + easyfixerId + (requestedDateTime ? ' · reschedule=yes' : ''));
  // This read chooses offer-vs-direct mode only. The selected path revalidates
  // lifecycle + job state under row locks before writing.
  const preloadedJob = await getJobMeta(jobId);
  if (!preloadedJob) {
    logger.warn('Assign job not found · id=' + jobId);
    const err = new Error('job not found'); err.status = 404; throw err;
  }

  // Normalise the optional schedule edit. Only when requestedDateTime is
  // supplied do we touch the job's date/time columns. time_slot is paired
  // (only written when a non-empty value is provided).
  const editSchedule = requestedDateTime != null && requestedDateTime !== '';
  // requestedDateTime is an IST WALL-CLOCK string (datetime-local
  // "YYYY-MM-DDTHH:mm" or date-only). Store it as the DB's literal
  // "YYYY-MM-DD HH:mm:ss" — do NOT pass a JS Date (new Date() of a
  // tz-less datetime-local is read as server-local and shifts hours on a
  // UTC host; mysql2 then re-converts). This matches how create() stores
  // requested_date_time as an IST literal.
  let newRequested = null;
  if (editSchedule) {
    const m = String(requestedDateTime).match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(:\d{2})?)?$/);
    if (!m) {
      const err = new Error('requestedDateTime is not a valid date'); err.status = 400; throw err;
    }
    const timePart = m[2] ? `${m[2]}${m[3] || ':00'}` : '00:00:00';
    newRequested = `${m[1]} ${timePart}`;
  }
  const hasSlot = timeSlot !== undefined && timeSlot !== null && timeSlot !== '';

  // THE OFFER MODEL: when the flag is ON *and* tbl_job_offer exists, a single
  // assign() becomes a 1-element POOL OFFER. Delegate to offerToTechnicians()
  // — the job stays BOOKED, fk_easyfixter_id stays NULL, the tech gets an
  // OFFERED row + push, and the legacy hard-schedule path below is skipped.
  // The optional schedule edit rides along in offerToTechnicians()'s own txn.
  const hasOfferTable = await jobOfferTableExists();
  if (offerFlowEnabled()
      && hasOfferTable
      && Number(preloadedJob.job_status) === STATUS.BOOKED
      && preloadedJob.fk_easyfixter_id == null) {
    return offerToTechnicians(jobId, [easyfixerId], actor, { requestedDateTime, timeSlot });
  }

  // THE OFFER MODEL, REASSIGN SIDE. Moving a job to a DIFFERENT technician has
  // to ask the incoming one to accept or reject, exactly as a first assignment
  // does — silently inheriting someone else's job is the defect this closes.
  // Release the outgoing claim first (offerToTechnicians refuses an owned job),
  // then offer: the incoming tech gets an OFFERED row + push, and their ACCEPT
  // is what schedules the job.
  //
  // Deliberately narrow — three gates, each closing a specific blast radius:
  //   • an owner exists AND differs from easyfixerId → a re-assign to the SAME
  //     technician falls through to the direct path (re-stamps the schedule, no
  //     pointless offer), and a first assignment was already handled above.
  //   • DIRECT_REJECTABLE_STATES (BOOKED/SCHEDULED) → a started job is never
  //     rewound to BOOKED; post-start reassigns keep the direct behaviour.
  //   • offerFlowEnabled() + hasOfferTable → flag OFF or pre-migration deploy
  //     behaves exactly as before.
  // No automated allocator reaches this: assignTopCandidate 409s on an
  // already-assigned job and bulkAssignUnassigned selects fk IS NULL only, so
  // both auto-assign callers land in the first-assignment branch above.
  const preloadedOwnerId = preloadedJob.fk_easyfixter_id == null
    ? null
    : Number(preloadedJob.fk_easyfixter_id);
  if (offerFlowEnabled()
      && hasOfferTable
      && preloadedOwnerId != null
      && preloadedOwnerId !== Number(easyfixerId)
      && DIRECT_REJECTABLE_STATES.has(Number(preloadedJob.job_status))) {
    // Eligibility is re-checked under lock inside offerToTechnicians, but check
    // it BEFORE releasing too: otherwise an ineligible incoming technician
    // leaves the job ownerless as the side effect of a request that then 400s.
    await assertTechniciansCanReceiveJobs([easyfixerId]);
    const releasedTechId = await releaseOwnedJobForReoffer(jobId, preloadedJob, { reasonId, rescheduleReason });
    logger.info('Job released for re-offer · id=' + jobId + ' · from=' + releasedTechId + ' · to=' + easyfixerId);
    // Tell the OUTGOING technician their job is gone. Fire-and-forget after the
    // release has COMMITTED — a push that beat the commit would announce a
    // removal that a rollback then undid. unassign() has the same gap and is
    // deliberately left alone here: this is the reassign path only.
    if (releasedTechId != null) {
      require('./job-offer-push.service')
        .sendJobRemovedPush(releasedTechId, { jobId })
        .catch(() => {});
    }
    // The outgoing technician has genuinely left the queue (fk cleared), so log
    // and signal it the way unassign() does. offerToTechnicians() fires no job
    // webhook by design — nomination is not assignment — so TechAssigned still
    // waits for the accept.
    await jobLog.logReschedule(jobId, {
      previousEasyfixerId: releasedTechId,
      newEasyfixerId: easyfixerId,
    }, actor);
    fireWebhook('RescheduleTech', jobId);
    return offerToTechnicians(jobId, [easyfixerId], actor, { requestedDateTime, timeSlot });
  }

  const lifecycleProjection = await easyfixerLifecycle.readProjection('e');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await assertTechniciansCanReceiveJobs([easyfixerId], conn, {
      forUpdate: true,
      lifecycleProjection,
    });

    const [[lockedJob]] = await conn.query(
      `SELECT job_id, job_status, fk_easyfixter_id
         FROM tbl_job
        WHERE job_id = ?
        FOR UPDATE`,
      [jobId],
    );
    if (!lockedJob) {
      const err = new Error('job not found'); err.status = 404; throw err;
    }

    // getJobMeta() above decides whether this request follows offer or direct
    // assignment semantics. Re-check the exact fields that made that decision
    // after taking the job lock; otherwise an unassign/cancel/accept racing in
    // between can be overwritten by this stale request.
    const preloadedOwner = preloadedJob.fk_easyfixter_id == null
      ? null
      : Number(preloadedJob.fk_easyfixter_id);
    const lockedOwner = lockedJob.fk_easyfixter_id == null
      ? null
      : Number(lockedJob.fk_easyfixter_id);
    if (Number(lockedJob.job_status) !== Number(preloadedJob.job_status)
        || lockedOwner !== preloadedOwner) {
      const err = new Error('job assignment changed; refresh and try again');
      err.status = 409;
      err.code = 'JOB_ASSIGNMENT_CHANGED';
      throw err;
    }
    if (NON_ASSIGNABLE_STATES.has(Number(lockedJob.job_status))) {
      const err = new Error('completed or cancelled jobs cannot be assigned');
      err.status = 409;
      err.code = 'JOB_NOT_ASSIGNABLE';
      throw err;
    }

    const isReassign = lockedJob.fk_easyfixter_id && lockedJob.fk_easyfixter_id !== easyfixerId;
    const now = new Date();

    // Build the SET list. The schedule edit (requested_date_time + time_slot)
    // rides along in the SAME UPDATE so "Schedule & Assign" is atomic.
    const sets = [
      'fk_easyfixter_id = ?',
      'scheduled_date_time = ?',
      'fk_scheduled_by = ?',
      `job_status = CASE WHEN job_status = ${STATUS.BOOKED} THEN ${STATUS.SCHEDULED} ELSE job_status END`,
      'first_scheduled_by = COALESCE(first_scheduled_by, ?)',
      // original_scheduling_date_time — first-schedule capture (set ONCE; legacy
      // parity with first_scheduled_by). COALESCE preserves it on later moves.
      'original_scheduling_date_time = COALESCE(original_scheduling_date_time, ?)',
      'last_update_time = ?',
    ];
    // Value order tracks the placeholders above (job_status has no ?):
    // fk_easyfixter_id, scheduled_date_time, fk_scheduled_by, first_scheduled_by,
    // original_scheduling_date_time, last_update_time.
    const values = [easyfixerId, now, actor?.user_id || null, actor?.user_id || null, now, now];
    if (editSchedule) {
      sets.push('requested_date_time = ?');
      values.push(newRequested);
      // requested_time = the 1-HOUR START of the edited appointment. Skipped on
      // a date-only edit so the midnight sentinel can't wipe a real time.
      if (hasTimeOfDay(newRequested)) {
        sets.push('requested_time = ?');
        values.push(wallClockTime(newRequested));
      }
    }
    // time_slot is written as a BAND — never the raw picker label (see
    // resolveTimeSlot). Derived from the edited appointment time when the edit
    // carries a REAL time-of-day, else canonicalised from whatever label the
    // caller sent — and written at all only when one of those exists.
    //
    // ⚠ hasTimeOfDay is the guard that stops a DATE-ONLY requestedDateTime
    // (which assignBody accepts) from resolving to 'After Hours' via the 00:00
    // sentinel and clobbering a good stored band. Same fix as offerToTechnicians.
    const slotSource  = (editSchedule && hasTimeOfDay(newRequested)) ? newRequested : null;
    const slotToStore = (slotSource || hasSlot)
      ? resolveTimeSlot(hasSlot ? timeSlot : null, slotSource)
      : null;
    if (slotToStore) {
      sets.push('time_slot = ?');
      values.push(slotToStore);
    }
    values.push(jobId);

    await conn.query(
      `UPDATE tbl_job SET ${sets.join(', ')} WHERE job_id = ?`,
      values
    );

    // Direct assignment/reassignment makes every prior pool offer obsolete.
    // Close them while holding the job lock so flag changes and mixed-version
    // replicas cannot leave a stale decision that another technician can see.
    if (hasOfferTable) {
      await conn.query(
        `UPDATE tbl_job_offer
            SET offer_status = ${OFFER_STATUS.EXPIRED}, responded_at = NOW()
          WHERE job_id = ? AND offer_status = ${OFFER_STATUS.OFFERED}`,
        [jobId],
      );
    }

    await conn.query(
      `INSERT INTO scheduling_history (job_id, easyfixer_id, schedule_time, reason_id, reschedule_reason)
       VALUES (?, ?, ?, ?, ?)`,
      // When the schedule is being edited, schedule_history captures the NEW
      // requested time as the schedule_time so the audit trail reflects the
      // promised appointment, not just the commit instant.
      [jobId, easyfixerId, editSchedule ? newRequested : now,
       isReassign ? (reasonId || null) : null,
       isReassign ? (rescheduleReason || null) : null]
    );

    await conn.commit();
    logger.info('Job ' + (isReassign ? 'reassigned' : 'assigned') + ' · id=' + jobId + ' · easyfixerId=' + easyfixerId);

    // tbl_job_logs: legacy splits these two the same way the webhook above does
    // — a FIRST scheduling is 'schedule', a change of technician is
    // 'Re-Scheduling' carrying who was on it before.
    if (isReassign) {
      // No Sched_by / Sched_date fragment here: the locked SELECT above reads
      // only what the assignment itself needs, and re-reading the row after the
      // UPDATE would report the NEW scheduling as the old one. logReschedule
      // omits the parts it is not given rather than writing 'null' into them.
      await jobLog.logReschedule(jobId, {
        previousEasyfixerId: lockedJob.fk_easyfixter_id,
        newEasyfixerId: easyfixerId,
      }, actor);
    } else {
      await jobLog.logSchedule(jobId, actor);
    }

    fireWebhook(isReassign ? 'RescheduleTech' : 'TechAssigned', jobId);

    // Assigning a technician is Ops handling the job — clear any pending request.
    await resolveCustomerRequests(jobId);
    return getById(jobId);
  } catch (e) {
    await conn.rollback();
    logger.error('Assign job failed, rolled back · id=' + jobId + ' · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }
}

// ─── Unassign technician (mobile reject path) ───────────────────────
/*
 * Reverses an assign: clears `fk_easyfixter_id`, drops the job back to
 * BOOKED, records the reason in `scheduling_history`. Used when the
 * technician rejects an assigned job from the app — the job has to
 * become re-claimable by ops + the auto-assign engine.
 *
 * Distinct from `setStatus()` (which mutates the status column +
 * stamps audit fields per the transition map). Distinct from
 * `assign()` (which sets the tech). Distinct from `changeOwner()`
 * (which mutates `job_owner`, not `fk_easyfixter_id`).
 *
 * Why a dedicated function rather than reusing `setStatus()` with
 * extras: this write spans two tables (UPDATE tbl_job + INSERT
 * scheduling_history) in a transaction, AND clears fk_easyfixter_id
 * which isn't a tier-side-effect column — it's the assignment FK
 * itself. Keeping it as its own canonical function means CRM can
 * later expose an admin /unassign endpoint that flows through the
 * same code path (e.g. for "tech is sick — reset this job") without
 * duplicating the transactional logic.
 *
 *   jobId  : the job to unassign
 *   reason : free-text reason (required — written to scheduling_history.reschedule_reason)
 *   actor  : { user_id?: number | null } — stamps `fk_scheduled_by` audit
 *
 * Fires the `RescheduleTech` webhook (same as a re-assignment) so
 * client integrations downstream see the job leave the tech's queue.
 * Returns the full getById() payload so callers can use it for
 * response immediately.
 */
function normalizeUnassignReason(reason, jobId) {
  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    logger.warn('Unassign rejected, reason required · id=' + jobId);
    const err = new Error('reason is required to unassign a job'); err.status = 400; throw err;
  }
  return reason.trim();
}

/*
 * Apply the shared direct-assignment rejection while the caller holds the job
 * row lock. Keeping these writes in one helper lets admin/legacy unassign and
 * mobile reject share the exact transaction without duplicating audit logic.
 */
async function applyUnassignLocked(conn, jobId, lockedJob, {
  reason,
  reasonId,
  hasOfferTable,
}) {
  const techIdAtUnassign = lockedJob.fk_easyfixter_id;
  if (techIdAtUnassign == null) return null;
  if (!DIRECT_REJECTABLE_STATES.has(Number(lockedJob.job_status))) {
    const err = new Error('only pre-start jobs can be rejected');
    err.status = 409;
    err.code = 'JOB_NOT_REJECTABLE';
    throw err;
  }
  const now = new Date();
  const [updated] = await conn.query(
    `UPDATE tbl_job
        SET fk_easyfixter_id = NULL,
            scheduled_date_time = NULL,
            job_status = ${STATUS.BOOKED},
            last_update_time = ?
      WHERE job_id = ? AND fk_easyfixter_id = ?`,
    [now, jobId, techIdAtUnassign],
  );
  if (Number(updated.affectedRows) !== 1) {
    const err = new Error('job assignment changed; refresh and try again');
    err.status = 409;
    err.code = 'JOB_ASSIGNMENT_CHANGED';
    throw err;
  }
  await conn.query(
    `INSERT INTO scheduling_history (job_id, easyfixer_id, schedule_time, reason_id, reschedule_reason)
     VALUES (?, ?, ?, NULL, ?)`,
    [jobId, techIdAtUnassign, now, reason],
  );

  if (hasOfferTable) {
    // Historical duplicate OPEN rows must not all become fresh rejection
    // decisions. Only the latest row can represent this technician's current
    // offer, matching accept/list/membership semantics.
    await conn.query(
      `UPDATE tbl_job_offer
          SET offer_status = ${OFFER_STATUS.REJECTED}, reject_reason = ?, reject_reason_id = ?, responded_at = NOW()
        WHERE job_offer_id = (
          SELECT latest_id FROM (
            SELECT MAX(job_offer_id) AS latest_id
              FROM tbl_job_offer
             WHERE job_id = ? AND fk_easyfixter_id = ?
          ) latest_offer
        )
          AND offer_status = ${OFFER_STATUS.OFFERED}`,
      [reason, reasonId != null ? reasonId : null, jobId, techIdAtUnassign],
    );
  }
  return Number(techIdAtUnassign);
}

async function unassign(jobId, { reason, reasonId }, actor) {
  logger.info('Unassign job · id=' + jobId + (reasonId != null ? ' · reasonId=' + reasonId : ''));
  const normalizedReason = normalizeUnassignReason(reason, jobId);
  const hasOfferTable = await jobOfferTableExists();
  const conn = await pool.getConnection();
  let techIdAtUnassign = null;
  try {
    await conn.beginTransaction();
    const [[lockedJob]] = await conn.query(
      `SELECT job_id, job_status, fk_easyfixter_id
         FROM tbl_job
        WHERE job_id = ?
        FOR UPDATE`,
      [jobId],
    );
    if (!lockedJob) {
      logger.warn('Unassign job not found · id=' + jobId);
      const err = new Error('job not found'); err.status = 404; throw err;
    }
    techIdAtUnassign = await applyUnassignLocked(conn, jobId, lockedJob, {
      reason: normalizedReason,
      reasonId,
      hasOfferTable,
    });
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    logger.error('Unassign job failed, rolled back · id=' + jobId + ' · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }

  if (techIdAtUnassign == null) {
    // Nothing to unassign — treat as a soft no-op so retries remain idempotent.
    logger.info('Unassign no-op, job has no technician · id=' + jobId);
  } else {
    logger.info('Job unassigned · id=' + jobId + ' · removedTech=' + techIdAtUnassign);
    // Reschedule-shaped event (job is leaving the tech's queue).
    // Clients that already received a TechAssigned for this job will
    // get a RescheduleTech to invalidate downstream state.
    fireWebhook('RescheduleTech', jobId);
  }
  return getById(jobId);
}

// ─── Accept a job offer (mobile accept path) ────────────────────────
/*
 * THE OFFER MODEL accept side — FIRST-WINS race-safe. A pool-offered job has
 * been offered to MANY techs at once; the first to accept claims it.
 *
 * The whole race resolves on a single conditional UPDATE:
 *   UPDATE tbl_job SET job_status = SCHEDULED, fk_easyfixter_id = ?
 *    WHERE job_id = ? AND job_status = BOOKED AND fk_easyfixter_id IS NULL
 * - affectedRows === 1  → this tech WON: stamp the fk + SCHEDULED, mark their
 *   offer ACCEPTED (1), EXPIRE (3) every other still-open sibling offer.
 * - affectedRows === 0  → already taken (fk already set, or status moved on):
 *   EXPIRE this tech's own open offer and throw a 409.
 *
 * Tolerant of tbl_job_offer being absent (un-migrated deploy): the offer-row
 * updates are skipped, and because legacy single-assign already SET the fk, the
 * `fk_easyfixter_id IS NULL` guard would always fail — so when the table is
 * absent we fall back to the prior unconditional-on-fk bump (`WHERE
 * job_status = BOOKED`) so the legacy accept path still works.
 *
 *   jobId : the offered job
 *   efrId : the accepting technician (tbl_easyfixer.efr_id)
 *
 * Returns a compact acknowledgement on success; throws { status: 409 } when
 * another technician already accepted. The mobile route does not consume a
 * hydrated job, so avoiding getById() here prevents several post-commit detail
 * and image queries from turning a successful claim into a false 500.
 */
async function acceptOffer(jobId, efrId) {
  logger.info('Accept job offer · id=' + jobId + ' · efrId=' + efrId);
  const [hasOfferTable, lifecycleProjection] = await Promise.all([
    jobOfferTableExists(),
    easyfixerLifecycle.readProjection('e'),
  ]);
  const conn = await pool.getConnection();
  // `committed` guards the catch so a post-commit throw (the 409 path) doesn't
  // issue a ROLLBACK against an already-committed transaction.
  let committed = false;
  try {
    await conn.beginTransaction();

    // A technician can become restricted after receiving an offer. Lock and
    // re-check lifecycle in the same transaction as the first-wins claim.
    await assertTechniciansCanReceiveJobs([efrId], conn, {
      forUpdate: true,
      lifecycleProjection,
    });

    if (!hasOfferTable) {
      // Legacy fallback: no offer pool. Single-assign already set the fk, so we
      // can't gate on fk IS NULL — but the accepting technician must still own
      // the job. Otherwise any eligible technician could claim another tech's
      // legacy BOOKED assignment by guessing its id.
      const [legacyClaim] = await conn.query(
        `UPDATE tbl_job
            SET job_status = ${STATUS.SCHEDULED}
          WHERE job_id = ?
            AND job_status = ${STATUS.BOOKED}
            AND fk_easyfixter_id = ?`,
        [jobId, efrId],
      );
      await conn.commit();
      committed = true;
      if (Number(legacyClaim.affectedRows) !== 1) {
        const err = new Error('This job offer is no longer available');
        err.status = 409;
        throw err;
      }
      /*
       * TechAssigned fires HERE, on acceptance — not when the offer was made.
       *
       * Legacy fired it the moment job_status became PENDING_TO_START (=1)
       * with a technician attached (EasyfixerCallRecordServiceImpl.java:183),
       * i.e. on the tech's accept, never on the nomination. assign()'s own
       * fire covers the direct hard-schedule path, which performs the same
       * BOOKED→SCHEDULED transition inline; the offer path returns before
       * reaching it, so these are mutually exclusive and cannot double-fire.
       *
       * Post-commit deliberately: the dispatcher re-reads the job to build the
       * payload, so firing inside the transaction would race its own write.
       */
      fireWebhook('TechAssigned', jobId);
      // 'schedule' in tbl_job_logs. Under THE OFFER MODEL assign() delegates to
      // offerToTechnicians() and returns without scheduling anyone, so the
      // acceptance IS the scheduling event — log it here or the history loses
      // 'schedule' entirely on every offer-flow job.
      await jobLog.logSchedule(jobId, { efr_id: efrId });
      return { accepted: true, jobId: Number(jobId) };
    }

    /*
     * Race-safe claim. Only succeeds while the job is still BOOKED *and* owner-
     * less — `job_status = BOOKED AND fk_easyfixter_id IS NULL` IS the atomic
     * first-wins gate, and it is what makes concurrent accepts safe. That
     * property does NOT depend on the freshness clause below.
     *
     * FRESHNESS gate (this tech's own open offer still inside OFFER_TTL_MINUTES)
     * is TTL ENFORCEMENT, not race safety: it exists to stop a tech accepting a
     * >30-min stale offer in the gap between expiry-cron ticks. So it belongs to
     * the SAME regime switch as the sweep and the CRM chip:
     *
     *   expiry ON  → enforce it. Identical comparison to offerColumns()'s
     *                "effectively open", so the CRM can never show an offer as
     *                live that this path would refuse.
     *   expiry OFF → DROP it. `job.offer_expiry.enabled = 'false'` means offers
     *                must not expire at all; keeping a hard 30-minute refusal
     *                here would make that setting a no-op in practice — the CRM
     *                would advertise an open offer while the technician's app
     *                silently rejected it. Race safety is unaffected.
     */
    const enforceTtl = offerExpiryEnabled();
    const freshnessClause = enforceTtl
      ? ' AND jo.offered_at >= NOW() - INTERVAL ? MINUTE'
      : '';
    const claimParams = enforceTtl
      ? [efrId, jobId, jobId, efrId, OFFER_TTL_MINUTES]
      : [efrId, jobId, jobId, efrId];
    const [r] = await conn.query(
      `UPDATE tbl_job
          SET job_status = ${STATUS.SCHEDULED}, fk_easyfixter_id = ?
        WHERE job_id = ? AND job_status = ${STATUS.BOOKED} AND fk_easyfixter_id IS NULL
          AND EXISTS (
            SELECT 1 FROM tbl_job_offer jo
             WHERE jo.job_id = ? AND jo.fk_easyfixter_id = ?
               AND jo.offer_status = ${OFFER_STATUS.OFFERED}
               AND jo.job_offer_id = (
                 SELECT MAX(latest.job_offer_id)
                   FROM tbl_job_offer latest
                  WHERE latest.job_id = jo.job_id
                    AND latest.fk_easyfixter_id = jo.fk_easyfixter_id
               )${freshnessClause}
          )`,
      claimParams,
    );

    if (r.affectedRows === 1) {
      // This tech claimed it: accept ONLY their latest offer. Historical open
      // rows can survive old retries/migrations; accepting all of them would
      // contradict the latest-row membership rule used everywhere else.
      const [acceptedOffer] = await conn.query(
        `UPDATE tbl_job_offer
            SET offer_status = ${OFFER_STATUS.ACCEPTED}, responded_at = NOW()
          WHERE job_offer_id = (
            SELECT latest_id FROM (
              SELECT MAX(job_offer_id) AS latest_id
                FROM tbl_job_offer
               WHERE job_id = ? AND fk_easyfixter_id = ?
            ) latest_offer
          )
            AND offer_status = ${OFFER_STATUS.OFFERED}`,
        [jobId, efrId],
      );
      if (Number(acceptedOffer.affectedRows) !== 1) {
        const err = new Error('This job offer is no longer available');
        err.status = 409;
        throw err;
      }
      await conn.query(
        `UPDATE tbl_job_offer SET offer_status = ${OFFER_STATUS.EXPIRED}, responded_at = NOW()
          WHERE job_id = ? AND offer_status = ${OFFER_STATUS.OFFERED}`,
        [jobId],
      );
      await conn.commit();
      committed = true;
      logger.info('Job offer accepted (won race) · id=' + jobId + ' · efrId=' + efrId);
      // Acceptance = the legacy TechAssigned moment. See the note on the
      // sibling claim path above; only the winner of the race reaches here.
      fireWebhook('TechAssigned', jobId);
      // 'schedule' — see the note on the sibling claim path above.
      await jobLog.logSchedule(jobId, { efr_id: efrId });
      return { accepted: true, jobId: Number(jobId) };
    }

    // Lost the race (someone else won, or the job already moved on). Expire this
    // tech's own open offer, commit that, and flag a 409 to throw post-finally.
    await conn.query(
      `UPDATE tbl_job_offer SET offer_status = ${OFFER_STATUS.EXPIRED}, responded_at = NOW()
        WHERE job_id = ? AND fk_easyfixter_id = ? AND offer_status = ${OFFER_STATUS.OFFERED}`,
      [jobId, efrId],
    );
    await conn.commit();
    committed = true;
  } catch (e) {
    if (!committed) await conn.rollback();
    logger.error('Accept offer failed · id=' + jobId + ' · efrId=' + efrId + ' · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }

  // Reached only on the lost-race path (the success paths returned inside try).
  // affectedRows=0 means one of: another tech won, the job moved on, OR this
  // tech's offer expired (>30 min / cron-expired) — so the message is neutral
  // rather than asserting another tech necessarily took it.
  logger.warn('Job offer no longer available (lost race or expired) · id=' + jobId + ' · efrId=' + efrId);
  throw Object.assign(new Error('This job offer is no longer available'), { status: 409 });
}

/*
 * True when this technician has a LIVE (open, status=0) offer on the job. Under
 * the offer-pool model a job stays fk_easyfixter_id=NULL until accepted, so the
 * "is this my job" fk check would 404 a job that's merely OFFERED to the tech —
 * this lets the mobile detail GET + reject allow an offered (not-yet-accepted)
 * tech through. Returns false when tbl_job_offer is absent (legacy deploy), so
 * callers fall back to the fk-ownership check.
 */
async function techHasOpenOffer(jobId, efrId) {
  try {
    if (!(await jobOfferTableExists())) return false;
    const lifecycleEligibility = await easyfixerWorkEligibility.sqlPredicate('e');
    const freshnessClause = offerExpiryEnabled()
      ? `AND jo.offered_at >= NOW() - INTERVAL ${OFFER_TTL_MINUTES} MINUTE`
      : '';
    const [[row]] = await pool.query(
      `SELECT 1 AS ok
         FROM tbl_job_offer jo
         JOIN tbl_easyfixer e ON e.efr_id = jo.fk_easyfixter_id
         JOIN tbl_job j ON j.job_id = jo.job_id
        WHERE jo.job_id = ?
          AND jo.fk_easyfixter_id = ?
          AND jo.offer_status = ${OFFER_STATUS.OFFERED}
          AND jo.job_offer_id = (
            SELECT MAX(latest.job_offer_id)
              FROM tbl_job_offer latest
             WHERE latest.job_id = jo.job_id
               AND latest.fk_easyfixter_id = jo.fk_easyfixter_id
          )
          AND j.job_status = ${STATUS.BOOKED}
          AND j.fk_easyfixter_id IS NULL
          AND ${lifecycleEligibility}
          ${freshnessClause}
        LIMIT 1`,
      [jobId, efrId],
    );
    return !!row;
  } catch { return false; }
}

/*
 * Reject just THIS tech's offer on a pool-offered job: stamps their open offer
 * REJECTED (status=2) + reason WITHOUT touching tbl_job — the job stays BOOKED
 * and offered to the other technicians (candidate-ranking already excludes any
 * tech with an offer row, so they won't be re-offered). On a legacy deploy (no
 * offer table) it falls back to the shared unassign() single-assign reject.
 */
async function rejectOffer(jobId, efrId, { reason, reasonId } = {}) {
  logger.info('Reject job offer · id=' + jobId + ' · efrId=' + efrId + (reasonId != null ? ' · reasonId=' + reasonId : ''));
  const normalizedReason = normalizeUnassignReason(reason, jobId);
  const hasOfferTable = await jobOfferTableExists();
  // Resolve schema-dependent SQL before opening the transaction. Permission is
  // re-evaluated from the technician row locked below, closing the middleware-
  // to-write lifecycle transition race.
  const lifecycleProjection = await easyfixerLifecycle.readProjection('e');
  const conn = await pool.getConnection();
  let unassignedTechId = null;
  try {
    await conn.beginTransaction();

    // Use the same global lock order as offer/accept/lifecycle writes.
    const [[tech]] = await conn.query(
      `SELECT e.efr_id, e.efr_status, e.is_technician_verified,
              e.efr_manager_id, e.scheduled_reactivation_date,
              ${lifecycleProjection}
         FROM tbl_easyfixer e
        WHERE e.efr_id = ?
        FOR UPDATE`,
      [efrId],
    );
    if (!tech) {
      const err = new Error('job not found'); err.status = 404; throw err;
    }
    const lockedLifecycle = easyfixerLifecycle.lifecycleFromRow(tech);
    if (lockedLifecycle.capabilities.receiveNewJobs !== true
        && lockedLifecycle.capabilities.mutateAssignedJobs !== true) {
      const err = new Error(
        `technician lifecycle ${lockedLifecycle.status} does not allow offer rejection`,
      );
      err.status = 403;
      err.code = 'TECH_LIFECYCLE_CAPABILITY_REQUIRED';
      err.details = {
        capabilities: ['receiveNewJobs', 'mutateAssignedJobs'],
        lifecycleStatus: lockedLifecycle.status,
      };
      throw err;
    }
    const [[lockedJob]] = await conn.query(
      `SELECT job_id, job_status, fk_easyfixter_id
         FROM tbl_job
        WHERE job_id = ?
        FOR UPDATE`,
      [jobId],
    );
    if (!lockedJob) {
      const err = new Error('job not found'); err.status = 404; throw err;
    }

    let latestOffer = null;
    if (hasOfferTable) {
      [[latestOffer]] = await conn.query(
        `SELECT job_offer_id, offer_status
           FROM tbl_job_offer
          WHERE job_id = ? AND fk_easyfixter_id = ?
          ORDER BY job_offer_id DESC
          LIMIT 1
          FOR UPDATE`,
        [jobId, efrId],
      );
    }

    const isPoolDecision = Number(lockedJob.job_status) === STATUS.BOOKED
      && lockedJob.fk_easyfixter_id == null;
    const isDirectOwner = Number(lockedJob.fk_easyfixter_id) === Number(efrId);

    if (isPoolDecision) {
      // Offer decisions are first-wins. An accept/expiry/re-offer that commits
      // first changes either the locked job or latest row, so this request must
      // return 409 rather than acknowledge a rejection that did not happen.
      if (!latestOffer) {
        const err = new Error('This job offer is no longer available'); err.status = 409; throw err;
      }
      const enforceTtl = offerExpiryEnabled();
      const freshnessClause = enforceTtl
        ? ' AND offered_at >= NOW() - INTERVAL ? MINUTE'
        : '';
      const updateParams = enforceTtl
        ? [normalizedReason, reasonId != null ? reasonId : null, latestOffer.job_offer_id, OFFER_TTL_MINUTES]
        : [normalizedReason, reasonId != null ? reasonId : null, latestOffer.job_offer_id];
      const [rejected] = await conn.query(
        `UPDATE tbl_job_offer
            SET offer_status = ${OFFER_STATUS.REJECTED}, reject_reason = ?, reject_reason_id = ?, responded_at = NOW()
          WHERE job_offer_id = ?
            AND offer_status = ${OFFER_STATUS.OFFERED}${freshnessClause}`,
        updateParams,
      );
      if (Number(rejected.affectedRows) !== 1) {
        const err = new Error('This job offer is no longer available'); err.status = 409; throw err;
      }
    } else if (isDirectOwner) {
      // Branch from the locked job, not historical offer rows. Direct
      // assignments legitimately coexist with OPEN/REJECTED/EXPIRED history in
      // rolling and kill-switch deployments. ACCEPTED is the exception: it
      // proves an accept decision already won this job-lock race.
      if (latestOffer && Number(latestOffer.offer_status) === OFFER_STATUS.ACCEPTED) {
        const err = new Error('This job offer is no longer available'); err.status = 409; throw err;
      }
      unassignedTechId = await applyUnassignLocked(conn, jobId, lockedJob, {
        reason: normalizedReason,
        reasonId,
        hasOfferTable,
      });
    } else {
      const noLongerAvailable = lockedJob.fk_easyfixter_id == null || latestOffer != null;
      const err = new Error(noLongerAvailable
        ? 'This job offer is no longer available'
        : 'job not found');
      err.status = noLongerAvailable ? 409 : 404;
      throw err;
    }

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    logger.error('Reject offer failed, rolled back · id=' + jobId + ' · efrId=' + efrId + ' · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }

  if (unassignedTechId != null) fireWebhook('RescheduleTech', jobId);
  // The mobile route returns its own compact acknowledgement and discards job
  // detail. Avoid a post-commit full hydration here: it adds several queries
  // and could turn a successful decision into a false 500 on read failure.
  return {
    rejected: true,
    jobId: Number(jobId),
    legacyUnassigned: unassignedTechId != null,
  };
}

// ─── List the techs currently offered a job (CRM "Offered to N") ────
/*
 * Returns every technician with a LIVE (open, status=0) offer on the given
 * job — newest offer first — so the CRM can expand "Offered to N" into the
 * actual roster. Returns [] when tbl_job_offer doesn't exist (un-migrated
 * deploy), so callers never need their own table-probe.
 *
 *   jobId : the job whose open offers to list
 *
 * Each row: { efr_id, efr_name, offered_at }.
 */
async function listOffers(jobId, { sweep = true } = {}) {
  logger.info('List offers for job · id=' + jobId);
  if (!(await jobOfferTableExists())) return [];
  /*
   * Lazy expiry: sweep THIS job's stale open offers before reading, so an offer
   * older than 30 min surfaces as EXPIRED even when the scheduler cron is off
   * (CRON_DISABLED) or between its 2-min ticks. Idempotent + job-scoped.
   *
   * `sweep:false` makes the read PURE. Added for the Pending-for-Scheduling
   * hover card, which fires on mouse-over: sweeping there would let merely
   * pointing at a row mutate offer state and flip the list's own chip from
   * "Offered to Tx" to "Expired/Rejected" under the operator's cursor. Ops
   * surfaces that ACT on offers keep the sweep; surfaces that merely LOOK
   * do not.
   */
  if (sweep) await expireStaleOffers(OFFER_TTL_MINUTES, jobId);
  // Latest offer row PER technician — a re-offer can leave more than one row for
  // the same (job, tech), so MAX(job_offer_id) picks the current one. Surfaced
  // states: OFFERED (live), REJECTED, EXPIRED — the Schedule & Assign modal shows
  // all three so ops can see who declined / timed out, not just live offers.
  // ACCEPTED is excluded (that job is already assigned and leaves this modal).
  // Order: live → rejected → expired, newest-first within each bucket.
  const [rows] = await pool.query(
    `SELECT jo.fk_easyfixter_id AS efr_id, ef.efr_name, jo.offered_at, jo.responded_at,
            jo.offer_status, jo.offer_status_label, jo.offer_count, jo.offer_source,
            jo.reject_reason,
            -- efr_no is the canonical technician mobile; the mask-mobile
            -- middleware redacts it in transit, and click-to-call re-resolves
            -- the real number server-side from efr_id, so the FE never holds it.
            ef.efr_no AS mobile,
            -- Who made the offer (NULL on offers predating the column, and on
            -- anything the auto-assign engine offered).
            jo.offered_by_user_id, ob.user_name AS offered_by_name
       FROM tbl_job_offer jo
       JOIN (SELECT fk_easyfixter_id, MAX(job_offer_id) AS mid
               FROM tbl_job_offer
              WHERE job_id = ?
              GROUP BY fk_easyfixter_id) latest ON latest.mid = jo.job_offer_id
       JOIN tbl_easyfixer ef ON ef.efr_id = jo.fk_easyfixter_id
       LEFT JOIN tbl_user ob ON ob.user_id = jo.offered_by_user_id
      WHERE jo.offer_status IN (${OFFER_STATUS.OFFERED}, ${OFFER_STATUS.REJECTED}, ${OFFER_STATUS.EXPIRED})
      ORDER BY FIELD(jo.offer_status, ${OFFER_STATUS.OFFERED}, ${OFFER_STATUS.REJECTED}, ${OFFER_STATUS.EXPIRED}),
               jo.offered_at DESC`,
    [jobId],
  );
  logger.info('Found ' + rows.length + ' offers (live+rejected+expired) · jobId=' + jobId);
  return rows;
}

// ─── Reschedule a job's appointment (Schedule & Assign → Reschedule) ─
/*
 * Explicit, audited reschedule. Distinct from assign(): it moves the
 * appointment (requested_date_time + requested_time + the two derived slot
 * columns) and re-stamps the schedule audit (scheduled_date_time +
 * fk_scheduled_by = THIS reschedule) — but never the technician, and never the
 * ORIGINAL-schedule columns (first_scheduled_by / original_scheduling_date_time
 * stay put). ALWAYS captures reason + remarks. The modal's Date/Time fields are
 * read-only; this is the sole path that moves them. All three inputs are
 * mandatory (rescheduleBody validates at the route). Transactional:
 *   1. tbl_job.requested_date_time / requested_time / time_slot /
 *      booking_cut_off_time_slot / scheduled_date_time / fk_scheduled_by
 *   2. scheduling_history (reason_id + reschedule_reason) — same shape as assign
 *   3. any OPEN offers on this job → EXPIRED (they were made for the OLD slot,
 *      so a tech must not be able to accept a now-stale appointment)
 * Then a tbl_job_comment audit row (comment_on=1, enum_reason_id, remarks) is
 * added outside the txn (addComment also mirrors to tbl_job.remarks). Returns
 * the refreshed job detail.
 */
async function reschedule(jobId, { requestedDateTime, reasonId, rescheduleReason, remarks }, actor) {
  logger.info('Reschedule job · id=' + jobId + ' · reasonId=' + reasonId);
  // time_slot is read only as the FALLBACK for a date-only reschedule (no
  // time-of-day to derive a band from) — see resolveTimeSlot below.
  // scheduled_date_time / fk_scheduled_by are read only to describe the schedule
  // being REPLACED in the 'Re-Scheduling' history row at the end; both are
  // overwritten by the UPDATE below, so they have to be captured up front.
  const [[existing]] = await pool.query(
    'SELECT job_id, fk_easyfixter_id, time_slot, scheduled_date_time, fk_scheduled_by FROM tbl_job WHERE job_id = ? LIMIT 1',
    [jobId],
  );
  if (!existing) { const err = new Error('job not found'); err.status = 404; throw err; }

  // Parse the IST wall-clock string exactly like assign() — NEVER new Date()/
  // toISOString() it (UTC↔IST day shift). Produces 'YYYY-MM-DD HH:MM:SS'.
  const m = String(requestedDateTime).match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(:\d{2})?)?$/);
  if (!m) { const err = new Error('requestedDateTime is not a valid date'); err.status = 400; throw err; }
  const newRequested = `${m[1]} ${m[2] ? `${m[2]}${m[3] || ':00'}` : '00:00:00'}`;
  /*
   * Re-derive both slot columns from the new appointment time so time_slot and
   * booking_cut_off_time_slot stay coherent with requested_date_time.
   *
   * time_slot always becomes the BAND containing the new appointment time. The
   * 1-hour frame the operator picked is not lost — it IS the new time-of-day,
   * carried by requested_date_time and requested_time (written just below).
   *
   * The `existing.time_slot` argument only comes into play for a DATE-ONLY
   * reschedule ('2026-07-20' with no time): there is no hour to band, so the
   * job's current label is canonicalised and kept rather than being clobbered
   * with 'After Hours' — the midnight sentinel must never masquerade as a real
   * appointment time.
   *
   * booking_cut_off_time_slot is a separate LEGACY derived column and keeps its
   * own legacy derivation — nothing matches on it.
   */
  const newTimeSlot = resolveTimeSlot(existing.time_slot, newRequested);
  const newCutoffSlot = deriveBookingCutoffSlot(newRequested);

  // Atomic core: the schedule move + offer-expiry must commit together (an
  // outstanding offer must never survive with the OLD slot). The audit rows
  // (scheduling_history + comment) are best-effort AFTER commit so a legacy
  // constraint can't fail the whole reschedule — critically, this flow runs on
  // UNASSIGNED jobs (fk_easyfixter_id NULL), and if scheduling_history.easyfixer_id
  // is legacy NOT NULL that insert would otherwise abort the whole operation.
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Reschedule also stamps the schedule AUDIT: scheduled_date_time +
    // fk_scheduled_by reflect the LATEST scheduling action (this reschedule);
    // first_scheduled_by / original_scheduling_date_time are deliberately NOT
    // touched (they hold the ORIGINAL schedule). requested_time is the legacy
    // HH:MM companion, re-derived from the new appointment so it stays coherent
    // with requested_date_time. (enum_reason_id / remarks / remarks_date_time +
    // the tbl_job_comment row are stamped by addComment below.) fk_scheduled_by
    // uses COALESCE so an actor-less auto-reschedule preserves the prior
    // scheduler. new Date() → pool tz +05:30 IST wall-clock, never SQL NOW().
    const rescheduledAt = new Date();
    const rescheduledBy = (actor && actor.user_id != null) ? actor.user_id : null;
    // requested_time = the 1-HOUR START, taken verbatim off the IST wall-clock
    // literal. NOT formatTimeIST(): that re-parses the string as a real instant
    // and adds +05:30 again, which on our UTC containers stored an IST 14:30
    // appointment as requested_time '20:00' (see wallClockTime's note).
    const newRequestedTime = wallClockTime(newRequested);
    await conn.query(
      `UPDATE tbl_job
          SET requested_date_time       = ?,
              requested_time            = ?,
              time_slot                 = COALESCE(?, time_slot),
              booking_cut_off_time_slot = COALESCE(?, booking_cut_off_time_slot),
              scheduled_date_time       = ?,
              fk_scheduled_by           = COALESCE(?, fk_scheduled_by),
              last_update_time          = ?
        WHERE job_id = ?`,
      [newRequested, newRequestedTime, newTimeSlot, newCutoffSlot, rescheduledAt, rescheduledBy, rescheduledAt, jobId],
    );
    // Open offers were extended for the OLD slot — expire them so no tech accepts
    // a stale appointment. Tolerant of a missing offer table (un-migrated deploys).
    if (await jobOfferTableExists()) {
      await conn.query(
        `UPDATE tbl_job_offer
            SET offer_status = ${OFFER_STATUS.EXPIRED}, responded_at = NOW()
          WHERE job_id = ? AND offer_status = ${OFFER_STATUS.OFFERED}`,
        [jobId],
      );
    }
    await conn.commit();
    logger.info('Job rescheduled · id=' + jobId + ' · newTime=' + newRequested);
  } catch (e) {
    await conn.rollback();
    logger.error('Reschedule failed, rolled back · id=' + jobId + ' · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }

  // 'Re-Scheduling' in tbl_job_logs, with the other post-commit audits below.
  // The technician is unchanged on this path (only the appointment moved), so it
  // appears on BOTH sides of the row — which is what the legacy rows look like
  // when only the time moved.
  await jobLog.logReschedule(jobId, {
    previousEasyfixerId: existing.fk_easyfixter_id,
    newEasyfixerId: existing.fk_easyfixter_id,
    previousScheduledBy: existing.fk_scheduled_by,
    previousScheduledAt: existing.scheduled_date_time,
  }, actor);

  // Audit (best-effort, post-commit). scheduling_history mirrors assign()'s shape
  // (reason_id + reschedule_reason label); easyfixer_id may be NULL on an
  // unassigned job. schedule_time = the NEW promised time.
  try {
    await pool.query(
      `INSERT INTO scheduling_history (job_id, easyfixer_id, schedule_time, reason_id, reschedule_reason)
       VALUES (?, ?, ?, ?, ?)`,
      [jobId, existing.fk_easyfixter_id || null, newRequested, reasonId || null, rescheduleReason || null],
    );
  } catch (e) {
    logger.warn('Reschedule scheduling_history insert failed (non-fatal) · id=' + jobId + ' · ' + e.message);
  }

  // Comment audit — addComment uses the pool + mirrors the latest remark to
  // tbl_job.remarks. comment_on=1 (lifecycle/schedule), reason FK in enum_reason_id,
  // new promised time in appointment_on, actor = CRM user.
  try {
    await require('./job-comment.service').addComment(jobId, {
      comments: remarks,
      comment_on: 1,
      commented_by: actor?.user_id || null,
      appointment_on: newRequested,
      enum_reason_id: reasonId || null,
    });
  } catch (e) {
    logger.warn('Reschedule audit comment failed (non-fatal) · id=' + jobId + ' · ' + e.message);
  }

  fireWebhook('RescheduleTech', jobId);
  // Ops rescheduled the job — directly handles a customer reschedule/cancel ask.
  await resolveCustomerRequests(jobId);
  return getById(jobId);
}

// ─── A technician's open offers (mobile "Offered to you" list) ──────
/*
 * Returns the jobs a technician currently holds a LIVE (open) offer for, each
 * as a full LIST-projection JobPreview row so the mobile app maps them with
 * the SAME mapper it uses for the opportunities list. Reuses list()'s
 * projection via its `jobIds` filter — single source of truth for the preview
 * shape, no parallel SELECT to drift out of sync.
 *
 *   efrId : the technician (tbl_easyfixer.efr_id)
 *   limit : max jobs to return (default 50)
 *
 * Each returned row also carries the OFFER's own timing, in the projection's
 * snake_case so the app reads one consistent naming style:
 *   offered_at — when this tech's live offer was (re)extended
 *   expires_at — offered_at + OFFER_TTL_MINUTES, i.e. the instant acceptOffer()
 *                will start rejecting it and the expiry cron will close it
 * Both are DERIVED IN SQL (DATE_ADD) off the row we already read, so there is no
 * extra query and — because the pool runs `dateStrings: true` — both arrive as
 * "YYYY-MM-DD HH:mm:ss" IST strings rather than tz-shifting Date objects.
 * Computing expires_at server-side (not in the app) keeps the 30-minute TTL a
 * single source of truth: change OFFER_TTL_MINUTES and every client follows.
 *
 * Returns { items } — [] when tbl_job_offer is absent.
 */
async function listOfferedForTech(efrId, { limit = 50 } = {}) {
  logger.info('List offered jobs for technician · efrId=' + efrId + ' · limit=' + limit);
  if (!(await jobOfferTableExists())) return { items: [] };
  const lifecycleEligibility = await easyfixerWorkEligibility.sqlPredicate('e');
  const expiryEnabled = offerExpiryEnabled();
  const freshnessClause = expiryEnabled
    ? `AND jo.offered_at >= NOW() - INTERVAL ${OFFER_TTL_MINUTES} MINUTE`
    : '';
  const expiresAtProjection = expiryEnabled
    ? `DATE_ADD(jo.offered_at, INTERVAL ${OFFER_TTL_MINUTES} MINUTE)`
    : 'NULL';
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  // Start from this technician's OPEN rows in offered_at order (served by
  // idx_job_offer_efr_status_open), then reject a row only when a newer history
  // row exists for the same job. This makes work proportional to CURRENT
  // offers and lets LIMIT stop the ordered index walk; the previous GROUP BY
  // materialised the technician's entire offer lifetime before the outer
  // LIMIT. The newer-row lookup is served by idx_job_offer_efr_job_latest.
  const [offerRows] = await pool.query(
    `SELECT jo.job_id, jo.offered_at,
            ${expiresAtProjection} AS expires_at
       FROM tbl_job_offer jo
       JOIN tbl_easyfixer e ON e.efr_id = jo.fk_easyfixter_id
       JOIN tbl_job j ON j.job_id = jo.job_id
      WHERE jo.fk_easyfixter_id = ?
        AND jo.offer_status = ${OFFER_STATUS.OFFERED}
        AND NOT EXISTS (
          SELECT 1
            FROM tbl_job_offer newer
           WHERE newer.fk_easyfixter_id = jo.fk_easyfixter_id
             AND newer.job_id = jo.job_id
             AND newer.job_offer_id > jo.job_offer_id
        )
        AND j.job_status = ${STATUS.BOOKED}
        AND j.fk_easyfixter_id IS NULL
        AND ${lifecycleEligibility}
        ${freshnessClause}
      ORDER BY jo.offered_at DESC
      LIMIT ?`,
    [efrId, safeLimit],
  );
  const ids = offerRows.map((r) => Number(r.job_id));
  if (!ids.length) return { items: [] };
  // Reuse the LIST projection (jobIds filter) so the app's existing JobPreview
  // mapper works unchanged. list() orders by job_id DESC; re-sort here to keep
  // the newest-offer-first order the tech expects.
  const { rows } = await list({ jobIds: ids, limit: ids.length });
  const order = new Map(ids.map((id, i) => [id, i]));
  rows.sort((a, b) => (order.get(Number(a.job_id)) ?? 0) - (order.get(Number(b.job_id)) ?? 0));
  // Stamp the offer timing back onto the preview rows. Keyed by job_id — one
  // OPEN offer per (job, tech) is an invariant of offerToTechnicians(), which
  // collapses stray duplicates, so this map can't lose a row.
  const timing = new Map(offerRows.map((r) => [Number(r.job_id), r]));
  for (const row of rows) {
    const t = timing.get(Number(row.job_id));
    if (!t) continue;
    row.offered_at = t.offered_at ?? null;
    row.expires_at = t.expires_at ?? null;
  }
  logger.info('Returning ' + rows.length + ' offered jobs · efrId=' + efrId);
  return { items: rows };
}

// ─── Change job owner (PM reassignment) ─────────────────────────────
// Distinct from /assign (which sets fk_easyfixter_id — the technician).
// This endpoint changes job_owner (the internal PM/user who runs the job).
// Always captures reason + timestamp + actor for the audit trail.
async function changeOwner(jobId, { newOwnerId, reason }, actor) {
  logger.info('Change job owner · id=' + jobId + ' · newOwnerId=' + newOwnerId);
  /*
   * ⚠ THIS MOVES job_client_owner, NOT job_owner.
   *
   * tbl_job carries two owner columns and they are different things:
   *   job_owner        — the internal EasyFix operator
   *   job_client_owner — the CLIENT's Primary SPOC, auto-resolved at creation
   *                      from tbl_vertical_mapping WHERE user_type = 1 (see
   *                      create() above)
   * Transfer Job Ownership wrote job_owner, which was the wrong column for
   * what the feature is for; product confirmed job_client_owner is the target.
   *
   * The `ownerId` LIST filter was moved to the same column in the same change.
   * That pairing is not cosmetic: routes/admin/jobs.js POST /bulk-owner-transfer
   * resolves its filters-mode target set with job.list({ ownerId: fromOwnerId }),
   * so if the list selected on one column while this wrote the other, a bulk
   * transfer would pick jobs by one owner and reassign a different owner's
   * jobs. Change one of these and you must change the other.
   */
  // Skip the full detail load — only the client owner matters for the no-op check.
  const [[existing]] = await pool.query(
    'SELECT job_id, job_client_owner FROM tbl_job WHERE job_id = ? LIMIT 1',
    [jobId]
  );
  if (!existing) {
    logger.warn('Change owner job not found · id=' + jobId);
    const err = new Error('job not found'); err.status = 404; throw err;
  }
  if (existing.job_client_owner === newOwnerId) {
    logger.warn('Change owner no-op, already owned · id=' + jobId + ' · ownerId=' + newOwnerId);
    const err = new Error(`job ${jobId} is already owned by user ${newOwnerId}`);
    err.status = 400; throw err;
  }

  // Validate target user exists, is active, and is an admin-group user.
  // (A client SPOC or technician can't own a CRM job.)
  const { classifyRoleIdSync } = require('./role.service');
  const [[target]] = await pool.query(
    `SELECT user_id, user_name, user_role, user_status FROM tbl_user WHERE user_id = ? LIMIT 1`,
    [newOwnerId]
  );
  if (!target) {
    const err = new Error(`target user ${newOwnerId} not found`); err.status = 400; throw err;
  }
  if (!target.user_status) {
    const err = new Error(`target user ${newOwnerId} is inactive`); err.status = 400; throw err;
  }
  const targetGroup = classifyRoleIdSync(target.user_role);
  if (targetGroup !== 'admin') {
    const err = new Error(`target user ${newOwnerId} is not in admin group (got "${targetGroup}")`);
    err.status = 400; throw err;
  }

  await pool.query(
    `UPDATE tbl_job
        SET job_client_owner = ?,
            job_owner_change_by = ?,
            owner_change_reason = ?,
            owner_change_date = ?,
            last_update_time = ?
      WHERE job_id = ?`,
    [newOwnerId, actor?.user_id || null, reason, new Date(), new Date(), jobId]
  );

  /*
   * job_primary_spoc is deliberately NOT re-stamped here. It used to be, back
   * when it snapshotted the owner's phone. It now snapshots the CLIENT's
   * vertical head, and an owner change moves the job between CRM operators
   * without touching the client — so the head cannot have changed and the
   * re-stamp would be two queries to write the identical value. A client
   * change (not possible on this route) would be the event that invalidates it.
   */

  logger.info('Job owner changed · id=' + jobId + ' · newOwnerId=' + newOwnerId);
  return getById(jobId);
}

/*
 * Invoked from create() via setImmediate when a new job is committed.
 * Reads tbl_autoallocation_setting.running_frequency (with per-client override
 * in tbl_client_setting) and, if 'instant', runs the auto-assign pipeline.
 * The actual assignment (including TechAssigned webhook + FCM push to the
 * chosen tech) is handled by auto-assign.service.js::assignTopCandidate(),
 * which calls our assign() above — so the full lifecycle (status bump,
 * scheduling_history row, notification fan-out) fires identically to a manual
 * assign by a human operator.
 */
async function tryAutoAssignOnCreate(jobId, clientId, actor) {
  const logger = require('../logger');
  const { getClientSetting } = require('./settings.service');
  const freq = await getClientSetting(clientId, 'running_frequency');
  if (freq !== 'instant') {
    logger.debug(`Auto-assign skipped for job ${jobId} — running_frequency=${freq ?? 'unset'}`);
    return;
  }
  const { assignTopCandidate } = require('./auto-assign.service');
  try {
    const result = await assignTopCandidate(jobId, actor);
    // A truthy `result.chosen` means `jobService.assign()` already committed
    // the transaction, so the job + scheduling_history row are safely persisted.
    // No email needed — downstream fan-out (webhook + FCM) is fire-and-forget
    // and has its own retry/DLQ plumbing. Per product: "Once auto assigned in
    // DB and status is saved, it's fine."
    if (result?.chosen) {
      logger.ready(`Auto-assigned job ${jobId} → ${result.chosen.efr_name} (efr_id=${result.chosen.efr_id}, score=${result.chosen.score})`);
      return;
    }
    // Defensive branch — assignTopCandidate should throw 422 on no-candidates
    // rather than return an empty result, but belt-and-braces.
    logger.warn(`Auto-assign found no eligible candidates for job ${jobId} — manual assignment required`);
    await notifyAutoAssignFailure(jobId, clientId, 'No eligible technician was found for this job.');
  } catch (err) {
    /*
     * Classify failures so the ops email conveys WHY nothing got assigned.
     * Categories we surface:
     *   422 → No eligible candidate (L1/L2 rejected everyone).
     *   404 → Job vanished between create + auto-assign (extremely rare).
     *   409 → Someone else assigned the job in the interval (manual operator
     *          won the race). This is NOT a failure — just log and skip email.
     *   other → DB save error, inactive efr, unexpected exception. Ops need
     *           to act because the job is still BOOKED with no tech.
     */
    if (err.status === 409) {
      logger.info(`Auto-assign skipped for job ${jobId} — already assigned (likely manual race): ${err.message}`);
      return;
    }
    // err.details (from assignTopCandidate) carries the ranker diagnostics:
    // { l1Count, rejectedCount, note, rejectedReasons }. Surface them in BOTH
    // the log and the ops email so "no technician" is explained, not opaque.
    const details = err.details || {};
    const reason =
      err.status === 422
        ? (details.l1Count > 0 && details.rejectedReasons
            ? `${details.l1Count} technician(s) matched the skill & area, but none were available: ${details.rejectedReasons}.`
            : 'No active, verified technician with the required skill was found for this job.')
      : err.status === 404 ? `Job could not be resolved (${err.message}).`
      : `Auto-assignment errored before the technician could be saved: ${err.message}`;
    logger.warn(
      `Auto-assign failed for job ${jobId}: ${err.message} (status=${err.status ?? 'unknown'})`
      + (err.status === 422
          ? ` · l1Eligible=${details.l1Count ?? '?'} · rejected=${details.rejectedCount ?? '?'}`
            + (details.note ? ` · note=${details.note}` : '')
            + (details.rejectedReasons ? ` · reasons: ${details.rejectedReasons}` : '')
          : '')
    );
    await notifyAutoAssignFailure(jobId, clientId, reason);
  }
}

/*
 * Sends an ops-style email when auto-assignment couldn't fulfil a job so a
 * human can pick up the slack. Email recipient is a configurable setting
 * (auto_assign_failure_email) with per-client override — same EAV plumbing
 * as running_frequency. If no email is configured, the notification is
 * silently skipped (ops can always check the job list for unassigned BOOKED
 * rows). Never throws — failure email failures are just logged.
 */
async function notifyAutoAssignFailure(jobId, clientId, reason) {
  const logger = require('../logger');
  try {
    const { getClientSetting } = require('./settings.service');
    const to = await getClientSetting(clientId, 'auto_assign_failure_email');
    if (!to) { logger.debug(`Auto-assign failure notification skipped — no email configured (job ${jobId})`); return; }

    const job = await getById(jobId);
    const lines = [
      `Auto-assignment did not complete for job #${jobId} — the job has NOT been assigned to a technician.`,
      `Reason: ${reason}`,
      '',
      `Client: ${job?.client_name ?? 'unknown'}`,
      `Customer: ${job?.customer_name ?? 'unknown'} · ${job?.customer_mob_no ?? ''}`,
      `City: ${job?.city_name ?? 'unknown'}`,
      `Type: ${job?.job_type ?? ''}`,
      `Requested: ${job?.requested_date_time ?? ''}`,
      '',
      `The job is currently in BOOKED status and needs manual assignment.`,
    ].join('\n');

    const { send } = require('./email.service');
    await send({
      to,
      subject: `[Auto-assign] Job #${jobId} not assigned — manual action needed`,
      text: lines,
      category: 'transactional',
    });
    logger.info(`Auto-assign failure notification sent to ${to} for job ${jobId}`);
  } catch (err) {
    logger.warn(`Failed to send auto-assign failure email for job ${jobId}: ${err.message}`);
  }
}

/*
 * Customer "Unreachable" SMS — direct port of legacy EasyFix_CRM
 * JobAction.sendSmsToNotReachableCustomer(). Fired when an operator marks a job
 * Unreachable from the Confirm modal (CRM POST /admin/jobs/:id/notify-unreachable).
 *
 * Parity with the legacy:
 *   - body comes from the DLT row tbl_sms_transational_meta
 *     (job_stage='customerNotReachable', client_id=1) — read via the shared
 *     sms-template service so the 5-min cache + per-client fallback are reused;
 *   - the legacy placeholders {#client#} / {#vertical#} / {#var#} are substituted
 *     (client name / vertical-or-"Order Id-<id>" / the wame.pro helpdesk link);
 *   - the customer mobile is tbl_customer.customer_mob_no via tbl_job.fk_customer_id;
 *   - sent through services/sms.service.js (sender id env SMS_SENDER_ID='EsyFix',
 *     SMSCountry), which already honours NOTIFICATIONS_DISABLE / TEST_MOBILE.
 *
 * Differences from legacy, by design: we do NOT replicate the obscure
 * `clientSetting == null` send-gate (it suppressed the SMS for every client that
 * had a settings row, which is counter-intuitive) — every Unreachable submit
 * notifies. The inline fallback below is a dev/safety net; in prod the carrier
 * delivers ONLY the DLT-registered template body. Caller treats this as
 * fire-and-forget / non-fatal — a provider failure must not fail the outcome.
 */
const UNREACHABLE_HELPDESK_LINK = 'https://wame.pro/helpdesk';
async function notifyCustomerNotReachable(jobId) {
  const smsService  = require('./sms.service');
  const smsTemplate = require('./sms-template.service');
  const [rows] = await pool.query(
    `SELECT j.job_id, cu.customer_mob_no, cl.client_name
       FROM tbl_job j
       LEFT JOIN tbl_customer cu ON cu.customer_id = j.fk_customer_id
       LEFT JOIN tbl_client   cl ON cl.client_id   = j.fk_client_id
      WHERE j.job_id = ?`,
    [jobId],
  );
  const job = rows && rows[0];
  if (!job) { logger.warn('Unreachable SMS skipped · job not found · jobId=' + jobId); return { sent: false, reason: 'job_not_found' }; }
  if (!job.customer_mob_no) { logger.warn('Unreachable SMS skipped · no customer mobile · jobId=' + jobId); return { sent: false, reason: 'no_mobile' }; }

  const clientName = job.client_name || 'EasyFix';
  const verticalName = 'Order Id- ' + jobId; // legacy fallback when no vertical

  let message = null;
  try {
    const tpl = await smsTemplate.getTemplate('customerNotReachable', { clientId: 1 });
    if (tpl) {
      message = String(tpl)
        .replace(/\{#client#\}/g, clientName)
        .replace(/\{#vertical#\}/g, verticalName)
        .replace(/\{#var#\}/g, UNREACHABLE_HELPDESK_LINK);
    }
  } catch (e) { logger.warn('Unreachable SMS · template load failed · ' + e.message); }
  if (!message) {
    message = 'Dear Customer, You are not REACHABLE. On behalf of ' + clientName
      + ' service of "Easyfix". Connect with us on this link - ' + UNREACHABLE_HELPDESK_LINK + '. Team EasyFix';
  }

  const result = await smsService.send({ to: job.customer_mob_no, message });
  logger.info('Unreachable SMS · jobId=' + jobId + ' delivered=' + !!(result && result.delivered));
  return { sent: !!(result && result.delivered), provider: result };
}

module.exports = {
  // Shared with services/job-export.service.js so the two q-clauses cannot
  // drift on what counts as a phone fragment. See the block at its definition.
  MOBILE_MIN_DIGITS,
  STATUS, ALL_STATUS_VALUES, MUTABLE_COLUMNS,
  // Cross-service helper — used by job-magic-link.service.js to keep the
  // tbl_job.client_services CSV in sync after the customer's self-submit
  // mutates tbl_job_services. Single source of truth, one helper.
  recomputeClientServicesCsv,
  list, getById, getByIdCore, getStatusCounts, getAttentionSummary, create, update, setStatus, assign, reschedule, unassign, acceptOffer, changeOwner,
  // THE OFFER MODEL (pool offers): offer one job to many techs, list a job's
  // open offers, and list a tech's open offers.
  offerToTechnicians, listOffers, listOfferedForTech, techHasOpenOffer, rejectOffer,
  isOfferFlowActive, expireStaleOffers, withdrawOffersForClosedJob,
  // The 30-min offer window. Exported so the offer-REMINDER cron can bound its
  // re-push window by the same constant instead of re-declaring it and drifting.
  OFFER_TTL_MINUTES,
  MAX_OFFER_RECIPIENTS,
  tryAutoAssignOnCreate,
  fireWebhook, statusToEventName,
  hasClientVerticalIdColumn,
  notifyCustomerNotReachable,
  // Canonical IST wall-clock formatter (server-TZ independent). Exported so
  // route-layer guards can compare an appointment against "now" in IST without
  // re-implementing the offset — there is exactly one correct version of this.
  formatMysqlDateTimeIST,
  /*
   * Job Age SQL — exported so any future consumer (a report, an export, a
   * dashboard tile) reuses the SAME expression instead of re-deriving the
   * anchors and drifting from what the jobs list shows. Pure column
   * arithmetic, no placeholders; requires the `j` (tbl_job) alias in scope.
   */
  JOB_AGE_END_EXPR, JOB_AGE_SECS_EXPR, JOB_AGE_DAYS_EXPR, JOB_AGE_COLUMNS,
  /*
   * The "customer name ON THIS JOB" expression. Exported for the same reason:
   * any other job-keyed read that needs to show a customer name should reuse
   * THIS expression rather than re-deriving it — and, critically, rather than
   * re-deriving it as a plain COALESCE, which blanks the name for every job
   * whose job_customer_name is an empty string. Requires the `j` (tbl_job) and
   * `cu` (tbl_customer) aliases in scope. NOT for customer-master surfaces.
   */
  JOB_CUSTOMER_NAME_EXPR,
  // The jobs-list server-side sort whitelist. Exported so
  // validators/job.validator.js derives its `sortBy` valid() list from the SAME
  // keys — one source of truth, no BE-side both-sides-whitelist drift.
  SORTABLE_COLUMNS,
  /*
   * Pending-for-Scheduling offer sub-state filter. OFFER_STATE_VALUES is the
   * ONE list of literals — validators/job.validator.js derives its valid() from
   * it, so the accepted param values can never drift from what the service
   * implements. offerStateClause is exported for its unit tests (the tri-state
   * semantics are subtle enough to pin explicitly).
   *
   * offerColumns is exported for the SAME tests: they assert the `offer_state`
   * projection column is built from the identical predicate as the filter, which
   * is what makes "the chip and the filter cannot disagree" a checked property
   * rather than a comment.
   */
  OFFER_STATE_VALUES, offerStateClause, offerColumns,
  /*
   * `job.offer_expiry.enabled` — exported so the tests can pin BOTH regimes
   * (expiry on ⇒ a stale OFFERED row reads Expired; expiry off ⇒ it stays
   * Offered, because the business said offers never expire) without touching
   * live config, and so expireStaleOffers()'s gate is checkable.
   */
  offerExpiryEnabled,
  /*
   * The appointment slot model, re-exported so callers (and tests) reach it
   * through job.service the way they always have. The implementations live in
   * services/time-slot.js — require that module directly in new code.
   *   deriveTimeSlot   — IST datetime → one of the FOUR bands
   *   resolveTimeSlot  — the writer-side gate for tbl_job.time_slot
   */
  deriveTimeSlot, resolveTimeSlot,
  /*
   * The LEGACY "H AM - H PM" derivation for booking_cut_off_time_slot. Exported
   * so job-magic-link.service writes that column in the SAME spelling every
   * other create path writes it, instead of inventing a spelling of its own.
   */
  deriveBookingCutoffSlot,
};
