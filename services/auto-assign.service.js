const { pool } = require('../db');
const logger = require('../logger');
const jobService = require('./job.service');

/*
 * 3-layer auto-assignment pipeline (blueprint §5).
 *
 * NOTE (2026-04-20): Distance switched from haversine GPS to ZONE-based
 * eligibility. Technicians work only in zones they're explicitly mapped to
 * (via tbl_easyfixer.efr_zone_city_id → tbl_zone_city_mapping → tbl_zone_master).
 * Customer pincode → zones is resolved through pincode_firefox_city_mapping.
 * Distance scoring removed from L3 entirely; the weight previously held by
 * distance (0.35) is redistributed across the remaining three dimensions.
 *
 * Layer 1 — SQL eligibility filter:
 *   - efr_service_category matches job's service category (LIKE '%…%')
 *   - efr_cityId == job's city
 *   - efr_status = 1
 *   - is_technician_verified = 1
 *   - efr_id NOT in scheduling_history for this job with a non-null
 *     reschedule_reason (covers BOTH manual reschedules AND mobile rejections —
 *     the reject endpoint writes the reason into the same column).
 *   - efr_zone_city_id ∈ (city_zone rows whose zone covers the customer's
 *     pincode). A tech with no zone mapping is excluded entirely.
 *
 * Layer 2 — code availability filter:
 *   - active jobs (status 0/1/2) < MAX_CONCURRENT_JOBS
 *   - no overlapping time-slot booking on same date
 *   (Distance check removed — zone match already encodes serviceability.)
 *
 * Layer 3 — weighted scoring (higher = better), stats from last 90 days:
 *   workload_score   = (MAX_JOBS - active_jobs) / MAX_JOBS
 *   rating_score     = avg_customer_rating / 5                  (default 3.0 if no ratings)
 *   completion_score = completed / (completed + cancelled)      (default 0.8 if no history)
 *   score = W_WORK·w + W_RATE·r + W_COMP·c
 *   Default weights: 0.45 / 0.30 / 0.25 (formerly 0.30 / 0.20 / 0.15 with
 *   distance taking 0.35; redistributed proportionally so the engine still
 *   normalises around 1.0 even though one dimension is gone).
 */

const CONFIG = {
  get MAX_CONCURRENT_JOBS()       { return Number(process.env.MAX_CONCURRENT_JOBS || 5); },
  get W_WORKLOAD()                { return Number(process.env.WEIGHT_WORKLOAD || 0.45); },
  get W_RATING()                  { return Number(process.env.WEIGHT_RATING || 0.30); },
  get W_COMPLETION()              { return Number(process.env.WEIGHT_COMPLETION || 0.25); },
  STATS_LOOKBACK_DAYS: 90,
  DEFAULT_RATING: 3.0,
  DEFAULT_COMPLETION: 0.8,
};

/*
 * Weight model
 * ────────────
 *   3 DIMENSION weights — each ONE row in tbl_autoallocation_setting.
 *   Workload + Rating + Completion must sum to 1.0 (validated client-side
 *   in the CRM Settings page; engine still normalises defensively).
 *
 *   Within Completion only, 3 SUB-WEIGHT proportions split the dimension W
 *   across the failure modes:
 *     cancellation_weight + escalation_weight + estimate_rejection_weight = 1.0
 *
 *   Sub-weight contribution to final score = W_completion × proportion.
 *
 *   Per-failure-mode SCORING (e.g. computing each tech's cancellation rate
 *   separately and weighting those) is not yet implemented — until it is,
 *   the engine treats W_completion as a single signal. The sub-weight rows
 *   are stored + surfaced in the UI so ops can configure them ahead of the
 *   engine catching up; no runtime effect today.
 *
 *   Legacy `*_weight` rows (distance, tat, ota, sda, margin, phone_picked,
 *   skill_matching, performance) are vestigial — not bucketed here and not
 *   shown in the UI. Engine ignores them.
 *
 * This map MUST stay in sync with WEIGHT_CATEGORIES in
 *   Easyfix_CRM_UI/src/app/(authed)/settings/auto-allocation/page.tsx
 */
