/*
 * "Send Request to Client" — Material Management phase 2 follow-on.
 * Coverage for services/material-client-request.service.js, wired into
 * POST /admin/jobs/:id/material-review's 'approve' branch (see
 * tests/ops-material-approval.test.js for the review/transaction mechanics
 * this reuses unmodified), plus the client bell-count addition in
 * routes/client/index.js GET /notices/unread-count.
 *
 * Runner: `node --test --test-force-exit tests/material-client-request.test.js`.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.WEBHOOK_OUTBOUND_ENABLED = 'false';
process.env.CLIENT_URL = 'https://portal.test';

const { installFakePool } = require('./helpers/fake-pool');

const OPS_USER_ID = 77;
const TECH_EFR_ID = 4242;
const JOB_ID = 800;
const CLIENT_ID = 133;
const REPORTING_CONTACT_ID = 43;

function makeJob(over = {}) {
  return {
    job_id: JOB_ID,
    job_reference_id: 'JR-800',
    job_status: 16,
    fk_easyfixter_id: TECH_EFR_ID,
    fk_client_id: CLIENT_ID,
    city_id: 11,
    vertical_id: 3,
    fk_customer_id: 3,
    reporting_contact_id: REPORTING_CONTACT_ID,
    client_spoc_email: 'spoc-fallback@client.test',
    job_client_owner: 501,
    job_owner: null,
    client_ref_id: null,
    approved_on_date_time: null,
    approval_reject_date_time: null,
    approval_sent_on_date_time: null,
    material_sub_status: 2,
    permission_required: 0,
    material_reject_reason: null,
    requested_date_time: '2026-09-20 10:00:00',
    booking_cut_off_time_slot: null,
    otp: null,
    remarks: null,
    custom_property: null,
    customer_name: 'Test Customer',
    customer_mob_no: null,
    client_name: 'Test Client',
    ...over,
  };
}

function materialLine(over = {}) {
  return {
    id: null, job_id: JOB_ID, type: 'material', name: 'Pipe fitting',
    unit: 2, unit_price: 999, approved_charge: null,
    status: 1, action_by: null, action_on: null,
    ...over,
  };
}

let jobFixture = makeJob();
let quotationRows = [];
let permissions = ['isJobMaterialReview'];
let contactEmailFixture = 'contact@client.test';
let notifRows = []; // for GET /notices/unread-count: { job_id, fk_client_id, status }
let noticeBoardUnread = 0;

function filterQuotationRows(sql, jobIds) {
  const statusMatch = sql.match(/status[^=]*=\s*(\d+)/i);
  const requiredStatus = statusMatch ? Number(statusMatch[1]) : null;
  const requiresActionOnNotNull = /action_on\s+IS\s+NOT\s+NULL/i.test(sql);
  const requiresActionOnNull = /action_on\s+IS\s+NULL/i.test(sql) && !requiresActionOnNotNull;
  const requiresTypeMaterial = /type\s*=\s*'material'/i.test(sql);
  return quotationRows.filter((r) => {
    if (!jobIds.includes(r.job_id)) return false;
    if (requiresTypeMaterial && r.type !== 'material') return false;
    if (requiredStatus != null && Number(r.status) !== requiredStatus) return false;
    if (requiresActionOnNotNull && r.action_on == null) return false;
    if (requiresActionOnNull && r.action_on != null) return false;
    return true;
  });
}

// user_type -> { user_id, user_name, email } for the SPOC CC lookup.
let spocFixture = {};
const fake = installFakePool([
  [/FROM\s+tbl_job_comment\s+c\b[\s\S]*comment_id\s*=\s*\?/i, () => [{ id: 1, job_id: JOB_ID, comment_on: 1 }]],
  [/FROM tbl_job j\s+LEFT JOIN tbl_customer/i, () => (jobFixture ? [jobFixture] : [])],
  [/SELECT j\.\*/i, () => (jobFixture ? [jobFixture] : [])],
  // services/material-client-request.service.js's OWN job lookup — distinct
  // column list so it cannot be confused with the routes above.
  [/j\.job_reference_id,\s*j\.reporting_contact_id/i, () => (jobFixture ? [jobFixture] : [])],
  [/FROM\s+tbl_job\s+WHERE\s+job_id\s*=\s*\?/i, () => (jobFixture ? [jobFixture] : [])],
  [/^\s*UPDATE tbl_job\b/i, () => ({ affectedRows: 1 })],
  [/^\s*INSERT INTO tbl_job_comment/i, () => ({ insertId: 1, affectedRows: 1 })],
  [/^\s*INSERT INTO tbl_job_material_review/i, () => ({ insertId: 1, affectedRows: 1 })],
  [/^\s*INSERT INTO tbl_job_logs/i, () => ({ insertId: 1, affectedRows: 1 })],
  [/^\s*INSERT INTO dashboard_notification_log/i, () => ({ insertId: 1, affectedRows: 1 })],
  [/INFORMATION_SCHEMA/i, () => [{ n: 3 }]],

  [/^\s*SELECT id FROM quotation_details/i, (sql, params) => filterQuotationRows(sql, [params[0]]).map((r) => ({ id: r.id }))],
  [/^\s*UPDATE quotation_details\b/i, (sql, params) => {
    const isApprove = /approved_charge/.test(sql);
    const id = isApprove ? params[3] : params[2];
    const row = quotationRows.find((r) => r.id === id);
    if (row) {
      const statusLiteral = sql.match(/\bstatus\s*=\s*(\d+)/i);
      if (isApprove) { [row.approved_charge, row.action_by, row.action_on] = params; }
      else { [row.action_by, row.action_on] = params; }
      row.status = statusLiteral ? Number(statusLiteral[1]) : null;
    }
    return { affectedRows: row ? 1 : 0 };
  }],
  [/FROM quotation_details qd/i, (sql, params) => filterQuotationRows(sql, params).map((r) => ({
    line_id: r.id, job_id: r.job_id, name: r.name, unit: r.unit, approved_charge: r.approved_charge,
  }))],
  [/FROM tbl_job_services js/i, () => []],

  // job.service.js resolveClientSpocUsers — the Primary (1) / Secondary (2)
  // EasyFix SPOC CC. params = [clientId, userType].
  [/u\.official_email AS email[\s\S]*vm\.user_type = \?/i, (sql, params) => {
    const row = spocFixture[Number(params[1])];
    return row ? [row] : [];
  }],
  // material-client-request.service.js's contact-email lookup.
  [/SELECT contact_email FROM tbl_client_contacts WHERE id\s*=\s*\?/i, () => (contactEmailFixture ? [{ contact_email: contactEmailFixture }] : [])],

  // GET /notices/unread-count — Notice Board half (untouched by this feature).
  [/FROM tbl_notice n\b/i, () => [{ unread: noticeBoardUnread }]],
  // GET /notices/unread-count — new dashboard_notification_log half. The
  // "exclude read rows" filter is derived from the SQL TEXT (like
  // filterQuotationRows above), not hand-assumed — so a regression that
  // drops that clause from the real query stops this fake enforcing it too.
  [/FROM\s+dashboard_notification_log\s+n\s+JOIN\s+tbl_job\s+j/i, (sql, params) => {
    // Both predicates are read out of the SQL TEXT, not hand-assumed — a
    // regression that drops `fk_client_id = ?` (cross-client leak) or the
    // read-exclusion from the real query stops this fake enforcing it too,
    // same technique as filterQuotationRows above.
    const scopesToClient = /fk_client_id\s*=\s*\?/i.test(sql);
    const excludesRead = /status\s*<>\s*'read'/i.test(sql);
    const clientId = scopesToClient ? params[0] : null;
    const rows = notifRows.filter((r) =>
      (!scopesToClient || r.fk_client_id === clientId) && (!excludesRead || r.status !== 'read'));
    return [{ unread: new Set(rows.map((r) => r.job_id)).size }];
  }],

  [/^\s*(SELECT|INSERT|UPDATE)/i, () => []],
]);

