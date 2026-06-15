/*
 * Joi schemas for the native QuickSight reports.
 *
 * `jobFilterBase` is the shared filter contract every report's endpoint
 * extends. All dimension filters are arrays of integer ids that accept a
 * single scalar (`.single()`) and default to `[]` (= "no restriction", per
 * services/quicksight/_shared.js::buildInFilter). `format` toggles the
 * server-side xlsx export branch.
 *
 * Per-endpoint schemas extend this with `extendJobFilter({ ... })`, e.g.
 *   - drill-downs add  pmUserId: Joi.number().integer().required()
 *   - client-performance adds  period: Joi.string().valid('monthly','weekly')
 *   - vertical-orders adds      flag: Joi.string()  (CSV)
 *
 * Filter semantics (see _crosscut.json / _plan.json):
 *   - zonalManagerId → tbl_city.state_user (a city's zonal owner user_id),
 *     NOT a manager hierarchy.
 *   - projectManagerId → tbl_vertical_mapping.user_type
 *       (user_type=2 for openOrders pmlist; user_type=1 for client-performance PM).
 */

const Joi = require('joi');

// Array-of-ids filter: accepts a single scalar or an array, defaults [].
const idArray = Joi.array().items(Joi.number().integer()).single().default([]);

const jobFilterBase = Joi.object({
  clientId:          idArray,
  verticalId:        idArray,
  zonalManagerId:    idArray,
  serviceCategoryId: idArray,
  projectManagerId:  idArray,
  stateId:           idArray,
  cityId:            idArray,
  format:            Joi.string().valid('json', 'xlsx').default('json'),
});

/*
 * extendJobFilter(extra) — return a NEW schema = jobFilterBase + extra keys.
 *
 *   const summaryQuery = extendJobFilter();                       // base only
 *   const drillQuery   = extendJobFilter({ pmUserId: Joi.number().integer().required() });
 *   const perfQuery    = extendJobFilter({ period: Joi.string().valid('monthly','weekly').default('monthly') });
 *
 * `extra` is a plain object of { key: Joi.schema }. Joi's .keys() merges
 * (and overrides on key collision) without mutating the base schema.
 */
function extendJobFilter(extra = {}) {
  return jobFilterBase.keys(extra);
}

module.exports = {
  jobFilterBase,
  extendJobFilter,
  // Exposed so per-endpoint schemas can reuse the same array shape for
  // any additional id-list filter a report introduces.
  idArray,
};
