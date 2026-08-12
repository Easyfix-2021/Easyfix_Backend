const { pool } = require('../db');
const logger = require('../logger');
const s3 = require('../utils/s3-storage');

/*
 * Notice service — backs the Notice Board CRM management surfaces
 * (list, detail, create, update, publish, archive) AND the active-
 * notice feed each surface (CRM / Client / Technician) consumes
 * for its dashboard strip / bell screen.
 *
 * Status model:
 *   draft       — author still composing; not visible anywhere
 *   scheduled   — publish_at in future; will flip to published when
 *                 NOW() >= publish_at (computed at read time; no cron)
 *   published   — visible to target_surfaces within the publish/expire
 *                 window
 *   archived    — soft-deleted; preserved for audit / read-receipt
 *                 history but invisible everywhere
 *
 * Expired is DERIVED (expire_at < NOW); we don't store it. That keeps
 * the lifecycle write paths simple — publish/archive are the only
 * transitions a human performs.
 *
 * `target_surfaces` is a CSV subset of {crm,client,technician}. v1
 * audience_scope is always 'all'; the scope columns are reserved for
 * city / specific targeting that lands in Phase 2.
 */

function mkErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const SURFACES = ['crm', 'client', 'technician'];

// `target_surfaces` is a CSV (e.g. "technician,client"). Returns true when
// `surface` is one of its members.
/*
 * Should publishing this notice fan a push out to the Technician App?
 *
 * Treats an ABSENT flag as TRUE on purpose: rows written before the
 * push_technician column existed, and any caller that doesn't set it, must keep
 * the historic behaviour (targeting the technician surface has always pushed).
 * Only an explicit 0/false suppresses it.
 */
function pushTechnicianWanted(notice) {
  const flag = notice && notice.push_technician;
  if (flag === undefined || flag === null) return true;
  return Number(flag) === 1 || flag === true;
}

function surfacesInclude(targetSurfaces, surface) {
  return String(targetSurfaces || '')
    .split(',')
    .map((s) => s.trim())
    .includes(surface);
}

// Returns rough audience-reach count for each surface. Used by the
// All-Notices table's "Reach" column and the Review & Send step's
// "≈ N technicians" hint. Computed per request; small/fast (single
// COUNT each, no joins, all indexed).
async function getSurfaceReachMap() {
  const out = { crm: 0, client: 0, technician: 0 };
  try {
    const [[{ n }]] = await pool.query(
      'SELECT COUNT(*) AS n FROM tbl_user WHERE COALESCE(user_status, 1) = 1',
    );
    out.crm = Number(n) || 0;
  } catch (e) {
    logger.warn({ err: e }, 'getSurfaceReachMap: tbl_user count failed; defaulting to 0');
  }
  try {
    const [[{ n }]] = await pool.query(
      `SELECT COUNT(*) AS n FROM tbl_easyfixer
        WHERE efr_status = 1
          AND COALESCE(is_technician_verified, 0) = 1`,
    );
    out.technician = Number(n) || 0;
  } catch (e) {
    logger.warn({ err: e }, 'getSurfaceReachMap: tbl_easyfixer count failed; defaulting to 0');
  }
  try {
    // tbl_client_contacts is the per-client SPOC table powering the
    // Client Dashboard. We count all rows (no status flag) as an upper
    // bound — a tighter active-only filter can land when Phase 2 adds
    // the consumer surface.
    const [[{ n }]] = await pool.query(
      'SELECT COUNT(*) AS n FROM tbl_client_contacts',
    );
    out.client = Number(n) || 0;
  } catch (e) {
    logger.warn({ err: e }, 'getSurfaceReachMap: tbl_client_contacts count failed; defaulting to 0');
  }
  return out;
}

/*
 * effective_status decoration. Pure derivation — applied at read time
 * so the stored `status` reflects author intent and we don't need a
 * cron to flip scheduled → published.
 *
 *   scheduled + publish_at > NOW    → 'scheduled'
 *   scheduled + publish_at <= NOW   → 'published'  (effective)
 *   published + expire_at < NOW     → 'expired'    (effective)
 *   anything else                   → status unchanged
 */
