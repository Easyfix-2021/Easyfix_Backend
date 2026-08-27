const cron = require('node-cron');
const logger = require('../logger');
const { getProperty } = require('../services/properties.service');

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
 * Future jobs can be appended below. Each registered task is captured
 * in `jobs[]` with metadata (id / name / description / cron / runner)
 * so the Scheduled Jobs admin page can list them, show last-run
 * telemetry, and fire a manual "Trigger Now" via `triggerJob(id)`.
 */

const TZ = 'Asia/Kolkata';

/*
 * Registered jobs registry (2026-06-06). Each entry:
 *   {
 *     id:          slug used in API routes (kebab-case)
 *     name:        human-readable label for the admin page
 *     description: one-line explanation of what the job does
 *     cron:        the cron expression string (e.g. '0 *\/4 * * *')
 *     runner:      async () => result  — the underlying work the cron
 *                  callback executes; reused by triggerJob() for the
 *                  manual "Trigger Now" path
 *     registered:  boolean — true if the cron actually registered
 *                  (false when an env/property gate skipped it). The
 *                  job stays in the registry either way so the admin
 *                  page surfaces "skipped, gate=…" status + still lets
 *                  ops trigger it manually
 *     skipReason:  optional string ("ENABLED gate is false", etc.)
 *     task:        node-cron handle (only when registered=true)
 *     lastRunAt / lastDurationMs / lastResult / lastError:
 *                  in-memory telemetry. Lost on restart — that's fine,
 *                  scheduler.js is the single source of truth for
 *                  "what just ran" and pid-scoped state is sufficient
 *                  for the admin UX. Persisting per-run history is a
 *                  separate concern.
 *   }
 *
 * The registry is exported via getJobs() so the admin service can
 * project a public-safe view (omits the runner closure + task handle).
 */
const jobs = [];
let orphanResetTask = null;
let idempotencyCleanupTask = null;

function registerJob({
  id, name, description, cron: cronExpr, runner, skipReason,
  // Optional "test send" support (2026-06-06). When a job exposes a
  // `tester` fn, the admin Scheduled Jobs page renders a "Test" button
  // alongside "Trigger Now". The tester is called with the operator-
  // typed { mobile, sourceId } and is expected to dispatch a single
  // test message — never to the original recipient — and return a
  // structured result the route surfaces back to the FE.
  // `testSourceLabel` + `testSourceHelp` drive the modal's optional
  // source-id input copy (e.g. "Easyfixer ID" / "Unconfirmed Job ID").
  tester, testSourceLabel, testSourceHelp,
  // Optional real-interrupt hook — see requestCancel(). Its presence is what
  // makes the FE show a Stop button for this job.
  canceller,
}) {
  const job = {
    id, name, description,
    cron: cronExpr,
    runner,
    tester: tester || null,
    canceller: canceller || null,
    running: false,
    runningSince: null,
    cancelRequested: false,
    progressText: null,
    testSourceLabel: testSourceLabel || null,
    testSourceHelp: testSourceHelp || null,
    registered: false,
    skipReason: skipReason || null,
    task: null,
    lastRunAt: null,
    lastDurationMs: null,
    lastResult: null,
    lastError: null,
    lastTriggerKind: null,   // 'cron' | 'manual' | 'test'
  };
  jobs.push(job);
  return job;
}

/*
 * Wraps the runner so every invocation (cron OR manual) updates the
 * in-memory telemetry on the same job entry. Errors are caught + logged
 * so cron callbacks never throw (node-cron would silently swallow the
 * next tick), and the manual-trigger HTTP handler can still surface the
 * error to the operator via the job's lastError.
 */
async function invokeJob(job, kind /* 'cron' | 'manual' */) {
  const t0 = Date.now();
  job.lastRunAt = new Date();
  job.lastTriggerKind = kind;
  job.lastResult = null;
  job.lastError = null;
  /*
   * LIVE-RUN STATE. Set on the job entry (not a side map) so getJobs() can
   * publish it with zero extra bookkeeping — the Scheduled Jobs page then shows
   * progress from the list endpoint it ALREADY fetches, instead of needing a
   * second polling endpoint per job.
   */
  job.running = true;
  job.runningSince = t0;
  job.cancelRequested = false;
  job.progressText = null;
  try {
    const result = await job.runner();
    job.lastDurationMs = Date.now() - t0;
    job.lastResult = result ?? { ok: true };
    return result;
  } catch (err) {
    job.lastDurationMs = Date.now() - t0;
    job.lastError = err?.message || String(err);
    logger.error(`Cron job "${job.id}" (${kind}) failed: ${job.lastError}`);
    if (kind === 'manual') throw err;     // surface to HTTP caller
    return null;                          // cron path — swallow per the rule
  } finally {
    // ALWAYS clear, or a crashed run would leave the card showing a phantom
    // "running" for the life of the process.
    job.running = false;
    job.runningSince = null;
    job.progressText = null;
  }
}

/*
 * Publish a human progress line for a running job. Long jobs call this as they
 * move between phases; everything else simply shows elapsed time. Kept as a
 * plain string so the scheduler needs no knowledge of any job's internals.
 */
function setJobProgress(id, text) {
  const job = jobs.find((j) => j.id === id);
  if (job) job.progressText = text || null;
}

/*
 * Cooperative cancellation.
 *
 * A promise cannot be killed from outside, so "stop" means two different things
 * and the UI must not pretend otherwise:
 *   - a job registered with `canceller` can be interrupted for real (the QA
 *     refresh kills its mysqldump child), and
 *   - any job can READ isCancelRequested() at a checkpoint and bail cleanly.
 * Jobs that do neither are published as cancellable:false so the FE never offers
 * a Stop button that would do nothing.
 */
function requestCancel(id) {
  const job = jobs.find((j) => j.id === id);
  if (!job) { const e = new Error(`No scheduled job with id "${id}"`); e.status = 404; throw e; }
  if (!job.running) return { cancelled: false, reason: 'not running' };
  job.cancelRequested = true;
  logger.warn(`Cron job "${job.id}" — stop requested by operator`);
  if (typeof job.canceller === 'function') {
    try { job.canceller(); } catch (e) { logger.warn(`canceller for "${job.id}" threw · ${e.message}`); }
    return { cancelled: true, immediate: true };
  }
  return { cancelled: true, immediate: false };
}

function isCancelRequested(id) {
  const job = jobs.find((j) => j.id === id);
  return !!job?.cancelRequested;
}

