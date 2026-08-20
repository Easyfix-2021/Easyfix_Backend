const crypto = require('node:crypto');
const logger = require('../logger');

const ACTIVE_PAN_CONSTRAINT = 'uq_easyfixer_active_pan';

/*
 * PAN uniqueness for the mobile identity writer.
 *
 * There is no authoritative PAN UNIQUE index in the current schema. A
 * connection-scoped named lock serialises two technicians submitting the same
 * PAN, then the caller checks for an existing active owner inside its write
 * transaction. PAN values never appear in lock names, logs, or errors.
 */

function normalizePan(value) {
  return String(value ?? '').trim().toUpperCase();
}

let fallbackKey = null;
function lockKeyMaterial() {
  const configured = process.env.PAN_LOCK_SALT
    || process.env.AADHAAR_LOCK_SALT
    || process.env.JWT_SECRET;
  if (configured) return configured;
  if (!fallbackKey) {
    fallbackKey = crypto.randomBytes(32);
    logger.warn('PAN_LOCK_SALT/AADHAAR_LOCK_SALT/JWT_SECRET unset - PAN lock names are process-local');
  }
  return fallbackKey;
}

function activePanLockName(value) {
  return `efr_pan:${crypto
    .createHmac('sha256', lockKeyMaterial())
    .update(normalizePan(value))
    .digest('hex')
    .slice(0, 32)}`;
}

function panConflictError() {
  const error = new Error('This PAN is already registered to another technician');
  error.status = 409;
  error.code = 'PAN_ALREADY_REGISTERED';
  // Retain the existing details.code convention for routes that deliberately
  // translate known 4xx errors before the terminal error handler.
  error.details = { code: 'PAN_ALREADY_REGISTERED' };
  return error;
}

function isPanUniqueViolation(error) {
  if (error?.code !== 'ER_DUP_ENTRY') return false;
  return [error.constraint, error.sqlMessage, error.message]
    .some((value) => String(value || '').includes(ACTIVE_PAN_CONSTRAINT));
}

function scrubPanDuplicateEntry(error, { panBound } = {}) {
  if (error?.code !== 'ER_DUP_ENTRY' || !panBound) return error;
  if (isPanUniqueViolation(error)) return panConflictError();
  const scrubbed = new Error('a database uniqueness constraint rejected this identity write');
  scrubbed.code = 'ER_DUP_ENTRY';
  return scrubbed;
}

async function assertActivePanAvailable(runner, pan, excludeEfrId) {
  const value = normalizePan(pan);
  if (!value) return;
  const [rows] = await runner.query(
    `SELECT 1 AS conflict FROM tbl_easyfixer
      WHERE NOT (efr_status <=> 3)
        AND NULLIF(UPPER(TRIM(pan_card_number)), '') = ?
        AND efr_id <> ?
      LIMIT 1`,
    [value, Number(excludeEfrId) || 0],
  );
  if (rows.length) throw panConflictError();
}

module.exports = {
  ACTIVE_PAN_CONSTRAINT,
  activePanLockName,
  assertActivePanAvailable,
  isPanUniqueViolation,
  normalizePan,
  panConflictError,
  scrubPanDuplicateEntry,
};
