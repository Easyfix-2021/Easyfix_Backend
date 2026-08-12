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

/*
 * ⚠ REUSE NOW REQUIRES PROOF OF OWNERSHIP, and this test used to assert the
 * opposite. It called decideAccountAction with no context and expected `reuse`,
 * which is exactly the behaviour that let a second employee of the same name be
 * silently attached to the FIRST employee's mailbox — licence assigned to a
 * stranger's account, that stranger's object id stored against the new user row.
 *
 * "An account exists at this address" and "this is my own earlier attempt" are
 * different facts, and the old signature could not tell them apart because it
 * was never given the one thing that distinguishes them: the object id already
 * recorded for THIS user_id. Passing it is what makes reuse safe, so the test
 * now passes it — and the collision case it used to hide is asserted below.
 */
test('decideAccountAction REUSES an existing object only when it is the one recorded for THIS user', () => {
  const d = entra.decideAccountAction(
    { found: true, status: 'found', user: { id: 'obj-1' } },
    { recordedObjectId: 'obj-1' },
  );
  assert.equal(d.action, 'reuse');
  assert.equal(d.accountStatus, entra.ACCOUNT_STATUS.ALREADY_EXISTS);
  assert.equal(d.entraObjectId, 'obj-1');
});

test('decideAccountAction REFUSES an existing object that belongs to someone else', () => {
  // The address is taken by a DIFFERENT directory object. Reusing it would hand
  // this new employee another employee's mailbox.
  const other = entra.decideAccountAction(
    { found: true, status: 'found', user: { id: 'obj-STRANGER' } },
    { recordedObjectId: 'obj-1' },
  );
  assert.equal(other.action, 'collision');
  assert.notEqual(other.entraObjectId, 'obj-STRANGER',
    "a stranger's object id must never flow onward into recordProvisioning");

  // And with NO recorded row at all: every one of our own attempts leaves a
  // claim the moment Graph confirms an account, so an unclaimed account we did
  // not record is somebody else's. Refusing is the fail-safe direction — the
  // false positive is one clear message to an operator, the false negative is
  // two people sharing a mailbox.
  const unclaimed = entra.decideAccountAction(
    { found: true, status: 'found', user: { id: 'obj-2' } },
    { recordedObjectId: null },
  );
  assert.equal(unclaimed.action, 'collision');
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

// ── Licence assignment: ACCEPTED ≠ ASSIGNED ───────────────────────────────
//
// graphRequest sets `ok` from res.ok, which is true for ANY 2xx — including
// 202 Accepted, which on assignLicense means "queued", not "the seat is on the
// user". We recorded `assigned` off that and never looked again.
//
// Real case, anand.thakur@easyfix.in (2026-08-04): tbl_user_entra_provisioning
// said assigned / O365_BUSINESS_ESSENTIALS while the M365 admin centre showed
// every licence box unticked, and the account could open nothing until an admin
// assigned Microsoft 365 Business Basic by hand.

const SKU_BUSINESS_BASIC = '802384e1-3c01-4d3e-879f-0dc385e79031';

/*
 * `visibleAfterReads` is the whole point of the backoff: Entra is eventually
 * consistent, so the seat is genuinely absent for the first N read-backs and
 * genuinely present afterwards. 0 (the default) keeps every pre-existing
 * fixture's behaviour — visible immediately, or never.
 */
function withLicenceGraph({ assignStatus = 202, licencesOnReadBack = [], visibleAfterReads = 0 }, fn) {
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
  let reads = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('login.microsoftonline.com')) {
      return makeRes(200, { access_token: 'fake-token', expires_in: 3600 });
    }
    if (/assignLicense/.test(u)) {
      seen.push('assign');
      return makeRes(assignStatus, assignStatus === 202 ? null : { id: 'obj-1' });
    }
    if (/\/users\//.test(u) && String(init.method || 'GET').toUpperCase() === 'GET') {
      seen.push('readback');
      reads++;
      const visible = reads > visibleAfterReads ? licencesOnReadBack : [];
      return makeRes(200, { id: 'obj-1', assignedLicenses: visible.map((skuId) => ({ skuId })) });
    }
    return makeRes(404, { error: { code: 'Request_ResourceNotFound', message: 'unscripted' } });
  };

  return Promise.resolve(fn(seen)).finally(() => {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

/*
 * THE BUDGET, INJECTED. Every test that has to WAIT passes this instead of the
 * shipped ~90s default. A test that really sleeps 90 seconds gets deleted by the
 * next person and takes the guard with it, so the bound is proven on a scaled
 * clock: same code, same branches, ~0.3s.
 */
const FAST_VERIFY = { budgetMs: 300, firstDelayMs: 10, maxDelayMs: 40 };

test('a 202 with the seat visible on read-back is VERIFIED', () => withLicenceGraph(
  { assignStatus: 202, licencesOnReadBack: [SKU_BUSINESS_BASIC] },
  async (seen) => {
    const res = await entra.assignLicense('obj-1', SKU_BUSINESS_BASIC, FAST_VERIFY);
    assert.equal(res.ok, true);
    assert.equal(res.verified, true, 'the seat was read back from Entra');
    assert.ok(seen.includes('readback'), 'the acknowledgement alone is never enough');
  },
));

test('a 202 with NO seat on read-back is accepted-but-UNVERIFIED, not assigned', () => withLicenceGraph(
  { assignStatus: 202, licencesOnReadBack: [] },
  async () => {
    const res = await entra.assignLicense('obj-1', SKU_BUSINESS_BASIC, FAST_VERIFY);
    assert.equal(res.ok, true, 'Graph did accept it — this is not a hard failure');
    assert.equal(res.verified, false, '…but the seat never appeared');
    assert.match(res.reason, /still not on the user/);
  },
));

test('a read-back showing a DIFFERENT sku does not count as verified', () => withLicenceGraph(
  { assignStatus: 200, licencesOnReadBack: ['ffffffff-0000-0000-0000-000000000000'] },
  async () => {
    const res = await entra.assignLicense('obj-1', SKU_BUSINESS_BASIC, FAST_VERIFY);
    assert.equal(res.verified, false, 'holding SOME licence is not holding THIS one');
  },
));

/*
 * ── The backoff: how LONG we look, never WHETHER we look ──────────────────
 *
 * LICENCE_VERIFY_ATTEMPTS = 2 / LICENCE_VERIFY_DELAY_MS = 1200 gave Microsoft
 * 1.2 seconds to make an eventually-consistent write visible. Graph licence
 * propagation routinely takes tens of seconds, so on user 8805 we recorded
 * assigned_unconfirmed at 05:40:04, suppressed the welcome mail and threw the
 * temp password away — not detecting a failure, giving up before the answer
 * existed. The three tests below pin the replacement: return early on success,
 * keep looking on absence, and STOP.
 */

test('assignLicense stops the instant the seat is observed — a backoff that ignored its own success would keep sleeping', () => withLicenceGraph(
  { assignStatus: 202, licencesOnReadBack: [SKU_BUSINESS_BASIC] },
  async (seen) => {
    const startedAt = Date.now();
    const res = await entra.assignLicense('obj-1', SKU_BUSINESS_BASIC, FAST_VERIFY);
    assert.equal(res.verified, true);
    assert.equal(res.reads, 1, 'the first read already answered');
    assert.equal(seen.filter((s) => s === 'readback').length, 1,
      'exactly ONE read-back — asserted on the count, so a loop that keeps going after success cannot pass');
    assert.ok(Date.now() - startedAt < FAST_VERIFY.budgetMs,
      'and it did not sleep once: a fast tenant is no slower than the old two-read version');
  },
));

test('a seat that appears only on a LATER read is STILL verified — the whole point of waiting', () => withLicenceGraph(
  { assignStatus: 202, licencesOnReadBack: [SKU_BUSINESS_BASIC], visibleAfterReads: 3 },
  async (seen) => {
    const res = await entra.assignLicense('obj-1', SKU_BUSINESS_BASIC, FAST_VERIFY);
    assert.equal(res.verified, true,
      'four reads in, Entra finally showed the seat — the old two-attempt version never got here');
    assert.equal(res.reads, 4);
    assert.equal(seen.filter((s) => s === 'readback').length, 4, 'and it stopped at the one that answered');
  },
));

test('a seat that NEVER appears exhausts the budget and is honestly UNVERIFIED — the wait is bounded', () => withLicenceGraph(
  { assignStatus: 202, licencesOnReadBack: [] },
  async (seen) => {
    const startedAt = Date.now();
    const res = await entra.assignLicense('obj-1', SKU_BUSINESS_BASIC, FAST_VERIFY);
    const elapsed = Date.now() - startedAt;

    assert.equal(res.ok, true, 'Graph did accept the request');
    assert.equal(res.verified, false,
      'accepted-but-unobservable is STILL not a mailbox — waiting longer must never soften into trusting the 2xx');
    assert.match(res.reason, /still not on the user/);
    assert.ok(res.reads > 2, 'it really did keep looking (' + res.reads + ' reads)');
    assert.equal(seen.filter((s) => s === 'readback').length, res.reads);

    // THE BOUND. Without it this loop is an unbounded retry that pins a request
    // (and a temp password) in memory forever.
    assert.ok(elapsed >= FAST_VERIFY.firstDelayMs, 'it waited at all');
    assert.ok(elapsed < FAST_VERIFY.budgetMs * 4,
      'and it STOPPED — ' + elapsed + 'ms against a ' + FAST_VERIFY.budgetMs + 'ms budget');
    assert.ok(res.waitedMs <= elapsed);
  },
));

test('the per-sleep cap and the remaining budget both clamp the doubling', () => withLicenceGraph(
  { assignStatus: 202, licencesOnReadBack: [] },
  async () => {
    // 2 → 4 → 8 … would run away without the cap; the budget then truncates the
    // final sleep so the total never overshoots.
    const startedAt = Date.now();
    const res = await entra.assignLicense('obj-1', SKU_BUSINESS_BASIC, { budgetMs: 120, firstDelayMs: 5, maxDelayMs: 20 });
    assert.equal(res.verified, false);
    assert.ok(Date.now() - startedAt < 1000, 'a 120ms budget must not become a multi-second wait');
  },
));

test('the sku match is case-insensitive — Graph casing must not cause a false alarm', () => withLicenceGraph(
  { assignStatus: 200, licencesOnReadBack: [SKU_BUSINESS_BASIC.toUpperCase()] },
  async () => {
    const res = await entra.assignLicense('obj-1', SKU_BUSINESS_BASIC);
    assert.equal(res.verified, true);
  },
));

/*
 * ── THE INCIDENT, END TO END ──────────────────────────────────────────────
 *
 * user 8805 / mohit.kumar@easyfix.in. Account created 05:40:01. Licence assigned
 * — Graph returned 200 — but the read-back could not see the SKU, so at 05:40:04
 * provisioning recorded assigned_unconfirmed, mailboxReady=false, the welcome
 * mail was suppressed at GATE 1 and the temp password was discarded. The 06:16
 * retry found the licence had been there all along, but the reuse path mints no
 * password, so GATE 3 suppressed the mail again. That user could never be mailed
 * by any retry.
 *
 * This drives the REAL orchestrator against a Graph that behaves exactly like
 * that — the SKU absent for the first two read-backs, present on the third — and
 * then runs the caller's own chain (sink the password, hand it to
 * sendWelcomeMail with the outcome; see services/user.service.js) to prove the
 * mail goes out WITH a credential. Anything less than the full chain would pass
 * while the user still got nothing.
 */

const SKU_SPB = {
  skuId: 'sku-guid-spb', skuPartNumber: 'SPB', capabilityStatus: 'Enabled',
  consumedUnits: 3, prepaidUnits: { enabled: 10, warning: 0, suspended: 0 },
};

function withProvisioningGraph({ sku = SKU_SPB, visibleAfterReads = 0 }, fn) {
  const originalFetch = globalThis.fetch;
  const env = {};
  for (const k of ['MS_GRAPH_TENANT_ID', 'MS_GRAPH_CLIENT_ID', 'MS_GRAPH_CLIENT_SECRET',
    'MS_GRAPH_SENDER_EMAIL', 'NOTIFICATIONS_DISABLE', 'TEST_EMAILS']) env[k] = process.env[k];
  process.env.MS_GRAPH_TENANT_ID = 'tenant-test';
  process.env.MS_GRAPH_CLIENT_ID = 'client-test';
  process.env.MS_GRAPH_CLIENT_SECRET = 'secret-test';
  process.env.MS_GRAPH_SENDER_EMAIL = 'ithelpdesk@easyfix.in';
  delete process.env.NOTIFICATIONS_DISABLE;
  delete process.env.TEST_EMAILS;

  const seen = [];
  let reads = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    const body = init.body === undefined ? '' : String(init.body);
    seen.push({ url: u, method, body });

    if (u.includes('login.microsoftonline.com')) return makeRes(200, { access_token: 'fake-token', expires_in: 3600 });
    if (u.includes('/sendMail')) return makeRes(202, undefined);
    if (u.includes('/assignLicense')) return makeRes(202, null);   // ACCEPTED, nothing more
    if (u.includes('/subscribedSkus')) return makeRes(200, { value: [sku] });
    if (method === 'POST' && /\/v1\.0\/users$/.test(u)) return makeRes(201, { id: 'obj-8805' });
    /*
     * The licence READ-BACK, matched on its EXACT select list: `assignedLicenses`
     * also appears in the pre-existence lookup's select, and a looser match would
     * answer THAT with a 200 — the account would read as already existing, the
     * flow would take the reuse path and POST /users would never happen.
     */
    if (method === 'GET' && u.includes('$select=id,assignedLicenses')) {
      reads++;
      return makeRes(200, {
        id: 'obj-8805',
        assignedLicenses: reads > visibleAfterReads ? [{ skuId: sku.skuId }] : [],
      });
    }
    if (u.includes('$filter=')) return makeRes(200, { value: [] });
    return makeRes(404, { error: { code: 'Request_ResourceNotFound', message: 'not found' } });
  };

  return Promise.resolve(fn(seen)).finally(() => {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

/* Capture every line the REAL logger emits, without printing it. */
function captureLogger() {
  const logger = require('../logger');
  const lines = [];
  const original = {};
  for (const [key, fn] of Object.entries(logger)) {
    if (typeof fn !== 'function') continue;
    original[key] = fn;
    logger[key] = (...args) => { lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  }
  return { lines, restore: () => Object.assign(logger, original) };
}

const MOHIT = {
  userId: 8805, userName: 'Mohit Kumar', officialEmail: 'mohit.kumar@easyfix.in',
};

test('THE INCIDENT: a licence visible only on a LATER read still reaches the welcome mail, WITH the credential', async () => {
  await setProps({
    'entra.provisioning.enabled': 'true',
    'entra.managed.domains': 'easyfix.in',
    'entra.provisioning.sku.part.number': 'SPB',
  });
  const welcomeMail = require('../services/user-welcome-mail.service');
  const log = captureLogger();
  fake.reset();

  let sunk = null;
  let out;
  let mail;
  let seen;
  try {
    await withProvisioningGraph({ visibleAfterReads: 2 }, async (requests) => {
      out = await entra.provisionUserMailbox({
        ...MOHIT,
        trigger: 'create-user',
        onTempPassword: (pw) => { sunk = pw; },
        licenceVerify: FAST_VERIFY,
      });
      // The caller's chain, verbatim (services/user.service.js): the sink value
      // is still in scope when provisioning resolves, which is the ONLY reason a
      // wait longer than the HTTP response can still produce a credential mail.
      mail = await welcomeMail.sendWelcomeMail({
        userId: MOHIT.userId,
        userName: MOHIT.userName,
        officialEmail: MOHIT.officialEmail,
        personalEmail: 'mohit.personal@gmail.com',
        tempPassword: sunk,
        provisioning: out,
      });
      seen = requests;
    });
  } finally {
    log.restore();
    await setProps({ 'entra.provisioning.enabled': 'false' });
  }

  // ── (a) The incident was REPRODUCED: the seat was not there at first. ────
  const readbacks = seen.filter((r) => r.url.includes('$select=id,assignedLicenses'));
  assert.equal(readbacks.length, 3,
    'absent on two reads, present on the third — the old 2-attempt/1.2s version stopped one read short');

  // ── (b) …and then FIXED. ────────────────────────────────────────────────
  assert.equal(out.licenceStatus, entra.LICENCE_STATUS.ASSIGNED,
    'not assigned_unconfirmed: we looked longer, and the seat was really there');
  assert.equal(out.mailboxReady, true);

  const mailReq = seen.find((r) => r.url.includes('/sendMail'));
  assert.ok(mailReq, 'the welcome mail went out — GATE 1 passed because the mailbox is real');
  assert.equal(mail.status, 'sent');
  assert.equal(typeof sunk, 'string');
  assert.ok(mailReq.body.includes(sunk),
    'and it carries the temp password — a mail without the credential is the same dead end');

  // ── (c) The password reached NOTHING else, on the long path either. ──────
  assert.equal(JSON.stringify(out).includes(sunk), false,
    'the provisioning outcome is published verbatim in the API response');
  assert.equal(JSON.stringify(mail).includes(sunk), false, 'so is the mail outcome');
  const leakedLog = log.lines.find((l) => l.includes(sunk));
  assert.equal(leakedLog, undefined, 'no logger line may carry it — got: ' + String(leakedLog));
  assert.ok(log.lines.length > 2, 'sanity: the logger really was capturing (' + log.lines.length + ' lines)');
  const leakedSql = fake.calls.find((c) =>
    String(c.sql).includes(sunk) || JSON.stringify(c.params ?? null).includes(sunk));
  assert.equal(leakedSql, undefined, 'and it is never persisted, to any table');
});

test('…and when the seat NEVER appears, the budget expires into the honest state: no mailbox, no mail, no credential anywhere', async () => {
  await setProps({
    'entra.provisioning.enabled': 'true',
    'entra.managed.domains': 'easyfix.in',
    'entra.provisioning.sku.part.number': 'SPB',
  });
  const welcomeMail = require('../services/user-welcome-mail.service');
  const log = captureLogger();
  fake.reset();

  let sunk = null;
  let out;
  let mail;
  let seen;
  try {
    // Never visible: 999 reads' worth of absence against a 300ms budget.
    await withProvisioningGraph({ visibleAfterReads: 999 }, async (requests) => {
      out = await entra.provisionUserMailbox({
        ...MOHIT,
        trigger: 'create-user',
        onTempPassword: (pw) => { sunk = pw; },
        licenceVerify: FAST_VERIFY,
      });
      mail = await welcomeMail.sendWelcomeMail({
        userId: MOHIT.userId,
        userName: MOHIT.userName,
        officialEmail: MOHIT.officialEmail,
        personalEmail: 'mohit.personal@gmail.com',
        tempPassword: sunk,
        provisioning: out,
      });
      seen = requests;
    });
  } finally {
    log.restore();
    await setProps({ 'entra.provisioning.enabled': 'false' });
  }

  assert.equal(out.licenceStatus, entra.LICENCE_STATUS.ASSIGNED_UNCONFIRMED,
    'waiting longer never turns "accepted" into "assigned" — the 2xx is still not evidence');
  assert.equal(out.mailboxReady, false);
  assert.equal(mail.status, 'skipped');
  assert.match(mail.reason, /mailbox is not ready/);
  assert.equal(seen.some((r) => r.url.includes('/sendMail')), false,
    'no credential mail for a mailbox we could not confirm');

  // The password WAS minted (the account got created), so this is not vacuous.
  assert.equal(typeof sunk, 'string');
  assert.equal(JSON.stringify(out).includes(sunk), false);
  assert.equal(log.lines.find((l) => l.includes(sunk)), undefined);
  assert.equal(
    fake.calls.find((c) => String(c.sql).includes(sunk) || JSON.stringify(c.params ?? null).includes(sunk)),
    undefined,
  );
});

test('assigned_unconfirmed does NOT count as a working mailbox', () => {
  // This is the load-bearing half. mailboxLikelyExists gates the OTP mailbox
  // pre-check: treating an unconfirmed licence as ready would mail a login OTP
  // into a mailbox that does not exist and suppress the WhatsApp/SMS fallback.
  assert.equal(
    entra.mailboxLikelyExists(entra.ACCOUNT_STATUS.CREATED, entra.LICENCE_STATUS.ASSIGNED_UNCONFIRMED),
    false,
  );
  assert.equal(
    entra.mailboxLikelyExists(entra.ACCOUNT_STATUS.CREATED, entra.LICENCE_STATUS.ASSIGNED),
    true,
  );
  assert.notEqual(entra.LICENCE_STATUS.ASSIGNED_UNCONFIRMED, entra.LICENCE_STATUS.ASSIGNED);
  assert.ok(entra.LICENCE_STATUS.ASSIGNED_UNCONFIRMED.length <= 32, 'licence_status is VARCHAR(32)');
});
