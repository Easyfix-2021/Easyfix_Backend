const { modernError } = require('../utils/response');
const { asyncMiddleware } = require('../utils/async-middleware');
const delegation = require('../services/job-share-delegation.service');
const logger = require('../logger');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const OFFER_ACCEPT_PATH = /^\/jobs\/[^/]+\/accept\/?$/;
const OFFER_REJECT_PATH = /^\/jobs\/[^/]+\/reject\/?$/;
/* The job id in a /jobs/<id>… path, and the share sub-surface itself. The
 * share routes are the ONE thing both parties may always reach while a share
 * is live — cancelling, accepting and rejecting are how a share ends. */
const JOB_ID_PATH = /^\/jobs\/(\d+)(?:\/|$)/;
const SHARE_PATH = /^\/jobs\/\d+\/share(?:\/|$)/;

function requireTechCapability(capability) {
  function techCapabilityGuard(req, res, next) {
    const lifecycle = req.tech && req.tech.lifecycle;
    if (lifecycle?.capabilities?.[capability] === true) return next();
    return modernError(
      res,
      403,
      `technician lifecycle ${lifecycle?.status || 'UNKNOWN'} does not allow ${capability}`,
      {
        code: 'TECH_LIFECYCLE_CAPABILITY_REQUIRED',
        capability,
        lifecycleStatus: lifecycle?.status || 'UNKNOWN',
      },
    );
  }
  techCapabilityGuard._techCapability = capability;
  return techCapabilityGuard;
}

const requireNewJobs = requireTechCapability('receiveNewJobs');
const requireAssignedJobMutation = requireTechCapability('mutateAssignedJobs');

function requireOfferRejectCapability(req, res, next) {
  const capabilities = req.tech?.lifecycle?.capabilities || {};
  // Pool rejection does not create work; legacy rejection relinquishes an
  // already-assigned job. PAUSED therefore remains able to reject via its
  // mutateAssignedJobs capability, while accept always requires receiveNewJobs.
  if (capabilities.receiveNewJobs === true || capabilities.mutateAssignedJobs === true) {
    return next();
  }
  return modernError(
    res,
    403,
    `technician lifecycle ${req.tech?.lifecycle?.status || 'UNKNOWN'} does not allow offer rejection`,
    {
      code: 'TECH_LIFECYCLE_CAPABILITY_REQUIRED',
      capabilities: ['receiveNewJobs', 'mutateAssignedJobs'],
      lifecycleStatus: req.tech?.lifecycle?.status || 'UNKNOWN',
    },
  );
}

/* The lifecycle half — unchanged, and still synchronous. */
function applyLifecycleGate(req, res, next) {
  if (SAFE_METHODS.has(String(req.method || '').toUpperCase())) return next();
  const path = req.path || req.originalUrl || '';
  if (!path.startsWith('/jobs/')) return next();
  if (OFFER_ACCEPT_PATH.test(path)) return requireNewJobs(req, res, next);
  if (OFFER_REJECT_PATH.test(path)) return requireOfferRejectCapability(req, res, next);
  return requireAssignedJobMutation(req, res, next);
}

/*
 * ─── THE DELEGATION LOCK ─────────────────────────────────────────────
 *
 * WHY HERE. A live share flips WHO may act on one job, and "who may act" is
 * decided in 15 separate places — `job.fk_easyfixter_id !== req.tech.efr_id`
 * in six route handlers, plus a `fk_easyfixter_id = ?` pin inside every
 * mobile-job-lifecycle mutation. Editing 15 sites leaves the 16th (the one
 * added next month) unlocked by construction. This function is the ONE thing
 * every /jobs request already passes through, so the lock goes here.
 *
 * HOW THE DELEGATE IS LET IN. Not by widening 15 ownership checks, but by
 * answering them differently: for a request the accepted/started delegate
 * makes against THAT job, `req.tech.efr_id` is rewritten to the original
 * technician's id for the rest of the request. Every existing ownership check
 * and every service-layer `fk_easyfixter_id = ?` pin then passes without
 * knowing delegation exists. The real caller stays on `req.tech.actual_efr_id`
 * and `req.jobShare`.
 *
 * ponytail: identity substitution attributes the delegate's writes to the
 * ORIGINAL technician (job comments, fk_checkin_by, fk_checkout_by). That is
 * consistent with the job never changing hands, and the share row records who
 * actually did it. If per-write delegate attribution is ever wanted, the
 * upgrade path is to read `req.tech.actual_efr_id` at the individual write
 * sites — not to undo the substitution.
 *
 * SCOPE. The rewrite applies ONLY to `/jobs/<id>…` requests whose <id> carries
 * a live share the caller is the delegate on. `/jobs` (the list),
 * `/jobs/offered`, and every non-job route are untouched — a delegate must
 * never inherit the original's identity anywhere else.
 *
 * The share sub-surface (`/jobs/<id>/share…`) is exempt from BOTH halves: the
 * cancel/accept/reject routes resolve identity themselves and must see the
 * real caller.
 */
