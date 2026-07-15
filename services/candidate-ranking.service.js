const { pool } = require('../db');
const { OFFER_STATUS } = require('./offer-status');
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
  // Zone-widening fallback threshold — if fewer than this many candidates
  // survive the city-scoped pass, re-run eligibility widened to the job
  // pincode's zone(s) and re-apply the same filters (spec: "less than 10").
  MIN_CANDIDATES_BEFORE_WIDEN: 10,
  // Default sub-scores for technicians with NO completed-job history in
  // the lookback window. Used as a neutral midpoint so new joiners aren't
  // pegged at 0 (unfair) or 1 (gaming). Settings keys
  // `default_tat_score` / `default_sda_score` override per environment.
  DEFAULT_TAT_SCORE:       0.5,
  DEFAULT_SDA_SCORE:       0.5,
};

// Ranking model — PRIORITY ORDER, not a weighted score (2026-06-22).
// After candidates clear every hard filter, order them by:
//   1. Worked in this Vertical (service category) before  — existing-tech preference
//   2. Worked for this Client before                       — existing-tech preference
//   3. Past Performance (tiebreaker only)                  — Rating 30 / TAT 20 / SDA 20
// Attendance is a FILTER ONLY (present for the job date); it is NOT a ranking
// signal. New technicians (no history) carry neutral default performance
// sub-scores so they still rank fairly within the non-preferred group.
const RANKING_ORDER = Object.freeze(['worked_for_vertical', 'worked_for_client', 'performance']);
// Performance composite (tiebreaker only + letter grade): Rating 30 / TAT 20 /
// SDA 20, normalised to sum 1.0.
const PERFORMANCE_SUB = Object.freeze({
  rating: 30 / 70,
  tat:    20 / 70,
  sda:    20 / 70,
});

// ─── Ranking config resolver (batched, with safe fallbacks) ──────────
/*
 * Settings precedence (same as settings.getClientSetting):
 *   1. Per-client override   — tbl_client_setting row for (client_id, setting_id)
 *   2. Global default        — tbl_autoallocation_setting.default_value
 *   3. Built-in fallback     — the DEFAULTS constant below
 *
 * The candidate-ranking pipeline always passes `job.fk_client_id` so step 1
 * fires whenever the job has a client. Cross-client jobs (fk_client_id IS NULL)
 * skip step 1 and resolve directly to global → built-in.
 *
 * getRankingConfig batches the FIVE static ranking keys into ONE round-trip:
 * settings.getAllForClient runs 2 queries (master list + this client's
 * overrides) and returns every key already coerced to its data_type. That
 * replaces the previous 5× getClientSetting (10 sequential queries) — and,
 * because rankCandidatesForJob resolves it once and hands it to BOTH the city
 * and zone-widening stats passes, it drops from ~20 settings round-trips per
 * request to 2. REALTIME (no cache): the two queries hit tiny tables
 * (tbl_autoallocation_setting=30 rows, tbl_client_setting per-client), so an
 * ops toggle still takes effect on the very next request — preserving
 * settings.service's deliberate no-cache contract.
 */
async function getRankingConfig(clientId) {
  let byKey = new Map();
  try {
    const rows = await settings.getAllForClient(clientId || null);
    byKey = new Map(rows.map((r) => [r.key, r.effective_value]));
  } catch { /* fall through to built-in DEFAULTS below */ }
  const int = (key, fallback) => {
    const n = Number(byKey.get(key));
    return Number.isFinite(n) ? n : fallback;
  };
  // getAllForClient coerces 'json' data_type to an object already; tolerate a
  // raw string too (belt-and-braces) so a mis-declared data_type still parses.
  let tatTier = null;
  const rawTier = byKey.get('tat_service_catg_tier');
  if (rawTier != null && rawTier !== '') {
    try { tatTier = typeof rawTier === 'object' ? rawTier : JSON.parse(rawTier); } catch { tatTier = null; }
  }
  return {
    maxConcurrent:   int('max_concurrent_jobs',  DEFAULTS.MAX_CONCURRENT_JOBS),
    defaultRating:   int('default_rating_value', DEFAULTS.DEFAULT_RATING),
    defaultTatScore: int('default_tat_score',    DEFAULTS.DEFAULT_TAT_SCORE),
    defaultSdaScore: int('default_sda_score',    DEFAULTS.DEFAULT_SDA_SCORE),
    tatTier,
  };
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
  const jobZonePincodes = new Set();
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
    if (jobZoneIds.size > 0) {
      // Every pincode sharing a zone with the job pincode — the search space for
      // widening by a tech's CURRENT pincode (efr_pin_no) or SERVICEABLE pincode,
      // not just their home zone_city.
      try {
        const [pinRows] = await pool.query(
          `SELECT DISTINCT p.pincode
             FROM tbl_zone_pincode_mapping zpm
             JOIN tbl_pincode p ON p.pincode_id = zpm.pincode_id
            WHERE zpm.zone_id IN (${[...jobZoneIds].map(() => '?').join(',')})`,
          [...jobZoneIds],
        );
        for (const r of pinRows) if (r.pincode != null) jobZonePincodes.add(String(r.pincode).trim());
      } catch (e) {
        logger.warn({ err: e.message, jobPin }, 'candidate-ranking: zone-pincode set lookup failed');
      }
    } else {
      // NOT silent: an unmapped job pincode is exactly why zone-widening can't
      // fire (see the pincode→zone population gap) — surface it so ops can map
      // the pincode in Manage Pincodes rather than wonder why the pool is thin.
      logger.warn('Job pincode is not mapped to any zone — zone-widening unavailable · jobPin=' + jobPin + ' (map it in Manage Pincodes → Zones to enable widening)');
    }
  }
  return { jobPin, jobZoneIds, jobZonePincodes };
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
 * Memoised existence probe for tbl_job_offer — the new EasyFix-owned table
 * (migrations/2026-06-27-create-tbl-job-offer.sql) backing THE OFFER MODEL.
 * Mirrors job.service.js's jobOfferTableExists() (kept local so this service
 * doesn't depend on that helper being exported). When the table is absent the
 * offer-history exclusion below is skipped entirely, so eligibility behaviour
 * is byte-identical to the pre-offer-model pipeline on un-migrated deploys.
 */
