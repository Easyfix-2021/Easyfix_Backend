'use strict';
/*
 * The technician's side of V3 Phase 3 — what he TELLS us from site, and what
 * his phone reads back (routes/mobile/jobs-phase3.js; design sheets 09-15).
 *
 *   additional work   report · booked-meanwhile answer · "Leaving now"
 *   can't complete    reason + proof → ₹250 if he reached → undo
 *   cancel request    proof + ₹250 on top of the existing request model → undo
 *   need help         a picked reason, open until the bench picks up
 *   job state         pendingOn / waitingFor / visitNo / collectFromCustomer
 *                     for the list and detail, and the four-step money view
 *
 * Every write is scoped to his job through mobile-job-lifecycle's getOwnedJob,
 * so a claim route 404s exactly the way cancel / reschedule always have. Every
 * history row is written AFTER the state change it describes and through the
 * fail-soft job-log writers, so a dead tbl_job_logs never fails a claim.
 */

const { pool } = require('../db');
const logger = require('../logger');
const { getProperty } = require('./properties.service');
const lifecycle = require('./mobile-job-lifecycle.service');
const txReports = require('./job-tx-report.service');
const incentives = require('./job-incentive.service');
const jobLog = require('./job-log.service');
const lookup = require('./lookup.service');
const { pendingOnForJobs } = require('./job-pending-on');
const { technicianSharesForJobs } = require('./job-ledger.service');
const { estimateLinesForJobs } = require('./job-line-total');
const { OPEN_JOB_STATUSES } = require('./easyfixer-lifecycle.service');
const { PROOF_CLAIM_CATEGORY } = require('../utils/job-image-buckets');

const { KIND, STATUS } = txReports;

/*
 * "He is on site on THIS visit": checked in (2 / 20) AND the arrival was
 * stamped. checkin_date_time alone is not enough — it is WRITE-ONCE across
 * visits (routes/mobile/index.js check-in), so on a revisit that has not
 * started yet it still holds visit 1's arrival, and "you reached, ₹250 is
 * yours" would pay for a trip he has not made.
 */
const CHECKED_IN_STATUSES = new Set([2, 20]);
const onSite = (job) => Boolean(job && job.checkin_date_time) && CHECKED_IN_STATUSES.has(Number(job.job_status));

/*
 * A claim can be raised while the visit is live: at the door (1) or on site
 * (2 / 20) — the same window a proof photo can be taken in
 * (mobile-job-estimate.service PROOF_UPLOAD_STATUSES), because the claim is
 * worthless without its photo.
 */
const CLAIM_STATUSES = new Set([1, 2, 20]);

/*
 * Work-found photos — step 2's "photos of the work you found" (sheet 09), which
 * the app stores as 'Booking' → 'checkin' (utils/job-image-buckets.js). NOT the
 * whole before bucket: 'booking' / 'unconfirmed' there are the CUSTOMER'S and
 * partner's photos, and the desk prices additional work from what HE saw.
 */
const WORK_FOUND_CATEGORIES = ['checkin', 'before'];

const QC_HOURS_DEFAULT = 24;
const CHECK_HOURS_DEFAULT = 2;
const PROP_QC_HOURS = 'job.qc.hours.default';
const PROP_CHECK_HOURS = 'job.check.hours.default';

function httpError(status, message) {
  const e = new Error(message); e.status = status; return e;
}

