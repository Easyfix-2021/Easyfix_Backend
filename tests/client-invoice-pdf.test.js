/*
 * GET /api/client/invoices/:id/pdf — the portal's invoice PDF, rendered by the
 * same service as the admin CRM (services/invoice-artifact.service.js).
 *
 * The portal used to link `/easydoc/<file_path_pdf>` on its own host — wrong
 * host, wrong directory, and files the legacy generator stopped writing in
 * Feb 2018. Scope is the one thing this route adds, so it is what is pinned:
 * another client's invoice (or an unraised draft) must not even be LOADED.
 */
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const S = { owned: true };
const fake = installFakePool([
  [/FROM tbl_client_invoice WHERE id = \? AND fk_client_id = \? AND is_raised = 1/i, () => (S.owned ? [{ id: 77 }] : [])],
]);
const artifact = require('../services/invoice-artifact.service');
const real = { load: artifact.loadInvoiceArtifactData, send: artifact.sendInvoicePdf };
const loaded = [];
artifact.loadInvoiceArtifactData = async (id) => { loaded.push(id); return { inv: { id, invoice_number: 'INV-77' }, client: {}, lines: [] }; };
after(() => { artifact.loadInvoiceArtifactData = real.load; artifact.sendInvoicePdf = real.send; fake.restore(); });

const router = require('../routes/client/index');
const layer = router.stack.find((e) => e.route && e.route.path === '/invoices/:id/pdf' && e.route.methods.get);
const handle = layer && layer.route.stack[layer.route.stack.length - 1].handle;

function res() {
  return {
    headers: {}, code: 200, body: null, sent: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
async function call(id) {
  const r = res();
  await handle({ spoc: { id: 42, client_id: 133 }, params: { id: String(id) }, query: {} }, r, (e) => { throw e; });
  return r;
}

beforeEach(() => { S.owned = true; loaded.length = 0; fake.reset(); });

test('the route is mounted', () => { assert.ok(handle, 'GET /invoices/:id/pdf must exist'); });

test("the client's own raised invoice renders through the shared service", async () => {
  let sent = null;
  artifact.sendInvoicePdf = (r, data) => { sent = data; r.setHeader('Content-Type', 'application/pdf'); };
  const r = await call(77);
  assert.deepEqual(loaded, [77]);
  assert.equal(sent.inv.invoice_number, 'INV-77');
  assert.equal(r.headers['content-type'], 'application/pdf');
  const scopeQuery = fake.calls.find((c) => /tbl_client_invoice/.test(c.sql));
  assert.deepEqual(scopeQuery.params, [77, 133], 'scoped to the SPOC\'s client from the token, never the request');
});

test("another client's invoice (or a draft) is a 404 and is never loaded", async () => {
  S.owned = false;
  const r = await call(77);
  assert.equal(r.code, 404);
  assert.deepEqual(loaded, [], 'must not build another client\'s artifact at all');
});

test('a non-numeric id is a 400', async () => {
  const r = await call('abc');
  assert.equal(r.code, 400);
});

test('the download filename is trimmed and header-safe (legacy rows carry " ")', async () => {
  const { PassThrough } = require('node:stream');
  const disposition = async (inv) => {
    const sink = new PassThrough();
    const h = {};
    sink.setHeader = (k, v) => { h[k] = v; };
    const chunks = [];
    sink.on('data', (c) => chunks.push(c));
    const done = new Promise((r) => sink.on('end', r));
    real.send(sink, { inv, client: {}, lines: [] });   // the REAL renderer, into a real stream
    await done;
    assert.equal(Buffer.concat(chunks).subarray(0, 5).toString(), '%PDF-', 'positive control: it actually rendered');
    return h['Content-Disposition'];
  };
  assert.equal(await disposition({ id: 1371, invoice_number: ' ' }), 'attachment; filename="invoice-1371.pdf"');
  assert.equal(await disposition({ id: 9, invoice_number: 'EF/2017 "01"' }), 'attachment; filename="invoice-EF_2017_01_.pdf"');
});
