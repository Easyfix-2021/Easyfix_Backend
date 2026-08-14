/*
 * A job may be placed on fulfillment hold ONCE, ever.
 *
 * Legacy enforced this at EasyFix_CRM JobDaoImpl.java:6106 —
 * `if (j.getNoOffullfillments() == 0)` — and notably did NOT gate on status:
 * a hold can be placed from any state. The counter IS the state machine.
 *
 * That guard is what makes the release safe. `fullfillmentHoldCheckout` sets
 * job_status = 10 unconditionally, so hold/release is only correct as a single
 * 10 → 21 → 10 round trip. Allow a second hold and a job that had moved on
 * gets dragged back to 21, then released to 10 — a status it had already left.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '../routes/admin/jobs.js'), 'utf8');

/**
 * Strip comments before asserting on code. These handlers are heavily
 * commented — including comments that NAME setStatus to explain why it is
 * deliberately not used — so a bare regex would match the explanation rather
 * than a call and fail on correct code.
 */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** The `PUT /:id/hold` handler body, up to the next route registration. */
function holdHandler() {
  const start = SRC.indexOf("router.put('/:id/hold'");
  assert.notEqual(start, -1, 'hold route not found');
  const end = SRC.indexOf('router.', SRC.indexOf('});', start));
  return codeOnly(SRC.slice(start, end === -1 ? SRC.length : end));
}

test('placing a hold reads the existing hold count first', () => {
  const body = holdHandler();
  assert.match(body, /no_of_req_foh[\s\S]{0,60}AS holds/, 'reads the counter before writing');
  const read = body.indexOf('AS holds');
  const write = body.indexOf('SET job_status = 21');
  assert.ok(read !== -1 && read < write, 'the count is checked before the status is changed');
});

test('a second hold is refused with 409, not silently applied', () => {
  const body = holdHandler();
  assert.match(body, /Number\(current\.holds\) > 0/, 'guards on a prior hold');
  assert.match(body, /modernError\(res, 409/, 'refuses rather than pretending to succeed');
  const guard = body.indexOf('modernError(res, 409');
  const write = body.indexOf('SET job_status = 21');
  assert.ok(guard < write, 'the refusal returns before any write');
});

test('the UPDATE itself re-checks the counter, closing the race', () => {
  // Two concurrent hold requests both pass the SELECT. Only the WHERE clause
  // stops the second from double-incrementing and re-stamping the reason.
  const body = holdHandler();
  assert.match(
    body, /WHERE job_id = \? AND COALESCE\(no_of_req_foh, 0\) = 0/,
    'the write is conditional on the counter, not just the earlier read',
  );
});

test('the hold is NOT gated on job status — matching legacy', () => {
  // Legacy placed holds from any state; only the counter limits it. A status
  // filter here would silently refuse holds the CRM has always allowed.
  const body = holdHandler();
  assert.ok(!/job_status\s*(=|IN)\s*\d/.test(body.replace(/SET job_status = 21/, '')),
    'no status precondition on the hold');
});

test('release restores status 10 unconditionally, as legacy did', () => {
  const start = SRC.indexOf("router.post('/:id/hold/release'");
  assert.notEqual(start, -1, 'release route not found');
  // Bound to THIS handler — a fixed-width slice spills into the next route,
  // which does use setStatus, and the assertion below would read it as ours.
  const next = SRC.indexOf('router.', SRC.indexOf('});', start));
  const body = codeOnly(SRC.slice(start, next === -1 ? SRC.length : next));
  assert.match(body, /SET job_status = 10 WHERE job_id = \?/);
  // Deliberately not via setStatus: 10 maps to TechVisitInComplete, which the
  // client already received before the hold.
  assert.ok(!/setStatus\(/.test(body), 'must not route through setStatus and re-fire the webhook');
});
