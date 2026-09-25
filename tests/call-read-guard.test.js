/*
 * callReadGuard — who may HEAR a call.
 *
 * ─── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * The per-call READ paths were owner-or-Admin, which left a supervisor unable
 * to review calls placed on their own jobs. The rule was widened to "you
 * placed it, OR its job is one you could already open" — and a widening of an
 * access boundary is exactly the change that needs its DENY arms pinned,
 * because every one of them is invisible in the happy path.
 *
 * Three of these tests exist for a branch that returns the WRONG answer
 * silently rather than erroring:
 *
 *   · An INBOUND row's `caller_id` is the CUSTOMER's identifier, not a
 *     tbl_user id. Comparing it to req.user.user_id compares two namespaces
 *     and can match by coincidence — so a user whose id collides with a
 *     customer number would "own" a stranger's inbound call. isCallOwner is
 *     false for anything not OUT, and this file proves it with a row that
 *     WOULD match on caller_id alone.
 *   · assertEntityInScope treats an ABSENT dimension as in-scope. A call with
 *     no job resolves to no client, no city, no vertical — every dimension
 *     absent — so reusing the guard verbatim would make the LEAST-scoped rows
 *     world-readable, in exactly the direction the change existed to prevent.
 *   · A wildcard client scope (manage_clients='0') would pass the job-scope
 *     arm for every job in the company. ~31 of ~71 active dialers hold one.
 *
 * Every deny test is paired with a POSITIVE CONTROL that flips ONE operand and
 * gets a 200, so a refusal can never be attributed to the fixture.
 *
 * Driven through GET /:id/recording: a Kaleyra row carries an https URL, so
 * the allow path returns immediately after the gate — no S3, no provider, no
 * network. Non-destructive: fake pool, no DB.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const OWNER_ID = 77;          // the operator who placed the outbound call
const COLLEAGUE_ID = 88;      // a different operator, reachable only via job scope

const JOB_ID = 900;
const JOB_CLIENT = 10;
const JOB_CITY = 42;
const JOB_VERTICAL = 3;

const REC_URL = 'https://recordings.example.test/kaleyra/abc.mp3';

const CALL_OUT = 5001;        // OUT, placed by OWNER_ID, attached to JOB_ID
const CALL_IN = 5002;         // IN, caller_id happens to equal OWNER_ID
const CALL_NO_JOB = 5003;     // OUT by someone else, job_id NULL
const CALL_JOB_ZERO = 5004;   // OUT by someone else, legacy job_id = 0 sentinel

const CALLS = {
  [CALL_OUT]: { job_id: JOB_ID, caller_id: OWNER_ID, call_type: 'OUT' },
  [CALL_IN]: { job_id: JOB_ID, caller_id: OWNER_ID, call_type: 'IN' },
  [CALL_NO_JOB]: { job_id: null, caller_id: 999, call_type: 'OUT' },
  [CALL_JOB_ZERO]: { job_id: 0, caller_id: 999, call_type: 'OUT' },
};

/* Zonal Field Team, NOT Admin. SCOPE_BYPASS_ROLES = {Admin, Finance}, so a
 * test run as Admin short-circuits every arm below and proves nothing. */
const ROLE = { role_id: 12, role_name: 'Zonal Field Team', role_status: 1, menu_ids: '' };
const ADMIN_ROLE = { role_id: 2, role_name: 'Admin', role_status: 1, menu_ids: '' };
/*
 * Finance is in SCOPE_BYPASS_ROLES and is deliberately NOT a bypass here — see
 * RECORDING_BYPASS_ROLES in routes/admin/calls.js. Pinned because the change
 * that narrowed it broke no test: the guard had gone from an Admin-only inline
 * check to bypassesScope(), silently handing Finance every customer
 * conversation, and nothing went red either way. A behaviour no test can
 * distinguish is a behaviour nobody chose.
 */
const FINANCE_ROLE = { role_id: 7, role_name: 'Finance', role_status: 1, menu_ids: '' };

