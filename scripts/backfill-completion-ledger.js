#!/usr/bin/env node
'use strict';

/*
 * backfill-completion-ledger — post the ledger for jobs this backend completed
 * without one (2026-09-11). A DRY RUN unless --apply.
 *
 * WHY. Until setStatus learned to post (services/job-ledger.service.js), a job
 * entering Completed through this backend got no tbl_job_transaction row, no
 * technician / EasyFix / client ledger rows and no current_balance move. The
 * new CRM's Complete and row Check-Out did exactly that from go-live
 * (2026-04-17) to 2026-09-10. This finds those jobs and posts what the legacy
 * Check Out would have posted, through the same function the live path uses.
 *
 * SCOPE — the critic's, so nothing legacy ever meant is touched:
 *   job_status IN (3, 5), checkout_date_time >= --since (default go-live),
 *   no tbl_job_transaction row AND no technician ledger row for the job.
 * That leaves out the 233 pre-2024 legacy orphans (checked out before go-live)
 * and the 208 old jobs with a ledger row but no job row. It never writes
 * tbl_job: status, checkout time, paid_by and material_charge stay as they are.
 *
 * AND IT REFUSES WHAT THE LIVE PATH REFUSES. Same unpostableReason (no
 * technician, collected_by not 1-3), plus two only a backfill can meet: a job
 * whose 'status change' log shows it completed out of CANCELLED (the live path
 * refuses those, so posting them here would contradict it), and a job that was
 * cancelled at some point with no log to show how it completed — reported for
 * review rather than posted.
 *
 * Each posted row names the CRM user who completed the job, taken from its
 * 'checkout' log where there is one (the new backend has written those since
 * 2026-08-20); older jobs post as the system, like legacy's own system rows.
 *
 * READ THE DRY RUN BEFORE APPLYING. Postings change live gates at once:
 * credits can lift a technician over the ₹500 COD gate and unlock withdrawals;
 * a debit (collected_by 1, the technician kept the cash) can take one below
 * zero, where the opt-in dormancy rule marks them DORMANT. The dry run prints
 * every technician whose balance would cross 0 or 500.
 *
 * DATES. The job row's insert_date is the job's checkout time, so earnings land
 * in the month the work was done. The three ledgers are dated now, so each
 * running-balance chain stays in date order (their balances are computed now).
 *
 * SAFE TO RE-RUN: the same keys as the live path; a posted job is skipped.
 *
 * USAGE
 *   node scripts/backfill-completion-ledger.js                  dry run since go-live
 *   node scripts/backfill-completion-ledger.js --csv /tmp/plan.csv
 *   node scripts/backfill-completion-ledger.js --job 538579     one job
 *   node scripts/backfill-completion-ledger.js --apply --confirm-db <@@hostname>
 *
 *   --since YYYY-MM-DD   earliest checkout date (default 2026-04-17)
 *   --job N              only this job
 *   --csv PATH           write the per-job plan and per-technician totals
 *   --apply              post; refused unless --confirm-db names the server
 *   --confirm-db NAME    must equal SELECT @@hostname — you say which database
 */

require('dotenv').config();

const fs = require('node:fs');
const ledger = require('../services/job-ledger.service');

const GO_LIVE = '2026-04-17';
const COD_FLOOR = 500;   // candidate-ranking's cash-job balance floor

function parseArgs(argv) {
  const out = { since: GO_LIVE, jobId: null, csv: null, apply: false, confirmDb: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--since') out.since = argv[++i];
    else if (a === '--job') out.jobId = Number(argv[++i]);
    else if (a === '--csv') out.csv = argv[++i];
    else if (a === '--apply') out.apply = true;
    else if (a === '--confirm-db') out.confirmDb = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(out.since))) throw new Error('--since must be YYYY-MM-DD');
  if (out.jobId !== null && !(out.jobId > 0)) throw new Error('--job must be a job id');
  if (out.apply && !out.confirmDb) throw new Error('--apply needs --confirm-db <@@hostname of the database you mean>');
  return out;
}

/*
 * One scan of the technician ledger for its job ids (it has no job_id index),
 * not one per candidate.
 */
