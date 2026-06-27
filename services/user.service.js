const { pool } = require('../db');
const logger = require('../logger');
const roleService = require('./role.service');

/*
 * Manage Users — internal-staff CRUD on tbl_user.
 *
 * Mirrors the cities service in shape (list/get/create/update/deactivate +
 * sortable-column whitelist + mkErr helper). The big behavioural rule:
 *
 *   Internal-user gate (user_type_id = 5)
 *   ─────────────────────────────────────
 *   The CRM only manages user_type_id = 5 — internal staff. The legacy DB
 *   carries other user_type_ids (clients, technicians ghosts, etc.) and the
 *   auth flow in services/auth.service.js already enforces this gate at OTP
 *   issuance. We mirror it here so an Admin can never accidentally create or
 *   list a row that wouldn't actually be loginable.
 *
 * Soft-delete only — tbl_user is referenced by tbl_job.fk_created_by,
 * tbl_job.fk_scheduled_by, audit columns across the schema, and historical
 * tbl_easyfixer assignments. Hard-delete would break joins on five legacy
 * services. Deactivating sets user_status = 0; reactivation flips it back.
 *
 * NO PASSWORD COLUMN — confirmed in CLAUDE.md and the auth service. Auth is
 * OTP-only (email or mobile → 4-digit OTP). This service therefore takes
 * no password input on create/update; that surface doesn't exist.
 */

const INTERNAL_USER_TYPE_ID = 5;
const STATUS_ACTIVE = 1;

function mkErr(status, message) { const e = new Error(message); e.status = status; return e; }

/*
 * Sortable-column whitelist. Same SQL-injection guardrail as cities — only
 * keys in this map can land in ORDER BY. Computed/joined columns (role_name,
 * city_name) work because MySQL resolves SELECT aliases inside ORDER BY.
 */
const SORTABLE_COLUMNS = Object.freeze({
  user_id:        'u.user_id',
  user_name:      'u.user_name',
  official_email: 'u.official_email',
  mobile_no:      'u.mobile_no',
  role_name:      'r.role_name',
  city_name:      'c.city_name',
  user_status:    'u.user_status',
  insert_date:    'u.insert_date',
});

const MUTABLE_COLUMNS = Object.freeze([
  // user_name / official_email NOT included — legacy CRM treats them as
  // read-only post-create (addEditUser.vm has them as RO fields). They feed
  // OTP delivery; changing them mid-flight can lock a user out of their
  // own account. If renaming becomes a real ops need, add a dedicated
  // "transfer ownership" flow rather than a plain UPDATE.
  'mobile_no', 'alternate_no', 'user_role', 'city_id',
  // Scope CSVs — drive row-level RBAC. Each accepts the legacy
  // wildcard "0" meaning "all". See lib/scope.js for the parser.
  'manage_clients', 'manage_cities', 'manage_states', 'manage_verticals',
  // Reporting manager — single user_id. Drives hierarchy DFS for
  // scope-union (see findDescendantUserIds + buildHierarchyTree).
  'reporting_manager',
]);

