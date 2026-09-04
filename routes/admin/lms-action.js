const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const requireAction = require('../../middleware/require-action');
const { buildRequestScope, assertEntityInScope } = require('../../lib/scope');
const action = require('../../services/lms-action.service');
const chase = require('../../services/lms-chase.service');
const lms = require('../../services/lms.service');
const pushDelivery = require('../../services/push-delivery.service');
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');
const { streamStyledXlsx } = require('../../utils/xlsx-styled-export');
const logger = require('../../logger');

/*
 * LMS action tool — B-01 action home, B-02 pending drilldown, B-13 the state
 * manager's own city, and the chase endpoints underneath all three.
 *
 * Mounted as a SECOND router on /admin/lms, alongside routes/admin/lms.js,
 * the way /jobs already spreads across several files. The split is by
 * purpose, not by table: lms.js is the content and assignment CRUD a training
 * admin uses to SET things up, this file is what the team looks at every
 * morning to find out what needs doing.
 *
 * TWO ROLES, ONE MECHANISM
 *   Training team  — isLmsAction + isLmsChaseHandoff + isLmsManage
 *   State manager  — isLmsAction only, and a geographic scope
 *
 * The state manager is NOT a new role_id. A user whose tbl_user.manage_states
 * is an explicit allow-list already resolves, via lib/scope.js, to a live city
 * list on req.scope — so "his city only" is enforced by the same machinery
 * that scopes Manage Easyfixers, not by a second idea of who owns where.
 * Inventing a role would give the database a third representation of the same
 * fact, and three representations drift.
 *
 * "CANNOT CREATE OR PUSH" IS ENFORCED HERE, NOT IN THE UI
 * Every mutating route carries an action key. A state manager who crafts the
 * POST by hand gets a 403 from the route, not a hidden button.
 *
 * MOBILE NUMBERS
 * Inherited maskMobile masks them on the way out, so the browser never holds
 * a technician's number. That is why the WhatsApp and call endpoints take an
 * efrId and resolve the number server-side rather than accepting one.
 */

const requireLmsAction = requireAction('isLmsAction');
const requireHandoff = requireAction('isLmsChaseHandoff');
const requireLmsManage = requireAction('isLmsManage');

const DETECTORS = [
  'deadline_passed', 'session_48h', 'assessment_failed',
  'paused_not_started', 'client_uncertified', 'stale_module',
];
const CHIPS = ['overdue', 'not_started', 'part_done', 'failed', 'done'];

const homeQuery = Joi.object({
  /*
   * The Refresh button, and nothing else, bypasses the 60s cache.
   *
   * truthy(1)/falsy(0) because Joi 17 dropped numeric coercion for booleans:
   * `?fresh=1` — the obvious thing for a caller to send, and what the first
   * version of the CRM sent — 400s without it. Accepting both spellings costs
   * nothing and removes a class of "why is Refresh broken" report.
   */
  fresh: Joi.boolean().truthy(1, '1').falsy(0, '0').default(false),
});

const pendingQuery = Joi.object({
  detector: Joi.string().valid(...DETECTORS).optional(),
  courseId: Joi.number().integer().positive().optional(),
  /* Narrows to technicians mapped to this client — the D5 "Push now" row
   * links here with it, and until 2026-08-21 it was accepted and then
   * ignored, so that link showed the whole organisation. */
  clientId: Joi.number().integer().positive().optional(),
  status: Joi.string().valid(...CHIPS).optional(),
  q: Joi.string().allow('', null).optional(),
  limit: Joi.number().integer().min(1).max(500).default(50),
  offset: Joi.number().integer().min(0).default(0),
});

/* A bulk chase is capped by the same 500 ceiling the assign endpoint uses. */
const chaseBody = Joi.object({
  efrIds: Joi.array().items(Joi.number().integer().positive()).min(1).max(500).required(),
  courseId: Joi.number().integer().positive().allow(null).optional(),
  detectorKey: Joi.string().valid(...DETECTORS).optional(),
  note: Joi.string().max(500).allow('', null).optional(),
});

const handoffBody = chaseBody.keys({ confirm: Joi.boolean().default(false) });

/* ─── B-01 · Action home ──────────────────────────────────────────────*/

