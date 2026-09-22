const { pool } = require('../db');
const logger = require('../logger');
const stateService = require('./state.service');

/*
 * Manage Cities — generic master.
 *
 * Operates on existing tbl_city (NOT a new table — cities have been a
 * shared schema-level entity since the legacy CRM, with five legacy
 * services already reading the same rows). Columns in use:
 *   city_id, city_name, state_id, city_status, tier, district, reference_pincode
 *
 * UX columns (per spec for Manage Cities):
 *   City ID | City Name | State | District | Tier | Status |
 *   No. of Zones | No. of Pincodes | No. of Technicians
 *
 * Counts are computed at read time (no stored flags) so onboarding /
 * deactivating downstream entities reflects on the next page load.
 */

const STATUS_INACTIVE = 0;
const STATUS_ACTIVE   = 1;
/*
 * PENDING is a SENTINEL on the existing tinyint, not a new column — same
 * shape as DELETED_STATUS = 3 in services/entity-deletion.service.js.
 * Six code paths (three of them unauthenticated) create cities on the fly;
 * they now write 2 so the city exists for the booking that needed it but is
 * not offered anywhere until an operator approves it.
 *
 * ⚠ Do NOT propagate a `city_status = 1` filter into name-resolution JOINs.
 * ~160 places read tbl_city and most correctly do not filter, because a
 * saved job must keep rendering its city after that city is deactivated.
 * Only SELECTION surfaces filter.
 */
const STATUS_PENDING  = 2;

function mkErr(status, message) { const e = new Error(message); e.status = status; return e; }

/*
 * Whitelist of sortable columns. Maps the public API key (sortBy=...) to
 * the actual SQL expression. Whitelisting is mandatory — interpolating an
 * arbitrary client-supplied column name into ORDER BY is a SQL injection
 * vector. Computed columns (zone_count, etc.) are valid because MySQL
 * resolves SELECT aliases inside ORDER BY.
 */
const SORTABLE_COLUMNS = Object.freeze({
  city_id:          'c.city_id',
  city_name:        'c.city_name',
  state_name:       's.state_name',
  district:         'c.district',
  tier:             'c.tier',
  zone_count:       'zone_count',
  pincode_count:    'pincode_count',
  technician_count: 'technician_count',
  city_status:      'c.city_status',
});

// ─── List ────────────────────────────────────────────────────────────
// Creator-audit tracking columns on tbl_city (created_by / created_by_type /
// created_date) are a pending migration — probe once + guard so this query
// stays valid where it's unrun.
let _hasCityCreatorCol = null;
async function hasCityCreatorCol() {
  if (_hasCityCreatorCol !== null) return _hasCityCreatorCol;
  try {
    const [r] = await pool.query("SHOW COLUMNS FROM tbl_city LIKE 'created_by_type'");
    _hasCityCreatorCol = r.length > 0;
  } catch {
    /*
     * A METADATA probe: absence comes back as ZERO ROWS, so any error here is a
     * genuine fault — a pool blip, a lock timeout — and never the answer. The
     * memo is deliberately LEFT NULL so the next call re-probes; caching false
     * would disable the feature until the container restarts, which is the
     * defect tests/schema-probe-failure-not-cached.test.js exists to catch.
     * (utils/schema-absent-error.js documents the two probe styles; only the
     * try-the-query style may cache its error.)
     */
    return false;
  }
  return _hasCityCreatorCol;
}

/*
 * Approval-audit columns (approved_by / approved_at / approval_decision /
 * merged_into_city_id) ship in migrations/executed/2026-09-09-city-approval-flow.sql
 * and are NOT on QA. Same probe-once-and-guard shape as hasCityCreatorCol()
 * above: approve/reject must work on a database where the migration has not
 * run — minus the audit stamp — rather than throwing ER_BAD_FIELD_ERROR.
 * One column stands for all four: they land in a single ALTER block, so a
 * database with one has all of them.
 */
let _hasCityApprovalCols = null;
async function hasCityApprovalCols() {
  if (_hasCityApprovalCols !== null) return _hasCityApprovalCols;
  try {
    const [r] = await pool.query("SHOW COLUMNS FROM tbl_city LIKE 'approval_decision'");
    _hasCityApprovalCols = r.length > 0;
  } catch {
    /*
     * A METADATA probe: absence comes back as ZERO ROWS, so any error here is a
     * genuine fault — a pool blip, a lock timeout — and never the answer. The
     * memo is deliberately LEFT NULL so the next call re-probes; caching false
     * would disable the feature until the container restarts, which is the
     * defect tests/schema-probe-failure-not-cached.test.js exists to catch.
     * (utils/schema-absent-error.js documents the two probe styles; only the
     * try-the-query style may cache its error.)
     */
    return false;
  }
  return _hasCityApprovalCols;
}

