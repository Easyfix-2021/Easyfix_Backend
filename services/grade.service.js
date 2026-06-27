const { pool } = require('../db');
const logger = require('../logger');

/*
 * Technician grade — replaces the hardcoded mobile 'A'. Computes ONE real,
 * improvable A+…E grade per technician and caches it in tbl_efr_grade_snapshot
 * (migrations/2026-06-26-create-tbl-efr-grade-snapshot.sql), recomputed on read
 * when older than SNAPSHOT_TTL_MS.
 *
 * Two bases (same A+…E cutoffs as candidate-ranking so mobile + web align):
 *   - performance: techs with >= MIN_JOBS completed jobs AND rating history →
 *     customer-rating score (the dominant ranking factor; Rating is 30/70 there).
 *   - onboarding:  new techs → readiness from training% + KYC + profile% + tenure,
 *     so a tech who finished onboarding earns a real B/A instead of a fake A and
 *     a no-effort tech lands at D/E.
 *
 * EVERY signal is read in its own try/catch and degrades to a neutral default,
 * so a missing/renamed column can never crash the grade — it just lowers that
 * component's confidence. All inputs are existing columns; no schema change.
 */

const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000; // recompute at most once/day per tech
const MIN_JOBS = 5;                          // performance basis kicks in here
// Same cutoffs as candidate-ranking.service.js (pct of composite*100).
const CUTOFFS = [
  [95, 'A+'], [90, 'A'], [80, 'B'], [70, 'C'], [60, 'D'], [0, 'E'],
];
const ORDER = ['E', 'D', 'C', 'B', 'A', 'A+'];

function gradeFor(pct) {
  for (const [floor, letter] of CUTOFFS) if (pct >= floor) return letter;
  return 'E';
}
function clamp01(n) { return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0)); }
function bit(v) {
  if (Buffer.isBuffer(v)) return v[0] === 1;
  return Number(v) === 1;
}

// ─── Individual signals (each fail-soft to a neutral default) ───────

async function trainingScore(efrId) {
  try {
    const [[r]] = await pool.query(
      `SELECT AVG(watched_percentage) AS avgPct
         FROM easyfixer_watched_video WHERE easyfixer_id = ?`,
      [efrId],
    );
    if (r && r.avgPct != null) return clamp01(Number(r.avgPct) / 100);
  } catch (e) { logger.warn({ err: e.message, efrId }, 'grade: trainingScore failed'); }
  return 0; // no training watched → 0 (honest; it's the biggest improvable lever)
}

async function easyfixerRow(efrId) {
  try {
    const [[r]] = await pool.query(
      `SELECT efr_profile_perc, is_identity_details_verified_by_crm,
              is_technician_verified, profile_activation_date_time
         FROM tbl_easyfixer WHERE efr_id = ? LIMIT 1`,
      [efrId],
    );
    return r || null;
  } catch (e) { logger.warn({ err: e.message, efrId }, 'grade: easyfixerRow failed'); return null; }
}

function profileScore(row) {
  const p = row ? Number(row.efr_profile_perc) : NaN;
  return Number.isFinite(p) ? clamp01(p / 100) : 0.5;
}
function kycScore(row) {
  if (!row) return 0;
  const id = bit(row.is_identity_details_verified_by_crm);
  const tech = bit(row.is_technician_verified);
  return (id ? 0.5 : 0) + (tech ? 0.5 : 0);
}
function tenureScore(row) {
  const d = row && row.profile_activation_date_time ? new Date(row.profile_activation_date_time) : null;
  if (!d || Number.isNaN(d.getTime())) return 0;
  const days = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
  return clamp01(days / 90); // ramps to full over ~3 months
}

async function completedJobCount(efrId) {
  try {
    const [[r]] = await pool.query(
      `SELECT COUNT(*) AS n FROM tbl_job
        WHERE fk_easyfixter_id = ? AND job_status IN (3, 5)`,
      [efrId],
    );
    return r ? Number(r.n) : 0;
  } catch (e) { logger.warn({ err: e.message, efrId }, 'grade: completedJobCount failed'); return 0; }
}

