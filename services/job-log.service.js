const { pool } = require('../db');
const logger = require('../logger');

/*
 * services/job-log.service.js — the new backend's writer for tbl_job_logs, the
 * platform's 1.7-million-row job-history archive.
 *
 * WHY THIS EXISTS
 * ───────────────
 * tbl_job_logs has been written since 2015 by the legacy Java stack ONLY — the
 * old CRM (EasyFix_CRM JobDaoImpl), the old public API (EasyFix_API
 * JobsResource / JobDAO) and ACD_APIs. The new backend did not know the table
 * existed: zero references in any .js or .sql, and it was absent from
 * scripts/schema-verify.js, which is precisely why a source-level survey could
 * not see it. As work moves onto the new CRM the archive stops growing, and at
 * cut-over it becomes a dead file rather than a job's history.
 *
 * So this module writes the SAME table with the SAME conventions, so a reader
 * joining old rows to new ones sees ONE history and not two vocabularies.
 *
 * ── THE VOCABULARY (measured against the live table, 2026-08-20) ────────────
 * Eleven log_for values exist. Six of them died in 2023-24 with the writers
 * that produced them ('checkin', 'reject', 'Requested For ETA', 'Requested
 * Date/time Change', 'Expected Date/time Change', 'job Desc') and are NOT
 * resurrected here — a dead event with a new writer is a lie about history.
 * Five are still being written today, and they are exactly the events the new
 * CRM is taking over, so they are the five this module continues:
 *
 *   log_for              new_data              old_data                       eta_status
 *   'new job'            'New Job_<jobId>'     NULL                           '01'
 *   'schedule'           'schedule_<jobId>'    NULL                           '1'
 *   'checkout'           'checkOut_<jobId>'    NULL                           '3'
 *   'Re-Scheduling'      'Efr_id: <new>'       'Efr_id: <old> Sched_by: ...'  NULL
 *   'Re-visit Required'  'revisit_<jobId>'     the revisit reason             '01'
 *
 * Every one of those strings is byte-for-byte what production holds — including
 * the two mixed-case oddities that a "tidy-up" would silently break:
 *
 *   • log_for is the event name LOWERCASED but new_data keeps the ORIGINAL
 *     casing of the same token. Legacy does this in one line
 *     (JobDaoImpl.savejobStatusInlog: `flag.toLowerCase()` for log_for,
 *     `flag + "_" + jobId` for new_data), which is how 'checkout' ends up
 *     paired with 'checkOut_481851' and 'new job' with 'New Job_482393'.
 *   • 'Re-Scheduling' and 'Re-visit Required' are NOT lowercased at all.
 *
 * eta_status is likewise per-event, not a constant. The '01' in the legacy
 * create path is the NEW-JOB code, and copying it onto every event would
 * corrupt a column that reports read: on the live table, 100% of 'schedule'
 * rows written by the CRM carry '1', 100% of 'checkout' rows carry '3', and
 * 'Re-Scheduling' carries NULL. (The rows with a NULL eta_status on those two
 * events are the old API writer's, exactly and only — schedule NULL count ==
 * schedule changed_by=54 count, same for checkout. The CRM stamps it; the API
 * never did. This module is the CRM, so it stamps it.)
 *
 * ── THE NEW EVENTS ──────────────────────────────────────────────────────────
 * The new CRM does something the legacy stack never logged: a general STATUS
 * TRANSITION. setStatus() moves a job between any two of thirteen states, and
 * of those only CANCELLED leaves a dated row anywhere (tbl_job.cancel_*). That
 * gap gets its OWN log_for — 'status change' — rather than being smuggled into
 * an existing value. Overloading 'schedule' or 'checkout' to also mean "some
 * status moved" would retroactively change what a decade of rows means.
 * old_data / new_data carry the before and after.
 *
 * Two more joined it when the customer PIN (tbl_job.otp) moved from gating job
 * START to gating job CLOSE — 'customer pin resent' and 'completed without
 * customer pin'. Both name an OPS action that sits outside that gate, and
 * neither had any home in job history before (the first wrote an application
 * log line only; the second was indistinguishable from an ordinary ops close).
 * Same reasoning as 'status change': a new fact gets a new log_for.
 *
 * ADDING A log_for IS SAFE FOR THE LEGACY STACK, and that was checked rather
 * than assumed. tbl_job_logs is written by three legacy writers but READ by
 * exactly one code path: EasyFix_CRM JobsLogDaoImpl.getRescheduledReasonByJobId,
 * which filters `log_for like '<value>'` and whose only two live callers
 * (JobAction.java:1142 and :2355) pass the literal "Re-visit Required". A row
 * whose log_for is neither of those is never selected, so it cannot be rendered
 * as anything — least of all as a reschedule reason. (The DAO does skip the
 * filter when status is null/empty and then takes the job's LATEST row, which
 * WOULD be reachable; no caller does that, and getRescheduledReasonByJobId1,
 * the Criteria variant, has no callers at all.) EasyFix_API's JobsLogDAO and
 * ACD_APIs' JobLogsRepository only ever persist. Every column is a plain
 * varchar/tinytext on both sides — the Hibernate entities map log_for,
 * old_data, new_data and comments to String — so there is no enum, lookup or
 * check constraint for a new value to violate.
 *
 * ── changed_by: ONE NAMESPACE, NO EXCEPTIONS ────────────────────────────────
 * See ACTOR_RULE below. This is the part most likely to be got wrong, because
 * the actor object arriving here already carries two namespaces in one slot.
 *
 * ── FAIL-SOFT, AND OUTSIDE THE CALLER'S TRANSACTION ─────────────────────────
 * Every function swallows its own errors and returns instead of throwing: a
 * history row is worth strictly less than the mutation that produced it, and a
 * job that cannot be created because its log row failed is a far worse bug than
 * a missing log row. The legacy CRM made the same call (its insert sits inside
 * a try/catch that only logs); so does services/plivo-call-log.service.js
 * record() in this repo.
 *
 * Fail-soft is only REAL if the write cannot poison the caller, so every insert
 * here goes through the shared `pool` — never the caller's transaction
 * connection — and callers invoke it AFTER their COMMIT. Inside an open
 * transaction a failed statement can leave the transaction in an aborted state,
 * and a deadlock victim rolls back the whole thing: the catch would swallow the
 * error while the job creation it was logging silently vanished. setStatus()
 * already reasons this way about its post-cancel offer expiry ("NOT
 * transactional, deliberately"). The cost is that a process death between
 * COMMIT and INSERT loses one history row; that is the correct trade against
 * losing the job.
 */

