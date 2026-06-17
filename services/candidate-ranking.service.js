const { pool } = require('../db');
const logger = require('../logger');
const settings = require('./settings.service');
const jobService = require('./job.service');
const geocode = require('./pincode-geocode.service');

/*
 * Candidate ranking — single shared pipeline used by both:
 *   - on-create auto-assign (services/auto-assign.service.js delegates here)
 *   - operator-driven Assign / Reassign modals on /my-orders and /jobs
 *
 * Layer sequence MIRRORS the "How It Works?" panel on
 * /settings/auto-allocation:
 *
 *   L1 — Eligibility (who CAN do this job)
 *     1. Inactive (efr_status = 0)            ← excluded
 *     2. Profile not verified                  ← excluded
 *     3. Already rejected/rescheduled this job ← excluded
 *     4. Don't hold deep-skill                 ← excluded (with fallback, see below)
 *
 *   L2 — Availability (who SHOULDN'T get more work right now)
 *     1. ≥ Max Concurrent Jobs                ← excluded
 *     2. Booking conflict same date+slot      ← excluded
 *     (3. Local/Travel pincode distance — DEFERRED, ignored for now)
 *
 *   Ranking (Performance Score + Worked-for-Client + Vertical + Attendance)
 *     - Performance: Rating 30%, TAT 20%, SDA 20%
 *     - Worked-for-Client (10%)
 *     - Same-Vertical (10%)
 *     - Attendance Marked (10%)
 *
 *   Account balance: shown as informational column on the candidate row,
 *   NOT used to sort or filter the ranked list. The auto-assign commit
 *   path applies a "skip until balance >= floor" filter when the job's
 *   paid_by = 'customer' so the chosen tech can cover travel; that logic
 *   lives in pickAutoAssignCandidate() below, not in the ranking.
 *
 *   Deep-skill fallback: if ZERO techs pass the deep-skill filter, retry L1
 *   without the skill predicate and tag the result with note='no_deep_skill_match'
 *   so the modal can surface it.
 *
 * Performance:
 *   All per-tech stats are batched in parallel via Promise.all — every
 *   query is `WHERE fk_easyfixter_id IN (?, ?, …)`-shaped so MySQL can use
 *   the index on tbl_job.fk_easyfixter_id (legacy index, present on prod).
 *   See migrations/2026-05-06-candidate-ranking-indexes.sql for the full
 *   set of supporting indexes (most already exist; one new composite covers
 *   the slot-conflict query specifically).
 */

const DEFAULTS = {
  MAX_CONCURRENT_JOBS:     5,
  TRAVEL_DISTANCE_KM:      100,
  REROUTE_AFTER_MINUTES:   30,
  DEFAULT_RATING:          3.0,
  STATS_LOOKBACK_DAYS:     90,
  ACCOUNT_BALANCE_FLOOR:   500,
  // Default sub-scores for technicians with NO completed-job history in
  // the lookback window. Used as a neutral midpoint so new joiners aren't
  // pegged at 0 (unfair) or 1 (gaming). Settings keys
  // `default_tat_score` / `default_sda_score` override per environment.
  DEFAULT_TAT_SCORE:       0.5,
  DEFAULT_SDA_SCORE:       0.5,
};

// Top-level weight buckets — must sum to 1.00.
//
//   Performance bucket          = 0.70  (Rating 30 + TAT 20 + SDA 20)
//   Worked for Client           = 0.10
//   Worked in Vertical          = 0.10
//   Attendance Marked Today     = 0.10
//                                 ────
//                                 1.00
//
// No workload term — the Max Concurrent Jobs check already prevents
// saturated technicians from being scored at all (L2 filter), so a second
// workload kicker on top would double-count the same signal. The earlier
// 0.60 / 4×0.10 split was both a math error (0.60 + 0.40 = 1.0 superficially
// but Performance was meant to be 70 internal points = 0.70 share) and a
// modelling error (workload as both filter and ranker).
const SCORE_WEIGHTS = Object.freeze({
  performance:          0.70,
  worked_for_client:    0.10,
  worked_for_vertical:  0.10,
  attendance:           0.10,
});
// Inside performance: 30 / 20 / 20 split per spec, normalised to sum 1.0.
const PERFORMANCE_SUB = Object.freeze({
  rating: 30 / 70,
  tat:    20 / 70,
  sda:    20 / 70,
});

// ─── Setting resolvers (with safe fallbacks) ─────────────────────────
/*
 * Settings precedence (delegated to settings.getClientSetting):
 *   1. Per-client override   — tbl_client_setting row for (client_id, setting_id)
 *   2. Global default        — tbl_autoallocation_setting.default_value
 *   3. Built-in fallback     — the `fallback` argument in resolveInt below
 *
 * The candidate-ranking pipeline always passes `job.fk_client_id` so step 1
 * fires whenever the job has a client. Cross-client jobs (fk_client_id IS NULL)
 * skip step 1 and resolve directly to global → built-in.
 */
async function resolveInt(clientId, key, fallback) {
  try {
    const v = await settings.getClientSetting(clientId, key);
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  } catch { return fallback; }
}
async function resolveJSON(clientId, key) {
  try {
    const v = await settings.getClientSetting(clientId, key);
    if (v == null || v === '') return null;
    return typeof v === 'object' ? v : JSON.parse(v);
  } catch { return null; }
}

/*
 * Resolve the job-pincode context used by the distance/tier computation:
 *   { jobPin: '110001'|null, jobZoneIds: Set<int> }
 * jobZoneIds is the SET of zone ids the job PIN belongs to, read from the
 * many-to-many junction tbl_zone_pincode_mapping (a pincode may sit in
 * MULTIPLE zones; the vestigial scalar tbl_pincode.zone_id is NOT read).
 * Fail-soft — a missing PIN / unzoned PIN simply yields an empty set (tier
 * degrades to out_of_zone/unknown). Memo-light: called once per rank/search
 * request.
 */
async function resolveJobPincodeContext(job) {
  const jobPin = job.pin_code != null && /^[0-9]{6}$/.test(String(job.pin_code).trim())
    ? String(job.pin_code).trim()
    : null;
  const jobZoneIds = new Set();
  if (jobPin) {
    try {
      const [rows] = await pool.query(
        `SELECT DISTINCT zpm.zone_id
           FROM tbl_pincode p
           JOIN tbl_zone_pincode_mapping zpm ON zpm.pincode_id = p.pincode_id
           JOIN tbl_zone_master zm ON zm.zone_id = zpm.zone_id AND zm.zone_status = 1
          WHERE p.pincode = ?`,
        [jobPin],
      );
      for (const r of rows) if (r.zone_id != null) jobZoneIds.add(r.zone_id);
    } catch (e) {
      logger.warn({ err: e.message, jobPin }, 'candidate-ranking: job-pincode zone lookup failed');
    }
  }
  return { jobPin, jobZoneIds };
}

/*
 * Compute distance_tier + the reference pincode used for the km calc.
 *
 *   Tier1 "same_pincode"    — a serviceable pincode == job pincode.
 *                             Reference PIN = job pincode (km ≈ 0).
 *   Tier2 "current_pincode" — efr_pin_no is set + comparable to job pincode.
 *                             Reference PIN = efr_pin_no.
 *   Tier3 "in_zone"         — a serviceable pincode sits in the job's zone.
 *                             Reference PIN = that serviceable pincode.
 *   else  "out_of_zone"     — none of the above but we have SOME reference
 *                             PIN (efr_pin_no) to measure from.
 *   "unknown"               — no comparable reference PIN at all.
 *
 * Returns { tier, refPin }. refPin is the tech-side PIN to geocode against
 * the job pincode for the km value (null when unknown).
 */
