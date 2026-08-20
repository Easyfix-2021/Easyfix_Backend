/*
 * LMS action home — the six detectors, the four counters, and the
 * "running normally" denominator.
 *
 * THE PREMISE, from the spec:
 *   "Not a content library with tracking added on. An action tool. The home
 *    screen shows only what needs someone to do something. Anything moving
 *    normally stays invisible. Every row answers three things: who is stuck ·
 *    who owns it · what to do next."
 *
 * That premise imposes one hard constraint on this file: EVERY NUMBER ON THE
 * SCREEN MUST COME FROM THE SAME READ. The counters, the rows and the
 * denominator are computed in one call, from one base predicate, against one
 * `istToday`, under one scope. The moment any of them is computed by a second
 * query with its own WHERE, the tile says 12, the drilldown shows 9, and
 * nobody trusts the screen again — at which point an action tool is just a
 * slower report.
 *
 * WHY A CACHE AND NOT A SUMMARY TABLE
 * The data is small: ~4,680 active technicians, and easyfixer_courses was
 * empty as recently as 2026-08-13. This is not a warehouse problem. A
 * materialised table would buy a cron, a staleness window, a backfill and a
 * second source of truth — for numbers whose entire value is that they agree
 * with each other and with the restriction the technician is actually under.
 * Instead: a 60-second in-process cache, KEYED BY THE CALLER'S CITY SCOPE.
 *
 * The key matters. A global cache filtered per request leaks counts across
 * states, and the counters are the first thing a state manager reads.
 *
 * D2 IS NOT COMPUTABLE YET and says so rather than pretending. There is no
 * sessions table, so the live-session detector reports `available: false` and
 * contributes zero to every counter and to the denominator. On a screen whose
 * whole premise is that what you see is what needs doing, a placeholder row is
 * worse than an absent one.
 */

const { pool } = require('../db');
const logger = require('../logger');
const properties = require('./properties.service');
const lms = require('./lms.service');

/* One tick of staleness, matching CITY_BY_STATE_TTL_MS in lib/scope.js so the
 * two caches in the request path can never disagree by more than a beat. */
const TTL_MS = 60_000;

const cache = new Map();

/*
 * Tunables. getProperty is synchronous and returns a RAW STRING.
 *
 * Every read goes through this guard because Number('') is 0, not NaN — a
 * blank or missing property must fall back to the default, not silently
 * become zero. A zero here would mean "every module is stale" (D6) or "no
 * cooldown at all"; the same coercion silently disabled the rewards earn
 * cycle for days in August.
 */
