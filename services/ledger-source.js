/*
 * tbl_easyfixer_transaction.source / tbl_client_transaction.source — the legacy
 * tinyint vocabulary, in one place because Node used to bind STRINGS here.
 *
 * The column is `tinyint` and the BE pool session runs sql_mode
 * 'IGNORE_SPACE,NO_ENGINE_SUBSTITUTION' — no STRICT_TRANS_TABLES — so MySQL
 * coerced 'WITHDRAWAL' and 'ADMIN_RECHARGE' to 0 with warning 1292 and the row
 * was written anyway. Legacy is immune by construction: every legacy ledger
 * write goes through an SP whose parameter is declared `IN in_source INT`.
 *
 * Codes below are the ones this backend writes. The rest of the live vocabulary,
 * for whoever reads a row: the column comment on QA says
 * "1:from system, 2: cash, 3:cheque, 4:Online, 5: app", legacy's manual-entry
 * form (addEditTransaction.vm) labels 2 Cash / 3 Cheque / 4 PayTm / 5 NEFT /
 * 6 Cash deposited in Bank / 7 Adjustment, and 8 / 9 are the two bank codes
 * EasyfixerFinanceAction maps for an NDM recharge (Yes Bank / ICICI Bank).
 * The two label maps disagree about 4; nothing in either stack FILTERS on
 * source, so a code is a label, never a predicate.
 *
 * QA distribution when this was written (tbl_easyfixer_transaction, 395k rows):
 *   1 → 341,043 · 4 → 34,865 · 5 → 12,036 · 2 → 7,441 · 7 → 3,603
 *   0 → 1,056 (legacy NDM recharges, 2016-2020) · 3 → 491 · 6 → 24 · 9 → 6 · 8 → 1
 *
 * A LEAF MODULE ON PURPOSE — it requires nothing. services/withdrawal.service.js
 * has exactly one require (the logger) and takes its pool by injection;
 * importing job-ledger.service there to reach an integer would invert that.
 */
const SOURCE = {
  SYSTEM: 1,        // written by the system for a job — what every SP passes
  CASH: 2,          // NDM collected cash (legacy EasyfixerFinanceAction maps 'Cash' → 2)
  PAYOUT: 4,        // a technician payout; what sp_ef_approve_payout_by_finance itself stamps
  ADJUSTMENT: 7,    // an operator-entered correction with no other classification
  YES_BANK: 8,
  ICICI_BANK: 9,
};

module.exports = { SOURCE };
