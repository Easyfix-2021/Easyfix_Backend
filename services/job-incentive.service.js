/*
 * System-awarded job charges — the ones nobody types (V3 plan 2.3, 2.4, 2.6).
 *
 * ── WHY THIS IS NOT IN job-charges.service.js ────────────────────────────
 *
 * That file is the CRM's "Billing & Charges" tab: an OPERATOR opens a job and
 * adds a Penalty, a Travel or an Incentive row by hand. It enforces
 * `client_charge >= tx_charge` on every insert, and its own header explains why
 * — "a negative margin is always an operator error".
 *
 * The on-time start bonus is exactly a negative margin, on purpose. EasyFix
 * funds it out of its own share (owner's decision, 2026-09-23: "EasyFix funds
 * the ₹50 out of margin"), so it is `tx_charge = 50, client_charge = 0` and the
 * operator guard would refuse it — correctly, for an operator.
 *
 * So the exemption gets its own MODULE rather than a flag threaded through the
 * operator path. Nothing here is reachable from the CRM's charge routes, the
 * guard over there is untouched, and the two readers of `job_material` cannot
 * be confused about which rules applied: a row written by hand passed
 * assertChargeOrder, a row written from here passed the rule stated beside it.
 *
 * ── HOW A NEGATIVE MARGIN ACTUALLY MOVES THE MONEY ───────────────────────
 *
 * job-ledger.service.js's computeCompletionAmounts does, for each job_material
 * row:
 *
 *     tx += sign * tx_charge          cx += sign * client_charge
 *     efr = <rate card share> + tx    ef  = <rate card share> + (cx - tx)
 *
 * With tx=50 and cx=0 the technician gains ₹50 and EasyFix's own share drops by
 * exactly ₹50. The client is billed nothing. That is what "EasyFix funds it"
 * means arithmetically, and it needed no new column to express — `materialSign`
 * already treats 'incentive' as +1 toward the technician.
 *
 * The ₹250 visit charge is the other shape: tx=250, cx=250. The technician is
 * paid for the wasted trip and the client is billed for it, so EasyFix's share
 * is unchanged. That one would have passed the operator guard too; it lives here
 * because it is system-awarded, not because it needed the exemption.
 *
 * ── THE AMOUNTS ARE OPS-TUNABLE ──────────────────────────────────────────
 *
 * Both read from easyfix_properties, which properties.service caches for an
 * hour with a flush gesture — so `getProperty` is a memory read, not a query,
 * and this adds nothing to the check-in path. A figure ops can change without a
 * deploy is the difference between a pricing decision and a release.
 */

const { pool } = require('../db');
const logger = require('../logger');
const { getProperty } = require('./properties.service');
const { deriveTimeSlot, displaySlot, canonicalSlot } = require('./time-slot');

const PROP_ON_TIME = 'job.incentive.on_time_start.amount';
const PROP_VISIT = 'job.charge.wasted_visit.amount';

// The figures confirmed by the owner, used when ops has set no property.
const DEFAULT_ON_TIME = 50;
const DEFAULT_VISIT = 250;

/*
 * The `reason` strings double as the IDEMPOTENCY KEY (see awardOnce), so they
 * are values, not prose. Changing one re-awards the charge on every job that
 * already has the old one. They are also what an operator reads in the CRM's
 * Billing tab, which is why they are sentences rather than slugs.
 */
const REASON_ON_TIME = 'On-time start incentive (system)';
const REASON_VISIT = 'Visit charge — could not complete (system)';
const REASON_ADDITIONAL_WORK = 'Additional work approved (system)';

