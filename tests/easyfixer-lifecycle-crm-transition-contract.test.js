'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LIFECYCLE_STATUSES,
  _internals,
} = require('../services/easyfixer-lifecycle.service');

const { allowedCrmTransitions } = _internals;

/*
 * The CRM transition contract for a VERIFIED, UNMAPPED technician:
 * allowedCrmTransitions(status, verified=true, managerId=0) with the self status
 * removed (the dialog dropdown filters self, so does the CRM guide port).
 *
 * This is the SOURCE-OF-TRUTH side of the contract. The CRM transition guide
 * (Easyfix_CRM_UI/src/lib/easyfixer-lifecycle-guide.ts) hand-ports this function
 * as crmTransitionTargets(); its test carries a byte-identical EXPECTED table.
 * If this graph ever changes, this test fails first — update the guide + both
 * tables together so Ops documentation cannot silently drift from behaviour.
 */
const EXPECTED = {
  NEW: ['REGISTRATION_INCOMPLETE', 'TRAINING_PENDING', 'ASSESSMENT_FAILED', 'UNDER_VERIFICATION', 'VERIFICATION_REJECTED', 'APPLICATION_REJECTED', 'INACTIVE', 'BLACKLISTED'],
  REGISTRATION_INCOMPLETE: ['NEW', 'TRAINING_PENDING', 'ASSESSMENT_FAILED', 'UNDER_VERIFICATION', 'VERIFICATION_REJECTED', 'APPLICATION_REJECTED', 'INACTIVE', 'BLACKLISTED'],
  TRAINING_PENDING: ['NEW', 'REGISTRATION_INCOMPLETE', 'ASSESSMENT_FAILED', 'UNDER_VERIFICATION', 'VERIFICATION_REJECTED', 'APPLICATION_REJECTED', 'INACTIVE', 'BLACKLISTED'],
  ASSESSMENT_FAILED: ['NEW', 'REGISTRATION_INCOMPLETE', 'TRAINING_PENDING', 'UNDER_VERIFICATION', 'VERIFICATION_REJECTED', 'APPLICATION_REJECTED', 'INACTIVE', 'BLACKLISTED'],
  UNDER_VERIFICATION: ['NEW', 'REGISTRATION_INCOMPLETE', 'TRAINING_PENDING', 'ASSESSMENT_FAILED', 'VERIFICATION_REJECTED', 'APPLICATION_REJECTED', 'INACTIVE', 'BLACKLISTED'],
  VERIFICATION_REJECTED: ['NEW', 'REGISTRATION_INCOMPLETE', 'TRAINING_PENDING', 'ASSESSMENT_FAILED', 'UNDER_VERIFICATION', 'APPLICATION_REJECTED', 'INACTIVE', 'BLACKLISTED'],
  ACTIVE: ['PAUSED', 'INACTIVE', 'BLACKLISTED', 'DORMANT', 'OFFLINE', 'ON_BENCH', 'SUSPENDED'],
  PAUSED: ['ACTIVE', 'INACTIVE', 'BLACKLISTED', 'DORMANT', 'OFFLINE', 'ON_BENCH', 'SUSPENDED'],
  INACTIVE: ['DORMANT', 'BLACKLISTED'],
  REAPPLIED: ['REGISTRATION_INCOMPLETE', 'APPLICATION_REJECTED'],
  APPLICATION_REJECTED: ['NEW', 'REGISTRATION_INCOMPLETE', 'TRAINING_PENDING', 'ASSESSMENT_FAILED', 'UNDER_VERIFICATION', 'VERIFICATION_REJECTED', 'INACTIVE', 'BLACKLISTED'],
  BLACKLISTED: ['ACTIVE', 'PAUSED', 'INACTIVE', 'DORMANT', 'OFFLINE', 'ON_BENCH', 'SUSPENDED'],
  DORMANT: ['INACTIVE', 'BLACKLISTED'],
  UNDER_MASTER: ['ACTIVE', 'PAUSED', 'INACTIVE', 'BLACKLISTED', 'DORMANT', 'OFFLINE', 'ON_BENCH', 'SUSPENDED'],
  OFFLINE: ['ACTIVE', 'PAUSED', 'INACTIVE', 'BLACKLISTED', 'DORMANT', 'ON_BENCH', 'SUSPENDED'],
  ON_BENCH: ['ACTIVE', 'PAUSED', 'INACTIVE', 'BLACKLISTED', 'DORMANT', 'OFFLINE', 'SUSPENDED'],
  SUSPENDED: ['ACTIVE', 'PAUSED', 'INACTIVE', 'BLACKLISTED', 'DORMANT', 'OFFLINE', 'ON_BENCH'],
};

test('allowedCrmTransitions matches the documented CRM transition contract for every status', () => {
  for (const status of LIFECYCLE_STATUSES) {
    const actual = allowedCrmTransitions(status, true, 0).filter((target) => target !== status);
    assert.deepEqual(actual, EXPECTED[status], `allowedCrmTransitions(${status}, true, 0)`);
  }
});

test('the contract covers exactly the canonical lifecycle statuses', () => {
  assert.deepEqual(Object.keys(EXPECTED).sort(), [...LIFECYCLE_STATUSES].sort());
});

test('a manager-mapped verified technician is offered UNDER_MASTER instead of ACTIVE', () => {
  // The common contract above is the unmapped case (mappedTarget = ACTIVE). A
  // manager mapping flips the single work-enabled option to UNDER_MASTER — the
  // guide documents this as the "Active vs Under Master is automatic" rule.
  const mapped = allowedCrmTransitions('BLACKLISTED', true, 501);
  assert.equal(mapped.includes('UNDER_MASTER'), true, 'mapped tech reactivates as UNDER_MASTER');
  assert.equal(mapped.includes('ACTIVE'), false, 'mapped tech is never offered plain ACTIVE');
});

test('an unverified operational technician loses the work-enabled options', () => {
  const unverified = allowedCrmTransitions('BLACKLISTED', false, 0);
  assert.equal(unverified.includes('ACTIVE'), false, 'unverified cannot be set ACTIVE');
  assert.equal(unverified.includes('UNDER_MASTER'), false, 'unverified cannot be set UNDER_MASTER');
  assert.equal(unverified.includes('INACTIVE'), true, 'non-work restrictions remain available');
});
