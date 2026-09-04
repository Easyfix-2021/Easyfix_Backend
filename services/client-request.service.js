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


/* ── Unconfirmed-page sections ─────────────────────────────────────────────
 *
 * My Orders -> Unconfirmed is one page split into five sections. EVERY job
 * lands in EXACTLY ONE — ops asked for no overlap, so this is a precedence
 * chain, not five independent filters. A job listed twice reads as two jobs,
 * and the section counts stop summing to the tab count.
 *
 * PRECEDENCE (membership), which is NOT the display order:
 *   1. actioned_by_client   the client has asked for something — that is the
 *                           newest fact about the job and needs ops
 *   2. pending_with_client  ops asked the client and is waiting
 *   3. by appointment date  everything else
 *
 * The conversation sections win because a job blocked on a person is not
 * usefully filed under a date. The DISPLAY order ops chose is
 * actioned -> overdue -> upcoming -> future -> pending, and the page lets them
 * drag it; that is a view concern and lives in the CRM.
 *
 * A job with NO appointment date goes to `future_unscheduled` (ops decision) —
 * hence the section's name. Being Unconfirmed is often exactly why no date
 * exists yet, so these are numerous, and dropping them would silently shrink
 * the page.
 */
const SECTIONS = ['actioned_by_client', 'overdue', 'upcoming', 'future_unscheduled', 'pending_with_client'];

/** Display order + labels. The CRM may reorder; these are the defaults. */
const SECTION_META = [
  { key: 'actioned_by_client', label: 'Actioned By Client' },
  { key: 'overdue', label: 'Overdue Jobs' },
  { key: 'upcoming', label: 'Upcoming Jobs' },
  { key: 'future_unscheduled', label: 'Future & Unscheduled Jobs' },
  { key: 'pending_with_client', label: 'Pending Action from Client' },
];

/**
 * Which section a job belongs to. Pure, so it is testable without a DB.
 *
 * `today` is passed in rather than read from the clock so a test can pin it and
 * so every row in one response is classified against the SAME day — a request
 * that straddles midnight would otherwise put two identical jobs in different
 * sections.
 *
 * Dates are compared as IST CALENDAR DAYS, not as instants: "tomorrow" means
 * the date ops would read off the row, and an appointment at 23:00 tonight is
 * today's problem, not tomorrow's.
 */
