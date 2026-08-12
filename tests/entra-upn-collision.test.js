/*
 * UPN COLLISION — the pre-flight, the server-side guard, and the rescue.
 *
 * THE INCIDENT
 * ────────────
 * mohit.kumar@easyfix.in: the Entra account was created at 05:40:01, the licence
 * could not be confirmed at 05:40:04 (mailboxReady=false), and the retry at
 * 06:16 completed cleanly on the REUSE path. The one run that held a temp
 * password had no mailbox; the one run that had a mailbox minted no password. No
 * welcome mail was ever sent, and no number of retries could produce one.
 *
 * Two things had to change, and this file pins both:
 *
 * 1. THE ADDRESS CHECK (isUpnAvailable / suggestAvailableUpn). Asked BEFORE the
 *    CRM row is written, because aborting mid-create leaves an orphan row whose
 *    official_email can never get a mailbox. The assertion that matters most is
 *    the FAILURE one: a check that answers "available" when it does not know is
 *    worse than no check, because it is trusted and the operator stops looking.
 *
 * 2. THE GUARD (decideAccountAction). A pre-flight the client can skip is not a
 *    guard. Reuse is allowed ONLY when the directory object found at that
 *    address is the one already recorded against THIS user_id — otherwise a
 *    second employee with the same name is silently attached to the first one's
 *    mailbox, licence and all.
 *
 * Plus the rescue (POST /:userId/reset-mailbox-password), which is the only way
 * a stranded user can ever receive credentials — and which must leak the
 * password it mints no further than the Graph body and the mail body.
 *
 * NO NETWORK, NO DB: globalThis.fetch is a scripted stub and the mysql2 pool is
 * tests/helpers/fake-pool. Runner: `node --test`.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

// ── Fake DB ───────────────────────────────────────────────────────────────

const USER_ID = 8805;                 // the mohit.kumar row from the incident
const OUR_OBJECT_ID = 'obj-8805';     // what tbl_user_entra_provisioning records

let props = {};
// Mutable so a single test can say "this user has no provisioning row yet" or
// "the recorded licence never landed" without a second fake pool.
let provisioningRow = null;

const fake = installFakePool([
  [/FROM easyfix_properties/i, () =>
    Object.entries(props).map(([property_key, property_value]) => ({ property_key, property_value }))],
  [/SELECT role_id, role_name/i, [{ role_id: 2, role_name: 'Admin', role_status: 1, menu_ids: '' }]],
  [/FROM tbl_user_entra_provisioning/i, () => (provisioningRow ? [provisioningRow] : [])],
  [/INSERT INTO tbl_user_entra_provisioning/i, { affectedRows: 1 }],
  [/FROM tbl_user_personal_details/i, [{ personal_email: 'personal.inbox@gmail.com' }]],
  [/FROM tbl_user_allowed_stages/i, []],
  [/FROM tbl_user\s+u/i, [{
    user_id: USER_ID,
    user_name: 'Mohit Kumar',
    official_email: 'mohit.kumar@easyfix.in',
    user_status: 1,
  }]],
]);

const propsSvc = require('../services/properties.service');
const logger = require('../logger');
const express = require('express');
const entra = require('../services/entra-provisioning.service');
const usersRouter = require('../routes/admin/users');

const ENV_KEYS = [
  'MS_GRAPH_TENANT_ID', 'MS_GRAPH_CLIENT_ID', 'MS_GRAPH_CLIENT_SECRET', 'MS_GRAPH_SENDER_EMAIL',
  'NOTIFICATIONS_DISABLE', 'TEST_EMAILS', 'CRM_PUBLIC_BASE_URL',
];
const savedEnv = {};

let server;
let baseUrl;

before(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  props = {
    'entra.provisioning.enabled': 'true',
    'entra.managed.domains': 'easyfix.in',
    'entra.provisioning.sku.part.number': 'SPB',
  };
  await propsSvc.flushCache();
  process.env.MS_GRAPH_TENANT_ID = 'tenant-test';
  process.env.MS_GRAPH_CLIENT_ID = 'client-test';
  process.env.MS_GRAPH_CLIENT_SECRET = 'secret-test';
  process.env.MS_GRAPH_SENDER_EMAIL = 'ithelpdesk@easyfix.in';
  process.env.CRM_PUBLIC_BASE_URL = 'https://qa.crm.easyfix.in';
  delete process.env.NOTIFICATIONS_DISABLE;
  delete process.env.TEST_EMAILS;

  /*
   * The REAL routes/admin/users.js router, so the guards, the Joi schemas and
   * the refusal order under test are the shipped ones. Only what
   * routes/admin/index.js would have attached (req.user) is injected — that
   * mount is not what we are testing. role_id 2 resolves to 'Admin' through the
   * fake pool above, so roleByName(['Admin']) passes for real.
   */
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { user_id: 77, user_role: 2 }; next(); });
  app.use('/users', usersRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  fake.restore();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
});

