/*
 * GET /admin/calls/preview — the RBAC city scope on the efrId branch.
 *
 * ─── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * /preview used to carry its own hand-written copy of all five receiver
 * lookups, under a comment asking the next editor to "change both". On
 * 2026-08-21 the shared resolveReceiver() gained an RBAC city-scope check and
 * the copy here did not — so /preview quietly became the remaining way for a
 * city-scoped user to confirm that a technician in another region exists.
 *
 * The masked number is not the leak. 404-vs-200 is: guess an id, read the
 * status, learn whether that technician is real. `assertEntityInScope`
 * therefore returns the SAME 404 body as "not found", and these tests assert
 * the two are byte-identical rather than merely both-4xx.
 *
 * The fix routed /preview through resolveReceiver. That is what these tests
 * actually protect — not the guard itself (which resolveReceiver's own callers
 * already exercise) but the fact that /preview goes through it at all. A
 * future editor re-inlining a lookup for speed would fail here.
 *
 * Non-destructive: fake pool, no network, no DB.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const EFR_ID = 4242;
const EFR_CITY = 42;
const EFR_NO_NUMBER = 4243;

/* Zonal Field Team, NOT Admin. SCOPE_BYPASS_ROLES = {Admin, Finance}, so an
 * Admin bypasses scope entirely by design — a test run as Admin would pass
 * against the unfixed code and prove nothing. */
const AGENT = { user_id: 77, user_name: 'Zonal User', mobile_no: '9910000001' };
const ROLE = { role_id: 12, role_name: 'Zonal Field Team', role_status: 1, menu_ids: '' };

installFakePool([
  [/FROM easyfix_properties/i, () => ([])],
  [/SELECT user_role FROM tbl_user/i, [{ user_role: 12 }]],
  [/FROM tbl_role/i, [ROLE]],
  [/ma\.action_name/i, [{ action_name: 'isClickToCall' }]],
  [/FROM tbl_easyfixer/i, (sql, params) => {
    const id = Number(params?.[0]);
    if (id === EFR_ID) return [{ efr_id: EFR_ID, efr_first_name: 'Ramesh', efr_last_name: 'K', efr_no: '9910000002', efr_cityId: EFR_CITY }];
    /* In scope, on file, but no number recorded — the case /preview has always
     * tolerated and resolveReceiver rejects with a 400. */
    if (id === EFR_NO_NUMBER) return [{ efr_id: EFR_NO_NUMBER, efr_first_name: 'Sunil', efr_last_name: null, efr_no: null, efr_cityId: EFR_CITY }];
    return [];
  }],
  [/UPDATE|INSERT|SELECT/i, []],
]);

const express = require('express');
const properties = require('../services/properties.service');
const callsRouter = require('../routes/admin/calls');

let server;
let baseUrl;
/* Mutated per test, then read by the request-scoped middleware below. */
let scopeForRequest;

before(async () => {
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'test-secret';
  await properties.preload();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { ...AGENT };
    req.userRole = { ...ROLE };
    /* routes/admin/index.js normally attaches this once per request. Setting
     * the property AT ALL is what buildRequestScope keys on (hasOwnProperty),
     * so `undefined` here means "bypass", not "absent". */
    if (scopeForRequest !== 'absent') req.scope = scopeForRequest;
    next();
  });
  app.use('/calls', callsRouter);
  app.use((err, _req, res, _next) => { res.status(500).json({ success: false, error: String(err && err.message) }); });

  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function preview(efrId) {
  const res = await fetch(`${baseUrl}/calls/preview?efrId=${efrId}`);
  return { status: res.status, body: await res.json() };
}

const allow = (...ids) => ({ cities: { mode: 'allow', ids }, clients: { mode: 'all', ids: [] }, states: { mode: 'all', ids: [] }, verticals: { mode: 'all', ids: [] } });

test('a caller scoped to the technician\'s own city gets the preview', async () => {
  scopeForRequest = allow(EFR_CITY);
  const { status, body } = await preview(EFR_ID);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  assert.ok(body.data.dialTo, 'a receiver leg is resolved');
});