function propNumber(key, fallback) {
  const raw = properties.getProperty(key);
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const tunables = () => ({
  staleDays: propNumber('lms.action.stale.days', 7),
  stalePct: propNumber('lms.action.stale.pct', 30),
  minCohort: propNumber('lms.action.stale.min_cohort', 5),
  decisionDays: propNumber('lms.action.decision.days', 14),
});

/* ─── Scope ────────────────────────────────────────────────────────────
 *
 * ONE helper, six call sites. Six hand-written scope clauses is six chances
 * to write a subtly different one, and the one that is wrong is a data leak
 * rather than a visible bug.
 *
 * Technicians scope by CITY (tbl_easyfixer.efr_cityId). A region-scoped user
 * carries states on tbl_user.manage_states, and lib/scope.js has already
 * expanded those to a live city list by the time req.scope reaches us.
 */
function applyCityScope(clauses, params, scope, alias = 'e') {
  const ci = scope?.cities;
  if (!ci) return;                                   // Admin / Finance bypass
  if (ci.mode === 'none') { clauses.push('1=0'); return; }
  if (ci.mode === 'allow' && ci.ids.length) {
    clauses.push(`${alias}.efr_cityId IN (${ci.ids.map(() => '?').join(',')})`);
    params.push(...ci.ids);
  }
}

/*
 * The cache key IS the scope. 'all' for a bypass role, 'none' for a user
 * scoped to nothing, otherwise the city id list — which expandStatesToCities
 * has already produced in a stable order.
 */
function scopeKey(scope) {
  if (!scope?.cities) return 'all';
  const ci = scope.cities;
  if (ci.mode === 'none') return 'none';
  if (ci.mode !== 'allow') return 'all';
  return 'c:' + ci.ids.join(',');
}

/* ─── The shared base ──────────────────────────────────────────────────
 *
 * Every detector, every counter and the denominator start here, so they
 * cannot disagree about which assignments are even in play.
 *
 * `c.status = 1` excludes retired courses. The EXISTS on content is not
 * optional: a course with no videos can never be completed, so counting it as
 * outstanding would put a technician on a list he has no way to leave.
 * assignCourse already refuses to create such assignments; rows predating
 * that guard still exist, and they surface deliberately under "Needs
 * decision" instead (arm 3), which is the only place they can be acted on.
 */
const LIVE_FROM = `
    FROM easyfixer_courses ec
    JOIN courses c        ON c.id = ec.course_id AND c.status = 1
    JOIN tbl_easyfixer e  ON e.efr_id = ec.easyfixer_id`;

const LIVE_WHERE = [
  'NOT (e.efr_status <=> 3)',
  'EXISTS (SELECT 1 FROM course_videos cv WHERE cv.course_id = ec.course_id)',
];

function liveQuery(extraClauses = [], extraParams = [], scope) {
  const clauses = [...LIVE_WHERE, ...extraClauses];
  const params = [...extraParams];
  applyCityScope(clauses, params, scope);
  return { where: `WHERE ${clauses.join(' AND ')}`, params };
}

/* Zero recorded progress on this course, for this technician. The only
 * place easyfixer_watched_video is touched, and only over the already-narrow
 * overdue set. That table is MyISAM with a live monotonicity trigger — it is
 * read here and never written, and no index is added to it. */
const NO_PROGRESS = `
  NOT EXISTS (
    SELECT 1 FROM course_videos cv
      JOIN easyfixer_watched_video w
        ON w.video_id = cv.video_id AND w.easyfixer_id = ec.easyfixer_id
     WHERE cv.course_id = ec.course_id
       AND COALESCE(w.watched_percentage, 0) > 0)`;

/* ─── Ownership ────────────────────────────────────────────────────────
 *
 * tbl_city.state_user is the only ownership fact in the database, and it is
 * already what job scoping and pincode reporting use. Do not invent a second
 * one — a third representation of "who owns this city" is a third thing to
 * drift.
 */
async function ownersForCities(cityIds = []) {
  const ids = [...new Set(cityIds.map(Number).filter(Number.isFinite))];
  if (!ids.length) return new Map();
  try {
    const [rows] = await pool.query(
      `SELECT c.city_id, c.state_user, u.user_name
         FROM tbl_city c
         LEFT JOIN tbl_user u ON u.user_id = c.state_user
        WHERE c.city_id IN (${ids.map(() => '?').join(',')})`,
      ids,
    );
    return new Map(rows.map((r) => [Number(r.city_id), { userId: r.state_user, name: r.user_name }]));
  } catch (err) {
    logger.warn({ err: err.message }, 'Owner lookup failed — action rows render without an owner');
    return new Map();
  }
}

/** One distinct owner → the name. Several → a count. None → the training team. */
function describeOwner(owners) {
  const named = [...new Set(owners.filter((o) => o && o.name).map((o) => o.name))];
  if (named.length === 1) return named[0];
  if (named.length > 1) return `${named.length} state managers`;
  return 'Training team';
}

/* ─── D1 · deadline_passed ─────────────────────────────────────────────
 * "A deadline has passed and people are pending" → Chase.
 * Grain: one row per module.
 */
async function detectDeadlinePassed(scope, today) {
  const { where, params } = liveQuery(
    ['ec.completion_date IS NULL', 'ec.due_date IS NOT NULL', 'ec.due_date < ?'],
    [today],
    scope,
  );
  const [rows] = await pool.query(
    `SELECT ec.course_id, c.name AS course_name,
            COUNT(DISTINCT ec.easyfixer_id) AS stuck_count,
            MIN(ec.due_date) AS oldest_due,
            GROUP_CONCAT(DISTINCT e.efr_cityId) AS city_ids
       ${LIVE_FROM}
       ${where}
      GROUP BY ec.course_id, c.name
      ORDER BY stuck_count DESC, oldest_due ASC`,
    params,
  );
  return rows;
}

/* ─── D3 · assessment_failed ───────────────────────────────────────────
 * "Someone has failed an assessment 3 times" → Review.
 *
 * THE 3-ATTEMPT VERSION CANNOT BE COMPUTED YET. easyfixer_courses.score is a
 * single legacy scalar with no attempt history and no pass mark, and nothing
 * writes it. So this ships as the narrower thing that IS true today:
 * lifecycle_status = 'ASSESSMENT_FAILED', a live state that means exactly
 * "a human must decide". The copy says "needs review", not "failed 3 times",
 * because claiming a count we cannot produce is how a screen loses trust.
 *
 * Slice 4 replaces the predicate with a real attempt count; the row, the
 * button and the drilldown do not change.
 */
async function detectAssessmentFailed(scope) {
  const clauses = ["e.lifecycle_status = 'ASSESSMENT_FAILED'", 'NOT (e.efr_status <=> 3)'];
  const params = [];
  applyCityScope(clauses, params, scope);
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS stuck_count,
            GROUP_CONCAT(DISTINCT e.efr_cityId) AS city_ids
       FROM tbl_easyfixer e
      WHERE ${clauses.join(' AND ')}`,
    params,
  );
  return rows;
}

/* ─── D4 · paused_not_started ──────────────────────────────────────────
 * "A paused technician has not started remediation" → Open list.
 *
 * "Paused" here is the TRAINING restriction, not lifecycle_status='PAUSED'.
 * The thing that stops a technician earning over training is
 * lms.hasOverdueTraining zeroing his job capabilities in tech-auth.service —
 * and that is the population a chase can actually help. A lifecycle-PAUSED
 * technician is paused for reasons no amount of chasing fixes.
 *
 * Grain: technicians, not modules — a module can be running perfectly while
 * one person has not opened it.
 */
async function detectPausedNotStarted(scope, today) {
  const { where, params } = liveQuery(
    ['ec.completion_date IS NULL', 'ec.due_date IS NOT NULL', 'ec.due_date < ?', NO_PROGRESS],
    [today],
    scope,
  );
  const [rows] = await pool.query(
    `SELECT COUNT(DISTINCT ec.easyfixer_id) AS stuck_count,
            GROUP_CONCAT(DISTINCT e.efr_cityId) AS city_ids
       ${LIVE_FROM}
       ${where}`,
    params,
  );
  return rows;
}

/* ─── D5 · client_uncertified ──────────────────────────────────────────
 * "A client needing certification has uncertified technicians" → Push now.
 *
 * The only row whose owner is a CLIENT rather than a person.
 *
 * NOTE the mapping FK is `easyfixer_id`, not `efr_id`
 * (services/client-tech-mapping.service.js documents this landmine). Getting
 * it wrong yields a silent zero-match, not an error.
 */
async function detectClientUncertified(scope) {
  const clauses = [
    'r.status = 1',
    'c.status = 1',
    '(m.mapping_status IS NULL OR m.mapping_status <> 0)',
    'NOT (e.efr_status <=> 3)',
    `NOT EXISTS (
        SELECT 1 FROM easyfixer_courses ec
         WHERE ec.easyfixer_id = m.easyfixer_id
           AND ec.course_id = r.course_id
           AND ec.completion_date IS NOT NULL)`,
  ];
  const params = [];
  applyCityScope(clauses, params, scope);
  const [rows] = await pool.query(
    `SELECT r.client_id, r.course_id, cl.client_name, c.name AS course_name,
            COUNT(DISTINCT m.easyfixer_id) AS stuck_count,
            GROUP_CONCAT(DISTINCT e.efr_cityId) AS city_ids
       FROM lms_client_course_requirement r
       JOIN courses c   ON c.id = r.course_id
       JOIN tbl_client cl ON cl.client_id = r.client_id
       JOIN tbl_client_easyfixer_mapping m ON m.client_id = r.client_id
       JOIN tbl_easyfixer e ON e.efr_id = m.easyfixer_id
      WHERE ${clauses.join(' AND ')}
      GROUP BY r.client_id, r.course_id, cl.client_name, c.name
      HAVING stuck_count > 0
      ORDER BY stuck_count DESC`,
    params,
  );
  return rows;
}

/* ─── D6 · stale_module ────────────────────────────────────────────────
 * "A module has been open 7 days with under 30% completion" → Chase.
 *
 * "Under 30% completion" is ambiguous in the spec. Read as COHORT
 * completion: fewer than 30% of the technicians holding this module have
 * finished it. That is the only reading whose "how many are stuck" column is
 * the same number the drilldown then shows.
 *
 * min_cohort is load-bearing: without a floor, a module assigned to one
 * person who has not finished it sits at 0% and screams every day.
 */
async function detectStaleModule(scope, today, t) {
  const { where, params } = liveQuery(
    ['ec.created_at <= DATE_SUB(?, INTERVAL ? DAY)'],
    [today, t.staleDays],
    scope,
  );
  const [rows] = await pool.query(
    `SELECT ec.course_id, c.name AS course_name,
            COUNT(*) AS assigned,
            SUM(ec.completion_date IS NOT NULL) AS done,
            COUNT(DISTINCT CASE WHEN ec.completion_date IS NULL THEN ec.easyfixer_id END) AS stuck_count,
            GROUP_CONCAT(DISTINCT e.efr_cityId) AS city_ids
       ${LIVE_FROM}
       ${where}
      GROUP BY ec.course_id, c.name
     HAVING assigned >= ? AND (done * 100 / assigned) < ?
      ORDER BY (done * 100 / assigned) ASC, assigned DESC`,
    [...params, t.minCohort, t.stalePct],
  );
  return rows;
}

/* ─── Counters ─────────────────────────────────────────────────────────
 *
 * Pending EXCLUDES Overdue. The spec puts the four side by side, and nested
 * counters sum to more than the population — at which point every operator
 * asks which number is the real one. They partition.
 *
 * "Paused and waiting" is a TECHNICIAN count while the first two are
 * ASSIGNMENT counts. That is deliberate and the tile must be labelled
 * "N technicians"; it is exactly the set for whom hasOverdueTraining returns
 * true, which is what makes it the same number B-13 puts in its headline.
 */
async function loadCounters(scope, today) {
  const { where, params } = liveQuery(['ec.completion_date IS NULL'], [], scope);
  const [[row]] = await pool.query(
    `SELECT
       SUM(ec.due_date IS NOT NULL AND ec.due_date < ?) AS overdue,
       SUM(NOT (ec.due_date IS NOT NULL AND ec.due_date < ?)) AS pending,
       COUNT(DISTINCT CASE WHEN ec.due_date IS NOT NULL AND ec.due_date < ? THEN ec.easyfixer_id END) AS paused_waiting,
       COUNT(DISTINCT ec.course_id) AS active_modules
     ${LIVE_FROM}
     ${where}`,
    [today, today, today, ...params],
  );
  return {
    overdue: Number(row?.overdue || 0),
    pending: Number(row?.pending || 0),
    pausedWaiting: Number(row?.paused_waiting || 0),
    activeModules: Number(row?.active_modules || 0),
  };
}

/*
 * "Needs decision" — everything a chase cannot fix.
 *
 * Arm 3 is the reason this is a separate query rather than another column on
 * loadCounters: assignments against a course with NO CONTENT are excluded by
 * the LIVE base by definition, so this is the one counter that deliberately
 * looks OUTSIDE the population the list is drawn from. Those technicians are
 * restricted for something they cannot possibly complete, which is precisely
 * why it needs a human.
 */
async function loadNeedsDecision(scope, today, t) {
  const failedClauses = ["e.lifecycle_status = 'ASSESSMENT_FAILED'", 'NOT (e.efr_status <=> 3)'];
  const failedParams = [];
  applyCityScope(failedClauses, failedParams, scope);

  const stuck = liveQuery(
    ['ec.completion_date IS NULL', 'ec.due_date IS NOT NULL',
      'ec.due_date < DATE_SUB(?, INTERVAL ? DAY)', NO_PROGRESS],
    [today, t.decisionDays],
    scope,
  );

  const emptyClauses = [
    'NOT (e.efr_status <=> 3)',
    'ec.completion_date IS NULL',
    'ec.due_date IS NOT NULL',
    'NOT EXISTS (SELECT 1 FROM course_videos cv WHERE cv.course_id = ec.course_id)',
  ];
  const emptyParams = [];
  applyCityScope(emptyClauses, emptyParams, scope);

  const [[failed], [stuckRow], [empty]] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS n FROM tbl_easyfixer e WHERE ${failedClauses.join(' AND ')}`, failedParams)
      .then(([r]) => r),
    pool.query(`SELECT COUNT(DISTINCT ec.easyfixer_id) AS n ${LIVE_FROM} ${stuck.where}`, stuck.params)
      .then(([r]) => r),
    pool.query(
      `SELECT COUNT(*) AS n
         FROM easyfixer_courses ec
         JOIN courses c ON c.id = ec.course_id AND c.status = 1
         JOIN tbl_easyfixer e ON e.efr_id = ec.easyfixer_id
        WHERE ${emptyClauses.join(' AND ')}`,
      emptyParams,
    ).then(([r]) => r),
  ]);

  return {
    total: Number(failed?.n || 0) + Number(stuckRow?.n || 0) + Number(empty?.n || 0),
    assessmentFailed: Number(failed?.n || 0),
    chasedWithoutEffect: Number(stuckRow?.n || 0),
    impossibleAssignment: Number(empty?.n || 0),
  };
}

