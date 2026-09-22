/*
 * Material Request Flow v2 — 2026-09-22 amendment coverage:
 *
 *   - services/material-auto-schedule.service.js pure helpers: baseDate,
 *     startHourFor, findSlot.
 *   - NEW POST /admin/jobs/:id/client-approval-on-behalf.
 *   - All three approval surfaces (client portal, public magic-link, admin
 *     on-behalf) invoke the auto-schedule trigger exactly once; a scheduler
 *     failure never fails the approval response.
 *   - services/job.service.js#reschedule() clears a pending needs_scheduling
 *     flag on any successful reschedule.
 *
 * Runner: `node --test --test-force-exit tests/material-approval-auto-schedule.test.js`.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.WEBHOOK_OUTBOUND_ENABLED = 'false';

const { installFakePool } = require('./helpers/fake-pool');

// ═════════════════════════════════════════════════════════════════════════
// 1. Pure helpers — services/material-auto-schedule.service.js
// ═════════════════════════════════════════════════════════════════════════

const mas = require('../services/material-auto-schedule.service');

test('baseDate: 14:59 IST -> approval day + 1', () => {
  // 2026-09-22 14:59 IST = 2026-09-22 09:29 UTC.
  const at = new Date('2026-09-22T09:29:00.000Z');
  assert.equal(mas.baseDate(at), '2026-09-23');
});

test('baseDate: 15:00 IST -> approval day + 2', () => {
  // 2026-09-22 15:00 IST = 2026-09-22 09:30 UTC.
  const at = new Date('2026-09-22T09:30:00.000Z');
  assert.equal(mas.baseDate(at), '2026-09-24');
});

test('baseDate: UTC-midnight edge — 00:00 UTC is 05:30 IST, still "day + 1", not the naive UTC day', () => {
  // 2026-09-22T00:00:00Z is 2026-09-22 05:30 IST — same IST calendar day as
  // the UTC date, hour < 15, so day + 1. A naive (non-IST-aware) reader could
  // easily get this right by accident; the real trap is the NEXT test.
  const at = new Date('2026-09-22T00:00:00.000Z');
  assert.equal(mas.baseDate(at), '2026-09-23');
});

test('baseDate: UTC-midnight edge where the IST day has already rolled over', () => {
  // 2026-09-21T20:00:00Z is 2026-09-22 01:30 IST — a full IST calendar day
  // AHEAD of the UTC date. A naive UTC-day reader would answer 2026-09-22 (UTC
  // day + 1); the IST-correct answer is 2026-09-23 (IST day 2026-09-22 + 1).
  const at = new Date('2026-09-21T20:00:00.000Z');
  assert.equal(mas.baseDate(at), '2026-09-23');
});

test('startHourFor: midnight sentinel -> 9', () => {
  assert.equal(mas.startHourFor('2026-09-20 00:00:00'), 9);
});

test('startHourFor: no time at all -> 9', () => {
  assert.equal(mas.startHourFor(null), 9);
  assert.equal(mas.startHourFor('2026-09-20'), 9);
});

test('startHourFor: hour outside 9..18 -> 9', () => {
  assert.equal(mas.startHourFor('2026-09-20 21:00:00'), 9);
  assert.equal(mas.startHourFor('2026-09-20 04:00:00'), 9);
});

test('startHourFor: a valid slot-start hour passes through verbatim', () => {
  assert.equal(mas.startHourFor('2026-09-20 11:00:00'), 11);
  assert.equal(mas.startHourFor('2026-09-20 18:30:00'), 18);
});

test('findSlot: the requested (startDate, startHour) itself, when free', () => {
  const slot = mas.findSlot('2026-09-23', 11, new Set());
  assert.deepEqual(slot, { date: '2026-09-23', hour: 11 });
});

test('findSlot: skips a busy hour, takes the next free one the same day', () => {
  const busy = new Set(['2026-09-23|11', '2026-09-23|12']);
  const slot = mas.findSlot('2026-09-23', 11, busy);
  assert.deepEqual(slot, { date: '2026-09-23', hour: 13 });
});

test('findSlot: every hour busy through 18 on day 0 -> rolls to 9 the next day', () => {
  const busy = new Set();
  for (let h = 16; h <= 18; h++) busy.add(`2026-09-23|${h}`);
  const slot = mas.findSlot('2026-09-23', 16, busy);
  assert.deepEqual(slot, { date: '2026-09-24', hour: 9 });
});

test('findSlot: hour 18 is a valid slot — the day is not exhausted until AFTER it', () => {
  const busy = new Set();
  for (let h = 9; h <= 17; h++) busy.add(`2026-09-23|${h}`);
  const slot = mas.findSlot('2026-09-23', 9, busy);
  assert.deepEqual(slot, { date: '2026-09-23', hour: 18 }, '18 must still be checked, not just up to 17');
});

test('findSlot: 7-day exhaustion -> null', () => {
  const busy = new Set();
  for (let day = 0; day < 7; day++) {
    const date = mas.addDaysToDateStr('2026-09-23', day);
    for (let h = 9; h <= 18; h++) busy.add(`${date}|${h}`);
  }
  const slot = mas.findSlot('2026-09-23', 9, busy, 7);
  assert.equal(slot, null);
});

/*
 * MUTATION: changed findSlot's inner loop bound from `h <= 18` to `h <= 17`.
 * Re-ran — the "skips a busy hour" and "every hour busy" tests stayed GREEN
 * (neither exercises hour 18 specifically), but "hour 18 is a valid slot"
 * above went red (returned the next day instead of {date, hour: 18}) — which
 * is why that test is in the suite. Reverted.
 */

