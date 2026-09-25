'use strict';
/*
 * services/ops-desk.service.js — the live-ops desk (V3 plan 3.2 / 3.3 / 3.5 / 3.6).
 *
 * WHAT IT IS. The CRM screen the prototype draws in renderDesk(): every job that
 * is on site today or waiting on someone, bucketed into four bands —
 *   A  on site, moving          B  stuck on the client
 *   C  quality check            D  cannot finish as booked
 * — with the desk's own actions on a technician's claim (price / send back /
 * resolve). Design authority: scratchpad/proto.txt renderDesk(), job.txt 10-13b.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: decide who a job is waiting on. The band,
 * pendingOn and situation come from services/job-pending-on.js
 * pendingOnForJobs() — the SAME function the technician app reads (spec rule 6),
 * so the desk and the phone cannot disagree about whose move it is.
 *
 * QUERY BUDGET (EASYFIX_PERFORMANCE_STANDARD — "fixed query budget"). listDesk
 * issues a FIXED number of statements for any number of jobs:
 *   1   the in-flight set (one UNION of five id sources, joined once)
 *   ≤3  pendingOnForJobs (its own contract)
 *   1   open claims for the page
 *   1   start-PIN log rows for the page
 *   ≤3  technicianSharesForJobs (1 posted + 2 estimate)
 *   2   estimateLinesForJobs (services + approved material lines)
 *   1   job_material client charges for the page
 * tests/v3p3-b-ops-desk.test.js pins it for 1 job and for 150.
 */
const { pool } = require('../db');
const logger = require('../logger');
const job = require('./job.service');
const jobLog = require('./job-log.service');
const ledger = require('./job-ledger.service');
const { estimateLinesForJobs } = require('./job-line-total');
const { stageVisibleStatuses } = require('../lib/job-stages');
const { todayIst, shiftYmd, istStringToDate } = require('../utils/ist-calendar');

const BANDS = ['A', 'B', 'C', 'D'];
const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;

/*
 * The in-flight set is computed in full (to count every band) and then paged,
 * so it needs its own ceiling. 2,000 is ~10x a busy day's on-site jobs across
 * every city; above it the response says `truncated` rather than silently
 * dropping rows.
 * ponytail: in-memory band filter over ≤2,000 rows; persist the band if the
 * desk ever needs more than that.
 */
const IN_FLIGHT_CAP = 2000;

/*
 * How far back a completed-but-unaudited job stays on the desk. tbl_job_verification
 * is NEW, so "every 3/5/10 job with no verification row" is the entire archive —
 * 2015 jobs would top an oldest-first queue. A rolling window keeps the desk to
 * work that can still be audited against a fresh memory.
 * ponytail: fixed 7 days; make it a property if ops wants a longer tail.
 */
const AUDIT_WINDOW_DAYS = 7;

/*
 * The door clock. The prototype starts it at 30 minutes when the additional
 * work is reported (proto.txt `doorLeft:30*60`, reset in sendQuote) and the app
 * tells him "Waiting N min. If no answer, finish the booked work and leave".
 * needsMeIn is the SAME countdown, so the desk sees the minutes he has left.
 */
const DOOR_WAIT_MINUTES = 30;

const OPEN_REPORT_STATUSES = ['open', 'priced', 'returned'];
const COMPLETED_STATUSES = [3, 5, 10];

function httpError(status, message, code) {
  const e = new Error(message); e.status = status; if (code) e.code = code; return e;
}

/*
 * A history row must never cost the action it records (job-log.service.js
 * "FAIL-SOFT, AND OUTSIDE THE CALLER'S TRANSACTION"). The writers already
 * swallow their own errors; this also survives a writer that is missing from
 * the module, which would otherwise turn a committed price into a 500.
 */
async function logSoft(name, jobId, details, actor, at) {
  try {
    await jobLog[name](jobId, details, actor, at);
  } catch (e) {
    logger.warn(`Job log ${name} failed (non-fatal) · jobId=${jobId} · ${e.message}`);
  }
}

/*
 * RBAC row scope, written EXACTLY as job.service list() writes it for
 * GET /api/admin/jobs: clients on j.fk_client_id, cities on ad.city_id,
 * verticals on cl.vertical_id (only when the column exists), then the Job Stage
 * Access intersection. buildRequestScopeWithHierarchy has already expanded
 * states into cities and folded verticals into clients, so list() reads no
 * states dimension and neither does this. Needs aliases j, ad, cl.
 */
