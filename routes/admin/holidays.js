const router = require('express').Router();

const validate     = require('../../middleware/validate');
const holiday      = require('../../services/holiday.service');
const { upcomingQuery } = require('../../validators/holiday.validator');
const { modernOk } = require('../../utils/response');
const logger       = require('../../logger');

/*
 * Holidays — drives the "Upcoming Events" rail on the CRM dashboard.
 * Backed by Nager.Date with a 24h in-memory cache + stale-while-
 * revalidate fallback. See services/holiday.service.js.
 *
 * No mutations: holidays come from an external source. If we ever
 * need manual overrides (Indian restricted holidays etc.), they'll
 * land as a separate `tbl_holiday_override` and the service will
 * merge them in — the route surface stays the same.
 */

router.get(
  '/upcoming',
  validate(upcomingQuery, 'query'),
  async (req, res, next) => {
    try {
      logger.info('Fetch upcoming holidays · days=' + req.query.days);
      const items = await holiday.getUpcoming({ days: req.query.days });
      logger.info('Returning ' + items.length + ' upcoming holidays');
      modernOk(res, { items });
    } catch (e) {
      // Even on total failure (no cache + no upstream) we'd rather show
      // an empty rail than 500. The service throws only when there's
      // truly nothing — degrade gracefully.
      logger.warn('Upcoming holidays unavailable, returning empty rail · ' + e.message);
      modernOk(res, { items: [], degraded: true });
    }
  },
);

module.exports = router;