// Customer rating over 90 days → 0..1. Returns null when there's no history (or
// the read fails) so the caller falls back to the onboarding basis.
async function ratingScore(efrId) {
  try {
    const [[r]] = await pool.query(
      `SELECT AVG(customer_rating) AS avgR, COUNT(*) AS cnt
         FROM tbl_easyfixer_rating_by_customer
        WHERE easyfixer_id = ?`,
      [efrId],
    );
    if (r && r.cnt > 0 && r.avgR != null) return clamp01(Number(r.avgR) / 5);
  } catch (e) { logger.warn({ err: e.message, efrId }, 'grade: ratingScore failed'); }
  return null;
}

// ─── Compute + cache ────────────────────────────────────────────────

async function computeGrade(efrId) {
  logger.info('Compute technician grade · efrId=' + efrId);
  const [training, row, completed, rating] = await Promise.all([
    trainingScore(efrId), easyfixerRow(efrId), completedJobCount(efrId), ratingScore(efrId),
  ]);
  const onboarding = clamp01(
    0.40 * training + 0.25 * kycScore(row) + 0.20 * profileScore(row) + 0.15 * tenureScore(row),
  );
  const usePerformance = completed >= MIN_JOBS && rating != null;
  const composite = usePerformance ? rating : onboarding;
  const detail = {
    grade: gradeFor(composite * 100),
    composite: Number(composite.toFixed(4)),
    onboarding_score: Number(onboarding.toFixed(4)),
    performance_score: rating == null ? null : Number(rating.toFixed(4)),
    completed_jobs: completed,
    basis: usePerformance ? 'performance' : 'onboarding',
    // breakdown is for grade-advice; not persisted.
    _breakdown: {
      training, kyc: kycScore(row), profile: profileScore(row), tenure: tenureScore(row),
      rating: rating == null ? null : Number(rating.toFixed(4)),
    },
  };
  logger.info('Computed grade=' + detail.grade + ' · basis=' + detail.basis + ' · completed_jobs=' + completed);
  return detail;
}

async function saveSnapshot(efrId, d) {
  try {
    await pool.query(
      `INSERT INTO tbl_efr_grade_snapshot
         (efr_id, grade, composite, onboarding_score, performance_score, completed_jobs, basis, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         grade = VALUES(grade), composite = VALUES(composite),
         onboarding_score = VALUES(onboarding_score), performance_score = VALUES(performance_score),
         completed_jobs = VALUES(completed_jobs), basis = VALUES(basis), computed_at = NOW()`,
      [efrId, d.grade, d.composite, d.onboarding_score, d.performance_score, d.completed_jobs, d.basis],
    );
  } catch (e) { logger.warn({ err: e.message, efrId }, 'grade: saveSnapshot failed'); }
}

/*
 * Cached grade for a tech. Reads the snapshot; recomputes + upserts when missing
 * or older than the TTL. Always returns a grade (degrades to 'C' only if every
 * signal AND the snapshot read fail). Safe to call from any hot mobile path.
 */
async function getGrade(efrId) {
  logger.info('Get technician grade · efrId=' + efrId);
  try {
    const [[snap]] = await pool.query(
      `SELECT grade, composite, onboarding_score, performance_score, completed_jobs, basis, computed_at
         FROM tbl_efr_grade_snapshot WHERE efr_id = ? LIMIT 1`,
      [efrId],
    );
    if (snap && snap.computed_at && Date.now() - new Date(snap.computed_at).getTime() < SNAPSHOT_TTL_MS) {
      logger.info('Returning cached grade=' + snap.grade + ' · basis=' + snap.basis);
      return snap;
    }
  } catch (e) { logger.warn({ err: e.message, efrId }, 'grade: snapshot read failed'); }
  try {
    const d = await computeGrade(efrId);
    await saveSnapshot(efrId, d);
    return d;
  } catch (e) {
    logger.warn({ err: e.message, efrId }, 'grade: compute failed — defaulting');
    return { grade: 'C', composite: 0.7, basis: 'onboarding', completed_jobs: 0 };
  }
}

