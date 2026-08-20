const { pool } = require('../db');
const logger = require('../logger');
const s3Storage = require('../utils/s3-storage');
const { OFFER_STATUS } = require('./offer-status');
const {
  JOB_AGE_DAYS_EXPR,
  JOB_AGE_SECS_EXPR,
} = require('../utils/job-age-sql');
const {
  currentIstMonth,
  monthBounds,
  monthLabel,
  monthParts,
  shiftMonth,
  shiftYmd,
  todayIst,
} = require('../utils/ist-calendar');

// A job can expose at most twenty proof rows (ten before + ten after). Keep
// signing/fallback I/O below that SQL bound so one detail request cannot fan
// all of those legacy S3 HEAD probes out at once.
const PROOF_IMAGE_RESOLUTION_CONCURRENCY = 4;
const CANONICAL_JOB_PROOF_KEY = /^JobSupportings\/[A-Za-z][A-Za-z0-9]*_\d+_\d+$/;
const UNDER_AUDIT_STATUS = 10;

/*
 * Status 10 is overloaded by the legacy application. QuickSight's canonical
 * "Waiting Audit" cohort adds both request-counter gates; the mobile read
 * model also excludes rows carrying a revisit reason so a revisit is never
 * presented as quality review. This is an operations-audit signal, NOT a
 * claim that the client has a dedicated QC workflow.
 */
const UNDER_AUDIT_PREDICATE = `j.job_status = ${UNDER_AUDIT_STATUS}
  AND j.app_checkout_date_time IS NOT NULL
  AND j.no_of_req_approval < 1
  AND j.no_of_req_foh < 1
  AND j.revisit_reason_id IS NULL`;
const COMPONENT_NOT_STORED = 'PAYOUT_COMPONENT_NOT_STORED';

/*
 * Performance + History + Earnings (PHE) read model for the technician app.
 *
 * This module deliberately composes existing source-of-truth tables rather
 * than creating another wallet/performance ledger:
 *   - job earnings     tbl_job_transaction.efr_charge
 *   - paid timestamp   tbl_easyfixer_transaction (type 2 = wallet credit)
 *   - wallet balance   tbl_easyfixer.current_balance
 *   - withdrawals      tbl_easyfixer_withdrawal_request
 *   - job performance  tbl_job + tbl_job_offer + customer ratings
 *   - proof of work    tbl_job_image
 *
 * Every public function receives the authenticated efr id. There is no subject
 * id in query/body data. Reads are bounded and page-based where the result can
 * grow. Client QC remains intentionally absent: the current schema has no
 * authoritative client-quality state. The separately exposed Under Audit view
 * uses the full legacy operations predicate above and labels that provenance.
 */

function num(value) {
  return Number(value ?? 0);
}

function money(value) {
  return Number(num(value).toFixed(2));
}

function maskedLast4(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? digits.slice(-4) : null;
}