function scopeClauses(scope, allowedStages, hasVerticalCol) {
  const clauses = [];
  const params = [];
  if (scope) {
    const dims = [
      [scope.clients, 'j.fk_client_id'],
      [scope.cities, 'ad.city_id'],
      [hasVerticalCol ? scope.verticals : null, 'cl.vertical_id'],
    ];
    for (const [d, col] of dims) {
      if (!d) continue;
      if (d.mode === 'none') clauses.push('1=0');
      else if (d.mode === 'allow' && d.ids.length) { clauses.push(`${col} IN (?)`); params.push(d.ids); }
    }
    // list() skips the vertical dimension when the column is absent, but a
    // 'none' vertical scope still means nothing is visible.
    if (!hasVerticalCol && scope.verticals && scope.verticals.mode === 'none') clauses.push('1=0');
  }
  if (allowedStages && allowedStages.mode === 'list') {
    const visible = [...stageVisibleStatuses(allowedStages.stages)];
    if (!visible.length) clauses.push('1=0');
    else { clauses.push('j.job_status IN (?)'); params.push(visible); }
  }
  return { clauses, params };
}

// Display columns shared by the desk and the verification queue.
const JOB_COLUMNS = `j.job_id, j.job_status, j.job_reference_id, j.client_ref_id, j.fk_client_id,
       j.fk_easyfixter_id, j.requested_date_time, j.checkin_date_time, j.checkout_date_time,
       j.approved_on_date_time,
       (COALESCE(j.is_cancelled_by_app, 0) = 1)   AS is_cancelled_by_app,
       (COALESCE(j.is_rescheduled_by_app, 0) = 1) AS is_rescheduled_by_app,
       cl.client_name, ad.locality, ci.city_name, e.efr_name, sc.service_catg_name`;
const JOB_JOINS = `LEFT JOIN tbl_address      ad ON ad.address_id     = j.fk_address_id
  LEFT JOIN tbl_city         ci ON ci.city_id        = ad.city_id
  LEFT JOIN tbl_client       cl ON cl.client_id      = j.fk_client_id
  LEFT JOIN tbl_easyfixer    e  ON e.efr_id          = j.fk_easyfixter_id
  LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = j.fk_service_catg_id`;

function jobHeader(r) {
  return {
    jobId: Number(r.job_id),
    reference: r.job_reference_id || r.client_ref_id || null,
    title: r.service_catg_name || null,
    clientName: r.client_name || null,
    locality: r.locality || r.city_name || null,
    technician: r.fk_easyfixter_id ? { efrId: Number(r.fk_easyfixter_id), name: r.efr_name || null } : null,
    jobStatus: Number(r.job_status),
  };
}

function auditSince(now) {
  return `${shiftYmd(todayIst(now), -AUDIT_WINDOW_DAYS)} 00:00:00`;
}

/*
 * The in-flight set — spec "Admin": today's live jobs, anything with an open
 * claim or app request, plus completed jobs not yet through audit / QC.
 *
 * A DERIVED TABLE OF UNIONED IDS, not `WHERE … OR …` and not `IN (SELECT … UNION …)`.
 * An OR across five unrelated predicates cannot use any one index, so it scans
 * tbl_job (384k rows) on every 30-second poll; a UNION inside IN() is not a
 * semi-join candidate and is re-evaluated per outer row. Each arm here is a
 * narrow index range (job_status, idx_jtr_status, idx_jv_qc), the union is
 * materialised once, and tbl_job is then joined by primary key.
 */
async function loadInFlight({ scope, allowedStages, now }) {
  const hasVerticalCol = await job.hasClientVerticalIdColumn();
  const { clauses, params } = scopeClauses(scope, allowedStages, hasVerticalCol);
  const { todayStart, tomorrowStart } = job.istDayBounds(now);
  const [rows] = await pool.query(
    `SELECT ${JOB_COLUMNS}
       FROM (
         SELECT job_id FROM tbl_job
          WHERE job_status IN (1, 2, 15, 16, 20) AND requested_date_time >= ? AND requested_date_time < ?
         UNION SELECT job_id FROM tbl_job_tx_report WHERE status IN (?)
         UNION SELECT job_id FROM tbl_job
          WHERE job_status = 1 AND (COALESCE(is_cancelled_by_app, 0) = 1 OR COALESCE(is_rescheduled_by_app, 0) = 1)
         UNION SELECT job_id FROM tbl_job WHERE checkout_date_time >= ? AND job_status IN (?)
         UNION SELECT job_id FROM tbl_job_verification WHERE qc_status IN ('pending', 'disputed')
       ) f
       JOIN tbl_job j ON j.job_id = f.job_id
       ${JOB_JOINS}
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY j.requested_date_time, j.job_id
      LIMIT ?`,
    [todayStart, tomorrowStart, OPEN_REPORT_STATUSES, auditSince(now), COMPLETED_STATUSES,
      ...params, IN_FLIGHT_CAP + 1],
  );
  return { rows: rows.slice(0, IN_FLIGHT_CAP), truncated: rows.length > IN_FLIGHT_CAP };
}

