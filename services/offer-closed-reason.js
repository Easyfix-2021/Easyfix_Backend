/*
 * tbl_job_offer.closed_reason — WHY an offer closed without the technician
 * answering. The named source, mirroring services/offer-status.js.
 *
 * ─── WHY THIS COLUMN EXISTS (2026-09-10) ───────────────────────────────────
 *
 * `offer_status = 3 EXPIRED` is written by EIGHT distinct code paths and only
 * ONE of them is the 30-minute timeout. The others fire when the job is
 * assigned, rescheduled, released, withdrawn, re-offered, or when a sibling
 * technician accepts. The status alone therefore cannot answer the question an
 * operator actually asks — "did this technician ignore the job?" — and on job
 * 538177 it answered it WRONGLY: two offers read EXPIRED after 22 hours with
 * the timeout switched off, both closed in the same second a re-offer went
 * out, six seconds before the new offer.
 *
 * That is not only a display problem. candidate-ranking.service.js scores a
 * technician's acceptance rate from OFFERED and REJECTED rows, so whether a
 * closed offer reads as a decline is a fairness claim about a named person.
 *
 * ─── SCOPE: ONLY THE CLOSURES THAT NEED EXPLAINING ─────────────────────────
 *
 * Set for offer_status 3 (EXPIRED) only. ACCEPTED and REJECTED already say
 * what happened — the technician answered — so adding a reason there would be
 * a second, redundant encoding that could disagree with the status. NULL on an
 * EXPIRED row means "closed before this column existed", not "unknown cause":
 * every current writer sets it.
 */
const OFFER_CLOSED_REASON = Object.freeze({
  /* The 30-minute TTL actually elapsed. The ONLY reason that means the
   * technician did not respond in time — and the only one gated on
   * `job.offer_expiry.enabled`, so in a regime with expiry off it should never
   * appear on a new row. */
  TTL_ELAPSED: 'ttl_elapsed',

  /* The job reached a state where the offer could not be accepted (completed,
   * cancelled, closed from the app). Nothing left to accept. */
  JOB_CLOSED: 'job_closed',

  /* Another technician accepted first. The classic race, and explicitly NOT a
   * decline. */
  SIBLING_ACCEPTED: 'sibling_accepted',

  /* A fresh offer round superseded this one — the operator re-offered the job.
   * This is what job 538177's two rows actually were. */
  REOFFERED: 'reoffered',

  /* An operator assigned the job directly, so the open invitations are moot. */
  JOB_ASSIGNED: 'job_assigned',

  /* The appointment moved; an offer for the old time must not stay live. */
  RESCHEDULED: 'rescheduled',

  /* The owning technician was released so the job could go back out. */
  RELEASED_FOR_REOFFER: 'released_for_reoffer',

  /* The TECHNICIAN entered a lifecycle state that cannot receive new work
   * (blocked / inactive / temp-inactive). Per-technician, not per-job — this
   * one closes their open offers across every job at once. */
  TECHNICIAN_RESTRICTED: 'technician_restricted',
});

/*
 * Operator-facing wording. Deliberately phrased so none of them can be read as
 * "the technician ignored it" except the one that means exactly that.
 */
const OFFER_CLOSED_REASON_LABEL = Object.freeze({
  [OFFER_CLOSED_REASON.TTL_ELAPSED]:           'No response in time',
  [OFFER_CLOSED_REASON.JOB_CLOSED]:            'Job closed',
  [OFFER_CLOSED_REASON.SIBLING_ACCEPTED]:      'Another technician accepted',
  [OFFER_CLOSED_REASON.REOFFERED]:             'Superseded by a re-offer',
  [OFFER_CLOSED_REASON.JOB_ASSIGNED]:          'Job assigned directly',
  [OFFER_CLOSED_REASON.RESCHEDULED]:           'Appointment rescheduled',
  [OFFER_CLOSED_REASON.RELEASED_FOR_REOFFER]:  'Released for re-offer',
  [OFFER_CLOSED_REASON.TECHNICIAN_RESTRICTED]: 'Technician unavailable',
});

/* The longest value is 21 chars ('technician_restricted'); the column is
 * VARCHAR(40), so a new reason has room without a schema change. */
const OFFER_CLOSED_REASON_MAX_LENGTH = 40;

