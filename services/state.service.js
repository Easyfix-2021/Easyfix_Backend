const { pool } = require('../db');
const logger = require('../logger');
const { ROLE_ID_TO_GROUP } = require('./role.service');

/*
 * Manage States — the state master and its zonal manager.
 *
 * THE RULE (decided 2026-09-21): one zonal manager per state; one manager may
 * hold many states. The manager is SET on tbl_state.state_user and COPIED onto
 * tbl_city.state_user for every city in the state.
 *
 * WHY THE COPY STAYS. tbl_city.state_user is what everything reads — the jobs
 * zonalManagerId filter, eight QuickSight reports, Manage Pincodes, technician
 * registration scoping, LMS action ownership, the zonal-managers lookup. Moving
 * the control to the state without keeping the city column in step would mean
 * rewriting all of them. Instead every write here pushes the value down in the
 * same transaction, and every city creation / state change / approval copies it
 * from the state (stateManagerFor below). The readers never change.
 *
 * Columns ship in migrations/2026-09-21-state-zonal-manager.sql. Reads work
 * before that migration runs (managers come back NULL); writes answer 503.
 */

function mkErr(status, message) { const e = new Error(message); e.status = status; return e; }

// Cities that count towards a state's figures: active, pending, and legacy
// NULL-status rows (treated as active everywhere — see lib/city-status.js).
// Inactive cities still RECEIVE the manager on save; they just aren't counted.
const COUNTED_CITY = '(c.city_status IS NULL OR c.city_status IN (1, 2))';

/*
 * Same probe-once shape as hasCityCreatorCol() in services/city.service.js.
 * A METADATA probe: absence is zero rows, so an error is a real fault and is
 * NOT cached (tests/schema-probe-failure-not-cached.test.js).
 */
const _stateColProbe = new Map();
async function hasStateColumn(column) {
  if (_stateColProbe.has(column)) return _stateColProbe.get(column);
  try {
    const [r] = await pool.query('SHOW COLUMNS FROM tbl_state LIKE ?', [column]);
    _stateColProbe.set(column, r.length > 0);
  } catch {
    return false;
  }
  return _stateColProbe.get(column);
}
// state_user / state_status / updated_* — migrations/2026-09-21-state-zonal-manager.sql
const hasStateManagerCols = () => hasStateColumn('state_user');
// state_type — also migrations/2026-09-21-state-zonal-manager.sql, probed on its own.
const hasStateTypeCol = () => hasStateColumn('state_type');

// Official classification (Constitution, First Schedule): 28 States, 8 UTs.
const STATE_TYPES = Object.freeze(['State', 'UT']);

// ─── Resolve a state from a NAME ─────────────────────────────────────
/*
 * Old and informal spellings → the official name (lower-case). Geocoding,
 * client integrations, bulk uploads and typed addresses all send names, and
 * several of these once existed as separate tbl_state rows (cleaned up by hand
 * on 2026-09-22, the old rows marked inactive). Without this map an "Orissa"
 * arriving tomorrow would create a new state instead of meaning Odisha.
 */
const STATE_NAME_ALIASES = Object.freeze({
  'orissa': 'odisha',
  'orisa': 'odisha',
  'uttaranchal': 'uttarakhand',
  'pondicherry': 'puducherry',
  'new delhi': 'delhi',
  'nct of delhi': 'delhi',
  'national capital territory of delhi': 'delhi',
  'chattisgarh': 'chhattisgarh',
  'chhatisgarh': 'chhattisgarh',
  'andaman and nicobar': 'andaman and nicobar islands',
  'lakshadweep islands': 'lakshadweep',
  'dadra and nagar haveli': 'dadra and nagar haveli and daman and diu',
  'dadar and nagar haveli': 'dadra and nagar haveli and daman and diu',
  'daman and diu': 'dadra and nagar haveli and daman and diu',
  'telengana': 'telangana',
  'tamilnadu': 'tamil nadu',
});

function normaliseStateName(raw) {
  return String(raw || '').toLowerCase().replace(/&/g, ' and ').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
}

/*
 * The state a name means, or null. Candidates: the name exactly as stored
 * (lower-cased, trimmed — so a stored "Jammu & Kashmir" is found), the same
 * after normalising '&' / punctuation / spacing, and the official spelling from
 * STATE_NAME_ALIASES ("Orissa" → Odisha). An ACTIVE row always wins over an
 * inactive one — an old spelling kept on an inactive row ("Orisa") resolves to
 * the active official row — then the most exact match. Never creates anything:
 * callers that may create (pincode.service findOrCreateStateByName) do so only
 * when this returns null.
 */
