/*
 * The one-list Edit Services editor (Schedule & Assign Uplifted tab):
 *   GET /admin/jobs/:id/service-catalog   and   PUT /admin/jobs/:id/services
 *
 * WHAT IS ACTUALLY AT RISK
 *   These are the job's BILLING LINES. The existing inline POST /:id/services
 *   silently overwrites a service's quantity when it is "added" again — an
 *   operator meaning "one more" can LOWER a quantity with a 200 that says
 *   "reactivated". This editor replaces add-and-hope with a COMPLETE desired
 *   set diffed against the ACTIVE rows, so the properties pinned here are the
 *   ones that keep billing honest:
 *     - an empty set is refused (a job needs a service);
 *     - a new service must be an active product of this client in this job's
 *       category; a line from ANOTHER category can be kept, never added;
 *     - a quantity change recomputes all five charge columns through the same
 *       cascade every writer stores from;
 *     - a dropped line is SOFT-deleted (status 0), never hard-deleted;
 *     - a job with no category gets one set, exactly once;
 *     - resubmitting the same set writes NOTHING — no row, no comment;
 *     - the catalog's unit prices equal what saving stores.
 *   Plus the shapes QA's data forced: duplicate active rows (10,737 jobs),
 *   lines whose product went inactive (278,759 rows), rows with no service_id
 *   (445), and a line whose rate card no longer exists.
 *
 * NO DB: a fake pool answers every read from the scenario below and RECORDS
 * every write. Runner: `node --test` (see npm test).
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installFakePool } = require('./helpers/fake-pool');

const CLIENT = 10;
const CARPENTRY = 5;
const ELECTRICIAN = 1;

/*
 * The client's rate card. Two Carpentry products, one Electrician product, one
 * INACTIVE Carpentry product, and one product belonging to ANOTHER client.
 * Cascade columns chosen so the easyfixer share is non-trivial.
 */
const RATE_CARD = [
  { client_service_id: 25739, client_id: CLIENT, service_catg_id: CARPENTRY, service_type_id: 223, service_status: 1,
    name: 'FUR - Large / Installation', service_type_name: 'Modular Packed Furniture',
    total_amount: 1000, easyfix_direct_fixed: 200, easyfix_direct_variable: 10, overhead_fixed: 0, overhead_variable: 20, client_fixed: 0, client_variable: 0 },
  { client_service_id: 25298, client_id: CLIENT, service_catg_id: CARPENTRY, service_type_id: 241, service_status: 1,
    name: 'Estimated on Visit (Carpenter)', service_type_name: 'Estimate On VISIT',
    total_amount: 500, easyfix_direct_fixed: 0, easyfix_direct_variable: 20, overhead_fixed: 0, overhead_variable: 10, client_fixed: 0, client_variable: 0 },
  { client_service_id: 29262, client_id: CLIENT, service_catg_id: ELECTRICIAN, service_type_id: 240, service_status: 1,
    name: 'Incentive', service_type_name: 'Estimate On VISIT',
    total_amount: 1500, easyfix_direct_fixed: 500, easyfix_direct_variable: 0, overhead_fixed: 0, overhead_variable: 0, client_fixed: 0, client_variable: 0 },
  { client_service_id: 26090, client_id: CLIENT, service_catg_id: CARPENTRY, service_type_id: 241, service_status: 0,
    name: 'Hidden - Negotiated by PM', service_type_name: 'Estimate On VISIT',
    total_amount: 500, easyfix_direct_fixed: 0, easyfix_direct_variable: 0, overhead_fixed: 0, overhead_variable: 0, client_fixed: 0, client_variable: 0 },
  { client_service_id: 24055, client_id: 213, service_catg_id: CARPENTRY, service_type_id: 241, service_status: 1,
    name: 'Another client\'s product', service_type_name: 'Estimate On VISIT',
    total_amount: 500, easyfix_direct_fixed: 0, easyfix_direct_variable: 0, overhead_fixed: 0, overhead_variable: 0, client_fixed: 0, client_variable: 0 },
];
const CATEGORY_NAMES = { [CARPENTRY]: 'Carpentry Services', [ELECTRICIAN]: 'Electrician Services' };

