/*
 * Material Request Flow v2 — 2026-09-22 owner correction coverage:
 *
 *   - services/visit-slots.service.js: listVisitSlots (past-hour omission in
 *     IST, incl. a UTC-date-boundary case; busy frames; no-technician ->
 *     all free) and assertSlotBookable (400/400/409).
 *   - services/job-estimate-approval.js#validatePermissionChoice (sync).
 *   - All three approve surfaces (admin on-behalf, client portal, public
 *     magic-link) require visit_date_time/permission/permission_file,
 *     validate BEFORE any write, reschedule to exactly the chosen slot, and
 *     raise the right permission-request row per choice.
 *   - job.service.js#reschedule() no longer touches the removed
 *     tbl_job_auto_schedule table (regression guard).
 *
 * Runner: `node --test --test-force-exit tests/visit-slots-and-material-approval.test.js`.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.WEBHOOK_OUTBOUND_ENABLED = 'false';

const { installFakePool } = require('./helpers/fake-pool');

// ═════════════════════════════════════════════════════════════════════════
// Shared fake pool — every DB read the code under test issues (job lookups,
// busy-frame checks, the approval txn's quotation_details stamp, the reason
// lookup). `state` is mutated per test to control what each route answers.
// ═════════════════════════════════════════════════════════════════════════
const JOB_ID = 9101;
const state = { technicianId: 4242, busyHour: null, busyRows: [] };

const fake = installFakePool([
  [/^SELECT fk_easyfixter_id FROM tbl_job/, () => [{ fk_easyfixter_id: state.technicianId }]],
  [/^SELECT requested_date_time FROM tbl_job/, () => state.busyRows],
  [/^SELECT 1 FROM tbl_job/, (sql, params) => {
    // params: [technicianId, jobId, date, hour] — busy iff this exact
    // (date, hour) is the one the test flagged.
    const [, , date, hour] = params;
    return (state.busyHour && state.busyHour.date === date && state.busyHour.hour === hour) ? [{ 1: 1 }] : [];
  }],
  [/^SELECT id FROM action_taken_reason/, () => [{ id: 555 }]],
  [/^UPDATE quotation_details/, () => []],
  // The public magic-link approve route's OWN direct job lookup (it doesn't
  // go through jobService.getById) — answered from the same `jobFixture`
  // the deep-mocks section below maintains.
  [/^SELECT job_id, job_status, approved_on_date_time, approval_reject_date_time, fk_easyfixter_id[\s\S]*FROM tbl_job/,
    () => [jobFixture]],
]);

after(() => { fake.restore(); });
beforeEach(() => {
  fake.reset();
  state.technicianId = 4242;
  state.busyHour = null;
  state.busyRows = [];
});

// ═════════════════════════════════════════════════════════════════════════
// 1. services/visit-slots.service.js — pure-ish, DB-mocked
// ═════════════════════════════════════════════════════════════════════════

const visitSlots = require('../services/visit-slots.service');

test('listVisitSlots: no technician -> every hour in the window is free', async () => {
  state.technicianId = null;
  const now = new Date('2026-09-22T09:00:00.000Z'); // 2026-09-22 14:30 IST
  const result = await visitSlots.listVisitSlots(JOB_ID, { days: 2, now });
  assert.equal(result.technician_id, null);
  assert.equal(result.days.length, 2);
  for (const day of result.days) {
    for (const h of day.hours) assert.equal(h.free, true, `${day.date} ${h.hour} must be free with no technician`);
  }
});

test('listVisitSlots: today omits hours at or before the current IST hour', async () => {
  // 2026-09-22T09:00:00Z = 2026-09-22 14:30 IST -> current IST hour 14.
  const now = new Date('2026-09-22T09:00:00.000Z');
  const result = await visitSlots.listVisitSlots(JOB_ID, { days: 1, now });
  const today = result.days[0];
  assert.equal(today.date, '2026-09-22');
  assert.ok(!today.hours.some((h) => h.hour <= 14), 'hours <= 14 must be omitted (past)');
  assert.ok(today.hours.some((h) => h.hour === 15), 'hour 15 (future) must remain');
});

/*
 * THE UTC-date-boundary case: 2026-09-21T20:00:00Z is 2026-09-22 01:30 IST —
 * a full IST calendar day AHEAD of the UTC date. A naive (non-IST-aware)
 * reader would answer "today = 2026-09-21"; the IST-correct answer is
 * 2026-09-22, with only hour 0 (a slot before 9 AM does not exist) past —
 * i.e. every SLOT_START_HOURS entry (9..18) survives since current hour is 1.
 */
