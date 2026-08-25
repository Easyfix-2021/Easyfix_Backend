/*
 * GET /api/admin/easyfixers/:efrId/mirror/* — the read-only technician-app
 * mirror.
 *
 * ─── WHAT THESE TESTS ARE FOR ──────────────────────────────────────────────
 *
 * The mirror mints a real technician JWT and replays the real mobile router
 * with it. That is a deliberately sharp tool: three things keep it a viewer
 * rather than an impersonation endpoint, and all three are the kind of thing
 * a later "small refactor" silently removes.
 *
 *   1. GET only — POST /mobile/device runs a single-active-session sweep that
 *      logs the technician's real phone out mid-job.
 *   2. An anchored path allowlist — a prefix list would admit
 *      GET /jobs/:id/share-link, which mints a public link.
 *   3. The minted token stays in the process.
 *
 * Plus the scope gate, which must answer identically for "no such technician"
 * and "not in your cities" — a differing answer is an existence oracle.
 *
 * Non-destructive: fake pool, no network, no DB.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const EFR_ID = 4242;
const EFR_CITY = 42;
const ABSENT_ID = 999999;

/* Zonal Field Team, NOT Admin — Admin bypasses scope entirely (SCOPE_BYPASS_ROLES),
 * so a test run as Admin would pass against an unguarded route and prove nothing. */
const AGENT = { user_id: 77, user_name: 'Zonal User', mobile_no: '9910000001' };
const ROLE = { role_id: 12, role_name: 'Zonal Field Team', role_status: 1, menu_ids: '' };

/* The one mobile payload asserted verbatim. GET /mobile/experience is a static
 * master list — no per-technician derivation between the row and the response —
 * so "unchanged" means unchanged, not "unchanged modulo enrichment". */
const EXPERIENCE_ROWS = [
  { id: 1, name: '0-1 years', description: null },
  { id: 2, name: '2-5 years', description: 'mid' },
];

const efrRow = {
  efr_id: EFR_ID,
  efr_name: 'Ramesh K',
  efr_first_name: 'Ramesh',
  efr_last_name: 'K',
  efr_no: '9910000002',
  efr_email: 'ramesh@example.com',
  efr_cityId: EFR_CITY,
  efr_service_category: null,
  efr_status: 1,
  is_technician_verified: 1,
  efr_manager_id: null,
  user_id: null,
  insert_date: null,
  update_date: null,
  lifecycle_status: null,
  lifecycle_reason_code: null,
  lifecycle_reason: null,
  lifecycle_changed_at: null,
  lifecycle_source: null,
  lifecycle_version: 0,
};

const fake = installFakePool([
  [/FROM easyfix_properties/i, () => ([])],
  [/FROM information_schema/i, () => ([])],
  [/FROM experience/i, () => EXPERIENCE_ROWS.map((r) => ({ ...r }))],
  [/FROM tbl_role/i, [ROLE]],
  [/FROM tbl_easyfixer/i, (_sql, params) => (Number(params?.[0]) === EFR_ID ? [{ ...efrRow }] : [])],
  [/SELECT user_role FROM tbl_user/i, [{ user_role: 12 }]],
]);

const express = require('express');
const jwt = require('jsonwebtoken');
const properties = require('../services/properties.service');
const mirrorRouter = require('../routes/admin/easyfixer-app-mirror');

/* Every token the route mints, recorded at the source. Lets the leak test
 * search the response for the ACTUAL secret rather than for a JWT-shaped
 * string that a future encoding change might no longer look like. */
const mintedTokens = [];
const realSign = jwt.sign;

let server;
let baseUrl;
let scopeForRequest;

before(async () => {
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'test-secret';
  await properties.preload();

  jwt.sign = (...args) => {
    const token = realSign.apply(jwt, args);
    mintedTokens.push(token);
    return token;
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // routes/admin/index.js normally attaches these once per request.
    req.user = { ...AGENT };
    req.userRole = { ...ROLE };
    req.scope = scopeForRequest;
    next();
  });
  app.use('/easyfixers', mirrorRouter);
  app.use((err, _req, res, _next) => { res.status(500).json({ success: false, error: String(err && err.message) }); });

  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  jwt.sign = realSign;
  fake.restore();
  if (server) await new Promise((resolve) => server.close(resolve));
});

const allow = (...ids) => ({
  cities: { mode: 'allow', ids },
  clients: { mode: 'all', ids: [] },
  states: { mode: 'all', ids: [] },
  verticals: { mode: 'all', ids: [] },
});

async function mirror(efrId, subPath, init) {
  mintedTokens.length = 0;
  const res = await fetch(`${baseUrl}/easyfixers/${efrId}/mirror${subPath}`, init);
  return { status: res.status, body: await res.json() };
}

test('a non-GET method is refused 405 — and mints no token, so no replay happened', async () => {
  /*
   * The method gate is the one that matters most: POST /mobile/device would
   * log the technician's real phone out. Asserting only the 405 would still
   * pass if the route replayed first and refused afterwards, so the real
   * assertion is that nothing was minted.
   */
  scopeForRequest = allow(EFR_CITY);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const { status } = await mirror(EFR_ID, '/experience', { method });
    assert.equal(status, 405, `${method} must be refused`);
    assert.equal(mintedTokens.length, 0, `${method} must not mint a technician token`);
  }
});

test('a path off the allowlist is 404 — and mints no token', async () => {
  /* /bank-details is a real, working GET on the mobile router. It is refused
   * because it is not on the list, not because it does not exist. */
  scopeForRequest = allow(EFR_CITY);
  const { status } = await mirror(EFR_ID, '/bank-details');
  assert.equal(status, 404);
  assert.equal(mintedTokens.length, 0, 'the allowlist must be checked before a token exists');
});