/* An ACTIVE job row, joined the way loadActiveLines joins it. */
function jobRow(jobServiceId, serviceId, quantity, { catg } = {}) {
  const cs = RATE_CARD.find((r) => r.client_service_id === serviceId);
  return {
    job_service_id: jobServiceId, service_id: serviceId, quantity,
    catg_id: catg !== undefined ? catg : (cs ? cs.service_catg_id : null),
    name: cs ? cs.name : null,
    service_type_name: cs ? cs.service_type_name : null,
    service_catg_name: cs ? CATEGORY_NAMES[cs.service_catg_id] : null,
    ...(cs || {}),
    rate_card_present: cs ? cs.client_service_id : null,
  };
}

const scenario = {};
function reset() {
  Object.assign(scenario, {
    job: { job_id: 482657, fk_client_id: CLIENT, fk_service_catg_id: CARPENTRY, job_status: 1 },
    jobRows: [jobRow(652574, 25739, 2)],
  });
}
reset();

const WRITE = /^\s*(UPDATE|INSERT|DELETE)\b/i;
const fake = installFakePool([
  [/FROM tbl_job WHERE job_id = \? FOR UPDATE/i, () => (scenario.job ? [scenario.job] : [])],
  [/SELECT js\.job_service_id FROM tbl_job_services js[\s\S]*FOR UPDATE/i, () => scenario.jobRows.map((r) => ({ job_service_id: r.job_service_id }))],
  [/AS catg_id/i, () => scenario.jobRows],
  [/SELECT DISTINCT sc\.service_catg_id AS id/i, (sql, [clientId]) => {
    const ids = [...new Set(RATE_CARD.filter((r) => r.client_id === clientId && r.service_status === 1).map((r) => r.service_catg_id))];
    return ids.map((id) => ({ id, name: CATEGORY_NAMES[id] }));
  }],
  [/SELECT service_catg_name FROM tbl_service_catg WHERE service_catg_id = \?/i, (sql, [id]) =>
    (CATEGORY_NAMES[id] ? [{ service_catg_name: CATEGORY_NAMES[id] }] : [])],
  [/SELECT DISTINCT st\.service_type_id/i, (sql, [clientId, catg]) => {
    const seen = new Map();
    for (const r of RATE_CARD) {
      if (r.client_id === clientId && r.service_status === 1 && r.service_catg_id === catg) {
        seen.set(r.service_type_id, { service_type_id: r.service_type_id, name: r.service_type_name });
      }
    }
    return [...seen.values()];
  }],
  [/WHERE cs\.client_service_id IN \(\?\)/i, (sql, [ids]) => RATE_CARD.filter((r) => ids.includes(r.client_service_id))],
  [/WHERE cs\.client_id = \? AND cs\.service_status = 1 AND cs\.service_catg_id = \?/i, (sql, [clientId, catg]) =>
    RATE_CARD.filter((r) => r.client_id === clientId && r.service_status === 1 && r.service_catg_id === catg)],
  [/SHOW COLUMNS/i, []],
  [/SELECT service_id FROM tbl_job_services/i, []],
  [WRITE, () => ({ affectedRows: 1, insertId: 900001 })],
]);

const jobComments = require('../services/job-comment.service');
const editor = require('../services/job-services-editor.service');
const { computeJobServiceCharges } = require('../utils/rate-card-calc');

const comments = [];
const realAddComment = jobComments.addComment;

beforeEach(() => {
  reset();
  fake.reset();
  comments.length = 0;
  jobComments.addComment = async (jobId, payload) => { comments.push({ jobId, payload }); return { id: 1 }; };
});
after(() => { jobComments.addComment = realAddComment; });