async function resolveStateByName(rawName, db = pool) {
  const raw = String(rawName || '').trim().toLowerCase();
  const given = normaliseStateName(rawName);
  if (!given) return null;
  const official = STATE_NAME_ALIASES[given] || given;
  const status = await hasStateManagerCols(); // state_status ships with state_user
  const [rows] = await db.query(
    `SELECT state_id, state_name
       FROM tbl_state WHERE LOWER(TRIM(state_name)) IN (?, ?, ?)
      ORDER BY ${status ? '(state_status = 1) DESC, ' : ''}(LOWER(TRIM(state_name)) = ?) DESC, (LOWER(TRIM(state_name)) = ?) DESC, state_id ASC
      LIMIT 1`,
    [raw, given, official, raw, given]
  );
  const row = rows[0];
  return row ? { state_id: Number(row.state_id), state_name: row.state_name } : null;
}

/*
 * Every spelling a bulk upload may use for a state, each mapped to the ACTIVE
 * state it means: the active states' own names plus STATE_NAME_ALIASES
 * ("Orissa" → Odisha). Returns [{ name, state_id, state_name }] with state_name
 * always the row's real name, so a caller can key it however it likes and list
 * distinct state_names for a template dropdown. Inactive states are never
 * offered. Before the migration every row counts as active.
 */
async function stateNameVariants(db = pool) {
  const status = await hasStateManagerCols();
  // Before the migration this is exactly the query the bulk uploads always
  // ran, so their behaviour there is unchanged.
  const [rows] = await db.query(
    `SELECT state_id, state_name${status ? ', state_status' : ''} FROM tbl_state`
  );
  const active = rows.filter((r) => !status || Number(r.state_status) === 1);
  const out = active.map((r) => ({ name: r.state_name, state_id: Number(r.state_id), state_name: r.state_name }));
  const byNorm = new Map(active.map((r) => [normaliseStateName(r.state_name), r]));
  for (const [alias, official] of Object.entries(STATE_NAME_ALIASES)) {
    // An active row that actually carries this spelling keeps it — e.g. a
    // "Lakshadweep Islands" row is not rerouted by the alias.
    if (byNorm.has(alias)) continue;
    const t = byNorm.get(official);
    if (t) out.push({ name: alias, state_id: Number(t.state_id), state_name: t.state_name });
  }
  return out;
}

/*
 * Refuse INACTIVE state ids (state_status = 0) on a write. Pickers no longer
 * offer them, so this catches stale browser tabs, saved payloads and hand-made
 * requests that would otherwise attach data to a state no picker or report
 * offers. Unknown ids are deliberately left to each caller's own existence check.
 */