async function findCandidates(conn, { since, jobId }) {
  const [rows] = await conn.query(
    `SELECT j.job_id, j.job_status, j.fk_easyfixter_id, j.collected_by, j.fk_client_id,
            j.checkout_date_time, j.cancel_date_time
       FROM tbl_job j
       LEFT JOIN tbl_job_transaction jt ON jt.fk_job_id = j.job_id
       LEFT JOIN (SELECT DISTINCT job_id FROM tbl_easyfixer_transaction WHERE job_id > 0) e ON e.job_id = j.job_id
      WHERE j.job_status IN (3, 5)
        AND j.checkout_date_time >= ?
        AND jt.fk_job_id IS NULL
        AND e.job_id IS NULL
        ${jobId ? 'AND j.job_id = ?' : ''}
      ORDER BY j.checkout_date_time, j.job_id`,
    jobId ? [since, jobId] : [since],
  );
  return rows;
}

const signedEfr = (moves) => (moves.efr.type === ledger.DEBIT ? -moves.efr.amount : moves.efr.amount);

/*
 * Two batched log reads for the whole candidate set (tbl_job_logs is indexed by
 * job_id; tbl_easyfixer_transaction is not, which is why plan() does NOT re-ask
 * whether a job is posted — findCandidates already excluded posted jobs with one
 * scan, and the post itself re-checks under the job's lock):
 *   - how the job entered 3/5, because the live path refuses to post a
 *     completion out of CANCELLED and so must this;
 *   - which CRM user completed it ('checkout' changed_by), so the backfilled
 *     rows name them as legacy does instead of posting as the system.
 */
async function annotate(conn, candidates) {
  const byId = new Map(candidates.map((c) => [Number(c.job_id), { ...c, fromCancelled: false, completedBy: null, sawStatusLog: false }]));
  const ids = [...byId.keys()];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const [moves] = await conn.query(
      `SELECT job_id, MAX(old_data = 'Status: 6') AS from_cancelled
         FROM tbl_job_logs
        WHERE log_for = 'status change' AND new_data IN ('Status: 3', 'Status: 5') AND job_id IN (?)
        GROUP BY job_id`, [chunk],
    );
    for (const m of moves) {
      const c = byId.get(Number(m.job_id));
      if (c) { c.sawStatusLog = true; c.fromCancelled = Number(m.from_cancelled) === 1; }
    }
    const [actors] = await conn.query(
      `SELECT job_id, MAX(changed_by) AS changed_by
         FROM tbl_job_logs WHERE log_for = 'checkout' AND job_id IN (?) GROUP BY job_id`, [chunk],
    );
    for (const a of actors) {
      const c = byId.get(Number(a.job_id));
      if (c && Number(a.changed_by) > 0) c.completedBy = Number(a.changed_by);
    }
  }
  return [...byId.values()];
}

/** The plan: what each job would post, and each technician's balance before and after. */
async function plan(conn, candidates) {
  const jobs = [];
  for (const c of await annotate(conn, candidates)) {
    // The live path's own test, plus the two the backfill alone can make:
    // a completion out of CANCELLED, and one whose path no log can show.
    let reason = ledger.unpostableReason(c);
    if (!reason && c.fromCancelled) reason = 'completed out of CANCELLED';
    if (!reason && c.cancel_date_time && !c.sawStatusLog) reason = 'was cancelled once and no log shows how it completed — review by hand';
    const amounts = await ledger.computeCompletionAmounts(conn, c.job_id);
    const moves = reason ? null : ledger.ledgerMoves(c.collected_by, amounts);
    jobs.push({ ...c, postable: !reason, reason, amounts, moves, efrDelta: moves ? signedEfr(moves) : 0 });
  }
  const byTech = new Map();
  for (const j of jobs.filter((x) => x.postable)) {
    const t = byTech.get(j.fk_easyfixter_id) || { efr_id: j.fk_easyfixter_id, jobs: 0, delta: 0 };
    t.jobs += 1; t.delta = Math.round((t.delta + j.efrDelta) * 100) / 100;
    byTech.set(j.fk_easyfixter_id, t);
  }
  for (const t of byTech.values()) {
    const [[tail]] = await conn.query(
      'SELECT balance FROM tbl_easyfixer_transaction WHERE easyfixer_id = ? ORDER BY transaction_id DESC LIMIT 1', [t.efr_id],
    );
    t.before = Number(tail && tail.balance) || 0;
    t.after = Math.round((t.before + t.delta) * 100) / 100;
    t.crosses = [
      t.before >= 0 && t.after < 0 ? 'goes below 0' : null,
      t.before < 0 && t.after >= 0 ? 'back above 0' : null,
      t.before < COD_FLOOR && t.after >= COD_FLOOR ? `reaches ₹${COD_FLOOR} (COD gate)` : null,
      t.before >= COD_FLOOR && t.after < COD_FLOOR ? `drops under ₹${COD_FLOOR} (COD gate)` : null,
    ].filter(Boolean);
  }
  return { jobs, techs: [...byTech.values()].sort((a, b) => a.delta - b.delta) };
}

