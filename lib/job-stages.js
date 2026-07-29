/*
 * Job Stage Access — pure stage/permission helpers (NO DB access).
 *
 * A "stage" is a named bucket of the job lifecycle, defined by the set of
 * tbl_job.job_status codes VISIBLE in that stage plus the set of statuses a
 * job in that stage may transition TO. Per-user grants (tbl_user_allowed_stages)
 * restrict a user to a subset of these stages:
 *
 *   - VISIBILITY: they only SEE jobs whose current job_status maps to one of
 *     their allowed stages (enforced in job.service list/counts/attention).
 *   - TRANSITIONS: they may only act on a job whose CURRENT stage they own, and
 *     only make the moves that stage declares in `targets` (SOURCE-anchored —
 *     see transitionAllowed for why target-anchored breaks the Booking grant).
 *     Enforced by middleware/require-stage.js at the admin route layer.
 *
 * The permission object shape (mirrored EXACTLY by the frontend):
 *   { mode: 'all',  stages: [] }          → UNRESTRICTED (no rows / default)
 *   { mode: 'list', stages: ['pending-close', ...] }  → restricted
 *   { mode: 'list', stages: [] }          → NO ACCESS (sees nothing, acts on nothing)
 *
 * ⚠ "no rows" and "no access" are DIFFERENT permissions that would otherwise
 * collapse onto the same storage state. Zero rows has to stay UNRESTRICTED so
 * no existing user is locked out when the table lands (no backfill). An admin
 * who explicitly grants zero stages therefore writes ONE sentinel row
 * (stage_key = NO_ACCESS_KEY) — a present row that carries no stage. See
 * parseAllowedRows / parseAllowedInput and user.service reconcileAllowedStages.
 *
 * Admin/Finance always resolve to { mode:'all' } (see lib/scope.js bypassesScope).
 *
 * This module is DB-free and side-effect-free so it is trivially unit-testable
 * and safe to require from both services and middleware.
 *
 * ⚠ CONTRACT: the STAGES map below is a pinned contract shared with the FE.
 * Every visible-status is unique across stages (so status → stage is a
 * 1:1 reverse lookup). If you add/remove a stage or move a status, update the
 * FE mirror in the same change.
 */

// stage_key → { visible: number[] (job_status codes), targets: number[] }
const STAGES = Object.freeze({
  'unconfirmed':        { visible: [9],     targets: [0, 6] },
  'pending-scheduling': { visible: [0],     targets: [1, 6, 9] },
  'pending-start':      { visible: [1],     targets: [2, 20, 21, 6] },
  'pending-close':      { visible: [2, 20], targets: [3, 5, 21, 6] },
  'audit-complete':     { visible: [3, 5],  targets: [10] },
  'pending-feedback':   { visible: [10],    targets: [] },
  'onhold':             { visible: [21],    targets: [1, 6] },
  'estimate-pending':   { visible: [15],    targets: [0, 1, 6] },
  'cancelled':          { visible: [6],     targets: [] },
});

const STAGE_KEYS = Object.freeze(Object.keys(STAGES));

/*
 * Sentinel stage_key meaning "explicitly granted NOTHING". Deliberately not a
 * member of STAGES, so it can never satisfy a visibility or transition check —
 * its only job is to make "no access" storable as a ROW, distinguishing it from
 * the zero-rows default (unrestricted). Never accepted from the API (the Joi
 * schema only admits STAGE_KEYS) and never returned in `stages`.
 */
const NO_ACCESS_KEY = '__none__';

// Human-readable labels — BE-side parity with the FE stage picker. Not
// load-bearing for enforcement (which keys off stage_key), but exported so
// any BE surface that needs to render a stage name has a single source.
const STAGE_LABELS = Object.freeze({
  'unconfirmed':        'Unconfirmed',
  'pending-scheduling': 'Pending Scheduling',
  'pending-start':      'Pending Start',
  'pending-close':      'Pending Close',
  'audit-complete':     'Audit & Complete',
  'pending-feedback':   'Pending Feedback',
  'onhold':             'On Hold',
  'estimate-pending':   'Estimate Pending',
  'cancelled':          'Cancelled',
});

// Reverse index: job_status code → stage_key. Each visible status belongs to
// exactly one stage, so this is unambiguous. Built once at module load.
const STATUS_TO_STAGE = (() => {
  const m = new Map();
  for (const [key, def] of Object.entries(STAGES)) {
    for (const s of def.visible) m.set(Number(s), key);
  }
  return m;
})();

/**
 * stageOfStatus(status) → stage_key | null
 * Maps a job_status code to the (single) stage that renders it. Returns null
 * for statuses that belong to no stage (e.g. 7 ENQUIRY).
 */
function stageOfStatus(status) {
  if (status === null || status === undefined || status === '') return null;
  return STATUS_TO_STAGE.get(Number(status)) || null;
}

/**
 * stageVisibleStatuses(stageKeys) → Set<number>
 * Union of the VISIBLE job_status codes across the given stage keys. Unknown
 * keys are skipped. Empty / non-array input → empty Set.
 */
function stageVisibleStatuses(stageKeys) {
  const set = new Set();
  if (!Array.isArray(stageKeys)) return set;
  for (const key of stageKeys) {
    const def = STAGES[key];
    if (!def) continue;
    for (const s of def.visible) set.add(Number(s));
  }
  return set;
}