function computeTierAndRefPin({ jobPin, jobZoneIds, currentPincode, servPins, servPinZoneIds }) {
  // Tier1 — serviceable contains the job pincode.
  if (jobPin && servPins.includes(jobPin)) {
    return { tier: 'same_pincode', refPin: jobPin };
  }
  // Tier2 — current pincode comparable to job pincode.
  if (jobPin && currentPincode) {
    return { tier: 'current_pincode', refPin: currentPincode };
  }
  // Tier3 — a serviceable pincode whose zone-set intersects the job's
  // zone-set (pincodes are many-to-many with zones via the junction).
  if (jobZoneIds && jobZoneIds.size) {
    const inZonePin = servPins.find((p) => {
      const zoneSet = servPinZoneIds.get(p);
      if (!zoneSet) return false;
      for (const z of zoneSet) if (jobZoneIds.has(z)) return true;
      return false;
    });
    if (inZonePin) return { tier: 'in_zone', refPin: inZonePin };
  }
  // Fallback — have a reference PIN but no tier match.
  if (currentPincode) return { tier: 'out_of_zone', refPin: currentPincode };
  if (servPins.length) return { tier: 'out_of_zone', refPin: servPins[0] };
  return { tier: 'unknown', refPin: null };
}

/*
 * Deep-skill 3-state. job-level skill requirement decides applicability.
 *   - job has NO skill requirement      → 'both_available' (not-applicable).
 *   - tech has ZERO active mappings      → 'easyfixer_skills_not_available'.
 *   - tech has mappings but none match   → 'job_skill_not_available'.
 *   - tech matches the job skill         → 'both_available'.
 */
function deepSkillStatus({ jobHasSkillReq, hasAnySkill, matchesJobSkill }) {
  if (!jobHasSkillReq) return 'both_available';
  if (!hasAnySkill) return 'easyfixer_skills_not_available';
  if (!matchesJobSkill) return 'job_skill_not_available';
  return 'both_available';
}

// ─── Layer 1: SQL eligibility ────────────────────────────────────────
/*
 * Returns rows from tbl_easyfixer that pass active + verified + reject-history
 * + (optionally) deep-skill. The `applyDeepSkill` flag is the lever for the
 * "no-skill-match fallback": first call with true; if zero rows return,
 * caller re-invokes with false and tags the result.
 */
async function l1Eligibility(job, { applyDeepSkill = true } = {}) {
  /*
   * Deep-skill match — actual schema (verified against the legacy Java
   * @Entity for tbl_efr_deepskill_mapping in API_AngularClientDashboard):
   *
   *   easyfixer_id       FK to tbl_easyfixer.efr_id (NOT named "efr_id")
   *   category_id        service category for THIS mapping row
   *   service_type_id    service type for THIS mapping row
   *   parent_skill_id    legacy: deep_skill_id (semantic name confusion)
   *   deep_skill_id      legacy: option_id     (semantic name confusion)
   *   is_repairing       active flag (1 = active, 0 = inactive)
   *
   * The legacy auto-assign.service.js had a `JOIN tbl_deep_skill ds`
   * referencing `m.deepskill_id` — that column doesn't exist on the
   * mapping table; it failed at request time. The category/service-type
   * match is done inline from the mapping row's own columns. We DO touch
   * tbl_deep_skill, but only to EXCLUDE mappings whose deep skill is
   * INACTIVE (status=0) — via the CORRECT column `m.parent_skill_id`
   * (which holds the deepskill_id). `NOT EXISTS(status=0)` keeps active +
   * any orphan rows, so a deactivated/deleted deep skill stops crediting
   * technicians without over-pruning legacy data.
   */
  const skillClauses = [];
  const skillParams  = [];
  if (applyDeepSkill && (job.fk_service_catg_id || job.fk_service_type_id)) {
    let predicate = `EXISTS (
      SELECT 1
        FROM tbl_efr_deepskill_mapping m
       WHERE m.easyfixer_id = e.efr_id
         AND m.is_repairing = 1
         AND NOT EXISTS (
           SELECT 1 FROM tbl_deep_skill ds
            WHERE ds.deepskill_id = m.parent_skill_id AND ds.status = 0
         )`;
    if (job.fk_service_catg_id) { predicate += ' AND m.category_id = ?';     skillParams.push(job.fk_service_catg_id); }
    if (job.fk_service_type_id) { predicate += ' AND m.service_type_id = ?'; skillParams.push(job.fk_service_type_id); }
    predicate += ')';
    skillClauses.push(predicate);
  }
  const skillSql = skillClauses.length ? ` AND ${skillClauses.join(' AND ')}` : '';

  // City filter — same city as the job. Zone-distance L2 (Local/Travel km
  // cap) is deferred per spec; we keep the city scope so cross-country
  // assignments don't appear by mistake.
  //
  // Column note: balance lives on `tbl_easyfixer.current_balance` (legacy
  // schema; same column the Finance dashboard reads). The earlier draft of
  // this service named it `efr_balance` and 500'd at request time — fixed.
  const [rows] = await pool.query(
    `SELECT e.efr_id, e.efr_name, e.efr_no, e.efr_email,
            e.efr_cityId, c.city_name,
            e.current_balance,
            e.is_technician_verified
       FROM tbl_easyfixer e
       LEFT JOIN tbl_city c ON c.city_id = e.efr_cityId
      WHERE e.efr_status = 1
        AND e.is_technician_verified = 1
        AND e.efr_cityId = ?
        ${skillSql}
        AND e.efr_id NOT IN (
          SELECT sh.easyfixer_id FROM scheduling_history sh
           WHERE sh.job_id = ?
             AND sh.reschedule_reason IS NOT NULL
             AND sh.reschedule_reason <> ''
        )`,
    [job.city_id, ...skillParams, job.job_id]
  );
  return rows;
}