let _hasJobOfferTable = null;
async function jobOfferTableExists() {
  if (_hasJobOfferTable !== null) return _hasJobOfferTable;
  try {
    await pool.query('SELECT 1 FROM tbl_job_offer LIMIT 1');
    _hasJobOfferTable = true;
  } catch {
    _hasJobOfferTable = false;
  }
  return _hasJobOfferTable;
}

/*
 * Returns rows from tbl_easyfixer that pass active + verified + reject-history
 * + already-offered (offer-pool model) + (optionally) deep-skill. The
 * `applyDeepSkill` flag is the lever for the "no-skill-match fallback": first
 * call with true; if zero rows return, caller re-invokes with false and tags
 * the result.
 */
async function l1Eligibility(job, { applyDeepSkill = true, zoneIds = null, zonePincodes = null, excludeEfrIds = null } = {}) {
  /*
   * Layer-1 eligibility, scoped EITHER to the job's city (default pass) OR —
   * for the zone-widening fallback — to the job pincode's zone(s).
   *
   * Legacy-canonical predicates (confirmed across every legacy candidate /
   * availability / assign query; activation sets efr_status=1):
   *   efr_status = 1            → ACTIVE  (do NOT invert to 0)
   *   is_technician_verified=1  → verified profile
   *   NOT IN scheduling_history(reschedule_reason <> '')  → not rejected/
   *                              rescheduled off THIS job earlier
   *
   * Deep-skill match — actual schema (verified against the legacy Java
   * @Entity for tbl_efr_deepskill_mapping):
   *   easyfixer_id (FK→tbl_easyfixer.efr_id), category_id, service_type_id,
   *   parent_skill_id (= deepskill_id), is_repairing (1 = active mapping).
   * We touch tbl_deep_skill only to EXCLUDE mappings whose deep skill is
   * INACTIVE (status=0) via the correct column m.parent_skill_id;
   * NOT EXISTS(status=0) keeps active + orphan rows.
   *
   * Params are pushed in WHERE order (scope → skill → exclude → history) so
   * the positional placeholders bind correctly.
   */
  const where = ['e.efr_status = 1', 'e.is_technician_verified = 1'];
  const params = [];

  // ── Geographic scope ──
  if (Array.isArray(zoneIds) && zoneIds.length > 0) {
    // Zone-widening pass — a technician qualifies if they operate in the job
    // pincode's zone(s) by ANY of:
    //   (1) HOME zone  — efr_zone_city_id → tbl_zone_city_mapping.zone_id
    //   (2) CURRENT pincode — efr_pin_no is one of the zone's pincodes
    //   (3) SERVICEABLE pincode — a pincode in their serviceable CSV is in the
    //       zone (REPLACE strips spaces so FIND_IN_SET matches "122001, 122002")
    // (2)/(3) need the zone's pincode set (zonePincodes); without it we fall
    // back to home-zone only. Built on the new-CRM zone model (legacy had none).
    const zoneClauses = [`e.efr_zone_city_id IN (
          SELECT zcm.city_zone_id FROM tbl_zone_city_mapping zcm
           WHERE zcm.zone_id IN (${zoneIds.map(() => '?').join(',')})
        )`];
    params.push(...zoneIds);
    const zonePins = Array.isArray(zonePincodes) ? zonePincodes.filter(Boolean) : [];
    if (zonePins.length > 0) {
      zoneClauses.push(`e.efr_pin_no IN (${zonePins.map(() => '?').join(',')})`);
      params.push(...zonePins);
      zoneClauses.push(`EXISTS (
            SELECT 1 FROM tbl_efr_serviceable_pincodes sp
             WHERE sp.easyfixer_id = e.efr_id
               AND (${zonePins.map(() => `FIND_IN_SET(?, REPLACE(sp.pincodes, ' ', ''))`).join(' OR ')})
          )`);
      params.push(...zonePins);
    }
    where.push(`(${zoneClauses.join('\n          OR ')})`);
  } else {
    // City-scoped pass (default) — same city as the job.
    where.push('e.efr_cityId = ?');
    params.push(job.city_id);
  }

  // ── Deep-skill (exact category + type match, active mappings only) ──
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
    if (job.fk_service_catg_id) { predicate += ' AND m.category_id = ?';     params.push(job.fk_service_catg_id); }
    if (job.fk_service_type_id) { predicate += ' AND m.service_type_id = ?'; params.push(job.fk_service_type_id); }
    predicate += ')';
    where.push(predicate);
  }

  // ── Exclude already-considered techs (zone pass excludes the city pool) ──
  if (Array.isArray(excludeEfrIds) && excludeEfrIds.length > 0) {
    where.push(`e.efr_id NOT IN (${excludeEfrIds.map(() => '?').join(',')})`);
    params.push(...excludeEfrIds);
  }

  // ── Already rejected / rescheduled-off THIS job ──
  where.push(`e.efr_id NOT IN (
          SELECT sh.easyfixer_id FROM scheduling_history sh
           WHERE sh.job_id = ?
             AND sh.reschedule_reason IS NOT NULL
             AND sh.reschedule_reason <> ''
        )`);
  params.push(job.job_id);

  // ── Already OFFERED this job (offer-pool model) ──
  // In THE OFFER MODEL a job is offered to MANY technicians at once; each open
  // offer is a tbl_job_offer row with offer_status = 0 (OFFERED). Suppress any
  // tech who currently holds an open offer for THIS job so the Top-10 / search
  // candidate list never re-surfaces someone already offered. Gated by the
  // memoised existence probe — when tbl_job_offer is absent this clause is
  // omitted and eligibility is identical to the pre-offer-model behaviour.
  if (await jobOfferTableExists()) {
    where.push(`e.efr_id NOT IN (
          SELECT jo.fk_easyfixter_id FROM tbl_job_offer jo
           WHERE jo.job_id = ?
             AND jo.offer_status = ${OFFER_STATUS.OFFERED}
        )`);
    params.push(job.job_id);
  }

  // Column note: balance lives on tbl_easyfixer.current_balance (legacy
  // schema; same column the Finance dashboard reads).
  const [rows] = await pool.query(
    `SELECT e.efr_id, e.efr_name, e.efr_no, e.efr_email,
            e.efr_cityId, c.city_name,
            e.current_balance,
            e.is_technician_verified
       FROM tbl_easyfixer e
       LEFT JOIN tbl_city c ON c.city_id = e.efr_cityId
      WHERE ${where.join('\n        AND ')}`,
    params
  );
  return rows;
}