/*
 * Start proof from tbl_job_logs 'customer pin verified' (job-log.service.js
 * logCustomerPinVerified): old_data 'Late: yes' is the PIN entered after
 * arrival. No row but checked in → photos were the proof (sheet 11b). One row
 * saying on-time beats a later late one.
 */
async function startProofForJobs(rows) {
  const out = new Map();
  if (!rows.length) return out;
  const [logs] = await pool.query(
    'SELECT job_id, old_data FROM tbl_job_logs WHERE job_id IN (?) AND log_for = ?',
    [rows.map((r) => Number(r.job_id)), jobLog.LOG_FOR.CUSTOMER_PIN_VERIFIED],
  );
  for (const l of logs) {
    const id = Number(l.job_id);
    const late = l.old_data === 'Late: yes';
    if (!late) out.set(id, 'pin');
    else if (!out.has(id)) out.set(id, 'pin_late');
  }
  for (const r of rows) {
    if (!out.has(Number(r.job_id)) && r.checkin_date_time) out.set(Number(r.job_id), 'photos');
  }
  return out;
}

/*
 * Signed like job-ledger.service.js materialSign (not exported): penalty
 * subtracts, material / travel / incentive add, anything else is not money.
 */
function materialSign(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'penalty') return -1;
  return ['material', 'travel', 'incentive'].includes(t) ? 1 : 0;
}

/*
 * Client ₹X · TX ₹Y (renderDesk k-money, the JobModal Money card).
 *   client  what the client is billed: the job's priced lines through
 *           job-line-total.js (THE definition the estimate preview, the email
 *           and the client portal already share) plus job_material client
 *           charges — so a ₹250 visit charge shows on both sides.
 *   tx      technicianSharesForJobs — the one function every technician-facing
 *           surface asks, posted where posted, estimated where not.
 * null, never 0, where the answer is unknown (that function's own rule).
 */
async function moneyForJobs(jobIds) {
  const ids = [...new Set(jobIds.map(Number))];
  const out = new Map();
  if (!ids.length) return out;
  const shares = await ledger.technicianSharesForJobs(pool, ids);
  const lines = await estimateLinesForJobs(ids);
  const [materials] = await pool.query(
    'SELECT job_id, type, client_charge FROM job_material WHERE job_id IN (?)', [ids],
  );
  const extra = new Map();
  for (const m of materials) {
    const id = Number(m.job_id);
    extra.set(id, (extra.get(id) || 0) + materialSign(m.type) * Number(m.client_charge || 0));
  }
  for (const id of ids) {
    const est = lines.get(id);
    const hasClient = est || extra.has(id);
    const client = hasClient ? round2((est ? est.totals.grand_total : 0) + (extra.get(id) || 0)) : null;
    const share = shares.get(id);
    const tx = share ? share.amount : null;
    out.set(id, {
      client, tx, txPosted: share ? share.posted : null,
      margin: client != null && tx != null ? round2(client - tx) : null,
    });
  }
  return out;
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }

function minutesSince(value, now) {
  const d = istStringToDate(value);
  return d ? Math.floor((now.getTime() - d.getTime()) / 60000) : null;
}

function shapeReport(r) {
  return {
    id: Number(r.id),
    kind: r.kind,
    status: r.status,
    reasonCode: r.reason_code || null,
    reasonText: r.reason_text || null,
    proofImageIds: r.proof_image_ids ? String(r.proof_image_ids).split(',').map(Number).filter(Boolean) : [],
    bookedMeanwhile: r.booked_meanwhile || null,
    leftSiteOn: r.left_site_on || null,
    clientAmount: r.client_amount == null ? null : Number(r.client_amount),
    txAmount: r.tx_amount == null ? null : Number(r.tx_amount),
    priceNote: r.price_note || null,
    returnNote: r.return_note || null,
    visitChargeAwarded: Number(r.visit_charge_awarded) === 1,
    reportedOn: r.reported_on,
  };
}