/* ⚠ ORDER MATTERS: /FROM tbl_job/ would also match tbl_job_caller_info, so the
 * caller-info route has to come first. */
const fake = installFakePool([
  [/FROM easyfix_properties/i, () => ([])],
  [/SELECT user_role FROM tbl_user/i, [{ user_role: 12 }]],
  [/FROM tbl_role/i, [ROLE]],
  [/ma\.action_name/i, [{ action_name: 'isClickToCall' }]],
  [/FROM tbl_job_caller_info/i, (sql, params) => {
    const c = CALLS[Number(params?.[0])];
    if (!c) return [];
    return [{
      id: Number(params[0]), ...c,
      provider: 'kaleyra', unique_id: 'uuid-' + params[0], recording: REC_URL,
    }];
  }],
  [/FROM tbl_job j/i, (sql, params) => (Number(params?.[0]) === JOB_ID
    ? [{ client_id: JOB_CLIENT, city_id: JOB_CITY, vertical_id: JOB_VERTICAL }]
    : [])],
  [/UPDATE|INSERT|SELECT/i, []],
]);

const express = require('express');
const properties = require('../services/properties.service');
const callsRouter = require('../routes/admin/calls');

let server;
let baseUrl;
/* Mutated per test, then read by the request-scoped middleware below. */
let userForRequest;
let roleForRequest;
let scopeForRequest;

before(async () => {
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'test-secret';
  await properties.preload();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { user_id: userForRequest, user_name: 'Op ' + userForRequest, mobile_no: '9910000001' };
    req.userRole = { ...roleForRequest };
    /* routes/admin/index.js normally attaches this once per request. Setting
     * the property AT ALL is what buildRequestScope keys on (hasOwnProperty),
     * so `undefined` here means "bypass", not "absent". */
    req.scope = scopeForRequest;
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

async function recording(callId) {
  const res = await fetch(`${baseUrl}/calls/${callId}/recording`);
  return { status: res.status, body: await res.json() };
}

/* A scope object shaped like the admin middleware's. `clients` defaults to an
 * allow-list that does NOT contain the job's client, so nothing passes the
 * job-scope arm by accident. */
const scope = (over = {}) => ({
  clients: { mode: 'allow', ids: [999], placeholders: '?' },
  cities: { mode: 'all', ids: [], placeholders: '' },
  states: { mode: 'all', ids: [], placeholders: '' },
  verticals: { mode: 'all', ids: [], placeholders: '' },
  ...over,
});
const allowClients = (...ids) => ({ clients: { mode: 'allow', ids, placeholders: ids.map(() => '?').join(',') } });

function as(userId, { role = ROLE, scope: s = scope() } = {}) {
  userForRequest = userId;
  roleForRequest = role;
  scopeForRequest = s;
}

// ─── The owner arm ────────────────────────────────────────────────────

test('the operator who PLACED an outbound call hears it, on a job they cannot otherwise reach', async () => {
  // clients=[999], so the job-scope arm is closed. Only the owner arm can
  // produce a 200 here — which is what makes this a test OF the owner arm.
  as(OWNER_ID);
  const { status, body } = await recording(CALL_OUT);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.data.url, REC_URL);
});

test('the SAME user does NOT own an INBOUND row whose caller_id equals their user id', async () => {
  /*
   * THE NAMESPACE TRAP. On an IN row caller_id carries the CUSTOMER's number,
   * not a tbl_user id. This fixture is the coincidence made concrete: the
   * numbers are equal, and the answer must still be no.
   *
   * Delete the call_type check in isCallOwner and this test — and only this
   * test — goes green with a 200.
   */
  as(OWNER_ID);
  const { status } = await recording(CALL_IN);
  assert.equal(status, 403, 'an inbound row has no owner in this table');
});

test('POSITIVE CONTROL — the same inbound row IS audible once its job is in scope', async () => {
  // Same row, same user, one operand flipped: the client allow-list. Proves
  // the 403 above came from call_type and not from the row being unreachable.
  as(OWNER_ID, { scope: scope(allowClients(JOB_CLIENT)) });
  const { status, body } = await recording(CALL_IN);
  assert.equal(status, 200, JSON.stringify(body));
});

// ─── The job-scope arm ────────────────────────────────────────────────

test('a colleague who could open the call\'s job hears it', async () => {
  as(COLLEAGUE_ID, { scope: scope(allowClients(JOB_CLIENT)) });
  const { status, body } = await recording(CALL_OUT);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.data.url, REC_URL);
});