function init() {
  if (String(process.env.CRON_DISABLED).toLowerCase() === 'true') {
    logger.warn('CRON_DISABLED=true — scheduled tasks NOT registered.');
    // Still register the jobs with `registered: false` + a clear skip
    // reason so the admin page can show what WOULD have been scheduled
    // and operators can still hit Trigger Now in dev.
  }

  const cronDisabled = String(process.env.CRON_DISABLED).toLowerCase() === 'true';

  // ─── Kaleyra call-report sync — every 4 hours ─────────────────────
  // Polls Kaleyra's dial.callreports for rows where is_updated=0,
  // filling in duration / recording / status / start_time / end_time.
  // Schedule deliberately matches the user's stated frequency (legacy
  // ran hourly; the operator preference is 4-hourly for reduced load).
  const kaleyraSync = require('../services/kaleyra-report-sync.service');
  const kaleyraJob = registerJob({
    id: 'kaleyra-report-sync',
    name: 'Kaleyra Call-Report Sync',
    description:
`What this task does: When an operator or technician makes a call through our calling system (Kaleyra), we record a row in our database the moment the call is placed. But the FINAL details — how long the call lasted, whether it was answered, whether there was a recording — only become available a few minutes later on Kaleyra's side.

This task's job is to keep those details up to date. Here's how it works, step by step:
  1. Every 4 hours (at midnight, 4am, 8am, 12pm, 4pm and 8pm IST), the task wakes up automatically.
  2. It looks at our database and finds every call row that's still missing its final details (technically: rows where the "is_updated" flag is 0).
  3. For each of those rows, it asks Kaleyra: "Hey, what happened with this call?"
  4. Kaleyra responds with the call's duration, final status (answered / missed / busy / failed), start time, end time, and a link to the recording (if any).
  5. The task writes those details back into our database, and flips "is_updated" to 1 so we don't re-fetch the same call next time.
  6. It logs how many rows it checked, how many it updated, and how many failed — visible in the server logs and on this page (Last Run details below).

Why this matters: without this task, the Call History pages in the CRM would always show recently-placed calls as "still in progress" forever — the details would never appear. Trigger Now is useful if an operator needs to see a specific call's recording RIGHT NOW and doesn't want to wait up to 4 hours for the next automatic run.`,
    cron: '0 */4 * * *',
    runner: async () => {
      const result = await kaleyraSync.syncPendingReports();
      logger.info(
        `Kaleyra sync · checked=${result.checked} · updated=${result.updated} · ` +
        `failed=${result.failed}`
      );
      return result;
    },
  });
  // Per-cron kill-switch (2026-07-14) — lets ops silence THIS cron individually
  // without killing every cron via the master CRON_DISABLED. This is an
  // ALWAYS-ON infra cron, so the flag DEFAULTS ON: absent (or anything but
  // 'false') → registers; set the property to 'false' to disable. (Contrast the
  // opt-in gated crons above, which default OFF via `=== 'true'`.) Read once at
  // boot → restart after flipping. Seeded 'true' for visibility via migration
  // 2026-07-14-seed-per-cron-enable-flags.sql, but works with the row absent.
  const kaleyraSyncEnabled =
    String(getProperty('kaleyra.report_sync.enabled') ?? '').toLowerCase() !== 'false';
  if (cronDisabled) {
    kaleyraJob.skipReason = 'CRON_DISABLED=true';
  } else if (!kaleyraSyncEnabled) {
    kaleyraJob.skipReason = "property 'kaleyra.report_sync.enabled' is 'false' — set it to 'true' (or remove it) and restart to enable";
    logger.info("Kaleyra report-sync cron SKIPPED — kaleyra.report_sync.enabled=false in easyfix_properties (set 'true' + restart to enable).");
  } else {
    kaleyraJob.task = cron.schedule(
      kaleyraJob.cron,
      () => invokeJob(kaleyraJob, 'cron'),
      { timezone: TZ },
    );
    kaleyraJob.registered = true;
    logger.info('Kaleyra report-sync cron registered (kaleyra.report_sync.enabled=true, every 4h IST).');
  }

  // ─── Customer Magic-Link cron — hourly at :05 IST ─────────────────
  // Added 2026-05-28. Scans Unconfirmed (status=9) jobs whose client
  // is opted in via tbl_client_custom_properties.auto_process_unconfirmed_order
  // and dispatches the WhatsApp magic link. Eligibility query +
  // 24h cooldown + 3-send cap live in services/job-magic-link-cron.js.
  //
  // GATE (added 2026-05-30, moved to easyfix_properties 2026-06-03):
  //   property `magic.link.cron.enabled` = 'true'  → cron registers
  //   otherwise                                     → cron is NOT
  //                                                   registered (no tick),
  //                                                   but stays in the
  //                                                   registry so admin
  //                                                   page can manually
  //                                                   trigger it.
  const magicLinkCron = require('../services/job-magic-link-cron');
  const magicLinkJob = registerJob({
    id: 'magic-link-hourly-sweep',
    name: 'Customer Magic-Link Sweep',
    description:
`What this task does: When a job is created by an external client (e.g. through a bulk upload or via a Decathlon-style integration), it starts in an "Unconfirmed" state — the customer doesn't yet know about it. Normally, an operator would call the customer to confirm the date/time before scheduling.

For SOME clients, the operator wants to skip the manual call: instead, send the customer a WhatsApp message with a "magic link" they can click to confirm or reschedule themselves. This task is what sends those WhatsApp messages automatically.

Here's how it works, step by step:
  1. Every hour at 5 minutes past the hour (1:05, 2:05, 3:05 IST, etc.), the task wakes up automatically.
  2. It looks at every job in the system that's still "Unconfirmed" (status 9).
  3. It filters those jobs to only the ones whose CLIENT has opted in — clients turn this on by setting "auto_process_unconfirmed_order" to "yes" in their custom properties.
  4. For each remaining job, it checks two safety rules:
       a. Cooldown — did we already send a magic link to this job in the last 24 hours? If yes, skip it (don't spam the customer).
       b. Send cap — have we already sent 3 magic links for this job total? If yes, give up on this job (the customer clearly isn't responding; an operator should call them instead).
  5. For each job that passes both checks, it generates a unique, short URL (the "magic link") and sends it to the customer's WhatsApp number via our messaging provider.
  6. The customer can click the link to land on a confirmation page where they pick a date/time slot or cancel. The link expires after a few days for security.
  7. The task logs how many jobs were eligible, how many sends it attempted, how many succeeded, and how many failed — visible in the server logs and on this page (Last Run details below).

Why this matters: without this task, "auto-confirm" clients would have to call every customer manually, defeating the whole point of opting in. Trigger Now is useful when a new client just opted in and ops wants to dispatch the first wave of confirmations immediately rather than waiting for the next hourly tick.

Note: this task only runs if the property "magic.link.cron.enabled" is set to "true" in easyfix_properties. The property is checked once at server start — after changing it, a server restart (redeploy) is required for the schedule to turn on or off. If it's set to "false" (or unset), the automatic schedule is OFF — but Trigger Now still works for manual one-off sweeps.`,
    cron: '5 * * * *',
    runner: async () => {
      const result = await magicLinkCron.runHourlySweep();
      logger.info(
        `Magic-link cron · eligible=${result.eligible} · attempted=${result.attempted} · ` +
        `succeeded=${result.succeeded} · failed=${result.failed}`
      );
      return result;
    },
    // Test send (2026-06-06). Operator enters a mobile + optional unconfirmed
    // job_id; the cron service sends the SAME `confirm_order` template to the
    // typed mobile only (never to the real customer) using the job's
    // customer/client names as placeholder values. No tbl_job mutation.
    tester: ({ mobile, sourceId }) => magicLinkCron.runTest({ mobile, sourceId }),
    testSourceLabel: 'Unconfirmed Job ID',
    testSourceHelp:
      'Optional. If you provide an unconfirmed job\'s ID, the customer name + client name from that job ' +
      'are used as placeholder values in the test message. The WhatsApp itself still goes ONLY to the ' +
      'mobile number you typed above — never to the real customer. Leave blank to use dummy details ' +
      '("Test Customer" / "EasyFix Demo").',
  });
  const magicLinkCronEnabled =
    String(getProperty('magic.link.cron.enabled') ?? '').toLowerCase() === 'true';
  if (cronDisabled) {
    magicLinkJob.skipReason = 'CRON_DISABLED=true';
  } else if (!magicLinkCronEnabled) {
    magicLinkJob.skipReason = "property 'magic.link.cron.enabled' was not 'true' at server start — flip it to 'true' and restart the server to enable";
    logger.info('Magic-link cron SKIPPED — set magic.link.cron.enabled=true in easyfix_properties to enable (takes effect after restart).');
  } else {
    magicLinkJob.task = cron.schedule(
      magicLinkJob.cron,
      () => invokeJob(magicLinkJob, 'cron'),
      { timezone: TZ },
    );
    magicLinkJob.registered = true;
    logger.info('Magic-link cron registered (magic.link.cron.enabled=true).');
  }

  // ─── Easyfixer Profile-Completion Reminder — Wed + Sat at 19:00 IST ───
  // Added 2026-06-06 per ops. Finds every ACTIVE + IN-PROGRESS easyfixer
  // (efr_status = 1, INCLUDES technicians whose verification is mid-flow)
  // with an incomplete profile (efr_profile_perc < 100 OR
  // final_submission != 1) and sends them a WhatsApp nudge via the
  // Gallabox template `complete_profile_easyfixer`.
  //
  // 2026-06-11 schedule change: was daily at 10:00 IST, now
  // Wed + Sat at 19:00 IST (cron `0 19 * * 3,6`). Twice-weekly cadence
  // avoids fatigue; 19:00 catches technicians at end-of-day when they're
  // winding down + checking phones (vs. busy with jobs during the day).
  // Plus the existing 7-day per-tech cooldown means even within the
  // twice-weekly window each tech gets at most one nudge per week.
  //
  // Property gate `easyfixer.profile_reminder.enabled` must be 'true' for
  // autonomous firing. Per-send errors logged + counted, never abort the loop.
  const profileReminderCron = require('../services/easyfixer-profile-reminder-cron');
  const profileReminderJob = registerJob({
    id: 'easyfixer-profile-reminder',
    name: 'Easyfixer Profile-Completion Reminder',
    description:
`What this task does: Every active easyfixer (technician) in our system is expected to fill out their full profile — name, contact info, service categories they cover, documents (Aadhaar, PAN, photo), etc. When their profile is incomplete, the auto-assignment engine struggles to pick them for jobs, and ops can't verify them. This task gives those technicians a friendly twice-weekly nudge over WhatsApp.

Here's how it works, step by step:
  1. Every Wednesday and Saturday at 7:00 PM IST, the task wakes up automatically. Twice-weekly cadence catches technicians at end-of-day attention while avoiding daily-nudge fatigue.
  2. It looks at every technician in our database whose account is ACTIVE OR whose registration is still in progress. Both groups need the nudge — the former to finalize their submission, the latter to actually finish registration.
  3. From those, it picks only the ones whose profile is INCOMPLETE — meaning their profile completion percentage is below 100, OR they haven't yet pressed the "Final Submission" button (which signals "I'm done filling things in").
  4. It also filters out anyone without a valid mobile number on file — there's no point sending a WhatsApp message if we don't know where to send it.
  5. For each remaining technician, it asks Gallabox (our WhatsApp messaging provider) to send them a pre-approved template message called "complete_profile_easyfixer". The template is a generic, friendly nudge: "Please complete your EasyFix profile to get assigned to jobs."
  6. The task logs how many technicians were eligible, how many messages it attempted, how many succeeded, and how many failed — visible in the server logs and on this page (Last Run details below).

Why this matters: technicians often get distracted mid-signup and never finish their profile. Without this nudge, those incomplete profiles pile up indefinitely. The WhatsApp message lands directly on their phone and links back to the profile page — much higher conversion than email reminders.

Note: this task DOES have a per-technician 7-day cooldown — once we send a profile-update WhatsApp (from any source: this cron, the skill+pincode cron, or a manual operator "Send Profile Update Link" action), we don't nudge that technician again for 7 days. Prevents nudge fatigue.

This task only runs automatically if the property "easyfixer.profile_reminder.enabled" is set to "true" in easyfix_properties. The property is checked once at server start — after changing it, a server restart (redeploy) is required for the schedule to turn on or off. If unset or "false", the schedule is OFF — but Trigger Now still works for manual sweeps. Trigger Now is useful if ops just imported a batch of new technicians and wants to send the first wave of nudges immediately rather than waiting for the next Wednesday/Saturday 7 PM tick.`,
    cron: '0 19 * * 3,6',
    runner: async () => {
      const result = await profileReminderCron.runDailyReminder();
      logger.info(
        `Profile-reminder cron · eligible=${result.eligible} · ` +
        `attempted=${result.attempted} · succeeded=${result.succeeded} · ` +
        `failed=${result.failed} · skipped=${result.skipped}`
      );
      return result;
    },
    // Test send (2026-06-06). Operator enters a mobile + optional easyfixer
    // efr_id; the cron service sends the SAME `complete_profile_easyfixer`
    // template to the typed mobile only (never to the real easyfixer) using
    // the easyfixer's name as the recipientName. No tbl_easyfixer mutation.
    tester: ({ mobile, sourceId }) => profileReminderCron.runTest({ mobile, sourceId }),
    testSourceLabel: 'Easyfixer ID (efr_id)',
    testSourceHelp:
      'Optional. If you provide an easyfixer\'s ID, that easyfixer\'s display name is used as the ' +
      'recipient name in the test message. The WhatsApp itself still goes ONLY to the mobile number ' +
      'you typed above — never to the real easyfixer. Leave blank to use a dummy name ("Test Easyfixer").',
  });
  /*
   * Property gate (2026-06-11) — parity with the magic-link cron + the
   * skill+pincode cron. Lets ops kill the daily profile-completion
   * nudges without a deploy when WhatsApp budget spikes or the
   * Gallabox template approval lapses. Default-off (property unset OR
   * not 'true' → cron stays unregistered for autonomous firing) so
   * an env with no property is silent until ops explicitly turns it on.
   */
  const profileReminderEnabled =
    String(getProperty('easyfixer.profile_reminder.enabled') ?? '').toLowerCase() === 'true';
  if (cronDisabled) {
    profileReminderJob.skipReason = 'CRON_DISABLED=true';
  } else if (!profileReminderEnabled) {
    profileReminderJob.skipReason = "property 'easyfixer.profile_reminder.enabled' was not 'true' at server start — flip it to 'true' and restart the server to enable";
    logger.info("Easyfixer profile-reminder cron SKIPPED — set easyfixer.profile_reminder.enabled=true in easyfix_properties to enable (takes effect after restart).");
  } else {
    profileReminderJob.task = cron.schedule(
      profileReminderJob.cron,
      () => invokeJob(profileReminderJob, 'cron'),
      { timezone: TZ },
    );
    profileReminderJob.registered = true;
    logger.info('Easyfixer profile-reminder cron registered (easyfixer.profile_reminder.enabled=true, Wed + Sat 19:00 IST).');
  }

  // ─── Easyfixer Skill+Pincode Reminder — daily at 12:30 IST ────────
  // Added 2026-06-11. Sister cron to the profile-completion reminder
  // above, but targets a different incompleteness signal: ACTIVE
  // easyfixers whose profile shell is filled in (so they don't show up
  // for the profile-completion nudge) but who are missing deep-skill mappings
  // (tbl_efr_deepskill_mapping with is_repairing=1) OR serviceable
  // pincodes (tbl_efr_serviceable_pincodes.pincodes empty/null) — both
  // of which the auto-assignment engine actually USES to pick them.
  // 12:30 IST puts the WhatsApp in the lunch-break attention window
  // (highest action-completion for a 2-min form) without stacking on
  // top of the profile-completion cron. Reuses the magic-link
  // sender (sendForEasyfixer) so JWT, short URL, Gallabox template
  // send, and audit-column updates are all handled downstream.
  const skillPincodeReminderCron = require('../services/easyfixer-skill-pincode-reminder-cron');
  const skillPincodeReminderJob = registerJob({
    id: 'easyfixer-skill-pincode-reminder',
    name: 'Easyfixer Skill+Pincode Reminder',
    description:
`What this task does: Active easyfixers whose profile shell is filled in (so the profile-completion cron — Wed + Sat 19:00 IST — skips them) but who are missing the two structured datasets the dispatcher actually USES to pick them — deep-skill mappings AND/OR serviceable pincodes — won't show up in any job auto-assignment. This cron nudges them to fill in those two surfaces via the same WhatsApp magic-link the "Send Profile Update Link" admin action sends.

Step by step:
  1. Daily at 12:30 IST — lunch-break attention window, the highest-conversion slot for a 2-minute mobile form.
  2. Finds every ACTIVE easyfixer with a usable mobile who has BOTH deep-skill mappings empty (no tbl_efr_deepskill_mapping rows with is_repairing=1) AND serviceable pincodes empty (tbl_efr_serviceable_pincodes.pincodes empty/null). Partial-progress profiles (data in one of the two) are intentionally excluded — they've engaged with the form and don't need a nudge.
  3. Skips anyone we've already messaged in the last 7 days — prevents nudge fatigue.
  4. For each remaining tech, reuses the sendForEasyfixer service (same code path the manual "Send Profile Update Link" admin action uses), so JWT minting, URL shortening, Gallabox template send, and audit-column updates (profile_update_sent_at / send_count / last_action) all flow through one place. The audit's last_action is stamped 'reminder' so operators can distinguish cron sends from manual sends.
  5. Per-row send failures (invalid number, opt-out, template render error) are logged + counted but never abort the loop — the rest of the queue still drains.

Note: this task only runs automatically if the property "easyfixer.skill_pincode_reminder.enabled" is set to "true" in easyfix_properties. The property is checked once at server start — after changing it, a server restart (redeploy) is required for the schedule to turn on or off. If unset or "false", the schedule is OFF — but Trigger Now still works for manual sweeps. Test sends a real Gallabox template to whatever mobile you type — never to a real easyfixer's number.`,
    cron: '30 12 * * *',
    runner: async () => {
      const result = await skillPincodeReminderCron.runDailyReminder();
      logger.info(
        `Skill-pincode-reminder cron · candidates=${result.candidates} · ` +
        `sent=${result.sent} · failed=${result.failed} · took_ms=${result.took_ms}`
      );
      return result;
    },
    // Test send (2026-06-11). Operator enters a mobile + optional efr_id;
    // the cron service mints a real JWT-bearing URL using that easyfixer's
    // name (or a dummy) and sends the SAME profile-update magic-link
    // template to the typed mobile ONLY — never to the real easyfixer.
    // No audit-column writes; this is a true read-only test path.
    tester: ({ mobile, sourceId }) => skillPincodeReminderCron.runTest({ mobile, sourceId }),
    testSourceLabel: 'Easyfixer ID',
    testSourceHelp:
      'Optional. If you provide an easyfixer\'s ID, that row\'s display name + a real JWT minted for them ' +
      'are used in the test message. The WhatsApp itself still goes ONLY to the mobile number you typed ' +
      'above — never to the real easyfixer. Leave blank to use a dummy name ("Test Easyfixer") and an ' +
      'efr_id=0 JWT (the landing page will 404 the prefill, but the WhatsApp delivery still tests cleanly).',
  });
  /*
   * Property gate (2026-06-11) — mirror of the magic.link.cron.enabled
   * pattern above. Lets ops disable this cron without a deploy when
   * WhatsApp budget spikes or the template approval lapses. Default-off
   * (property unset OR not 'true' → cron stays unregistered) so adding
   * the cron is a no-op until ops explicitly turns it on.
   */
  const skillPincodeReminderEnabled =
    String(getProperty('easyfixer.skill_pincode_reminder.enabled') ?? '').toLowerCase() === 'true';
  if (cronDisabled) {
    skillPincodeReminderJob.skipReason = 'CRON_DISABLED=true';
  } else if (!skillPincodeReminderEnabled) {
    skillPincodeReminderJob.skipReason = "property 'easyfixer.skill_pincode_reminder.enabled' was not 'true' at server start — flip it to 'true' and restart the server to enable";
    logger.info("Skill+pincode reminder cron SKIPPED — set easyfixer.skill_pincode_reminder.enabled=true in easyfix_properties to enable (takes effect after restart).");
  } else {
    skillPincodeReminderJob.task = cron.schedule(
      skillPincodeReminderJob.cron,
      () => invokeJob(skillPincodeReminderJob, 'cron'),
      { timezone: TZ },
    );
    skillPincodeReminderJob.registered = true;
    logger.info('Easyfixer skill+pincode reminder cron registered (easyfixer.skill_pincode_reminder.enabled=true, daily 12:30 IST).');
  }

  // ─── Notice scheduled → published flip + push — every minute ─────────
  // Added 2026-06-26. Notices created with a future publish_at sit in
  // status='scheduled'. The notice feeds already SHOW them once NOW()
  // passes publish_at (read-time effectiveStatus derivation), but nothing
  // ever PERSISTED the flip to 'published' nor fired the technician push —
  // so a scheduled notice went live silently, never notifying anyone.
  //
  // This cron is the durable transition: every minute it promotes every
  // due 'scheduled' notice to 'published' (atomic per-row guard) and fires
  // the technician push exactly once per real transition. No property gate
  // and no CRON_DISABLED skip-reason gymnastics needed beyond the standard
  // inline guard — the cost is one indexed SELECT per minute and the
  // alternative (notices never durably publishing / never pushing) is
  // strictly worse.
  const noticeService = require('../services/notice.service');
  const noticePublishJob = registerJob({
    id: 'notice-publish-scheduled',
    name: 'Notice Scheduled → Published Flip',
    description:
`What this task does: When someone writes a notice on the Notice Board and sets it to go live at a FUTURE date/time, the notice waits in a "scheduled" state until that moment arrives. This task is what actually flips it live — and, just as importantly, sends the push notification to technicians the instant it goes live.

Here's how it works, step by step:
  1. Every minute, the task wakes up automatically.
  2. It looks for every notice that is still "scheduled" AND whose go-live time (publish_at) has now passed.
  3. For each one, it flips the notice's status to "published" — durably, in the database. (A built-in guard means even if two ticks overlap, only one wins the flip, so a notice can never be double-published or double-pushed.)
  4. If that notice targets technicians, it fires the technician push notification right then — so technicians are alerted the moment a scheduled notice goes live, not whenever they next happen to open the app.
  5. It logs how many scheduled notices it checked, how many it published, and how many pushes it fired — visible in the server logs and on this page (Last Run details below).

Why this matters: before this task existed, the notice feeds would already DISPLAY a scheduled notice once its go-live time passed (computed on the fly when someone loads the feed), but the database never recorded it as published and no push ever went out. That meant technicians were never actively notified about scheduled notices — they'd only see them if they happened to open the Notice screen. This task closes that gap. Trigger Now is useful if ops just scheduled a notice for "a minute ago" and wants it published + pushed immediately rather than waiting for the next minute tick.`,
    cron: '* * * * *',
    runner: async () => {
      const result = await noticeService.publishDueScheduled();
      logger.info(
        `Notice publish cron · checked=${result.checked} · ` +
        `published=${result.published} · pushed=${result.pushed}`
      );
      return result;
    },
  });
  // Always-on infra cron → default-ON kill-switch (set 'false' to disable). See kaleyra note above.
  const noticePublishEnabled =
    String(getProperty('notice.publish.enabled') ?? '').toLowerCase() !== 'false';
  if (cronDisabled) {
    noticePublishJob.skipReason = 'CRON_DISABLED=true';
  } else if (!noticePublishEnabled) {
    noticePublishJob.skipReason = "property 'notice.publish.enabled' is 'false' — set it to 'true' (or remove it) and restart to enable";
    logger.info("Notice-publish cron SKIPPED — notice.publish.enabled=false in easyfix_properties (set 'true' + restart to enable).");
  } else {
    noticePublishJob.task = cron.schedule(
      noticePublishJob.cron,
      () => invokeJob(noticePublishJob, 'cron'),
      { timezone: TZ },
    );
    noticePublishJob.registered = true;
    logger.info('Notice-publish cron registered (notice.publish.enabled=true, every minute IST).');
  }

  // ─── Job-offer auto-expiry — every 2 minutes ────────────────────────
  // Added 2026-06-30. Open offers (tbl_job_offer.offer_status=0) that no tech
  // ever accepted should not linger forever. This cron expires every open offer
  // older than 30 minutes (status → 3 EXPIRED), clearing the "Offered to Tx"
  // chip + freeing the pool; the job stays BOOKED/owner-less so ops can re-offer
  // it. No property gate — one small UPDATE every 2 min, the alternative (stale
  // offers piling up) is worse. acceptOffer() enforces the same 30-min TTL so a
  // tech can't accept a stale offer between ticks.
  const jobOfferSvc = require('../services/job.service');
  const offerExpiryJob = registerJob({
    id: 'job-offer-expiry',
    name: 'Job Offer Auto-Expiry',
    description:
`What this task does: When the CRM offers a job to one or more technicians, each technician gets a limited window to accept it on their app. This task enforces that window. Step by step:
  1. Every 2 minutes, the task wakes up automatically.
  2. It finds every job offer that is still waiting for a response (nobody has accepted or rejected it) AND was sent more than 30 minutes ago.
  3. It marks each of those offers as "expired", so it no longer shows up as a live offer to the technician or as "Offered to Tx" in the CRM.
  4. The job itself is left untouched and owner-less, so the CRM can simply offer it again to a fresh set of technicians.
  5. It logs how many stale offers it expired — visible in the server logs and on this page (Last Run details below).

Why this matters: without this, a job offered to technicians who never respond would sit "offered" forever, blocking a clean re-offer and cluttering the CRM. A technician also cannot accept an offer older than 30 minutes (the accept path enforces the same limit), so this keeps the live state and what technicians can act on in sync.`,
    cron: '*/2 * * * *',
    runner: async () => {
      // No literal — defaults to job.service.js OFFER_TTL_MINUTES (the single
      // source of truth shared with acceptOffer's freshness gate).
      const result = await jobOfferSvc.expireStaleOffers();
      logger.info(`Job-offer expiry cron · expired=${result.expired}` + (result.skipped ? ' (skipped: no tbl_job_offer)' : ''));
      return result;
    },
  });
  // Always-on infra cron → default-ON kill-switch (set 'false' to disable). See kaleyra note above.
  const offerExpiryEnabled =
    String(getProperty('job.offer_expiry.enabled') ?? '').toLowerCase() !== 'false';
  if (cronDisabled) {
    offerExpiryJob.skipReason = 'CRON_DISABLED=true';
  } else if (!offerExpiryEnabled) {
    offerExpiryJob.skipReason = "property 'job.offer_expiry.enabled' is 'false' — set it to 'true' (or remove it) and restart to enable";
    logger.info("Job-offer expiry cron SKIPPED — job.offer_expiry.enabled=false in easyfix_properties (set 'true' + restart to enable).");
  } else {
    offerExpiryJob.task = cron.schedule(
      offerExpiryJob.cron,
      () => invokeJob(offerExpiryJob, 'cron'),
      { timezone: TZ },
    );
    offerExpiryJob.registered = true;
    logger.info('Job-offer expiry cron registered (job.offer_expiry.enabled=true, every 2 min IST).');
  }

  // ─── Job-offer escalation reminder — every 2 minutes ─────────────────
  // (Added 2026-07-29) Re-pushes offers that are still open and unanswered
  // 5 minutes in, at most twice, and never once the 30-min window is nearly up.
  // Deliberately DOUBLE-gated (master loud-alert flag AND its own flag, both
  // default-off) because unlike the expiry sweep above this SENDS traffic to
  // technicians — it must stay dark until ops explicitly turns it on. The
  // runner re-checks the same gate, so Trigger Now is a no-op while off.
  const offerReminderCron = require('../services/job-offer-reminder-cron');
  const offerReminderJob = registerJob({
    id: 'job-offer-reminder',
    name: 'Job Offer Reminder Push',
    description:
`What this task does: When a job is offered to technicians, they get one push notification. If their phone was in a pocket or the notification got buried, the offer quietly expires after 30 minutes and ops has to offer the job all over again. This task gives unanswered offers a second (and at most a third) chance. Step by step:
  1. Every 2 minutes, the task wakes up automatically.
  2. It finds every job offer that is STILL waiting for a response and was sent at least 5 minutes ago.
  3. It skips any offer it already reminded about in the last 5 minutes, and any offer older than 15 minutes (close to the 30-minute expiry, where a reminder would only frustrate).
  4. Each remaining offer gets ONE more push to that technician — the same notification, worded as a reminder, opening the same accept screen.
  5. Any single offer can be reminded at most TWICE, ever.
  6. It logs how many offers were eligible, how many it actually reminded, and how many pushes failed — visible in the server logs and on this page (Last Run details below).

Why this matters: a missed job-offer notification costs the technician a job and costs ops a re-offer. A short, capped nudge recovers offers that were simply not seen, without turning into notification spam.

Note: this task only runs if BOTH properties "job.offer.loud_alert.enabled" AND "job.offer.reminder.enabled" are "true" in easyfix_properties. Both are checked at server start (so a restart/redeploy is needed after changing them) AND again on every run — so while either is off, even Trigger Now does nothing.`,
    cron: '*/2 * * * *',
    runner: async () => {
      const result = await offerReminderCron.runOfferReminders();
      logger.info(
        `Job-offer reminder cron · eligible=${result.eligible} · reminded=${result.claimed} · ` +
        `pushed=${result.pushed} · failed=${result.failed}` + (result.skipped ? ` (skipped: ${result.reason})` : '')
      );
      return result;
    },
  });
  // Default-OFF gate (mirrors the attendance-reminder pattern, NOT the always-on
  // kill-switch pattern above): the job stays unregistered unless BOTH flags read
  // 'true' at boot. `offerReminderEnabled()` is the shared AND of the two — the
  // same helper the runner and the push sender use, so they can't disagree.
  const offerReminderEnabled = require('../services/job-offer-alert-flags').offerReminderEnabled();
  if (cronDisabled) {
    offerReminderJob.skipReason = 'CRON_DISABLED=true';
  } else if (!offerReminderEnabled) {
    offerReminderJob.skipReason = "properties 'job.offer.loud_alert.enabled' + 'job.offer.reminder.enabled' were not both 'true' at server start — set both to 'true' and restart the server to enable";
    logger.info("Job-offer reminder cron SKIPPED — set job.offer.loud_alert.enabled=true AND job.offer.reminder.enabled=true in easyfix_properties to enable (takes effect after restart).");
  } else {
    offerReminderJob.task = cron.schedule(
      offerReminderJob.cron,
      () => invokeJob(offerReminderJob, 'cron'),
      { timezone: TZ },
    );
    offerReminderJob.registered = true;
    logger.info('Job-offer reminder cron registered (both loud-alert + reminder flags true, every 2 min IST).');
  }

  // ─── Call-recording backfill — every 15 min ──────────────────────────
  // (Added 2026-07-10) The Plivo PUSH recording callback (<Dial
  // recordingCallbackUrl>) has proven unreliable — tbl_plivo_call_log.recording_url
  // was never populated by it. This PULLS missing recordings from the Plivo
  // Recording API (by call_uuid) and persists them, so recording_url stays
  // populated for the "Missing Call Recordings" report + downstream transcription
  // without depending on the push. No-op when there's nothing missing / columns
  // absent. No property gate (one bounded sweep; safe).
  const recordingBackfillSvc = require('../services/recording-backfill.service');
  const recordingBackfillJob = registerJob({
    id: 'recording-backfill',
    name: 'Call-Recording Backfill',
    description:
`What this task does: When the CRM records a call, the recording URL is supposed to be pushed back by the phone provider (Plivo). That push has been unreliable, so this task fills the gap. Step by step:
  1. Every 15 minutes, the task wakes up automatically.
  2. It finds recorded calls that are still missing their recording URL.
  3. For each, it asks Plivo directly for the recording and saves the URL.
  4. It logs how many it recovered — visible in the server logs and on this page.

Why this matters: without this, recorded calls would show no recording in the CRM and would be missed by the "Missing Call Recordings" report and by call-quality transcription, even though Plivo has the audio.`,
    cron: '*/15 * * * *',
    runner: async () => {
      const result = await recordingBackfillSvc.backfillMissingRecordings({ limit: 100 });
      logger.info(`Recording-backfill cron · recovered=${result.recovered} scanned=${result.scanned}` + (result.skipped ? ' (skipped: columns absent)' : ''));
      return result;
    },
  });
  // Always-on infra cron → default-ON kill-switch (set 'false' to disable). See kaleyra note above.
  const recordingBackfillEnabled =
    String(getProperty('recording.backfill.enabled') ?? '').toLowerCase() !== 'false';
  if (cronDisabled) {
    recordingBackfillJob.skipReason = 'CRON_DISABLED=true';
  } else if (!recordingBackfillEnabled) {
    recordingBackfillJob.skipReason = "property 'recording.backfill.enabled' is 'false' — set it to 'true' (or remove it) and restart to enable";
    logger.info("Recording-backfill cron SKIPPED — recording.backfill.enabled=false in easyfix_properties (set 'true' + restart to enable).");
  } else {
    recordingBackfillJob.task = cron.schedule(
      recordingBackfillJob.cron,
      () => invokeJob(recordingBackfillJob, 'cron'),
      { timezone: TZ },
    );
    recordingBackfillJob.registered = true;
    logger.info('Recording-backfill cron registered (recording.backfill.enabled=true, every 15 min IST).');
  }

  // ─── Attendance reminder — daily at 9:00 IST ─────────────────────────
  // (Added 2026-06-28) Pushes a "mark your attendance" FCM reminder to every
  // active + verified technician who has NOT marked attendance for TODAY (IST).
  // Companion to the in-app popup the technician app shows on open — both read
  // the same "unmarked for the IST day" predicate. Property-gated so ops can
  // disable the daily fan-out (a few-thousand-tech send) without a deploy.
  const attendanceReminderCron = require('../services/attendance-reminder-cron');
  // Schedule is configurable via property `attendance.reminder.cron` (default
  // 09:00 IST). An empty/invalid value falls back to the default, so a
  // fat-fingered property can't crash cron registration. Checked once at start.
  const attendanceCronExpr = (() => {
    const raw = String(getProperty('attendance.reminder.cron') ?? '').trim();
    return raw && cron.validate(raw) ? raw : '0 9 * * *';
  })();
  const attendanceReminderJob = registerJob({
    id: 'attendance-reminder-daily',
    name: 'Technician Attendance Reminder',
    description:
`What this task does: Every morning at 9:00 AM IST, technicians who have not yet marked their attendance for today receive a push notification on their phone reminding them to do so. Marking attendance is what tells the auto-assignment engine a technician is available, so a forgotten attendance silently removes them from the day's job pool.

Here's how it works, step by step:
  1. Every day at 9:00 AM IST, the task wakes up automatically.
  2. It looks at every technician whose account is ACTIVE and VERIFIED and who has a usable mobile number.
  3. For each one, it checks whether they have already acted on today's attendance — marked themselves present (morning and/or evening) OR marked themselves on leave. If they have, we skip them.
  4. Everyone left (no attendance action for today) is sent a push notification: "Mark Your Attendance — you haven't marked your attendance for today. Tap to mark it and keep receiving jobs."
  5. Tapping the notification opens the app, where the technician marks attendance for today (and tomorrow if they wish).
  6. The task logs how many technicians were eligible, how many the push reached, how many failed, and how many were skipped (no registered device) — visible in the server logs and on this page (Last Run details below).

Why this matters: technicians frequently forget to mark daily attendance, which quietly blocks job auto-assignment and leaves ops with an incomplete availability picture. A gentle morning nudge significantly increases attendance compliance, and it pairs with the in-app popup the technician sees when they open the app.

Note: this task only runs automatically if the property "attendance.reminder.enabled" is set to "true" in easyfix_properties. The SEND TIME is configurable via the property "attendance.reminder.cron" (a cron expression, e.g. "0 9 * * *" for 9:00 AM IST; defaults to 9:00 AM if unset/invalid). Both properties are checked once at server start — after changing either, a server restart (redeploy) is required. If the enable flag is unset or "false", the schedule is OFF — but Trigger Now still works for manual testing.`,
    cron: attendanceCronExpr,
    runner: async () => {
      const result = await attendanceReminderCron.runDailyReminder();
      logger.info(
        `Attendance-reminder cron · eligible=${result.eligible} · succeeded=${result.succeeded} · ` +
        `failed=${result.failed} · skipped=${result.skipped}`
      );
      return result;
    },
    tester: ({ sourceId }) => attendanceReminderCron.runTest({ sourceId }),
    testSourceLabel: 'Easyfixer ID (efr_id)',
    testSourceHelp:
      'Required. The reminder push is sent to THIS easyfixer\'s registered device(s). In a test environment with TEST_FCM_TOKEN set, every send is redirected to the operator token — so it lands on your test device, never the real technician.',
  });
  /*
   * Property gate — mirror of the magic-link / profile-reminder pattern. Lets
   * ops kill the daily fan-out without a deploy. Default-off (unset OR not
   * 'true' → unregistered) so adding the cron is a no-op until ops turns it on.
   */
  const attendanceReminderEnabled =
    String(getProperty('attendance.reminder.enabled') ?? '').toLowerCase() === 'true';
  if (cronDisabled) {
    attendanceReminderJob.skipReason = 'CRON_DISABLED=true';
  } else if (!attendanceReminderEnabled) {
    attendanceReminderJob.skipReason = "property 'attendance.reminder.enabled' was not 'true' at server start — flip it to 'true' and restart the server to enable";
    logger.info("Attendance-reminder cron SKIPPED — set attendance.reminder.enabled=true in easyfix_properties to enable (takes effect after restart).");
  } else {
    attendanceReminderJob.task = cron.schedule(
      attendanceReminderJob.cron,
      () => invokeJob(attendanceReminderJob, 'cron'),
      { timezone: TZ },
    );
    attendanceReminderJob.registered = true;
    logger.info(`Attendance-reminder cron registered (attendance.reminder.enabled=true, schedule="${attendanceCronExpr}" IST).`);
  }

  /* ── Training reminder ───────────────────────────────────────────── */
  const trainingReminderCron = require('../services/training-reminder-cron');
  // Schedule configurable via property `training.reminder.cron` (default 10:00
  // IST — an hour after the attendance nudge, so the two never land together).
  const trainingCronExpr = (() => {
    const raw = String(getProperty('training.reminder.cron') ?? '').trim();
    return raw && cron.validate(raw) ? raw : '0 10 * * *';
  })();
  const trainingReminderJob = registerJob({
    id: 'training-reminder-daily',
    name: 'Technician Training Reminder',
    description:
`What this task does: Every morning at 10:00 AM IST, technicians who have been assigned LMS training they have not finished receive a push notification reminding them to complete it. It repeats EVERY DAY until the training is done — an assignment that is being ignored is exactly the one worth nudging.

Here's how it works, step by step:
  1. Every day at 10:00 AM IST, the task wakes up automatically.
  2. It finds every technician holding at least one assigned course that is not yet complete. Courses with no videos in them are ignored — those cannot be completed, so reminding anyone about them would be futile.
  3. It works out whether the due date has already passed for any of those courses.
  4. If the deadline has NOT passed, the technician gets a nudge naming the date: "Finish Your Training — you have training to complete by <date>."
  5. If the deadline HAS passed, the message says so plainly: "Training Overdue — App Restricted." That is not a scare tactic; by that point the app really is restricted (see below), and a cheerful reminder would leave them guessing why their work screen stopped working.
  6. Tapping the notification opens the app on the Training screen.
  7. The task logs how many technicians were eligible, reached, failed, and skipped (no registered device) — visible in the server logs and on this page (Last Run details below).

What "restricted" means: once a technician is past the due date on assigned training, the backend withdraws their ability to receive new jobs, mutate assigned jobs and mark attendance. They keep Training, Claim Amount, and the ability to SKIP a job they are already holding — so they can release work they cannot do and still get paid. The restriction lifts by itself the moment they finish the training; nothing needs to be done in the CRM.

Why this matters: training assigned with a deadline and never followed up is training that does not happen. The daily nudge plus the in-app prompt is what turns an assignment into a completion, and it pairs with the popup the technician sees when they open the app.

Note: this task only runs automatically if the property "training.reminder.enabled" is set to "true" in easyfix_properties. The SEND TIME is configurable via the property "training.reminder.cron" (a cron expression, e.g. "0 10 * * *" for 10:00 AM IST; defaults to 10:00 AM if unset/invalid). Both properties are checked once at server start — after changing either, a server restart (redeploy) is required. If the enable flag is unset or "false", the schedule is OFF — but Trigger Now still works for manual testing.`,
    cron: trainingCronExpr,
    runner: async () => {
      const result = await trainingReminderCron.runDailyReminder();
      logger.info(
        `Training-reminder cron · eligible=${result.eligible} · succeeded=${result.succeeded} · ` +
        `failed=${result.failed} · skipped=${result.skipped}`
      );
      return result;
    },
    tester: ({ sourceId }) => trainingReminderCron.runTest({ sourceId }),
    testSourceLabel: 'Easyfixer ID (efr_id)',
    testSourceHelp:
      'Required. Sends the training reminder to THIS easyfixer\'s registered device(s), whether or not they actually owe training today — so delivery can be proven without waiting for a real assignment. In a test environment with TEST_FCM_TOKEN set, every send is redirected to the operator token.',
  });
  /*
   * Property gate — same shape as the attendance reminder. Default-off (unset
   * OR not 'true' → unregistered) so adding the cron is a no-op until ops
   * turns it on, which matters more than usual here: this one repeats daily
   * and its overdue message tells technicians their app is restricted.
   */
  const trainingReminderEnabled =
    String(getProperty('training.reminder.enabled') ?? '').toLowerCase() === 'true';
  if (cronDisabled) {
    trainingReminderJob.skipReason = 'CRON_DISABLED=true';
  } else if (!trainingReminderEnabled) {
    trainingReminderJob.skipReason = "property 'training.reminder.enabled' was not 'true' at server start — flip it to 'true' and restart the server to enable";
    logger.info("Training-reminder cron SKIPPED — set training.reminder.enabled=true in easyfix_properties to enable (takes effect after restart).");
  } else {
    trainingReminderJob.task = cron.schedule(
      trainingReminderJob.cron,
      () => invokeJob(trainingReminderJob, 'cron'),
      { timezone: TZ },
    );
    trainingReminderJob.registered = true;
    logger.info(`Training-reminder cron registered (training.reminder.enabled=true, schedule="${trainingCronExpr}" IST).`);
  }

  /* ── Rewards earning ─────────────────────────────────────────────── */
  const rewardsService = require('../services/rewards.service');
  const rewardsCronExpr = (() => {
    const raw = String(getProperty('rewards.earn.cron') ?? '').trim();
    return raw && cron.validate(raw) ? raw : '0 2 * * *';
  })();
  const rewardsEarnJob = registerJob({
    id: 'rewards-earn-daily',
    name: 'Rewards Points Earning',
    description:
`What this task does: Every night at 2:00 AM IST it awards reward points for what technicians earned that day — good ratings, same-day appointments, and referrals that have come good. Points are spent in the Rewards shop in the app; they are NOT money and can never be withdrawn.

Here's how it works, step by step:
  1. Every night at 2:00 AM IST the task wakes up automatically.
  2. It looks back over a short window (3 days by default) — NOT over all history. This is deliberate and important: there are over 300,000 historical ratings in the database, and a task that read all of them would hand out millions of points on its first run. The window means the programme genuinely starts on the day it is switched on.
  3. RATING POINTS: for every job rated 5 stars in that window where the job was NOT escalated, the technician is credited. The escalation check matters — roughly 9 in every 10 ratings are 5 stars, so without it this would simply pay for finishing a job rather than for doing it well.
  4. SDA POINTS: for every completed job in that window where the technician checked in on the appointment's own calendar day. This uses exactly the same rule as the SDA percentage the technician already sees in the app, so the two can never disagree.
  5. REFERRAL POINTS: when someone who joined using a technician's referral code completes Skills, Identity and Work Area, the referrer is credited. Not at install or signup — paying then would be an invitation to invent technicians. The referrer must still be an active technician at that moment.
  6. Every award is recorded once and once only. The database itself refuses a second award for the same job or referral, so re-running the task — or an overlapping window — pays nobody twice. The log reports how many were already paid.

Why the balance is never wrong: there is no stored balance anywhere. A technician's points are always the sum of their ledger, and corrections are added as new rows rather than by editing old ones — so "why did my points change?" always has a complete answer on their screen.

How many points each thing is worth: a good rating is 10, a same-day appointment is 30, and a referral that comes good is 200. These values are FIXED IN CODE, not settings — they are the terms technicians are told and plan around, so changing one is a deliberate deploy rather than something that can drift mid-month. You can see them any time on the Reward Items page in the CRM.

Note: this task runs automatically as long as the property "rewards.earn.enabled" is "true" in easyfix_properties, which it is by default — earning IS the programme, and a rewards system installed switched-off would show every technician a permanent zero. Setting it to "false" pauses the nightly awarding. The SEND TIME is configurable via "rewards.earn.cron" (default "0 2 * * *"). Both are read once at server start, so a restart is required after changing either. Trigger Now works regardless of the schedule.`,
    cron: rewardsCronExpr,
    runner: async () => {
      const result = await rewardsService.runEarnCycle();
      logger.info(
        `Rewards-earning cron · paused=${result.paused} · window=${result.windowDays}d ` +
        `from ${result.windowFrom} · rating=${result.rating}/${result.ratingRows} · ` +
        `sda=${result.sda}/${result.sdaRows} · referral=${result.referral} · ` +
        `alreadyPaid=${result.skipped}`
      );
      return result;
    },
    tester: () => rewardsService.runEarnCycle(),
    testSourceLabel: 'Not required',
    testSourceHelp:
      'No input needed. Trigger Now runs exactly the awarding pass the schedule would, over the same short look-back window. It is safe to run repeatedly: every award is recorded once and once only, so a second run pays nobody twice and simply reports them as already paid.',
  });
  const rewardsEarnEnabled =
    String(getProperty('rewards.earn.enabled') ?? '').toLowerCase() === 'true';
  if (cronDisabled) {
    rewardsEarnJob.skipReason = 'CRON_DISABLED=true';
  } else if (!rewardsEarnEnabled) {
    rewardsEarnJob.skipReason = "property 'rewards.earn.enabled' was not 'true' at server start — flip it to 'true' and restart the server to enable";
    logger.info("Rewards-earning cron SKIPPED — set rewards.earn.enabled=true in easyfix_properties to enable (takes effect after restart).");
  } else {
    rewardsEarnJob.task = cron.schedule(
      rewardsEarnJob.cron,
      () => invokeJob(rewardsEarnJob, 'cron'),
      { timezone: TZ },
    );
    rewardsEarnJob.registered = true;
    logger.info(`Rewards-earning cron registered (rewards.earn.enabled=true, schedule="${rewardsCronExpr}" IST).`);
  }

  // ─── Easyfixer auto-reactivation — daily at 01:00 IST ───────────────
  // (Added 2026-07-13) Reactivates technicians set "Temporarily Inactive" with a
  // scheduled_reactivation_date that has arrived (efr_status 0 → 1, clears the
  // date). Property-gated + IST-date based (not CURDATE). Runs at 01:00 IST,
  // before the 09:00 attendance push, so a reactivated tech is in that day's pool.
  const easyfixerReactivationCron = require('../services/easyfixer-reactivation-cron');
  const easyfixerReactivationJob = registerJob({
    id: 'easyfixer-auto-reactivation',
    name: 'Technician Auto-Reactivation',
    description:
`What this task does: Every day at 1:00 AM IST, technicians who were set "Temporarily Inactive" with a scheduled reactivation date that has now arrived are automatically switched back to Active.

Here's how it works, step by step:
  1. Every day at 1:00 AM IST, the task wakes up automatically.
  2. It finds a bounded batch of verified technicians whose lifecycle is SUSPENDED or PAUSED and whose scheduled reactivation date is on or before today (IST).
  3. For each, it uses the same locked lifecycle transition as the CRM, writing the audit history and only sending the app refresh push after commit.
  4. INACTIVE and BLACKLISTED technicians are never selected and the lifecycle service rejects those automatic transitions as a second safety layer.
  5. It logs eligible, reactivated and failed counts (visible in the server logs and on this page).

Why this matters: ops can put a technician on a fixed break (leave, temporary suspension) and have the system bring them back automatically on the agreed date, instead of relying on someone remembering to reactivate them.

Note: this task only runs automatically if the property "easyfixer.auto_reactivation.enabled" is "true" in easyfix_properties (checked once at server start — a restart is required after changing it). If unset or "false", the schedule is OFF, but Trigger Now / Test still work for manual verification.`,
    cron: '0 1 * * *',
    runner: async () => {
      const result = await easyfixerReactivationCron.runDailyReactivation();
      logger.info(
        `Easyfixer auto-reactivation cron · reactivated=${result.reactivated}` +
        (result.skipped ? ` (skipped — ${result.reason || 'lifecycle schema pre-migration'})` : '')
      );
      return result;
    },
    tester: ({ sourceId }) => easyfixerReactivationCron.runTest({ sourceId }),
    testSourceLabel: 'Easyfixer ID (efr_id)',
    testSourceHelp:
      'Required. Immediately reactivates THIS temporarily-inactive, verified technician (ignores the scheduled date) so you can verify the flow end-to-end.',
  });
  const easyfixerReactivationEnabled =
    String(getProperty('easyfixer.auto_reactivation.enabled') ?? '').toLowerCase() === 'true';
  if (cronDisabled) {
    easyfixerReactivationJob.skipReason = 'CRON_DISABLED=true';
  } else if (!easyfixerReactivationEnabled) {
    easyfixerReactivationJob.skipReason = "property 'easyfixer.auto_reactivation.enabled' was not 'true' at server start — flip it to 'true' and restart the server to enable";
    logger.info("Easyfixer auto-reactivation cron SKIPPED — set easyfixer.auto_reactivation.enabled=true in easyfix_properties to enable (takes effect after restart).");
  } else {
    easyfixerReactivationJob.task = cron.schedule(
      easyfixerReactivationJob.cron,
      () => invokeJob(easyfixerReactivationJob, 'cron'),
      { timezone: TZ },
    );
    easyfixerReactivationJob.registered = true;
    logger.info('Easyfixer auto-reactivation cron registered (easyfixer.auto_reactivation.enabled=true, 01:00 IST).');
  }

  // ─── Plivo low-balance alert — every 3 hours ────────────────────────
  // Added 2026-08-27, after calling was dead on production with an empty Plivo
  // account and nothing anywhere reporting it: the API accepted every call, the
  // conference was created, /web-start returned 200, and the browser leg died
  // at signalling. Operators saw "Busy" and every log line stayed green.
  //
  // The call panel now warns whoever opens it, but that only reaches somebody
  // already blocked. This half reaches the people who can top the account up,
  // while there is still credit left to work with.
  //
  // Everything is read from easyfix_properties so ops can retune without a
  // deploy: recipients, threshold, and the repeat cadence. State (the last-sent
  // stamp) lives there too, so the cooldown survives restarts and is shared
  // across replicas — a MySQL named lock keeps two replicas from both sending.
  const plivoBalanceAlertCron = require('../services/plivo-balance-alert-cron');
  const plivoBalanceAlertJob = registerJob({
    id: 'plivo-balance-alert',
    name: 'Plivo Low-Balance Alert',
    description:
`What this task does: Every 3 hours it checks how much calling credit is left in the Plivo account, and emails a warning while there is still time to top it up.

Why it exists: when the Plivo account runs out, calling does not fail in any visible way. Plivo still accepts each call, our server still records it and still answers "OK", and then the call quietly dies before anyone's phone rings. The operator sees "Busy" and there is no error anywhere to find. That is exactly what happened on 27 August 2026, and it was only discovered by someone opening the Plivo billing page by hand.

Step by step:
  1. It asks Plivo how much credit is left.
  2. If Plivo cannot be reached, or does not answer with a balance, it does NOTHING. Not knowing the balance is not the same as knowing it is low, and a false alarm here would teach everyone to ignore the real one.
  3. If the credit is above the threshold, it clears any earlier alert so the next drop is reported immediately.
  4. If the credit is at or below the threshold, it emails the configured recipients — unless it already sent one recently, or the account has auto-recharge switched on.

Settings (Setting -> Admin Actions, no deploy needed):
  plivo.balance.alert.enabled      'true' to run this at all
  plivo.balance.alert.recipients   who to email, comma separated
  plivo.balance.threshold          what counts as low (also drives the warning shown in the call panel)
  plivo.balance.alert.repeat_hours how often to repeat while it stays low`,
    cron: '0 */3 * * *',
    runner: () => plivoBalanceAlertCron.runOnce(),
  });
  const plivoBalanceAlertEnabled =
    String(getProperty('plivo.balance.alert.enabled') ?? '').toLowerCase() === 'true';
  if (cronDisabled) {
    plivoBalanceAlertJob.skipReason = 'CRON_DISABLED=true';
  } else if (!plivoBalanceAlertEnabled) {
    plivoBalanceAlertJob.skipReason = "property 'plivo.balance.alert.enabled' was not 'true' at server start — flip it to 'true' and restart the server to enable";
    logger.info("Plivo low-balance alert SKIPPED — set plivo.balance.alert.enabled=true in easyfix_properties to enable (takes effect after restart).");
  } else {
    plivoBalanceAlertJob.task = cron.schedule(
      plivoBalanceAlertJob.cron,
      () => invokeJob(plivoBalanceAlertJob, 'cron'),
      { timezone: TZ },
    );
    plivoBalanceAlertJob.registered = true;
    logger.info('Plivo low-balance alert registered (plivo.balance.alert.enabled=true, every 3h).');
  }

  // ─── Technician lifecycle evaluation — daily at 02:00 IST ─────────
  // Opt-in and bounded. Evaluates the documented PAUSED/DORMANT signals in
  // set-based batches; the lifecycle service independently rejects any cron
  // attempt to set INACTIVE/BLACKLISTED.
  const lifecycleEvaluation = require('../services/easyfixer-lifecycle-evaluation-cron');
  const lifecycleEvaluationJob = registerJob({
    id: 'easyfixer-lifecycle-evaluation',
    name: 'Technician Lifecycle Evaluation',
    description:
`What this task does: Reviews a bounded batch of Active / Under Master technicians and applies the automatic PAUSED or DORMANT rules from the Technician App v5.1 specification.

It checks negative wallet balance, no job/attendance activity (90 days by default), D/E grade, two consecutive escalations, low margin, and — only when Ops explicitly configures both its denominator and window — no-show rate. Every change uses the same locked/audited transition as the CRM and sends the technician a post-commit refresh push. It can never automatically set INACTIVE or BLACKLISTED.

The schedule is opt-in: set easyfixer.lifecycle.evaluation.enabled=true and restart. Batch size, bounded max batches/runtime, and thresholds are easyfix_properties values. Trigger Now runs the same bounded drain even when the schedule is disabled.`,
    cron: '0 2 * * *',
    runner: async () => lifecycleEvaluation.runDailyEvaluation(),
  });
  const lifecycleEvaluationEnabled =
    String(getProperty('easyfixer.lifecycle.evaluation.enabled') ?? '').toLowerCase() === 'true';
  if (cronDisabled) {
    lifecycleEvaluationJob.skipReason = 'CRON_DISABLED=true';
  } else if (!lifecycleEvaluationEnabled) {
    lifecycleEvaluationJob.skipReason = "property 'easyfixer.lifecycle.evaluation.enabled' was not 'true' at server start — review thresholds, set true, and restart to enable";
    logger.info('Technician lifecycle evaluation SKIPPED — easyfixer.lifecycle.evaluation.enabled is not true.');
  } else {
    lifecycleEvaluationJob.task = cron.schedule(
      lifecycleEvaluationJob.cron,
      () => invokeJob(lifecycleEvaluationJob, 'cron'),
      { timezone: TZ },
    );
    lifecycleEvaluationJob.registered = true;
    logger.info('Technician lifecycle evaluation registered (daily 02:00 IST).');
  }

  // ── Transcription backfill — fetch Plivo transcripts for EVERY completed
  //    call (not just ones whose recording someone played), so Call Analytics
  //    has a transcript per call. Gated by plivo.transcription.enabled. ──
  const callTranscriptionCron = require('../services/call-transcription-cron');
  const transcriptionBackfillJob = registerJob({
    id: 'transcription-backfill',
    name: 'Call Transcription Backfill',
    description:
`What this task does: Every 30 minutes it fetches + stores the Plivo transcription for completed Plivo calls that don't have one yet, so Settings → Call Analytics has a transcript for each call to analyse.

Step by step:
  1. Every 30 minutes the task wakes up.
  2. It finds completed Plivo calls (last 7 days) that already have a call-log row but no transcription yet.
  3. For each, it looks up the call's recording on Plivo, then fetches that recording's transcription and stores it on the call-log row.
  4. Calls whose recording isn't ready yet are left pending and retried on a later run.
  5. It logs how many were eligible / completed / not-available / pending / failed (visible below under Last Run).

Note: only runs automatically if easyfix_properties "plivo.transcription.enabled" = "true" (checked once at server start — restart after flipping). Trigger Now still works for manual testing. Transcriptions are customer PII — ensure a retention policy.`,
    cron: '*/30 * * * *',
    runner: async () => {
      const result = await callTranscriptionCron.runTranscriptionBackfill({ limit: 50 });
      logger.info('Transcription-backfill cron · ' + JSON.stringify(result));
      return result;
    },
  });
  const transcriptionBackfillEnabled =
    String(getProperty('plivo.transcription.enabled') ?? '').toLowerCase() === 'true';
  if (cronDisabled) {
    transcriptionBackfillJob.skipReason = 'CRON_DISABLED=true';
  } else if (!transcriptionBackfillEnabled) {
    transcriptionBackfillJob.skipReason = "property 'plivo.transcription.enabled' was not 'true' at server start — flip it to 'true' and restart to enable";
    logger.info("Transcription-backfill cron SKIPPED — set plivo.transcription.enabled=true in easyfix_properties to enable (takes effect after restart).");
  } else {
    transcriptionBackfillJob.task = cron.schedule(
      transcriptionBackfillJob.cron,
      () => invokeJob(transcriptionBackfillJob, 'cron'),
      { timezone: TZ },
    );
    transcriptionBackfillJob.registered = true;
    logger.info('Transcription-backfill cron registered (plivo.transcription.enabled=true, every 30 min IST).');
  }

  // ── Call-metrics (Amazon Transcribe Call Analytics) — start + retrieve jobs
  //    for completed calls. Gated by transcribe.analytics.enabled + AWS config. ──
  const callMetricsCron = require('../services/call-metrics-cron');
  const transcribeSvc = require('../services/transcribe-call-analytics.service');
  const callMetricsJob = registerJob({
    id: 'call-metrics-transcribe',
    name: 'Call Metrics (Transcribe Call Analytics)',
    description:
`What this task does: Every 10 minutes it drives Amazon Transcribe Call Analytics for completed Plivo calls — it starts an analytics job on each call's recording (caching the recording in S3 first if needed) and, on later runs, retrieves the finished result (sentiment, agent/customer talk-time, interruptions) and stores it for Settings → Call Analytics.

Note: only runs automatically when easyfix_properties "transcribe.analytics.enabled" = "true" AND the AWS config is present (S3_BUCKET_NAME + TRANSCRIBE_DATA_ACCESS_ROLE_ARN). Checked at server start — restart after changing. Transcribe Call Analytics needs 2-channel recordings + a region that supports it.`,
    cron: '*/10 * * * *',
    runner: async () => {
      const r = await callMetricsCron.runCallMetrics({ startLimit: 10, pollLimit: 25 });
      logger.info('Call-metrics cron · ' + JSON.stringify(r));
      return r;
    },
  });
  if (cronDisabled) {
    callMetricsJob.skipReason = 'CRON_DISABLED=true';
  } else if (!transcribeSvc.enabled()) {
    callMetricsJob.skipReason = "transcribe.analytics.enabled not 'true' OR AWS config (S3_BUCKET_NAME / TRANSCRIBE_DATA_ACCESS_ROLE_ARN) missing at server start";
    logger.info('Call-metrics cron SKIPPED — set transcribe.analytics.enabled=true + AWS config to enable (takes effect after restart).');
  } else {
    callMetricsJob.task = cron.schedule(
      callMetricsJob.cron,
      () => invokeJob(callMetricsJob, 'cron'),
      { timezone: TZ },
    );
    callMetricsJob.registered = true;
    logger.info('Call-metrics cron registered (transcribe.analytics.enabled=true, every 10 min IST).');
  }

  // ─── QA database refresh from production — 1st + 16th, 00:30 IST ────
  // Explicit OPT-IN gate (=== 'true'), unlike the default-on per-cron flags:
  // this job DROPS a database, so a missing property must never be able to
  // schedule it. Guards inside the service refuse to run outside ENVIRONMENT=qa.
  const qaDbRefresh = require('../services/qa-db-refresh.service');
  const qaDbRefreshJob = registerJob({
    id: 'qa-db-refresh',
    name: 'QA Database Refresh from Production',
    description:
`What this task does: QA's database slowly drifts away from production, so bugs that only show up on real data can't be reproduced and testing gives false confidence. Twice a month this task reloads QA with a fresh copy of production data.

Here's how it works, step by step:
  1. At 12:30 AM IST on the 1st and the 16th of each month, the task wakes up.
  2. It runs a series of safety checks BEFORE touching anything. It refuses to run unless this is the QA environment, and unless the restore target is the QA database and is not the same server it is copying from. Either of those failing stops the task immediately and emails the failure. (Keeping QA from messaging real customers is handled separately, by the test-number redirects each message channel already applies.)
  3. It takes a copy of the database from production's REPLICA — a stand-by copy of production — never from the live production database itself. It connects using a read-only login that is not permitted to change anything, so production cannot be affected even in principle. The copy is taken in a way that places no locks on the replica.
  4. It checks the copy is complete. A dropped network connection can produce a file that looks fine but stops halfway — restoring that would leave QA quietly missing data. The task confirms the copy ran to the very end before going any further.
  5. Only then does it pause QA: the app starts replying "briefly unavailable" to requests, the QA database is replaced with the fresh copy, and the app resumes. This pause is why the task runs at 12:30 AM.
  6. It confirms QA came back up with data, deletes older copies to save disk, and emails the result — success or failure — to the recipients in "qa.dbrefresh.alert.emails".

Note: this task exists ONLY in the QA environment. On production it is never scheduled and refuses to run at all, so it can never touch production's own database. Trigger Now runs it on demand in QA (the same safety checks still apply).`,
    cron: '30 0 1,16 * *',
    // Real interrupt: kills the in-flight mysqldump/mysql child.
    canceller: () => qaDbRefresh.cancelRun(),
    runner: async () => {
      const r = await qaDbRefresh.runQaDbRefresh();
      logger.info('QA DB refresh · ' + JSON.stringify({ ok: r.ok, tables: r.tables, error: r.error }));
      return r;
    },
  });
  /*
   * ENVIRONMENT is the only gate. There is deliberately no property flag: a
   * property is a value someone can flip, and the one thing that must never be
   * flippable is "may this job drop a database on this box". ENVIRONMENT is set
   * per-host by the compose file (deploy/docker-compose.yml sets "qa"; the prod
   * compose does not), so the answer is a property OF THE MACHINE, not of the
   * data — which is exactly the right shape for this decision.
   *
   * Defence in depth: the service re-checks ENVIRONMENT in assertSafeToRun()
   * before every run, so even Trigger Now on a prod box refuses.
   */
  const isQaEnv = String(process.env.ENVIRONMENT || '').toLowerCase() === 'qa';
  if (cronDisabled) {
    qaDbRefreshJob.skipReason = 'CRON_DISABLED=true';
  } else if (!isQaEnv) {
    qaDbRefreshJob.skipReason = `ENVIRONMENT is "${process.env.ENVIRONMENT || '(unset)'}", not "qa" — this job only ever runs in QA`;
    logger.info('QA DB refresh cron NOT registered — this is not the QA environment (ENVIRONMENT != qa).');
  } else {
    qaDbRefreshJob.task = cron.schedule(
      qaDbRefreshJob.cron,
      () => invokeJob(qaDbRefreshJob, 'cron'),
      { timezone: TZ },
    );
    qaDbRefreshJob.registered = true;
    logger.info('QA DB refresh cron registered (ENVIRONMENT=qa, 1st + 16th 00:30 IST).');
  }

  /*
   * ─── QA DB refresh — DRY RUN (manual only, never scheduled) ─────────
   * Registered as its OWN job rather than an option on the one above,
   * because `triggerJob(id)` takes no arguments — threading options through
   * invokeJob() would change shared plumbing every other job depends on. As a
   * separate entry it gets its own Trigger Now button, its own telemetry, and
   * — having no cron task — it can never fire on its own.
   */
  const qaDbRefreshDryJob = registerJob({
    id: 'qa-db-refresh-dry-run',
    name: 'QA Database Refresh — Dry Run (safe, no restore)',
    description:
`What this task does: exactly what the QA Database Refresh does, but it STOPS before touching QA. It runs every safety check, connects to the production replica with the read-only login, downloads the copy, and verifies the copy is complete — then stops and emails you the result. QA is left exactly as it was.

Use this to prove the real refresh will work before letting it run for the first time, or after changing any of the database settings. If the dry run passes, the only step left untested is the restore itself.

This task has no schedule and can only be started with "Trigger Now".`,
    cron: 'manual only (no schedule)',
    canceller: () => qaDbRefresh.cancelRun(),
    runner: async () => {
      const r = await qaDbRefresh.runQaDbRefresh({ dryRun: true });
      logger.info('QA DB refresh DRY RUN · ' + JSON.stringify({ ok: r.ok, dumpBytes: r.dumpBytes, error: r.error }));
      return r;
    },
  });
  // Never scheduled by design — `registered:false` + this reason is what the
  // admin page renders, and Trigger Now stays available regardless. Outside QA
  // it stays visible but refuses on invocation (assertSafeToRun), so say so
  // here rather than letting an operator discover it by pressing the button.
  qaDbRefreshDryJob.skipReason = isQaEnv
    ? 'manual only — this job has no schedule; use Trigger Now'
    : `manual only — and ENVIRONMENT is "${process.env.ENVIRONMENT || '(unset)'}", so it will refuse to run outside QA`;

  // ─── Conference reaper — every 5 minutes ─────────────────────────────
  // (Added 2026-08-04) COST BACKSTOP for Plivo conference calling. Every ops
  // call is now a Multi-Party Call, an orphaned one bills every leg until
  // Plivo's own max_duration fires, and /api/admin/* is rate-limit-exempt —
  // so this is the only thing that force-ends a runaway room. It also frees
  // conferences stranded in 'creating', which otherwise consume the
  // concurrency cap (default 3) and block EVERY ops call.
  const conferenceReaper = require('../services/conference-reaper-cron');
  const conferenceReaperJob = registerJob({
    id: 'conference-reaper',
    name: 'Conference Reaper (Cost Backstop)',
    description:
`What this task does: Ops calls are now conference calls, and a conference that nobody hangs up keeps charging for every person still on the line. Every 5 minutes this task looks for calls that have overrun and shuts them down.

Step by step:
  1. Every 5 minutes, the task wakes up automatically.
  2. It finds conference calls still running after an unreasonably long time. There is deliberately NO maximum-length setting — ops asked for no cap on how long a call may run, so this is not a limit being enforced. It is a leak detector, with a ceiling set high enough in code that a real conversation can never trip it.
  3. It ends each of those with the phone provider, then reads the call back to confirm it really stopped. If the provider says the call is still running, the task leaves it marked as running and tries again next time, rather than pretending it succeeded.
  4. It then checks calls stuck at "starting" — these are calls where the provider never told us the conference actually began. It asks the provider directly and either marks them running or clears them out, so the records match what really happened and a stuck row does not sit there looking live for ever.
  5. Finally it clears out individual people stuck at "ringing" long after the phone should have stopped ringing.
  6. It logs everything it changed — visible in the server logs and on this page under Last Run.

Why this matters: this is the money guard, and since ops chose to have no maximum call length and no cap on participants, it is now the ONLY one besides the operator hanging up (which ends the call for everyone automatically). Conference calling has no on/off switch of its own — it is part of every ops call — so without this task a single stuck call could keep billing for hours unnoticed.

Test button: leaving the ID blank does a DRY RUN — it reports what the next sweep would end, without touching anything. Entering a conference ID force-ends THAT conference for real (it will hang up a live call).

Note: this runs automatically unless the property "plivo.conference.reaper.enabled" is set to "false" in easyfix_properties (checked once at server start — restart after changing). Trigger Now / Test still work either way.`,
    cron: '*/5 * * * *',
    runner: async () => {
      const r = await conferenceReaper.run({ limit: 25 });
      logger.info('Conference-reaper cron · ' + JSON.stringify(r));
      return r;
    },
    tester: ({ sourceId }) => conferenceReaper.runTest({ sourceId }),
    testSourceLabel: 'Conference ID (tbl_job_conference.id) — optional',
    testSourceHelp:
      'Leave BLANK for a dry run (reports what would be ended, changes nothing). Enter a conference ID to force-end that conference immediately — this really does hang up a live call, and is the only way to verify the provider teardown works.',
  });
  // Cost-safety infra cron → default-ON kill switch (set 'false' to disable),
  // deliberately NOT an opt-in gate: an unseeded property must not leave the
  // money guard switched off.
  const conferenceReaperEnabled =
    String(getProperty('plivo.conference.reaper.enabled') ?? '').toLowerCase() !== 'false';
  if (cronDisabled) {
    conferenceReaperJob.skipReason = 'CRON_DISABLED=true';
  } else if (!conferenceReaperEnabled) {
    conferenceReaperJob.skipReason = "property 'plivo.conference.reaper.enabled' is 'false' — set it to 'true' (or remove it) and restart to enable. ⚠ While off, runaway conferences are NOT force-ended.";
    logger.warn("⚠ Conference-reaper cron SKIPPED — plivo.conference.reaper.enabled=false in easyfix_properties. Runaway conference calls will NOT be force-ended.");
  } else {
    conferenceReaperJob.task = cron.schedule(
      conferenceReaperJob.cron,
      () => invokeJob(conferenceReaperJob, 'cron'),
      { timezone: TZ },
    );
    conferenceReaperJob.registered = true;
    logger.info('Conference-reaper cron registered (every 5 min IST, cost backstop).');
  }

  // ─── Deep Skill Image-Gen orphan reset — every 5 minutes ─────────────
  // Standalone cron (NOT registered via registerJob()). Deliberately
  // absent from the Scheduled Jobs admin page — this is infrastructure
  // plumbing, not an operator-facing task. Flips status='pending' rows
  // older than 10 minutes to 'failed' so the FE polling loop can stop
  // spinning on rows whose dispatcher was killed by a server restart.
  // See services/deep-skill-image-gen.service.js::resetOrphanedPendingImageGens
  // for the full rationale.
  //
  // No property gate — the cost is one tiny UPDATE per 5 min, and the
  // alternative (gate disabled, orphans accumulate) is strictly worse.
  // init() has no early return for CRON_DISABLED — gate inline so dev environments stay quiet.
  if (!cronDisabled) {
    const dsImageGen = require('../services/deep-skill-image-gen.service');
    orphanResetTask = cron.schedule(
      '*/5 * * * *',
      async () => {
        try {
          await dsImageGen.resetOrphanedPendingImageGens();
        } catch (err) {
          logger.warn({ err }, 'deep-skill orphan-reset tick failed');
        }
      },
      { timezone: TZ },
    );
    logger.info('Deep-skill image-gen orphan reset cron registered (every 5 min, hidden from admin page).');
  }

  // ─── Idempotency response retention — hourly, bounded ───────────────
  // Infrastructure housekeeping, not an operator workflow: one indexed
  // DELETE capped at 1,000 rows. Fourteen-day expiry keeps responses beyond
  // the app's seven-day outbox window without allowing the ledger to grow
  // indefinitely. No timer is registered when CRON_DISABLED=true.
  if (!cronDisabled) {
    const idempotencyRetention = require('../services/idempotency-retention.service');
    idempotencyCleanupTask = cron.schedule(
      '17 * * * *',
      async () => {
        try {
          await idempotencyRetention.run();
        } catch (err) {
          logger.warn({ err }, 'idempotency retention tick failed');
        }
      },
      { timezone: TZ },
    );
    logger.info('Idempotency retention cron registered (hourly, max 1,000 rows, hidden from admin page).');
  }

  const registeredCount = jobs.filter((j) => j.registered).length;
  logger.ready(`Scheduler started — ${registeredCount}/${jobs.length} task(s) registered (tz=${TZ}).`);
}

