/*
 * /api/client/company — tenant isolation and the write gate.
 *
 * These routes are the first place the client portal WRITES to tbl_client, so
 * two properties matter more than anything else about them:
 *
 *   1. A SPOC CANNOT REACH ANOTHER TENANT'S ROW. Every handler takes the
 *      client id from req.spoc, never from the request — except the document
 *      DELETE, which necessarily takes a document id from the URL. That one
 *      re-checks ownership itself, because clientDocsSvc.softDelete() applies
 *      NO client filter: it is safe in the CRM only because that route runs
 *      guardRowByClientId() first. Without the same check here, counting
 *      upwards through document ids would delete other clients' files. The
 *      first test is the one that would catch that being removed.
 *
 *   2. A STORE SPOC CANNOT REWRITE THE COMPANY. Company writes are gated on
 *      access.allStores — the existing "speaks for the whole client" signal —
 *      so a single-site contact cannot change the registered address or the
 *      invoice name for everyone.
 *
 * The handlers are invoked directly off the router stack (same approach as
 * easyfixer-lifecycle-route-auth.test.js) so no HTTP server or supertest
 * dependency is needed.
 *
 * Runner: `node --test`.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const OUR_CLIENT = 133;
const OTHER_CLIENT = 987;
const OUR_DOC = 5001;
const THEIR_DOC = 5002;

const COMPANY_ROW = {
  client_id: OUR_CLIENT,
  client_name: 'Brightline Retail',
  billing_name: 'Brightline Retail Private Limited',
  client_email: 'accounts@brightline.example',
  client_address: '14 MG Road, Connaught Place',
  client_city_id: 12,
  city_name: 'New Delhi',
  client_status: 1,
  booking_cut_off: 4,
  collected_by: 2,
  billing_raised: 1,
  billing_cycle: '1,40',
};

const fake = installFakePool([
  // The company read. Matched on the `cl` alias so it cannot also catch the
  // tbl_client_document query below.
  [/FROM tbl_client cl/i, [COMPANY_ROW]],
  // Ownership lookup behind clientService.getDocumentClientId().
  [/FROM tbl_client_document WHERE document_id/i, (sql, params) => (
    Number(params[0]) === OUR_DOC ? [{ client_id: OUR_CLIENT }]
      : Number(params[0]) === THEIR_DOC ? [{ client_id: OTHER_CLIENT }]
        : []
  )],
  // The soft delete itself. Reaching this at all is the failure mode test 1 guards.
  [/UPDATE tbl_client_document/i, { affectedRows: 1 }],
  [/INFORMATION_SCHEMA\.TABLES/i, [{ 1: 1 }]],
  [/INFORMATION_SCHEMA\.COLUMNS/i, [
    { COLUMN_NAME: 'client_id' }, { COLUMN_NAME: 'client_email' },
    { COLUMN_NAME: 'client_address' }, { COLUMN_NAME: 'billing_name' },
    { COLUMN_NAME: 'building' }, { COLUMN_NAME: 'landmark' },
    { COLUMN_NAME: 'client_pincode' }, { COLUMN_NAME: 'collected_by' },
    { COLUMN_NAME: 'booking_cut_off' }, { COLUMN_NAME: 'update_date' },
  ]],
  [/^UPDATE tbl_client SET/i, { affectedRows: 1 }],
]);

const router = require('../routes/client/index');

/** The final handler for a route, i.e. past any validate() middleware. */
function handlerFor(path, method) {
  const layer = router.stack.find((e) => e.route && e.route.path === path && e.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function res() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const req = ({ allStores = true, body = {}, params = {} } = {}) => ({
  spoc: { id: 42, client_id: OUR_CLIENT },
  access: { allStores, grants: ['home'], role: 'senior' },
  clientUser: { userId: 900 },
  body,
  params,
});

beforeEach(() => fake.reset());

test("deleting ANOTHER tenant's document is refused, and never reaches the delete", async () => {
  const r = res();
  await handlerFor('/company/documents/:id', 'delete')(
    req({ params: { id: String(THEIR_DOC) } }), r, (e) => { throw e; },
  );

  assert.equal(r.statusCode, 404,
    'must 404 — and 404, not 403, so the endpoint cannot be used to probe which ids exist');
  const deleted = fake.calls.some((c) => /UPDATE tbl_client_document/i.test(c.sql));
  assert.equal(deleted, false,
    'the soft delete must not run: softDelete() applies no client filter of its own');
});

test('deleting your own document works', async () => {
  const r = res();
  await handlerFor('/company/documents/:id', 'delete')(
    req({ params: { id: String(OUR_DOC) } }), r, (e) => { throw e; },
  );
  assert.equal(r.body?.data?.deleted, true);
  assert.ok(fake.calls.some((c) => /UPDATE tbl_client_document/i.test(c.sql)));
});

test('a non-numeric document id is refused before any lookup', async () => {
  const r = res();
  await handlerFor('/company/documents/:id', 'delete')(
    req({ params: { id: 'abc' } }), r, (e) => { throw e; },
  );
  assert.equal(r.statusCode, 404);
  assert.equal(fake.calls.length, 0, 'no query should be issued for a malformed id');
});

test('a SPOC without allStores cannot write the company profile', async () => {
  const r = res();
  await handlerFor('/company', 'put')(
    req({ allStores: false, body: { clientAddress: '1 New Road' } }), r, (e) => { throw e; },
  );
  assert.equal(r.statusCode, 403);
  assert.equal(fake.calls.some((c) => /^UPDATE tbl_client SET/i.test(c.sql)), false);
});

test('only allowlisted fields reach the writer — commercial config cannot ride along', async () => {
  const r = res();
  await handlerFor('/company', 'put')(
    req({
      body: {
        clientAddress: '1 New Road',
        // None of these are in COMPANY_WRITABLE. Joi rejects them at the edge;
        // this asserts the handler's own loop drops them too, so the guarantee
        // does not rest on one layer.
        collectedBy: 3,
        bookingCutOff: 0,
        clientName: 'Not Your Name',
      },
    }), r, (e) => { throw e; },
  );

  const update = fake.calls.find((c) => /^UPDATE tbl_client SET/i.test(c.sql));
  assert.ok(update, 'the allowlisted field must still be written');
  assert.match(update.sql, /client_address = \?/);
  assert.doesNotMatch(update.sql, /collected_by/, 'collected_by is EasyFix commercial config');
  assert.doesNotMatch(update.sql, /booking_cut_off/, 'booking_cut_off is dispatch config');
  assert.doesNotMatch(update.sql, /client_name/, 'the master name is not the tenant\'s to change');
});

test('a body with no allowlisted field is a 400, not a silent no-op', async () => {
  const r = res();
  await handlerFor('/company', 'put')(
    req({ body: { collectedBy: 3 } }), r, (e) => { throw e; },
  );
  assert.equal(r.statusCode, 400);
});

test('GET /company reports canEdit from the SAME gate the PUT applies', async () => {
  // A drift between these two is how a portal ends up showing an input that
  // 403s on save, so they are asserted together rather than separately.
  fake.reset();
  const senior = res();
  await handlerFor('/company', 'get')(req({ allStores: true }), senior, (e) => { throw e; });
  const store = res();
  await handlerFor('/company', 'get')(req({ allStores: false }), store, (e) => { throw e; });

  assert.equal(senior.body?.data?.canEdit, true);
  assert.ok(senior.body.data.editable.includes('clientAddress'));
  assert.equal(store.body?.data?.canEdit, false);
  assert.deepEqual(store.body.data.editable, [],
    'a SPOC who cannot write must be told which fields are editable: none');
});
