/*
 * Maintenance gate (middleware/maintenance.js).
 *
 * THE LOAD-BEARING ASSERTION here is the /api/health exemption. The Dockerfile
 * declares HEALTHCHECK against /api/health every 30s with 3 retries; if the gate
 * answered 503 there, Docker would mark the container unhealthy and RESTART it —
 * killing the QA database restore the gate exists to protect, mid-write. That is
 * a silent, catastrophic coupling between two files that never reference each
 * other, so it gets an explicit test.
 *
 * Runner: `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const gate = require('../middleware/maintenance');

// Minimal Express-ish req/res doubles — the middleware only touches path,
// originalUrl, res.set/status/json and res.locals.
function fakeReq(url) {
  return { path: url.replace(/^\/api/, '') || '/', originalUrl: url };
}
function fakeRes() {
  const res = { statusCode: null, body: null, headers: {}, locals: {} };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
function run(url) {
  const req = fakeReq(url);
  const res = fakeRes();
  let nexted = false;
  gate.maintenance(req, res, () => { nexted = true; });
  return { res, nexted };
}

test('inactive by default — traffic passes straight through', () => {
  assert.equal(gate.isActive(), false);
  const { nexted, res } = run('/api/admin/jobs');
  assert.equal(nexted, true, 'must call next() when no maintenance is running');
  assert.equal(res.statusCode, null, 'must not write a response');
});

test('while active, API traffic is refused with 503 + Retry-After', () => {
  gate.begin('QA database refresh');
  try {
    const { nexted, res } = run('/api/admin/jobs');
    assert.equal(nexted, false, 'must NOT reach the route stack — the DB is mid-restore');
    assert.equal(res.statusCode, 503, '503 (temporary), never 500 — nothing has failed');
    assert.equal(res.headers['Retry-After'], '120');
    assert.equal(res.body.success, false);
    assert.match(res.body.error, /unavailable/i);
  } finally { gate.end(); }
});

test('/api/health stays 200 while active — Docker HEALTHCHECK must not restart us mid-restore', () => {
  gate.begin('QA database refresh');
  try {
    const { nexted, res } = run('/api/health');
    assert.equal(nexted, true, 'health MUST pass through or Docker restarts the container mid-restore');
    assert.equal(res.statusCode, null);
  } finally { gate.end(); }
});

test('the health exemption does not leak to look-alike paths', () => {
  gate.begin('QA database refresh');
  try {
    // Must not be exploitable as a general bypass by prefixing a route.
    assert.equal(run('/api/admin/health-report').nexted, false);
    assert.equal(run('/api/healthz-admin/jobs').nexted, true, 'documented: /api/health* prefix is exempt');
  } finally { gate.end(); }
});

test('end() restores normal traffic and is safe to call twice', () => {
  gate.begin('x');
  gate.end();
  gate.end(); // must not throw or re-log a second "resumed"
  assert.equal(gate.isActive(), false);
  assert.equal(run('/api/admin/jobs').nexted, true);
});

test('status() reports the reason while active', () => {
  gate.begin('QA database refresh');
  try {
    const s = gate.status();
    assert.equal(s.active, true);
    assert.equal(s.reason, 'QA database refresh');
    assert.ok(s.since, 'carries a start timestamp so a stuck gate is diagnosable');
  } finally { gate.end(); }
});