beforeEach(() => {
  fake.reset();
  provisioningRow = {
    user_id: USER_ID,
    user_principal_name: 'mohit.kumar@easyfix.in',
    entra_object_id: OUR_OBJECT_ID,
    account_status: 'created',
    licence_status: 'assigned',
  };
});

// ── Scripted Microsoft Graph ──────────────────────────────────────────────

function makeRes(status, body) {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => text,
    json: async () => body,
  };
}

const NOT_FOUND = { error: { code: 'Request_ResourceNotFound', message: 'not found' } };

/*
 * `directory` maps a lowercase address to the object Graph would return for it.
 * `byUpn` answers GET /users/{address} (Graph resolves that by userPrincipalName
 * or id ONLY); `byMail` answers the `$filter=mail eq …` alias probe findByUpn
 * falls back to. Keeping them separate is the point of the proxy-address test.
 */
function withGraph({ byUpn = {}, byMail = {}, failWith = null, onRequest = null }, fn) {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    const body = init.body === undefined ? '' : String(init.body);
    seen.push({ url: u, method, body });

    if (u.includes('login.microsoftonline.com')) return makeRes(200, { access_token: 'fake-token', expires_in: 3600 });
    if (onRequest) {
      const scripted = onRequest({ url: u, method, body });
      if (scripted) return scripted;
    }
    if (failWith) return makeRes(failWith.status, failWith.body);
    if (u.includes('/sendMail')) return makeRes(202, undefined);
    // PATCH /users/{id} — the password reset. Graph answers 204 No Content.
    if (method === 'PATCH') return makeRes(204, undefined);

    if (u.includes('$filter=')) {
      const wanted = decodeURIComponent(u).match(/mail eq '([^']+)'/);
      const hit = wanted && byMail[wanted[1].toLowerCase()];
      return makeRes(200, { value: hit ? [hit] : [] });
    }
    const direct = decodeURIComponent(u).match(/\/users\/([^?]+)/);
    if (method === 'GET' && direct) {
      const hit = byUpn[direct[1].toLowerCase()];
      return hit ? makeRes(200, hit) : makeRes(404, NOT_FOUND);
    }
    return makeRes(404, NOT_FOUND);
  };
  return Promise.resolve(fn(seen)).finally(() => { globalThis.fetch = originalFetch; });
}

const dirObject = (upn, extra = {}) => ({
  id: 'obj-' + upn.split('@')[0],
  userPrincipalName: upn,
  mail: upn,
  accountEnabled: true,
  proxyAddresses: ['SMTP:' + upn],
  ...extra,
});