async function applyShareLock(req, res, next) {
  const path = req.path || req.originalUrl || '';
  const match = JOB_ID_PATH.exec(path);

  // A shared-job GUEST (web link) is the delegate by construction: requireTechAuth
  // already resolved it to the sharer's identity and confirmed the share is
  // live, and requireShareGuestScope confined it to this job. Without this
  // branch resolveLock would see the SHARER's efr_id and refuse every write.
  if (req.shareGuest) {
    req.jobShare = req.shareGuest.share;
    if (req.shareGuest.status === 'accepted' && !SAFE_METHODS.has(String(req.method || '').toUpperCase())) {
      try {
        req.jobShare = await delegation.markStarted(req.shareGuest.share);
        req.shareGuest.status = 'started';
      } catch (e) {
        if (e.status === 409) {
          return modernError(res, 409, 'This shared job was just taken back.', { code: 'share_conflict' });
        }
        throw e;
      }
    }
    return applyLifecycleGate(req, res, next);
  }

  const efrId = req.tech && req.tech.efr_id;
  // Not a single-job route, or no identity to compare against (the lifecycle
  // guard's own unit tests call it with a bare `{ lifecycle }` tech).
  if (!match || efrId == null) return applyLifecycleGate(req, res, next);

  const jobId = Number(match[1]);
  const lock = await delegation.resolveLock(jobId, efrId).catch((e) => {
    // A missing table (pre-migration deploy) or a transient read must not turn
    // every job request into a 500 — fail OPEN to the pre-delegation behaviour.
    // Safe by construction: with no share row there is nothing to lock.
    logger.warn(`share lock lookup failed · jobId=${jobId} · ${e.message}`);
    return null;
  });
  if (!lock) return applyLifecycleGate(req, res, next);

  const isShareRoute = SHARE_PATH.test(path);

  if (lock.isDelegate) {
    if ((lock.status === 'accepted' || lock.status === 'started') && !isShareRoute) {
      req.jobShare = lock.share;
      req.tech = { ...req.tech, efr_id: lock.share.fk_easyfixer_id, actual_efr_id: efrId };
      // First mutating touch closes the original's cancel window. Awaited, not
      // fired and forgotten: the original's cancel is a genuine race on another
      // phone, and an off-thread stamp would let both succeed.
      if (lock.status === 'accepted' && !SAFE_METHODS.has(String(req.method || '').toUpperCase())) {
        try {
          req.jobShare = await delegation.markStarted(lock.share);
        } catch (e) {
          if (e.status === 409) {
            // Cancelled/expired between the read and the write — the delegate
            // no longer holds this job.
            return modernError(res, 409, 'This shared job was just taken back.', { code: 'share_conflict' });
          }
          throw e;
        }
      }
    }
    // A `pending` delegate has accepted nothing yet, so he gets no rights on
    // the job beyond the share routes — and those he reaches unsubstituted.
    return applyLifecycleGate(req, res, next);
  }

  if (lock.isSharer) {
    req.jobShare = lock.share;
    // Reads stay open — the original can watch his job being done. Ending the
    // share is the one write he keeps, and only while it has not started; the
    // route enforces the status, this only lets it through.
    if (SAFE_METHODS.has(String(req.method || '').toUpperCase()) || isShareRoute) {
      return applyLifecycleGate(req, res, next);
    }
    if (res.locals) res.locals.logHint = 'job is shared — original technician is read-only';
    logger.info(`Job mutation refused · shared job ${jobId} · efr=${efrId} · shareStatus=${lock.status}`);
    // `code` at BOTH levels on purpose: the modern envelope documents a
    // top-level `code`, every existing gate puts it in `details`, and three
    // repositories are keying off the string. See contract note.
    return res.status(409).json({
      success: false,
      error: lock.status === 'started'
        ? 'This job is being done by the technician you shared it with. You can act on it again once they finish.'
        : 'You have shared this job. Cancel the share to work on it yourself.',
      code: 'job_shared',
      details: { code: 'job_shared', shareStatus: lock.status, canCancel: lock.status !== 'started' },
    });
  }

  // Neither party — a live share is none of their business; the ordinary
  // ownership checks downstream will refuse them anyway.
  return applyLifecycleGate(req, res, next);
}

/**
 * Parent-router boundary for every /mobile/jobs request. Two gates in one
 * middleware, in this order:
 *   1. the DELEGATION LOCK (above) — who may act on this particular job,
 *   2. the LIFECYCLE gate — whether this technician may act at all.
 *
 * Reads remain available so a restricted technician can still inspect
 * already-owned work. Offer accept is a new-work decision. Reject may either
 * decline a pool offer or relinquish a legacy direct assignment, so it accepts
 * either relevant capability. Every other write operates on already-assigned
 * work.
 *
 * Now ASYNC (the lock needs one indexed read). Wrapped in asyncMiddleware so a
 * pool fault returns a 500 instead of exiting the process — see
 * utils/async-middleware.js.
 *
 * The wrapper takes applyShareLock BY NAME, and that is not a style choice:
 * scripts/scan-unguarded-await.js recognises a guard as wrapped only when an
 * Identifier is handed to asyncMiddleware. An inline function that merely
 * CALLS applyShareLock leaves the async function looking unguarded to the
 * gate, which is how this file failed CI on 2026-09-10 despite being safe at
 * runtime. Keep the identifier form.
 */
const requireTechJobMutationCapability = asyncMiddleware(applyShareLock);

module.exports = {
  requireTechCapability,
  requireTechJobMutationCapability,
  _internals: { SAFE_METHODS, OFFER_ACCEPT_PATH, OFFER_REJECT_PATH, JOB_ID_PATH, SHARE_PATH },
};
