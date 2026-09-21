/*
 * QuickSight — Employee Performance: the native Employee tab's READ routes.
 *
 * routes/admin/quicksight/employee-performance.js GET /options, /summary,
 * /open-jobs, /technicians and /member hand the stored snapshot to
 * services/quicksight/employee-performance/aggregate.js (whose numbers are
 * proven against the dashboard itself in tests/quicksight-ep-aggregate.test.js).
 * So what is pinned HERE is the plumbing only, where a mistake is silent:
 *
 *   - the query reaches aggregate.js as the filters it means: `vertical` /
 *     `employee` repeated, comma-joined, or repeated MORE THAN 20 times (which
 *     qs turns into an object, not an array); paging and sort keys by name;
 *   - every read answers from the parsed snapshot, is never cached by an
 *     intermediary, and 404s cleanly before anything is uploaded;
 *   - a bad parameter is a 400, not a silently different report;
 *   - the parsed snapshot is cached per upload, and a newer upload — from this
 *     instance or from another one writing the same storage — replaces it;
 *   - the view key still gates it all.
 *
 * Expected bodies are aggregate.js called directly on the same D, JSON
 * round-tripped the way the response is.
 *
 * No DB (permissions stubbed at role.service), no S3 (forced off, storage is a
 * throwaway directory), no network beyond 127.0.0.1.
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

process.env.S3_BUCKET_NAME = '';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-ep-routes-'));
process.env.QS_EMPLOYEE_PERFORMANCE_DIR = TMP;

const VIEW_KEY = 'isQuickSightEmployeePerformanceView';
const S = { perms: ['ef-QuickSight', VIEW_KEY] };

function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, '..', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub('services/role.service', { getEffectivePermissions: async () => ({ menuIds: [], actionPermissions: S.perms }) });

const express = require('express');
const service = require('../services/quicksight/quicksight-employee-performance.service');
const agg = require('../services/quicksight/employee-performance/aggregate');
const { syntheticD } = require('./fixtures/qs-ep-aggregate/synthetic-d');

const D = syntheticD();
const json = (x) => JSON.parse(JSON.stringify(x));
const asDataJs = (d) => Buffer.from(`const D=${JSON.stringify(d)};\n`);

let server;
let base;
before(async () => {
  const app = express();
  app.use((req, _res, next) => { req.user = { user_id: 9, user_name: 'MIS User' }; next(); });
  app.use('/api/admin/quicksight/employee-performance', require('../routes/admin/quicksight/employee-performance'));
  app.use((err, _req, res, _next) => { res.status(500).json({ success: false, error: String(err && err.message) }); });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/api/admin/quicksight/employee-performance`;
});
after(async () => {
  if (server) await new Promise((r) => server.close(r));
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function get(p) {
  const res = await fetch(base + p);
  return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() };
}
async function ok(p) {
  const r = await get(p);
  assert.equal(r.status, 200, `${p} → ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.cache, 'no-store', `${p} is not cacheable`);
  assert.equal(r.body.success, true);
  return r.body.data;
}

const READS = ['/options', '/summary', '/open-jobs', '/technicians', '/member?name=Asha'];

/* ── before any upload ─────────────────────────────────────────────────── */

test('every read 404s before anything is uploaded — no-store, and a code the CRM can branch on', async () => {
  assert.equal(await service.getSnapshotD(), null);
  for (const p of READS) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
    assert.equal(r.cache, 'no-store', p);
    assert.deepEqual(r.body, {
      success: false,
      error: 'No Employee Performance data has been uploaded yet',
      details: { code: 'NO_SNAPSHOT' },
    }, p);
  }
});

