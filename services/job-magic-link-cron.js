const { pool } = require('../db');
const logger = require('../logger');
const magicLinkService = require('./job-magic-link.service');

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
      SELECT j.job_id, j.magic_link_sent_at, j.magic_link_send_count
        FROM tbl_job j
        JOIN tbl_client_custom_properties cp
          ON cp.client_id = j.fk_client_id
         AND cp.c_prop_name = 'auto_process_unconfirmed_order'
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
      try {
        const result = await magicLinkService.sendForJob(row.job_id, { action }, pool);
        if (result?.delivered) succeeded += 1;
        else {
          failed += 1;
          logger.warn({ jobId: row.job_id, error: result?.error }, 'magic-link cron: whatsapp not delivered');
        }
      } catch (e) {
        failed += 1;
        logger.warn({ jobId: row.job_id, err: e?.message }, 'magic-link cron: sendForJob threw');
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

module.exports = { runHourlySweep };
