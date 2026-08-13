const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const svc = require('../../services/rewards.service');
const { pool } = require('../../db');
const { modernOk } = require('../../utils/response');
const logger = require('../../logger');

/*
 * Rewards — technician API. Mounted under /api/mobile, so every route here
 * already has a verified technician on req.tech.
 *
 * EVERY route scopes to req.tech.efr_id and never trusts an id in the body.
 * Points are the technician's own property; a claim or a ledger read that took
 * its subject from the request would let any signed-in technician spend
 * someone else's balance.
 *
 * Note what is deliberately ABSENT: there is no route that converts points to
 * money, and none should ever be added. Points are a separate, non-convertible
 * ledger from the wallet.
 */

// ─── Balance, ledger and shop ────────────────────────────────────────

const pageQuery = Joi.object({
  limit: Joi.number().integer().min(1).max(200).default(50),
  offset: Joi.number().integer().min(0).default(0),
});

/*
 * The W-01 payload in one call: balance, recent history and the shop.
 *
 * One request rather than three because this is the screen's first paint on a
 * field technician's phone — often on a poor connection — and three
 * round-trips would show three separate skeletons resolving at different
 * times. The pieces are all small.
 */
router.get('/summary', async (req, res, next) => {
  try {
    const efrId = req.tech.efr_id;
    logger.info('Rewards summary · efrId=' + efrId);
    const [balance, ledger, items, referral] = await Promise.all([
      svc.balanceFor(efrId),
      svc.ledgerFor(efrId, { limit: 20 }),
      svc.listItems({ limit: 50 }),
      svc.referralSummary(efrId),
    ]);
    modernOk(res, {
      balance,
      history: ledger.rows,
      historyTotal: ledger.total,
      items: items.rows,
      referral,
      /*
       * The published earn rates, sent with the screen rather than hardcoded
       * in the app. W-01 tells the technician what each route is worth, and
       * those numbers must come from the same constant the awarding cron uses
       * — an app that claims 30 points for an SDA while the server pays 25
       * is a broken promise, not a display bug.
       */
      earnRules: svc.pointsConfig().rules,
      /*
       * Paused means NEW earning has stopped — not that anything was taken
       * away. The balance stands and the shop still works, so the app shows a
       * note rather than hiding the screen. A technician who suddenly stops
       * seeing points otherwise assumes his good work went unnoticed.
       */
      earningPaused: svc.pointsConfig().earningPaused,
    });
  } catch (e) { next(e); }
});

router.get('/ledger', validate(pageQuery, 'query'), async (req, res, next) => {
  try {
    modernOk(res, await svc.ledgerFor(req.tech.efr_id, req.query));
  } catch (e) { next(e); }
});

// ─── Claiming ────────────────────────────────────────────────────────

/*
 * The saved address comes from registration (tbl_easyfixer), and the app
 * prefills it. The technician may override it per claim — parcels go to
 * where someone can receive them, which is not always the address on file.
 */
router.get('/address', async (req, res, next) => {
  try {
    const [[row]] = await pool.query(
      `SELECT e.efr_address, e.efr_address_res, e.efr_pin_no, e.efr_no, c.city_name
         FROM tbl_easyfixer e
         LEFT JOIN tbl_city c ON c.city_id = e.efr_cityId
        WHERE e.efr_id = ?`,
      [req.tech.efr_id],
    );
    modernOk(res, {
      line: row?.efr_address_res || row?.efr_address || '',
      city: row?.city_name || '',
      pincode: row?.efr_pin_no ? String(row.efr_pin_no) : '',
      phone: row?.efr_no ? String(row.efr_no) : '',
    });
  } catch (e) { next(e); }
});

const claimBody = Joi.object({
  item_id: Joi.number().integer().positive().required(),
  size: Joi.string().max(20).allow('', null).optional(),
  address: Joi.object({
    line: Joi.string().trim().min(5).max(500).required(),
    city: Joi.string().max(120).allow('', null).optional(),
    pincode: Joi.string().max(12).allow('', null).optional(),
    phone: Joi.string().max(20).allow('', null).optional(),
  }).required(),
});

/*
 * Confirming a claim debits the points in the same transaction that creates
 * it. Deliberately NOT deferred to dispatch: a technician with 400 points
 * could otherwise confirm four 400-point rewards and leave ops to discover it.
 */
router.post('/claims', validate(claimBody), async (req, res, next) => {
  try {
    logger.info('Reward claim · efrId=' + req.tech.efr_id + ' · item=' + req.body.item_id);
    const result = await svc.claimItem(req.tech.efr_id, {
      itemId: req.body.item_id,
      size: req.body.size,
      address: req.body.address,
    });
    res.status(201);
    modernOk(res, result);
  } catch (e) { next(e); }
});

router.get('/claims', validate(pageQuery, 'query'), async (req, res, next) => {
  try {
    modernOk(res, await svc.claimsFor(req.tech.efr_id, req.query));
  } catch (e) { next(e); }
});

// ─── Referral ────────────────────────────────────────────────────────

/* Issues the code on first read, so a technician who never opens Rewards
 * never has one — there is nothing to generate in advance. */
router.get('/referral', async (req, res, next) => {
  try {
    modernOk(res, await svc.referralSummary(req.tech.efr_id));
  } catch (e) { next(e); }
});

const applyBody = Joi.object({ code: Joi.string().trim().min(4).max(24).required() });

/*
 * Applying a code records the link and pays NOTHING. The referrer is credited
 * only once this technician completes their first job — paying at signup would
 * be an invitation to invent technicians.
 */
router.post('/referral/apply', validate(applyBody), async (req, res, next) => {
  try {
    modernOk(res, await svc.attachReferral(req.tech.efr_id, req.body.code));
  } catch (e) { next(e); }
});

module.exports = router;
