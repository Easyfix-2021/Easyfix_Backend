/*
 * The Schedule & Assign job header must be built in ONE place.
 *
 * /candidates (ranked top-10) and /candidates/search both return a `job`
 * object that feeds the same <JobContextPanel>. They were two hand-written
 * object literals and had already drifted: the search copy was missing Client
 * SPOC, Booked By, Booked On, Collected By, Additional Comments and
 * assigned_efr_id.
 *
 * Nothing throws when a field goes missing — the object is an ALLOWLIST over
 * the getById payload, so an omitted field reaches the modal as `undefined`
 * and renders as an empty row. That is how Booked By / Booked On / Client SPOC
 * went blank once already. The only signal is an operator noticing a value
 * that used to be there, which is why this is pinned in a test.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { _internals } = require('../services/candidate-ranking.service');
const { buildJobHeader } = _internals;

// Every field the Schedule & Assign panel reads off the header. Ordered as the
// panel shows them so a missing one is easy to place.
const REQUIRED = [
  'job_id', 'fk_client_id',
  'customer_name', 'customer_mob_no',
  'client_name', 'client_ref_id', 'client_spoc', 'client_spoc_name',
  'address', 'building', 'landmark', 'gps_location', 'address_instruction',
  'city_id', 'city_name', 'pin_code',
  'service_category', 'service_type', 'deep_skill_label', 'services',
  'job_type', 'payment_mode', 'paid_by', 'paid_by_label', 'collected_by',
  'requested_date_time', 'time_slot', 'booking_cut_off_time_slot',
  'job_desc', 'efr_special_notes',
  'created_by_name', 'created_date_time', 'assigned_efr_id',
];

test('the header carries every field the panel renders', () => {
  const header = buildJobHeader({ job_id: 1, fk_client_id: 2 });
  const missing = REQUIRED.filter((k) => !(k in header));
  assert.deepEqual(
    missing, [],
    `header field(s) ${missing.join(', ')} would reach the modal as undefined and render blank`,
  );
});

test('an absent column becomes null, never undefined', () => {
  // undefined is what JSON.stringify DROPS — the field would vanish from the
  // response entirely rather than arriving as an explicit empty.
  const header = buildJobHeader({ job_id: 1 });
  // job_id excluded: it is the identity, always present on a real row, and a
  // null there should surface loudly rather than be normalised away.
  const undef = REQUIRED.filter((k) => k !== 'job_id' && header[k] === undefined);
  assert.deepEqual(undef, [], `${undef.join(', ')} serialise away instead of arriving as null`);
});

test('both endpoints build the header through the one builder', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services/candidate-ranking.service.js'), 'utf8');
  // Count CALLS only — `function buildJobHeader(job, {` is the definition and
  // matches the same substring.
  const calls = src.split('buildJobHeader(job, {').length - 1
    - (src.split('function buildJobHeader(job, {').length - 1);
  assert.equal(calls, 2, `expected the ranked and search headers to both call buildJobHeader, found ${calls}`);
  // A second hand-written literal of the same shape is the drift coming back.
  const literals = src.split('job_id:            job.job_id').length - 1;
  assert.equal(literals, 1, 'a second hand-written job-header literal is back — call buildJobHeader instead');
});