const writes = () => fake.calls.filter((c) => WRITE.test(c.sql));
const serviceWrites = () => writes().filter((c) => /tbl_job_services/i.test(c.sql));
const put = (body, actor = { user_id: 77 }) => editor.replaceJobServices(482657, body, actor);

/* ── GET service-catalog ─────────────────────────────────────────────────── */

test('the job\'s own category wins, and `categories` is empty when one is set', async () => {
  const c = await editor.getServiceCatalog(scenario.job);
  assert.deepEqual(c.category, { id: CARPENTRY, name: 'Carpentry Services', source: 'job' });
  assert.deepEqual(c.categories, []);
});

test('products are this client\'s ACTIVE products in the category, with the writer\'s unit prices', async () => {
  const c = await editor.getServiceCatalog(scenario.job);
  assert.deepEqual(c.products.map((p) => p.service_id).sort(), [25298, 25739],
    'no inactive product, no other category, no other client');
  for (const p of c.products) {
    const ch = computeJobServiceCharges(RATE_CARD.find((r) => r.client_service_id === p.service_id), 1);
    assert.equal(p.unit_client, ch.total_cost, `${p.name}: unit_client must be what saving stores at qty 1`);
    assert.equal(p.unit_tx, ch.easyfixer_charge, `${p.name}: unit_tx must be what saving stores at qty 1`);
    assert.equal(p.code, null, 'no product code exists on the rate-card path');
  }
  assert.deepEqual(c.types.map((t) => t.service_type_id).sort(), [223, 241]);
});

test('on_job_qty / job_service_id are set only for services ACTIVE on the job', async () => {
  const c = await editor.getServiceCatalog(scenario.job);
  const fur = c.products.find((p) => p.service_id === 25739);
  assert.equal(fur.on_job_qty, 2);
  assert.equal(fur.job_service_id, 652574);
  const other = c.products.find((p) => p.service_id === 25298);
  assert.equal(other.on_job_qty, null);
  assert.equal(other.job_service_id, null);
});

test('duplicate active rows for one service are ONE line: summed quantity, newest row id', async () => {
  scenario.jobRows = [jobRow(652574, 25739, 1), jobRow(652580, 25739, 2)];
  const fur = (await editor.getServiceCatalog(scenario.job)).products.find((p) => p.service_id === 25739);
  assert.equal(fur.on_job_qty, 3);
  assert.equal(fur.job_service_id, 652580);
});

test('`foreign` carries every active line the product list does not — other category AND inactive product', async () => {
  scenario.jobRows = [jobRow(652574, 25739, 2), jobRow(652576, 29262, 1), jobRow(652577, 26090, 2)];
  const c = await editor.getServiceCatalog(scenario.job);
  assert.deepEqual(c.foreign.map((f) => f.service_id).sort(), [26090, 29262]);
  const incentive = c.foreign.find((f) => f.service_id === 29262);
  assert.deepEqual(Object.keys(incentive).sort(),
    ['job_service_id', 'name', 'quantity', 'service_catg_name', 'service_id', 'service_type_name', 'unit_client', 'unit_tx'].sort());
  assert.equal(incentive.service_catg_name, 'Electrician Services');
});

test('a row with no service_id is shown nowhere — it cannot be named, so it cannot be edited', async () => {
  scenario.jobRows = [jobRow(652574, 25739, 2), { ...jobRow(652599, 0, 1), service_id: null }];
  const c = await editor.getServiceCatalog(scenario.job);
  assert.equal(c.foreign.length, 0);
  assert.equal(c.products.filter((p) => p.on_job_qty != null).length, 1);
});

test('no job category, ONE category on the lines → source "services"', async () => {
  scenario.job = { ...scenario.job, fk_service_catg_id: null };
  const c = await editor.getServiceCatalog(scenario.job);
  assert.deepEqual(c.category, { id: CARPENTRY, name: 'Carpentry Services', source: 'services' });
});

