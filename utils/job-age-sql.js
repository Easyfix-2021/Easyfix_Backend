/*
 * Canonical SQL fragments for a job's elapsed age.
 *
 * Keep this tiny module dependency-free of the large job service: CRM job
 * reads, exports and mobile read models can share the exact terminal anchors
 * without loading it (or re-declaring subtly different age rules). `db` is
 * the one exception, needed for the clock-rule fix below.
 */
const { pool } = require('../db');

const JOB_AGE_STATUS = Object.freeze({
  COMPLETED: 3,
  COMPLETED_ALT: 5,
  CANCELLED: 6,
  ENQUIRY: 7,
});

/*
 * Functions, not constants. checkout_date_time / cancel_date_time /
 * enquiry_date_time (the CASE branches) are all bound as new Date() in
 * job.service.js; the OPEN-job fallback (none of the 4 terminal timestamps
 * set yet) measures age against THE CURRENT MOMENT, so it binds that same
 * app clock via pool.escape() instead of reading SQL NOW() — NOW() follows
 * the DB session's own timezone, not the pool's +05:30 option (see
 * routes/index.js's /api/health/db probe). Evaluated fresh on every call: a
 * module-load-time constant would freeze this instant for the process's
 * whole lifetime.
 */
function jobAgeEndExpr() {
  return `COALESCE(
    CASE j.job_status
      WHEN ${JOB_AGE_STATUS.COMPLETED}     THEN j.checkout_date_time
      WHEN ${JOB_AGE_STATUS.COMPLETED_ALT} THEN j.checkout_date_time
      WHEN ${JOB_AGE_STATUS.CANCELLED}     THEN j.cancel_date_time
      WHEN ${JOB_AGE_STATUS.ENQUIRY}       THEN j.enquiry_date_time
    END,
    ${pool.escape(new Date())}
  )`;
}

function jobAgeSecsExpr() {
  return `GREATEST(TIMESTAMPDIFF(SECOND, j.ticket_created_date_time, ${jobAgeEndExpr()}), 0)`;
}
function jobAgeDaysExpr() {
  return `GREATEST(TIMESTAMPDIFF(DAY, j.ticket_created_date_time, ${jobAgeEndExpr()}), 0)`;
}
function jobAgeColumns() {
  return `,
  ${jobAgeDaysExpr()} AS ageDays,
  ${jobAgeSecsExpr()} AS ageSecs`;
}

module.exports = {
  JOB_AGE_STATUS,
  JOB_AGE_END_EXPR: jobAgeEndExpr,
  JOB_AGE_SECS_EXPR: jobAgeSecsExpr,
  JOB_AGE_DAYS_EXPR: jobAgeDaysExpr,
  JOB_AGE_COLUMNS: jobAgeColumns,
};
