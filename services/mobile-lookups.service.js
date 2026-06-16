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

module.exports = {
  experience,
};