test('without the view key (or the QuickSight family key) every read is refused', async () => {
  try {
    S.perms = ['ef-QuickSight'];
    for (const p of READS) {
      const r = await get(p);
      assert.equal(r.status, 403, p);
      assert.match(r.body.error, new RegExp(VIEW_KEY), p);
    }
    S.perms = [VIEW_KEY];
    for (const p of READS) assert.equal((await get(p)).status, 403, p);
  } finally {
    S.perms = ['ef-QuickSight', VIEW_KEY];
  }
});

/* ── round trips ───────────────────────────────────────────────────────── */

test('upload, then /options is buildOptions(D)', async () => {
  const meta = await service.saveSnapshot({ buffer: asDataJs(D), originalName: 'data.js', user: { user_id: 9, user_name: 'MIS User' } });
  assert.equal(meta.employeeCount, Object.keys(D.employees).length);

  const data = await ok(`/options?v=${encodeURIComponent(meta.uploadedAt)}`);
  assert.deepEqual(data, json(agg.buildOptions(D)));
  assert.deepEqual(data.verticals, ['Furniture', 'Sports'], 'positive control: the fixture really is behind the route');
});

test('/summary: the filter bar reaches aggregate.js as the filters it means', async () => {
  const cases = [
    ['', {}],
    ['?vertical=Furniture', { verticals: ['Furniture'] }],
    ['?vertical=Furniture&employee=Asha&employee=Chitra&month=2026-09', { verticals: ['Furniture'], employees: ['Asha', 'Chitra'], month: '2026-09' }],
    ['?zm=Zed&from=2026-08-31&to=2026-09-02', { zm: 'Zed', from: '2026-08-31', to: '2026-09-02' }],
    ['?employee=Bharat&month=ALL&zm=&from=&to=&v=anything', { employees: ['Bharat'] }],
  ];
  for (const [qs, filters] of cases) {
    assert.deepEqual(await ok(`/summary${qs}`), json(agg.buildSummary(D, filters)), qs || '(no filters)');
  }

  // Not vacuous: a filter changes the answer.
  const all = await ok('/summary');
  const furniture = await ok('/summary?vertical=Furniture');
  assert.notEqual(all.kpis.revenue, furniture.kpis.revenue);
});

test('vertical / employee: repeated, comma-joined and mixed forms are the same filter', async () => {
  const expected = await ok('/summary?employee=Asha&employee=Chitra');
  assert.notDeepEqual(expected, await ok('/summary'), 'positive control: the employee filter bites');
  for (const qs of ['employee=Asha,Chitra', 'employee=Chitra,%20Asha', 'employee=Asha&employee=Chitra,Asha', 'employee[]=Asha&employee[]=Chitra']) {
    assert.deepEqual(await ok(`/summary?${qs}`), expected, qs);
  }
  assert.deepEqual(await ok('/summary?vertical=Sports,Furniture&employee=Bharat'),
    json(agg.buildSummary(D, { verticals: ['Sports', 'Furniture'], employees: ['Bharat'] })));
});

test('more than 20 repeats of employee= (what qs parses as an object) is still the list', async () => {
  // "Select all" over a big roster. 25 names: the 3 real SPOCs plus 22 others.
  const names = ['Asha', 'Chitra', ...Array.from({ length: 22 }, (_, i) => `Person ${i}`), 'Bharat'];
  const qs = names.map((n) => `employee=${encodeURIComponent(n)}`).join('&');
  assert.deepEqual(await ok(`/summary?${qs}`), json(agg.buildSummary(D, { employees: names })));

  // …and a subset past the limit keeps its meaning (not silently "all").
  const some = ['Asha', ...Array.from({ length: 22 }, (_, i) => `Person ${i}`)];
  const got = await ok(`/summary?${some.map((n) => `employee=${encodeURIComponent(n)}`).join('&')}`);
  assert.deepEqual(got, json(agg.buildSummary(D, { employees: ['Asha'] })));
  assert.notDeepEqual(got, await ok('/summary'));
});