function hoursProperty(key, fallback) {
  const n = Number(getProperty(key));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const actorOf = (efrId) => ({ efr_id: efrId });

/* ─── Mobile shapes. Never a client amount: tx_report carries client_amount
 *     for the desk, and it must not reach the phone (spec rule 5). ────────── */

function shapeAdditionalWork(r) {
  if (!r) return undefined;
  return {
    id: Number(r.id),
    status: r.status,
    reportedOn: r.reported_on,
    bookedMeanwhile: r.booked_meanwhile || null,
    leftSiteOn: r.left_site_on || null,
    returnNote: r.status === STATUS.RETURNED ? (r.return_note || null) : null,
    ...(r.status === STATUS.APPROVED ? { approvedOn: r.resolved_on || null } : {}),
  };
}

const visitChargeOf = (r) => (Number(r.visit_charge_awarded) === 1 ? incentives.visitChargeAmount() : null);

function shapeCantComplete(r) {
  if (!r) return undefined;
  return {
    id: Number(r.id),
    status: r.status,
    reasonText: r.reason_text || null,
    reportedOn: r.reported_on,
    visitCharge: visitChargeOf(r),
  };
}

function shapeHelp(r) {
  if (!r) return undefined;
  return { id: Number(r.id), reasonCode: r.reason_code, reportedOn: r.reported_on };
}

/* ─── Shared steps ──────────────────────────────────────────────────────── */

/*
 * Every proof id must be a PROOF photo on THIS job. Without the job pin a
 * technician could attach another job's photo; without the category pin an
 * old before-photo could stand in for evidence taken at the door. One query.
 */
async function assertProofOnJob(jobId, proofImageIds) {
  const ids = [...new Set((proofImageIds || []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
  if (!ids.length) throw httpError(400, 'Add at least one proof photo');
  if (ids.length > txReports.MAX_PROOF_IDS) throw httpError(400, `At most ${txReports.MAX_PROOF_IDS} proof photos`);
  const [rows] = await pool.query(
    'SELECT image_id FROM tbl_job_image WHERE job_id = ? AND image_id IN (?) AND image_category = ?',
    [Number(jobId), ids, PROOF_CLAIM_CATEGORY],
  );
  const found = new Set(rows.map((r) => Number(r.image_id)));
  if (ids.some((id) => !found.has(id))) throw httpError(400, 'Proof photo not found on this job');
  return ids;
}

/*
 * The ₹250 for a claim, paid at most once PER CLAIM ROW and only if he is on
 * site. Re-run on a retry of the same claim (visit_charge_awarded still 0) so a
 * request that died between the claim INSERT and the award heals itself —
 * awardVisitCharge is idempotent on its reason key, so this cannot pay twice.
 *
 * The flag is set only when THIS call inserted the job_material row. If a
 * checkout "problem with job" already paid the ₹250 on this job, the claim did
 * not pay it, and its undo must not take it back.
 */
async function payVisitChargeIfOnSite(job, row, efrId, actorId) {
  if (!onSite(job) || Number(row.visit_charge_awarded) === 1) return row;
  let award = null;
  try {
    award = await incentives.awardVisitCharge(job.job_id, { actorId });
  } catch (e) {
    logger.warn('Visit charge not awarded on claim · job=' + job.job_id + ' · ' + e.message);
    return row;
  }
  if (award && award.awarded) {
    await txReports.setVisitChargeAwarded(row.id, true);
    await jobLog.logVisitChargeAwarded(job.job_id, { amount: award.amount }, actorOf(efrId));
    return { ...row, visit_charge_awarded: 1 };
  }
  return row;
}

/*
 * Give back a claim's ₹250 on undo — only a charge THIS claim paid, and only
 * while the ledger is unposted (job-incentive.reverseVisitCharge decides).
 */
async function reverseClaimCharge(jobId, row) {
  if (Number(row.visit_charge_awarded) !== 1) return { reversed: false, reason: 'no visit charge on this claim' };
  const out = await incentives.reverseVisitCharge(jobId);
  if (out.reversed) await txReports.setVisitChargeAwarded(row.id, false);
  return out;
}

/* ─── Additional work (sheets 09-12) ────────────────────────────────────── */

async function reportAdditionalWork(jobId, efrId) {
  const job = await lifecycle.getOwnedJob(jobId, efrId);
  if (!CHECKED_IN_STATUSES.has(Number(job.job_status))) throw httpError(409, 'Start the job first');
  // "Your 2 photos have gone to EasyFix" — the photos ARE the report (sheet 10),
  // so a report with none is a report the desk cannot price.
  const [photos] = await pool.query(
    `SELECT image_id FROM tbl_job_image
      WHERE job_id = ? AND image_category IN (?)
      ORDER BY image_id DESC LIMIT ${txReports.MAX_PROOF_IDS}`,
    [Number(jobId), WORK_FOUND_CATEGORIES],
  );
  if (!photos.length) throw httpError(422, 'Take photos of the work you found first');
  const photoIds = photos.map((p) => Number(p.image_id));

  const existing = await txReports.findOpen(jobId, KIND.ADDITIONAL_WORK);
  if (existing && existing.status === STATUS.RETURNED) {
    /*
     * "EasyFix needs one thing more" → Send again (sheet 11 / prototype
     * deskReturn). The SAME claim goes back to the desk with his new photos —
     * not a second claim, which the dedupe key would refuse anyway — and the
     * clock restarts, because the desk's "min at the door" is from this send.
     */
    const [res] = await pool.query(
      `UPDATE tbl_job_tx_report SET status = ?, proof_image_ids = ?, reported_on = ?
        WHERE id = ? AND status = ?`,
      [STATUS.OPEN, txReports.proofIdsToCsv(photoIds), new Date(), existing.id, STATUS.RETURNED],
    );
    if (Number(res.affectedRows) > 0) await jobLog.logAdditionalWorkReported(jobId, {}, actorOf(efrId));
    return { report: shapeAdditionalWork(await txReports.byId(existing.id)), created: false };
  }
  if (existing) return { report: shapeAdditionalWork(existing), created: false };

  const { row, created } = await txReports.open({
    jobId, efrId, kind: KIND.ADDITIONAL_WORK, proofImageIds: photoIds,
  });
  if (created) await jobLog.logAdditionalWorkReported(jobId, {}, actorOf(efrId));
  return { report: shapeAdditionalWork(row), created };
}

async function openAdditionalWorkOrThrow(jobId, efrId) {
  await lifecycle.getOwnedJob(jobId, efrId);
  const row = await txReports.findOpen(jobId, KIND.ADDITIONAL_WORK);
  if (!row) throw httpError(404, 'No additional work is waiting on this job');
  return row;
}

/*
 * "Yes, starting / Not now" (sheet 11). Recorded because "he is idle at the
 * door" and "he is working meanwhile" are two different situations for the
 * desk. A change of answer is allowed (the prototype's "I can start it now")
 * and logged; a repeat of the same answer is a no-op, not a second history row.
 */
async function answerBooked(jobId, efrId, answer) {
  const row = await openAdditionalWorkOrThrow(jobId, efrId);
  if (row.booked_meanwhile === answer) return { report: shapeAdditionalWork(row) };
  await pool.query('UPDATE tbl_job_tx_report SET booked_meanwhile = ? WHERE id = ?', [answer, row.id]);
  await jobLog.logBookedMeanwhile(jobId, { answer }, actorOf(efrId));
  return { report: shapeAdditionalWork({ ...row, booked_meanwhile: answer }) };
}

/*
 * "Leaving now" (sheet 11). Stamped ONCE — the first departure is the fact;
 * a retry must not move it. The revisit it implies is applied at checkout
 * (hasUnresolvedAdditionalWork below), where the job actually closes.
 */
async function leaveSite(jobId, efrId) {
  const row = await openAdditionalWorkOrThrow(jobId, efrId);
  const now = new Date();
  const [res] = await pool.query(
    'UPDATE tbl_job_tx_report SET left_site_on = ? WHERE id = ? AND left_site_on IS NULL',
    [now, row.id],
  );
  if (Number(res.affectedRows) > 0) await jobLog.logLeftSite(jobId, {}, actorOf(efrId));
  return { report: shapeAdditionalWork(await txReports.byId(row.id)) };
}

/*
 * Sheet 12: "If he has reported additional work that is still unapproved, this
 * same step lets him submit the booked portion and go; the additional comes
 * back as visit 2." Read by the checkout route, which then takes its existing
 * isNextVisit → 10 branch — server-side, so an old app build that never asks
 * cannot close a job whose extra work is still waiting.
 */
async function hasUnresolvedAdditionalWork(jobId) {
  return Boolean(await txReports.findOpen(jobId, KIND.ADDITIONAL_WORK));
}

/* ─── Can't complete (sheet 13) ─────────────────────────────────────────── */

async function reportCantComplete(jobId, efrId, { reasonId, proofImageIds }, actorId) {
  const job = await lifecycle.getOwnedJob(jobId, efrId);
  if (!CLAIM_STATUSES.has(Number(job.job_status))) throw httpError(409, 'This job can no longer be reported');
  // The existing lookup, not a second copy of its filter: whatever the app's
  // sheet lists is exactly what is accepted here.
  const reason = (await lookup.cannotCompleteReasons()).find((r) => Number(r.id) === Number(reasonId));
  if (!reason) throw httpError(400, 'Unknown reason');
  const ids = await assertProofOnJob(jobId, proofImageIds);

  const opened = await txReports.open({
    jobId, efrId, kind: KIND.CANT_COMPLETE,
    reasonCode: String(reason.id), reasonText: reason.reason, proofImageIds: ids,
  });
  if (opened.created) await jobLog.logCannotCompleteReported(jobId, { reasonId: reason.id }, actorOf(efrId));
  const row = await payVisitChargeIfOnSite(job, opened.row, efrId, actorId);
  return { report: shapeCantComplete(row), created: opened.created };
}

async function undoCantComplete(jobId, efrId) {
  await lifecycle.getOwnedJob(jobId, efrId);
  const row = await txReports.findOpen(jobId, KIND.CANT_COMPLETE);
  // Guarded UPDATE: a desk resolution that lands first wins, and he is told.
  if (!row || !(await txReports.markUndone(row.id))) {
    throw httpError(409, 'There is nothing to undo. EasyFix may have acted on it already.');
  }
  const visitCharge = await reverseClaimCharge(jobId, row);
  await jobLog.logClaimUndone(jobId, { kind: KIND.CANT_COMPLETE }, actorOf(efrId));
  return { undone: true, visitCharge };
}

/* ─── Cancel request (sheet 08c) ────────────────────────────────────────── */

/*
 * The proof + ₹250 half of POST /jobs/:id/cancel. Called by the route AFTER
 * lifecycle.cancel() recorded the ask, with the job row read BEFORE it — the
 * request model parks the job at 1, and both the ₹250 test and the undo need
 * the status he was actually in.
 *
 * An open 'cancel' row is REFRESHED, not duplicated: the CRM's reject clears
 * the tbl_job flag but does not know this table, so the next ask would
 * otherwise find a stale open row holding the previous ask's photos.
 */
async function recordCancelClaim(jobBefore, efrId, { reasonId, proofImageIds }, actorId) {
  const jobId = Number(jobBefore.job_id);
  const reason = (await lookup.appCancelReasons()).find((r) => Number(r.id) === Number(reasonId));
  const reasonText = reason ? reason.reason : null;
  const csv = txReports.proofIdsToCsv(proofImageIds);
  let row = await txReports.findOpen(jobId, KIND.CANCEL);
  if (row) {
    await pool.query(
      `UPDATE tbl_job_tx_report SET reason_code = ?, reason_text = ?, proof_image_ids = ?, reported_on = ?
        WHERE id = ?`,
      [String(reasonId), reasonText, csv, new Date(), row.id],
    );
    row = await txReports.byId(row.id);
  } else {
    ({ row } = await txReports.open({
      jobId, efrId, kind: KIND.CANCEL, reasonCode: String(reasonId), reasonText,
      proofImageIds, prevJobStatus: Number(jobBefore.job_status),
    }));
  }
  row = await payVisitChargeIfOnSite(jobBefore, row, efrId, actorId);
  return { proofCount: txReports.proofIdsFromCsv(row.proof_image_ids).length, visitCharge: visitChargeOf(row) };
}

/*
 * "Customer changed their mind" on a cancel ask. Withdraws it in the SAME
 * storage the CRM's reject clears (tbl_job.is_cancelled_by_app, job.service
 * rejectAppRequest), with the same guard: only an ask still pending at 1.
 *
 * AND PUTS HIM BACK TO WORK. The request model moved a checked-in job to 1;
 * left there, the app would show "Start job" to a man who is mid-job. The
 * status before the ask is on the claim row, and only a checked-in status is
 * restored — anything else stays at 1, which is what it was.
 */
async function undoCancel(jobId, efrId) {
  await lifecycle.getOwnedJob(jobId, efrId);
  const row = await txReports.findOpen(jobId, KIND.CANCEL);
  const back = row && CHECKED_IN_STATUSES.has(Number(row.prev_job_status))
    ? Number(row.prev_job_status) : lifecycle.STATUS_REQUEST_PENDING;
  const [res] = await pool.query(
    `UPDATE tbl_job SET is_cancelled_by_app = 0, job_status = ?
      WHERE job_id = ? AND fk_easyfixter_id = ? AND job_status = ?
        AND COALESCE(is_cancelled_by_app, 0) = 1`,
    [back, Number(jobId), Number(efrId), lifecycle.STATUS_REQUEST_PENDING],
  );
  if (!res || Number(res.affectedRows) === 0) {
    throw httpError(409, 'There is no open cancellation request on this job. EasyFix may have acted on it already.');
  }
  let visitCharge = { reversed: false, reason: 'no visit charge on this claim' };
  if (row && (await txReports.markUndone(row.id))) visitCharge = await reverseClaimCharge(jobId, row);
  await jobLog.logClaimUndone(jobId, { kind: KIND.CANCEL }, actorOf(efrId));
  return { undone: true, jobStatus: back, visitCharge };
}

/* ─── Need help (sheet 13b) ─────────────────────────────────────────────── */

async function requestHelp(jobId, efrId, reason) {
  const job = await lifecycle.getOwnedJob(jobId, efrId);
  if (!OPEN_JOB_STATUSES.includes(Number(job.job_status))) throw httpError(409, 'This job is closed');
  const label = txReports.HELP_REASONS[reason];
  if (!label) throw httpError(400, 'Unknown reason');
  const { row, created } = await txReports.open({
    jobId, efrId, kind: KIND.HELP, reasonCode: reason, reasonText: label,
  });
  if (created) await jobLog.logHelpRequested(jobId, { reason }, actorOf(efrId));
  return { help: shapeHelp(row), created };
}

/* ─── Read side: list + detail decoration ───────────────────────────────── */

/*
 * pendingOn / waitingFor / visitNo / collectFromCustomer for a page of jobs.
 *
 * FIXED BUDGET for any page size: pending-on's 2 + ONE tbl_job read + (only if
 * a cash-collect job is on the page) estimateLinesForJobs' 2. Never per row.
 * Decorated here, not in jobService.list, for the reason decorateTechnician-
 * Share gives: that list is also the CRM's and the export's.
 *
 * visitNo — 2 once the job has been sent back for another visit. The rule is
 * the one "My Team" already counts revisits by (mobile-team.service
 * recorded_revisit_jobs: `COALESCE(visit_number, 1) > 1 OR revisit_reason_id
 * IS NOT NULL`), plus "it is AT 10 right now", so the Going-back group and the
 * team screen cannot disagree about which jobs are second visits. Read from
 * tbl_job, not from the 'Re-visit Required' history rows, so the app's
 * hottest read does not depend on the tbl_job_logs(job_id) index.
 *
 * collectFromCustomer — ONLY on a cash-collect job, i.e. tbl_job.collected_by
 * = 1: the ledger's own reading of that code (job-ledger SIGN_TABLE 1, "the
 * technician collected" — he is debited the whole bill). The figure is
 * job-line-total's grand_total, the ONE definition every estimate and invoice
 * surface quotes, so "collect ₹X" is the number on the customer's bill. It is
 * the one client figure the phone is allowed (spec rule 5), under a name that
 * cannot be read as "order value". Absent when there is nothing priced —
 * "collect ₹0" is an instruction, and a wrong one.
 */
async function decorateJobState(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && Number.isSafeInteger(Number(r.job_id)));
  if (!list.length) return rows;
  const ids = [...new Set(list.map((r) => Number(r.job_id)))];

  const states = await pendingOnForJobs(pool, list);
  const [facts] = await pool.query(
    `SELECT job_id, job_status, CAST(collected_by AS SIGNED) AS collected_by,
            visit_number, revisit_reason_id
       FROM tbl_job WHERE job_id IN (?)`,
    [ids],
  );
  const factById = new Map(facts.map((f) => [Number(f.job_id), f]));
  const cashIds = facts.filter((f) => Number(f.collected_by) === 1).map((f) => Number(f.job_id));
  const bills = cashIds.length ? await estimateLinesForJobs(cashIds) : new Map();

  for (const row of list) {
    const id = Number(row.job_id);
    const s = states.get(id) || {};
    row.pendingOn = s.pendingOn ?? null;
    row.waitingFor = s.waitingFor ?? null;
    const f = factById.get(id) || {};
    const revisited = Number(f.job_status ?? row.job_status) === 10
      || Number(f.visit_number || 1) > 1 || f.revisit_reason_id != null;
    row.visitNo = revisited ? 2 : 1;
    const bill = bills.get(id);
    const total = bill ? Math.round(Number(bill.totals.grand_total) || 0) : 0;
    if (total > 0) row.collectFromCustomer = total;
  }
  return rows;
}

/*
 * The detail's claim state: `reports` (the latest in-flight row per kind, plus
 * an approved additional-work row he may now act on) and `cancelRequest`.
 * One bounded query; the cancel ask itself is read off the job row the caller
 * already holds (is_cancelled_by_app, via lifecycle.bitTrue — a bit(1) Buffer
 * is always truthy).
 */
async function detailClaims(job) {
  const rows = await txReports.forJob(job.job_id);
  const first = (kind, statuses) => rows.find((r) => r.kind === kind && statuses.includes(r.status));
  const reports = {};
  const extra = first(KIND.ADDITIONAL_WORK, [...txReports.OPEN_STATUSES, STATUS.APPROVED]);
  if (extra) reports.additionalWork = shapeAdditionalWork(extra);
  const cant = first(KIND.CANT_COMPLETE, [STATUS.OPEN]);
  if (cant) reports.cantComplete = shapeCantComplete(cant);
  const help = first(KIND.HELP, [STATUS.OPEN]);
  if (help) reports.help = shapeHelp(help);

  let cancelRequest;
  if (lifecycle.bitTrue(job.is_cancelled_by_app)) {
    const claim = first(KIND.CANCEL, [STATUS.OPEN]);
    cancelRequest = {
      reasonText: job.app_cancel_reason_name ?? (claim ? claim.reason_text : null) ?? null,
      proofCount: claim ? txReports.proofIdsFromCsv(claim.proof_image_ids).length : 0,
      requestedOn: job.cancel_date_time ?? null,
      visitCharge: claim ? visitChargeOf(claim) : null,
    };
  }
  return { reports, cancelRequest };
}

/* ─── Where is my money (sheet 14) ──────────────────────────────────────── */

/*
 * The four steps, each with its date or null: You finished · EasyFix checking
 * (usually N h) · Client QC (usually N h) · In wallet. ONE job read (owner-
 * pinned) + technicianSharesForJobs' 1-3. Read once by done.tsx, never polled.
 *
 * walletOn is the verification row's posted_on, or — for a job whose ledger was
 * posted some other way (a CRM completion posts at checkout) — the
 * tbl_job_transaction row's own date: the money is in the wallet either way,
 * and saying "not yet" about money he can already withdraw is the one wrong
 * answer this screen exists to stop.
 */
async function jobMoney(jobId, efrId) {
  const [[row]] = await pool.query(
    `SELECT j.job_id, j.checkout_date_time, cl.client_name,
            v.verified_on, v.qc_due_on, v.qc_status, v.qc_on, v.posted_on,
            t.qc_hours, t.check_hours,
            (SELECT jt.insert_date FROM tbl_job_transaction jt
              WHERE jt.fk_job_id = j.job_id LIMIT 1) AS ledger_on
       FROM tbl_job j
       LEFT JOIN tbl_client cl ON cl.client_id = j.fk_client_id
       LEFT JOIN tbl_job_verification v ON v.job_id = j.job_id
       LEFT JOIN tbl_client_qc_timing t ON t.client_id = j.fk_client_id
      WHERE j.job_id = ? AND j.fk_easyfixter_id = ?
      LIMIT 1`,
    [Number(jobId), Number(efrId)],
  );
  if (!row) throw httpError(404, 'job not found');
  const share = (await technicianSharesForJobs(pool, [Number(jobId)])).get(Number(jobId));
  const qcDone = row.qc_status === 'passed' || row.qc_status === 'auto';
  return {
    share: share ? share.amount : null,
    shareEstimated: share ? !share.posted : null,
    finishedOn: row.checkout_date_time || null,
    checking: {
      doneOn: row.verified_on || null,
      usualHours: Number(row.check_hours) > 0 ? Number(row.check_hours) : hoursProperty(PROP_CHECK_HOURS, CHECK_HOURS_DEFAULT),
    },
    clientQc: {
      doneOn: qcDone ? (row.qc_on || row.qc_due_on || null) : null,
      dueOn: row.qc_due_on || null,
      usualHours: Number(row.qc_hours) > 0 ? Number(row.qc_hours) : hoursProperty(PROP_QC_HOURS, QC_HOURS_DEFAULT),
      clientName: row.client_name || null,
    },
    walletOn: row.posted_on || row.ledger_on || null,
  };
}

module.exports = {
  reportAdditionalWork,
  answerBooked,
  leaveSite,
  hasUnresolvedAdditionalWork,
  reportCantComplete,
  undoCantComplete,
  assertProofOnJob,
  recordCancelClaim,
  undoCancel,
  requestHelp,
  decorateJobState,
  detailClaims,
  jobMoney,
  PROP_QC_HOURS,
  PROP_CHECK_HOURS,
  QC_HOURS_DEFAULT,
  CHECK_HOURS_DEFAULT,
  _internals: { onSite, CLAIM_STATUSES },
};