function maskPersonName(value) {
  const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

function withdrawalShape(row) {
  if (!row || row.request_id == null) return null;
  return {
    requestId: Number(row.request_id),
    amount: money(row.amount),
    status: row.status || null,
    requestedOn: row.requested_on || null,
    processedOn: row.processed_on || null,
    bankName: row.bank_name || null,
    accountLast4: maskedLast4(row.bank_account_number),
    // `remarks` is operator free text, not a canonical bank/UTR reference.
    // Keep the contract explicit until a dedicated payout-reference column is
    // introduced and populated by the finance flow.
    reference: null,
  };
}

function unavailableMoneyComponent(reasonCode = COMPONENT_NOT_STORED) {
  return {
    available: false,
    amount: null,
    source: null,
    reasonCode,
  };
}

function payoutBreakdown(row) {
  const transactionCount = num(row?.transaction_count);
  const walletCreditCount = num(row?.wallet_credit_count);
  return {
    available: transactionCount > 0 || walletCreditCount > 0,
    reasonCode: transactionCount > 0 || walletCreditCount > 0
      ? null
      : 'NO_JOB_PAYOUT_TRANSACTION',
    components: {
      basePayout: unavailableMoneyComponent(),
      sameDayIncentive: unavailableMoneyComponent(),
      visitationCharge: unavailableMoneyComponent(),
      material: unavailableMoneyComponent(),
      penalty: unavailableMoneyComponent(),
      technicianEarning: transactionCount > 0 ? {
        available: true,
        amount: money(row.technician_earning),
        source: 'tbl_job_transaction.efr_charge',
        reasonCode: null,
      } : unavailableMoneyComponent('NO_JOB_TRANSACTION'),
      paidToTechnician: walletCreditCount > 0 ? {
        available: true,
        amount: money(row.paid_to_technician),
        source: 'tbl_easyfixer_transaction.amount',
        reasonCode: null,
      } : unavailableMoneyComponent('NO_JOB_LINKED_WALLET_CREDIT'),
    },
  };
}

async function resolveProofImageUrl(storedValue) {
  const stored = String(storedValue || '').trim();
  if (!stored) return null;

  /*
   * Canonical JobSupportings keys were written by this backend after a
   * successful PutObject, so signing them directly is safe and purely local.
   * The shared resolver first sends HeadObject; skipping that network probe
   * halves S3 operations on the common path. Old Job_Images keys and bare
   * filenames still use resolveImageUrl so their S3/local-disk fallback stays
   * byte-for-byte compatible.
  */
  if (s3Storage.isEnabled() && CANONICAL_JOB_PROOF_KEY.test(stored)) {
    try {
      return await s3Storage.getPresignedUrl(stored);
    } catch {
      // Preserve the existing resolver's local fallback on an exceptional
      // credentials/signing failure; only the healthy canonical path skips
      // the S3 existence probe.
      return s3Storage.resolveImageUrl(stored);
    }
  }
  return s3Storage.resolveImageUrl(stored);
}

async function resolveProofRows(rows, jobId = null) {
  const source = Array.isArray(rows) ? rows : [];
  const result = new Array(source.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < source.length) {
      const index = nextIndex;
      nextIndex += 1;
      const image = source[index];
      let url = null;
      try {
        url = await resolveProofImageUrl(image.image);
      } catch (error) {
        logger.warn(
          { err: error.message, jobId: jobId == null ? undefined : Number(jobId), imageId: Number(image.image_id) },
          'PHE proof image URL resolution failed',
        );
      }
      result[index] = { image, url };
    }
  };

  const workerCount = Math.min(PROOF_IMAGE_RESOLUTION_CONCURRENCY, source.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return result;
}

function pageValues({ page = 1, limit = 20 } = {}) {
  const p = Math.max(Number(page) || 1, 1);
  const l = Math.min(Math.max(Number(limit) || 20, 1), 50);
  return { page: p, limit: l, offset: (p - 1) * l };
}

function monthsBefore(before, limit) {
  const result = [];
  let cursor = shiftMonth(before, -1);
  for (let i = 0; i < limit; i += 1) {
    result.push(cursor);
    cursor = shiftMonth(cursor, -1);
  }
  return result;
}

function hasMonthActivity(item) {
  return item.earnings !== 0
    || item.given !== 0
    || item.accepted !== 0
    || item.completed !== 0
    || item.sameDay !== 0
    || item.rating != null;
}

async function getOverview(efrId, { before, limit = 6 } = {}, db = pool) {
  const exclusiveBefore = before || shiftMonth(currentIstMonth(), 1);
  monthParts(exclusiveBefore);
  const cappedLimit = Math.min(Math.max(Number(limit) || 6, 1), 12);
  const to = `${exclusiveBefore}-01`;

  logger.info(`PHE overview · efrId=${efrId} before=${exclusiveBefore} limit=${cappedLimit}`);

  const accountPromise = db.query(
    `SELECT e.current_balance,
            w.request_id, w.amount, w.status, w.requested_on, w.processed_on,
            w.bank_name, w.bank_account_number
       FROM tbl_easyfixer e
       LEFT JOIN tbl_easyfixer_withdrawal_request w
              ON w.request_id = (
                SELECT MAX(w2.request_id)
                  FROM tbl_easyfixer_withdrawal_request w2
                 WHERE w2.fk_easyfixer_id = e.efr_id
              )
      WHERE e.efr_id = ? AND NOT (e.efr_status <=> 3)
      LIMIT 1`,
    [efrId],
  );

  /*
   * Wallet money needs three deliberately different labels in the app:
   *
   *   currentBalance   the accounting balance, which finance only debits on
   *                    settlement;
   *   claimableNow     what a second payout request may safely ask for now;
   *   totalWithdrawn   requests finance has actually paid.
   *
   * A requested payout still leaves current_balance untouched, so presenting
   * that raw column as "claimable" would invite a second request that the
   * transactional withdrawal service must reject. This one technician-scoped
   * aggregate keeps those meanings separate without per-row work.
   */
  const withdrawalSummaryPromise = db.query(
    `SELECT COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) AS total_withdrawn,
            COALESCE(MAX(CASE WHEN status = 'requested' THEN amount END), 0) AS pending_amount,
            SUM(status = 'requested') AS open_count
       FROM tbl_easyfixer_withdrawal_request
      WHERE fk_easyfixer_id = ?`,
    [efrId],
  );

  /*
   * Lifetime job earnings is a job-performance metric, not a wallet metric.
   * The canonical source used by CRM lifecycle/performance reporting is the
   * technician share on completed job transactions. Manual wallet recharges
   * and withdrawal bookkeeping therefore cannot inflate it.
   */
  const lifetimeJobEarningsPromise = db.query(
    `SELECT COALESCE(SUM(CASE WHEN q.job_status IN (3, 5)
                              THEN q.technician_earning ELSE 0 END), 0) AS lifetime_job_earnings,
            SUM(q.is_under_audit) AS under_audit_jobs,
            SUM(q.is_under_audit AND q.transaction_count > 0) AS under_audit_amount_known_jobs,
            COALESCE(SUM(CASE WHEN q.is_under_audit = 1 AND q.transaction_count > 0
                              THEN q.technician_earning ELSE 0 END), 0) AS under_audit_known_amount
       FROM (
         SELECT j.job_id, j.job_status,
                (${UNDER_AUDIT_PREDICATE}) AS is_under_audit,
                COUNT(tjt.fk_job_id) AS transaction_count,
                COALESCE(SUM(tjt.efr_charge), 0) AS technician_earning
           FROM tbl_job j
           LEFT JOIN tbl_job_transaction tjt ON tjt.fk_job_id = j.job_id
          WHERE j.fk_easyfixter_id = ?
            AND (j.job_status IN (3, 5) OR j.job_status = ${UNDER_AUDIT_STATUS})
          GROUP BY j.job_id, j.job_status, j.app_checkout_date_time,
                   j.no_of_req_approval, j.no_of_req_foh, j.revisit_reason_id
       ) q`,
    [efrId],
  );

  /*
   * Page over months that actually contain technician activity. Dense
   * calendar windows used to stop at the first six-month inactive gap and
   * made all older history unreachable. One extra row is the bounded has-more
   * signal; every branch remains technician scoped.
   */
  const activityMonthsResult = await db.query(
    `SELECT activity.month_key
       FROM (
         SELECT DATE_FORMAT(j.checkout_date_time, '%Y-%m') AS month_key
           FROM tbl_job j
          WHERE j.fk_easyfixter_id = ?
            AND j.job_status IN (3, 5)
            AND j.checkout_date_time < ?
          GROUP BY DATE_FORMAT(j.checkout_date_time, '%Y-%m')
         UNION
         SELECT DATE_FORMAT(jo.offered_at, '%Y-%m') AS month_key
           FROM tbl_job_offer jo
          WHERE jo.fk_easyfixter_id = ?
            AND jo.offered_at < ?
          GROUP BY DATE_FORMAT(jo.offered_at, '%Y-%m')
       ) activity
      WHERE activity.month_key IS NOT NULL
      ORDER BY activity.month_key DESC
      LIMIT ?`,
    [efrId, to, efrId, to, cappedLimit + 1],
  ).catch(async (error) => {
    if (error?.code !== 'ER_NO_SUCH_TABLE') throw error;
    return db.query(
      `SELECT DATE_FORMAT(j.checkout_date_time, '%Y-%m') AS month_key
         FROM tbl_job j
        WHERE j.fk_easyfixter_id = ?
          AND j.job_status IN (3, 5)
          AND j.checkout_date_time < ?
        GROUP BY DATE_FORMAT(j.checkout_date_time, '%Y-%m')
        ORDER BY month_key DESC
        LIMIT ?`,
      [efrId, to, cappedLimit + 1],
    );
  });
  const activityMonths = (activityMonthsResult[0] || [])
    .map((row) => row.month_key)
    .filter(Boolean);
  const hasMoreMonths = activityMonths.length > cappedLimit;
  const monthKeys = activityMonths.slice(0, cappedLimit);
  const from = monthKeys.length ? `${monthKeys[monthKeys.length - 1]}-01` : to;

  // A Paid-month card uses completed jobs as the cohort, including legitimate
  // zero-rupee warranty visits. The technician share comes from the same
  // tbl_job_transaction.efr_charge source as CRM performance reporting. Wallet
  // credits are settlement/audit records and must not redefine job earnings.
  const paidJobsPromise = monthKeys.length ? db.query(
    `SELECT DATE_FORMAT(p.checkout_date_time, '%Y-%m') AS month_key,
            COALESCE(SUM(p.technician_earning), 0) AS earnings,
            COUNT(*) AS completed,
            SUM(DATE(p.checkin_date_time) = DATE(COALESCE(p.original_appointment_date_time, p.requested_date_time))) AS same_day,
            AVG(r.job_rating) AS rating
       FROM (
         SELECT j.job_id, j.checkout_date_time, j.checkin_date_time,
                j.original_appointment_date_time, j.requested_date_time,
                COALESCE(SUM(tjt.efr_charge), 0) AS technician_earning
           FROM tbl_job j
           LEFT JOIN tbl_job_transaction tjt ON tjt.fk_job_id = j.job_id
          WHERE j.fk_easyfixter_id = ?
            AND j.job_status IN (3, 5)
            AND j.checkout_date_time >= ?
            AND j.checkout_date_time < ?
          GROUP BY j.job_id, j.checkout_date_time, j.checkin_date_time,
                   j.original_appointment_date_time, j.requested_date_time
       ) p
       LEFT JOIN (
         SELECT rc.job_id, AVG(rc.customer_rating) AS job_rating
           FROM tbl_easyfixer_rating_by_customer rc
          WHERE rc.easyfixer_id = ?
          GROUP BY rc.job_id
       ) r ON r.job_id = p.job_id
      GROUP BY month_key`,
    [efrId, from, to, efrId],
  ) : Promise.resolve([[]]);

  const offersPromise = monthKeys.length ? db.query(
    `SELECT DATE_FORMAT(jo.offered_at, '%Y-%m') AS month_key,
            COUNT(DISTINCT jo.job_id) AS given_count,
            COUNT(DISTINCT CASE WHEN jo.offer_status = ${OFFER_STATUS.ACCEPTED}
                                THEN jo.job_id END) AS accepted_count
       FROM tbl_job_offer jo
      WHERE jo.fk_easyfixter_id = ?
        AND jo.offered_at >= ?
        AND jo.offered_at < ?
      GROUP BY month_key`,
    [efrId, from, to],
  ).catch((error) => {
    if (error?.code === 'ER_NO_SUCH_TABLE') return [[]];
    throw error;
  }) : Promise.resolve([[]]);

  const [accountResult, withdrawalSummaryResult, lifetimeResult, paidJobResult, offerResult] = await Promise.all([
    accountPromise,
    withdrawalSummaryPromise,
    lifetimeJobEarningsPromise,
    paidJobsPromise,
    offersPromise,
  ]);
  const account = accountResult[0]?.[0] || null;
  if (!account) {
    const error = new Error('Technician not found');
    error.status = 404;
    throw error;
  }

  const paidJobs = new Map((paidJobResult[0] || []).map((r) => [r.month_key, r]));
  const offers = new Map((offerResult[0] || []).map((r) => [r.month_key, r]));
  const withdrawalSummary = withdrawalSummaryResult[0]?.[0] || {};
  const financialJobSummary = lifetimeResult[0]?.[0] || {};
  const currentBalance = Math.max(money(account.current_balance), 0);
  const hasOpenWithdrawal = num(withdrawalSummary.open_count) > 0;
  const underAuditJobs = num(financialJobSummary.under_audit_jobs);
  const underAuditKnownJobs = num(financialJobSummary.under_audit_amount_known_jobs);

  const items = monthKeys.map((month) => {
    const paid = paidJobs.get(month) || {};
    const o = offers.get(month) || {};
    return {
      month,
      label: monthLabel(month),
      earnings: money(paid.earnings),
      given: num(o.given_count),
      accepted: num(o.accepted_count),
      completed: num(paid.completed),
      sameDay: num(paid.same_day),
      rating: paid.rating == null ? null : Number(num(paid.rating).toFixed(1)),
    };
  });

  return {
    wallet: {
      // Compatibility field retained for older app builds. It now carries the
      // safe claimable amount, not the raw accounting balance.
      availableToWithdraw: hasOpenWithdrawal ? 0 : currentBalance,
      claimableNow: hasOpenWithdrawal ? 0 : currentBalance,
      canWithdraw: !hasOpenWithdrawal && currentBalance > 0,
      currentBalance,
      pendingWithdrawalAmount: money(withdrawalSummary.pending_amount),
      totalWithdrawn: money(withdrawalSummary.total_withdrawn),
      lifetimeJobEarnings: money(financialJobSummary.lifetime_job_earnings),
      // This is only the transaction-backed amount for the strict operations
      // Under Audit cohort. It must not be labelled as client QC.
      workInProgress: underAuditJobs > 0
        ? money(financialJobSummary.under_audit_known_amount)
        : null,
    },
    qualityReview: {
      available: true,
      source: 'tbl_job legacy under-audit predicate',
      semantics: 'OPERATIONS_UNDER_AUDIT_NOT_CLIENT_QC',
      jobs: underAuditJobs,
      amountKnownJobs: underAuditKnownJobs,
      knownTechnicianEarning: money(financialJobSummary.under_audit_known_amount),
      amountCoverageComplete: underAuditKnownJobs === underAuditJobs,
    },
    latestWithdrawal: withdrawalShape(account),
    months: {
      items,
      nextCursor: hasMoreMonths && items.length ? items[items.length - 1].month : null,
    },
    features: {
      qc: false,
      inQa: true,
      workInProgress: true,
    },
  };
}

async function getInQa(efrId, paging = {}, db = pool) {
  const { page, limit, offset } = pageValues(paging);
  logger.info(`PHE Under Audit · efrId=${efrId} page=${page} limit=${limit}`);

  const [rowsResult, summaryResult] = await Promise.all([
    db.query(
      `SELECT j.job_id,
              COALESCE(sc.service_catg_name, st.service_type_name, CONCAT('Job #', j.job_id)) AS title,
              cl.client_name, j.app_checkout_date_time,
              GREATEST(TIMESTAMPDIFF(DAY, j.app_checkout_date_time, NOW()), 0) AS review_age_days,
              GREATEST(TIMESTAMPDIFF(SECOND, j.app_checkout_date_time, NOW()), 0) AS review_age_secs,
              COUNT(tjt.fk_job_id) AS transaction_count,
              COALESCE(SUM(tjt.efr_charge), 0) AS technician_earning
         FROM tbl_job j
         LEFT JOIN tbl_job_transaction tjt ON tjt.fk_job_id = j.job_id
         LEFT JOIN tbl_client cl ON cl.client_id = j.fk_client_id
         LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = j.fk_service_catg_id
         LEFT JOIN tbl_service_type st ON st.service_type_id = j.fk_service_type_id
        WHERE j.fk_easyfixter_id = ?
          AND ${UNDER_AUDIT_PREDICATE}
        GROUP BY j.job_id, sc.service_catg_name, st.service_type_name,
                 cl.client_name, j.app_checkout_date_time
        ORDER BY j.app_checkout_date_time DESC, j.job_id DESC
        LIMIT ? OFFSET ?`,
      [efrId, limit, offset],
    ),
    db.query(
      `SELECT COUNT(*) AS total_jobs,
              SUM(q.transaction_count > 0) AS amount_known_jobs,
              COALESCE(SUM(CASE WHEN q.transaction_count > 0
                                THEN q.technician_earning ELSE 0 END), 0) AS known_amount
         FROM (
           SELECT j.job_id, COUNT(tjt.fk_job_id) AS transaction_count,
                  COALESCE(SUM(tjt.efr_charge), 0) AS technician_earning
             FROM tbl_job j
             LEFT JOIN tbl_job_transaction tjt ON tjt.fk_job_id = j.job_id
            WHERE j.fk_easyfixter_id = ?
              AND ${UNDER_AUDIT_PREDICATE}
            GROUP BY j.job_id
         ) q`,
      [efrId],
    ),
  ]);

  const summary = summaryResult[0]?.[0] || {};
  const total = num(summary.total_jobs);
  const amountKnownJobs = num(summary.amount_known_jobs);
  return {
    availability: {
      available: true,
      source: 'tbl_job legacy under-audit predicate',
      semantics: 'OPERATIONS_UNDER_AUDIT_NOT_CLIENT_QC',
      reasonCode: null,
    },
    items: (rowsResult[0] || []).map((row) => {
      const amountAvailable = num(row.transaction_count) > 0;
      return {
        jobId: Number(row.job_id),
        title: row.title,
        clientName: row.client_name || null,
        reviewStartedAt: row.app_checkout_date_time || null,
        reviewAgeDays: num(row.review_age_days),
        reviewAgeSecs: num(row.review_age_secs),
        state: {
          code: 'UNDER_AUDIT',
          source: 'tbl_job.job_status + audit request counters',
        },
        action: {
          required: false,
          code: null,
          reasonCode: 'NO_TECHNICIAN_ACTION_RECORDED',
        },
        amount: amountAvailable ? money(row.technician_earning) : null,
        amountAvailability: {
          available: amountAvailable,
          source: amountAvailable ? 'tbl_job_transaction.efr_charge' : null,
          reasonCode: amountAvailable ? null : 'NO_JOB_TRANSACTION',
        },
      };
    }),
    summary: {
      jobs: total,
      amountKnownJobs,
      knownTechnicianEarning: money(summary.known_amount),
      amountCoverageComplete: amountKnownJobs === total,
    },
    total,
    page,
    limit,
  };
}

async function getMonthJobs(efrId, month, paging = {}, db = pool) {
  const { start, end } = monthBounds(month);
  const { page, limit, offset } = pageValues(paging);

  const [rowsResult, countResult] = await Promise.all([
    db.query(
      `SELECT j.job_id,
              COALESCE(sc.service_catg_name, st.service_type_name, CONCAT('Job #', j.job_id)) AS title,
              cl.client_name, j.ticket_created_date_time, j.created_date_time,
              j.checkout_date_time,
              (SELECT MIN(et.transaction_date)
                 FROM tbl_easyfixer_transaction et
                WHERE et.easyfixer_id = ?
                  AND et.transaction_type = 2
                  AND et.job_id = j.job_id) AS paid_at,
              COALESCE(SUM(tjt.efr_charge), 0) AS technician_earning,
              ${JOB_AGE_DAYS_EXPR} AS age_days,
              ${JOB_AGE_SECS_EXPR} AS age_secs,
              j.visit_number, r.job_rating, COALESCE(r.is_escalated, 0) AS is_escalated,
              (j.checkin_date_time IS NOT NULL
                AND j.checkin_date_time <= DATE_ADD(j.requested_date_time, INTERVAL 60 MINUTE)) AS on_time,
              (j.checkin_date_time IS NOT NULL
                AND DATE(j.checkin_date_time) = DATE(COALESCE(j.original_appointment_date_time, j.requested_date_time))) AS same_day
         FROM tbl_job j
         LEFT JOIN tbl_job_transaction tjt ON tjt.fk_job_id = j.job_id
         LEFT JOIN tbl_client cl ON cl.client_id = j.fk_client_id
         LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = j.fk_service_catg_id
         LEFT JOIN tbl_service_type st ON st.service_type_id = j.fk_service_type_id
         LEFT JOIN (
           SELECT rc.job_id, AVG(rc.customer_rating) AS job_rating,
                  MAX(COALESCE(rc.is_escalated, 0)) AS is_escalated
             FROM tbl_easyfixer_rating_by_customer rc
            WHERE rc.easyfixer_id = ?
            GROUP BY rc.job_id
         ) r ON r.job_id = j.job_id
        WHERE j.fk_easyfixter_id = ?
          AND j.job_status IN (3, 5)
          AND j.checkout_date_time >= ?
          AND j.checkout_date_time < ?
        GROUP BY j.job_id, sc.service_catg_name, st.service_type_name,
                 cl.client_name, j.ticket_created_date_time, j.created_date_time,
                 j.checkout_date_time, j.job_status, j.cancel_date_time,
                 j.enquiry_date_time, j.visit_number, r.job_rating, r.is_escalated,
                 j.checkin_date_time, j.requested_date_time,
                 j.original_appointment_date_time
        ORDER BY j.checkout_date_time DESC, j.job_id DESC
        LIMIT ? OFFSET ?`,
      [efrId, efrId, efrId, start, end, limit, offset],
    ),
    db.query(
      `SELECT COUNT(*) AS total
         FROM tbl_job j
        WHERE j.fk_easyfixter_id = ?
          AND j.job_status IN (3, 5)
          AND j.checkout_date_time >= ?
          AND j.checkout_date_time < ?`,
      [efrId, start, end],
    ),
  ]);

  return {
    month,
    items: (rowsResult[0] || []).map((r) => ({
      jobId: Number(r.job_id),
      title: r.title,
      clientName: r.client_name || null,
      bookedAt: r.ticket_created_date_time || null,
      recordCreatedAt: r.created_date_time || null,
      ageDays: num(r.age_days),
      ageSecs: num(r.age_secs),
      completedAt: r.checkout_date_time || null,
      paidAt: r.paid_at || null,
      amount: money(r.technician_earning),
      rating: r.job_rating == null ? null : Number(num(r.job_rating).toFixed(1)),
      onTime: Boolean(r.on_time),
      sameDay: Boolean(r.same_day),
      visitNumber: r.visit_number == null ? null : num(r.visit_number),
      isEscalated: Boolean(r.is_escalated),
    })),
    total: num(countResult[0]?.[0]?.total),
    page,
    limit,
  };
}

async function getJobDetail(efrId, jobId, db = pool) {
  const [[row]] = await db.query(
    `SELECT j.job_id,
            COALESCE(sc.service_catg_name, st.service_type_name, CONCAT('Job #', j.job_id)) AS title,
            cl.client_name, j.ticket_created_date_time, j.created_date_time,
            j.job_status, j.checkout_date_time, j.app_checkout_date_time,
            j.checkin_date_time AS reached_at,
            j.visit_number, j.revisit_reason_id,
            j.no_of_req_approval, j.no_of_req_foh,
            ${JOB_AGE_DAYS_EXPR} AS age_days,
            ${JOB_AGE_SECS_EXPR} AS age_secs,
            wallet.paid_at, wallet.wallet_credit_count, wallet.paid_to_technician,
            COALESCE(tx.technician_earning, 0) AS technician_earning,
            tx.transaction_count, tx.gross_charge, tx.easyfix_charge, tx.client_charge,
            accepted.offered_at, accepted.responded_at AS accepted_at,
            CASE WHEN accepted.offered_at IS NOT NULL AND accepted.responded_at IS NOT NULL
                 THEN GREATEST(TIMESTAMPDIFF(SECOND, accepted.offered_at, accepted.responded_at), 0)
                 ELSE NULL END AS accepted_in_secs,
            r.customer_rating, COALESCE(NULLIF(r.comment, ''), r.review_comment) AS feedback,
            COALESCE(r.is_escalated, 0) AS is_escalated,
            COALESCE(NULLIF(j.job_customer_name, ''), cu.customer_name) AS reviewer_name,
            NULLIF(CONCAT_WS(', ', ad.address, ad.building, ad.locality, ci.city_name, ad.pin_code), '') AS full_address,
            ef.efr_id AS attendee_efr_id, ef.efr_name AS attendee_name,
            rr.reason AS revisit_reason
       FROM tbl_job j
       LEFT JOIN tbl_client cl ON cl.client_id = j.fk_client_id
       LEFT JOIN tbl_customer cu ON cu.customer_id = j.fk_customer_id
       LEFT JOIN tbl_address ad ON ad.address_id = j.fk_address_id
       LEFT JOIN tbl_city ci ON ci.city_id = ad.city_id
       LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = j.fk_service_catg_id
       LEFT JOIN tbl_service_type st ON st.service_type_id = j.fk_service_type_id
       LEFT JOIN (
         SELECT MIN(et.transaction_date) AS paid_at,
                COUNT(*) AS wallet_credit_count,
                SUM(ABS(et.amount)) AS paid_to_technician
           FROM tbl_easyfixer_transaction et
          WHERE et.easyfixer_id = ? AND et.transaction_type = 2 AND et.job_id = ?
       ) wallet ON 1 = 1
       LEFT JOIN (
         SELECT COUNT(*) AS transaction_count,
                SUM(COALESCE(tjt.efr_charge, 0)) AS technician_earning,
                SUM(COALESCE(tjt.total_charge, 0)) AS gross_charge,
                SUM(COALESCE(tjt.ef_charge, 0)) AS easyfix_charge,
                SUM(COALESCE(tjt.client_charge, 0)) AS client_charge
           FROM tbl_job_transaction tjt
          WHERE tjt.fk_job_id = ?
       ) tx ON 1 = 1
       LEFT JOIN (
         SELECT jo.offered_at, jo.responded_at
           FROM tbl_job_offer jo
          WHERE jo.job_id = ?
            AND jo.fk_easyfixter_id = ?
            AND jo.offer_status = ${OFFER_STATUS.ACCEPTED}
          ORDER BY jo.job_offer_id DESC
          LIMIT 1
       ) accepted ON 1 = 1
       LEFT JOIN tbl_easyfixer_rating_by_customer r
              ON r.id = (
                SELECT r2.id
                  FROM tbl_easyfixer_rating_by_customer r2
                 WHERE r2.easyfixer_id = ? AND r2.job_id = j.job_id
                 ORDER BY r2.insert_date_time DESC, r2.id DESC
                 LIMIT 1
              )
       LEFT JOIN tbl_easyfixer ef ON ef.efr_id = j.fk_easyfixter_id
       LEFT JOIN revisit_reason_by_app rr ON rr.id = j.revisit_reason_id
      WHERE j.job_id = ?
        AND j.fk_easyfixter_id = ?
        AND (
          j.job_status IN (3, 5)
          OR (${UNDER_AUDIT_PREDICATE})
        )
      LIMIT 1`,
    [efrId, jobId, jobId, jobId, efrId, efrId, jobId, efrId],
  );
  if (!row) {
    const error = new Error('job not found');
    error.status = 404;
    throw error;
  }

  // Cap both SQL rows and URL-signing work. Reading each proof bucket
  // independently preserves the earliest "before" evidence and the latest
  // completion evidence even on jobs with a noisy historical image trail.
  const [beforeResult, afterResult] = await Promise.all([
    db.query(
      `SELECT image_id, image, image_category, job_stage, created_date
         FROM tbl_job_image
        WHERE job_id = ?
          AND (LOWER(image_category) IN ('booking', 'before', 'checkin') OR job_stage = 0)
        ORDER BY image_id ASC
        LIMIT 10`,
      [jobId],
    ),
    db.query(
      `SELECT image_id, image, image_category, job_stage, created_date
         FROM tbl_job_image
        WHERE job_id = ?
          AND (LOWER(image_category) IN ('completion', 'after') OR job_stage = 5)
        ORDER BY image_id DESC
        LIMIT 10`,
      [jobId],
    ),
  ]);
  const imageRows = [...new Map(
    [...(beforeResult[0] || []), ...(afterResult[0] || [])]
      .map((image) => [image.image_id, image]),
  ).values()];

  const proof = { before: [], after: [] };
  const resolvedImages = await resolveProofRows(imageRows, jobId);
  // Preserve SQL order even when signed-URL calls resolve out of order.
  // Deterministic evidence ordering prevents a refresh from visually shuffling
  // the same job's proof tiles.
  resolvedImages.forEach(({ image, url }) => {
    if (!url) return;
    const category = String(image.image_category || '').toLowerCase();
    const item = {
      imageId: Number(image.image_id),
      url,
      createdAt: image.created_date || null,
    };
    if (category === 'completion' || category === 'after' || Number(image.job_stage) === 5) {
      proof.after.push(item);
    } else if (category === 'booking' || category === 'before' || category === 'checkin' || Number(image.job_stage) === 0) {
      proof.before.push(item);
    }
  });

  return {
    jobId: Number(row.job_id),
    title: row.title,
    clientName: row.client_name || null,
    completedAt: row.checkout_date_time || null,
    paidAt: row.paid_at || null,
    amount: money(row.technician_earning),
    // The legacy transaction table does not split technician earnings into
    // base pay, incentive and penalty columns. Expose only the sums it actually
    // stores so clients never label an invented breakdown as authoritative.
    earningsCalculation: num(row.transaction_count) > 0 ? {
      technicianEarning: money(row.technician_earning),
      grossJobCharge: money(row.gross_charge),
      easyFixCharge: money(row.easyfix_charge),
      clientCharge: money(row.client_charge),
      transactionLines: num(row.transaction_count),
    } : null,
    payoutBreakdown: payoutBreakdown(row),
    qualityReview: Number(row.job_status) === UNDER_AUDIT_STATUS ? {
      state: 'UNDER_AUDIT',
      source: 'tbl_job legacy under-audit predicate',
      semantics: 'OPERATIONS_UNDER_AUDIT_NOT_CLIENT_QC',
      startedAt: row.app_checkout_date_time || null,
      action: {
        required: false,
        code: null,
        reasonCode: 'NO_TECHNICIAN_ACTION_RECORDED',
      },
    } : null,
    customerFeedback: row.customer_rating == null && !row.feedback ? null : {
      rating: row.customer_rating == null ? null : Number(row.customer_rating),
      comment: row.feedback || null,
      reviewerDisplayName: maskPersonName(row.reviewer_name),
    },
    proof,
    bookedAt: row.ticket_created_date_time || null,
    recordCreatedAt: row.created_date_time || null,
    ageDays: num(row.age_days),
    ageSecs: num(row.age_secs),
    offeredAt: row.offered_at || null,
    acceptedAt: row.accepted_at || null,
    acceptedInSecs: row.accepted_in_secs == null ? null : num(row.accepted_in_secs),
    reachedAt: row.reached_at || null,
    visitNumber: row.visit_number == null ? null : num(row.visit_number),
    recordedRevisitReason: row.revisit_reason_id == null ? null : {
      id: num(row.revisit_reason_id),
      label: row.revisit_reason || null,
    },
    isEscalated: Boolean(row.is_escalated),
    // Stable code lets each supported app language render its own self label.
    // This technician-scoped endpoint cannot truthfully infer a different team
    // attendee from the current schema.
    attendedByType: 'SELF',
    attendee: row.attendee_efr_id == null ? null : {
      efrId: Number(row.attendee_efr_id),
      displayName: row.attendee_name || null,
      isSelf: Number(row.attendee_efr_id) === Number(efrId),
    },
    address: row.full_address || null,
  };
}

async function missedWindow(efrId, from, to, db) {
  const offersQuery = db.query(
    `SELECT
       SUM(x.offer_status = ${OFFER_STATUS.EXPIRED}) AS expired_jobs,
       SUM(x.offer_status = ${OFFER_STATUS.REJECTED}) AS rejected_jobs,
       SUM(CASE WHEN x.offer_status = ${OFFER_STATUS.EXPIRED} THEN x.known_amount ELSE 0 END) AS expired_amount,
       SUM(CASE WHEN x.offer_status = ${OFFER_STATUS.REJECTED} THEN x.known_amount ELSE 0 END) AS rejected_amount,
       SUM(CASE WHEN x.offer_status = ${OFFER_STATUS.EXPIRED} AND x.has_amount = 1 THEN 1 ELSE 0 END) AS expired_known,
       SUM(CASE WHEN x.offer_status = ${OFFER_STATUS.REJECTED} AND x.has_amount = 1 THEN 1 ELSE 0 END) AS rejected_known
     FROM (
       SELECT jo.job_id, jo.offer_status,
              COALESCE(SUM(tjt.efr_charge), 0) AS known_amount,
              (COUNT(tjt.fk_job_id) > 0) AS has_amount
         FROM tbl_job_offer jo
         JOIN (
           SELECT job_id, MAX(job_offer_id) AS latest_offer_id
             FROM tbl_job_offer
            WHERE fk_easyfixter_id = ?
              AND offer_status IN (${OFFER_STATUS.REJECTED}, ${OFFER_STATUS.EXPIRED})
              AND responded_at >= ?
              AND responded_at < ?
            GROUP BY job_id
         ) latest ON latest.latest_offer_id = jo.job_offer_id
         LEFT JOIN tbl_job_transaction tjt ON tjt.fk_job_id = jo.job_id
        GROUP BY jo.job_id, jo.offer_status
     ) x`,
    [efrId, from, to],
  ).catch((error) => {
    if (error?.code === 'ER_NO_SUCH_TABLE') return [[{}]];
    throw error;
  });

  const cancelledQuery = db.query(
    `SELECT COUNT(*) AS cancelled_jobs,
            SUM(x.known_amount) AS cancelled_amount,
            SUM(x.has_amount = 1) AS cancelled_known
       FROM (
         SELECT j.job_id, COALESCE(SUM(tjt.efr_charge), 0) AS known_amount,
                (COUNT(tjt.fk_job_id) > 0) AS has_amount
           FROM tbl_job j
           LEFT JOIN tbl_job_transaction tjt ON tjt.fk_job_id = j.job_id
          WHERE j.fk_easyfixter_id = ?
            AND j.job_status = 6
            AND j.cancel_date_time >= ?
            AND j.cancel_date_time < ?
          GROUP BY j.job_id
       ) x`,
    [efrId, from, to],
  );

  const [offerResult, cancelResult] = await Promise.all([offersQuery, cancelledQuery]);
  const o = offerResult[0]?.[0] || {};
  const c = cancelResult[0]?.[0] || {};
  const expiredJobs = num(o.expired_jobs);
  const rejectedJobs = num(o.rejected_jobs);
  const cancelledJobs = num(c.cancelled_jobs);
  const expiredKnown = num(o.expired_known);
  const rejectedKnown = num(o.rejected_known);
  const cancelledKnown = num(c.cancelled_known);

  const categories = [
    {
      key: 'expired', label: 'Offer expired', jobs: expiredJobs,
      knownAmount: money(o.expired_amount), amountCoverageComplete: expiredKnown === expiredJobs,
    },
    {
      key: 'rejected', label: 'Offer declined', jobs: rejectedJobs,
      knownAmount: money(o.rejected_amount), amountCoverageComplete: rejectedKnown === rejectedJobs,
    },
    {
      key: 'cancelledAfterAssignment', label: 'Cancelled after assignment', jobs: cancelledJobs,
      knownAmount: money(c.cancelled_amount), amountCoverageComplete: cancelledKnown === cancelledJobs,
    },
  ];
  const totalJobs = expiredJobs + rejectedJobs + cancelledJobs;
  const knownJobs = expiredKnown + rejectedKnown + cancelledKnown;
  return {
    expiredOffers: expiredJobs,
    rejectedOffers: rejectedJobs,
    cancelledJobs,
    knownPotentialAmount: money(categories.reduce((sum, item) => sum + item.knownAmount, 0)),
    amountCoverageComplete: knownJobs === totalJobs,
    categories,
  };
}

async function getMissed(efrId, { days = 30 } = {}, db = pool) {
  const windowDays = Number(days) || 30;
  const today = todayIst();
  const currentTo = shiftYmd(today, 1);
  const currentFrom = shiftYmd(currentTo, -windowDays);
  const previousFrom = shiftYmd(currentFrom, -windowDays);
  const [current, previous] = await Promise.all([
    missedWindow(efrId, currentFrom, currentTo, db),
    missedWindow(efrId, previousFrom, currentFrom, db),
  ]);
  return {
    period: { days: windowDays, from: currentFrom, to: today },
    summary: {
      expiredOffers: current.expiredOffers,
      rejectedOffers: current.rejectedOffers,
      cancelledJobs: current.cancelledJobs,
      knownPotentialAmount: current.knownPotentialAmount,
      amountCoverageComplete: current.amountCoverageComplete,
    },
    previousPeriod: {
      expiredOffers: previous.expiredOffers,
      rejectedOffers: previous.rejectedOffers,
      cancelledJobs: previous.cancelledJobs,
      knownPotentialAmount: previous.knownPotentialAmount,
      amountCoverageComplete: previous.amountCoverageComplete,
    },
    categories: current.categories,
  };
}

async function getWithdrawals(efrId, paging = {}, db = pool) {
  const { page, limit, offset } = pageValues(paging);
  const [rowsResult, countResult] = await Promise.all([
    db.query(
      `SELECT request_id, amount, status, requested_on, processed_on,
              bank_name, bank_account_number
         FROM tbl_easyfixer_withdrawal_request
        WHERE fk_easyfixer_id = ?
        ORDER BY request_id DESC
        LIMIT ? OFFSET ?`,
      [efrId, limit, offset],
    ),
    db.query(
      `SELECT COUNT(*) AS total
         FROM tbl_easyfixer_withdrawal_request
        WHERE fk_easyfixer_id = ?`,
      [efrId],
    ),
  ]);
  return {
    items: (rowsResult[0] || []).map(withdrawalShape),
    total: num(countResult[0]?.[0]?.total),
    page,
    limit,
  };
}

module.exports = {
  getOverview,
  getInQa,
  getMonthJobs,
  getJobDetail,
  getMissed,
  getWithdrawals,
  _internals: {
    currentIstMonth,
    monthBounds,
    monthsBefore,
    shiftMonth,
    todayIst,
    pageValues,
    hasMonthActivity,
    maskPersonName,
    withdrawalShape,
    resolveProofImageUrl,
    resolveProofRows,
    payoutBreakdown,
    UNDER_AUDIT_PREDICATE,
    PROOF_IMAGE_RESOLUTION_CONCURRENCY,
  },
};
