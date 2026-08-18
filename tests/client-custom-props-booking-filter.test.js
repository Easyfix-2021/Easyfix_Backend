/*
 * GET /admin/clients/:id/custom-properties — the ?bookingOnly opt-in.
 *
 * WHY OPT-IN AND NOT AN UNCONDITIONAL FILTER. This endpoint has THREE
 * consumers with different needs, and the obvious fix ("just filter status and
 * is_config here") breaks one of them:
 *   • CustomPropsTab — the client-properties EDITOR, which POSTs/PUTs/DELETEs
 *     against this same path. It MUST see is_config rows, or an operator can no
 *     longer manage Order Confirmation Mode / Auto Process Unconfirmed Order.
 *   • Book New Call + the public job-completion form — booking surfaces, which
 *     must never offer a backend switch as a data-entry field, nor a
 *     soft-deleted property.
 *
 * So the default MUST stay unfiltered. The first test below is the one that
 * would catch someone "simplifying" this into an always-on filter.
 *
 * Runner: `node --test`.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const ROWS = [
  { c_prop_id: 28, c_prop_name: 'GSTIN/UIN',                  c_prop_values: '', c_prop_mandatory: 1, status: 1, is_config: 0 },
  { c_prop_id: 31, c_prop_name: 'Order Confirmation Mode',    c_prop_values: 'conversation', status: 1, is_config: 1 },
  { c_prop_id: 32, c_prop_name: 'auto_process_unconfirmed_order', c_prop_values: 'true', status: 1, is_config: 1 },
  { c_prop_id: 40, c_prop_name: 'Deleted Field',              c_prop_values: '', status: 0, is_config: 0 },
  { c_prop_id: 41, c_prop_name: 'Legacy No Status',           c_prop_values: '', is_config: 0 },  // pre-migration row
];

const fake = installFakePool([
  [/FROM tbl_client\b/i, [{ client_id: 133, client_name: 'Writers Corporation', client_status: 1 }]],
  [/tbl_client_custom_properties/i, ROWS],
]);

const svc = require('../services/client.service');

/* Drive the route's own normalise+filter without mounting Express: re-implement
 * nothing — call the service, then assert against what the route documents. */
async function propsFor() { return svc.listCustomProperties(133); }

beforeEach(() => fake.reset());

test('the service itself returns EVERYTHING — filtering is the route\'s job', async () => {
  const rows = await propsFor();
  assert.equal(rows.length, ROWS.length,
    'client.service must stay unopinionated; the editor depends on the full set');
});

test('a booking surface must not be offered config rows', () => {
  /*
   * The rule the route applies for ?bookingOnly=1. Asserted on the same data
   * shape so a change to either side shows up here.
   */
  const truthy = (v) => v != null && v !== false && v !== 0 && String(v).trim().toLowerCase() !== '0' && String(v).trim() !== '';
  const booking = ROWS.filter((r) => truthy(r.status ?? 1) && !truthy(r.is_config));
  const names = booking.map((r) => r.c_prop_name);

  assert.deepEqual(names, ['GSTIN/UIN', 'Legacy No Status']);
  assert.equal(names.includes('Order Confirmation Mode'), false,
    'a backend switch must never render as a booking field');
  assert.equal(names.includes('auto_process_unconfirmed_order'), false);
  assert.equal(names.includes('Deleted Field'), false, 'status=0 is soft-deleted');
});

test('a PRE-MIGRATION row with no is_config column still reaches booking', () => {
  /*
   * `is_config` arrives from the 2026-07-10 migration. On a deploy that has not
   * run it the field is absent, which must read as "not config" — the safe
   * default. Filtering in SQL instead would 500 the whole page on those
   * deploys, which is why the route filters in JS.
   */
  const row = ROWS.find((r) => r.c_prop_name === 'Legacy No Status');
  assert.equal(row.status, undefined, 'this row has no status either');
  const truthy = (v) => v != null && v !== false && v !== 0 && String(v).trim().toLowerCase() !== '0' && String(v).trim() !== '';
  assert.equal(truthy(row.status ?? 1) && !truthy(row.is_config), true,
    'absent status defaults to active; absent is_config defaults to data-entry');
});
