'use strict';
/*
 * THE COMPLETION LEDGER (2026-09-11).
 *
 * WHAT WAS MISSING. A job entering Completed (3 / 5) through this backend posted
 * nothing: no tbl_job_transaction row, no technician / EasyFix / client ledger
 * rows, no tbl_easyfixer.current_balance move. Legacy posts all of them at the
 * CRM Check Out, through sp_ef_checkout_job_and_update_transaction. The new
 * CRM's Complete and row Check-Out sent 3 from 2026-04-18 to 2026-09-10, so
 * every job it completed has none of them. current_balance is what the COD gate,
 * withdrawals and the dormancy rule read; tbl_job_transaction is what the
 * technician app's earnings read.
 *
 * WHAT THIS POSTS: what that Check Out posts, from the same inputs, under the
 * SP's own idempotency keys, so either stack may complete a job and neither can
 * post it twice.
 *   amounts  EasyFix_CRM@515f582f5 JobServiceImpl.saveCheckOutJob :1908-2045.
 *            Each active service line is re-split PER UNIT by the legacy
 *            rate-card formula (legacyRateCardShares) on its price net of
 *            service tax, times quantity. Then job_material: the technician
 *            gets tx_charge, EasyFix client_charge − tx_charge, Penalty
 *            negative. The client amount is services only.
 *   signs    the SP's collected_by table (SIGN_TABLE).
 *   keys     tbl_job_transaction only if the job has none (UNIQUE fk_job_id);
 *            the three ledgers + current_balance only if the technician
 *            ledger has no row for the job (SP lines 63 and 113).
 *
 * WHY RE-SPLIT rather than sum the stored shares. tbl_job_services keeps the
 * shares PER UNIT on lines legacy wrote and PER LINE (× quantity) on lines this
 * backend wrote (utils/rate-card-calc.js), so the column means two things. QA:
 * 4,998 of 5,015 legacy lines with quantity > 1 are per-unit; 8 of 9 non-zero
 * new-backend lines are per-line. Legacy re-splits at checkout too, so this
 * makes the line's writer irrelevant.
 *
 * WHAT IT DELIBERATELY DOES NOT COPY FROM THE SP:
 *   - its tbl_job UPDATE (status 3, checkout time, owner, paid_by,
 *     material_charge). setStatus owns the transition, and those paid_by /
 *     material_charge writes are why every legacy-closed job has both at 0;
 *   - its unlocked read-then-write of the running balances, which loses about
 *     1 EasyFix row in 580 under legacy traffic. Here the technician row is
 *     locked FOR UPDATE and the global EasyFix / per-client tails are read
 *     under one named lock, always in that order;
 *   - its fall-through when collected_by is not 1-3, which writes zero
 *     balances. Here nothing is posted and the caller is told why;
 *   - saveCheckOutJob's running-total bug for Travel / Incentive / Penalty,
 *     which adds the CUMULATIVE total per row, so a second row double-counts.
 *     Each row counts once, which reproduces 13,121 of 13,125 legacy rows.
 */
const { pool } = require('../db');
const logger = require('../logger');
const { ACTIVE_SERVICES_SQL } = require('./job-line-total');
const { SOURCE } = require('./ledger-source');

const SOURCE_SYSTEM = SOURCE.SYSTEM;   // tbl_*_transaction.source: 1 = from system (what the SP is passed)
const DEBIT = 1;
const CREDIT = 2;
const CANCELLED = 6;
const LEDGER_LOCK = 'easyfix:completion-ledger';
const LEDGER_LOCK_TIMEOUT_S = 10;
// Row-lock waits inside a post are bounded BELOW the named-lock timeout: a post
// stuck on one technician's row would otherwise hold the named lock for
// innodb_lock_wait_timeout (50 s on QA) while every other completion 409s.
const ROW_LOCK_WAIT_S = 5;
const RETRYABLE_ERRNO = new Set([1213 /* ER_LOCK_DEADLOCK */, 1205 /* ER_LOCK_WAIT_TIMEOUT */]);
const MIN_FEE_PARAM_ID = 6;       // tbl_easyfixer_rating_parameters_weightage: minimum_easyfixer_fee

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => Number(v) || 0;

