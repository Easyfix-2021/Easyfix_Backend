const { pool } = require('../db');
const logger = require('../logger');
const { INTERNAL_USER_TYPE_ID } = require('./user.service');
const {
  validateMobile, validateDateOfBirth, normaliseBank,
  parseJson, bankFromRow, istTimestamp, mkErr,
} = require('./profile-self.service');

/*
 * profile-update-request.service — the HR-APPROVED half of HRMS "My Profile".
 *
 * Mobile number, a date-of-birth CORRECTION and bank details are identity /
 * payroll facts, so a CRM user cannot change them directly. They submit a
 * request; HR approves or rejects it; approval is what writes.
 *
 * ── ONE OPEN REQUEST PER USER (contract, revised 2026-09-01) ────────────
 * A user has AT MOST ONE pending request, and it is a DRAFT THAT ACCUMULATES.
 * Submitting MERGES: keys present overwrite, keys absent are left alone. So
 * "submit DOB, then later submit only mobile" ends as ONE request holding both.
 * There is deliberately NO 409 on "you already have a request" — merging IS the
 * behaviour. HR sees exactly one row per user and approves the whole thing.
 *
 * `old_values` records each key's value AS IT STOOD WHEN THAT KEY FIRST ENTERED
 * the request, so a re-submitted field does not overwrite the original "before"
 * with the previous draft's value. Without that rule, submitting a mobile twice
 * would show HR "9111111111 → 9222222222" where the truth is "<original> →
 * 9222222222" — a before/after that is not the change being approved.
 *
 * Enforcement of the one-row rule is the SERVICE'S JOB: MySQL has no partial
 * unique index, so the merge runs inside a transaction that takes the user's
 * pending row FOR UPDATE before deciding merge-vs-insert. A read-then-write
 * without that lock lets two tabs create two pending rows, which is exactly the
 * thing this model exists to prevent. On a miss the FOR UPDATE still takes a
 * gap lock in idx_user_status, which is what serialises two concurrent INSERTs.
 *
 * Errors throw { status, code, message } — same shape as withdrawal.service, so
 * the routes surface e.status plus a machine code the FE branches on.
 */

// The only three things a request can carry. `bank` is ONE value (all four
// fields), approved or rejected as a unit — see normaliseBank.
const FIELD_KEYS = ['mobile_no', 'date_of_birth', 'bank'];

// pending is the only actionable state; approved/rejected are terminal.
const REQUEST_STATUSES = ['pending', 'approved', 'rejected'];

/*
 * Validate + normalise a `changes` payload. THE definition of a valid request,
 * called at BOTH ends of the flow:
 *   - on submit, so garbage never lands in the table;
 *   - on APPROVE, because a value can go stale between the two (the classic
 *     case is a mobile that has since been registered to someone else, handled
 *     separately by assertMobileFree, but a DOB can also cross the age bound on
 *     a long-open request).
 * Throws 400 { code } on anything unusable.
 */
function normaliseChanges(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw mkErr(400, 'INVALID_CHANGES', 'changes must be an object');
  }
  const unknown = Object.keys(raw).filter((k) => !FIELD_KEYS.includes(k));
  if (unknown.length) {
    throw mkErr(400, 'INVALID_CHANGES',
      `changes has unknown field(s): ${unknown.join(', ')} — allowed: ${FIELD_KEYS.join(', ')}`);
  }
  const out = {};
  if ('mobile_no' in raw)     out.mobile_no     = validateMobile(raw.mobile_no, 'mobile_no');
  if ('date_of_birth' in raw) out.date_of_birth = validateDateOfBirth(raw.date_of_birth);
  if ('bank' in raw)          out.bank          = normaliseBank(raw.bank);
  if (!Object.keys(out).length) {
    throw mkErr(400, 'INVALID_CHANGES', 'changes must contain at least one field');
  }
  return out;
}

/*
 * The SAME uniqueness rule services/user.service.js applies on create and on
 * update: an ACTIVE INTERNAL user's mobile is unique. Historical inactive rows
 * do not count. Run on submit (fail fast, before a request is stored) AND again
 * inside the approve transaction (the number may have been taken in between).
 * `runner` is the pool on submit and the transaction connection on approve.
 */
async function assertMobileFree(mobile, userId, runner) {
  const [[dup]] = await runner.query(
    `SELECT user_id FROM tbl_user
      WHERE mobile_no = ? AND user_status = 1 AND user_type_id = ? AND user_id <> ?
      LIMIT 1`,
    [mobile, INTERNAL_USER_TYPE_ID, Number(userId)],
  );
  if (dup) {
    throw mkErr(409, 'MOBILE_TAKEN', `Another active user already uses mobile "${mobile}"`);
  }
}