router.get('/action/home', requireLmsAction, validate(homeQuery, 'query'), async (req, res, next) => {
  try {
    const scope = buildRequestScope(req);
    const payload = await action.actionHome(scope, { fresh: req.query.fresh });
    logger.info('LMS action home · rows=' + payload.rows.length
      + ' · overdue=' + payload.counters.overdue);
    modernOk(res, payload);
  } catch (e) { next(e); }
});

/* ─── B-02 · Pending drilldown ────────────────────────────────────────*/

router.get('/action/pending', requireLmsAction, validate(pendingQuery, 'query'), async (req, res, next) => {
  try {
    const scope = buildRequestScope(req);
    const page = await action.pendingList({ ...req.query, scope });

    /* Chase history for exactly this page's technicians — one grouped read,
     * never one per row. */
    const summary = await chase.chaseSummaryFor(page.rows.map((r) => r.easyfixer_id));
    const rows = page.rows.map((r) => ({
      ...r,
      last_chased_at: summary.get(Number(r.easyfixer_id))?.lastChasedAt ?? null,
      chase_count_7d: summary.get(Number(r.easyfixer_id))?.count7d ?? 0,
    }));

    modernOk(res, { ...page, rows });
  } catch (e) { next(e); }
});

/*
 * The drilldown as a spreadsheet.
 *
 * It takes THE SAME query parameters as the list and runs THE SAME service
 * call — the export is a mirror of what is on screen, not a second query that
 * happens to look similar. The CRM builds one URLSearchParams and uses it for
 * both, so the two cannot describe different sets. (jobs/export.xlsx carries
 * the same rule in a comment, and it is there because the two drifted once.)
 *
 * Mobile numbers are NOT included. The inherited maskMobile would mask them
 * anyway, and a column of "9876••••••" is worse than no column: it looks like
 * data and is useless for the one thing a phone number is for. The EFX id is
 * the identifier that actually travels between systems.
 */