/*
 * EasyFix_CRM@515f582f5 util/scheduling/RateCardCalculationsImpl.java, line for
 * line. Proven against that class, compiled unmodified, on every distinct fee
 * combination in tbl_client_service plus the clamp boundaries
 * (tests/fixtures/legacy-rate-card-golden.json). It is NOT
 * utils/rate-card-calc.js: that cascade takes the client share out of the
 * technician's residual, where this one takes it out of EasyFix's, and it has no
 * minimum-fee floor. The two agree only while the client share is 0 and nothing
 * clamps.
 */
function legacyRateCardShares(amount, rc, minFee) {
  const a = num(amount);
  const efVar = num(rc.easyfix_direct_variable) / 100;
  const ohVar = num(rc.overhead_variable) / 100;
  const clVar = num(rc.client_variable) / 100;
  const min = num(minFee);
  const efConvFee = efVar * a + num(rc.easyfix_direct_fixed);
  const factor1 = efConvFee <= a - min ? efConvFee : a - min;
  const f2 = (a - factor1) * ohVar + num(rc.overhead_fixed);
  const f3 = a - factor1 - min;
  const overhead = f2 <= f3 ? f2 : f3;
  const client = (a - efConvFee) * clVar + num(rc.client_fixed);
  const efRaw = overhead - client + factor1;
  const easyfix = efRaw > 0 ? efRaw : 0;
  return { client, easyfix, easyfixer: a - easyfix - client };
}

/*
 * The SP's sign table (lines 72-111), keyed by tbl_job.collected_by. The SP
 * reads collected_by from tbl_job and ignores the value it is passed; so does
 * this. Anything but 1-3 returns null: the SP would post type 0 / amount 0 and
 * reset every balance to 0.
 */
const SIGN_TABLE = {
  1: ({ efr, ef, client }) => ({    // technician collected: owes EasyFix + client shares
    efr: { type: DEBIT, amount: round2(ef + client) },
    ef: { type: CREDIT, amount: ef },
    client: { type: CREDIT, amount: client },
  }),
  2: ({ efr, ef, client }) => ({    // EasyFix collected: everyone is credited
    efr: { type: CREDIT, amount: efr },
    ef: { type: CREDIT, amount: ef },
    client: { type: CREDIT, amount: client },
  }),
  3: ({ efr, ef }) => ({            // client collected: owes technician + EasyFix
    efr: { type: CREDIT, amount: efr },
    ef: { type: CREDIT, amount: ef },
    client: { type: DEBIT, amount: round2(efr + ef) },
  }),
};

function ledgerMoves(collectedBy, amounts) {
  const plan = SIGN_TABLE[Number(collectedBy)];
  return plan ? plan(amounts) : null;
}

const signed = (move) => (move.type === DEBIT ? -move.amount : move.amount);

async function loadLedgerConfig(conn) {
  // Both exactly as legacy reads them: JobDaoImpl.getServiceTaxRate() and
  // getParamList() → param 6. 0 and 0 on QA.
  const [[tax]] = await conn.query('SELECT SUM(rate) AS rate FROM tbl_tax_rate WHERE status = 1');
  const [[fee]] = await conn.query(
    'SELECT param_weightage FROM tbl_easyfixer_rating_parameters_weightage WHERE param_id = ?', [MIN_FEE_PARAM_ID],
  );
  return { serviceTaxRate: num(tax && tax.rate), minEasyfixerFee: num(fee && fee.param_weightage) };
}

/**
 * What a completion of this job posts, before any sign is applied.
 * Read-only; `conn` may be the pool or a transaction's connection.
 */
