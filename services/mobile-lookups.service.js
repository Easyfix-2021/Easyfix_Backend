const { pool } = require('../db');
const logger = require('../logger');

/*
 * Mobile Lookups service — backs the Technician App dropdown/picker
 * endpoint in routes/mobile/lookups.js:
 *   GET /experience              (experience options)
 *
 * DUPLICATES REMOVED: `serviceCategories`, `banks`, and `jobReasons`
 * were removed — they duplicate /api/shared/lookup/service-categories,
 * /api/shared/lookup/banks, and /api/shared/lookup/cancel-reasons +
 * /reschedule-reasons. Only `experience` (no existing equivalent) remains.
 *
 * Native rebuild of the legacy ACD_APIs (`/test-api/api/*`) experience
 * lookup the Flutter app historically hit. Cross-referenced against:
 *   - ACD_APIs Experience entity → @Table "experience"
 *     (cols id, name, description)
 */

// ── Experience options ─────────────────────────────────────────────────
/*
 * Experience dropdown for the registration "professional details" step.
 * Legacy `experience` table (ACD_APIs Experience entity / EasyFix_CRM
 * Experience model — @JsonProperty maps id→experienceId, name, description).
 *
 *   [ { id, name, description } ]
 */
async function experience() {
  logger.info('List experience options');
  const [rows] = await pool.query(
    `SELECT id, name, description
       FROM experience
      ORDER BY id ASC`,
  );
  logger.info('Found ' + rows.length + ' experience options');
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description ?? null,
  }));
}

// ── Pincode → city / district / state ──────────────────────────────────
/*
 * Resolve a 6-digit pincode to its city + district + state for the
 * registration / edit-profile address forms (legacy Flutter GetCityStateBloc).
 *
 * Pure DB — NO Google/Mappls call needed: tbl_pincode.city_id → tbl_city →
 * tbl_state already carries city + state (the geocode service is lat/lng-only).
 * Reuses technician-registration-profile's lightweight canonical resolver,
 * which returns only the city/state projection registration needs. Returns
 * null when the pincode isn't seeded in tbl_pincode.
 */
async function resolvePincode(pincode) {
  logger.info('Resolve pincode · pincode=' + pincode);
  // Keep authenticated profile forms and the public pre-login form on the
  // exact same one-query resolver. The old pincode.service detail call also
  // computed active-technician and zone counts that registration never uses.
  // eslint-disable-next-line global-require
  const registrationProfile = require('./technician-registration-profile.service');
  const row = await registrationProfile.resolvePincode(pincode);
  if (!row) logger.info('Pincode not seeded · pincode=' + pincode);
  if (!row) return null;
  logger.info('Pincode resolved · pincode=' + pincode + ' cityId=' + (row.cityId ?? '-'));
  return row;
}

module.exports = {
  experience,
  resolvePincode,
};