function report({ jobs, techs }) {
  const postable = jobs.filter((j) => j.postable);
  const reasons = {};
  for (const j of jobs.filter((x) => !x.postable)) reasons[j.reason] = (reasons[j.reason] || 0) + 1;
  const sum = (k) => Math.round(postable.reduce((s, j) => s + j.amounts[k], 0) * 100) / 100;
  console.log(`candidates: ${jobs.length} · postable: ${postable.length} · not postable: ${jobs.length - postable.length}`);
  for (const [r, n] of Object.entries(reasons)) console.log(`  not postable — ${r}: ${n}`);
  console.log(`totals if posted: technician ${sum('efr')} · EasyFix ${sum('ef')} · client ${sum('client')}`);
  console.log(`technicians affected: ${techs.length}`);
  for (const t of techs.filter((x) => x.crosses.length)) {
    console.log(`  efr ${t.efr_id}: ${t.before} → ${t.after} (${t.jobs} jobs) — ${t.crosses.join(', ')}`);
  }
}

function writeCsv(path, { jobs, techs }) {
  const q = (v) => (v === null || v === undefined ? '' : `"${String(v).replace(/"/g, '""')}"`);
  const lines = ['kind,job_id,checkout_date_time,efr_id,collected_by,efr,ef,client,efr_delta,postable,reason'];
  for (const j of jobs) {
    lines.push(['job', j.job_id, j.checkout_date_time, j.fk_easyfixter_id, j.collected_by,
      j.amounts && j.amounts.efr, j.amounts && j.amounts.ef, j.amounts && j.amounts.client,
      j.efrDelta, j.postable ? 1 : 0, j.reason].map(q).join(','));
  }
  lines.push('kind,efr_id,jobs,before,delta,after,crosses');
  for (const t of techs) lines.push(['technician', t.efr_id, t.jobs, t.before, t.delta, t.after, t.crosses.join('; ')].map(q).join(','));
  fs.writeFileSync(path, lines.join('\n') + '\n');
}

/** Post each postable job in its own transaction. Returns the tally. */
async function apply(db, jobs) {
  const tally = { posted: 0, skipped: 0, failed: 0 };
  for (const j of jobs.filter((x) => x.postable)) {
    try {
      // The live path's wrapper: bounded lock waits, one retry, the named lock
      // released after the commit, the connection destroyed if it cannot be.
      const r = await ledger.inLedgerTransaction((conn) => ledger.postCompletionLedger(conn, {
        jobId: j.job_id,
        crmUserId: j.completedBy,            // the CRM user who completed it, where a log says so
        at: new Date(),
        jobTransactionAt: j.checkout_date_time,
      }), { db });
      if (r.ledgers || r.jobTransaction) tally.posted += 1; else tally.skipped += 1;
    } catch (e) {
      tally.failed += 1;
      console.error(`job ${j.job_id}: ${e.message}`);
    }
  }
  return tally;
}

async function main(argv) {
  const args = parseArgs(argv);
  const { pool } = require('../db');
  const [[h]] = await pool.query('SELECT @@hostname AS host, DATABASE() AS db');
  console.log(`database: ${h.host} / ${h.db} · since ${args.since}${args.jobId ? ` · job ${args.jobId}` : ''} · ${args.apply ? 'APPLY' : 'dry run'}`);
  if (args.apply && args.confirmDb !== h.host) {
    throw new Error(`--confirm-db ${args.confirmDb} does not match this server (${h.host}); nothing was written`);
  }
  const candidates = await findCandidates(pool, args);
  const p = await plan(pool, candidates);
  report(p);
  if (args.csv) { writeCsv(args.csv, p); console.log(`plan written to ${args.csv}`); }
  if (args.apply) {
    const t = await apply(pool, p.jobs);
    console.log(`applied: posted ${t.posted} · already posted ${t.skipped} · failed ${t.failed}`);
    if (t.failed) process.exitCode = 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => require('../db').pool.end().catch(() => {}));
}

module.exports = { parseArgs, findCandidates, annotate, plan, apply, main, GO_LIVE };