async function computeCompletionAmounts(conn, jobId) {
  const { serviceTaxRate, minEasyfixerFee } = await loadLedgerConfig(conn);
  const [lines] = await conn.query(
    `SELECT js.job_service_id, js.service_id, js.total_charge, js.quantity,
            cs.client_service_id, cs.client_fixed, cs.client_variable,
            cs.easyfix_direct_fixed, cs.easyfix_direct_variable,
            cs.overhead_fixed, cs.overhead_variable
       FROM tbl_job_services js
       LEFT JOIN tbl_client_service cs ON cs.client_service_id = js.service_id
      WHERE js.job_id = ? AND ${ACTIVE_SERVICES_SQL('js')}
      ORDER BY js.job_service_id`,
    [jobId],
  );
  let efr = 0; let ef = 0; let client = 0; let tax = 0;
  const priced = []; const unpriced = [];
  for (const l of lines) {
    // No rate card: legacy's lookup throws, the catch swallows it, and the line
    // adds nothing — not even its tax. Same here, and it is reported.
    if (l.client_service_id == null) { unpriced.push(l.job_service_id); continue; }
    const price = num(l.total_charge);
    const lineTax = price * serviceTaxRate / 100;
    const s = legacyRateCardShares(price - lineTax, l, minEasyfixerFee);
    const qty = num(l.quantity);
    efr += s.easyfixer * qty; ef += s.easyfix * qty; client += s.client * qty; tax += lineTax;
    priced.push({ job_service_id: l.job_service_id, price, quantity: qty,
      easyfixer: round2(s.easyfixer), easyfix: round2(s.easyfix), client: round2(s.client) });
  }
  const [materials] = await conn.query('SELECT type, tx_charge, client_charge FROM job_material WHERE job_id = ?', [jobId]);
  let tx = 0; let cx = 0;
  for (const m of materials) {
    const t = String(m.type || '').toLowerCase();
    const sign = t === 'penalty' ? -1 : (['material', 'travel', 'incentive'].includes(t) ? 1 : 0);
    tx += sign * num(m.tx_charge); cx += sign * num(m.client_charge);
  }
  return {
    efr: round2(efr + tx), ef: round2(ef + (cx - tx)), client: round2(client), tax: round2(tax),
    lines: priced, unpriced, materialRows: materials.length,
    config: { serviceTaxRate, minEasyfixerFee },
  };
}

/*
 * Why a job cannot be posted, or null. Checked BEFORE any write, so an
 * unpostable completion changes no balance at all.
 */
function unpostableReason(job) {
  if (!job) return 'job not found';
  if (Number(job.job_status) === CANCELLED) return 'job is cancelled';
  if (!num(job.fk_easyfixter_id)) return 'no technician assigned';
  if (!SIGN_TABLE[Number(job.collected_by)]) return 'collected_by is not set (1 Paid By Customer / 2 Free For Customer / 3 Client)';
  return null;
}

/**
 * Post a completion INSIDE the caller's transaction on `conn`.
 *
 * The caller must commit or roll back, THEN call releaseLedgerLock(conn): the
 * named lock has to outlive the commit, or another writer could read the tail
 * before these rows are visible.
 *
 * @param {object} p
 * @param {number} p.jobId
 * @param {number} [p.fromStatus]  status the job was in before this transition
 * @param {number|null} p.crmUserId  a tbl_user id or null (FK on created_by)
 * @param {Date} [p.at]            event instant (IST via the pool timezone)
 * @param {Date} [p.jobTransactionAt]  the job row's insert_date; defaults to `at`.
 *   The backfill passes the job's checkout time here (earnings group by it)
 *   while the ledgers keep `at` = now, so their running-balance chains stay
 *   in date order.
 * @returns {Promise<{posted: boolean, jobTransaction: boolean, ledgers: boolean, reason?: string,
 *   unpostable?: true, amounts?: object}>}  unpostable: nothing CAN be posted
 *   (see unpostableReason); without it, a false `ledgers` means already posted.
 */
