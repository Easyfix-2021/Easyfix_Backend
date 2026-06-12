const { pool } = require('../db');
const settings = require('./settings.service');
const jobService = require('./job.service');

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
   * mapping table; it failed at request time. Since the mapping row
   * already carries `category_id` + `service_type_id` directly, the
   * JOIN through tbl_deep_skill is unnecessary — we filter inline.
   */
  const skillClauses = [];
  const skillParams  = [];
  if (applyDeepSkill && (job.fk_service_catg_id || job.fk_service_type_id)) {
    let predicate = `EXISTS (
      SELECT 1
        FROM tbl_efr_deepskill_mapping m
       WHERE m.easyfixer_id = e.efr_id
         AND m.is_repairing = 1`;
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
  let deepSkillQuery;
  if (job.fk_service_catg_id || job.fk_service_type_id) {
    let sql = `SELECT DISTINCT m.easyfixer_id AS efr_id
                 FROM tbl_efr_deepskill_mapping m
                WHERE m.easyfixer_id IN (${placeholders})
                  AND m.is_repairing = 1`;
    const params = [...efrIds];
    if (job.fk_service_catg_id) { sql += ' AND m.category_id = ?';     params.push(job.fk_service_catg_id); }
    if (job.fk_service_type_id) { sql += ' AND m.service_type_id = ?'; params.push(job.fk_service_type_id); }
    deepSkillQuery = pool.query(sql, params);
  } else {
    // No skill criteria on the job — every tech trivially "matches".
    deepSkillQuery = Promise.resolve([efrIds.map((id) => ({ efr_id: id }))]);
  }

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
    conflictRowsResult,
    [ratingRows],
    [tatRows],
    [sdaRows],
    workedClientRowsResult,
    workedVerticalRowsResult,
    attRowsResult,
    deepSkillResult,
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

    // Time-slot conflicts (only if we have date+slot)
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

    // Attendance marked today? Fail-soft if the table name differs.
    pool.query(
      `SELECT efr_id
         FROM tbl_easyfixer_attendance
        WHERE efr_id IN (${placeholders})
          AND DATE(attendance_date) = CURDATE()`,
      efrIds
    ).catch(() => [[]]),

    // Deep-skill match per tech (built above so the SQL stays readable).
    deepSkillQuery,
  ]);

  // Build maps from the parallel results.
  const activeMap = new Map(activeRows.map((r) => [r.efr_id, Number(r.active_jobs)]));
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
    out.set(id, {
      active_jobs:        activeMap.get(id) ?? 0,
      has_conflict:       conflictMap.get(id) === true,
      avg_rating:         ratingMap.get(id) ?? defaultRating,
      avg_tat_hours:      tatRow ? tatRow.hours : null,
      tat_history:        tatRow ? tatRow.count > 0 : false,
      sda_rate:           sdaRow ? sdaRow.rate : null,
      sda_history:        !!sdaRow,
      worked_for_client:  workedClientMap.get(id) === true,
      worked_for_vertical:workedVerticalMap.get(id) === true,
      attendance_marked:  attendanceMap.get(id) === true,
      has_deep_skill:     deepSkillMap.get(id) === true,
      tat_target_hours:   tatTargetHours,
      max_concurrent:     maxConcurrent,
      // Defaults travel through to scoreOne so per-job overrides work.
      default_tat_score:  Number(defaultTatScore) || DEFAULTS.DEFAULT_TAT_SCORE,
      default_sda_score:  Number(defaultSdaScore) || DEFAULTS.DEFAULT_SDA_SCORE,
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
 */
async function rankCandidatesForJob(jobId, { limit = 50 } = {}) {
  const job = await jobService.getById(jobId);
  if (!job) {
    const err = new Error('job not found'); err.status = 404; throw err;
  }
  const alreadyAssigned = !!job.fk_easyfixter_id;
  const assignedEfrId = alreadyAssigned ? Number(job.fk_easyfixter_id) : null;

  /*
   * Resolve human labels for the job's service category + type so the
   * Assign / Reassign modal header can display the actual deep-skill
   * the job needs (not just a service_category_id). Single round-trip
   * with two scalar subqueries — both are PK lookups, sub-ms each.
   * Returns nulls if the job has no assigned category/type.
   */
  let deepSkillLabel = null;
  if (job.fk_service_catg_id || job.fk_service_type_id) {
    const [[labels]] = await pool.query(
      `SELECT
         (SELECT service_catg_name FROM tbl_service_catg WHERE service_catg_id = ?) AS catg_name,
         (SELECT service_type_name FROM tbl_service_type WHERE service_type_id = ?) AS type_name`,
      [job.fk_service_catg_id || 0, job.fk_service_type_id || 0]
    );
    // "Carpentry > Wood Repair" if both present, else whichever's set.
    deepSkillLabel = [labels?.catg_name, labels?.type_name].filter(Boolean).join(' › ') || null;
  }

  // L1 with deep-skill on; fallback if 0.
  let eligible = await l1Eligibility(job, { applyDeepSkill: true });
  let note = null;
  if (eligible.length === 0 && (job.fk_service_catg_id || job.fk_service_type_id)) {
    eligible = await l1Eligibility(job, { applyDeepSkill: false });
    if (eligible.length > 0) note = 'no_deep_skill_match';
  }

  if (eligible.length === 0) {
    return {
      job, alreadyAssigned, note: note ?? 'no_eligible_techs',
      l1Count: 0, l2Count: 0, candidates: [], rejected: [],
      config: { weights: SCORE_WEIGHTS, performance_sub: PERFORMANCE_SUB },
    };
  }

  const stats = await statsForCandidates(eligible.map((e) => e.efr_id), job, job.fk_client_id);

  const scored = [];
  const rejected = [];
  for (const e of eligible) {
    const s = stats.get(e.efr_id);

    // L2 — availability
    if (s.active_jobs >= s.max_concurrent) {
      rejected.push({ efr_id: e.efr_id, efr_name: e.efr_name, reason: `saturated (${s.active_jobs} active jobs)` }); continue;
    }
    if (s.has_conflict) {
      rejected.push({ efr_id: e.efr_id, efr_name: e.efr_name, reason: 'time-slot conflict on requested date' }); continue;
    }

    // Workload removed from scoring — Max Concurrent Jobs already filters
    // saturated techs at L2, so a workload kicker would double-count.
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

    // Balance is informational — NOT used to sort or filter the ranked list.
    // pickAutoAssignCandidate() applies the floor at commit time when the
    // job's paid_by = 'customer'; manual operators see the value and decide.
    const balance = Number(e.current_balance ?? 0);

    scored.push({
      efr_id:        e.efr_id,
      efr_name:      e.efr_name,
      efr_no:        e.efr_no,
      efr_email:     e.efr_email,
      city_name:     e.city_name,
      current_balance: balance,
      active_jobs:   s.active_jobs,
      avg_rating:    Number((s.avg_rating ?? 0).toFixed(2)),
      avg_tat_hours: s.avg_tat_hours == null ? null : Number(s.avg_tat_hours.toFixed(1)),
      tat_history:   s.tat_history,
      sda_rate:      s.sda_rate == null ? null : Number(s.sda_rate.toFixed(2)),
      sda_history:   s.sda_history,
      worked_for_client:   s.worked_for_client,
      worked_for_vertical: s.worked_for_vertical,
      attendance_marked:   s.attendance_marked,
      has_deep_skill:      s.has_deep_skill,
      score:        Number(out.total.toFixed(4)),
      performance:  Number(out.performance.toFixed(4)),
      grade:        out.grade,
      breakdown:    Object.fromEntries(Object.entries(out.breakdown).map(([k, v]) => [k, Number(Number(v).toFixed(3))])),
    });
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
    job: {
      job_id: job.job_id,
      fk_client_id: job.fk_client_id,
      city_id: job.city_id,
      city_name: job.city_name,
      pin_code: job.pin_code,
      service_category: job.service_categories_dashboard,
      requested_date_time: job.requested_date_time,
      time_slot: job.time_slot,
      paid_by: job.paid_by ?? null,
      paid_by_label: paidByLabel(job.paid_by),
      assigned_efr_id: assignedEfrId,
      deep_skill_label: deepSkillLabel,
    },
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

  const assignedRow = {
    efr_id:        techRow.efr_id,
    efr_name:      techRow.efr_name,
    efr_no:        techRow.efr_no,
    efr_email:     techRow.efr_email,
    city_name:     techRow.city_name,
    current_balance: Number(techRow.current_balance ?? 0),
    active_jobs:   s.active_jobs,
    avg_rating:    Number((s.avg_rating ?? 0).toFixed(2)),
    avg_tat_hours: s.avg_tat_hours == null ? null : Number(s.avg_tat_hours.toFixed(1)),
    tat_history:   s.tat_history,
    sda_rate:      s.sda_rate == null ? null : Number(s.sda_rate.toFixed(2)),
    sda_history:   s.sda_history,
    worked_for_client:   s.worked_for_client,
    worked_for_vertical: s.worked_for_vertical,
    attendance_marked:   s.attendance_marked,
    has_deep_skill:      s.has_deep_skill,
    score:        Number(out.total.toFixed(4)),
    performance:  Number(out.performance.toFixed(4)),
    grade:        out.grade,
    breakdown:    Object.fromEntries(Object.entries(out.breakdown).map(([k, v]) => [k, Number(Number(v).toFixed(3))])),
    is_current:   true,
  };
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

module.exports = {
  rankCandidatesForJob,
  pickAutoAssignCandidate,
  SCORE_WEIGHTS,
  PERFORMANCE_SUB,
  DEFAULTS,
};
