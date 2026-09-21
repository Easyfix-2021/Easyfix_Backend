/*
 * services/job-share-delegation.service.js — a technician DELEGATES a job.
 *
 * The job never changes hands in the DB: tbl_job.fk_easyfixter_id stays on the
 * ORIGINAL technician for the whole life of the share. What changes is WHO may
 * act on it. While a share is live:
 *
 *   · the original technician is read-only on /mobile/jobs/<id>/*  — he may
 *     only cancel the share, and only before the delegate starts,
 *   · the delegate acts on the job as though he owned it.
 *
 * The lock itself lives in middleware/require-tech-lifecycle-capability.js —
 * the single choke point every /jobs mutation already passes through. This file
 * owns the RECORD and the STATE MACHINE; it decides nothing about routes.
 *
 * ── THE STATE MACHINE ──
 *   LIVE      pending → accepted → started
 *   TERMINAL  rejected · cancelled · expired · completed · handed_back · released
 *
 * Expressed once, as a table (TRANSITIONS below), because the alternative —
 * an `if` per call site — is how the sixth caller ends up permitting a seventh
 * transition nobody designed. Every mutation in this file goes through
 * `applyTransition`, and `applyTransition` refuses anything not in the table.
 *
 * ── AT MOST ONE LIVE SHARE PER JOB ──
 * Enforced in the DB by a UNIQUE index over a generated `live_job_id` column
 * (migrations/2026-09-10-job-share-delegation.sql), NOT by the read-then-insert
 * below. The read is the friendly error; the index is the guarantee. A racing
 * second INSERT surfaces as ER_DUP_ENTRY and is mapped to the same 409.
 *
 * ── THE CONTACT DELEGATE (2026-09-21) ──
 * A share to a plain phone number (`contact_number`, no delegate_efr_id) is
 * worked from a web copy of the technician app, reached by the WhatsApp link.
 * The contact proves the phone with an OTP and gets a guest session scoped to
 * this one job — services/job-share-guest.service.js.
 *
 * ── HOW A SHARE ENDS ──
 * Only three ways, by the owner's rule: the sharer cancels (before work
 * starts), the delegate COMPLETES the job, or ops revokes it from the CRM.
 * "Can't Complete Today" keeps it live — the same delegate returns for the
 * next visit — and there is no time-based expiry (the TTL sweep was removed).
 */

const { pool } = require('../db');
const logger = require('../logger');

/* Live = the original is locked out. Terminal = the job is his again (or the
 * delegate finished it). This list is the code half of the CASE expression in
 * the migration's generated column; change one and you must change the other. */
const LIVE_STATUSES = Object.freeze(['pending', 'accepted', 'started']);
const LIVE_SET = new Set(LIVE_STATUSES);

/*
 * The whole state machine. `from → Set(legal to)`. A terminal status maps to an
 * EMPTY set rather than being absent, so an unknown status read from a row is
 * distinguishable from a known-terminal one (the former throws, the latter
 * refuses cleanly).
 */
const TRANSITIONS = Object.freeze({
  pending:     new Set(['accepted', 'rejected', 'cancelled', 'expired', 'released']),
  accepted:    new Set(['started', 'cancelled', 'expired', 'released']),
  started:     new Set(['completed', 'handed_back', 'released']),
  rejected:    new Set(),
  cancelled:   new Set(),
  expired:     new Set(),
  completed:   new Set(),
  handed_back: new Set(),
  released:    new Set(),
});

/* Statuses that end the share. Derived, never listed twice. */
const TERMINAL_STATUSES = Object.freeze(
  Object.keys(TRANSITIONS).filter((s) => !LIVE_SET.has(s)),
);

/* A job in one of these is finished — nothing left to delegate. Mirrors
 * job.service STATUS COMPLETED(3) / COMPLETED_ALT(5) / CANCELLED(6); imported
 * rather than retyped so a status renumber cannot silently diverge. */
const { STATUS, delegationColsExist } = require('./job.service');
const NON_SHAREABLE_JOB_STATUSES = new Set([
  STATUS.COMPLETED, STATUS.COMPLETED_ALT, STATUS.CANCELLED,
]);

function err(status, message, details) {
  const e = new Error(message);
  e.status = status;
  if (details) e.details = details;
  return e;
}