// ─── Layer 2 + ranking stats ─────────────────────────────────────────
async function statsForCandidates(efrIds, job, clientId, cfg = null) {
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

  // Static ranking config — ONE batched round-trip (getRankingConfig →
  // settings.getAllForClient) instead of the 5× getClientSetting that used to
  // sit in this Promise.all. Resolved once per request and passed in as `cfg`
  // (city + zone-widening passes share it); falls back to its own resolve when
  // a caller doesn't supply it.
  const { maxConcurrent, defaultRating, defaultTatScore, defaultSdaScore, tatTier: tatTierJson } =
    cfg || (await getRankingConfig(clientId));

  const [
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
    // ⚠ INVERTED 2026-07-15 — this now selects the ABSENT set, not the present
    // set. Per ops: "if attendance is not marked as absent, consider it present;
    // ONLY explicitly absent counts as absent." Previously presence had to be
    // AFFIRMED (a row existed AND a slot was ticked AND no leave), so the far
    // larger population of techs who simply never marked anything was treated as
    // absent — the default was backwards. `is_leave_marked = 1` is the only
    // explicit absence signal the table carries (columns: morning_slot,
    // evening_slot, is_leave_marked — see scripts/schema-verify.js), so it alone
    // defines absence now. A row with neither slot ticked and no leave flag is
    // NOT explicit absence → present.
    //
    // Consequences of the flip, both intentional:
    //   - reqDate null (no schedule): empty ABSENT set → everyone present. Was:
    //     everyone absent.
    //   - Query failure: fails OPEN (empty absent set → everyone present) rather
    //     than closed. That follows directly from the rule — we cannot claim
    //     someone is "explicitly absent" on the strength of a failed query.
    reqDate
      ? pool.query(
          `SELECT DISTINCT easyfixer_id AS efr_id
             FROM tbl_easyfixer_attendance
            WHERE easyfixer_id IN (${placeholders})
              AND DATE(created_on) = ?
              AND is_leave_marked = 1`,
          [...efrIds, reqDate]
        ).catch((e) => { logger.warn({ err: e.message }, 'candidate-ranking: attendance-absent query failed; treating all as present (only explicit absence excludes)'); return [[]]; })
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
  // Membership = EXPLICITLY ABSENT (is_leave_marked = 1). Non-membership —
  // including "never marked attendance at all" — means present. See the query.
  const absentMap = new Map((attRowsResult[0] || []).map((r) => [r.efr_id, true]));
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
      // Drives the modal's "Attendance Today" tick/cross. Same rule as
      // attendance_for_job_date: a cross now means EXPLICITLY marked absent
      // (is_leave_marked=1), not merely "hasn't marked attendance".
      attendance_marked:  !absentMap.has(id),
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
      // Present UNLESS explicitly marked absent — `absentMap` is the leave set.
      attendance_for_job_date: !absentMap.has(id),
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

  // Performance composite (0–1) — used ONLY as the ranking tiebreaker (after
  // worked-vertical / worked-client preference) and to derive the letter grade.
  // Worked-for-client/vertical are higher-priority SORT keys (not part of this
  // score); attendance is a hard filter (not scored).
  const performance =
    PERFORMANCE_SUB.rating * rating +
    PERFORMANCE_SUB.tat    * tat +
    PERFORMANCE_SUB.sda    * sda;

  // Letter grade from the performance composite.
  const pct = Math.round(performance * 100);
  let grade;
  if (pct >= 95) grade = 'A+';
  else if (pct >= 90) grade = 'A';
  else if (pct >= 80) grade = 'B';
  else if (pct >= 70) grade = 'C';
  else if (pct >= 60) grade = 'D';
  else grade = 'E';

  return {
    grade,
    performance,
    breakdown: { rating, tat, sda },
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
    // ── Ranking fields ── `score` mirrors the performance composite (the
    // tiebreaker). The actual ORDER is the priority sort in rankCandidatesForJob:
    // worked_for_vertical → worked_for_client → performance.
    score:        Number(out.performance.toFixed(4)),
    performance:  Number(out.performance.toFixed(4)),
    grade:        out.grade,
    breakdown:    Object.fromEntries(Object.entries(out.breakdown).map(([k, v]) => [k, Number(Number(v).toFixed(3))])),
  };
}

// ─── Shared hard-filter + score step ─────────────────────────────────
/*
 * Applies the hard filters (spec priority order) to an eligible set and
 * builds scored rows for the survivors. Reused by BOTH the city-scoped pass
 * and the zone-widening fallback so the gates stay identical across both.
 *
 * Hard filters:
 *   - same-day + same-slot booking conflict    (ALWAYS)
 *   - not explicitly absent for the job date    (when enforceAttendance)
 *   - at/over Max Concurrent Jobs               (when enforceMaxConcurrent)
 *   - COD job + balance <= floor                (when enforceCodBalance)
 */
function filterAndScore(eligible, stats, job, opts) {
  const { enforceMaxConcurrent, enforceCodBalance, enforceAttendance, softAttendance, isCod, balanceFloor } = opts;
  const scored = [];
  const rejected = [];
  for (const e of eligible) {
    const s = stats.get(e.efr_id);
    if (!s) continue;

    if (s.same_slot_conflict) {
      rejected.push({ efr_id: e.efr_id, efr_name: e.efr_name, reason: 'already booked same day + same slot' }); continue;
    }
    // Attendance HARD FILTER: excludes only technicians EXPLICITLY marked
    // absent (is_leave_marked=1) for the job date — as of 2026-07-15 an
    // unmarked technician counts as PRESENT and passes (see the absent-set
    // query above; this used to require affirmative presence and rejected
    // everyone who simply never marked). The `enforceAttendance` flag here is
    // already WINDOW-GATED by the
    // caller (rankCandidatesForJob) to jobs scheduled TODAY/TOMORROW — the only
    // dates a technician can mark attendance for — so later/past/unscheduled
    // jobs never hit this gate. DIVERGES from legacy (legacy used attendance
    // only for display + a soft confidence-score weight, never a gate). Present-
    // definition matches legacy (tbl_easyfixer_attendance: NOT is_leave_marked
    // AND (morning_slot OR evening_slot), DATE(created_on) = job date).
    if (enforceAttendance && !s.attendance_for_job_date && !softAttendance) {
      rejected.push({ efr_id: e.efr_id, efr_name: e.efr_name, reason: 'not present (attendance not marked) for job date' }); continue;
    }
    // SOFT attendance (manual Schedule & Assign): absent techs are NOT excluded
    // here — they stay in `scored` and the present-first sort in
    // rankCandidatesForJob demotes them below present techs, so the top-N slice
    // keeps present techs as a priority and only BACKFILLS with absent ones to
    // fill the list. HARD mode (auto-assign-on-create) already `continue`d above.
    // (same-slot / max-concurrent / COD gates below still apply to everyone.)
    if (enforceMaxConcurrent && s.active_jobs >= s.max_concurrent) {
      rejected.push({ efr_id: e.efr_id, efr_name: e.efr_name, reason: `saturated (${s.active_jobs} active jobs)` }); continue;
    }
    if (enforceCodBalance && isCod && Number(e.current_balance ?? 0) <= balanceFloor) {
      rejected.push({ efr_id: e.efr_id, efr_name: e.efr_name, reason: `COD job: balance ${Number(e.current_balance ?? 0)} <= ${balanceFloor}` }); continue;
    }

    scored.push(buildCandidateRow(e, s, job));
  }
  return { scored, rejected };
}

// ─── Public entrypoint ───────────────────────────────────────────────
/*
 * Returns:
 *   {
 *     job: { … },
 *     alreadyAssigned: bool,
 *     note: 'no_deep_skill_match' | null,
 *     l1Count, l2Count, candidates: [...],
 *     config: { ranking_order, max_concurrent, … },
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
 *   enforceAttendance    — hard-exclude techs EXPLICITLY marked absent for the job
 *                          date. DEFAULT true, but INTERNALLY WINDOW-GATED: it
 *                          only applies when the job is scheduled TODAY or
 *                          TOMORROW (the dates a technician can mark attendance
 *                          for). Jobs scheduled later/past/unscheduled ignore
 *                          attendance entirely — so far-future on-create auto-
 *                          assign is never starved. DIVERGES from legacy (which
 *                          gated on attendance NOWHERE — display + soft score
 *                          only). Pass false to disable the gate completely.
 * The same-day + same-slot conflict is ALWAYS a hard exclude (unchanged).
 *
 * Zone-widening fallback: when fewer than DEFAULTS.MIN_CANDIDATES_BEFORE_WIDEN
 * (10) candidates survive the CITY-scoped pass, eligibility is re-run widened
 * to the job pincode's zone(s) (resolveJobPincodeContext → tbl_zone_city_mapping
 * → efr_zone_city_id), excluding the city pool, and the same filters re-applied;
 * results merge and `note` is tagged 'zone_widened'. Net-new vs legacy.
 */
async function rankCandidatesForJob(jobId, {
  limit = 10, jobDate, timeSlot,
  enforceMaxConcurrent = true, enforceCodBalance = false, enforceAttendance = true,
  softAttendance = false,
  preloadedJob = null,
} = {}) {
  logger.info('Rank candidates for job · jobId=' + jobId + ' limit=' + limit + (jobDate ? ' jobDate=' + jobDate : '') + (timeSlot != null && timeSlot !== '' ? ' timeSlot=' + timeSlot : ''));
  // Reuse the job the route already loaded (req.scopedJob) when provided — the
  // /candidates route runs scopedJob → getById first, so re-fetching here is a
  // redundant second getById (full detail incl. the ~1.1s tbl_job_image scan).
  // Standalone callers (on-create auto-assign) pass nothing → getByIdCore
  // fetches ONLY the scalar detail row this pipeline reads (no images/services).
  const job = preloadedJob || await jobService.getByIdCore(jobId);
  if (!job) {
    logger.warn('Rank candidates failed · job not found · jobId=' + jobId);
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
  let serviceCatgName = null;
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
    serviceCatgName = labels?.catg_name ?? null;
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
    // Prefer the RESOLVED category name (from fk_service_catg_id) over the
    // legacy free-text job.service_category column, which is NULL on most
    // client-imported jobs (why the modal header showed "—").
    service_category:  serviceCatgName ?? job.service_category ?? null,
    service_type:      serviceTypeName      ?? null,
    deep_skill_label:  deepSkillLabel       ?? null,
    services:          mapJobServices(job),
    job_type:          job.job_type         ?? null,
    payment_mode:      paidByLabel(job.paid_by),
    requested_date_time: job.requested_date_time ?? null,
    time_slot:         job.time_slot        ?? null,
    // The legacy "H AM - H PM" cut-off window — the Schedule & Assign modal shows
    // THIS as the read-only Time Slot (the customer's booked slot), not a
    // client-derived label. Reschedule re-derives it BE-side from the new time.
    booking_cut_off_time_slot: job.booking_cut_off_time_slot ?? null,
    job_desc:          job.job_desc         ?? null,
    paid_by:           job.paid_by          ?? null,
    paid_by_label:     paidByLabel(job.paid_by),
    assigned_efr_id:   assignedEfrId,
    // Schedule & Assign Job Details fields. This object is an ALLOWLIST over the
    // getById payload — anything not copied here reaches the modal as undefined
    // and renders blank, which is exactly what happened to Booked By / Booked On
    // / Client SPOC. Add the field HERE too when the modal grows a column.
    client_spoc:       job.client_spoc      ?? null,
    client_spoc_name:  job.client_spoc_name ?? null,
    created_by_name:   job.created_by_name  ?? null,
    created_date_time: job.created_date_time ?? null,
    // Who collects payment — per JOB. Shown against Paid service lines.
    collected_by:      job.collected_by     ?? null,
    // Technician-facing note, surfaced as "Additional Comments".
    efr_special_notes: job.efr_special_notes ?? null,
  };

  // COD = customer pays the tech on-site (paid_by = Customer). Such techs
  // need cash on hand → optionally hard-filter balance > floor.
  const isCod = paidByIsCustomer(job.paid_by);
  const balanceFloor = DEFAULTS.ACCOUNT_BALANCE_FLOOR;

  // Attendance window — technicians can only mark attendance for TODAY and
  // TOMORROW, so the attendance hard filter is meaningful ONLY for jobs
  // scheduled on those two dates; for any other date (later, past, or
  // unscheduled) we ignore attendance entirely. This also makes far-future
  // on-create auto-assign safe (no empty pool from a gate that can't be
  // satisfied yet). IST today/tomorrow via Intl (server-TZ-agnostic); the
  // job's scheduled date is the IST wall-clock prefix of requested_date_time.
  const reqDateForWindow = job.requested_date_time ? String(job.requested_date_time).slice(0, 10) : null;
  const istToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const istTomorrow = (() => {
    const d = new Date(istToday + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  })();
  const attendanceWindowActive = !!reqDateForWindow && (reqDateForWindow === istToday || reqDateForWindow === istTomorrow);

  const filterOpts = {
    enforceMaxConcurrent, enforceCodBalance,
    // Hard-filter attendance only inside the today/tomorrow marking window.
    enforceAttendance: enforceAttendance && attendanceWindowActive,
    // SOFT attendance (manual Schedule & Assign): keep absent techs in the list
    // (present-first sort + backfill) instead of excluding them → the list is
    // never empty while present techs keep priority. Auto-assign leaves this
    // false so attendance stays a HARD gate.
    softAttendance,
    isCod, balanceFloor,
  };

  // Job-pincode zone-set — drives the zone-widening fallback below. Cheap
  // single query; fail-soft to an empty set (no zones → no widening).
  const { jobZoneIds, jobZonePincodes } = await resolveJobPincodeContext(job);

  // ── Pass 1: CITY-scoped eligibility (+ skill-drop fallback if zero) ──
  let appliedDeepSkill = true;
  let eligible = await l1Eligibility(job, { applyDeepSkill: true });
  let note = null;
  logger.info('City-scoped eligibility · found ' + eligible.length + ' eligible techs');
  if (eligible.length === 0 && (job.fk_service_catg_id || job.fk_service_type_id)) {
    eligible = await l1Eligibility(job, { applyDeepSkill: false });
    if (eligible.length > 0) { note = 'no_deep_skill_match'; appliedDeepSkill = false; }
    logger.info('Deep-skill fallback eligibility · found ' + eligible.length + ' eligible techs');
  }

  let scored = [];
  let rejected = [];
  let totalEligible = eligible.length;
  let cfgMaxConcurrent = DEFAULTS.MAX_CONCURRENT_JOBS;
  // Batched ranking config — resolved at most ONCE (only when there are
  // eligible techs to score) and shared by the city + zone stats passes so we
  // don't pay the settings round-trip twice.
  let rankingCfg = null;

  if (eligible.length > 0) {
    rankingCfg = await getRankingConfig(job.fk_client_id);
    const stats = await statsForCandidates(eligible.map((e) => e.efr_id), job, job.fk_client_id, rankingCfg);
    cfgMaxConcurrent = stats.values().next().value?.max_concurrent ?? cfgMaxConcurrent;
    const r = filterAndScore(eligible, stats, job, filterOpts);
    scored = r.scored;
    rejected = r.rejected;
  }

  // ── Pass 2: ZONE-WIDENING fallback (spec: "less than 10 after filters") ──
  // Re-run eligibility widened to the job pincode's zone(s), excluding the
  // city pool already considered, and re-apply the SAME filters. Mirrors the
  // city pass's deep-skill state (if the city pass dropped the skill predicate
  // because nothing matched, so does the widened pass). Net-new vs legacy
  // (legacy never scoped by zone); built on the new-CRM zone model.
  if (scored.length < DEFAULTS.MIN_CANDIDATES_BEFORE_WIDEN && jobZoneIds.size > 0) {
    logger.info('Zone-widening fallback · scored=' + scored.length + ' below threshold ' + DEFAULTS.MIN_CANDIDATES_BEFORE_WIDEN + ' · widening to ' + jobZoneIds.size + ' zone(s)');
    const zoneIds = [...jobZoneIds];
    const zonePincodes = [...jobZonePincodes];
    const excludeEfrIds = eligible.map((e) => e.efr_id);
    let zoneEligible = await l1Eligibility(job, { applyDeepSkill: appliedDeepSkill, zoneIds, zonePincodes, excludeEfrIds });
    if (zoneEligible.length === 0 && appliedDeepSkill && (job.fk_service_catg_id || job.fk_service_type_id)) {
      zoneEligible = await l1Eligibility(job, { applyDeepSkill: false, zoneIds, zonePincodes, excludeEfrIds });
      if (zoneEligible.length > 0 && !note) note = 'no_deep_skill_match';
    }
    if (zoneEligible.length > 0) {
      totalEligible += zoneEligible.length;
      rankingCfg = rankingCfg || (await getRankingConfig(job.fk_client_id));
      const zStats = await statsForCandidates(zoneEligible.map((e) => e.efr_id), job, job.fk_client_id, rankingCfg);
      if (cfgMaxConcurrent === DEFAULTS.MAX_CONCURRENT_JOBS) {
        cfgMaxConcurrent = zStats.values().next().value?.max_concurrent ?? cfgMaxConcurrent;
      }
      const zr = filterAndScore(zoneEligible, zStats, job, filterOpts);
      rejected = rejected.concat(zr.rejected);
      if (zr.scored.length > 0) {
        scored = scored.concat(zr.scored);
        note = note ? `${note},zone_widened` : 'zone_widened';
      }
    }
  }

  if (scored.length === 0 && totalEligible === 0) {
    logger.info('Returning 0 candidates · no eligible techs · jobId=' + jobId);
    return {
      job: enrichedJob, alreadyAssigned, note: note ?? 'no_eligible_techs',
      l1Count: 0, l2Count: 0, candidates: [], rejected: [],
      config: { ranking_order: RANKING_ORDER, performance_sub: PERFORMANCE_SUB },
    };
  }

  // Priority-order ranking (NOT a weighted score): PRESENT-for-job-date techs
  // first (so soft-attendance backfill can never bury a present tech below an
  // absent one, and the top-N slice keeps present techs as the priority), then
  // existing-tech preference — worked in this Vertical, then worked for this
  // Client — then past performance (Rating/TAT/SDA) as the tiebreaker. In HARD
  // attendance mode every scored tech is present, so the attendance key is a
  // no-op (no behaviour change for auto-assign). Balance is a column, never a
  // sort input.
  scored.sort((a, b) => {
    if (a.attendance_for_job_date !== b.attendance_for_job_date) return a.attendance_for_job_date ? -1 : 1;
    if (a.worked_for_vertical !== b.worked_for_vertical) return a.worked_for_vertical ? -1 : 1;
    if (a.worked_for_client   !== b.worked_for_client)   return a.worked_for_client   ? -1 : 1;
    return b.performance - a.performance;
  });

  // If the job already has an assigned technician (Reassign mode), pin them
  // first so operators can compare current vs. potential replacements. The
  // assigned tech may have been filtered out — ensureAssignedFirst re-fetches
  // + scores them so they still render with is_current=true.
  let candidatesList = scored.slice(0, limit);
  if (assignedEfrId) {
    candidatesList = await ensureAssignedFirst(candidatesList, assignedEfrId, job, scored);
  }

  logger.info('Returning ' + candidatesList.length + ' candidates · eligible=' + totalEligible + ' scored=' + scored.length + ' rejected=' + rejected.length + (note ? ' note=' + note : ''));
  return {
    job: enrichedJob,
    alreadyAssigned,
    note,
    l1Count: totalEligible,
    l2Count: scored.length,
    candidates: candidatesList,
    rejected: rejected.slice(0, 20),
    config: {
      ranking_order: RANKING_ORDER,
      performance_sub: PERFORMANCE_SUB,
      max_concurrent: cfgMaxConcurrent,
      account_balance_floor: DEFAULTS.ACCOUNT_BALANCE_FLOOR,
      min_candidates_before_widen: DEFAULTS.MIN_CANDIDATES_BEFORE_WIDEN,
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
 * paid_by storage convention (verified against legacy CRM Velocity templates):
 *   1 → 'Client'    (the client pays — legacy "Client" / "By client")
 *   2 → 'Customer'  (end customer pays the technician on-site)
 *   3 → 'Easyfix'   (Easyfix bills the client, no on-site collection)
 *   anything else → 'Not Set'
 *
 * Wording checked against legacy pages/jobs/jobDetails.vm, which renders the
 * JOB's paid_by as: 1 → "Client", 2 → "Customer", else → "NA".
 *   - 1 was previously labelled 'NE' ("non-Easyfix party") — accurate but
 *     jargon ops never see anywhere else. Legacy calls it Client; so do we.
 *   - 'NA' → 'Not Set' is a WORDING change only, same trigger. It matters
 *     because paid_by is 0 on ~434k of ~481k jobs and NULL on ~29k — i.e. ~96%
 *     of jobs render this label, and "Not Set" says what's true (nobody
 *     populates the column) where "NA" reads like a system error. There is no
 *     "Cash" value in this enum on any tier — legacy included.
 * Labels only: paidByIsCustomer() keys on 2, so the COD/balance gate is
 * untouched by the 1 and fallback rewordings.
 *
 * paidByLabel() converts whichever shape arrives (int from the DB, string
 * from older code paths, null) into the canonical human label. paidByIsCustomer()
 * is the single source of truth for the customer-paid customer-balance gate
 * applied in pickAutoAssignCandidate — accepts both 2 and 'Customer'/'customer'.
 */
/*
 * Compact per-service breakdown (service name / category / type / qty / charge)
 * for the Schedule & Assign modal header. Source rows come from job.services
 * (populated only on the full-getById path — i.e. the route's req.scopedJob
 * preloadedJob); the getByIdCore / auto-assign path carries no services → [].
 * Active rows only (job_service_status !== 0 hides soft-deleted lines).
 */
function mapJobServices(job) {
  return (Array.isArray(job.services) ? job.services : [])
    .filter((s) => s.job_service_status !== 0)
    .map((s) => ({
      service_name: s.service_name      ?? null,
      service_catg: s.service_catg_name ?? null,
      service_type: s.service_type_name ?? null,
      quantity:     s.quantity          ?? null,
      total_charge: s.total_charge      ?? null,
      // Free/Paid per service, derived by job.service.js getById from
      // effective_charge. This mapper is an ALLOWLIST — a field absent here is
      // dropped no matter what getById projects, which is why the modal's
      // Billing chip rendered "—".
      billing_label: s.billing_label    ?? null,
    }));
}

function paidByLabel(raw) {
  const n = Number(raw);
  if (Number.isFinite(n)) {
    if (n === 1) return 'Client';
    if (n === 2) return 'Customer';
    if (n === 3) return 'Easyfix';
    return 'Not Set';
  }
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'customer') return 'Customer';
  if (s === 'ne' || s === 'client') return 'Client';
  if (s === 'easyfix')  return 'Easyfix';
  return 'Not Set';
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
  logger.info('Pick auto-assign candidate · paymentMode=' + paidByLabel(paidBy) + ' candidates=' + list.length);
  if (!list.length) {
    logger.info('Auto-assign pick · none available');
    return null;
  }

  if (!paidByIsCustomer(paidBy)) {
    logger.info('Auto-assign picked top rank · efr_id=' + list[0].efr_id);
    return { candidate: list[0], reason: 'top_rank', low_balance: false };
  }

  const eligible = list.find((c) => Number(c.current_balance ?? 0) >= balanceFloor);
  if (eligible) {
    logger.info('Auto-assign picked (COD, balance >= ' + balanceFloor + ') · efr_id=' + eligible.efr_id);
    return {
      candidate: eligible,
      reason: eligible === list[0] ? 'top_rank' : 'top_rank_with_balance',
      low_balance: false,
    };
  }
  // No one meets the cash floor — fall back to the top-ranked tech but flag.
  logger.warn('Auto-assign pick · no candidate meets COD balance floor ' + balanceFloor + ' · returning top rank efr_id=' + list[0].efr_id + ' with low_balance flag');
  return { candidate: list[0], reason: 'top_rank_low_balance', low_balance: true };
}

// ─── Search anyone (assign-anyone path) ───────────────────────────────
/*
 * searchTechniciansForJob(jobId, { term, jobDate, timeSlot, limit })
 *
 * Powers GET /api/admin/jobs/:id/candidates/search. Matches ANY technician
 * by efr_id / efr_name / efr_no(mobile) / city_name / efr_pin_no — NO top-10
 * hard filters, NO ranking-based exclusion — so ops can assign anyone. One
 * `term` box covers every column (ops should never have to pick a field first).
 * Returns the SAME
 * widened row shape as the ranked list (reuses statsForCandidates +
 * buildCandidateRow), so every computed column (distance, attendance,
 * concurrent, skill state, …) is consistent across both surfaces.
 *
 * Cap (default 250) + logger.warn when the raw match count hits the cap, so
 * a too-broad term is observable in logs (the operator should refine).
 */
async function searchTechniciansForJob(jobId, { term, jobDate, timeSlot, limit = 50, preloadedJob = null } = {}) {
  logger.info('Search technicians for job · jobId=' + jobId + ' termLen=' + String(term ?? '').trim().length + ' limit=' + limit);
  // Reuse the route's already-loaded job (req.scopedJob); else fetch only the
  // scalar detail row (getByIdCore skips the expensive tbl_job_image scan).
  const job = preloadedJob || await jobService.getByIdCore(jobId);
  if (!job) {
    logger.warn('Search technicians failed · job not found · jobId=' + jobId);
    const err = new Error('job not found'); err.status = 404; throw err;
  }
  const cap = Math.min(Math.max(Number(limit) || 250, 1), 250);

  // Proposed-schedule overrides (same contract as rankCandidatesForJob).
  if (jobDate) job.requested_date_time = jobDate;
  if (timeSlot !== undefined && timeSlot !== null && timeSlot !== '') job.time_slot = timeSlot;

  const q = String(term ?? '').trim();
  if (!q) {
    logger.info('Search technicians · empty term · returning 0 candidates');
    return { job: await searchJobHeader(job), candidates: [], capped: false };
  }

  // Match by name / mobile (efr_no) / city always; by efr_id only when the term
  // is a pure integer. capLookup = cap + 1 so we can detect "hit the cap".
  const like = `%${q}%`;
  const params = [like, like, like];
  let idClause = '';
  if (/^[0-9]+$/.test(q)) {
    idClause = ' OR e.efr_id = ?';
    params.push(Number(q));
  }
  // A 6-digit numeric term is genuinely ambiguous: it can be a pincode, an
  // efr_id (ids are sequential and already reach that width) or a fragment of a
  // 10-digit mobile. We deliberately do NOT disambiguate — every clause is OR'd,
  // so the pin match is purely ADDITIVE and the pre-existing id / mobile
  // behaviour is untouched (a superset, never a replacement). Gated to exactly 6
  // digits: that is the full Indian pincode width, a shorter term would match a
  // whole region's worth of techs, and a 10-digit mobile can never be a pin.
  // Bound as a STRING because efr_pin_no is a varchar — a numeric param would
  // make MySQL coerce the column and lose the index.
  let pinClause = '';
  if (/^[0-9]{6}$/.test(q)) {
    pinClause = ' OR e.efr_pin_no = ?';
    params.push(q);
  }
  // Search is a "match-anyone" override so ops can bypass the RANKING filters
  // (deep-skill match, distance, serviceable pincode, attendance, same-slot
  // conflict, max-concurrent, COD balance, scheduling_history rejection) and
  // assign a specific tech. But it must still enforce the two IDENTITY gates
  // that make a row an assignable technician at all — the same hard gates
  // l1Eligibility applies: efr_status = 1 (ACTIVE — canonical, do NOT invert to
  // 0) AND is_technician_verified = 1 (verified profile). Without these, search
  // surfaced inactive / unverified / incomplete-profile ghosts (e.g. a NULL
  // is_technician_verified row with no efr_name) that can never be assigned.
  const [techRows] = await pool.query(
    `SELECT e.efr_id, e.efr_name, e.efr_no, e.efr_email,
            e.efr_cityId, c.city_name, e.current_balance
       FROM tbl_easyfixer e
       LEFT JOIN tbl_city c ON c.city_id = e.efr_cityId
      WHERE e.efr_status = 1
        AND e.is_technician_verified = 1
        AND (e.efr_name LIKE ? OR e.efr_no LIKE ? OR c.city_name LIKE ?${idClause}${pinClause})
      ORDER BY e.efr_name ASC
      LIMIT ?`,
    [...params, cap + 1],
  );

  const capped = techRows.length > cap;
  if (capped) {
    logger.warn({ jobId, term: q, cap }, 'searchTechniciansForJob: result set hit the cap — term too broad');
  }
  const rows = techRows.slice(0, cap);
  logger.info('Found ' + rows.length + ' matching technicians' + (capped ? ' (capped)' : ''));
  if (rows.length === 0) return { job: await searchJobHeader(job), candidates: [], capped };

  const stats = await statsForCandidates(rows.map((r) => r.efr_id), job, job.fk_client_id);
  const candidates = rows.map((r) => buildCandidateRow(r, stats.get(r.efr_id), job));

  logger.info('Returning ' + candidates.length + ' technician candidates');
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
  // Resolve BOTH category + type names from the job's FK ids (same as the
  // ranked header) — job.service_category is a legacy free-text column that is
  // NULL on most client-imported jobs.
  let serviceTypeName = null;
  let serviceCatgName = null;
  if (job.fk_service_catg_id || job.fk_service_type_id) {
    const [[labels]] = await pool.query(
      `SELECT
         (SELECT service_catg_name FROM tbl_service_catg WHERE service_catg_id = ?) AS catg_name,
         (SELECT service_type_name FROM tbl_service_type WHERE service_type_id = ?) AS type_name`,
      [job.fk_service_catg_id || 0, job.fk_service_type_id || 0]
    );
    serviceTypeName = labels?.type_name ?? null;
    serviceCatgName = labels?.catg_name ?? null;
  }
  const deepSkillLabel = [serviceCatgName, serviceTypeName].filter(Boolean).join(' › ') || null;
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
    service_category:  serviceCatgName ?? job.service_category ?? null,
    service_type:      serviceTypeName      ?? null,
    deep_skill_label:  deepSkillLabel       ?? null,
    services:          mapJobServices(job),
    job_type:          job.job_type         ?? null,
    payment_mode:      paidByLabel(job.paid_by),
    requested_date_time: job.requested_date_time ?? null,
    time_slot:         job.time_slot        ?? null,
    booking_cut_off_time_slot: job.booking_cut_off_time_slot ?? null,
    job_desc:          job.job_desc         ?? null,
    paid_by:           job.paid_by          ?? null,
    paid_by_label:     paidByLabel(job.paid_by),
  };
}

module.exports = {
  rankCandidatesForJob,
  searchTechniciansForJob,
  pickAutoAssignCandidate,
  RANKING_ORDER,
  PERFORMANCE_SUB,
  DEFAULTS,
};