test('/open-jobs pages and sorts through aggregate.pageOpenJobs', async () => {
  const cases = [
    ['', {}, {}],
    ['?zm=Zed&page=2&pageSize=2&sortBy=aging&sortDir=asc', { zm: 'Zed' }, { page: 2, pageSize: 2, sortBy: 'aging', sortDir: 'asc' }],
    ['?vertical=Furniture&sortBy=client', { verticals: ['Furniture'] }, { sortBy: 'client' }],
    ['?sortBy=&sortDir=&pageSize=200', {}, { pageSize: 200 }],
  ];
  for (const [qs, filters, paging] of cases) {
    assert.deepEqual(await ok(`/open-jobs${qs}`), json(agg.pageOpenJobs(D, filters, paging)), qs || '(defaults)');
  }
  const page = await ok('/open-jobs?zm=Zed&page=2&pageSize=2&sortBy=aging&sortDir=asc');
  assert.deepEqual(Object.keys(page).sort(), ['page', 'pageSize', 'rows', 'sortBy', 'sortDir', 'total', 'totalPages']);
  assert.deepEqual([page.total, page.page, page.pageSize, page.totalPages, page.sortBy, page.sortDir], [5, 2, 2, 3, 'aging', 'asc']);
  assert.equal(page.rows.length, 2);
});

test('/technicians pages and sorts through aggregate.pageTechnicians', async () => {
  const cases = [
    ['', {}, {}],
    ['?vertical=Furniture&sortBy=total&pageSize=3', { verticals: ['Furniture'] }, { sortBy: 'total', pageSize: 3 }],
    ['?employee=Asha&zm=Yan&sortBy=avgAging&sortDir=asc&from=2026-09-01', { employees: ['Asha'], zm: 'Yan', from: '2026-09-01' }, { sortBy: 'avgAging', sortDir: 'asc' }],
  ];
  for (const [qs, filters, paging] of cases) {
    assert.deepEqual(await ok(`/technicians${qs}`), json(agg.pageTechnicians(D, filters, paging)), qs || '(defaults)');
  }
  assert.ok((await ok('/technicians')).rows.length > 0, 'positive control: rows come back');
});

test('/member is memberDetail — lead and member views, only month/dates applied', async () => {
  const lead = await ok('/member?name=Asha&month=2026-08');
  assert.deepEqual(lead, json(agg.memberDetail(D, { month: '2026-08' }, 'Asha')));
  assert.equal(lead.view, 'team');

  // The whole filter bar is accepted; memberDetail ignores all but month/from/to.
  const member = await ok('/member?name=Esha&vertical=Sports&employee=Bharat&zm=Yan&from=2026-08-31&to=2026-09-02');
  assert.deepEqual(member, json(agg.memberDetail(D, { from: '2026-08-31', to: '2026-09-02' }, 'Esha')));
  assert.equal(member.view, 'member');
  assert.equal(member.key, 'Esha');
  assert.equal(member.displayName, 'Esha K');
});

test('/member for a name with no employee row is a 404, not an empty dialog', async () => {
  // Hari is on a team roster but has no employee row; __proto__ must not reach Object.prototype.
  for (const name of ['Nobody', 'Hari', '__proto__', 'constructor']) {
    const r = await get(`/member?name=${encodeURIComponent(name)}`);
    assert.equal(r.status, 404, name);
    assert.equal(r.cache, 'no-store', name);
    assert.equal(r.body.details.code, 'MEMBER_NOT_FOUND', name);
  }
});

/* ── bad parameters ────────────────────────────────────────────────────── */