async function postCompletionLedger(conn, { jobId, fromStatus, crmUserId = null, at = new Date(), jobTransactionAt = at }) {
  const [[job]] = await conn.query(
    `SELECT job_id, job_status, fk_easyfixter_id, collected_by, fk_client_id
       FROM tbl_job WHERE job_id = ? FOR UPDATE`,
    [jobId],
  );
  // A job completed straight out of CANCELLED posts nothing: legacy's Check Out
  // accepted only 10 or 2, and 2,059 cancelled jobs carry zero-amount ledger
  // tombstones from delete_job_data.
  const reason = unpostableReason(job && fromStatus != null ? { ...job, job_status: fromStatus } : job);
  if (reason) return { posted: false, jobTransaction: false, ledgers: false, reason, unpostable: true };

  const efrId = Number(job.fk_easyfixter_id);
  const amounts = await computeCompletionAmounts(conn, jobId);
  const moves = ledgerMoves(job.collected_by, amounts);
  const createdBy = num(crmUserId) > 0 ? Number(crmUserId) : null;

  /*
   * The two existence checks are PLAIN reads, and that is safe: both checkout
   * SPs UPDATE tbl_job before they insert anything, and this transaction holds
   * that row's lock (setStatus's UPDATE, or the FOR UPDATE above). So nothing
   * can post THIS job between the snapshot and the commit. A locking read here
   * would be worse, not safer: FOR UPDATE on an absent fk_job_id gap-locks the
   * end of the unique index, where every new job's row lands, and two
   * completions of DIFFERENT jobs then deadlock on their inserts.
   */
  let jobTransaction = false;
  const [jt] = await conn.query('SELECT 1 FROM tbl_job_transaction WHERE fk_job_id = ? LIMIT 1', [jobId]);
  if (jt.length === 0) {
    const total = round2(amounts.efr + amounts.ef + amounts.client);
    try {
      await conn.query(
        `INSERT INTO tbl_job_transaction
           (fk_job_id, total_charge, ef_charge, efr_charge, client_charge, collected_by,
            insert_date, updated_by, tax, total_charge_and_tax)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [jobId, total, amounts.ef, amounts.efr, amounts.client, Number(job.collected_by),
          jobTransactionAt, createdBy, amounts.tax, round2(total + amounts.tax)],
      );
      jobTransaction = true;
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY') throw e;   // unique_job_id: someone posted it first
    }
  }

  // The technician ledger decides, exactly as the SP's second guard does.
  const [already] = await conn.query('SELECT 1 FROM tbl_easyfixer_transaction WHERE job_id = ? LIMIT 1', [jobId]);
  if (already.length > 0) {
    return { posted: jobTransaction, jobTransaction, ledgers: false, reason: 'technician ledger already has this job', amounts };
  }

  /*
   * LOCK ORDER — this job's row (held), the named lock, the TECHNICIAN ROW,
   * then the three ledger tails (technician, EasyFix, client).
   *
   * Technician row before the tails, because every other writer of this
   * technician's balance takes it first: withdrawal pay, admin recharge and NDM
   * approval lock it FOR UPDATE and then insert a ledger row, and a legacy
   * Check Out's ledger INSERT takes it in share mode for its foreign key. With
   * the row last, the post would hold the tail gap those inserts need while
   * waiting for the row they hold — a cycle. First, they all queue on the row.
   * (The one interleaving left — a legacy SP that already holds the row in
   * share mode and then upgrades it — InnoDB detects; inLedgerTransaction
   * retries once.)
   *
   * The tails are LOCKING reads for a reason. A plain read answers from the
   * snapshot this transaction took at its first plain read — before the named
   * lock was held — so it could miss a row another writer committed in
   * between: the very lost update this service exists to stop. The named lock
   * keeps two of OUR writers from holding a tail gap at once (gap locks are
   * compatible, so without it both would read one tail and both would insert).
   * Writers that read a tail WITHOUT locking — the legacy SPs — can still race
   * each other and us; that is theirs to fix, not something Node can prevent.
   */
  const [[lock]] = await conn.query('SELECT GET_LOCK(?, ?) AS got', [LEDGER_LOCK, LEDGER_LOCK_TIMEOUT_S]);
  if (Number(lock && lock.got) !== 1) throw ledgerBusy();
  await conn.query('SELECT efr_id FROM tbl_easyfixer WHERE efr_id = ? FOR UPDATE', [efrId]);

  const tail = async (sql, params) => { const [[r]] = await conn.query(sql, params); return num(r && r.balance); };
  const efrBal = round2(await tail('SELECT balance FROM tbl_easyfixer_transaction WHERE easyfixer_id = ? ORDER BY transaction_id DESC LIMIT 1 FOR UPDATE', [efrId]) + signed(moves.efr));
  const efBal = round2(await tail('SELECT balance FROM tbl_easyfix_transaction ORDER BY trans_id DESC LIMIT 1 FOR UPDATE', []) + signed(moves.ef));
  const clBal = round2(await tail('SELECT balance FROM tbl_client_transaction WHERE client_id = ? ORDER BY client_trans_id DESC LIMIT 1 FOR UPDATE', [job.fk_client_id]) + signed(moves.client));

  const desc = `Job Id : ${jobId}`;
  await conn.query(
    `INSERT INTO tbl_easyfixer_transaction
       (easyfixer_id, source, description, transaction_type, transaction_date, amount, balance, created_by, job_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [efrId, SOURCE_SYSTEM, desc, moves.efr.type, at, moves.efr.amount, efrBal, createdBy, jobId],
  );
  await conn.query(
    `INSERT INTO tbl_easyfix_transaction
       (source, description, transaction_type, transaction_date, amount, balance, created_by, job_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [SOURCE_SYSTEM, desc, moves.ef.type, at, moves.ef.amount, efBal, createdBy, jobId],
  );
  await conn.query(
    `INSERT INTO tbl_client_transaction
       (client_id, source, description, transaction_type, transaction_date, amount, balance, created_by, job_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [job.fk_client_id, SOURCE_SYSTEM, desc, moves.client.type, at, moves.client.amount, clBal, createdBy, jobId],
  );
  // current_balance is a cache of the ledger tail (3,926 of 3,927 technicians on
  // QA); balance_updated is stamped with it, as the SP does (the CRM shows it).
  await conn.query('UPDATE tbl_easyfixer SET current_balance = ?, balance_updated = ? WHERE efr_id = ?', [efrBal, at, efrId]);

  logger.info('Completion ledger posted · jobId=' + jobId + ' · efr=' + efrId + ' · collected_by=' + job.collected_by
    + ' · efr ' + (moves.efr.type === DEBIT ? '-' : '+') + moves.efr.amount + ' → ' + efrBal);
  return { posted: true, jobTransaction, ledgers: true, amounts, moves, balances: { efr: efrBal, ef: efBal, client: clBal } };
}

function ledgerBusy() {
  const err = new Error('The ledger is busy — try completing the job again in a moment.');
  err.status = 409; err.code = 'LEDGER_BUSY';
  return err;
}

/**
 * Safe to call whether or not the lock is held. Never throws. Returns false
 * when the release itself failed: that connection may still hold the lock, and
 * GET_LOCK is re-entrant per session, so it must be destroyed, never pooled.
 */
async function releaseLedgerLock(conn) {
  try { await conn.query('SELECT RELEASE_LOCK(?)', [LEDGER_LOCK]); return true; } catch (e) {
    logger.warn('Completion ledger lock release failed · ' + e.message);
    return false;
  }
}

/**
 * Run `fn(conn)` in one transaction on a dedicated connection, the way every
 * ledger post must: row-lock waits bounded below the named-lock timeout, one
 * retry on a deadlock or lock-wait timeout (then LEDGER_BUSY), the named lock
 * released AFTER commit / rollback, the session restored before the connection
 * goes back to the pool (mysql2 does not reset it), and a connection that could
 * not be cleaned up destroyed rather than reused.
 */
async function inLedgerTransaction(fn, { db = pool, attempts = 2 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const conn = await db.getConnection();
    let healthy = true;
    try {
      /*
       * Bound the row-lock wait ONLY when the old value can be read back, so
       * the connection is never returned to the pool with a session this code
       * could not restore (mysql2 does not reset one on release).
       */
      const [[waitRow]] = await conn.query('SELECT @@SESSION.innodb_lock_wait_timeout AS wait');
      const previousWait = waitRow && waitRow.wait != null ? Number(waitRow.wait) : null;
      if (previousWait != null) await conn.query('SET SESSION innodb_lock_wait_timeout = ?', [ROW_LOCK_WAIT_S]);
      try {
        await conn.beginTransaction();
        const out = await fn(conn);
        await conn.commit();
        return out;
      } catch (e) {
        try { await conn.rollback(); } catch (rbErr) {
          healthy = false;
          logger.warn('Ledger rollback failed · ' + rbErr.message);
        }
        if (!RETRYABLE_ERRNO.has(e.errno)) throw e;
        if (attempt >= attempts) { logger.warn('Ledger post gave up · ' + e.message); throw ledgerBusy(); }
        logger.warn('Ledger post retrying · ' + e.message);   // falls through to the next attempt
      } finally {
        healthy = (await releaseLedgerLock(conn)) && healthy;
        if (previousWait != null) {
          try { await conn.query('SET SESSION innodb_lock_wait_timeout = ?', [previousWait]); } catch (_) { healthy = false; }
        }
      }
    } finally {
      if (healthy) conn.release(); else conn.destroy();
    }
  }
}

function badLedgerType(type) {
  const err = new Error('ledger transaction_type must be 1 (debit) or 2 (credit), got ' + type);
  err.status = 400; err.code = 'LEDGER_BAD_TYPE';
  return err;
}

/**
 * Take THE ledger lock — the one every Node writer of these tails must hold.
 *
 * Two writers under two different lock names are not serialised at all: they
 * read one tail and both append from it, and the chain forks permanently. That
 * is what finance.js's own `client_ledger_<id>` lock did against this service's
 * lock, so both are now this one name.
 *
 * Call it INSIDE inLedgerTransaction — which releases it after commit/rollback
 * and destroys the connection if the release fails, because GET_LOCK is
 * re-entrant per session and a leaked lock would travel to the next borrower —
 * and AFTER any domain row the caller locks first (the recharge row, the
 * withdrawal request, the job), which is the order postCompletionLedger uses.
 */
async function acquireLedgerLock(conn) {
  const [[lock]] = await conn.query('SELECT GET_LOCK(?, ?) AS got', [LEDGER_LOCK, LEDGER_LOCK_TIMEOUT_S]);
  if (Number(lock && lock.got) !== 1) throw ledgerBusy();
}

/**
 * Append ONE row to a technician's ledger and re-point the cache at it.
 *
 * `tbl_easyfixer.current_balance` is a CACHE of the ledger tail, nothing more
 * (3,926 of 3,927 technicians on QA). So the balance is derived from the tail —
 * read FOR UPDATE, never from the cache — and the cache is then set to it
 * ABSOLUTELY. A relative `current_balance = current_balance - ?` looks
 * equivalent and is not: it preserves whatever drift the cache already carried,
 * and an increment with no ledger row (what NDM approval used to do) is erased
 * by the next writer that recomputes the cache from the tail.
 *
 * `amount` is always the positive MAGNITUDE; the sign lives in `type`, exactly
 * as legacy stores it (0 negative amounts in 330,844 QA client rows).
 * Returns null when the technician row does not exist, so the caller can refuse
 * rather than credit an orphan.
 */
async function appendTechnicianLedgerEntry(conn, {
  efrId, type, amount, description, source = SOURCE.SYSTEM, createdBy = null, jobId = 0, at = new Date(),
}) {
  if (type !== DEBIT && type !== CREDIT) throw badLedgerType(type);
  const [[tech]] = await conn.query('SELECT efr_id FROM tbl_easyfixer WHERE efr_id = ? FOR UPDATE', [efrId]);
  if (!tech) return null;
  const [[tailRow]] = await conn.query(
    'SELECT balance FROM tbl_easyfixer_transaction WHERE easyfixer_id = ? ORDER BY transaction_id DESC LIMIT 1 FOR UPDATE',
    [efrId],
  );
  const amt = round2(amount);
  const balance = round2(num(tailRow && tailRow.balance) + signed({ type, amount: amt }));
  const [ins] = await conn.query(
    `INSERT INTO tbl_easyfixer_transaction
       (easyfixer_id, source, description, transaction_type, transaction_date, amount, balance, created_date, created_by, job_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [efrId, source, description || null, type, at, amt, balance, at, createdBy, jobId],
  );
  await conn.query('UPDATE tbl_easyfixer SET current_balance = ?, balance_updated = ? WHERE efr_id = ?', [balance, at, efrId]);
  return { transactionId: ins.insertId, balance };
}

/** The client-side twin of appendTechnicianLedgerEntry. No cache column exists here. */
async function appendClientLedgerEntry(conn, {
  clientId, type, amount, description, source = SOURCE.SYSTEM, createdBy = null, jobId = null, at = new Date(),
}) {
  if (type !== DEBIT && type !== CREDIT) throw badLedgerType(type);
  const [[tailRow]] = await conn.query(
    'SELECT balance FROM tbl_client_transaction WHERE client_id = ? ORDER BY client_trans_id DESC LIMIT 1 FOR UPDATE',
    [clientId],
  );
  const amt = round2(amount);
  const balance = round2(num(tailRow && tailRow.balance) + signed({ type, amount: amt }));
  const [ins] = await conn.query(
    `INSERT INTO tbl_client_transaction
       (client_id, job_id, source, transaction_type, amount, balance, description, transaction_date, created_date, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [clientId, jobId, source, type, amt, balance, description || null, at, at, createdBy],
  );
  return { transactionId: ins.insertId, balance };
}

/**
 * What completing this job would post, and whether it can — for the CRM's
 * Complete Audit dialog and the backfill dry run. Writes nothing.
 */
async function previewCompletionLedger(jobId, conn = pool) {
  const [[job]] = await conn.query(
    'SELECT job_id, job_status, fk_easyfixter_id, collected_by, fk_client_id FROM tbl_job WHERE job_id = ?', [jobId],
  );
  const reason = unpostableReason(job);
  const [[jt]] = await conn.query('SELECT COUNT(*) AS n FROM tbl_job_transaction WHERE fk_job_id = ?', [jobId]);
  const [[led]] = await conn.query('SELECT COUNT(*) AS n FROM tbl_easyfixer_transaction WHERE job_id = ?', [jobId]);
  const amounts = job ? await computeCompletionAmounts(conn, jobId) : null;
  return {
    job_id: Number(jobId),
    postable: !reason,
    reason,
    collected_by: job ? job.collected_by : null,
    already: { job_transaction: Number(jt.n) > 0, technician_ledger: Number(led.n) > 0 },
    amounts,
    moves: amounts && !reason ? ledgerMoves(job.collected_by, amounts) : null,
  };
}

module.exports = {
  legacyRateCardShares,
  ledgerMoves,
  computeCompletionAmounts,
  postCompletionLedger,
  releaseLedgerLock,
  inLedgerTransaction,
  acquireLedgerLock,
  appendTechnicianLedgerEntry,
  appendClientLedgerEntry,
  ledgerBusy,
  previewCompletionLedger,
  unpostableReason,
  LEDGER_LOCK,
  SOURCE,
  DEBIT,
  CREDIT,
};
