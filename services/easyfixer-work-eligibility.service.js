const lifecycleService = require('./easyfixer-lifecycle.service');

/*
 * One reusable SQL/row projection for the question every job flow asks:
 * "may this technician receive a NEW job?"
 *
 * A RECEIVE_NEW_JOB_STATUSES list used to live here and feed the predicate.
 * It was removed with the reconciliation below rather than left exported: it
 * no longer decided anything, and a constant that still reads like the gate is
 * how the next reader ends up editing the wrong thing. The equivalent list is
 * derived inside lifecycleService.reconciledWorkEligibleSql(), from the
 * resolver the nightly repair uses.
 */

function assertAlias(alias) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error('invalid SQL alias for easyfixer work eligibility');
  }
}

/*
 * RECONCILED, not a plain AND of the two status columns (2026-09-07).
 *
 * The old predicate required lifecycle_status IN (work-enabled) AND the legacy
 * gate. For any row this backend wrote those two agree by construction —
 * transition() sets both together — so the lifecycle half changed no answer
 * except on DRIFTED rows, where it gave the wrong one: a technician reactivated
 * in the legacy CRM passed the legacy half, failed the lifecycle half, and
 * received no job offers while every screen ops uses read Active. Reported for
 * efr 4980.
 *
 * lifecycleService.reconciledWorkEligibleSql() derives the replacement from the
 * heal's own resolver, so the candidate query, the row projection below and the
 * nightly repair cannot disagree about who may work.
 */
/*
 * OVERDUE MANDATORY TRAINING BELONGS INSIDE THIS PREDICATE, not beside it.
 *
 * The rule is "block NEW offers only" — a technician who missed a training
 * deadline must still finish, progress and submit for approval every job he
 * already holds, and still mark attendance. Folding the condition in here is
 * safe precisely because this predicate asks nothing else: every caller was
 * checked (2026-09-07) and not one of them governs an already-accepted job.
 *
 *   job.service.assertTechniciansCanReceiveJobs (via fromRow) — the gate for
 *     offerToTechnicians, assign and acceptOffer, i.e. every way a tbl_job_offer
 *     row or a direct assignment comes into existence, CRM and auto-assign alike
 *   candidate-ranking.service / auto-assign.service — candidate selection
 *   job.service.techHasOpenOffer / listOfferedForTech, job-offer-reminder-cron
 *     — visibility of offers not yet accepted
 *   candidate-ranking.diagnoseEmptyPool — "why was nobody offerable" counters
 *
 * Continuing, mutating and completing an owned job route through job ownership
 * (tbl_job.fk_easyfixter_id) and the lifecycle capabilities, never through
 * here. Putting the condition in a separate predicate consulted only by SOME
 * of the list above is what would re-create the bug: a sibling offer path that
 * forgets to call it.
 *
 * THE ROW HALF IS THE ONE THAT ACTUALLY BLOCKS. This SQL only filters lists;
 * the authoritative write gate projects rows and calls fromRow() below. Both
 * are expressed from the same condition (lifecycleService.overdueTrainingSql /
 * the `training_overdue` column that readProjection derives from it) so the
 * two cannot drift apart, which is the invariant fromRow's own comment already
 * demanded of them.
 */
async function sqlPredicate(alias = 'e') {
  assertAlias(alias);
  const training = (await lifecycleService.hasTrainingDeadlineSchema())
    ? ` AND NOT ${await lifecycleService.overdueTrainingSql(alias)}`
    : '';
  if (!(await lifecycleService.hasLifecycleSchema())) {
    // No lifecycle columns to consult, and none to contradict the legacy bit.
    return `${alias}.efr_status = 1 AND ${alias}.is_technician_verified = 1${training}`;
  }
  return `${lifecycleService.reconciledWorkEligibleSql(alias)}${training}`;
}

function fromRow(row) {
  const lifecycle = lifecycleService.lifecycleFromRow(row);
  // Lifecycle is the business policy, while these two legacy columns remain
  // cutover integrity guards. In particular, legacy derivation intentionally
  // tolerates NULL/nonzero status for read compatibility; a write permission
  // must be stricter and match sqlPredicate() exactly so deleted/status-drifted
  // rows can never be assigned by direct ID.
  const legacyEligible = Number(row?.efr_status) === 1
    && Number(row?.is_technician_verified) === 1;
  /*
   * `training_overdue` is projected by lifecycleService.readProjection(), which
   * every row reaching this function is already built from — including the
   * server-authoritative offer gate's own SELECT. An ABSENT column reads as not
   * overdue, so a caller that has not been migrated to the projection, or a
   * database without the training-deadline columns, loses the block rather than
   * gaining a phantom one. Same direction as the display overlay's fail-OPEN.
   */
  const trainingOverdue = Number(row?.training_overdue) === 1;
  /*
   * Say WHY, not just no. Every consumer of this function renders
   * `lifecycle.reason` — the CRM candidate picker's red line
   * (candidate-ranking.buildCandidateRow) and the 400 body a rejected
   * assign/offer returns (job.service.assertTechniciansCanReceiveJobs) — and
   * without this they would print "ACTIVE technicians cannot receive new job
   * offers", which is both confusing and false. Only when training is the SOLE
   * reason: a genuine BLACKLISTED/PAUSED reason must not be overwritten.
   */
  if (trainingOverdue && lifecycle.capabilities.receiveNewJobs && legacyEligible) {
    lifecycle.reasonCode = 'TRAINING_OVERDUE';
    lifecycle.reason = 'Mandatory training is overdue. New job offers resume once it is completed.';
    // Keep the snapshot self-consistent with canOffer below. This object is
    // freshly built by lifecycleFromRow() on every call, so nothing is shared.
    lifecycle.capabilities.receiveNewJobs = false;
  }
  return {
    lifecycle,
    trainingOverdue,
    canOffer: lifecycle.capabilities.receiveNewJobs && legacyEligible && !trainingOverdue,
  };
}

module.exports = {
  sqlPredicate,
  fromRow,
};
