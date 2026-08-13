const logger = require('../logger');

/*
 * withdrawal.service — backing logic for POST /api/mobile/withdraw
 * (routes/mobile/profile-extra.js).
 *
 * MVP payout model (FINANCE-IN-THE-LOOP): a technician asks to withdraw their
 * wallet balance (tbl_easyfixer.current_balance) to the bank on file. We ONLY
 * RECORD the request here — an INSERT into tbl_easyfixer_withdrawal_request with
 * status='requested'. We DELIBERATELY DO NOT touch current_balance: the actual
 * money movement (payout to the bank) and the corresponding wallet debit are a
 * downstream FINANCE/OPS step, done when the payout is settled. Recording the
 * intent without debiting keeps the request auditable and avoids draining a
 * balance before the money has actually left.
 *
 * Every call is scoped to ONE technician — callers pass `efrId` resolved from
 * req.tech.efr_id (never a body id). Errors throw { status, code, message } so
 * the central error-handler surfaces the status + plain-language message that
 * the mobile app shows verbatim (see middleware/error-handler.js).
 */

// A withdrawal finance hasn't settled yet — blocks a second concurrent request.
// The flow is requested → paid/rejected (no interim 'processing' state).
const OPEN_STATUSES = ['requested'];

function mkErr(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

/*
 * Record a payout request against the technician's wallet.
 *
 * @param efrId  technician id (req.tech.efr_id)
 * @param body   { amount } — INR to withdraw (Joi-validated positive at route)
 * @param pool   mysql2 pool (passed in — matches the callers' pattern)
 * @returns { requestId, amount, status: 'requested' }
 */
async function requestWithdrawal(efrId, { amount }, pool) {
  logger.info('Withdrawal request · efrId=' + efrId + ' amount=' + amount);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // The technician PK is the per-account mutex. Every request locks it before
    // checking the open queue, so two devices/replicas with different
    // Idempotency-Keys cannot both observe "no pending request" and insert.
    const [[tech]] = await conn.query(
      `SELECT current_balance, lifecycle_status
         FROM tbl_easyfixer
        WHERE efr_id = ? AND NOT (efr_status <=> 3)
        LIMIT 1 FOR UPDATE`,
      [efrId],
    );
    if (!tech) throw mkErr(404, 'TECH_NOT_FOUND', 'Technician not found');
    const currentBalance = Number(tech.current_balance ?? 0);

    const [[bank]] = await conn.query(
      `SELECT d.efr_bank_id, d.efr_bank_acc_num, d.efr_bank_acc_name,
              d.efr_bank_ifsc, d.bank AS bank_id, n.bank_name
         FROM tbl_easyfixer_bank_details d
         LEFT JOIN bank_name n ON n.id = d.bank
        WHERE d.efr_Id = ?
          AND NULLIF(TRIM(d.efr_bank_acc_num), '') IS NOT NULL
          AND NULLIF(TRIM(d.efr_bank_ifsc), '') IS NOT NULL
          AND NULLIF(TRIM(d.efr_bank_acc_name), '') IS NOT NULL
        LIMIT 1`,
      [efrId],
    );
    if (!bank) throw mkErr(400, 'NO_BANK_ON_FILE', 'Add bank details before withdrawing');

    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > currentBalance) {
      throw mkErr(400, 'INVALID_AMOUNT', 'Enter a valid amount within your available balance');
    }
    // A blacklisted technician has one terminal settlement action: withdraw
    // the entire authoritative wallet to the existing account. Compare in
    // paise so floating-point representation cannot reject equal INR values.
    if (String(tech.lifecycle_status || '').toUpperCase() === 'BLACKLISTED'
        && Math.round(amt * 100) !== Math.round(currentBalance * 100)) {
      throw mkErr(400, 'FULL_BALANCE_REQUIRED', 'Withdraw your full available balance');
    }

    // Deliberately a consistent (non-locking) read. Finance processing locks
    // request -> technician; waiting on the request here while holding the
    // technician would invert that order and deadlock. Seeing a concurrently
    // settling row as still requested is conservative: this attempt returns
    // pending and the technician can retry after settlement.
    const [[open]] = await conn.query(
      `SELECT request_id
         FROM tbl_easyfixer_withdrawal_request
        WHERE fk_easyfixer_id = ? AND status IN (?)
        LIMIT 1`,
      [efrId, OPEN_STATUSES],
    );
    if (open) {
      throw mkErr(409, 'WITHDRAWAL_PENDING', 'A withdrawal request is already pending');
    }

    const [ins] = await conn.query(
      `INSERT INTO tbl_easyfixer_withdrawal_request
         (fk_easyfixer_id, amount, status, requested_on,
          bank_details_id, bank_account_number, bank_ifsc,
          bank_account_holder_name, bank_id, bank_name)
       VALUES (?, ?, 'requested', NOW(), ?, ?, ?, ?, ?, ?)`,
      [
        efrId,
        amt,
        bank.efr_bank_id,
        bank.efr_bank_acc_num,
        bank.efr_bank_ifsc,
        bank.efr_bank_acc_name,
        bank.bank_id,
        bank.bank_name,
      ],
    );
    await conn.commit();
    logger.info('Withdrawal request recorded · requestId=' + ins.insertId + ' amount=' + amt);
    return { requestId: ins.insertId, amount: amt, status: 'requested' };
  } catch (error) {
    await conn.rollback().catch(() => {});
    logger.warn('Withdrawal request rolled back · efrId=' + efrId + ' · ' + error.message);
    throw error;
  } finally {
    conn.release();
  }
}