// ─── Layer 2 + ranking stats ─────────────────────────────────────────
async function statsForCandidates(efrIds, job, clientId) {
  if (efrIds.length === 0) return new Map();
  const placeholders = efrIds.map(() => '?').join(',');
  const lookback = DEFAULTS.STATS_LOOKBACK_DAYS;

  // Pre-build the deep-skill match query — same predicate as the L1
  // EXISTS clause but returning the matched easyfixer_ids. We surface
  // this as a per-candidate `has_deep_skill` flag so the modal can show
  // a check/X icon. Even when the fallback fires (zero matches), the
  // query still returns 0 rows — every candidate gets has_deep_skill=false.
  const jobHasSkillReq = !!(job.fk_service_catg_id || job.fk_service_type_id);
  let deepSkillQuery;
  if (jobHasSkillReq) {
    let sql = `SELECT DISTINCT m.easyfixer_id AS efr_id
                 FROM tbl_efr_deepskill_mapping m
                WHERE m.easyfixer_id IN (${placeholders})
                  AND m.is_repairing = 1
                  AND NOT EXISTS (
                    SELECT 1 FROM tbl_deep_skill ds
                     WHERE ds.deepskill_id = m.parent_skill_id AND ds.status = 0
                  )`;
    const params = [...efrIds];
    if (job.fk_service_catg_id) { sql += ' AND m.category_id = ?';     params.push(job.fk_service_catg_id); }
    if (job.fk_service_type_id) { sql += ' AND m.service_type_id = ?'; params.push(job.fk_service_type_id); }
    deepSkillQuery = pool.query(sql, params);
  } else {
    // No skill criteria on the job — every tech trivially "matches".
    deepSkillQuery = Promise.resolve([efrIds.map((id) => ({ efr_id: id }))]);
  }

  // For the 3-state deep_skill_status we also need to know which techs have
  // ANY active deep-skill mapping at all (independent of THIS job's skill) —
  // that separates "easyfixer has no skills on file" from "has skills, but
  // none match this job".
  const anySkillQuery = jobHasSkillReq
    ? pool.query(
        `SELECT DISTINCT m.easyfixer_id AS efr_id
           FROM tbl_efr_deepskill_mapping m
          WHERE m.easyfixer_id IN (${placeholders})
            AND m.is_repairing = 1
            AND NOT EXISTS (
              SELECT 1 FROM tbl_deep_skill ds
               WHERE ds.deepskill_id = m.parent_skill_id AND ds.status = 0
            )`,
        [...efrIds],
      )
    : Promise.resolve([[]]);

  // Resolved settings + ALL per-tech stat queries fire in parallel.
  // Each query is independently `WHERE fk_easyfixter_id IN (...)` shaped, so
  // MySQL parallelises across the connection-pool's free connections (we
  // sized the pool at 20). Tail-latency for the 7-query batch is
  // max(query_i), not sum(query_i) — typically ~150ms vs ~600ms sequential
  // on the 384k-row tbl_job.
  // dateStrings:true (db.js) delivers requested_date_time as the IST
  // literal 'YYYY-MM-DD HH:mm:ss' — take the date prefix directly.
  // Round-tripping through new Date().toISOString() is server-TZ-dependent
  // and shifts the day on non-UTC servers (violates the TZ-agnostic
  // invariant documented in job.service.js IST helpers).
  const reqDate = job.requested_date_time
    ? String(job.requested_date_time).slice(0, 10)
    : null;

  const [
    maxConcurrent,
    defaultRating,
    defaultTatScore,
    defaultSdaScore,
    tatTierJson,
    [activeRows],
    [completedRows],
    conflictRowsResult,
    [ratingRows],
    [tatRows],
    [sdaRows],
    workedClientRowsResult,
    workedVerticalRowsResult,
    attRowsResult,
    deepSkillResult,
    anySkillResult,
    baseRowsResult,
    servPinRowsResult,
    concurrentRowsResult,
    techZoneRowsResult,
  ] = await Promise.all([
    resolveInt(clientId,  'max_concurrent_jobs',  DEFAULTS.MAX_CONCURRENT_JOBS),
    resolveInt(clientId,  'default_rating_value', DEFAULTS.DEFAULT_RATING),
    resolveInt(clientId,  'default_tat_score',    DEFAULTS.DEFAULT_TAT_SCORE),
    resolveInt(clientId,  'default_sda_score',    DEFAULTS.DEFAULT_SDA_SCORE),
    resolveJSON(clientId, 'tat_service_catg_tier'),

    // Active jobs (status 0/1/2)
    pool.query(
      `SELECT fk_easyfixter_id AS efr_id, COUNT(*) AS active_jobs
         FROM tbl_job
        WHERE fk_easyfixter_id IN (${placeholders})
          AND job_status IN (0, 1, 2)
        GROUP BY fk_easyfixter_id`,
      efrIds
    ),

    // Completed jobs till now (2026-06-17) — "Fresher" flag source. DISTINCT
    // COMPLETED jobs (status 3/5), mirroring the Manage Easyfixers job_count
    // column so the chip means the same thing on both surfaces.
    // job_count < 5 => Fresher chip in the Top 10 / Search candidate list.
    pool.query(
      `SELECT fk_easyfixter_id AS efr_id, COUNT(DISTINCT job_id) AS job_count
         FROM tbl_job
        WHERE fk_easyfixter_id IN (${placeholders})
          AND job_status IN (3, 5)
        GROUP BY fk_easyfixter_id`,
      efrIds
    ),

    // Same-day + same-slot conflict (the HARD-FILTER signal). Scoped to the
    // PROPOSED job date (reqDate) + slot, regardless of Max-Concurrent.
    reqDate && job.time_slot
      ? pool.query(
          `SELECT DISTINCT fk_easyfixter_id AS efr_id
             FROM tbl_job
            WHERE fk_easyfixter_id IN (${placeholders})
              AND DATE(requested_date_time) = ?
              AND time_slot = ?
              AND job_status IN (0, 1, 2)`,
          [...efrIds, reqDate, job.time_slot]
        )
      : Promise.resolve([[]]),

    // 90d rating
    pool.query(
      `SELECT easyfixer_id AS efr_id, AVG(customer_rating) AS avg_rating, COUNT(*) AS rating_count
         FROM tbl_easyfixer_rating_by_customer
        WHERE easyfixer_id IN (${placeholders})
          AND insert_date_time >= DATE_SUB(NOW(), INTERVAL ${lookback} DAY)
        GROUP BY easyfixer_id`,
      efrIds
    ),

    // TAT (avg checkout - scheduled hours, completed jobs only)
    pool.query(
      `SELECT fk_easyfixter_id AS efr_id,
              AVG(TIMESTAMPDIFF(HOUR, scheduled_date_time, checkout_date_time)) AS avg_tat_hours,
              COUNT(*) AS tat_count
         FROM tbl_job
        WHERE fk_easyfixter_id IN (${placeholders})
          AND job_status IN (3, 5)
          AND scheduled_date_time IS NOT NULL
          AND checkout_date_time  IS NOT NULL
          AND created_date_time >= DATE_SUB(NOW(), INTERVAL ${lookback} DAY)
        GROUP BY fk_easyfixter_id`,
      efrIds
    ),

    // SDA — same-day-attempt rate; checkin date == requested date.
    // SUM in a CASE counts the SDA hits; total attempts is the row count.
    pool.query(
      `SELECT fk_easyfixter_id AS efr_id,
              SUM(CASE WHEN DATE(checkin_date_time) = DATE(requested_date_time) THEN 1 ELSE 0 END) AS sda,
              SUM(CASE WHEN job_status IN (2, 3, 5) THEN 1 ELSE 0 END) AS attempted
         FROM tbl_job
        WHERE fk_easyfixter_id IN (${placeholders})
          AND job_status IN (2, 3, 5)
          AND created_date_time >= DATE_SUB(NOW(), INTERVAL ${lookback} DAY)
        GROUP BY fk_easyfixter_id`,
      efrIds
    ),

    // Worked-for-this-client before?
    job.fk_client_id
      ? pool.query(
          `SELECT DISTINCT fk_easyfixter_id AS efr_id
             FROM tbl_job
            WHERE fk_easyfixter_id IN (${placeholders})
              AND fk_client_id = ?
              AND job_status IN (3, 5)`,
          [...efrIds, job.fk_client_id]
        )
      : Promise.resolve([[]]),

    // Worked-for-this-vertical before?
    job.fk_service_catg_id
      ? pool.query(
          `SELECT DISTINCT fk_easyfixter_id AS efr_id
             FROM tbl_job
            WHERE fk_easyfixter_id IN (${placeholders})
              AND fk_service_catg_id = ?
              AND job_status IN (3, 5)`,
          [...efrIds, job.fk_service_catg_id]
        )
      : Promise.resolve([[]]),

    // Attendance for the JOB DATE — green tick ONLY when a row exists for
    // DATE(jobDate) that marks the tech present. Canonical "present" def
    // (matches services/easyfixer.service.js, verified against live DB):
    //   (morning_slot = 1 OR evening_slot = 1) AND NOT on leave.
    // FK is `easyfixer_id` and the date column is `created_on` (NOT
    // efr_id/attendance_date — those don't exist on the live table). When
    // reqDate is null (no schedule at all) nobody can be present → []. Future
    // dates with no row also return [] → red cross, per the locked decision.
    // Fail-soft: a schema/table mismatch yields [] (everyone red) rather than
    // erroring the whole list.
    reqDate
      ? pool.query(
          `SELECT DISTINCT easyfixer_id AS efr_id
             FROM tbl_easyfixer_attendance
            WHERE easyfixer_id IN (${placeholders})
              AND DATE(created_on) = ?
              AND (morning_slot = 1 OR evening_slot = 1)
              AND (is_leave_marked IS NULL OR is_leave_marked = 0)`,
          [...efrIds, reqDate]
        ).catch((e) => { logger.warn({ err: e.message }, 'candidate-ranking: attendance-for-job-date query failed; treating all as absent'); return [[]]; })
      : Promise.resolve([[]]),

    // Deep-skill match per tech (built above so the SQL stays readable).
    deepSkillQuery,

    // Has ANY active deep-skill mapping (for the 3-state status).
    anySkillQuery,

    // Tech base fields — current pincode (efr_pin_no) + zone FK
    // (efr_zone_city_id). efr_pin_no EXISTS on the physical table even
    // though it's absent from the Java entity subset (locked decision).
    pool.query(
      `SELECT e.efr_id, e.efr_pin_no, e.efr_zone_city_id
         FROM tbl_easyfixer e
        WHERE e.efr_id IN (${placeholders})`,
      efrIds
    ),

    // Serviceable pincodes — comma-separated TEXT per tech. Split to array
    // by the caller. Fail-soft if the table is absent on this deploy.
    pool.query(
      `SELECT easyfixer_id AS efr_id, pincodes
         FROM tbl_efr_serviceable_pincodes
        WHERE easyfixer_id IN (${placeholders})`,
      efrIds
    ).catch((e) => { logger.warn({ err: e.message }, 'candidate-ranking: serviceable-pincodes query failed'); return [[]]; }),

    // Concurrent jobs scoped to the PROPOSED job date (active statuses only).
    reqDate
      ? pool.query(
          `SELECT fk_easyfixter_id AS efr_id, COUNT(*) AS cnt
             FROM tbl_job
            WHERE fk_easyfixter_id IN (${placeholders})
              AND DATE(requested_date_time) = ?
              AND job_status IN (0, 1, 2)
            GROUP BY fk_easyfixter_id`,
          [...efrIds, reqDate]
        )
      : Promise.resolve([[]]),

    // Tech zone name via the canonical chain:
    //   efr_zone_city_id → tbl_zone_city_mapping.city_zone_id → zone_id
    //   → tbl_zone_master.zone_name.
    // (Job-pincode zone is resolved separately in resolveJobPincodeContext.)
    pool.query(
      `SELECT e.efr_id, zm.zone_id, zm.zone_name
         FROM tbl_easyfixer e
         LEFT JOIN tbl_zone_city_mapping zcm ON zcm.city_zone_id = e.efr_zone_city_id
         LEFT JOIN tbl_zone_master zm        ON zm.zone_id = zcm.zone_id AND zm.zone_status = 1
        WHERE e.efr_id IN (${placeholders})`,
      efrIds
    ).catch((e) => { logger.warn({ err: e.message }, 'candidate-ranking: tech-zone query failed'); return [[]]; }),
  ]);

  // Build maps from the parallel results.
  const activeMap = new Map(activeRows.map((r) => [r.efr_id, Number(r.active_jobs)]));
  const completedMap = new Map(completedRows.map((r) => [r.efr_id, Number(r.job_count)]));
  const conflictMap = new Map();
  for (const r of (conflictRowsResult[0] || [])) conflictMap.set(r.efr_id, true);
  const ratingMap = new Map(ratingRows.map((r) => [r.efr_id, Number(r.avg_rating)]));
  // TAT & SDA: keep BOTH the metric AND a `has_history` flag so we can show
  // "No Completed Jobs" in the UI versus a real 0% / 0h reading.
  const tatMap = new Map(tatRows.map((r) => [r.efr_id, { hours: Number(r.avg_tat_hours), count: Number(r.tat_count) }]));
  const sdaMap = new Map();
  for (const r of sdaRows) {
    const att = Number(r.attempted);
    if (att > 0) sdaMap.set(r.efr_id, { rate: Number(r.sda) / att, attempts: att });
  }
  const workedClientMap = new Map();
  for (const r of (workedClientRowsResult[0] || [])) workedClientMap.set(r.efr_id, true);
  const workedVerticalMap = new Map();
  for (const r of (workedVerticalRowsResult[0] || [])) workedVerticalMap.set(r.efr_id, true);
  const attendanceMap = new Map((attRowsResult[0] || []).map((r) => [r.efr_id, true]));
  const deepSkillMap  = new Map((deepSkillResult[0] || []).map((r) => [r.efr_id, true]));
  const anySkillMap   = new Map((anySkillResult[0] || []).map((r) => [r.efr_id, true]));

  // Tech base fields — current pincode + zone FK.
  const baseMap = new Map();
  for (const r of (baseRowsResult[0] || [])) {
    baseMap.set(r.efr_id, {
      current_pincode: r.efr_pin_no != null && String(r.efr_pin_no).trim() !== '' ? String(r.efr_pin_no).trim() : null,
      zone_city_id:    r.efr_zone_city_id ?? null,
    });
  }

  // Serviceable pincodes — comma-separated TEXT → de-duped array of strings.
  const servPinMap = new Map();
  for (const r of (servPinRowsResult[0] || [])) {
    const arr = String(r.pincodes ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^[0-9]{6}$/.test(s));
    servPinMap.set(r.efr_id, [...new Set(arr)]);
  }

  // Concurrent jobs scoped to the proposed job date.
  const concurrentMap = new Map((concurrentRowsResult[0] || []).map((r) => [r.efr_id, Number(r.cnt)]));

  // Tech zone name (via efr_zone_city_id chain).
  const techZoneMap = new Map();
  for (const r of (techZoneRowsResult[0] || [])) {
    techZoneMap.set(r.efr_id, { zone_id: r.zone_id ?? null, zone_name: r.zone_name ?? null });
  }

  // ── Distance / tier prep (job-level, computed once) ──────────────
  // 1. Job-pincode context: job PIN + its zone-set (for Tier3 "in_zone").
  const { jobPin, jobZoneIds } = await resolveJobPincodeContext(job);

  // 2. Zone-set for every distinct serviceable pincode across all techs — used
  //    to decide Tier3. One batched lookup against the many-to-many junction
  //    tbl_zone_pincode_mapping (a pincode may belong to MULTIPLE zones; the
  //    vestigial scalar tbl_pincode.zone_id is NOT read).
  const allServPins = new Set();
  for (const arr of servPinMap.values()) for (const p of arr) allServPins.add(p);
  const servPinZoneIds = new Map(); // pincode → Set<zone_id>
  if (allServPins.size) {
    try {
      const pins = [...allServPins];
      const [rows] = await pool.query(
        `SELECT p.pincode, zpm.zone_id
           FROM tbl_pincode p
           JOIN tbl_zone_pincode_mapping zpm ON zpm.pincode_id = p.pincode_id
           JOIN tbl_zone_master zm ON zm.zone_id = zpm.zone_id AND zm.zone_status = 1
          WHERE p.pincode IN (${pins.map(() => '?').join(',')})`,
        pins,
      );
      for (const r of rows) {
        if (r.zone_id == null) continue;
        const key = String(r.pincode);
        let set = servPinZoneIds.get(key);
        if (!set) { set = new Set(); servPinZoneIds.set(key, set); }
        set.add(r.zone_id);
      }
    } catch (e) {
      logger.warn({ err: e.message }, 'candidate-ranking: serviceable-pincode zone batch lookup failed');
    }
  }

  // 3. Pre-compute per-tech tier + reference PIN, then batch-geocode the job
  //    PIN + every distinct reference PIN so the haversine has centroids.
  const tierByTech = new Map();   // efr_id → { tier, refPin }
  const pinsToGeocode = new Set();
  if (jobPin) pinsToGeocode.add(jobPin);
  for (const id of efrIds) {
    const base = baseMap.get(id) || {};
    const servPins = servPinMap.get(id) || [];
    const tr = computeTierAndRefPin({
      jobPin, jobZoneIds,
      currentPincode: base.current_pincode ?? null,
      servPins,
      servPinZoneIds,
    });
    tierByTech.set(id, tr);
    if (tr.refPin) pinsToGeocode.add(tr.refPin);
  }
  // Batch geocode (cache-first; never blocks the list — missing centroids
  // just yield distance_km = null).
  const centroids = await geocode.getCentroids([...pinsToGeocode]);
  const jobCentroid = jobPin ? (centroids.get(jobPin) ?? null) : null;

  // TAT target for THIS job — looks up tat_service_catg_tier JSON by
  // (service_catg_id, city tier). Shape expected (lenient parsing):
  //   {
  //     "<service_catg_id>": { "1": 24, "2": 48, "3": 72 },   // hours per tier
  //     "default": 48
  //   }
  let tatTargetHours = 48;
  if (tatTierJson && job.fk_service_catg_id) {
    const byCatg = tatTierJson[String(job.fk_service_catg_id)];
    if (byCatg) {
      const tier = job.city_tier ?? 'default';
      tatTargetHours = Number(byCatg[String(tier)] ?? byCatg.default ?? tatTierJson.default ?? 48);
    } else if (tatTierJson.default) {
      tatTargetHours = Number(tatTierJson.default);
    }
  }

  // Merge per-tech. The `tat_history`/`sda_history` flags let scoreOne and
  // the UI distinguish "no completed jobs" (use configured default + show
  // a placeholder) from a genuine 0% reading (use 0 + show actual value).
  const out = new Map();
  for (const id of efrIds) {
    const tatRow = tatMap.get(id);
    const sdaRow = sdaMap.get(id);
    const base = baseMap.get(id) || {};
    const servPins = servPinMap.get(id) || [];
    const tr = tierByTech.get(id) || { tier: 'unknown', refPin: null };

    // distance_km: haversine between job centroid + reference-PIN centroid.
    // same_pincode collapses to ~0 (same PIN). Any missing centroid → null.
    let distanceKm = null;
    if (jobCentroid && tr.refPin) {
      if (tr.tier === 'same_pincode') {
        distanceKm = 0;
      } else {
        const refCentroid = centroids.get(tr.refPin) ?? null;
        distanceKm = geocode.haversineKm(jobCentroid, refCentroid);
      }
    }

    // Deep-skill 3-state + bool.
    const matchesJobSkill = deepSkillMap.get(id) === true;
    const hasAnySkill = jobHasSkillReq ? (anySkillMap.get(id) === true) : true;
    const skillStatus = deepSkillStatus({ jobHasSkillReq, hasAnySkill, matchesJobSkill });

    const techZone = techZoneMap.get(id) || {};

    out.set(id, {
      active_jobs:        activeMap.get(id) ?? 0,
      job_count:          completedMap.get(id) ?? 0, // completed jobs; "Fresher" when < 5
      has_conflict:       conflictMap.get(id) === true,
      avg_rating:         ratingMap.get(id) ?? defaultRating,
      avg_tat_hours:      tatRow ? tatRow.hours : null,
      tat_history:        tatRow ? tatRow.count > 0 : false,
      sda_rate:           sdaRow ? sdaRow.rate : null,
      sda_history:        !!sdaRow,
      worked_for_client:  workedClientMap.get(id) === true,
      worked_for_vertical:workedVerticalMap.get(id) === true,
      attendance_marked:  attendanceMap.get(id) === true,
      has_deep_skill:     matchesJobSkill,
      tat_target_hours:   tatTargetHours,
      max_concurrent:     maxConcurrent,
      // Defaults travel through to scoreOne so per-job overrides work.
      default_tat_score:  Number(defaultTatScore) || DEFAULTS.DEFAULT_TAT_SCORE,
      default_sda_score:  Number(defaultSdaScore) || DEFAULTS.DEFAULT_SDA_SCORE,

      // ── Schedule & Assign widened fields ──
      current_pincode:        base.current_pincode ?? null,
      serviceable_pincodes:   servPins,
      zone_name:              techZone.zone_name ?? null,
      distance_km:            distanceKm == null ? null : Number(distanceKm.toFixed(1)),
      distance_tier:          tr.tier,
      attendance_for_job_date: attendanceMap.get(id) === true,
      deep_skill_status:      skillStatus,
      deep_skill_match:       matchesJobSkill,
      worked_in_category:     workedVerticalMap.get(id) === true,
      concurrent_jobs_count:  concurrentMap.get(id) ?? 0,
      same_slot_conflict:     conflictMap.get(id) === true,
    });
  }
  return out;
}