function amount(key, fallback) {
  const raw = Number(getProperty(key));
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/**
 * Was the job STARTED inside the slot it was booked for?
 *
 * The owner's definition, 2026-09-23: "on-time = within same slot of
 * appointment". Not "within N minutes" — the four booking bands are what the
 * customer was actually promised ('9AM to 12PM', '12PM to 3PM', '3PM to 7PM',
 * 'After Hours'), so arriving at 11:55 for a 9-12 slot is on time and 12:05 is
 * not, however close the clock looks.
 *
 * Composed from services/time-slot.js rather than re-derived: `displaySlot` is
 * that module's READ-side answer to "which band is this job's appointment in"
 * (it prefers the appointment instant over the stored column, which is derived
 * and can be stale), `deriveTimeSlot` answers the same for the check-in
 * instant, and `canonicalSlot` is its cosmetic fold for comparing two band
 * strings. Re-implementing any of the three here is how the app and the CRM
 * start disagreeing about the same job.
 *
 * NULL, never false, when the question cannot be answered — an appointment with
 * no time of day, or a check-in that was never stamped. "We cannot tell" must
 * not silently become "he was late".
 */
function startedInSlot(job, checkinAt) {
  const booked = displaySlot(job.requested_date_time, job.time_slot);
  const actual = deriveTimeSlot(checkinAt);
  if (!booked || !actual) return null;
  return canonicalSlot(booked) === canonicalSlot(actual);
}

/**
 * Insert a job_material row unless one with this exact reason already exists.
 *
 * ONE STATEMENT, deliberately. A phone retries: a flaky check-in POST that
 * succeeds server-side and times out client-side is the normal case, not the
 * exotic one, and a SELECT-then-INSERT would pay the bonus twice from a retry
 * arriving while the first is still in flight. `INSERT ... SELECT ... WHERE NOT
 * EXISTS` collapses the check and the write into one round trip so there is no
 * window between them in this process.
 *
 * CEILING, stated rather than discovered: `job_material` has no unique index on
 * (job_id, type, reason), so this is not proof against two statements racing
 * inside the database itself. It is proof against the retry shape that actually
 * happens. The real fix is a unique index, which is a DDL change on a legacy
 * table the CRM also writes to — worth doing, not worth blocking this on.
 *
 * Returns true only when this call was the one that inserted.
 */
async function awardOnce(jobId, { reason, txCharge, clientCharge, actorId }) {
  const [res] = await pool.query(
    `INSERT INTO job_material
       (job_id, type, reason, tx_charge, client_charge,
        is_client_approval_needed, is_pre_approved, inserted_by, inserted_date_time)
     SELECT ?, 'Incentive', ?, ?, ?, 0, 1, ?, ?
       FROM DUAL
      WHERE NOT EXISTS (
        SELECT 1 FROM job_material
         WHERE job_id = ? AND type = 'Incentive' AND reason = ?
      )`,
    [Number(jobId), reason, txCharge, clientCharge, String(actorId), new Date(),
     Number(jobId), reason],
  );
  const inserted = Number(res.affectedRows) > 0;
  if (inserted) {
    logger.info(`System charge awarded · jobId=${jobId} · ${reason} · tx=${txCharge} client=${clientCharge}`);
  }
  return inserted;
}

/**
 * Award the on-time start bonus, if it is owed and not already paid.
 *
 * TWO CONDITIONS, BOTH REQUIRED, and this is the shape V3 2.3 + 2.4 describe
 * together: the technician must have started inside the booked slot AND the
 * customer's PIN must have been verified. The PIN is what makes the arrival
 * real — without it "started" is a button the technician pressed. 2.4 is the
 * other half: a technician who could not get the PIN at the door keeps earning
 * it by entering the PIN later, which is why this function is called from the
 * late-PIN route as well as from check-in, and why it is idempotent.
 *
 * `checkinAt` is the arrival instant, NOT "now" — a late PIN is verified hours
 * after the arrival it is attesting to, and scoring the slot against the moment
 * the PIN arrived would refuse every single one of them.
 */
async function awardOnTimeStart(job, { checkinAt, actorId }) {
  const onTime = startedInSlot(job, checkinAt);
  if (onTime !== true) return { awarded: false, onTime };
  const txCharge = amount(PROP_ON_TIME, DEFAULT_ON_TIME);
  if (txCharge <= 0) return { awarded: false, onTime, reason: 'amount is zero' };
  // client_charge 0 — EasyFix funds it out of its own share. See the header.
  const awarded = await awardOnce(job.job_id, {
    reason: REASON_ON_TIME, txCharge, clientCharge: 0, actorId,
  });
  return { awarded, onTime, amount: txCharge };
}

/**
 * Award the wasted-visit charge — the technician attended and could not do the
 * work through no fault of his own (V3 2.6).
 *
 * BILLS THE CLIENT (owner's decision, 2026-09-23): tx and client both carry the
 * figure, so the technician is paid for the trip and the client pays for it.
 * EasyFix's share is unchanged.
 */
async function awardVisitCharge(jobId, { actorId }) {
  const charge = amount(PROP_VISIT, DEFAULT_VISIT);
  if (charge <= 0) return { awarded: false, reason: 'amount is zero' };
  const awarded = await awardOnce(jobId, {
    reason: REASON_VISIT, txCharge: charge, clientCharge: charge, actorId,
  });
  return { awarded, amount: charge };
}

/**
 * Take back the ₹250 visit charge — "customer changed their mind" (V3 3.6a/b,
 * design sheet 13: the only action left after a claim is the undo).
 *
 * ONLY WHILE THE LEDGER IS UNPOSTED. Once a completion has posted,
 * tbl_job_transaction and tbl_easyfixer_transaction carry the ₹250 inside
 * efr_charge and the technician's running balance; deleting the job_material
 * row then would make the job's own charges disagree with the money already
 * in his wallet, and nothing downstream re-posts. The two tables are the
 * ledger's OWN "is posted" tests — technicianSharesForJobs reads the first,
 * postCompletionLedger's second guard reads the second — so either one present
 * means posted. A posted charge is left alone and the caller is told why; a
 * reversal after posting is a finance adjustment, not an app tap.
 *
 * The DELETE repeats both NOT EXISTS guards rather than trusting the read
 * before it: the same one-statement reasoning as awardOnce, so a completion
 * posting between the read and the delete cannot be undercut in this process.
 * Scoped by the exact REASON_VISIT string (the award's own idempotency key), so
 * an operator's hand-typed Incentive row can never be what this removes.
 */
async function reverseVisitCharge(jobId) {
  const id = Number(jobId);
  const [[posted]] = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM tbl_job_transaction WHERE fk_job_id = ?)
         OR EXISTS (SELECT 1 FROM tbl_easyfixer_transaction WHERE job_id = ?) AS posted`,
    [id, id],
  );
  if (Number(posted && posted.posted) === 1) return { reversed: false, reason: 'ledger already posted' };
  const [res] = await pool.query(
    `DELETE FROM job_material
      WHERE job_id = ? AND type = 'Incentive' AND reason = ?
        AND NOT EXISTS (SELECT 1 FROM tbl_job_transaction WHERE fk_job_id = ?)
        AND NOT EXISTS (SELECT 1 FROM tbl_easyfixer_transaction WHERE job_id = ?)`,
    [id, REASON_VISIT, id, id],
  );
  const reversed = Number(res.affectedRows) > 0;
  if (reversed) logger.info(`System charge reversed · jobId=${id} · ${REASON_VISIT}`);
  return { reversed, reason: reversed ? null : 'no visit charge on this job' };
}

/*
 * The ₹250 as configured NOW — for the app's "₹250 visit charge is yours" line
 * on a claim this module has already paid. ponytail: a property change after
 * the award shows the new figure on an old claim; read job_material's
 * tx_charge instead if ops ever changes it mid-flight.
 */
function visitChargeAmount() {
  return amount(PROP_VISIT, DEFAULT_VISIT);
}

/*
 * Pay the technician for additional work the CLIENT APPROVED (V3 3.3).
 *
 * WHY A job_material ROW, AND WHY client_charge IS 0. The desk prices the work
 * into a quotation_details line so the client's existing estimate-approve flow
 * can act on it. That line is what the client is INVOICED from —
 * routes/admin/finance.js bills approved quotation lines at approved_charge. But
 * the completion ledger (job-ledger.service computeCompletionAmounts) reads
 * service lines and job_material only, so the technician's tx_charge on the
 * quotation line never reached his wallet: "additional work you report is
 * priced and paid to you" (design sheet 09) was a promise nothing kept.
 *
 * A system job_material row is how the ₹250 visit charge already reaches the
 * wallet, so the same road carries this. client_charge is 0 ON PURPOSE: the
 * client is already billed once, by the invoice, from the quotation line.
 * Billing it here too would double-charge the client in the client ledger.
 *
 * Keyed on the report id, so a retry, or a second approve path firing for the
 * same report, cannot pay twice — while a second additional-work report on the
 * same job is its own row.
 */
async function awardAdditionalWork(jobId, { reportId, txCharge, actorId }) {
  const tx = Number(txCharge);
  const rid = Number(reportId);
  if (!Number.isInteger(rid) || rid <= 0) return { awarded: false, reason: 'no report' };
  if (!Number.isFinite(tx) || tx <= 0) return { awarded: false, reason: 'amount is zero' };
  const awarded = await awardOnce(jobId, {
    reason: `${REASON_ADDITIONAL_WORK} · report ${rid}`, txCharge: tx, clientCharge: 0, actorId,
  });
  return { awarded, amount: tx };
}

module.exports = {
  awardOnTimeStart,
  awardAdditionalWork,
  REASON_ADDITIONAL_WORK,
  awardVisitCharge,
  reverseVisitCharge,
  visitChargeAmount,
  startedInSlot,
  PROP_ON_TIME,
  PROP_VISIT,
  DEFAULT_ON_TIME,
  DEFAULT_VISIT,
  REASON_ON_TIME,
  REASON_VISIT,
};