function effectiveStatus(row, now = new Date()) {
  if (row.status === 'archived' || row.status === 'draft') return row.status;
  const nowMs = now.getTime();
  const pubMs = row.publish_at ? new Date(row.publish_at).getTime() : null;
  const expMs = row.expire_at  ? new Date(row.expire_at).getTime()  : null;
  if (row.status === 'scheduled') {
    if (pubMs == null || pubMs <= nowMs) {
      // publish window passed → effectively published (unless expired)
      if (expMs != null && expMs < nowMs) return 'expired';
      return 'published';
    }
    return 'scheduled';
  }
  // status === 'published'
  if (expMs != null && expMs < nowMs) return 'expired';
  return 'published';
}

/*
 * Build the bare SELECT row + category + creator name. We DON'T join
 * tbl_notice_read here — counts are added separately to keep the
 * primary query index-friendly even with many read receipts.
 */
const ROW_SELECT = `
  n.notice_id, n.title, n.body, n.category_id,
  n.target_surfaces, n.audience_scope, n.audience_ref_id,
  n.action_url, n.images, n.is_pinned, n.status,
  n.publish_at, n.expire_at,
  -- event_date drives the dashboard's Upcoming Events rail; the push flags let
  -- the CRM show what a notice was configured to send. Added here (the shared
  -- projection) so list, detail AND the per-surface active feed all carry them.
  n.event_date, n.push_technician, n.push_client,
  n.created_by, n.reviewed_by, n.published_by,
  n.created_at, n.updated_at,
  c.name  AS category_name,
  c.color AS category_color,
  u.user_name AS created_by_name
`;

/*
 * mysql2 returns JSON columns either as already-parsed JS values OR
 * as raw strings depending on driver version + table charset. Normalise
 * here so every consumer sees a `string[]` (or empty array on null).
 *
 * The returned array holds RAW STORED VALUES — S3 keys (e.g.
 * "Notices/1716_abcd") for new uploads, or relative URLs (e.g.
 * "/easydoc/abcd.png") for the local-disk fallback path. The
 * `resolveStoredImages()` helper turns these into renderable URLs.
 */
function normaliseImages(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/*
 * Resolve an array of stored image values to renderable URLs.
 *   - S3 keys ("Notices/...") → presigned GET URLs (5-min TTL)
 *   - Local paths / URLs       → passthrough
 *   - null/empty               → dropped
 *
 * Concurrent via Promise.all because each S3 sign is independent +
 * local (no network). On a 5-image notice this resolves in single-
 * digit milliseconds total.
 */
async function resolveStoredImages(stored) {
  if (!Array.isArray(stored) || stored.length === 0) return [];
  const resolved = await Promise.all(stored.map((v) => s3.resolveNoticeImageUrl(v)));
  return resolved.filter((u) => !!u);
}

/*
 * Inverse direction — when the FE sends `images` on Save, the array
 * may contain presigned URLs (because the form just received them as
 * resolved URLs on hydration). We want to STORE the canonical key,
 * not the ephemeral presigned URL whose signature ages out.
 *
 * Conversion:
 *   - presigned S3 URL → extract the path → strip leading `/` → that's the key
 *   - relative URL ("/easydoc/...") → passthrough (stored as-is)
 *   - already-a-key ("Notices/...") → passthrough
 *
 * The bucket-name comparison guards against a third-party signed URL
 * sneaking into our table; if the host doesn't match our bucket we
 * passthrough the raw URL (FE will still display, but new edits will
 * eventually break — surface this as a future hygiene task).
 */
function normaliseIncomingImageValue(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v) return null;
  // Already an S3 key — keep as-is.
  if (v.startsWith('Notices/') || v.startsWith('JobSupportings/') || v.startsWith('Job_Images/')) {
    return v;
  }
  // Relative URL — local-disk fallback path; keep as-is.
  if (v.startsWith('/')) return v;
  // Full URL — try to extract the S3 key from the pathname.
  if (/^https?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      const bucket = s3.bucketName();
      // Match either virtual-hosted-style URL (<bucket>.s3.<region>.amazonaws.com)
      // or path-style (s3.amazonaws.com/<bucket>/<key>). For our own bucket
      // we trust the path is the key (after stripping a leading slash).
      const pathKey = u.pathname.replace(/^\/+/, '');
      if (bucket && (u.hostname.startsWith(`${bucket}.`) || pathKey.startsWith(`${bucket}/`))) {
        const keyOnly = pathKey.startsWith(`${bucket}/`) ? pathKey.slice(bucket.length + 1) : pathKey;
        return keyOnly;
      }
      // Foreign URL — store the path portion; the resolveNoticeImageUrl
      // fallback will render it if Nginx/CDN happens to serve it.
      return pathKey || v;
    } catch {
      return v;
    }
  }
  return v;
}