/*
 * ...AND THE CONSTANT IS NOW ENFORCED, at require time, over the enum it
 * describes.
 *
 * It was declared and exported on the day this file was written and read by
 * nothing — found by scripts/dead-exports.js. The value is real: the column is
 * VARCHAR(40), and MySQL would truncate or reject a longer reason depending on
 * strict mode. No write path can violate it today, because closedReasonSet()
 * only accepts OFFER_CLOSED_REASON's values. The ONE way to break it is to ADD
 * a reason longer than the column — an edit a few lines above this, with
 * nothing to stop it.
 *
 * So the check lives here, not at the write: it fires at boot, on the edit
 * that could cause it, instead of on some technician's failed offer weeks
 * later. Throwing at require is deliberate — a reason that cannot be stored
 * cannot be read back, and a silent truncation in an audit column is worse
 * than a container that refuses to start with this message in its log.
 */
for (const value of Object.values(OFFER_CLOSED_REASON)) {
  if (String(value).length > OFFER_CLOSED_REASON_MAX_LENGTH) {
    throw new Error(
      `offer closed_reason "${value}" is ${String(value).length} chars, but `
      + `tbl_job_offer.closed_reason is VARCHAR(${OFFER_CLOSED_REASON_MAX_LENGTH}). `
      + 'Shorten the value or widen the column — do not let it truncate.',
    );
  }
}

/*
 * ─── THE COLUMN PROBE LIVES HERE, NOT IN EACH CALLER ───────────────────────
 *
 * Three files close offers (job.service, job-offer-persistence,
 * easyfixer-lifecycle). A probe copied into each would be three memos that can
 * disagree — and the one that answered "absent" first would silently stop
 * recording reasons for the life of the process while its siblings recorded
 * them. One implementation, one memo.
 *
 * This is why the module holds a DB dependency where its sibling
 * services/offer-status.js is pure constants: sharing the probe is worth more
 * than symmetry.
 */
const { pool } = require('../db');
const logger = require('../logger');

let _hasClosedReasonCol = null;
async function hasOfferClosedReasonCol() {
  if (_hasClosedReasonCol !== null) return _hasClosedReasonCol;
  try {
    const [rows] = await pool.query("SHOW COLUMNS FROM tbl_job_offer LIKE 'closed_reason'");
    _hasClosedReasonCol = rows.length > 0;
    return _hasClosedReasonCol;
  } catch (e) {
    /*
     * A FAILURE IS NOT CACHED. The memo is for the ANSWER. Freezing a
     * transient fault as "the column is absent" would disable reason-recording
     * until restart — silently, because absent is a legitimate answer that
     * degrades rather than errors. Same rule as job.service.js's probes; the
     * repo has a test for it (schema-probe-failure-not-cached).
     */
    logger.warn('offer-closed-reason: schema probe failed, not caching · ' + ((e && e.message) || e));
    return false;
  }
}

/**
 * SET fragment recording why an offer closed, plus its bind params.
 *
 * Returns an EMPTY fragment while the column is absent, so the application can
 * ship before or after migrations/2026-09-10-job-offer-closed-reason.sql runs.
 *
 * ⚠ The params belong to the SET clause, so they must be spread BEFORE the
 * caller's WHERE params:
 *     const cr = await closedReasonSet(REASON.JOB_ASSIGNED);
 *     conn.query(`UPDATE … SET … ${cr.sql} WHERE job_id = ?`, [...cr.params, jobId]);
 *
 * @param {string} reason one of OFFER_CLOSED_REASON's values
 * @returns {Promise<{sql: string, params: string[]}>}
 */
async function closedReasonSet(reason) {
  if (!Object.values(OFFER_CLOSED_REASON).includes(reason)) {
    // A typo'd reason would write a value no reader knows. Fail loudly here,
    // in the caller's own transaction, rather than storing a dead string.
    throw new Error(`Unknown offer closed_reason: ${JSON.stringify(reason)}`);
  }
  if (!(await hasOfferClosedReasonCol())) return { sql: '', params: [] };
  return { sql: ', closed_reason = ?', params: [reason] };
}

module.exports = {
  OFFER_CLOSED_REASON,
  OFFER_CLOSED_REASON_LABEL,
  OFFER_CLOSED_REASON_MAX_LENGTH,
  hasOfferClosedReasonCol,
  closedReasonSet,
};