/*
 * ACTOR_RULE — what changed_by is allowed to contain.
 *
 * changed_by is a tbl_user.user_id and NOTHING else. A reader must be able to
 * join it straight to tbl_user without first asking which kind of id this
 * particular row happens to hold.
 *
 * That rule needs defending, because the actor object reaching job.service.js
 * ALREADY mixes two namespaces in the `user_id` slot:
 *   routes/admin/jobs.js          → req.user, a real tbl_user id
 *   routes/integration/v1/index.js→ { user_id: null }, no actor at all
 *   routes/mobile/* + services/mobile-job-lifecycle.js
 *                                 → { user_id: <efr_id> }, a tbl_easyfixer id
 *                                   sitting in a slot every reader treats as a
 *                                   tbl_user id
 * The same defect is already live on tbl_job.cancel_by, tbl_job.fk_checkout_by
 * and tbl_job_comment.commented_by, and was just fixed in the Call Tracking
 * report (CALLER_NAME) where one column held two namespaces. A LOG is made of
 * actor attributions, so it is the last place to repeat it.
 *
 * So: technicians never appear in changed_by, and the two are never confusable.
 *
 *   CRM user     → changed_by = the tbl_user id   · comments 'Changed by New CRM'
 *   technician   → changed_by = NO_CRM_USER (0)   · comments 'Changed by New CRM App (efr:N)'
 *   no actor     → changed_by = NO_CRM_USER (0)   · comments 'Changed by New CRM System'
 *
 * Why 0 and not NULL: 0 is not a legal tbl_user PK (AUTO_INCREMENT starts at 1)
 * so it can never collide with a person, it joins to nothing, and — measured on
 * the live table — no existing row uses it, so a 0 is positively identifying
 * rather than merely absent. NULL is what a forgotten column looks like; 0 here
 * is a deliberate statement that no CRM user acted.
 *
 * A technician is NOT resolved to a tbl_user id even though tbl_easyfixer.user_id
 * exists and ACD_APIs uses it (JobServiceImpl:1017). Two reasons. It is populated
 * for only 6,907 of 10,356 technicians (2,816 of 4,680 ACTIVE ones), so it would
 * be NULL more often than not — and, far worse, when it IS populated the
 * technician becomes indistinguishable from an operator in the one column that
 * is supposed to say who acted. A partly-working resolution is the ambiguity,
 * not the fix. The technician is identified unambiguously in `comments` instead,
 * which is already this table's source-of-record field.
 *
 * `comments` is where legacy records the WRITER: 'Changed by CRM' (old CRM,
 * 1,015,510 rows), 'Changed by Api' (old API, 325,135). Ours is prefixed
 * 'Changed by New CRM' — never equal to a legacy value, so `comments LIKE
 * 'Changed by New CRM%'` selects exactly the rows this backend wrote, and the
 * existing exact-match filters keep meaning what they meant.
 */
const NO_CRM_USER = 0;

const SOURCE = {
  CRM: 'Changed by New CRM',
  APP: 'Changed by New CRM App',
  SYSTEM: 'Changed by New CRM System',
};

/*
 * The log_for vocabulary. The five continued values are quoted from production
 * and must never be "cleaned up" — a changed byte forks the history into two
 * vocabularies, which is the exact failure this module exists to prevent.
 */
const LOG_FOR = {
  NEW_JOB: 'new job',
  SCHEDULE: 'schedule',
  CHECKOUT: 'checkout',
  RESCHEDULE: 'Re-Scheduling',
  REVISIT_REQUIRED: 'Re-visit Required',
  // New, because the legacy stack never logged a generic transition. See above.
  STATUS_CHANGE: 'status change',
  // New, because the legacy stack had no customer-PIN-on-close gate to bypass.
  CUSTOMER_PIN_RESENT: 'customer pin resent',
  COMPLETED_WITHOUT_PIN: 'completed without customer pin',
  /*
   * V3 2.2/2.3/2.4/2.6 (2026-09-23). Three facts the legacy stack could not
   * have had, because none of the things they describe existed: the PIN moved
   * from gating job START to being collected at ARRIVAL, and the system began
   * awarding two charges nobody types.
   *
   * Each gets its own log_for for the reason stated above 'status change': a
   * new fact gets a new value. Folding "we paid him the on-time bonus" into
   * 'status change' would make a decade of status rows ambiguous, and folding
   * both money events into one value would leave a reader unable to tell an
   * EasyFix-funded bonus from a client-billed visit charge without parsing
   * new_data -- which is exactly the kind of overload this module avoids.
   */
  CUSTOMER_PIN_VERIFIED: 'customer pin verified',
  INCENTIVE_AWARDED: 'incentive awarded',
  VISIT_CHARGE_AWARDED: 'visit charge awarded',
  /*
   * V3 Phase 3 (2026-09-24) — the on-site claims and the desk/QC events that
   * resolve them (design sheets 10-14). Same rule as every value above: a new
   * fact gets its own log_for, so a reader filters on one value and never has
   * to parse new_data to tell "he reported additional work" from "the desk
   * priced it". No `%` or `_` in any of them — the legacy LIKE reader.
   */
  ADDITIONAL_WORK_REPORTED: 'additional work reported',
  ADDITIONAL_WORK_PRICED: 'additional work priced',
  ADDITIONAL_WORK_RETURNED: 'additional work returned',
  ADDITIONAL_WORK_APPROVED: 'additional work approved',
  LEFT_SITE: 'left site',
  BOOKED_MEANWHILE: 'booked work meanwhile',
  CANNOT_COMPLETE_REPORTED: 'cannot complete reported',
  CLAIM_UNDONE: 'claim undone',
  HELP_REQUESTED: 'help requested',
  HELP_PICKED_UP: 'help picked up',
  JOB_VERIFIED: 'job verified',
  CLIENT_QC: 'client qc',
  LEDGER_POSTED: 'ledger posted',
};

/*
 * new_data's leading token, which keeps the event name's ORIGINAL casing while
 * log_for is lowercased. 'checkOut' and 'New Job' look like typos and are not.
 */