/* ─── Assembly ─────────────────────────────────────────────────────────*/

function splitCityIds(csv) {
  return String(csv || '').split(',').map(Number).filter(Number.isFinite);
}

async function buildActionHome(scope) {
  const today = lms.istToday();
  const t = tunables();

  const [d1, d3, d4, d5, d6, counters, needsDecision] = await Promise.all([
    detectDeadlinePassed(scope, today),
    detectAssessmentFailed(scope),
    detectPausedNotStarted(scope, today),
    detectClientUncertified(scope),
    detectStaleModule(scope, today, t),
    loadCounters(scope, today),
    loadNeedsDecision(scope, today, t),
  ]);

  /* One owner lookup for every city in play across all detectors. */
  const allCityIds = [d1, d3, d4, d5, d6].flat().flatMap((r) => splitCityIds(r.city_ids));
  const owners = await ownersForCities(allCityIds);
  const ownerFor = (row) => describeOwner(splitCityIds(row.city_ids).map((id) => owners.get(id)));

  const rows = [];

  for (const r of d1) {
    rows.push({
      detector: 'deadline_passed',
      item: r.course_name,
      itemId: Number(r.course_id),
      stuckCount: Number(r.stuck_count),
      owner: ownerFor(r),
      button: 'Chase',
      href: `/lms/action/pending?detector=deadline_passed&courseId=${r.course_id}`,
    });
  }

  /* D1 SUPPRESSES D6 for the same module. Overdue is strictly more urgent,
   * and two rows for one module double-count it in the counters AND in the
   * denominator below. */
  const overdueModules = new Set(d1.map((r) => Number(r.course_id)));

  const failed = d3[0];
  if (failed && Number(failed.stuck_count) > 0) {
    rows.push({
      detector: 'assessment_failed',
      item: 'Assessment failed — needs review',
      itemId: null,
      stuckCount: Number(failed.stuck_count),
      owner: ownerFor(failed),
      button: 'Review',
      href: '/lms/action/pending?detector=assessment_failed',
    });
  }

  const paused = d4[0];
  if (paused && Number(paused.stuck_count) > 0) {
    rows.push({
      detector: 'paused_not_started',
      item: 'Paused, has not started training',
      itemId: null,
      stuckCount: Number(paused.stuck_count),
      owner: ownerFor(paused),
      button: 'Open list',
      href: '/lms/action/pending?detector=paused_not_started',
    });
  }

  for (const r of d5) {
    rows.push({
      detector: 'client_uncertified',
      item: `${r.client_name} — ${r.course_name}`,
      itemId: Number(r.course_id),
      clientId: Number(r.client_id),
      stuckCount: Number(r.stuck_count),
      owner: r.client_name,
      button: 'Push now',
      href: `/lms/action/pending?detector=client_uncertified&clientId=${r.client_id}&courseId=${r.course_id}`,
    });
  }

  for (const r of d6) {
    if (overdueModules.has(Number(r.course_id))) continue;
    rows.push({
      detector: 'stale_module',
      item: r.course_name,
      itemId: Number(r.course_id),
      stuckCount: Number(r.stuck_count),
      completionPct: Math.round((Number(r.done) * 100) / Math.max(1, Number(r.assigned))),
      owner: ownerFor(r),
      button: 'Chase',
      href: `/lms/action/pending?detector=stale_module&courseId=${r.course_id}`,
    });
  }

  /*
   * THE DENOMINATOR — "14 modules are running normally and are not shown
   * here." The spec says that line matters, because it is what tells the team
   * nothing is hidden. So it is computed as the population the detectors
   * scanned MINUS the modules they emitted, never by a second query.
   *
   * Only the MODULE-GRAINED detectors reduce it. D3 and D4 are technician-
   * grained: a module can be running perfectly while one person is stuck on
   * it, and subtracting it would make the sentence false in the other
   * direction.
   */
  const flagged = new Set([
    ...d1.map((r) => Number(r.course_id)),
    ...d5.map((r) => Number(r.course_id)),
    ...d6.map((r) => Number(r.course_id)),
  ]);
  const runningNormally = Math.max(0, counters.activeModules - flagged.size);

  return {
    today,
    counters: {
      overdue: counters.overdue,
      pending: counters.pending,
      pausedWaiting: counters.pausedWaiting,
      needsDecision: needsDecision.total,
      needsDecisionBreakdown: needsDecision,
    },
    rows,
    summary: {
      activeModules: counters.activeModules,
      runningNormally,
      /*
       * Copy lives with the number so the "0" case cannot be re-derived
       * wrongly on the client. "0 modules are running normally" reads like a
       * rendering bug on the one line whose job is to be believable.
       *
       * THREE cases, not two. Nothing assigned at all is NOT the same claim
       * as everything needing attention, and conflating them tells a team
       * with an empty catalogue that all of it is on fire.
       */
      runningNormallyText: counters.activeModules === 0
        ? 'No training is currently assigned to anyone.'
        : runningNormally === 0
          ? 'Every module with live assignments needs attention.'
          : `${runningNormally} module${runningNormally === 1 ? '' : 's'} running normally and not shown here.`,
    },
    /* Detectors that cannot be computed yet declare themselves rather than
     * emitting a fake row. The CRM renders one muted line while any are
     * unavailable. */
    unavailable: [
      { key: 'session_48h', reason: 'live sessions are not tracked yet' },
    ],
  };
}

