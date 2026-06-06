const { pool } = require('../db');
const logger = require('../logger');
const magicLinkService = require('./job-magic-link.service');
const conversationService = require('./whatsapp-conversation.service');
// Direct Gallabox handle (separate from magicLinkService.sendForJob) for the
// TEST send path — we explicitly DON'T want the production helper because
// it mutates tbl_job (sent_at, send_count) and writes to tbl_url_shortener
// for the real customer. A test must be side-effect-free against the source
// row + must always go to the operator's typed number, not the customer's.
const whatsappService = require('./gallabox.whatsapp.service');
const { signJobToken } = require('../utils/jwt');

/*
 * Hourly cron — scans Unconfirmed (status=9) jobs whose client is
 * opted in via tbl_client_custom_properties.auto_process_unconfirmed_order
 * and dispatches the WhatsApp magic link if eligible. Guards:
 *   - customer_submitted_at IS NULL (customer hasn't responded yet)
 *   - magic_link_sent_at IS NULL OR magic_link_sent_at < NOW() - INTERVAL 24 HOUR (24h cooldown)
 *   - magic_link_send_count < 3 (cap at 3 sends per job)
 * LIMIT 500 per run to avoid choking on a backlog burst — next hour
 * picks up the rest.
 *
 * Per-row try/catch so a single bad mobile / whatsapp 4xx doesn't stall
 * the batch. action='first' when send_count=0, else 'reminder' (so the
 * audit trail distinguishes the cron's nudge vs. an operator's manual
 * resend).
 *
 * Returns a summary { eligible, attempted, succeeded, failed, skipped }
 * for the scheduler caller to log. Pure side-effect function otherwise.
 */
async function runHourlySweep() {
  const startedAt = Date.now();
  let eligible = 0, attempted = 0, succeeded = 0, failed = 0, skipped = 0;

  try {
    const [rows] = await pool.query(`
      SELECT j.job_id, j.magic_link_sent_at, j.magic_link_send_count,
             (SELECT LOWER(REPLACE(cpm.c_prop_values, '_', ' '))
                FROM tbl_client_custom_properties cpm
               WHERE cpm.client_id = j.fk_client_id
                 AND LOWER(REPLACE(cpm.c_prop_name, '_', ' ')) = LOWER('Order Confirmation Mode')
                 AND cpm.status = 1
               LIMIT 1) AS flow_mode
        FROM tbl_job j
        JOIN tbl_client_custom_properties cp
          ON cp.client_id = j.fk_client_id
         AND LOWER(REPLACE(cp.c_prop_name, '_', ' ')) = LOWER('Auto Process Unconfirmed Order')
         AND LOWER(cp.c_prop_values) = 'true'
         AND cp.status = 1
       WHERE j.job_status = 9
         AND j.customer_submitted_at IS NULL
         AND (j.magic_link_sent_at IS NULL OR j.magic_link_sent_at < NOW() - INTERVAL 24 HOUR)
         AND j.magic_link_send_count < 3
       ORDER BY j.job_id ASC
       LIMIT 500
    `);
    eligible = rows.length;

    for (const row of rows) {
      attempted += 1;
      const action = (row.magic_link_send_count > 0) ? 'reminder' : 'first';
      // Per-client channel: 'conversation' → in-chat AI flow; anything else
      // (incl. unset) → the magic-link FORM. Default keeps existing clients
      // on the form path untouched.
      const conversational = String(row.flow_mode || '').trim() === 'conversation';
      try {
        const result = conversational
          ? await conversationService.startConversation(row.job_id, { action }, pool)
          : await magicLinkService.sendForJob(row.job_id, { action }, pool);
        if (result?.delivered || result?.suppressed) succeeded += 1;
        else {
          failed += 1;
          logger.warn({ jobId: row.job_id, conversational, error: result?.error }, 'unconfirmed-order cron: whatsapp not delivered');
        }
      } catch (e) {
        failed += 1;
        logger.warn({ jobId: row.job_id, conversational, err: e?.message }, 'unconfirmed-order cron: send threw');
      }
    }

    const durationMs = Date.now() - startedAt;
    logger.info({ eligible, attempted, succeeded, failed, skipped, durationMs }, 'magic-link cron sweep complete');
    return { eligible, attempted, succeeded, failed, skipped, durationMs };
  } catch (e) {
    logger.error({ err: e?.message }, 'magic-link cron sweep top-level failure');
    return { eligible, attempted, succeeded, failed: failed + 1, skipped, error: e?.message };
  }
}

