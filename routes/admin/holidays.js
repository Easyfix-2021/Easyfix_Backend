const router = require('express').Router();

const validate     = require('../../middleware/validate');
const holiday      = require('../../services/holiday.service');
const { upcomingQuery } = require('../../validators/holiday.validator');
const { modernOk } = require('../../utils/response');

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
      const items = await holiday.getUpcoming({ days: req.query.days });
      modernOk(res, { items });
    } catch (e) {
      // Even on total failure (no cache + no upstream) we'd rather show
      // an empty rail than 500. The service throws only when there's
      // truly nothing — degrade gracefully.
      modernOk(res, { items: [], degraded: true });
    }
  },
);

module.exports = router;