function sectionFor({ hasClientRequest, hasUnreachableOutcome, appointmentYmd }, todayYmd) {
  if (hasClientRequest) return 'actioned_by_client';
  if (hasUnreachableOutcome) return 'pending_with_client';
  if (!appointmentYmd) return 'future_unscheduled';
  if (appointmentYmd < todayYmd) return 'overdue';
  const t = new Date(`${todayYmd}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  const tomorrowYmd = t.toISOString().slice(0, 10);
  if (appointmentYmd === todayYmd || appointmentYmd === tomorrowYmd) return 'upcoming';
  return 'future_unscheduled';
}

/**
 * Classify a page of Unconfirmed job ids in ONE round trip.
 *
 * Two aggregates over tbl_job_comment rather than a query per job: the page
 * shows up to a few hundred rows and a per-row lookup is the N+1 this codebase
 * keeps being bitten by.
 */
async function sectionsFor(db, jobIds, todayYmd) {
  const ids = [...new Set((jobIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return {};
  const reasons = await reasonIds(db);
  const marks = new Map(ids.map((id) => [id, { hasClientRequest: false, hasUnreachableOutcome: false, appointmentYmd: null }]));

  const ph = ids.map(() => '?').join(',');
  const [rows] = await db.query(
    `SELECT j.job_id,
            DATE_FORMAT(j.requested_date_time, '%Y-%m-%d') AS appt_ymd,
            MAX(c.comment_on = 16)                     AS unreachable,
            MAX(${reasons ? 'c.enum_reason_id IN (?, ?)' : '0'}) AS client_req
       FROM tbl_job j
       LEFT JOIN tbl_job_comment c ON c.job_id = j.job_id
      WHERE j.job_id IN (${ph})
      GROUP BY j.job_id, appt_ymd`,
    reasons ? [reasons.cancel, reasons.retry, ...ids] : ids,
  );
  for (const r of rows) {
    marks.set(Number(r.job_id), {
      hasClientRequest: !!Number(r.client_req),
      hasUnreachableOutcome: !!Number(r.unreachable),
      appointmentYmd: r.appt_ymd || null,
    });
  }
  const out = {};
  for (const [id, m] of marks) out[id] = sectionFor(m, todayYmd);
  return out;
}


/*
 * The same five sections, as SQL.
 *
 * ⚠ THIS IS A SECOND EXPRESSION OF sectionFor's RULE, and that is the whole
 * risk in this file. The classifier answers for a page of ids the browser
 * already has; this answers for a paged, searched, sorted query the browser has
 * not fetched yet. Neither can be derived from the other — one is JavaScript
 * over rows, the other is a WHERE clause the database evaluates — so they are
 * pinned together by a test that runs BOTH over the same fixture and asserts
 * they agree, row for row. If you change one, that test fails until you change
 * the other. Do not "simplify" it by deleting one side.
 *
 * PRECEDENCE IS ENCODED AS MUTUAL EXCLUSION. sectionFor gets it free from an
 * if-chain; SQL has no such ordering, so each date bucket must NOT-EXISTS its
 * way past the two conversation sections explicitly. Miss one of those and a
 * client-actioned job appears in TWO sections — the exact thing ops ruled out,
 * and the counts stop summing to the tab total.
 *
 * DATES ARE IST CALENDAR DAYS. The pool runs at +05:30, so CURDATE() is the
 * date ops reads off the row. Comparing DATE(j.requested_date_time) rather than
 * the datetime keeps "tomorrow" meaning tomorrow's date rather than a moment
 * 24 hours out — an appointment at 23:00 tonight is today's problem.
 */
function sectionPredicate(section, ids) {
  const alias = 'j';
  /*
   * A client request is identified by enum_reason_id, never by comment text.
   * With no seeded ids (migration not run on this host) the subquery must match
   * NOTHING rather than everything: `IN (0, 0)` is empty, so every job falls
   * through to the date buckets and nothing is silently mis-filed as actioned.
   */
  const reqIds = ids ? [ids.cancel, ids.retry] : [0, 0];
  const hasRequest = `EXISTS (SELECT 1 FROM tbl_job_comment rq
       WHERE rq.job_id = ${alias}.job_id AND rq.enum_reason_id IN (?, ?))`;
  const hasUnreachable = `EXISTS (SELECT 1 FROM tbl_job_comment ur
       WHERE ur.job_id = ${alias}.job_id AND ur.comment_on = 16)`;
  // Not in either conversation section — the precondition every date bucket shares.
  const noConversation = `NOT ${hasRequest} AND NOT ${hasUnreachable}`;
  const appt = `DATE(${alias}.requested_date_time)`;

  switch (section) {
    case 'actioned_by_client':
      return { sql: hasRequest, params: [...reqIds] };
    case 'pending_with_client':
      return { sql: `NOT ${hasRequest} AND ${hasUnreachable}`, params: [...reqIds] };
    case 'overdue':
      return { sql: `${noConversation} AND ${appt} IS NOT NULL AND ${appt} < CURDATE()`,
        params: [...reqIds] };
    case 'upcoming':
      return { sql: `${noConversation} AND ${appt} IN (CURDATE(), DATE_ADD(CURDATE(), INTERVAL 1 DAY))`,
        params: [...reqIds] };
    case 'future_unscheduled':
      /*
       * The NULL branch is why this section is named for both. Being Unconfirmed
       * is frequently the reason no appointment exists yet, so these are
       * numerous — and a bucket set that omitted them would drop those jobs off
       * the page with nothing reporting it.
       */
      return { sql: `${noConversation} AND (${appt} IS NULL OR ${appt} > DATE_ADD(CURDATE(), INTERVAL 1 DAY))`,
        params: [...reqIds] };
    default:
      return null;
  }
}

module.exports = {
  KINDS, REASON, CHIP_LABEL, COMMENT_ON, SOURCE_TYPE, SECTIONS, SECTION_META,
  reasonIds, buildComment, kindOfReasonId, insertRequest, sectionFor, sectionsFor,
  sectionPredicate,
};
