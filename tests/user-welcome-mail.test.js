/*
 * Unit tests for the "Your EasyFix account is ready" credential mail and — the
 * point of the exercise — for the TEMPORARY PASSWORD's containment.
 *
 * THE TWO THINGS BEING PINNED
 * ───────────────────────────
 * 1. WHEN IT SENDS. Only when the provisioning outcome says mailboxReady, i.e.
 *    the Entra account was created AND a licence was assigned. An account with
 *    no licence has NO mailbox, so mailing "here are your Outlook and Teams
 *    credentials" for it is actively misleading — licence_status
 *    'no_seats_available' is a real live case (user 8737).
 *
 * 2. WHERE THE PASSWORD GOES. Exactly two places: the Graph POST /users body,
 *    and the mail body. The guard test at the bottom drives the WHOLE create
 *    path with a scripted Graph and then asserts the real generated password
 *    string appears in NEITHER the API response object, NOR any line the real
 *    logger emitted, NOR any SQL statement or bound parameter. It first proves
 *    it DID reach the Graph body and the mail body, so the assertion cannot
 *    pass vacuously by the password never having existed.
 *
 * NO NETWORK, NO DB: globalThis.fetch is a scripted stub and the mysql2 pool is
 * tests/helpers/fake-pool. Nothing is written anywhere and no mail is sent.
 * Runner: `node --test`.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

// ── Fake DB ───────────────────────────────────────────────────────────────
let props = {};
const CREATED_USER_ID = 9001;

const fake = installFakePool([
  // createUser now takes GET_LOCK('easyfix_emp_code', 5) around the employee-code
  // duplicate check. An unrouted GET_LOCK returns no rows, which the service
  // correctly reads as "not acquired" and turns into a 503 — so every create
  // below would fail for a reason these tests are not about. 1 = acquired.
  // The collision guard itself is characterized in tests/emp-code.test.js.
  [/GET_LOCK/i, [{ got: 1 }]],
  [/FROM easyfix_properties/i, () =>
    Object.entries(props).map(([property_key, property_value]) => ({ property_key, property_value }))],
  [/SELECT role_id, role_name/i, [{ role_id: 2, role_name: 'Admin', role_status: 1, menu_ids: '' }]],
  [/LOWER\(official_email\)/i, []],
  [/INSERT INTO tbl_user_personal_details/i, { affectedRows: 1 }],
  [/tbl_user_entra_provisioning/i, { affectedRows: 1 }],
  [/FROM tbl_user_allowed_stages/i, []],
  [/INSERT INTO tbl_user\b/i, { insertId: CREATED_USER_ID }],
  [/FROM tbl_user\s+u/i, [{
    user_id: CREATED_USER_ID,
    user_name: 'Test User',
    official_email: 'test.user@easyfix.in',
    personal_email: 'personal.inbox@gmail.com',
    user_status: 1,
  }]],
]);

const propsSvc = require('../services/properties.service');
const logger = require('../logger');
const emailService = require('../services/email.service');
const welcome = require('../services/user-welcome-mail.service');
const userService = require('../services/user.service');

const ENV_KEYS = [
  'MS_GRAPH_TENANT_ID', 'MS_GRAPH_CLIENT_ID', 'MS_GRAPH_CLIENT_SECRET', 'MS_GRAPH_SENDER_EMAIL',
  'NOTIFICATIONS_DISABLE', 'TEST_EMAILS', 'CRM_PUBLIC_BASE_URL', 'CRM_URL', 'MAGIC_LINK_BASE_URL',
  // Restored like the rest: node --test forks per file today, but a runner that
  // ever shares a process would otherwise hand the next file a 1s licence budget
  // and a mysteriously "flaky" provisioning test.
  'ENTRA_LICENCE_VERIFY_BUDGET_MS',
];
const savedEnv = {};

before(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  /*
   * CLAMP THE LICENCE-VERIFY BUDGET, and this is correctness rather than speed.
   *
   * assignLicense now waits out Graph's eventual consistency with a backoff
   * under a 90-second budget — deliberately longer than the 20s inline deadline,
   * so a slow seat still gets its welcome mail from the background chain. That
   * makes the seat-never-visible test here do two things it must not: stall the
   * file for the full 20s deadline, and — worse — keep polling in the background
   * AFTER `after()` restores the real globalThis.fetch, so a unit test would
   * reach the real network.
   *
   * The budget is read lazily on purpose (see licenceVerifyBudgetMs), so setting
   * it here takes effect even though the service was required above.
   */
  process.env.ENTRA_LICENCE_VERIFY_BUDGET_MS = '1000';
  props = {
    'entra.provisioning.enabled': 'true',
    'entra.managed.domains': 'easyfix.in',
    'entra.provisioning.sku.part.number': 'SPB',
  };
  await propsSvc.flushCache();
  process.env.CRM_PUBLIC_BASE_URL = 'https://qa.crm.easyfix.in';
  delete process.env.CRM_URL;
  delete process.env.MAGIC_LINK_BASE_URL;
});

