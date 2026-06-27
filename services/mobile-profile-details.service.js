const { pool } = require('../db');
const logger = require('../logger');
const dashboardService = require('./mobile-dashboard.service');
const performanceService = require('./performance.service');
const jobService = require('./job.service');

/*
 * Mobile profile-details orchestrator — backs `GET /api/mobile/profile/details`.
 *
 * The app's ApiProfileService.getProfileDetails expects a composed view of the
 * technician (identity + reputation + headline counts), NOT the raw tbl_easyfixer
 * row that the legacy `GET /profile` returns. Per the single-source-of-truth /
 * no-route-duplication rule, EVERY field here comes from a function that already
 * powers another surface — this file only RE-SHAPES, it never re-implements
 * business logic:
 *
 *   - identity (name / mobile / email / city / photo / categories)
 *       → mobile-dashboard.service.fetchIdentity()  (same projection the
 *         home-screen technician card reads)
 *   - rating + grade
 *       → performance.service.getForTech()          (same OTA/SDA/grade/rating
 *         engine the dashboard + CRM "Top Technicians" report use)
 *   - completedJobs
 *       → job.service.getStatusCounts()             (the canonical status-tally
 *         engine; completed = COMPLETED(3) + COMPLETED_ALT(5))
 *
 * The only direct SQL is one tiny tier-specific read (`insert_date` →
 * memberSince), because the dashboard identity projection doesn't carry it and
 * adding it there would change a payload other consumers depend on.
 *
 * `membershipType` is returned as null — there is no such column on tbl_easyfixer
 * (kept in the shape so the app's parser has a stable key to read).
 */

// `fetchIdentity` is an internal of mobile-dashboard.service. Reuse it when the
// module exposes it; otherwise fall back to the identical projection locally so
// this service never depends on another module's export surface to function.
async function readIdentity(efrId) {
  if (typeof dashboardService.fetchIdentity === 'function') {
    return dashboardService.fetchIdentity(efrId);
  }
  // Defensive fallback — same SELECT (with efr_email added) and the same
  // ER_BAD_FIELD_ERROR degrade-without-efr_profile_img behaviour.
  const base = (withImg) => `
    SELECT e.efr_id, e.efr_name, e.efr_first_name, e.efr_no, e.efr_email,
           ${withImg ? 'e.efr_profile_img,' : ''}
           e.efr_cityId, c.city_name,
           e.current_balance, e.efr_service_category
      FROM tbl_easyfixer e
      LEFT JOIN tbl_city c ON c.city_id = e.efr_cityId
     WHERE e.efr_id = ? LIMIT 1`;
  try {
    const [[row]] = await pool.query(base(true), [efrId]);
    return row || {};
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      try {
        const [[row]] = await pool.query(base(false), [efrId]);
        return row || {};
      } catch (e2) {
        logger.warn({ err: e2.message, efrId }, 'readIdentity fallback failed');
        return {};
      }
    }
    logger.warn({ err: e.message, efrId }, 'readIdentity failed');
    return {};
  }
}

// `insert_date` (technician's join date) + `efr_email` + `efr_pin_no` — none is
// carried by the dashboard identity projection (fetchIdentity selects no email,
// no insert_date, no pincode), so a focused single read fills them. Best-effort:
// degrade to empty object so each field falls back to null.
async function fetchExtraProfileFields(efrId) {
  try {
    const [[row]] = await pool.query(
      'SELECT insert_date, efr_email, efr_pin_no FROM tbl_easyfixer WHERE efr_id = ? LIMIT 1',
      [efrId],
    );
    return row || {};
  } catch (e) {
    logger.info({ err: e.message, efrId }, 'fetchExtraProfileFields failed; returning empty');
    return {};
  }
}

// DISTINCT mapped deep-skill count for the technician. Documented column
// inversion: the physical `parent_skill_id` column actually holds the
// deepskill_id, so counting DISTINCT parent_skill_id yields distinct deep
// skills. Best-effort: any failure (incl. missing table) degrades to 0.
async function fetchSkillCount(efrId) {
  try {
    const [[row]] = await pool.query(
      `SELECT COUNT(DISTINCT m.parent_skill_id) AS skill_count
         FROM tbl_efr_deepskill_mapping m
        WHERE m.easyfixer_id = ? AND m.is_repairing = 1`,
      [efrId],
    );
    return Number(row?.skill_count ?? 0);
  } catch (e) {
    logger.info({ err: e.message, efrId }, 'fetchSkillCount failed; returning 0');
    return 0;
  }
}

/*
 * Compose the profile-details payload the app expects:
 *   { efrId, name, mobile, email, city, photoUrl, rating, grade,
 *     completedJobs, skillCount, pincode, membershipType, memberSince,
 *     categories }
 *
 * The three independent reads (identity, performance, counts) plus the tiny
 * memberSince read run in a single Promise.all fan-out. Each is wrapped so one
 * failing source degrades that field gracefully rather than failing the screen.
 */
async function getProfileDetails(efrId) {
  if (!efrId) {
    const err = new Error('efrId is required');
    err.status = 400;
    throw err;
  }

  const [ident, performance, counts, extra, skillCount] = await Promise.all([
    readIdentity(efrId),
    performanceService.getForTech(efrId).catch((e) => {
      logger.warn({ err: e.message, efrId }, 'profile-details performance failed');
      return { grade: null, rating: 0 };
    }),
    jobService.getStatusCounts({ easyfixerId: efrId }).catch((e) => {
      logger.warn({ err: e.message, efrId }, 'profile-details status-counts failed');
      return { byStatus: {} };
    }),
    fetchExtraProfileFields(efrId),
    fetchSkillCount(efrId),
  ]);

  const completedJobs =
    Number(counts.byStatus?.['3'] ?? 0) + Number(counts.byStatus?.['5'] ?? 0);

  return {
    efrId:          ident?.efr_id ?? efrId,
    name:           ident?.efr_name ?? null,
    mobile:         ident?.efr_no ?? null,
    // Prefer the identity row's email if it carries one; otherwise the focused
    // tbl_easyfixer read (fetchIdentity doesn't project efr_email).
    email:          ident?.efr_email ?? extra?.efr_email ?? null,
    city:           ident?.city_name ?? null,
    photoUrl:       ident?.efr_profile_img || null,
    rating:         performance.rating ?? 0,
    grade:          performance.grade ?? null,
    completedJobs,
    skillCount:     skillCount ?? 0,
    pincode:        extra?.efr_pin_no ?? null,
    membershipType: null,           // no such column on tbl_easyfixer
    memberSince:    extra?.insert_date ?? null,
    categories:     ident?.efr_service_category
      ? String(ident.efr_service_category).split(/[,|]/).map((s) => s.trim()).filter(Boolean)
      : [],
  };
}

module.exports = { getProfileDetails };
