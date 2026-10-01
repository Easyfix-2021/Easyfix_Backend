/*
 * Add Remarks (POST /admin/jobs/:id/comments) stamps the job's stage.
 *
 * Legacy's saveJobComment (EasyFix_CRM JobDaoImpl.java:4565) wrote
 * tbl_job_comment.job_stage = the job's status on EVERY remark — 441,727 of
 * the legacy non-reschedule rows on QA carry one. The Node route stored NULL,
 * so the CRM's Stage column was blank for every remark it filed.
 *
 * The SERVER decides the value, from the row scopedJob already loaded: the
 * column is an int, while the route's schema still admits a string label from
 * the body. Real router, real scopedJob guard; getById and the pool are faked.
 * Runner: `node --test`.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installFakePool } = require('./helpers/fake-pool');

const scenario = { job: null };

const fake = installFakePool([
  // hasJobStageColumn's probe — the deploy HAS the column, or nothing is stamped.
  [/INFORMATION_SCHEMA[\s\S]*'tbl_job_comment'[\s\S]*'job_stage'/i, [{ 1: 1 }]],
  [/SHOW COLUMNS/i, []],
  [/INSERT INTO tbl_job_comment/i, () => ({ insertId: 555, affectedRows: 1 })],
  // addComment reads the row back and shapes it before returning.
  [/SELECT c\.comment_id AS id/i, [{ id: 555, job_id: 42, comments: 'x', comment_on: 1 }]],
]);

const job = require('../services/job.service');

const realGetById = job.getById;
job.getById = async (id) => ({ job_id: Number(id), fk_client_id: 5, city_id: 11, vertical_id: 3, ...scenario.job });

const jobsRouter = require('../routes/admin/jobs');
let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { user_id: 77, user_name: 'Sonam Patel', permissions: { menuIds: [], actionPermissions: [] } };
    req.userRole = { role_name: 'Admin' };
    const all = { mode: 'all', ids: [], placeholders: '' };
    req.scope = { clients: all, cities: all, states: all, verticals: all };
    req.allowedStages = null;
    next();
  });
  app.use('/jobs', jobsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { res.status(500).json({ error: String(err && err.message) }); });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  job.getById = realGetById;
  fake.restore();
});

beforeEach(() => {
  fake.calls.length = 0;
  scenario.job = { job_status: 20 };
});

async function addRemark(body) {
  const res = await fetch(`${baseUrl}/jobs/42/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ins = fake.calls.find((c) => /INSERT INTO tbl_job_comment/i.test(c.sql));
  let row = null;
  if (ins) {
    const cols = /\(([^)]+)\)\s*VALUES/i.exec(ins.sql)[1].split(',').map((s) => s.trim());
    row = Object.fromEntries(cols.map((c, i) => [c, ins.params[i]]));
  }
  return { status: res.status, row };
}

test('an Add Remarks row records the job\'s status as its stage', async () => {
  const { status, row } = await addRemark({ comments: 'Customer will be home after 6', comment_on: 1 });
  assert.equal(status, 201);
  assert.ok(row, 'the route must have written a row');
  assert.equal(row.job_stage, 20, 'the status scopedJob loaded (Pending to Close on App)');
  assert.equal(row.commented_by, 77);
});

test('status 0 survives the trip — it is Pending for Scheduling, not "not recorded"', async () => {
  scenario.job = { job_status: 0 };
  const { row } = await addRemark({ comments: 'x', comment_on: 1 });
  assert.equal(row.job_stage, 0);
});

test('the server\'s stage wins over one in the body', async () => {
  // The schema still admits a string label; the column is an int.
  const { status, row } = await addRemark({ comments: 'x', comment_on: 1, job_stage: 'Scheduled' });
  assert.equal(status, 201);
  assert.equal(row.job_stage, 20);
});

test('Unreachable / Enquiry outcomes keep addComment\'s pin to 9', async () => {
  const { row } = await addRemark({ comments: 'x', comment_on: 16 });
  assert.equal(row.job_stage, 9, 'addComment overrides 16/17 to CALL_LATER after the route stamps');
});
