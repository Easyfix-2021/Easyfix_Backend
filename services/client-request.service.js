'use strict';

const { pool } = require('../db');

/*
 * client-request.service — the two things a CLIENT can ask ops to do about a
 * job whose customer cannot be reached.
 *
 * Neither action changes the job. Per ops (2026-09-04) a client cannot cancel a
 * booking themselves: they RAISE A REQUEST and ops acts on it. So both actions
 * do the same two things — write a durable remark, and make that remark visible
 * to ops as a chip on My Orders -> Unconfirmed. Nothing here touches
 * job_status, and nothing here is destructive.
 *
 *   cancel  "please cancel this booking"     -> action_taken_reason type 1  (Cancel)
 *   retry   "please try the customer again"  -> action_taken_reason type 25 (Un Reachable)
 *
 * ── THE ROW IS IDENTIFIED BY enum_reason_id, NOT BY ITS TEXT ───────────────
 *
 * An earlier cut of this used an anchored prefix in `comments` as the
 * discriminator, on the assumption that "hardcode the wording" meant no seeded
 * reason rows existed to point at. That was the wrong tree: `enum_reason_id` is
 * a real FK on tbl_job_comment, the magic-link cancel/reschedule path already
 * stamps it (routes/public/job-completion.js), and seeding a reason bucket is a
 * one-file idempotent migration this repo has done before. Matching prose to
 * decide what a row MEANS is a last resort; this is not one.
 *
 * The ids are RESOLVED at write time from (action_type, user_type, action_desc)
 * rather than hardcoded as integers. action_taken_reason.id is AUTO_INCREMENT,
 * so it differs per environment — a literal that is right on QA is silently
 * wrong on Production, and the failure is a comment stamped with another
 * reason's id, which nothing would ever flag.
 *
 * ── WHY THE REMARK GOES TO tbl_job_comment, NOT tbl_job.remarks ────────────
 *
 * `tbl_job.remarks` is a single mutable column the NEXT comment overwrites
 * (job.service.js ~:482 says so). A client request written there would be
 * destroyed by the next remark from anyone — including on the client's own
 * screen, since the portal's job detail renders that column. Comment rows
 * persist.
 *
 * ── WHY commented_by IS NULL ───────────────────────────────────────────────
 *
 * `tbl_job_comment.commented_by` is a **tbl_user** FK; the read path joins
 * `LEFT JOIN tbl_user u ON u.user_id = c.commented_by`. A client SPOC is a
 * tbl_client_contacts row, a different id space.
 *
 * This is not a risk, it is a certainty. Both tables are AUTO_INCREMENT PKs
 * counting from 1, and tbl_user carries ~4,700 technician rows on top of staff,
 * so across the range actually in use EVERY contact id has a same-numbered user
 * row. The write would not error and would not render blank — it would resolve
 * to a real, named, innocent employee and attribute the client's remark to
 * them, with no symptom anywhere.
 *
 * So the column is omitted from the INSERT entirely, and the author rides in
 * job_escalated_by (text) the same way the escalation path carries
 * escalated_by_name.
 */

/** The two request kinds, as the API accepts them. */
const KINDS = ['cancel', 'retry'];

/*
 * tbl_job_comment.source_type — WHO wrote the row. Column confirmed on the
 * table by the legacy client-dashboard JPA entity
 * (ACD_APIs .../domain/JobComment.java, @Column(name = "source_type")); the new
 * backend has simply never written it.
 *
 * ⚠ IT IS NOT THE DISCRIMINATOR, and must never be the only test. source_type
 * is a CHANNEL label, and channel labels get shared across stacks: on tbl_job,
 * 'New Dashboard' is written by BOTH this portal and the legacy Angular
 * dashboard, which is indistinguishable in the DB and has already cost three
 * wrong turns. This literal is new and specific, so it is a good ORIGIN marker
 * — but what a row MEANS is carried by enum_reason_id, a real FK that no other
 * stack can collide with by choosing the same string.
 */
const SOURCE_TYPE = 'Client Dashboard - New';

/*
 * The seeded reason row each kind points at.
 *
 * user_type = 3 is CLIENT. Confirmed from services/reason-codes.js
 * (`DUE_TO_USER_TYPE.client = 3`), NOT from the comment at the top of
 * migrations/executed/2026-07-10-seed-reschedule-reasons-action-type-8.sql,
 * which still describes the pre-2026-07-14 mapping (1=Customer, 2=Client) that
 * was corrected precisely because it shifted three of the four parties. That
 * file is executed and frozen, so the stale comment stays; do not learn the
 * mapping from it.
 *
 * `desc` must match the seed migration EXACTLY — resolution is by description.
 */
