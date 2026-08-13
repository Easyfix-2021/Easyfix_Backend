/*
 * Characterization tests for the job_primary_spoc snapshot written during
 * job.service.create.
 *
 * The bug these pin: the column used to be stamped with the JOB OWNER's phone
 * (the CRM operator holding the job) instead of the CLIENT'S VERTICAL HEAD
 * (tbl_vertical_mapping.user_type = 1). Because those are different people by
 * definition, EVERY row was wrong — which is why the strongest assertion here
 * is a negative one: the owner's number must never appear in any statement the
 * stamp issues. A test that only checks "the head's number is stamped" would
 * still pass if the owner's number were stamped somewhere alongside it.
 *
 * stampJobPrimarySpoc is private, so these drive it through create() and read
 * the captured statements. Both column probes are memoised per process, so the
 * probe-absent cases re-require the service with a fresh module-registry entry
 * (same technique as tests/job-offer-state-filter.test.js).
 *
 * Non-destructive: fake pool, no real DB. Runner: `node --test`.
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const CLIENT_ID = 30;
const OWNER_MOBILE = '9000000001'; // the job owner — must NEVER be stamped
const HEAD_MOBILE = '9111111111';  // the client's vertical head — the right answer
const OLDER_HEAD_MOBILE = '9222222222';

const SVC_PATH = '../services/job.service';
const HEAD_LOOKUP = /FROM tbl_vertical_mapping vm/;
const SPOC_UPDATE = /UPDATE tbl_job SET job_primary_spoc/;

const DEFAULTS = () => ({
  hasSpocColumn: true,
  hasInsertedOn: true,
  headRows: [{ mobile_no: HEAD_MOBILE }],
  headLookupThrows: false,
});
const scenario = DEFAULTS();

const fake = installFakePool(
  [
    // Both probes are scenario-driven; every other SHOW COLUMNS degrades to absent.
    [/SHOW COLUMNS FROM tbl_job LIKE 'job_primary_spoc'/, () => (scenario.hasSpocColumn ? [{ Field: 'job_primary_spoc' }] : [])],
    [/SHOW COLUMNS FROM tbl_vertical_mapping LIKE 'inserted_on'/, () => (scenario.hasInsertedOn ? [{ Field: 'inserted_on' }] : [])],
    [/SHOW COLUMNS/i, []],
    [/INFORMATION_SCHEMA/i, [{ n: 0 }]],
    [/SELECT customer_id FROM tbl_customer WHERE customer_id/, [{ customer_id: 7 }]],
    // The head lookup. Ordered before the tbl_user route because its SQL joins
    // tbl_user too and the fake takes the FIRST matching route.
    [HEAD_LOOKUP, () => {
      if (scenario.headLookupThrows) throw new Error('__HEAD_LOOKUP_BOOM__');
      return scenario.headRows;
    }],
    // Any other tbl_user read hands back the OWNER's number, so a regression to
    // the old owner-based lookup would visibly stamp OWNER_MOBILE.
    [/FROM tbl_user\b/, [{ user_id: 9, user_name: 'Owner', user_role: 2, user_status: 1, mobile_no: OWNER_MOBILE }]],
    [/INSERT INTO tbl_job\b/, { insertId: 4242 }],
  ],
  // Sentinel one write PAST the stamp: the stamp is fail-soft and swallows its
  // own errors, so stopping ON it would be swallowed and create would run on.
  { stopOn: /INSERT INTO tbl_job_services/ },
);

let jobSvc = require(SVC_PATH);

function reloadSvc() {
  delete require.cache[require.resolve(SVC_PATH)];
  jobSvc = require(SVC_PATH);
}

const VALID_INPUT = () => ({
  customer: { customer_id: 7 },
  address: { address_id: 55 },
  job_client_owner: 9,   // skip create()'s own SPOC lookup on the same table
  branch_details: 'B1',  // skip the branch-mandatory client.service call
  fk_client_id: CLIENT_ID,
  services: [{ service_id: 1 }], // gives the stop sentinel something to fire on
});

/*
 * Run create() and swallow whatever it throws. The stop sentinel (or a
 * downstream read the fake doesn't stub) is expected to end the call; what the
 * tests assert on is the captured statement stream, not the return value.
 * Returns the error so a test can prove WHICH failure ended the call.
 */
async function runCreate() {
  fake.reset();
  try {
    await jobSvc.create(VALID_INPUT(), { user_id: 9 });
    return null;
  } catch (e) {
    return e;
  }
}