/* The live values behind the three request keys — the `old_values` snapshot. */
async function readCurrentValues(userId, runner) {
  const [[user]] = await runner.query(
    'SELECT mobile_no FROM tbl_user WHERE user_id = ? LIMIT 1', [userId],
  );
  const [[personal]] = await runner.query(
    `SELECT date_of_birth, bank_account_number, bank_ifsc, bank_account_name, bank_name
       FROM tbl_user_personal_details WHERE user_id = ? LIMIT 1`,
    [userId],
  );
  return {
    mobile_no: (user && user.mobile_no) || null,
    date_of_birth: personal && personal.date_of_birth
      ? String(personal.date_of_birth).slice(0, 10) : null,
    bank: personal ? bankFromRow(personal) : null,
  };
}

/*
 * POST /api/profile/update-requests — submit or MERGE.
 *
 * @param userId      the CALLER's own id (routes/profile.js; never from input)
 * @param rawChanges  { mobile_no?, date_of_birth?, bank? }
 * @returns the merged request { request_id, changes, old_values, status }
 */
async function submitChanges(userId, rawChanges, poolRef = pool) {
  const changes = normaliseChanges(rawChanges);
  logger.info('Profile update request submitted · userId=' + userId
    + ' fields=' + Object.keys(changes).join(','));

  // Fail fast, outside the transaction: a taken mobile is the common rejection
  // and there is no reason to hold a row lock while discovering it. Re-checked
  // inside the approve transaction, which is where it actually matters.
  if (changes.mobile_no) await assertMobileFree(changes.mobile_no, userId, poolRef);

  const conn = await poolRef.getConnection();
  try {
    await conn.beginTransaction();

    // THE LOCK. Decides merge-vs-insert; on a miss it gap-locks the
    // (user_id, 'pending') range so a concurrent submit cannot insert a second
    // pending row behind our back.
    const [[open]] = await conn.query(
      `SELECT request_id, changes, old_values
         FROM tbl_user_profile_update_request
        WHERE user_id = ? AND status = 'pending'
        ORDER BY request_id DESC LIMIT 1 FOR UPDATE`,
      [userId],
    );

    const prevChanges = (open && parseJson(open.changes)) || {};
    const prevOld     = (open && parseJson(open.old_values)) || {};
    const merged      = { ...prevChanges, ...changes };

    // Snapshot the "before" ONLY for keys entering the request for the first
    // time. A key already in old_values keeps its original value — that is what
    // makes the before/after true across a re-submission.
    const oldValues = { ...prevOld };
    const firstTime = Object.keys(changes).filter((k) => !(k in oldValues));
    if (firstTime.length) {
      const live = await readCurrentValues(userId, conn);
      for (const key of firstTime) oldValues[key] = live[key] ?? null;
    }

    const now = new Date();
    let requestId;
    if (open) {
      await conn.query(
        `UPDATE tbl_user_profile_update_request
            SET changes = ?, old_values = ?, updated_on = ?
          WHERE request_id = ? AND status = 'pending'`,
        [JSON.stringify(merged), JSON.stringify(oldValues), now, open.request_id],
      );
      requestId = open.request_id;
    } else {
      // updated_on stays NULL on the first write — the column means "last time
      // this pending request was MERGED into", so NULL is "never merged".
      const [ins] = await conn.query(
        `INSERT INTO tbl_user_profile_update_request
           (user_id, changes, old_values, status, requested_on, updated_on)
         VALUES (?, ?, ?, 'pending', ?, NULL)`,
        [userId, JSON.stringify(merged), JSON.stringify(oldValues), now],
      );
      requestId = ins.insertId;
    }

    await conn.commit();
    logger.info('Profile update request ' + (open ? 'merged' : 'created')
      + ' · requestId=' + requestId + ' userId=' + userId
      + ' fields=' + Object.keys(merged).join(','));
    return {
      request_id: requestId,
      changes: merged,
      old_values: oldValues,
      status: 'pending',
      merged: Boolean(open),
    };
  } catch (e) {
    await conn.rollback().catch(() => {});
    logger.warn('Profile update request rolled back · userId=' + userId + ' · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }
}

/*
 * DELETE /api/profile/update-requests/:id — withdraw the whole draft.
 *
 * `AND user_id = ?` is the security boundary: the id comes from the URL, so the
 * row is scoped to the caller in the statement itself and a request id belonging
 * to a colleague simply matches nothing (404, not 403 — we do not confirm that
 * someone else's request exists).
 *
 * A DELETE, not a status flip: the contract's status vocabulary is
 * pending|approved|rejected, with no 'withdrawn'. A withdrawn draft was never
 * an HR decision and does not belong in the approval history.
 */
async function withdrawRequest(userId, requestId, poolRef = pool) {
  const [res] = await poolRef.query(
    `DELETE FROM tbl_user_profile_update_request
      WHERE request_id = ? AND user_id = ? AND status = 'pending'`,
    [Number(requestId), Number(userId)],
  );
  if (!res.affectedRows) {
    throw mkErr(404, 'REQUEST_NOT_FOUND', 'No pending request of yours with that id');
  }
  logger.info('Profile update request withdrawn · requestId=' + requestId + ' userId=' + userId);
  return { request_id: Number(requestId), withdrawn: true };
}

/*
 * One row shape for the list and for the post-process re-read, so the FE never
 * sees two different versions of the same record.
 *
 * The requester JOIN is not decoration: the Approvals table's "Raised By"
 * column is name + employee code, and without them it can only render
 * "ID <user_id>". `p` is the approver, for the processed-by column.
 */
const REQUEST_SELECT = `
  SELECT r.request_id, r.user_id, r.changes, r.old_values, r.status,
         r.requested_on, r.updated_on, r.processed_on, r.processed_by, r.remarks,
         u.user_code, u.user_name, u.official_email,
         p.user_name AS processed_by_name
    FROM tbl_user_profile_update_request r
    LEFT JOIN tbl_user u ON u.user_id = r.user_id
    LEFT JOIN tbl_user p ON p.user_id = r.processed_by`;

function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    changes:    parseJson(row.changes) || {},
    old_values: parseJson(row.old_values) || {},
    // IST wall clock, verbatim — never a UTC/ISO conversion. See istTimestamp.
    requested_on: istTimestamp(row.requested_on),
    updated_on:   istTimestamp(row.updated_on),
    processed_on: istTimestamp(row.processed_on),
  };
}

