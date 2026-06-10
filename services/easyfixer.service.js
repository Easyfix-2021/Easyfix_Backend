const { pool } = require('../db');

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
  e.final_submission, e.new_easy_fixer,
  e.user_id,
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
  q, cityId, serviceCategory, isVerified, status,
  scope,
  limit = 50, offset = 0, includeInactive = false,
  // Manage Easyfixers parity filters (2026-06-08)
  easyfixerId, name, mobileNo,
  efAccount, stateId, serviceType, deepSkillId,
  activeFromDate, activeToDate,
  zonalManagerId, attendance, deepSkillMapped,
} = {}) {
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
  if (status == null && !includeInactive) {
    // Default: status=1 Active
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
    clauses.push('EXISTS (SELECT 1 FROM tbl_efr_deepskill_mapping dsm WHERE dsm.easyfixer_id = e.efr_id AND dsm.deep_skill_id = ?)');
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

  params.push(Number(limit), Number(offset));
  const [rows] = await pool.query(
    `SELECT ${LIST_COLUMNS}
       ${LIST_JOINS}
       ${where}
       ORDER BY e.efr_id DESC
       LIMIT ? OFFSET ?`,
    params
  );
  return { rows, total };
}

// ─── Detail ─────────────────────────────────────────────────────────
async function getById(id) {
  const [[row]] = await pool.query(
    `SELECT ${DETAIL_COLUMNS}
       FROM tbl_easyfixer e
       LEFT JOIN tbl_city c ON c.city_id = e.efr_cityId
      WHERE e.efr_id = ? LIMIT 1`,
    [id]
  );
  return row || null;
}

// ─── Create ─────────────────────────────────────────────────────────
async function findActiveByMobile(efrNo) {
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

async function create(input, actor) {
  const existing = await findActiveByMobile(input.efr_no);
  if (existing) {
    const err = new Error(`an active easyfixer with efr_no=${input.efr_no} already exists (efr_id=${existing.efr_id})`);
    err.status = 409;
    err.details = { existingId: existing.efr_id };
    throw err;
  }

  const columns = [];
  const values = [];
  for (const col of MUTABLE_COLUMNS) {
    if (input[col] !== undefined) {
      columns.push(col);
      values.push(input[col]);
    }
  }
  // Audit + defaults
  columns.push('efr_status', 'inserted_by', 'insert_date', 'update_date');
  values.push(1, actor?.user_id || null, new Date(), new Date());

  const placeholders = columns.map(() => '?').join(', ');
  const [result] = await pool.query(
    `INSERT INTO tbl_easyfixer (${columns.join(', ')}) VALUES (${placeholders})`,
    values
  );
  return getById(result.insertId);
}

// ─── Update ─────────────────────────────────────────────────────────
async function update(id, input, actor) {
  const existing = await getById(id);
  if (!existing) {
    const err = new Error('easyfixer not found');
    err.status = 404;
    throw err;
  }

  const sets = [];
  const values = [];
  for (const col of MUTABLE_COLUMNS) {
    if (input[col] !== undefined) {
      sets.push(`${col} = ?`);
      values.push(input[col]);
    }
  }
  if (sets.length === 0) return existing; // nothing to change

  sets.push('updated_by = ?', 'update_date = ?');
  values.push(actor?.user_id || null, new Date());
  values.push(id);

  await pool.query(
    `UPDATE tbl_easyfixer SET ${sets.join(', ')} WHERE efr_id = ?`,
    values
  );
  return getById(id);
}

// ─── Status toggle ──────────────────────────────────────────────────
async function setStatus(id, { active, reasonId, comment }, actor) {
  const existing = await getById(id);
  if (!existing) {
    const err = new Error('easyfixer not found');
    err.status = 404;
    throw err;
  }

  const sets = ['efr_status = ?', 'updated_by = ?', 'update_date = ?'];
  const values = [active ? 1 : 0, actor?.user_id || null, new Date()];

  if (active === false) {
    sets.push('inactive_reason = ?', 'inactive_comment = ?', 'last_inactive_date_time = ?');
    values.push(reasonId || null, comment || null, new Date());
  } else {
    // Reactivation: clear inactivity reason fields
    sets.push('inactive_reason = NULL', 'inactive_comment = NULL');
  }

  values.push(id);
  await pool.query(
    `UPDATE tbl_easyfixer SET ${sets.join(', ')} WHERE efr_id = ?`,
    values
  );
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
            cu.customer_name        AS customer_name,
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
  return { rows, total };
}

// ─── Sub-resource: Mapped Clients ───────────────────────────────────
// Feeds the "Client Mapping" modal. Joins tbl_client_easyfixer_mapping
// (keyed by easyfixer_id, filtered mapping_status = 1) to tbl_client for
// the display name. tbl_client_easyfixer_mapping.easyfixer_id is the FK
// to tbl_easyfixer.efr_id (NOT efr_id — verified in client-tech-mapping
// service comments).
async function listMappedClients(efrId, { limit = 50, offset = 0 } = {}) {
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
       COALESCE(sp.pincodes, '')              AS serviceable_pincodes_csv
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
        * Options-mapped rollup (2026-06-10). Counts DISTINCT options each
        * easyfixer is mapped to in tbl_efr_deepskill_mapping where
        * is_repairing = 1 (the "active" mapping flag). Covered by the
        * composite index added in
        * migrations/2026-06-10-add-efr-deepskill-mapping-composite-index.sql.
        */
       SELECT easyfixer_id, COUNT(*) AS options_mapped_count
         FROM tbl_efr_deepskill_mapping
        WHERE easyfixer_id IN (${placeholders}) AND is_repairing = 1
        GROUP BY easyfixer_id
     ) optmap ON optmap.easyfixer_id = e.efr_id
     LEFT JOIN tbl_efr_serviceable_pincodes sp ON sp.easyfixer_id = e.efr_id
     WHERE e.efr_id IN (${placeholders})${scopeWhere}`,
    [...ids, ...ids, ...ids, ...ids, ...ids, ...scopeParams],
  );

  return { rows };
}

// ─── Sub-resource: Today's Attendance (lazy column fill) ────────────
// POST /admin/easyfixers/attendance body { efrIds: [...] }
// Returns today's attendance row per requested easyfixer (if any).
// Missing rows mean "no information" — FE should treat absence accordingly.
async function attendance(efrIds, { scope } = {}) {
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
  const clauses = [];
  const params = [];

  // Inherit the same RBAC scope-narrowing list() applies first.
  if (scope?.cities) {
    const ci = scope.cities;
    if (ci.mode === 'none') {
      // No access — short-circuit to all-zero counts.
      return {
        active: 0, inactive: 0, idle: 0, not_eligible: 0,
        not_suitable: 0, reg_in_progress: 0, total: 0,
      };
    }
    if (ci.mode === 'allow' && ci.ids.length) {
      clauses.push(`e.efr_cityId IN (${ci.ids.map(() => '?').join(',')})`);
      params.push(...ci.ids);
    }
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const [[row]] = await pool.query(`
    SELECT
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

  return {
    active:          Number(row.active)          || 0,
    inactive:        Number(row.inactive)        || 0,
    idle:            Number(row.idle)            || 0,
    not_eligible:    Number(row.not_eligible)    || 0,
    not_suitable:    Number(row.not_suitable)    || 0,
    reg_in_progress: Number(row.reg_in_progress) || 0,
    total:           Number(row.total)           || 0,
  };
}

module.exports = {
  list,
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
};