test('listVisitSlots: UTC-date-boundary — IST day has already rolled over', async () => {
  const now = new Date('2026-09-21T20:00:00.000Z');
  const result = await visitSlots.listVisitSlots(JOB_ID, { days: 1, now });
  assert.equal(result.days[0].date, '2026-09-22', 'IST date must be the day AHEAD of the UTC date');
  assert.equal(result.days[0].hours.length, 10, 'current IST hour is 1 — none of 9..18 are past yet');
});

test('listVisitSlots: marks a busy technician frame, and only that one', async () => {
  const now = new Date('2026-09-22T03:00:00.000Z'); // 08:30 IST
  state.busyRows = [{ requested_date_time: '2026-09-22 11:00:00' }, { requested_date_time: '2026-09-23 14:00:00' }];
  const result = await visitSlots.listVisitSlots(JOB_ID, { days: 2, now });
  const hour = (date, h) => result.days.find((d) => d.date === date).hours.find((x) => x.hour === h);
  assert.equal(hour('2026-09-22', 11).free, false);
  assert.equal(hour('2026-09-22', 12).free, true, 'neighbouring hour must stay free — no sliding window');
  assert.equal(hour('2026-09-23', 14).free, false);
});

/*
 * MUTATION (actually run): changed the busy-frame filter's date comparison
 * from `date === startDate` to always-false (so today's hours were NEVER
 * checked for the current-hour cutoff and hour<=0 rule stopped applying to
 * day 0). Re-ran "today omits hours" above — went red (hour 9 appeared on
 * the current day even though the current hour was 14). Reverted.
 */

test('assertSlotBookable: bad format -> 400 "Pick a visit time between 9 AM and 6 PM"', async () => {
  await assert.rejects(
    () => visitSlots.assertSlotBookable(JOB_ID, '2026-09-23 10:00', new Date('2026-09-22T03:00:00.000Z')),
    (e) => { assert.equal(e.status, 400); assert.match(e.message, /9 AM and 6 PM/); return true; },
  );
});

test('assertSlotBookable: hour outside 9..18 -> 400', async () => {
  await assert.rejects(
    () => visitSlots.assertSlotBookable(JOB_ID, '2026-09-23 19:00:00', new Date('2026-09-22T03:00:00.000Z')),
    (e) => { assert.equal(e.status, 400); assert.match(e.message, /9 AM and 6 PM/); return true; },
  );
});

test('assertSlotBookable: the current IST hour today -> 400 "Pick a future visit time within 30 days"', async () => {
  const now = new Date('2026-09-22T09:00:00.000Z'); // 14:30 IST -> current hour 14
  await assert.rejects(
    () => visitSlots.assertSlotBookable(JOB_ID, '2026-09-22 14:00:00', now),
    (e) => { assert.equal(e.status, 400); assert.match(e.message, /within 30 days/); return true; },
  );
});

test('assertSlotBookable: beyond the 30-day window -> 400', async () => {
  const now = new Date('2026-09-22T03:00:00.000Z');
  await assert.rejects(
    () => visitSlots.assertSlotBookable(JOB_ID, '2026-10-25 10:00:00', now),
    (e) => { assert.equal(e.status, 400); assert.match(e.message, /within 30 days/); return true; },
  );
});

test('assertSlotBookable: technician already booked that frame -> 409', async () => {
  const now = new Date('2026-09-22T03:00:00.000Z');
  state.busyHour = { date: '2026-09-23', hour: 10 };
  await assert.rejects(
    () => visitSlots.assertSlotBookable(JOB_ID, '2026-09-23 10:00:00', now),
    (e) => { assert.equal(e.status, 409); assert.match(e.message, /pick another/); return true; },
  );
});

test('assertSlotBookable: resolves (no throw) on a free, future, in-window slot', async () => {
  const now = new Date('2026-09-22T03:00:00.000Z');
  await visitSlots.assertSlotBookable(JOB_ID, '2026-09-23 10:00:00', now);
});

test('assertSlotBookable: no technician -> every hour free, no 409 possible', async () => {
  state.technicianId = null;
  const now = new Date('2026-09-22T03:00:00.000Z');
  await visitSlots.assertSlotBookable(JOB_ID, '2026-09-23 10:00:00', now);
});