// ─── Per-signal scoring ──────────────────────────────────────────────
function scoreOne({ avg_rating, avg_tat_hours, tat_history,
                    sda_rate, sda_history,
                    worked_for_client, worked_for_vertical, attendance_marked,
                    tat_target_hours, default_tat_score, default_sda_score }) {
  // Rating: 0–5 → 0–1.
  const rating = Math.max(0, Math.min(1, (avg_rating ?? 3.0) / 5));

  // TAT: configured default if no completed-job history; else
  // 1 when avg ≤ target, decays linearly to 0 at 2× target.
  let tat;
  if (!tat_history || tat_target_hours <= 0) {
    tat = default_tat_score;
  } else {
    const ratio = avg_tat_hours / tat_target_hours;
    tat = Math.max(0, Math.min(1, 1 - Math.max(0, ratio - 1)));
  }

  // SDA: configured default if no completed-job history; else the actual rate.
  const sda = sda_history ? (sda_rate ?? 0) : default_sda_score;

  const performance =
    PERFORMANCE_SUB.rating * rating +
    PERFORMANCE_SUB.tat    * tat +
    PERFORMANCE_SUB.sda    * sda;

  const total =
    SCORE_WEIGHTS.performance         * performance +
    SCORE_WEIGHTS.worked_for_client   * (worked_for_client   ? 1 : 0) +
    SCORE_WEIGHTS.worked_for_vertical * (worked_for_vertical ? 1 : 0) +
    SCORE_WEIGHTS.attendance          * (attendance_marked   ? 1 : 0);

  // Letter grade per spec.
  const pct = Math.round(performance * 100);
  let grade;
  if (pct >= 95) grade = 'A+';
  else if (pct >= 90) grade = 'A';
  else if (pct >= 80) grade = 'B';
  else if (pct >= 70) grade = 'C';
  else if (pct >= 60) grade = 'D';
  else grade = 'E';

  return {
    total,
    grade,
    performance,
    breakdown: {
      rating, tat, sda,
      worked_for_client:   worked_for_client   ? 1 : 0,
      worked_for_vertical: worked_for_vertical ? 1 : 0,
      attendance:          attendance_marked   ? 1 : 0,
    },
  };
}

