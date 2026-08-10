/*
 * POST /admin/calls/web-start — a ROUTE-level smoke test.
 *
 * ─── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * The conference block in this handler was copied from /click-to-call and kept
 * its `resolvedProvider === 'plivo' &&` guard. That variable exists in
 * /click-to-call, which resolves a provider; it does not exist here, because web
 * calling IS Plivo by definition. Every web call 500'd with
 * "resolvedProvider is not defined" — in production, on a route that had been
 * working for months.
 *
 * NOTHING IN THE TOOLCHAIN COULD HAVE CAUGHT IT:
 *   - `npm run build` is `node --check`: syntax only. An undefined identifier is
 *     valid syntax; it fails at RUNTIME, when the line executes.
 *   - this backend has no ESLint, so `no-undef` never ran.
 *   - the conference tests I wrote covered plivo.service's stashWebDial /
 *     resolveWebDial — the SERVICE — and never executed the route that calls
 *     them. Testing the pieces around a seam is not testing the seam.
 *
 * So the guard has to be execution. This mounts the REAL router and drives the
 * REAL handler; any ReferenceError in the path surfaces as a 500 here rather
 * than in ops' logs. It deliberately asserts little about the response body —
 * its job is "this handler runs end to end", which is exactly the assertion that
 * was missing.
 *
 * Non-destructive: fake pool, stubbed fetch, no network, no DB.
 * Runner: `node --test`.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const AGENT = { user_id: 77, user_name: 'Shaifali', mobile_no: '9910000001', role: 'Admin' };
const EFR_ID = 290;

let props = [
  { property_key: 'voice.call.mode', property_value: 'web' },
  { property_key: 'plivo.calling.enabled', property_value: 'true' },
];

installFakePool([
  [/FROM easyfix_properties/i, () => props],
  /*
   * requireClickToCallAction → getEffectivePermissions, which is THREE queries:
   * the user's role, the role row, then the action names. All three have to be
   * fixtured or the handler 403s at the guard and never reaches the conference
   * block — which is precisely how the first draft of this test passed while the
   * bug it was written for was still present. A route test that stops at the
   * middleware is not a route test.
   */
  [/SELECT user_role FROM tbl_user/i, [{ user_role: 2 }]],
  [/FROM tbl_role/i, [{ role_id: 2, role_name: 'Admin', role_status: 1, menu_ids: '' }]],
  [/ma\.action_name/i, [{ action_name: 'isClickToCall' }]],
  [/FROM tbl_easyfixer/i, [{ efr_id: EFR_ID, efr_name: 'Ramesh K', efr_no: '9910000002' }]],
  [/INSERT INTO tbl_job_caller_info/i, { insertId: 944793 }],
  [/INSERT INTO tbl_job_conference/i, { insertId: 5 }],
  [/FROM tbl_job_conference/i, [{ id: 5, friendly_name: 'efxcweb00001', status: 'creating' }]],
  [/INSERT INTO tbl_plivo_call_log/i, { insertId: 900 }],
  [/tbl_plivo_call_log/i, []],
  [/UPDATE|INSERT|SELECT/i, []],
]);

const express = require('express');
const properties = require('../services/properties.service');
const callsRouter = require('../routes/admin/calls');

let server;
let baseUrl;
let plivoResponder = null;      // (url) => { status, body } | null
const realFetch = globalThis.fetch;

before(async () => {
  process.env.PLIVO_AUTH_ID = 'auth-id-test';
  process.env.PLIVO_AUTH_TOKEN = 'auth-token-test';
  process.env.PLIVO_CALLER_ID = '911140000000';
  process.env.PLIVO_CALLBACK_BASE_URL = 'https://core.easyfix.in';
  // The browser-endpoint credentials web-credentials legitimately requires. Set
  // here so its OWN guard passes and the tests exercise the body — otherwise the
  // endpoint 503s at the door and the config diagnostic is never reached.
  process.env.PLIVO_ENDPOINT_USERNAME = 'endpoint-test';
  process.env.PLIVO_ENDPOINT_PASSWORD = 'endpoint-pass';
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'test-secret';
  await properties.preload();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { ...AGENT }; next(); });
  app.use('/calls', callsRouter);
  // Surfaces a thrown ReferenceError as a 500 with its message — which is
  // exactly the shape the production failure took.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { res.status(500).json({ success: false, error: String(err && err.message) }); });

  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith(baseUrl)) return realFetch(url, init);
    // A test that needs a SPECIFIC provider answer installs a responder; anything
    // it declines to handle falls through to the generic success below.
    if (plivoResponder) {
      const scripted = plivoResponder(u);
      if (scripted) {
        return {
          ok: scripted.status >= 200 && scripted.status < 300,
          status: scripted.status,
          headers: { get: () => null },
          text: async () => JSON.stringify(scripted.body ?? {}),
          json: async () => (scripted.body ?? {}),
        };
      }
    }
    // Any outbound Plivo call succeeds; this test is about the handler, not the provider.
    return {
      ok: true, status: 201, headers: { get: () => null },
      text: async () => JSON.stringify({ request_uuid: ['req-1'], message: 'ok' }),
      json: async () => ({ request_uuid: ['req-1'], message: 'ok' }),
    };
  };
});