async function listCities({
  q, stateId, createdByTech = false, includeInactive = false,
  limit = 200, offset = 0,
  sortBy = 'city_name', sortDir = 'asc',
} = {}) {
  limit  = Math.min(Math.max(Number(limit)  || 200, 1), 1000);
  offset = Math.max(Number(offset) || 0, 0);

  logger.info('List cities · q=' + (q || '-') + ' stateId=' + (stateId || '-') + ' includeInactive=' + includeInactive + ' sortBy=' + sortBy + ' sortDir=' + sortDir + ' limit=' + limit + ' offset=' + offset);

  const sortExpr = SORTABLE_COLUMNS[sortBy] || SORTABLE_COLUMNS.city_name;
  const dir      = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  // Stable secondary sort on city_id keeps row order deterministic when
  // the primary sort key has duplicates (e.g. many cities with empty
  // district). Without it, paginated results can shuffle on each page-load.
  const orderBy  = `${sortExpr} ${dir}, c.city_id ASC`;

  const where = ['1=1'];
  const params = [];
  if (!includeInactive) where.push('c.city_status = 1');
  if (q) {
    where.push('(c.city_name LIKE ? OR c.district LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  if (stateId) { where.push('c.state_id = ?'); params.push(Number(stateId)); }

  // Creator-audit projection + filter, gated on the pending migration.
  const hasCreator = await hasCityCreatorCol();
  const creatorSelect = hasCreator
    ? "c.created_by, c.created_by_type, c.created_date, COALESCE(cbe.efr_name, cbu.user_name) AS created_by_name"
    : 'NULL AS created_by, NULL AS created_by_type, NULL AS created_date, NULL AS created_by_name';
  const creatorJoin = hasCreator
    ? `LEFT JOIN tbl_easyfixer cbe ON (c.created_by_type = 'technician' AND cbe.efr_id = c.created_by)
       LEFT JOIN tbl_user      cbu ON (c.created_by_type = 'user'       AND cbu.user_id = c.created_by)`
    : '';
  if (createdByTech && hasCreator) where.push("c.created_by_type = 'technician'");

  const [rows] = await pool.query(
    `SELECT
        c.city_id,
        c.city_name,
        c.state_id,
        s.state_name,
        c.district,
        c.tier,
        c.reference_pincode,
        c.city_status,
        ${creatorSelect},
        (SELECT COUNT(*) FROM tbl_zone_master z
          WHERE z.city_id = c.city_id AND z.zone_status = 1)        AS zone_count,
        (SELECT COUNT(*) FROM tbl_pincode p
          WHERE p.city_id = c.city_id AND p.pincode_status = 1)     AS pincode_count,
        (SELECT COUNT(*) FROM tbl_easyfixer e
          WHERE e.efr_cityId = c.city_id AND e.efr_status = 1)      AS technician_count
       FROM tbl_city  c
       LEFT JOIN tbl_state s ON s.state_id = c.state_id
       ${creatorJoin}
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  logger.info('Found ' + rows.length + ' cities');

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM tbl_city c WHERE ${where.join(' AND ')}`,
    params
  );

  logger.info('Returning ' + rows.length + ' cities · total=' + total);
  return { items: rows, total };
}

async function getCityById(cityId) {
  logger.info('Get city by id · id=' + cityId);
  const [[row]] = await pool.query(
    `SELECT c.city_id, c.city_name, c.state_id, s.state_name,
            c.district, c.tier, c.reference_pincode, c.city_status,
            (SELECT COUNT(*) FROM tbl_zone_master z
              WHERE z.city_id = c.city_id AND z.zone_status = 1)        AS zone_count,
            (SELECT COUNT(*) FROM tbl_pincode p
              WHERE p.city_id = c.city_id AND p.pincode_status = 1)     AS pincode_count,
            (SELECT COUNT(*) FROM tbl_easyfixer e
              WHERE e.efr_cityId = c.city_id AND e.efr_status = 1)      AS technician_count
       FROM tbl_city  c
       LEFT JOIN tbl_state s ON s.state_id = c.state_id
      WHERE c.city_id = ? LIMIT 1`,
    [cityId]
  );
  return row || null;
}

// ─── Create ──────────────────────────────────────────────────────────
async function createCity({ city_name, state_id, district, tier, reference_pincode }) {
  logger.info('Create city · city_name=' + (city_name || '-') + ' state_id=' + (state_id || '-') + ' district=' + (district || '-') + ' tier=' + (tier || '-'));
  const trimmed = String(city_name || '').trim();
  if (!trimmed) throw mkErr(400, 'city_name is required');
  if (!state_id) throw mkErr(400, 'state_id is required');

  // City names are unique within a state — a "Hyderabad" in Telangana
  // and a hypothetical same-named entry in another state are distinct.
  const [[stateRow]] = await pool.query(
    'SELECT state_id FROM tbl_state WHERE state_id = ? LIMIT 1', [state_id]
  );
  if (!stateRow) throw mkErr(400, `Unknown state_id ${state_id}`);
  await stateService.assertActiveStates([state_id]);

  const [[dup]] = await pool.query(
    `SELECT city_id FROM tbl_city
      WHERE state_id = ? AND LOWER(city_name) = LOWER(?) LIMIT 1`,
    [state_id, trimmed]
  );
  if (dup) throw mkErr(409, `City "${trimmed}" already exists in this state`);

  // The city's zonal manager is its state's (services/state.service.js). This
  // path used to set none at all, so every hand-added city started unowned and
  // fell out of every zonal-scoped report until someone patched it in the DB.
  const stateUser = await stateService.stateManagerFor(state_id);

  const [r] = await pool.query(
    `INSERT INTO tbl_city
       (city_name, state_id, district, tier, reference_pincode, city_status, state_user)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      trimmed,
      Number(state_id),
      district || null,
      tier || null,
      reference_pincode || null,
      STATUS_ACTIVE,
      stateUser,
    ]
  );
  logger.info('City created · id=' + r.insertId + ' state_user=' + (stateUser ?? 'none'));
  return getCityById(r.insertId);
}

// ─── Update ──────────────────────────────────────────────────────────
async function updateCity(cityId, fields) {
  logger.info('Update city · id=' + cityId + ' fields=[' + Object.keys(fields || {}).join(',') + ']');
  const sets = [];
  const params = [];

  if (fields.city_name !== undefined) {
    const trimmed = String(fields.city_name).trim();
    if (!trimmed) throw mkErr(400, 'city_name cannot be blank');
    // Uniqueness check needs the current state_id (or the new one if also updating).
    const [[me]] = await pool.query('SELECT state_id FROM tbl_city WHERE city_id = ? LIMIT 1', [cityId]);
    if (!me) throw mkErr(404, 'City not found');
    const targetStateId = fields.state_id !== undefined ? Number(fields.state_id) : me.state_id;
    const [[dup]] = await pool.query(
      `SELECT city_id FROM tbl_city
        WHERE state_id = ? AND LOWER(city_name) = LOWER(?) AND city_id <> ? LIMIT 1`,
      [targetStateId, trimmed, cityId]
    );
    if (dup) throw mkErr(409, `Another city named "${trimmed}" exists in this state`);
    sets.push('city_name = ?'); params.push(trimmed);
  }
  if (fields.state_id !== undefined) {
    const [[s]] = await pool.query('SELECT state_id FROM tbl_state WHERE state_id = ? LIMIT 1', [fields.state_id]);
    if (!s) throw mkErr(400, `Unknown state_id ${fields.state_id}`);
    await stateService.assertActiveStates([fields.state_id]);
    sets.push('state_id = ?'); params.push(Number(fields.state_id));
    /*
     * The city takes its state's zonal manager. The edit dialog always sends
     * state_id, so saving any city also realigns its manager with its state —
     * intended: the state is the only place a manager is set. A state with no
     * manager yet leaves the city's current one alone rather than blanking it.
     */
    const stateUser = await stateService.stateManagerFor(fields.state_id);
    if (stateUser != null) { sets.push('state_user = ?'); params.push(stateUser); }
  }
  if (fields.district !== undefined)          { sets.push('district = ?');          params.push(fields.district || null); }
  if (fields.tier !== undefined)              { sets.push('tier = ?');              params.push(fields.tier || null); }
  if (fields.reference_pincode !== undefined) { sets.push('reference_pincode = ?'); params.push(fields.reference_pincode || null); }
  if (fields.is_active !== undefined) {
    /*
     * The Active toggle cannot move a PENDING city. Sending is_active:false
     * for one would retire it to 0 with no merge (see deactivateCity), and
     * is_active:true would promote it to 1 behind approveCity's back, leaving
     * approved_by / approved_at / approval_decision NULL — an approved city
     * with no record of who approved it. Everything else on the row stays
     * editable, so an operator can still fix a district or a typo before
     * deciding.
     */
    const [[cur]] = await pool.query(
      'SELECT city_status FROM tbl_city WHERE city_id = ? LIMIT 1', [cityId]
    );
    if (!cur) throw mkErr(404, 'City not found');
    if (Number(cur.city_status) === STATUS_PENDING) {
      logger.warn('Status change refused · city is pending approval · id=' + cityId);
      throw mkErr(409,
        'This city is awaiting approval — use Approve or Reject rather than the Active toggle.');
    }
    sets.push('city_status = ?'); params.push(fields.is_active ? 1 : 0);
    /*
     * Reviving a rejected city clears its decision. The row would otherwise be
     * ACTIVE while still claiming it was merged away, and the forward pointer
     * is load-bearing now — new rows resolving this city's name would be sent
     * to the replacement instead of to the city an operator just revived.
     * The merged rows themselves stay where they went; the merge is one-way.
     */
    if (fields.is_active && await hasCityApprovalCols()) {
      sets.push('approval_decision = NULL', 'merged_into_city_id = NULL');
    }
  }

  if (!sets.length) throw mkErr(400, 'No mutable fields supplied');

  params.push(cityId);
  const [r] = await pool.query(`UPDATE tbl_city SET ${sets.join(', ')} WHERE city_id = ?`, params);
  if (!r.affectedRows) return null;
  logger.info('City updated · id=' + cityId);
  return getCityById(cityId);
}

// ─── Soft-delete (status flag) ───────────────────────────────────────
/*
 * No hard delete. tbl_city is referenced by tbl_pincode, tbl_zone_master,
 * tbl_easyfixer, address tables, etc. — orphaning rows would break joins
 * across legacy services. Setting city_status = 0 hides the row from
 * default lists while preserving every historical reference.
 */
async function deactivateCity(cityId) {
  logger.info('Deactivate city · id=' + cityId);
  /*
   * A PENDING city must not be retired this way. Deactivating it flips it to
   * 0 with no merge and no merged_into_city_id, so it leaves listPendingCities
   * for good — never approved, never rejected — while its pincodes and
   * addresses keep pointing at it. That is precisely the orphaned state
   * rejectCity exists to prevent, reached under the weaker isCityEdit grant.
   * Rejection is the only route out of the queue that moves the rows.
   */
  const [[cur]] = await pool.query(
    'SELECT city_status FROM tbl_city WHERE city_id = ? LIMIT 1', [cityId]
  );
  if (cur && Number(cur.city_status) === STATUS_PENDING) {
    logger.warn('Deactivate refused · city is pending approval · id=' + cityId);
    throw mkErr(409,
      'This city is awaiting approval. Approve it, or reject it and choose a replacement '
      + '— rejecting moves its rows, deactivating would strand them.');
  }
  const [r] = await pool.query(
    'UPDATE tbl_city SET city_status = 0 WHERE city_id = ?',
    [cityId]
  );
  logger.info('City deactivated · id=' + cityId + ' affected=' + r.affectedRows);
  return r.affectedRows > 0;
}

// ─── Approval queue ──────────────────────────────────────────────────
/*
 * Cities the automatic paths created (city_status = 2), newest first, with
 * enough context for an operator to decide without opening each row: who
 * created it and how, its district / reference pincode, and how many
 * pincodes have already attached themselves to it.
 *
 * The pincode count is UNFILTERED, unlike listCities()' `pincode_count`
 * which counts only pincode_status = 1. Here the question is "how much has
 * already accreted onto this city", and a not-yet-serviceable pincode
 * counts towards that just as much as a serviceable one.
 */
async function listPendingCities({ limit = 200, offset = 0 } = {}) {
  limit  = Math.min(Math.max(Number(limit)  || 200, 1), 1000);
  offset = Math.max(Number(offset) || 0, 0);
  logger.info('List pending cities · limit=' + limit + ' offset=' + offset);

  const hasCreator = await hasCityCreatorCol();
  const creatorSelect = hasCreator
    ? "c.created_by, c.created_by_type, c.created_date, COALESCE(cbe.efr_name, cbu.user_name) AS created_by_name"
    : 'NULL AS created_by, NULL AS created_by_type, NULL AS created_date, NULL AS created_by_name';
  const creatorJoin = hasCreator
    ? `LEFT JOIN tbl_easyfixer cbe ON (c.created_by_type = 'technician' AND cbe.efr_id = c.created_by)
       LEFT JOIN tbl_user      cbu ON (c.created_by_type = 'user'       AND cbu.user_id = c.created_by)`
    : '';
  // "Newest first" is created_date where the audit column exists. It is
  // NULLable (rows predating the migration), and MySQL sorts NULLs LAST in
  // DESC — which is what we want: undated rows sink below dated ones, and
  // city_id DESC keeps them in insert order among themselves.
  const orderBy = hasCreator ? 'c.created_date DESC, c.city_id DESC' : 'c.city_id DESC';

  const [rows] = await pool.query(
    `SELECT
        c.city_id,
        c.city_name,
        c.state_id,
        s.state_name,
        c.district,
        c.tier,
        c.reference_pincode,
        c.city_status,
        ${creatorSelect},
        (SELECT COUNT(*) FROM tbl_pincode p WHERE p.city_id = c.city_id) AS pincode_count
       FROM tbl_city  c
       LEFT JOIN tbl_state s ON s.state_id = c.state_id
       ${creatorJoin}
      WHERE c.city_status = ?
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`,
    [STATUS_PENDING, limit, offset]
  );

  // Full count, not rows.length — the tab badge must show the backlog, not
  // the page.
  const [[{ total }]] = await pool.query(
    'SELECT COUNT(*) AS total FROM tbl_city WHERE city_status = ?', [STATUS_PENDING]
  );

  logger.info('Returning ' + rows.length + ' pending cities · total=' + total);
  return { items: rows, total };
}

// ─── Approve ─────────────────────────────────────────────────────────
/*
 * 2 → 1. The status guard lives in the WHERE clause, so the check and the
 * write are one statement and two operators clicking Approve at the same
 * moment cannot both win. affectedRows = 0 then means either "no such city"
 * or "not pending" — one follow-up read tells them apart, and it only runs
 * on the failure path.
 */
async function approveCity(cityId, userId) {
  logger.info('Approve city · id=' + cityId + ' by=' + (userId || '-'));
  const stamp = await hasCityApprovalCols();
  const sets  = ['city_status = ?'];
  const params = [STATUS_ACTIVE];
  if (stamp) {
    /*
     * merged_into_city_id = NULL is an INVARIANT, not tidying. Since the
     * pointer became load-bearing (services/pincode.service.js forwards name
     * resolution through it), an ACTIVE city carrying one would silently
     * redirect new rows away from itself. The invariant is "a selectable city
     * has no forward pointer", and it is enforced at both places a city
     * becomes active — here and in updateCity's reactivation branch.
     */
    sets.push('approved_by = ?', 'approved_at = ?', "approval_decision = 'approved'",
      'merged_into_city_id = NULL');
    params.push(userId || null, new Date());
  }
  /*
   * Re-read the manager from the state at approval, not creation. The city
   * copied it when it was minted, but it may have sat in the queue while the
   * state was reassigned — and the approver only clicks Approve, there is no
   * manager field to fill. COALESCE keeps the copy if the state has none.
   * (Correlated to the outer row but reading tbl_state, so no ER_UPDATE_TABLE_USED.)
   */
  if (await stateService.hasStateManagerCols()) {
    sets.push('state_user = COALESCE((SELECT s.state_user FROM tbl_state s WHERE s.state_id = tbl_city.state_id), state_user)');
  }
  params.push(cityId, STATUS_PENDING);

  const [r] = await pool.query(
    `UPDATE tbl_city SET ${sets.join(', ')} WHERE city_id = ? AND city_status = ?`, params
  );
  if (!r.affectedRows) {
    const current = await getCityById(cityId);
    if (!current) throw mkErr(404, 'City not found');
    logger.warn('Approve rejected · not pending · id=' + cityId + ' status=' + current.city_status);
    throw mkErr(409, `City is not pending approval (city_status = ${current.city_status})`);
  }
  logger.info('City approved · id=' + cityId + ' audit=' + stamp);
  return getCityById(cityId);
}

/*
 * Chunk size for the merge UPDATEs. 5,000 rows is comfortably one short
 * statement on the biggest target: tbl_address is ~421k rows, and its city_id
 * IS indexed (FK_tbl_address_tbl_city), so each chunk is an index range scan
 * rather than a table scan. The largest single city on QA holds ~60k
 * addresses — twelve chunks — and a pending city, being freshly minted, holds
 * far fewer.
 */
const MERGE_CHUNK_ROWS = 5000;
/* Pure runaway guard: 5,000 x 4,000 is 20M rows, ~50x the whole table. */
const MERGE_MAX_CHUNKS = 4000;

/**
 * Repoint every row of `table`.`col` from one city to another, in bounded
 * statements, and return how many moved.
 *
 * WHAT THIS DOES AND DOES NOT BUY. It is still ONE transaction and one commit
 * — deliberately. InnoDB holds every row lock until COMMIT, so chunking does
 * NOT shorten how long the locks are held or how many are taken; anyone
 * expecting that from "batching" will be disappointed. Committing per chunk
 * WOULD release them, and would also destroy the property that makes this
 * merge safe: an interrupted merge would leave a city's rows split across two
 * cities, with no record of how far it got. Atomicity is worth more than lock
 * duration here.
 *
 * What it does buy: no single statement long enough to trip
 * innodb_lock_wait_timeout or a proxy's statement timeout, a bounded undo
 * segment per statement, and — the practical one — progress in the log, so a
 * merge that is slow is distinguishable from one that is stuck.
 *
 * Terminates without OFFSET because the UPDATE removes its own matches: once a
 * row's city_id is the replacement it no longer satisfies `col = ?`, so the
 * next pass sees the next batch. A short pass means the table is done.
 */
async function repointInChunks(conn, table, col, fromCityId, toCityId) {
  let moved = 0;
  for (let pass = 0; pass < MERGE_MAX_CHUNKS; pass += 1) {
    const [r] = await conn.query(
      `UPDATE ${table} SET ${col} = ? WHERE ${col} = ? LIMIT ${MERGE_CHUNK_ROWS}`,
      [toCityId, fromCityId]
    );
    moved += r.affectedRows;
    if (r.affectedRows < MERGE_CHUNK_ROWS) return moved;
    logger.info('Merge chunk · ' + table + '.' + col + ' · ' + moved + ' rows so far · city '
      + fromCityId + ' → ' + toCityId);
  }
  /*
   * Only reachable if the UPDATE stops removing its own matches — which would
   * mean fromCityId === toCityId. rejectCity rejects that with a 400 before
   * reaching here, so this is a guard against a future caller, not a live
   * case. Throwing rolls the whole merge back, which is the right answer: a
   * loop that will not terminate must not be committed halfway.
   */
  throw mkErr(500, `Merge of ${table}.${col} did not converge after ${MERGE_MAX_CHUNKS} passes`);
}

// ─── Reject (= MERGE) ────────────────────────────────────────────────
/*
 * Rejecting is not deactivating. By the time an operator sees a pending
 * city, rows already point at it — that is WHY it exists. Flipping it to 0
 * and walking away strands them: the address keeps a city_id nobody lists,
 * so the job it belongs to loses its city on every selection surface.
 *
 * So a rejection REPOINTS every reference at the replacement city and only
 * then retires the row.
 *
 * ─── THE SCOPE IS MEASURED, NOT GUESSED ────────────────────────────────
 * Per-row correspondence test against tbl_city over every column in the
 * schema whose name looks like a city id (rows on QA / share resolving):
 *
 *   tbl_address.city_id             354,900   99.8%   ← how JOBS reach a city
 *   tbl_zone_city_mapping.city_id    57,750   98.7%
 *   tbl_pincode.city_id              11,052    100%
 *   tbl_easyfixer.efr_cityId          7,929    100%
 *   tbl_client.client_city_id            398    100%
 *   tbl_client_billing.c_bill_city_id    293    100%
 *   tbl_client_store.city_id               3    100%
 *   tbl_user.city_id                       3    100%
 *   firefox_city_mapping.city_id          20    100%
 *
 * Two more carry NO data on QA but their WRITERS in this repo settle them,
 * which is a stronger proof than a correspondence rate:
 *
 *   tbl_zone_master.city_id       — services/zone.service.js:361 inserts it
 *                                   straight after assertCityExists(), and
 *                                   listCities() above already joins it as a
 *                                   tbl_city FK for `zone_count`. Included:
 *                                   leaving it out would orphan zones, and
 *                                   refusing instead would make every city
 *                                   with a zone un-rejectable.
 *   lms_chase_assignment.city_id  — routes/admin/lms-action.js:505 inserts
 *                                   `Number(t.efr_cityId)`, i.e. a value
 *                                   copied from a column already on this
 *                                   list. Included.
 *
 * ─── WHAT IS DELIBERATELY NOT TOUCHED ──────────────────────────────────
 *   tbl_zone_city_mapping.city_zone_id  — 15.9% resolve. A DIFFERENT ID
 *     SPACE (it is that table's own PK). Repointing it corrupts zone
 *     mappings.
 *   tbl_easyfixer.efr_zone_city_id      — 78.8% resolve, which is
 *     coincidental id-range overlap, not a relationship. It FKs to
 *     tbl_zone_city_mapping.city_zone_id — stated in zone.service.js:57,
 *     joined that way in job.service.js:2107,
 *     candidate-ranking.service.js:1033 and pincode.service.js:142. Same
 *     forbidden id space as city_zone_id. NOT a tbl_city id.
 *
 * ─── UNIQUE-CONSTRAINT HAZARD: CHECKED, information_schema ─────────────
 * No unique index on any of the eleven tables includes its city column, so
 * a repoint cannot violate one:
 *   tbl_address / tbl_easyfixer / tbl_client / tbl_client_billing /
 *   tbl_user / tbl_zone_master / firefox_city_mapping → PRIMARY only
 *   tbl_pincode          → uniq_pincode(pincode)
 *   tbl_client_store     → uq_client_store_code(fk_client_id, store_code)
 *   lms_chase_assignment → uq(efr_id, course_id, batch_id)
 *   tbl_zone_city_mapping→ PRIMARY(city_zone_id) only — no (zone_id,
 *     city_id) unique, so the merge cannot violate one. It CAN create a
 *     duplicate (zone_id, city_id) pair; QA already holds 3,425 such
 *     duplicate groups (the documented legacy cross-join in
 *     job.service.js:2095), and no reader of that table dedupes on the
 *     pair, so this is pre-existing shape rather than new damage.
 */
const MERGE_TARGETS = Object.freeze([
  ['tbl_address',           'city_id'],
  ['tbl_zone_city_mapping', 'city_id'],
  ['tbl_pincode',           'city_id'],
  ['tbl_easyfixer',         'efr_cityId'],
  ['tbl_client',            'client_city_id'],
  ['tbl_client_billing',    'c_bill_city_id'],
  ['tbl_client_store',      'city_id'],
  ['tbl_user',              'city_id'],
  ['firefox_city_mapping',  'city_id'],
  ['tbl_zone_master',       'city_id'],
  ['lms_chase_assignment',  'city_id'],
]);

/*
 * The one column that could not be established either way.
 *
 * tbl_opencity_servicetype.open_city_id is empty on QA AND has zero
 * references anywhere in this repo, so neither data nor code says what it
 * points at — and it does not even follow the `city_id` naming convention,
 * so "it looks like a city id" is the whole of the evidence. It also
 * carries UNIQUE(open_city_id, service_type_id), which a blind repoint
 * could violate outright.
 *
 * Guessing has two failure modes and they are not symmetric: repointing a
 * foreign id space corrupts rows silently, while refusing a merge is a
 * message an operator can read. So: COUNT the rows that reference the
 * rejected city and REFUSE the whole merge if any exist. Empty — the
 * expected case, and the only one QA can produce — costs one cheap COUNT
 * and changes nothing.
 *
 * To retire this guard: establish what open_city_id points at, then either
 * move it into MERGE_TARGETS or delete this block.
 */
const UNVERIFIED_TARGETS = Object.freeze([
  ['tbl_opencity_servicetype', 'open_city_id'],
]);

async function rejectCity(cityId, replacementCityId, userId) {
  logger.info('Reject city · id=' + cityId + ' → replacement=' + replacementCityId + ' by=' + (userId || '-'));
  cityId            = Number(cityId);
  replacementCityId = Number(replacementCityId);
  // Cheap enough to answer before taking a connection off the pool.
  if (cityId === replacementCityId) throw mkErr(400, 'replacement_city_id must be a different city');

  // Probed BEFORE the connection is taken. It runs on the shared pool, and
  // asking the pool for a second connection while already holding one is
  // how a saturated pool deadlocks against itself.
  const stamp = await hasCityApprovalCols();

  let conn;                                  // acquired inside the try; finally releases only if we got one
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    // FOR UPDATE, so two operators rejecting the same city serialise here
    // rather than both passing the status check and merging twice.
    const [[target]] = await conn.query(
      'SELECT city_id, city_status FROM tbl_city WHERE city_id = ? FOR UPDATE', [cityId]
    );
    if (!target) { throw mkErr(404, 'City not found'); }
    if (target.city_status !== STATUS_PENDING) {
      logger.warn('Reject refused · not pending · id=' + cityId + ' status=' + target.city_status);
      throw mkErr(409, `City is not pending approval (city_status = ${target.city_status})`);
    }

    /*
     * Merging into a pending or inactive city is the trap this guards: it
     * would move live rows onto a city that is itself awaiting a decision, or
     * onto one an operator has already retired.
     *
     * FOR UPDATE, because a plain read is a check without a hold. The status
     * was verified and then relied on for the rest of the transaction while
     * nothing stopped a concurrent DELETE /admin/cities/:id from retiring the
     * replacement in the gap — leaving the merge to complete onto a city that
     * was active when it was checked and inactive by the time it was written
     * to. Every row would land somewhere that appears in no picker, which is
     * the exact orphaning this whole flow exists to prevent, and no error
     * would be raised.
     *
     * Deadlock-free by shape rather than by luck: the rejected city is locked
     * first and the replacement second, and the two can never swap roles — a
     * rejection requires a PENDING subject and an ACTIVE replacement, and no
     * city is both. So no two transactions can hold these locks in opposite
     * order.
     */
    const [[replacement]] = await conn.query(
      'SELECT city_id, city_status FROM tbl_city WHERE city_id = ? FOR UPDATE', [replacementCityId]
    );
    if (!replacement) { throw mkErr(400, `Unknown replacement_city_id ${replacementCityId}`); }
    if (replacement.city_status !== STATUS_ACTIVE) {
      throw mkErr(400, `replacement_city_id ${replacementCityId} is not an active city (city_status = ${replacement.city_status})`);
    }

    for (const [table, col] of UNVERIFIED_TARGETS) {
      // A missing table is the same answer as an empty one: nothing can be
      // orphaned there. Anything else propagates and rolls the merge back.
      let n = 0;
      try {
        const [[row]] = await conn.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`, [cityId]);
        n = Number(row.n) || 0;
      } catch (e) {
        if (e && e.code === 'ER_NO_SUCH_TABLE') n = 0;
        else throw e;
      }
      if (n > 0) {
        logger.warn('Reject refused · unverified reference · ' + table + '.' + col + ' rows=' + n + ' city=' + cityId);
        throw mkErr(409,
          `${n} row(s) in ${table}.${col} reference this city, and that column's id space is unverified — ` +
          'merging could corrupt it. Resolve those rows manually, or verify the column and add it to MERGE_TARGETS.');
      }
    }

    // Table and column names come only from the frozen constant above —
    // never from a request — so interpolating them is not an injection
    // surface, and identifiers cannot be bound as parameters anyway.
    const moved = {};
    let total = 0;
    for (const [table, col] of MERGE_TARGETS) {
      const n = await repointInChunks(conn, table, col, cityId, replacementCityId);
      moved[`${table}.${col}`] = n;
      total += n;
    }

    const sets  = ['city_status = ?'];
    const params = [STATUS_INACTIVE];
    if (stamp) {
      sets.push('approved_by = ?', 'approved_at = ?', "approval_decision = 'rejected'", 'merged_into_city_id = ?');
      params.push(userId || null, new Date(), replacementCityId);
    }
    params.push(cityId);
    await conn.query(`UPDATE tbl_city SET ${sets.join(', ')} WHERE city_id = ?`, params);

    await conn.commit();
    logger.info('City rejected + merged · id=' + cityId + ' → ' + replacementCityId + ' rows=' + total + ' audit=' + stamp);
    return { city_id: cityId, merged_into_city_id: replacementCityId, rows_moved: total, moved, audit_recorded: stamp };
  } catch (e) {
    try { if (conn) await conn.rollback(); } catch { /* connection already gone */ }
    if (!e || !e.status) logger.error('Reject city failed · id=' + cityId + ' · ' + ((e && e.message) || e));
    throw e;
  } finally {
    if (conn) conn.release();
  }
}

module.exports = {
  listCities,
  listPendingCities,
  getCityById,
  createCity,
  updateCity,
  deactivateCity,
  approveCity,
  rejectCity,
  MERGE_TARGETS,
  UNVERIFIED_TARGETS,
  STATUS_PENDING,
  SORTABLE_COLUMNS,
};