test('FINANCE does NOT bypass — recording bypass is Admin-only, unlike scope generally', async () => {
  /*
   * SCOPE_BYPASS_ROLES is {Admin, Finance}, and reusing bypassesScope() here
   * would have handed Finance every customer conversation. The check the guard
   * replaced was `user_role === 2` — Admin alone — so borrowing the helper
   * would have widened a second axis nobody asked about, as a side effect of
   * reuse. Finance is therefore scoped like anyone else.
   *
   * This test exists because narrowing it broke NOTHING: 15 tests passed with
   * Finance bypassing and 15 passed with it not. A behaviour no test can
   * distinguish is a behaviour nobody chose.
   */
  as(COLLEAGUE_ID, { role: FINANCE_ROLE, scope: scope(allowClients(4242)) });
  const refused = await recording(CALL_OUT);
  assert.equal(refused.status, 403, JSON.stringify(refused.body));

  // Control: the SAME Finance user hears it once the job is genuinely in scope,
  // proving the 403 above is the scope arm and not a blanket ban on the role.
  as(COLLEAGUE_ID, { role: FINANCE_ROLE, scope: scope(allowClients(JOB_CLIENT)) });
  const allowed = await recording(CALL_OUT);
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
});

test('ADMIN still bypasses, on a job it could not otherwise reach', async () => {
  as(COLLEAGUE_ID, { role: ADMIN_ROLE, scope: scope(allowClients(4242)) });
  const { status } = await recording(CALL_OUT);
  assert.equal(status, 200, 'Admin bypass is the one this change deliberately KEPT');
});

test('a colleague scoped to ANOTHER client is refused', async () => {
  as(COLLEAGUE_ID, { scope: scope(allowClients(4242)) });
  const { status, body } = await recording(CALL_OUT);
  assert.equal(status, 403, JSON.stringify(body));
});

test('city and vertical narrow it too — the client allow-list is not the only dimension', async () => {
  as(COLLEAGUE_ID, {
    scope: scope({ ...allowClients(JOB_CLIENT), cities: { mode: 'allow', ids: [1], placeholders: '?' } }),
  });
  const { status } = await recording(CALL_OUT);
  assert.equal(status, 403);
});

// ─── The two deny arms assertEntityInScope cannot express ─────────────

/*
 * ⚠ THE STATUS CODE ALONE CANNOT TEST THIS ARM, and asserting only on it is a
 * control that cannot fail. Delete the arm and a job-less row still 403s —
 * `WHERE j.job_id = 0` matches nothing, so the "job not found" arm below
 * catches the same rows. The arm's observable effect is that it denies BEFORE
 * the lookup, so that is what these assert: 403 AND no job query issued. With
 * the arm removed the query appears and both go red.
 *
 * Belt and braces, deliberately: it saves a round trip today, and it is the
 * only thing that still denies if the job lookup ever grows a fallback.
 */
const jobLookups = () => fake.calls.filter((c) => /FROM tbl_job j\b/.test(c.sql)).length;

test('a call with NO job is refused before any job lookup — no client, no city, no vertical', async () => {
  /*
   * The fail-open branch this arm exists to close. inDim() returns true for a
   * NULL dimension, so a row that resolves to no dimensions at all would be
   * readable by EVERYONE with the permission — the row with the least scope
   * attached to it being the most widely readable.
   */
  as(COLLEAGUE_ID, { scope: scope(allowClients(JOB_CLIENT)) });
  fake.reset();
  const { status, body } = await recording(CALL_NO_JOB);
  assert.equal(status, 403, JSON.stringify(body));
  assert.equal(jobLookups(), 0, 'a job-less row must be denied without resolving a job');
});

