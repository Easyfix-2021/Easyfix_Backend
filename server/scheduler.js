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
}) {
  const job = {
    id, name, description,
    cron: cronExpr,
    runner,
    tester: tester || null,
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
  }
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
  if (!cronDisabled) {
    kaleyraJob.task = cron.schedule(
      kaleyraJob.cron,
      () => invokeJob(kaleyraJob, 'cron'),
      { timezone: TZ },
    );
    kaleyraJob.registered = true;
  } else {
    kaleyraJob.skipReason = 'CRON_DISABLED=true';
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
  if (!cronDisabled) {
    noticePublishJob.task = cron.schedule(
      noticePublishJob.cron,
      () => invokeJob(noticePublishJob, 'cron'),
      { timezone: TZ },
    );
    noticePublishJob.registered = true;
  } else {
    noticePublishJob.skipReason = 'CRON_DISABLED=true';
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
  if (!cronDisabled) {
    offerExpiryJob.task = cron.schedule(
      offerExpiryJob.cron,
      () => invokeJob(offerExpiryJob, 'cron'),
      { timezone: TZ },
    );
    offerExpiryJob.registered = true;
  } else {
    offerExpiryJob.skipReason = 'CRON_DISABLED=true';
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
  if (!cronDisabled) {
    recordingBackfillJob.task = cron.schedule(
      recordingBackfillJob.cron,
      () => invokeJob(recordingBackfillJob, 'cron'),
      { timezone: TZ },
    );
    recordingBackfillJob.registered = true;
  } else {
    recordingBackfillJob.skipReason = 'CRON_DISABLED=true';
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

module.exports = { init, stop, getJobs, triggerJob, testJob };