/*
 * MUTATION (actually run): removed the `if (!j.fk_easyfixter_id) return;`
 * early-out in assertSlotBookable. Re-ran the full file — every test STAYED
 * GREEN, including "no technician" above. Root cause, not a test gap: in
 * real MySQL `fk_easyfixter_id = NULL` is never TRUE (three-valued SQL
 * logic), so the busy-check query would return zero rows on its own even
 * without the early return — the guard is a pure "skip a query we know is
 * pointless" optimisation, not a correctness dependency, and this fake pool
 * (plain JS equality, not SQL NULL semantics) cannot exercise the
 * difference either way. Reverted; noted here rather than left silently
 * unconfirmed, per the "don't claim a mutation you didn't run" rule.
 */
test('assertSlotBookable: mutation-sensitive — busy-check must be SKIPPED with no technician (proves the early-out, not just its outcome)', async () => {
  state.technicianId = null;
  const now = new Date('2026-09-22T03:00:00.000Z');
  const db = require('../db');
  const realQuery = db.pool.query;
  let busyCheckRan = false;
  db.pool.query = async (sql, params) => {
    const text = Array.isArray(sql) ? String(sql[0]) : String(sql);
    if (/^SELECT 1 FROM tbl_job/.test(text)) busyCheckRan = true;
    return realQuery(sql, params);
  };
  try {
    await visitSlots.assertSlotBookable(JOB_ID, '2026-09-23 10:00:00', now);
  } finally {
    db.pool.query = realQuery;
  }
  assert.equal(busyCheckRan, false, 'no technician means nothing to conflict with — the busy query must not even run');
});
/*
 * MUTATION (actually run): removed the early-out again, this time re-running
 * JUST the test above. Went red (busyCheckRan === true). This is the
 * positive control the earlier note was missing — the SAME code change now
 * has a check that observes the mechanism (does the query run) rather than
 * only an outcome a mocked backend can't tell apart. Reverted.
 */

// ═════════════════════════════════════════════════════════════════════════
// 2. services/job-estimate-approval.js#validatePermissionChoice — sync, no DB
// ═════════════════════════════════════════════════════════════════════════

const jobEstimateApproval = require('../services/job-estimate-approval');

test('validatePermissionChoice: unknown choice -> 400', () => {
  assert.throws(() => jobEstimateApproval.validatePermissionChoice('soon', null), (e) => e.status === 400);
});

test('validatePermissionChoice: "now" without a file -> 400', () => {
  assert.throws(() => jobEstimateApproval.validatePermissionChoice('now', null), (e) => e.status === 400);
});

test('validatePermissionChoice: "now" with an unsupported mimetype -> 400', () => {
  assert.throws(
    () => jobEstimateApproval.validatePermissionChoice('now', { originalname: 'x.exe', mimetype: 'application/x-msdownload', size: 100 }),
    (e) => e.status === 400,
  );
});

test('validatePermissionChoice: "now" with a mimetype/extension mismatch -> 400', () => {
  assert.throws(
    () => jobEstimateApproval.validatePermissionChoice('now', { originalname: 'x.png', mimetype: 'application/pdf', size: 100 }),
    (e) => e.status === 400,
  );
});

test('validatePermissionChoice: "now" with a heic file -> accepted (no throw)', () => {
  const r = jobEstimateApproval.validatePermissionChoice('now', { originalname: 'x.heic', mimetype: 'image/heic', size: 100 });
  assert.equal(r.choice, 'now');
});

test('validatePermissionChoice: "later"/"not_required" never require a file', () => {
  assert.deepEqual(jobEstimateApproval.validatePermissionChoice('later', null), { choice: 'later', file: null });
  assert.deepEqual(jobEstimateApproval.validatePermissionChoice('not_required', null), { choice: 'not_required', file: null });
});

// ═════════════════════════════════════════════════════════════════════════
// 3. Deep-dependency mocks shared by every route test below. job.service and
// job-permission-request.service are always require()'d LAZILY inside
// approveWithVisitSchedule, so monkey-patching their exported properties
// works regardless of module-load order or which test file ran first —
// same pattern this suite's predecessor used for scheduleAfterApproval.
// ═════════════════════════════════════════════════════════════════════════

