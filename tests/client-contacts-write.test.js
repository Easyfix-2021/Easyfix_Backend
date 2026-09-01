/*
 * POST /contacts, PUT /contacts/:id, POST /auth/signup.
 *
 * WHY THIS FILE EXISTS. All three were called by the portal and none existed.
 * Profile -> Contacts has an Add button, an Edit button and an
 * Activate/Deactivate toggle; every one of them 404'd, and the landing page's
 * "Signup Now" reported "Signup failed. Please contact your account manager"
 * — which reads as policy, not as a missing route, so nobody chased it.
 *
 * These drive the ROUTE HANDLERS. The services underneath (createContact,
 * updateContact) were already exercised by bulk-upload; what was missing, and
 * what is tested here, is the wiring: validation, tenancy and the toggle shape.
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

let contactRow = { id: 7, client_id: 133 };     // the row loadOwnedContact finds
let dupRow = [];                                 // findDuplicateContact result
let clientRow = [{ client_id: 133, client_name: 'Acme' }];

const fake = installFakePool([
  [/SELECT id, client_id FROM tbl_client_contacts/i, () => (contactRow ? [contactRow] : [])],
  [/FROM tbl_client_contacts[\s\S]*contact_email = \?|contact_no = \?/i, () => dupRow],
  [/SELECT client_id, client_name FROM tbl_client/i, () => clientRow],
  [/SELECT client_id FROM tbl_client_contacts WHERE id/i, () => [{ client_id: 133 }]],
  [/^\s*INSERT INTO tbl_client_contacts/i, () => ({ insertId: 4242 })],
  [/^\s*UPDATE tbl_client_contacts/i, () => ({ affectedRows: 1 })],
  [/^\s*SELECT/i, [{}]],
]);

/* The signup route emails ops. Capture instead of sending. */
const email = require('../services/email.service');
let sent = [];
email.send = async (msg) => { sent.push(msg); return { ok: true }; };

const router = require('../routes/client/index');

