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
const OWNER_USER_ID = 9;        // the CRM operator creating the job — must NEVER be stamped
const HEAD_USER_ID = 4242;      // the client's vertical head — the right answer
const OLDER_HEAD_USER_ID = 777; // a superseded head mapping
const OWNER_MOBILE = '9000000001'; // kept only to prove no phone reaches the column

const SVC_PATH = '../services/job.service';
const HEAD_LOOKUP = /FROM tbl_vertical_mapping vm/;
const SPOC_UPDATE = /UPDATE tbl_job SET job_primary_spoc/;

const DEFAULTS = () => ({
  hasSpocColumn: true,
  hasInsertedOn: true,
  headRows: [{ user_id: HEAD_USER_ID }],
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
    [/FROM tbl_user\b/, [{ user_id: OWNER_USER_ID, user_name: 'Owner', user_role: 2, user_status: 1, mobile_no: OWNER_MOBILE }]],
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
/*
 * The original bug's fingerprint: the owner's PHONE reaching any statement. The
 * owner's user_id cannot be checked the same way — it legitimately appears as
 * job_owner and fk_created_by on the INSERT — so the owner assertion is made
 * against the stamped value specifically, in assertOwnerNotStamped below.
 */
const assertOwnerNeverBound = () => {
  const leak = fake.calls.find((c) => (c.params || []).some((p) => p === OWNER_MOBILE));
  assert.equal(leak, undefined, `the job owner's phone must never be bound (leaked in: ${leak && leak.sql})`);
};
const assertOwnerNotStamped = () => {
  assert.notEqual(stampedValue(), OWNER_USER_ID,
    'the operator holding the job is not the client\'s SPOC — stamping them made the column wrong on every row');
};

beforeEach(() => { fake.reset(); Object.assign(scenario, DEFAULTS()); });

test("the CLIENT'S vertical head is stamped — never the job owner", async () => {
  await runCreate();
  assert.equal(stampedValue(), HEAD_USER_ID, "job_primary_spoc must be the head's user_id");
  assertOwnerNeverBound();
  assertOwnerNotStamped();

  const lookup = find(HEAD_LOOKUP);
  assert.ok(lookup, 'the head must be resolved from tbl_vertical_mapping');
  assert.match(lookup.sql, /vm\.user_type = 1/, 'user_type 1 = Head (2 is Project Manager)');
  assert.deepEqual(lookup.params, [CLIENT_ID], "scoped to the job's client, nothing else");
});

test('several heads on one client → the latest inserted_on wins, via an explicit ORDER BY', async () => {
  // The mapping is per (client, vertical) and a job has no vertical of its own,
  // so there is no per-job tie-break — latest-wins is the deliberate rule, and
  // it has to live in the SQL because only the DB sees the other rows.
  scenario.headRows = [{ user_id: HEAD_USER_ID }, { user_id: OLDER_HEAD_USER_ID }];
  await runCreate();
  const lookup = find(HEAD_LOOKUP);
  assert.match(lookup.sql, /ORDER BY vm\.inserted_on DESC/, 'latest inserted_on first');
  assert.match(lookup.sql, /LIMIT 1/, 'exactly one head is stamped');
  assert.equal(stampedValue(), HEAD_USER_ID, 'the latest head is the one stamped');
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
  assert.equal(stampedValue(), HEAD_USER_ID);
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

test('the stamped value fits the legacy int — a phone number here is a crash', async () => {
  /*
   * THE REGRESSION THIS PINS (2026-08-14). A revision of stampJobPrimarySpoc
   * stamped the head's mobile_no. EasyFix_CRM's Jobs.java:395 declares
   *
   *     @JsonProperty("job_primary_spoc") private int jobPrimarySpoc;
   *
   * and an Indian mobile is 10 digits starting 6-9, i.e. at least 6,000,000,000
   * — every one of them OVERFLOWS Java's int ceiling of 2,147,483,647. So the
   * column did not merely hold the wrong KIND of value; each row was a
   * deserialize failure waiting for the legacy CRM to read that job.
   *
   * Asserting "equals HEAD_USER_ID" alone would not catch a future change that
   * swapped in some other over-long identifier, so this checks the SHAPE the
   * consumer can actually accept.
   */
  // The column-absent test above leaves the module's memoised probe saying
  // "absent"; re-require so this one runs against the default scenario.
  reloadSvc();
  await runCreate();
  const v = stampedValue();

  assert.notEqual(v, null, 'a resolvable head must be stamped');
  const n = Number(v);
  assert.ok(Number.isInteger(n), `job_primary_spoc must be an integer id, got ${JSON.stringify(v)}`);
  assert.ok(n > 0 && n <= 2147483647,
    `job_primary_spoc must fit a Java int (legacy Jobs.java reads it as one); got ${n}`);
  assert.ok(String(v).length < 10,
    'a 10-digit value is a phone number, which is exactly the bug this replaced');
});

/*
 * ── job_owner ON UNATTENDED BOOKINGS ──────────────────────────────────────
 *
 * A website, Website Bot or partner-API booking has no acting CRM operator, so
 * `actor?.user_id` is undefined and job_owner went in NULL — the job landed in
 * nobody's queue. Measured on QA: 173 of 185 'website' jobs, and every
 * 'partner API' and 'integration_v2' row. Operator-placed sources (CRM, manual,
 * excel) already showed zero missing, which is what says this is about the
 * ABSENCE of an actor rather than about the binding being broken.
 *
 * The fallback is the client's Primary SPOC — the same person job_client_owner
 * resolves to, a few lines above in the same function. Source-level because the
 * defect is the ORDER of a `||` chain: any fixture that exercises it would pass
 * against a chain that merely happened to reach the right value.
 */
const SPOC_SRC = require('fs').readFileSync(
  require('path').join(__dirname, '..', 'services/job.service.js'), 'utf8',
);

test('job_owner falls back to the client SPOC, and only AFTER the acting operator', () => {
  assert.match(
    SPOC_SRC,
    /input\.job_owner \|\| actor\?\.user_id \|\| resolvedJobClientOwner \|\| null,/,
    'the precedence must be explicit owner -> acting operator -> client SPOC -> null',
  );
  // The old chain, which dropped straight to null with no actor.
  assert.equal(
    /input\.job_owner \|\| actor\?\.user_id \|\| null,/.test(SPOC_SRC),
    false,
    'an unattended booking would still land in nobody queue',
  );
});

test('job_owner and job_client_owner stay DIFFERENT columns', () => {
  /*
   * The fallback must not be read as merging them. job_owner is the CRM
   * operator holding the job; job_client_owner is the client's SPOC. They
   * coincide only when there was no operator to record — everywhere else the
   * actor wins, which is exactly what the ordering above guarantees.
   */
  assert.match(SPOC_SRC, /resolvedJobClientOwner \?\? null,/,
    'job_client_owner keeps its own independent binding');
});

/*
 * ── ONE SPOC LOOKUP, THREE COLUMNS ────────────────────────────────────────
 *
 * job_primary_spoc, job_client_owner and (unattended) job_owner all name the
 * same person. They were resolved by TWO copies of the lookup that disagreed:
 * the create path ordered `id ASC` — the OLDEST mapping — and read vm.user_id
 * directly; the stamp ordered newest-first through a LEFT JOIN on tbl_user.
 *
 * Measured on QA: 204 clients have a user_type = 1 mapping, none has more than
 * one, and the two orderings disagree on 0 of them. So this is a latent defect,
 * not a live one — which is exactly why it needs a test rather than a bug
 * report. The day a client's SPOC is reassigned, one job would carry the old
 * owner in one column and the new one in another, silently.
 */
test('one resolver feeds every owner column — no second copy of the lookup', () => {
  assert.match(SPOC_SRC, /async function resolveClientPrimarySpoc\(/,
    'the shared lookup must exist');
  // The stamp and the create path both go through it.
  assert.match(SPOC_SRC, /const headUserId = await resolveClientPrimarySpoc\(clientId, db\);/);
  assert.match(SPOC_SRC, /await resolveClientPrimarySpoc\(input\.fk_client_id, conn\)/);
  // And the create path's old private copy is gone.
  assert.equal(
    /ORDER BY id ASC LIMIT 1/.test(SPOC_SRC), false,
    'the OLDEST-mapping ordering must not survive anywhere',
  );
});

test('the shared lookup keeps the LEFT JOIN and the newest-first ordering', () => {
  const body = SPOC_SRC.slice(SPOC_SRC.indexOf('async function resolveClientPrimarySpoc('));
  const fn = body.slice(0, body.indexOf('\n}\n') + 3);
  assert.match(fn, /LEFT JOIN tbl_user u ON u\.user_id = vm\.user_id/,
    'a deleted user must yield NULL, never a dangling owner id');
  assert.match(fn, /SELECT u\.user_id/, 'select the JOINED id, not vm.user_id');
  assert.match(fn, /vm\.inserted_on DESC, vm\.id DESC/, 'newest mapping wins');
  assert.match(fn, /vm\.status IS NULL OR vm\.status = 1/, 'inactive mappings are skipped');
});
