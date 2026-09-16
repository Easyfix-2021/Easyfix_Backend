/*
 * The job REASON endpoints on routes/admin/jobs.js — /action-reasons and its
 * sibling /reschedule-reasons — through the REAL router, against a fake pool
 * that records the SQL each one issues.
 *
 * WHAT IS ACTUALLY AT RISK
 *   These endpoints answer "which reasons may an operator pick", and getting
 *   one wrong shows a real, plausible-looking list belonging to the wrong
 *   party. Nothing throws; the operator picks from it and the wrong reason id
 *   lands on the job. So what is pinned is WHICH ROWS EACH CALL ASKS FOR:
 *   the action_type bucket, and whether a user_type filter is applied at all.
 *
 * THE `dueTo=any` WORKAROUND, which is most of this file.
 *   The six seeded action_type = 8 rows carry user_type values written against
 *   the mapping DUE_TO_USER_TYPE later disproved (services/reason-codes.js has
 *   the dates), so `dueTo=customer` is legitimately EMPTY on today's data and
 *   the CRM needs the unfiltered bucket through the same endpoint shape. That
 *   escape hatch has to be SCOPED: handed to every mode it would let a due-to
 *   radio send no party at all on Cancel / Add Remarks / Enquiry / Un
 *   Reachable, whose per-party data is correct. Both halves are pinned — it
 *   works for reschedule, and it is still an ordinary unknown value everywhere
 *   else.
 *
 * NO DB: the fake-pool seam answers the reads. Runner: `node --test`.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installFakePool } = require('./helpers/fake-pool');

// Every reason read goes through this one route; the rows are irrelevant to
// what is asserted (the SQL and its params are the subject), so one row is
// enough to prove the mapping/filtering reached the response.
const fake = installFakePool([
  [/FROM action_taken_reason/i, [{ id: 501, action_desc: '  Customer requested a different date/time  ' }]],
]);

const { ACTION_TYPE_BY_MODE, DUE_TO_USER_TYPE, DUE_TO_ANY, MODES_ALLOWING_DUE_TO_ANY } =
  require('../services/reason-codes');
const jobsRouter = require('../routes/admin/jobs');

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  // Only what routes/admin/index.js would attach. These endpoints read neither
  // scope nor permissions — they are catalogue reads behind the group guard.
  app.use((req, _res, next) => {
    req.user = { user_id: 77, permissions: { menuIds: [], actionPermissions: [] } };
    req.userRole = { role_name: 'Admin' };
    const all = { mode: 'all', ids: [], placeholders: '' };
    req.scope = { clients: all, cities: all, states: all, verticals: all };
    req.allowedStages = null;
    next();
  });
  app.use('/jobs', jobsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { res.status(500).json({ error: String(err && err.message) }); });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  fake.restore();
});

beforeEach(() => { fake.calls.length = 0; });

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}
// The one reason SELECT this request issued.
const reasonQuery = () => fake.calls.find((c) => /FROM action_taken_reason/i.test(c.sql));

/* ── The reschedule mode exists at all ───────────────────────────────────── */

test('reschedule is a registered mode, mapped to the seeded action_type 8 bucket', () => {
  assert.equal(ACTION_TYPE_BY_MODE.reschedule, 8);
});

test('?type=reschedule&dueTo=<party> is action_type 8 narrowed by that party', async () => {
  for (const [party, userType] of Object.entries(DUE_TO_USER_TYPE)) {
    fake.calls.length = 0;
    const r = await get(`/jobs/action-reasons?type=reschedule&dueTo=${party}`);
    assert.equal(r.status, 200);
    const q = reasonQuery();
    assert.match(q.sql, /action_type = \? AND user_type = \?/, `${party} must stay party-filtered`);
    assert.deepEqual(q.params, [8, userType], `${party} → user_type ${userType}`);
  }
});

/* ── dueTo=any: the whole bucket, for reschedule only ────────────────────── */

test('?type=reschedule&dueTo=any drops the user_type filter entirely', async () => {
  const r = await get('/jobs/action-reasons?type=reschedule&dueTo=any');
  assert.equal(r.status, 200);
  const q = reasonQuery();
  assert.doesNotMatch(q.sql, /user_type/, 'no party predicate may be emitted');
  assert.deepEqual(q.params, [8], 'and no party param may be bound');
  assert.match(q.sql, /\(status IS NULL OR status = 1\)/, 'still active rows only');
});