const REASON = {
  cancel: { actionType: 1, userType: 3, desc: 'Cancellation requested by client' },
  retry: { actionType: 25, userType: 3, desc: 'Client asked to retry contacting the customer' },
};

/** The chip ops sees on My Orders -> Unconfirmed, per kind. */
const CHIP_LABEL = {
  cancel: 'Cancellation Requested',
  retry: 'Client → Retry',
};

/*
 * comment_on = 1, the generic lifecycle bucket.
 *
 * NOT a new enum value: `comment_on` is a LEGACY column the old Java CRM reads
 * and renders, so an unknown code is a rendering risk in an app this change
 * does not test. 1 is also what the magic-link mirror uses, and it deliberately
 * avoids 16/17, which carry a job_stage = 9 side-effect in addComment.
 */
const COMMENT_ON = 1;

/*
 * Resolved ids, cached per process after the first hit.
 *
 * Cached because every read of the Unconfirmed list needs them and they cannot
 * change without a migration. NOT cached on failure: a miss means the seed has
 * not run on this host yet, and caching that would keep the feature dark until
 * a restart even after the migration lands.
 */
let cachedIds = null;

async function reasonIds(db = pool) {
  if (cachedIds) return cachedIds;
  const out = {};
  for (const kind of KINDS) {
    const r = REASON[kind];
    const [[row]] = await db.query(
      `SELECT id FROM action_taken_reason
        WHERE action_type = ? AND user_type = ? AND action_desc = ?
          AND (status IS NULL OR status = 1)
        LIMIT 1`,
      [r.actionType, r.userType, r.desc],
    );
    if (!row) return null;          // seed not applied here — see above
    out[kind] = Number(row.id);
  }
  cachedIds = out;
  return out;
}

/**
 * The comment text. The reason row carries the MEANING; this carries the human
 * detail — who asked, and what they said.
 *
 * The author is in the text because no column can hold a client contact id
 * (see the header). Without it ops sees a request with no idea who asked.
 */
function buildComment(kind, { authorName, comment }) {
  const who = String(authorName || '').trim();
  const note = String(comment || '').trim();
  let out = REASON[kind].desc;
  if (who) out += ` (${who})`;
  if (note) out += `: ${note}`;
  return out;
}

/** Which kind an enum_reason_id represents, or null. */
function kindOfReasonId(ids, enumReasonId) {
  if (!ids || enumReasonId == null) return null;
  return KINDS.find((k) => ids[k] === Number(enumReasonId)) || null;
}

/**
 * Insert the request comment. Columns, and why each is what it is:
 *
 *   comments            the prefix + author + the client's own words
 *   source_type         SOURCE_TYPE — origin marker, never the discriminator
 *   comment_on          1, the lifecycle bucket the legacy CRM renders
 *   enum_reason_id      THE discriminator: which of the two requests this is
 *   created_on          NOW()
 *   job_stage           the job's status AT THE TIME, so ops can see what the
 *                       client was looking at when they asked
 *   job_escalated_by    the client contact's NAME — the only place an author
 *                       can go, because commented_by is a tbl_user FK and a
 *                       client SPOC is a tbl_client_contacts row. Writing the
 *                       contact id there would attribute the remark to
 *                       whichever EMPLOYEE holds that id, silently.
 *
 * commented_by is left out of the INSERT entirely rather than passed NULL, so
 * a future reader cannot mistake it for "we tried and had nothing".
 */
async function insertRequest(db, { jobId, kind, jobStatus, authorName, comment, reasonId }) {
  const [r] = await db.query(
    `INSERT INTO tbl_job_comment
       (job_id, comments, source_type, comment_on, enum_reason_id, created_on, job_stage, job_escalated_by)
     VALUES (?, ?, ?, ?, ?, NOW(), ?, ?)`,
    [jobId, buildComment(kind, { authorName, comment }), SOURCE_TYPE, COMMENT_ON,
     reasonId, jobStatus ?? null, String(authorName || '').trim() || null],
  );
  return r.insertId;
}

module.exports = {
  KINDS, REASON, CHIP_LABEL, COMMENT_ON, SOURCE_TYPE,
  reasonIds, buildComment, kindOfReasonId, insertRequest,
};
