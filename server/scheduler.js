const cron = require('node-cron');
const logger = require('../logger');

/*
 * Cron job registration. Exports init() to register all scheduled tasks
 * and a stop() to tear them down for graceful shutdown.
 *
 * Time zone: Asia/Kolkata. Cron expressions are evaluated in IST so the
 * 4-hourly job (see cron string below) fires at 00:00, 04:00, 08:00,
 * 12:00, 16:00, 20:00 IST — NOT UTC. This matters because legacy CRM
 * operators read call reports with an IST mental model.
 *
 * Dev guard: CRON_DISABLED=true short-circuits init() — useful for local
 * dev where you don't want the 4-hour Kaleyra poller firing against the
 * shared QA database.
 *
 * Future jobs can be appended below. Each registered task is pushed to
 * `tasks[]` so stop() can iterate and call `.stop()` on each.
 */

const TZ = 'Asia/Kolkata';
const tasks = [];

function init() {
  if (String(process.env.CRON_DISABLED).toLowerCase() === 'true') {
    logger.warn('CRON_DISABLED=true — scheduled tasks NOT registered.');
    return;
  }

  // ─── Kaleyra call-report sync — every 4 hours ─────────────────────
  // Polls Kaleyra's dial.callreports for rows where is_updated=0,
  // filling in duration / recording / status / start_time / end_time.
  // Schedule deliberately matches the user's stated frequency (legacy
  // ran hourly; the operator preference is 4-hourly for reduced load).
  const kaleyraSync = require('../services/kaleyra-report-sync.service');
  tasks.push(cron.schedule('0 */4 * * *', async () => {
    const t0 = Date.now();
    try {
      const result = await kaleyraSync.syncPendingReports();
      const ms = Date.now() - t0;
      logger.info(
        `Kaleyra sync cron · checked=${result.checked} · updated=${result.updated} · ` +
        `failed=${result.failed} · ${ms}ms`
      );
    } catch (err) {
      // Cron callbacks must never throw — node-cron would silently
      // swallow the next tick. Log + continue.
      logger.error(`Kaleyra sync cron crashed: ${err.message}`);
    }
  }, { timezone: TZ }));

  // ─── Customer Magic-Link cron — hourly at :05 IST ─────────────────
  // Added 2026-05-28. Scans Unconfirmed (status=9) jobs whose client
  // is opted in via tbl_client_custom_properties.auto_process_unconfirmed_order
  // and dispatches the WhatsApp magic link. Eligibility query +
  // 24h cooldown + 3-send cap live in services/job-magic-link-cron.js.
  const magicLinkCron = require('../services/job-magic-link-cron');
  tasks.push(cron.schedule('5 * * * *', async () => {
    const t0 = Date.now();
    try {
      const result = await magicLinkCron.runHourlySweep();
      const ms = Date.now() - t0;
      logger.info(
        `Magic-link cron · eligible=${result.eligible} · attempted=${result.attempted} · ` +
        `succeeded=${result.succeeded} · failed=${result.failed} · ${ms}ms`
      );
    } catch (err) {
      // Cron callbacks must never throw — node-cron would silently
      // swallow the next tick. Log + continue.
      logger.error(`Magic-link cron crashed: ${err.message}`);
    }
  }, { timezone: TZ }));

  logger.ready(`Scheduler started — ${tasks.length} task(s) registered (tz=${TZ}).`);
}

function stop() {
  for (const t of tasks) {
    try { t.stop(); } catch { /* ignore */ }
  }
  tasks.length = 0;
}

module.exports = { init, stop };