test('a caller scoped to ANOTHER city gets 404 — the leak this file exists for', async () => {
  scopeForRequest = allow(99);
  const { status, body } = await preview(EFR_ID);
  assert.equal(status, 404);
  assert.equal(body.error, `Easyfixer ${EFR_ID} not found`);
});

test('out-of-scope and genuinely-absent are indistinguishable — no existence oracle', async () => {
  /*
   * The response must be a pure function of the id the caller already
   * supplied, carrying no bit that says whether that id is real.
   *
   * The two bodies are not literally equal — each echoes its own id, which
   * the caller typed — so the assertion normalises the id out and compares
   * what remains. Comparing the raw bodies would only prove that 4242 is not
   * 999999.
   */
  scopeForRequest = allow(99);
  const outOfScope = await preview(EFR_ID);          // exists, other city

  scopeForRequest = allow(EFR_CITY);
  const absent = await preview(999999);              // does not exist at all

  assert.equal(outOfScope.status, absent.status,
    'a differing status tells the caller the id exists');

  const shape = (r, id) => JSON.stringify(r.body).split(String(id)).join('<id>');
  assert.equal(shape(outOfScope, EFR_ID), shape(absent, 999999),
    'once the caller\'s own id is removed, nothing distinguishes the two answers');
});

test('a caller scoped to NOTHING sees nobody', async () => {
  scopeForRequest = { cities: { mode: 'none', ids: [] }, clients: { mode: 'all', ids: [] }, states: { mode: 'all', ids: [] }, verticals: { mode: 'all', ids: [] } };
  const { status } = await preview(EFR_ID);
  assert.equal(status, 404);
});

test('an unscoped caller (bypass role) is unaffected', async () => {
  scopeForRequest = undefined;   // what the admin middleware sets for Admin/Finance
  const { status } = await preview(EFR_ID);
  assert.equal(status, 200);
});

test('a handler that never passed through the admin middleware still resolves', async () => {
  /* buildRequestScope falls back to own-scope-only when `scope` is absent
   * entirely. req.user carries no manage_* CSVs here, so every dimension
   * parses to "none" — which must not crash the route. */
  scopeForRequest = 'absent';
  const { status } = await preview(EFR_ID);
  assert.ok(status === 200 || status === 404, `expected a clean answer, got ${status}`);
});

test('/preview issues NO receiver lookup of its own — it goes through resolveReceiver', async () => {
  /*
   * The structural assertion. The leak existed because this route kept a
   * second copy of the lookups; re-inlining one would reintroduce it, and
   * every behavioural test above would still pass on the copy.
   */
  const src = require('fs').readFileSync(require.resolve('../routes/admin/calls.js'), 'utf8');
  const route = src.slice(src.indexOf("router.get('/preview'"));
  const body = route.slice(0, route.indexOf('\n});'));
  assert.equal((body.match(/pool\.query/g) || []).length, 0,
    '/preview must not query for a receiver itself — that is what drifted');
  assert.match(body, /resolveReceiver\(req,/,
    'and it must pass `req`, or the scope check has nothing to check against');
});

test('a technician with NO number still previews — the 400 is swallowed on purpose', async () => {
  /*
   * resolveReceiver returns 400 "has no mobile on file"; /preview deliberately
   * renders anyway with an empty receiver leg, which is exactly what it did
   * before the refactor.
   *
   * The preview's job is to show what WOULD be dialled. A dialog that refuses
   * to open teaches the operator nothing about why, and the POST still refuses
   * the call — so nobody dials a blank number either way.
   */
  scopeForRequest = allow(EFR_CITY);
  const { status, body } = await preview(EFR_NO_NUMBER);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  assert.ok('dialTo' in body.data, 'the preview still answers, with an empty receiver');
});

test('the 400 swallow does NOT swallow an out-of-scope 404', async () => {
  // The two error shapes are treated differently; this pins that the
  // permissive branch cannot accidentally widen to cover the security one.
  scopeForRequest = allow(99);
  const { status } = await preview(EFR_NO_NUMBER);
  assert.equal(status, 404, 'out of scope wins over "no number on file"');
});