const jobService = require('../services/job.service');
const permissionRequests = require('../services/job-permission-request.service');
const jobComments = require('../services/job-comment.service');
const jobImageService = require('../services/job-image.service');

const orig = {
  getById: jobService.getById,
  setStatus: jobService.setStatus,
  reschedule: jobService.reschedule,
  raiseForApproval: permissionRequests.raiseForApproval,
  addComment: jobComments.addComment,
  storeJobImageFile: jobImageService.storeJobImageFile,
};

function restoreDeepMocks() {
  jobService.getById = orig.getById;
  jobService.setStatus = orig.setStatus;
  jobService.reschedule = orig.reschedule;
  permissionRequests.raiseForApproval = orig.raiseForApproval;
  jobComments.addComment = orig.addComment;
  jobImageService.storeJobImageFile = orig.storeJobImageFile;
}

let jobFixture, setStatusCalls, rescheduleCalls, raiseCalls, rescheduleBehavior, raiseBehavior;

function makeJob(over = {}) {
  return {
    job_id: JOB_ID, job_status: 15, fk_client_id: 133, city_id: 11, vertical_id: 3,
    fk_easyfixter_id: 4242, approved_on_date_time: null, approval_reject_date_time: null,
    reporting_contact_id: 1, ...over,
  };
}

function installDeepMocks() {
  jobFixture = makeJob();
  setStatusCalls = []; rescheduleCalls = []; raiseCalls = [];
  rescheduleBehavior = 'ok'; raiseBehavior = 'ok';

  jobService.getById = async () => jobFixture;
  jobImageService.storeJobImageFile = async ({ jobId, file, category, contentType }) => ({
    image_id: 1, job_id: jobId, image_category: category, mime_type: contentType, originalname: file.originalname,
  });
  jobComments.addComment = async () => ({ comment_id: 1 });
  jobService.setStatus = async (jobId, patch) => {
    setStatusCalls.push({ jobId, patch });
    jobFixture = makeJob({ job_status: patch.status });
  };
  jobService.reschedule = async (jobId, payload, actor) => {
    rescheduleCalls.push({ jobId, payload, actor });
    if (rescheduleBehavior === 'throw') throw new Error('simulated reschedule failure');
    return makeJob({ job_status: 1 });
  };
  permissionRequests.raiseForApproval = async (args) => {
    raiseCalls.push(args);
    if (raiseBehavior === 'throw') throw new Error('simulated permission-request failure');
    if (raiseBehavior === 'no-technician') return null;
    return { requestId: 777 };
  };
}

// ═════════════════════════════════════════════════════════════════════════
// 4. POST /admin/jobs/:id/client-approval-on-behalf
// ═════════════════════════════════════════════════════════════════════════

const OPS_USER_ID = 88;
const NOW_IST_MORNING = new Date('2026-09-22T03:00:00.000Z'); // 08:30 IST — every SLOT_START_HOURS entry today is future

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
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, error: String(err && err.message) }));

let server, baseUrl;
before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) server.close();
  restoreDeepMocks();
  await new Promise((resolve) => setImmediate(resolve));
});

beforeEach(() => { installDeepMocks(); });

function smallAudio(name = 'call.mp3', mimetype = 'audio/mpeg', size = 1000) {
  return { data: Buffer.alloc(size, 1), name, type: mimetype };
}
function smallImage(name = 'permit.png', mimetype = 'image/png', size = 500) {
  return { data: Buffer.alloc(size, 2), name, type: mimetype };
}