test('no category anywhere → null, the client\'s categories to pick from, and no products until one is picked', async () => {
  scenario.job = { ...scenario.job, fk_service_catg_id: null };
  scenario.jobRows = [];
  const c = await editor.getServiceCatalog(scenario.job);
  assert.equal(c.category, null);
  assert.deepEqual(c.categories.map((x) => x.id).sort(), [ELECTRICIAN, CARPENTRY].sort());
  assert.deepEqual(c.types, []);
  assert.deepEqual(c.products, []);

  const picked = await editor.getServiceCatalog(scenario.job, { categoryId: ELECTRICIAN });
  assert.deepEqual(picked.products.map((p) => p.service_id), [29262], '?categoryId= loads that category');
});

test('?categoryId= is ignored while the job resolves a category of its own', async () => {
  const c = await editor.getServiceCatalog(scenario.job, { categoryId: ELECTRICIAN });
  assert.equal(c.category.id, CARPENTRY);
  assert.ok(c.products.every((p) => p.service_id !== 29262));
});

test('the catalog never writes', async () => {
  await editor.getServiceCatalog(scenario.job);
  assert.deepEqual(writes(), []);
});

/* ── PUT services: the refusals ──────────────────────────────────────────── */

test('an EMPTY set is refused with a plain sentence, and nothing is written', async () => {
  await assert.rejects(put({ services: [] }), { status: 400, message: 'A job needs at least one service.' });
  assert.deepEqual(writes(), []);
  assert.equal(comments.length, 0);
});

test('the same service twice in one set is refused', async () => {
  await assert.rejects(put({ services: [{ service_id: 25739, quantity: 1 }, { service_id: 25739, quantity: 2 }] }),
    { status: 400, message: 'Each service can only be listed once.' });
});

test('a quantity outside 1..100 is refused', async () => {
  for (const quantity of [0, 101, 1.5]) {
    await assert.rejects(put({ services: [{ service_id: 25739, quantity }] }), { status: 400 });
  }
});

test('ADDING a service from another category is refused, and the whole set rolls back', async () => {
  await assert.rejects(
    put({ services: [{ service_id: 25739, quantity: 2 }, { service_id: 25298, quantity: 1 }, { service_id: 29262, quantity: 1 }] }),
    (e) => e.status === 400 && /Incentive is from a different category/.test(e.message),
  );
  assert.deepEqual(serviceWrites(), [], 'the valid add alongside it must not land either');
});

test('adding an inactive product, or another client\'s, is refused', async () => {
  await assert.rejects(put({ services: [{ service_id: 25739, quantity: 2 }, { service_id: 26090, quantity: 1 }] }),
    { status: 400, message: "Service 26090 is not on this client's rate card." });
  await assert.rejects(put({ services: [{ service_id: 25739, quantity: 2 }, { service_id: 24055, quantity: 1 }] }),
    { status: 400, message: "Service 24055 is not on this client's rate card." });
});

test('a completed job is refused on the LOCKED row', async () => {
  scenario.job = { ...scenario.job, job_status: 3 };
  await assert.rejects(put({ services: [{ service_id: 25739, quantity: 2 }] }), { status: 409 });
});

/* ── PUT services: keeping what is already there ─────────────────────────── */

test('a line from ANOTHER category that is already on the job may be KEPT', async () => {
  scenario.jobRows = [jobRow(652574, 25739, 2), jobRow(652576, 29262, 1)];
  const r = await put({ services: [{ service_id: 25739, quantity: 2 }, { service_id: 29262, quantity: 1 }] });
  assert.deepEqual(r, { added: 0, updated: 0, removed: 0 });
  assert.deepEqual(writes(), []);
});

test('a line whose product went INACTIVE may be kept — and re-quantified from its rate card', async () => {
  scenario.jobRows = [jobRow(652574, 25739, 2), jobRow(652577, 26090, 1)];
  const r = await put({ services: [{ service_id: 25739, quantity: 2 }, { service_id: 26090, quantity: 3 }] });
  assert.deepEqual(r, { added: 0, updated: 1, removed: 0 });
});