after(() => {
  fake.restore();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────

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

const READY = { mailboxReady: true, accountStatus: 'created', licenceStatus: 'assigned' };

/* Replace emailService.send with a recorder. Returns { sends, restore }. */
function stubSender(result = { accepted: true, delivered: true, deliveryConfirmed: false }) {
  const sends = [];
  const original = emailService.send;
  emailService.send = async (msg) => { sends.push(msg); return result; };
  return { sends, restore: () => { emailService.send = original; } };
}

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

// ── 1. Composition (pure) ─────────────────────────────────────────────────

test('composeWelcomeMail names the person and the org in the subject', () => {
  const m = welcome.composeWelcomeMail({
    userName: 'Priya Sharma', officialEmail: 'priya.sharma@easyfix.in',
    tempPassword: 'Pw-EXAMPLE-1', crmUrl: 'https://crm.easyfix.in',
  });
  assert.match(m.subject, /^Your EasyFix account is ready/);
  assert.match(m.subject, /Priya Sharma/);
});

test('composeWelcomeMail carries the sign-in address, the password, and the must-change instruction', () => {
  const m = welcome.composeWelcomeMail({
    userName: 'Priya Sharma', officialEmail: 'priya.sharma@easyfix.in',
    tempPassword: 'Pw-EXAMPLE-1', crmUrl: 'https://crm.easyfix.in',
  });
  assert.match(m.text, /priya\.sharma@easyfix\.in/);
  assert.match(m.text, /Pw-EXAMPLE-1/);
  assert.match(m.text, /MUST change this password the first time you sign in/);
});

test('composeWelcomeMail says where to sign in — Outlook, Teams and the CRM', () => {
  const m = welcome.composeWelcomeMail({
    userName: 'Priya Sharma', officialEmail: 'priya.sharma@easyfix.in',
    tempPassword: 'Pw-EXAMPLE-1', crmUrl: 'https://qa.crm.easyfix.in',
  });
  assert.match(m.text, /outlook\.office\.com/);
  assert.match(m.text, /teams\.microsoft\.com/);
  assert.match(m.text, /qa\.crm\.easyfix\.in/, 'the CRM host comes from env, never a hardcoded literal');
});

test('composeWelcomeMail states OUTRIGHT that CRM sign-in is OTP-based and does NOT use this password', () => {
  const m = welcome.composeWelcomeMail({
    userName: 'Priya Sharma', officialEmail: 'priya.sharma@easyfix.in',
    tempPassword: 'Pw-EXAMPLE-1', crmUrl: 'https://crm.easyfix.in',
  });
  assert.match(m.text, /CRM does NOT use the password above/);
  assert.match(m.text, /one-time password \(OTP\)/);
  assert.match(m.text, /there is no password field/,
    'conflating the mailbox password with CRM login is the obvious support ticket');
});

test('composeWelcomeMail omits the CRM link rather than guessing a host when neither env var is set', () => {
  const m = welcome.composeWelcomeMail({
    userName: 'X', officialEmail: 'x@easyfix.in', tempPassword: 'Pw-EXAMPLE-1', crmUrl: null,
  });
  assert.match(m.text, /EasyFix CRM/, 'the CRM paragraph still explains OTP sign-in');
  assert.equal(/https?:\/\/[^\s]*crm/i.test(m.text), false,
    'a QA host that guessed the production URL would send a new joiner to the wrong system');
});

test('crmSignInUrl prefers CRM_PUBLIC_BASE_URL, falls back to MAGIC_LINK_BASE_URL, and strips a trailing slash', () => {
  process.env.CRM_PUBLIC_BASE_URL = 'https://qa.crm.easyfix.in/';
  process.env.MAGIC_LINK_BASE_URL = 'https://crm.easyfix.in';
  assert.equal(welcome.crmSignInUrl(), 'https://qa.crm.easyfix.in');
  delete process.env.CRM_PUBLIC_BASE_URL;
  assert.equal(welcome.crmSignInUrl(), 'https://crm.easyfix.in');
  delete process.env.MAGIC_LINK_BASE_URL;
  assert.equal(welcome.crmSignInUrl(), null);
  process.env.CRM_PUBLIC_BASE_URL = 'https://qa.crm.easyfix.in';
});

test('crmSignInUrl NEVER reads CRM_URL — that variable is the CORS origin allowlist', () => {
  /*
   * cors.js:46 runs CRM_URL through splitOrigins(), so it is legitimately
   * comma-separated, and the checked-in .env sets it to http://localhost:5180.
   * Reading it here put a localhost link — or a two-host CSV — into a new
   * joiner's first mail on any host without CRM_PUBLIC_BASE_URL.
   */
  delete process.env.CRM_PUBLIC_BASE_URL;
  delete process.env.MAGIC_LINK_BASE_URL;
  process.env.CRM_URL = 'https://crm.easyfix.in,https://qa.crm.easyfix.in';
  assert.equal(welcome.crmSignInUrl(), null, 'the link is omitted rather than sourced from the CORS list');
  delete process.env.CRM_URL;

  // And a base URL that has picked up a comma still yields ONE usable origin.
  process.env.CRM_PUBLIC_BASE_URL = 'https://qa.crm.easyfix.in/,https://crm.easyfix.in';
  assert.equal(welcome.crmSignInUrl(), 'https://qa.crm.easyfix.in');
  process.env.CRM_PUBLIC_BASE_URL = 'https://qa.crm.easyfix.in';
});

test('the credential mail opts OUT of the Sent Items copy — a live password must not be archived in the shared IT mailbox', async () => {
  const s = stubSender();
  try {
    await welcome.sendWelcomeMail({
      userId: 1, userName: 'X', officialEmail: 'x@easyfix.in',
      personalEmail: 'x@gmail.com', tempPassword: 'Pw-EXAMPLE-1', provisioning: READY,
    });
    assert.equal(s.sends[0].saveToSentItems, false,
      'MS_GRAPH_SENDER_EMAIL is a shared helpdesk mailbox nobody prunes — the user and the HR CC are the only intended copies');
  } finally { s.restore(); }
});

/*
 * ── The CC address is a CONSTANT (was `user.welcome.cc.emails` until 2026-08-03)
 *
 * These three tests replace the ones that exercised the property (empty list,
 * multi-address list). Those states no longer exist: the key is gone from the
 * migration and nothing reads easyfix_properties for this.
 */

test('the CC is ALWAYS hr@easyfix.in — no property, no configuration, no way to be unset', () => {
  assert.equal(welcome.WELCOME_MAIL_CC, 'hr@easyfix.in');
  assert.deepEqual(welcome.ccRecipients(), ['hr@easyfix.in']);
  assert.deepEqual(welcome.ccRecipients('personal.inbox@gmail.com'), ['hr@easyfix.in']);
});

test('the CC survives an EMPTY easyfix_properties table — the exact case the property got wrong', async () => {
  /*
   * THE BUG THIS PINS. When the address lived in `user.welcome.cc.emails`, an
   * absent or blank row read as "no CC" and the mail went out to the joiner
   * alone — silently, with nothing reporting that HR had been dropped. Same
   * class of failure as `entra.provisioning.enabled` being unset, which turned
   * mailbox provisioning off for every user while looking shipped. A constant
   * has no unset state, so drive the whole send with the properties table
   * completely empty and prove the CC is still on the envelope.
   */
  const saved = props;
  const s = stubSender();
  try {
    props = {};
    await propsSvc.flushCache();

    assert.deepEqual(welcome.ccRecipients('personal.inbox@gmail.com'), ['hr@easyfix.in']);

    const out = await welcome.sendWelcomeMail({
      userId: CREATED_USER_ID, userName: 'Test User', officialEmail: 'test.user@easyfix.in',
      personalEmail: 'personal.inbox@gmail.com', tempPassword: 'Pw-EXAMPLE-1', provisioning: READY,
    });
    assert.equal(out.status, 'sent');
    assert.deepEqual(out.cc, ['hr@easyfix.in']);
    assert.deepEqual(s.sends[0].cc, ['hr@easyfix.in'],
      'no properties row anywhere, and HR is still copied');
  } finally {
    s.restore();
    props = saved;
    await propsSvc.flushCache();
  }
});

test('SELF-CC: an HR joiner is not copied on their own mail', async () => {
  // Case-insensitively, after trimming — the normalisation the property-backed
  // parse used to apply is kept so ' HR@EasyFix.in ' still collides.
  assert.deepEqual(welcome.ccRecipients('hr@easyfix.in'), []);
  assert.deepEqual(welcome.ccRecipients('  HR@EasyFix.in  '), []);

  const s = stubSender();
  try {
    const out = await welcome.sendWelcomeMail({
      userId: 1, userName: 'HR Person', officialEmail: 'hr.person@easyfix.in',
      personalEmail: 'HR@easyfix.in', tempPassword: 'Pw-EXAMPLE-1', provisioning: READY,
    });
    assert.equal(out.status, 'sent');
    assert.deepEqual(out.cc, []);
    assert.equal(s.sends[0].cc, undefined,
      'one mailbox on both lines would put two copies of a live temp password in one inbox');
  } finally { s.restore(); }
});

// ── 2. The send gate ──────────────────────────────────────────────────────

test('NOT sent when mailboxReady is false — an unlicensed account has no Outlook or Teams to log into', async () => {
  const s = stubSender();
  try {
    for (const provisioning of [
      { mailboxReady: false, accountStatus: 'created',          licenceStatus: 'no_seats_available' },
      { mailboxReady: false, accountStatus: 'created',          licenceStatus: 'no_sku_configured' },
      { mailboxReady: false, accountStatus: 'skipped_disabled', licenceStatus: 'skipped' },
      { mailboxReady: false, accountStatus: 'failed',           licenceStatus: 'not_attempted' },
    ]) {
      const out = await welcome.sendWelcomeMail({
        userId: 8737, userName: 'Test User', officialEmail: 'test.user@easyfix.in',
        personalEmail: 'personal.inbox@gmail.com', tempPassword: 'Pw-EXAMPLE-1', provisioning,
      });
      assert.equal(out.status, 'skipped', JSON.stringify(provisioning));
      assert.match(out.reason, /mailbox is not ready/);
    }
    assert.equal(s.sends.length, 0, 'not one message was composed, let alone sent');
  } finally { s.restore(); }
});

test('NOT sent when there is no provisioning outcome at all', async () => {
  const s = stubSender();
  try {
    const out = await welcome.sendWelcomeMail({ userId: 1, tempPassword: 'Pw-EXAMPLE-1', personalEmail: 'a@b.com' });
    assert.equal(out.status, 'skipped');
    assert.equal(s.sends.length, 0);
  } finally { s.restore(); }
});

test('NOT sent when the user has no personal email — there is nowhere reachable to send it', async () => {
  const s = stubSender();
  try {
    const out = await welcome.sendWelcomeMail({
      userId: 1, userName: 'X', officialEmail: 'x@easyfix.in',
      personalEmail: '  ', tempPassword: 'Pw-EXAMPLE-1', provisioning: READY,
    });
    assert.equal(out.status, 'skipped');
    assert.match(out.reason, /no personal email/);
    assert.equal(s.sends.length, 0);
  } finally { s.restore(); }
});

test('NOT sent when no password was minted (the account already existed) — no empty credential mail', async () => {
  const s = stubSender();
  try {
    const out = await welcome.sendWelcomeMail({
      userId: 1, userName: 'X', officialEmail: 'x@easyfix.in',
      personalEmail: 'x@gmail.com', tempPassword: null,
      provisioning: { mailboxReady: true, accountStatus: 'already_exists', licenceStatus: 'already_licensed' },
    });
    assert.equal(out.status, 'skipped');
    assert.match(out.reason, /already existed/);
    assert.match(out.reason, /admin centre/, 'and it says what to do instead');
    assert.equal(s.sends.length, 0);
  } finally { s.restore(); }
});

test('SENT to the PERSONAL address, CC hr@easyfix.in, when the mailbox is genuinely ready', async () => {
  const s = stubSender();
  try {
    const out = await welcome.sendWelcomeMail({
      userId: CREATED_USER_ID, userName: 'Test User', officialEmail: 'test.user@easyfix.in',
      personalEmail: 'personal.inbox@gmail.com', tempPassword: 'Pw-EXAMPLE-1', provisioning: READY,
    });
    assert.equal(out.status, 'sent');
    assert.equal(out.to, 'personal.inbox@gmail.com');
    assert.deepEqual(out.cc, ['hr@easyfix.in']);

    assert.equal(s.sends.length, 1);
    const msg = s.sends[0];
    assert.equal(msg.to, 'personal.inbox@gmail.com',
      'never the official_email — the brand-new mailbox cannot be its own delivery address');
    assert.deepEqual(msg.cc, ['hr@easyfix.in'], 'so HR can re-share it if the user misses it');
    assert.match(msg.subject, /Your EasyFix account is ready - Test User/);
    assert.match(msg.text, /Pw-EXAMPLE-1/);
    assert.equal(msg.category, 'transactional');
  } finally { s.restore(); }
});

test('a mail failure is REPORTED, never thrown — user creation must not roll back over an email', async () => {
  const s = stubSender({ accepted: false, delivered: false, error: 'Graph sendMail 503: service unavailable' });
  try {
    const out = await welcome.sendWelcomeMail({
      userId: 1, userName: 'X', officialEmail: 'x@easyfix.in',
      personalEmail: 'x@gmail.com', tempPassword: 'Pw-EXAMPLE-1', provisioning: READY,
    });
    assert.equal(out.status, 'failed');
    assert.match(out.reason, /503/);
  } finally { s.restore(); }

  // Even a sender that THROWS is contained.
  const original = emailService.send;
  emailService.send = async () => { throw new Error('boom'); };
  try {
    const out = await welcome.sendWelcomeMail({
      userId: 1, userName: 'X', officialEmail: 'x@easyfix.in',
      personalEmail: 'x@gmail.com', tempPassword: 'Pw-EXAMPLE-1', provisioning: READY,
    });
    assert.equal(out.status, 'failed');
    assert.match(out.reason, /boom/);
  } finally { emailService.send = original; }
});

test('NOTIFICATIONS_DISABLE short-circuits BEFORE any network call', async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error('a disabled host must not reach the network'); };
  process.env.NOTIFICATIONS_DISABLE = 'true';
  try {
    const out = await welcome.sendWelcomeMail({
      userId: 1, userName: 'X', officialEmail: 'x@easyfix.in',
      personalEmail: 'real.person@gmail.com', tempPassword: 'Pw-EXAMPLE-1', provisioning: READY,
    });
    assert.equal(out.status, 'skipped');
    assert.match(out.reason, /notifications are disabled/);
    assert.equal(networkCalls, 0, 'a QA host must never mail a real person’s personal address');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.NOTIFICATIONS_DISABLE;
  }
});