/*
 * Test send (2026-06-06). Fires the SAME Gallabox `confirm_order` template
 * the hourly cron fires, but to an arbitrary operator-supplied mobile —
 * never to the real customer. Two modes:
 *
 *   - sourceId omitted → dummy customer name / dummy client name + a
 *     clearly-marked sentinel URL. Useful for verifying template approval
 *     / Gallabox connectivity without touching any real row.
 *
 *   - sourceId provided (a job_id) → we look up THAT job's customer name
 *     and client name and use them in the template body so the test
 *     message looks identical to what THAT customer would receive. We
 *     mint a real magic-link JWT for the same job_id so the URL is
 *     openable (the URL is sent to the operator's mobile, so only the
 *     operator can click it). The lookup is read-only:
 *       - tbl_job.magic_link_sent_at NOT updated
 *       - tbl_job.magic_link_send_count NOT incremented
 *       - tbl_url_shortener row NOT minted (would clutter audit with test rows)
 *     Under no path does the message reach the real customer's number.
 *
 * The mobile is validated to 10 Indian digits (or 12 with the 91 prefix);
 * an invalid number throws a 400 before any provider call. Returns a
 * structured result the route handler surfaces back to the FE for the
 * "Last Run" panel.
 */
async function runTest({ mobile, sourceId } = {}) {
  const phone = String(mobile || '').trim();
  const cleaned = phone.replace(/\D/g, '');
  if (!(cleaned.length === 10 || (cleaned.length === 12 && cleaned.startsWith('91')))) {
    throw Object.assign(new Error('Mobile must be a valid 10-digit Indian number.'), {
      status: 400, code: 'INVALID_TEST_MOBILE',
    });
  }

  // Defaults — used when no sourceId provided OR when a field is missing on
  // the looked-up row. Keep the values obviously-fake so a recipient who
  // gets a misrouted test can recognise it as a test.
  let customerName = 'Test Customer';
  let clientName   = 'EasyFix Demo';
  let jobIdForToken = null;
  let sourceUsed   = null;

  if (sourceId != null && String(sourceId).trim() !== '') {
    const jobId = Number(String(sourceId).trim());
    if (!Number.isInteger(jobId) || jobId <= 0) {
      throw Object.assign(new Error('Job ID must be a positive integer.'), {
        status: 400, code: 'INVALID_SOURCE_ID',
      });
    }
    const [rows] = await pool.query(
      `SELECT j.job_id, j.job_status,
              COALESCE(j.job_customer_name, cu.customer_name) AS customer_name,
              cl.client_name
         FROM tbl_job j
         LEFT JOIN tbl_customer cu ON cu.customer_id = j.fk_customer_id
         LEFT JOIN tbl_client   cl ON cl.client_id   = j.fk_client_id
        WHERE j.job_id = ? LIMIT 1`,
      [jobId],
    );
    if (rows.length === 0) {
      throw Object.assign(new Error(`No job found with id ${jobId}.`), {
        status: 404, code: 'JOB_NOT_FOUND',
      });
    }
    customerName  = rows[0].customer_name || customerName;
    clientName    = rows[0].client_name   || clientName;
    jobIdForToken = rows[0].job_id;
    sourceUsed = {
      job_id: rows[0].job_id,
      job_status: rows[0].job_status,
      customer_name: rows[0].customer_name || null,
      client_name: rows[0].client_name || null,
    };
  }

  // Mint a magic-link URL. If a real job_id is in hand, the token verifies
  // and the link works end-to-end (handy for sanity-checking the customer
  // landing page too); otherwise we ship a clearly-fake sentinel URL.
  let testUrl;
  if (jobIdForToken) {
    try {
      const token = signJobToken({ jobId: jobIdForToken });
      const base = process.env.MAGIC_LINK_BASE_URL || 'https://qa.easyfix.in';
      testUrl = `${base.replace(/\/$/, '')}/job-completion/${token}`;
    } catch (e) {
      logger.warn({ err: e?.message }, 'magic-link TEST: token mint failed, falling back to sentinel URL');
      testUrl = 'https://qa.easyfix.in/job-completion/test-link-please-ignore';
    }
  } else {
    testUrl = 'https://qa.easyfix.in/job-completion/test-link-please-ignore';
  }

  // Send strictly to the operator's mobile. Bypasses sendForJob entirely so
  // no tbl_job mutation + no url-shortener row are created.
  const res = await whatsappService.sendTemplate({
    to: phone,
    recipientName: customerName,
    templateName: 'confirm_order',
    bodyValues: {
      1: customerName,
      2: clientName,
      3: testUrl,
    },
  });

  logger.info(
    `Magic-link TEST · target=${phone} · customerName="${customerName}" · ` +
    `clientName="${clientName}" · job_id=${sourceUsed?.job_id ?? 'none'} · ` +
    `delivered=${!!res?.delivered}`,
  );

  return {
    test: true,
    target_mobile: phone,
    customer_name: customerName,
    client_name: clientName,
    test_url: testUrl,
    source_used: sourceUsed,
    delivered: !!res?.delivered,
    disabled: !!res?.disabled,
    redirected_to_test_mobile: !!res?.redirected,
    intended_to: res?.intendedTo || null,
    http_status: res?.httpStatus || null,
    provider_response: res?.providerResponse ? String(res.providerResponse).slice(0, 240) : null,
    error: res?.error || null,
  };
}

module.exports = { runHourlySweep, runTest };