const NEW_DATA_TOKEN = {
  [LOG_FOR.NEW_JOB]: 'New Job',
  [LOG_FOR.SCHEDULE]: 'schedule',
  [LOG_FOR.CHECKOUT]: 'checkOut',
  [LOG_FOR.REVISIT_REQUIRED]: 'revisit',
  [LOG_FOR.CUSTOMER_PIN_RESENT]: 'pinResent',
  [LOG_FOR.COMPLETED_WITHOUT_PIN]: 'noCustomerPin',
  [LOG_FOR.CUSTOMER_PIN_VERIFIED]: 'pinVerified',
  [LOG_FOR.INCENTIVE_AWARDED]: 'onTime',
  [LOG_FOR.VISIT_CHARGE_AWARDED]: 'visitCharge',
  [LOG_FOR.ADDITIONAL_WORK_REPORTED]: 'additionalWork',
  [LOG_FOR.ADDITIONAL_WORK_PRICED]: 'additionalWorkPriced',
  [LOG_FOR.ADDITIONAL_WORK_RETURNED]: 'additionalWorkReturned',
  [LOG_FOR.ADDITIONAL_WORK_APPROVED]: 'additionalWorkApproved',
  [LOG_FOR.LEFT_SITE]: 'leftSite',
  [LOG_FOR.BOOKED_MEANWHILE]: 'bookedMeanwhile',
  [LOG_FOR.CANNOT_COMPLETE_REPORTED]: 'cannotComplete',
  [LOG_FOR.CLAIM_UNDONE]: 'claimUndone',
  [LOG_FOR.HELP_REQUESTED]: 'help',
  [LOG_FOR.HELP_PICKED_UP]: 'helpPickedUp',
  [LOG_FOR.JOB_VERIFIED]: 'verified',
  [LOG_FOR.CLIENT_QC]: 'clientQc',
  [LOG_FOR.LEDGER_POSTED]: 'ledgerPosted',
};

/*
 * eta_status per event, quoted from the live table. NULL is a real value here,
 * not "unknown" — 'Re-Scheduling' has never carried one.
 */
const ETA_STATUS = {
  [LOG_FOR.NEW_JOB]: '01',
  [LOG_FOR.SCHEDULE]: '1',
  [LOG_FOR.CHECKOUT]: '3',
  [LOG_FOR.RESCHEDULE]: null,
  [LOG_FOR.REVISIT_REQUIRED]: '01',
  // No legacy eta code describes a generic transition, and inventing one would
  // put a value into eta_status that no reader can interpret. Same for the two
  // customer-PIN events: eta_status reports on the ETA lifecycle, which neither
  // a re-send nor a PIN-less close touches.
  [LOG_FOR.STATUS_CHANGE]: null,
  [LOG_FOR.CUSTOMER_PIN_RESENT]: null,
  [LOG_FOR.COMPLETED_WITHOUT_PIN]: null,
  // Same reasoning again: eta_status reports on the ETA lifecycle. A PIN check
  // and a charge award are not ETA events, so they carry no code rather than a
  // borrowed one.
  [LOG_FOR.CUSTOMER_PIN_VERIFIED]: null,
  [LOG_FOR.INCENTIVE_AWARDED]: null,
  [LOG_FOR.VISIT_CHARGE_AWARDED]: null,
  // V3 Phase 3: none of these is a legacy ETA code, so none claims one.
  [LOG_FOR.ADDITIONAL_WORK_REPORTED]: null,
  [LOG_FOR.ADDITIONAL_WORK_PRICED]: null,
  [LOG_FOR.ADDITIONAL_WORK_RETURNED]: null,
  [LOG_FOR.ADDITIONAL_WORK_APPROVED]: null,
  [LOG_FOR.LEFT_SITE]: null,
  [LOG_FOR.BOOKED_MEANWHILE]: null,
  [LOG_FOR.CANNOT_COMPLETE_REPORTED]: null,
  [LOG_FOR.CLAIM_UNDONE]: null,
  [LOG_FOR.HELP_REQUESTED]: null,
  [LOG_FOR.HELP_PICKED_UP]: null,
  [LOG_FOR.JOB_VERIFIED]: null,
  [LOG_FOR.CLIENT_QC]: null,
  [LOG_FOR.LEDGER_POSTED]: null,
};

/*
 * Column order is the legacy CRM's own INSERT, with old_data added in the
 * position the table itself declares it (log_for, old_data, new_data). The
 * legacy CRM omits old_data entirely; the API writer uses it, and the status
 * transition needs it to carry the "before".
 *
 * event_received_date is deliberately NOT written. It exists so the old API
 * could separate "when the event happened" from "when we heard about it" — it
 * accepted a client-supplied event timestamp. Nothing here is second-hand:
 * change_date IS the event instant, so a second column holding the same value
 * would imply a distinction that does not exist.
 */
const COLUMNS = ['log_for', 'old_data', 'new_data', 'job_id', 'eta_status', 'change_date', 'changed_by', 'comments'];

// Live column widths (INFORMATION_SCHEMA, 2026-08-20). log_for / old_data /
// new_data are varchar(255); comments is tinytext, i.e. 255 BYTES. Truncating
// here rather than letting MySQL do it keeps a strict-mode deploy from turning
// an over-long value into a failed insert, and a non-strict one from silently
// storing a half string.
const MAX_VARCHAR = 255;
const MAX_TINYTEXT = 255;

/*
 * NO CALLER-SUPPLIED FREE TEXT EVER REACHES THIS TABLE.
 *
 * Every field this module writes is composed here from ids the caller already
 * holds — job_id, efr_id, user_id, reason_id, status code — and the public
 * functions coerce each of them through intOrNull(). A customer name, address,
 * mobile number, email or operator remark cannot be passed in, so there is
 * nothing for utils/mask-mobile.js to mask: the leak is prevented by the
 * signature rather than scrubbed after the fact.
 *
 * The ONE string that is not composed from an id is the revisit reason's label,
 * and it is not caller-supplied either: the caller passes an id, and the LABEL
 * IS READ HERE FROM THE REASON MASTER (see resolveRevisitReasonText). It has to
 * be the label, because old_data on a 'Re-visit Required' row is not free-form
 * — it is a rendered field. EasyFix_CRM JobAction.java:1144 does
 *
 *     JobsLog reasonList = jobService.getRescheduledReasonByJobId(jobId, "Re-visit Required");
 *     responseObj.setReSchReason(reasonList.getOldValue());
 *
 * i.e. it prints old_data to the operator AS the reason. Both legacy writers
 * put text there — ACD_APIs JobServiceImpl:1017 writes
 * EasyfixerRevisitReason.getReason(), EasyFix_API JobsResource:440 writes the
 * reschReason string — so anything else renders as garbage on a live screen.
 * An earlier draft of this module wrote 'Reason_id: 7'; that is literally what
 * the operator would have read where 'Need to buy material' belongs.
 */
function intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function positiveIntOrNull(v) {
  const n = intOrNull(v);
  return n !== null && n > 0 ? n : null;
}

/*
 * 'YYYY-MM-DD HH:mm:ss' in IST clock time, matching the legacy 'Sched_date:'
 * fragment. Values read through this repo's pool arrive as that string already
 * (dateStrings: true) and pass through unchanged; a JS Date is shifted by the
 * fixed +05:30 offset and read via its UTC getters, so the output is the same
 * whether the container runs UTC or IST. Never toISOString() — that would write
 * a UTC clock into a column whose every other row is IST, putting a late-evening
 * reschedule on the wrong DAY.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
function formatMysqlDateTimeIST(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.replace('T', ' ').slice(0, 19);
  const date = (d instanceof Date) ? d : new Date(d);
  if (Number.isNaN(+date)) return null;
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return `${ist.getUTCFullYear()}-${p(ist.getUTCMonth() + 1)}-${p(ist.getUTCDate())} `
    + `${p(ist.getUTCHours())}:${p(ist.getUTCMinutes())}:${p(ist.getUTCSeconds())}`;
}

function clip(s, max) {
  if (s === null || s === undefined) return null;
  const str = String(s);
  return str.length > max ? str.slice(0, max) : str;
}

/*
 * Classify the actor into the single scheme described in ACTOR_RULE.
 *
 * The technician signals, in order of trust:
 *   1. actor.efr_id — set by middleware/auth.js on a technician principal, and
 *      now passed explicitly by every routes/mobile call site so the raw efr id
 *      in `user_id` can never be mistaken for a tbl_user id here.
 *   2. actor.user_id === 'efr:<n>' — the shared /api/shared/* principal shape.
 * Only when NEITHER fires is user_id read as a tbl_user id.
 *
 * Ordering matters: a technician principal carries BOTH efr_id and a user_id,
 * so the technician checks must come first or an efr id would be written into
 * changed_by as if it were an operator.
 */
function resolveActor(actor) {
  const a = actor || {};
  const efrId = positiveIntOrNull(a.efr_id)
    || (typeof a.user_id === 'string' && a.user_id.startsWith('efr:')
      ? positiveIntOrNull(a.user_id.slice('efr:'.length))
      : null);
  if (efrId) return { changedBy: NO_CRM_USER, comments: `${SOURCE.APP} (efr:${efrId})` };

  const userId = positiveIntOrNull(a.user_id);
  if (userId) return { changedBy: userId, comments: SOURCE.CRM };

  return { changedBy: NO_CRM_USER, comments: SOURCE.SYSTEM };
}

/*
 * The one insert. Returns the new job_log_id, or null when anything went wrong
 * — and NEVER throws, which is the contract every caller relies on.
 *
 * change_date is the EVENT INSTANT, bound as a JS Date rather than written as
 * SQL NOW(). That is this repo's DATETIME convention (pool timezone '+05:30',
 * so a Date serialises to its IST wall clock) and it lands on the same clock
 * legacy NOW() lands on, because the MySQL session time_zone is SYSTEM and the
 * server's system zone is IST — verified: NOW() and the Node process agreed to
 * the second. Binding it also lets a caller pass the instant the event actually
 * happened rather than the instant we got around to logging it, and makes the
 * value assertable in a test, which NOW() would not be.
 */
async function write({ logFor, jobId, oldData = null, newData = null, actor, at = new Date() }) {
  try {
    const id = positiveIntOrNull(jobId);
    if (!id) {
      // No job means no job history. Refusing here rather than inserting a
      // NULL job_id keeps us from recreating 'job Desc', the one legacy event
      // whose 9,705 rows are all job_id NULL and therefore unreadable as job
      // history by anything.
      logger.warn('job-log: refusing a row with no job id · logFor=' + logFor);
      return null;
    }
    const { changedBy, comments } = resolveActor(actor);
    const params = [
      clip(logFor, MAX_VARCHAR),
      clip(oldData, MAX_VARCHAR),
      clip(newData, MAX_VARCHAR),
      id,
      ETA_STATUS[logFor] === undefined ? null : ETA_STATUS[logFor],
      at instanceof Date ? at : new Date(),
      changedBy,
      clip(comments, MAX_TINYTEXT),
    ];
    const [r] = await pool.query(
      `INSERT INTO tbl_job_logs (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`,
      params,
    );
    logger.info('Job log written · job=' + id + ' · logFor=' + logFor + ' · id=' + r.insertId);
    return r.insertId;
  } catch (e) {
    // Swallowed on purpose — see the FAIL-SOFT note at the top. The mutation
    // this row describes has already committed and must stay committed.
    logger.warn({ err: e.message, jobId, logFor }, 'job-log: write failed (non-fatal)');
    return null;
  }
}

// 'new job' — a job was created. Legacy: JobDaoImpl.createJob / savejobStatusInlog("New Job").
async function logNewJob(jobId, actor, at) {
  return write({
    logFor: LOG_FOR.NEW_JOB,
    jobId,
    newData: `${NEW_DATA_TOKEN[LOG_FOR.NEW_JOB]}_${positiveIntOrNull(jobId)}`,
    actor,
    at,
  });
}

/*
 * 'schedule' — a technician was put on the job for the FIRST time. Legacy draws
 * the same line: saveScheduleJob() logs 'schedule' on the initial scheduling and
 * the reschedule path produces 'Re-Scheduling' instead, so a re-assignment must
 * NOT come through here.
 */
async function logSchedule(jobId, actor, at) {
  return write({
    logFor: LOG_FOR.SCHEDULE,
    jobId,
    newData: `${NEW_DATA_TOKEN[LOG_FOR.SCHEDULE]}_${positiveIntOrNull(jobId)}`,
    actor,
    at,
  });
}