test('dueTo=any returns the SAME rows, in the same shape, as /reschedule-reasons', async () => {
  // The CRM falls back from an empty party list to this call, so the two must
  // be interchangeable: same bucket, same active filter, same { id, label }.
  const any = await get('/jobs/action-reasons?type=reschedule&dueTo=any');
  const anySql = reasonQuery().sql.replace(/\s+/g, ' ').trim();
  const anyParams = reasonQuery().params;
  fake.calls.length = 0;
  const legacy = await get('/jobs/reschedule-reasons');
  const legacySql = reasonQuery().sql.replace(/\s+/g, ' ').trim();

  assert.equal(anySql, legacySql, 'the two must issue the identical statement');
  assert.deepEqual(anyParams, reasonQuery().params);
  assert.deepEqual(any.body, legacy.body, 'and return the identical payload');
  // The shape the CRM renders, including the trim the fixture row needs.
  assert.deepEqual(any.body.data, [{ id: 501, label: 'Customer requested a different date/time' }]);
});

test('dueTo=any is case- and space-insensitive like every other dueTo', async () => {
  for (const spelling of ['ANY', ' any ', 'Any']) {
    fake.calls.length = 0;
    await get(`/jobs/action-reasons?type=reschedule&dueTo=${encodeURIComponent(spelling)}`);
    assert.deepEqual(reasonQuery().params, [8], `${JSON.stringify(spelling)} must be the unfiltered read`);
  }
});

/* ── …and nowhere else ───────────────────────────────────────────────────── */

test('dueTo=any is an ORDINARY UNKNOWN VALUE on every other mode', async () => {
  /*
   * The regression this prevents: handing the escape hatch to modes whose
   * per-party data is correct would let a due-to radio quietly send no party
   * and show every party's reasons as if they were one.
   *
   * "Unchanged" is asserted against a KNOWN-UNKNOWN value rather than against a
   * hardcoded 2, so if the endpoint's default ever moves, this test follows it
   * instead of going quietly stale.
   */
  for (const mode of Object.keys(ACTION_TYPE_BY_MODE)) {
    if (MODES_ALLOWING_DUE_TO_ANY.includes(mode)) continue;
    fake.calls.length = 0;
    await get(`/jobs/action-reasons?type=${mode}&dueTo=any`);
    const withAny = reasonQuery();
    fake.calls.length = 0;
    await get(`/jobs/action-reasons?type=${mode}&dueTo=zzz-not-a-party`);
    const withJunk = reasonQuery();
    assert.match(withAny.sql, /user_type = \?/, `${mode} must stay party-filtered`);
    assert.deepEqual(withAny.params, withJunk.params,
      `${mode}: dueTo=any must behave exactly as an unknown value does`);
    assert.equal(withAny.params[0], ACTION_TYPE_BY_MODE[mode], `${mode} keeps its own bucket`);
  }
});

test('only reschedule opts in — the list is not quietly growing', () => {
  // A second mode joining this list is a product decision, not a refactor.
  assert.deepEqual([...MODES_ALLOWING_DUE_TO_ANY], ['reschedule']);
  assert.equal(DUE_TO_ANY, 'any');
  assert.equal(DUE_TO_USER_TYPE[DUE_TO_ANY], undefined,
    '"any" must never become a DUE_TO_USER_TYPE key — that would hand it to every mode');
});

/* ── The surrounding contract stays as it was ────────────────────────────── */

test('/reschedule-reasons is unchanged: action_type 8, no party filter', async () => {
  const r = await get('/jobs/reschedule-reasons');
  assert.equal(r.status, 200);
  const q = reasonQuery();
  assert.deepEqual(q.params, [8]);
  assert.doesNotMatch(q.sql, /user_type/);
});

test('a missing type still 400s, and now names every mode it accepts', async () => {
  const r = await get('/jobs/action-reasons');
  assert.equal(r.status, 400);
  assert.equal(reasonQuery(), undefined, 'nothing may be read for a request that names no mode');
  for (const mode of Object.keys(ACTION_TYPE_BY_MODE)) {
    assert.ok(r.body.error.includes(mode), `the hint must name ${mode}`);
  }
});

test('an unknown type is an empty list, not a bucket guess', async () => {
  const r = await get('/jobs/action-reasons?type=teleport&dueTo=any');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, []);
  assert.equal(reasonQuery(), undefined, 'and it must not reach the database at all');
});