// ─── List ────────────────────────────────────────────────────────────
async function listUsers({
  q, roleId, cityId, includeInactive = false,
  limit = 200, offset = 0,
  sortBy = 'user_name', sortDir = 'asc',
} = {}) {
  limit  = Math.min(Math.max(Number(limit)  || 200, 1), 1000);
  offset = Math.max(Number(offset) || 0, 0);

  logger.info('List users · q=' + (q || '') + ' · roleId=' + (roleId || '') + ' · cityId=' + (cityId || '') + ' · includeInactive=' + includeInactive + ' · limit=' + limit + ' · offset=' + offset);

  const sortExpr = SORTABLE_COLUMNS[sortBy] || SORTABLE_COLUMNS.user_name;
  const dir      = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  // Stable secondary sort on user_id — guarantees deterministic pagination
  // when the primary key has duplicates (very common on role_name).
  const orderBy  = `${sortExpr} ${dir}, u.user_id ASC`;

  const where  = [`u.user_type_id = ${INTERNAL_USER_TYPE_ID}`];
  const params = [];
  if (!includeInactive) where.push('u.user_status = 1');
  else where.push('NOT (u.user_status <=> 3)'); // never surface admin-deleted (tombstoned) users — NULL-safe
  if (q) {
    where.push('(u.user_name LIKE ? OR u.official_email LIKE ? OR u.mobile_no LIKE ? OR u.user_code LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (roleId) { where.push('u.user_role = ?'); params.push(Number(roleId)); }
  if (cityId) { where.push('u.city_id = ?');   params.push(Number(cityId)); }

  const [rows] = await pool.query(
    `SELECT
        u.user_id, u.user_code, u.user_name, u.official_email, u.mobile_no,
        u.alternate_no, u.user_role, r.role_name,
        u.city_id, c.city_name,
        u.manage_clients, u.manage_cities, u.manage_states, u.manage_verticals,
        u.reporting_manager,
        u.user_status, u.insert_date, u.update_date
       FROM tbl_user  u
       LEFT JOIN tbl_role r ON r.role_id = u.user_role
       LEFT JOIN tbl_city c ON c.city_id = u.city_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM tbl_user u WHERE ${where.join(' AND ')}`,
    params
  );

  logger.info('Found ' + rows.length + ' users (total=' + total + ')');
  return { items: rows, total };
}

async function getUserById(userId) {
  logger.info('Get user by id · userId=' + userId);
  const [[row]] = await pool.query(
    `SELECT u.user_id, u.user_code, u.user_name, u.official_email, u.mobile_no,
            u.alternate_no, u.user_role, r.role_name,
            u.city_id, c.city_name,
            u.manage_clients, u.manage_cities, u.manage_states, u.manage_verticals,
        u.reporting_manager,
            u.user_status, u.insert_date, u.update_date, u.updated_by
       FROM tbl_user  u
       LEFT JOIN tbl_role r ON r.role_id = u.user_role
       LEFT JOIN tbl_city c ON c.city_id = u.city_id
      WHERE u.user_id = ? AND u.user_type_id = ?
      LIMIT 1`,
    [userId, INTERNAL_USER_TYPE_ID]
  );
  return row || null;
}

// ─── Create ──────────────────────────────────────────────────────────
/*
 * Uniqueness rules — enforced in app code, not in DB. tbl_user has no
 * unique key on email or mobile (legacy has duplicates), so we do a
 * "no active duplicate" pre-check before INSERT. Inactive duplicates are
 * tolerated — they represent ex-staff whose row we soft-deleted but kept
 * for audit FKs. If a new joiner has the same email/mobile as an inactive
 * row, the operator should reactivate that row instead.
 */
async function createUser({
  user_name, official_email, mobile_no, user_role,
  city_id, alternate_no,
  manage_clients, manage_cities, manage_states, manage_verticals,
  reporting_manager,
  createdBy,
}) {
  logger.info('Create user · role=' + (user_role || '') + ' · cityId=' + (city_id || ''));
  const name  = String(user_name || '').trim();
  const email = String(official_email || '').trim().toLowerCase();
  const mob   = String(mobile_no || '').trim();
  if (!name)  throw mkErr(400, 'user_name is required');
  if (!email) throw mkErr(400, 'official_email is required');
  if (!mob)   throw mkErr(400, 'mobile_no is required');
  if (!user_role) throw mkErr(400, 'user_role is required');

  // Validate role exists + is admin-group (we don't manage technicians or
  // client-dashboard users here — those have their own lifecycles).
  const role = await roleService.getRoleById(user_role);
  if (!role)           throw mkErr(400, `Unknown role_id ${user_role}`);
  if (role.group !== 'admin')
    throw mkErr(400, `Role "${role.role_name}" is not an admin role and can't be assigned to a CRM user`);

  const [[dupEmail]] = await pool.query(
    `SELECT user_id FROM tbl_user
      WHERE LOWER(official_email) = ? AND user_status = 1 AND user_type_id = ?
      LIMIT 1`,
    [email, INTERNAL_USER_TYPE_ID]
  );
  if (dupEmail) {
    logger.warn('Create user rejected · duplicate active email');
    throw mkErr(409, `An active user with email "${email}" already exists`);
  }

  const [[dupMob]] = await pool.query(
    `SELECT user_id FROM tbl_user
      WHERE mobile_no = ? AND user_status = 1 AND user_type_id = ?
      LIMIT 1`,
    [mob, INTERNAL_USER_TYPE_ID]
  );
  if (dupMob) {
    logger.warn('Create user rejected · duplicate active mobile');
    throw mkErr(409, `An active user with mobile "${mob}" already exists`);
  }

  const [r] = await pool.query(
    `INSERT INTO tbl_user
       (user_name, official_email, mobile_no, alternate_no,
        user_role, user_type_id, city_id,
        manage_clients, manage_cities, manage_states, manage_verticals,
        reporting_manager,
        user_status, insert_date, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
    [
      name, email, mob, alternate_no || null,
      Number(user_role), INTERNAL_USER_TYPE_ID, city_id ? Number(city_id) : null,
      manage_clients || null, manage_cities || null, manage_states || null, manage_verticals || null,
      reporting_manager ? Number(reporting_manager) : null,
      STATUS_ACTIVE, createdBy || null,
    ]
  );
  // New active user could be a manager's direct report — invalidate so
  // the next hierarchy resolution picks up the new edge instead of
  // serving the pre-insert adjacency map for up to 60s.
  invalidateHierarchyCache();
  logger.info('User created · id=' + r.insertId + ' · role=' + Number(user_role));
  return getUserById(r.insertId);
}

// ─── Update ──────────────────────────────────────────────────────────
/*
 * Per-column value-equality used by updateUser to short-circuit writes
 * when the incoming PATCH would be a no-op against the current row.
 *
 *   - Numeric FKs (user_role, city_id, reporting_manager) compare as
 *     numbers; '' / null collapse to null.
 *   - Scope CSVs (manage_*) compare as canonical sorted-int sets so
 *     "5,10" and "10,5" both match an existing "5,10". The literal
 *     "0" wildcard stays its own value (matches only itself).
 *   - String columns (mobile_no, alternate_no) trim + compare; ''
 *     collapses to null.
 */
function normaliseForCompare(key, val) {
  const csvKeys = new Set(['manage_clients', 'manage_cities', 'manage_states', 'manage_verticals']);
  const numKeys = new Set(['user_role', 'city_id', 'reporting_manager']);
  if (val === undefined || val === null) return null;
  if (csvKeys.has(key)) {
    const s = String(val).trim();
    if (s === '' || s === null) return '';
    if (s === '0') return '0';
    const ids = s.split(',').map((x) => x.trim()).filter(Boolean).map(Number).filter((n) => !Number.isNaN(n));
    return Array.from(new Set(ids)).sort((a, b) => a - b).join(',');
  }
  if (numKeys.has(key)) {
    if (val === '' || val === null) return null;
    const n = Number(val);
    return Number.isNaN(n) ? null : n;
  }
  // string column
  const s = String(val).trim();
  return s === '' ? null : s;
}

async function updateUser(userId, fields, updatedBy, opts = {}) {
  const { dryRun = false } = opts;
  logger.info('Update user · userId=' + userId + ' · dryRun=' + dryRun);

  // Load every column we might compare against. The single round-trip
  // replaces the older mobile-only SELECT and unlocks the "skip-on-no-
  // change" path: if every supplied field already matches the row, we
  // never issue an UPDATE (no update_date bump, no updated_by churn,
  // no idempotent re-application of the same data on re-uploads).
  const [[me]] = await pool.query(
    `SELECT user_id, user_type_id, mobile_no, alternate_no,
            user_role, city_id,
            manage_clients, manage_cities, manage_states, manage_verticals,
            reporting_manager, user_status
       FROM tbl_user WHERE user_id = ? LIMIT 1`,
    [userId]
  );
  if (!me) {
    logger.warn('Update user rejected · not found · userId=' + userId);
    throw mkErr(404, 'User not found');
  }
  if (me.user_type_id !== INTERNAL_USER_TYPE_ID) {
    logger.warn('Update user rejected · not an internal CRM user · userId=' + userId);
    throw mkErr(403, 'This user is not an internal CRM user and can\'t be edited here');
  }

  const sets   = [];
  const params = [];
  let suppliedCount = 0;

  for (const key of MUTABLE_COLUMNS) {
    if (fields[key] === undefined) continue;
    suppliedCount++;

    // Skip the column entirely when the incoming value already matches
    // the persisted value. This is the core of the no-change short-
    // circuit — without it, every re-upload bumps update_date even
    // though no business data changed.
    if (normaliseForCompare(key, fields[key]) === normaliseForCompare(key, me[key])) continue;

    let val = fields[key];
    if (key === 'user_role' && val) {
      const role = await roleService.getRoleById(val);
      if (!role) throw mkErr(400, `Unknown role_id ${val}`);
      if (role.group !== 'admin') {
        throw mkErr(400, `Role "${role.role_name}" is not an admin role`);
      }
      val = Number(val);
    }
    if (key === 'mobile_no' && val) {
      const mob = String(val).trim();
      // Mobile is actually changing here (the equality short-circuit
      // above guarantees that), so the uniqueness probe is meaningful.
      const [[dup]] = await pool.query(
        `SELECT user_id FROM tbl_user
          WHERE mobile_no = ? AND user_status = 1 AND user_type_id = ?
            AND user_id <> ? LIMIT 1`,
        [mob, INTERNAL_USER_TYPE_ID, userId]
      );
      if (dup) {
        logger.warn('Update user rejected · mobile already used by another active user · userId=' + userId);
        throw mkErr(409, `Another active user already uses mobile "${mob}"`);
      }
      val = mob;
    }
    sets.push(`${key} = ?`);
    params.push(val === '' ? null : val);
  }

  if (fields.is_active !== undefined) {
    suppliedCount++;
    const wantActive = fields.is_active ? 1 : 0;
    if (wantActive !== me.user_status) {
      sets.push('user_status = ?');
      params.push(wantActive);
    }
  }

  // Distinguish "operator sent nothing" (real 400) from "operator sent
  // values that all match" (no-op, return unchanged sentinel).
  if (suppliedCount === 0) throw mkErr(400, 'No mutable fields supplied');
  if (!sets.length) {
    logger.info('Update user no-op · userId=' + userId + ' · all supplied values match');
    const row = await getUserById(userId);
    if (row) row.__unchanged = true;
    return row;
  }

  // Dry-run path — diff has happened, we KNOW this would mutate the
  // row, but we don't want to actually write. Returns a sentinel the
  // bulk-upload route uses to report 'valid' (vs 'unchanged') so the
  // operator gets an accurate preview.
  if (dryRun) {
    logger.info('Update user dry-run · userId=' + userId + ' · wouldChange fields=' + sets.length);
    const row = await getUserById(userId);
    if (row) row.__wouldUpdate = true;
    return row;
  }

  sets.push('update_date = NOW()', 'updated_by = ?');
  params.push(updatedBy || null, userId);

  await pool.query(`UPDATE tbl_user SET ${sets.join(', ')} WHERE user_id = ?`, params);
  logger.info('User updated · id=' + userId + ' · fields=' + sets.length);
  // Per-user perms cache invalidation. A user_role change is the obvious
  // trigger; other field edits (name, email, etc.) don't change perms but
  // clearing one entry is cheap so we do it unconditionally.
  roleService.invalidatePermissionsCache(userId);
  // Hierarchy adjacency invalidation. reporting_manager / user_status /
  // user_type_id are all reachable via this update path; rather than
  // sniff which field changed, just clear unconditionally (rebuild ~1 ms).
  invalidateHierarchyCache();
  return getUserById(userId);
}

// ─── Soft-delete (status flag) ──────────────────────────────────────
/**
 * Hierarchy DFS — return every user_id that reports to `rootUserId`
 * directly or transitively via `tbl_user.reporting_manager`.
 *
 * Strategy: load the (manager_id, user_id) adjacency for all internal
 * users once (cheap — single SELECT, ~few thousand rows), build an
 * in-memory map, then DFS from the root. Cycles are guarded by a
 * `visited` set; legacy production data has at least one self-loop.
 *
 * Returns: { descendants: number[], directReports: number[] }
 *   descendants — DFS-flattened all-levels (excluding rootUserId itself)
 *   directReports — only the level-1 children (drives the graph view's
 *                   initial render)
 *
 * Cached briefly: hierarchy mutations are rare (org change ≪ per-request)
 * so we hold a 60s cache to avoid re-scanning on every /auth/me hit.
 */
let _hierarchyCache = { at: 0, byManager: null };

/*
 * Explicit hierarchy-adjacency cache invalidation (added 2026-05-30).
 *
 * Any mutation to tbl_user that could change who appears as a direct
 * report calls this — specifically:
 *   - createUser           — new active row that might list a manager
 *   - updateUser           — reporting_manager / user_status / user_type_id
 *                            could have changed; conservatively clear on
 *                            any field-write
 *   - deactivateUser       — user disappears from the active-only query
 *                            inside _loadHierarchyAdjacency
 *
 * Without this, the cache still self-corrects within 60 seconds (the
 * existing TTL on _loadHierarchyAdjacency), but operators reassigning a
 * reporting manager via Manage Users would see stale "team data" reads
 * for up to that window. Resetting `at=0` forces the next read to
 * refetch from DB regardless of TTL.
 *
 * Cheap by design: this is a single object assignment; the cache rebuild
 * is one indexed query on tbl_user, returning typically <500 rows.
 */
function invalidateHierarchyCache() {
  _hierarchyCache = { at: 0, byManager: null };
}

async function _loadHierarchyAdjacency() {
  if (_hierarchyCache.byManager && Date.now() - _hierarchyCache.at < 60_000) {
    return _hierarchyCache.byManager;
  }
  const [rows] = await pool.query(
    `SELECT user_id, reporting_manager
       FROM tbl_user
      WHERE user_type_id = ?
        AND user_status = 1`,
    [INTERNAL_USER_TYPE_ID]
  );
  const byManager = new Map();
  for (const r of rows) {
    const mgr = Number(r.reporting_manager || 0);
    if (!mgr) continue;
    if (!byManager.has(mgr)) byManager.set(mgr, []);
    byManager.get(mgr).push(Number(r.user_id));
  }
  _hierarchyCache = { at: Date.now(), byManager };
  return byManager;
}

async function findDescendantUserIds(rootUserId) {
  const adj = await _loadHierarchyAdjacency();
  const directReports = adj.get(Number(rootUserId)) || [];
  const descendants = [];
  const visited = new Set([Number(rootUserId)]);
  const stack = [...directReports];
  while (stack.length) {
    const id = stack.pop();
    if (visited.has(id)) continue; // cycle guard
    visited.add(id);
    descendants.push(id);
    const children = adj.get(id) || [];
    for (const c of children) stack.push(c);
  }
  return { descendants, directReports };
}

/**
 * Build a hierarchy tree rooted at `rootUserId` — used by the Users →
 * Hierarchy graph view. Returns the user node + nested children, plus
 * the chain of ancestors so the UI can show "this person reports up to".
 */
async function buildHierarchyTree(rootUserId) {
  logger.info('Build hierarchy tree · rootUserId=' + rootUserId);
  const adj = await _loadHierarchyAdjacency();
  const [[root]] = await pool.query(
    `SELECT u.user_id, u.user_name, u.official_email, u.mobile_no,
            u.user_role, r.role_name, u.reporting_manager
       FROM tbl_user u LEFT JOIN tbl_role r ON r.role_id = u.user_role
      WHERE u.user_id = ? AND u.user_type_id = ?`,
    [rootUserId, INTERNAL_USER_TYPE_ID]
  );
  if (!root) {
    logger.warn('Build hierarchy tree · root user not found · rootUserId=' + rootUserId);
    return null;
  }

  // Collect every user_id we'll need in one query (root + descendants + ancestors).
  const { descendants } = await findDescendantUserIds(rootUserId);
  const ancestors = [];
  let cursor = root.reporting_manager;
  const seen = new Set([Number(rootUserId)]);
  while (cursor && !seen.has(Number(cursor))) {
    seen.add(Number(cursor));
    ancestors.push(Number(cursor));
    const [[mgrRow]] = await pool.query(
      'SELECT reporting_manager FROM tbl_user WHERE user_id = ? LIMIT 1',
      [cursor]
    );
    cursor = mgrRow ? mgrRow.reporting_manager : null;
  }

  const allIds = [Number(rootUserId), ...descendants, ...ancestors];
  if (allIds.length === 0) return root;
  const placeholders = allIds.map(() => '?').join(',');
  const [allUsers] = await pool.query(
    `SELECT u.user_id, u.user_name, u.official_email, u.mobile_no,
            u.user_role, r.role_name, u.reporting_manager
       FROM tbl_user u LEFT JOIN tbl_role r ON r.role_id = u.user_role
      WHERE u.user_id IN (${placeholders})`,
    allIds
  );
  const byId = new Map(allUsers.map((u) => [u.user_id, { ...u, children: [] }]));

  // Build nested children tree
  function attach(uid) {
    const node = byId.get(uid);
    if (!node) return null;
    const childIds = adj.get(uid) || [];
    node.children = childIds.map(attach).filter(Boolean);
    return node;
  }
  const tree = attach(Number(rootUserId));
  const ancestorChain = ancestors.map((id) => byId.get(id)).filter(Boolean);
  logger.info('Hierarchy tree built · rootUserId=' + rootUserId + ' · descendants=' + descendants.length + ' · ancestors=' + ancestorChain.length);
  return { tree, ancestors: ancestorChain };
}

/*
 * Real-time mobile-uniqueness probe — drives the Add/Edit User form's
 * inline validation so the operator finds out BEFORE clicking Save that
 * a number is already taken. Cheap (mobile_no has an index in production
 * and the table is ~hundreds of rows of internal staff), so a debounced
 * call per keystroke is acceptable. We mirror the same active-internal
 * gate used on create/update — historical inactive duplicates don't count.
 */
async function isMobileTakenByAnother(mobile, excludeUserId) {
  logger.info('Check mobile availability · excludeUserId=' + (excludeUserId || ''));
  const mob = String(mobile || '').trim();
  if (!/^[0-9]{10}$/.test(mob)) return { available: false, reason: 'invalid' };
  const params = [mob, INTERNAL_USER_TYPE_ID];
  let sql = `SELECT user_id, user_name FROM tbl_user
              WHERE mobile_no = ? AND user_status = 1 AND user_type_id = ?`;
  if (excludeUserId) { sql += ' AND user_id <> ?'; params.push(Number(excludeUserId)); }
  sql += ' LIMIT 1';
  const [[row]] = await pool.query(sql, params);
  if (!row) return { available: true };
  logger.info('Mobile already taken · takenByUserId=' + row.user_id);
  return { available: false, takenBy: { user_id: row.user_id, user_name: row.user_name } };
}

/*
 * Real-time email-uniqueness probe — drives the Add User form's inline
 * validation so the operator finds out BEFORE clicking Save that the
 * address is already taken. When `name` is supplied we also generate a
 * suggestion in the legacy convention `<first>.<last>[<n>]@easyfix.in`,
 * bumping the numeric suffix until a free slot is found (looked up in a
 * single `WHERE official_email IN (...)` query to avoid an N+1 loop).
 */
async function isEmailTakenByAnother(email, excludeUserId, name) {
  logger.info('Check email availability · excludeUserId=' + (excludeUserId || ''));
  const e = String(email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(e)) return { available: false, reason: 'invalid' };
  const params = [e, INTERNAL_USER_TYPE_ID];
  let sql = `SELECT user_id, user_name FROM tbl_user
              WHERE LOWER(official_email) = ? AND user_status = 1 AND user_type_id = ?`;
  if (excludeUserId) { sql += ' AND user_id <> ?'; params.push(Number(excludeUserId)); }
  sql += ' LIMIT 1';
  const [[row]] = await pool.query(sql, params);
  const taken = !!row;

  let suggestion = null;
  if (taken && name && String(name).trim()) {
    suggestion = await suggestAvailableEmail(name, excludeUserId);
  }

  if (!taken) return { available: true };
  logger.info('Email already taken · takenByUserId=' + row.user_id + ' · hasSuggestion=' + !!suggestion);
  return {
    available: false,
    takenBy: { user_id: row.user_id, user_name: row.user_name },
    ...(suggestion ? { suggestion } : {}),
  };
}

/*
 * Build a deterministic `<first>.<last>[<n>]@easyfix.in` candidate and
 * return the first unused variant. Strategy:
 *   1. Tokenise name → [first, last]. Single-token name uses just that
 *      token. 3+ tokens use first + last (skip middles).
 *   2. Sanitise each token (lowercase, strip non a-z0-9).
 *   3. Generate candidates: base, base1, base2, ... base50.
 *   4. SELECT all taken emails in that set in one query, pick the first
 *      candidate not in the result.
 */
async function suggestAvailableEmail(name, excludeUserId) {
  logger.info('Suggest available email · excludeUserId=' + (excludeUserId || ''));
  const sanitise = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const toks = String(name).trim().split(/\s+/).filter(Boolean).map(sanitise).filter(Boolean);
  if (toks.length === 0) return null;
  const base = toks.length === 1
    ? toks[0]
    : `${toks[0]}.${toks[toks.length - 1]}`;
  const candidates = [`${base}@easyfix.in`];
  for (let i = 1; i <= 50; i++) candidates.push(`${base}${i}@easyfix.in`);

  const placeholders = candidates.map(() => '?').join(',');
  const params = [...candidates, INTERNAL_USER_TYPE_ID];
  let sql = `SELECT LOWER(official_email) AS email FROM tbl_user
              WHERE LOWER(official_email) IN (${placeholders})
                AND user_status = 1 AND user_type_id = ?`;
  if (excludeUserId) { sql += ' AND user_id <> ?'; params.push(Number(excludeUserId)); }
  const [rows] = await pool.query(sql, params);
  const taken = new Set(rows.map((r) => r.email));
  return candidates.find((c) => !taken.has(c)) || null;
}

async function deactivateUser(userId, updatedBy) {
  logger.info('Deactivate user · userId=' + userId);
  const [r] = await pool.query(
    `UPDATE tbl_user
        SET user_status = 0, update_date = NOW(), updated_by = ?
      WHERE user_id = ? AND user_type_id = ?`,
    [updatedBy || null, userId, INTERNAL_USER_TYPE_ID]
  );
  logger.info('User deactivated · userId=' + userId + ' · affected=' + r.affectedRows);
  if (r.affectedRows) {
    // Deactivated user's perms cache entry would still serve stale data
    // until TTL; drop it now so a re-activation or any racing request
    // immediately re-resolves against the live row.
    roleService.invalidatePermissionsCache(userId);
    // Hierarchy view: _loadHierarchyAdjacency queries WHERE user_status=1,
    // so this user just disappeared from every manager's downstream list.
    // Clear so the next read reflects the change.
    invalidateHierarchyCache();
  }
  return r.affectedRows > 0;
}

module.exports = {
  listUsers,
  getUserById,
  createUser,
  updateUser,
  deactivateUser,
  isMobileTakenByAnother,
  isEmailTakenByAnother,
  suggestAvailableEmail,
  findDescendantUserIds,
  buildHierarchyTree,
  // Hierarchy adjacency cache invalidation hook — call from any external
  // write path that mutates tbl_user beyond the create/update/deactivate
  // entrypoints here (e.g. a future bulk-import path that writes
  // reporting_manager directly via pool.query without going through
  // updateUser). Internal write paths already self-invalidate.
  invalidateHierarchyCache,
  SORTABLE_COLUMNS,
  INTERNAL_USER_TYPE_ID,
};