/* One projection for every read, so the API shape can never depend on which
 * function fetched the row. */
const SHARE_SELECT = `
  SELECT s.share_id, s.job_id, s.fk_easyfixer_id, s.delegate_efr_id,
         s.contact_name, s.contact_number, s.status,
         s.created_on, s.responded_on, s.started_on, s.ended_on, s.end_reason,
         sharer.efr_name   AS sharer_name,
         delegate.efr_name AS delegate_name,
         delegate.efr_no   AS delegate_no
    FROM tbl_job_share_link s
    LEFT JOIN tbl_easyfixer sharer   ON sharer.efr_id   = s.fk_easyfixer_id
    LEFT JOIN tbl_easyfixer delegate ON delegate.efr_id = s.delegate_efr_id`;

/*
 * The `share` JSON. Used VERBATIM by the technician app and by the CRM, so the
 * field names here are a cross-repo contract — renaming one is a breaking
 * change in three repositories.
 *
 * canCancel is viewer-dependent by design: it answers "may the person reading
 * this response press Cancel?", which is the only question the button needs.
 */
function toShareJson(row, viewerEfrId = null) {
  if (!row) return null;
  const viewer = viewerEfrId == null ? null : Number(viewerEfrId);
  return {
    id: row.share_id,
    jobId: row.job_id,
    status: row.status,
    sharedByEfrId: row.fk_easyfixer_id,
    sharedByName: row.sharer_name || null,
    delegateEfrId: row.delegate_efr_id == null ? null : Number(row.delegate_efr_id),
    delegateName: row.delegate_name || row.contact_name || null,
    delegateNumber: row.delegate_no || row.contact_number || null,
    createdOn: row.created_on || null,
    respondedOn: row.responded_on || null,
    startedOn: row.started_on || null,
    endedOn: row.ended_on || null,
    endReason: row.end_reason || null,
    canCancel: viewer != null
      && Number(row.fk_easyfixer_id) === viewer
      && (row.status === 'pending' || row.status === 'accepted'),
  };
}

/* The one live share on a job, or null. `runner` lets a caller pass a
 * transaction connection; defaults to the pool.
 *
 * Null too on a DB the delegation migration has not reached: no share can
 * exist there, and SHARE_SELECT would 500 every read that funnels through here
 * — GET /mobile/jobs/:id/share (the app fires it on every open order), the
 * non-owner GET /mobile/jobs/:id, accept/reject/cancel, the CRM release. Same
 * probe list() gates on, so the two cannot disagree. */
async function findLiveShare(jobId, runner = pool) {
  if (!(await delegationColsExist())) return null;
  const [[row]] = await runner.query(
    `${SHARE_SELECT} WHERE s.job_id = ? AND s.status IN (?, ?, ?) LIMIT 1`,
    [jobId, ...LIVE_STATUSES],
  );
  return row || null;
}

async function findShareById(shareId, runner = pool) {
  const [[row]] = await runner.query(`${SHARE_SELECT} WHERE s.share_id = ? LIMIT 1`, [shareId]);
  return row || null;
}

/*
 * THE ONLY WRITE PATH for a status change.
 *
 * Refuses anything the table does not permit, then applies it with a
 * CONDITIONAL update pinned to the status it just validated. The condition is
 * what makes two concurrent callers safe: the loser's UPDATE matches 0 rows and
 * is reported as a conflict rather than silently overwriting the winner. That
 * matters here specifically — the original cancelling and the delegate starting
 * are a genuine race, and they are on opposite phones.
 */