function normaliseIncomingImages(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(normaliseIncomingImageValue).filter((v) => v !== null);
}

const ROW_JOINS = `
  LEFT JOIN tbl_notice_category c ON c.category_id = n.category_id
  LEFT JOIN tbl_user            u ON u.user_id     = n.created_by
`;

/*
 * Decorate a list of rows with read_count, effective_status, reach.
 * Single round-trip for the read counts via IN-list.
 */
async function decorate(rows, reachMap) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.notice_id);

  // Read counts
  const [readRows] = await pool.query(
    `SELECT notice_id, COUNT(*) AS c
       FROM tbl_notice_read
      WHERE notice_id IN (?)
      GROUP BY notice_id`,
    [ids],
  );
  const readCount = new Map(readRows.map((r) => [r.notice_id, Number(r.c)]));

  // Resolve every row's images concurrently. The Promise.all here
  // amortises S3 signing across all rows in a single tick — even on
  // a 50-row list with 5 images each, the total resolve cost is the
  // worst single sign (no network involved).
  const resolved = await Promise.all(rows.map(async (r) => {
    const surfaces = (r.target_surfaces || '').split(',').filter(Boolean);
    const reach = surfaces.reduce((sum, s) => sum + (reachMap[s] || 0), 0);
    const imageKeys = normaliseImages(r.images);
    const imageUrls = await resolveStoredImages(imageKeys);
    return {
      ...r,
      // Two parallel arrays: `image_keys` is what the FE echoes back
      // on edit (round-trip identity), `images` is what it renders.
      image_keys: imageKeys,
      images: imageUrls,
      effective_status: effectiveStatus(r),
      read_count: readCount.get(r.notice_id) || 0,
      reach_estimate: reach,
      read_pct: reach > 0
        ? Math.round(((readCount.get(r.notice_id) || 0) / reach) * 100)
        : 0,
    };
  }));
  return resolved;
}