// ═════════════════════════════════════════════════════════════════════════
// 2. POST /admin/jobs/:id/client-approval-on-behalf — route-level behaviour
// ═════════════════════════════════════════════════════════════════════════

const JOB_ID = 9001;
const OPS_USER_ID = 88;

let jobFixture;
function makeJob(over = {}) {
  return {
    job_id: JOB_ID, job_status: 15, fk_client_id: 133, city_id: 11, vertical_id: 3,
    fk_easyfixter_id: 4242, requested_date_time: '2026-09-20 10:00:00', ...over,
  };
}

const fake = installFakePool([
  [/^\s*(SELECT|INSERT|UPDATE)/i, () => []],
]);

const job = require('../services/job.service');
const jobImageService = require('../services/job-image.service');
const jobComments = require('../services/job-comment.service');
const jobEstimateApproval = require('../services/job-estimate-approval');

const orig = {
  getById: job.getById,
  storeJobImageFile: jobImageService.storeJobImageFile,
  addComment: jobComments.addComment,
  approveEstimateLinesAndStatus: jobEstimateApproval.approveEstimateLinesAndStatus,
  afterApprovalCommitted: jobEstimateApproval.afterApprovalCommitted,
};

let storeCalls, commentCalls, approveCalls, afterCalls, afterResult;

function restoreMocks() {
  job.getById = orig.getById;
  jobImageService.storeJobImageFile = orig.storeJobImageFile;
  jobComments.addComment = orig.addComment;
  jobEstimateApproval.approveEstimateLinesAndStatus = orig.approveEstimateLinesAndStatus;
  jobEstimateApproval.afterApprovalCommitted = orig.afterApprovalCommitted;
}

function installMocks() {
  job.getById = async () => jobFixture;
  jobImageService.storeJobImageFile = async ({ jobId, file, category, contentType }) => {
    storeCalls.push({ jobId, category, contentType, originalname: file.originalname });
    return { image_id: storeCalls.length, job_id: jobId, image_category: category, mime_type: contentType };
  };
  jobComments.addComment = async (jobId, payload) => { commentCalls.push({ jobId, payload }); return { comment_id: 1 }; };
  jobEstimateApproval.approveEstimateLinesAndStatus = async (conn, jobId, actor) => {
    approveCalls.push({ jobId, actor });
    jobFixture = makeJob({ job_status: 1 });
  };
  jobEstimateApproval.afterApprovalCommitted = async (jobId) => {
    afterCalls.push(jobId);
    return afterResult;
  };
}

const app = express();
app.use((req, _res, next) => {
  req.user = { user_id: OPS_USER_ID, user_name: 'PM Tester', permissions: { menuIds: [], actionPermissions: ['isJobMaterialReview'] } };
  req.userRole = { role_name: 'Project Manager' };
  req.scope = {
    clients: { mode: 'all', ids: [], placeholders: '' }, cities: { mode: 'all', ids: [], placeholders: '' },
    states: { mode: 'all', ids: [], placeholders: '' }, verticals: { mode: 'all', ids: [], placeholders: '' },
  };
  req.allowedStages = null;
  next();
});
app.use('/jobs', require('../routes/admin/jobs'));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => res.status(500).json({ error: String(err && err.message) }));