after(async () => {
  globalThis.fetch = realFetch;
  if (server) await new Promise((r) => server.close(r));
});

const post = async (path, body) => {
  const res = await realFetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
};

test('web-start runs end to end — no ReferenceError from the conference block', async () => {
  const res = await post('/calls/web-start', { efrId: EFR_ID });

  /*
   * THE ASSERTION THAT WAS MISSING. The production failure was a 500 carrying
   * "resolvedProvider is not defined"; asserting the absence of a 500 is what
   * catches an out-of-scope identifier anywhere in this handler, not just that
   * one. A 4xx would be a legitimate outcome of the fixture data — a 500 never is.
   */
  /*
   * NON-VACUITY GUARD, and it is the point of this test. The first draft
   * asserted only "not a 500" and got a 403 from the permission middleware — so
   * it went green without the handler body ever executing, i.e. it would have
   * passed with the very bug it exists to catch. Assert we got PAST the guard
   * before asserting anything about what happens after it.
   */
  assert.notEqual(res.status, 403,
    'the permission fixture is wrong — this test never reached the handler body');
  assert.notEqual(res.status, 500,
    `web-start 500'd: ${res.body && res.body.error}`);
  if (res.body && res.body.error) {
    assert.equal(/is not defined|Cannot read properties/.test(String(res.body.error)), false,
      `a scope/runtime error escaped: ${res.body.error}`);
  }
});

test('web calling refuses cleanly when the mode is mobile — a 409, never a crash', async () => {
  const saved = props;
  props = props.map((p) => (p.property_key === 'voice.call.mode' ? { ...p, property_value: 'mobile' } : p));
  await properties.flushCache();
  try {
    const res = await post('/calls/web-start', { efrId: EFR_ID });
    assert.equal(res.status, 409, 'the mode guard answers, rather than falling through');
  } finally {
    props = saved;
    await properties.flushCache();
  }
});

/*
 * GET /admin/calls/web-credentials — executed, not just written.
 *
 * This endpoint mints the Plivo browser token and hands back the DID the browser
 * dials. It had no test, and while adding a config diagnostic to it I wrote
 * `plivo.callbackBase()` — a real function in plivo.service that is NOT
 * exported. That is a TypeError on the first request, which would have taken
 * web calling down completely rather than merely reporting on it.
 *
 * `no-undef` does NOT catch that: a property access on an imported object is
 * valid to the linter. Only running the line finds it — which is the same
 * lesson as the 500 that started all of this, one level down.
 */
test('web-credentials executes and reports missing web config instead of hiding it', async () => {
  const saved = process.env.PLIVO_WEB_APP_ID;
  delete process.env.PLIVO_WEB_APP_ID;
  try {
    const res = await realFetch(`${baseUrl}/calls/web-credentials`);
    const body = await res.json();

    assert.notEqual(res.status, 500, `web-credentials 500'd: ${body && body.error}`);
    assert.equal(res.status, 200);
    assert.ok(body.data.token, 'a token is still issued — this reports, it does not enforce');
    assert.ok(Array.isArray(body.data.warnings), 'warnings is always present, empty when healthy');
    assert.equal(
      body.data.warnings.some((w) => /PLIVO_WEB_APP_ID/.test(w)),
      true,
      'an unset app id must be NAMED — silently omitting the `app` claim is what makes every '
      + 'outgoing call fail as "Busy" with nothing in our logs',
    );
  } finally {
    if (saved === undefined) delete process.env.PLIVO_WEB_APP_ID;
    else process.env.PLIVO_WEB_APP_ID = saved;
  }
});

test('web-credentials reports NO warnings when the environment is complete', async () => {
  const saved = process.env.PLIVO_WEB_APP_ID;
  process.env.PLIVO_WEB_APP_ID = 'app-id-test';
  try {
    const res = await realFetch(`${baseUrl}/calls/web-credentials`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.data.warnings, [], 'a healthy env must be quiet, or the signal is noise');
  } finally {
    if (saved === undefined) delete process.env.PLIVO_WEB_APP_ID;
    else process.env.PLIVO_WEB_APP_ID = saved;
  }
});