async function postApproval(fields = {}, opts = {}) {
  const form = new FormData();
  form.append('comment', fields.comment ?? 'Client confirmed over a phone call');
  for (const f of (opts.proofFiles || [smallAudio()])) {
    form.append('files', new Blob([f.data], { type: f.type }), f.name);
  }
  if (fields.visit_date_time !== undefined) form.append('visit_date_time', fields.visit_date_time);
  if (fields.permission !== undefined) form.append('permission', fields.permission);
  if (opts.permissionFile) form.append('permission_file', new Blob([opts.permissionFile.data], { type: opts.permissionFile.type }), opts.permissionFile.name);
  const res = await fetch(`${baseUrl}/jobs/${JOB_ID}/client-approval-on-behalf`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/*
 * A slot that is ALWAYS in the future, whenever this suite runs.
 *
 * The routes below validate the requested time against the REAL clock (unlike
 * visitSlots.assertSlotBookable further up, which takes an injectable `now` —
 * those tests keep their pinned dates on purpose). A hardcoded date here is a
 * time bomb: this file pinned '2026-09-23 10:00:00' while it was written on
 * 2026-09-22, and every approval test went red the following day with "Pick a
 * future visit time within 30 days" — on Production too, which blocked a
 * release PR for work that never touched this area. Derive it instead:
 * tomorrow, 10:00 IST (a SLOT_START_HOURS entry, well inside the 30-day window).
 *
 * TZ-independent: npm test runs with TZ=UTC but a developer may not, so shift
 * to the IST wall clock explicitly and read it back with getUTC*.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const VALID_SLOT_HOUR = 10;
function istTomorrow() {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  ist.setUTCDate(ist.getUTCDate() + 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${ist.getUTCFullYear()}-${p(ist.getUTCMonth() + 1)}-${p(ist.getUTCDate())}`;
}
const VALID_SLOT_DATE = istTomorrow();
const VALID_SLOT = `${VALID_SLOT_DATE} ${String(VALID_SLOT_HOUR).padStart(2, '0')}:00:00`;

test('on-behalf: 400 without visit_date_time', async () => {
  const res = await postApproval({ permission: 'not_required' });
  assert.equal(res.status, 400, JSON.stringify(res.body));
});

test('on-behalf: 400 with a bad permission value', async () => {
  const res = await postApproval({ visit_date_time: VALID_SLOT, permission: 'soon' });
  assert.equal(res.status, 400, JSON.stringify(res.body));
});

test('on-behalf: 400 when permission=now and no permission_file is attached', async () => {
  const res = await postApproval({ visit_date_time: VALID_SLOT, permission: 'now' });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(setStatusCalls.length, 0, 'must not write anything before validation passes');
});

test('on-behalf: nothing is written when a 400 fires before any write', async () => {
  await postApproval({ visit_date_time: 'garbage', permission: 'not_required' });
  assert.equal(setStatusCalls.length, 0);
  assert.equal(rescheduleCalls.length, 0);
  assert.equal(raiseCalls.length, 0);
});

test('on-behalf: 409 when the chosen slot is already booked', async () => {
  state.busyHour = { date: VALID_SLOT_DATE, hour: VALID_SLOT_HOUR };
  const res = await postApproval({ visit_date_time: VALID_SLOT, permission: 'not_required' });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(setStatusCalls.length, 0, 'busy slot must be caught before any write');
});

test('on-behalf: happy path — approves, reschedules to exactly the chosen slot, permission=not_required raises nothing', async () => {
  const res = await postApproval({ visit_date_time: VALID_SLOT, permission: 'not_required' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(setStatusCalls.length, 1);
  assert.equal(rescheduleCalls.length, 1);
  assert.equal(rescheduleCalls[0].payload.requestedDateTime, VALID_SLOT);
  assert.equal(rescheduleCalls[0].payload.rescheduleReason, 'Material Approved — Visit Chosen');
  assert.equal(rescheduleCalls[0].actor.user_id, OPS_USER_ID, 'the CRM user is the reschedule actor on this path');
  assert.equal(raiseCalls.length, 0, 'not_required must never raise a permission request');
  assert.equal(res.body.data.visit_date_time, VALID_SLOT);
  assert.deepEqual(res.body.data.permission, { choice: 'not_required', request_id: null });
  assert.equal(res.body.data.schedule_error, null);
  assert.equal(res.body.data.permission_error, null);
});

test('on-behalf: permission=later raises an OPEN request, never fulfilled', async () => {
  const res = await postApproval({ visit_date_time: VALID_SLOT, permission: 'later' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(raiseCalls.length, 1);
  assert.equal(raiseCalls[0].fulfilNow, false);
  assert.equal(raiseCalls[0].efrId, jobFixture.fk_easyfixter_id ?? 4242);
  assert.equal(res.body.data.permission.choice, 'later');
  assert.equal(res.body.data.permission.request_id, 777);
});

test('on-behalf: permission=now raises AND immediately fulfils with the permission_file', async () => {
  const res = await postApproval(
    { visit_date_time: VALID_SLOT, permission: 'now' },
    { permissionFile: smallImage() },
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(raiseCalls.length, 1);
  assert.equal(raiseCalls[0].fulfilNow, true);
  assert.ok(raiseCalls[0].file, 'the permission_file must be handed to raiseForApproval');
  assert.equal(raiseCalls[0].fileContentType, 'image/png');
  assert.equal(res.body.data.permission.choice, 'now');
  assert.equal(res.body.data.permission.request_id, 777);
});

test('on-behalf: a post-commit reschedule failure is surfaced, not swallowed', async () => {
  rescheduleBehavior = 'throw';
  const res = await postApproval({ visit_date_time: VALID_SLOT, permission: 'not_required' });
  assert.equal(res.status, 200, JSON.stringify(res.body), 'the approval itself already committed');
  assert.match(res.body.data.schedule_error || '', /simulated reschedule failure/);
});

/*
 * MUTATION (actually run): made approveWithVisitSchedule's reschedule step
 * swallow its error silently (removed `result.scheduleError = ...`, left the
 * catch block empty). Re-ran the test above — went red (schedule_error was
 * null instead of naming the failure). Reverted. This is exactly the
 * "approved-but-unscheduled, silently" failure mode item 3 forbids.
 */

test('on-behalf: 403 without isJobMaterialReview', async () => {
  const appNoAction = express();
  appNoAction.use((req, _res, next) => {
    req.user = { user_id: OPS_USER_ID, permissions: { menuIds: [], actionPermissions: [] } };
    req.userRole = { role_name: 'Project Manager' };
    req.scope = { clients: { mode: 'all', ids: [] }, cities: { mode: 'all', ids: [] }, states: { mode: 'all', ids: [] }, verticals: { mode: 'all', ids: [] } };
    req.allowedStages = null;
    next();
  });
  appNoAction.use('/jobs', require('../routes/admin/jobs'));
  const s = await new Promise((resolve) => { const srv = appNoAction.listen(0, () => resolve(srv)); });
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/jobs/${JOB_ID}/client-approval-on-behalf`, { method: 'POST', body: new FormData() });
    assert.equal(res.status, 403);
  } finally {
    s.close();
  }
});

test('GET /admin/jobs/:id/visit-slots returns the shared shape', async () => {
  const res = await fetch(`${baseUrl}/jobs/${JOB_ID}/visit-slots`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.technician_id, 4242);
  assert.ok(Array.isArray(body.data.days));
});

// ═════════════════════════════════════════════════════════════════════════
// 5. Client portal + public magic-link approve — same shared writer, called
// directly (no HTTP/multer — req.file is set on the fake request object the
// way multer would have set it, which is simpler and just as faithful since
// the field under test is approveWithVisitSchedule, not multer itself).
// ═════════════════════════════════════════════════════════════════════════

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

async function callClient(body = {}, file = null) {
  const r = mockRes();
  await handlerFor(clientRouter, '/jobs/:id/estimate/approve', 'patch')(
    {
      spoc: { id: 42, client_id: 133 }, access: { allStores: true }, query: {},
      params: { id: String(JOB_ID) }, body, file,
    },
    r, (e) => { r.statusCode = e.status || 500; r.body = { success: false, error: e.message }; },
  );
  return r;
}

function mintEstimateToken(jobId, clientContactId = null) {
  return jwt.sign({ sub: String(jobId), clientContactId }, process.env.JWT_SECRET);
}
async function callPublic(body = {}, file = null, clientContactId = 42) {
  const r = mockRes();
  await handlerFor(publicEstimateRouter, '/:token/approve', 'patch')(
    { params: { token: mintEstimateToken(JOB_ID, clientContactId) }, body, file },
    r, (e) => { r.statusCode = e.status || 500; r.body = { success: false, error: e.message }; },
  );
  return r;
}

test('client portal approve: 400 before any write when visit_date_time is missing', async () => {
  jobFixture = makeJob({ job_status: 15 });
  const r = await callClient({ permission: 'not_required' }, null);
  assert.equal(r.statusCode, 400, JSON.stringify(r.body));
  assert.equal(setStatusCalls.length, 0);
});

test('client portal approve: 409 on a busy slot, before any write', async () => {
  jobFixture = makeJob({ job_status: 15 });
  state.busyHour = { date: VALID_SLOT_DATE, hour: VALID_SLOT_HOUR };
  const r = await callClient({ visit_date_time: VALID_SLOT, permission: 'not_required' });
  assert.equal(r.statusCode, 409, JSON.stringify(r.body));
  assert.equal(setStatusCalls.length, 0);
});

test('client portal approve: happy path reschedules to the chosen slot with a system (null) actor', async () => {
  jobFixture = makeJob({ job_status: 15 });
  const r = await callClient({ visit_date_time: VALID_SLOT, permission: 'not_required' });
  assert.equal(r.body?.success, true, JSON.stringify(r.body));
  assert.equal(rescheduleCalls.length, 1);
  assert.equal(rescheduleCalls[0].payload.requestedDateTime, VALID_SLOT);
  assert.equal(rescheduleCalls[0].actor, null, 'never a client-contact id in a tbl_user FK');
  assert.equal(r.body.data.visit_date_time, VALID_SLOT);
});

test('client portal approve: permission=now fulfils with the SPOC as the fulfilling contact', async () => {
  jobFixture = makeJob({ job_status: 15 });
  const file = { originalname: 'permit.png', mimetype: 'image/png', size: 500, buffer: Buffer.alloc(10) };
  const r = await callClient({ visit_date_time: VALID_SLOT, permission: 'now' }, file);
  assert.equal(r.body?.success, true, JSON.stringify(r.body));
  assert.equal(raiseCalls.length, 1);
  assert.equal(raiseCalls[0].fulfilNow, true);
  assert.equal(raiseCalls[0].spocId, 42);
});

test('public magic-link approve: 400 with a bad permission value, before any write', async () => {
  jobFixture = makeJob({ job_status: 15 });
  const r = await callPublic({ visit_date_time: VALID_SLOT, permission: 'soon' });
  assert.equal(r.statusCode, 400, JSON.stringify(r.body));
  assert.equal(setStatusCalls.length, 0);
});

test('public magic-link approve: happy path reschedules to the chosen slot with a system (null) actor', async () => {
  jobFixture = makeJob({ job_status: 15 });
  const r = await callPublic({ visit_date_time: VALID_SLOT, permission: 'not_required' });
  assert.equal(r.body?.success ?? (r.statusCode === 200 || r.statusCode === null), true, JSON.stringify(r.body));
  assert.equal(rescheduleCalls.length, 1);
  assert.equal(rescheduleCalls[0].actor, null);
  assert.equal(r.body.data.visit_date_time, VALID_SLOT);
});

test('public magic-link approve: permission=later raises an open request attributed to the token contact', async () => {
  jobFixture = makeJob({ job_status: 15 });
  const r = await callPublic({ visit_date_time: VALID_SLOT, permission: 'later' }, null, 77);
  assert.equal(r.body?.success, true, JSON.stringify(r.body));
  assert.equal(raiseCalls.length, 1);
  assert.equal(raiseCalls[0].fulfilNow, false);
  assert.equal(raiseCalls[0].spocId, 77);
});

// ═════════════════════════════════════════════════════════════════════════
// 6. job.service.js#reschedule() no longer touches tbl_job_auto_schedule
// (the table + hook this change removes) — regression guard against a
// re-introduction.
// ═════════════════════════════════════════════════════════════════════════

test('reschedule() issues no query against the removed tbl_job_auto_schedule table', async () => {
  restoreDeepMocks(); // use the REAL job.service.reschedule for this one
  const db = require('../db');
  const realQuery = db.pool.query;
  const seen = [];
  db.pool.query = async (sql, params) => {
    const text = Array.isArray(sql) ? String(sql[0]) : String(sql);
    seen.push(text);
    if (/SELECT job_id, fk_easyfixter_id, time_slot, scheduled_date_time, fk_scheduled_by FROM tbl_job/i.test(text)) {
      return [[{ job_id: JOB_ID, fk_easyfixter_id: 4242, time_slot: null, scheduled_date_time: null, fk_scheduled_by: null }], []];
    }
    return [[], []];
  };
  const realAddComment = jobComments.addComment;
  jobComments.addComment = async () => ({ comment_id: 1 });
  try {
    await jobService.reschedule(JOB_ID, {
      requestedDateTime: '2026-09-24 11:00', reasonId: null, rescheduleReason: 'test', remarks: 'test remark',
    }, null);
  } finally {
    db.pool.query = realQuery;
    jobComments.addComment = realAddComment;
    installDeepMocks(); // restore this file's mocks for any tests still to run
  }
  assert.ok(!seen.some((s) => /tbl_job_auto_schedule/i.test(s)), 'reschedule() must never reference the removed table');
});