const WEIGHT_BUCKETS = {
  workload:   ['workload_weight'],
  rating:     ['rating_weight'],
  completion: ['completion_weight'],
};
// Reserved for the future per-failure-mode scoring expansion.
// eslint-disable-next-line no-unused-vars
const COMPLETION_SUB_WEIGHTS = ['cancellation_weight', 'escalation_weight', 'estimate_rejection_weight'];
const KEY_TO_BUCKET = (() => {
  const m = new Map();
  for (const bucket of Object.keys(WEIGHT_BUCKETS)) {
    for (const key of WEIGHT_BUCKETS[bucket]) m.set(key, bucket);
  }
  return m;
})();

/*
 * Resolve the effective {W_workload, W_rating, W_completion} for a given
 * client. Pulls every weight setting once via settingsService (which handles
 * client-override → global-default → built-in fallback per key) and sums by
 * bucket. Pure cost: ~1 DB roundtrip per scoring call (the bulk variant
 * batches via the same path).
 */
async function effectiveWeights(clientId) {
  const settings = require('./settings.service');
  const out = { workload: 0, rating: 0, completion: 0 };
  for (const [key, bucket] of KEY_TO_BUCKET.entries()) {
    try {
      const raw = await settings.getClientSetting(clientId, key);
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) out[bucket] += n;
    } catch { /* missing key — fine, bucket falls back to default */ }
  }
  // Fallback to the built-in default if a bucket has no contributing rows.
  if (out.workload   === 0) out.workload   = CONFIG.W_WORKLOAD;
  if (out.rating     === 0) out.rating     = CONFIG.W_RATING;
  if (out.completion === 0) out.completion = CONFIG.W_COMPLETION;
  return out;
}

// ─── Layer 1: SQL eligibility (city + zone + skill + history) ───────
/*
 * Customer pincode → set of zone_city_mapping rows (city_zone_id) that the
 * tech's `efr_zone_city_id` must belong to.
 *
 * The chain (no FK between the two pincode tables — joined on city_name string,
 * see services/zone.service.js for the shape rationale):
 *   pincode → pincode_firefox_city_mapping.city_name
 *           → tbl_city.city_name
 *           → tbl_zone_city_mapping.city_id (gives city_zone_id + zone_id)
 *           → tbl_zone_master.zone_id
 *
 * If the customer's pincode resolves to NO zones, returns [] — the engine
 * surfaces this as "no L1 candidates" so ops know the address is out of
 * coverage rather than that no tech happened to match.
 */
