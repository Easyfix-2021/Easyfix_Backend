'use strict';
/*
 * V3 Phase 4 (4.1, spec D6) — the customer's signature.
 *   POST /api/mobile/jobs/:id/signature (routes/mobile/jobs-phase4.js)
 *   GET  /api/admin/jobs/:id/signature  (routes/admin/jobs-phase4.js)
 *
 * WHAT IS AT RISK
 *   1. STORED XSS. The CRM renders what is stored. Only SVG path data may
 *      land: every markup / script / attribute / url() shape is refused
 *      BEFORE any query runs, and a refused body never reaches the INSERT.
 *   2. Size (≤200 KB) and pad bounds (1..4096).
 *   3. Owner guard (404 for someone else's job) and status 2/20 only (409).
 *   4. One row per job — an upsert, never a second row.
 *   5. 'signature taken' is logged, fail-soft, as the technician.
 *
 * MUTATIONS RUN (each turned this file red, then was restored):
 *   MS1 job-signature.service PATH_DATA: '<' and '>' added to the character
 *       class → "markup and script are refused" failed (200, INSERT ran).
 *   MS2 job-signature.service SIGNABLE: 1 added → "only while in progress"
 *       failed (200 at status 1).
 *   MS3 job-signature.service saveSignature: ON DUPLICATE KEY clause removed →
 *       "a re-sign replaces the row" failed.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installFakePool } = require('./helpers/fake-pool');

const state = {};
function reset() {
  state.job = { job_id: 42, job_status: 2, fk_easyfixter_id: 7, fk_customer_id: 1, fk_client_id: 3, otp: null, checkin_date_time: null };
  state.sig = null;
}
reset();

const fake = installFakePool([
  [/SELECT job_id, job_status, fk_easyfixter_id, fk_customer_id/, () => (state.job ? [state.job] : [])],
  [/INSERT INTO tbl_job_signature/, () => ({ affectedRows: 1 })],
  [/FROM tbl_job_signature WHERE job_id = \?/, () => (state.sig ? [state.sig] : [])],
  [/INSERT INTO tbl_job_logs/, () => ({ insertId: 1 })],
]);

const jobLog = require('../services/job-log.service');
const jobService = require('../services/job.service');

const logged = [];
let server; let base; let hadWriter; let origGetById;
before(async () => {
  // BACKEND-A adds logSignatureTaken; stub it here so this file does not
  // depend on the order the two halves land in.
  hadWriter = Object.prototype.hasOwnProperty.call(jobLog, 'logSignatureTaken') ? jobLog.logSignatureTaken : undefined;
  jobLog.logSignatureTaken = async (...a) => { logged.push(a); return 1; };
  origGetById = jobService.getById;
  jobService.getById = async () => ({ job_id: 42, job_status: 2, fk_client_id: 3, city_id: 1, vertical_id: 1 });

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/mobile', (req, _res, next) => { req.tech = { efr_id: 7, user_id: 70 }; next(); }, require('../routes/mobile/jobs-phase4'));
  app.use('/admin', (req, _res, next) => {
    req.user = { user_id: 77, permissions: { menuIds: [], actionPermissions: [] } };
    req.scope = undefined; req.allowedStages = null; next();
  }, require('../routes/admin/jobs-phase4'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err && err.message) }));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  if (server) server.close();
  if (hadWriter === undefined) delete jobLog.logSignatureTaken; else jobLog.logSignatureTaken = hadWriter;
  jobService.getById = origGetById;
  fake.restore();
});
beforeEach(() => { reset(); fake.reset(); logged.length = 0; });

async function sign(body, id = 42) {
  const r = await fetch(`${base}/mobile/${id}/signature`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
const inserts = () => fake.calls.filter((c) => /INSERT INTO tbl_job_signature/.test(c.sql));
const GOOD = 'M10 20 L30 40.5 C1,2 3,4 5,6 M-1e2 3 l4 -5 Z';

test('valid path data is stored as-is and the time returned', async () => {
  const r = await sign({ svg: `  ${GOOD}\n`, width: 360, height: 200 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.data.signatureOn, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const [ins] = inserts();
  assert.deepEqual(ins.params.slice(0, 5), [42, 7, GOOD, 360, 200], 'trimmed path, owner efr, pad size');
  assert.equal(logged.length, 1);
  assert.equal(logged[0][0], 42);
  assert.deepEqual(logged[0][2], { efr_id: 7 }, 'logged as the technician');
});

test('markup and script are refused before any query', async () => {
  const bad = [
    '<svg onload="alert(1)"><path d="M0 0"/></svg>',
    'M0 0 L1 1"/><script>alert(1)</script>',
    'M0 0 javascript:alert(1)',
    'M0 0 url(#x)',
    'M0 0 &lt;',
    'M0 0; L1 1',
    'L0 0 L1 1',       // must start with a moveto
    'M',               // no coordinates at all
    'data:image/png;base64,AAAA',
    'M0 0 L1 1 ✓',
  ];
  for (const svg of bad) {
    const r = await sign({ svg, width: 100, height: 100 });
    assert.equal(r.status, 400, svg);
  }
  assert.equal(fake.calls.length, 0, 'nothing reached the database');
});

test('size and pad bounds', async () => {
  const big = 'M0 0' + ' L1 1'.repeat(Math.ceil((200 * 1024) / 5));
  assert.ok(big.length > 200 * 1024);
  assert.equal((await sign({ svg: big, width: 100, height: 100 })).status, 400, 'over 200 KB');
  const fits = 'M0 0' + ' L1 1'.repeat(Math.floor((200 * 1024 - 4) / 5));
  assert.equal((await sign({ svg: fits, width: 100, height: 100 })).status, 200, 'just under 200 KB');
  for (const [w, h] of [[0, 100], [100, 0], [4097, 100], [100, 1.5], ['x', 100]]) {
    assert.equal((await sign({ svg: GOOD, width: w, height: h })).status, 400, `${w}x${h}`);
  }
  assert.equal((await sign({ svg: GOOD, width: 100 })).status, 400, 'height required');
});

test('only while in progress (2 / 20), only on his own job', async () => {
  for (const s of [0, 1, 3, 5, 6, 10]) {
    state.job.job_status = s;
    const r = await sign({ svg: GOOD, width: 100, height: 100 });
    assert.equal(r.status, 409, `status ${s}`);
    assert.equal(r.body.error.code, 'JOB_NOT_IN_PROGRESS');
  }
  state.job.job_status = 20;
  assert.equal((await sign({ svg: GOOD, width: 100, height: 100 })).status, 200);
  state.job.fk_easyfixter_id = 8;
  assert.equal((await sign({ svg: GOOD, width: 100, height: 100 })).status, 404, 'not his');
  state.job = null;
  assert.equal((await sign({ svg: GOOD, width: 100, height: 100 })).status, 404);
  assert.equal(inserts().length, 1, 'only the status-20 sign wrote');
});

test('a re-sign replaces the row (one per job)', async () => {
  await sign({ svg: GOOD, width: 100, height: 100 });
  const [ins] = inserts();
  assert.match(ins.sql, /ON DUPLICATE KEY UPDATE efr_id = VALUES\(efr_id\), svg_path = VALUES\(svg_path\)/);
  assert.match(ins.sql, /signed_on = VALUES\(signed_on\)/);
});

test('a failing log writer does not fail the save', async () => {
  const w = jobLog.logSignatureTaken;
  jobLog.logSignatureTaken = async () => { throw new Error('boom'); };
  try {
    assert.equal((await sign({ svg: GOOD, width: 100, height: 100 })).status, 200);
  } finally { jobLog.logSignatureTaken = w; }
});

test('GET /admin/jobs/:id/signature → {svg,width,height,signedOn} | null', async () => {
  let r = await (await fetch(`${base}/admin/42/signature`)).json();
  assert.equal(r.data, null);
  state.sig = { svg_path: GOOD, width: 360, height: 200, signed_on: '2026-09-24 11:00:00' };
  r = await (await fetch(`${base}/admin/42/signature`)).json();
  assert.deepEqual(r.data, { svg: GOOD, width: 360, height: 200, signedOn: '2026-09-24 11:00:00' });
});