// ─── Shared candidate-row builder ─────────────────────────────────────
/*
 * Builds ONE widened candidate row from a tech profile + its stats entry.
 * Used by BOTH rankCandidatesForJob (top-10) and searchTechniciansForJob
 * (match-anyone) so the column shape is identical across the two surfaces.
 *
 *   tech  — { efr_id, efr_name, efr_no, efr_email, city_name, current_balance }
 *   s     — the stats entry from statsForCandidates() for this efr_id
 *   job   — the job row (for payment_mode label)
 */
function buildCandidateRow(tech, s, job) {
  const out = scoreOne({
    avg_rating:          s.avg_rating,
    avg_tat_hours:       s.avg_tat_hours,
    tat_history:         s.tat_history,
    sda_rate:            s.sda_rate,
    sda_history:         s.sda_history,
    worked_for_client:   s.worked_for_client,
    worked_for_vertical: s.worked_for_vertical,
    attendance_marked:   s.attendance_marked,
    tat_target_hours:    s.tat_target_hours,
    default_tat_score:   s.default_tat_score,
    default_sda_score:   s.default_sda_score,
  });
  return {
    efr_id:        tech.efr_id,
    efr_name:      tech.efr_name,
    efr_no:        tech.efr_no,
    // `mobile` mirrors efr_no — masked automatically by middleware/mask-mobile.
    mobile:        tech.efr_no,
    efr_email:     tech.efr_email,
    city_name:     tech.city_name,
    current_balance: Number(tech.current_balance ?? 0),
    account_balance: Number(tech.current_balance ?? 0),
    active_jobs:   s.active_jobs,
    job_count:     s.job_count ?? 0, // completed jobs; "Fresher" chip when < 5
    avg_rating:    Number((s.avg_rating ?? 0).toFixed(2)),
    avg_tat_hours: s.avg_tat_hours == null ? null : Number(s.avg_tat_hours.toFixed(1)),
    tat_history:   s.tat_history,
    sda_rate:      s.sda_rate == null ? null : Number(s.sda_rate.toFixed(2)),
    sda_history:   s.sda_history,
    worked_for_client:   s.worked_for_client,
    worked_for_vertical: s.worked_for_vertical,
    has_deep_skill:      s.has_deep_skill,
    // ── Schedule & Assign widened columns ──
    current_pincode:        s.current_pincode ?? null,
    zone_name:              s.zone_name ?? null,
    serviceable_pincodes:   s.serviceable_pincodes ?? [],
    distance_km:            s.distance_km ?? null,
    distance_tier:          s.distance_tier ?? 'unknown',
    attendance_for_job_date: s.attendance_for_job_date === true,
    deep_skill_status:      s.deep_skill_status ?? 'both_available',
    deep_skill_match:       s.deep_skill_match === true,
    worked_in_category:     s.worked_in_category === true,
    payment_mode:           paidByLabel(job.paid_by),
    concurrent_jobs_count:  s.concurrent_jobs_count ?? 0,
    same_slot_conflict:     s.same_slot_conflict === true,
    // ── Existing score/grade fields ──
    score:        Number(out.total.toFixed(4)),
    performance:  Number(out.performance.toFixed(4)),
    grade:        out.grade,
    breakdown:    Object.fromEntries(Object.entries(out.breakdown).map(([k, v]) => [k, Number(Number(v).toFixed(3))])),
  };
}