// 'checkout' — the visit was closed out. Legacy: savejobStatusInlog("checkOut").
async function logCheckout(jobId, actor, at) {
  return write({
    logFor: LOG_FOR.CHECKOUT,
    jobId,
    newData: `${NEW_DATA_TOKEN[LOG_FOR.CHECKOUT]}_${positiveIntOrNull(jobId)}`,
    actor,
    at,
  });
}

/*
 * 'Re-Scheduling' — the appointment moved, or the job changed technician.
 *
 * old_data / new_data follow the legacy row shape verbatim:
 *   old_data 'Efr_id: 2702 Sched_by: 5776 Sched_date: 2026-04-28 16:01:05'
 *   new_data 'Efr_id: 2702'
 * i.e. who WAS on it, who scheduled that, and when — against who is on it now.
 * A missing technician is left out of the string rather than written as 'null':
 * this flow legitimately runs on unassigned jobs (reschedule() operates with
 * fk_easyfixter_id NULL), and 'Efr_id: null' would read as a technician.
 */
async function logReschedule(jobId, {
  previousEasyfixerId = null,
  newEasyfixerId = null,
  previousScheduledBy = null,
  previousScheduledAt = null,
} = {}, actor, at) {
  const parts = [];
  const prevEfr = positiveIntOrNull(previousEasyfixerId);
  const prevBy = positiveIntOrNull(previousScheduledBy);
  if (prevEfr) parts.push(`Efr_id: ${prevEfr}`);
  if (prevBy) parts.push(`Sched_by: ${prevBy}`);
  const prevAt = formatMysqlDateTimeIST(previousScheduledAt);
  if (prevAt) parts.push(`Sched_date: ${prevAt}`);

  const newEfr = positiveIntOrNull(newEasyfixerId);
  return write({
    logFor: LOG_FOR.RESCHEDULE,
    jobId,
    oldData: parts.length ? parts.join(' ') : null,
    newData: newEfr ? `Efr_id: ${newEfr}` : null,
    actor,
    at,
  });
}

/*
 * The revisit-reason master. tbl_job.revisit_reason_id is an FK into
 * revisit_reason_by_app(id, reason varchar(200)) — the same table the legacy
 * writer reads (ACD_APIs EasyfixerRevisitReason is @Table("revisit_reason_by_app"))
 * and the same one services/lookup.service.js#revisitReasons() serves to the
 * pickers that produce the id in the first place.
 *
 * Cached because the master is a handful of static rows and a revisit should not
 * pay a round trip to name a reason it already named an hour ago. Only SUCCESSES
 * are cached: a miss must stay a miss, or a reason added after boot would be
 * permanently unresolvable on a long-lived container.
 */
const revisitReasonTextById = new Map();

/*
 * id → label, or null when the label cannot be produced. NEVER THROWS.
 *
 * Null (rather than a placeholder) is what an unresolvable reason writes,
 * because old_data is rendered verbatim as the reason on the legacy screen: an
 * empty reason reads as "no reason recorded", which is true, whereas
 * 'Reason_id: 7' or 'Unknown reason (7)' reads as a reason the operator never
 * chose. The id is not lost — it is on tbl_job.revisit_reason_id, written by
 * the same transition — and the failure is logged with the id here.
 */
async function resolveRevisitReasonText(reasonId) {
  const id = positiveIntOrNull(reasonId);
  if (!id) return null;
  if (revisitReasonTextById.has(id)) return revisitReasonTextById.get(id);
  try {
    const [rows] = await pool.query(
      'SELECT reason FROM revisit_reason_by_app WHERE id = ? LIMIT 1',
      [id],
    );
    const raw = rows && rows[0] ? rows[0].reason : null;
    const text = raw === null || raw === undefined ? '' : String(raw).trim();
    if (!text) {
      logger.warn('job-log: revisit reason ' + id + ' has no text in revisit_reason_by_app · old_data left empty');
      return null;
    }
    revisitReasonTextById.set(id, text);
    return text;
  } catch (e) {
    // Same bargain as write() below: the mutation has already committed, and a
    // reason master that cannot be read must cost at most a blank reason.
    logger.warn({ err: e.message, reasonId: id }, 'job-log: revisit reason lookup failed (non-fatal)');
    return null;
  }
}

/*
 * 'Re-visit Required' — the technician closed the visit but the job needs
 * another one. old_data carries the reason's LABEL, resolved from the master by
 * id, because a live legacy screen renders that column as the reason text — see
 * the note above resolveRevisitReasonText and the NO CALLER-SUPPLIED FREE TEXT
 * block at the top.
 */
async function logRevisitRequired(jobId, { reasonId = null } = {}, actor, at) {
  const reasonText = await resolveRevisitReasonText(reasonId);
  return write({
    logFor: LOG_FOR.REVISIT_REQUIRED,
    jobId,
    oldData: reasonText,
    newData: `${NEW_DATA_TOKEN[LOG_FOR.REVISIT_REQUIRED]}_${positiveIntOrNull(jobId)}`,
    actor,
    at,
  });
}

/*
 * 'status change' — THE NEW EVENT. Every setStatus() transition, carrying the
 * before and after in old_data / new_data.
 *
 * Numeric codes, not labels: tbl_job.job_status is numeric everywhere in this
 * platform and a label is a rendering decision that has already changed more
 * than once (BOOKED splits into two labels depending on assignment). A stored
 * label would date; a stored code will not.
 *
 * Returns null without writing when the status did not actually move — a
 * no-op transition is the documented mechanism the mobile ETA and reschedule
 * routes use to ride the extras path (they pass the job's CURRENT status), and
 * logging those would bury the real transitions under thousands of 1 -> 1 rows.
 */
async function logStatusChange(jobId, { from = null, to = null } = {}, actor, at) {
  const before = intOrNull(from);
  const after = intOrNull(to);
  if (after === null || before === after) return null;
  return write({
    logFor: LOG_FOR.STATUS_CHANGE,
    jobId,
    oldData: before === null ? null : `Status: ${before}`,
    newData: `Status: ${after}`,
    actor,
    at,
  });
}

