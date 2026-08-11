const { modernError } = require('../utils/response');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const OFFER_ACCEPT_PATH = /^\/jobs\/[^/]+\/accept\/?$/;
const OFFER_REJECT_PATH = /^\/jobs\/[^/]+\/reject\/?$/;

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

/**
 * Parent-router boundary for every /mobile/jobs mutation. Reads remain
 * available so a restricted technician can still inspect already-owned work.
 * Offer accept is a new-work decision. Reject may either decline a pool offer
 * or relinquish a legacy direct assignment, so it accepts either relevant
 * capability. Every other write operates on already-assigned work.
 */
function requireTechJobMutationCapability(req, res, next) {
  if (SAFE_METHODS.has(String(req.method || '').toUpperCase())) return next();
  const path = req.path || req.originalUrl || '';
  if (!path.startsWith('/jobs/')) return next();
  if (OFFER_ACCEPT_PATH.test(path)) return requireNewJobs(req, res, next);
  if (OFFER_REJECT_PATH.test(path)) return requireOfferRejectCapability(req, res, next);
  return requireAssignedJobMutation(req, res, next);
}

module.exports = {
  requireTechCapability,
  requireTechJobMutationCapability,
  _internals: { SAFE_METHODS, OFFER_ACCEPT_PATH, OFFER_REJECT_PATH },
};