// ─── Public entrypoint ───────────────────────────────────────────────
/*
 * Returns:
 *   {
 *     job: { … },
 *     alreadyAssigned: bool,
 *     note: 'no_deep_skill_match' | null,
 *     l1Count, l2Count, candidates: [...],
 *     config: { weights, max_concurrent, … },
 *     rejected: [{ efr_id, reason }]
 *   }
 *
 * Each candidate row carries everything the modal needs: name, location,
 * active_jobs, efr_balance, per-signal sub-scores, total score, grade.
 *
 * Options:
 *   limit     — top-N cap (default 10 for the Schedule & Assign modal).
 *   jobDate   — ISO override of the job's requested_date_time. When the ops
 *               user edits the schedule in section (a), the FE re-requests
 *               with the proposed date so attendance / concurrent / same-slot
 *               recompute against the PROPOSED schedule.
 *   timeSlot  — slot override (paired with jobDate).
 * Both default to the job row's requested_date_time / time_slot when omitted.
 *
 *   enforceMaxConcurrent — hard-exclude techs at/over Max-Concurrent-Jobs.
 *                          DEFAULT true (preserves legacy auto-assign
 *                          behaviour). The Schedule & Assign modal passes
 *                          FALSE — per the contract, concurrent count is a
 *                          DISPLAYED column there, not a hard filter.
 *   enforceCodBalance    — hard-exclude techs with balance <= floor when the
 *                          job is COD. DEFAULT false (legacy auto-assign
 *                          applies the floor POST-rank via
 *                          pickAutoAssignCandidate, not as a ranked-list
 *                          exclude). The Schedule & Assign modal passes TRUE.
 * The same-day + same-slot conflict is ALWAYS a hard exclude (unchanged).
 */