/*
 * 'customer pin resent' — ops re-sent the customer PIN from the CRM
 * (POST /api/admin/jobs/:id/resend-customer-pin).
 *
 * WHY IT IS A HISTORY ROW AND NOT A logger.info
 * The PIN gates job CLOSE. When a technician cannot close, the question asked
 * afterwards is "why couldn't this job close?", and it is asked on the job —
 * not in Dozzle. An application log line is invisible there, is not attributed
 * to a person on the job, and rolls off. This is the same reasoning that put
 * the cancel audit comment on the job in setStatus().
 *
 * THE PIN ITSELF IS NEVER WRITTEN. The signature has nowhere to put it: the row
 * records that a re-send happened, by whom and when. The code lives on
 * tbl_job.otp and goes to the customer's phone — the whole point of the route
 * being a re-send rather than a "show me the PIN" panel is that ops never sees
 * it, and a log row that carries it would hand it back.
 *
 * "Resent", not "delivered": the route awaits the SMS service, which discards
 * its provider result, so nothing here can honestly assert delivery.
 */
async function logCustomerPinResent(jobId, actor, at) {
  return write({
    logFor: LOG_FOR.CUSTOMER_PIN_RESENT,
    jobId,
    newData: `${NEW_DATA_TOKEN[LOG_FOR.CUSTOMER_PIN_RESENT]}_${positiveIntOrNull(jobId)}`,
    actor,
    at,
  });
}

/*
 * 'completed without customer pin' — a CRM close where the PIN gate was not
 * satisfied.
 *
 * THIS IS A FACT, NOT AN ACCUSATION. Ops closing a job for a technician who
 * cannot reach the customer is legitimate, and is exactly why the escape hatch
 * exists — the mobile checkout enforces the PIN, the CRM deliberately does not
 * (routes/mobile/index.js POST /jobs/:id/checkout says so in as many words).
 * The row exists so the two closes are TELLABLE APART afterwards, which they
 * were not: an ops close was already attributed (logStatusChange + logCheckout
 * both carry the actor) but looked identical to any other ops close.
 *
 * TWO CONDITIONS, BOTH REQUIRED, both checked here rather than at the call site
 * so the judgement lives next to the actor classifier it depends on:
 *
 *  1. pinOutstanding — the job still carries a non-empty tbl_job.otp. The
 *     caller passes a BOOLEAN, never the code: this module's standing rule is
 *     that no secret and no free text can reach the table by signature rather
 *     than by remembering to strip it, and the PIN is the strongest example.
 *     When tbl_job has no otp column at all (older deploys — see
 *     job.service.hasOtpColumn) the caller has nothing to report and passes
 *     false, so nothing is recorded rather than a value being invented.
 *
 *  2. the actor is a CRM user — resolveActor puts a real tbl_user id in
 *     changedBy for exactly those. Without this the row would be a LIE on the
 *     commonest close in the system: the technician app closes through the same
 *     setStatus(), it verifies the PIN by COMPARING it and never clears
 *     tbl_job.otp, so "otp is still set" is true of a correctly PIN-verified
 *     technician close too. Integration and system closes (changedBy 0, no
 *     actor) are excluded for the plainer reason that no PIN gate applies to
 *     them, so there is nothing there to have bypassed.
 *
 * Returns null without writing when either fails — the same shape logStatusChange
 * uses for a transition that did not actually move.
 */
async function logCompletedWithoutCustomerPin(jobId, { pinOutstanding = false } = {}, actor, at) {
  if (!pinOutstanding) return null;
  const { changedBy } = resolveActor(actor);
  if (!changedBy) return null;
  return write({
    logFor: LOG_FOR.COMPLETED_WITHOUT_PIN,
    jobId,
    newData: `${NEW_DATA_TOKEN[LOG_FOR.COMPLETED_WITHOUT_PIN]}_${positiveIntOrNull(jobId)}`,
    actor,
    at,
  });
}

/*
 * 'customer pin verified' — the customer's PIN was entered and matched
 * (V3 2.2 at the door, V3 2.4 when it arrives late).
 *
 * WHY IT IS A ROW AND NOT AN INFERENCE. The PIN stopped being a gate in V3: a
 * technician can work, and close, without one. So "was the customer actually
 * there when he said he arrived?" is no longer answerable from the job's
 * status — the status is identical either way. This row is the only place that
 * question has an answer, which is precisely why the verification queue (V3
 * 3.6) and the ops desk (3.2) both read it.
 *
 * `late` distinguishes the two routes: FALSE is the PIN collected at arrival,
 * TRUE is the technician entering it afterwards from the order screen. It goes
 * in old_data because that is where this module already puts a rendered
 * qualifier (see resolveRevisitReasonText), and because a reader looking at a
 * late verification needs to know it was late without joining anything.
 *
 * THE PIN IS NEVER WRITTEN, for the same reason logCustomerPinResent does not
 * write it: the signature has nowhere to put it.
 */
async function logCustomerPinVerified(jobId, { late = false } = {}, actor, at) {
  return write({
    logFor: LOG_FOR.CUSTOMER_PIN_VERIFIED,
    jobId,
    oldData: late ? 'Late: yes' : null,
    newData: `${NEW_DATA_TOKEN[LOG_FOR.CUSTOMER_PIN_VERIFIED]}_${positiveIntOrNull(jobId)}`,
    actor,
    at,
  });
}

/*
 * The two SYSTEM-AWARDED charges (V3 2.3 and 2.6), each on its own log_for.
 *
 * WHY MONEY EVENTS BELONG IN JOB HISTORY AT ALL. services/job-incentive.service.js
 * writes a job_material row and a logger.info line. The row is the money; the
 * log line is invisible on the job and rolls off. When a technician asks "why
 * was I paid 50 more on that job" — or an operator asks "who authorised billing
 * this client 250" — the question is asked ON THE JOB, and today the only
 * honest answer is a SELECT against job_material by a developer.
 *
 * THE AMOUNT IS COMPOSED HERE FROM A NUMBER, not passed as text: the callers
 * hand over the figure job-incentive.service.js already computed, it goes
 * through intOrNull(), and a non-numeric amount writes no row rather than
 * smuggling a string into a table this module promises holds none. That keeps
 * the NO-CALLER-SUPPLIED-FREE-TEXT rule above literally true.
 *
 * Both are best-effort like every other write here, and both are called only
 * when the award actually inserted — `awardOnce` returns true exactly once per
 * job per reason, so the history cannot double-count a retry that the charge
 * itself correctly refused.
 */