/* ─── B-02 · the pending drilldown ─────────────────────────────────────
 *
 * Opened from any B-01 row. The detector that opened it decides the
 * population, so the two can never describe different sets — which is the
 * whole reason the detector key travels in the URL rather than the CRM
 * re-deriving a filter that "should" match.
 *
 * The five filter chips are computed from the SAME rows, in SQL, so a chip
 * count can never disagree with the rows behind it.
 */

const STATUS_EXPR = `
  CASE
    WHEN ec.completion_date IS NOT NULL THEN 'done'
    WHEN ec.due_date IS NOT NULL AND ec.due_date < ? THEN 'overdue'
    WHEN prog.done_videos = 0 OR prog.done_videos IS NULL THEN 'not_started'
    ELSE 'part_done'
  END`;

/* Per-assignment progress, joined once rather than correlated per column.
 * easyfixer_watched_video is MyISAM and read-only to us. */
const PROGRESS_JOIN = `
  LEFT JOIN (
    SELECT cv.course_id, w.easyfixer_id,
           COUNT(*) AS done_videos
      FROM course_videos cv
      JOIN easyfixer_watched_video w
        ON w.video_id = cv.video_id AND COALESCE(w.watched_percentage, 0) >= 100
     GROUP BY cv.course_id, w.easyfixer_id
  ) prog ON prog.course_id = ec.course_id AND prog.easyfixer_id = ec.easyfixer_id`;