test('bad parameters are a 400, never a silently different report', async () => {
  const bad = [
    '/summary?from=2026-13-01',
    '/summary?to=01-09-2026',
    '/summary?from=2026-09-03&to=2026-09-01',          // inverted range
    '/summary?month=2026-9',
    '/summary?month=all',
    '/summary?zm=Zed&zm=Yan',                           // single-select
    '/summary?employee[x]=Asha',
    '/summary?employee[0][0]=Asha',
    `/summary?zm=${'z'.repeat(201)}`,
    '/open-jobs?sortBy=bogus',
    '/open-jobs?sortBy=total',                          // a technician column, not an open-job one
    '/open-jobs?sortDir=up',
    '/open-jobs?page=0',
    '/open-jobs?page=abc',
    `/open-jobs?pageSize=${agg.MAX_PAGE_SIZE + 1}`,
    '/technicians?sortBy=aging',                        // an open-job column
    '/technicians?pageSize=0',
    '/member',                                          // name is required
    '/member?name=',
    '/member?name=Asha&name=Esha',
    '/member?name=Asha&from=2026-02-30x',
  ];
  for (const p of bad) {
    const r = await get(p);
    assert.equal(r.status, 400, `${p} → ${r.status}`);
    assert.equal(r.cache, 'no-store', p);
    assert.equal(r.body.error, 'Validation failed', p);
    assert.ok(Array.isArray(r.body.details) && r.body.details.length, p);
  }
  // Positive controls for the whitelists: the same keys on their own table pass.
  assert.equal((await get('/open-jobs?sortBy=aging&sortDir=desc&page=1')).status, 200);
  assert.equal((await get('/technicians?sortBy=total')).status, 200);
});

/* ── the parsed-snapshot cache ─────────────────────────────────────────── */

test('the snapshot is parsed once per upload and replaced by a newer one', async () => {
  const first = await service.getSnapshotD();
  assert.ok(first && first.employees.Asha, 'the uploaded D');
  assert.equal(await service.getSnapshotD(), first, 'the same parsed object on every read');

  // Another instance (sharing the storage) uploads: its own data object first,
  // then meta naming it — written straight to storage so this process's cache
  // knows nothing of it.
  const next = syntheticD();
  next.employees.Asha.daily[0].revenue += 1000;
  fs.writeFileSync(path.join(TMP, 'data-other-instance.json.gz'), zlib.gzipSync(JSON.stringify(next)));
  const meta = JSON.parse(fs.readFileSync(path.join(TMP, 'meta.json'), 'utf8'));
  fs.writeFileSync(path.join(TMP, 'meta.json'), JSON.stringify({
    ...meta, dataKey: 'data-other-instance.json.gz', uploadedAt: new Date(Date.parse(meta.uploadedAt) + 1000).toISOString(),
  }));

  const [a, b] = await Promise.all([service.getSnapshotD(), service.getSnapshotD()]);
  assert.notEqual(a, first, 'a new uploadedAt replaces the entry');
  assert.equal(a, b, 'concurrent first reads share one load');
  assert.equal(await service.getSnapshotD(), a);
  assert.deepEqual(await ok('/summary'), json(agg.buildSummary(next, {})));
  assert.notDeepEqual(await ok('/summary'), json(agg.buildSummary(D, {})), 'positive control: the new data shows');

  // A regular upload through the service primes the cache with what it stored.
  const third = syntheticD();
  third.employees.Bharat.daily[0].revenue += 7;
  await service.saveSnapshot({ buffer: asDataJs(third), originalName: 'data.js', user: { user_id: 9, user_name: 'MIS User' } });
  const primed = await service.getSnapshotD();
  assert.deepEqual(json(primed), json(third));
  assert.equal(await service.getSnapshotD(), primed);
  assert.deepEqual(await ok('/summary?vertical=Sports'), json(agg.buildSummary(third, { verticals: ['Sports'] })));
});

test('the existing /meta and /dashboard reads still answer', async () => {
  const meta = await get('/meta');
  assert.equal(meta.status, 200);
  assert.equal(meta.body.data.employeeCount, Object.keys(D.employees).length);
  const dash = await get('/dashboard');
  assert.equal(dash.status, 200);
  assert.equal(dash.cache, 'no-store');
  assert.match(dash.body.data.html, /const D=/);
});
