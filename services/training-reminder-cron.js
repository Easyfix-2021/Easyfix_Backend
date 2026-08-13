const { pool } = require('../db');
const logger = require('../logger');
// Token resolution + dead-token pruning come from the one shared delivery layer.
const pushDelivery = require('./push-delivery.service');
const lms = require('./lms.service');

/*
 * Training-reminder cron (2026-08-13).
 *
 * Daily push to every technician holding assigned training they have not
 * finished. Runs until the training IS finished — an assignment that is
 * ignored is exactly the one worth nudging, so unlike a one-shot notification
 * this repeats every day while the debt stands.
 *
 * Companion to the in-app prompt the technician app shows on open; both read
 * the same predicate through lms.pendingTraining, so the push and the popup
 * can never disagree about who owes what.
 *
 * The message changes at the deadline. Before it, the nudge is informational
 * and names the date. After it, it says plainly that the app is restricted —
 * because by then it IS: tech-auth withdraws job capabilities for an overdue
 * technician, and a cheerful reminder would be actively misleading about why
 * their work screen stopped working.
 *
 * Token routing + dead-token pruning: the shared push-delivery layer (reads
 * tbl_easyfixer_app.device_id first, then device_info.fire_base_token; prunes
 * 404 UNREGISTERED tokens from both stores).
 *
 * Best-effort by contract: per-tech failures are counted + logged, never abort
 * the loop; the top level swallows so a cron tick can't crash the process.
 */

const PUSH_DATA = { type: 'training_reminder', screen: 'training' };

/*
 * Candidates: technicians with at least one incomplete assigned course that
 * actually HAS content. The content check matters — an empty course cannot be
 * completed, so nagging someone daily about one would be both futile and
 * infuriating, and the assign guard now prevents new ones.
 *
 * Deliberately does NOT filter on lifecycle status. A technician in
 * TRAINING_PENDING is precisely the person this exists for, and they are not
 * ACTIVE — the attendance cron's "ACTIVE and VERIFIED" filter would exclude
 * exactly the wrong people here.
 */
async function loadCandidates() {
  const [rows] = await pool.query(
    `SELECT ec.easyfixer_id,
            COUNT(*) AS pending_courses,
            MIN(ec.due_date) AS earliest_due,
            SUM(CASE WHEN ec.due_date IS NOT NULL AND ec.due_date < ? THEN 1 ELSE 0 END) AS overdue_courses
       FROM easyfixer_courses ec
       JOIN tbl_easyfixer e ON e.efr_id = ec.easyfixer_id
      WHERE ec.completion_date IS NULL
        AND NOT (e.efr_status <=> 3)
        AND EXISTS (SELECT 1 FROM course_videos cv WHERE cv.course_id = ec.course_id)
      GROUP BY ec.easyfixer_id`,
    [lms.istToday()],
  );
  return rows;
}

function messageFor(row) {
  const overdue = Number(row.overdue_courses) || 0;
  const pending = Number(row.pending_courses) || 0;
  const courseWord = pending === 1 ? 'training' : `${pending} trainings`;

  if (overdue > 0) {
    return {
      title: 'Training Overdue — App Restricted',
      body: `Your ${courseWord} passed the due date. Until you finish, you can only use Training and Claim Amount. Tap to finish now.`,
    };
  }
  const due = row.earliest_due ? String(row.earliest_due).slice(0, 10) : null;
  return {
    title: 'Finish Your Training',
    body: due
      ? `You have ${courseWord} to complete by ${due}. Tap to continue watching.`
      : `You have ${courseWord} to complete. Tap to continue watching.`,
  };
}

// Push to ONE technician across all their device tokens (dead tokens are
// pruned inside the shared delivery layer). Returns { delivered } — delivered
// true if at least one token took the push, skipped when no tokens.
async function pushTo(row) {
  const { title, body } = messageFor(row);
  return pushDelivery.deliverToEfr(
    row.easyfixer_id,
    { title, body, data: PUSH_DATA },
    { channel: 'training-reminder' },
  );
}

async function runDailyReminder() {
  let eligible = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  try {
    const rows = await loadCandidates();
    eligible = rows.length;
    logger.info('Training-reminder cron · eligible=' + eligible);
    for (const row of rows) {
      try {
        const result = await pushTo(row);
        if (result?.delivered) succeeded += 1;
        else skipped += 1;
      } catch (e) {
        failed += 1;
        logger.warn('Training reminder failed · efrId=' + row.easyfixer_id + ' · ' + e.message);
      }
    }
  } catch (e) {
    // Swallowed on purpose: a cron tick must never crash the process.
    logger.error('Training-reminder cron failed · ' + e.message);
  }
  return { eligible, succeeded, failed, skipped };
}

/*
 * Trigger-Now tester. Sends to ONE technician regardless of whether they are
 * due a reminder today, so an operator can prove delivery end-to-end without
 * waiting for a real debt to exist. In an environment with TEST_FCM_TOKEN set,
 * the shared delivery layer redirects every send to the operator's token.
 */
async function runTest({ sourceId } = {}) {
  const efrId = Number(sourceId);
  if (!Number.isInteger(efrId) || efrId <= 0) {
    throw new Error('an Easyfixer ID (efr_id) is required to test this reminder');
  }
  const status = await lms.pendingTraining(efrId);
  const row = {
    easyfixer_id: efrId,
    pending_courses: status.pending,
    overdue_courses: status.overdue,
    earliest_due: status.courses.find((c) => c.due_date)?.due_date ?? null,
  };
  const result = await pushTo(row);
  return {
    efrId,
    pending: status.pending,
    overdue: status.overdue,
    delivered: Boolean(result?.delivered),
  };
}

module.exports = { runDailyReminder, runTest, _internals: { messageFor, loadCandidates } };