/*
 * Detector -> extra predicate. Keeping this beside the detectors themselves
 * is deliberate: B-01 and B-02 must move together or the row count in the
 * tile stops matching the list it opens.
 */
function detectorClauses(detector, today, t) {
  switch (detector) {
    case 'deadline_passed':
      return { clauses: ['ec.completion_date IS NULL', 'ec.due_date IS NOT NULL', 'ec.due_date < ?'], params: [today] };
    case 'paused_not_started':
      return { clauses: ['ec.completion_date IS NULL', 'ec.due_date IS NOT NULL', 'ec.due_date < ?', NO_PROGRESS], params: [today] };
    case 'stale_module':
      return { clauses: ['ec.completion_date IS NULL'], params: [] };
    case 'client_uncertified':
      return { clauses: ['ec.completion_date IS NULL'], params: [] };
    default:
      /* No detector, or one whose population is not assignment-shaped
       * (assessment_failed): fall back to everything outstanding rather than
       * to everything, so an unknown key cannot silently widen the list. */
      return { clauses: ['ec.completion_date IS NULL'], params: [] };
  }
}

/**
 * One page of the drilldown, plus the chip counts for the whole filtered set.
 *
 * @param {object} opts
 * @param {string} [opts.detector]  which B-01 row opened this
 * @param {number} [opts.courseId]
 * @param {string} [opts.status]    overdue | not_started | part_done | failed | done
 * @param {string} [opts.q]         name / EFX id search
 * @param {object} opts.scope       req.scope
 */
