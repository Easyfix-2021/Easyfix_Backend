const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { modernOk } = require('../../utils/response');
const svc = require('../../services/mobile-performance.service');

/*
 * /api/mobile/performance/* — Technician-app weekly-performance surface.
 *
 * Backs the RN home dashboard's per-week OTA/SDA bar chart + headline
 * OTA / SDA / grade / rating / totals. All metrics are computed LIVE
 * from tbl_job (no pre-computed table) by mobile-performance.service,
 * which reuses performance.service's exact OTA / SDA / rating / grade
 * definitions for consistency.
 *
 * AUTH: `requireTechAuth` is applied UPSTREAM in routes/mobile/index.js
 * via `router.use(requireTechAuth)` BEFORE this sub-router is mounted —
 * so `req.tech.efr_id` is always populated here. Handlers scope strictly
 * to `req.tech.efr_id`; no technician id is ever read from the request.
 *
 * Mount (add in routes/mobile/index.js AFTER requireTechAuth):
 *   router.use('/performance', require('./performance'));
 *
 * Paths here are RELATIVE to that mount, so the chart endpoint resolves
 * to GET /api/mobile/performance/weekly.
 */

// ─── Weekly chart window ─────────────────────────────────────────────
// `from` / `to` are inclusive YYYY-MM-DD bounds, both required. The
// range is capped at 26 weeks (≈182 days) — the app only ever charts a
// rolling quarter-or-two, and the cap bounds the per-bar fan-out.
const MAX_RANGE_DAYS = 26 * 7;

const weeklyQuery = Joi.object({
  from: Joi.date().iso().required(),
  to: Joi.date().iso().required(),
})
  .custom((value, helpers) => {
    if (value.to < value.from) {
      return helpers.message('`to` must be on or after `from`');
    }
    const spanDays = (value.to - value.from) / (24 * 60 * 60 * 1000);
    if (spanDays > MAX_RANGE_DAYS) {
      return helpers.message(`date range too wide (max ${MAX_RANGE_DAYS} days / 26 weeks)`);
    }
    return value;
  });

// Joi.date().iso() coerces to a Date; the service wants plain YYYY-MM-DD
// strings for the SQL window, so normalise back to the date portion.
function toYmd(d) {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

/*
 * GET /api/mobile/performance/weekly?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Returns:
 *   { ota, sda, grade, rating, totalJobs, totalEarnings,
 *     weeks: [{ weekStart, ota, sda, jobsDone, earnings }] }
 *
 * `weeks` has one entry per ISO week in [from, to], ascending, with
 * zero-job weeks filled so the bar chart has a bar per week.
 */
router.get('/weekly', validate(weeklyQuery, 'query'), async (req, res, next) => {
  try {
    const from = toYmd(req.query.from);
    const to = toYmd(req.query.to);
    modernOk(res, await svc.getWeeklyPerformance(req.tech.efr_id, from, to));
  } catch (e) { next(e); }
});

module.exports = router;
