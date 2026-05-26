/*
 * Client Vertical Mapping — per-client (vertical × user) assignments.
 *
 * Backed by `tbl_vertical_mapping(client_id, vertical_id, user_id, [user_type])`.
 *
 * Legacy semantics:
 *   - Each row says "user U is assigned to client C under vertical V".
 *   - The legacy Java model exposed two roles per vertical:
 *       user_type = 1 → Head
 *       user_type = 2 → Project Manager
 *     But not every legacy DB has the `user_type` column — some only
 *     track membership without role distinction. We runtime-probe and
 *     adapt: include user_type if present, fall back to plain
 *     (client, vertical, user) triples otherwise.
 *
 *   - One client can have multiple users under the same vertical (one
 *     Head + one PM, or just members). The (client_id, vertical_id,
 *     user_id) triple is treated as the natural key.
 *
 * Why this lives in a separate service vs. client.service.js:
 *   The mapping touches THREE tables (tbl_vertical_mapping +
 *   tbl_vertical for names + tbl_user for names) and uses a
 *   replace-set TX pattern. Folding it into client.service.js would
 *   muddy that file's single-table focus.
 *
 * Public API:
 *   - listForClient(clientId)         → joined assignments
 *   - replaceForClient(clientId, [...]) → TX delete-all + insert-all
 *   - hasUserTypeColumn()              → cached column probe
 */

const { pool } = require('../db');
const logger = require('../logger');

/* ─── Column-presence probe (cached) ──────────────────────────────── */

let _hasUserTypeColPromise = null;
async function hasUserTypeColumn() {
  if (!_hasUserTypeColPromise) {
    _hasUserTypeColPromise = (async () => {
      try {
        const [rows] = await pool.query(
          "SHOW COLUMNS FROM tbl_vertical_mapping LIKE 'user_type'",
        );
        const present = rows.length > 0;
        logger.info({ present }, '[client-verticals] tbl_vertical_mapping.user_type probe');
        return present;
      } catch (e) {
        logger.warn({ err: e?.message }, '[client-verticals] user_type probe failed — assuming column absent');
        return false;
      }
    })();
  }
  return _hasUserTypeColPromise;
}

/* ─── Reads ───────────────────────────────────────────────────────── */

/*
 * List the current vertical assignments for a client, joined to
 * `tbl_vertical` and `tbl_user` for display names.
 *
 * Returns an array of:
 *   {
 *     vertical_id: number,
 *     vertical_name: string,
 *     user_id: number,
 *     user_name: string,
 *     user_email: string | null,
 *     user_type: number | null,   // 1=Head, 2=PM, null when col absent
 *     user_type_label: 'Head' | 'PM' | 'Member',
 *   }
 *
 * Empty array on no assignments. Tolerant of missing user_type column
 * — falls back to `user_type: null, user_type_label: 'Member'`.
 */
async function listForClient(clientId) {
  const hasUT = await hasUserTypeColumn();
  // Column lists differ by schema variant — kept explicit so the
  // shape on the wire is stable.
  const utSelect = hasUT ? 'vm.user_type' : 'NULL AS user_type';
  // Column-name landmine: tbl_user uses **single `user_name`** field
  // (not first_name + last_name) and **`official_email`** (not
  // user_email). Verified against legacy UserDaoImpl.java#128-131.
  const [rows] = await pool.query(
    `SELECT vm.vertical_id, vm.user_id, ${utSelect},
            v.vertical_name,
            u.user_name, u.official_email
       FROM tbl_vertical_mapping vm
       LEFT JOIN tbl_vertical v ON v.vertical_id = vm.vertical_id
       LEFT JOIN tbl_user u     ON u.user_id     = vm.user_id
      WHERE vm.client_id = ?
      ORDER BY v.vertical_name ASC, vm.user_id ASC`,
    [clientId],
  );
  return rows.map((r) => {
    const ut = r.user_type;
    return {
      vertical_id: r.vertical_id,
      vertical_name: r.vertical_name,
      user_id: r.user_id,
      user_name: r.user_name ?? null,
      user_email: r.official_email ?? null,
      user_type: ut,
      user_type_label: ut === 1 ? 'Head' : ut === 2 ? 'PM' : 'Member',
    };
  });
}

/* ─── Replace-set (TX) ────────────────────────────────────────────── */

/*
 * replaceForClient(clientId, assignments)
 *
 * Replace-all semantics:
 *   1. Validate each assignment shape
 *   2. BEGIN
 *   3. DELETE all rows for client
 *   4. INSERT each assignment
 *   5. COMMIT
 *
 * `assignments` is `[{ verticalId, userId, userType? }]`. `userType`
 * is silently dropped if the column doesn't exist on this DB.
 *
 * Throws (4xx with .status) for invalid input. Caller surfaces via
 * modernError.
 *
 * Why replace-set vs. row-level upsert: the legacy UI saves the whole
 * assignment grid at once ("save all changes"). Replace-set matches
 * that UX and avoids the diff-and-merge complexity of row-by-row
 * upserts. The list is bounded (max ~50 rows per client realistically),
 * so the TX is cheap.
 */