// ── 3. End-to-end through createUser, with a scripted Graph ───────────────

const SKU_FREE = {
  skuId: 'sku-guid-spb', skuPartNumber: 'SPB', capabilityStatus: 'Enabled',
  consumedUnits: 3, prepaidUnits: { enabled: 10, warning: 0, suspended: 0 },
};
const SKU_FULL = { ...SKU_FREE, consumedUnits: 10 };

/*
 * Scripted Microsoft Graph. Records every request so the guard test can prove
 * the password DID reach the create body (non-vacuous) and DID reach the mail
 * body, before asserting it reached nothing else.
 */
function withScriptedGraph(sku, fn, { seatVisibleOnReadBack = true } = {}) {
  const originalFetch = globalThis.fetch;
  process.env.MS_GRAPH_TENANT_ID = 'tenant-test';
  process.env.MS_GRAPH_CLIENT_ID = 'client-test';
  process.env.MS_GRAPH_CLIENT_SECRET = 'secret-test';
  process.env.MS_GRAPH_SENDER_EMAIL = 'ithelpdesk@easyfix.in';
  delete process.env.NOTIFICATIONS_DISABLE;
  delete process.env.TEST_EMAILS;

  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    const body = init.body === undefined ? '' : String(init.body);
    seen.push({ url: u, method, body });

    if (u.includes('login.microsoftonline.com')) return makeRes(200, { access_token: 'fake-token', expires_in: 3600 });
    if (u.includes('/sendMail'))                 return makeRes(202, undefined);
    if (u.includes('/assignLicense'))            return makeRes(204, undefined);
    if (u.includes('/subscribedSkus'))           return makeRes(200, { value: [sku] });
    if (method === 'POST' && /\/v1\.0\/users$/.test(u)) return makeRes(201, { id: 'obj-9001' });
    /*
     * Licence READ-BACK. assignLicense no longer trusts its own 2xx — a 202 means
     * "queued", not "the seat is on the user" — so it re-reads assignedLicenses
     * and only reports `assigned` when the SKU is really there. Without this
     * branch the read 404s, the licence records `assigned_unconfirmed`, and
     * GATE 3 correctly suppresses the credential mail.
     */
    /*
     * Matched on the EXACT select list. `assignedLicenses` also appears in the
     * pre-existence lookup's select (findByUpn's race re-resolve), and a looser
     * match answered THAT with a 200 — so the account read as already existing,
     * the flow took the reuse path, and POST /users never happened.
     */
    if (method === 'GET' && u.includes('$select=id,assignedLicenses')) {
      return makeRes(200, {
        id: 'obj-9001',
        assignedLicenses: seatVisibleOnReadBack ? [{ skuId: sku.skuId }] : [],
      });
    }
    if (u.includes('$filter='))                  return makeRes(200, { value: [] });
    return makeRes(404, { error: { code: 'Request_ResourceNotFound', message: 'not found' } });
  };

  return Promise.resolve(fn(seen)).finally(() => { globalThis.fetch = originalFetch; });
}

