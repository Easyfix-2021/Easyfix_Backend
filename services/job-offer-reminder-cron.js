const { pool } = require('../db');
const logger = require('../logger');
const { OFFER_STATUS } = require('./offer-status');
const { OFFER_TTL_MINUTES, STATUS } = require('./job.service');
const { sendJobOfferPush } = require('./job-offer-push.service');
const alertFlags = require('./job-offer-alert-flags');
const easyfixerWorkEligibility = require('./easyfixer-work-eligibility.service');

/*
 * Job-offer ESCALATION REMINDER cron (2026-07-29).
 *
 * A job offer is live for OFFER_TTL_MINUTES (30). The original push fires once,
 * at offer time — if the technician's phone was face-down, in a pocket, or the
 * notification got buried, the offer quietly expires and the job has to be
 * re-offered by ops. This sweep re-pushes offers that are STILL open and have
 * gone unanswered, so a missed notification is not a lost job.
 *
 * ELIGIBILITY (all must hold):
 *   - offer_status = 0 (OFFERED)  — untouched: accepted/rejected/expired never re-push
 *   - age >= REMINDER_AFTER_MINUTES        (don't nag immediately)
 *   - age <  MAX_REMINDER_AGE_MINUTES      (stop nagging near the end of the window)
 *   - last_reminded_at IS NULL OR older than REMINDER_INTERVAL_MINUTES
 *   - THE JOB IS STILL OFFERABLE: BOOKED and owner-less
 *
 * That last one is not redundant. NOTHING closes an open tbl_job_offer row when
 * the job itself moves on — setStatus() does not touch the table on the CANCELLED
 * transition, and a direct assign leaves the losing techs' rows open — so the row
 * stays offer_status=0 until the 30-minute expiry sweep catches it. Without the
 * job predicate this cron would spend those minutes pushing "Job offer still
 * waiting" for a job that is cancelled or already someone else's, and the tap
 * would land on an offer acceptOffer()'s race-safe claim refuses.
 *
 * THE 2-REMINDER CAP IS DERIVED FROM THE WINDOW, not a counter column. Reminders
 * are forced >= REMINDER_INTERVAL_MINUTES apart (by last_reminded_at) inside an
 * eligibility window that is exactly 2 * REMINDER_INTERVAL_MINUTES wide, so at
 * most two can ever land for one offer: one at >= 5 min, one at >= 10 min, and a
 * third would need age >= 15 which is outside the window. A stalled cron only
 * ever produces FEWER reminders, never more — the failure mode is safe. This is
 * why MAX_REMINDER_AGE_MINUTES is computed rather than hard-coded: change the
 * cap or interval and the window follows.
 *
 * MAX_REMINDER_AGE_MINUTES is additionally clamped to OFFER_TTL_MINUTES so we can
 * never push a reminder for an offer that is already (or about to be) expired —
 * tapping that push would land the tech on an offer acceptOffer() refuses.
 *
 * IDEMPOTENCY: each row is CLAIMED with a conditional
 * `UPDATE … SET last_reminded_at = NOW() WHERE job_offer_id = ? AND <same predicate>`
 * and pushed ONLY if that UPDATE reported affectedRows = 1. Because the claim
 * re-checks the predicate it just read, two replicas (or an overlapping tick)
 * racing the same offer produce exactly one push — the loser sees affectedRows 0
 * and skips. A per-row claim costs one tiny indexed UPDATE; the eligible set is
 * inherently small (only offers aged 5–15 min) and BATCH_LIMIT bounds the worst case.
 *
 * GATED by the master loud-alert flag AND job.offer.reminder.enabled — both must
 * be on. With either off this runner is a no-op that touches nothing, so merging
 * it changes nothing until ops flips a property.
 *
 * Best-effort by contract: swallows its own errors and always resolves a summary,
 * so a cron tick can never crash the process.
 */