async function applyTransition(share, to, { endReason = null, runner = pool } = {}) {
  const from = String(share.status || '');
  const legal = TRANSITIONS[from];
  if (!legal) throw err(500, `unknown share status "${from}"`);
  if (!legal.has(to)) {
    throw err(409, `this share is ${from} — it cannot become ${to}`, {
      code: 'share_transition_refused', from, to,
    });
  }

  const sets = ['status = ?'];
  const params = [to];
  const now = new Date();
  if (to === 'accepted' || to === 'rejected') { sets.push('responded_on = ?'); params.push(now); }
  if (to === 'started') { sets.push('started_on = ?'); params.push(now); }
  if (TERMINAL_STATUSES.includes(to)) { sets.push('ended_on = ?'); params.push(now); }
  if (endReason != null) { sets.push('end_reason = ?'); params.push(String(endReason).slice(0, 32)); }
  params.push(share.share_id, from);

  const [res] = await runner.query(
    `UPDATE tbl_job_share_link SET ${sets.join(', ')} WHERE share_id = ? AND status = ?`,
    params,
  );
  if (res.affectedRows !== 1) {
    throw err(409, 'this share was just changed from another device — reload and try again', {
      code: 'share_conflict', from, to,
    });
  }
  logger.info(`Job share ${share.share_id} · ${from} → ${to} · jobId=${share.job_id}`);
  return findShareById(share.share_id, runner);
}

/* ─── Create ──────────────────────────────────────────────────────── */

/*
 * The sharer must own a LIVE job. Any technician may share — there is no
 * allowlist. A delegate technician must exist, be active, and not be the
 * sharer himself.
 *
 * 404 (not 403) when the job is not his: an ownership failure must not confirm
 * that a job id exists, matching every other /mobile/jobs ownership check.
 */
async function createShare(jobId, sharerEfrId, { delegateEfrId = null, contactName = null, contactNumber = null } = {}) {
  if (delegateEfrId == null && !contactNumber) {
    throw err(400, 'Choose a technician or enter a contact number.', { code: 'share_no_delegate' });
  }

  const [[job]] = await pool.query(
    'SELECT job_id, job_status, fk_easyfixter_id FROM tbl_job WHERE job_id = ? LIMIT 1',
    [jobId],
  );
  if (!job || Number(job.fk_easyfixter_id) !== Number(sharerEfrId)) {
    throw err(404, 'job not found');
  }
  if (NON_SHAREABLE_JOB_STATUSES.has(Number(job.job_status))) {
    throw err(409, 'This job is already closed — it cannot be shared.', { code: 'job_not_live' });
  }

  if (delegateEfrId != null) {
    if (Number(delegateEfrId) === Number(sharerEfrId)) {
      throw err(400, 'You cannot share a job with yourself.', { code: 'share_self' });
    }
    const [[delegate]] = await pool.query(
      'SELECT efr_id, efr_status FROM tbl_easyfixer WHERE efr_id = ? LIMIT 1',
      [delegateEfrId],
    );
    if (!delegate || Number(delegate.efr_status) !== 1) {
      throw err(422, 'That technician is not available to take this job.', { code: 'delegate_unavailable' });
    }
  }

  const existing = await findLiveShare(jobId);
  if (existing) {
    throw err(409, 'This job is already shared.',
      // NOT `job_shared` — that code means "you are the original and the lock
      // is refusing you". This is the create conflict: somebody already holds
      // this job. Sharing one code between them puts the caller back on a
      // generic message, which is the defect the codes exist to remove.
      { code: 'already_shared', shareStatus: existing.status });
  }

  try {
    const [res] = await pool.query(
      `INSERT INTO tbl_job_share_link
         (job_id, fk_easyfixer_id, delegate_efr_id, contact_name, contact_number, status, created_on)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      [
        jobId, sharerEfrId, delegateEfrId,
        contactName ? String(contactName).slice(0, 150) : null,
        contactNumber ? String(contactNumber).slice(0, 15) : null,
        new Date(),
      ],
    );
    logger.info(`Job share created · jobId=${jobId} · by=${sharerEfrId} · delegate=${delegateEfrId || contactNumber}`);
    return toShareJson(await findShareById(res.insertId), sharerEfrId);
  } catch (e) {
    // The unique live index is the real guarantee; this is the second racer.
    if (e && e.code === 'ER_DUP_ENTRY') {
      throw err(409, 'This job is already shared.',
        // The DB got there first: the unique live-share index rejected the
        // second INSERT. Same meaning as the check above, same code.
        { code: 'already_shared' });
    }
    throw e;
  }
}

/*
 * WhatsApp to the person the job was shared with — a team technician (his
 * efr_no) or a typed/picked contact (contact_number). Without it a contact
 * share is a dead end: the sharer is locked out and the delegate never hears.
 *
 * Best-effort and AFTER the insert, like the supply-gap send: a failed message
 * never undoes a saved share; the outcome is returned so the app can tell the
 * sharer to call instead. Only job-level facts go out (service, area, slot) —
 * never the customer's name, phone or street address, because the number is
 * whatever the technician typed.
 *
 * `job_shared_contact` must match the Gallabox template name exactly, and
 * bodyValues keys must match its {{variables}}. `link` is a plain URL in the
 * BODY (not a URL button) so the contact can reopen it as often as the job
 * needs — start work today, add materials tomorrow.
 */
const SHARE_TEMPLATE = 'job_shared_contact';

function istSlot(value) {
  if (!value) return 'To be confirmed';
  const d = value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}+05:30`);
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d);
}