async function logIncentiveAwarded(jobId, { amount = null } = {}, actor, at) {
  const rupees = intOrNull(amount);
  if (rupees === null) return null;
  return write({
    logFor: LOG_FOR.INCENTIVE_AWARDED,
    jobId,
    oldData: `Amount: ${rupees}`,
    newData: `${NEW_DATA_TOKEN[LOG_FOR.INCENTIVE_AWARDED]}_${positiveIntOrNull(jobId)}`,
    actor,
    at,
  });
}

async function logVisitChargeAwarded(jobId, { amount = null } = {}, actor, at) {
  const rupees = intOrNull(amount);
  if (rupees === null) return null;
  return write({
    logFor: LOG_FOR.VISIT_CHARGE_AWARDED,
    jobId,
    oldData: `Amount: ${rupees}`,
    newData: `${NEW_DATA_TOKEN[LOG_FOR.VISIT_CHARGE_AWARDED]}_${positiveIntOrNull(jobId)}`,
    actor,
    at,
  });
}

/*
 * ── V3 PHASE 3 WRITERS (2026-09-24) ─────────────────────────────────────────
 *
 * Thirteen events, one shape: `(jobId, details, actor, at)`, a log_for of their
 * own, new_data `<token>_<jobId>`, eta_status NULL. Built by one factory rather
 * than thirteen copies of logIncentiveAwarded, because the only thing that
 * varies is how `details` becomes old_data — and that is exactly the part the
 * NO-CALLER-SUPPLIED-FREE-TEXT rule governs, so it is written once per event
 * below and nowhere else.
 *
 * old_data is composed ONLY from integers (intOrNull) or from a CLOSED
 * vocabulary. A value outside the vocabulary writes NO row rather than a row
 * carrying the caller's string: a history table that promises no free text
 * cannot take "whatever the route happened to pass" on the one field a
 * reader renders verbatim. `null` from the composer means "refuse".
 *
 * Every writer is fail-soft (write() swallows) and must be called AFTER the
 * caller's commit — the module header explains why.
 */
const NO_DETAIL = () => undefined;       // event carries nothing beyond its name
const oneOf = (allowed, label, v) => (allowed.includes(v) ? `${label}: ${v}` : null);
const HELP_REASONS_LOGGED = ['gate', 'arguing', 'unsure', 'colour', 'unsafe'];
const CLAIM_KINDS_LOGGED = ['cant_complete', 'cancel', 'additional_work', 'help'];
const QC_OUTCOMES_LOGGED = ['passed', 'auto', 'disputed'];

function phase3Writer(logFor, compose) {
  return async function writer(jobId, details = {}, actor, at) {
    const oldData = compose(details || {});
    if (oldData === null) return null;
    return write({
      logFor,
      jobId,
      oldData: oldData === undefined ? null : oldData,
      newData: `${NEW_DATA_TOKEN[logFor]}_${positiveIntOrNull(jobId)}`,
      actor,
      at,
    });
  };
}

const logAdditionalWorkReported = phase3Writer(LOG_FOR.ADDITIONAL_WORK_REPORTED, NO_DETAIL);
// Both figures, or no row: a priced event without its price is the one row a
// reader would open to find the number.
const logAdditionalWorkPriced = phase3Writer(LOG_FOR.ADDITIONAL_WORK_PRICED, ({ clientAmount, txAmount }) => {
  const c = intOrNull(clientAmount);
  const t = intOrNull(txAmount);
  return c === null || t === null ? null : `Client: ${c} Tx: ${t}`;
});
const logAdditionalWorkReturned = phase3Writer(LOG_FOR.ADDITIONAL_WORK_RETURNED, NO_DETAIL);
const logAdditionalWorkApproved = phase3Writer(LOG_FOR.ADDITIONAL_WORK_APPROVED, NO_DETAIL);
const logLeftSite = phase3Writer(LOG_FOR.LEFT_SITE, NO_DETAIL);
const logBookedMeanwhile = phase3Writer(LOG_FOR.BOOKED_MEANWHILE,
  ({ answer }) => oneOf(['yes', 'no'], 'Answer', answer));
// The reason ID, never its label: the label lives in action_taken_reason and a
// reader resolves it, exactly as tbl_job.enum_reason_id is resolved.
const logCannotCompleteReported = phase3Writer(LOG_FOR.CANNOT_COMPLETE_REPORTED, ({ reasonId }) => {
  const id = positiveIntOrNull(reasonId);
  return id === null ? null : `Reason: ${id}`;
});
const logClaimUndone = phase3Writer(LOG_FOR.CLAIM_UNDONE,
  ({ kind }) => oneOf(CLAIM_KINDS_LOGGED, 'Kind', kind));
const logHelpRequested = phase3Writer(LOG_FOR.HELP_REQUESTED,
  ({ reason }) => oneOf(HELP_REASONS_LOGGED, 'Reason', reason));
const logHelpPickedUp = phase3Writer(LOG_FOR.HELP_PICKED_UP, NO_DETAIL);
const logJobVerified = phase3Writer(LOG_FOR.JOB_VERIFIED, NO_DETAIL);
const logClientQc = phase3Writer(LOG_FOR.CLIENT_QC,
  ({ outcome }) => oneOf(QC_OUTCOMES_LOGGED, 'Outcome', outcome));
const logLedgerPosted = phase3Writer(LOG_FOR.LEDGER_POSTED, NO_DETAIL);