// Wait this long after the offer before the FIRST reminder.
const REMINDER_AFTER_MINUTES = 5;
// Minimum spacing between reminders for the SAME offer.
const REMINDER_INTERVAL_MINUTES = 5;
// Hard cap on reminders per offer (see the window math above).
const MAX_REMINDERS = 2;
// Derived eligibility ceiling, clamped so a reminder never chases a dead offer.
const MAX_REMINDER_AGE_MINUTES = Math.min(
  REMINDER_AFTER_MINUTES + REMINDER_INTERVAL_MINUTES * MAX_REMINDERS,
  OFFER_TTL_MINUTES,
);
// Upper bound on offers handled in one tick — a runaway offer burst must not
// open thousands of FCM sockets. Anything skipped is picked up next tick.
const BATCH_LIMIT = 300;
// Sends in flight at once (mirrors attendance-reminder's bounded fan-out).
const CONCURRENCY = 10;

/*
 * The shared eligibility predicate, as a SQL fragment. Written ONCE and used by
 * BOTH the SELECT and the per-row claim UPDATE — if the two ever drifted, the
 * claim could stamp last_reminded_at on a row that was no longer eligible (or
 * refuse a row that was), which is exactly the class of bug that makes a
 * reminder cron double-push. Bind order: [afterMinutes, maxAgeMinutes, intervalMinutes].
 *
 * The job predicate is an EXISTS (rather than a JOIN) precisely so the ONE
 * fragment keeps working verbatim in the single-table claim UPDATE. It is
 * correlated on `tbl_job_offer.job_id` — unaliased in both statements — and
 * binds no parameters, so the bind order above is unchanged.
 */
const BASE_ELIGIBLE_SQL = `
     offer_status = ${OFFER_STATUS.OFFERED}
 AND offered_at <= NOW() - INTERVAL ? MINUTE
 AND offered_at >  NOW() - INTERVAL ? MINUTE
 AND (last_reminded_at IS NULL OR last_reminded_at <= NOW() - INTERVAL ? MINUTE)
 AND EXISTS (SELECT 1 FROM tbl_job j
              WHERE j.job_id = tbl_job_offer.job_id
                AND j.job_status = ${STATUS.BOOKED}
                AND j.fk_easyfixter_id IS NULL)`;

function eligibleSql(technicianPredicate) {
  return `${BASE_ELIGIBLE_SQL}
 AND EXISTS (SELECT 1 FROM tbl_easyfixer ef
              WHERE ef.efr_id = tbl_job_offer.fk_easyfixter_id
                AND ${technicianPredicate})`;
}

const ELIGIBLE_PARAMS = () => [
  REMINDER_AFTER_MINUTES,
  MAX_REMINDER_AGE_MINUTES,
  REMINDER_INTERVAL_MINUTES,
];

/*
 * True when the sweep cannot run against this DB — tbl_job_offer missing
 * (pre-offer-model deploy) or last_reminded_at missing (this feature's migration
 * not applied yet). Both are treated as "feature not provisioned": log once,
 * no-op, never 500. Mirrors job.service.js's memoised probe idiom.
 */
function notProvisioned(err) {
  return err && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR');
}

/*
 * One sweep. Returns a summary the Scheduled Jobs admin page renders:
 *   { skipped?, reason?, eligible, claimed, pushed, failed }
 */