/*
 * The job-level facts a share recipient may see before (and in) the WhatsApp:
 * service, area, slot, and the sharer's own number. Deliberately NOT the
 * customer's name, phone or street address.
 */
async function shareJobFacts(share) {
  const [[r]] = await pool.query(
    `SELECT j.job_id, COALESCE(j.scheduled_date_time, j.requested_date_time) AS slot,
            sc.service_catg_name, ad.locality, ad.pin_code, ci.city_name,
            sharer.efr_no AS sharer_no
       FROM tbl_job j
       LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = j.fk_service_catg_id
       LEFT JOIN tbl_address ad ON ad.address_id = j.fk_address_id
       LEFT JOIN tbl_city ci ON ci.city_id = ad.city_id
       LEFT JOIN tbl_easyfixer sharer ON sharer.efr_id = ?
      WHERE j.job_id = ?
      LIMIT 1`,
    [share.sharedByEfrId, share.jobId],
  );
  if (!r) return null;
  const area = [r.locality, r.city_name].filter(Boolean).join(', ')
    + (r.pin_code ? ` - ${r.pin_code}` : '');
  return {
    jobId: Number(r.job_id),
    service: r.service_catg_name || 'Service job',
    area: area || 'Shared on call',
    schedule: istSlot(r.slot),
    sharerMobile: r.sharer_no ? String(r.sharer_no) : '',
  };
}

async function notifyShareRecipient(share, link) {
  const to = share && share.delegateNumber;
  if (!to) return { sent: false, reason: 'no recipient number' };
  try {
    const facts = await shareJobFacts(share);
    if (!facts) return { sent: false, reason: 'job not found' };
    const gallabox = require('./gallabox.whatsapp.service');
    const result = await gallabox.sendTemplate({
      to,
      recipientName: share.delegateName || undefined,
      templateName: SHARE_TEMPLATE,
      bodyValues: {
        contact_name: share.delegateName || 'there',
        sharer_name: share.sharedByName || 'An EasyFix technician',
        sharer_mobile: facts.sharerMobile,
        job_id: String(facts.jobId),
        service: facts.service,
        area: facts.area,
        schedule: facts.schedule,
        link: link || '',
      },
    });
    const sent = Boolean(result && result.delivered);
    logger.info(`Job share WhatsApp · shareId=${share.id} · jobId=${share.jobId} · sent=${sent}`);
    return { sent, reason: sent ? null : (result?.error || (result?.disabled ? 'notifications disabled' : 'not delivered')) };
  } catch (e) {
    logger.warn(`Job share WhatsApp failed · shareId=${share.id} · ${e.message}`);
    return { sent: false, reason: e.message };
  }
}

/* ─── The five party-driven transitions ───────────────────────────── */

async function requireLiveShare(jobId) {
  const share = await findLiveShare(jobId);
  if (!share) throw err(404, 'This job is not shared.', { code: 'share_not_found' });
  return share;
}

/* Original only, pending|accepted only — the table enforces the second half. */
async function cancelShare(jobId, sharerEfrId) {
  const share = await requireLiveShare(jobId);
  if (Number(share.fk_easyfixer_id) !== Number(sharerEfrId)) throw err(404, 'This job is not shared.');
  return toShareJson(await applyTransition(share, 'cancelled', { endReason: 'sharer_cancelled' }), sharerEfrId);
}