// ─── List (All Notices page) ────────────────────────────────────────
async function listNotices({
  q, status, surface, category_id,
  limit = 25, offset = 0,
} = {}) {
  limit  = Math.min(Math.max(Number(limit) || 25, 1), 200);
  offset = Math.max(Number(offset) || 0, 0);

  logger.info('List notices · status=' + (status || 'any') + ' · surface=' + (surface || 'any')
    + ' · category_id=' + (category_id || 'any') + ' · q=' + (q ? 'yes' : 'no')
    + ' · limit=' + limit + ' · offset=' + offset);

  const where = ['1=1'];
  const params = [];

  if (q) {
    where.push('(n.title LIKE ? OR n.body LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  if (status) {
    where.push('n.status = ?');
    params.push(status);
  }
  if (surface) {
    // FIND_IN_SET handles the CSV cleanly. Cannot use a generated
    // column / FK here — keep the table simple.
    where.push('FIND_IN_SET(?, n.target_surfaces)');
    params.push(surface);
  }
  if (category_id) {
    where.push('n.category_id = ?');
    params.push(Number(category_id));
  }

  const [rows] = await pool.query(
    `SELECT ${ROW_SELECT}
       FROM tbl_notice n ${ROW_JOINS}
      WHERE ${where.join(' AND ')}
      ORDER BY n.is_pinned DESC,
               COALESCE(n.publish_at, n.created_at) DESC,
               n.notice_id DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM tbl_notice n WHERE ${where.join(' AND ')}`,
    params,
  );

  const reachMap = await getSurfaceReachMap();
  const items = await decorate(rows, reachMap);
  logger.info('Returning ' + items.length + ' notices · total=' + total);
  return { items, total };
}

async function getNoticeById(noticeId) {
  const [[row]] = await pool.query(
    `SELECT ${ROW_SELECT} FROM tbl_notice n ${ROW_JOINS} WHERE n.notice_id = ?`,
    [noticeId],
  );
  if (!row) return null;
  const reachMap = await getSurfaceReachMap();
  const [decorated] = await decorate([row], reachMap);
  return decorated;
}

// ─── Create ─────────────────────────────────────────────────────────
async function createNotice(body, createdBy) {
  const {
    title, body: text, category_id, target_surfaces,
    audience_scope = 'all', audience_ref_id = null,
    action_url = null, images = [], is_pinned = false,
    publish_at = null, expire_at = null,
    // '' from an untouched date input must land as SQL NULL, not as the empty
    // string (which MySQL would coerce to the zero-date '0000-00-00').
    event_date = null,
    push_technician = true, push_client = false,
    status_intent = 'draft',
  } = body;

  logger.info('Create notice · category_id=' + category_id + ' · surfaces=' + target_surfaces
    + ' · status_intent=' + status_intent);

  // Validate category exists + active
  const [[cat]] = await pool.query(
    'SELECT category_id, is_active FROM tbl_notice_category WHERE category_id = ?',
    [category_id],
  );
  if (!cat) {
    logger.warn('Create notice rejected · invalid category_id=' + category_id);
    throw mkErr(400, 'Invalid category_id');
  }
  if (!cat.is_active) {
    logger.warn('Create notice rejected · inactive category_id=' + category_id);
    throw mkErr(400, 'Category is inactive');
  }

  // v1 supports only audience_scope='all'. Schema accepts the other
  // values for forward-compat but the service rejects them until the
  // city/specific targeting paths land.
  if (audience_scope !== 'all') {
    throw mkErr(400, 'audience_scope city/specific is not yet supported');
  }

  // Derive status from status_intent + publish_at.
  let status = 'draft';
  let resolvedPublishAt = publish_at;
  let resolvedPublishedBy = null;

  if (status_intent === 'publish') {
    if (!publish_at) {
      resolvedPublishAt = new Date();           // publish now
      status = 'published';
      resolvedPublishedBy = createdBy;
    } else {
      const pubMs = new Date(publish_at).getTime();
      if (pubMs <= Date.now()) {
        status = 'published';
        resolvedPublishedBy = createdBy;
      } else {
        status = 'scheduled';
      }
    }
  }

  // Images: normalise incoming values to canonical KEYS (extract from
  // presigned URLs if necessary), then JSON-stringify. Storing keys
  // (not URLs) means presigning happens fresh on every read and
  // ephemeral signature expiry doesn't break later renders.
  const normalisedImages = normaliseIncomingImages(images);
  const imagesJson = JSON.stringify(normalisedImages);

  const [r] = await pool.query(
    `INSERT INTO tbl_notice
       (title, body, category_id, target_surfaces,
        audience_scope, audience_ref_id, action_url, images, is_pinned,
        status, publish_at, expire_at,
        event_date, push_technician, push_client,
        created_by, published_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      title, text, category_id, target_surfaces,
      audience_scope, audience_ref_id, action_url, imagesJson, is_pinned ? 1 : 0,
      status, resolvedPublishAt, expire_at,
      event_date || null, push_technician ? 1 : 0, push_client ? 1 : 0,
      createdBy, resolvedPublishedBy,
    ],
  );

  const created = await getNoticeById(r.insertId);
  logger.info('Notice created · id=' + r.insertId + ' · status=' + status);

  // Same fire-and-forget push as publishNotice — only when the notice was
  // created already-published (publish intent with no future publish_at)
  // and targets the technician surface. Scheduled/future notices are NOT
  // pushed here (no scheduler fires them at publish_at yet).
  // pushWanted(): the technician fan-out now also honours the explicit
  // push_technician flag. It only NARROWS — the surface must still be targeted.
  // Undefined (pre-migration rows / callers that never set it) counts as TRUE
  // so historic behaviour is preserved.
  if (
    created
    && status === 'published'
    && surfacesInclude(created.target_surfaces, 'technician')
    && pushTechnicianWanted(created)
  ) {
    const { pushNoticeToTechnicians } = require('./notice-push.service');
    pushNoticeToTechnicians(created).catch(() => {});
  }

  return created;
}

// ─── Update (drafts and scheduled only) ─────────────────────────────
async function updateNotice(noticeId, fields) {
  logger.info('Update notice · id=' + noticeId + ' · fields=' + Object.keys(fields || {}).join(','));
  const [[existing]] = await pool.query(
    'SELECT notice_id, status FROM tbl_notice WHERE notice_id = ?',
    [noticeId],
  );
  if (!existing) return null;
  if (existing.status === 'published' || existing.status === 'archived') {
    logger.warn('Update notice rejected · id=' + noticeId + ' · status=' + existing.status + ' not editable');
    throw mkErr(409,
      'Published or archived notices cannot be edited. Archive and recreate to make changes.');
  }

  if (fields.audience_scope && fields.audience_scope !== 'all') {
    throw mkErr(400, 'audience_scope city/specific is not yet supported');
  }
  if (fields.category_id) {
    const [[cat]] = await pool.query(
      'SELECT category_id, is_active FROM tbl_notice_category WHERE category_id = ?',
      [fields.category_id],
    );
    if (!cat) throw mkErr(400, 'Invalid category_id');
    if (!cat.is_active) throw mkErr(400, 'Category is inactive');
  }

  const allowed = [
    'title', 'body', 'category_id', 'target_surfaces',
    'audience_scope', 'audience_ref_id', 'action_url', 'images',
    'is_pinned', 'publish_at', 'expire_at',
    'event_date', 'push_technician', 'push_client',
  ];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = ?`);
      // Coerce: is_pinned → 0/1; images → JSON-string. Everything else
      // passes through as-is and mysql2's parameter binding handles
      // the appropriate quoting/escaping.
      if (k === 'is_pinned') {
        params.push(fields[k] ? 1 : 0);
      } else if (k === 'images') {
        // Same canonicalisation as create — convert any presigned
        // URLs back to S3 keys before persisting.
        params.push(JSON.stringify(normaliseIncomingImages(fields[k])));
      } else {
        params.push(fields[k]);
      }
    }
  }
  if (!sets.length) return getNoticeById(noticeId);
  params.push(noticeId);
  await pool.query(
    `UPDATE tbl_notice SET ${sets.join(', ')} WHERE notice_id = ?`,
    params,
  );
  logger.info('Notice updated · id=' + noticeId);
  return getNoticeById(noticeId);
}

