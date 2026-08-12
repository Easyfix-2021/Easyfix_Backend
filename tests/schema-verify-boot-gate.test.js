'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootWouldFail } = require('../scripts/schema-verify');

/*
 * The 2026-08-12 outage in one sentence: the server refused to boot on a missing
 * hardening invariant AFTER `compose up --force-recreate` had already destroyed
 * the outgoing container, so a schema gap became a total outage instead of a
 * failed deploy.
 *
 * Two guarantees keep that from recurring, and both live in bootWouldFail():
 *   1. Only genuinely boot-stopping conditions stop the boot.
 *   2. The pre-swap deploy gate (schema-verify --boot-check) and server.js call
 *      THIS SAME function, so the gate is a faithful prediction of boot. If they
 *      ever drifted, the pipeline would wave through a release that crash-loops
 *      with no old container left to serve.
 */

const clean = { requiredMismatches: [], invariantMismatches: [] };
const missingColumn = {
  requiredMismatches: [{ table: 'tbl_job', col: 'some_new_column' }],
  invariantMismatches: [],
};
const missingInvariant = {
  requiredMismatches: [],
  invariantMismatches: [
    { table: 'easyfixer_watched_video', col: '<UNIQUE INDEX(easyfixer_id,video_id)>' },
    { table: 'tbl_easyfixer', col: '<UNIQUE INDEX(active_aadhaar_unique)>' },
  ],
};

test('a clean schema always boots', () => {
  assert.equal(bootWouldFail(clean, { strictInvariants: false }), false);
  assert.equal(bootWouldFail(clean, { strictInvariants: true }), false);
});

test('a missing column always blocks the boot, in either mode', () => {
  // The code's own SQL names these, so every request touching them 500s.
  assert.equal(bootWouldFail(missingColumn, { strictInvariants: false }), true);
  assert.equal(bootWouldFail(missingColumn, { strictInvariants: true }), true);
});

test('missing hardening invariants do NOT block the boot by default', () => {
  // This is the outage fix: queries still run, behaviour merely degrades, so a
  // release must never be held hostage to a migration awaiting an Ops decision.
  assert.equal(bootWouldFail(missingInvariant, { strictInvariants: false }), false);
});

test('REQUIRE_SCHEMA_INVARIANTS=true restores fail-closed enforcement', () => {
  assert.equal(bootWouldFail(missingInvariant, { strictInvariants: true }), true);
});

test('strictInvariants defaults to the REQUIRE_SCHEMA_INVARIANTS env var', () => {
  const original = process.env.REQUIRE_SCHEMA_INVARIANTS;
  try {
    delete process.env.REQUIRE_SCHEMA_INVARIANTS;
    assert.equal(bootWouldFail(missingInvariant), false, 'absent env → permissive');

    process.env.REQUIRE_SCHEMA_INVARIANTS = 'true';
    assert.equal(bootWouldFail(missingInvariant), true, 'true → fail closed');

    process.env.REQUIRE_SCHEMA_INVARIANTS = 'TRUE';
    assert.equal(bootWouldFail(missingInvariant), true, 'case-insensitive');

    process.env.REQUIRE_SCHEMA_INVARIANTS = 'false';
    assert.equal(bootWouldFail(missingInvariant), false, 'false → permissive');

    process.env.REQUIRE_SCHEMA_INVARIANTS = '1';
    assert.equal(
      bootWouldFail(missingInvariant),
      false,
      'only the literal string "true" enforces — never guess at truthiness',
    );
  } finally {
    if (original === undefined) delete process.env.REQUIRE_SCHEMA_INVARIANTS;
    else process.env.REQUIRE_SCHEMA_INVARIANTS = original;
  }
});

test('an explicit strictInvariants argument overrides the environment', () => {
  const original = process.env.REQUIRE_SCHEMA_INVARIANTS;
  try {
    process.env.REQUIRE_SCHEMA_INVARIANTS = 'true';
    assert.equal(bootWouldFail(missingInvariant, { strictInvariants: false }), false);
    process.env.REQUIRE_SCHEMA_INVARIANTS = 'false';
    assert.equal(bootWouldFail(missingInvariant, { strictInvariants: true }), true);
  } finally {
    if (original === undefined) delete process.env.REQUIRE_SCHEMA_INVARIANTS;
    else process.env.REQUIRE_SCHEMA_INVARIANTS = original;
  }
});
