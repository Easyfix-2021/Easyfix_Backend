const { pool } = require('../db');
const logger = require('../logger');
const { OFFER_STATUS } = require('./offer-status');

/*
 * Technician lifecycle — the single mutation/read authority for the v5.1
 * EasyFixer states.  The legacy efr_status bit remains a compatibility and job
 * eligibility projection; lifecycle_status is the richer source of truth once
 * the pending migration is installed.
 *
 * Deployment order is intentionally safe:
 *   - reads probe the schema once (with a short negative TTL) and derive a
 *     lifecycle from legacy columns while the migration is absent;
 *   - new lifecycle writes fail with a clear 503 before touching data;
 *   - the old binary status endpoint retains its legacy fallback in
 *     easyfixer.service.js until the migration is present.
 */

const LIFECYCLE_STATUSES = Object.freeze([
  'NEW',
  'REGISTRATION_INCOMPLETE',
  'TRAINING_PENDING',
  'ASSESSMENT_FAILED',
  'UNDER_VERIFICATION',
  'VERIFICATION_REJECTED',
  'ACTIVE',
  'PAUSED',
  'INACTIVE',
  'REAPPLIED',
  'APPLICATION_REJECTED',
  'BLACKLISTED',
  'DORMANT',
  'UNDER_MASTER',
  'OFFLINE',
  'ON_BENCH',
  'SUSPENDED',
]);

const STATUS_SET = new Set(LIFECYCLE_STATUSES);
const WORK_ENABLED = new Set(['ACTIVE', 'UNDER_MASTER']);
const LEGACY_WORK_BLOCKED = new Set([
  'PAUSED', 'INACTIVE', 'BLACKLISTED', 'DORMANT', 'SUSPENDED',
  'OFFLINE', 'ON_BENCH',
]);
const REAPPLY_FROM = new Set(['INACTIVE', 'DORMANT', 'APPLICATION_REJECTED']);
const REASON_REQUIRED = new Set([
  'ASSESSMENT_FAILED',
  'VERIFICATION_REJECTED',
  'PAUSED',
  'INACTIVE',
  'APPLICATION_REJECTED',
  'BLACKLISTED',
  'DORMANT',
  'SUSPENDED',
]);
const EDIT_REGISTRATION = new Set([
  'NEW',
  'REGISTRATION_INCOMPLETE',
  'TRAINING_PENDING',
  'ASSESSMENT_FAILED',
  'UNDER_VERIFICATION',
  'VERIFICATION_REJECTED',
]);
const ONBOARDING_STATES = new Set([
  'NEW',
  'REGISTRATION_INCOMPLETE',
  'TRAINING_PENDING',
  'ASSESSMENT_FAILED',
  'UNDER_VERIFICATION',
  'VERIFICATION_REJECTED',
  'REAPPLIED',
  'APPLICATION_REJECTED',
]);
const REAPPLICATION_REENTRY_STATES = new Set([
  'NEW',
  'REGISTRATION_INCOMPLETE',
  'TRAINING_PENDING',
  'ASSESSMENT_FAILED',
  'UNDER_VERIFICATION',
  'VERIFICATION_REJECTED',
  'APPLICATION_REJECTED',
]);
const REAPPLIED_CRM_TARGETS = new Set([
  'REGISTRATION_INCOMPLETE',
  'APPLICATION_REJECTED',
]);
const REAPPLICATION_SUMMARY_STATES = new Set(['INACTIVE', 'DORMANT', 'REAPPLIED']);
const SOURCES = new Set(['CRM', 'CRON', 'APP', 'SYSTEM', 'LEGACY', 'MIGRATION', 'DERIVED']);

// Exactly the six additive columns the migration installs. The scheduled block
// end date reuses tbl_easyfixer.scheduled_reactivation_date and the pause /
// re-application counts derive from tbl_easyfixer_lifecycle_status_log, so
// neither is probed here.
const REQUIRED_COLUMNS = [
  'lifecycle_status',
  'lifecycle_reason_code',
  'lifecycle_reason',
  'lifecycle_changed_at',
  'lifecycle_source',
  'lifecycle_version',
];

const SCHEMA_POSITIVE_TTL_MS = 60 * 60 * 1000;
const SCHEMA_NEGATIVE_TTL_MS = 30 * 1000;
let schemaCache = { value: null, checkedAt: 0, promise: null };

function httpError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  if (details) error.details = details;
  return error;
}

function asBool(value) {
  if (typeof value === 'boolean') return value;
  if (Buffer.isBuffer(value)) return value[0] === 1;
  return Number(value) === 1;
}

function asNullableDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function asNullableDateTime(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  const raw = String(value);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(raw)) {
    const parsed = new Date(`${raw.replace(' ', 'T')}+05:30`);
    return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

function normalizeStatus(value) {
  const status = String(value || '').trim().toUpperCase();
  return STATUS_SET.has(status) ? status : null;
}

function capabilitiesForStatus(status) {
  const active = WORK_ENABLED.has(status);
  const paused = status === 'PAUSED';
  const availabilityOnly = status === 'OFFLINE' || status === 'ON_BENCH';
  const editRegistration = EDIT_REGISTRATION.has(status);
  const reapply = REAPPLY_FROM.has(status);
  return {
    receiveNewJobs: active,
    // A pause/availability change must never strand a job already assigned.
    continueAssignedJobs: active || paused || availabilityOnly,
    mutateAssignedJobs: active || paused || availabilityOnly,
    markAttendance: active || availabilityOnly,
    editRegistration,
    claimMoney: true,
    reapply,
    readOnlyApp: !active && !paused && !availabilityOnly && !editRegistration,
  };
}

function allowedCrmTransitions(status, verified, managerId = 0) {
  if (status === 'REAPPLIED') return [...REAPPLIED_CRM_TARGETS];
  // INACTIVE/DORMANT are (semi-)technician-driven exits: returning to work must
  // go through the reapply → re-verification flow (enforced in assertTransition),
  // so the CRM only offers the administrative moves among the blocked states.
  if (status === 'INACTIVE' || status === 'DORMANT') {
    return ['INACTIVE', 'DORMANT', 'BLACKLISTED'];
  }
  // BLACKLISTED is a pure admin decision, so an admin can FULLY reverse it —
  // it falls through to the operational target set below (verification-filtered),
  // giving Ops the complete range of statuses, not just Inactive/Dormant.
  if (ONBOARDING_STATES.has(status)) {
    return [
      'NEW',
      'REGISTRATION_INCOMPLETE',
      'TRAINING_PENDING',
      'ASSESSMENT_FAILED',
      'UNDER_VERIFICATION',
      'VERIFICATION_REJECTED',
      'APPLICATION_REJECTED',
      'INACTIVE',
      'BLACKLISTED',
    ];
  }
  const targets = [
    'ACTIVE', 'PAUSED', 'INACTIVE', 'BLACKLISTED', 'DORMANT',
    'UNDER_MASTER', 'OFFLINE', 'ON_BENCH', 'SUSPENDED',
  ];
  const verifiedTargets = verified
    ? targets
    : targets.filter((target) => target !== 'ACTIVE' && target !== 'UNDER_MASTER');
  const mappedTarget = Number(managerId || 0) > 0 ? 'UNDER_MASTER' : 'ACTIVE';
  return verifiedTargets.filter((target) => (
    !WORK_ENABLED.has(target) || target === mappedTarget
  ));
}

function deriveLegacyStatus(row = {}) {
  const verified = asBool(row.is_technician_verified);
  const enabled = row.efr_status == null || Number(row.efr_status) !== 0;
  if (verified) {
    if (!enabled) {
      return row.scheduled_reactivation_date ? 'SUSPENDED' : 'INACTIVE';
    }
    return Number(row.efr_manager_id || 0) > 0 ? 'UNDER_MASTER' : 'ACTIVE';
  }

  const personalDecision = row.user_personal_details_filled
    ?? row.personal_details_filled;
  const identityDecision = row.is_identity_details_verified_by_crm
    ?? row.is_identity_details_verified;
  if (Number(identityDecision) === 2) return 'VERIFICATION_REJECTED';
  if (Number(personalDecision) === 2) return 'APPLICATION_REJECTED';
  if (!row.user_id) return 'NEW';

  const personalSubmitted = asBool(
    row.user_is_personal_detail_filled
      ?? row.is_personal_detail_filled
      ?? row.lifecycle_personal_submitted,
  );
  const hasAadhaar = row.lifecycle_aadhaar_present != null
    ? asBool(row.lifecycle_aadhaar_present)
    : (row.adhaar_card_number != null && String(row.adhaar_card_number).trim() !== '');
  const hasPhoto = row.lifecycle_photo_present != null
    ? asBool(row.lifecycle_photo_present)
    : (row.efr_profile_img != null && String(row.efr_profile_img).trim() !== '');
  if (!personalSubmitted || !hasAadhaar || !hasPhoto) {
    return 'REGISTRATION_INCOMPLETE';
  }
  return 'UNDER_VERIFICATION';
}

function lifecycleFromRow(row = {}) {
  const persisted = normalizeStatus(row.lifecycle_status);
  const status = persisted || deriveLegacyStatus(row);
  const verified = asBool(row.is_technician_verified);
  // Persisted lifecycle is authoritative only when its legacy work bit agrees.
  // During pre-migration derivation we preserve the established NULL=enabled
  // compatibility, but a persisted ACTIVE/UNDER_MASTER row must carry exactly
  // efr_status=1 or every server-side work capability fails closed.
  const legacyEnabled = persisted
    ? Number(row.efr_status) === 1
    : (row.efr_status == null || Number(row.efr_status) !== 0);
  const capabilities = capabilitiesForStatus(status);
  capabilities.receiveNewJobs = capabilities.receiveNewJobs
    && verified && legacyEnabled;
  if (persisted && WORK_ENABLED.has(status) && (!verified || !legacyEnabled)) {
    capabilities.continueAssignedJobs = false;
    capabilities.mutateAssignedJobs = false;
    capabilities.markAttendance = false;
  }
  return {
    status,
    reasonCode: persisted ? (row.lifecycle_reason_code || null) : null,
    reason: persisted ? (row.lifecycle_reason || null) : null,
    changedAt: persisted
      ? asNullableDateTime(row.lifecycle_changed_at)
      : asNullableDateTime(row.update_date || row.insert_date),
    // The scheduled block end date is single-sourced from
    // scheduled_reactivation_date (a PAUSED/SUSPENDED transition writes the
    // "until" there); there is no separate lifecycle_until column.
    until: asNullableDate(row.scheduled_reactivation_date),
    version: persisted ? Math.max(0, Number(row.lifecycle_version) || 0) : 0,
    // pause / re-application counts are audit-log-derived. lifecycleFromRow is a
    // pure, synchronous projection used on hot bulk reads, so it never issues a
    // log query: it reports 0 unless a caller that genuinely needs the count has
    // projected it onto the row (e.g. the registered queue), and single-row
    // consumers (getLifecycle) overlay the exact counts from the log.
    pauseCount: persisted ? Math.max(0, Number(row.lifecycle_pause_count) || 0) : 0,
    reapplicationCount: persisted
      ? Math.max(0, Number(row.lifecycle_reapplication_count) || 0)
      : 0,
    // Keep the legacy bit in this decision as a fail-closed drift guard. Every
    // lifecycle transition writes the status and bit atomically, but old tools
    // may still change efr_status directly during the cutover window.
    jobsAllowed: capabilities.receiveNewJobs,
    canReapply: capabilities.reapply,
    canClaimEarnings: true,
    source: persisted ? (row.lifecycle_source || 'SYSTEM') : 'DERIVED',
    capabilities,
    allowedTransitions: allowedCrmTransitions(status, verified, row.efr_manager_id),
  };
}

/**
 * Technician-facing lifecycle projection. CRM reasons normally explain the
 * remediation the technician must complete, but BLACKLISTED notes may contain
 * internal RCA/support detail. Keep the operational status/capabilities while
 * redacting only those two internal fields at the server boundary.
 */
function forTechnician(snapshot = {}) {
  if (snapshot.status !== 'BLACKLISTED') return snapshot;
  return {
    ...snapshot,
    reasonCode: null,
    reason: null,
  };
}

function legacyStatusForTransition(target, currentValue) {
  if (WORK_ENABLED.has(target)) return 1;
  if (LEGACY_WORK_BLOCKED.has(target)) return 0;
  if (currentValue == null) return null;
  return asBool(currentValue) ? 1 : 0;
}

function requiresReapplicationVerificationReset(currentStatus, target) {
  return currentStatus === 'REAPPLIED'
    && REAPPLICATION_REENTRY_STATES.has(target);
}

function gate1FinalizationDecision(currentStatus, gates = {}) {
  const complete = asBool(gates.personal_submitted)
    && String(gates.adhaar_card_number || '').trim() !== ''
    && String(gates.efr_profile_img || '').trim() !== '';
  const canFinalize = currentStatus === 'NEW'
    || currentStatus === 'REGISTRATION_INCOMPLETE'
    || currentStatus === 'VERIFICATION_REJECTED';
  return {
    complete,
    target: complete && canFinalize ? 'UNDER_VERIFICATION' : currentStatus,
    clearIdentityRejection: complete && currentStatus === 'VERIFICATION_REJECTED',
  };
}

function resolveGate1Finalization(currentStatus, gates = {}) {
  if (currentStatus === 'UNDER_VERIFICATION') {
    return {
      complete: true,
      target: 'UNDER_VERIFICATION',
      clearIdentityRejection: false,
      idempotent: true,
    };
  }
  const supported = currentStatus === 'NEW'
    || currentStatus === 'REGISTRATION_INCOMPLETE'
    || currentStatus === 'VERIFICATION_REJECTED';
  if (!supported) {
    throw httpError(409, `registration cannot be finalized from ${currentStatus}`);
  }
  const decision = gate1FinalizationDecision(currentStatus, gates);
  if (!decision.complete) {
    const missing = [];
    if (!asBool(gates.personal_submitted)) missing.push('personal_details_confirmation');
    if (String(gates.adhaar_card_number || '').trim() === '') missing.push('aadhaar_number');
    if (String(gates.efr_profile_img || '').trim() === '') missing.push('profile_image');
    throw httpError(409, 'registration Gate 1 is incomplete', { missing });
  }
  return { ...decision, idempotent: false };
}

function assertFinalActivationEligible(row = {}) {
  if (Number(row.user_personal_details_filled) !== 1
      || Number(row.is_identity_details_verified_by_crm) !== 1
      || Number(row.efr_profile_perc || 0) < 100) {
    throw httpError(
      409,
      'final activation requires accepted lead, approved identity, and complete profile',
    );
  }
}

function assertVerificationActivationSourceAllowed(row = {}) {
  const status = lifecycleFromRow(row).status;
  if (['PAUSED', 'INACTIVE', 'BLACKLISTED', 'DORMANT', 'SUSPENDED', 'OFFLINE', 'ON_BENCH']
    .includes(status)) {
    throw httpError(409, `cannot activate a technician whose lifecycle is ${status}`);
  }
}

function operationalStatusForManager(row = {}) {
  return Number(row.efr_manager_id || 0) > 0 ? 'UNDER_MASTER' : 'ACTIVE';
}

function assertManagerStatusInvariant(target, row = {}) {
  if (WORK_ENABLED.has(target) && target !== operationalStatusForManager(row)) {
    throw httpError(
      409,
      Number(row.efr_manager_id || 0) > 0
        ? 'manager-mapped technician must use UNDER_MASTER'
        : 'technician without a manager mapping must use ACTIVE',
    );
  }
}

function protectsVerificationSync(currentStatus, requestedStatus) {
  return LEGACY_WORK_BLOCKED.has(currentStatus)
    || (currentStatus === 'REAPPLIED' && !requestedStatus);
}

async function probeLifecycleSchema() {
  const [rows] = await pool.query(
    `SELECT
       (SELECT COUNT(*)
          FROM information_schema.columns
         WHERE table_schema = DATABASE()
           AND table_name = 'tbl_easyfixer'
           AND column_name IN (${REQUIRED_COLUMNS.map(() => '?').join(',')})) AS column_count,
       (SELECT COUNT(*)
          FROM information_schema.tables
         WHERE table_schema = DATABASE()
           AND table_name = 'tbl_easyfixer_lifecycle_status_log') AS history_count`,
    REQUIRED_COLUMNS,
  );
  const row = rows[0] || {};
  return Number(row.column_count) === REQUIRED_COLUMNS.length
    && Number(row.history_count) === 1;
}

async function hasLifecycleSchema({ force = false } = {}) {
  const now = Date.now();
  const ttl = schemaCache.value ? SCHEMA_POSITIVE_TTL_MS : SCHEMA_NEGATIVE_TTL_MS;
  if (!force && schemaCache.value !== null && now - schemaCache.checkedAt < ttl) {
    return schemaCache.value;
  }
  if (schemaCache.promise) return schemaCache.promise;
  schemaCache.promise = probeLifecycleSchema()
    .catch((error) => {
      logger.warn({ err: error.message }, 'lifecycle schema probe failed; using legacy-derived reads');
      return false;
    })
    .then((value) => {
      schemaCache.value = value;
      schemaCache.checkedAt = Date.now();
      schemaCache.promise = null;
      return value;
    });
  return schemaCache.promise;
}

function resetSchemaProbeForTests() {
  schemaCache = { value: null, checkedAt: 0, promise: null };
}

async function readProjection(alias = 'e') {
  if (!(await hasLifecycleSchema())) {
    return `NULL AS lifecycle_status,
            NULL AS lifecycle_reason_code,
            NULL AS lifecycle_reason,
            NULL AS lifecycle_changed_at,
            NULL AS lifecycle_source,
            0 AS lifecycle_version`;
  }
  return `${alias}.lifecycle_status,
          ${alias}.lifecycle_reason_code,
          ${alias}.lifecycle_reason,
          ${alias}.lifecycle_changed_at,
          ${alias}.lifecycle_source,
          ${alias}.lifecycle_version`;
}

/**
 * Audit-log-derived pause / re-application counters. These replace the former
 * denormalized lifecycle_pause_count / lifecycle_reapplication_count columns:
 *   pauseCount         = number of transitions INTO PAUSED
 *   reapplicationCount = number of transitions INTO REAPPLIED
 * One indexed set-based read (uq_efr_lifecycle_version / idx_efr_lifecycle_history
 * both lead with efr_id). `executor` is the pool by default, or a transaction
 * connection when the caller already holds the row lock.
 */
async function loadLifecycleCounts(efrId, executor = pool) {
  const [[row]] = await executor.query(
    `SELECT
       COALESCE(SUM(to_status = ?), 0) AS pause_count,
       COALESCE(SUM(to_status = ?), 0) AS reapplication_count
       FROM tbl_easyfixer_lifecycle_status_log
      WHERE efr_id = ?`,
    ['PAUSED', 'REAPPLIED', Number(efrId)],
  );
  return {
    pauseCount: Math.max(0, Number(row?.pause_count) || 0),
    reapplicationCount: Math.max(0, Number(row?.reapplication_count) || 0),
  };
}

async function getLifecycle(efrId) {
  const projection = await readProjection('e');
  const [[row]] = await pool.query(
    `SELECT e.efr_id, e.efr_status, e.is_technician_verified,
            e.efr_manager_id, e.user_id, e.adhaar_card_number,
            e.efr_profile_img, e.is_identity_details_verified_by_crm,
            e.scheduled_reactivation_date, e.insert_date, e.update_date,
            u.personal_details_filled AS user_personal_details_filled,
            u.is_personal_detail_filled AS user_is_personal_detail_filled,
            ${projection}
       FROM tbl_easyfixer e
       LEFT JOIN tbl_user u ON u.user_id = e.user_id
      WHERE e.efr_id = ? AND NOT (e.efr_status <=> 3)
      LIMIT 1`,
    [Number(efrId)],
  );
  if (!row) throw httpError(404, 'easyfixer not found');
  const snapshot = lifecycleFromRow(row);
  // Single-row read: overlay the exact log-derived counters so the API shape
  // (pauseCount / reapplicationCount) is identical to the pre-slimming column.
  if (normalizeStatus(row.lifecycle_status) && (await hasLifecycleSchema())) {
    Object.assign(snapshot, await loadLifecycleCounts(efrId));
  }
  return snapshot;
}

function assertTransition(current, target, input) {
  const source = String(input.source || 'CRM').toUpperCase();
  if (!SOURCES.has(source) || source === 'DERIVED' || source === 'MIGRATION') {
    throw httpError(400, 'invalid lifecycle transition source');
  }
  if (!STATUS_SET.has(target)) throw httpError(400, 'invalid lifecycle status');
  if (target === 'REAPPLIED' && source !== 'APP') {
    throw httpError(409, 'REAPPLIED can only be requested by the technician app');
  }
  if (current.status === 'REAPPLIED' && source !== 'APP') {
    if (source !== 'CRM' || !REAPPLIED_CRM_TARGETS.has(target)) {
      throw httpError(
        409,
        're-application requires CRM admission to REGISTRATION_INCOMPLETE before verification',
      );
    }
  }
  if ((source === 'CRM' || source === 'LEGACY')
      && (current.status === 'INACTIVE' || current.status === 'DORMANT')
      && (WORK_ENABLED.has(target) || ONBOARDING_STATES.has(target))) {
    throw httpError(
      409,
      `${current.status} must reapply through the technician app before registration or activation`,
    );
  }
  const appReapplication = source === 'APP' && target === 'REAPPLIED';
  if (!ONBOARDING_STATES.has(current.status)
      && ONBOARDING_STATES.has(target)
      && !appReapplication) {
    throw httpError(409, `cannot move an operational technician to ${target}`);
  }
  if ((source === 'CRM' || source === 'LEGACY')
      && ONBOARDING_STATES.has(current.status)
      && WORK_ENABLED.has(target)) {
    throw httpError(409, 'onboarding activation must use the verification approval flow');
  }

  const reason = String(input.reason || '').trim();
  if (REASON_REQUIRED.has(target) && !reason) {
    throw httpError(400, `reason is required when setting ${target}`);
  }
  const suppliedUntil = input.until == null ? null : String(input.until);
  if (suppliedUntil && target !== 'PAUSED' && target !== 'SUSPENDED') {
    throw httpError(400, 'until is only allowed for PAUSED or SUSPENDED');
  }
  if (target === 'PAUSED' && suppliedUntil) {
    const todayIst = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' })
      .format(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(suppliedUntil) || suppliedUntil <= todayIst) {
      throw httpError(400, 'PAUSED until must be a future date');
    }
  }
  if (target === 'SUSPENDED') {
    const until = String(input.until || '');
    const todayIst = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' })
      .format(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || until <= todayIst) {
      throw httpError(400, 'SUSPENDED requires a future until date');
    }
  }

  if (source === 'CRON') {
    const autoPause = (current.status === 'ACTIVE' || current.status === 'UNDER_MASTER')
      && (target === 'PAUSED' || target === 'DORMANT');
    const scheduledLift = (current.status === 'PAUSED' || current.status === 'SUSPENDED')
      && (target === 'ACTIVE' || target === 'UNDER_MASTER');
    if (!autoPause && !scheduledLift) {
      throw httpError(409, `cron transition ${current.status} -> ${target} is not allowed`);
    }
    if (target === 'INACTIVE' || target === 'BLACKLISTED') {
      throw httpError(409, `cron cannot set ${target}`);
    }
  }

  if (source === 'APP') {
    if (target !== 'REAPPLIED') {
      throw httpError(409, 'the technician app can only request REAPPLIED');
    }
    if (current.status !== 'REAPPLIED' && !REAPPLY_FROM.has(current.status)) {
      throw httpError(409, `re-application is not allowed from ${current.status}`);
    }
  }
}

function sameLifecycle(current, target, input) {
  const reasonCode = input.reasonCode || null;
  const reason = input.reason ? String(input.reason).trim() : null;
  const until = input.until || null;
  return current.status === target
    && (current.reasonCode || null) === reasonCode
    && (current.reason || null) === reason
    && String(current.until || '').slice(0, 10) === String(until || '').slice(0, 10);
}

async function postCommitPush(efrId, lifecycleStatus, notification = {}) {
  // Lazy require avoids a module cycle: registration-status-push derives the
  // mobile registration gate, which itself consumes this lifecycle service.
  try {
    const push = require('./registration-status-push.service');
    return await push.notifyRegistrationStatusChanged(efrId, {
      lifecycleStatus,
      ...notification,
    });
  } catch (error) {
    logger.warn({ efrId, err: error.message }, 'lifecycle push dispatch failed (non-fatal)');
    return { delivered: false, error: error.message };
  }
}

async function loadAlertSummary(efrId) {
  const [[row]] = await pool.query(
    `SELECT e.efr_id, e.efr_name, e.efr_no, e.efr_email,
            e.efr_service_category, e.efr_service_type,
            e.current_balance, e.inactive_comment, e.last_inactive_date_time,
            c.city_name, gs.grade, gs.completed_jobs
       FROM tbl_easyfixer e
       LEFT JOIN tbl_city c ON c.city_id = e.efr_cityId
       LEFT JOIN tbl_efr_grade_snapshot gs ON gs.efr_id = e.efr_id
      WHERE e.efr_id = ? LIMIT 1`,
    [Number(efrId)],
  );
  return row || null;
}

const MANAGEMENT_ALERT_RECIPIENTS = Object.freeze([
  'management@easyfix.in',
  'supply@easyfix.in',
]);

function managementAlertMessage(summary, {
  kind, lifecycleStatus, reason, amount = null,
}) {
  const isReapplication = kind === 'reapplication';
  const subject = isReapplication
    ? `[EasyFix] Technician re-application · TID ${summary.efr_id}`
    : `[EasyFix] Negative wallet lifecycle alert · TID ${summary.efr_id}`;
  const balance = amount != null && Number.isFinite(Number(amount))
    ? Number(amount)
    : (Number(summary.current_balance) || 0);
  const lines = [
    isReapplication
      ? 'A technician has submitted a re-application for management review.'
      : 'A technician was moved to DORMANT after the configured negative-wallet rule matched.',
    '',
    `Technician ID (old/current TID): ${summary.efr_id}`,
    `Name: ${summary.efr_name || '-'}`,
    `Mobile: ${summary.efr_no || '-'}`,
    `Email: ${summary.efr_email || '-'}`,
    `City: ${summary.city_name || '-'}`,
    `Service: ${summary.efr_service_category || '-'} / ${summary.efr_service_type || '-'}`,
    `Previous performance: grade ${summary.grade || '-'}, completed jobs ${Number(summary.completed_jobs) || 0}`,
    `Wallet balance: ${balance}`,
    `Lifecycle status: ${lifecycleStatus}`,
    `Reason: ${reason || '-'}`,
    `Previous inactive RCA: ${summary.inactive_comment || '-'}`,
    `Previous inactive since: ${summary.last_inactive_date_time || '-'}`,
  ];
  return {
    to: [...MANAGEMENT_ALERT_RECIPIENTS],
    subject,
    text: lines.join('\n'),
  };
}

async function sendManagementAlert(efrId, {
  kind, lifecycleStatus, reason, amount = null,
}) {
  try {
    const summary = await loadAlertSummary(efrId);
    if (!summary) return;
    const message = managementAlertMessage(summary, {
      kind, lifecycleStatus, reason, amount,
    });
    const email = require('./email.service');
    await email.send({
      ...message,
      category: 'transactional',
    });
  } catch (error) {
    logger.warn({ efrId, err: error.message, kind }, 'lifecycle management alert failed (non-fatal)');
  }
}

function managementAlertForTransition(result, input = {}) {
  if (!result?.changed) return null;
  const source = String(input.source || 'CRM').toUpperCase();
  if (source === 'APP'
      && result.lifecycle?.status === 'REAPPLIED'
      && result.transitionedFrom !== 'REAPPLIED') {
    return {
      kind: 'reapplication',
      lifecycleStatus: result.lifecycle.status,
      reason: result.lifecycle.reason,
    };
  }
  if (source === 'CRON'
      && result.lifecycle?.status === 'DORMANT'
      && result.lifecycle?.reasonCode === 'WALLET_BELOW_ZERO'
      && result.transitionedFrom !== 'DORMANT') {
    return {
      kind: 'negative-wallet',
      lifecycleStatus: result.lifecycle.status,
      reason: result.lifecycle.reason,
      amount: Number(input.metadata?.walletBalance),
    };
  }
  return null;
}

async function postCommitSideEffects(efrId, result, input) {
  const reapplicationApproved = result.transitionedFrom === 'REAPPLIED'
    && result.lifecycle.status === 'REGISTRATION_INCOMPLETE';
  const effects = [postCommitPush(efrId, result.lifecycle.status, reapplicationApproved
    ? {
      title: 'Re-application approved',
      body: 'Review and confirm your prefilled registration details to continue verification.',
      event: 'reapplication_approved',
    }
    : {})];
  const managementAlert = managementAlertForTransition(result, input);
  if (managementAlert) effects.push(sendManagementAlert(efrId, managementAlert));
  await Promise.allSettled(effects);
}

/**
 * Close every still-open offer when a technician enters a lifecycle state that
 * cannot receive new jobs. This runs on the caller's existing transaction and
 * after the technician row is locked, so an offer/accept race cannot survive a
 * committed restriction. Missing offer-table deployments remain compatible.
 */
async function expireOpenOffersForRestrictedLifecycle(conn, efrId) {
  try {
    const [result] = await conn.query(
      `UPDATE tbl_job_offer
          SET offer_status = ?,
              responded_at = COALESCE(responded_at, NOW())
        WHERE fk_easyfixter_id = ?
          AND offer_status = ?`,
      [OFFER_STATUS.EXPIRED, Number(efrId), OFFER_STATUS.OFFERED],
    );
    return Number(result?.affectedRows) || 0;
  } catch (error) {
    if (error?.code === 'ER_NO_SUCH_TABLE') return 0;
    throw error;
  }
}

async function transition(efrId, input = {}, actor = null) {
  if (!(await hasLifecycleSchema())) {
    throw httpError(
      503,
      'technician lifecycle schema is not installed; apply the pending lifecycle migration first',
    );
  }

  const id = Number(efrId);
  let target = normalizeStatus(input.status);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'invalid easyfixer id');
  if (!target && typeof input._resolveStatus !== 'function') {
    throw httpError(400, 'invalid lifecycle status');
  }

  const source = String(input.source || 'CRM').toUpperCase();
  const conn = await pool.getConnection();
  let result;
  try {
    await conn.beginTransaction();
    const [[row]] = await conn.query(
      `SELECT e.efr_id, e.efr_status, e.is_technician_verified,
              e.efr_manager_id, e.user_id, e.adhaar_card_number,
              e.efr_profile_img, e.is_identity_details_verified_by_crm,
              e.efr_profile_perc,
              e.scheduled_reactivation_date, e.insert_date, e.update_date,
              e.lifecycle_status, e.lifecycle_reason_code, e.lifecycle_reason,
              e.lifecycle_changed_at, e.lifecycle_version, e.lifecycle_source,
              u.personal_details_filled AS user_personal_details_filled,
              u.is_personal_detail_filled AS user_is_personal_detail_filled
         FROM tbl_easyfixer e
         LEFT JOIN tbl_user u ON u.user_id = e.user_id
        WHERE e.efr_id = ? AND NOT (e.efr_status <=> 3)
        LIMIT 1 FOR UPDATE`,
      [id],
    );
    if (!row) throw httpError(404, 'easyfixer not found');

    const current = lifecycleFromRow(row);
    // Counters are audit-log-derived (the denormalized columns were dropped).
    // Read them once under the row lock we already hold and attach to `current`,
    // so every branch below — the no-op / protected responses and the increment
    // in the mutation branch — reports the exact committed count.
    Object.assign(current, await loadLifecycleCounts(id, conn));
    const storedVersion = Math.max(0, Number(row.lifecycle_version) || 0);
    if (input.expectedVersion != null && Number(input.expectedVersion) !== storedVersion) {
      throw httpError(409, 'lifecycle status changed since it was loaded', {
        expectedVersion: Number(input.expectedVersion),
        currentVersion: storedVersion,
        currentStatus: current.status,
      });
    }
    if (!target && typeof input._resolveStatus === 'function') {
      target = normalizeStatus(await input._resolveStatus(row, current, conn));
    }
    if (!target) throw httpError(400, 'invalid lifecycle status');

    const protectLifecycle = typeof input._protectLifecycle === 'function'
      && input._protectLifecycle(current, target, row) === true;
    if (!protectLifecycle) {
      assertManagerStatusInvariant(target, row);
      assertTransition(current, target, { ...input, source });
    }

    if (protectLifecycle) {
      if (typeof input._beforeUpdate === 'function') {
        await input._beforeUpdate(conn, row);
      }
      await conn.commit();
      result = {
        lifecycle: current,
        changed: false,
        transitionedFrom: current.status,
        protected: true,
        mutationApplied: typeof input._beforeUpdate === 'function',
      };
    } else if (sameLifecycle(current, target, input) && typeof input._beforeUpdate !== 'function') {
      // A same-status transition is also a cheap repair hook. It closes stale
      // offers that may pre-date lifecycle enforcement without manufacturing a
      // new lifecycle version/log row. Use only columns from the base offer
      // migration so this remains safe during rolling migration deployment.
      const expiredOpenOffers = current.capabilities.receiveNewJobs
        ? 0
        : await expireOpenOffersForRestrictedLifecycle(conn, id);
      await conn.commit();
      result = {
        lifecycle: current,
        changed: false,
        transitionedFrom: current.status,
        expiredOpenOffers,
      };
    } else {
      if (WORK_ENABLED.has(target)
          && !asBool(row.is_technician_verified)
          && input._willVerify !== true) {
        throw httpError(409, `${target} requires a verified technician`);
      }

      if (typeof input._beforeUpdate === 'function') {
        await input._beforeUpdate(conn, row);
      }

      const now = new Date();
      const newVersion = storedVersion + 1;
      // current.pauseCount / current.reapplicationCount are the committed
      // log-derived counts read under the row lock above. This transition writes
      // its own log row below, so +1 exactly equals a later COUNT of the log.
      const pauseCount = target === 'PAUSED' && current.status !== 'PAUSED'
        ? Math.min(255, current.pauseCount + 1)
        : current.pauseCount;
      const reapplicationCount = source === 'APP'
        && target === 'REAPPLIED'
        && current.status !== 'REAPPLIED'
        ? Math.min(65535, current.reapplicationCount + 1)
        : current.reapplicationCount;
      const reasonCode = input.reasonCode || null;
      const reason = input.reason ? String(input.reason).trim() : null;
      const until = input.until || null;
      const workEnabled = WORK_ENABLED.has(target);
      const legacyBlocked = LEGACY_WORK_BLOCKED.has(target);
      const resetReapplicationVerification = requiresReapplicationVerificationReset(
        current.status,
        target,
      );
      // Do not turn onboarding/re-application states into the old app's generic
      // "deactivated" wall. Only explicit operational blocks project to 0;
      // ACTIVE/UNDER_MASTER project to 1; every other state preserves the
      // locked row's legacy value during the cutover. Re-application re-entry
      // (including a failed/rejected second-pass outcome) is the exception: it
      // begins a new verification cycle and must remain ineligible for work
      // until a later final SYSTEM activation transaction.
      const nextLegacyStatus = resetReapplicationVerification
        ? 0
        : legacyStatusForTransition(target, row.efr_status);
      const sets = [
        'lifecycle_status = ?',
        'lifecycle_reason_code = ?',
        'lifecycle_reason = ?',
        'lifecycle_changed_at = ?',
        'lifecycle_version = ?',
        'lifecycle_source = ?',
        'efr_status = ?',
        'updated_by = ?',
        'update_date = ?',
      ];
      const params = [
        target, reasonCode, reason, now, newVersion, source,
        nextLegacyStatus, actor?.user_id || null, now,
      ];

      if (resetReapplicationVerification) {
        // NULL is intentional: the Registered Easyfixer queue uses the legacy
        // IS NULL predicate. Preserve all submitted profile/section data so CRM
        // can review it again, but revoke the previous final approval atomically
        // with the lifecycle transition and audit record.
        sets.push(
          'is_technician_verified = NULL',
          'is_personal_details_verified_by_crm = NULL',
          'personal_details_verification_comment_crm = NULL',
          'is_bank_details_verified_by_crm = NULL',
          'bank_details_verification_comment = NULL',
          'is_identity_details_verified_by_crm = NULL',
          'send_back_to_tx_reason_crm = NULL',
        );
        if (target === 'REGISTRATION_INCOMPLETE' && row.user_id) {
          // Force the prefilled confirmation screen to be submitted again.
          // This clears only the completion marker; the profile fields remain
          // intact and are returned by the normal registration/profile reads.
          await conn.query(
            `UPDATE tbl_user
                SET is_personal_detail_filled = 0,
                    personal_details_filled = NULL
              WHERE user_id = ?`,
            [Number(row.user_id)],
          );
        }
      }

      if (workEnabled) {
        sets.push(
          'inactive_reason = NULL',
          'inactive_comment = NULL',
          'scheduled_reactivation_date = NULL',
        );
      } else if (legacyBlocked) {
        sets.push(
          'inactive_reason = NULL',
          'inactive_comment = ?',
          'last_inactive_date_time = ?',
          'scheduled_reactivation_date = ?',
        );
        params.push(reason, now, (target === 'PAUSED' || target === 'SUSPENDED') ? until : null);
      } else {
        // A technician leaving a scheduled block for an onboarding/application
        // state must not remain eligible for the old date-based lift cron.
        sets.push('scheduled_reactivation_date = NULL');
      }
      params.push(id);
      await conn.query(
        `UPDATE tbl_easyfixer SET ${sets.join(', ')} WHERE efr_id = ?`,
        params,
      );

      // Open offers are new-work invitations, not assigned work. Expire them
      // atomically whenever the target state cannot receive new jobs; PAUSED
      // technicians still keep/finish their already-assigned jobs.
      const expiredOpenOffers = workEnabled
        ? 0
        : await expireOpenOffersForRestrictedLifecycle(conn, id);

      const metadata = {
        ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
        // Preserve the scheduled end date in immutable history even after the
        // current row is later lifted and scheduled_reactivation_date is cleared.
        until: until || null,
        expiredOpenOffers,
        actorName: actor?.user_name || actor?.name || null,
      };
      await conn.query(
        `INSERT INTO tbl_easyfixer_lifecycle_status_log
           (efr_id, from_status, to_status, reason_code, reason, source,
            actor_user_id, metadata, status_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, current.status, target, reasonCode, reason, source,
          actor?.user_id || null, JSON.stringify(metadata), newVersion, now,
        ],
      );
      await conn.commit();

      const verifiedAfterTransition = input._willVerify === true
        || (!resetReapplicationVerification && asBool(row.is_technician_verified));

      result = {
        lifecycle: {
          status: target,
          reasonCode,
          reason,
          changedAt: now.toISOString(),
          until: until || null,
          version: newVersion,
          pauseCount,
          reapplicationCount,
          jobsAllowed: workEnabled
            && verifiedAfterTransition
            && nextLegacyStatus !== 0,
          canReapply: REAPPLY_FROM.has(target),
          canClaimEarnings: true,
          source,
          capabilities: {
            ...capabilitiesForStatus(target),
            receiveNewJobs: workEnabled
              && verifiedAfterTransition
              && nextLegacyStatus !== 0,
          },
          allowedTransitions: allowedCrmTransitions(
            target,
            verifiedAfterTransition,
            row.efr_manager_id,
          ),
        },
        changed: true,
        transitionedFrom: current.status,
        expiredOpenOffers,
      };
    }
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }

  if (result.changed) {
    const effects = postCommitSideEffects(id, result, input);
    if (input._awaitPostCommitSideEffects === true) await effects;
    else effects.catch(() => {});
  }
  return result;
}

async function requestReapplication(efrId, { reason } = {}) {
  return transition(
    efrId,
    {
      status: 'REAPPLIED',
      reasonCode: 'TECHNICIAN_REAPPLICATION',
      reason: String(reason || 'Technician requested re-application').trim(),
      source: 'APP',
    },
    null,
  );
}

function assertReapplicationSummaryAllowed(status) {
  if (!REAPPLICATION_SUMMARY_STATES.has(status)) {
    throw httpError(409, 're-application summary is only available before or during re-application');
  }
}

async function getReapplicationSummary(efrId) {
  const current = await getLifecycle(efrId);
  assertReapplicationSummaryAllowed(current.status);
  const [[row]] = await pool.query(
    `SELECT e.efr_id, e.current_balance,
            COALESCE(a.completed_jobs, 0) AS completed_jobs,
            COALESCE(a.lifetime_earnings, 0) AS lifetime_earnings
       FROM tbl_easyfixer e
       LEFT JOIN (
         SELECT j.fk_easyfixter_id,
                COUNT(DISTINCT t.fk_job_id) AS completed_jobs,
                SUM(t.efr_charge) AS lifetime_earnings
           FROM tbl_job j
           JOIN tbl_job_transaction t ON t.fk_job_id = j.job_id
          WHERE j.fk_easyfixter_id = ?
            AND j.job_status IN (3, 5)
          GROUP BY j.fk_easyfixter_id
       ) a ON a.fk_easyfixter_id = e.efr_id
      WHERE e.efr_id = ?
      LIMIT 1`,
    [Number(efrId), Number(efrId)],
  );
  if (!row) throw httpError(404, 'easyfixer not found');
  return {
    efrId: Number(row.efr_id),
    completedJobs: Number(row.completed_jobs) || 0,
    lifetimeEarnings: Number(row.lifetime_earnings) || 0,
    currentBalance: Number(row.current_balance) || 0,
  };
}

async function finalizeMobileRegistrationGate1(efrId) {
  if (!(await hasLifecycleSchema())) {
    return { schemaInstalled: false, changed: false, lifecycle: null };
  }
  let clearIdentityRejection = false;
  const result = await transition(efrId, {
    source: 'SYSTEM',
    reasonCode: 'MOBILE_GATE1_FINALIZED',
    reason: 'Technician confirmed registration details for verification',
    metadata: { mobileGate1Finalization: true },
    _resolveStatus: (row, current) => {
      // transition() already holds the easyfixer/user row lock and selected all
      // three gates; avoid a redundant second SELECT ... FOR UPDATE.
      const decision = resolveGate1Finalization(current.status, {
        personal_submitted: row.user_is_personal_detail_filled,
        adhaar_card_number: row.adhaar_card_number,
        efr_profile_img: row.efr_profile_img,
      });
      clearIdentityRejection = decision.clearIdentityRejection;
      return decision.target;
    },
    _beforeUpdate: async (conn) => {
      if (!clearIdentityRejection) return;
      await conn.query(
        `UPDATE tbl_easyfixer
            SET is_identity_details_verified_by_crm = NULL,
                send_back_to_tx_reason_crm = NULL,
                updated_by = NULL,
                update_date = NOW()
          WHERE efr_id = ?`,
        [Number(efrId)],
      );
    },
    _protectLifecycle: (current, target) => current.status === target,
  }, null);
  return { schemaInstalled: true, ...result };
}

async function activateFromVerification(efrId, body, actor = null) {
  return transition(efrId, {
    reasonCode: 'FINAL_ACTIVATION_APPROVED',
    reason: body.final_accept_comment || 'Technician activation approved',
    source: 'SYSTEM',
    metadata: { verificationSync: true, finalActivation: true },
    _willVerify: true,
    _resolveStatus: (row) => operationalStatusForManager(row),
    _beforeUpdate: async (conn, row) => {
      assertVerificationActivationSourceAllowed(row);
      assertFinalActivationEligible(row);
      await conn.query(
        `UPDATE tbl_easyfixer
            SET final_accept_comment = ?,
                efr_type = COALESCE(?, efr_type),
                is_technician_verified = 1,
                profile_crm_activation_by = ?,
                profile_activation_date_time = NOW(),
                is_eligible_for_offline_orders = COALESCE(?, is_eligible_for_offline_orders)
          WHERE efr_id = ?`,
        [
          body.final_accept_comment || null,
          body.grade || null,
          actor?.user_id || null,
          body.is_eligible_for_offline_orders ?? null,
          Number(efrId),
        ],
      );
    },
  }, actor);
}

async function syncFromVerificationFlags(efrId, {
  status: requestedStatus,
  reasonCode = 'VERIFICATION_STATUS_SYNC',
  reason = 'Registration verification status updated',
} = {}, actor = null) {
  if (!(await hasLifecycleSchema())) {
    return { schemaInstalled: false, changed: false, lifecycle: null };
  }
  const current = await getLifecycle(efrId);
  // Verification owns onboarding states, not post-activation operational
  // restrictions. In particular, no verification save may undo BLACKLISTED.
  if (protectsVerificationSync(current.status, requestedStatus)) {
    return { schemaInstalled: true, changed: false, lifecycle: current, protected: true };
  }
  // REAPPLIED is a management-approval queue. Ordinary lead/identity saves
  // must not derive legacy INACTIVE (the account bit remains 0 while waiting)
  // and silently undo that marker. A CRM lifecycle transition first admits the
  // application back into onboarding; explicit rejection is still allowed.

  let target = normalizeStatus(requestedStatus);
  if (!target) {
    const [[row]] = await pool.query(
      `SELECT e.efr_status, e.is_technician_verified, e.efr_manager_id,
              e.user_id, e.adhaar_card_number, e.efr_profile_img,
              e.is_identity_details_verified_by_crm,
              e.scheduled_reactivation_date, e.insert_date, e.update_date,
              u.personal_details_filled AS user_personal_details_filled,
              u.is_personal_detail_filled AS user_is_personal_detail_filled
         FROM tbl_easyfixer e
         LEFT JOIN tbl_user u ON u.user_id = e.user_id
        WHERE e.efr_id = ? LIMIT 1`,
      [Number(efrId)],
    );
    if (!row) throw httpError(404, 'easyfixer not found');
    target = deriveLegacyStatus(row);
  }

  return {
    schemaInstalled: true,
    ...(await transition(efrId, {
      status: target,
      reasonCode,
      reason,
      source: 'SYSTEM',
      metadata: { verificationSync: true },
    }, actor)),
  };
}

async function syncFromVerificationFlagsAtomic(efrId, {
  status: requestedStatus,
  reasonCode = 'VERIFICATION_STATUS_SYNC',
  reason = 'Registration verification status updated',
  projectedRow = {},
  mutate,
} = {}, actor = null) {
  if (!(await hasLifecycleSchema())) {
    return { schemaInstalled: false, changed: false, lifecycle: null };
  }
  if (typeof mutate !== 'function') {
    throw httpError(500, 'atomic verification sync requires a mutation callback');
  }
  const explicitTarget = normalizeStatus(requestedStatus);
  const result = await transition(efrId, {
    status: explicitTarget || undefined,
    reasonCode,
    reason,
    source: 'SYSTEM',
    metadata: { verificationSync: true, atomicLegacyMutation: true },
    _resolveStatus: explicitTarget
      ? undefined
      : (row) => deriveLegacyStatus({ ...row, ...projectedRow }),
    _beforeUpdate: mutate,
    _protectLifecycle: (current, target) => (
      protectsVerificationSync(current.status, requestedStatus)
      || current.status === target
    ),
  }, actor);
  return { schemaInstalled: true, ...result };
}

function historyItemFromRow(row) {
  let metadata = row.metadata || null;
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata); } catch { metadata = null; }
  }
  return {
    id: Number(row.lifecycle_log_id),
    fromStatus: row.from_status,
    toStatus: row.to_status,
    reasonCode: row.reason_code || null,
    reason: row.reason || null,
    source: row.source,
    actorUserId: row.actor_user_id == null ? null : Number(row.actor_user_id),
    metadata,
    until: metadata && metadata.until ? asNullableDate(metadata.until) : null,
    createdAt: asNullableDateTime(row.created_at),
    version: Number(row.status_version) || 0,
  };
}

async function getHistory(efrId, { limit = 50, offset = 0 } = {}) {
  const id = Number(efrId);
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  if (!(await hasLifecycleSchema())) {
    // Read-safe before migration: the current status endpoint still returns a
    // derived lifecycle; there simply is no persisted history table yet.
    return { items: [], total: 0, limit: safeLimit, offset: safeOffset, schemaInstalled: false };
  }

  const [[exists]] = await pool.query(
    `SELECT 1 AS found FROM tbl_easyfixer
      WHERE efr_id = ? AND NOT (efr_status <=> 3) LIMIT 1`,
    [id],
  );
  if (!exists) throw httpError(404, 'easyfixer not found');

  const [[[{ total }]], [rows]] = await Promise.all([
    pool.query(
      'SELECT COUNT(*) AS total FROM tbl_easyfixer_lifecycle_status_log WHERE efr_id = ?',
      [id],
    ),
    pool.query(
      `SELECT lifecycle_log_id, from_status, to_status, reason_code, reason,
              source, actor_user_id, metadata, status_version, created_at
         FROM tbl_easyfixer_lifecycle_status_log
        WHERE efr_id = ?
        ORDER BY created_at DESC, lifecycle_log_id DESC
        LIMIT ? OFFSET ?`,
      [id, safeLimit, safeOffset],
    ),
  ]);
  return {
    items: rows.map(historyItemFromRow),
    total: Number(total) || 0,
    limit: safeLimit,
    offset: safeOffset,
    schemaInstalled: true,
  };
}

module.exports = {
  LIFECYCLE_STATUSES,
  REAPPLY_FROM,
  capabilitiesForStatus,
  hasLifecycleSchema,
  readProjection,
  lifecycleFromRow,
  forTechnician,
  deriveLegacyStatus,
  operationalStatusForManager,
  getLifecycle,
  transition,
  requestReapplication,
  getReapplicationSummary,
  finalizeMobileRegistrationGate1,
  activateFromVerification,
  syncFromVerificationFlags,
  syncFromVerificationFlagsAtomic,
  getHistory,
  _internals: {
    assertTransition,
    sameLifecycle,
    normalizeStatus,
    capabilitiesForStatus,
    allowedCrmTransitions,
    REAPPLIED_CRM_TARGETS,
    assertReapplicationSummaryAllowed,
    resetSchemaProbeForTests,
    legacyStatusForTransition,
    requiresReapplicationVerificationReset,
    gate1FinalizationDecision,
    resolveGate1Finalization,
    assertFinalActivationEligible,
    assertVerificationActivationSourceAllowed,
    operationalStatusForManager,
    assertManagerStatusInvariant,
    protectsVerificationSync,
    expireOpenOffersForRestrictedLifecycle,
    historyItemFromRow,
    loadLifecycleCounts,
    managementAlertForTransition,
    managementAlertMessage,
    loadAlertSummary,
    sendManagementAlert,
  },
};
