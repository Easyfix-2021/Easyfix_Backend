/*
 * Canonical SQL fragments for a job's elapsed age.
 *
 * Keep this tiny module dependency-free: CRM job reads, exports and mobile
 * read models can share the exact terminal anchors without loading the large
 * job service (or re-declaring subtly different age rules).
 */
const JOB_AGE_STATUS = Object.freeze({
  COMPLETED: 3,
  COMPLETED_ALT: 5,
  CANCELLED: 6,
  ENQUIRY: 7,
});

const JOB_AGE_END_EXPR = `COALESCE(
    CASE j.job_status
      WHEN ${JOB_AGE_STATUS.COMPLETED}     THEN j.checkout_date_time
      WHEN ${JOB_AGE_STATUS.COMPLETED_ALT} THEN j.checkout_date_time
      WHEN ${JOB_AGE_STATUS.CANCELLED}     THEN j.cancel_date_time
      WHEN ${JOB_AGE_STATUS.ENQUIRY}       THEN j.enquiry_date_time
    END,
    NOW()
  )`;

const JOB_AGE_SECS_EXPR = `GREATEST(TIMESTAMPDIFF(SECOND, j.ticket_created_date_time, ${JOB_AGE_END_EXPR}), 0)`;
const JOB_AGE_DAYS_EXPR = `GREATEST(TIMESTAMPDIFF(DAY, j.ticket_created_date_time, ${JOB_AGE_END_EXPR}), 0)`;
const JOB_AGE_COLUMNS = `,
  ${JOB_AGE_DAYS_EXPR} AS ageDays,
  ${JOB_AGE_SECS_EXPR} AS ageSecs`;

module.exports = {
  JOB_AGE_STATUS,
  JOB_AGE_END_EXPR,
  JOB_AGE_SECS_EXPR,
  JOB_AGE_DAYS_EXPR,
  JOB_AGE_COLUMNS,
};