test('a line whose rate card no longer EXISTS can be kept but not re-quantified', async () => {
  const orphan = { ...jobRow(652590, 31337, 1), name: 'Legacy line', rate_card_present: null };
  scenario.jobRows = [jobRow(652574, 25739, 2), orphan];
  // Kept at its quantity: fine.
  assert.deepEqual(await put({ services: [{ service_id: 25739, quantity: 2 }, { service_id: 31337, quantity: 1 }] }),
    { added: 0, updated: 0, removed: 0 });
  // Re-quantified: refused, because the cascade given nothing would zero its charges.
  await assert.rejects(put({ services: [{ service_id: 25739, quantity: 2 }, { service_id: 31337, quantity: 4 }] }),
    (e) => e.status === 400 && /no longer on any rate card/.test(e.message));
});

/* ── PUT services: the diff ──────────────────────────────────────────────── */

test('a QUANTITY change recomputes all five charge columns through the writers\' cascade', async () => {
  const r = await put({ services: [{ service_id: 25739, quantity: 3 }] });
  assert.deepEqual(r, { added: 0, updated: 1, removed: 0 });
  const [upd] = serviceWrites();
  assert.match(upd.sql, /SET quantity = \?, total_charge = \?, total_cost = \?,\s*client_charge = \?, easyfix_charge = \?, easyfixer_charge = \?/);
  const ch = computeJobServiceCharges(RATE_CARD[0], 3);
  assert.deepEqual(upd.params, [3, ch.total_charge, ch.total_cost, ch.client_charge, ch.easyfix_charge, ch.easyfixer_charge, 482657, 652574]);
});

test('a NEW service is INSERTed with its type, category and five charge columns', async () => {
  const r = await put({ services: [{ service_id: 25739, quantity: 2 }, { service_id: 25298, quantity: 2 }] });
  assert.deepEqual(r, { added: 1, updated: 0, removed: 0 });
  const ins = serviceWrites().find((c) => /^\s*INSERT/i.test(c.sql));
  const ch = computeJobServiceCharges(RATE_CARD[1], 2);
  assert.deepEqual(ins.params, [482657, 25298, 2, 241, CARPENTRY, 1,
    ch.total_charge, ch.total_cost, ch.client_charge, ch.easyfix_charge, ch.easyfixer_charge]);
});

test('a DROPPED line is SOFT-deleted (status 0) — never hard-deleted', async () => {
  scenario.jobRows = [jobRow(652574, 25739, 2), jobRow(652576, 29262, 1)];
  const r = await put({ services: [{ service_id: 25739, quantity: 2 }] });
  assert.deepEqual(r, { added: 0, updated: 0, removed: 1 });
  const [del] = serviceWrites();
  assert.match(del.sql, /SET job_service_status = 0/);
  assert.deepEqual(del.params, [482657, [652576]]);
  assert.equal(writes().filter((c) => /^\s*DELETE/i.test(c.sql)).length, 0);
});

test('duplicates: resubmitting the SUM is a no-op; a new quantity collapses onto the newest row', async () => {
  scenario.jobRows = [jobRow(652574, 25739, 1), jobRow(652580, 25739, 2)];
  assert.deepEqual(await put({ services: [{ service_id: 25739, quantity: 3 }] }), { added: 0, updated: 0, removed: 0 });
  assert.deepEqual(writes(), []);

  fake.reset();
  assert.deepEqual(await put({ services: [{ service_id: 25739, quantity: 5 }] }), { added: 0, updated: 1, removed: 0 });
  const [upd, collapse] = serviceWrites();
  assert.equal(upd.params.at(-1), 652580, 'the newest row carries the new quantity');
  assert.deepEqual(collapse.params, [482657, [652574]], 'the older duplicate is soft-deleted');
});

