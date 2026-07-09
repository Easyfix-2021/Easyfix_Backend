const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { roleByName } = require('../../middleware/role');
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');
const withdrawalService = require('../../services/withdrawal.service');

/*
 * /api/admin/withdrawals — CRM "Payout Requests" processor.
 *
 * The finance-side consumer of technician withdrawal requests recorded by
 * POST /api/mobile/withdraw (services/withdrawal.service.js::requestWithdrawal).
 * LIST the queue, then PAY (debit tbl_easyfixer.current_balance + mark paid) or
 * REJECT (no debit). The heavy lifting — transaction, FOR UPDATE row locks,
 * idempotency, balance check — lives in the service so it's testable in one place.
 *
 * Mount inherits requireAuth + role(['admin']) + scope from routes/admin/index.js.
 * These routes additionally gate to Finance (money movement) via roleByName. The
 * canonical Admin role is included so the superuser isn't locked out — mirrors
 * how every other mutation route gates roleByName(['Admin']). FE button-level
 * gating uses the seeded action keys isPayoutRequestsView / isPayoutRequestsProcess.
 */
const financeGuard = roleByName(['Admin', 'Finance']);

// The statuses a request row can hold. 'requested' is open (finance-actionable);
// 'paid'/'rejected' are terminal.
const WITHDRAWAL_STATUSES = ['requested', 'paid', 'rejected'];

const listQuery = Joi.object({
  status: Joi.string().valid(...WITHDRAWAL_STATUSES).optional(),
  q:      Joi.string().trim().max(100).allow('', null).optional(),
  page:   Joi.number().integer().min(1).default(1),
  // Ceiling MUST stay in sync with the FE TablePagination "All" cap
  // (pageSizeToLimit(pageSize, 200)) — the memory note on the pagination cap.
  limit:  Joi.number().integer().min(1).max(200).default(20),
});

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const processBody = Joi.object({
  action:  Joi.string().valid('pay', 'reject').required(),
  remarks: Joi.string().trim().max(255).allow('', null).optional(),
});

// ─── LIST ────────────────────────────────────────────────────────────
router.get('/', financeGuard, validate(listQuery, 'query'), async (req, res, next) => {
  try {
    logger.info('List withdrawal requests · status=' + (req.query.status ?? 'all') + ' q=' + (req.query.q ?? '-') + ' page=' + req.query.page + ' limit=' + req.query.limit);
    const data = await withdrawalService.listWithdrawalRequests(req.query, pool);
    modernOk(res, data);
  } catch (e) { next(e); }
});

// ─── PROCESS (pay / reject) — MONEY-CRITICAL ─────────────────────────
router.post('/:id/process',
  financeGuard,
  validate(idParam, 'params'),
  validate(processBody),
  async (req, res, next) => {
    try {
      logger.info('Process withdrawal · id=' + req.params.id + ' action=' + req.body.action + ' actor=' + (req.user?.user_id ?? '-'));
      const row = await withdrawalService.processWithdrawal(
        Number(req.params.id), req.body, req.user, pool,
      );
      logger.info('Withdrawal processed · id=' + req.params.id + ' status=' + (row?.status ?? '-'));
      modernOk(res, row, req.body.action === 'pay' ? 'Withdrawal paid' : 'Withdrawal rejected');
    } catch (e) {
      // Service throws { status, code, message } for the money-safety rejects
      // (409 ALREADY_PROCESSED, 400 INSUFFICIENT_BALANCE, 404 …). Surface the
      // status + a machine code the FE can branch on; fall through to the
      // central handler for anything unexpected (→ 500).
      if (e.status) {
        logger.warn('Process withdrawal failed · id=' + req.params.id + ' · ' + e.message);
        return modernError(res, e.status, e.message, e.code ? { code: e.code } : undefined);
      }
      next(e);
    }
  },
);

module.exports = router;