after(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  fake.restore();
});

beforeEach(() => {
  fake.calls.length = 0;
  jobFixture = makeJob();
  quotationRows = [];
  permissions = ['isJobMaterialReview'];
  contactEmailFixture = 'contact@client.test';
  notifRows = [];
  noticeBoardUnread = 0;
  sentEmails.length = 0;
  sendImpl = defaultSendImpl;
});

// ─── Intercept the outbound email at the module boundary — email.service.js
// talks to MS Graph over fetch, which must never run in a test. ───────────
const emailService = require('../services/email.service');
const originalSend = emailService.send;
let sentEmails = [];
async function defaultSendImpl(opts) { sentEmails.push(opts); return { accepted: true, delivered: true }; }
let sendImpl = defaultSendImpl;
emailService.send = (...args) => sendImpl(...args);
after(() => { emailService.send = originalSend; });

const express = require('express');
const jobsRouter = require('../routes/admin/jobs');

let adminServer;
let adminBaseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { user_id: OPS_USER_ID, user_name: 'PM Tester', permissions: { menuIds: [], actionPermissions: permissions } };
    req.userRole = { role_name: 'Project Manager' };
    req.scope = {
      clients:   { mode: 'all', ids: [], placeholders: '' },
      cities:    { mode: 'all', ids: [], placeholders: '' },
      states:    { mode: 'all', ids: [], placeholders: '' },
      verticals: { mode: 'all', ids: [], placeholders: '' },
    };
    req.allowedStages = null;
    next();
  });
  app.use('/jobs', jobsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { res.status(500).json({ error: String(err && err.message) }); });
  await new Promise((resolve) => { adminServer = app.listen(0, resolve); });
  adminBaseUrl = `http://127.0.0.1:${adminServer.address().port}`;
});

