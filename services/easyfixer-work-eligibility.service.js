const lifecycleService = require('./easyfixer-lifecycle.service');

/*
 * One reusable SQL/row projection for the question every job flow asks:
 * "may this technician receive a NEW job?"  The status list is derived from
 * lifecycleService's own capability function so ranking and mutation guards
 * cannot drift when the lifecycle matrix changes.
 */
const RECEIVE_NEW_JOB_STATUSES = Object.freeze(
  lifecycleService.LIFECYCLE_STATUSES.filter((status) => (
    lifecycleService.capabilitiesForStatus(status).receiveNewJobs
  )),
);

function assertAlias(alias) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error('invalid SQL alias for easyfixer work eligibility');
  }
}

async function sqlPredicate(alias = 'e') {
  assertAlias(alias);
  const legacyGate = `${alias}.efr_status = 1 AND ${alias}.is_technician_verified = 1`;
  if (!(await lifecycleService.hasLifecycleSchema())) return legacyGate;
  const statuses = RECEIVE_NEW_JOB_STATUSES.map((status) => `'${status}'`).join(', ');
  return `${alias}.lifecycle_status IN (${statuses}) AND ${legacyGate}`;
}

function fromRow(row) {
  const lifecycle = lifecycleService.lifecycleFromRow(row);
  // Lifecycle is the business policy, while these two legacy columns remain
  // cutover integrity guards. In particular, legacy derivation intentionally
  // tolerates NULL/nonzero status for read compatibility; a write permission
  // must be stricter and match sqlPredicate() exactly so deleted/status-drifted
  // rows can never be assigned by direct ID.
  const legacyEligible = Number(row?.efr_status) === 1
    && Number(row?.is_technician_verified) === 1;
  return {
    lifecycle,
    canOffer: lifecycle.capabilities.receiveNewJobs && legacyEligible,
  };
}

module.exports = {
  RECEIVE_NEW_JOB_STATUSES,
  sqlPredicate,
  fromRow,
};