// ─── Publish (transition draft → scheduled/published) ───────────────
async function publishNotice(noticeId, { publish_at, expire_at }, publishedBy) {
  logger.info('Publish notice · id=' + noticeId);
  const [[existing]] = await pool.query(
    'SELECT notice_id, status, publish_at FROM tbl_notice WHERE notice_id = ?',
    [noticeId],
  );
  if (!existing) return null;
  if (existing.status === 'archived') {
    logger.warn('Publish notice rejected · id=' + noticeId + ' · already archived');
    throw mkErr(409, 'Cannot publish an archived notice');
  }
  if (existing.status === 'published') {
    // Idempotent — return the row as-is.
    logger.info('Publish notice no-op · id=' + noticeId + ' · already published');
    return getNoticeById(noticeId);
  }

  let resolvedPublishAt = publish_at ?? existing.publish_at ?? new Date();
  const pubMs = new Date(resolvedPublishAt).getTime();
  const isFuture = pubMs > Date.now() + 1_000;       // 1s slack for clock skew
  const newStatus = isFuture ? 'scheduled' : 'published';

  const sets = ['status = ?', 'publish_at = ?'];
  const params = [newStatus, resolvedPublishAt];
  if (expire_at !== undefined) {
    sets.push('expire_at = ?');
    params.push(expire_at);
  }
  if (newStatus === 'published') {
    sets.push('published_by = ?');
    params.push(publishedBy);
  }
  params.push(noticeId);
  await pool.query(
    `UPDATE tbl_notice SET ${sets.join(', ')} WHERE notice_id = ?`,
    params,
  );
  logger.info('Notice ' + newStatus + ' · id=' + noticeId);

  const row = await getNoticeById(noticeId);

  // Fire the technician push only for notices that went LIVE now (not
  // scheduled for the future) and that target the technician surface.
  // Scheduled notices won't push until a scheduler exists to fire them at
  // their publish_at — no cron does that yet.
  if (
    row
    && newStatus === 'published'
    && surfacesInclude(row.target_surfaces, 'technician')
    && pushTechnicianWanted(row)
  ) {
    // Lazy require avoids any circular-require risk (mirrors how
    // job.service.js lazily requires its orchestrator). Fire-and-forget:
    // never block the HTTP response on the fan-out.
    const { pushNoticeToTechnicians } = require('./notice-push.service');
    pushNoticeToTechnicians(row).catch(() => {});
  }

  return row;
}