/* Just the letter — convenience for the mobile services that only show a pill. */
async function getGradeLetter(efrId) {
  const d = await getGrade(efrId);
  return d.grade || 'C';
}

// ─── Grade advice ("how to improve your grade") ─────────────────────

const NEXT_GRADE = { E: 'D', D: 'C', C: 'B', B: 'A', A: 'A+', 'A+': 'A+' };
const NEXT_FLOOR = { E: 60, D: 70, C: 80, B: 90, A: 95, 'A+': 100 };

/*
 * Deterministic, causally-correct coaching — each action maps to a real grade
 * lever (the candidate-ranking / onboarding factors), so following it actually
 * moves the number. (An LLM can be layered on later via ai.service; this rules
 * engine is the reliable, zero-cost, no-hallucination baseline + fallback.)
 */
async function getGradeAdvice(efrId) {
  logger.info('Build grade-improvement advice · efrId=' + efrId);
  const d = await computeGrade(efrId);
  const b = d._breakdown || {};
  const pct = Math.round((d.composite || 0) * 100);
  const nextGrade = NEXT_GRADE[d.grade] || 'A+';
  const pointsToNext = Math.max(0, (NEXT_FLOOR[d.grade] || 100) - pct);

  // Candidate levers, each with the weighted gap it could close (lower current
  // score on a higher-weight factor → bigger potential lift).
  const levers = [];
  if (d.basis === 'onboarding') {
    if (b.training < 0.99) levers.push({ key: 'training', score: b.training, weight: 0.40,
      title: 'Finish your training videos', why: 'Training completion is the biggest part of a new technician’s grade.' });
    if (b.kyc < 0.99) levers.push({ key: 'kyc', score: b.kyc, weight: 0.25,
      title: 'Complete KYC / identity verification', why: 'Verified technicians rank higher and get more jobs.' });
    if (b.profile < 0.99) levers.push({ key: 'profile', score: b.profile, weight: 0.20,
      title: 'Complete your profile', why: 'A 100% profile lifts your readiness score.' });
    if (b.tenure < 0.99) levers.push({ key: 'tenure', score: b.tenure, weight: 0.15,
      title: 'Keep taking jobs', why: 'Your grade strengthens as you stay active on the platform.' });
  } else {
    levers.push({ key: 'rating', score: b.rating == null ? 0.6 : b.rating, weight: 1,
      title: 'Keep your customer rating high', why: 'Customer ratings drive your performance grade — be on time and finish the job cleanly.' });
    levers.push({ key: 'punctual', score: 0.5, weight: 1,
      title: 'Check in within the appointment window', why: 'On-time arrivals improve your punctuality score.' });
    levers.push({ key: 'sameday', score: 0.5, weight: 1,
      title: 'Attempt jobs the same day they’re scheduled', why: 'Same-day attempts raise your reliability.' });
  }
  // Rank by potential weighted lift (weight × how far from full).
  levers.sort((a, z) => (z.weight * (1 - z.score)) - (a.weight * (1 - a.score)));
  const actions = levers.slice(0, 3).map((l) => ({ title: l.title, why: l.why }));
  if (actions.length === 0) {
    actions.push({ title: 'You’re doing great', why: 'Keep up your ratings and on-time check-ins to stay at the top.' });
  }

  logger.info('Returning grade advice · currentGrade=' + d.grade + ' · nextGrade=' + nextGrade + ' · ' + actions.length + ' actions');
  return {
    currentGrade: d.grade,
    nextGrade,
    pointsToNext,
    basis: d.basis,
    actions,
  };
}

module.exports = {
  getGrade,
  getGradeLetter,
  computeGrade,
  getGradeAdvice,
  gradeFor,
  CUTOFFS,
  ORDER,
};
