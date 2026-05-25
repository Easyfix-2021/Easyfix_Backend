const Joi = require('joi');

/*
 * Holiday route validators.
 *
 * Only one knob: `days` window for the upcoming-events rail. Capped at
 * 30 to discourage callers from asking for the full year (use a
 * dedicated /admin/holidays/year endpoint if that ever becomes a need).
 */

const upcomingQuery = Joi.object({
  days: Joi.number().integer().min(1).max(30).default(7),
});

module.exports = { upcomingQuery };
