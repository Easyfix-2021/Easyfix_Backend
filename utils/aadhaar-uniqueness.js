const ACTIVE_AADHAAR_CONSTRAINT = 'uq_easyfixer_active_aadhaar';

function isAadhaarUniqueViolation(error) {
  if (error?.code !== 'ER_DUP_ENTRY') return false;
  // mysql2 includes the rejected value in message/sqlMessage. Inspect only for
  // the constraint name; callers must replace the original error before it can
  // reach application logs or an HTTP response.
  return [error.constraint, error.sqlMessage, error.message]
    .some((value) => String(value || '').includes(ACTIVE_AADHAAR_CONSTRAINT));
}

function aadhaarConflictError() {
  const error = new Error('This Aadhaar number is already registered to another technician');
  error.status = 409;
  error.details = { code: 'AADHAAR_ALREADY_REGISTERED' };
  return error;
}

function mapAadhaarUniqueViolation(error) {
  return isAadhaarUniqueViolation(error) ? aadhaarConflictError() : error;
}

module.exports = {
  ACTIVE_AADHAAR_CONSTRAINT,
  aadhaarConflictError,
  isAadhaarUniqueViolation,
  mapAadhaarUniqueViolation,
};
