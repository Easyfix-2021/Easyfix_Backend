const { pool } = require('../db');
const logger = require('../logger');
const s3Storage = require('../utils/s3-storage');
const { getEffectivePermissions } = require('./role.service');
const { FEATURES, emailAllowed } = require('./feature-access.service');

/*
 * ─── IN-APP ISSUE REPORTER ─────────────────────────────────────────────────
 *
 * Any CRM user can report a problem from the page they are on. An issue
 * manager triages the queue, comments, and closes with a note.
 *
 * Two tables (migrations/2026-09-10-crm-issue-reporter.sql) and one service,
 * called from routes/admin/issues.js. The route owns HTTP shape and nothing
 * else; every rule about who may see or change an issue lives here.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE OWNERSHIP RULE — STATED ONCE, ENFORCED ON THE ROW ACTUALLY FETCHED
 * ══════════════════════════════════════════════════════════════════════════
 *
 *   READ an issue, ADD A COMMENT to it, or REOPEN it once closed, if
 *       issue.reported_by === actor.userId   OR   actor.canManage
 *   CLOSE it, or LIST with scope=all, only if
 *       actor.canManage
 *
 * `canManage` is "holds the isIssueManage action key AND is on the
 * access.issues.emails allowlist" — BOTH locks, see resolveActor. Resolved by
 * resolveActor() below.
 *
 * ── WHY THE CHECK IS ON THE FETCHED ROW, NOT IN THE WHERE CLAUSE ─────────
 * The tempting shape is `WHERE id = ? AND (reported_by = ? OR <manager>)`,
 * which returns zero rows for an unauthorised caller and lets the handler
 * answer 404. It is one statement shorter and it is the wrong shape here,
 * twice over:
 *
 *   1. It makes "no such issue" and "not yours" the same result, so the guard
 *      has no way to say which happened and neither do the logs. A guard whose
 *      failure is indistinguishable from an empty table cannot be tested — the
 *      passing and failing cases return identical output.
 *   2. Every caller of a row-loading helper would have to remember to pass the
 *      predicate. The moment one does not, the query is a plain `WHERE id = ?`
 *      and it looks correct at the call site. Fetching first and asserting
 *      after puts the guard in ONE place that every path routes through, so a
 *      new endpoint cannot forget it: loadIssueForActor() is the only way to
 *      get an issue row out of this module.
 *
 * ── req.scope IS DELIBERATELY NOT CONSULTED ─────────────────────────────
 * /api/admin attaches a city/client-shaped `req.scope` to every request and
 * most services intersect it into their WHERE clause. This one does not, and
 * the omission is a decision rather than an oversight. An issue is INTERNAL:
 * it is about the CRM itself, not about a job, a client or a city. Filtering
 * the queue by the reporter's geography would hide "the Jobs list crashes on
 * page 2" from a manager in a different city, which is the precise opposite of
 * what a bug queue is for. There is no `req.scope` reference anywhere in this
 * file or in routes/admin/issues.js, and there should not be one.
 *
 * ── THE SCREENSHOT IS PRESIGNED IN EXACTLY ONE PLACE ────────────────────
 * getIssueDetail() mints a 900-second presigned GET URL PER SCREENSHOT, AFTER
 * loadIssueForActor has passed, and it is the only function in this module that
 * calls getPresignedUrl. The list deliberately cannot: listIssues() never
 * selects a key at all — it projects `COUNT(*) … AS screenshot_count` from
 * tbl_crm_issue_image, so no key exists in the result set to be leaked by a
 * later refactor that forgets to delete it. A presigned URL is a bearer
 * credential in a query string: anyone holding it can fetch the object for 15
 * minutes with no auth at all, so it must never be minted for a caller who has
 * not already passed the per-row check.
 */

/** The two values the frontend switches on. Nothing else is ever stored. */
const STATUS = { OPEN: 'open', CLOSED: 'closed' };

/** The single action key that means "issue manager". */
const MANAGE_ACTION = 'isIssueManage';