test('dropping a duplicated service soft-deletes EVERY row of it', async () => {
  scenario.jobRows = [jobRow(652574, 25739, 2), jobRow(652581, 25298, 1), jobRow(652582, 25298, 1)];
  assert.deepEqual(await put({ services: [{ service_id: 25739, quantity: 2 }] }), { added: 0, updated: 0, removed: 1 });
  assert.deepEqual(serviceWrites()[0].params, [482657, [652581, 652582]]);
});

test('a row with no service_id is never touched by a save', async () => {
  scenario.jobRows = [jobRow(652574, 25739, 2), { ...jobRow(652599, 0, 1), service_id: null }];
  await put({ services: [{ service_id: 25739, quantity: 4 }] });
  for (const w of serviceWrites()) {
    assert.ok(!JSON.stringify(w.params).includes('652599'), 'the unnamed row must not be in any write');
  }
});

test('RESUBMITTING THE SAME SET WRITES NOTHING — no row, no job stamp, no comment', async () => {
  const r = await put({ services: [{ service_id: 25739, quantity: 2 }] });
  assert.deepEqual(r, { added: 0, updated: 0, removed: 0 });
  assert.deepEqual(writes(), []);
  assert.equal(comments.length, 0);
});

/* ── PUT services: category ──────────────────────────────────────────────── */

test('on a job with NO category, categoryId is required …', async () => {
  scenario.job = { ...scenario.job, fk_service_catg_id: null };
  await assert.rejects(put({ services: [{ service_id: 25739, quantity: 2 }] }),
    { status: 400, message: 'Choose a category for this job first.' });
});

test('… must be one the client\'s rate card sells …', async () => {
  scenario.job = { ...scenario.job, fk_service_catg_id: null };
  await assert.rejects(put({ categoryId: 99, services: [{ service_id: 25739, quantity: 2 }] }),
    { status: 400, message: "That category is not on this client's rate card." });
});

test('… and is SET on the job, once — a resubmit afterwards writes nothing', async () => {
  scenario.job = { ...scenario.job, fk_service_catg_id: null };
  const r = await put({ categoryId: CARPENTRY, services: [{ service_id: 25739, quantity: 2 }] });
  assert.deepEqual(r, { added: 0, updated: 0, removed: 0 });
  const set = writes().find((c) => /SET fk_service_catg_id = \?/.test(c.sql));
  assert.deepEqual(set.params, [CARPENTRY, 482657]);
  assert.match(comments[0].payload.comments, /category set to Carpentry Services/);

  // The job now has that category; the same request again is a no-op.
  scenario.job = { ...scenario.job, fk_service_catg_id: CARPENTRY };
  fake.reset();
  comments.length = 0;
  await put({ categoryId: CARPENTRY, services: [{ service_id: 25739, quantity: 2 }] });
  assert.deepEqual(writes(), []);
  assert.equal(comments.length, 0);
});

test('a categoryId that DIFFERS from the job\'s is rejected; the same one is accepted', async () => {
  await assert.rejects(put({ categoryId: ELECTRICIAN, services: [{ service_id: 25739, quantity: 2 }] }),
    (e) => e.status === 400 && /category is already set/.test(e.message));
  assert.deepEqual(await put({ categoryId: CARPENTRY, services: [{ service_id: 25739, quantity: 2 }] }),
    { added: 0, updated: 0, removed: 0 });
});

test('new services on a newly-categorised job must be in THAT category', async () => {
  scenario.job = { ...scenario.job, fk_service_catg_id: null };
  scenario.jobRows = [];
  await assert.rejects(put({ categoryId: ELECTRICIAN, services: [{ service_id: 25739, quantity: 1 }] }),
    (e) => e.status === 400 && /different category/.test(e.message));
});

/* ── PUT services: the audit trail and the CSV mirror ────────────────────── */