const appNoAction = express();
appNoAction.use((req, _res, next) => {
  req.user = { user_id: OPS_USER_ID, permissions: { menuIds: [], actionPermissions: [] } };
  req.userRole = { role_name: 'Project Manager' };
  req.scope = { clients: { mode: 'all', ids: [] }, cities: { mode: 'all', ids: [] }, states: { mode: 'all', ids: [] }, verticals: { mode: 'all', ids: [] } };
  req.allowedStages = null;
  next();
});
appNoAction.use('/jobs', require('../routes/admin/jobs'));

let server, baseUrl, serverNoAction, baseUrlNoAction;
before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => { serverNoAction = appNoAction.listen(0, resolve); });
  baseUrlNoAction = `http://127.0.0.1:${serverNoAction.address().port}`;
});
after(async () => {
  if (server) server.close();
  if (serverNoAction) serverNoAction.close();
  restoreMocks();
  await new Promise((resolve) => setImmediate(resolve));
  fake.restore();
});

beforeEach(() => {
  fake.calls.length = 0;
  jobFixture = makeJob();
  storeCalls = []; commentCalls = []; approveCalls = []; afterCalls = [];
  afterResult = { rescheduled: true, requestedDateTime: '2026-09-23 09:00:00', needsScheduling: false };
  installMocks();
});

function smallAudio(name = 'call.mp3', mimetype = 'audio/mpeg', size = 1000) {
  return { data: Buffer.alloc(size, 1), name, type: mimetype };
}