function stop() {
  for (const j of jobs) {
    try { j.task?.stop(); } catch { /* ignore */ }
    j.task = null;
    j.registered = false;
  }
  jobs.length = 0;
  try { orphanResetTask?.stop(); } catch { /* ignore */ }
  orphanResetTask = null;
  try { idempotencyCleanupTask?.stop(); } catch { /* ignore */ }
  idempotencyCleanupTask = null;
}

/*
 * Public-safe projection of the registry — strips the runner closure
 * and the node-cron task handle so the API response only carries
 * serialisable telemetry. Returns a fresh array every call so callers
 * can mutate without polluting state.
 */
function getJobs() {
  return jobs.map((j) => ({
    id: j.id,
    name: j.name,
    description: j.description,
    cron: j.cron,
    timezone: TZ,
    registered: j.registered,
    skipReason: j.skipReason,
    lastRunAt: j.lastRunAt,
    lastDurationMs: j.lastDurationMs,
    lastResult: j.lastResult,
    lastError: j.lastError,
    lastTriggerKind: j.lastTriggerKind,
    // Live-run surface — drives the progress strip + Stop button. All in-memory,
    // so the list endpoint stays a pure projection with no added query cost.
    running: !!j.running,
    runningSince: j.runningSince ? new Date(j.runningSince).toISOString() : null,
    runningMs: j.runningSince ? Date.now() - j.runningSince : null,
    progressText: j.progressText || null,
    cancelRequested: !!j.cancelRequested,
    cancellable: typeof j.canceller === 'function',
    // Test-send surface (2026-06-06). `testable` drives whether the FE
    // renders a Test button next to Trigger Now; the label/help strings
    // drive the modal's optional source-id input copy. The lastTest*
    // fields mirror the lastRun* fields but for the SEPARATE test path
    // so a test send doesn't pollute the production cron's telemetry.
    testable: !!j.tester,
    testSourceLabel: j.testSourceLabel,
    testSourceHelp: j.testSourceHelp,
    lastTestAt: j.lastTestAt || null,
    lastTestDurationMs: j.lastTestDurationMs ?? null,
    lastTestResult: j.lastTestResult ?? null,
    lastTestError: j.lastTestError || null,
  }));
}