function handlerFor(path, method) {
  const layer = router.stack.find((e) => e.route && e.route.path === path && e.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
  return layer.route.stack;
}
const res = () => ({
  statusCode: null, body: null,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
});

/* Run the whole stack so `validate(...)` actually runs — testing the final
 * handler alone would skip the schema, which is half of what is new here. */
async function call(path, method, body, params = {}) {
  const stack = handlerFor(path, method);
  const r = res();
  /* originalUrl/method are read by validate()'s 400 logger — without them the
   * middleware throws inside its own logging and the test sees a TypeError
   * instead of the 400 it is asserting. */
  const req = { spoc: { id: 42, client_id: 133, contact_name: 'A', contact_email: 'a@b.co' },
                access: {}, query: {}, params, body,
                method: method.toUpperCase(), originalUrl: `/api/client${path}`, path };
  for (const layer of stack) {
    let nexted = false;
    await layer.handle(req, r, (e) => { if (e) throw e; nexted = true; });
    if (!nexted) break;                 // a layer answered (validation error, etc.)
  }
  return r;
}

const good = { contactName: 'Asha R', contactEmail: 'asha@acme.com', contactNo: '9876543210' };

beforeEach(() => {
  fake.reset(); sent = [];
  contactRow = { id: 7, client_id: 133 };
  dupRow = []; clientRow = [{ client_id: 133, client_name: 'Acme' }];
});

/* ─── POST /contacts ───────────────────────────────────────────────────── */

test('POST /contacts creates, scoped to the caller\'s own client', async () => {
  const r = await call('/contacts', 'post', { ...good });
  assert.equal(r.body?.success, true, JSON.stringify(r.body));
  const ins = fake.calls.find((c) => /INSERT INTO tbl_client_contacts/i.test(c.sql));
  assert.ok(ins, 'must insert');
  assert.equal(ins.params[0], 133, 'client_id comes from the session, never the body');
});

test('a body claiming another client cannot reach the INSERT', async () => {
  await call('/contacts', 'post', { ...good, clientId: 999, client_id: 999 });
  const ins = fake.calls.find((c) => /INSERT INTO tbl_client_contacts/i.test(c.sql));
  assert.equal(ins.params[0], 133, 'req.spoc.client_id wins — a foreign id is not a tenancy hole');
});

test('phone is normalised the way the spreadsheet normalises it', async () => {
  // Spacing is stripped, exactly as client-xlsx.service.js strips it.
  await call('/contacts', 'post', { ...good, contactNo: '98765 43210' });
  const ins = fake.calls.find((c) => /INSERT INTO tbl_client_contacts/i.test(c.sql));
  assert.ok(ins && ins.params.includes('9876543210'),
    'a spaced number uploads fine in a sheet; it must not fail in the form');
});

test('a +91 number is refused HERE too — the sheet refuses it as well', async () => {
  /* The sheet does replace(/\D/g,'') then /^\d{10}$/, so '+91 98765 43210'
   * becomes twelve digits and fails there. Accepting it here would be the
   * two-populations bug this parity exists to prevent — one contact typed in
   * and one uploaded must obey one rule. If the country code should be
   * tolerated, it has to be tolerated in BOTH places. */
  const r = await call('/contacts', 'post', { ...good, contactNo: '+91 98765 43210' });
  assert.equal(r.statusCode, 400);
});

test('a 9-digit phone is refused, as the sheet refuses it', async () => {
  const r = await call('/contacts', 'post', { ...good, contactNo: '987654321' });
  assert.equal(r.statusCode, 400);
  assert.equal(fake.calls.some((c) => /INSERT INTO/i.test(c.sql)), false, 'nothing written');
});

test('a missing name or email never reaches the database', async () => {
  for (const bad of [{ ...good, contactName: undefined }, { ...good, contactEmail: 'nope' }]) {
    fake.reset();
    const r = await call('/contacts', 'post', bad);
    assert.equal(r.statusCode, 400, JSON.stringify(r.body));
    assert.equal(fake.calls.some((c) => /INSERT INTO/i.test(c.sql)), false);
  }
});

/* ─── PUT /contacts/:id ────────────────────────────────────────────────── */

test('PUT updates a contact of my own client', async () => {
  const r = await call('/contacts/:id', 'put', { contactDesgn: 'Ops Lead' }, { id: '7' });
  assert.equal(r.body?.success, true, JSON.stringify(r.body));
  assert.ok(fake.calls.some((c) => /UPDATE tbl_client_contacts/i.test(c.sql)), 'must update');
});

test('⚠ a contact of ANOTHER client is 404, and nothing is written', async () => {
  contactRow = { id: 7, client_id: 999 };
  const r = await call('/contacts/:id', 'put', { contactDesgn: 'x' }, { id: '7' });
  assert.equal(r.statusCode, 404, 'not 403 — a distinguishable answer confirms the id exists');
  assert.equal(fake.calls.some((c) => /UPDATE tbl_client_contacts/i.test(c.sql)), false);
});

test('the Activate/Deactivate toggle sends status ALONE and is accepted', async () => {
  // The toggle posts { status: 0 } with no other field. An `.min(1)` schema that
  // required a name would have rejected exactly the call the UI makes.
  const r = await call('/contacts/:id', 'put', { status: 0 }, { id: '7' });
  assert.equal(r.body?.success, true, JSON.stringify(r.body));
  const up = fake.calls.find((c) => /UPDATE tbl_client_contacts/i.test(c.sql));
  assert.match(up.sql, /status = \?/);
  assert.equal(up.params[0], 0);
});

test('an empty body is refused rather than issuing an UPDATE with no SET', async () => {
  const r = await call('/contacts/:id', 'put', {}, { id: '7' });
  assert.equal(r.statusCode, 400);
});

test('status must be 0 or 1', async () => {
  const r = await call('/contacts/:id', 'put', { status: 7 }, { id: '7' });
  assert.equal(r.statusCode, 400);
});

/* ─── POST /auth/signup ────────────────────────────────────────────────── */

test('signup is PUBLIC — it sits above requireSpocAuth', async () => {
  const idx = (p, m) => router.stack.findIndex((e) => e.route && e.route.path === p && e.route.methods[m]);
  const gate = router.stack.findIndex((e) => !e.route && /requireSpocAuth/.test(String(e.handle)));
  assert.ok(gate > 0, 'the auth gate must be findable');
  assert.ok(idx('/auth/signup', 'post') < gate,
    'someone without an account cannot be authenticated — the route must precede the gate');
});

test('signup emails ops and creates NOTHING', async () => {
  const r = await call('/auth/signup', 'post', { clientId: '133', email: 'new@acme.com' });
  assert.equal(r.body?.success, true, JSON.stringify(r.body));
  assert.equal(sent.length, 1, 'ops must be told');
  assert.match(sent[0].text, /new@acme\.com/);
  assert.equal(fake.calls.some((c) => /INSERT|UPDATE/i.test(c.sql)), false,
    '⚠ the client id is typed by a stranger — provisioning on it would let anyone '
    + 'attach to any client and receive that client\'s login OTPs');
});

test('⚠ the response never reveals whether the client exists', async () => {
  const hit = await call('/auth/signup', 'post', { clientId: '133', email: 'a@b.co' });
  clientRow = [];
  const miss = await call('/auth/signup', 'post', { clientId: '999999', email: 'a@b.co' });
  assert.deepEqual(miss.body, hit.body, 'otherwise the form enumerates client ids');
  assert.equal(miss.statusCode, hit.statusCode);
  // ...but ops are told, because they are the ones who must act on it.
  assert.match(sent[1].text, /No client matched/);
});

test('signup validates the email before mailing anyone', async () => {
  const r = await call('/auth/signup', 'post', { clientId: '133', email: 'not-an-email' });
  assert.equal(r.statusCode, 400);
  assert.equal(sent.length, 0);
});