/*
 * ...AND the email allowlist that narrows it. RBAC says the screen exists;
 * easyfix_properties['access.issues.emails'] says who may reach it. Both must
 * pass — see the canManageIssues note in services/feature-access.service.js
 * for why an issue queue is a per-PERSON grant and not a per-role one.
 *
 * Named through FEATURES rather than repeated as a literal so the key cannot
 * drift from the one GET /api/admin/access/features reports to the frontend:
 * the two answering differently is invisible until a user sees a button that
 * 403s.
 */
const MANAGE_PROPERTY = FEATURES.canManageIssues;

/** S3 prefix for screenshots. No extension on the key — MIME rides on
 *  Content-Type, per the ops convention in utils/s3-storage.js. */
const S3_PREFIX = 'Issues/';

/** Presigned-URL lifetime for a screenshot, seconds. Longer than the 5-minute
 *  default because the reader may be scrolling a long comment thread before
 *  the <img> is scrolled into view; far shorter than the 1-hour notice TTL
 *  because an issue screenshot can contain anything that was on the
 *  reporter's screen. */
const SCREENSHOT_PRESIGN_TTL_SEC = 900;

function badRequest(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/*
 * Resolve the caller into the { userId, canManage } shape every function here
 * takes. Reuses req.user.permissions when an upstream requireAction() has
 * already hydrated it (the close route), and otherwise asks role.service —
 * which is itself cached and single-flighted per user, so the read routes pay
 * at most one lookup per request.
 *
 * Kept in the service rather than the route so that "what counts as a manager"
 * is defined next to the rule that uses it; a route that resolved the key
 * itself could drift to a different key name and nothing would fail.
 */
async function resolveActor(req) {
  const userId = req.user && req.user.user_id;
  if (!userId) throw badRequest('authentication required', 401);
  if (!req.user.permissions) {
    req.user.permissions = await getEffectivePermissions(userId);
  }
  const perms = (req.user.permissions && req.user.permissions.actionPermissions) || [];
  /*
   * BOTH locks, and the AND is the whole point. The action key alone would
   * make the queue grantable from Manage Role to anyone given the Admin role
   * next; the allowlist alone would ignore RBAC entirely. A caller who holds
   * the key but is not on the list is treated exactly like an ordinary
   * reporter — they keep their own issues and see nobody else's — rather than
   * being refused outright, because that is the honest description of what
   * they now are.
   *
   * emailAllowed() fails CLOSED on a missing property, an empty CSV, or a user
   * row with no official_email.
   */
  const canManage = perms.includes(MANAGE_ACTION)
    && emailAllowed(MANAGE_PROPERTY, req.user.official_email);
  return { userId: Number(userId), canManage };
}

/** The rule, in one place. Returns true / false; callers turn it into a 403. */
function canRead(issue, actor) {
  return actor.canManage || Number(issue.reported_by) === Number(actor.userId);
}

/*
 * Load an issue and assert the actor may READ it. The ONLY way an issue row
 * leaves this module — see the ownership note above for why this is a fetch-
 * then-assert and not a predicate in the WHERE clause.
 *
 * 404 when it does not exist, 403 when it exists and is not the actor's. Those
 * are different answers on purpose: an issue id is a small sequential integer,
 * so hiding existence behind a 404 buys nothing an attacker could not get by
 * counting, and it costs the reporter a comprehensible error.
 */
async function loadIssueForActor(issueId, actor) {
  const [rows] = await pool.query(
    `SELECT i.id, i.title, i.description, i.page_path, i.status,
            i.reported_by, i.created_on, i.closed_by, i.closed_on, i.close_note,
            ru.user_name AS reported_by_name,
            cu.user_name AS closed_by_name
       FROM tbl_crm_issue i
       LEFT JOIN tbl_user ru ON ru.user_id = i.reported_by
       LEFT JOIN tbl_user cu ON cu.user_id = i.closed_by
      WHERE i.id = ?`,
    [issueId],
  );
  if (!rows.length) throw badRequest('Issue not found', 404);
  const issue = rows[0];
  if (!canRead(issue, actor)) {
    logger.warn('Issue access refused · issueId=' + issueId + ' userId=' + actor.userId);
    throw badRequest('You may only view issues you reported', 403);
  }
  return issue;
}

/*
 * Create an issue. `screenshotKeys` are the S3 keys the route already stored,
 * in the order the reporter attached them — the route owns the upload because
 * that is where multer put the buffers, and this function owns the rows.
 *
 * The images go to tbl_crm_issue_image, NOT to tbl_crm_issue.screenshot_key,
 * which is frozen at its last value and read by nothing from here on
 * (migrations/2026-09-10-crm-issue-reporter-v2.sql backfilled the old ones).
 *
 * The image inserts are ONE multi-row statement, so a five-screenshot report
 * costs two round trips rather than six, and either every image lands or none
 * does. They are not in a transaction with the parent insert on purpose: an
 * issue whose images failed is still a bug report worth having, and losing the
 * whole report because the second screenshot's row failed would be a strictly
 * worse outcome for the person trying to tell us something is broken.
 *
 * created_on is `new Date()`, never NOW(): the pool's +05:30 session timezone
 * (db.js) stores the IST wall clock verbatim, whereas NOW() would read the
 * container clock and mix two timezones into one column.
 */
async function createIssue({ title, description, pagePath, screenshotKeys, userId }) {
  const keys = (screenshotKeys || []).filter(Boolean);
  const now = new Date();
  const [r] = await pool.query(
    'INSERT INTO tbl_crm_issue (title, description, page_path, status, reported_by, created_on) VALUES (?, ?, ?, ?, ?, ?)',
    [title, description, pagePath || null, STATUS.OPEN, userId, now],
  );
  if (keys.length) {
    await pool.query(
      'INSERT INTO tbl_crm_issue_image (issue_id, s3_key, sort_order, created_on) VALUES ?',
      [keys.map((k, i) => [r.insertId, k, i, now])],
    );
  }
  logger.info('Issue reported · id=' + r.insertId + ' by=' + userId + ' screenshots=' + keys.length);
  return { id: r.insertId };
}

/*
 * The screenshots for a set of issues, as issueId → [key, …] in sort_order.
 * One query for N issues rather than N queries — the detail route needs one
 * issue's keys and nothing today needs more, but the list route's
 * screenshot_count is computed the same way and a per-row subquery there would
 * be the exact shape services/job.service.js:1447 warns against.
 */
async function imageKeysByIssue(issueIds) {
  const ids = (issueIds || []).map(Number).filter((n) => Number.isFinite(n));
  const out = new Map();
  if (!ids.length) return out;
  const [rows] = await pool.query(
    'SELECT issue_id, s3_key FROM tbl_crm_issue_image WHERE issue_id IN (?) ORDER BY issue_id, sort_order, id',
    [ids],
  );
  for (const row of rows) {
    if (!out.has(row.issue_id)) out.set(row.issue_id, []);
    out.get(row.issue_id).push(row.s3_key);
  }
  return out;
}

/*
 * The queue. `scope=all` is a manager-only view; `scope=mine` is every
 * caller's own issues and needs no grant.
 *
 * screenshot_count is computed IN SQL rather than derived from selected keys —
 * see the presign note in the header. No key and no URL is in this projection,
 * and neither must ever be added to it.
 */
async function listIssues({ scope, status, limit, offset }, actor) {
  if (scope === 'all' && !actor.canManage) {
    logger.warn('Issue list scope=all refused · userId=' + actor.userId);
    throw badRequest(`Missing permission: ${MANAGE_ACTION}`, 403);
  }

  const where = [];
  const params = [];
  if (scope !== 'all') {
    where.push('i.reported_by = ?');
    params.push(actor.userId);
  }
  if (status) {
    where.push('i.status = ?');
    params.push(status);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [rows] = await pool.query(
    /*
     * reported_by_name is joined, not left to the caller (2026-09-10).
     *
     * Without it a triage queue lists tickets with no indication of WHO filed
     * them — you cannot chase a reporter for detail, and in the comment thread
     * you cannot tell your own reply from theirs. The id alone is not an
     * answer to "who", and no amount of frontend work can supply a name the
     * API never sent.
     *
     * LEFT JOIN, matching services/job-comment.service.js:80: a deleted or
     * unresolvable user must yield NULL and a row that still renders, never
     * drop the ticket out of the queue.
     */
    `SELECT i.id, i.title, i.page_path, i.status, i.reported_by, i.created_on, i.closed_on,
            ru.user_name AS reported_by_name,
            (SELECT COUNT(*) FROM tbl_crm_issue_image  m WHERE m.issue_id = i.id) AS screenshot_count,
            (SELECT COUNT(*) FROM tbl_crm_issue_comment c WHERE c.issue_id = i.id) AS comment_count
       FROM tbl_crm_issue i
       LEFT JOIN tbl_user ru ON ru.user_id = i.reported_by
       ${clause}
      ORDER BY i.id DESC
      LIMIT ?, ?`,
    [...params, offset, limit],
  );
  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total FROM tbl_crm_issue i ${clause}`,
    params,
  );

  return {
    items: rows.map((r) => ({
      ...r,
      screenshot_count: Number(r.screenshot_count) || 0,
      has_screenshot: Number(r.screenshot_count) > 0,
    })),
    total: (countRows[0] && countRows[0].total) || 0,
    limit,
    offset,
  };
}

/*
 * Detail + comments. The ONE place a screenshot URL is minted, and only after
 * loadIssueForActor has passed.
 *
 * screenshot_urls is an ARRAY, empty when there are no screenshots, when S3 is
 * unconfigured (local dev), and when every signature failed — the frontend must
 * treat empty as "nothing to show", not as an error. A key that fails to sign
 * is DROPPED rather than returned as a null hole, so the array's length is
 * always the number of images the reader can actually open; screenshot_count
 * on the row is what they were told to expect, and the two differing is the
 * only honest way to show a partial failure.
 *
 * Raw keys are never returned: a key is useless to the browser and returning it
 * only widens what a logged response body exposes.
 */
async function getIssueDetail(issueId, actor) {
  const issue = await loadIssueForActor(issueId, actor);

  const [comments] = await pool.query(
    `SELECT c.id, c.comment_text, c.commented_by, c.created_on,
            u.user_name AS commented_by_name
       FROM tbl_crm_issue_comment c
       LEFT JOIN tbl_user u ON u.user_id = c.commented_by
      WHERE c.issue_id = ? ORDER BY c.id ASC`,
    [issueId],
  );

  const keys = (await imageKeysByIssue([issueId])).get(Number(issueId)) || [];
  const screenshotUrls = [];
  if (keys.length && s3Storage.isEnabled()) {
    for (const key of keys) {
      try {
        screenshotUrls.push(await s3Storage.getPresignedUrl(key, SCREENSHOT_PRESIGN_TTL_SEC));
      } catch (e) {
        // A signing failure must not take the whole issue down — the reporter
        // still needs to read the description and the thread — nor the other
        // screenshots down with it.
        logger.warn('Issue screenshot presign failed · issueId=' + issueId + ' err=' + (e && e.message));
      }
    }
  }

  return {
    ...issue,
    screenshot_count: keys.length,
    has_screenshot: keys.length > 0,
    screenshot_urls: screenshotUrls,
    comments,
  };
}

/*
 * Add a comment. Same read rule as the detail — a reporter can answer a
 * question on their own issue without holding the key, which is the whole
 * point of the thread.
 *
 * Deliberately allowed on a CLOSED issue: "this came back" belongs on the
 * original issue, not in a new one. A comment leaves the issue closed; to put
 * it back in the open queue, reopenIssue() below.
 */
async function addComment(issueId, { commentText }, actor) {
  await loadIssueForActor(issueId, actor);
  const [r] = await pool.query(
    'INSERT INTO tbl_crm_issue_comment (issue_id, comment_text, commented_by, created_on) VALUES (?, ?, ?, ?)',
    [issueId, commentText, actor.userId, new Date()],
  );
  logger.info('Issue comment added · issueId=' + issueId + ' by=' + actor.userId);
  return { id: r.insertId };
}

/*
 * Close. Manager-only — the route mounts requireAction(isIssueManage), and
 * this re-asserts on the actor rather than trusting the mount, because the
 * guard and the rule must not be able to drift apart.
 *
 * 409 on an already-closed issue: two managers working the queue will
 * occasionally both close the same row, and the loser must be told the row
 * moved rather than silently overwriting the first closer's note and
 * timestamp.
 */
async function closeIssue(issueId, { closeNote }, actor) {
  if (!actor.canManage) throw badRequest(`Missing permission: ${MANAGE_ACTION}`, 403);

  const issue = await loadIssueForActor(issueId, actor);
  if (issue.status === STATUS.CLOSED) {
    throw badRequest('Issue is already closed', 409);
  }

  await pool.query(
    'UPDATE tbl_crm_issue SET status = ?, closed_by = ?, closed_on = ?, close_note = ? WHERE id = ? AND status = ?',
    [STATUS.CLOSED, actor.userId, new Date(), closeNote || null, issueId, STATUS.OPEN],
  );
  logger.info('Issue closed · id=' + issueId + ' by=' + actor.userId);
  return { id: issueId, status: STATUS.CLOSED };
}

/** tbl_crm_issue_comment.comment_text is VARCHAR(2000). */
const COMMENT_MAX = 2000;

/*
 * Reopen. The READ rule, not the close rule: the reporter is the person who
 * finds out the fix did not work, and they hold no key. So the authorisation is
 * loadIssueForActor (404 / 403) and nothing else — the rule stays in one place.
 *
 * NO SCHEMA CHANGE. tbl_crm_issue has one closed_by / closed_on / close_note
 * slot, so the reopen CLEARS it — an open row carrying closed_on is the state
 * hand-check 5 in migrations/executed/2026-09-10-crm-issue-reporter.sql says
 * must never exist — and the close it undoes survives as a COMMENT by the
 * reopener: their reason, then who closed it, when, and with what note.
 *
 * ONE transaction, because each half alone is a lie: a reopen without its
 * comment erases the close note with no trace, and a comment without the
 * reopen claims a state change that never happened. `AND status = 'closed'` is
 * the race guard — two people reopening the same row both pass the status
 * check, and the loser's UPDATE matches nothing: 409, rollback, no second
 * comment.
 */
async function reopenIssue(issueId, { reopenNote }, actor) {
  const issue = await loadIssueForActor(issueId, actor);
  if (issue.status !== STATUS.CLOSED) {
    throw badRequest('Issue is already open', 409);
  }

  // closed_on is the pool's IST wall-clock string (db.js dateStrings):
  // reorder it to DD-MM-YYYY HH:mm, never parse it — parsing is where a TZ shift gets in.
  const when = String(issue.closed_on || '').replace(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}).*$/, '$3-$2-$1 $4:$5');
  const closer = issue.closed_by_name || `user #${issue.closed_by}`;
  const text = `Reopened: ${reopenNote}\n\nPreviously closed by ${closer}${when ? ` on ${when}` : ''}.`
    + (issue.close_note ? ` Close note: ${issue.close_note}` : '');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query(
      'UPDATE tbl_crm_issue SET status = ?, closed_by = NULL, closed_on = NULL, close_note = NULL WHERE id = ? AND status = ?',
      [STATUS.OPEN, issueId, STATUS.CLOSED],
    );
    if (!r.affectedRows) throw badRequest('Issue is already open', 409);
    await conn.query(
      'INSERT INTO tbl_crm_issue_comment (issue_id, comment_text, commented_by, created_on) VALUES (?, ?, ?, ?)',
      // ponytail: a 2000-char reason plus a 1000-char close note can overflow
      // the column, so the tail (the old note) is cut rather than 1406-ing the
      // reopen. Lower the reopen_note max if a cut note ever matters.
      [issueId, text.slice(0, COMMENT_MAX), actor.userId, new Date()],
    );
    await conn.commit();
  } catch (e) {
    try { await conn.rollback(); } catch { /* the original error is the one to report */ }
    throw e;
  } finally {
    conn.release();
  }
  logger.info('Issue reopened · id=' + issueId + ' by=' + actor.userId);
  return { id: issueId, status: STATUS.OPEN };
}

/** Build the S3 key for a screenshot. Timestamp + 8 hex chars, no extension —
 *  the same shape buildNoticeKey / buildClientDocKey use. */
function buildScreenshotKey() {
  const crypto = require('crypto');
  return `${S3_PREFIX}${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

module.exports = {
  STATUS,
  MANAGE_ACTION,
  SCREENSHOT_PRESIGN_TTL_SEC,
  buildScreenshotKey,
  resolveActor,
  canRead,
  loadIssueForActor,
  createIssue,
  listIssues,
  getIssueDetail,
  addComment,
  closeIssue,
  reopenIssue,
};