router.get('/action/pending/export.xlsx', requireLmsAction, validate(pendingQuery, 'query'), async (req, res, next) => {
  try {
    const scope = buildRequestScope(req);
    /* The export ceiling is the endpoint's own max, not an invented one, so a
     * sheet can never silently contain less than the list claims. */
    const page = await action.pendingList({ ...req.query, limit: 500, offset: 0, scope });
    /* Chase history is added by the LIST route, not by the service, so the
     * export has to ask for it too — otherwise the Last Chased column is
     * silently blank for everyone and reads as "never chased". */
    const summary = await chase.chaseSummaryFor(page.rows.map((r) => r.easyfixer_id));
    page.rows = page.rows.map((r) => ({
      ...r,
      last_chased_at: summary.get(Number(r.easyfixer_id))?.lastChasedAt ?? null,
      chase_count_7d: summary.get(Number(r.easyfixer_id))?.count7d ?? 0,
    }));
    logger.info('Export LMS pending xlsx · detector=' + (req.query.detector ?? '-')
      + ' · status=' + (req.query.status ?? '-') + ' · rows=' + page.rows.length + ' of ' + page.total);

    const truncated = page.total > page.rows.length;
    const meta = [
      `Generated: ${page.today}`,
      `Filter: ${req.query.detector || 'all outstanding'}${req.query.status ? ' · ' + req.query.status : ''}`,
      /* Say it on the sheet, not just in a log. A silently truncated export
       * reads as "this is everyone", which is how a chase list loses people. */
      truncated
        ? `Showing the first ${page.rows.length} of ${page.total} — narrow the filter to export the rest`
        : `Total: ${page.total} row${page.total === 1 ? '' : 's'}`,
    ];

    await streamStyledXlsx(res, `lms-pending_${page.today}.xlsx`, {
      title: 'EasyFix  ·  Training Pending',
      meta,
      sheetName: 'Pending',
      columns: [
        { header: 'EFX ID', key: 'efx_id', width: 12, align: 'center' },
        { header: 'Technician', key: 'technician', width: 28, align: 'left' },
        { header: 'City', key: 'city', width: 18, align: 'left' },
        { header: 'Grade', key: 'grade', width: 10, align: 'center' },
        { header: 'Module', key: 'course', width: 30, align: 'left' },
        { header: 'Progress', key: 'progress', width: 12, align: 'center' },
        { header: 'Status', key: 'status', width: 14, align: 'center' },
        { header: 'Assigned On', key: 'assigned_on', width: 14, align: 'center' },
        { header: 'Due Date', key: 'due_date', width: 14, align: 'center' },
        { header: 'Days Late', key: 'days_late', width: 11, align: 'center' },
        { header: 'Last Chased', key: 'last_chased', width: 18, align: 'center' },
        { header: 'Chases (7d)', key: 'chases_7d', width: 12, align: 'center' },
      ],
      rows: page.rows.map((r) => {
        const due = r.due_date ? String(r.due_date).slice(0, 10) : '';
        const daysLate = due && due < page.today
          ? Math.round((Date.parse(`${page.today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86400000)
          : '';
        return {
          efx_id: r.easyfixer_id,
          technician: r.technician_name || '',
          city: r.city_name || '',
          grade: r.grade || '',
          course: r.course_name || '',
          progress: `${r.videos_done}/${r.videos_total}`,
          status: r.status,
          assigned_on: r.assigned_on ? String(r.assigned_on).slice(0, 10) : '',
          due_date: due,
          days_late: daysLate,
          last_chased: r.last_chased_at ? String(r.last_chased_at).slice(0, 16).replace('T', ' ') : 'Never',
          chases_7d: r.chase_count_7d ?? 0,
        };
      }),
      emptyMessage: 'Nothing outstanding for this filter.',
    });
  } catch (e) { next(e); }
});

/* ─── B-13 · The state manager's own city ─────────────────────────────
 *
 * Three lists, and a sentence. The spec is explicit that the sentence is the
 * screen: "9 technicians in your city are not earning because of pending
 * training" — it connects training to money, which is what a state manager
 * actually cares about.
 *
 * "Not earning" is not a new calculation. It is exactly the population for
 * whom lms.hasOverdueTraining() returns true, which is what tech-auth uses to
 * zero receiveNewJobs / continueAssignedJobs / markAttendance. One predicate,
 * two screens, so the count on B-13 and the restriction on the technician's
 * phone can never disagree.
 */

router.get('/field/my-city', requireLmsAction, async (req, res, next) => {
  try {
    const scope = buildRequestScope(req);
    const [overdue, pending, handedOff] = await Promise.all([
      action.pendingList({ detector: 'deadline_passed', limit: 200, scope }),
      action.pendingList({ status: 'not_started', limit: 200, scope }),
      listHandoffsFor(req, scope),
    ]);

    /* The headline counts TECHNICIANS, not assignments — one person owing
     * three modules is one person not earning. */
    const notEarning = new Set(overdue.rows.map((r) => Number(r.easyfixer_id)));

    /*
     * ONE array, not two.
     *
     * The spec lists "Paused" and "Overdue" as separate sections, and they
     * will genuinely diverge once a push can opt out of blocking jobs. TODAY
     * they are the same population by definition: overdue training is exactly
     * what withdraws a technician's job capabilities. Sending the same 200
     * rows under two keys would make the payload look like two facts and
     * invite the reader to add them.
     *
     * So the server sends the assignments once; the screen presents them
     * twice — grouped by technician for "not earning", flat per module for
     * "overdue". `notEarningCount` is the grouped count, computed here so the
     * headline sentence and the card count cannot disagree.
     */
    modernOk(res, {
      today: overdue.today,
      notEarningCount: notEarning.size,
      headline: `${notEarning.size} technician${notEarning.size === 1 ? '' : 's'} in your city ${notEarning.size === 1 ? 'is' : 'are'} not earning because of pending training.`,
      overdue: overdue.rows,
      pending: pending.rows,
      handedOff,
    });
  } catch (e) { next(e); }
});

/*
 * Work the training team pushed to this manager. Addressed by user id where
 * a city has an owner, and by city otherwise, so a hand-off for a city with
 * no state_user is still visible to whoever is scoped to it rather than
 * disappearing.
 */
async function listHandoffsFor(req, scope) {
  const clauses = ["ca.status IN ('open','chased')"];
  const params = [];
  const userId = req.user?.user_id;
  if (userId) { clauses.push('(ca.assigned_user_id = ? OR ca.assigned_user_id IS NULL)'); params.push(userId); }
  const ci = scope?.cities;
  if (ci?.mode === 'none') clauses.push('1=0');
  else if (ci?.mode === 'allow' && ci.ids.length) {
    clauses.push(`ca.city_id IN (${ci.ids.map(() => '?').join(',')})`);
    params.push(...ci.ids);
  }
  const [rows] = await pool.query(
    `SELECT ca.id, ca.efr_id, ca.course_id, ca.city_id, ca.status, ca.note,
            ca.created_at, ca.first_chased_at, ca.batch_id,
            e.efr_name AS technician_name, e.efr_no, c.name AS course_name
       FROM lms_chase_assignment ca
       JOIN tbl_easyfixer e ON e.efr_id = ca.efr_id
       LEFT JOIN courses c ON c.id = ca.course_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY ca.created_at ASC
      LIMIT 200`,
    params,
  );
  return rows;
}

/* ─── Chase ───────────────────────────────────────────────────────────*/

/*
 * Resolve the technicians a chase may touch, IN SCOPE.
 *
 * Silently dropping an out-of-scope id would let a state manager chase
 * another state's technician by editing the request; 404-ing the whole call
 * tells them nothing useful when 199 of 200 ids are fine. So: filter to what
 * is in scope, and report what was dropped.
 */
async function resolveChaseTargets(req, scope, efrIds) {
  const ids = [...new Set(efrIds.map(Number).filter(Number.isFinite))];
  if (!ids.length) return { targets: [], dropped: [] };
  const [rows] = await pool.query(
    `SELECT efr_id, efr_name, efr_no, efr_cityId
       FROM tbl_easyfixer
      WHERE efr_id IN (${ids.map(() => '?').join(',')})
        AND NOT (efr_status <=> 3)`,
    ids,
  );
  const targets = [];
  const dropped = [];
  for (const r of rows) {
    const guard = assertEntityInScope(req, { city_id: r.efr_cityId });
    if (guard.ok) targets.push(r); else dropped.push(r.efr_id);
  }
  const missing = ids.filter((id) => !rows.some((r) => Number(r.efr_id) === id));
  return { targets, dropped: [...dropped, ...missing] };
}

/*
 * Nudge — the in-app push.
 *
 * CHUNKED AT 50, and that is not an optimisation.
 * push-delivery.resolveTokensForEfrs LOGS A WARNING AND RETURNS [] above
 * MAX_TARGETED_EFR_IDS. It does not throw. So handing it 412 ids delivers to
 * nobody, silently, and the only trace is one warn line — indistinguishable
 * from "nobody has a device registered".
 */
router.post('/chase/nudge', requireLmsAction, validate(chaseBody), async (req, res, next) => {
  try {
    const scope = buildRequestScope(req);
    const { targets, dropped } = await resolveChaseTargets(req, scope, req.body.efrIds);
    if (!targets.length) return modernError(res, 404, 'no technicians in scope for this chase');

    const batchId = chase.newBatchId();
    const skip = await chase.withinCooldown(targets.map((t) => t.efr_id), chase.CHANNEL_NUDGE);

    const message = {
      title: 'Finish Your Training',
      body: 'You have training to complete. Tap to continue watching.',
      data: { type: 'training_reminder', screen: 'training' },
    };

    const entries = [];
    let delivered = 0;
    const eligible = targets.filter((t) => !skip.has(Number(t.efr_id)));

    for (let i = 0; i < eligible.length; i += 50) {
      const slice = eligible.slice(i, i + 50);
      const recipients = await pushDelivery.resolveTokensForEfrs(slice.map((t) => t.efr_id));
      /*
       * PRUNE, unlike the notice broadcast this option block was copied from.
       * `prune:false` is deliberate for notice — a broadcast should not reap
       * tokens on someone else's behalf — but a chase is a TARGETED per-tech
       * send, exactly like the job-offer and training-reminder senders, and
       * those take the default true. Without it an UNREGISTERED token is left
       * on the row, so the same technician is targeted again tomorrow, fails
       * again, and can never be reached until they happen to reinstall: the
       * "notification is not working" report with no end state.
       */
      const out = await pushDelivery.deliver(recipients, message, {
        concurrency: 10, channel: 'lms-chase', unit: 'recipients',
        label: 'lms-chase · batch=' + batchId,
      });
      delivered += out.deliveredCount || 0;

      /*
       * THREE outcomes, because there are three things that can happen — and
       * until now the middle one was recorded as the first.
       *
       * `hadToken` used to be the whole test, so a technician FCM REJECTED was
       * logged 'sent' exactly like one it accepted. That is not only a lie in
       * the audit trail: withinCooldown and chaseSummaryFor both filter
       * `outcome IN ('sent','noted','queued')`, so the false success then
       * SUPPRESSED the retry that would have worked, and advanceHandoff moved
       * the field-view status on for a push nobody received. 'failed' was
       * already declared in OUTCOMES with nothing writing it.
       */
      const hadToken = new Set(recipients.map((r) => Number(r.efrId)));
      const gotIt = out.deliveredEfrIds ?? new Set();
      for (const t of slice) {
        const efrId = Number(t.efr_id);
        const outcome = gotIt.has(efrId) ? 'sent' : hadToken.has(efrId) ? 'failed' : 'skipped';
        entries.push(baseEntry(req, t, batchId, {
          channel: chase.CHANNEL_NUDGE,
          outcome,
          outcomeDetail: outcome === 'sent' ? null
            : outcome === 'failed' ? 'push rejected by FCM'
              : 'no device token',
        }));
      }
    }

    /* Cooldown skips are LOGGED, not omitted. "So nobody says they were never
     * told" cuts both ways — a skip with no trace looks like a bug. */
    for (const t of targets.filter((x) => skip.has(Number(x.efr_id)))) {
      entries.push(baseEntry(req, t, batchId, {
        channel: chase.CHANNEL_NUDGE, outcome: 'skipped', outcomeDetail: 'cooldown',
      }));
    }

    await chase.recordChaseBatch(entries);
    action.invalidate();
    logger.info('LMS nudge · targeted=' + targets.length + ' · delivered=' + delivered
      + ' · cooldownSkipped=' + skip.size);
    modernOk(res, {
      batchId, targeted: targets.length, delivered,
      cooldownSkipped: skip.size, outOfScope: dropped.length,
    });
  } catch (e) { next(e); }
});

/*
 * Mark chased — an off-platform contact the operator is recording.
 *
 * The spec puts this on B-13 because a state manager's real chase is a phone
 * call from their own handset. Without it the log would only ever show what
 * the CRM did, which is the smaller half of the truth.
 */
router.post('/chase/mark-chased', requireLmsAction, validate(chaseBody), async (req, res, next) => {
  try {
    const scope = buildRequestScope(req);
    const { targets, dropped } = await resolveChaseTargets(req, scope, req.body.efrIds);
    if (!targets.length) return modernError(res, 404, 'no technicians in scope for this chase');

    const batchId = chase.newBatchId();
    await chase.recordChaseBatch(targets.map((t) => baseEntry(req, t, batchId, {
      channel: chase.CHANNEL_MARK_CHASED, outcome: 'noted',
      outcomeDetail: req.body.note || null,
    })));
    action.invalidate();
    modernOk(res, { batchId, recorded: targets.length, outOfScope: dropped.length });
  } catch (e) { next(e); }
});

function baseEntry(req, tech, batchId, extra) {
  return {
    efrId: tech.efr_id,
    targetType: 'course',
    courseId: req.body.courseId ?? null,
    detectorKey: req.body.detectorKey ?? null,
    batchId,
    actor: req.user,
    actorRoleName: req.userRole?.role_name ?? null,
    actorSource: chase.SOURCE_CRM,
    /* The FULL number goes in; lms-chase.service masks it on the way to the
     * table. Masking is not this file's job and must not be. */
    recipientMobile: tech.efr_no ?? null,
    ...extra,
  };
}

/* ─── Send to state managers ──────────────────────────────────────────*/

/*
 * Two steps on purpose. The preview is what the operator confirms against,
 * and it names the cities with no owner rather than dropping them — a
 * technician who silently belongs to nobody is worse than one the training
 * team knowingly keeps.
 */
router.post('/action/handoff/preview', requireHandoff, validate(handoffBody), async (req, res, next) => {
  try {
    const scope = buildRequestScope(req);
    const { targets, dropped } = await resolveChaseTargets(req, scope, req.body.efrIds);
    const owners = await action._internals.ownersForCities(targets.map((t) => t.efr_cityId));

    const byCity = new Map();
    for (const t of targets) {
      const cid = Number(t.efr_cityId);
      if (!byCity.has(cid)) {
        byCity.set(cid, { city_id: cid, state_manager: owners.get(cid)?.name ?? null, count: 0 });
      }
      byCity.get(cid).count += 1;
    }
    const batchPreview = [...byCity.values()];
    modernOk(res, {
      batchPreview,
      total: targets.length,
      unassignable: batchPreview.filter((c) => !c.state_manager).reduce((n, c) => n + c.count, 0),
      outOfScope: dropped.length,
    });
  } catch (e) { next(e); }
});

router.post('/action/handoff', requireHandoff, validate(handoffBody), async (req, res, next) => {
  try {
    if (!req.body.confirm) return modernError(res, 400, 'confirm the split before sending');
    const scope = buildRequestScope(req);
    const { targets, dropped } = await resolveChaseTargets(req, scope, req.body.efrIds);
    if (!targets.length) return modernError(res, 404, 'no technicians in scope for this hand-off');

    const owners = await action._internals.ownersForCities(targets.map((t) => t.efr_cityId));
    const batchId = chase.newBatchId();
    const now = new Date();

    /* city_id is a SNAPSHOT: a technician who transfers city mid-chase must
     * not vanish from the manager who was asked to chase him. */
    const values = targets.map((t) => [
      t.efr_id, req.body.courseId ?? null, Number(t.efr_cityId),
      owners.get(Number(t.efr_cityId))?.userId ?? null,
      'open', req.body.detectorKey ?? null, batchId, req.body.note || null,
      req.user?.user_id ?? null, now,
    ]);

    await pool.query(
      `INSERT INTO lms_chase_assignment
         (efr_id, course_id, city_id, assigned_user_id, status, detector_key,
          batch_id, note, created_by_user_id, created_at)
       VALUES ${values.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
       ON DUPLICATE KEY UPDATE status = VALUES(status)`,
      values.flat(),
    );

    await chase.recordChaseBatch(targets.map((t) => baseEntry(req, t, batchId, {
      channel: chase.CHANNEL_HANDOFF, outcome: 'sent',
      outcomeDetail: 'sent to ' + (owners.get(Number(t.efr_cityId))?.name ?? 'the training team'),
    })));
    action.invalidate();

    logger.info('LMS hand-off · batch=' + batchId + ' · technicians=' + targets.length);
    modernOk(res, { batchId, handedOff: targets.length, outOfScope: dropped.length });
  } catch (e) { next(e); }
});

/* ─── D5 · Push now ───────────────────────────────────────────────────
 *
 * The one action-home button that CREATES assignments, so it needs the
 * authoring key, not the chase key. A state manager reaching this endpoint
 * gets a 403 from the route — the spec's "cannot create or push", enforced
 * rather than hidden.
 */
router.post('/action/client-push', requireLmsManage, validate(Joi.object({
  clientId: Joi.number().integer().positive().required(),
  courseId: Joi.number().integer().positive().required(),
}), 'body'), async (req, res, next) => {
  try {
    const { clientId, courseId } = req.body;
    const [[req_]] = await pool.query(
      'SELECT duration_months, duration_days FROM lms_client_course_requirement WHERE client_id = ? AND course_id = ? AND status = 1',
      [clientId, courseId],
    );
    if (!req_) return modernError(res, 404, 'no active certification requirement for this client and module');

    const [rows] = await pool.query(
      `SELECT DISTINCT m.easyfixer_id
         FROM tbl_client_easyfixer_mapping m
         JOIN tbl_easyfixer e ON e.efr_id = m.easyfixer_id
        WHERE m.client_id = ?
          AND (m.mapping_status IS NULL OR m.mapping_status <> 0)
          AND NOT (e.efr_status <=> 3)
          AND NOT EXISTS (
                SELECT 1 FROM easyfixer_courses ec
                 WHERE ec.easyfixer_id = m.easyfixer_id
                   AND ec.course_id = ?
                   AND ec.completion_date IS NOT NULL)
        LIMIT 500`,
      [clientId, courseId],
    );
    if (!rows.length) return modernOk(res, { assigned: 0, message: 'every mapped technician is already certified' });

    const out = await lms.assignCourse(courseId, rows.map((r) => r.easyfixer_id), {
      durationMonths: req_.duration_months, durationDays: req_.duration_days,
    });
    action.invalidate();
    modernOk(res, out);
  } catch (e) { next(e); }
});

module.exports = router;