// The claim the desk acts on first: help (band A), then the band-D claims,
// then additional work — renderDesk's own if/else order.
const REPORT_PRIORITY = ['help', 'cant_complete', 'cancel', 'additional_work'];

async function listDesk({ scope, allowedStages, band = null, limit = LIMIT_DEFAULT, offset = 0, now = new Date() }) {
  const lim = Math.min(Math.max(Number(limit) || LIMIT_DEFAULT, 1), LIMIT_MAX);
  const off = Math.max(Number(offset) || 0, 0);
  const { rows, truncated } = await loadInFlight({ scope, allowedStages, now });

  // eslint-disable-next-line global-require -- BACKEND-A's module; see the header.
  const { pendingOnForJobs } = require('./job-pending-on');
  const pending = rows.length ? await pendingOnForJobs(pool, rows) : new Map();

  const counts = { A: 0, B: 0, C: 0, D: 0 };
  const live = [];
  for (const r of rows) {
    const p = pending.get(Number(r.job_id)) || {};
    // A completed job whose audit and QC are both behind it is history, not
    // in flight — it only entered the set through the 7-day audit arm.
    if (!p.band && COMPLETED_STATUSES.includes(Number(r.job_status))) continue;
    if (p.band) counts[p.band] += 1;
    live.push({ r, p });
  }
  const order = (b) => (b ? BANDS.indexOf(b) : BANDS.length);
  const filtered = (band ? live.filter((x) => x.p.band === band) : live)
    .sort((a, b) => order(a.p.band) - order(b.p.band));   // stable: appointment order within a band
  const page = filtered.slice(off, off + lim);
  const pageRows = page.map((x) => x.r);
  const ids = pageRows.map((r) => Number(r.job_id));

  const reportsByJob = new Map();
  if (ids.length) {
    const [reports] = await pool.query(
      `SELECT id, job_id, kind, status, reason_code, reason_text, proof_image_ids, booked_meanwhile,
              left_site_on, client_amount, tx_amount, price_note, return_note, visit_charge_awarded, reported_on
         FROM tbl_job_tx_report WHERE job_id IN (?) AND status IN (?)`,
      [ids, OPEN_REPORT_STATUSES],
    );
    for (const rep of reports) {
      const list = reportsByJob.get(Number(rep.job_id)) || [];
      list.push(rep);
      reportsByJob.set(Number(rep.job_id), list);
    }
  }
  const proof = await startProofForJobs(pageRows);
  const money = await moneyForJobs(ids);

  const items = page.map(({ r, p }) => {
    const id = Number(r.job_id);
    const reports = (reportsByJob.get(id) || [])
      .sort((a, b) => REPORT_PRIORITY.indexOf(a.kind) - REPORT_PRIORITY.indexOf(b.kind));
    const top = reports[0] || null;
    const help = reports.find((x) => x.kind === 'help');
    const aw = reports.find((x) => x.kind === 'additional_work');
    // needsMeIn: minutes left on the door clock while he is on site holding
    // for pricing / approval (proto.txt timer). Null once he has left.
    let needsMeIn = null;
    if (aw && ['open', 'priced'].includes(aw.status) && !aw.left_site_on) {
      const waited = minutesSince(aw.reported_on, now);
      if (waited != null) needsMeIn = Math.max(0, DOOR_WAIT_MINUTES - waited);
    }
    const m = money.get(id) || {};
    return {
      ...jobHeader(r),
      band: p.band || null,
      situation: p.situation || null,
      pendingOn: p.pendingOn || null,
      waitingFor: p.waitingFor || null,
      startProof: proof.get(id) || null,
      money: { client: m.client ?? null, tx: m.tx ?? null },
      needsMeIn,
      report: top ? shapeReport(top) : null,
      helpReason: help ? help.reason_code : null,
      leftSite: aw ? Boolean(aw.left_site_on) : null,
      appointmentOn: r.requested_date_time || null,
    };
  });
  logger.info(`Ops desk · inFlight=${rows.length} · band=${band || 'all'} · page=${items.length}`);
  return { counts, items, total: filtered.length, truncated };
}

/*
 * The report + its job, scope-checked the way scopedJob checks a job: a report
 * on a job outside the caller's patch is a 404, never a 403, so ids do not leak.
 */