async function postApproval(baseUrlTarget, { comment, files } = {}) {
  const form = new FormData();
  if (comment !== undefined) form.append('comment', comment);
  for (const f of (files || [])) {
    form.append('files', new Blob([f.data], { type: f.type }), f.name);
  }
  const res = await fetch(`${baseUrlTarget}/jobs/${JOB_ID}/client-approval-on-behalf`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('client-approval-on-behalf: 403 without isJobMaterialReview', async () => {
  const res = await postApproval(baseUrlNoAction, { comment: 'Approved over phone call', files: [smallAudio()] });
  assert.equal(res.status, 403);
});

test('client-approval-on-behalf: 409 when job is not at status 15', async () => {
  jobFixture = makeJob({ job_status: 2 });
  const res = await postApproval(baseUrl, { comment: 'Approved over phone call', files: [smallAudio()] });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(res.body.error || '', /not waiting for client approval/);
});

test('client-approval-on-behalf: 400 without a comment', async () => {
  const res = await postApproval(baseUrl, { files: [smallAudio()] });
  assert.equal(res.status, 400, JSON.stringify(res.body));
});

test('client-approval-on-behalf: 400 with a comment shorter than 10 chars', async () => {
  const res = await postApproval(baseUrl, { comment: 'ok', files: [smallAudio()] });
  assert.equal(res.status, 400, JSON.stringify(res.body));
});

test('client-approval-on-behalf: 400 without any file', async () => {
  const res = await postApproval(baseUrl, { comment: 'Approved over phone call', files: [] });
  assert.equal(res.status, 400, JSON.stringify(res.body));
});

/*
 * MUTATION: made clientApprovalProofError() return null unconditionally (no
 * type/extension check at all). Re-ran — both this test and the
 * mismatch test below went red (200 instead of 400). Reverted.
 */
test('client-approval-on-behalf: 400 on a bad mimetype', async () => {
  const res = await postApproval(baseUrl, {
    comment: 'Approved over phone call',
    files: [smallAudio('malware.exe', 'application/x-msdownload')],
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(storeCalls.length, 0, 'must not store anything once one file fails validation');
});

test('client-approval-on-behalf: 400 on a mimetype/extension mismatch', async () => {
  const res = await postApproval(baseUrl, {
    comment: 'Approved over phone call',
    files: [smallAudio('call.wav', 'audio/mpeg')], // .wav name, mp3 mimetype
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
});

test('client-approval-on-behalf: 400 when a file exceeds 10MB', async () => {
  const res = await postApproval(baseUrl, {
    comment: 'Approved over phone call',
    files: [smallAudio('big.mp3', 'audio/mpeg', 11 * 1024 * 1024)],
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(res.body.error || '', /10MB/);
});

test('client-approval-on-behalf: happy path stores files, adds the prefixed comment, calls the shared approval helper once, and returns the schedule', async () => {
  const res = await postApproval(baseUrl, {
    comment: 'Client confirmed over a phone call',
    files: [smallAudio('call.mp3', 'audio/mpeg'), smallAudio('screenshot.png', 'image/png')],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(storeCalls.length, 2, 'both files stored');
  assert.ok(storeCalls.every((c) => c.category === 'ClientApprovalProof'));
  assert.equal(commentCalls.length, 1);
  assert.equal(commentCalls[0].payload.comments, "Approved on client's behalf: Client confirmed over a phone call");
  assert.equal(commentCalls[0].payload.commented_by, OPS_USER_ID);
  assert.equal(approveCalls.length, 1, 'the shared approval helper runs exactly once');
  assert.equal(approveCalls[0].actor.user_id, OPS_USER_ID);
  assert.equal(afterCalls.length, 1, 'the post-commit scheduler trigger runs exactly once');
  assert.equal(res.body.data.job_status, 1);
  assert.deepEqual(res.body.data.schedule, {
    rescheduled: true, requested_date_time: '2026-09-23 09:00:00', needs_scheduling: false,
  });
});

/*
 * MUTATION (actually run, not just described): replaced the
 * `Number(req.scopedJob.job_status) !== job.STATUS.ESTIMATE_PENDING_APPROVAL`
 * guard's condition with `false`. Re-ran — "409 when job is not at status 15"
 * went red (200 instead of 409). Reverted.
 */

// ═════════════════════════════════════════════════════════════════════════
// 3. All three approval surfaces invoke the scheduler; a scheduler failure
//    never fails the approval.
// ═════════════════════════════════════════════════════════════════════════

const materialAutoSchedule = require('../services/material-auto-schedule.service');
const origScheduleAfterApproval = materialAutoSchedule.scheduleAfterApproval;
let scheduleCalls;

function mockScheduler(behavior) {
  scheduleCalls = [];
  materialAutoSchedule.scheduleAfterApproval = async (jobId) => {
    scheduleCalls.push(jobId);
    if (behavior === 'throw') throw new Error('simulated scheduler crash');
    return { rescheduled: true, requestedDateTime: '2026-09-23 09:00:00', needsScheduling: false };
  };
}
function restoreScheduler() { materialAutoSchedule.scheduleAfterApproval = origScheduleAfterApproval; }

test('on-behalf approval: the real afterApprovalCommitted invokes the scheduler exactly once', async () => {
  jobEstimateApproval.afterApprovalCommitted = orig.afterApprovalCommitted; // use the REAL wrapper for this test
  mockScheduler('ok');
  try {
    const res = await postApproval(baseUrl, {
      comment: 'Client confirmed over a phone call',
      files: [smallAudio()],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(scheduleCalls.length, 1);
    assert.equal(scheduleCalls[0], JOB_ID);
  } finally {
    restoreScheduler();
    installMocks(); // put the isolating mocks back for later tests in section 2's describe scope
  }
});

test('on-behalf approval: a scheduler crash does not fail the approval response', async () => {
  jobEstimateApproval.afterApprovalCommitted = orig.afterApprovalCommitted;
  mockScheduler('throw');
  try {
    const res = await postApproval(baseUrl, {
      comment: 'Client confirmed over a phone call',
      files: [smallAudio()],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.schedule.needs_scheduling, true, 'a failed scheduler still reports needs_scheduling');
    assert.equal(scheduleCalls.length, 1);
  } finally {
    restoreScheduler();
    installMocks();
  }
});

// ── Client portal + public magic-link approve — reuse the SAME
// afterApprovalCommitted wrapper (never a second copy), so proving they call
// it is proving they call the scheduler too.

const clientRouter = require('../routes/client/index');
const publicEstimateRouter = require('../routes/public/estimate.js');
const jwt = require('jsonwebtoken');

function handlerFor(router, routePath, method) {
  const layer = router.stack.find((e) => e.route && e.route.path === routePath && e.route.methods[method]);
  if (!layer) throw new Error(`${method.toUpperCase()} ${routePath} not mounted`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function mockRes() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
async function callClient() {
  const r = mockRes();
  await handlerFor(clientRouter, '/jobs/:id/estimate/approve', 'patch')(
    { spoc: { id: 42, client_id: 133 }, access: { allStores: true }, query: {}, params: { id: String(JOB_ID) }, body: {} },
    r, (e) => { throw e; },
  );
  return r;
}
function mintEstimateToken(jobId, clientContactId = null) {
  return jwt.sign({ sub: String(jobId), clientContactId }, process.env.JWT_SECRET);
}
async function callPublic() {
  const r = mockRes();
  await handlerFor(publicEstimateRouter, '/:token/approve', 'patch')(
    { params: { token: mintEstimateToken(JOB_ID, 42) }, body: {} },
    r, (e) => { throw e; },
  );
  return r;
}

// A separate, permissive fake-pool config the client/public approve handlers
// need for their own row lookups — same shape as
// tests/material-request-flow-v2-admin.test.js's proven config, trimmed to
// just the approve path.
test('client portal approve invokes the scheduler exactly once (via the shared afterApprovalCommitted)', async () => {
  jobFixture = makeJob({ job_status: 15 });
  mockScheduler('ok');
  const origLoadJobInScope = require('../routes/client/index');
  try {
    // loadJobInScope reads via pool directly; our catch-all fake pool answers
    // every SELECT with [] by default, so seed the specific row lookups the
    // approve handler needs.
    fake.calls.length = 0;
    const db = require('../db');
    const realQuery = db.pool.query;
    db.pool.query = async (sql, params) => {
      const text = Array.isArray(sql) ? String(sql[0]) : String(sql);
      if (/SELECT user_id FROM tbl_client_contacts WHERE id\s*=\s*\?/i.test(text)) return [[{ user_id: 555 }], []];
      if (/FROM tbl_job[\s\S]*WHERE[\s\S]*job_id\s*=\s*\?/i.test(text) || /SELECT j\.\*/i.test(text)) return [[jobFixture], []];
      return realQuery(sql, params);
    };
    try {
      const r = await callClient();
      assert.equal(r.body?.success, true, JSON.stringify(r.body));
    } finally {
      db.pool.query = realQuery;
    }
    assert.equal(scheduleCalls.length, 1, JSON.stringify(scheduleCalls));
  } finally {
    restoreScheduler();
  }
  void origLoadJobInScope;
});

test('public magic-link approve invokes the scheduler exactly once (via the shared afterApprovalCommitted)', async () => {
  jobFixture = makeJob({ job_status: 15 });
  mockScheduler('ok');
  try {
    const db = require('../db');
    const realQuery = db.pool.query;
    db.pool.query = async (sql, params) => {
      const text = Array.isArray(sql) ? String(sql[0]) : String(sql);
      if (/SELECT user_id FROM tbl_client_contacts WHERE id\s*=\s*\?/i.test(text)) return [[{ user_id: 555 }], []];
      if (/SELECT job_id, job_status, approved_on_date_time, approval_reject_date_time/i.test(text)) return [[jobFixture], []];
      if (/FROM tbl_job\b(?!_)[\s\S]{0,500}job_id\s*=\s*\?/i.test(text)) return [[jobFixture], []];
      return realQuery(sql, params);
    };
    try {
      const r = await callPublic();
      assert.equal(r.statusCode ?? 200, 200, JSON.stringify(r.body));
    } finally {
      db.pool.query = realQuery;
    }
    assert.equal(scheduleCalls.length, 1, JSON.stringify(scheduleCalls));
  } finally {
    restoreScheduler();
  }
});

// ═════════════════════════════════════════════════════════════════════════
// 4. services/job.service.js#reschedule() clears a pending needs_scheduling
//    flag on any successful reschedule.
// ═════════════════════════════════════════════════════════════════════════

test("reschedule() clears the job's needs_scheduling flag", async () => {
  const db = require('../db');
  const realQuery = db.pool.query;
  const clearCalls = [];
  db.pool.query = async (sql, params) => {
    const text = Array.isArray(sql) ? String(sql[0]) : String(sql);
    if (/^\s*UPDATE tbl_job_auto_schedule SET cleared_at/i.test(text)) {
      clearCalls.push({ sql: text, params });
      return [{ affectedRows: 1 }, []];
    }
    if (/SELECT job_id, fk_easyfixter_id, time_slot, scheduled_date_time, fk_scheduled_by FROM tbl_job/i.test(text)) {
      return [[{ job_id: JOB_ID, fk_easyfixter_id: 4242, time_slot: null, scheduled_date_time: null, fk_scheduled_by: null }], []];
    }
    return [[], []];
  };
  const realAddComment = jobComments.addComment;
  jobComments.addComment = async () => ({ comment_id: 1 });
  try {
    await job.reschedule(JOB_ID, {
      requestedDateTime: '2026-09-24 11:00', reasonId: null, rescheduleReason: 'test', remarks: 'test remark',
    }, null);
  } finally {
    db.pool.query = realQuery;
    jobComments.addComment = realAddComment;
  }
  assert.equal(clearCalls.length, 1, 'reschedule must clear the auto-schedule flag exactly once');
  assert.equal(clearCalls[0].params[1], JOB_ID);
});

/*
 * MUTATION (actually run): removed the tbl_job_auto_schedule UPDATE block
 * from job.service.js#reschedule(). Re-ran — this test went red (0 clear
 * calls instead of 1). Reverted.
 */