const find = (re) => fake.calls.find((c) => re.test(c.sql));
const stampedValue = () => {
  const u = find(SPOC_UPDATE);
  assert.ok(u, 'the job_primary_spoc UPDATE must be issued');
  return u.params[0];
};
// The bug's fingerprint: the owner's number reaching ANY statement.
const assertOwnerNeverBound = () => {
  const leak = fake.calls.find((c) => (c.params || []).some((p) => p === OWNER_MOBILE));
  assert.equal(leak, undefined, `the job owner's phone must never be bound (leaked in: ${leak && leak.sql})`);
};

beforeEach(() => { fake.reset(); Object.assign(scenario, DEFAULTS()); });

test("the CLIENT'S vertical head is stamped — never the job owner", async () => {
  await runCreate();
  assert.equal(stampedValue(), HEAD_MOBILE, "job_primary_spoc must be the head's phone");
  assertOwnerNeverBound();

  const lookup = find(HEAD_LOOKUP);
  assert.ok(lookup, 'the head must be resolved from tbl_vertical_mapping');
  assert.match(lookup.sql, /vm\.user_type = 1/, 'user_type 1 = Head (2 is Project Manager)');
  assert.deepEqual(lookup.params, [CLIENT_ID], "scoped to the job's client, nothing else");
});

test('several heads on one client → the latest inserted_on wins, via an explicit ORDER BY', async () => {
  // The mapping is per (client, vertical) and a job has no vertical of its own,
  // so there is no per-job tie-break — latest-wins is the deliberate rule, and
  // it has to live in the SQL because only the DB sees the other rows.
  scenario.headRows = [{ mobile_no: HEAD_MOBILE }, { mobile_no: OLDER_HEAD_MOBILE }];
  await runCreate();
  const lookup = find(HEAD_LOOKUP);
  assert.match(lookup.sql, /ORDER BY vm\.inserted_on DESC/, 'latest inserted_on first');
  assert.match(lookup.sql, /LIMIT 1/, 'exactly one head is stamped');
  assert.equal(stampedValue(), HEAD_MOBILE, 'the latest head is the one stamped');
  assertOwnerNeverBound();
});

test('no mapping row → the column is left NULL, NOT filled from the owner', async () => {
  // A wrong number is worse than none: a stale-but-plausible mobile looks right
  // to whoever calls it, so an unresolvable head must degrade to NULL.
  scenario.headRows = [];
  await runCreate();
  assert.equal(stampedValue(), null, 'no head ⇒ NULL');
  assertOwnerNeverBound();
});

test('a failing head lookup never fails the job create', async () => {
  scenario.headLookupThrows = true;
  const err = await runCreate();
  assert.ok(find(/INSERT INTO tbl_job\b/), 'the job row is still written');
  assert.ok(find(/INSERT INTO tbl_job_services/), 'create ran on past the stamp');
  assert.doesNotMatch(String(err && err.message), /__HEAD_LOOKUP_BOOM__/, 'the lookup error must not escape create()');
  assert.equal(find(SPOC_UPDATE), undefined, 'a failed lookup leaves the snapshot untouched');
  assertOwnerNeverBound();
});

/* ─── Probe-absent cases (memoised → need a fresh module registry) ─── */

test('inserted_on absent → deterministic PK fallback, never a bare LIMIT 1', async () => {
  // inserted_on is not written by client-verticals.service.js's INSERTs, so it
  // is a DB default at best. Without it the order must still be fixed: an
  // unordered pick returns a different person on different days, which is
  // indistinguishable from the owner-instead-of-head bug.
  scenario.hasInsertedOn = false;
  reloadSvc();
  await runCreate();
  const lookup = find(HEAD_LOOKUP);
  assert.doesNotMatch(lookup.sql, /inserted_on/, 'the absent column must not be referenced');
  assert.match(lookup.sql, /ORDER BY vm\.id DESC/, 'falls back to the mapping PK, latest first');
  assert.equal(stampedValue(), HEAD_MOBILE);
  assertOwnerNeverBound();
});

test('job_primary_spoc column absent → the whole stamp no-ops (PROD-only column)', async () => {
  scenario.hasSpocColumn = false;
  reloadSvc();
  await runCreate();
  assert.ok(find(/INSERT INTO tbl_job\b/), 'the job is still created');
  assert.equal(find(SPOC_UPDATE), undefined, 'no UPDATE against a column that does not exist');
  assert.equal(find(HEAD_LOOKUP), undefined, 'and no head lookup is paid for either');
});

after(() => {
  // Leave the module registry and the db singleton as we found them.
  delete require.cache[require.resolve(SVC_PATH)];
  fake.restore();
});