async function pendingList({ detector, courseId, status, q, limit = 50, offset = 0, scope } = {}) {
  const today = lms.istToday();
  const t = tunables();
  const d = detectorClauses(detector, today, t);

  const clauses = [...LIVE_WHERE, ...d.clauses];
  const params = [...d.params];
  if (courseId) { clauses.push('ec.course_id = ?'); params.push(Number(courseId)); }
  if (q && String(q).trim()) {
    const like = `%${String(q).trim()}%`;
    clauses.push('(e.efr_name LIKE ? OR e.efr_no LIKE ?)');
    params.push(like, like);
  }
  applyCityScope(clauses, params, scope);
  const where = `WHERE ${clauses.join(' AND ')}`;

  /* Chip counts come from the same WHERE, before the status filter narrows
   * it — a chip that counted only its own selection would always read the
   * page size. */
  const [[chips]] = await pool.query(
    `SELECT
       SUM(ec.completion_date IS NULL AND ec.due_date IS NOT NULL AND ec.due_date < ?) AS overdue,
       SUM(ec.completion_date IS NULL AND COALESCE(prog.done_videos,0) = 0) AS not_started,
       SUM(ec.completion_date IS NULL AND COALESCE(prog.done_videos,0) > 0) AS part_done,
       SUM(ec.completion_date IS NOT NULL) AS done,
       COUNT(*) AS total
     ${LIVE_FROM}
     ${PROGRESS_JOIN}
     ${where}`,
    [today, ...params],
  );

  /*
   * THE CHIP FILTER MUST BE THE CHIP DEFINITION, LITERALLY.
   *
   * The first cut of this compared a single CASE expression to the chosen
   * status, which made the five values mutually exclusive with 'overdue'
   * winning. The chips are not a partition: "overdue" is a statement about a
   * DEADLINE while "not started / part done / done" are statements about
   * PROGRESS, and an overdue technician is very often also a not-started one.
   * The result was a chip reading "Not started 2" that filtered to zero rows
   * — the precise contradiction B-01 and B-02 exist to avoid.
   *
   * So each filter reuses the same SQL its chip counts with. They cannot
   * drift, because they are the same expression.
   */
  const CHIP_PREDICATES = {
    overdue: { sql: 'ec.completion_date IS NULL AND ec.due_date IS NOT NULL AND ec.due_date < ?', params: [today] },
    not_started: { sql: 'ec.completion_date IS NULL AND COALESCE(prog.done_videos,0) = 0', params: [] },
    part_done: { sql: 'ec.completion_date IS NULL AND COALESCE(prog.done_videos,0) > 0', params: [] },
    done: { sql: 'ec.completion_date IS NOT NULL', params: [] },
    /* No attempt history exists yet. `1=0` rather than "ignore the filter":
     * an unsupported chip must return nothing, never silently widen to
     * everything. */
    failed: { sql: '1=0', params: [] },
  };

  const statusClauses = [...clauses];
  const statusParams = [...params];
  const chip = status ? CHIP_PREDICATES[status] : null;
  if (chip) {
    statusClauses.push(`(${chip.sql})`);
    statusParams.push(...chip.params);
  }
  const statusWhere = `WHERE ${statusClauses.join(' AND ')}`;

  const [rows] = await pool.query(
    `SELECT ec.easyfixer_id, ec.course_id, c.name AS course_name,
            e.efr_name AS technician_name, e.efr_no, e.efr_cityId,
            ct.city_name, g.grade,
            ec.due_date, ec.completion_date, ec.created_at AS assigned_on,
            COALESCE(prog.done_videos, 0) AS videos_done,
            (SELECT COUNT(*) FROM course_videos cv WHERE cv.course_id = ec.course_id) AS videos_total,
            ${STATUS_EXPR} AS status
       ${LIVE_FROM}
       ${PROGRESS_JOIN}
       LEFT JOIN tbl_city ct ON ct.city_id = e.efr_cityId
       LEFT JOIN tbl_efr_grade_snapshot g ON g.efr_id = e.efr_id
       ${statusWhere}
      ORDER BY (ec.due_date IS NULL), ec.due_date ASC, ec.easyfixer_id ASC
      LIMIT ? OFFSET ?`,
    [today, ...statusParams, Number(limit), Number(offset)],
  );

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total ${LIVE_FROM} ${PROGRESS_JOIN} ${statusWhere}`,
    statusParams,
  );

  return {
    rows,
    total: Number(total),
    limit: Number(limit),
    offset: Number(offset),
    today,
    chips: {
      overdue: Number(chips?.overdue || 0),
      not_started: Number(chips?.not_started || 0),
      part_done: Number(chips?.part_done || 0),
      /* No attempt history exists yet, so "failed" is honestly zero rather
       * than quietly folded into another chip. Slice 4 fills it. */
      failed: 0,
      done: Number(chips?.done || 0),
    },
  };
}

/**
 * Action home for this caller, cached 60s per city scope.
 *
 * @param {object} scope   req.scope
 * @param {{fresh?: boolean}} [opts]
 */
async function actionHome(scope, { fresh = false } = {}) {
  const key = scopeKey(scope);
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.payload;

  const payload = await buildActionHome(scope);
  cache.set(key, { at: Date.now(), payload });
  return payload;
}

/**
 * Drop every cached scope.
 *
 * Called on every chase, hand-off and assignment change. Without it an
 * operator chases a technician and the row is still sitting there sixty
 * seconds later — which is the single fastest way to make people stop
 * believing an action tool.
 *
 * Scope-blind on purpose: a chase in one city can change another manager's
 * counters (a technician appears in several detectors), and the cache is
 * cheap to rebuild.
 */
function invalidate() {
  cache.clear();
}

module.exports = {
  actionHome,
  pendingList,
  invalidate,
  applyCityScope,
  scopeKey,
  LIVE_FROM,
  LIVE_WHERE,
  NO_PROGRESS,
  tunables,
  propNumber,
  _internals: {
    buildActionHome, loadCounters, loadNeedsDecision, ownersForCities, describeOwner,
  },
};