test('ONE comment names what changed, through addComment, as the acting user', async () => {
  scenario.jobRows = [jobRow(652574, 25739, 2), jobRow(652576, 29262, 1)];
  await put({ services: [{ service_id: 25739, quantity: 3 }, { service_id: 25298, quantity: 1 }] });
  assert.equal(comments.length, 1);
  const { jobId, payload } = comments[0];
  assert.equal(jobId, 482657);
  assert.equal(payload.comment_on, 1);
  assert.equal(payload.commented_by, 77);
  assert.equal(payload.comments,
    'Services updated: added Estimated on Visit (Carpenter) ×1; quantity changed FUR - Large / Installation 2 → 3; removed Incentive.');
});

test('a change re-mirrors tbl_job.client_services and stamps last_update_time', async () => {
  await put({ services: [{ service_id: 25739, quantity: 3 }] });
  assert.ok(writes().some((c) => /UPDATE tbl_job SET client_services = \?/.test(c.sql)), 'client_services recomputed');
  assert.ok(writes().some((c) => /UPDATE tbl_job SET last_update_time = \?/.test(c.sql)));
});

test('a comment failure does not undo a committed change', async () => {
  jobComments.addComment = async () => { throw new Error('comment table locked'); };
  assert.deepEqual(await put({ services: [{ service_id: 25739, quantity: 3 }] }), { added: 0, updated: 1, removed: 0 });
});

/* ── Routes ──────────────────────────────────────────────────────────────── */

const jobSvc = require('../services/job.service');
const realGetById = jobSvc.getById;
const route = { scoped: true };
let server;
let baseUrl;

before(async () => {
  jobSvc.getById = async () => (route.scoped ? { ...scenario.job, city_id: 2, vertical_id: 3 } : null);
  const jobsRouter = require('../routes/admin/jobs');
  const app = express();
  app.use(express.json());
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
  jobSvc.getById = realGetById;
  fake.restore();
});

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('GET /jobs/:id/service-catalog returns the five keys', async () => {
  route.scoped = true;
  const r = await call('GET', '/jobs/482657/service-catalog');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body.data).sort(), ['categories', 'category', 'foreign', 'products', 'types']);
});

test('PUT /jobs/:id/services answers the empty set with the plain sentence', async () => {
  route.scoped = true;
  const r = await call('PUT', '/jobs/482657/services', { services: [] });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'A job needs at least one service.');
});

test('PUT is refused on a completed job by servicesEditable, before the service runs', async () => {
  route.scoped = true;
  scenario.job = { ...scenario.job, job_status: 5 };
  fake.reset();
  const r = await call('PUT', '/jobs/482657/services', { services: [{ service_id: 25739, quantity: 2 }] });
  assert.equal(r.status, 409);
  assert.equal(fake.calls.filter((c) => /FOR UPDATE/.test(c.sql)).length, 0, 'the route guard fires first');
});

test('both routes 404 an out-of-scope job', async () => {
  route.scoped = false;
  assert.equal((await call('GET', '/jobs/482657/service-catalog')).status, 404);
  assert.equal((await call('PUT', '/jobs/482657/services', { services: [{ service_id: 25739, quantity: 2 }] })).status, 404);
  route.scoped = true;
});

test('the route rejects a malformed quantity with the plain quantity sentence', async () => {
  route.scoped = true;
  const r = await call('PUT', '/jobs/482657/services', { services: [{ service_id: 25739, quantity: 500 }] });
  assert.equal(r.status, 400);
  assert.ok(JSON.stringify(r.body).includes('Quantity must be a whole number from 1 to 100.'));
});

test('POST /jobs/:id/services is untouched — this round adds a writer, it does not change one', async () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../routes/admin/jobs.js'), 'utf8');
  const post = src.slice(src.indexOf("router.post('/:id/services',"), src.indexOf("router.get('/:id/service-catalog',"));
  assert.match(post, /ORDER BY job_service_id DESC LIMIT 1/, 'the existing add path keeps its current lookup');
});
