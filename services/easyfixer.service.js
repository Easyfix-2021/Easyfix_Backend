const { pool } = require('../db');
const logger = require('../logger');
const lifecycleService = require('./easyfixer-lifecycle.service');
const {
  mapAadhaarUniqueViolation,
  normalizeAadhaar,
  withActiveAadhaarGuard,
} = require('../utils/aadhaar-uniqueness');

/*
 * Easyfixer (technician) CRUD.
 *
 * Important notes about the live table (2026-04-17):
 *   - tbl_easyfixer has 86 columns. We expose a curated projection in list
 *     responses (~14 cols) and a fuller one in detail responses. Never return
 *     the raw SELECT * on lists — the payload size hurts perf.
 *   - efr_no (mobile) is the business identifier BUT is NOT enforced unique
 *     at the DB level. Duplicates exist in production data. We detect active
 *     duplicates on create and return 409; we do not block updates.
 *   - Several column names drift from the blueprint; the DB is authoritative.
 *     See CLAUDE.md "Table-name reconciliations" + easyfixer glossary.
 *
 * All queries parameterised. Status toggles use soft-delete semantics —
 * we flip efr_status, never DELETE.
 */

// ─── Projections ────────────────────────────────────────────────────
// Manage Easyfixers parity (2026-06-08): the BASE list returns a minimal
// projection only — no expensive aggregations. Earnings/job-count/rating/
// clients_mapped/today-attendance are now fetched lazily by the FE via:
//   POST /admin/easyfixers/aggregates  → clients_mapped, total_earnings, job_count, avg_rating
//   POST /admin/easyfixers/attendance  → today's attendance slots
// EF Account label and the cheap city/state/zonal-manager joins are kept
// here — `team` scans tiny `tbl_easyfixer`, the rest are PK lookups.
const LIST_COLUMNS = `
  e.efr_id, e.efr_name, e.efr_first_name, e.efr_last_name,
  e.efr_no, e.efr_email, e.efr_cityId, c.city_name AS city_name,
  e.efr_status, e.efr_service_category, e.efr_service_type,
  e.efr_profile_perc, e.is_technician_verified,
  e.scheduled_reactivation_date,
  e.final_submission, e.new_easy_fixer,
  e.user_id,
  U.is_personal_detail_filled AS lifecycle_personal_submitted,
  (e.adhaar_card_number IS NOT NULL AND e.adhaar_card_number <> '') AS lifecycle_aadhaar_present,
  (e.efr_profile_img IS NOT NULL AND e.efr_profile_img <> '') AS lifecycle_photo_present,
  /*
   * Column-name mapping (2026-06-08). The legacy Java DAO reads
   * personalDetailsFilled / isIdentityDetailsVerified -- names without
   * the _by_crm suffix. The actual DB column names ARE suffixed
   * (is_personal_details_verified_by_crm, is_identity_details_verified_by_crm).
   * Legacy populated the un-suffixed field names via SELECT aliases.
   * We mirror that here so the FE / Joi validators see the un-suffixed
   * names while the SQL targets the real columns.
   *
   * Schema drift gate: an earlier version of this query targeted the
   * un-suffixed names directly. That caused "Unknown column" 500s on
   * deploys where only the _by_crm columns exist. If a future deploy
   * has BOTH names, the alias still wins.
   *
   * NOTE: this comment is INSIDE the LIST_COLUMNS template literal --
   * do not use backtick chars in this block or they will close the
   * template literal early and crash the module load with a parser
   * error pointing here.
   */
  /*
   * Column-source mapping (2026-06-08 v2 — corrected after legacy audit).
   *
   * Two legacy fields are sourced from DIFFERENT tables than the
   * earlier guess:
   *   - personal_details_filled       lives on tbl_user, NOT tbl_easyfixer.
   *                                   Legacy alias U.personal_details_filled.
   *   - is_identity_details_verified  lives on tbl_easyfixer as the
   *                                   _by_crm-suffixed column. Aliased
   *                                   below so downstream code reads
   *                                   the legacy name.
   *
   * Without sourcing personal_details_filled from tbl_user, the
   * "Not Eligible" bucket reads 0 rows on QA (the tbl_easyfixer column
   * I previously targeted has no value=2 data); the missing rows pile
   * into "Registration In Progress" instead, breaking parity counts.
   */
  U.personal_details_filled               AS personal_details_filled,
  e.is_identity_details_verified_by_crm   AS is_identity_details_verified,
  /*
   * Derived 6-status label. Highest-priority WHEN wins, matching
   * "last setter wins" in legacy Java EasyfixerDaoImpl.java#475-505.
   * Priority order top-to-bottom:
   *   Inactive > Active > Not Suitable > Not Eligible >
   *   Registration In Progress > Idle
   */
  CASE
    WHEN e.is_technician_verified = 1 AND e.efr_status = 0                       THEN 'Inactive'
    WHEN e.is_technician_verified = 1                                            THEN 'Active'
    WHEN (e.is_technician_verified IS NULL OR e.is_technician_verified = 0)
         AND e.is_identity_details_verified_by_crm = 2                           THEN 'Not Suitable'
    WHEN U.personal_details_filled = 2                                           THEN 'Not Eligible'
    WHEN e.user_id IS NOT NULL AND e.user_id > 0                                 THEN 'Registration In Progress'
    ELSE 'Idle'
  END AS efr_status_label,
  e.efr_manager_id, e.insert_date, e.update_date,
  c.state_id AS state_id,
  s.state_name AS state_name,
  c.state_user AS zonal_manager_user_id,
  zm.user_name AS user_mapped_to_city,
  e.current_balance AS current_balance,
  e.profile_activation_date_time AS profile_activation_date_time,
  CASE
    WHEN e.efr_manager_id IS NOT NULL AND e.efr_manager_id > 0 THEN 'Under Master'
    WHEN team.team_count > 0 THEN 'Master'
    ELSE 'Individual'
  END AS ef_account
`;

// Shared FROM/JOIN block — used by both the data and the count queries so
// any filter referencing an alias resolves. Only CHEAP joins live here:
//   - tbl_city / tbl_state / tbl_user — PK lookups
//   - team subquery — scans `tbl_easyfixer` (tiny table)
// Expensive aggregations (earn/cm/rt/att) moved to the sub-resource
// endpoints (aggregates / attendance).
const LIST_JOINS = `
  FROM tbl_easyfixer e
  LEFT JOIN tbl_city c ON c.city_id = e.efr_cityId
  LEFT JOIN tbl_state s ON s.state_id = c.state_id
  LEFT JOIN tbl_user zm ON zm.user_id = c.state_user
  /*
   * tbl_user JOIN (2026-06-08) — needed because the legacy "Not Eligible"
   * / "Not Suitable" / "Registration In Progress" status signals all read
   * tbl_user.personal_details_filled (NOT a column on tbl_easyfixer).
   * Legacy alias U; we use the same alias here so the WHERE clauses below
   * read identically to legacy EasyfixerDaoImpl.java lines 212-218.
   * LEFT JOIN because Idle rows have user_id NULL — must not be filtered out.
   */
  LEFT JOIN tbl_user U ON U.user_id = e.user_id
  LEFT JOIN (
    SELECT efr_manager_id, COUNT(*) AS team_count
      FROM tbl_easyfixer
     WHERE efr_manager_id IS NOT NULL AND efr_manager_id > 0
     GROUP BY efr_manager_id
  ) team ON team.efr_manager_id = e.efr_id
`;

const DETAIL_COLUMNS = `
  e.*,
  c.city_name AS city_name
`;