async function assertActiveStates(stateIds, db = pool) {
  const ids = [...new Set((stateIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length || !(await hasStateManagerCols())) return;
  const [rows] = await db.query(
    'SELECT state_id, state_name FROM tbl_state WHERE state_id IN (?) AND state_status = 0', [ids]
  );
  if (rows.length) throw mkErr(422, 'Inactive state(s): ' + rows.map((r) => r.state_name).join(', '));
}

async function requireManagerCols() {
  if (!(await hasStateManagerCols())) {
    throw mkErr(503, 'State zonal manager is not set up on this database yet — run migrations/2026-09-21-state-zonal-manager.sql');
  }
}

/*
 * The state's zonal manager, or null. The single place city creation, city
 * state-change, approval and automatic city creation get a new city's manager
 * from. `db` lets a caller inside a transaction read through its connection.
 */
async function stateManagerFor(stateId, db = pool) {
  if (!stateId || !(await hasStateManagerCols())) return null;
  const [[row]] = await db.query('SELECT state_user FROM tbl_state WHERE state_id = ? LIMIT 1', [Number(stateId)]);
  return row && row.state_user != null ? Number(row.state_user) : null;
}

/*
 * A zonal manager must be an ACTIVE INTERNAL user — tbl_user.user_status = 1
 * and an admin-group role. The group check keeps out the ~4,700 legacy role-19
 * "Technician" ghost rows in tbl_user and client-dashboard logins, which the
 * picker never offers but a hand-crafted request could.
 */
async function assertAssignableManager(db, userId) {
  const [[u]] = await db.query(
    'SELECT user_id, user_name, user_status, user_role FROM tbl_user WHERE user_id = ? LIMIT 1', [Number(userId)]
  );
  if (!u) throw mkErr(400, `Unknown user ${userId}`);
  if (Number(u.user_status) !== 1) throw mkErr(400, `${u.user_name} is not an active user — pick someone still in the organisation`);
  if (ROLE_ID_TO_GROUP[Number(u.user_role)] !== 'admin') throw mkErr(400, `${u.user_name} is not an internal user`);
  return u;
}

// ─── Read ────────────────────────────────────────────────────────────
/*
 * Every state in one response. The master is ~36 rows (PAN India) and the
 * States tab filters, selects and counts across all of them client-side —
 * a selection has to survive switching the manager filter — so paging it would
 * only get in the way. LIMIT is a runaway guard, not pagination.
 */
async function listStates({ includeInactive = false } = {}) {
  const has = await hasStateManagerCols();
  logger.info('List states · includeInactive=' + includeInactive + ' managerCols=' + has);

  const managerSelect = has
    ? `s.state_status, s.state_user, s.updated_by, s.updated_on,
       mu.user_name  AS manager_name,
       mr.role_name  AS manager_role,
       mu.user_status AS manager_status,
       ub.user_name  AS updated_by_name,
       (SELECT COUNT(*) FROM tbl_city c
         WHERE c.state_id = s.state_id AND ${COUNTED_CITY} AND c.state_user = s.state_user) AS synced_count`
    : `1 AS state_status, NULL AS state_user, NULL AS updated_by, NULL AS updated_on,
       NULL AS manager_name, NULL AS manager_role, NULL AS manager_status,
       NULL AS updated_by_name, 0 AS synced_count`;
  const managerJoin = has
    ? `LEFT JOIN tbl_user mu ON mu.user_id = s.state_user
       LEFT JOIN tbl_role mr ON mr.role_id = mu.user_role
       LEFT JOIN tbl_user ub ON ub.user_id = s.updated_by`
    : '';
  const where = has && !includeInactive ? 'WHERE s.state_status = 1' : '';
  const typeSelect = (await hasStateTypeCol()) ? 's.state_type' : 'NULL AS state_type';

  const [rows] = await pool.query(
    `SELECT s.state_id, s.state_name, s.state_code, s.country_id, ${typeSelect},
            ${managerSelect},
            (SELECT COUNT(*) FROM tbl_city c
              WHERE c.state_id = s.state_id AND ${COUNTED_CITY}) AS city_count
       FROM tbl_state s
       ${managerJoin}
      ${where}
      ORDER BY s.state_name ASC
      LIMIT 500`
  );
  logger.info('Returning ' + rows.length + ' states');
  return { items: rows, total: rows.length, manager_columns: has };
}

async function getStateById(stateId) {
  const { items } = await listStates({ includeInactive: true });
  return items.find((s) => Number(s.state_id) === Number(stateId)) || null;
}

// ─── Name / code uniqueness ──────────────────────────────────────────
// A code only has to be unique among ACTIVE states (an inactive old row may
// share one); a name must be unique across all rows — see below.
async function assertUniqueNameAndCode(db, { name, code, exceptId = null }) {
  const liveOnly = (await hasStateManagerCols()) ? ' AND state_status = 1' : '';
  if (name !== undefined) {
    // Every row blocks a name, inactive ones too: a second "Orisa" created
    // live would compete with the old row in every name lookup.
    const [[dup]] = await db.query(
      'SELECT state_id FROM tbl_state WHERE LOWER(TRIM(state_name)) = LOWER(?) AND state_id <> ? LIMIT 1',
      [name, exceptId || 0]
    );
    if (dup) throw mkErr(409, `A state named "${name}" already exists`);
    // An old spelling of an existing state ("Orissa") is that state, not a new one.
    const hit = await resolveStateByName(name, db);
    if (hit && hit.state_id !== Number(exceptId || 0)) {
      throw mkErr(409, `"${name}" is another name for ${hit.state_name}`);
    }
  }
  if (code) {
    const [[dup]] = await db.query(
      `SELECT state_id, state_name FROM tbl_state WHERE UPPER(TRIM(state_code)) = ? AND state_id <> ?${liveOnly} LIMIT 1`,
      [code, exceptId || 0]
    );
    if (dup) throw mkErr(409, `State code ${code} is already used by ${dup.state_name}`);
  }
}

const cleanCode = (v) => (v == null ? null : String(v).trim().toUpperCase() || null);

// Validated against STATE_TYPES by the route; refused outright before the
// migration adds the column, rather than silently dropped.
async function assertStateTypeWritable(stateType) {
  if (stateType === undefined) return;
  if (!STATE_TYPES.includes(stateType)) throw mkErr(400, 'state_type must be State or UT');
  if (!(await hasStateTypeCol())) {
    throw mkErr(503, 'State / UT type is not set up on this database yet — run migrations/2026-09-21-state-zonal-manager.sql');
  }
}

// ─── Create ──────────────────────────────────────────────────────────
async function createState({ state_name, state_code, state_user, state_type }, actorId) {
  await requireManagerCols();
  const name = String(state_name || '').trim();
  const code = cleanCode(state_code);
  logger.info('Create state · name=' + name + ' code=' + (code || '-') + ' manager=' + state_user + ' by=' + (actorId || '-'));
  if (!name) throw mkErr(400, 'state_name is required');

  await assertUniqueNameAndCode(pool, { name, code });
  await assertAssignableManager(pool, state_user);
  await assertStateTypeWritable(state_type);

  // Lazy: pincode.service requires this module, so a top-level require here
  // would be a cycle. indiaCountryId is the same resolver its auto-created
  // states use — EasyFix operates only in India.
  const countryId = await require('./pincode.service').indiaCountryId();
  if (countryId == null) throw mkErr(400, 'No country configured in tbl_country');

  const cols = ['state_name', 'state_code', 'country_id', 'state_user', 'state_status', 'updated_by', 'updated_on'];
  const vals = [name, code, countryId, Number(state_user), 1, actorId || null, new Date()];
  if (state_type !== undefined) { cols.push('state_type'); vals.push(state_type); }
  const [r] = await pool.query(
    `INSERT INTO tbl_state (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, vals
  );
  logger.info('State created · id=' + r.insertId);
  return getStateById(r.insertId);
}

// ─── Update (name / code / manager of ONE state) ─────────────────────
/*
 * `state_user` present in the body means "this state's manager is now X" and
 * is pushed to every city of the state in the same transaction. Absent means a
 * rename only — cities are not touched, so renaming a state never silently
 * re-syncs its cities.
 */
async function updateState(stateId, fields, actorId) {
  await requireManagerCols();
  logger.info('Update state · id=' + stateId + ' fields=[' + Object.keys(fields || {}).join(',') + '] by=' + (actorId || '-'));
  const sets = [];
  const params = [];
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [[cur]] = await conn.query('SELECT state_id, state_name, state_status FROM tbl_state WHERE state_id = ? FOR UPDATE', [stateId]);
    if (!cur) throw mkErr(404, 'State not found');

    const name = fields.state_name !== undefined ? String(fields.state_name).trim() : undefined;
    const code = fields.state_code !== undefined ? cleanCode(fields.state_code) : undefined;
    if (name !== undefined && !name) throw mkErr(400, 'state_name cannot be blank');
    await assertUniqueNameAndCode(conn, { name, code, exceptId: stateId });
    if (name !== undefined) { sets.push('state_name = ?'); params.push(name); }
    if (code !== undefined) { sets.push('state_code = ?'); params.push(code); }
    if (fields.state_type !== undefined) {
      await assertStateTypeWritable(fields.state_type);
      sets.push('state_type = ?'); params.push(fields.state_type);
    }

    const managerChanging = fields.state_user !== undefined;
    if (managerChanging) {
      if (Number(cur.state_status) !== 1) throw mkErr(422, `${cur.state_name} is inactive — managers are assigned to active states only`);
      await assertAssignableManager(conn, fields.state_user);
      sets.push('state_user = ?'); params.push(Number(fields.state_user));
    }
    if (!sets.length) throw mkErr(400, 'No mutable fields supplied');

    sets.push('updated_by = ?', 'updated_on = ?'); params.push(actorId || null, new Date());
    params.push(stateId);
    await conn.query(`UPDATE tbl_state SET ${sets.join(', ')} WHERE state_id = ?`, params);

    let citiesUpdated = 0;
    if (managerChanging) {
      const [r] = await conn.query('UPDATE tbl_city SET state_user = ? WHERE state_id = ?', [Number(fields.state_user), stateId]);
      citiesUpdated = r.affectedRows;
    }
    await conn.commit();
    logger.info('State updated · id=' + stateId + ' cities_updated=' + citiesUpdated);
    return { state: await getStateById(stateId), cities_updated: citiesUpdated };
  } catch (e) {
    try { if (conn) await conn.rollback(); } catch { /* connection already gone */ }
    if (!e || !e.status) logger.error('Update state failed · id=' + stateId + ' · ' + ((e && e.message) || e));
    throw e;
  } finally {
    if (conn) conn.release();
  }
}

// ─── Assign one manager to MANY states ───────────────────────────────
/*
 * The "a manager left, move their states" action, and the "tick Assam and
 * Uttar Pradesh, give both to Sneha" action. All states and all their cities
 * in ONE transaction: a half-applied reassignment would leave a manager
 * holding part of a region with no record of which part.
 */
async function assignManager(stateIds, managerId, actorId) {
  await requireManagerCols();
  const ids = [...new Set(stateIds.map(Number))];
  logger.info('Assign manager · manager=' + managerId + ' states=[' + ids.join(',') + '] by=' + (actorId || '-'));
  const marks = ids.map(() => '?').join(',');
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [found] = await conn.query(
      `SELECT state_id, state_name, state_status FROM tbl_state WHERE state_id IN (${marks}) FOR UPDATE`, ids
    );
    if (found.length !== ids.length) {
      const have = new Set(found.map((r) => Number(r.state_id)));
      throw mkErr(400, 'Unknown state_id(s): ' + ids.filter((i) => !have.has(i)).join(', '));
    }
    // Managers are assigned to ACTIVE states only (decided 2026-09-22).
    const inactive = found.filter((r) => Number(r.state_status) !== 1);
    if (inactive.length) throw mkErr(422, 'Inactive state(s): ' + inactive.map((r) => r.state_name).join(', '));
    const mgr = await assertAssignableManager(conn, managerId);

    await conn.query(
      `UPDATE tbl_state SET state_user = ?, updated_by = ?, updated_on = ? WHERE state_id IN (${marks})`,
      [Number(managerId), actorId || null, new Date(), ...ids]
    );
    const [r] = await conn.query(`UPDATE tbl_city SET state_user = ? WHERE state_id IN (${marks})`, [Number(managerId), ...ids]);

    await conn.commit();
    logger.info('Manager assigned · manager=' + managerId + ' states=' + ids.length + ' cities_updated=' + r.affectedRows);
    return { manager_id: Number(managerId), manager_name: mgr.user_name, states_updated: ids.length, cities_updated: r.affectedRows };
  } catch (e) {
    try { if (conn) await conn.rollback(); } catch { /* connection already gone */ }
    if (!e || !e.status) logger.error('Assign manager failed · ' + ((e && e.message) || e));
    throw e;
  } finally {
    if (conn) conn.release();
  }
}

// ─── Re-sync a state's cities to its manager ─────────────────────────
/*
 * For cities that drifted: split managers before the backfill, or a city added
 * or edited from outside this backend (the legacy Java CRM writes the same
 * table without these rules). Touches only the cities that differ, so
 * affectedRows is the number that were actually wrong. Does not stamp the
 * state's updated_by — the state itself did not change.
 */
async function resyncState(stateId, actorId) {
  await requireManagerCols();
  logger.info('Re-sync state · id=' + stateId + ' by=' + (actorId || '-'));
  const [[s]] = await pool.query('SELECT state_id, state_name, state_user, state_status FROM tbl_state WHERE state_id = ? LIMIT 1', [stateId]);
  if (!s) throw mkErr(404, 'State not found');
  if (Number(s.state_status) !== 1) throw mkErr(422, `${s.state_name} is inactive — re-sync applies to active states only`);
  if (s.state_user == null) throw mkErr(409, 'This state has no zonal manager yet — assign one first');
  const [r] = await pool.query(
    'UPDATE tbl_city SET state_user = ? WHERE state_id = ? AND NOT (state_user <=> ?)',
    [Number(s.state_user), stateId, Number(s.state_user)]
  );
  logger.info('State re-synced · id=' + stateId + ' cities_updated=' + r.affectedRows);
  return { state_id: Number(stateId), cities_updated: r.affectedRows };
}

module.exports = {
  listStates,
  getStateById,
  createState,
  updateState,
  assignManager,
  resyncState,
  stateManagerFor,
  hasStateManagerCols,
  hasStateTypeCol,
  resolveStateByName,
  stateNameVariants,
  assertActiveStates,
  normaliseStateName,
  STATE_NAME_ALIASES,
  STATE_TYPES,
};