/*
 * Manual trigger — invoked from the admin "Trigger Now" button.
 * Runs the job's runner OUT-OF-BAND (no cron tick). Updates the
 * in-memory telemetry on the same registry entry so the operator sees
 * the result reflected in the next /scheduled-jobs list response.
 * Returns whatever the runner returned (or throws if the runner threw —
 * the HTTP handler can surface that as a 500).
 */
async function triggerJob(id) {
  const job = jobs.find((j) => j.id === id);
  if (!job) {
    const err = new Error(`No scheduled job with id "${id}"`);
    err.status = 404;
    throw err;
  }
  return invokeJob(job, 'manual');
}

/*
 * Test send (2026-06-06). Invokes the job's tester closure with the
 * operator-supplied opts ({ mobile, sourceId }). Distinct from triggerJob()
 * because:
 *   - It does NOT touch the job's lastRunAt / lastDurationMs telemetry.
 *     A test send is an out-of-band probe — surfacing it as "Last Run" on
 *     the admin page would mislead ops into thinking the cron itself ran.
 *     Instead we stash the test outcome on `lastTestAt` / `lastTestResult`
 *     / `lastTestError` so the FE can render a small "Last Test" line
 *     separately without polluting the production cron telemetry.
 *   - The tester is OPTIONAL per job — throws 400 if the targeted job
 *     didn't register one (most jobs are too side-effect-heavy to be
 *     safely testable; only message-dispatch crons opt in).
 *   - Validates the route's input shape, but the per-job tester is
 *     the source of truth for mobile / sourceId validation (so each
 *     job can enforce its own constraints — e.g. magic-link requires
 *     a real job_id with status=9 if sourceId is given).
 */
async function testJob(id, opts) {
  const job = jobs.find((j) => j.id === id);
  if (!job) {
    const err = new Error(`No scheduled job with id "${id}"`);
    err.status = 404;
    throw err;
  }
  if (typeof job.tester !== 'function') {
    const err = new Error(`Job "${id}" does not support test sends.`);
    err.status = 400;
    throw err;
  }
  const t0 = Date.now();
  job.lastTestAt = new Date();
  job.lastTestError = null;
  job.lastTestResult = null;
  job.lastTriggerKind = 'test';
  try {
    const result = await job.tester(opts || {});
    job.lastTestDurationMs = Date.now() - t0;
    job.lastTestResult = result ?? { ok: true };
    return result;
  } catch (err) {
    job.lastTestDurationMs = Date.now() - t0;
    job.lastTestError = err?.message || String(err);
    logger.warn(`Cron job "${job.id}" TEST failed: ${job.lastTestError}`);
    throw err;
  }
}

module.exports = {
  init, stop, getJobs, triggerJob, testJob,
  setJobProgress, requestCancel, isCancelRequested,
};