const CREATE_ARGS = {
  user_name: 'Test User',
  official_email: 'test.user@easyfix.in',
  user_role: 2,
  personal_email: 'personal.inbox@gmail.com',
  createdBy: 99,
  // MANDATORY since 2026-09-01 — operator-supplied, prefilled from
  // GET /api/admin/users/next-emp-code. Present so these tests reach the
  // provisioning and mail behaviour they are about; the code's own rules
  // (format, collision, lock) live in tests/emp-code.test.js.
  user_code: 'EF000123',
};

test('GUARD: the temp password reaches the Graph body and the mail body — and NOTHING else', async () => {
  const log = captureLogger();
  fake.reset();
  let row;
  let seen;
  try {
    await withScriptedGraph(SKU_FREE, async (requests) => {
      row = await userService.createUser({ ...CREATE_ARGS });
      seen = requests;
    });
  } finally {
    log.restore();
  }

  // ── (a) The password EXISTS and is the real generated one. ──────────────
  const createReq = seen.find((r) => r.method === 'POST' && /\/v1\.0\/users$/.test(r.url));
  assert.ok(createReq, 'the directory account was created');
  const password = JSON.parse(createReq.body).passwordProfile.password;
  assert.equal(typeof password, 'string');
  assert.equal(password.length, 20, 'the existing 20-char CSPRNG generator is unchanged');
  assert.match(password, /^[a-zA-Z0-9!@#$%^*()\-_=+?]+$/);
  assert.equal(JSON.parse(createReq.body).passwordProfile.forceChangePasswordNextSignIn, true);

  // ── (b) It DID reach the mail. Without this the guard below is vacuous. ─
  const mailReq = seen.find((r) => r.url.includes('/sendMail'));
  assert.ok(mailReq, 'the credential mail was sent');
  assert.ok(mailReq.body.includes(password), 'the mail actually carries the password — otherwise it is useless');

  // ── (c) It reached NOTHING else. ────────────────────────────────────────
  assert.equal(
    JSON.stringify(row).includes(password), false,
    'the API response body (row + provisioning + welcome_mail) must not contain the password',
  );
  assert.equal(
    JSON.stringify(row.provisioning).includes(password), false,
    'the provisioning outcome is published verbatim — it must be clean',
  );
  assert.equal(
    JSON.stringify(row.welcome_mail).includes(password), false,
    'the mail outcome is published verbatim — it must be clean',
  );
  assert.equal(Object.prototype.hasOwnProperty.call(row.welcome_mail, 'password'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(row.provisioning, 'password'), false);

  const leakedLog = log.lines.find((l) => l.includes(password));
  assert.equal(leakedLog, undefined,
    'no logger line on ANY path may contain the password — got: ' + String(leakedLog));
  assert.ok(log.lines.length > 3, 'sanity: the logger really was capturing (' + log.lines.length + ' lines)');

  const leakedSql = fake.calls.find((c) =>
    String(c.sql).includes(password) || JSON.stringify(c.params ?? null).includes(password));
  assert.equal(leakedSql, undefined,
    'the password must never be written to tbl_user_personal_details, tbl_user_entra_provisioning, or anywhere else');
  assert.ok(
    fake.calls.some((c) => /tbl_user_entra_provisioning/i.test(c.sql)),
    'sanity: the provisioning row WAS written, so the assertion above had something to inspect',
  );

  // ── (d) And the feature actually worked. ────────────────────────────────
  assert.equal(row.provisioning.mailboxReady, true);
  assert.equal(row.welcome_mail.status, 'sent');
  assert.equal(row.welcome_mail.to, 'personal.inbox@gmail.com');
  assert.deepEqual(row.welcome_mail.cc, ['hr@easyfix.in']);
  const envelope = JSON.parse(mailReq.body).message;
  assert.deepEqual(envelope.toRecipients, [{ emailAddress: { address: 'personal.inbox@gmail.com' } }]);
  assert.deepEqual(envelope.ccRecipients, [{ emailAddress: { address: 'hr@easyfix.in' } }]);
  assert.match(envelope.subject, /Your EasyFix account is ready - Test User/);
});

test('GUARD: with NO free licence seats no mail is sent at all, and the response says why', async () => {
  fake.reset();
  let row;
  let seen;
  await withScriptedGraph(SKU_FULL, async (requests) => {
    row = await userService.createUser({ ...CREATE_ARGS, official_email: 'no.seats@easyfix.in' });
    seen = requests;
  });

  assert.equal(row.provisioning.mailboxReady, false);
  assert.equal(row.provisioning.licenceStatus, 'no_seats_available');
  assert.equal(
    seen.some((r) => r.url.includes('/sendMail')), false,
    'this is the user-8737 case: Outlook and Teams will NOT work, so "here are your credentials" would be a lie',
  );
  assert.equal(row.welcome_mail.status, 'skipped');
  assert.match(row.welcome_mail.reason, /mailbox is not ready/);
  assert.match(row.welcome_mail.reason, /no_seats_available/, 'and it names the actual blocker');
});

test('GUARD: with provisioning OFF the create path sends nothing and touches no network', async () => {
  props = { ...props, 'entra.provisioning.enabled': 'false' };
  await propsSvc.flushCache();
  fake.reset();
  let row;
  let seen;
  try {
    await withScriptedGraph(SKU_FREE, async (requests) => {
      row = await userService.createUser({ ...CREATE_ARGS, official_email: 'flag.off@easyfix.in' });
      seen = requests;
    });
    assert.equal(seen.length, 0, 'the master switch gates every outbound call, mail included');
    assert.equal(row.provisioning.accountStatus, 'skipped_disabled');
    assert.equal(row.welcome_mail.status, 'skipped');
  } finally {
    props = { ...props, 'entra.provisioning.enabled': 'true' };
    await propsSvc.flushCache();
  }
});

test('createEntraUser keeps the password OFF its return value — a future {...created} spread cannot leak it', async () => {
  const entra = require('../services/entra-provisioning.service');
  let sunk = null;
  await withScriptedGraph(SKU_FREE, async () => {
    const created = await entra.createEntraUser(
      { userPrincipalName: 'sink.test@easyfix.in', displayName: 'Sink Test', mailNickname: 'sink.test' },
      (pw) => { sunk = pw; },
    );
    assert.equal(created.ok, true);
    assert.deepEqual(Object.keys(created).sort(), ['id', 'ok', 'requestId'],
      'ok / id / requestId — and nothing else');
    assert.equal(JSON.stringify(created).includes(sunk), false);
  });
  assert.equal(typeof sunk, 'string');
  assert.equal(sunk.length, 20, 'the sink is the ONLY exit, and it did fire');
});

test('a throwing password sink cannot break provisioning', async () => {
  const entra = require('../services/entra-provisioning.service');
  await withScriptedGraph(SKU_FREE, async () => {
    const created = await entra.createEntraUser(
      { userPrincipalName: 'boom.sink@easyfix.in', displayName: 'Boom', mailNickname: 'boom.sink' },
      () => { throw new Error('consumer exploded'); },
    );
    assert.equal(created.ok, true, 'the account was still created; the sink is best-effort');
  });
});

/*
 * GATE 3 now also covers "Graph accepted the licence but the seat never
 * appeared". Previously that state recorded a clean `assigned` and the joiner
 * got a credential mail for a mailbox they could not open — the reported bug on
 * anand.thakur@easyfix.in, whose provisioning row said assigned /
 * O365_BUSINESS_ESSENTIALS while every licence box in the admin centre was
 * unticked.
 *
 * Suppressing is the right failure here: the credentials are useless until the
 * seat lands, and the WARN + `assigned_unconfirmed` row makes it findable and
 * re-runnable through the repair endpoint. A mail that looks like success is
 * exactly what hid this for a day.
 */
test('no credential mail when the licence seat is not visible on read-back', async () => {
  const log = captureLogger();
  fake.reset();
  let seen;
  try {
    await withScriptedGraph(
      SKU_FREE,
      async (requests) => { await userService.createUser({ ...CREATE_ARGS }); seen = requests; },
      { seatVisibleOnReadBack: false },
    );
  } finally {
    log.restore();
  }
  assert.ok(seen.find((r) => r.url.includes('/assignLicense')), 'the assignment WAS attempted');
  assert.equal(
    seen.find((r) => r.url.includes('/sendMail')),
    undefined,
    'but no credentials go out for a mailbox we could not confirm',
  );
});