test('the legacy job_id = 0 sentinel is refused on the same footing as NULL', async () => {
  as(COLLEAGUE_ID, { scope: scope(allowClients(JOB_CLIENT)) });
  fake.reset();
  const { status } = await recording(CALL_JOB_ZERO);
  assert.equal(status, 403);
  assert.equal(jobLookups(), 0, 'the 0 sentinel must take the same arm as NULL');
});

test('CONTROL — an in-scope row DOES issue the job lookup', async () => {
  // Proves jobLookups() can count: without this, "0 lookups" is equally
  // consistent with a matcher that never matches anything.
  as(COLLEAGUE_ID, { scope: scope(allowClients(JOB_CLIENT)) });
  fake.reset();
  const { status } = await recording(CALL_OUT);
  assert.equal(status, 200);
  assert.equal(jobLookups(), 1, 'the scope arm resolves the job exactly once');
});

test('POSITIVE CONTROL — a bypass role still hears the job-less row', async () => {
  /*
   * The job-less arm is a scope rule, not a blanket ban: Admin/Finance bypass
   * scope everywhere else and must here too. This also proves the two 403s
   * above are the ARM firing, not the fixture failing to resolve.
   */
  as(COLLEAGUE_ID, { role: ADMIN_ROLE, scope: undefined });
  const { status, body } = await recording(CALL_NO_JOB);
  assert.equal(status, 200, JSON.stringify(body));
});

test('a WILDCARD client scope is refused — it must not mean "every recording"', async () => {
  /*
   * The narrow variant. manage_clients='0' parses to mode 'all', which passes
   * every job on earth through the scope arm. ~31 of ~71 active dialers carry
   * one, so the broad rule alone would hand ~44% of them the whole company's
   * audio. They keep the owner arm; the scope arm is closed to them.
   */
  as(COLLEAGUE_ID, { scope: scope({ clients: { mode: 'all', ids: [], placeholders: '' } }) });
  const { status, body } = await recording(CALL_OUT);
  assert.equal(status, 403, JSON.stringify(body));
});

test('the wildcard rule reads the PRE-FOLD dimension, so a vertical fold cannot launder it', async () => {
  /*
   * buildRequestScopeWithHierarchy rewrites `clients` into a folded allow-list
   * and parks the original on `entityClients` — which is the dimension
   * assertEntityInScope itself reads, and the one the ~31 was counted from.
   * Reading `clients` here instead would let exactly those users back in.
   */
  as(COLLEAGUE_ID, {
    scope: scope({
      clients: { mode: 'allow', ids: [JOB_CLIENT], placeholders: '?' },
      entityClients: { mode: 'all', ids: [], placeholders: '' },
    }),
  });
  const { status } = await recording(CALL_OUT);
  assert.equal(status, 403);
});

test('POSITIVE CONTROL — the wildcard user hears a call they PLACED', async () => {
  // Same wildcard scope, owner arm instead of scope arm. The narrow rule
  // removes the scope arm from these users, never their own calls.
  as(OWNER_ID, { scope: scope({ clients: { mode: 'all', ids: [], placeholders: '' } }) });
  const { status, body } = await recording(CALL_OUT);
  assert.equal(status, 200, JSON.stringify(body));
});

// ─── Coverage of the READ paths, and of what must stay owner-only ─────