async function rankCandidatesForJob(jobId, {
  limit = 10, jobDate, timeSlot,
  enforceMaxConcurrent = true, enforceCodBalance = false,
} = {}) {
  const job = await jobService.getById(jobId);
  if (!job) {
    const err = new Error('job not found'); err.status = 404; throw err;
  }
  const alreadyAssigned = !!job.fk_easyfixter_id;
  const assignedEfrId = alreadyAssigned ? Number(job.fk_easyfixter_id) : null;

  // Apply proposed-schedule overrides so attendance / concurrent / same-slot
  // (computed in statsForCandidates against job.requested_date_time +
  // job.time_slot) recompute against what the ops user is about to set. When
  // omitted, fall back to the job's current schedule. dateStrings:true keeps
  // the value as the IST literal; slice to date-only for DATE() comparisons.
  if (jobDate) job.requested_date_time = jobDate;
  if (timeSlot !== undefined && timeSlot !== null && timeSlot !== '') job.time_slot = timeSlot;

  /*
   * Resolve human labels for the job's service category + type so the
   * Assign / Reassign modal header can display the actual deep-skill
   * the job needs (not just a service_category_id). Single round-trip
   * with two scalar subqueries — both are PK lookups, sub-ms each.
   * Returns nulls if the job has no assigned category/type.
   *
   * Also resolves the service_type_name via a scalar subquery since the
   * getById JOIN only adds tbl_service_type on tbl_job_services (not on
   * the job row itself for fk_service_type_id).
   */
  let deepSkillLabel = null;
  let serviceTypeName = null;
  if (job.fk_service_catg_id || job.fk_service_type_id) {
    const [[labels]] = await pool.query(
      `SELECT
         (SELECT service_catg_name FROM tbl_service_catg WHERE service_catg_id = ?) AS catg_name,
         (SELECT service_type_name FROM tbl_service_type WHERE service_type_id = ?) AS type_name`,
      [job.fk_service_catg_id || 0, job.fk_service_type_id || 0]
    );
    // "Carpentry > Wood Repair" if both present, else whichever's set.
    deepSkillLabel = [labels?.catg_name, labels?.type_name].filter(Boolean).join(' › ') || null;
    serviceTypeName = labels?.type_name ?? null;
  }

  // Pre-build the enriched job payload used in ALL return paths (early-exit
  // on zero-eligible and the normal ranked return).
  const enrichedJob = {
    job_id:            job.job_id,
    fk_client_id:      job.fk_client_id,
    customer_name:     job.customer_name    ?? null,
    customer_mob_no:   job.customer_mob_no  ?? null,
    client_name:       job.client_name      ?? null,
    client_ref_id:     job.client_ref_id    ?? null,
    address:           job.address          ?? null,
    city_id:           job.city_id          ?? null,
    city_name:         job.city_name        ?? null,
    pin_code:          job.pin_code         ?? null,
    service_category:  job.service_category ?? null,
    service_type:      serviceTypeName      ?? null,
    deep_skill_label:  deepSkillLabel       ?? null,
    job_type:          job.job_type         ?? null,
    payment_mode:      paidByLabel(job.paid_by),
    requested_date_time: job.requested_date_time ?? null,
    time_slot:         job.time_slot        ?? null,
    job_desc:          job.job_desc         ?? null,
    paid_by:           job.paid_by          ?? null,
    paid_by_label:     paidByLabel(job.paid_by),
    assigned_efr_id:   assignedEfrId,
  };

  // L1 with deep-skill on; fallback if 0.
  let eligible = await l1Eligibility(job, { applyDeepSkill: true });
  let note = null;
  if (eligible.length === 0 && (job.fk_service_catg_id || job.fk_service_type_id)) {
    eligible = await l1Eligibility(job, { applyDeepSkill: false });
    if (eligible.length > 0) note = 'no_deep_skill_match';
  }

  if (eligible.length === 0) {
    return {
      job: enrichedJob, alreadyAssigned, note: note ?? 'no_eligible_techs',
      l1Count: 0, l2Count: 0, candidates: [], rejected: [],
      config: { weights: SCORE_WEIGHTS, performance_sub: PERFORMANCE_SUB },
    };
  }

  const stats = await statsForCandidates(eligible.map((e) => e.efr_id), job, job.fk_client_id);

  // COD = customer pays the tech on-site (paid_by = Customer). Such techs
  // need cash on hand → optionally hard-filter balance > floor.
  const isCod = paidByIsCustomer(job.paid_by);
  const balanceFloor = DEFAULTS.ACCOUNT_BALANCE_FLOOR;

  // ── HARD FILTERS (exclude before ranking) ──
  //   1. active + verified                 (already enforced by l1Eligibility)
  //   2. NOT same-day + same-slot booked    (ALWAYS — regardless of options)
  //   3. at/over Max-Concurrent             (only when enforceMaxConcurrent)
  //   4. COD → account balance > floor      (only when enforceCodBalance)
  // The Schedule & Assign modal passes enforceMaxConcurrent:false +
  // enforceCodBalance:true (so concurrent is a displayed column + COD is a
  // hard floor); auto-assign keeps the legacy defaults.
  const scored = [];
  const rejected = [];
  for (const e of eligible) {
    const s = stats.get(e.efr_id);

    if (s.same_slot_conflict) {
      rejected.push({ efr_id: e.efr_id, efr_name: e.efr_name, reason: 'already booked same day + same slot' }); continue;
    }
    if (enforceMaxConcurrent && s.active_jobs >= s.max_concurrent) {
      rejected.push({ efr_id: e.efr_id, efr_name: e.efr_name, reason: `saturated (${s.active_jobs} active jobs)` }); continue;
    }
    if (enforceCodBalance && isCod && Number(e.current_balance ?? 0) <= balanceFloor) {
      rejected.push({ efr_id: e.efr_id, efr_name: e.efr_name, reason: `COD job: balance ${Number(e.current_balance ?? 0)} <= ${balanceFloor}` }); continue;
    }

    scored.push(buildCandidateRow(e, s, job));
  }

  // Pure ranking sort: highest score first. Balance is shown as a column;
  // not factored into the sort.
  scored.sort((a, b) => b.score - a.score);

  // If the job already has an assigned technician (Reassign mode), pin
  // them at the top of the list so operators can compare current vs.
  // potential replacements side-by-side. The assigned tech may have been
  // filtered out by L1 (e.g. they already rescheduled this job earlier)
  // or L2 (saturated since the original assignment) — in either case we
  // re-fetch their stats and present them with `is_current = true` so the
  // UI can render the row distinctly.
  let candidatesList = scored.slice(0, limit);
  if (assignedEfrId) {
    candidatesList = await ensureAssignedFirst(candidatesList, assignedEfrId, job, scored);
  }

  return {
    job: enrichedJob,
    alreadyAssigned,
    note,
    l1Count: eligible.length,
    l2Count: scored.length,
    candidates: candidatesList,
    rejected: rejected.slice(0, 20),
    config: {
      weights: SCORE_WEIGHTS,
      performance_sub: PERFORMANCE_SUB,
      max_concurrent: stats.values().next().value?.max_concurrent ?? DEFAULTS.MAX_CONCURRENT_JOBS,
      account_balance_floor: DEFAULTS.ACCOUNT_BALANCE_FLOOR,
    },
  };
}

/*
 * Ensure the currently-assigned technician appears first in the candidate
 * list (used by Reassign mode). If they already passed L1+L2 they're moved
 * to position 0 with `is_current=true`. If they were filtered out (no
 * matching deep-skill, saturated, etc.) we still surface them — fetched +
 * scored independently — so operators can see who's currently on the job
 * even when they wouldn't be auto-eligible.
 */
async function ensureAssignedFirst(candidatesList, assignedEfrId, job, scoredAll) {
  // Path A: the assigned tech is already in the scored set — just promote.
  const idx = candidatesList.findIndex((c) => Number(c.efr_id) === assignedEfrId);
  if (idx !== -1) {
    const [assigned] = candidatesList.splice(idx, 1);
    return [{ ...assigned, is_current: true }, ...candidatesList];
  }
  const idxAll = scoredAll.findIndex((c) => Number(c.efr_id) === assignedEfrId);
  if (idxAll !== -1) {
    return [{ ...scoredAll[idxAll], is_current: true }, ...candidatesList];
  }

  // Path B: the assigned tech was filtered out before scoring (e.g. by L1).
  // Re-fetch their basic profile + stats so we can still render the row.
  const [[techRow]] = await pool.query(
    `SELECT e.efr_id, e.efr_name, e.efr_no, e.efr_email,
            e.efr_cityId, c.city_name, e.current_balance
       FROM tbl_easyfixer e
       LEFT JOIN tbl_city c ON c.city_id = e.efr_cityId
      WHERE e.efr_id = ? LIMIT 1`,
    [assignedEfrId]
  );
  if (!techRow) return candidatesList;

  const stats = await statsForCandidates([assignedEfrId], job, job.fk_client_id);
  const s = stats.get(assignedEfrId);
  const assignedRow = { ...buildCandidateRow(techRow, s, job), is_current: true };
  return [assignedRow, ...candidatesList];
}

