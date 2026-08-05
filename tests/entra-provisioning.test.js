/*
 * Unit tests for the Microsoft 365 / Entra mailbox-provisioning logic and for
 * the "Graph 202 means ACCEPTED, not DELIVERED" semantics that hid the reported
 * bug (an OTP mailed to a mailbox that was never created reported success, so
 * the WhatsApp/SMS fallback never fired).
 *
 * NO NETWORK, NO DB:
 *   - the pure helpers (password shape, UPN/mailNickname derivation, Graph
 *     error mapping, idempotency decision, SKU selection) are called directly;
 *   - the two flow tests that need Graph replace `globalThis.fetch` with a
 *     scripted stub — the same "fake the seam, never the provider" approach the
 *     existing suite uses for the DB via tests/helpers/fake-pool.
 * Runner: `node --test`.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * The property table is served from a fake pool and loaded through the REAL
 * properties.service cache — the entra service destructures getProperty at
 * require time, so a getProperty stub would silently miss. This also keeps the
 * suite off any real database.
 */
let props = {};
const fake = installFakePool([
  [/FROM easyfix_properties/i, () =>
    Object.entries(props).map(([property_key, property_value]) => ({ property_key, property_value }))],
]);

const propsSvc = require('../services/properties.service');
const entra = require('../services/entra-provisioning.service');

before(async () => {
  props = {
    'entra.managed.domains': 'easyfix.in',
    'login.otp.email.mailbox.precheck': 'true',
    'entra.provisioning.enabled': 'false',
  };
  await propsSvc.flushCache();
});
after(() => fake.restore());

// ── 1. Temp password: shape + strength ────────────────────────────────────