async function loadReportInScope(reportId, req) {
  const [[rep]] = await pool.query(
    `SELECT id, job_id, efr_id, kind, status, reason_code, reason_text, client_amount, tx_amount
       FROM tbl_job_tx_report WHERE id = ?`,
    [reportId],
  );
  if (!rep) return null;
  const j = await job.getById(rep.job_id);
  if (!j) return null;
  // eslint-disable-next-line global-require
  const { assertEntityInScope } = require('../lib/scope');
  const guard = assertEntityInScope(req, { client_id: j.fk_client_id, city_id: j.city_id, vertical_id: j.vertical_id });
  if (!guard.ok) return null;
  return { report: rep, job: j };
}

/*
 * PRICE — the desk turns a technician's "I found additional work" into an
 * estimate the CLIENT approves, through the pipeline the client portal already
 * runs. Nothing about the approval is forked:
 *
 *   the line   a quotation_details row born REVIEWED — sent_on = action_on = now,
 *              status 1, client_status NULL — i.e. quotation-line-state's
 *              `approval_pending`. That is the exact shape the CRM's own
 *              "add a line" route writes (routes/admin/jobs.js POST
 *              /:id/quotation-lines) and the exact set the client's approve /
 *              reject stamps (job-estimate-approval.js stampApprovalPendingLines).
 *              type 'material' because the client's estimate preview lists
 *              approved quotation lines of that type only
 *              (job-line-total.js approvedMaterialLinesForJobs); a 'product' line
 *              would be approved blind. approved_charge = what the client pays,
 *              tx_charge = his share, margin = the difference.
 *   the status 1 / 2 / 20 → 15 with the pre-status stored (same as that route),
 *              16 stays 16 (the PM's review moves it to 15), 15 stays 15 (one
 *              estimate, one decision). 15 is the ONLY status the action queue
 *              lists and the approve route accepts (isEstimateApprovable).
 *   the ask    material-client-request.service sendMaterialClientRequest, after
 *              commit and never awaited — that route's rule.
 *
 * REFUSED when the job already carries a client decision. PATCH
 * /client/jobs/:id/estimate/approve refuses a job with approved_on_date_time or
 * approval_reject_date_time set, and the action queue hides it, and nothing in
 * this codebase clears those stamps. Pricing such a job would park it at 15 with
 * an estimate no client screen can act on, so it is a 409 the desk can read.
 */
/*
 * 10 is priceable (V3 Phase 4, 4.3). A checkout with additional work still
 * pending closes as a REVISIT (10) — the technician has left. Without 10 here
 * the claim sat at "pricing" forever: nothing could price it, so nothing could
 * schedule visit 2. Priced from 10, the client's EXISTING approve flow asks for
 * a visit slot and moves the job to 1 — which IS scheduling visit 2, exactly
 * the design's "price it and get approval so visit 2 can be scheduled". A
 * rejection returns it to 10 (estimateRejectStatus), never to "in progress".
 */
const PRICEABLE_STATUSES = new Set([1, 2, 10, 15, 16, 20]);
const ENTERS_ESTIMATE = new Set([1, 2, 10, 20]);