/*
 * paid_by storage convention (verified against legacy CRM JSP templates):
 *   1 → 'NE'        (legacy "Client" / "By client" — non-Easyfix party pays)
 *   2 → 'Customer'  (end customer pays the technician on-site)
 *   3 → 'Easyfix'   (Easyfix bills the client, no on-site collection)
 *   anything else → 'NA'
 *
 * paidByLabel() converts whichever shape arrives (int from the DB, string
 * from older code paths, null) into the canonical human label. paidByIsCustomer()
 * is the single source of truth for the customer-paid customer-balance gate
 * applied in pickAutoAssignCandidate — accepts both 2 and 'Customer'/'customer'.
 */
function paidByLabel(raw) {
  const n = Number(raw);
  if (Number.isFinite(n)) {
    if (n === 1) return 'NE';
    if (n === 2) return 'Customer';
    if (n === 3) return 'Easyfix';
    return 'NA';
  }
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'customer') return 'Customer';
  if (s === 'ne')       return 'NE';
  if (s === 'easyfix')  return 'Easyfix';
  return 'NA';
}
function paidByIsCustomer(raw) {
  return paidByLabel(raw) === 'Customer';
}

/*
 * Pick the right candidate for auto-assignment from a ranked list.
 *
 * Default behaviour: pick the top-ranked candidate.
 *
 * Customer-paid override: when the job's paid_by = Customer, the chosen
 * tech needs cash on hand to cover travel out-of-pocket — so we walk down
 * the ranked list and pick the first candidate whose current_balance is
 * AT LEAST the configured floor (default ₹500). If nobody meets the gate,
 * we return the top-ranked anyway with a `low_balance` flag, so callers
 * can decide whether to assign with a warning or hold for manual triage.
 *
 * The ranking itself is preserved — this is a *post-rank* selection step,
 * not an input to scoring. That keeps the modal consistent for human
 * operators (always see the best-ranked tech first) while giving auto-
 * assign the right cash-floor behaviour.
 */
function pickAutoAssignCandidate(rankResult, { paidBy, balanceFloor = DEFAULTS.ACCOUNT_BALANCE_FLOOR } = {}) {
  const list = rankResult?.candidates ?? [];
  if (!list.length) return null;

  if (!paidByIsCustomer(paidBy)) {
    return { candidate: list[0], reason: 'top_rank', low_balance: false };
  }

  const eligible = list.find((c) => Number(c.current_balance ?? 0) >= balanceFloor);
  if (eligible) {
    return {
      candidate: eligible,
      reason: eligible === list[0] ? 'top_rank' : 'top_rank_with_balance',
      low_balance: false,
    };
  }
  // No one meets the cash floor — fall back to the top-ranked tech but flag.
  return { candidate: list[0], reason: 'top_rank_low_balance', low_balance: true };
}

// ─── Search anyone (assign-anyone path) ───────────────────────────────
/*
 * searchTechniciansForJob(jobId, { term, jobDate, timeSlot, limit })
 *
 * Powers GET /api/admin/jobs/:id/candidates/search. Matches ANY technician
 * by efr_id / efr_name / efr_no(mobile) — NO top-10 hard filters, NO
 * ranking-based exclusion — so ops can assign anyone. Returns the SAME
 * widened row shape as the ranked list (reuses statsForCandidates +
 * buildCandidateRow), so every computed column (distance, attendance,
 * concurrent, skill state, …) is consistent across both surfaces.
 *
 * Cap (default 50) + logger.warn when the raw match count hits the cap, so
 * a too-broad term is observable in logs (the operator should refine).
 */
async function searchTechniciansForJob(jobId, { term, jobDate, timeSlot, limit = 50 } = {}) {
  const job = await jobService.getById(jobId);
  if (!job) {
    const err = new Error('job not found'); err.status = 404; throw err;
  }
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 50);

  // Proposed-schedule overrides (same contract as rankCandidatesForJob).
  if (jobDate) job.requested_date_time = jobDate;
  if (timeSlot !== undefined && timeSlot !== null && timeSlot !== '') job.time_slot = timeSlot;

  const q = String(term ?? '').trim();
  if (!q) return { job: await searchJobHeader(job), candidates: [], capped: false };

  // Match by name / mobile (efr_no) always; by efr_id only when the term is
  // a pure integer. capLookup = cap + 1 so we can detect "hit the cap".
  const like = `%${q}%`;
  const params = [like, like];
  let idClause = '';
  if (/^[0-9]+$/.test(q)) {
    idClause = ' OR e.efr_id = ?';
    params.push(Number(q));
  }
  const [techRows] = await pool.query(
    `SELECT e.efr_id, e.efr_name, e.efr_no, e.efr_email,
            e.efr_cityId, c.city_name, e.current_balance
       FROM tbl_easyfixer e
       LEFT JOIN tbl_city c ON c.city_id = e.efr_cityId
      WHERE (e.efr_name LIKE ? OR e.efr_no LIKE ?${idClause})
      ORDER BY e.efr_name ASC
      LIMIT ?`,
    [...params, cap + 1],
  );

  const capped = techRows.length > cap;
  if (capped) {
    logger.warn({ jobId, term: q, cap }, 'searchTechniciansForJob: result set hit the cap — term too broad');
  }
  const rows = techRows.slice(0, cap);
  if (rows.length === 0) return { job: await searchJobHeader(job), candidates: [], capped };

  const stats = await statsForCandidates(rows.map((r) => r.efr_id), job, job.fk_client_id);
  const candidates = rows.map((r) => buildCandidateRow(r, stats.get(r.efr_id), job));

  return { job: await searchJobHeader(job), candidates, capped };
}

/*
 * Enriched job header reused by the search response.
 * The job object comes from jobService.getById (j.* + LIST_JOIN/DETAIL_JOIN
 * so all customer/client/address/service_category fields are present).
 * service_type_name requires a separate scalar subquery since getById only
 * JOINs tbl_service_type against tbl_job_services, not against the job row's
 * own fk_service_type_id — we do that inline here.
 */
async function searchJobHeader(job) {
  let serviceTypeName = null;
  if (job.fk_service_type_id) {
    const [[st]] = await pool.query(
      'SELECT service_type_name FROM tbl_service_type WHERE service_type_id = ? LIMIT 1',
      [job.fk_service_type_id]
    );
    serviceTypeName = st?.service_type_name ?? null;
  }
  let deepSkillLabel = null;
  if (job.fk_service_catg_id || job.fk_service_type_id) {
    deepSkillLabel = [job.service_category, serviceTypeName].filter(Boolean).join(' › ') || null;
  }
  return {
    job_id:            job.job_id,
    fk_client_id:      job.fk_client_id,
    customer_name:     job.customer_name    ?? null,
    customer_mob_no:   job.customer_mob_no  ?? null,
    client_name:       job.client_name      ?? null,
    client_ref_id:     job.client_ref_id    ?? null,
    address:           job.address          ?? null,
    city_id:           job.city_id          ?? null,
    city_name:         job.city_name        ?? null,
    pin_code:          job.pin_code         ?? null,
    service_category:  job.service_category ?? null,
    service_type:      serviceTypeName      ?? null,
    deep_skill_label:  deepSkillLabel       ?? null,
    job_type:          job.job_type         ?? null,
    payment_mode:      paidByLabel(job.paid_by),
    requested_date_time: job.requested_date_time ?? null,
    time_slot:         job.time_slot        ?? null,
    job_desc:          job.job_desc         ?? null,
    paid_by:           job.paid_by          ?? null,
    paid_by_label:     paidByLabel(job.paid_by),
  };
}

module.exports = {
  rankCandidatesForJob,
  searchTechniciansForJob,
  pickAutoAssignCandidate,
  SCORE_WEIGHTS,
  PERFORMANCE_SUB,
  DEFAULTS,
};