after(async () => { if (adminServer) adminServer.close(); });

async function adminPost(body) {
  const res = await fetch(`${adminBaseUrl}/jobs/${JOB_ID}/material-review`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// The route fires services/material-client-request.service.js with
// `.catch()`, never awaited — flush the microtask queue until the async
// side effect we're checking for has actually landed (bounded: this must
// never hang a suite on a wiring regression). Exits on the POSITIVE signal
// (predicate becomes true), same rule as the monitor-exit lesson: waiting
// on "!done" is indistinguishable from "never checked".
async function flushUntil(predicate, tries = 25) {
  for (let i = 0; i < tries && !predicate(); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function dashboardNotificationInsert() {
  return fake.calls.find((c) => /^\s*INSERT INTO dashboard_notification_log/i.test(c.sql));
}

// ═════════════════════════════════════════════════════════════════════════
// approve -> email + notification
// ═════════════════════════════════════════════════════════════════════════

test('approve: email goes to the client CONTACT (not the owner), with the deep link, approved amounts, and no unit_price', async () => {
  jobFixture = makeJob({ job_owner: 909 });
  quotationRows = [materialLine({ id: 91, name: 'Pipe', unit: 2 })];
  const res = await adminPost({
    decision: 'approve',
    permission_required: 0,
    lines: [{ line_id: 91, decision: 'approve', approved_amount: 450 }],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  await flushUntil(() => sentEmails.length > 0);
  assert.equal(sentEmails.length, 1, 'exactly one email must be sent');
  const mail = sentEmails[0];
  assert.deepEqual(mail.to, ['contact@client.test'], 'must go to the client CONTACT, never the job owner');
  assert.match(mail.subject, /materials for job #JR-800/);
  assert.equal(mail.category, 'material.send-to-client');
  assert.match(mail.text, /https:\/\/portal\.test\/jobs\?jobId=800/, 'deep link must carry the job id');
  assert.match(mail.html, /https:\/\/portal\.test\/jobs\?jobId=800/);
  assert.match(mail.text, /450\.00/, 'approved amount must appear');
  assert.doesNotMatch(mail.text, /999/, 'the technician\'s quoted unit_price must never appear');
  assert.doesNotMatch(mail.html, /999/);

  await flushUntil(() => !!dashboardNotificationInsert());
  const notif = dashboardNotificationInsert();
  assert.ok(notif, 'the notification must also be written');
  assert.match(notif.params.join('|'), /Material approval needed/);
});

test('approve, no contact email and no spoc fallback: no email is sent, notification is still written', async () => {
  jobFixture = makeJob({ client_spoc_email: null });
  contactEmailFixture = null;
  quotationRows = [materialLine({ id: 91 })];
  const res = await adminPost({
    decision: 'approve',
    lines: [{ line_id: 91, decision: 'approve', approved_amount: 100 }],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  await flushUntil(() => !!dashboardNotificationInsert());
  assert.equal(sentEmails.length, 0, 'no valid recipient means no email');
  assert.ok(dashboardNotificationInsert(), 'the notification must still be written');
});

test('approve, contact email missing: falls back to tbl_job.client_spoc_email', async () => {
  jobFixture = makeJob({ client_spoc_email: 'fallback@client.test' });
  contactEmailFixture = null;
  quotationRows = [materialLine({ id: 91 })];
  const res = await adminPost({
    decision: 'approve',
    lines: [{ line_id: 91, decision: 'approve', approved_amount: 100 }],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await flushUntil(() => sentEmails.length > 0);
  assert.deepEqual(sentEmails[0].to, ['fallback@client.test']);
});

test('POSITIVE CONTROL: an email failure does not change the approve response or the committed status', async () => {
  jobFixture = makeJob();
  quotationRows = [materialLine({ id: 91 })];
  sendImpl = async () => { throw new Error('Graph is down'); };
  const res = await adminPost({
    decision: 'approve',
    lines: [{ line_id: 91, decision: 'approve', approved_amount: 100 }],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body?.data?.job_status ?? jobFixture.job_status, jobFixture.job_status);
  const statusUpd = fake.calls.find((c) => /^\s*UPDATE tbl_job\b/i.test(c.sql) && /job_status\s*=\s*\?/i.test(c.sql));
  assert.ok(statusUpd, 'the status move must still have happened');
  await flushUntil(() => !!dashboardNotificationInsert());
  assert.ok(dashboardNotificationInsert(), 'the notification write is independent of the email failure');
});

test('reject: nothing is sent', async () => {
  jobFixture = makeJob();
  const res = await adminPost({ decision: 'reject', reason: 'Quote missing brand' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  // Nothing async is fired on reject, so a short flush is enough to prove a
  // negative — it does not need to "wait it out" indefinitely.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sentEmails.length, 0);
  assert.equal(dashboardNotificationInsert(), undefined);
});

// ═════════════════════════════════════════════════════════════════════════
// GET /api/client/notices/unread-count — combined bell count
// ═════════════════════════════════════════════════════════════════════════

const clientRouter = require('../routes/client/index');

function handlerFor(router, routePath, method) {
  const layer = router.stack.find((e) => e.route && e.route.path === routePath && e.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${routePath} must be mounted`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function mockRes() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
async function callUnreadCount(spoc) {
  const r = mockRes();
  await handlerFor(clientRouter, '/notices/unread-count', 'get')({ spoc, query: {} }, r, (e) => { throw e; });
  return r;
}

test('unread-count includes this client\'s unread job notifications and excludes another client\'s', async () => {
  notifRows = [
    { job_id: 1, fk_client_id: CLIENT_ID, status: 'unread' },
    { job_id: 2, fk_client_id: CLIENT_ID, status: 'read' },
    { job_id: 3, fk_client_id: 999, status: 'unread' }, // another client — must not count
  ];
  noticeBoardUnread = 2;
  const r = await callUnreadCount({ id: 42, client_id: CLIENT_ID });
  assert.equal(r.body?.data?.jobs, 1, 'only this client\'s unread job notification counts');
  assert.equal(r.body?.data?.notices, 2);
  assert.equal(r.body?.data?.count, 3, 'combined count = notices + jobs');
});

test('unread-count for another client sees only its own row', async () => {
  notifRows = [
    { job_id: 1, fk_client_id: CLIENT_ID, status: 'unread' },
    { job_id: 3, fk_client_id: 999, status: 'unread' },
  ];
  noticeBoardUnread = 0;
  const r = await callUnreadCount({ id: 43, client_id: 999 });
  assert.equal(r.body?.data?.jobs, 1);
  assert.equal(r.body?.data?.count, 1);
});

test('clientPortalBaseUrl uses CLIENT_URL as-is, minus a trailing slash', () => {
  const { clientPortalBaseUrl } = require('../services/material-client-request.service');
  assert.equal(clientPortalBaseUrl({ CLIENT_URL: 'https://client.easyfix.in/' }), 'https://client.easyfix.in');
  assert.equal(clientPortalBaseUrl({ CLIENT_URL: 'http://10.30.2.30:5181' }), 'http://10.30.2.30:5181');
  assert.equal(clientPortalBaseUrl({}), '');
});

/* Owner (2026-09-21): CC the client's Primary AND Secondary EasyFix SPOCs on
   the Send Request to Client email, so the team can chase the approval. */
test('approve: the Primary and Secondary SPOCs are CC\'d, never duplicating a To, invalid skipped', async () => {
  quotationRows = [materialLine({ id: 91, name: 'Pipe', unit: 2 })];
  spocFixture = {
    1: { user_id: 11, user_name: 'Asha', email: 'asha@easyfix.test' },
    2: { user_id: 12, user_name: 'Ravi', email: 'ravi@easyfix.test' },
  };
  try {
    const res = await adminPost({ decision: 'approve', permission_required: 0, lines: [{ line_id: 91, decision: 'approve', approved_amount: 450 }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await flushUntil(() => sentEmails.length > 0);
    const mail = sentEmails[sentEmails.length - 1];
    assert.deepEqual(mail.to, ['contact@client.test']);
    assert.deepEqual([...(mail.cc || [])].sort(), ['asha@easyfix.test', 'ravi@easyfix.test']);

    // A SPOC who is already the To recipient is not CC'd again; a bad email is skipped.
    sentEmails.length = 0;
    spocFixture = {
      1: { user_id: 11, user_name: 'Asha', email: 'contact@client.test' },
      2: { user_id: 12, user_name: 'Ravi', email: 'not-an-email' },
    };
    quotationRows = [materialLine({ id: 92, name: 'Pipe', unit: 1 })];
    const res2 = await adminPost({ decision: 'approve', permission_required: 0, lines: [{ line_id: 92, decision: 'approve', approved_amount: 100 }] });
    assert.equal(res2.status, 200, JSON.stringify(res2.body));
    await flushUntil(() => sentEmails.length > 0);
    assert.equal(sentEmails[sentEmails.length - 1].cc, undefined, 'no duplicate To, no invalid address');
  } finally {
    spocFixture = {};
  }
});

/* Owner (2026-09-21): "don't email the SPOCs without a client email". The CC
   rides on the client email — with no client contact email, nothing is sent,
   even when both SPOCs have valid addresses. */
test('no client email: the SPOCs are NOT emailed on their own; the notification is still written', async () => {
  jobFixture = makeJob({ client_spoc_email: null });
  contactEmailFixture = null;
  spocFixture = {
    1: { user_id: 11, user_name: 'Asha', email: 'asha@easyfix.test' },
    2: { user_id: 12, user_name: 'Ravi', email: 'ravi@easyfix.test' },
  };
  quotationRows = [materialLine({ id: 93 })];
  try {
    const res = await adminPost({ decision: 'approve', lines: [{ line_id: 93, decision: 'approve', approved_amount: 100 }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await flushUntil(() => !!dashboardNotificationInsert());
    assert.equal(sentEmails.length, 0, 'SPOCs must not be emailed without a client email');
    assert.ok(dashboardNotificationInsert(), 'the notification must still be written');
  } finally {
    spocFixture = {};
  }
});