test('every READ path is gated, and the two ACT paths stay owner-only', async () => {
  /*
   * The drift guard. Behaviour above is asserted through /:id/recording only;
   * this is what says the other three read paths route through the same
   * function — and that /:id/hangup and /:id/web-failed did NOT get widened
   * along with them. web-failed writes a first-person account into the audit
   * trail: an Admin reporting a failure on a leg they never held is hearsay.
   *
   * Comments are stripped first, or a `// see callReadGuard` would satisfy
   * the positive half; and every extracted body is checked to be non-empty
   * and to contain its own distinctive text, or a slicing bug would report a
   * clean pass over nothing.
   */
  const src = require('fs').readFileSync(require.resolve('../routes/admin/calls.js'), 'utf8');
  const bodyOf = (decl) => {
    const from = src.indexOf(decl);
    assert.notEqual(from, -1, `route not found: ${decl}`);
    const body = src.slice(from, src.indexOf('\n});', from));
    assert.ok(body.length > 100, `extracted an empty body for ${decl}`);
    return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  };

  for (const [decl, probe] of [
    ["router.get('/:id/status'", 'TERMINAL_STATUSES.has'],
    ["router.get('/:id/recording'", 'buildCallRecordingKey'],
    ["router.get('/:id/analysis'", 'analysisModeOf'],
    ["router.post('/:id/reanalyse'", 'resetTranscriptForRefetch'],
  ]) {
    const body = bodyOf(decl);
    assert.match(body, new RegExp(probe), `${decl}: sliced the wrong route`);
    assert.match(body, /await callReadGuard\(req,/, `${decl} must go through callReadGuard`);
  }

  for (const [decl, probe] of [
    ["router.post('/:id/hangup'", 'voice.hangup'],
    ["  '/:jobCallerInfoId/web-failed'", 'markTerminalByJci'],
  ]) {
    const body = bodyOf(decl);
    assert.match(body, new RegExp(probe), `${decl}: sliced the wrong route`);
    assert.doesNotMatch(body, /callReadGuard/, `${decl} must stay owner-only`);
    assert.match(body, /caller_id != null/, `${decl} must keep its own ownership check`);
  }
});

test('the list projects has_recording, never the raw recording URL', async () => {
  /*
   * A Kaleyra row's `recording` column IS a playable https URL, so projecting
   * it from a role-gated list was a wider audio path than the endpoint this
   * file gates. Asserted structurally because no fixture can prove the absence
   * of a column across every filter combination the list accepts.
   */
  const src = require('fs').readFileSync(require.resolve('../routes/admin/calls.js'), 'utf8');
  const from = src.indexOf("router.get('/', validate(callListQuery");
  assert.notEqual(from, -1, 'list route not found');
  const body = src.slice(from).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const select = body.slice(body.indexOf('SELECT jci.job_caller_info'), body.indexOf('ORDER BY jci.inserted_time'));
  assert.ok(select.includes('jci.caller_status'), 'sliced the wrong projection');
  assert.match(select, /AS has_recording/, 'the list must expose presence, not the URL');
  assert.doesNotMatch(select, /^\s*jci\.recording,\s*$/m, 'the raw recording URL is back in the list');
});

test('recording_lost flags ONLY the proven-absent outage rows', async () => {
  /*
   * "No recording" up front must never hide audio that exists. The only rows
   * PROVEN to have none are the 2026-09-24/25 outage calls, which carry
   * recording_id='starting' with no URL (the Plivo account holds zero
   * recordings in that window). A blank recording_url alone is the NORMAL
   * state of a playable web call, so it must not be the test.
   */
  const src = require('fs').readFileSync(require.resolve('../routes/admin/calls.js'), 'utf8');
  const from = src.indexOf("router.get('/', validate(callListQuery");
  const body = src.slice(from).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const select = body.slice(body.indexOf('SELECT jci.job_caller_info'), body.indexOf('ORDER BY jci.inserted_time'));
  const lost = select.slice(select.indexOf('EXISTS'), select.indexOf('AS recording_lost'));
  assert.ok(select.includes('AS recording_lost'), 'the list must expose recording_lost');
  assert.match(lost, /recording_id = 'starting'/, 'keyed on the outage marker');
  assert.match(lost, /recording_url IS NULL/, 'a row that DID get a URL is never lost');
  assert.match(lost, /job_caller_info_id = jci\.job_caller_info/, 'scoped to this call');
});