/*
 * GET /admin/calls/web-diagnostics — the endpoint that asks PLIVO what it has.
 *
 * It exists because every check we owned came back clean while web calling was
 * completely broken: the token was issued, the env vars were set, `warnings`
 * was empty. A variable being SET tells you nothing about whether it points at
 * an application that still exists, is enabled, and answers on our host — and
 * those three are exactly the failures that survive a config review.
 *
 * Executed, not just written. The last diagnostic added to this router called an
 * unexported helper and would have TypeError'd on its first request; `no-undef`
 * cannot see that, and only running the line does.
 */
test('web-diagnostics NAMES a stale answer URL instead of reporting healthy', async () => {
  const savedApp = process.env.PLIVO_WEB_APP_ID;
  process.env.PLIVO_WEB_APP_ID = 'app-123';
  plivoResponder = (u) => {
    if (/\/Application\/app-123\/$/.test(u)) {
      return { status: 200, body: {
        app_id: 'app-123', app_name: 'EasyFix Web Call', enabled: true,
        // Points at LAST QUARTER'S HOST — set, valid, and completely wrong.
        answer_url: 'https://old-host.example.com/api/public/plivo/web-answer',
        answer_method: 'POST', hangup_url: 'https://core.easyfix.in/api/webhook/plivo/web-hangup',
      } };
    }
    if (/\/Endpoint\/$/.test(u)) {
      return { status: 200, body: { objects: [{ username: 'endpoint-test', application: '/v1/Account/X/Application/app-123/' }] } };
    }
    return null;
  };
  try {
    const res = await realFetch(`${baseUrl}/calls/web-diagnostics`);
    const body = await res.json();

    assert.notEqual(res.status, 403, 'the permission fixture is wrong — the handler never ran');
    assert.equal(res.status, 200, `web-diagnostics failed: ${body && body.error}`);
    assert.equal(body.data.healthy, false, 'a wrong answer URL is not healthy');

    const answer = body.data.checks.find((c) => c.name === 'Answer URL');
    assert.ok(answer, 'the answer URL is checked at all');
    assert.equal(answer.ok, false);
    assert.match(answer.detail, /old-host\.example\.com/, 'it QUOTES what Plivo will actually fetch');
    assert.match(answer.detail, /core\.easyfix\.in/, 'beside what this server expects');

    // The app itself resolved, so that check must PASS — otherwise the report
    // blames the wrong thing and sends ops to recreate a healthy application.
    assert.equal(body.data.checks.find((c) => c.name === 'Voice Application').ok, true);
  } finally {
    plivoResponder = null;
    if (savedApp === undefined) delete process.env.PLIVO_WEB_APP_ID;
    else process.env.PLIVO_WEB_APP_ID = savedApp;
  }
});

test('web-diagnostics reports healthy when Plivo agrees with us', async () => {
  const savedApp = process.env.PLIVO_WEB_APP_ID;
  process.env.PLIVO_WEB_APP_ID = 'app-123';
  plivoResponder = (u) => {
    if (/\/Application\/app-123\/$/.test(u)) {
      return { status: 200, body: {
        app_id: 'app-123', app_name: 'EasyFix Web Call', enabled: true,
        answer_url: 'https://core.easyfix.in/api/public/plivo/web-answer',
        answer_method: 'POST', hangup_url: 'https://core.easyfix.in/api/webhook/plivo/web-hangup',
      } };
    }
    if (/\/Endpoint\/$/.test(u)) {
      return { status: 200, body: { objects: [{ username: 'endpoint-test', application: '/v1/Account/X/Application/app-123/' }] } };
    }
    return null;
  };
  try {
    const res = await realFetch(`${baseUrl}/calls/web-diagnostics`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.data.healthy, true,
      'a healthy environment must report clean, or the report is noise: '
      + JSON.stringify(body.data.checks.filter((c) => !c.ok)));
  } finally {
    plivoResponder = null;
    if (savedApp === undefined) delete process.env.PLIVO_WEB_APP_ID;
    else process.env.PLIVO_WEB_APP_ID = savedApp;
  }
});

test('web-diagnostics says so plainly when the app id points at nothing', async () => {
  const savedApp = process.env.PLIVO_WEB_APP_ID;
  process.env.PLIVO_WEB_APP_ID = 'deleted-app';
  plivoResponder = (u) => (/\/Application\/deleted-app\/$/.test(u)
    ? { status: 404, body: { error: 'not found' } }
    : null);
  try {
    const res = await realFetch(`${baseUrl}/calls/web-diagnostics`);
    const body = await res.json();
    assert.equal(res.status, 200, 'a broken environment still gets a REPORT, never a 500');
    const app = body.data.checks.find((c) => c.name === 'Voice Application');
    assert.equal(app.ok, false);
    assert.match(app.detail, /does not exist/i);
  } finally {
    plivoResponder = null;
    if (savedApp === undefined) delete process.env.PLIVO_WEB_APP_ID;
    else process.env.PLIVO_WEB_APP_ID = savedApp;
  }
});
