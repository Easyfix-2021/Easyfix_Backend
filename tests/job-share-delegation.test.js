const test = require('node:test');
const { after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installFakePool } = require('./helpers/fake-pool');
const { readMigration } = require('./helpers/migration-file');

/*
 * JOB DELEGATION — the state machine, the lock, and the two places the rule is
 * written down twice.
 *
 * The lock is the part worth testing hardest: it is ONE function
 * (middleware/require-tech-lifecycle-capability.js) standing in for 15
 * ownership checks, so if it is wrong the wrong technician gets a job.
 *
 * Every source-text assertion strips comments first — this repo writes long
 * comments that name the very identifiers being asserted, so an un-stripped
 * match can be satisfied by prose alone.
 */

const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');

const readSrc = (rel) => stripComments(
  fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'),
);

/* ─── Fake DB ──────────────────────────────────────────────────────────
 * `shareRow` is what tbl_job_share_link holds for the job under test;
 * `jobRow` what tbl_job holds. `updates` records every status write so a test
 * can assert the transition actually reached the DB rather than trusting the
 * return value.                                                              */
let shareRow = null;
let jobRow = null;
let delegateRow = { efr_id: 902, efr_status: 1 };
let updates = [];
let updateAffected = 1;

const fake = installFakePool([
  [/SELECT property_key, property_value FROM easyfix_properties/i, () => ([
    { property_key: 'job.share.delegate.efr_ids', property_value: '901, 903' },
  ])],
  [/UPDATE tbl_job_share_link/i, (sql, params) => {
    updates.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return { affectedRows: updateAffected };
  }],
  [/INSERT INTO tbl_job_share_link/i, () => ({ insertId: 77 })],
  [/FROM tbl_job_share_link s/i, () => (shareRow ? [shareRow] : [])],
  [/FROM tbl_job\b/i, () => (jobRow ? [jobRow] : [])],
  [/FROM tbl_easyfixer\b/i, () => (delegateRow ? [delegateRow] : [])],
]);

const delegation = require('../services/job-share-delegation.service');
const properties = require('../services/properties.service');
const {
  requireTechJobMutationCapability,
} = require('../middleware/require-tech-lifecycle-capability');

after(() => fake.restore());

beforeEach(() => {
  updates = [];
  updateAffected = 1;
  shareRow = null;
  jobRow = null;
  delegateRow = { efr_id: 902, efr_status: 1 };
});

function share(overrides = {}) {
  return {
    share_id: 77,
    job_id: 4321,
    fk_easyfixer_id: 901,      // the original technician (the sharer)
    delegate_efr_id: 902,      // the technician doing the work
    contact_name: null,
    contact_number: null,
    status: 'pending',
    created_on: '2026-09-10 09:00:00',
    responded_on: null,
    started_on: null,
    ended_on: null,
    end_reason: null,
    sharer_name: 'Original Tech',
    delegate_name: 'Delegate Tech',
    delegate_no: '9876543210',
    ...overrides,
  };
}

/* Capabilities that let the lifecycle gate through, so a refusal in these
 * tests can only have come from the delegation lock. */
const ABLE = { receiveNewJobs: true, mutateAssignedJobs: true };