/* Delegate only, pending only. */
async function acceptShare(jobId, delegateEfrId) {
  const share = await requireLiveShare(jobId);
  if (Number(share.delegate_efr_id) !== Number(delegateEfrId)) throw err(404, 'This job is not shared with you.');
  return toShareJson(await applyTransition(share, 'accepted'), delegateEfrId);
}

/*
 * A CONTACT share (no delegate technician) is accepted by the contact proving
 * the phone with the OTP (services/job-share-guest.service.js) — there is no
 * Accept button for someone without the app. Pending → accepted; already
 * accepted/started is a no-op so a second device's verify is not a conflict.
 */
async function acceptByContact(shareId) {
  const share = await findShareById(shareId);
  if (!share || !LIVE_SET.has(share.status)) {
    throw err(410, 'This job is no longer shared with you.', { code: 'share_ended' });
  }
  if (share.status !== 'pending') return share;
  return applyTransition(share, 'accepted');
}

/* Delegate only, pending only. The job returns to the original technician —
 * which needs no write, because it never left him. */
async function rejectShare(jobId, delegateEfrId, reason = null) {
  const share = await requireLiveShare(jobId);
  if (Number(share.delegate_efr_id) !== Number(delegateEfrId)) throw err(404, 'This job is not shared with you.');
  return toShareJson(await applyTransition(share, 'rejected', { endReason: reason || 'delegate_rejected' }), delegateEfrId);
}

/*
 * The delegate touched the job — the cancel window closes NOW.
 *
 * Called from the lock middleware on the delegate's first mutating request, so
 * "began work" means the same thing for start-work, an estimate and a
 * permission request without three separate hooks. Idempotent: `accepted` is
 * the only status the table lets become `started`, so a second call is a no-op
 * conflict which the caller swallows.
 */
async function markStarted(share) {
  return applyTransition(share, 'started');
}

/*
 * The delegate finished (or could not finish today). Called from the checkout
 * route, which already knows which of the two happened.
 */
async function closeForJobOutcome(jobId, outcome) {
  const share = await findLiveShare(jobId);
  if (!share || share.status !== 'started') return null;
  return toShareJson(await applyTransition(share, outcome, { endReason: outcome }));
}

/* Ops force-release from the CRM. Legal from every live status — that is the
 * point of it: it is the only exit once the delegate has started. */
async function releaseShare(jobId, { userId = null } = {}) {
  const share = await requireLiveShare(jobId);
  logger.info(`Job share released by ops · jobId=${jobId} · shareId=${share.share_id} · userId=${userId ?? '-'}`);
  return toShareJson(await applyTransition(share, 'released', { endReason: 'ops_released' }));
}

/* ─── Reads ───────────────────────────────────────────────────────── */

/*
 * The live share on a job, as seen by `viewerEfrId` — but only if he is one of
 * the two parties. A stranger gets null rather than 403: whether a job is
 * delegated is not his business, and a distinguishable answer would leak it.
 */
async function getShareForViewer(jobId, viewerEfrId) {
  const share = await findLiveShare(jobId);
  if (!share) return null;
  const viewer = Number(viewerEfrId);
  const isParty = Number(share.fk_easyfixter_id) === viewer
    || Number(share.delegate_efr_id) === viewer;
  return isParty ? toShareJson(share, viewer) : null;
}

/*
 * The lock's one question, in one indexed query: for THIS job, is there a live
 * share, and what is the caller to it? Returns null when the job is not shared,
 * so the caller can fall straight through to the existing behaviour.
 */
async function resolveLock(jobId, efrId) {
  const share = await findLiveShare(jobId);
  if (!share) return null;
  const viewer = Number(efrId);
  return {
    share,
    status: share.status,
    isSharer: Number(share.fk_easyfixer_id) === viewer,
    isDelegate: Number(share.delegate_efr_id) === viewer,
  };
}

module.exports = {
  LIVE_STATUSES,
  TERMINAL_STATUSES,
  TRANSITIONS,
  toShareJson,
  findLiveShare,
  createShare,
  acceptByContact,
  findShareById,
  notifyShareRecipient,
  shareJobFacts,
  SHARE_TEMPLATE,
  cancelShare,
  acceptShare,
  rejectShare,
  markStarted,
  closeForJobOutcome,
  releaseShare,
  getShareForViewer,
  resolveLock,
};
