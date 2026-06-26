const { pool } = require('../db');

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
  const [rows] = await pool.query(
    `SELECT id, name, description
       FROM experience
      ORDER BY id ASC`,
  );
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
 * Reuses the canonical resolver services/pincode.service.getPincodeByValue,
 * which returns { city_name, district, state_name, ... }. Returns null when the
 * pincode isn't seeded in tbl_pincode (caller surfaces "enter manually").
 */
async function resolvePincode(pincode) {
  // eslint-disable-next-line global-require
  const pincodeService = require('./pincode.service');
  const row = await pincodeService.getPincodeByValue(pincode);
  if (!row) return null;
  return {
    pincode: row.pincode,
    cityId: row.city_id ?? null,
    city: row.city_name ?? null,
    district: row.district ?? null,
    state: row.state_name ?? null,
  };
}

module.exports = {
  experience,
  resolvePincode,
};