test('GET /jobs/:id/share-link is off the allowlist — the reason it is anchored, not a prefix', async () => {
  // A `/jobs` PREFIX would admit this. It mints a public share link and
  // records the technician as its sharer: a write dressed as a GET.
  scopeForRequest = allow(EFR_CITY);
  const { status } = await mirror(EFR_ID, '/jobs/12/share-link');
  assert.equal(status, 404);
  assert.equal(mintedTokens.length, 0);
});

test('an out-of-scope technician is indistinguishable from one that does not exist', async () => {
  /*
   * A 403 here — or any body that differs — would let a city-scoped operator
   * guess ids and learn which technicians are real. The two bodies echo no id
   * today, but the assertion normalises anyway so it keeps holding if one
   * ever starts to.
   */
  scopeForRequest = allow(99);
  const outOfScope = await mirror(EFR_ID, '/experience');     // exists, other city

  scopeForRequest = allow(EFR_CITY);
  const absent = await mirror(ABSENT_ID, '/experience');      // does not exist

  assert.equal(outOfScope.status, 404);
  assert.equal(outOfScope.status, absent.status, 'a differing status tells the caller the id exists');

  const shape = (r, id) => JSON.stringify(r.body).split(String(id)).join('<id>');
  assert.equal(shape(outOfScope, EFR_ID), shape(absent, ABSENT_ID),
    'once the caller\'s own id is removed, nothing distinguishes the two answers');
});

test('a successful GET returns the mobile envelope with NO second wrapper', async () => {
  /*
   * The mirror must return the mobile handler's body verbatim — ONE envelope.
   *
   * Every /api/mobile/* route already answers { success, data }. Wrapping that
   * again in modernOk() produces { success, data: { success, data } }, and the
   * technician app's own client (src/lib/api.ts) unwraps exactly one level —
   * so every screen would receive an envelope where it expected its payload
   * and render empty. Caught end to end against the running server before this
   * assertion existed; keep it, or the double wrap comes back invisibly.
   */
  scopeForRequest = allow(EFR_CITY);
  const { status, body } = await mirror(EFR_ID, '/experience');
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  assert.deepEqual(body.data, EXPERIENCE_ROWS,
    'exactly one envelope — body.data is the payload, not another envelope');
  assert.ok(
    !(body.data && typeof body.data === 'object' && 'success' in body.data),
    'body.data must not itself be an envelope',
  );
});

test('the path the APP actually sends — /mobile-prefixed — reaches the handler', async () => {
  /*
   * THE SHAPE THE CLIENT REALLY USES.
   *
   * Every other test here calls mirror(EFR_ID, '/experience'), i.e. the path
   * already stripped of its mount prefix. The technician app does not send
   * that. On a phone its base URL is '<host>/api' and the mobile router is
   * mounted at '/api/mobile', so all 83 of its request paths are written
   * '/mobile/...'. Pointed at this proxy, that prefix rides along into the
   * captured path.
   *
   * So the real client sent '/mirror/mobile/experience' while every test
   * asserted on '/mirror/experience' — and the suite was fully green while the
   * mirrored app rendered an error screen on its first request. This test
   * exists so the client's own shape is covered, not just the server's
   * internal one.
   */
  scopeForRequest = allow(EFR_CITY);
  const { status, body } = await mirror(EFR_ID, '/mobile/experience');
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.data, EXPERIENCE_ROWS, 'the /mobile prefix must be stripped, not 404d');
});

test('the prefix is stripped exactly once — /mobile/mobile/... stays refused', async () => {
  // The strip must not become a loop, or a caller could walk back to any path
  // by repeating the prefix. One strip, then the allowlist decides.
  scopeForRequest = allow(EFR_CITY);
  const { status } = await mirror(EFR_ID, '/mobile/mobile/experience');
  assert.equal(status, 404, 'a doubled prefix is off the allowlist');
  assert.equal(mintedTokens.length, 0, 'refused before any token is minted');
});

test('the minted JWT appears nowhere in the response', async () => {
  /*
   * THE test. Everything else is a policy that can be re-argued; this one is
   * the line between a viewer and an endpoint that hands out impersonation
   * credentials for any technician in your scope.
   */
  scopeForRequest = allow(EFR_CITY);
  const { body } = await mirror(EFR_ID, '/experience');
  assert.equal(mintedTokens.length, 1, 'exactly one token per view');

  const serialised = JSON.stringify(body);
  assert.ok(!serialised.includes(mintedTokens[0]), 'the minted token must not be in the body');
  // Nor any other JWT — catches a future refactor that mints a second one.
  assert.ok(!/eyJ[A-Za-z0-9_-]{8,}\./.test(serialised), 'no JWT-shaped string may reach the caller');
  assert.ok(!serialised.toLowerCase().includes('authorization'), 'no request headers travel back');
});

test('the token is short-lived — a leak would have almost no window', async () => {
  scopeForRequest = allow(EFR_CITY);
  await mirror(EFR_ID, '/experience');
  const decoded = jwt.decode(mintedTokens[0]);
  assert.equal(decoded.sub, `efr:${EFR_ID}`, 'the claim shape middleware/tech-auth.js expects');
  assert.ok(decoded.exp - decoded.iat <= 30, 'the mirror token must expire within 30s');
});

test('middleware/tech-auth.js carries no mirror bypass', async () => {
  /*
   * Structural. The replay is safe BECAUSE technician auth is unmodified — a
   * bypass flag added "just for the mirror" would be a hole in every
   * technician's auth, reachable from anywhere that can set the flag.
   */
  const src = require('fs').readFileSync(require.resolve('../middleware/tech-auth.js'), 'utf8');
  assert.ok(!/mirror/i.test(src), 'tech-auth must not know the mirror exists');
});