/* Capture every line the REAL logger emits, without printing it. */
function captureLogger() {
  const lines = [];
  const original = {};
  for (const [key, fn] of Object.entries(logger)) {
    if (typeof fn !== 'function') continue;
    original[key] = fn;
    logger[key] = (...args) => { lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  }
  return { lines, restore: () => Object.assign(logger, original) };
}

/*
 * The REAL fetch, captured before any test swaps globalThis.fetch for the
 * scripted Graph. The route tests drive the app over HTTP from INSIDE
 * withGraph(), so calling the global here would send the test's own request to
 * the Graph stub and get a scripted 404 back.
 */
const REAL_FETCH = globalThis.fetch;

async function post(path, body) {
  const res = await REAL_FETCH(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ── 1. Availability ───────────────────────────────────────────────────────

test('a free address reports AVAILABLE', () => withGraph({}, async () => {
  const r = await entra.isUpnAvailable('mohit.kumar@easyfix.in');
  assert.equal(r.available, true);
  assert.equal(r.email, 'mohit.kumar@easyfix.in');
}));

test('a taken address reports UNAVAILABLE and is flagged as definitively taken', () => withGraph(
  { byUpn: { 'mohit.kumar@easyfix.in': dirObject('mohit.kumar@easyfix.in') } },
  async () => {
    const r = await entra.isUpnAvailable('MOHIT.KUMAR@EasyFix.in');
    assert.equal(r.available, false);
    assert.equal(r.taken, true, 'a DEFINITIVE hit — this is what makes a numbered suggestion meaningful');
    assert.equal(r.email, 'mohit.kumar@easyfix.in', 'normalised, so the answer is about the address we would create');
    assert.match(r.reason, /already in use/);
  },
));

test('the suggestion SKIPS numbers that are themselves taken — 2 and 3 gone means 4', () => withGraph(
  {
    byUpn: {
      'mohit.kumar@easyfix.in':  dirObject('mohit.kumar@easyfix.in'),
      'mohit.kumar2@easyfix.in': dirObject('mohit.kumar2@easyfix.in'),
      'mohit.kumar3@easyfix.in': dirObject('mohit.kumar3@easyfix.in'),
    },
  },
  async () => {
    const s = await entra.suggestAvailableUpn('mohit.kumar@easyfix.in');
    assert.equal(s.suggested, 'mohit.kumar4@easyfix.in',
      'numbering starts at 2 (the unnumbered address is the first) and walks past every taken one');
  },
));

test('the probe is BOUNDED — twenty taken variants fail with a reason, not an endless walk', () => withGraph(
  {
    onRequest: ({ url, method }) => (method === 'GET' && url.includes('/users/')
      // Everything is taken, forever. Without the bound this test would hang.
      ? makeRes(200, { id: 'obj-x', userPrincipalName: 'x@easyfix.in', mail: 'x@easyfix.in' })
      : null),
  },
  async (seen) => {
    const s = await entra.suggestAvailableUpn('mohit.kumar@easyfix.in', { maxProbes: 5 });
    assert.equal(s.suggested, null);
    assert.match(s.reason, /all in use/);
    const probes = seen.filter((r) => r.url.includes('/users/') && !r.url.includes('login.'));
    assert.equal(probes.length, 5, 'exactly maxProbes Graph round-trips, no more');
  },
));

/*
 * THE ONE THAT MATTERS MOST.
 *
 * The answer this endpoint gives is TRUSTED — the operator stops looking once it
 * says "free". So every state that is not a clean, definitive miss must report
 * unavailable WITH the reason. A 403 is the realistic one: User.Read.All rides
 * on the same consent as provisioning, so before an admin grants it EVERY call
 * here answers 403. Reading that as "available" would hand out an address the
 * directory has never been asked about.
 */
test('a lookup FAILURE reports UNAVAILABLE — never available', async () => {
  for (const failure of [
    { status: 403, body: { error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges' } } },
    { status: 429, body: { error: { code: 'TooManyRequests', message: 'throttled' } } },
    { status: 503, body: { error: { code: 'ServiceUnavailable', message: 'try later' } } },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await withGraph({ failWith: failure }, async () => {
      const r = await entra.isUpnAvailable('mohit.kumar@easyfix.in');
      assert.equal(r.available, false, 'HTTP ' + failure.status + ' means "cannot tell", which is NOT "free"');
      assert.equal(r.taken, false, 'and it is not a definitive hit either, so no number may be suggested off it');
      assert.match(r.reason, /could not confirm/);
    });
  }
});

test('a lookup failure suggests NOTHING rather than inventing a number on top of a non-answer', () => withGraph(
  { failWith: { status: 403, body: { error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges' } } } },
  async () => {
    const s = await entra.suggestAvailableUpn('mohit.kumar@easyfix.in');
    assert.equal(s.suggested, null);
    assert.match(s.reason, /could not check/);
  },
));

test('an address that is free as a userPrincipalName but IS another mailbox\'s SMTP address is NOT available', () => withGraph(
  {
    /*
     * `alias.person@easyfix.in` resolves to NOTHING on GET /users/{upn} — Graph
     * matches that by userPrincipalName or id only. It is the primary SMTP
     * address of a mailbox whose UPN is different, which is ordinary in a real
     * tenant. findByUpn's `mail eq` fallback is what catches it, and creating a
     * user there would fail on a proxyAddresses conflict — after we had already
     * told the operator with full confidence that it was free.
     */
    byMail: {
      'alias.person@easyfix.in': {
        id: 'obj-real',
        userPrincipalName: 'real.person@easyfix.in',
        mail: 'alias.person@easyfix.in',
        proxyAddresses: ['SMTP:alias.person@easyfix.in', 'smtp:real.person@easyfix.in'],
      },
    },
  },
  async () => {
    const r = await entra.isUpnAvailable('alias.person@easyfix.in');
    assert.equal(r.available, false);
    assert.equal(r.taken, true);
    assert.match(r.reason, /real\.person@easyfix\.in/, 'and it names the mailbox that actually owns the address');
  },
));

test('an address outside the managed domains is unavailable-with-a-reason, not a Graph probe', () => withGraph({}, async (seen) => {
  const r = await entra.isUpnAvailable('mohit.kumar@gmail.com');
  assert.equal(r.available, false);
  assert.equal(r.taken, false);
  assert.match(r.reason, /not an EasyFix-managed/);
  assert.equal(seen.length, 0, 'we cannot own a mailbox there, so there is nothing to ask Microsoft');
}));

// ── 2. The route contract ─────────────────────────────────────────────────

test('POST /check-official-email answers the fixed contract for a free address', () => withGraph({}, async () => {
  const res = await post('/users/check-official-email', { email: 'brand.new@easyfix.in' });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.available, true);
  assert.equal(res.body.data.email, 'brand.new@easyfix.in');
}));

test('POST /check-official-email returns the next free numbered address for a taken one', () => withGraph(
  {
    byUpn: {
      'mohit.kumar@easyfix.in':  dirObject('mohit.kumar@easyfix.in'),
      'mohit.kumar2@easyfix.in': dirObject('mohit.kumar2@easyfix.in'),
    },
  },
  async () => {
    const res = await post('/users/check-official-email', { email: 'mohit.kumar@easyfix.in' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.available, false);
    assert.equal(res.body.data.suggested, 'mohit.kumar3@easyfix.in',
      'the owner\'s own example: two taken, so the third is offered');
    assert.ok(res.body.data.reason);
  },
));

/*
 * ⚠ `taken` IS NOT `!available`, and this is the test that stops a future reader
 * "simplifying" the two states back into one.
 *
 * available:false covers two facts that need different words in front of an
 * operator: "Microsoft 365 already has this address" — pick the suggestion — and
 * "the directory could not tell us", which says nothing about the address at all
 * and where a numbered suggestion would be an answer invented on top of a
 * non-answer. The service has always known the difference; until now the route
 * threw it away, so the FE could not tell the operator which one had happened.
 */
test('POST /check-official-email publishes `taken` — a real hit and a non-answer are both unavailable, and must not read the same', async () => {
  // (a) A DEFINITIVE directory hit.
  await withGraph(
    { byUpn: { 'mohit.kumar@easyfix.in': dirObject('mohit.kumar@easyfix.in') } },
    async () => {
      const res = await post('/users/check-official-email', { email: 'mohit.kumar@easyfix.in' });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.available, false);
      assert.equal(res.body.data.taken, true, 'the address really is spoken for');
      assert.equal(res.body.data.suggested, 'mohit.kumar2@easyfix.in',
        'which is what makes a numbered suggestion meaningful');
    },
  );

  // (b) The directory could not answer. SAME `available`, OPPOSITE `taken`.
  const inconclusive = [
    ['403 before admin consent', {
      failWith: { status: 403, body: { error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges' } } },
    }],
    ['a transport timeout', {
      onRequest: ({ url }) => {
        if (!url.includes('/users')) return null;
        // AbortSignal.timeout raises this shape; graphRequest maps it to a
        // networkError, never to a Graph verdict.
        const e = new Error('The operation was aborted due to timeout');
        e.name = 'TimeoutError';
        throw e;
      },
    }],
  ];
  for (const [label, graph] of inconclusive) {
    // eslint-disable-next-line no-await-in-loop
    await withGraph(graph, async () => {
      const res = await post('/users/check-official-email', { email: 'mohit.kumar@easyfix.in' });
      assert.equal(res.status, 200, label);
      assert.equal(res.body.data.available, false, label + ': "cannot tell" is never "free"');
      assert.equal(res.body.data.taken, false,
        label + ': nothing was observed, so nothing may be reported as taken');
      assert.equal(res.body.data.suggested, null,
        label + ': no number invented on top of a non-answer');
      assert.match(res.body.data.reason, /could not confirm/, label);
    });
  }
});

test('POST /check-official-email carries taken:false on the FREE path too — one shape, never a maybe-absent key', () => withGraph({}, async () => {
  const res = await post('/users/check-official-email', { email: 'brand.new@easyfix.in' });
  assert.equal(res.body.data.available, true);
  assert.equal(res.body.data.taken, false);
}));

// ── 3. The server-side guard ──────────────────────────────────────────────

test('decideAccountAction REUSES only the object already recorded against THIS user', () => {
  const d = entra.decideAccountAction(
    { found: true, status: 'found', user: { id: OUR_OBJECT_ID, userPrincipalName: 'mohit.kumar@easyfix.in' } },
    { recordedObjectId: OUR_OBJECT_ID },
  );
  assert.equal(d.action, 'reuse');
  assert.equal(d.accountStatus, entra.ACCOUNT_STATUS.ALREADY_EXISTS);
  assert.equal(d.entraObjectId, OUR_OBJECT_ID);
});

test('decideAccountAction reports a COLLISION when the address holds a DIFFERENT object', () => {
  const d = entra.decideAccountAction(
    { found: true, status: 'found', user: { id: 'obj-somebody-else', userPrincipalName: 'mohit.kumar@easyfix.in' } },
    { recordedObjectId: OUR_OBJECT_ID },
  );
  assert.notEqual(d.action, 'reuse', 'reusing it would licence and hand over a stranger\'s mailbox');
  assert.equal(d.action, 'collision');
  assert.equal(d.accountStatus, entra.ACCOUNT_STATUS.COLLISION);
  assert.equal(d.entraObjectId, undefined,
    'the stranger\'s object id must never be recorded against this user_id');
  assert.match(d.reason, /DIFFERENT directory object/);
});

test('decideAccountAction treats "no recorded account + the address exists" as a COLLISION, not a retry', () => {
  /*
   * The mohit-kumar-2 scenario, and the branch it is easiest to get wrong: it
   * LOOKS like a first-run retry. It is not — recordProvisioning writes a row on
   * every path and stamps the object id as soon as Graph confirms an account, so
   * one of our own attempts always leaves a claim behind. No claim means the
   * mailbox belongs to somebody else.
   */
  const d = entra.decideAccountAction(
    { found: true, status: 'found', user: { id: 'obj-first-mohit', userPrincipalName: 'mohit.kumar@easyfix.in' } },
    { recordedObjectId: null },
  );
  assert.equal(d.action, 'collision');
  assert.match(d.reason, /different directory object/i);
  assert.match(d.reason, /numbered variant/, 'and it tells the operator what to do instead');
});

test('decideAccountAction still creates on a definitive miss and still ABORTS while blind', () => {
  assert.equal(entra.decideAccountAction({ found: false, status: 'missing' }, {}).action, 'create');
  assert.equal(entra.decideAccountAction({ found: false, status: 'unknown', reason: '403' }, {}).action, 'abort');
  assert.equal(entra.decideAccountAction(null, {}).action, 'abort');
});

test('provisionUserMailbox REFUSES to touch the directory on a collision', () => withGraph(
  { byUpn: { 'mohit.kumar@easyfix.in': dirObject('mohit.kumar@easyfix.in', { id: 'obj-first-mohit' }) } },
  async (seen) => {
    provisioningRow = null; // a brand-new CRM user: nothing recorded yet
    const out = await entra.provisionUserMailbox({
      userId: 9999, userName: 'Mohit Kumar', officialEmail: 'mohit.kumar@easyfix.in', trigger: 'test',
    });
    assert.equal(out.accountStatus, entra.ACCOUNT_STATUS.COLLISION);
    assert.equal(out.mailboxReady, false);
    assert.equal(out.entraObjectId, null, 'nothing about the other person\'s account is kept');
    assert.equal(seen.some((r) => r.method === 'POST' && /\/v1\.0\/users$/.test(r.url)), false, 'no account created');
    assert.equal(seen.some((r) => r.url.includes('assignLicense')), false, 'no licence seat spent on a stranger');

    const write = fake.calls.find((c) => /INSERT INTO tbl_user_entra_provisioning/i.test(c.sql));
    assert.ok(write, 'the refusal is RECORDED — a blocked user must not be invisible');
    assert.equal(write.params[2], null, 'entra_object_id stays NULL for a collision');
    assert.equal(write.params[3], entra.ACCOUNT_STATUS.COLLISION);
  },
));

// ── 4. The rescue ─────────────────────────────────────────────────────────

test('reset-mailbox-password resets the account, mails the credentials, and leaks the password NOWHERE', async () => {
  const log = captureLogger();
  let res;
  let seen;
  try {
    await withGraph(
      { byUpn: { 'mohit.kumar@easyfix.in': dirObject('mohit.kumar@easyfix.in', { id: OUR_OBJECT_ID }) } },
      async (requests) => {
        res = await post(`/users/${USER_ID}/reset-mailbox-password`);
        seen = requests;
      },
    );
  } finally {
    log.restore();
  }

  // ── (a) It did the thing, and the password is real. ─────────────────────
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const patch = seen.find((r) => r.method === 'PATCH');
  assert.ok(patch, 'the Entra password was reset');
  assert.match(patch.url, new RegExp(OUR_OBJECT_ID), 'against the recorded object, not one we just looked up blind');
  const profile = JSON.parse(patch.body).passwordProfile;
  assert.equal(typeof profile.password, 'string');
  assert.equal(profile.password.length, 20, 'the existing 20-char CSPRNG generator, reused');
  assert.equal(profile.forceChangePasswordNextSignIn, true, 'single-use by design');
  const password = profile.password;

  // ── (b) It reached the mail. Without this, (c) passes vacuously. ────────
  const mailReq = seen.find((r) => r.url.includes('/sendMail'));
  assert.ok(mailReq, 'the credential mail went out — that is the entire point of the endpoint');
  assert.ok(mailReq.body.includes(password), 'and it actually carries the new password');
  const envelope = JSON.parse(mailReq.body).message;
  assert.deepEqual(envelope.ccRecipients, [{ emailAddress: { address: 'hr@easyfix.in' } }],
    'the existing sender is reused, so the HR CC and all three gates still apply');

  // ── (c) It reached NOTHING else. Asserted on the SERIALISED payload. ────
  assert.equal(res.status, 200);
  assert.equal(res.body.data.ok, true);
  assert.equal(res.body.data.welcomeMail.status, 'sent');
  assert.equal(JSON.stringify(res.body).includes(password), false,
    'the response body is published to the browser — it must be clean');
  const leakedLog = log.lines.find((l) => l.includes(password));
  assert.equal(leakedLog, undefined, 'no logger line on ANY path may contain the password — got: ' + String(leakedLog));
  assert.ok(log.lines.length > 2, 'sanity: the logger really was capturing (' + log.lines.length + ' lines)');
  const leakedSql = fake.calls.find((c) =>
    String(c.sql).includes(password) || JSON.stringify(c.params ?? null).includes(password));
  assert.equal(leakedSql, undefined, 'the password is never persisted, to any table');

  // ── (d) And it was audited. ─────────────────────────────────────────────
  assert.ok(log.lines.some((l) => /Mailbox password reset requested/.test(l) && /actorId=77/.test(l)),
    'resetting somebody\'s password is an audited act — the actor id is on the line');
});

test('reset-mailbox-password REFUSES when there is nothing to reset, and touches no password', async () => {
  // Each case mutates the READY row that beforeEach installs, so they stay
  // independent of one another's arrangement.
  const ready = { ...provisioningRow };
  const cases = [
    {
      name: 'no provisioning row at all',
      arrange: () => { provisioningRow = null; },
      expect: /No Microsoft 365 account is recorded/,
    },
    {
      name: 'the mailbox is not ready',
      arrange: () => { provisioningRow = { ...ready, licence_status: 'no_seats_available' }; },
      expect: /mailbox is not ready/,
    },
    {
      name: 'the address belongs to a different directory object',
      arrange: () => { provisioningRow = { ...ready, entra_object_id: 'obj-someone-else' }; },
      expect: /different Microsoft 365 account/,
    },
  ];

  for (const c of cases) {
    // eslint-disable-next-line no-await-in-loop
    await withGraph(
      { byUpn: { 'mohit.kumar@easyfix.in': dirObject('mohit.kumar@easyfix.in', { id: OUR_OBJECT_ID }) } },
      async (seen) => {
        c.arrange();
        const res = await post(`/users/${USER_ID}/reset-mailbox-password`);
        assert.ok(res.status === 400 || res.status === 409, c.name + ' → ' + res.status);
        assert.equal(res.body.success, false);
        assert.match(res.body.error, c.expect, c.name);
        assert.equal(seen.some((r) => r.method === 'PATCH'), false, c.name + ': no password was minted');
        assert.equal(seen.some((r) => r.url.includes('/sendMail')), false, c.name + ': and nothing was mailed');
      },
    );
  }
});

test('reset-mailbox-password is refused outright while the feature is off', async () => {
  props = { ...props, 'entra.provisioning.enabled': 'false' };
  await propsSvc.flushCache();
  try {
    await withGraph({}, async (seen) => {
      const res = await post(`/users/${USER_ID}/reset-mailbox-password`);
      assert.equal(res.status, 400);
      assert.match(res.body.error, /turned off/);
      assert.equal(seen.length, 0, 'the master switch gates every outbound call');
    });
  } finally {
    props = { ...props, 'entra.provisioning.enabled': 'true' };
    await propsSvc.flushCache();
  }
});
