const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { roleByName } = require('../../middleware/role');
const svc = require('../../services/rewards.service');
const { modernOk } = require('../../utils/response');
const logger = require('../../logger');

/*
 * Rewards admin API — the shop catalogue, the claims queue, and the points
 * ledger. Mounted at /api/admin/rewards, so it inherits requireAuth,
 * role(['admin']) and maskMobile from routes/admin/index.js; writes narrow
 * further to roleByName(['Admin']) as the other master-data routes do.
 *
 * technician_mobile in the claim and ledger responses is masked on the way out
 * by the inherited middleware — no per-route work.
 */

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const referralsQuery = Joi.object({
  status: Joi.string().valid('pending', 'qualified').allow('', null).optional(),
  code: Joi.string().trim().max(24).allow('', null).optional(),
  search: Joi.string().trim().max(100).allow('', null).optional(),
  // Temporary alias for callers built against the earlier internal draft.
  q: Joi.string().trim().max(100).allow('', null).optional(),
  cursor: Joi.number().integer().positive().optional(),
  limit: Joi.number().integer().min(1).max(200).default(50),
});

/*
 * The published earn rates, read-only.
 *
 * The values are fixed in code — they are the programme's terms, and a rate
 * ops could retune mid-month would turn a promise to technicians into a
 * moving target while leaving already-awarded ledger rows indistinguishable
 * from new ones. This endpoint exists so nobody has to read the source to
 * answer "how many points is a same-day appointment worth?", which is the
 * question ops will actually be asked.
 */
router.get('/config', async (_req, res, next) => {
  try {
    const config = svc.pointsConfig();
    modernOk(res, {
      rules: config.rules,
      lookbackDays: config.lookbackDays,
      /* Drives the "Rewards Programme Is Paused" note across the CRM pages. */
      earningPaused: config.earningPaused,
      // Stated explicitly so the CRM can say so on the page rather than
      // implying the numbers are editable somewhere an operator hasn't found.
      configurable: false,
    });
  } catch (e) { next(e); }
});

/*
 * Read-only referral operations view. It inherits the same authenticated admin
 * permission and mobile-number masking as the other Rewards reads. Pagination
 * is id-keyset based; no export-sized/unbounded response is available here.
 */
router.get('/referrals', validate(referralsQuery, 'query'), async (req, res, next) => {
  try {
    modernOk(res, await svc.listReferrals(req.query));
  } catch (e) { next(e); }
});

// ─── Items ───────────────────────────────────────────────────────────

const listItemsQuery = Joi.object({
  q: Joi.string().allow('', null).optional(),
  includeRetired: Joi.boolean().default(false),
  limit: Joi.number().integer().min(1).max(1000).default(200),
  offset: Joi.number().integer().min(0).default(0),
});

/*
 * `sizes` is a CSV the operator types ("S,M,L,XL" or "7,8,9"). Free text
 * rather than a fixed enum because the catalogue spans apparel, footwear and
 * items with no size at all, and inventing a size taxonomy for four T-shirts
 * would be ceremony.
 */
const itemBody = Joi.object({
  name: Joi.string().trim().min(2).max(150).required(),
  description: Joi.string().max(1000).allow('', null).optional(),
  image_key: Joi.string().max(255).allow('', null).optional(),
  points_cost: Joi.number().integer().min(1).max(1000000).required(),
  sizes: Joi.string().max(200).allow('', null).optional(),
  stock: Joi.number().integer().min(0).max(100000).default(0),
});

const itemPatch = Joi.object({
  name: Joi.string().trim().min(2).max(150).optional(),
  description: Joi.string().max(1000).allow('', null).optional(),
  image_key: Joi.string().max(255).allow('', null).optional(),
  points_cost: Joi.number().integer().min(1).max(1000000).optional(),
  sizes: Joi.string().max(200).allow('', null).optional(),
  stock: Joi.number().integer().min(0).max(100000).optional(),
  status: Joi.boolean().optional(),
}).min(1);

router.get('/items', validate(listItemsQuery, 'query'), async (req, res, next) => {
  try {
    modernOk(res, await svc.listItems(req.query));
  } catch (e) { next(e); }
});

router.post('/items', roleByName(['Admin']), validate(itemBody), async (req, res, next) => {
  try {
    const created = await svc.createItem(req.body);
    res.status(201);
    modernOk(res, created);
  } catch (e) { next(e); }
});

