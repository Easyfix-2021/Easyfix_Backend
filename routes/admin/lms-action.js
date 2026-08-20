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
  /* The Refresh button, and nothing else, bypasses the 60s cache. */
  fresh: Joi.boolean().default(false),
});

const pendingQuery = Joi.object({
  detector: Joi.string().valid(...DETECTORS).optional(),
  courseId: Joi.number().integer().positive().optional(),
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

    modernOk(res, {
      today: overdue.today,
      notEarningCount: notEarning.size,
      headline: `${notEarning.size} technician${notEarning.size === 1 ? '' : 's'} in your city ${notEarning.size === 1 ? 'is' : 'are'} not earning because of pending training.`,
      paused: overdue.rows,
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
      const out = await pushDelivery.deliver(recipients, message, {
        concurrency: 10, prune: false, channel: 'lms-chase', unit: 'recipients',
        label: 'lms-chase · batch=' + batchId,
      });
      delivered += out.deliveredCount || 0;
      const reached = new Set(recipients.map((r) => Number(r.efrId)));
      for (const t of slice) {
        entries.push(baseEntry(req, t, batchId, {
          channel: chase.CHANNEL_NUDGE,
          outcome: reached.has(Number(t.efr_id)) ? 'sent' : 'skipped',
          outcomeDetail: reached.has(Number(t.efr_id)) ? null : 'no device token',
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
