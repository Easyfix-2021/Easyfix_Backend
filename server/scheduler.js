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

Note: this task only runs if the property "magic.link.cron.enabled" is set to "true" in easyfix_properties. If it's set to "false" (or unset), the automatic schedule is OFF — but Trigger Now still works for manual one-off sweeps.`,
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
    magicLinkJob.skipReason = "property 'magic.link.cron.enabled' is not 'true'";
    logger.info('Magic-link cron SKIPPED — set magic.link.cron.enabled=true in easyfix_properties to enable.');
  } else {
    magicLinkJob.task = cron.schedule(
      magicLinkJob.cron,
      () => invokeJob(magicLinkJob, 'cron'),
      { timezone: TZ },
    );
    magicLinkJob.registered = true;
    logger.info('Magic-link cron registered (magic.link.cron.enabled=true).');
  }

  // ─── Easyfixer Profile-Completion Reminder — daily at 10:00 IST ───
  // Added 2026-06-06 per ops. Finds every ACTIVE easyfixer with an
  // incomplete profile (efr_profile_perc < 100 OR final_submission != 1)
  // and sends them a WhatsApp nudge via the Gallabox template
  // `complete_profile_easyfixer`. No gating property — runs daily on
  // every env where CRON_DISABLED isn't set. Per-send errors are
  // logged + counted but don't abort the loop.
  const profileReminderCron = require('../services/easyfixer-profile-reminder-cron');
  const profileReminderJob = registerJob({
    id: 'easyfixer-profile-reminder',
    name: 'Easyfixer Profile-Completion Reminder',
    description:
`What this task does: Every active easyfixer (technician) in our system is expected to fill out their full profile — name, contact info, service categories they cover, documents (Aadhaar, PAN, photo), etc. When their profile is incomplete, the auto-assignment engine struggles to pick them for jobs, and ops can't verify them. This task gives those technicians a friendly daily nudge over WhatsApp.

Here's how it works, step by step:
  1. Every day at 10:00 AM IST, the task wakes up automatically.
  2. It looks at every technician in our database whose account is ACTIVE.
  3. From those, it picks only the ones whose profile is INCOMPLETE — meaning their profile completion percentage is below 100, OR they haven't yet pressed the "Final Submission" button (which signals "I'm done filling things in").
  4. It also filters out anyone without a valid mobile number on file — there's no point sending a WhatsApp message if we don't know where to send it.
  5. For each remaining technician, it asks Gallabox (our WhatsApp messaging provider) to send them a pre-approved template message called "complete_profile_easyfixer". The template is a generic, friendly nudge: "Please complete your EasyFix profile to get assigned to jobs."
  6. The task logs how many technicians were eligible, how many messages it attempted, how many succeeded, and how many failed — visible in the server logs and on this page (Last Run details below).

Why this matters: technicians often get distracted mid-signup and never finish their profile. Without this daily nudge, those incomplete profiles pile up indefinitely. The WhatsApp message lands directly on their phone and links back to the profile page — much higher conversion than email reminders.

Note: this task does NOT have a per-technician cooldown. A technician with an incomplete profile receives a nudge EVERY day until they finish (or until ops marks their account inactive). If a tech reports "stop spamming me", the operator should either deactivate their record (efr_status = 0) or complete the missing fields on their behalf. Trigger Now is useful if ops just imported a batch of new technicians and wants to send the first wave of nudges immediately rather than waiting for tomorrow's 10am tick.`,
    cron: '0 10 * * *',
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
  if (!cronDisabled) {
    profileReminderJob.task = cron.schedule(
      profileReminderJob.cron,
      () => invokeJob(profileReminderJob, 'cron'),
      { timezone: TZ },
    );
    profileReminderJob.registered = true;
    logger.info('Easyfixer profile-reminder cron registered (daily 10:00 IST).');
  } else {
    profileReminderJob.skipReason = 'CRON_DISABLED=true';
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