async function eligibleCandidates(job) {
  const customerPincode = job.pin_code ?? null;

  // Resolve customer pincode → set of city_zone_ids. Done as its own query so
  // a missing/unmapped pincode is observable in logs and we can short-circuit.
  let cityZoneIds = [];
  if (customerPincode) {
    const [zoneRows] = await pool.query(
      `SELECT DISTINCT zcm.city_zone_id
         FROM pincode_firefox_city_mapping p
         JOIN tbl_city                  c   ON c.city_name      = p.city_name
         JOIN tbl_zone_city_mapping     zcm ON zcm.city_id      = c.city_id
         LEFT JOIN tbl_zone_master      zm  ON zm.zone_id       = zcm.zone_id
        WHERE p.pincode = ?
          AND (zm.zone_id IS NULL OR zm.zone_status = 1)`,
      [customerPincode]
    );
    cityZoneIds = zoneRows.map((r) => r.city_zone_id);
  }
  if (cityZoneIds.length === 0) {
    logger.debug(`L1: customer pincode ${customerPincode ?? '(missing)'} resolves to no zones → empty candidate set`);
    return [];
  }

  /*
   * Skill match — DEEP SKILL based (replaces the old efr_service_category
   * LIKE substring match, which was a denormalised CSV with no FK integrity).
   *
   * The chain:
   *   tbl_efr_deepskill_mapping  — (efr_id, deepskill_id) — what the tech is qualified for
   *   tbl_deep_skill             — leaf rows (category_id, service_type_id, deepskill_name, status)
   *
   * A technician is eligible if at least one of their MAPPED deepskills aligns
   * with what the job needs:
   *   - If the job has both fk_service_catg_id and fk_service_type_id, both
   *     must match on the SAME mapping row (most precise).
   *   - If only category is set, the tech needs ANY active deep-skill in
   *     that category.
   *   - If neither is set on the job (legacy / partial data), skill match
   *     is skipped — the zone + city + verification filters still run.
   * Inactive deep-skills (tbl_deep_skill.status = 0) are excluded so
   * deactivating a skill immediately stops auto-assign from offering it,
   * even if old mapping rows still reference it.
   */
  const skillClauses = [];
  const skillParams  = [];
  if (job.fk_service_catg_id || job.fk_service_type_id) {
    let predicate = `EXISTS (
      SELECT 1
        FROM tbl_efr_deepskill_mapping m
        JOIN tbl_deep_skill ds ON ds.deepskill_id = m.deepskill_id
       WHERE m.efr_id = e.efr_id
         AND ds.status = 1`;
    if (job.fk_service_catg_id) { predicate += ' AND ds.category_id = ?';     skillParams.push(job.fk_service_catg_id); }
    if (job.fk_service_type_id) { predicate += ' AND ds.service_type_id = ?'; skillParams.push(job.fk_service_type_id); }
    predicate += ')';
    skillClauses.push(predicate);
  }
  const skillSql = skillClauses.length ? ` AND ${skillClauses.join(' AND ')}` : '';

  const placeholders = cityZoneIds.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT e.efr_id, e.efr_name, e.efr_no, e.efr_email,
            e.efr_zone_city_id,
            e.efr_service_category, e.efr_cityId,
            e.is_technician_verified
       FROM tbl_easyfixer e
      WHERE e.efr_status = 1
        AND e.is_technician_verified = 1
        AND e.efr_cityId = ?
        ${skillSql}
        AND e.efr_zone_city_id IN (${placeholders})
        AND e.efr_id NOT IN (
          SELECT sh.easyfixer_id FROM scheduling_history sh
           WHERE sh.job_id = ? AND sh.reschedule_reason IS NOT NULL AND sh.reschedule_reason <> ''
        )`,
    [job.city_id, ...skillParams, ...cityZoneIds, job.job_id]
  );
  return rows;
}

// ─── Layer 2 + 3: batch stats for candidates ────────────────────────
async function statsForCandidates(efrIds, jobRequestedTs, jobTimeSlot) {
  if (efrIds.length === 0) return new Map();
  const placeholders = efrIds.map(() => '?').join(',');

  // active jobs (open/scheduled/in-progress)
  const [activeRows] = await pool.query(
    `SELECT fk_easyfixter_id AS efr_id, COUNT(*) AS active_jobs
       FROM tbl_job WHERE fk_easyfixter_id IN (${placeholders})
                      AND job_status IN (0, 1, 2)
      GROUP BY fk_easyfixter_id`,
    efrIds
  );
  const activeMap = new Map(activeRows.map((r) => [r.efr_id, Number(r.active_jobs)]));

  // time-slot conflicts: any job on same date+slot
  const reqDate = jobRequestedTs ? new Date(jobRequestedTs).toISOString().slice(0, 10) : null;
  const conflictMap = new Map();
  if (reqDate && jobTimeSlot) {
    const [conflicts] = await pool.query(
      `SELECT DISTINCT fk_easyfixter_id AS efr_id
         FROM tbl_job
        WHERE fk_easyfixter_id IN (${placeholders})
          AND DATE(requested_date_time) = ?
          AND time_slot = ?
          AND job_status IN (0, 1, 2)`,
      [...efrIds, reqDate, jobTimeSlot]
    );
    for (const r of conflicts) conflictMap.set(r.efr_id, true);
  }

  // rating (90d avg)
  const [ratingRows] = await pool.query(
    `SELECT easyfixer_id AS efr_id, AVG(customer_rating) AS avg_rating, COUNT(*) AS rating_count
       FROM tbl_easyfixer_rating_by_customer
      WHERE easyfixer_id IN (${placeholders})
        AND insert_date_time >= DATE_SUB(NOW(), INTERVAL ${CONFIG.STATS_LOOKBACK_DAYS} DAY)
      GROUP BY easyfixer_id`,
    efrIds
  );
  const ratingMap = new Map(ratingRows.map((r) => [r.efr_id, Number(r.avg_rating)]));

  // completion ratio (90d)
  const [histRows] = await pool.query(
    `SELECT fk_easyfixter_id AS efr_id,
            SUM(CASE WHEN job_status IN (3, 5) THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN job_status = 6 THEN 1 ELSE 0 END) AS cancelled
       FROM tbl_job
      WHERE fk_easyfixter_id IN (${placeholders})
        AND created_date_time >= DATE_SUB(NOW(), INTERVAL ${CONFIG.STATS_LOOKBACK_DAYS} DAY)
      GROUP BY fk_easyfixter_id`,
    efrIds
  );
  const completionMap = new Map();
  for (const r of histRows) {
    const c = Number(r.completed);
    const x = Number(r.cancelled);
    if (c + x > 0) completionMap.set(r.efr_id, c / (c + x));
  }

  // merge
  const out = new Map();
  for (const id of efrIds) {
    out.set(id, {
      active_jobs: activeMap.get(id) ?? 0,
      has_conflict: conflictMap.get(id) === true,
      avg_rating:   ratingMap.get(id) ?? CONFIG.DEFAULT_RATING,
      completion:   completionMap.get(id) ?? CONFIG.DEFAULT_COMPLETION,
    });
  }
  return out;
}

/*
 * Normalise the 3 dimension weights so they sum to 1.0. Without this, ops
 * editing sub-weights would push the *final* score outside [0, 1] and make
 * cross-job comparisons meaningless. Normalisation only affects the absolute
 * score — the relative RANK of candidates is unchanged, so the assignment
 * decision is identical either way.
 */
function normaliseWeights(weights) {
  const sum = weights.workload + weights.rating + weights.completion;
  if (sum <= 0) {
    // Pathological: every bucket is 0. Fall back to built-in defaults so we
    // never produce NaN scores.
    return {
      workload:   CONFIG.W_WORKLOAD,
      rating:     CONFIG.W_RATING,
      completion: CONFIG.W_COMPLETION,
      raw_sum:    sum,
    };
  }
  return {
    workload:   weights.workload   / sum,
    rating:     weights.rating     / sum,
    completion: weights.completion / sum,
    raw_sum:    sum,
  };
}

function score({ activeJobs, rating, completion }, weights) {
  const MAX_J = CONFIG.MAX_CONCURRENT_JOBS;
  const wS = Math.max(0, (MAX_J - activeJobs) / MAX_J);
  const rS = Math.max(0, Math.min(1, rating / 5));
  const cS = Math.max(0, Math.min(1, completion));
  const total =
    weights.workload   * wS +
    weights.rating     * rS +
    weights.completion * cS;
  return { total, breakdown: { workload: wS, rating: rS, completion: cS } };
}

// ─── Main candidates entrypoint ─────────────────────────────────────
/*
 * `ignoreDistance` is preserved as an accepted option for API compat (the
 * preview endpoint still passes it through) but is now a no-op — there's no
 * distance gate to bypass. We accept-and-ignore rather than 400'ing so old
 * callers in the wild don't break.
 */
async function getCandidates(jobId, { limit = 10, ignoreDistance = false } = {}) { // eslint-disable-line no-unused-vars
  const job = await jobService.getById(jobId);
  if (!job) {
    const err = new Error('job not found'); err.status = 404; throw err;
  }
  if (job.fk_easyfixter_id) {
    return {
      job,
      alreadyAssigned: true,
      assignedTo: job.fk_easyfixter_id,
      candidates: [],
    };
  }

  const eligible = await eligibleCandidates(job);
  if (eligible.length === 0) {
    return {
      job,
      alreadyAssigned: false,
      candidates: [],
      l1Count: 0,
      rejectedCount: 0,
      notes: [job.pin_code
        ? `pincode ${job.pin_code} may be outside any mapped zone, or no verified tech in the zone matches the service category`
        : 'customer pincode missing on this job'],
    };
  }

  const [stats, rawWeights] = await Promise.all([
    statsForCandidates(
      eligible.map((e) => e.efr_id),
      job.requested_date_time,
      job.time_slot
    ),
    effectiveWeights(job.fk_client_id),
  ]);
  // Normalise once per request; the same normalised weights apply to every
  // candidate scored in this pass.
  const weights = normaliseWeights(rawWeights);

  const scored = [];
  const rejected = [];
  for (const e of eligible) {
    const s = stats.get(e.efr_id);

    // L2 filters (zone match already happened in L1 — only workload + slot conflict here)
    if (s.active_jobs >= CONFIG.MAX_CONCURRENT_JOBS) {
      rejected.push({ efr_id: e.efr_id, reason: `saturated (${s.active_jobs} active jobs)` }); continue;
    }
    if (s.has_conflict) {
      rejected.push({ efr_id: e.efr_id, reason: 'time-slot conflict on requested date' }); continue;
    }

    // L3 scoring (normalised weights → final score in [0, 1])
    const scoreObj = score({
      activeJobs: s.active_jobs, rating: s.avg_rating, completion: s.completion,
    }, weights);
    scored.push({
      efr_id: e.efr_id,
      efr_name: e.efr_name,
      efr_no: e.efr_no,
      active_jobs: s.active_jobs,
      avg_rating: Number(s.avg_rating.toFixed(2)),
      completion_ratio: Number(s.completion.toFixed(2)),
      score: Number(scoreObj.total.toFixed(4)),
      breakdown: Object.fromEntries(Object.entries(scoreObj.breakdown).map(([k, v]) => [k, Number(v.toFixed(3))])),
    });
  }

  scored.sort((a, b) => b.score - a.score);

  return {
    job: {
      job_id: job.job_id,
      requested_date_time: job.requested_date_time,
      time_slot: job.time_slot,
      city_id: job.city_id,
      city_name: job.city_name,
      pin_code: job.pin_code,
      service_category: job.service_categories_dashboard,
    },
    alreadyAssigned: false,
    config: {
      MAX_CONCURRENT_JOBS: CONFIG.MAX_CONCURRENT_JOBS,
      // `weights` is what the engine actually used (normalised, sum = 1.0)
      // `weightsRaw` is the per-bucket sum BEFORE normalisation, so the UI
      // can show ops both "what you set" and "what the engine ranked with".
      weights: {
        workload:   Number(weights.workload.toFixed(3)),
        rating:     Number(weights.rating.toFixed(3)),
        completion: Number(weights.completion.toFixed(3)),
      },
      weightsRaw: {
        workload:   Number(rawWeights.workload.toFixed(3)),
        rating:     Number(rawWeights.rating.toFixed(3)),
        completion: Number(rawWeights.completion.toFixed(3)),
        sum:        Number((rawWeights.workload + rawWeights.rating + rawWeights.completion).toFixed(3)),
      },
    },
    l1Count: eligible.length,
    rejectedCount: rejected.length,
    candidates: scored.slice(0, limit),
    rejectedSample: rejected.slice(0, 10),
  };
}

// ─── Single-job auto-assign ─────────────────────────────────────────
/*
 * Auto-assign now DELEGATES to candidate-ranking.service.rankCandidatesForJob
 * — single source of truth for the layered pipeline. The legacy in-file
 * eligibleCandidates / statsForCandidates / score functions remain for
 * backward compatibility with anything that imported them directly, but
 * the assign + bulk-assign code paths below all consume the shared service.
 *
 * Post-assignment side-effects (TechAssigned webhook, FCM push, failure-
 * notification email) are unchanged — they fire from jobService.assign().
 */
const candidateRanking = require('./candidate-ranking.service');

async function assignTopCandidate(jobId, actor) {
  // Attendance is hard-filtered only for jobs scheduled TODAY/TOMORROW (the
  // window technicians can mark attendance for) — the ranking service
  // window-gates it internally — so far-future on-create auto-assign is
  // unaffected. Keep the default (no per-caller override needed).
  const result = await candidateRanking.rankCandidatesForJob(jobId, { limit: 50 });

  if (result.alreadyAssigned) {
    const err = new Error(`job ${jobId} is already assigned`);
    err.status = 409;
    throw err;
  }
  if (!result.candidates.length) {
    const err = new Error(
      result.note === 'no_deep_skill_match'
        ? 'no candidate matched the deep-skill required for this job'
        : 'no eligible candidate found'
    );
    err.status = 422;
    err.details = { l1Count: result.l1Count, rejectedCount: result.rejected.length, note: result.note };
    throw err;
  }

  // Customer-paid jobs need a tech with cash on hand; pickAutoAssignCandidate
  // walks the ranked list and grabs the first one over the floor (or the
  // top-ranked tech with a `low_balance` flag if nobody clears it).
  const pick = candidateRanking.pickAutoAssignCandidate(result, { paidBy: result.job.paid_by });
  const top = pick.candidate;

  const assigned = await jobService.assign(jobId, { easyfixerId: top.efr_id }, actor);
  return {
    job: assigned,
    chosen: top,
    pick_reason: pick.reason,
    low_balance: pick.low_balance,
    l1Count: result.l1Count,
    rejectedCount: result.rejected.length,
    note: result.note,
  };
}

// ─── Bulk auto-assign for all unassigned booked jobs ────────────────
async function bulkAssignUnassigned({ limit = 50, dryRun = false } = {}, actor) {
  const [unassigned] = await pool.query(
    `SELECT job_id FROM tbl_job
      WHERE fk_easyfixter_id IS NULL
        AND job_status = ${jobService.STATUS.BOOKED}
      ORDER BY job_id ASC LIMIT ?`,
    [Number(limit)]
  );

  const results = [];
  let assignedCount = 0;
  for (const { job_id } of unassigned) {
    try {
      // Attendance gate is window-limited to today/tomorrow in the ranking
      // service, so far-future on-create jobs are unaffected. Keep the default.
      const ranked = await candidateRanking.rankCandidatesForJob(job_id, { limit: 50 });
      if (!ranked.candidates.length) {
        results.push({
          jobId: job_id, status: 'no_candidate',
          l1Count: ranked.l1Count, rejectedCount: ranked.rejected.length,
          note: ranked.note,
        });
        continue;
      }
      const pick = candidateRanking.pickAutoAssignCandidate(ranked, { paidBy: ranked.job.paid_by });
      const top = pick.candidate;
      if (dryRun) {
        results.push({
          jobId: job_id, status: 'would_assign', efrId: top.efr_id, score: top.score,
          pick_reason: pick.reason, low_balance: pick.low_balance,
        });
      } else {
        await jobService.assign(job_id, { easyfixerId: top.efr_id }, actor);
        assignedCount++;
        results.push({
          jobId: job_id, status: 'assigned', efrId: top.efr_id, score: top.score,
          pick_reason: pick.reason, low_balance: pick.low_balance,
        });
      }
    } catch (e) {
      logger.warn({ jobId: job_id, err: e.message }, 'bulk auto-assign row failed');
      results.push({ jobId: job_id, status: 'failed', error: e.message });
    }
  }
  return { summary: { examined: unassigned.length, assignedCount, dryRun }, results };
}

module.exports = { getCandidates, assignTopCandidate, bulkAssignUnassigned, CONFIG };