async function runOfferReminders() {
  // Gate INSIDE the runner as well as at cron registration, so the admin
  // "Trigger Now" button can't fire reminders while the feature is off.
  if (!alertFlags.offerReminderEnabled()) {
    logger.info('Job-offer reminder skipped — flags off (job.offer.loud_alert.enabled + job.offer.reminder.enabled must both be true)');
    return { skipped: true, reason: 'flags off', eligible: 0, claimed: 0, pushed: 0, failed: 0 };
  }

  const t0 = Date.now();
  let rows;
  let lifecycleAwareEligibility;
  try {
    // Resolve once per sweep. Both the batch SELECT and every atomic claim use
    // the exact same schema-aware predicate; there is no per-offer status read.
    lifecycleAwareEligibility = eligibleSql(
      await easyfixerWorkEligibility.sqlPredicate('ef'),
    );
    [rows] = await pool.query(
      `SELECT job_offer_id, job_id, fk_easyfixter_id
         FROM tbl_job_offer
        WHERE ${lifecycleAwareEligibility}
        ORDER BY offered_at ASC
        LIMIT ${BATCH_LIMIT}`,
      ELIGIBLE_PARAMS(),
    );
  } catch (e) {
    if (notProvisioned(e)) {
      logger.warn('Job-offer reminder unavailable — ' + e.code + ' (migration not applied); no-op');
      return { skipped: true, reason: e.code, eligible: 0, claimed: 0, pushed: 0, failed: 0 };
    }
    logger.error('Job-offer reminder: eligibility query failed · ' + e.message);
    return { eligible: 0, claimed: 0, pushed: 0, failed: 0, error: e.message };
  }

  logger.info('Job-offer reminder · eligible=' + rows.length);
  const summary = { eligible: rows.length, claimed: 0, pushed: 0, failed: 0 };

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const chunk = rows.slice(i, i + CONCURRENCY);
    const outcomes = await Promise.all(
      chunk.map((r) => remindOne(r, lifecycleAwareEligibility)),
    );
    for (const o of outcomes) {
      if (o.claimed) summary.claimed += 1;
      if (o.pushed) summary.pushed += 1;
      if (o.failed) summary.failed += 1;
    }
  }

  logger.info(
    'Job-offer reminder complete · eligible=' + summary.eligible +
    ' · claimed=' + summary.claimed + ' · pushed=' + summary.pushed +
    ' · failed=' + summary.failed + ' · took_ms=' + (Date.now() - t0),
  );
  return summary;
}

/*
 * Claim-then-push ONE offer. The claim UPDATE re-asserts the full eligibility
 * predicate, so it is the atomic gate: affectedRows 1 means WE own this
 * reminder, 0 means someone/something else already handled it (another replica,
 * an overlapping tick, or the tech responded between the SELECT and here).
 *
 * The stamp happens BEFORE the push on purpose. If the push then fails, the
 * offer simply loses that reminder — strictly better than the alternative
 * ordering, where a crash between push and stamp re-pushes on the next tick and
 * spams the technician. Reminders are a nicety; duplicates are a nuisance.
 */
async function remindOne(row, lifecycleAwareEligibility) {
  try {
    const [res] = await pool.query(
      `UPDATE tbl_job_offer
          SET last_reminded_at = NOW()
        WHERE job_offer_id = ?
          AND ${lifecycleAwareEligibility}`,
      [row.job_offer_id, ...ELIGIBLE_PARAMS()],
    );
    if (!res.affectedRows) return { claimed: false, pushed: false, failed: false };
  } catch (e) {
    logger.warn('Job-offer reminder claim failed · offerId=' + row.job_offer_id + ' · ' + e.message);
    return { claimed: false, pushed: false, failed: true };
  }

  // sendJobOfferPush is best-effort and never throws; it also handles the
  // "tech has no device tokens" case by returning delivered:false.
  const r = await sendJobOfferPush(row.fk_easyfixter_id, { jobId: row.job_id, reminder: true })
    .catch((e) => ({ delivered: false, error: e.message }));
  return { claimed: true, pushed: !!(r && r.delivered), failed: !(r && r.delivered) };
}

module.exports = {
  runOfferReminders,
  // Exported for the characterization tests, which pin the selection window and
  // the derived 2-reminder cap.
  REMINDER_AFTER_MINUTES,
  REMINDER_INTERVAL_MINUTES,
  MAX_REMINDERS,
  MAX_REMINDER_AGE_MINUTES,
  BATCH_LIMIT,
  _internals: { eligibleSql },
};