async function replaceForClient(clientId, assignments) {
  if (!Array.isArray(assignments)) {
    throw Object.assign(new Error('assignments must be an array'), { status: 400 });
  }
  // Dedupe (clientId, verticalId, userId) up front — defensive against
  // a buggy FE submitting the same row twice.
  const seen = new Set();
  const cleaned = [];
  for (const a of assignments) {
    const vid = Number(a?.verticalId);
    const uid = Number(a?.userId);
    if (!Number.isInteger(vid) || vid <= 0) {
      throw Object.assign(new Error('verticalId must be a positive integer'), { status: 400 });
    }
    if (!Number.isInteger(uid) || uid <= 0) {
      throw Object.assign(new Error('userId must be a positive integer'), { status: 400 });
    }
    const key = `${vid}:${uid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push({
      verticalId: vid,
      userId: uid,
      userType: a.userType != null ? Number(a.userType) : null,
    });
  }
  const hasUT = await hasUserTypeColumn();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM tbl_vertical_mapping WHERE client_id = ?', [clientId]);
    if (cleaned.length > 0) {
      if (hasUT) {
        const values = cleaned.map((a) => [clientId, a.verticalId, a.userId, a.userType]);
        await conn.query(
          'INSERT INTO tbl_vertical_mapping (client_id, vertical_id, user_id, user_type) VALUES ?',
          [values],
        );
      } else {
        const values = cleaned.map((a) => [clientId, a.verticalId, a.userId]);
        await conn.query(
          'INSERT INTO tbl_vertical_mapping (client_id, vertical_id, user_id) VALUES ?',
          [values],
        );
      }
    }
    await conn.commit();
    return cleaned.length;
  } catch (e) {
    try { await conn.rollback(); } catch (_) { /* swallow rollback failure */ }
    throw e;
  } finally {
    conn.release();
  }
}

/* ─── Bulk SPOC (Primary + Secondary) assignment ──────────────────── */

/*
 * Upsert Primary (user_type=1) + Secondary (user_type=2) SPOC for a
 * single client. Used by both the per-client UI flow and the bulk
 * Xlsx upload.
 *
 * Behaviour:
 *   - If a row exists for (client_id, user_type), UPDATE its user_id.
 *   - Otherwise INSERT a fresh row.
 *   - Uses ONE TX so the (Primary, Secondary) pair is consistent.
 *
 * vertical_id: legacy DBs put SPOC mappings under a specific
 * vertical_id; for the bulk flow we cannot infer which vertical, so
 * we look up the client's primary vertical_id (tbl_client.vertical_id)
 * and use that. If absent, we insert with vertical_id = 0 (legacy
 * "Default" vertical).
 *
 * Returns:
 *   { primary: 'inserted'|'updated', secondary: 'inserted'|'updated' }
 */
async function upsertPrimarySecondarySpoc(clientId, primaryUserId, secondaryUserId) {
  const hasUT = await hasUserTypeColumn();
  if (!hasUT) {
    throw Object.assign(
      new Error('tbl_vertical_mapping.user_type column missing — cannot record Primary/Secondary SPOC'),
      { status: 503 },
    );
  }
  // Resolve vertical_id for the client; fall back to 0 (legacy default).
  const [[clientRow]] = await pool.query(
    'SELECT vertical_id FROM tbl_client WHERE client_id = ? LIMIT 1', [clientId],
  );
  if (!clientRow) {
    throw Object.assign(new Error(`Client ${clientId} not found`), { status: 404 });
  }
  const verticalId = clientRow.vertical_id || 0;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = {};
    for (const [userType, userId, key] of [[1, primaryUserId, 'primary'], [2, secondaryUserId, 'secondary']]) {
      const [r] = await conn.query(
        `UPDATE tbl_vertical_mapping
            SET user_id = ?
          WHERE client_id = ? AND user_type = ?`,
        [userId, clientId, userType],
      );
      if (r.affectedRows === 0) {
        await conn.query(
          `INSERT INTO tbl_vertical_mapping (client_id, vertical_id, user_id, user_type)
           VALUES (?, ?, ?, ?)`,
          [clientId, verticalId, userId, userType],
        );
        out[key] = 'inserted';
      } else {
        out[key] = 'updated';
      }
    }
    await conn.commit();
    return out;
  } catch (e) {
    try { await conn.rollback(); } catch (_) { /* swallow */ }
    throw e;
  } finally {
    conn.release();
  }
}

/*
 * Validate one user_id exists + is internal (in tbl_user, not soft-deleted).
 * Cached set per process to avoid round-trip per row in bulk uploads.
 *
 * Refresh: invoke `clearActiveUserCache()` after any user create/edit
 * to drop the cache. For the bulk-upload flow's lifespan (~30s) the
 * cache is fine without active invalidation.
 */
let _activeUsersPromise = null;
async function activeInternalUserIds() {
  if (!_activeUsersPromise) {
    _activeUsersPromise = (async () => {
      const [rows] = await pool.query(
        // legacy `userDao.getActiveInternalUsers()` was role-status agnostic;
        // we err on the side of "any tbl_user row whose status != 0".
        `SELECT user_id FROM tbl_user WHERE user_status IS NULL OR user_status <> 0`,
      );
      return new Set(rows.map((r) => r.user_id));
    })();
  }
  return _activeUsersPromise;
}

function clearActiveUserCache() {
  _activeUsersPromise = null;
}

module.exports = {
  listForClient,
  replaceForClient,
  hasUserTypeColumn,
  upsertPrimarySecondarySpoc,
  activeInternalUserIds,
  clearActiveUserCache,
};