/* ─── FINANCE-SIDE PROCESSING (CRM Payout Requests) ──────────────────────
 *
 * The mobile endpoint above only RECORDS intent. Everything below is the
 * finance-in-the-loop consumer: LIST the queue, then PAY (debit wallet +
 * mark paid) or REJECT (no debit). Callers pass the shared `pool`.
 */

// Statuses finance can still act on. Same set as OPEN_STATUSES — a request is
// actionable exactly while it is still "open" (not already paid/rejected).
// Named separately for intent at the guard site.
const PROCESSABLE_STATUSES = OPEN_STATUSES;

// The row shape both list + process return. JOINs tbl_easyfixer for the
// technician's display name, mobile (efr_no — masked in admin responses by
// middleware/mask-mobile.js) and live wallet balance. Kept in one place so
// the list rows and the post-process row are byte-identical to the FE.
const REQUEST_SELECT = `
  SELECT w.request_id, w.fk_easyfixer_id, w.amount, w.status,
         w.requested_on, w.processed_on, w.processed_by, w.remarks,
         w.bank_details_id, w.bank_account_number, w.bank_ifsc,
         w.bank_account_holder_name, w.bank_id, w.bank_name,
         e.efr_name, e.efr_no, e.current_balance
    FROM tbl_easyfixer_withdrawal_request w
    LEFT JOIN tbl_easyfixer e ON e.efr_id = w.fk_easyfixer_id`;

/*
 * List withdrawal requests for the finance queue, server-side paginated.
 *
 * @param filters { status?, q?, page?, limit? }
 *   status  optional exact status filter ('requested'|'paid'|'rejected')
 *   q       optional LIKE search over technician name (efr_name) or mobile (efr_no)
 *   page    1-based page number (default 1)
 *   limit   page size (default 20, capped at 200 to match the route Joi max)
 * @param pool  mysql2 pool
 * @returns { items, total, page, limit }
 */