// ─── Archive ────────────────────────────────────────────────────────
async function archiveNotice(noticeId) {
  logger.info('Archive notice · id=' + noticeId);
  const [[existing]] = await pool.query(
    'SELECT notice_id, status FROM tbl_notice WHERE notice_id = ?',
    [noticeId],
  );
  if (!existing) return null;
  if (existing.status === 'archived') return getNoticeById(noticeId);
  await pool.query(
    `UPDATE tbl_notice SET status = 'archived' WHERE notice_id = ?`,
    [noticeId],
  );
  logger.info('Notice archived · id=' + noticeId);
  return getNoticeById(noticeId);
}

/*
 * Permanently delete a notice.
 *
 * Distinct from archive: archiving keeps the row (and its read receipts) for
 * the record and merely stops it appearing, whereas delete is for notices that
 * should never have existed — a typo, a duplicate, a test broadcast. Ops asked
 * for both because archiving a mistake still leaves it cluttering the list.
 *
 * The read receipts go with it. tbl_notice_read has no FK to tbl_notice (this
 * schema deliberately carries none), so nothing cascades — orphan rows would
 * accumulate forever and skew the read-percentage of a LATER notice if an id
 * were ever reused. Both statements run in one transaction so a notice can
 * never survive with its receipts already gone, or vice versa.
 *
 * Returns { deleted: true } or null when the id doesn't exist, so the route can
 * 404 cleanly rather than reporting a successful no-op.
 */
