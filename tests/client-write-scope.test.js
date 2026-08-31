/*
 * Client WRITES obey the same scope as client READS.
 *
 * The seven endpoints that mutate a job by id — approve, reject,
 * estimate/approve, estimate/reject, cancel, images, escalate — checked
 * TENANCY only: `job.fk_client_id === req.spoc.client_id`. Any SPOC who
 * guessed a job id could approve, escalate or CANCEL a colleague's job,
 * including one that appears in no list they can open. Read scope and write
 * scope were two different answers to the same question.
 *
 * These drive the ROUTE HANDLERS, because the gap was in the handler and
 * nowhere else — jobService did exactly what it was asked.
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/* 42 is the caller, 43 reports to them, 99 does not. */
let me = { manager_id: 7 };                       // not top of tree → scoped
let subtree = [{ id: 42 }, { id: 43 }];
let jobRow = null;

const fake = installFakePool([
  [/SELECT manager_id FROM tbl_client_contacts/i, () => [me]],
  [/WITH RECURSIVE team/i, () => subtree],
  // Column-presence probes inside getByIdCore. [] = "column absent", which is
  // a supported shape — the projection falls back to a NULL alias.
  [/INFORMATION_SCHEMA/i, []],
  [/^\s*SELECT j\.\*/i, () => (jobRow ? [jobRow] : [])],
  /*
   * /cancel goes on to jobService.setStatus, which re-reads the job through
   * getJobMeta — a DIFFERENT query. Without this the handler threw "job not
   * found" from deep inside the service AFTER passing the scope gate, which
   * looks like a failing scope test and is not one.
   *
   * Placed after the detail route: the fake dispatches on FIRST match, and
   * `SELECT job_id, job_status` is specific enough not to shadow it.
   */
  [/SELECT job_id, job_status, fk_easyfixter_id/i, () => (jobRow ? [jobRow] : [])],
]);

const router = require('../routes/client/index');

function handlerFor(path, method) {
  const layer = router.stack.find((e) => e.route && e.route.path === path && e.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
const res = () => ({
  statusCode: null, body: null,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
});

async function call(path, method, { access = { allStores: false }, body = {} } = {}) {
  const r = res();
  await handlerFor(path, method)(
    { spoc: { id: 42, client_id: 133, contact_name: 'Caller' },
      access, query: {}, params: { id: '5001' }, body },
    r, (e) => { throw e; });
  return r;
}

/* Did the handler reach its UPDATE, or bail before it? */
const wrote = () => fake.calls.some((c) => /UPDATE tbl_job/i.test(c.sql));

/*
 * "Got past the gate" — the assertion these tests actually make. A handler may
 * still fail further downstream on a fixture this file does not provide (the
 * cancel path fans out into comments, notifications and webhooks); what must
 * never happen is a 404 from the ownership check.
 */
async function passesGate(path, method, opts) {
  try {
    const r = await call(path, method, opts);
    return r.statusCode !== 404;
  } catch (e) {
    // Threw AFTER the gate — which is itself proof the gate let it through.
    return !/not found/i.test(e.message) || fake.calls.some((c) => /UPDATE tbl_job/i.test(c.sql));
  }
}

const job = (over = {}) => ({
  job_id: 5001, fk_client_id: 133, job_status: 15,
  reporting_contact_id: 43, approved_on_date_time: null,
  approval_reject_date_time: null, approval_sent_on_date_time: '2026-08-20 10:00:00',
  ...over,
});

beforeEach(() => {
  fake.reset();
  me = { manager_id: 7 };
  subtree = [{ id: 42 }, { id: 43 }];
  jobRow = job();
});

/* ─── the gap ──────────────────────────────────────────────────────────── */

const WRITES = [
  ['/jobs/:id/approve',          'patch', {}],
  ['/jobs/:id/reject',           'patch', { reason: 'not needed' }],
  ['/jobs/:id/estimate/approve', 'patch', {}],
  ['/jobs/:id/estimate/reject',  'patch', { reason: 'too costly' }],
  ['/jobs/:id/cancel',           'post',  { comment: 'duplicate' }],
  ['/jobs/:id/escalate',         'post',  { reasonId: 1 }],
];

for (const [path, method, body] of WRITES) {
  test(`${method.toUpperCase()} ${path} · a peer's job is 404, and nothing is written`, async () => {
    jobRow = job({ reporting_contact_id: 99 });   // same client, outside the subtree
    const r = await call(path, method, { body });
    assert.equal(r.statusCode, 404,
      'tenancy alone let any SPOC act on a colleague job by guessing its id');
    assert.equal(wrote(), false, 'the refusal must come BEFORE the mutation');
  });

  test(`${method.toUpperCase()} ${path} · a job inside the subtree still works`, async () => {
    assert.ok(await passesGate(path, method, { body }),
      'the check must not lock a SPOC out of their own team book');
  });

  test(`${method.toUpperCase()} ${path} · an allStores SPOC may act on any job of the client`, async () => {
    jobRow = job({ reporting_contact_id: 99 });
    assert.ok(await passesGate(path, method, { access: { allStores: true }, body }),
      'allStores is "sees the whole client"; a write it cannot make is a read it should not have');
  });
}

/* ─── the NULL case, which is 9,400 real jobs ─────────────────────────── */

test('a job with NO reporting contact is refused for a scoped SPOC', async () => {
  /*
   * 9,400 jobs have reporting_contact_id NULL — 52% of website bookings, 69%
   * of the Reach Fitness API's — because no SPOC booked them. They are ALREADY
   * invisible to a scoped SPOC in every list (`IN (…)` never matches NULL), so
   * refusing the write is the consistent answer, not a new restriction.
   */
  jobRow = job({ reporting_contact_id: null });
  const r = await call('/jobs/:id/approve', 'patch');
  assert.equal(r.statusCode, 404);
  assert.equal(wrote(), false);
});

test('…but an allStores SPOC can still act on it', async () => {
  jobRow = job({ reporting_contact_id: null });
  const r = await call('/jobs/:id/approve', 'patch', { access: { allStores: true } });
  assert.notEqual(r.statusCode, 404,
    'otherwise an API-booked job needing approval could be approved by nobody');
});

/* ─── tenancy, which must not have regressed ──────────────────────────── */

test("another client's job is still 404, before the hierarchy is even resolved", async () => {
  jobRow = job({ fk_client_id: 999, reporting_contact_id: 43 });
  const r = await call('/jobs/:id/approve', 'patch', { access: { allStores: true } });
  assert.equal(r.statusCode, 404, 'cross-tenant is the check that must never weaken');
  assert.equal(fake.calls.some((c) => /WITH RECURSIVE team/i.test(c.sql)), false,
    'a foreign job must not even cost a hierarchy lookup');
});

test('a missing job is 404', async () => {
  jobRow = null;
  const r = await call('/jobs/:id/approve', 'patch', { access: { allStores: true } });
  assert.equal(r.statusCode, 404);
});