/**
 * parseAllowedRows(rows) → { mode, stages }
 * Turns the tbl_user_allowed_stages result set into the permission object.
 * Accepts rows as objects ({ stage_key }) or plain strings. Invalid / unknown
 * keys are dropped and duplicates de-duped.
 *
 *   NO rows at all           → { mode:'all',  stages:[] }  (unrestricted)
 *   only the NO_ACCESS_KEY   → { mode:'list', stages:[] }  (explicit no access)
 *   real stage keys          → { mode:'list', stages:[…] }
 *
 * The sentinel is stripped from `stages` — it is storage, never a grant. If it
 * somehow coexists with real keys, the real keys win (the row set still means
 * "restricted to these").
 */
function parseAllowedRows(rows) {
  const stages = [];
  const seen = new Set();
  let sawSentinel = false;
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const key = typeof r === 'string' ? r : (r && r.stage_key);
    const k = String(key || '').trim();
    if (k === NO_ACCESS_KEY) { sawSentinel = true; continue; }
    if (!k || !STAGES[k] || seen.has(k)) continue;
    seen.add(k);
    stages.push(k);
  }
  if (stages.length === 0 && !sawSentinel) return { mode: 'all', stages: [] };
  return { mode: 'list', stages };
}

/**
 * parseAllowedInput(value) → { mode, stages }
 * The WIRE counterpart of parseAllowedRows: normalises the `allowed_stages`
 * field of a user create/update payload. The distinction that matters:
 *
 *   null / undefined / not-an-array → { mode:'all',  stages:[] }  UNRESTRICTED
 *   []                              → { mode:'list', stages:[] }  NO ACCESS
 *   ['unconfirmed', …]              → { mode:'list', stages:[…] } restricted
 *
 * i.e. an EMPTY ARRAY is an explicit "grant nothing", NOT a shorthand for All —
 * callers that mean All must send null. Unknown keys (and the sentinel) are
 * dropped here as defence-in-depth; the route's Joi schema already rejects
 * anything outside STAGE_KEYS, so an all-garbage array can't arrive in practice.
 */
function parseAllowedInput(value) {
  if (value === null || value === undefined || !Array.isArray(value)) {
    return { mode: 'all', stages: [] };
  }
  const stages = [];
  const seen = new Set();
  for (const v of value) {
    const k = String(v == null ? '' : v).trim();
    if (!k || k === NO_ACCESS_KEY || !STAGES[k] || seen.has(k)) continue;
    seen.add(k);
    stages.push(k);
  }
  return { mode: 'list', stages };
}

/**
 * transitionAllowed(allowed, source, target) → boolean
 * Is a user with the `allowed` permission object permitted to transition a job
 * from `source` status to `target` status?
 *   - mode 'all' (unrestricted / bypass) → always true.
 *   - same-stage no-op (source & target in the SAME stage, e.g. 2→20 within
 *     pending-close) → true; it never removes the job from the user's view.
 *   - otherwise the TARGET status must land in one of the user's allowed stages
 *     ("may only perform status transitions INTO them").
 * A target status that maps to no stage (e.g. 7 ENQUIRY) is never allowed for
 * a restricted user. An explicit NO-ACCESS grant ({mode:'list', stages:[]})
 * owns no source stage, so it falls out of the source check → every transition
 * denied. Same for stageVisible below.
 */
function transitionAllowed(allowed, source, target) {
  if (!allowed || allowed.mode === 'all') return true;
  const allowedSet = new Set(allowed.stages || []);
  const sourceStage = stageOfStatus(source);
  const targetStage = stageOfStatus(target);

  /*
   * The rule is SOURCE-anchored, not target-anchored: the user must OWN the
   * stage the job is in today, and the move must be one that stage declares.
   *
   * This is what makes the canonical example work: a user granted only
   * `unconfirmed` confirms a job 9 → 0. The TARGET (0 → 'pending-scheduling')
   * is deliberately NOT one of their stages — a target-anchored check would
   * 403 the very transition the grant exists to permit. What they own is the
   * SOURCE stage (`unconfirmed`), and `unconfirmed.targets` includes 0, so the
   * hand-off out of their stage is allowed while everything else stays closed.
   *
   * Consequence (intended): owning a stage grants the moves OUT of it that the
   * contract lists — never the right to act on a job sitting in someone else's
   * stage, because the source check fails first.
   */
  if (!sourceStage || !allowedSet.has(sourceStage)) return false;

  // Same-stage no-op (e.g. 2 ↔ 20 inside pending-close) — not a stage change.
  if (targetStage && targetStage === sourceStage) return true;

  return (STAGES[sourceStage].targets || []).includes(Number(target));
}

/**
 * stageVisible(allowed, source) → boolean
 * May a user with `allowed` act on a job currently in `source` status? Used by
 * transitions that don't change status (reschedule): the job's current stage
 * must be one the user is allowed to see. mode 'all' → always true.
 */
function stageVisible(allowed, source) {
  if (!allowed || allowed.mode === 'all') return true;
  const sourceStage = stageOfStatus(source);
  return !!(sourceStage && (allowed.stages || []).includes(sourceStage));
}

module.exports = {
  STAGES,
  STAGE_KEYS,
  STAGE_LABELS,
  NO_ACCESS_KEY,
  stageOfStatus,
  stageVisibleStatuses,
  parseAllowedRows,
  parseAllowedInput,
  transitionAllowed,
  stageVisible,
};