async function listWithdrawalRequests({ status, q, page, limit } = {}, pool) {
  const pageN  = Math.max(Number(page)  || 1, 1);
  const limitN = Math.min(Math.max(Number(limit) || 20, 1), 200);
  const offset = (pageN - 1) * limitN;

  logger.info('List withdrawal requests · status=' + (status || 'all') + ' q=' + (q || '') + ' page=' + pageN + ' limit=' + limitN);

  const where  = ['1=1'];
  const params = [];
  if (status) { where.push('w.status = ?'); params.push(status); }
  if (q) {
    // Mirror the easyfixer search columns: name + business mobile (efr_no).
    where.push('(e.efr_name LIKE ? OR e.efr_no LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  const whereSql = where.join(' AND ');

  // Pagination is server-side (LIMIT ?, ? = offset, count) per the blueprint.
  const [items] = await pool.query(
    `${REQUEST_SELECT}
      WHERE ${whereSql}
      ORDER BY w.request_id DESC
      LIMIT ?, ?`,
    [...params, offset, limitN],
  );

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total
       FROM tbl_easyfixer_withdrawal_request w
       LEFT JOIN tbl_easyfixer e ON e.efr_id = w.fk_easyfixer_id
      WHERE ${whereSql}`,
    params,
  );

  logger.info('Found ' + items.length + ' withdrawal requests · total=' + total);
  return { items, total, page: pageN, limit: limitN };
}

/*
 * Process a withdrawal request — MONEY-CRITICAL, transactional + idempotent.
 *
 *   action='pay'    → verify wallet ≥ amount, debit tbl_easyfixer.current_balance,
 *                     mark request 'paid'.
 *   action='reject' → mark request 'rejected' (NO debit).
 *
 * Both stamp processed_on / processed_by / remarks. The whole thing runs in a
 * single transaction with FOR UPDATE row locks so two finance operators can't
 * double-pay the same request or race the balance. Idempotency: the request
 * row is re-read FOR UPDATE inside the txn and rejected with 409 if it's no
 * longer 'requested' (i.e. already paid/rejected).
 *
 * @param requestId  tbl_easyfixer_withdrawal_request.request_id
 * @param body       { action: 'pay'|'reject', remarks?: string }
 * @param actor      req.user (the finance operator) — actor.user_id stamped to processed_by
 * @param pool       mysql2 pool
 * @returns the updated request row (same shape as listWithdrawalRequests items)
 */
async function processWithdrawal(requestId, { action, remarks }, actor, pool) {
  const actorId  = actor && actor.user_id != null ? actor.user_id : null;
  const remarkVal = remarks != null && String(remarks).trim() !== '' ? String(remarks).trim() : null;
  logger.info('Process withdrawal · requestId=' + requestId + ' action=' + action + ' actor=' + (actorId ?? '-'));

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1) Lock the request row. Idempotency guard: only open requests are
    //    actionable — anything already paid/rejected returns 409 so a
    //    double-submit (or a second operator) can't reprocess it.
    const [[reqRow]] = await conn.query(
      `SELECT request_id, fk_easyfixer_id, amount, status,
              bank_account_number, bank_ifsc, bank_account_holder_name
         FROM tbl_easyfixer_withdrawal_request
        WHERE request_id = ? FOR UPDATE`,
      [requestId],
    );
    if (!reqRow) {
      throw mkErr(404, 'REQUEST_NOT_FOUND', 'Withdrawal request not found');
    }
    if (!PROCESSABLE_STATUSES.includes(String(reqRow.status))) {
      throw mkErr(409, 'ALREADY_PROCESSED', `Request already ${reqRow.status} — cannot reprocess`);
    }

    const efrId = reqRow.fk_easyfixer_id;
    const amt   = Number(reqRow.amount);

    if (action === 'pay') {
      // Settle only against the immutable destination captured when the
      // technician submitted this request. Never fall back to the mutable
      // current bank-details row: changing that row after submission must not
      // silently redirect an already-approved payout.
      const accountNumber = String(reqRow.bank_account_number ?? '').trim();
      const ifsc = String(reqRow.bank_ifsc ?? '').trim();
      const accountHolder = String(reqRow.bank_account_holder_name ?? '').trim();
      if (!accountNumber || !ifsc || !accountHolder) {
        throw mkErr(409, 'PAYOUT_DESTINATION_MISSING',
          'Payout destination is missing; reject this request and ask the technician to submit it again');
      }

      // 2) Lock the wallet row and verify funds against the LIVE balance
      //    (the authoritative source — the technician may have earned/spent
      //    since the request was raised).
      const [[tech]] = await conn.query(
        'SELECT current_balance FROM tbl_easyfixer WHERE efr_id = ? FOR UPDATE',
        [efrId],
      );
      if (!tech) {
        throw mkErr(404, 'TECH_NOT_FOUND', 'Technician not found');
      }
      const balance = Number(tech.current_balance ?? 0);
      if (balance < amt) {
        throw mkErr(400, 'INSUFFICIENT_BALANCE',
          `Insufficient balance: available ${balance.toFixed(2)} < requested ${amt.toFixed(2)}`);
      }

      // 3a) Debit the wallet (+ stamp balance_updated, like the recharge path).
      await conn.query(
        'UPDATE tbl_easyfixer SET current_balance = current_balance - ?, balance_updated = NOW() WHERE efr_id = ?',
        [amt, efrId],
      );
      // 3b) Re-read the authoritative post-debit balance for the ledger row
      //     (avoids JS float drift from `balance - amt` on DECIMAL columns).
      const [[after]] = await conn.query(
        'SELECT current_balance FROM tbl_easyfixer WHERE efr_id = ?',
        [efrId],
      );
      const newBalance = Number(after && after.current_balance != null ? after.current_balance : balance - amt);
      // 3c) Wallet-ledger row so the payout reconciles to tbl_easyfixer_transaction
      //     (the tech's earnings statement + the finance ledger both read from
      //     there). transaction_type=1 = DEBIT per the legacy-authoritative mobile
      //     read (mobile-profile-extra.service.js: txType===2 is credit); `amount`
      //     is the magnitude, `balance` is the running balance AFTER the debit.
      //     Mirrors the admin-recharge ledger write in routes/admin/finance.js.
      await conn.query(
        `INSERT INTO tbl_easyfixer_transaction
           (easyfixer_id, source, description, transaction_type, transaction_date, amount, balance, created_date, created_by)
         VALUES (?, 'WITHDRAWAL', ?, 1, NOW(), ?, ?, NOW(), ?)`,
        [efrId, `Payout request #${requestId}${remarkVal ? ' — ' + remarkVal : ''}`, amt, newBalance, actorId],
      );
      // 3d) Mark the request paid.
      await conn.query(
        `UPDATE tbl_easyfixer_withdrawal_request
            SET status = 'paid', processed_on = NOW(), processed_by = ?, remarks = ?
          WHERE request_id = ?`,
        [actorId, remarkVal, requestId],
      );
    } else {
      // 3b) Reject — no debit, just flip status + audit fields.
      await conn.query(
        `UPDATE tbl_easyfixer_withdrawal_request
            SET status = 'rejected', processed_on = NOW(), processed_by = ?, remarks = ?
          WHERE request_id = ?`,
        [actorId, remarkVal, requestId],
      );
    }

    await conn.commit();
    logger.info('Withdrawal processed · requestId=' + requestId + ' action=' + action);
  } catch (e) {
    await conn.rollback();
    if (e.status) logger.warn('Process withdrawal rolled back · requestId=' + requestId + ' · ' + e.message);
    else logger.error('Process withdrawal failed · requestId=' + requestId + ' · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }

  // Re-read the committed row (with the joined efr fields + fresh balance) so
  // the FE gets the same shape the list returns.
  const [[updated]] = await pool.query(
    `${REQUEST_SELECT}
      WHERE w.request_id = ?`,
    [requestId],
  );
  return updated;
}

module.exports = { requestWithdrawal, listWithdrawalRequests, processWithdrawal };