/*
 * ── THE READ SIDE (V3 plan 3.1, 2026-09-23) ─────────────────────────────────
 *
 * Until now this module could only WRITE. tbl_job_logs has been accumulating
 * since 2015 and nothing in the new stack has ever shown a row of it to
 * anybody: the CRM has five separate history surfaces (reschedule history,
 * scheduling history, call history, customer history, the Audit & History
 * card) and none of them is this table. That is what V3 3.1 means by "job
 * event stream ... gates 3.2-3.7" — the writes already exist, the FEED does
 * not, and every downstream item (the ops desk's "Pending on" and "Start
 * proof", the verification queue, the waiting-for groups) is a READER of it.
 *
 * ONE ACTOR NAMESPACE COMING BACK OUT, AS IT WENT IN. ACTOR_RULE above splits
 * an actor across two columns on write: an operator lands in changed_by, a
 * technician lands in comments as '(efr:N)' with changed_by = 0. A reader that
 * only joined tbl_user would therefore render every technician action as
 * nobody. So this resolves BOTH sides and returns a single shaped `actor`, and
 * the parsing is anchored to the exact string resolveActor() writes rather
 * than a loose /efr:(\d+)/ that a future comments format could break silently.
 *
 * THE QUERY BUDGET IS THREE, NOT ONE-PER-ROW. One SELECT for the rows, one for
 * whatever operators appear, one for whatever technicians appear — and the last
 * two are skipped entirely when nobody of that kind acted. A correlated join to
 * tbl_user would have been one query, but tbl_easyfixer cannot be joined at all
 * (the efr id is inside a tinytext), and a per-row lookup on a job with 40
 * events is 40 round trips on a screen an operator opens all day. This backend
 * serves the CRM, the app and the client dashboard from one MySQL; a read this
 * casual to write is exactly where that gets spent.
 *
 * NEWEST LAST. The table is an append-only history and every existing reader of
 * it (and the CRM's own scheduling history) reads oldest-first, so a feed that
 * flipped the order here would disagree with the screen beside it. `limit`
 * therefore takes the MOST RECENT rows and returns them ascending, which is
 * what a capped feed has to mean — taking the oldest 200 of 400 would show a
 * job's first day forever and never its last.
 */
const ACTIVITY_LIMIT_DEFAULT = 200;
const ACTIVITY_LIMIT_MAX = 500;

// Anchored to what resolveActor() writes: 'Changed by New CRM App (efr:123)'.
const APP_EFR_RE = new RegExp('^' + SOURCE.APP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\(efr:(\\d+)\\)$');

/*
 * Which writer produced a row, from `comments` alone.
 *
 * 'legacy' is not a failure case — it is 1.3 million rows written by the old
 * CRM ('Changed by CRM') and the old API ('Changed by Api') before this backend
 * existed, and a feed that hid them would be missing most of a long job's life.
 * Anything unrecognised is 'legacy' too rather than 'system', because claiming
 * a row we cannot attribute was written by US is the one wrong answer.
 */
function sourceOf(comments) {
  const c = String(comments || '');
  if (APP_EFR_RE.test(c)) return 'app';
  if (c === SOURCE.CRM) return 'crm';
  if (c === SOURCE.SYSTEM) return 'system';
  return 'legacy';
}

async function listForJob(jobId, { limit = ACTIVITY_LIMIT_DEFAULT } = {}) {
  const id = positiveIntOrNull(jobId);
  if (!id) return [];
  const cap = Math.min(Math.max(positiveIntOrNull(limit) || ACTIVITY_LIMIT_DEFAULT, 1), ACTIVITY_LIMIT_MAX);

  // Ordered DESC so LIMIT keeps the RECENT end, then reversed below.
  const [rows] = await pool.query(
    `SELECT job_log_id, log_for, old_data, new_data, eta_status,
            change_date, changed_by, comments
       FROM tbl_job_logs
      WHERE job_id = ?
      ORDER BY change_date DESC, job_log_id DESC
      LIMIT ?`,
    [id, cap],
  );
  if (!rows.length) return [];

  const userIds = [...new Set(rows.map((r) => positiveIntOrNull(r.changed_by)).filter(Boolean))];
  const efrIds = [...new Set(rows
    .map((r) => (String(r.comments || '').match(APP_EFR_RE) || [])[1])
    .filter(Boolean)
    .map(Number))];

  const users = new Map();
  if (userIds.length) {
    const [us] = await pool.query(
      'SELECT user_id, user_name FROM tbl_user WHERE user_id IN (?)', [userIds]);
    for (const u of us) users.set(Number(u.user_id), u.user_name || null);
  }
  const techs = new Map();
  if (efrIds.length) {
    const [es] = await pool.query(
      'SELECT efr_id, efr_name FROM tbl_easyfixer WHERE efr_id IN (?)', [efrIds]);
    for (const e of es) techs.set(Number(e.efr_id), e.efr_name || null);
  }

  return rows.reverse().map((r) => {
    const source = sourceOf(r.comments);
    const efrId = source === 'app'
      ? Number((String(r.comments).match(APP_EFR_RE) || [])[1]) : null;
    const userId = positiveIntOrNull(r.changed_by);
    return {
      id: Number(r.job_log_id),
      event: r.log_for,
      from: r.old_data,
      to: r.new_data,
      etaStatus: r.eta_status,
      at: r.change_date,
      source,
      actor: {
        kind: source === 'app' ? 'technician' : (source === 'crm' ? 'user' : source),
        // An id we can join, or null. Never the other namespace's id.
        userId: source === 'crm' ? userId : null,
        efrId,
        // A name when we have one. Never a fabricated placeholder: 'System' is
        // a real answer, an unresolved id is not.
        name: source === 'app'
          ? (techs.get(efrId) || null)
          : (source === 'crm' ? (users.get(userId) || null) : null),
      },
      // The legacy writer's own words, so an operator can see WHICH stack wrote
      // a row without this module having to translate a decade of provenance.
      writtenBy: r.comments || null,
    };
  });
}

module.exports = {
  logNewJob,
  logSchedule,
  logCheckout,
  logReschedule,
  logRevisitRequired,
  logStatusChange,
  logCustomerPinResent,
  logCompletedWithoutCustomerPin,
  logCustomerPinVerified,
  logIncentiveAwarded,
  logVisitChargeAwarded,
  logAdditionalWorkReported,
  logAdditionalWorkPriced,
  logAdditionalWorkReturned,
  logAdditionalWorkApproved,
  logLeftSite,
  logBookedMeanwhile,
  logCannotCompleteReported,
  logClaimUndone,
  logHelpRequested,
  logHelpPickedUp,
  logJobVerified,
  logClientQc,
  logLedgerPosted,
  listForJob,
  ACTIVITY_LIMIT_MAX,
  sourceOf,
  // Exported for tests + for anyone auditing the conventions against production.
  LOG_FOR,
  ETA_STATUS,
  NEW_DATA_TOKEN,
  SOURCE,
  NO_CRM_USER,
  COLUMNS,
  resolveActor,
};