router.patch('/items/:id', roleByName(['Admin']), validate(idParam, 'params'), validate(itemPatch), async (req, res, next) => {
  try {
    modernOk(res, await svc.updateItem(req.params.id, req.body));
  } catch (e) { next(e); }
});

/* Retires (status 0); never deletes — old claims must keep resolving. */
router.delete('/items/:id', roleByName(['Admin']), validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Retire reward item · id=' + req.params.id);
    modernOk(res, await svc.retireItem(req.params.id));
  } catch (e) { next(e); }
});

// ─── Claims ──────────────────────────────────────────────────────────

const listClaimsQuery = Joi.object({
  status: Joi.string().valid(...svc.CLAIM_STATUSES).allow('', null).optional(),
  q: Joi.string().allow('', null).optional(),
  limit: Joi.number().integer().min(1).max(1000).default(100),
  offset: Joi.number().integer().min(0).default(0),
});

/*
 * `reject_reason` is required for REJECTED and ignored otherwise. Rejecting
 * refunds the points as a NEW ledger row and returns the unit to stock — the
 * technician sees both the original debit and the refund, which is the
 * explanation.
 */
const claimPatch = Joi.object({
  status: Joi.string().valid(...svc.CLAIM_STATUSES).required(),
  tracking_ref: Joi.string().max(120).allow('', null).optional(),
  reject_reason: Joi.string().max(255).allow('', null).optional(),
});

router.get('/claims', validate(listClaimsQuery, 'query'), async (req, res, next) => {
  try {
    modernOk(res, await svc.listClaims(req.query));
  } catch (e) { next(e); }
});

router.patch('/claims/:id', roleByName(['Admin']), validate(idParam, 'params'), validate(claimPatch), async (req, res, next) => {
  try {
    modernOk(res, await svc.updateClaim(
      req.params.id,
      {
        status: req.body.status,
        trackingRef: req.body.tracking_ref,
        rejectReason: req.body.reject_reason,
      },
      req.user?.user_id ?? null,
    ));
  } catch (e) { next(e); }
});

// ─── Ledger ──────────────────────────────────────────────────────────

const ledgerQuery = Joi.object({
  easyfixerId: Joi.number().integer().positive().optional(),
  reasonCode: Joi.string().valid(...Object.values(svc.REASON)).allow('', null).optional(),
  q: Joi.string().allow('', null).optional(),
  /*
   * The ledger is append-only and grows ~441 rows a day, so the page asks for a
   * WINDOW instead of everything. ISO yyyy-mm-dd, both ends OPTIONAL and
   * INDEPENDENT — "everything since the 1st" is a real request, not a malformed
   * one. No default is applied here on purpose: the service filters only on what
   * it is given, so a caller sending neither still gets the whole ledger rather
   * than a silently narrowed subset. See the block in services/rewards.service.js
   * adminLedger() for why the default belongs to the page and not to the API.
   */
  from: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).allow('', null).optional(),
  to: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).allow('', null).optional(),
  limit: Joi.number().integer().min(1).max(1000).default(100),
  offset: Joi.number().integer().min(0).default(0),
});

/*
 * A manual adjustment needs a REASON, always. An unexplained balance change is
 * the fastest way to lose a technician's trust, and the first question ops
 * will be asked is who did it and why — so `created_by` is stamped too.
 */
const adjustBody = Joi.object({
  easyfixer_id: Joi.number().integer().positive().required(),
  delta: Joi.number().integer().invalid(0).min(-100000).max(100000).required(),
  note: Joi.string().trim().min(3).max(255).required(),
});

router.get('/ledger', validate(ledgerQuery, 'query'), async (req, res, next) => {
  try {
    modernOk(res, await svc.adminLedger(req.query));
  } catch (e) { next(e); }
});

router.post('/ledger/adjust', roleByName(['Admin']), validate(adjustBody), async (req, res, next) => {
  try {
    logger.info('Manual points adjustment · efrId=' + req.body.easyfixer_id + ' · delta=' + req.body.delta);
    modernOk(res, await svc.adjustPoints({
      easyfixerId: req.body.easyfixer_id,
      delta: req.body.delta,
      note: req.body.note,
      createdBy: req.user?.user_id ?? null,
    }));
  } catch (e) { next(e); }
});

/* Balance for one technician — used by the adjust dialog to show the before. */
router.get('/balance/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    modernOk(res, { easyfixer_id: Number(req.params.id), balance: await svc.balanceFor(req.params.id) });
  } catch (e) { next(e); }
});

module.exports = router;