/*
 * GET /api/admin/profile-update-requests — the HR queue, server-side paginated.
 * `q` searches the REQUESTER (name / employee code / official email).
 *
 * Envelope is { rows, total, page, limit }: `rows` (not `items`) is what the
 * Approvals table reads, and `page` is 1-INDEXED like every other admin list
 * route in this codebase.
 */
const MAX_PAGE_SIZE = 1000;

async function listRequests({ status, q, page, limit } = {}, poolRef = pool) {
  const pageN  = Math.max(Number(page) || 1, 1);
  const limitN = Math.min(Math.max(Number(limit) || 20, 1), MAX_PAGE_SIZE);
  const offset = (pageN - 1) * limitN;

  const where  = ['1=1'];
  const params = [];
  if (status) { where.push('r.status = ?'); params.push(status); }
  if (q) {
    where.push('(u.user_name LIKE ? OR u.user_code LIKE ? OR u.official_email LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const whereSql = where.join(' AND ');

  const [rows] = await poolRef.query(
    `${REQUEST_SELECT}
      WHERE ${whereSql}
      ORDER BY r.request_id DESC
      LIMIT ?, ?`,
    [...params, offset, limitN],
  );
  const [[{ total }]] = await poolRef.query(
    `SELECT COUNT(*) AS total
       FROM tbl_user_profile_update_request r
       LEFT JOIN tbl_user u ON u.user_id = r.user_id
      WHERE ${whereSql}`,
    params,
  );

  logger.info('Listed profile update requests · status=' + (status || 'all')
    + ' page=' + pageN + ' total=' + total);
  return { rows: rows.map(hydrate), total, page: pageN, limit: limitN };
}

/*
 * Apply an approved `changes` object. Runs INSIDE the approve transaction, so
 * every field lands together with the status flip or none of it does.
 *
 * The personal-details write is a single upsert of only the columns this
 * request actually carries — column names come from the fixed literal lists
 * below, never from the payload, so the interpolation cannot carry user input.
 * Untouched columns (personal_email in particular) are left alone.
 */
async function applyChanges(userId, changes, conn) {
  if (changes.mobile_no) {
    await conn.query('UPDATE tbl_user SET mobile_no = ? WHERE user_id = ?',
      [changes.mobile_no, Number(userId)]);
  }

  const cols = [];
  const vals = [];
  if (changes.date_of_birth) {
    cols.push('date_of_birth');
    vals.push(changes.date_of_birth);
  }
  if (changes.bank) {
    cols.push('bank_account_number', 'bank_ifsc', 'bank_account_name', 'bank_name');
    vals.push(changes.bank.account_number, changes.bank.ifsc,
      changes.bank.account_name, changes.bank.bank_name);
  }
  if (!cols.length) return;

  const now = new Date();
  await conn.query(
    `INSERT INTO tbl_user_personal_details (user_id, ${cols.join(', ')}, created_on, updated_on)
     VALUES (${['?', ...cols.map(() => '?'), '?', '?'].join(', ')})
     ON DUPLICATE KEY UPDATE
       ${cols.map((c) => `${c} = VALUES(${c})`).join(',\n       ')},
       updated_on = VALUES(updated_on)`,
    [Number(userId), ...vals, now, now],
  );
}

/*
 * POST /api/admin/profile-update-requests/:id/process — approve or reject.
 *
 * TRANSACTION SHAPE (the whole point of this function):
 *   BEGIN
 *   1. SELECT … WHERE request_id = ? FOR UPDATE      — lock the row first
 *   2. 404 if missing; 409 ALREADY_PROCESSED if not 'pending'
 *   3. approve only:
 *        a. re-validate `changes` (a value can go stale between submit and
 *           approve — a DOB crossing the age bound, a mobile registered to
 *           someone else since). Fail with a clear code instead of writing a
 *           duplicate or an invalid value.
 *        b. re-run the ACTIVE-mobile uniqueness probe on the locked connection
 *        c. apply every key: tbl_user.mobile_no and/or the
 *           tbl_user_personal_details upsert
 *   4. UPDATE … SET status = ? … WHERE request_id = ? AND status = 'pending'
 *      — CONDITIONAL. affectedRows === 0 ⇒ 409 ALREADY_PROCESSED, which rolls
 *      back everything step 3 wrote. Redundant with the FOR UPDATE in step 1
 *      and kept anyway: it is the one check that still holds if this ever runs
 *      outside a transaction or under an isolation level that lets the row move.
 *   COMMIT
 *
 * Reject writes NOTHING but the status — the requested values are never applied
 * and the row keeps them so the user can see what was turned down.
 */
async function processRequest(requestId, { action, remarks }, actor, poolRef = pool) {
  const actorId = actor && Number.isFinite(Number(actor.user_id)) ? Number(actor.user_id) : null;
  const remarkVal = remarks != null && String(remarks).trim() !== ''
    ? String(remarks).trim() : null;
  logger.info('Process profile update request · requestId=' + requestId
    + ' action=' + action + ' actor=' + (actorId ?? '-'));

  const conn = await poolRef.getConnection();
  try {
    await conn.beginTransaction();

    const [[row]] = await conn.query(
      `SELECT request_id, user_id, changes, status
         FROM tbl_user_profile_update_request
        WHERE request_id = ? FOR UPDATE`,
      [Number(requestId)],
    );
    if (!row) throw mkErr(404, 'REQUEST_NOT_FOUND', 'Profile update request not found');
    if (String(row.status) !== 'pending') {
      throw mkErr(409, 'ALREADY_PROCESSED',
        `Request already ${row.status} — cannot reprocess`);
    }

    if (action === 'approve') {
      const stored = parseJson(row.changes);
      if (!stored) {
        throw mkErr(409, 'CHANGES_CORRUPT',
          'This request has no readable changes — reject it and ask the user to resubmit');
      }
      let changes;
      try {
        changes = normaliseChanges(stored);
      } catch (e) {
        // Valid when submitted, not valid now. Refuse the APPROVAL rather than
        // write the bad value; the approver rejects and the user resubmits.
        if (e.status === 400) {
          throw mkErr(409, 'CHANGES_INVALID_NOW',
            `This request can no longer be applied: ${e.message}`);
        }
        throw e;
      }
      if (changes.mobile_no) await assertMobileFree(changes.mobile_no, row.user_id, conn);
      await applyChanges(row.user_id, changes, conn);
    }

    const [flip] = await conn.query(
      `UPDATE tbl_user_profile_update_request
          SET status = ?, processed_on = ?, processed_by = ?, remarks = ?
        WHERE request_id = ? AND status = 'pending'`,
      [action === 'approve' ? 'approved' : 'rejected', new Date(), actorId,
        remarkVal, Number(requestId)],
    );
    if (!flip.affectedRows) {
      throw mkErr(409, 'ALREADY_PROCESSED',
        'Request was processed by someone else — reload the queue and retry');
    }

    await conn.commit();
    logger.info('Profile update request '
      + (action === 'approve' ? 'approved' : 'rejected') + ' · requestId=' + requestId);
  } catch (e) {
    await conn.rollback().catch(() => {});
    if (e.status) {
      logger.warn('Process profile update request rolled back · requestId=' + requestId
        + ' · ' + e.message);
    } else {
      logger.error('Process profile update request failed · requestId=' + requestId
        + ' · ' + e.message);
    }
    throw e;
  } finally {
    conn.release();
  }

  const [[updated]] = await poolRef.query(`${REQUEST_SELECT} WHERE r.request_id = ?`,
    [Number(requestId)]);
  return hydrate(updated);
}

module.exports = {
  submitChanges,
  withdrawRequest,
  listRequests,
  processRequest,
  normaliseChanges,
  FIELD_KEYS,
  REQUEST_STATUSES,
  MAX_PAGE_SIZE,
};