function responseDouble() {
  return {
    locals: {},
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function invoke({ method = 'POST', path: p, efrId }) {
  const req = {
    method,
    path: p,
    tech: { efr_id: efrId, lifecycle: { status: 'ACTIVE', capabilities: ABLE } },
  };
  const res = responseDouble();
  let nextCalled = false;
  await requireTechJobMutationCapability(req, res, (e) => {
    if (e) throw e;
    nextCalled = true;
  });
  return { req, res, nextCalled };
}

/* ─── The transition table ────────────────────────────────────────── */

test('the state machine permits exactly the designed transitions and nothing else', async () => {
  const EXPECTED = {
    pending:     ['accepted', 'rejected', 'cancelled', 'expired', 'released'],
    accepted:    ['started', 'cancelled', 'expired', 'released'],
    started:     ['completed', 'handed_back', 'released'],
    rejected:    [],
    cancelled:   [],
    expired:     [],
    completed:   [],
    handed_back: [],
    released:    [],
  };

  // DENOMINATOR: every status the machine knows, not just the ones with edges.
  assert.deepEqual(
    Object.keys(delegation.TRANSITIONS).sort(),
    Object.keys(EXPECTED).sort(),
    'the set of statuses must be exactly the nine in the contract',
  );
  for (const [from, tos] of Object.entries(EXPECTED)) {
    assert.deepEqual(
      [...delegation.TRANSITIONS[from]].sort(), [...tos].sort(),
      `legal transitions out of ${from}`,
    );
  }
  assert.deepEqual(delegation.LIVE_STATUSES, ['pending', 'accepted', 'started']);
  assert.deepEqual(
    [...delegation.TERMINAL_STATUSES].sort(),
    ['cancelled', 'completed', 'expired', 'handed_back', 'rejected', 'released'],
  );
});

test('an illegal transition is refused BEFORE any UPDATE reaches the DB', async () => {
  shareRow = share({ status: 'started' });
  await assert.rejects(
    () => delegation.cancelShare(4321, 901),
    (e) => e.status === 409 && e.details.code === 'share_transition_refused',
    'the original cannot cancel once the delegate has started',
  );
  assert.equal(updates.length, 0, 'a refused transition must not write');
});

test('a legal transition writes a status pinned to the status it validated', async () => {
  shareRow = share({ status: 'pending' });
  await delegation.acceptShare(4321, 902);
  assert.equal(updates.length, 1);
  const [u] = updates;
  assert.match(u.sql, /SET status = \?, responded_on = NOW\(\) WHERE share_id = \? AND status = \?/);
  assert.deepEqual(u.params, ['accepted', 77, 'pending'],
    'the WHERE must pin the FROM status, or two devices can both win');
});

test('a lost race reports a conflict instead of silently doing nothing', async () => {
  shareRow = share({ status: 'pending' });
  updateAffected = 0;
  await assert.rejects(
    () => delegation.acceptShare(4321, 902),
    (e) => e.status === 409 && e.details.code === 'share_conflict',
  );
});

test('only the named party may drive their own transition', async () => {
  shareRow = share({ status: 'pending' });
  await assert.rejects(() => delegation.acceptShare(4321, 999), (e) => e.status === 404);
  await assert.rejects(() => delegation.cancelShare(4321, 902), (e) => e.status === 404);
  assert.equal(updates.length, 0);
});

/* ─── The create gate ─────────────────────────────────────────────── */

test('creating a share is fail-closed on the easyfix_properties allowlist', async () => {
  properties.flushCache();
  await properties.preload();                       // '901, 903'
  assert.equal(delegation.canCreateShare(901), true);
  assert.equal(delegation.canCreateShare(902), false, 'not on the list — denied');

  jobRow = { job_id: 4321, job_status: 1, fk_easyfixter_id: 902 };
  await assert.rejects(
    () => delegation.createShare(4321, 902, { delegateEfrId: 901 }),
    (e) => e.status === 403 && e.details.code === 'share_not_enabled',
  );
});

test('a share needs a live job the sharer actually owns, and a real delegate', async () => {
  properties.flushCache();
  await properties.preload();

  jobRow = { job_id: 4321, job_status: 1, fk_easyfixter_id: 555 };
  await assert.rejects(() => delegation.createShare(4321, 901, { delegateEfrId: 902 }),
    (e) => e.status === 404, 'not his job — 404, never 403, so ids cannot be probed');

  jobRow = { job_id: 4321, job_status: 3 /* COMPLETED */, fk_easyfixter_id: 901 };
  await assert.rejects(() => delegation.createShare(4321, 901, { delegateEfrId: 902 }),
    (e) => e.status === 409 && e.details.code === 'job_not_live');

  jobRow = { job_id: 4321, job_status: 1, fk_easyfixter_id: 901 };
  await assert.rejects(() => delegation.createShare(4321, 901, { delegateEfrId: 901 }),
    (e) => e.status === 400 && e.details.code === 'share_self');

  delegateRow = { efr_id: 902, efr_status: 0 /* deactivated */ };
  await assert.rejects(() => delegation.createShare(4321, 901, { delegateEfrId: 902 }),
    (e) => e.status === 422 && e.details.code === 'delegate_unavailable');
});

/* ─── The lock ────────────────────────────────────────────────────── */

test('the ORIGINAL technician is refused every mutating /jobs route while a share is live', async () => {
  // DENOMINATOR: every mutating mobile /jobs path that exists today, collected
  // from the four routers that define one — not a hand-picked sample.
  const MUTATING_PATHS = [
    '/jobs/4321/checkin', '/jobs/4321/checkout', '/jobs/4321/eta',
    '/jobs/4321/reschedule', '/jobs/4321/cancel', '/jobs/4321/estimate',
    '/jobs/4321/permission-request', '/jobs/4321/selfie', '/jobs/4321/location',
  ];
  for (const status of ['pending', 'accepted', 'started']) {
    shareRow = share({ status });
    for (const p of MUTATING_PATHS) {
      const { res, nextCalled } = await invoke({ path: p, efrId: 901 });
      assert.equal(nextCalled, false, `${p} must be refused while ${status}`);
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.code, 'job_shared', `${p}: the app keys off this string`);
      assert.equal(res.body.details.code, 'job_shared');
      assert.equal(res.body.details.shareStatus, status);
    }
  }
  assert.equal(updates.length, 0, 'refusing the original must not move the share');
});

test('the original keeps reads, and keeps the share routes so he can cancel', async () => {
  shareRow = share({ status: 'accepted' });
  const read = await invoke({ method: 'GET', path: '/jobs/4321', efrId: 901 });
  assert.equal(read.nextCalled, true, 'he can watch his own job being done');

  const cancel = await invoke({ method: 'DELETE', path: '/jobs/4321/share', efrId: 901 });
  assert.equal(cancel.nextCalled, true, 'ending the share is the write he keeps');
  assert.equal(updates.length, 0, 'the lock must not transition anything itself here');
});

test('an accepted DELEGATE acts as the owner — and his first write closes the cancel window', async () => {
  shareRow = share({ status: 'accepted' });
  const { req, nextCalled } = await invoke({ path: '/jobs/4321/checkin', efrId: 902 });
  assert.equal(nextCalled, true);
  assert.equal(req.tech.efr_id, 901,
    'identity is substituted, so all 15 ownership checks pass unmodified');
  assert.equal(req.tech.actual_efr_id, 902, 'the real caller stays available');
  assert.equal(updates.length, 1, 'accepted → started on the first mutating touch');
  assert.deepEqual(updates[0].params, ['started', 77, 'accepted']);
});

test('a delegate GET substitutes identity but does NOT start the job', async () => {
  shareRow = share({ status: 'accepted' });
  const { req, nextCalled } = await invoke({ method: 'GET', path: '/jobs/4321', efrId: 902 });
  assert.equal(nextCalled, true);
  assert.equal(req.tech.efr_id, 901);
  assert.equal(updates.length, 0, 'opening the job is not beginning the work');
});

test('a PENDING delegate inherits nothing — he has accepted no job yet', async () => {
  shareRow = share({ status: 'pending' });
  const { req, nextCalled } = await invoke({ path: '/jobs/4321/checkin', efrId: 902 });
  assert.equal(nextCalled, true, 'the lifecycle gate, not the lock, is what runs');
  assert.equal(req.tech.efr_id, 902, 'NOT substituted — the ownership check below will 404 him');
  assert.equal(updates.length, 0);
});

test('the delegate reaches the share routes as HIMSELF, never as the owner', async () => {
  shareRow = share({ status: 'accepted' });
  const { req } = await invoke({ path: '/jobs/4321/share/accept', efrId: 902 });
  assert.equal(req.tech.efr_id, 902, 'accept/reject/cancel must see the real caller');
  assert.equal(updates.length, 0);
});

test('a job with no live share behaves exactly as it did before delegation existed', async () => {
  shareRow = null;
  for (const [efrId, p, method] of [
    [901, '/jobs/4321/checkin', 'POST'],
    [902, '/jobs/4321/checkin', 'POST'],
    [901, '/jobs/4321', 'GET'],
  ]) {
    const { req, nextCalled } = await invoke({ method, path: p, efrId });
    assert.equal(nextCalled, true, `${method} ${p} for ${efrId}`);
    assert.equal(req.tech.efr_id, efrId, 'no share → no substitution');
  }
});

test('the lock only reads the share for single-job paths — the list is untouched', async () => {
  shareRow = share({ status: 'started' });
  // /jobs and /jobs/offered carry no job id, so the sharer must not be locked
  // out of his own list because ONE of his jobs is delegated.
  for (const p of ['/jobs', '/jobs/offered', '/withdraw']) {
    const { nextCalled } = await invoke({ method: 'GET', path: p, efrId: 901 });
    assert.equal(nextCalled, true, p);
  }
});

/* ─── The two places the rule is written twice ────────────────────── */

test('the migration and the service agree on which statuses are LIVE', () => {
  // Resolved through the helper, not by hand: the file moves to
  // migrations/executed/ once it is applied, and a hand-pinned path would
  // break the day it is (tests/migration-file-helper.test.js enforces this).
  const sql = readMigration('2026-09-10-job-share-delegation.sql');
  const generated = /GENERATED ALWAYS AS \(CASE WHEN status IN \(([^)]*)\)/.exec(sql);
  assert.ok(generated, 'the unique-live index must be backed by a generated column');
  const inSql = generated[1].split(',').map((s) => s.trim().replace(/'/g, '')).sort();
  assert.deepEqual(inSql, [...delegation.LIVE_STATUSES].sort(),
    'the DB constraint and the service must lock on the same set of statuses');
  assert.match(sql, /ADD UNIQUE INDEX uq_job_share_live \(live_job_id\)/,
    'one live share per job must be a DB constraint, not only application code');
});

test('the mobile job list widens to delegated jobs, and only for the mobile list', () => {
  const jobService = readSrc('services/job.service.js');

  /*
   * THE LIST SET IS THE LIVE SET, and it was not.
   *
   * This asserted `IN ('accepted','started')` — pending excluded — which is
   * where the whole feature died: Accept and Reject are reachable only by
   * OPENING the job, and the app's only route to a job is this list. A pending
   * share the delegate cannot see is one he can never answer, so every
   * delegation would have sat until the TTL swept it to `expired` with nobody
   * able to say why. The test encoded that, so it would have defended it.
   *
   * Derived from LIVE_STATUSES rather than spelled out again: if a share is
   * live enough to take a job away from its owner, it is live enough for the
   * delegate to see it, and writing the set twice is how those two drift.
   */
  const liveInSql = [...delegation.LIVE_STATUSES].map((s) => `'${s}'`).join(', ');
  assert.ok(
    jobService.includes(`AND s.status IN (${liveInSql})`),
    `the delegate's list must cover every LIVE status — expected IN (${liveInSql}).\n`
    + '  Anything narrower hides a share he is expected to answer.',
  );
  // The widening must be OPT-IN: `easyfixerId` alone still means "assigned to",
  // which is what the CRM's technician filter and export rely on. It is also
  // SCHEMA-GATED: tests/mobile-jobs-list.test.js runs list() both ways.
  assert.match(jobService, /if \(delegatedToEfrId != null && await delegationColsExist\(\)\) \{/);
  const mobile = readSrc('routes/mobile/index.js');
  assert.match(mobile, /delegatedToEfrId: req\.tech\.efr_id/);

  // DENOMINATOR: nothing else in the repo may pass it.
  const callers = require('node:child_process')
    .execFileSync('grep', ['-rl', '--include=*.js', 'delegatedToEfrId',
      path.join(__dirname, '..', 'routes'), path.join(__dirname, '..', 'services')])
    .toString().trim().split('\n').map((f) => path.basename(f)).sort();
  assert.deepEqual(callers, ['index.js', 'job.service.js'],
    'only routes/mobile/index.js may widen the scope');
});

test('the retired public share-link surface is gone, not merely unmounted', () => {
  for (const rel of [
    'services/job-share.service.js',
    'routes/public/shared-job.js',
  ]) {
    assert.equal(fs.existsSync(path.join(__dirname, '..', rel)), false, `${rel} must be deleted`);
  }
  assert.doesNotMatch(readSrc('utils/jwt.js'), /signJobShareToken|verifyJobShareToken/,
    'the job_share token type must not survive its only consumer');
  assert.doesNotMatch(readSrc('routes/public/index.js'), /shared-job/);
  assert.doesNotMatch(readSrc('routes/mobile/index.js'), /share-link/);
});