async function priceReport({ report, job: j }, { clientAmount, txAmount, note = null }, actor, { now = new Date() } = {}) {
  if (report.kind !== 'additional_work') throw httpError(400, 'Only additional work is priced');
  if (report.status !== 'open') throw httpError(409, `This report is ${report.status}, not waiting for a price`, 'REPORT_NOT_OPEN');
  if (Number(txAmount) > Number(clientAmount)) {
    throw httpError(400, 'The technician share cannot be more than the client price');
  }
  const status = Number(j.job_status);
  if (!PRICEABLE_STATUSES.has(status)) throw httpError(409, `A job in status ${status} cannot take an estimate`);
  if (j.approved_on_date_time || j.approval_reject_date_time) {
    throw httpError(409, 'The client has already decided an estimate on this job, and the client portal accepts one decision per job. Price it on a new ticket.', 'CLIENT_ALREADY_DECIDED');
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // The guard IS the idempotency: two desk users pressing Price at once —
    // the second updates 0 rows and rolls back its quotation line with it.
    const [upd] = await conn.query(
      `UPDATE tbl_job_tx_report SET status = 'priced', client_amount = ?, tx_amount = ?, price_note = ?
        WHERE id = ? AND status = 'open'`,
      [clientAmount, txAmount, note, report.id],
    );
    if (!upd.affectedRows) throw httpError(409, 'This report was priced or changed by someone else', 'REPORT_NOT_OPEN');
    await conn.query(
      `INSERT INTO quotation_details
         (type, name, unit, unit_price, tx_charge, client_charge, approved_charge, margin,
          status, action_by, sent_by, sent_on, action_on, job_id)
       VALUES ('material', ?, 1, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      [(note ? `Additional work — ${note}` : 'Additional work').slice(0, 100), clientAmount, txAmount, clientAmount, clientAmount, clientAmount - txAmount,
        actor.user_id, actor.user_id, now, now, j.job_id],
    );
    if (ENTERS_ESTIMATE.has(status)) {
      // eslint-disable-next-line global-require
      await require('./material-review-store').storePreMaterialStatus(j.job_id, status, conn);
      await job.setStatus(j.job_id, { status: job.STATUS.ESTIMATE_PENDING_APPROVAL }, actor, { conn });
    }
    await conn.commit();
  } catch (e) {
    try { await conn.rollback(); } catch { /* connection may already be gone */ }
    throw e;
  } finally {
    conn.release();
  }
  if (status !== job.STATUS.PENDING_FOR_MATERIAL) {
    // eslint-disable-next-line global-require
    require('./material-client-request.service').sendMaterialClientRequest(j.job_id)
      .catch((err) => logger.warn('Additional work client request failed (non-fatal) · jobId=' + j.job_id + ' · ' + err.message));
  }
  await logSoft('logAdditionalWorkPriced', j.job_id, { clientAmount, txAmount }, actor, now);
  logger.info(`Additional work priced · report=${report.id} · jobId=${j.job_id} · client=${clientAmount} tx=${txAmount}`);
  return { id: Number(report.id), status: 'priced', jobStatus: ENTERS_ESTIMATE.has(status) ? 15 : status };
}

// "Send back to him" — before pricing only; once priced it is with the client.
async function returnReport({ report, job: j }, { note }, actor, { now = new Date() } = {}) {
  if (report.kind !== 'additional_work') throw httpError(400, 'Only additional work is sent back');
  const [upd] = await pool.query(
    `UPDATE tbl_job_tx_report SET status = 'returned', return_note = ? WHERE id = ? AND status = 'open'`,
    [note, report.id],
  );
  if (!upd.affectedRows) throw httpError(409, `This report is ${report.status}, not waiting for the desk`, 'REPORT_NOT_OPEN');
  await logSoft('logAdditionalWorkReturned', j.job_id, {}, actor, now);
  return { id: Number(report.id), status: 'returned' };
}

/*
 * RESOLVE.
 *   help           "Bench picked up" (renderDesk helpDone) → resolved.
 *   cant_complete  after the desk verified with the customer (band D hint):
 *   cancel           outcome 'revisit' + revisitOn → job.reschedule (the
 *                    Schedule & Assign path, which also answers a technician
 *                    reschedule ask); a cancel CLAIM declined this way also
 *                    clears its ask via job.rejectAppRequest, the CRM Reject
 *                    button's writer. The ₹250 stays his: the trip was wasted.
 *                  outcome 'cancel' → job.setStatus(6), the CRM cancel path,
 *                    which also clears the app-request flags.
 *
 * CLAIM FIRST, THEN ACT. The report flips to resolved under a status guard
 * before the job moves, so two desk users cannot both reschedule/cancel; if the
 * job move then fails the claim is put back and the error surfaces.
 * Job Stage Access is applied as the direct routes apply it (require-stage.js).
 */
async function resolveReport({ report, job: j }, body, actor, { allowedStages, now = new Date() } = {}) {
  if (!['help', 'cant_complete', 'cancel'].includes(report.kind)) {
    throw httpError(400, 'Additional work is priced or sent back, not resolved');
  }
  if (report.status !== 'open') throw httpError(409, `This report is ${report.status}, not open`, 'REPORT_NOT_OPEN');
  const outcome = report.kind === 'help' ? null : body.outcome;
  if (report.kind !== 'help') {
    if (!['revisit', 'cancel'].includes(outcome)) throw httpError(400, "outcome must be 'revisit' or 'cancel'");
    // eslint-disable-next-line global-require
    const { transitionAllowed, stageVisible } = require('../lib/job-stages');
    const restricted = allowedStages && allowedStages.mode !== 'all';
    const source = Number(j.job_status);
    if (restricted && outcome === 'cancel' && !transitionAllowed(allowedStages, source, job.STATUS.CANCELLED)) {
      throw httpError(403, 'You are not allowed to move this job to that stage.');
    }
    if (restricted && outcome === 'revisit' && !stageVisible(allowedStages, source)) {
      throw httpError(403, 'You do not have access to this job stage.');
    }
    /*
     * A revisit always names its day. For a cancel claim that is also the
     * honest answer: the request parked the job at 1 and he has left, so
     * "carry on now" is the technician's own undo, not the desk's call — and it
     * keeps his ₹250, because this trip was still wasted.
     */
    if (outcome === 'revisit' && !body.revisitOn) {
      throw httpError(400, 'revisitOn is required to schedule the revisit');
    }
    // job.reschedule records a reason on every move (rescheduleBody requires one).
    if (body.revisitOn && !body.reasonId) throw httpError(400, 'reasonId (a reschedule reason) is required with revisitOn');
    if (body.revisitOn && job.formatMysqlDateTimeIST(now) >= String(body.revisitOn).replace('T', ' ')) {
      throw httpError(400, 'Cannot reschedule to a date and time that has already passed. Pick a future appointment.');
    }
  }

  const [claim] = await pool.query(
    `UPDATE tbl_job_tx_report SET status = 'resolved', resolved_on = ?, resolved_by = ?
      WHERE id = ? AND status = 'open'`,
    [now, actor.user_id, report.id],
  );
  if (!claim.affectedRows) throw httpError(409, 'This report was resolved by someone else', 'REPORT_NOT_OPEN');

  try {
    if (outcome === 'cancel') {
      await job.setStatus(j.job_id, {
        status: job.STATUS.CANCELLED,
        reasonId: body.reasonId,
        comment: body.comment || 'Cancelled after the desk verified with the customer.',
      }, actor);
    } else if (outcome === 'revisit') {
      if (report.kind === 'cancel') {
        await job.rejectAppRequest(j.job_id, { kind: 'cancel', remarks: 'The customer still wants the job.' }, actor);
      }
      await job.reschedule(j.job_id, {
        requestedDateTime: body.revisitOn,
        reasonId: body.reasonId,
        remarks: body.comment || 'Revisit agreed with the customer after the technician could not finish.',
      }, actor);
    }
  } catch (e) {
    await pool.query(
      `UPDATE tbl_job_tx_report SET status = 'open', resolved_on = NULL, resolved_by = NULL WHERE id = ? AND status = 'resolved'`,
      [report.id],
    ).catch((re) => logger.warn(`Report re-open after failed resolve failed · report=${report.id} · ${re.message}`));
    throw e;
  }
  if (report.kind === 'help') await logSoft('logHelpPickedUp', j.job_id, {}, actor, now);
  logger.info(`Report resolved · report=${report.id} · kind=${report.kind} · outcome=${outcome || '-'}`);
  return { id: Number(report.id), status: 'resolved', outcome };
}

/*
 * The client decided the estimate a desk price put in front of them. Called
 * AFTER the approval committed, from each approve / reject surface this repo's
 * desk owns (client portal PATCH /jobs/:id/estimate/approve|reject, admin
 * POST /:id/client-approval-on-behalf). A WRITE rather than derive-on-read:
 * the on-behalf path stamps no approved_on_date_time, so no column read later
 * could tell an approved line from a pending one, and the app's "approved — you
 * can do it now" needs the moment it happened (logAdditionalWorkApproved).
 * Rejected → resolved: the claim is closed and nothing was approved.
 * Fail-soft: the client's decision has already landed.
 */
async function settleAdditionalWork(jobId, approved, actor, { now = new Date() } = {}) {
  try {
    // Read the priced report FIRST so the pay-out below knows its id and its
    // technician share. The UPDATE is still guarded on status = 'priced', so
    // two approve paths racing settle it once and only the winner pays.
    const [[rep]] = await pool.query(
      `SELECT id, tx_amount FROM tbl_job_tx_report
        WHERE job_id = ? AND kind = 'additional_work' AND status = 'priced'
        ORDER BY id DESC LIMIT 1`,
      [jobId],
    );
    if (!rep) return false;
    const [upd] = await pool.query(
      `UPDATE tbl_job_tx_report SET status = ?, resolved_on = ?
        WHERE id = ? AND status = 'priced'`,
      [approved ? 'approved' : 'resolved', now, rep.id],
    );
    if (!upd.affectedRows) return false;
    if (approved) {
      // The technician's share, onto the road the ledger actually reads. See
      // incentives.awardAdditionalWork for why client_charge is 0.
      await require('./job-incentive.service').awardAdditionalWork(jobId, {
        reportId: rep.id, txCharge: rep.tx_amount, actorId: actor?.user_id ?? 'system',
      });
      await logSoft('logAdditionalWorkApproved', jobId, {}, actor, now);
    }
    return true;
  } catch (e) {
    logger.warn(`Additional work settle failed (non-fatal) · jobId=${jobId} · ${e.message}`);
    return false;
  }
}

/*
 * GET /admin/verification — the EasyFix check queue (3.6).
 *   audit   completed / revisit jobs (3, 5, 10) with no verification row inside
 *           the audit window, OLDEST FIRST (the one waiting longest). Paged.
 *   claims  open cant_complete / cancel claims plus technician cancel asks
 *           still raised on tbl_job (an app build without the claim row).
 *           The live set is small; capped rather than paged.
 */
const CLAIMS_CAP = 200;

async function verificationQueue({ scope, allowedStages, limit = LIMIT_DEFAULT, offset = 0, now = new Date() }) {
  const lim = Math.min(Math.max(Number(limit) || LIMIT_DEFAULT, 1), LIMIT_MAX);
  const off = Math.max(Number(offset) || 0, 0);
  const hasVerticalCol = await job.hasClientVerticalIdColumn();
  const { clauses, params } = scopeClauses(scope, allowedStages, hasVerticalCol);
  const scoped = clauses.length ? `AND ${clauses.join(' AND ')}` : '';

  const auditFrom = `FROM tbl_job j
       LEFT JOIN tbl_job_verification v ON v.job_id = j.job_id
       ${JOB_JOINS}
      WHERE j.checkout_date_time >= ? AND j.job_status IN (?) AND v.job_id IS NULL ${scoped}`;
  const auditParams = [auditSince(now), COMPLETED_STATUSES, ...params];
  const [audit] = await pool.query(
    `SELECT ${JOB_COLUMNS} ${auditFrom} ORDER BY j.checkout_date_time, j.job_id LIMIT ? OFFSET ?`,
    [...auditParams, lim, off],
  );
  const [[found]] = await pool.query(`SELECT COUNT(*) AS n ${auditFrom}`, auditParams);

  const [claimRows] = await pool.query(
    `SELECT ${JOB_COLUMNS}, r.id AS report_id, r.kind, r.reason_text, r.proof_image_ids,
            r.visit_charge_awarded, r.reported_on
       FROM (
         SELECT id, job_id FROM tbl_job_tx_report WHERE status = 'open' AND kind IN ('cant_complete', 'cancel')
         UNION SELECT NULL, job_id FROM tbl_job WHERE job_status = 1 AND COALESCE(is_cancelled_by_app, 0) = 1
       ) f
       JOIN tbl_job j ON j.job_id = f.job_id
       LEFT JOIN tbl_job_tx_report r ON r.id = f.id
       ${JOB_JOINS}
      WHERE 1=1 ${scoped}
      ORDER BY COALESCE(r.reported_on, j.cancel_date_time), j.job_id
      LIMIT ?`,
    [...params, CLAIMS_CAP + 1],
  );
  // A job with a claim row appears twice (claim + flag); the claim wins.
  const seen = new Set(claimRows.filter((c) => c.report_id).map((c) => Number(c.job_id)));
  const claims = claimRows
    .filter((c) => c.report_id || !seen.has(Number(c.job_id)))
    .slice(0, CLAIMS_CAP)
    .map((c) => ({
      ...jobHeader(c),
      reportId: c.report_id ? Number(c.report_id) : null,
      kind: c.report_id ? c.kind : 'cancel_request',
      reasonText: c.reason_text || null,
      proofImageIds: c.proof_image_ids ? String(c.proof_image_ids).split(',').map(Number).filter(Boolean) : [],
      visitChargeAwarded: Number(c.visit_charge_awarded) === 1,
      reportedOn: c.reported_on || null,
    }));
  return {
    audit: {
      items: audit.map((r) => ({ ...jobHeader(r), finishedOn: r.checkout_date_time || null })),
      total: Number(found && found.n) || 0,
    },
    claims: { items: claims, total: claims.length, truncated: claimRows.length > CLAIMS_CAP },
  };
}

module.exports = {
  listDesk,
  moneyForJobs,
  startProofForJobs,
  loadReportInScope,
  priceReport,
  returnReport,
  resolveReport,
  settleAdditionalWork,
  verificationQueue,
  scopeClauses,
  IN_FLIGHT_CAP,
  AUDIT_WINDOW_DAYS,
  DOOR_WAIT_MINUTES,
  LIMIT_MAX,
};