async function deleteNotice(noticeId) {
  logger.info('Delete notice · id=' + noticeId);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[existing]] = await conn.query(
      'SELECT notice_id FROM tbl_notice WHERE notice_id = ? FOR UPDATE',
      [noticeId],
    );
    if (!existing) {
      await conn.rollback();
      return null;
    }
    const [reads] = await conn.query('DELETE FROM tbl_notice_read WHERE notice_id = ?', [noticeId]);
    await conn.query('DELETE FROM tbl_notice WHERE notice_id = ?', [noticeId]);
    await conn.commit();
    logger.info('Notice deleted · id=' + noticeId + ' · readReceiptsRemoved=' + (reads.affectedRows || 0));
    return { deleted: true, notice_id: Number(noticeId) };
  } catch (e) {
    await conn.rollback();
    logger.error('Delete notice failed, rolled back · id=' + noticeId + ' · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }
}

// ─── Scheduled → published flip + push (cron) ───────────────────────
/*
 * Promote every 'scheduled' notice whose publish_at has arrived to
 * 'published', and fire the technician push for each real transition.
 *
 * Read-time effectiveStatus() already SHOWS scheduled-now-eligible
 * notices in every feed (see top-of-file note), but it never PERSISTS
 * the flip nor fires a push — so a notice scheduled for the future was
 * silently visible without ever notifying technicians. This cron closes
 * that gap: it's the only place that durably writes scheduled→published
 * and the only place that pushes a *scheduled* notice at its publish_at.
 *
 * Atomicity: the UPDATE carries `AND status = 'scheduled'` so it acts as
 * a transition guard — exactly one tick can win the flip; a later tick
 * (or a concurrent publishNotice) sees affectedRows=0 and skips the push.
 * That guard is what makes the push fire-exactly-once per transition.
 *
 * Per-row work is wrapped in try/catch so one bad row never aborts the
 * batch. Returns { checked, published, pushed }.
 */
async function publishDueScheduled() {
  const [due] = await pool.query(
    `SELECT notice_id, created_by, published_by, target_surfaces
       FROM tbl_notice
      WHERE status = 'scheduled'
        AND publish_at IS NOT NULL
        AND publish_at <= NOW()`,
  );

  const summary = { checked: due.length, published: 0, pushed: 0 };
  logger.info('Promote due scheduled notices · found ' + due.length + ' due');

  for (const n of due) {
    try {
      // Atomic guard: only the tick that flips status='scheduled' → 'published'
      // gets affectedRows=1. published_by is COALESCE'd to created_by so a
      // scheduled notice (no human publisher) still records an author.
      const [res] = await pool.query(
        `UPDATE tbl_notice
            SET status = 'published',
                published_by = COALESCE(published_by, created_by)
          WHERE notice_id = ?
            AND status = 'scheduled'`,
        [n.notice_id],
      );
      if (res.affectedRows !== 1) continue;   // lost the race / already flipped
      summary.published += 1;

      // Only push when the (now-published) notice targets technicians.
      if (surfacesInclude(n.target_surfaces, 'technician')) {
        const row = await getNoticeById(n.notice_id);
        if (row && pushTechnicianWanted(row)) {
          // Lazy require mirrors createNotice/publishNotice — avoids any
          // circular-require risk. Fire-and-forget: never block the batch.
          const { pushNoticeToTechnicians } = require('./notice-push.service');
          pushNoticeToTechnicians(row).catch(() => {});
          summary.pushed += 1;
        }
      }
    } catch (err) {
      logger.warn('Promote due scheduled notice failed · id=' + n.notice_id + ' · ' + err.message);
      logger.warn({ err, notice_id: n.notice_id }, 'publishDueScheduled: row failed; skipping');
    }
  }

  logger.info('Promoted ' + summary.published + ' notices · pushed=' + summary.pushed);
  return summary;
}

// ─── Active feed (dashboard strip + future app screens) ─────────────
/*
 * Returns active notices for the given surface, with per-row `is_read`
 * for the calling user. Caller passes `surface` + the (reader_type,
 * reader_id) that identifies the consumer (crm_user/user_id for CRM,
 * client/contact_id or efr/efr_id for app surfaces).
 *
 * Active = published or scheduled-now-eligible, within the window,
 * for this surface.
 */
async function listActiveForSurface({
  surface,
  readerType = 'crm_user',
  readerId,
  limit = 20,
}) {
  if (!SURFACES.includes(surface)) throw mkErr(400, 'Invalid surface');
  limit = Math.min(Math.max(Number(limit) || 20, 1), 50);

  logger.info('List active notices · surface=' + surface + ' · readerType=' + readerType + ' · limit=' + limit);

  const [rows] = await pool.query(
    `SELECT ${ROW_SELECT},
            EXISTS(
              SELECT 1 FROM tbl_notice_read r
               WHERE r.notice_id   = n.notice_id
                 AND r.surface     = ?
                 AND r.reader_type = ?
                 AND r.reader_id   = ?
            ) AS is_read
       FROM tbl_notice n ${ROW_JOINS}
      WHERE FIND_IN_SET(?, n.target_surfaces)
        AND n.status IN ('published', 'scheduled')
        AND (n.publish_at IS NULL OR n.publish_at <= NOW())
        AND (n.expire_at  IS NULL OR n.expire_at  >  NOW())
      ORDER BY n.is_pinned DESC,
               COALESCE(n.publish_at, n.created_at) DESC,
               n.notice_id DESC
      LIMIT ?`,
    [surface, readerType, readerId || 0, surface, limit],
  );

  logger.info('Found ' + rows.length + ' active notices · surface=' + surface);

  return await Promise.all(rows.map(async (r) => {
    const imageKeys = normaliseImages(r.images);
    const imageUrls = await resolveStoredImages(imageKeys);
    return {
      ...r,
      image_keys: imageKeys,
      images: imageUrls,
      effective_status: effectiveStatus(r),
      is_read: Boolean(Number(r.is_read)),
    };
  }));
}

// ─── Unread count (accurate total, no LIMIT) ────────────────────────
/*
 * Total number of currently-active notices for `surface` that the reader
 * (readerType, readerId) has NOT read. Same active predicate as
 * listActiveForSurface (published/scheduled-now-eligible, within the
 * publish/expire window, for this surface) plus a NOT EXISTS read-receipt
 * check — but NO LIMIT, so callers (e.g. the mobile dashboard bell badge)
 * get the true unread total rather than a count bounded by a fetched batch.
 */
async function countUnreadForSurface({ surface, readerType = 'crm_user', readerId }) {
  if (!SURFACES.includes(surface)) throw mkErr(400, 'Invalid surface');
  logger.info('Count unread notices · surface=' + surface + ' · readerType=' + readerType);
  const [[{ unread }]] = await pool.query(
    `SELECT COUNT(*) AS unread
       FROM tbl_notice n
      WHERE FIND_IN_SET(?, n.target_surfaces)
        AND n.status IN ('published', 'scheduled')
        AND (n.publish_at IS NULL OR n.publish_at <= NOW())
        AND (n.expire_at  IS NULL OR n.expire_at  >  NOW())
        AND NOT EXISTS(
              SELECT 1 FROM tbl_notice_read r
               WHERE r.notice_id   = n.notice_id
                 AND r.surface     = ?
                 AND r.reader_type = ?
                 AND r.reader_id   = ?
            )`,
    [surface, surface, readerType, readerId || 0],
  );
  logger.info('Unread notices count=' + (Number(unread) || 0) + ' · surface=' + surface);
  return Number(unread) || 0;
}

// ─── Mark-read (idempotent upsert into tbl_notice_read) ─────────────
async function markRead({ noticeId, surface, readerType, readerId }) {
  if (!SURFACES.includes(surface)) throw mkErr(400, 'Invalid surface');
  logger.info('Mark notice read · noticeId=' + noticeId + ' · surface=' + surface + ' · readerType=' + readerType);
  // Insert and tolerate duplicates — UNIQUE index makes this idempotent.
  // We do NOT update read_at on duplicate; first read sticks (matches
  // the spec's "first time you opened it" semantics).
  await pool.query(
    `INSERT IGNORE INTO tbl_notice_read
       (notice_id, surface, reader_type, reader_id)
     VALUES (?, ?, ?, ?)`,
    [noticeId, surface, readerType, readerId],
  );
  return { ok: true };
}

module.exports = {
  // CRUD
  listNotices,
  getNoticeById,
  createNotice,
  updateNotice,
  publishNotice,
  archiveNotice,
  deleteNotice,
  publishDueScheduled,
  // Consumer
  listActiveForSurface,
  countUnreadForSurface,
  markRead,
  // Helpers (exposed for tests)
  effectiveStatus,
  getSurfaceReachMap,
  surfacesInclude,
};
