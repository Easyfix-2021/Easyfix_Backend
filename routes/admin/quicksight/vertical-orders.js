/*
 * QuickSight report sub-router — Vertical Orders.
 *
 *   registry slug   : vertical
 *   urlBase         : vertical-orders   (mounted at /api/admin/quicksight/vertical-orders)
 *   action key      : isQuickSightVerticalOrdersView
 *   service file    : services/quicksight/quicksight-vertical-orders.service.js
 *
 * Single legacy endpoint rebuilt natively:
 *   GET /api/admin/quicksight/vertical-orders?flag=<csv>[&format=xlsx]
 *
 * The parent admin chain (routes/admin/index.js) already applies
 * requireAuth -> role(['admin']) -> maskMobile -> req.scope. This router
 * layers the QuickSight gate on top (ef-QuickSight family key + the
 * per-report isQuickSightVerticalOrdersView key) via requireQuickSight,
 * applied to EVERY route below with router.use.
 *
 * Gating note (open question resolved): legacy openVerticalOrders was
 * effectively "any authenticated user" (permitAll + bearer-required, no
 * role check). The native build is INTENTIONALLY hardened to admin-group +
 * ef-QuickSight + the per-report key — the safer recommendation in the
 * spec's openQuestions. The data itself stays GLOBAL (no req.scope row
 * filtering) to keep the counts byte-identical to legacy.
 */

const router = require('express').Router();
const Joi = require('joi');

const requireQuickSight = require('../../../middleware/require-quicksight');
const validate = require('../../../middleware/validate');
const { modernOk, modernError } = require('../../../utils/response');
const { sendXlsx } = require('../../../utils/xlsx-export');
const logger = require('../../../logger');
const {
  getVerticalOpenOrders,
  buildExportRows,
  EXPORT_COLUMNS,
  FLAGS,
} = require('../../../services/quicksight/quicksight-vertical-orders.service');

// Per-report QuickSight gate on every route in this sub-router.
router.use(requireQuickSight('isQuickSightVerticalOrdersView'));

/*
 * Inline Joi schema (kept here so the shared validator is never edited).
 *
 * `flag` is the legacy CSV of one-or-more toggle tokens. The custom rule
 * mirrors the legacy IllegalArgumentException messages:
 *   - null/empty  -> 'Flags must not be null or empty'
 *   - bad token   -> 'Invalid flag value: <x>'
 * On success it NORMALISES `flag` to a deduped, lowercased array so the
 * handler/service receive a clean token list.
 *
 * `format` toggles the server-side xlsx export branch (default 'json').
 */
const verticalOrdersQuery = Joi.object({
  flag: Joi.string()
    .required()
    .custom((value, helpers) => {
      const parts = String(value)
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (!parts.length) return helpers.message('Flags must not be null or empty');
      for (const p of parts) {
        if (!FLAGS.includes(p)) return helpers.message(`Invalid flag value: ${p}`);
      }
      // Dedupe while preserving first-seen order.
      return Array.from(new Set(parts));
    }, 'vertical-orders flag csv')
    .messages({
      'any.required': 'Flags must not be null or empty',
      'string.empty': 'Flags must not be null or empty',
    }),
  format: Joi.string().valid('json', 'xlsx').default('json'),
});

/*
 * GET /api/admin/quicksight/vertical-orders?flag=<csv>[&format=xlsx]
 *
 * flag : CSV of {waitingtx, runninglate, openonapp, underaudit} (case-
 *        insensitive). Multiple flags SUM their buckets.
 * format=xlsx : streams the on-screen pivot (2 verticals + a Total row)
 *               as an .xlsx download instead of JSON.
 */
router.get('/', validate(verticalOrdersQuery, 'query'), async (req, res, next) => {
  try {
    const flags = req.query.flag; // normalised array (Joi custom rule)
    const result = await getVerticalOpenOrders(flags);

    if (req.query.format === 'xlsx') {
      const rows = buildExportRows(result.openOrderByGroup);
      logger.info(
        { report: 'quicksight-vertical-orders', flags, rows: rows.length },
        'QuickSight Vertical Orders xlsx export',
      );
      return sendXlsx(res, {
        filename: 'vertical-orders.xlsx',
        sheetName: 'Vertical Orders',
        columns: EXPORT_COLUMNS,
        rows,
      });
    }

    return modernOk(res, result);
  } catch (err) {
    // Map a thrown service error carrying an explicit HTTP status to a
    // modern error; otherwise defer to the global error handler.
    if (err && err.status) {
      return modernError(res, err.status, err.message);
    }
    return next(err);
  }
});

module.exports = router;
