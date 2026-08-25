'use strict';

/*
 * services/mobile-registration.service.js::deriveStatus — the precedence that
 * decides which route group the technician app mounts after login.
 *
 * ─── WHY THIS TEST EXISTS ────────────────────────────────────────────────
 *
 * A CRM-ACTIVATED technician whose profile row was missing one Gate-1 field
 * (personal-details flag, Aadhaar, or photo) derived 'personal_pending'. That
 * did NOT bounce the gate router — (registration)/index.tsx already sends an
 * ACTIVE lifecycle to the dashboard. It armed _layout.tsx's `welcomeEligible`,
 * which reads status === 'personal_pending' as "new technician" and whose
 * PostOtpWelcomeModal "Get Started" does
 * router.replace('/(registration)/complete-profile'). So a working technician
 * was walked back through onboarding they had already finished.
 *
 * The rule these cases pin: OPS VERIFICATION GATES JOB OFFERS, NOT THE HOME
 * SCREEN. Data gaps for an activated technician are a dashboard nudge
 * (UnlockChecklist / "Your Profile Is Under Review"), never a wall — and
 * jobsUnlocked still independently requires hasSkills + trainingComplete, so
 * this loosens routing without loosening work access.
 *
 * These must also NOT introduce a new status value: the app maps status
 * through an exhaustive Record, so an unknown member resolves to undefined and
 * breaks the redirect on every build already in the field.
 *
 *   node --test --test-force-exit tests/mobile-registration-derive-status.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { _internals: { deriveStatus } } = require('../services/mobile-registration.service');

/** Only the flags deriveStatus reads; defaults describe a fully-onboarded tech. */
function flags(over = {}) {
  return {
    personalDetailsFilled: 1,
    identityVerifiedByCrm: 1,
    gate1Complete: true,
    isTechnicianVerified: true,
    ...over,
  };
}

const ALLOWED = new Set([
  'not_eligible', 'rejected', 'personal_pending', 'pending_verification', 'active',
]);

test('a CRM-activated technician with an incomplete Gate 1 reaches the app, not registration', () => {
  // The reported case: verified and working, but one profile field missing.
  assert.equal(deriveStatus(flags({ gate1Complete: false })), 'active');
});

test('an UNVERIFIED technician with an incomplete Gate 1 still goes to registration', () => {
  // The guard the original ordering existed to provide — untouched for the
  // population it was written to protect.
  assert.equal(
    deriveStatus(flags({ gate1Complete: false, isTechnicianVerified: false })),
    'personal_pending',
  );
});

test('Gate 1 done but not yet activated is pending_verification — in the app, jobs locked', () => {
  assert.equal(
    deriveStatus(flags({ isTechnicianVerified: false })),
    'pending_verification',
  );
});

test('terminal CRM decisions still outrank everything, activated or not', () => {
  // A denied lead and a rejected identity must not be promoted by the new
  // activation exception.
  assert.equal(deriveStatus(flags({ personalDetailsFilled: 2 })), 'not_eligible');
  assert.equal(deriveStatus(flags({ identityVerifiedByCrm: 2 })), 'rejected');
  assert.equal(
    deriveStatus(flags({ personalDetailsFilled: 2, gate1Complete: false, isTechnicianVerified: true })),
    'not_eligible',
  );
  assert.equal(
    deriveStatus(flags({ identityVerifiedByCrm: 2, gate1Complete: false, isTechnicianVerified: true })),
    'rejected',
  );
});

test('no new status value is ever produced', () => {
  // Exhaustive over the flags deriveStatus reads. The app maps status through
  // an exhaustive Record; an unknown member breaks the redirect on shipped builds.
  for (const personalDetailsFilled of [0, 1, 2]) {
    for (const identityVerifiedByCrm of [0, 1, 2]) {
      for (const gate1Complete of [true, false]) {
        for (const isTechnicianVerified of [true, false]) {
          const out = deriveStatus({
            personalDetailsFilled, identityVerifiedByCrm, gate1Complete, isTechnicianVerified,
          });
          assert.ok(ALLOWED.has(out), `unexpected status ${out}`);
        }
      }
    }
  }
});