// ─── List ───────────────────────────────────────────────────────────
// `scope` (optional) is the parsed RBAC scope from /auth/me. When
// supplied, the easyfixer list is row-filtered by `e.efr_cityId` against
// scope.cities (and `mode='none'` short-circuits to zero rows).
async function list({
  q, cityId, serviceCategory, isVerified, status, lifecycleStatus,
  scope,
  limit = 50, offset = 0, includeInactive = false,
  // Manage Easyfixers parity filters (2026-06-08)
  easyfixerId, name, mobileNo,
  efAccount, stateId, serviceType, deepSkillId,
  activeFromDate, activeToDate,
  zonalManagerId, attendance, deepSkillMapped,
  sortBy = 'efr_id', sortDir = 'desc',
} = {}) {
  logger.info('List easyfixers · status=' + status + ' cityId=' + cityId + ' q=' + (q || '') + ' limit=' + limit + ' offset=' + offset + ' sortBy=' + sortBy);
  const lifecycleProjection = await lifecycleService.readProjection('e');
  const clauses = [];
  const params = [];

  // RBAC city scope — applied first so any explicit cityId filter
  // narrows within the allowed set.
  if (scope?.cities) {
    const ci = scope.cities;
    if (ci.mode === 'none') clauses.push('1=0');
    else if (ci.mode === 'allow' && ci.ids.length) {
      clauses.push(`e.efr_cityId IN (${ci.ids.map(() => '?').join(',')})`);
      params.push(...ci.ids);
    }
  }

  /*
   * Legacy-parity status filter (2026-06-08). The Manage Easyfixers
   * "Status" dropdown has SIX values, not two. The displayed label is
   * derived from 4 underlying columns per the priority order used by
   * EasyfixerDaoImpl.java#475-505 (last setter wins in Java = highest-
   * priority WHEN-clause wins in SQL CASE):
   *
   *   value=1  Active                  is_technician_verified=1 AND efr_status=1
   *   value=2  Inactive                is_technician_verified=1 AND efr_status=0
   *   value=3  Idle                    (user_id IS NULL OR user_id=0) AND no higher-priority match
   *   value=4  Not Eligible            personal_details_filled=2 AND no higher-priority match
   *   value=5  Not Suitable            (tech_verified!=1) AND is_identity_details_verified=2
   *   value=6  Registration In Progress user_id>0 AND tech_verified!=1
   *                                    AND personal_details_filled!=2
   *                                    AND is_identity_details_verified!=2
   *   value=0  All (no filter)
   *
   * The "no higher-priority match" suffix matters: a row that satisfies
   * BOTH the Idle base (user_id=0) AND the Not Eligible condition
   * (personal_details_filled=2) labels as Not Eligible (higher priority),
   * not Idle. Each filter clause below encodes its own priority guard.
   *
   * Default (when no status supplied AND includeInactive falsy) stays
   * status=1 Active — matches the screenshot's "Status: Active" default.
   */
  // Admin-deleted tombstones carry efr_status = 3 (deleted sentinel). Exclude
  // them from EVERY roster view regardless of the selected status filter
  // (the Idle / Not-Eligible filters below don't otherwise constrain efr_status).
  // NOT (… <=> 3) is NULL-safe — genuine NULL-status rows are NOT dropped.
  clauses.push('NOT (e.efr_status <=> 3)');
  if (status == null && !includeInactive && !lifecycleStatus) {
    // Default: status=1 Active — but NOT when a lifecycle-status filter is set
    // (a PAUSED/INACTIVE lifecycle row has efr_status=0, so the default Active
    // clause would AND it away to zero results).
    clauses.push('e.is_technician_verified = 1 AND e.efr_status = 1');
  } else if (status === 1) {
    clauses.push('e.is_technician_verified = 1 AND e.efr_status = 1');
  } else if (status === 2) {
    clauses.push('e.is_technician_verified = 1 AND e.efr_status = 0');
  } else if (status === 3) {
    // Idle — per legacy Java if(rslt.getUserId() == 0) at EasyfixerDaoImpl.java#484.
    // The legacy SQL doesn't add a WHERE clause for Idle specifically; the
    // user_id=0 check is intrinsic. Mirror that here.
    clauses.push('(e.user_id IS NULL OR e.user_id = 0)');
  } else if (status === 4) {
    // Not Eligible — legacy EasyfixerDaoImpl.java#212 verbatim:
    //   AND U.personal_details_filled = 2
    clauses.push('U.personal_details_filled = 2');
  } else if (status === 5) {
    // Not Suitable — legacy EasyfixerDaoImpl.java#215 verbatim:
    //   AND EF.is_identity_details_verified_by_crm = 2 AND U.personal_details_filled = 1
    clauses.push('e.is_identity_details_verified_by_crm = 2 AND U.personal_details_filled = 1');
  } else if (status === 6) {
    // Registration In Progress ("Active Soon") — legacy EasyfixerDaoImpl.java#218 verbatim:
    //   AND EF.user_id > 0 AND EF.is_technician_verified IS NULL
    //   AND (EF.is_identity_details_verified_by_crm != 2 OR EF.is_identity_details_verified_by_crm IS NULL)
    //   AND (U.personal_details_filled = 1 OR U.personal_details_filled IS NULL)
    // NOTE legacy uses `is_technician_verified IS NULL` strictly (not = 0).
    clauses.push(`e.user_id > 0
                  AND e.is_technician_verified IS NULL
                  AND (e.is_identity_details_verified_by_crm <> 2 OR e.is_identity_details_verified_by_crm IS NULL)
                  AND (U.personal_details_filled = 1 OR U.personal_details_filled IS NULL)`);
  }
  // status === 0 → All → no clause added (returns every row)
  // Optional v5.1 lifecycle-status filter (Manage Easyfixers Status dropdown).
  // Lazy-required + schema-guarded so it's a safe no-op before the lifecycle
  // migration adds the column (and avoids a circular import at module load).
  if (lifecycleStatus) {
    const { hasLifecycleSchema } = require('./easyfixer-lifecycle.service');
    if (await hasLifecycleSchema()) {
      clauses.push('e.lifecycle_status = ?');
      params.push(lifecycleStatus);
    }
  }
  if (q) {
    clauses.push('(e.efr_name LIKE ? OR e.efr_no LIKE ? OR e.efr_email LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (cityId != null) {
    clauses.push('e.efr_cityId = ?');
    params.push(cityId);
  }
  if (serviceCategory) {
    // CSV-stored column — exact-match on a single category via FIND_IN_SET
    // when the value looks numeric (legacy ids), otherwise fall back to LIKE
    // for callers that pass a category name fragment.
    if (/^\d+$/.test(String(serviceCategory))) {
      clauses.push('FIND_IN_SET(?, e.efr_service_category)');
      params.push(String(serviceCategory));
    } else {
      clauses.push('e.efr_service_category LIKE ?');
      params.push(`%${serviceCategory}%`);
    }
  }
  if (isVerified === true)  clauses.push('e.is_technician_verified = 1');
  if (isVerified === false) clauses.push('(e.is_technician_verified = 0 OR e.is_technician_verified IS NULL)');

  // ─── Manage Easyfixers filters ─────────────────────────────────────
  if (easyfixerId != null) {
    clauses.push('e.efr_id = ?');
    params.push(easyfixerId);
  }
  if (name) {
    clauses.push('e.efr_name LIKE ?');
    params.push(`%${name}%`);
  }
  if (mobileNo) {
    clauses.push('e.efr_no LIKE ?');
    params.push(`%${mobileNo}%`);
  }
  if (efAccount === 'under_master') {
    clauses.push('e.efr_manager_id IS NOT NULL AND e.efr_manager_id > 0');
  } else if (efAccount === 'master') {
    clauses.push('(e.efr_manager_id IS NULL OR e.efr_manager_id = 0) AND team.team_count > 0');
  } else if (efAccount === 'individual') {
    clauses.push('(e.efr_manager_id IS NULL OR e.efr_manager_id = 0) AND (team.team_count IS NULL OR team.team_count = 0)');
  }
  if (stateId != null) {
    clauses.push('c.state_id = ?');
    params.push(stateId);
  }
  if (serviceType) {
    if (/^\d+$/.test(String(serviceType))) {
      clauses.push('FIND_IN_SET(?, e.efr_service_type)');
      params.push(String(serviceType));
    } else {
      clauses.push('e.efr_service_type LIKE ?');
      params.push(`%${serviceType}%`);
    }
  }
  if (deepSkillId != null) {
    // Filter by the DEEP SKILL (3rd level). In tbl_efr_deepskill_mapping the
    // physical column parent_skill_id holds tbl_deep_skill.deepskill_id (the
    // "deep skill" id); the deep_skill_id physical column holds the 4th-level
    // OPTION id. is_repairing = 1 excludes soft-deleted skill rows (same shape
    // candidate-ranking uses).
    clauses.push('EXISTS (SELECT 1 FROM tbl_efr_deepskill_mapping dsm WHERE dsm.easyfixer_id = e.efr_id AND dsm.is_repairing = 1 AND dsm.parent_skill_id = ?)');
    params.push(deepSkillId);
  }
  /*
   * Legacy parity (2026-06-08). The legacy CRM's `deepSkillMapped`
   * filter ONLY takes effect when also scoped by serviceCategory /
   * serviceType / deepSkillId (verified via the EasyfixerDaoImpl.java
   * audit — the legacy SQL hard-codes `EDM.category_id = ?` /
   * `EDM.service_type_id = ?` / `EDM.deep_skill_id = ?` inside the
   * EXISTS subquery). Without any of those scope IDs supplied, the
   * legacy filter is effectively a no-op — the default UI label
   * "Mapped To DS" returns ALL active easyfixers, not just those with
   * a row in tbl_efr_deepskill_mapping.
   *
   * Before this gate, the New CRM applied EXISTS unconditionally on
   * the default page load (FE sends `deepSkillMapped: 'mapped'` as the
   * default value), filtering out ~866 active easyfixers who have no
   * deep-skill row → 1335 records on a QA env that legacy returns
   * 2201 for. The gate restores numerical parity.
   *
   * Sane semantics WHEN scope IS supplied:
   *   'mapped'     → EXISTS (HAS a row in tbl_efr_deepskill_mapping)
   *   'not_mapped' → NOT EXISTS (no row)
   * Operators picking a category + "Mapped To DS" now see actually-
   * mapped easyfixers (natural reading), not the legacy's inverted
   * "pending mapping" worklist. If business specifically wants the
   * legacy inverted semantics here, flip the EXISTS/NOT-EXISTS pair.
   */
  const hasDeepSkillScope = serviceCategory != null
    || serviceType != null
    || deepSkillId != null;
  if (deepSkillMapped === 'mapped' && hasDeepSkillScope) {
    clauses.push('EXISTS (SELECT 1 FROM tbl_efr_deepskill_mapping dsm WHERE dsm.easyfixer_id = e.efr_id)');
  } else if (deepSkillMapped === 'not_mapped' && hasDeepSkillScope) {
    clauses.push('NOT EXISTS (SELECT 1 FROM tbl_efr_deepskill_mapping dsm WHERE dsm.easyfixer_id = e.efr_id)');
  }
  if (activeFromDate && activeToDate) {
    clauses.push('DATE(e.profile_activation_date_time) BETWEEN ? AND ?');
    params.push(activeFromDate, activeToDate);
  } else if (activeFromDate) {
    clauses.push('DATE(e.profile_activation_date_time) >= ?');
    params.push(activeFromDate);
  } else if (activeToDate) {
    clauses.push('DATE(e.profile_activation_date_time) <= ?');
    params.push(activeToDate);
  }
  if (zonalManagerId != null) {
    clauses.push('c.state_user = ?');
    params.push(zonalManagerId);
  }
  // Attendance filter — `att` is no longer LEFT JOINed in the base query
  // (moved to POST /attendance sub-resource). Translate filter values to
  // EXISTS/NOT EXISTS so we still scope correctly on today's window.
  if (attendance === 'present') {
    clauses.push(`EXISTS (
      SELECT 1 FROM tbl_easyfixer_attendance att
       WHERE att.easyfixer_id = e.efr_id
         AND att.created_on >= CURDATE()
         AND att.created_on <  CURDATE() + INTERVAL 1 DAY
         AND (att.morning_slot = 1 OR att.evening_slot = 1)
         AND (att.is_leave_marked IS NULL OR att.is_leave_marked = 0)
    )`);
  } else if (attendance === 'absent') {
    clauses.push(`EXISTS (
      SELECT 1 FROM tbl_easyfixer_attendance att
       WHERE att.easyfixer_id = e.efr_id
         AND att.created_on >= CURDATE()
         AND att.created_on <  CURDATE() + INTERVAL 1 DAY
         AND (att.morning_slot IS NULL OR att.morning_slot = 0)
         AND (att.evening_slot IS NULL OR att.evening_slot = 0)
         AND (att.is_leave_marked IS NULL OR att.is_leave_marked = 0)
    )`);
  } else if (attendance === 'on_leave') {
    clauses.push(`EXISTS (
      SELECT 1 FROM tbl_easyfixer_attendance att
       WHERE att.easyfixer_id = e.efr_id
         AND att.created_on >= CURDATE()
         AND att.created_on <  CURDATE() + INTERVAL 1 DAY
         AND att.is_leave_marked = 1
    )`);
  } else if (attendance === 'no_information') {
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM tbl_easyfixer_attendance att
       WHERE att.easyfixer_id = e.efr_id
         AND att.created_on >= CURDATE()
         AND att.created_on <  CURDATE() + INTERVAL 1 DAY
    )`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  // Count must share the same JOINs because filters can reference aliases
  // from joined subqueries (team, att, c, zm).
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total ${LIST_JOINS} ${where}`,
    params
  );

  /*
   * Server-side sort over the COMPLETE filtered set (2026-06-17). Two paths:
   *   - MAIN_SORT columns live on tbl_easyfixer or a cheap LIST_JOINS alias —
   *     ORDER BY them directly (default/fast path, zero extra cost).
   *   - AGG_SORT columns are the 5 rollups the /aggregates endpoint computes
   *     per page. To sort the whole list by them we inject ONE targeted
   *     subquery JOIN (no params — aggregates over all rows) ONLY when that
   *     column is the sort key, so the common case stays as cheap as before.
   * sortBy is whitelisted here (and again in the validator) — defence in depth
   * against injection; unknown keys fall back to e.efr_id.
   */
  const MAIN_SORT = {
    efr_id:                 'e.efr_id',
    efr_name:               'e.efr_name',
    efr_no:                 'e.efr_no',
    efr_email:              'e.efr_email',
    state_name:             's.state_name',
    city_name:              'c.city_name',
    efr_service_category:   'e.efr_service_category',
    efr_service_type:       'e.efr_service_type',
    user_mapped_to_city:    'zm.user_name',
    current_balance:        'e.current_balance',
    efr_profile_perc:       'e.efr_profile_perc',
    is_technician_verified: 'e.is_technician_verified',
    profile_update_sent_at: 'e.profile_update_sent_at',
    insert_date:            'e.insert_date',
    efr_status_label:       'efr_status_label', // SELECT alias (MySQL allows ORDER BY alias)
  };
  const AGG_SORT = {
    clients_mapped:       'SELECT easyfixer_id AS sid, COUNT(DISTINCT client_id) AS sval FROM tbl_client_easyfixer_mapping WHERE mapping_status = 1 GROUP BY easyfixer_id',
    total_earnings:       'SELECT J.fk_easyfixter_id AS sid, SUM(TJT.efr_charge) AS sval FROM tbl_job_transaction TJT JOIN tbl_job J ON J.job_id = TJT.fk_job_id WHERE J.job_status IN (3, 5) GROUP BY J.fk_easyfixter_id',
    // job_count sort reads tbl_job ALONE (no tbl_job_transaction join): an
    // index-only streaming GROUP BY via idx_job_fk_easyfixter_status — ~190ms
    // vs ~2.1s for the txn-join version (which full-scans 338k txns + does a
    // PK lookup per row). Sorts by COMPLETED jobs (status 3/5); matches the
    // displayed txn-gated job_count within ~0.07% (233 of 338,926 completed
    // jobs lack a txn row), so the visible order is identical.
    job_count:            'SELECT fk_easyfixter_id AS sid, COUNT(*) AS sval FROM tbl_job WHERE job_status IN (3, 5) AND fk_easyfixter_id IS NOT NULL GROUP BY fk_easyfixter_id',
    avg_rating:           'SELECT easyfixer_id AS sid, ROUND(AVG(customer_rating), 2) AS sval FROM tbl_easyfixer_rating_by_customer WHERE easyfixer_id > 0 AND comment IS NOT NULL GROUP BY easyfixer_id',
    options_mapped_count: 'SELECT m.easyfixer_id AS sid, COUNT(DISTINCT m.parent_skill_id) AS sval FROM tbl_efr_deepskill_mapping m WHERE m.is_repairing = 1 AND EXISTS (SELECT 1 FROM tbl_deep_skill ds WHERE ds.deepskill_id = m.parent_skill_id AND (ds.status IS NULL OR ds.status <> 0)) GROUP BY m.easyfixer_id',
  };
  const dir = String(sortDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  let sortJoin = '';
  let orderBy;
  if (Object.prototype.hasOwnProperty.call(AGG_SORT, sortBy)) {
    sortJoin = `LEFT JOIN (${AGG_SORT[sortBy]}) sortagg ON sortagg.sid = e.efr_id`;
    orderBy = `ORDER BY COALESCE(sortagg.sval, 0) ${dir}, e.efr_id DESC`;
  } else {
    const col = MAIN_SORT[sortBy] || 'e.efr_id';
    // efr_id is already unique — no tiebreaker needed; everything else gets
    // a stable e.efr_id tiebreaker so paging is deterministic across pages.
    orderBy = col === 'e.efr_id'
      ? `ORDER BY e.efr_id ${dir}`
      : `ORDER BY ${col} ${dir}, e.efr_id DESC`;
  }

  params.push(Number(limit), Number(offset));
  const [rows] = await pool.query(
    `SELECT ${LIST_COLUMNS},
            ${lifecycleProjection}
       ${LIST_JOINS}
       ${sortJoin}
       ${where}
       ${orderBy}
       LIMIT ? OFFSET ?`,
    params
  );
  const items = rows.map((row) => ({
    ...row,
    pause_count: Number(row.lifecycle_pause_count) || 0,
    lifecycle: lifecycleService.lifecycleFromRow(row),
  }));
  logger.info('Returning ' + items.length + ' easyfixers · total=' + total);
  return { rows: items, total };
}

// ─── Detail ─────────────────────────────────────────────────────────
async function getById(id) {
  logger.info('Fetch easyfixer detail · id=' + id);
  const [[row]] = await pool.query(
    `SELECT ${DETAIL_COLUMNS}
       FROM tbl_easyfixer e
       LEFT JOIN tbl_city c ON c.city_id = e.efr_cityId
      WHERE e.efr_id = ? AND NOT (e.efr_status <=> 3) LIMIT 1`,
    [id]
  );
  return row || null;
}

// ─── Create ─────────────────────────────────────────────────────────
async function findActiveByMobile(efrNo) {
  logger.info('Lookup active easyfixer by mobile');
  const [[row]] = await pool.query(
    `SELECT efr_id, efr_name FROM tbl_easyfixer
      WHERE efr_no = ? AND efr_status = 1 LIMIT 1`,
    [efrNo]
  );
  return row || null;
}

const MUTABLE_COLUMNS = [
  'efr_name', 'efr_first_name', 'efr_last_name',
  'efr_no', 'efr_alt_no', 'efr_email',
  'efr_address', 'efr_address_res', 'efr_building', 'efr_landmark',
  'efr_pin_no', 'efr_cityId', 'efr_zone_city_id',
  'efr_base_gps', 'efr_current_gps',
  'efr_type', 'efr_service_category', 'efr_service_type',
  'efr_manager_id', 'efr_marital_status', 'efr_children', 'efr_age',
  'efr_profile_img', 'about_yourself',
  'adhaar_card_number', 'pan_card_number',
  'date_of_birth', 'efr_tools',
  'skill', 'skill_rating', 'tool_rating',
  'health_insurance', 'accidental_insurance', 'have_driving_lisence', 'have_bike',
  'use_whatsapp',
  'is_technician_verified', 'is_email_verified',
  'experience_id', 'user_id',
];

function hasOwn(input, key) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function effectiveVerificationFlag(value) {
  return value === true || Number(value) === 1;
}

function assertGenericVerificationUnchanged(input, lockedRow) {
  if (!hasOwn(input, 'is_technician_verified')) return;
  if (effectiveVerificationFlag(input.is_technician_verified)
      !== effectiveVerificationFlag(lockedRow.is_technician_verified)) {
    const err = new Error(
      'technician verification can only be changed through the verification activation flow',
    );
    err.status = 409;
    throw err;
  }
}

async function create(input, actor) {
  logger.info('Create easyfixer · name=' + (input.efr_name || '') + ' cityId=' + input.efr_cityId);
  const lifecycleInstalled = await lifecycleService.hasLifecycleSchema();
  if (lifecycleInstalled && effectiveVerificationFlag(input.is_technician_verified)) {
    const err = new Error(
      'a new technician must be activated through the verification activation flow',
    );
    err.status = 409;
    throw err;
  }
  // efr_no has NO unique index (duplicates exist in prod data — see header
  // note), so the duplicate check below is a check-then-insert race under
  // concurrency (e.g. a double-clicked create button). Serialise per efr_no
  // with a MySQL named lock. GET_LOCK/RELEASE_LOCK are connection-scoped,
  // so both must run on the SAME pinned connection — never via pool.query().
  const conn = await pool.getConnection();
  const lockName = `easyfixer_create_${input.efr_no}`; // < 64 chars, efr_no is a mobile number
  try {
    /*
     * Aadhaar duplicate guard. The efr_no lock below is keyed on the MOBILE
     * number, so two creates with different mobiles but the SAME Aadhaar take
     * different locks and both succeed — it cannot serialise this. The value
     * lock is taken first (coarse before fine) so the two named locks have a
     * total order and cannot deadlock; both precede any InnoDB lock. Passing
     * excludeEfrId 0 because no row exists yet. No-op when no Aadhaar is
     * supplied, which is the common case for a CRM create.
     */
    return await withActiveAadhaarGuard(conn, input.adhaar_card_number, 0, async () => {
    const [[lock]] = await conn.query('SELECT GET_LOCK(?, 5) AS got', [lockName]);
    if (!lock || lock.got !== 1) {
      logger.warn('Create easyfixer blocked · could not acquire mobile-number lock');
      const err = new Error('could not acquire create lock for this mobile number, please retry');
      err.status = 409;
      throw err;
    }

    // Duplicate check — same logic as findActiveByMobile, but on the pinned
    // connection so it runs under the lock.
    const [[existing]] = await conn.query(
      `SELECT efr_id, efr_name FROM tbl_easyfixer
        WHERE efr_no = ? AND efr_status = 1 LIMIT 1`,
      [input.efr_no]
    );
    if (existing) {
      logger.warn('Create easyfixer rejected · active duplicate exists · efr_id=' + existing.efr_id);
      const err = new Error(`an active easyfixer with efr_no=${input.efr_no} already exists (efr_id=${existing.efr_id})`);
      err.status = 409;
      err.details = { existingId: existing.efr_id };
      throw err;
    }

    const columns = [];
    const values = [];
    for (const col of MUTABLE_COLUMNS) {
      // Once lifecycle is authoritative, generic CRUD never writes this flag.
      // A false checkbox value is treated as the unchanged default NULL so a
      // newly created technician remains visible in the registration queue.
      if (lifecycleInstalled && col === 'is_technician_verified') continue;
      if (input[col] !== undefined) {
        columns.push(col);
        values.push(input[col]);
      }
    }
    // Audit + defaults
    columns.push('efr_status', 'inserted_by', 'insert_date', 'update_date');
    values.push(1, actor?.user_id || null, new Date(), new Date());

    const placeholders = columns.map(() => '?').join(', ');
    const [result] = await conn.query(
      `INSERT INTO tbl_easyfixer (${columns.join(', ')}) VALUES (${placeholders})`,
      values
    );
    logger.info('Easyfixer created · id=' + result.insertId);
    return getById(result.insertId);
    });
  } catch (error) {
    throw mapAadhaarUniqueViolation(error);
  } finally {
    try { await conn.query('SELECT RELEASE_LOCK(?)', [lockName]); } catch (_) { /* connection teardown releases it anyway */ }
    conn.release();
  }
}

// ─── Update ─────────────────────────────────────────────────────────
async function update(id, input, actor) {
  logger.info('Update easyfixer · id=' + id);
  const existing = await getById(id);
  if (!existing) {
    logger.warn('Update easyfixer failed · not found · id=' + id);
    const err = new Error('easyfixer not found');
    err.status = 404;
    throw err;
  }

  const lifecycleInstalled = await lifecycleService.hasLifecycleSchema();
  const ownsManagerMapping = hasOwn(input, 'efr_manager_id');
  const ownsVerificationFlag = hasOwn(input, 'is_technician_verified');
  const sets = [];
  const values = [];
  for (const col of MUTABLE_COLUMNS) {
    // Verification is a tri-state legacy field. After the lifecycle migration,
    // the generic editor may echo its current checkbox value but must never
    // write it. The comparison is made against the row lock below so a stale
    // form cannot undo a concurrent activation or rejection.
    if (lifecycleInstalled && col === 'is_technician_verified') continue;
    if (input[col] !== undefined) {
      sets.push(`${col} = ?`);
      values.push(input[col]);
    }
  }
  let updateSql = null;
  if (sets.length > 0) {
    sets.push('updated_by = ?', 'update_date = ?');
    values.push(actor?.user_id || null, new Date());
    values.push(id);
    updateSql = `UPDATE tbl_easyfixer SET ${sets.join(', ')} WHERE efr_id = ?`;
  }

  /*
   * Aadhaar duplicate guard. This path took NO lock at all before, on either
   * branch. The guard runs on its OWN pinned connection and completes before
   * transition() (which pins its own connection and takes `... FOR UPDATE`) or
   * the bare pool.query below — never while an InnoDB row lock is held, which is
   * the rule that keeps the named lock out of any row-lock wait cycle. Only pin
   * a connection when an Aadhaar is actually being written; the overwhelmingly
   * common edit does not touch it and must not pay for a lock or a pool slot.
   */
  const guardedAadhaar = normalizeAadhaar(input.adhaar_card_number);
  const lockConn = guardedAadhaar ? await pool.getConnection() : null;

  // Always take the lifecycle row lock when either lifecycle-owned input is
  // present. Do not decide from the earlier detail read: another request may
  // change the manager mapping or verification flag before this transaction.
  try {
    const applyUpdate = async () => {
    if (lifecycleInstalled && (ownsManagerMapping || ownsVerificationFlag)) {
      await lifecycleService.transition(id, {
        source: 'CRM',
        reasonCode: 'MANAGER_MAPPING_UPDATED',
        reason: 'Technician manager mapping updated',
        metadata: {
          profileUpdate: Boolean(updateSql),
          managerMappingInput: ownsManagerMapping,
        },
        _resolveStatus: (row, current) => {
          assertGenericVerificationUnchanged(input, row);
          // Project the new mapping into the locked row before both target
          // resolution and the lifecycle invariant run.
          if (ownsManagerMapping) row.efr_manager_id = input.efr_manager_id || null;
          return current.status === 'ACTIVE' || current.status === 'UNDER_MASTER'
            ? lifecycleService.operationalStatusForManager(row)
            : current.status;
        },
        _beforeUpdate: updateSql
          ? (conn) => conn.query(updateSql, values)
          : undefined,
        _protectLifecycle: (current, target) => current.status === target,
      }, actor);
    } else {
      if (!updateSql) return existing; // nothing to change
      await pool.query(updateSql, values);
    }
    return null;
    };

    const nothingToChange = lockConn
      ? await withActiveAadhaarGuard(lockConn, guardedAadhaar, id, applyUpdate)
      : await applyUpdate();
    if (nothingToChange) return nothingToChange;
  } catch (error) {
    throw mapAadhaarUniqueViolation(error);
  } finally {
    if (lockConn) lockConn.release();
  }
  logger.info('Easyfixer updated · id=' + id + ' fields=' + sets.length);
  return getById(id);
}

/*
 * Cached probe: does tbl_easyfixer have the scheduled_reactivation_date column?
 * It is added by a PENDING shared-schema migration (2026-07-13) that needs DBA
 * sign-off, so it may not exist yet. setStatus builds a dynamic UPDATE and naming
 * a missing column would throw — so we only touch it once confirmed present.
 * Resolved once per process, then cached (undefined = not yet probed).
 */
let _hasReactivationCol;
async function hasReactivationColumn() {
  if (_hasReactivationCol !== undefined) return _hasReactivationCol;
  try {
    const [rows] = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'tbl_easyfixer'
          AND column_name = 'scheduled_reactivation_date'
        LIMIT 1`,
    );
    _hasReactivationCol = rows.length > 0;
  } catch (e) {
    _hasReactivationCol = false;
  }
  return _hasReactivationCol;
}

// ─── Status toggle ──────────────────────────────────────────────────
async function setStatus(id, { active, reasonId, comment, reactivationDate }, actor) {
  logger.info('Toggle easyfixer status · id=' + id + ' active=' + active + ' reasonId=' + (reasonId || ''));
  const existing = await getById(id);
  if (!existing) {
    logger.warn('Toggle easyfixer status failed · not found · id=' + id);
    const err = new Error('easyfixer not found');
    err.status = 404;
    throw err;
  }

  // Once the additive lifecycle schema exists, the legacy binary endpoint is
  // only an adapter: all writes, audit rows, optimistic versioning and pushes
  // flow through the lifecycle authority. This keeps old CRM builds working
  // without creating a second status mutation path.
  const hasLifecycle = await lifecycleService.hasLifecycleSchema();
  if (hasLifecycle) {
    const target = active
      ? (Number(existing.efr_manager_id || 0) > 0 ? 'UNDER_MASTER' : 'ACTIVE')
      : (reactivationDate ? 'SUSPENDED' : 'INACTIVE');
    const reason = active
      ? (comment || 'Activated from legacy status control')
      : (comment || (reactivationDate
        ? 'Temporarily suspended from legacy status control'
        : 'Deactivated from legacy status control'));
    await lifecycleService.transition(id, {
      status: target,
      reasonCode: reasonId ? `LEGACY_REASON_${reasonId}` : 'LEGACY_STATUS_TOGGLE',
      reason,
      until: reactivationDate || null,
      source: 'LEGACY',
      metadata: { legacyBinaryStatus: true },
    }, actor);
    return getById(id);
  }

  // A scheduled lift must be auditable and race-safe. Refuse to create a new
  // temporary suspension before the lifecycle migration is installed; plain
  // activate/deactivate keeps the exact legacy fallback for staged deploys.
  if (reactivationDate) {
    throw Object.assign(
      new Error('technician lifecycle schema is required for scheduled reactivation'),
      { status: 503 },
    );
  }

  const hasReactCol = await hasReactivationColumn();
  const sets = ['efr_status = ?', 'updated_by = ?', 'update_date = ?'];
  const values = [active ? 1 : 0, actor?.user_id || null, new Date()];

  if (active === false) {
    sets.push('inactive_reason = ?', 'inactive_comment = ?', 'last_inactive_date_time = ?');
    values.push(reasonId || null, comment || null, new Date());
    if (hasReactCol) {
      // "Temporary Inactive": a future date auto-reactivates the tech via the
      // daily cron. NULL = a permanent deactivate (the cron never touches it).
      sets.push('scheduled_reactivation_date = ?');
      values.push(reactivationDate || null);
    }
  } else {
    // Reactivation: clear inactivity reason fields AND any pending auto-
    // reactivation so a manually-reactivated tech is never re-processed.
    sets.push('inactive_reason = NULL', 'inactive_comment = NULL');
    if (hasReactCol) sets.push('scheduled_reactivation_date = NULL');
  }

  values.push(id);
  await pool.query(
    `UPDATE tbl_easyfixer SET ${sets.join(', ')} WHERE efr_id = ?`,
    values
  );
  logger.info('Easyfixer status updated · id=' + id + ' active=' + active);
  return getById(id);
}

// ─── Sub-resource: Transaction List ─────────────────────────────────
// Feeds the "Transaction List" modal on the Easyfixer detail page.
// Joins tbl_job_transaction → tbl_job (for appointment/completion timestamps
// and customer/address lookup) → tbl_customer / tbl_address / tbl_city
// → tbl_user (Trans. By). We project SELECT * from TJT (best-effort — the
// table has columns not used elsewhere in this BE; see CRM legacy
// `tbl_job_transaction` references) plus the labelled join columns the FE
// modal needs verbatim.
//
// Assumptions:
//   - tbl_job_transaction columns verified from CRM legacy DAO:
//       fk_job_id, efr_charge, total_charge, ef_charge.
//     Additional columns (transaction_id PK, ticket_created_date_time,
//     amount, balance, description, created_by) are projected via SELECT *
//     since legacy code only ever does `SELECT * from tbl_job_transaction
//     where fk_job_id = ?` (JobDaoImpl.java#9018) without enumerating them.
//   - Order by `TJT.transaction_id DESC` assumes that column exists; if
//     not, the underlying error surfaces clearly.
async function listTransactions(efrId, { limit = 10, offset = 0 } = {}) {
  logger.info('List easyfixer transactions · efrId=' + efrId + ' limit=' + limit + ' offset=' + offset);
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total
       FROM tbl_job_transaction TJT
       JOIN tbl_job J ON J.job_id = TJT.fk_job_id
      WHERE J.fk_easyfixter_id = ?`,
    [efrId],
  );

  const [rows] = await pool.query(
    `SELECT TJT.*,
            J.job_id                AS job_id,
            J.job_reference_id      AS job_reference_id,
            J.scheduled_date_time   AS appointment_date_time,
            J.checkout_date_time    AS completion_date_time,
            J.job_status            AS job_status,
            /*
             * customer_name (2026-08-03) — every row here is ONE JOB's
             * transaction, so the name shown is the one typed at booking
             * (tbl_job.job_customer_name), falling back to the customer-master
             * name only when the job carries none. Alias unchanged, so
             * EasyfixerTransactionsModal.tsx (reads t.customer_name) is untouched.
             *
             * NULLIF(TRIM(...), '') is load-bearing: COALESCE treats only NULL
             * as absent, so a plain COALESCE(J.job_customer_name, ...) would
             * render a BLANK name whenever job_customer_name is '' or spaces.
             * That value is reachable -- validators/job.validator.js allows ''
             * and the create path binds it through the ?? operator, which
             * guards null/undefined only. (No backtick characters in this
             * comment -- it lives inside a JS template literal; see the
             * LIST_COLUMNS note at the top of this file.)
             * J is already joined below AND in the COUNT query above, so this
             * projection adds no join and cannot break the paginated total.
             */
            COALESCE(NULLIF(TRIM(J.job_customer_name), ''), cu.customer_name) AS customer_name,
            cu.customer_mob_no      AS customer_mob_no,
            ad.address              AS customer_address,
            ad.building             AS customer_building,
            ad.landmark             AS customer_landmark,
            ad.pin_code             AS customer_pin_code,
            ci.city_name            AS location,
            tx_user.user_name       AS trans_by
       FROM tbl_job_transaction TJT
       JOIN tbl_job J        ON J.job_id      = TJT.fk_job_id
       LEFT JOIN tbl_customer cu ON cu.customer_id = J.fk_customer_id
       LEFT JOIN tbl_address  ad ON ad.address_id  = J.fk_address_id
       LEFT JOIN tbl_city     ci ON ci.city_id     = ad.city_id
       LEFT JOIN tbl_user     tx_user ON tx_user.user_id = TJT.created_by
      WHERE J.fk_easyfixter_id = ?
      ORDER BY TJT.transaction_id DESC
      LIMIT ? OFFSET ?`,
    [efrId, Number(limit), Number(offset)],
  );
  logger.info('Returning ' + rows.length + ' transactions · total=' + total);
  return { rows, total };
}

// ─── Sub-resource: Mapped Clients ───────────────────────────────────
// Feeds the "Client Mapping" modal. Joins tbl_client_easyfixer_mapping
// (keyed by easyfixer_id, filtered mapping_status = 1) to tbl_client for
// the display name. tbl_client_easyfixer_mapping.easyfixer_id is the FK
// to tbl_easyfixer.efr_id (NOT efr_id — verified in client-tech-mapping
// service comments).
async function listMappedClients(efrId, { limit = 50, offset = 0 } = {}) {
  logger.info('List mapped clients for easyfixer · efrId=' + efrId + ' limit=' + limit + ' offset=' + offset);
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total
       FROM tbl_client_easyfixer_mapping m
      WHERE m.easyfixer_id = ? AND m.mapping_status = 1`,
    [efrId],
  );

  const [rows] = await pool.query(
    `SELECT m.mapping_id,
            m.client_id,
            m.easyfixer_id,
            m.service_type_id,
            m.mapping_status,
            m.insert_date         AS mapped_at,
            cl.client_name        AS client_name
       FROM tbl_client_easyfixer_mapping m
       LEFT JOIN tbl_client cl ON cl.client_id = m.client_id
      WHERE m.easyfixer_id = ? AND m.mapping_status = 1
      ORDER BY m.mapping_id DESC
      LIMIT ? OFFSET ?`,
    [efrId, Number(limit), Number(offset)],
  );
  logger.info('Returning ' + rows.length + ' mapped clients · total=' + total);
  return { rows, total };
}

// ─── Sub-resource: Aggregates (lazy column fill) ────────────────────
// POST /admin/easyfixers/aggregates body { efrIds: [...] }
// Returns the six expensive columns that were removed from the base list:
// clients_mapped, total_earnings, job_count, avg_rating, options_mapped_count,
// serviceable_pincodes_csv.
// The WHERE ... IN
// inside each subquery is the critical optimisation — without it those
// subqueries scan the full tables; with it, they hit covering indexes for
// just the requested page (~50 ids).
//
// `serviceable_pincodes_csv` comes from tbl_efr_serviceable_pincodes which
// stores the CSV directly in a `pincodes` TEXT column (one row per efr) —
// no GROUP_CONCAT needed; a simple LEFT JOIN suffices.
async function aggregates(efrIds, { scope } = {}) {
  logger.info('Compute easyfixer aggregates · requested=' + (Array.isArray(efrIds) ? efrIds.length : 0));
  if (!Array.isArray(efrIds) || efrIds.length === 0) return { rows: [] };
  // Cap + sanitise: integers, positive, dedupe, max 1000.
  const ids = Array.from(new Set(
    efrIds.slice(0, 1000).map(Number).filter((n) => Number.isInteger(n) && n > 0)
  ));
  if (ids.length === 0) return { rows: [] };

  // RBAC scope filter — restrict the id set to easyfixers whose city is in
  // the caller's scope. Uses the same scope shape as list().
  const scopeClauses = [];
  const scopeParams = [];
  if (scope?.cities) {
    const ci = scope.cities;
    if (ci.mode === 'none') return { rows: [] };
    if (ci.mode === 'allow' && ci.ids.length) {
      scopeClauses.push(`e.efr_cityId IN (${ci.ids.map(() => '?').join(',')})`);
      scopeParams.push(...ci.ids);
    }
  }
  const scopeWhere = scopeClauses.length ? ` AND ${scopeClauses.join(' AND ')}` : '';

  const placeholders = ids.map(() => '?').join(',');

  const [rows] = await pool.query(
    `SELECT
       e.efr_id,
       COALESCE(cm.clients_mapped, 0)         AS clients_mapped,
       COALESCE(earn.total_earnings, 0)       AS total_earnings,
       COALESCE(earn.job_count, 0)            AS job_count,
       ROUND(rt.rating, 2)                    AS avg_rating,
       COALESCE(optmap.options_mapped_count, 0) AS options_mapped_count,
       COALESCE(sp.pincodes, '')              AS serviceable_pincodes_csv,
       /*
        * Profile-update magic-link audit columns (2026-06-11). Added by
        * migrations/2026-06-11-easyfixer-profile-update-magic-link.sql
        * directly on tbl_easyfixer -- no JOIN needed. profile_update_sent_at
        * is nullable (never sent -> NULL); profile_update_send_count
        * defaults to 0 NOT NULL. Surfaces "Last Link Sent" column on the
        * Manage Easyfixers list so operators see who has been pinged and
        * how many times. (No backticks in this comment -- inside a JS
        * template literal they close the string early; see LIST_COLUMNS
        * comment block at the top of this file for context.)
        */
       e.profile_update_sent_at                AS profile_update_sent_at,
       COALESCE(e.profile_update_send_count, 0) AS profile_update_send_count
     FROM tbl_easyfixer e
     LEFT JOIN (
       SELECT easyfixer_id, COUNT(DISTINCT client_id) AS clients_mapped
         FROM tbl_client_easyfixer_mapping
        WHERE easyfixer_id IN (${placeholders}) AND mapping_status = 1
        GROUP BY easyfixer_id
     ) cm ON cm.easyfixer_id = e.efr_id
     LEFT JOIN (
       SELECT J.fk_easyfixter_id,
              SUM(TJT.efr_charge) AS total_earnings,
              COUNT(DISTINCT TJT.fk_job_id) AS job_count
         FROM tbl_job_transaction TJT
         JOIN tbl_job J ON J.job_id = TJT.fk_job_id
        WHERE J.fk_easyfixter_id IN (${placeholders}) AND J.job_status IN (3, 5)
        GROUP BY J.fk_easyfixter_id
     ) earn ON earn.fk_easyfixter_id = e.efr_id
     LEFT JOIN (
       SELECT easyfixer_id, AVG(customer_rating) AS rating
         FROM tbl_easyfixer_rating_by_customer
        WHERE easyfixer_id IN (${placeholders})
          AND easyfixer_id > 0
          AND comment IS NOT NULL
        GROUP BY easyfixer_id
     ) rt ON rt.easyfixer_id = e.efr_id
     LEFT JOIN (
       /*
        * Mapped-deep-skill rollup. Counts DISTINCT DEEP SKILLS each easyfixer
        * is actively mapped to. NEW CRM convention (confirmed 2026-06-17):
        * physical parent_skill_id holds the deepskill_id (L3) and
        * deep_skill_id holds the option id (L4) — so DISTINCT parent_skill_id
        * = number of distinct deep skills (not option rows). The CRM column
        * reads "Mapped Deep Skill"; alias kept as options_mapped_count for
        * FE-key stability. is_repairing = 1 is the active flag. Covered by the
        * composite index in
        * migrations/2026-06-10-add-efr-deepskill-mapping-composite-index.sql.
        *
        * EXISTS guard: count a deep skill only when parent_skill_id resolves to
        * a tbl_deep_skill row that EXISTS and is not inactive (status <> 0) —
        * mirrors candidate-ranking's exclusion of deactivated skills so "Mapped
        * Deep Skill" means the same across the list, the detail modal and job
        * ranking. Orphaned legacy rows (old-catalog ids with no surviving deep
        * skill) fall out here too; per plan they're cleaned + re-uploaded via
        * the new CRM.
        */
       SELECT m.easyfixer_id, COUNT(DISTINCT m.parent_skill_id) AS options_mapped_count
         FROM tbl_efr_deepskill_mapping m
        WHERE m.easyfixer_id IN (${placeholders}) AND m.is_repairing = 1
          AND EXISTS (
            SELECT 1 FROM tbl_deep_skill ds
             WHERE ds.deepskill_id = m.parent_skill_id
               AND (ds.status IS NULL OR ds.status <> 0)
          )
        GROUP BY m.easyfixer_id
     ) optmap ON optmap.easyfixer_id = e.efr_id
     LEFT JOIN tbl_efr_serviceable_pincodes sp ON sp.easyfixer_id = e.efr_id
     WHERE e.efr_id IN (${placeholders})${scopeWhere}`,
    [...ids, ...ids, ...ids, ...ids, ...ids, ...scopeParams],
  );

  logger.info('Returning aggregates for ' + rows.length + ' easyfixers');
  return { rows };
}

// ─── Sub-resource: Today's Attendance (lazy column fill) ────────────
// POST /admin/easyfixers/attendance body { efrIds: [...] }
// Returns today's attendance row per requested easyfixer (if any).
// Missing rows mean "no information" — FE should treat absence accordingly.
async function attendance(efrIds, { scope } = {}) {
  logger.info("Fetch today's attendance · requested=" + (Array.isArray(efrIds) ? efrIds.length : 0));
  if (!Array.isArray(efrIds) || efrIds.length === 0) return { rows: [] };
  const ids = Array.from(new Set(
    efrIds.slice(0, 1000).map(Number).filter((n) => Number.isInteger(n) && n > 0)
  ));
  if (ids.length === 0) return { rows: [] };

  // RBAC scope filter — same as aggregates().
  const scopeClauses = [];
  const scopeParams = [];
  if (scope?.cities) {
    const ci = scope.cities;
    if (ci.mode === 'none') return { rows: [] };
    if (ci.mode === 'allow' && ci.ids.length) {
      scopeClauses.push(`EXISTS (
        SELECT 1 FROM tbl_easyfixer e
         WHERE e.efr_id = att.easyfixer_id
           AND e.efr_cityId IN (${ci.ids.map(() => '?').join(',')})
      )`);
      scopeParams.push(...ci.ids);
    }
  }
  const scopeWhere = scopeClauses.length ? ` AND ${scopeClauses.join(' AND ')}` : '';

  const placeholders = ids.map(() => '?').join(',');

  const [rows] = await pool.query(
    `SELECT att.easyfixer_id     AS efr_id,
            att.is_leave_marked  AS att_is_leave_marked,
            att.morning_slot     AS att_morning_slot,
            att.evening_slot     AS att_evening_slot,
            att.created_on       AS att_created_on
       FROM tbl_easyfixer_attendance att
      WHERE att.easyfixer_id IN (${placeholders})
        AND att.created_on >= CURDATE()
        AND att.created_on <  CURDATE() + INTERVAL 1 DAY${scopeWhere}`,
    [...ids, ...scopeParams],
  );

  logger.info('Returning attendance for ' + rows.length + ' easyfixers');
  return { rows };
}

/*
 * Status-counts strip (2026-06-08). Single-query rollup of how many
 * easyfixers fall into each of the 6 status buckets, used by the page
 * subtitle ("2,635 Active · 215 Inactive · 3,449 Idle · …").
 *
 * Each count uses the SAME WHERE clause as the corresponding dropdown
 * filter value in `list()` so the strip number matches what the
 * operator sees after clicking the filter. Conditional aggregation via
 * `SUM(CASE WHEN ... THEN 1 ELSE 0 END)` gives all 6 counts + total in
 * ONE query — six round-trips collapsed to one.
 *
 * Buckets CAN overlap (e.g. a row with personal_details_filled=2 AND
 * is_technician_verified=1 counts under both Active AND Not Eligible)
 * because the legacy SQL WHERE clauses don't priority-guard each other.
 * That mirrors legacy behaviour — sum > total is expected — so the
 * displayed strip totals agree with the dropdown-filtered list page.
 *
 * RBAC: applies scope.cities filter so a city-scoped operator sees
 * counts within their allowed cities. Mirrors the same gating list()
 * uses; out-of-scope rows contribute zero.
 */
async function statusCounts({ scope } = {}) {
  logger.info('Compute easyfixer status counts');
  const clauses = [];
  const params = [];

  // Inherit the same RBAC scope-narrowing list() applies first.
  if (scope?.cities) {
    const ci = scope.cities;
    if (ci.mode === 'none') {
      // No access — short-circuit to all-zero counts.
      return {
        active: 0, inactive: 0, idle: 0, not_eligible: 0,
        not_suitable: 0, reg_in_progress: 0, training_pending: 0, total: 0,
      };
    }
    if (ci.mode === 'allow' && ci.ids.length) {
      clauses.push(`e.efr_cityId IN (${ci.ids.map(() => '?').join(',')})`);
      params.push(...ci.ids);
    }
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  /*
   * Training Pending is a LIFECYCLE bucket, not one of the six legacy status
   * buckets above it — which is why it is selected conditionally rather than
   * added to the list. `lifecycle_status` only exists once the technician
   * lifecycle migration is installed, and this endpoint has to keep answering
   * on an environment where it is not: referencing a missing column would
   * throw and take the whole counts strip down, not just this one number.
   *
   * It earns a place in the strip because the LMS made it actionable. Before
   * the completion wire, TRAINING_PENDING was a state nothing could clear
   * automatically and the cohort was not a worklist. Now that finishing the
   * assigned videos advances a technician out of it, whoever is left in it is
   * precisely the set who have not finished their training — the people an
   * operator needs to chase.
   */
  const lifecycleInstalled = await lifecycleService.hasLifecycleSchema();
  const trainingPendingSql = lifecycleInstalled
    ? `SUM(CASE WHEN e.lifecycle_status = 'TRAINING_PENDING' THEN 1 ELSE 0 END)`
    : '0';

  const [[row]] = await pool.query(`
    SELECT
      ${trainingPendingSql} AS training_pending,
      SUM(CASE WHEN e.is_technician_verified = 1 AND e.efr_status = 1
               THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN e.is_technician_verified = 1 AND e.efr_status = 0
               THEN 1 ELSE 0 END) AS inactive,
      SUM(CASE WHEN (e.user_id IS NULL OR e.user_id = 0)
               THEN 1 ELSE 0 END) AS idle,
      SUM(CASE WHEN U.personal_details_filled = 2
               THEN 1 ELSE 0 END) AS not_eligible,
      SUM(CASE WHEN e.is_identity_details_verified_by_crm = 2
                AND U.personal_details_filled = 1
               THEN 1 ELSE 0 END) AS not_suitable,
      SUM(CASE WHEN e.user_id > 0
                AND e.is_technician_verified IS NULL
                AND (e.is_identity_details_verified_by_crm <> 2
                     OR e.is_identity_details_verified_by_crm IS NULL)
                AND (U.personal_details_filled = 1
                     OR U.personal_details_filled IS NULL)
               THEN 1 ELSE 0 END) AS reg_in_progress,
      COUNT(*) AS total
      FROM tbl_easyfixer e
      LEFT JOIN tbl_user U ON U.user_id = e.user_id
      ${where}
  `, params);

  logger.info('Status counts ready · total=' + (Number(row.total) || 0));
  return {
    active:          Number(row.active)          || 0,
    inactive:        Number(row.inactive)        || 0,
    idle:            Number(row.idle)            || 0,
    not_eligible:    Number(row.not_eligible)    || 0,
    not_suitable:    Number(row.not_suitable)    || 0,
    reg_in_progress: Number(row.reg_in_progress) || 0,
    // 0 both when nobody is in the bucket and when the lifecycle migration is
    // absent — the two are indistinguishable from here, and the strip renders
    // the entry either way. Note this legitimately reads 0 today: nothing
    // currently moves a technician INTO TRAINING_PENDING (the LMS wire only
    // moves them out), so the bucket is empty until an entrance exists.
    training_pending: Number(row.training_pending) || 0,
    total:           Number(row.total)           || 0,
  };
}

// ─── Registered Easyfixers (onboarding / approval queue) ─────────────
/*
 * Parity port of the legacy CRM "EasyFixers → Registered Easyfixers" page
 * (struts efer-registration / getAllRegisteredEasyfixer →
 * EasyfixerDaoImpl.getAllRegisteredEasyfixer). This is the ONBOARDING queue,
 * distinct from the verified-roster list() above.
 *
 * "Registered" = an easyfixer who STARTED self-registration / re-onboarding
 * (new_easy_fixer OR is_existing_easyfixer set) AND is NOT yet finally
 * technician-verified (is_technician_verified IS NULL). Once verified they
 * graduate out of this queue into the roster.
 *
 * Location fields come from tbl_user (U.city/U.state/U.pin_code) exactly like
 * legacy — during onboarding the canonical location lives on the login row,
 * not yet on tbl_easyfixer.efr_cityId.
 *
 * Legacy quirks deliberately FIXED (documented for the migration):
 *   - parameterised SQL (legacy string-concatenated → injection-prone);
 *   - COUNT(*) for total (legacy materialised every row + counted in Java);
 *   - easyfixer_watched_video.video_id unified to 3 (legacy used 6 in the list
 *     query but 3 in count/export — a silent inconsistency);
 *   - PIN search unified to U.pin_code (legacy diverged list vs count);
 *   - State-User (zonal manager) name via a scalar subquery, not the legacy
 *     per-row DAO call (N+1).
 */

// Legacy registration-status label cascade (LAST-MATCH-WINS), replicating the
// EasyfixerDaoImpl RowMapper. `r` carries the raw columns selected below.
function registrationStatusLabel(r) {
  const pdf = r.personal_details_filled == null ? null : Number(r.personal_details_filled);
  const idv = r.is_identity_details_verified == null ? null : Number(r.is_identity_details_verified);
  const hasSb = r.send_back_to_tx_reason_crm != null && String(r.send_back_to_tx_reason_crm).trim() !== '';
  const hasLoc = r.name != null && r.city != null && r.pincode != null;
  const wv = r.watched_percentage == null ? null : Number(r.watched_percentage);
  const pp = r.profile_perc == null ? null : Number(r.profile_perc);

  let label = 'Details Not Available';
  if (hasLoc && (pdf === 0 || pdf === null)) label = 'New Lead';
  if (r.pincode == null || r.name == null || r.city == null) label = 'Details Not Available';
  if (pdf === 2) label = 'Not Eligible';
  if (hasLoc && pdf === 1) label = 'Self Registration In Progress';
  if (idv === 1) label = 'Send To Finance';
  if (hasSb && idv === 2) label = 'Not Suitable';
  if (hasSb && pdf === 0 && idv === 0) label = 'Send Back To Tx EC';
  if (hasSb && pdf === 1 && idv === 0) label = 'Send Back To Tx Identity Section';
  if (r.efr_profile_img != null && wv === 100 && pp === 100) label = 'Pending Member Verification';
  if (r.beneficiary_id != null && String(r.beneficiary_id) !== '' && r.easyfix_bank_name_id != null && idv === 1) label = 'Activation Pending';
  return label;
}

// Legacy IsEligibleForEarlyActivation — all key profile fields present + a
// city + some training watched (drives the "unlock" row highlight in the UI).
function earlyActivationEligible(r) {
  return !!(
    r.name && r.adhaar_card_number && r.efr_bank_acc_num &&
    r.efr_service_category && r.efr_service_type && r.efr_profile_img && r.efr_pin_no &&
    Number(r.efr_cityId) > 0 && Number(r.watched_percentage) > 0
  );
}

const REGISTERED_JOINS = `
  FROM tbl_easyfixer e
  LEFT JOIN tbl_user U ON U.user_id = e.user_id
  /* One bank row per easyfixer. tbl_easyfixer_bank_details can hold >1 row per
     efr, so a plain LEFT JOIN would FAN OUT (dupe list rows + inflate COUNT).
     The table has NO id PK, so we pre-aggregate by efr_id with MAX() over the
     presence-checked columns — the registered-status logic only tests presence/
     equality (not row identity), so collapsing to one row per efr is correct. */
  LEFT JOIN (
    SELECT efr_id,
           MAX(beneficiary_id)       AS beneficiary_id,
           MAX(easyfix_bank_name_id) AS easyfix_bank_name_id,
           MAX(efr_bank_acc_num)     AS efr_bank_acc_num
      FROM tbl_easyfixer_bank_details
     GROUP BY efr_id
  ) tb ON tb.efr_id = e.efr_id
  /* video_id=3 is unique per easyfixer (easyfixer_id+video_id key) → no fan-out. */
  LEFT JOIN easyfixer_watched_video wvd ON wvd.easyfixer_id = e.efr_id AND wvd.video_id = 3
  /* One cached performance row per technician (PK lookup; no fan-out). */
  LEFT JOIN tbl_efr_grade_snapshot egs ON egs.efr_id = e.efr_id
`;

const REGISTERED_SORTS = Object.freeze({
  efr_id:          'e.efr_id',
  registered_date: 'U.insert_date',
  name:            'U.user_name',
  city:            'U.city',
});

async function loadRegisteredLifetimeEarnings(efrIds) {
  const ids = Array.from(new Set(
    efrIds.map(Number).filter((id) => Number.isInteger(id) && id > 0),
  ));
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT j.fk_easyfixter_id AS efr_id,
            COALESCE(SUM(t.efr_charge), 0) AS lifetime_earnings
       FROM tbl_job j
       JOIN tbl_job_transaction t ON t.fk_job_id = j.job_id
      WHERE j.fk_easyfixter_id IN (${placeholders})
        AND j.job_status IN (3, 5)
      GROUP BY j.fk_easyfixter_id`,
    ids,
  );
  return new Map(rows.map((row) => [
    Number(row.efr_id),
    Number(row.lifetime_earnings) || 0,
  ]));
}

// Durable re-application provenance moved from a denormalized column
// (lifecycle_reapplication_count, now dropped) to the audit log: a technician
// has re-applied iff a transition INTO REAPPLIED was ever recorded. A single
// set-based EXISTS keeps this one indexed lookup per row on the registered queue
// (which genuinely filters on provenance) rather than an application-level N+1;
// idx_efr_lifecycle_history / uq_efr_lifecycle_version both lead with efr_id.
const reappliedProvenanceExists = (alias = 'e') => `EXISTS (
    SELECT 1 FROM tbl_easyfixer_lifecycle_status_log lrc
     WHERE lrc.efr_id = ${alias}.efr_id AND lrc.to_status = 'REAPPLIED')`;

function registeredReapplicationFields(row, lifecycle, lifetimeEarnings = 0) {
  const isReapplication = lifecycle.status === 'REAPPLIED'
    || lifecycle.reapplicationCount > 0;
  return {
    is_reapplication: isReapplication,
    previous_efr_id: isReapplication ? Number(row.efr_id) : null,
    lifetime_earnings: isReapplication ? (Number(lifetimeEarnings) || 0) : 0,
  };
}

// Shared WHERE builder for the registered queue (list + count + export).
function buildRegisteredWhere(f = {}, scope, lifecycleInstalled = false) {
  const onboardingLifecycleSql = [
    'NEW',
    'REGISTRATION_INCOMPLETE',
    'TRAINING_PENDING',
    'ASSESSMENT_FAILED',
    'UNDER_VERIFICATION',
    'VERIFICATION_REJECTED',
    'REAPPLIED',
    'APPLICATION_REJECTED',
  ].map((status) => `'${status}'`).join(',');
  const clauses = [
    lifecycleInstalled
      ? `(e.new_easy_fixer IS NOT NULL OR e.is_existing_easyfixer IS NOT NULL
          OR e.lifecycle_status IN (${onboardingLifecycleSql})
          OR ${reappliedProvenanceExists('e')})`
      : '(e.new_easy_fixer IS NOT NULL OR e.is_existing_easyfixer IS NOT NULL)',
    lifecycleInstalled
      ? "(e.is_technician_verified IS NULL OR e.lifecycle_status = 'REAPPLIED')"
      : 'e.is_technician_verified IS NULL',
  ];
  const params = [];

  // RBAC city scope — same convention as list().
  if (scope?.cities) {
    const ci = scope.cities;
    if (ci.mode === 'none') clauses.push('1=0');
    else if (ci.mode === 'allow' && ci.ids.length) {
      clauses.push(`e.efr_cityId IN (${ci.ids.map(() => '?').join(',')})`);
      params.push(...ci.ids);
    }
  }

  // Search — length-routed like legacy (6→pincode, 10→mobile, ≤4 digits→id);
  // other text falls back to name/mobile (legacy matched nothing for 7-9 digit
  // / free text — improved here).
  if (f.q) {
    const s = String(f.q).trim();
    if (/^\d{6}$/.test(s))       { clauses.push('U.pin_code LIKE ?'); params.push(`%${s}%`); }
    else if (/^\d{10}$/.test(s)) { clauses.push('e.efr_no LIKE ?');   params.push(`%${s}%`); }
    else if (/^\d{1,4}$/.test(s)){ clauses.push('e.efr_id = ?');      params.push(Number(s)); }
    else                         { clauses.push('(U.user_name LIKE ? OR e.efr_no LIKE ?)'); params.push(`%${s}%`, `%${s}%`); }
  }

  // Registration-status dropdown (legacy values 1-3, 5-9; 4 unused). Predicates
  // verbatim from EasyfixerDaoImpl.getAllRegisteredEasyfixer.
  switch (Number(f.registrationStatus)) {
    case 1: clauses.push("U.pin_code IS NOT NULL AND U.user_name IS NOT NULL AND U.personal_details_filled IS NULL AND e.is_identity_details_verified_by_crm IS NULL AND U.city IS NOT NULL"); break;
    case 2: clauses.push("U.personal_details_filled = 1 AND U.pin_code IS NOT NULL AND U.user_name IS NOT NULL AND U.city IS NOT NULL AND (e.is_identity_details_verified_by_crm IS NULL OR e.is_identity_details_verified_by_crm = 0)"); break;
    case 3: clauses.push("(U.pin_code IS NULL OR U.user_name IS NULL OR U.city IS NULL) AND U.personal_details_filled IS NULL"); break;
    case 5: clauses.push("U.personal_details_filled = 2 AND (e.is_identity_details_verified_by_crm IS NULL OR e.is_identity_details_verified_by_crm = 0)"); break;
    case 6: clauses.push("e.is_identity_details_verified_by_crm = 1 AND tb.beneficiary_id IS NULL AND tb.easyfix_bank_name_id IS NULL"); break;
    case 7: clauses.push("tb.beneficiary_id IS NOT NULL AND tb.beneficiary_id <> '' AND tb.easyfix_bank_name_id IS NOT NULL AND e.is_identity_details_verified_by_crm = 1"); break;
    case 8: clauses.push("e.send_back_to_tx_reason_crm IS NOT NULL AND e.is_identity_details_verified_by_crm = 2"); break;
    case 9: clauses.push("wvd.watched_percentage = 100 AND e.efr_profile_perc = 100 AND e.efr_profile_img IS NOT NULL AND e.is_identity_details_verified_by_crm IS NULL AND tb.beneficiary_id IS NULL AND tb.easyfix_bank_name_id IS NULL"); break;
    case 10: clauses.push(lifecycleInstalled ? reappliedProvenanceExists('e') : '1=0'); break;
    default: break;
  }

  // Easyfixer type: 1 = already-existing, 2 = new.
  if (Number(f.easyfixerType) === 1) clauses.push('e.is_existing_easyfixer = 1');
  else if (Number(f.easyfixerType) === 2) clauses.push('e.new_easy_fixer = 1');

  // Applied-on date range (on the login insert_date).
  if (f.dateFrom) { clauses.push('DATE(U.insert_date) >= ?'); params.push(String(f.dateFrom).slice(0, 10)); }
  if (f.dateTo)   { clauses.push('DATE(U.insert_date) <= ?'); params.push(String(f.dateTo).slice(0, 10)); }

  // NDM / state-user: the (login) city is an active city managed by ndmId.
  if (f.ndmId != null) {
    clauses.push('EXISTS (SELECT 1 FROM tbl_city rc WHERE rc.city_name = U.city AND rc.city_status = 1 AND rc.state_user = ?)');
    params.push(f.ndmId);
  }

  return { where: `WHERE ${clauses.join(' AND ')}`, params };
}

async function listRegistered(f = {}, scope) {
  logger.info('List registered easyfixers · registrationStatus=' + (f.registrationStatus || '') + ' q=' + (f.q || '') + ' limit=' + (f.limit || 20) + ' offset=' + (f.offset || 0));
  const lifecycleInstalled = await lifecycleService.hasLifecycleSchema();
  const lifecycleProjection = await lifecycleService.readProjection('e');
  const { where, params } = buildRegisteredWhere(f, scope, lifecycleInstalled);
  const sortCol = REGISTERED_SORTS[f.sortBy] || 'U.insert_date';
  const sortDir = String(f.sortDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // Page-size ceiling: 500 for the interactive list (matches the Joi cap).
  // The export path passes an explicit higher `maxLimit` so /download is NOT
  // silently truncated to 500 rows.
  const ceiling = Math.max(Number(f.maxLimit) || 500, 1);
  const limit = Math.min(Math.max(Number(f.limit) || 20, 1), ceiling);
  const offset = Math.max(Number(f.offset) || 0, 0);

  const [rows] = await pool.query(`
    SELECT
      e.efr_id,
      e.efr_status,
      e.is_technician_verified,
      e.efr_manager_id,
      e.user_id,
      e.scheduled_reactivation_date,
      U.insert_date                          AS registered_date,
      U.user_name                            AS name,
      e.efr_no                               AS mobile,
      U.city                                 AS city,
      U.pin_code                             AS pincode,
      U.state                                AS state_name,
      (SELECT u2.user_name FROM tbl_city rc JOIN tbl_user u2 ON u2.user_id = rc.state_user
        WHERE rc.city_name = U.city AND rc.city_status = 1 LIMIT 1) AS state_user_name,
      e.efr_profile_perc                     AS profile_perc,
      e.is_existing_easyfixer                AS is_existing_easyfixer,
      e.new_easy_fixer                       AS new_easy_fixer,
      U.personal_details_filled              AS personal_details_filled,
      U.is_personal_detail_filled            AS lifecycle_personal_submitted,
      (e.adhaar_card_number IS NOT NULL AND e.adhaar_card_number <> '') AS lifecycle_aadhaar_present,
      (e.efr_profile_img IS NOT NULL AND e.efr_profile_img <> '') AS lifecycle_photo_present,
      e.is_identity_details_verified_by_crm  AS is_identity_details_verified,
      e.send_back_to_tx_reason_crm           AS send_back_to_tx_reason_crm,
      e.efr_profile_img                      AS efr_profile_img,
      e.adhaar_card_number                   AS adhaar_card_number,
      e.efr_service_category                 AS efr_service_category,
      e.efr_service_type                     AS efr_service_type,
      e.efr_pin_no                           AS efr_pin_no,
      e.efr_cityId                           AS efr_cityId,
      e.profile_activation_date_time         AS profile_activation_date_time,
      e.current_balance                      AS wallet_balance,
      egs.grade                              AS previous_performance_grade,
      egs.completed_jobs                     AS previous_completed_jobs,
      wvd.watched_percentage                 AS watched_percentage,
      tb.beneficiary_id                      AS beneficiary_id,
      tb.easyfix_bank_name_id                AS easyfix_bank_name_id,
      tb.efr_bank_acc_num                    AS efr_bank_acc_num,
      ${lifecycleProjection},
      ${lifecycleInstalled ? reappliedProvenanceExists('e') : '0'} AS lifecycle_reapplication_count
    ${REGISTERED_JOINS}
    ${where}
    ORDER BY ${sortCol} ${sortDir}, e.efr_id DESC
    LIMIT ? OFFSET ?
  `, [...params, limit, offset]);

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total ${REGISTERED_JOINS} ${where}`,
    params
  );

  // Page-bounded aggregate: at most the already-limited row ids, using the
  // same completed statuses and efr_charge definition as aggregates(). This
  // avoids a correlated per-row scan and never aggregates the full roster.
  const lifetimeEarnings = await loadRegisteredLifetimeEarnings(
    rows
      .filter((row) => (
        row.lifecycle_status === 'REAPPLIED'
        || Number(row.lifecycle_reapplication_count) > 0
      ))
      .map((row) => row.efr_id),
  );

  const items = rows.map((r) => {
    const lifecycle = lifecycleService.lifecycleFromRow(r);
    const reapplication = registeredReapplicationFields(
      r,
      lifecycle,
      lifetimeEarnings.get(Number(r.efr_id)),
    );
    return {
      ...r,
      pause_count: Number(r.lifecycle_pause_count) || 0,
      lifecycle,
      ...reapplication,
      // Re-application deliberately reuses the same technician account so
      // wallet/history ownership remains intact; this is the previous Tx ID.
      registration_status_label: lifecycle.status === 'REAPPLIED'
        ? 'Re-application'
        : registrationStatusLabel(r),
      early_activation_eligible: earlyActivationEligible(r),
    };
  });
  logger.info('Returning ' + items.length + ' registered easyfixers · total=' + (Number(total) || 0));
  return { rows: items, total: Number(total) || 0 };
}

// Full (filtered) export set, no pagination — caller streams to xlsx.
async function listRegisteredForExport(f = {}, scope, cap = 10000) {
  logger.info('Export registered easyfixers · cap=' + cap);
  // maxLimit:cap lifts the interactive 500 ceiling so the export streams the
  // full (filtered) set up to the hard cap instead of being clamped to 500.
  const { rows } = await listRegistered({ ...f, limit: cap, maxLimit: cap, offset: 0 }, scope);
  return rows;
}

// Status-count strip for the registered queue (clickable triage header,
// mirrors statusCounts() for the roster). One SUM(CASE) pass over the base
// registered set + RBAC scope (no status filter). Buckets OVERLAP by design
// (sum may exceed total) — same as the legacy registration-status predicates.
// Keys map to the registrationStatus filter values:
//   new_lead=1 · in_progress=2 · details_not_available=3 · not_eligible=5 ·
//   send_to_finance=6 · activation_pending=7 · not_suitable=8 ·
//   pending_member_verification=9.
async function registeredStatusCounts(scope) {
  logger.info('Compute registered easyfixer status counts');
  const lifecycleInstalled = await lifecycleService.hasLifecycleSchema();
  const { where, params } = buildRegisteredWhere({}, scope, lifecycleInstalled);
  const reapplicationCountSql = lifecycleInstalled
    ? `SUM(CASE WHEN ${reappliedProvenanceExists('e')} THEN 1 ELSE 0 END)`
    : '0';
  const [[row]] = await pool.query(`
    SELECT
      SUM(CASE WHEN U.pin_code IS NOT NULL AND U.user_name IS NOT NULL AND U.personal_details_filled IS NULL AND e.is_identity_details_verified_by_crm IS NULL AND U.city IS NOT NULL THEN 1 ELSE 0 END) AS new_lead,
      SUM(CASE WHEN U.personal_details_filled = 1 AND U.pin_code IS NOT NULL AND U.user_name IS NOT NULL AND U.city IS NOT NULL AND (e.is_identity_details_verified_by_crm IS NULL OR e.is_identity_details_verified_by_crm = 0) THEN 1 ELSE 0 END) AS in_progress,
      SUM(CASE WHEN (U.pin_code IS NULL OR U.user_name IS NULL OR U.city IS NULL) AND U.personal_details_filled IS NULL THEN 1 ELSE 0 END) AS details_not_available,
      SUM(CASE WHEN U.personal_details_filled = 2 AND (e.is_identity_details_verified_by_crm IS NULL OR e.is_identity_details_verified_by_crm = 0) THEN 1 ELSE 0 END) AS not_eligible,
      SUM(CASE WHEN e.is_identity_details_verified_by_crm = 1 AND tb.beneficiary_id IS NULL AND tb.easyfix_bank_name_id IS NULL THEN 1 ELSE 0 END) AS send_to_finance,
      SUM(CASE WHEN tb.beneficiary_id IS NOT NULL AND tb.beneficiary_id <> '' AND tb.easyfix_bank_name_id IS NOT NULL AND e.is_identity_details_verified_by_crm = 1 THEN 1 ELSE 0 END) AS activation_pending,
      SUM(CASE WHEN e.send_back_to_tx_reason_crm IS NOT NULL AND e.is_identity_details_verified_by_crm = 2 THEN 1 ELSE 0 END) AS not_suitable,
      SUM(CASE WHEN wvd.watched_percentage = 100 AND e.efr_profile_perc = 100 AND e.efr_profile_img IS NOT NULL AND e.is_identity_details_verified_by_crm IS NULL AND tb.beneficiary_id IS NULL AND tb.easyfix_bank_name_id IS NULL THEN 1 ELSE 0 END) AS pending_member_verification,
      ${reapplicationCountSql} AS reapplications,
      COUNT(*) AS total
    ${REGISTERED_JOINS}
    ${where}
  `, params);
  logger.info('Registered status counts ready · total=' + (Number(row.total) || 0));
  return {
    new_lead:                    Number(row.new_lead) || 0,
    in_progress:                 Number(row.in_progress) || 0,
    details_not_available:       Number(row.details_not_available) || 0,
    not_eligible:                Number(row.not_eligible) || 0,
    send_to_finance:             Number(row.send_to_finance) || 0,
    activation_pending:          Number(row.activation_pending) || 0,
    not_suitable:                Number(row.not_suitable) || 0,
    pending_member_verification: Number(row.pending_member_verification) || 0,
    reapplications:              Number(row.reapplications) || 0,
    total:                       Number(row.total) || 0,
  };
}

module.exports = {
  list,
  listRegistered,
  listRegisteredForExport,
  registeredStatusCounts,
  registrationStatusLabel,
  getById,
  create,
  update,
  setStatus,
  findActiveByMobile,
  listTransactions,
  listMappedClients,
  aggregates,
  attendance,
  statusCounts,
  MUTABLE_COLUMNS,
  _internals: {
    buildRegisteredWhere,
    registeredReapplicationFields,
    effectiveVerificationFlag,
    assertGenericVerificationUnchanged,
  },
};
