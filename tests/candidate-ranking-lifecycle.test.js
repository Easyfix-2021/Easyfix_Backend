/*
 * Lifecycle contract for Schedule & Assign candidates.
 *
 * Non-destructive: the fake pool returns an ACTIVE and a PAUSED row even when
 * the SQL predicate says otherwise. That deliberately tests both layers:
 * set-based SQL filtering on the hot path and the zero-I/O JS fail-closed
 * mirror. Search must retain the PAUSED row with a reason and can_offer=false.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const ACTIVE = {
  efr_id: 11,
  efr_name: 'Active Tech',
  efr_no: '9000000011',
  efr_email: 'active@example.test',
  efr_cityId: 5,
  city_name: 'Gurugram',
  current_balance: 1000,
  efr_status: 1,
  is_technician_verified: 1,
  efr_manager_id: null,
  lifecycle_status: 'ACTIVE',
  lifecycle_reason_code: null,
  lifecycle_reason: null,
  lifecycle_version: 3,
};

const PAUSED = {
  ...ACTIVE,
  efr_id: 22,
  efr_name: 'Paused Tech',
  efr_no: '9000000022',
  efr_status: 0,
  lifecycle_status: 'PAUSED',
  lifecycle_reason_code: 'GRADE_BELOW_THRESHOLD',
  lifecycle_reason: 'Quality remediation is required',
};

const INACTIVE = {
  ...PAUSED,
  efr_id: 33,
  efr_name: 'Inactive Tech',
  efr_no: '9000000033',
  lifecycle_status: 'INACTIVE',
  lifecycle_reason_code: null,
  lifecycle_reason: null,
  inactive_comment: 'Inactive after repeated no-shows',
};

const defaults = () => ({ l1Rows: [ACTIVE, PAUSED, INACTIVE] });
const scenario = defaults();

const fake = installFakePool([
  [/FROM information_schema\.columns/i, [{ column_count: 6, history_count: 1 }]],
  [/WHERE NOT \(e\.efr_status <=> 3\)/, [ACTIVE, PAUSED, INACTIVE]],
  [/WHERE e\.efr_id = \? AND NOT \(e\.efr_status <=> 3\)/, [PAUSED]],
  [/FROM tbl_easyfixer e[\s\S]*scheduling_history sh/, () => scenario.l1Rows],
]);

const ranking = require('../services/candidate-ranking.service');

const job = (overrides = {}) => ({
  job_id: 700,
  fk_client_id: 30,
  fk_easyfixter_id: null,
  requested_date_time: null,
  time_slot: null,
  city_id: 5,
  pin_code: null,
  paid_by: 1,
  ...overrides,
});

beforeEach(() => {
  fake.reset();
  Object.assign(scenario, defaults());
});

test('Top 10 uses the shared lifecycle predicate and excludes a restricted row', async () => {
  const result = await ranking.rankCandidatesForJob(700, {
    preloadedJob: job(),
    limit: 10,
  });

  assert.deepEqual(result.candidates.map((row) => row.efr_id), [11]);
  assert.equal(result.candidates[0].lifecycle_status, 'ACTIVE');
  assert.equal(result.candidates[0].can_offer, true);

  const eligibility = fake.calls.find((call) => (
    /FROM tbl_easyfixer e/.test(call.sql) && /scheduling_history sh/.test(call.sql)
  ));
  assert.ok(eligibility, 'the set-based L1 query must be issued');
  assert.match(eligibility.sql, /e\.lifecycle_status IN \('ACTIVE', 'UNDER_MASTER'\)/);
  assert.match(eligibility.sql, /e\.efr_status = 1 AND e\.is_technician_verified = 1/);
});

test('restricted current assignee is pinned only as non-offerable reassignment context', async () => {
  const result = await ranking.rankCandidatesForJob(700, {
    preloadedJob: job({ fk_easyfixter_id: 22, job_status: 1 }),
    limit: 10,
  });
  const [incumbent, ...recommendations] = result.candidates;
  assert.equal(incumbent.efr_id, 22);
  assert.equal(incumbent.is_current, true);
  assert.equal(incumbent.lifecycle_status, 'PAUSED');
  assert.equal(incumbent.can_offer, false);
  assert.ok(recommendations.every((row) => row.can_offer === true),
    'the ranked replacement recommendations remain strictly active/offerable');
});

test('restricted incumbent remains visible when there are zero eligible replacements', async () => {
  scenario.l1Rows = [PAUSED, INACTIVE];
  const result = await ranking.rankCandidatesForJob(700, {
    preloadedJob: job({ fk_easyfixter_id: 22, job_status: 1 }),
    limit: 10,
  });
  assert.equal(result.l1Count, 0);
  assert.equal(result.l2Count, 0);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].efr_id, 22);
  assert.equal(result.candidates[0].is_current, true);
  assert.equal(result.candidates[0].can_offer, false);
});

test('explicit search returns active and restricted rows with authoritative offer metadata', async () => {
  const result = await ranking.searchTechniciansForJob(700, {
    preloadedJob: job(),
    term: 'Tech',
    limit: 250,
  });

  assert.equal(result.candidates.length, 3);
  const active = result.candidates.find((row) => row.efr_id === 11);
  const paused = result.candidates.find((row) => row.efr_id === 22);
  const inactive = result.candidates.find((row) => row.efr_id === 33);
  assert.equal(active.can_offer, true);
  assert.equal(paused.can_offer, false);
  assert.equal(paused.lifecycle_status, 'PAUSED');
  assert.equal(paused.lifecycle_reason_code, 'GRADE_BELOW_THRESHOLD');
  assert.equal(paused.lifecycle_reason, 'Quality remediation is required');
  assert.equal(inactive.can_offer, false);
  assert.equal(inactive.lifecycle_reason, 'Inactive after repeated no-shows');

  const search = fake.calls.find((call) => /WHERE NOT \(e\.efr_status <=> 3\)/.test(call.sql));
  assert.ok(search);
  assert.doesNotMatch(search.sql, /JOIN tbl_user/, 'migrated search must not pay the legacy user join');
  assert.equal(search.params.at(-1), 251, 'search reads only cap+1 rows to detect truncation');
});