const LOWER = /[a-z]/;
const UPPER = /[A-Z]/;
const DIGIT = /[0-9]/;
const SYMBOL = /[!@#$%^*()\-_=+?]/;

test('generateTempPassword is long enough for the Entra policy and uses all four character classes', () => {
  for (let i = 0; i < 50; i++) {
    const pw = entra.generateTempPassword();
    assert.equal(pw.length, 20, 'default length');
    assert.match(pw, LOWER, 'needs a lowercase letter');
    assert.match(pw, UPPER, 'needs an uppercase letter');
    assert.match(pw, DIGIT, 'needs a digit');
    assert.match(pw, SYMBOL, 'needs a symbol — Entra wants 3 of 4 classes, we supply 4');
  }
});

test('generateTempPassword clamps absurd lengths instead of producing a weak password', () => {
  assert.equal(entra.generateTempPassword(1).length, 16, 'floor');
  assert.equal(entra.generateTempPassword(9999).length, 64, 'ceiling');
  assert.equal(entra.generateTempPassword(32).length, 32);
});

test('generateTempPassword draws only from the safe alphabet (no quotes/backslashes to mangle in a shell or the admin centre)', () => {
  const allowed = /^[a-zA-Z0-9!@#$%^*()\-_=+?]+$/;
  for (let i = 0; i < 25; i++) assert.match(entra.generateTempPassword(), allowed);
});

test('generateTempPassword is not predictable — 200 draws are all distinct', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(entra.generateTempPassword());
  assert.equal(seen.size, 200, 'a collision here would mean it is not CSPRNG-backed');
});

test('generateTempPassword does not pin the guaranteed classes to the first eight positions', () => {
  // The generator emits 2 lower + 2 upper + 2 digit + 2 symbol then shuffles.
  // Without the shuffle every password would start with 4 letters; assert that
  // at least one of many draws has a digit or symbol inside the first 4 chars.
  let shuffled = false;
  for (let i = 0; i < 100 && !shuffled; i++) {
    const head = entra.generateTempPassword().slice(0, 4);
    if (DIGIT.test(head) || SYMBOL.test(head)) shuffled = true;
  }
  assert.equal(shuffled, true);
});

// ── 2. UPN / mailNickname / displayName derivation ────────────────────────

const DOMAINS = ['easyfix.in'];

test('deriveIdentity uses the official_email VERBATIM as the UPN', () => {
  const id = entra.deriveIdentity({ user_name: 'Ankit Jha', official_email: 'ankitjha@easyfix.in' }, DOMAINS);
  assert.equal(id.ok, true);
  assert.equal(id.userPrincipalName, 'ankitjha@easyfix.in',
    'a derived-but-different UPN would create a mailbox at an address nobody writes to');
  assert.equal(id.mailNickname, 'ankitjha');
  assert.equal(id.displayName, 'Ankit Jha');
  assert.equal(id.domain, 'easyfix.in');
});

test('deriveIdentity trims + lowercases the address and collapses whitespace in the display name', () => {
  const id = entra.deriveIdentity({ user_name: '  Priya   Sharma ', official_email: '  Priya.Sharma@EasyFix.IN ' }, DOMAINS);
  assert.equal(id.ok, true);
  assert.equal(id.userPrincipalName, 'priya.sharma@easyfix.in');
  assert.equal(id.mailNickname, 'priya.sharma');
  assert.equal(id.displayName, 'Priya Sharma');
});

test('deriveIdentity falls back to the local part when the name is blank', () => {
  const id = entra.deriveIdentity({ user_name: '   ', official_email: 'ops.desk@easyfix.in' }, DOMAINS);
  assert.equal(id.ok, true);
  assert.equal(id.displayName, 'ops.desk');
});

/*
 * FIRST NAME / LAST NAME. These were never sent, so every account created by
 * this service landed in Entra with a full name in Display name and both name
 * fields blank — visible in the M365 admin centre, in Outlook's address-book
 * sort, and anywhere Teams renders a first name.
 *
 * tbl_user holds ONE name column, so the split is positional and the tests
 * below pin the rule rather than a single example.
 */
test('deriveIdentity splits the CRM name into givenName + surname', () => {
  const id = entra.deriveIdentity({ user_name: 'Ankit Jha', official_email: 'ankitjha@easyfix.in' }, DOMAINS);
  assert.equal(id.givenName, 'Ankit');
  assert.equal(id.surname, 'Jha');
  assert.equal(id.displayName, 'Ankit Jha', 'displayName still carries the whole name');
});

test('a middle name goes with the SURNAME, not the given name', () => {
  // "Vijay Kumar Nailwal" → "Vijay" / "Kumar Nailwal". Dropping the middle name
  // would lose data the CRM holds; attaching it to the given name would put it
  // in the wrong field on every Indian three-part name.
  const id = entra.deriveIdentity({ user_name: 'Vijay Kumar Nailwal', official_email: 'vijay.nailwal@easyfix.in' }, DOMAINS);
  assert.equal(id.givenName, 'Vijay');
  assert.equal(id.surname, 'Kumar Nailwal');
});

test('a single-word name yields a given name and NO surname', () => {
  // null, not '' — Graph stores an empty string as a value, which would write a
  // blank Last name that looks exactly like the bug this fixes.
  const id = entra.deriveIdentity({ user_name: 'Priya', official_email: 'priya@easyfix.in' }, DOMAINS);
  assert.equal(id.givenName, 'Priya');
  assert.equal(id.surname, null);
});

test('a blank name sets NEITHER field — an email local part is not a name', () => {
  // displayName falls back to 'ops.desk', but splitting that on the dot would
  // invent a first and last name out of a mailbox alias.
  const id = entra.deriveIdentity({ user_name: '   ', official_email: 'ops.desk@easyfix.in' }, DOMAINS);
  assert.equal(id.givenName, null);
  assert.equal(id.surname, null);
});

test('name splitting collapses whitespace the same way displayName does', () => {
  const id = entra.deriveIdentity({ user_name: '  Priya   Sharma ', official_email: 'priya.sharma@easyfix.in' }, DOMAINS);
  assert.equal(id.givenName, 'Priya');
  assert.equal(id.surname, 'Sharma', 'the collapsed single space must not leave an empty token');
});

test('givenName and surname are capped at Graph\'s 64-char limit', () => {
  const long = 'A'.repeat(80);
  const id = entra.deriveIdentity({ user_name: `${long} ${long}`, official_email: 'long.name@easyfix.in' }, DOMAINS);
  assert.equal(id.givenName.length, 64);
  assert.equal(id.surname.length, 64);
  assert.ok(id.displayName.length <= 256, 'displayName has its own, larger limit');
});

test('deriveIdentity REFUSES an unmanaged domain — a personal address cannot get a tenant mailbox', () => {
  const id = entra.deriveIdentity({ user_name: 'Priya', official_email: 'ur.priya@gmail.com' }, DOMAINS);
  assert.equal(id.ok, false);
  assert.equal(id.accountStatus, entra.ACCOUNT_STATUS.SKIPPED_DOMAIN);
  assert.match(id.reason, /gmail\.com/);
  assert.match(id.reason, /easyfix\.in/, 'the reason names the managed domains so ops can fix the data');
});

test('deriveIdentity rejects unusable addresses rather than inventing one', () => {
  for (const bad of ['', null, undefined, 'not-an-email', 'nope@', '@easyfix.in', 'a b@easyfix.in']) {
    const id = entra.deriveIdentity({ user_name: 'X', official_email: bad }, DOMAINS);
    assert.equal(id.ok, false, JSON.stringify(bad));
  }
});

test('deriveIdentity rejects local parts that are legal in SMTP but illegal in a UPN', () => {
  const id = entra.deriveIdentity({ user_name: 'Tag User', official_email: 'ankit+crm@easyfix.in' }, DOMAINS);
  assert.equal(id.ok, false);
  assert.equal(id.accountStatus, entra.ACCOUNT_STATUS.SKIPPED_INVALID);
  assert.match(id.reason, /userPrincipalName/);
});

test('deriveIdentity sanitises the mailNickname without touching the UPN', () => {
  const id = entra.deriveIdentity({ user_name: "O'Brien", official_email: "o'brien@easyfix.in" }, DOMAINS);
  assert.equal(id.ok, true);
  assert.equal(id.userPrincipalName, "o'brien@easyfix.in", 'UPN keeps the apostrophe — the mailbox must match the CRM address');
  assert.equal(id.mailNickname, 'obrien', 'alias is sanitised');
});

test('isManagedDomain is case-insensitive and only matches the domain part', () => {
  assert.equal(entra.isManagedDomain('A.B@EASYFIX.IN', DOMAINS), true);
  assert.equal(entra.isManagedDomain('easyfix.in@gmail.com', DOMAINS), false);
  assert.equal(entra.isManagedDomain('no-at-sign', DOMAINS), false);
  assert.equal(entra.isManagedDomain('', DOMAINS), false);
});

// ── 3. Graph error → readable reason (+ request id) ───────────────────────

test('graphErrorToReason maps 403 to the missing-admin-consent explanation', () => {
  const r = entra.graphErrorToReason({
    status: 403,
    json: { error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges to complete the operation.' } },
    requestId: 'abc-123',
  });
  assert.equal(r.permissionIssue, true);
  assert.equal(r.notFound, false);
  assert.match(r.reason, /User\.ReadWrite\.All/);
  assert.match(r.reason, /Organization\.Read\.All/);
  assert.equal(r.requestId, 'abc-123', 'the correlation id is what MS support asks for first');
});

test('graphErrorToReason maps 401 to a token/secret problem, distinctly from 403', () => {
  const r = entra.graphErrorToReason({ status: 401, json: { error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired.' } } });
  assert.equal(r.permissionIssue, true);
  assert.match(r.reason, /MS_GRAPH_CLIENT_SECRET/);
});

test('graphErrorToReason recognises 404 as notFound', () => {
  const r = entra.graphErrorToReason({ status: 404, json: { error: { code: 'Request_ResourceNotFound', message: 'Resource not found.' } } });
  assert.equal(r.notFound, true);
  assert.equal(r.permissionIssue, false);
});

test('graphErrorToReason recognises the duplicate-UPN error text as alreadyExists', () => {
  const r = entra.graphErrorToReason({
    status: 400,
    json: { error: { code: 'Request_BadRequest', message: 'Another object with the same value for property userPrincipalName already exists.' } },
  });
  assert.equal(r.alreadyExists, true, 'drives the create-lost-a-race → re-resolve path');
});

test('graphErrorToReason flags 429 and 5xx as retryable, not as permission problems', () => {
  const t = entra.graphErrorToReason({ status: 429, json: {} });
  assert.equal(t.throttled, true);
  assert.equal(t.permissionIssue, false);
  const s = entra.graphErrorToReason({ status: 503, json: {} });
  assert.match(s.reason, /service error/i);
  assert.equal(s.permissionIssue, false);
});

test('graphErrorToReason surfaces a transport failure as a network reason, never as a Graph verdict', () => {
  const r = entra.graphErrorToReason({ status: 0, networkError: 'timed out after 15000ms', requestId: null });
  assert.equal(r.code, 'network');
  assert.equal(r.notFound, false, 'a timeout must NOT be mistaken for "mailbox does not exist"');
  assert.match(r.reason, /timed out/);
});

test('graphErrorToReason reads the request id out of innerError when the header is absent', () => {
  const r = entra.graphErrorToReason({
    status: 400,
    json: { error: { code: 'Request_BadRequest', message: 'bad', innerError: { 'request-id': 'inner-999' } } },
  });
  assert.equal(r.requestId, 'inner-999');
});

// ── 4. Idempotency decision (exists vs create) ────────────────────────────

test('decideAccountAction REUSES an existing directory object instead of creating a second one', () => {
  const d = entra.decideAccountAction({ found: true, status: 'found', user: { id: 'obj-1' } });
  assert.equal(d.action, 'reuse');
  assert.equal(d.accountStatus, entra.ACCOUNT_STATUS.ALREADY_EXISTS);
  assert.equal(d.entraObjectId, 'obj-1');
});

test('decideAccountAction creates only on a DEFINITIVE miss', () => {
  assert.equal(entra.decideAccountAction({ found: false, status: 'missing' }).action, 'create');
});

test('decideAccountAction ABORTS when the lookup was inconclusive — never create blind', () => {
  const d = entra.decideAccountAction({ found: false, status: 'unknown', reason: 'Graph denied the call (403)' });
  assert.equal(d.action, 'abort');
  assert.equal(d.accountStatus, entra.ACCOUNT_STATUS.FAILED);
  assert.match(d.reason, /403/);
  // Same rule for a missing/garbage lookup result.
  assert.equal(entra.decideAccountAction(null).action, 'abort');
  assert.equal(entra.decideAccountAction({}).action, 'abort');
});

// ── 5. SKU selection — every failure has a PRECISE reason ─────────────────

const SKUS = [
  { skuId: 'sku-guid-essentials', skuPartNumber: 'O365_BUSINESS_ESSENTIALS', capabilityStatus: 'Enabled', consumedUnits: 8,  prepaidUnits: { enabled: 10, warning: 0, suspended: 0 } },
  { skuId: 'sku-guid-full',       skuPartNumber: 'SPB',                      capabilityStatus: 'Enabled', consumedUnits: 5,  prepaidUnits: { enabled: 5,  warning: 0, suspended: 0 } },
  { skuId: 'sku-guid-dead',       skuPartNumber: 'EXCHANGESTANDARD',         capabilityStatus: 'Suspended', consumedUnits: 0, prepaidUnits: { enabled: 25, warning: 0, suspended: 25 } },
];

test('pickSku matches on skuPartNumber (case-insensitive) and returns the tenant GUID', () => {
  const p = entra.pickSku(SKUS, 'o365_business_essentials');
  assert.equal(p.ok, true);
  assert.equal(p.skuId, 'sku-guid-essentials');
  assert.equal(p.skuPartNumber, 'O365_BUSINESS_ESSENTIALS');
  assert.equal(p.seats, 2);
});

test('pickSku refuses when no SKU is configured, and names the property to set', () => {
  const p = entra.pickSku(SKUS, '');
  assert.equal(p.ok, false);
  assert.equal(p.status, entra.LICENCE_STATUS.NO_SKU_CONFIGURED);
  assert.match(p.reason, /entra\.provisioning\.sku\.part\.number/);
  assert.equal(entra.pickSku(SKUS, null).status, entra.LICENCE_STATUS.NO_SKU_CONFIGURED);
});

test('pickSku reports sku_not_found and lists what the tenant DOES have', () => {
  const p = entra.pickSku(SKUS, 'ENTERPRISEPACK');
  assert.equal(p.ok, false);
  assert.equal(p.status, entra.LICENCE_STATUS.SKU_NOT_FOUND);
  assert.match(p.reason, /O365_BUSINESS_ESSENTIALS/);
  assert.match(p.reason, /SPB/);
});

test('pickSku reports no_seats_available with the exact seat count', () => {
  const p = entra.pickSku(SKUS, 'SPB');
  assert.equal(p.ok, false);
  assert.equal(p.status, entra.LICENCE_STATUS.NO_SEATS);
  assert.match(p.reason, /5\/5/);
});

test('pickSku will not assign a Suspended subscription', () => {
  const p = entra.pickSku(SKUS, 'EXCHANGESTANDARD');
  assert.equal(p.ok, false);
  assert.equal(p.status, entra.LICENCE_STATUS.SKU_NOT_ACTIVE);
});

test('pickSku handles a tenant that returned nothing without throwing', () => {
  const p = entra.pickSku([], 'SPB');
  assert.equal(p.ok, false);
  assert.equal(p.status, entra.LICENCE_STATUS.SKU_NOT_FOUND);
  assert.match(p.reason, /no subscribed SKUs/);
  assert.equal(entra.pickSku(undefined, 'SPB').ok, false);
});

// ── 6. "Account created" ≠ "mailbox exists" ───────────────────────────────

test('mailboxLikelyExists requires BOTH an account AND a licence', () => {
  const A = entra.ACCOUNT_STATUS; const L = entra.LICENCE_STATUS;
  assert.equal(entra.mailboxLikelyExists(A.CREATED, L.ASSIGNED), true);
  assert.equal(entra.mailboxLikelyExists(A.ALREADY_EXISTS, L.ALREADY_LICENSED), true);
  // The exact silent state that produced the reported bug:
  assert.equal(entra.mailboxLikelyExists(A.CREATED, L.NO_SEATS), false,
    'a directory account with no licence has NO mailbox');
  assert.equal(entra.mailboxLikelyExists(A.CREATED, L.NO_SKU_CONFIGURED), false);
  assert.equal(entra.mailboxLikelyExists(A.FAILED, L.ASSIGNED), false);
  assert.equal(entra.mailboxLikelyExists(A.SKIPPED_DISABLED, L.SKIPPED), false);
});

// ── 7. The mailbox pre-check: 404 suppresses, 403 FAILS OPEN ──────────────
//
// These drive the real findByUpn/mailboxExists code with a scripted fetch, so
// the fail-open rule is pinned rather than asserted in prose.

function withFakeGraph(script, fn) {
  const originalFetch = globalThis.fetch;
  const env = {
    MS_GRAPH_TENANT_ID: process.env.MS_GRAPH_TENANT_ID,
    MS_GRAPH_CLIENT_ID: process.env.MS_GRAPH_CLIENT_ID,
    MS_GRAPH_CLIENT_SECRET: process.env.MS_GRAPH_CLIENT_SECRET,
  };
  process.env.MS_GRAPH_TENANT_ID = 'tenant-test';
  process.env.MS_GRAPH_CLIENT_ID = 'client-test';
  process.env.MS_GRAPH_CLIENT_SECRET = 'secret-test';

  const seen = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.includes('login.microsoftonline.com')) {
      return makeRes(200, { access_token: 'fake-token', expires_in: 3600 });
    }
    const hit = script.find(([re]) => re.test(u));
    if (!hit) return makeRes(404, { error: { code: 'Request_ResourceNotFound', message: 'unscripted' } });
    const [, status, body] = hit;
    return makeRes(status, body);
  };

  return Promise.resolve(fn(seen)).finally(() => {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

function makeRes(status, body) {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h.toLowerCase() === 'request-id' ? 'req-id-test' : null) },
    text: async () => text,
    json: async () => body,
  };
}

test('mailboxExists returns MISSING only for a clean 404 in a managed domain', async () => {
  entra.clearMailboxCache();
  await withFakeGraph(
    [
      [/\/users\/ankitjha%40easyfix\.in/, 404, { error: { code: 'Request_ResourceNotFound', message: 'not found' } }],
      [/\/users\?\$filter=/, 200, { value: [] }],
    ],
    async () => {
      const r = await entra.mailboxExists('ankitjha@easyfix.in');
      assert.equal(r.status, 'missing');
    },
  );
  entra.clearMailboxCache();
});

test('mailboxExists finds a mailbox reachable only by ALIAS — a 404 on the UPN lookup is not the end of the story', async () => {
  entra.clearMailboxCache();
  await withFakeGraph(
    [
      [/\/users\/alias%40easyfix\.in/, 404, { error: { code: 'Request_ResourceNotFound', message: 'not found' } }],
      [/\/users\?\$filter=/, 200, { value: [{ id: 'obj-9', mail: 'alias@easyfix.in', userPrincipalName: 'real@easyfix.in' }] }],
    ],
    async () => {
      const r = await entra.mailboxExists('alias@easyfix.in');
      assert.equal(r.status, 'exists', 'suppressing email for a working alias would lock the user out');
    },
  );
  entra.clearMailboxCache();
});

/*
 * REGRESSION: a directory object is NOT a mailbox.
 *
 * This is the state the whole feature exists to catch — POST /users landed, the
 * licence step did not, so Exchange never provisioned anything. Before the fix
 * mailboxExists() returned 'exists' for any object with an `id`, the OTP email
 * was counted as delivered on the Graph 202, and the WhatsApp/SMS fallback was
 * starved exactly as in the original bug. Note that every pre-existing 'exists'
 * fixture in this file sets a non-null `mail`, which is why they still pass.
 */
test('mailboxExists reports NO_MAILBOX for a directory object that is not mail-enabled', async () => {
  entra.clearMailboxCache();
  await withFakeGraph(
    [[/\/users\/unlicensed%40easyfix\.in/, 200, {
      id: 'obj-1', mail: null, userPrincipalName: 'unlicensed@easyfix.in', accountEnabled: true, proxyAddresses: [],
    }]],
    async () => {
      const r = await entra.mailboxExists('unlicensed@easyfix.in');
      assert.equal(r.status, 'no_mailbox',
        'an unlicensed Entra account has NO mailbox — reporting "exists" starves the OTP fallback');
    },
  );
  entra.clearMailboxCache();
});

test('mailboxExists still reports EXISTS when only an SMTP proxyAddress carries the mailbox', async () => {
  entra.clearMailboxCache();
  await withFakeGraph(
    [[/\/users\/hybrid%40easyfix\.in/, 200, {
      id: 'obj-2', mail: null, userPrincipalName: 'hybrid@easyfix.in',
      proxyAddresses: ['SMTP:hybrid@easyfix.in', 'smtp:h.old@easyfix.in'],
    }]],
    async () => {
      const r = await entra.mailboxExists('hybrid@easyfix.in');
      assert.equal(r.status, 'exists', 'a mail-enabled object whose `mail` is unset must not be doubted');
    },
  );
  entra.clearMailboxCache();
});

test('directoryObjectHasMailbox separates a mail-enabled object from a bare directory object', () => {
  assert.equal(entra.directoryObjectHasMailbox({ id: 'x', mail: 'a@easyfix.in' }), true);
  assert.equal(entra.directoryObjectHasMailbox({ id: 'x', mail: null, proxyAddresses: ['SMTP:a@easyfix.in'] }), true);
  assert.equal(entra.directoryObjectHasMailbox({ id: 'x', mail: null, proxyAddresses: [] }), false);
  assert.equal(entra.directoryObjectHasMailbox({ id: 'x', mail: '  ' }), false);
  // A non-SMTP proxy address (SIP, X500) is not a mailbox.
  assert.equal(entra.directoryObjectHasMailbox({ id: 'x', proxyAddresses: ['SIP:a@easyfix.in'] }), false);
  assert.equal(entra.directoryObjectHasMailbox(null), false);
});

test('mailboxExists FAILS OPEN on 403 — the permission may simply not be consented yet', async () => {
  entra.clearMailboxCache();
  await withFakeGraph(
    [[/\/users\//, 403, { error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges' } }]],
    async () => {
      const r = await entra.mailboxExists('ankitjha@easyfix.in');
      assert.equal(r.status, 'unknown', 'must NOT be "missing" — that would block OTP email for everyone');
      assert.equal(r.permissionIssue, true);
    },
  );
  entra.clearMailboxCache();
});

test('mailboxExists FAILS OPEN when the alias probe itself errors after a 404', async () => {
  entra.clearMailboxCache();
  await withFakeGraph(
    [
      [/\/users\/ankitjha%40easyfix\.in/, 404, { error: { code: 'Request_ResourceNotFound', message: 'not found' } }],
      [/\/users\?\$filter=/, 429, { error: { code: 'TooManyRequests', message: 'throttled' } }],
    ],
    async () => {
      const r = await entra.mailboxExists('ankitjha@easyfix.in');
      assert.equal(r.status, 'unknown');
    },
  );
  entra.clearMailboxCache();
});

test('mailboxExists SKIPS addresses outside the managed domains without calling Graph at all', async () => {
  entra.clearMailboxCache();
  await withFakeGraph([], async (seen) => {
    const r = await entra.mailboxExists('ur.priya@gmail.com');
    assert.equal(r.status, 'skipped');
    assert.equal(seen.length, 0, 'a personal address always 404s in our tenant — never probe it');
  });
  entra.clearMailboxCache();
});

test('mailboxExists caches, so the login path does not add a Graph round-trip per OTP', async () => {
  entra.clearMailboxCache();
  await withFakeGraph(
    [[/\/users\/cached%40easyfix\.in/, 200, { id: 'obj-1', mail: 'cached@easyfix.in', userPrincipalName: 'cached@easyfix.in' }]],
    async (seen) => {
      const a = await entra.mailboxExists('cached@easyfix.in');
      const b = await entra.mailboxExists('CACHED@easyfix.in'); // normalised
      assert.equal(a.status, 'exists');
      assert.equal(b.status, 'exists');
      assert.equal(b.cached, true);
      const userCalls = seen.filter((u) => u.includes('/users/'));
      assert.equal(userCalls.length, 1, 'second call served from cache');
    },
  );
  entra.clearMailboxCache();
});

// ── 8. 202 == ACCEPTED, not DELIVERED ─────────────────────────────────────

test('email.service reports a Graph 202 as ACCEPTED/queued and never as confirmed delivery', async () => {
  const emailService = require('../services/email.service');
  const originalFetch = globalThis.fetch;
  const originalDisable = process.env.NOTIFICATIONS_DISABLE;
  const originalTest = process.env.TEST_EMAILS;
  process.env.MS_GRAPH_TENANT_ID = 'tenant-test';
  process.env.MS_GRAPH_CLIENT_ID = 'client-test';
  process.env.MS_GRAPH_CLIENT_SECRET = 'secret-test';
  delete process.env.NOTIFICATIONS_DISABLE;
  delete process.env.TEST_EMAILS;

  globalThis.fetch = async (url) => {
    if (String(url).includes('login.microsoftonline.com')) return makeRes(200, { access_token: 'fake-token', expires_in: 3600 });
    // sendMail: exactly what Graph returns for a mailbox that does not exist —
    // 202 with an empty body. Graph does not validate the recipient.
    return { ok: true, status: 202, headers: { get: () => null }, text: async () => '', json: async () => ({}) };
  };

  try {
    const r = await emailService.send({ to: 'ghost@easyfix.in', subject: 's', text: 't' });
    assert.equal(r.accepted, true, '202 = queued');
    assert.equal(r.queuedForDelivery, true);
    assert.equal(r.deliveryConfirmed, false,
      'Graph has no delivery receipt — this must never be true from an HTTP status');
    assert.equal(r.delivered, true, 'legacy alias of `accepted`, kept for the ~15 existing call sites');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDisable === undefined) delete process.env.NOTIFICATIONS_DISABLE; else process.env.NOTIFICATIONS_DISABLE = originalDisable;
    if (originalTest === undefined) delete process.env.TEST_EMAILS; else process.env.TEST_EMAILS = originalTest;
  }
});

test('email.service failure paths carry the same accepted/deliveryConfirmed shape', async () => {
  const emailService = require('../services/email.service');
  const r = await emailService.send({ subject: 's', text: 't' }); // no `to`
  assert.equal(r.accepted, false);
  assert.equal(r.delivered, false);
  assert.equal(r.deliveryConfirmed, false);
  assert.match(r.error, /to is required/);
});

// ── 9. Fail-closed: the master switch must gate every directory WRITE ─────

async function setProps(next) {
  props = next;
  await propsSvc.flushCache();
}

test('provisionUserMailbox is FAIL-CLOSED — flag off means zero Graph calls and a recorded skip', async () => {
  await setProps({ 'entra.managed.domains': 'easyfix.in' }); // provisioning key absent entirely
  await withFakeGraph([], async (seen) => {
    const out = await entra.provisionUserMailbox({
      userId: 8710, userName: 'Ankit Jha', officialEmail: 'ankitjha@easyfix.in', trigger: 'test',
    });
    assert.equal(out.attempted, false);
    assert.equal(out.accountStatus, entra.ACCOUNT_STATUS.SKIPPED_DISABLED);
    assert.equal(out.licenceStatus, entra.LICENCE_STATUS.SKIPPED);
    assert.equal(out.mailboxReady, false);
    assert.match(out.reason, /entra\.provisioning\.enabled/);
    assert.equal(seen.length, 0, 'a missing/false flag must never touch the directory');
  });
});

test('provisionUserMailbox records the skip even when it does nothing — a missing mailbox must be discoverable', async () => {
  await setProps({ 'entra.provisioning.enabled': 'false' });
  const writes = [];
  const originalRecord = entra.recordProvisioning;
  await withFakeGraph([], async () => {
    const before = fake.calls.length;
    await entra.provisionUserMailbox({ userId: 8710, userName: 'Ankit Jha', officialEmail: 'ankitjha@easyfix.in' });
    for (const c of fake.calls.slice(before)) if (/tbl_user_entra_provisioning/i.test(c.sql)) writes.push(c);
  });
  assert.equal(originalRecord, entra.recordProvisioning, 'sanity: not stubbed');
  assert.equal(writes.length, 1, 'exactly one upsert into tbl_user_entra_provisioning');
  assert.match(writes[0].sql, /ON DUPLICATE KEY UPDATE/i, 'upsert, so a retry updates rather than duplicating');
  assert.equal(writes[0].params[0], 8710);
  assert.equal(writes[0].params[3], entra.ACCOUNT_STATUS.SKIPPED_DISABLED);
  assert.equal(writes[0].params[8], 0, 'a skipped run must not count as a Graph attempt');
  assert.ok(writes[0].params[9] instanceof Date, 'timestamps are bound as new Date() (IST via the pool), never SQL NOW()');
});

test('provisionUserMailbox refuses an unmanaged domain even with the flag ON, without calling Graph', async () => {
  await setProps({ 'entra.provisioning.enabled': 'true', 'entra.managed.domains': 'easyfix.in' });
  await withFakeGraph([], async (seen) => {
    const out = await entra.provisionUserMailbox({ userId: 42, userName: 'Priya', officialEmail: 'ur.priya@gmail.com' });
    assert.equal(out.accountStatus, entra.ACCOUNT_STATUS.SKIPPED_DOMAIN);
    assert.equal(out.attempted, false);
    assert.equal(seen.length, 0);
  });
  await setProps({ 'entra.provisioning.enabled': 'false' });
});

// ── The create BODY actually carries the name fields ──────────────────────
//
// deriveIdentity returning givenName/surname proves nothing on its own — the
// bug was that the Graph request body never mentioned them. This drives the
// real createEntraUser with a fetch stub that CAPTURES THE BODY, so the
// assertion is on what would go over the wire to Microsoft.

function withBodyCapturingGraph(fn) {
  const originalFetch = globalThis.fetch;
  const env = {
    MS_GRAPH_TENANT_ID: process.env.MS_GRAPH_TENANT_ID,
    MS_GRAPH_CLIENT_ID: process.env.MS_GRAPH_CLIENT_ID,
    MS_GRAPH_CLIENT_SECRET: process.env.MS_GRAPH_CLIENT_SECRET,
  };
  process.env.MS_GRAPH_TENANT_ID = 'tenant-test';
  process.env.MS_GRAPH_CLIENT_ID = 'client-test';
  process.env.MS_GRAPH_CLIENT_SECRET = 'secret-test';

  const posts = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('login.microsoftonline.com')) {
      return makeRes(200, { access_token: 'fake-token', expires_in: 3600 });
    }
    if (/\/users$/.test(u) && String(init.method).toUpperCase() === 'POST') {
      posts.push(JSON.parse(init.body));
      return makeRes(201, { id: 'obj-123' });
    }
    return makeRes(404, { error: { code: 'Request_ResourceNotFound', message: 'unscripted' } });
  };

  return Promise.resolve(fn(posts)).finally(() => {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

test('the Graph create body carries givenName and surname', () => withBodyCapturingGraph(async (posts) => {
  const ident = entra.deriveIdentity(
    { user_name: 'Vijay Kumar Nailwal', official_email: 'vijay.nailwal@easyfix.in' },
    ['easyfix.in'],
  );
  const res = await entra.createEntraUser(ident);
  assert.equal(res.ok, true);
  assert.equal(posts.length, 1);
  const body = posts[0];
  assert.equal(body.displayName, 'Vijay Kumar Nailwal');
  assert.equal(body.givenName, 'Vijay', 'First name in Entra');
  assert.equal(body.surname, 'Kumar Nailwal', 'Last name in Entra');
  assert.equal(body.userPrincipalName, 'vijay.nailwal@easyfix.in');
}));

test('a name field with no value is OMITTED from the body, never sent empty', () => withBodyCapturingGraph(async (posts) => {
  // Graph stores '' as a value: sending an empty surname writes a blank Last
  // name that is indistinguishable in the admin centre from the missing-fields
  // bug this change fixes.
  const ident = entra.deriveIdentity(
    { user_name: 'Priya', official_email: 'priya@easyfix.in' },
    ['easyfix.in'],
  );
  await entra.createEntraUser(ident);
  const body = posts[0];
  assert.equal(body.givenName, 'Priya');
  assert.equal('surname' in body, false, 'the key must be absent, not present-and-empty');
}));

test('a blank CRM name sends neither name field', () => withBodyCapturingGraph(async (posts) => {
  const ident = entra.deriveIdentity(
    { user_name: '', official_email: 'ops.desk@easyfix.in' },
    ['easyfix.in'],
  );
  await entra.createEntraUser(ident);
  const body = posts[0];
  assert.equal(body.displayName, 'ops.desk', 'displayName still falls back to the local part');
  assert.equal('givenName' in body, false);
  assert.equal('surname' in body, false);
}));
