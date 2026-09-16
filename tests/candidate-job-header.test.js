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
  // Quantity row (2026-09-11): read by the panel, never projected until now.
  'product_quantity',
  'requested_date_time', 'time_slot', 'booking_cut_off_time_slot',
  // The ORIGINAL appointment (2026-09-16): what was promised at booking, shown
  // beside the appointment that may since have moved. Both columns already
  // reach GET /jobs/:id through j.*; the allowlist is what kept them out of
  // this payload, which is the failure mode this file exists for.
  'original_appointment_date_time', 'original_appointment_time',
  'job_desc', 'efr_special_notes',
  'created_by_name', 'created_date_time', 'assigned_efr_id',
  /*
   * Job Age (2026-09-16) — camelCase because these are the SQL aliases
   * utils/job-age-sql.js emits and the exact two keys the CRM's formatJobAge()
   * reads. Renaming them into this file's snake_case majority would render the
   * Age row as "—" with every value present, so the spelling is pinned here too.
   */
  'ageDays', 'ageSecs',
  // The two INHERITED managers (2026-09-16): the PM from the client's vertical
  // mapping, the ZM from the address city's owner — see getJobManagerNames.
  // Passed as options, so buildJobHeader alone renders them null, which is what
  // the null-not-undefined test below should see.
  'project_manager_name', 'zonal_manager_name',
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
  /*
   * The manager names are the one part of the header the BUILDER cannot supply
   * on its own — they are resolved per call site and passed in. So the same
   * drift the rest of this file guards has one more door: a call site that
   * forgets the resolver still returns a complete-looking header, with two
   * silently null rows. Both sites must resolve them.
   */
  const resolves = src.split('jobService.getJobManagerNames(').length - 1;
  assert.equal(resolves, 2, `both header paths must resolve the manager names, found ${resolves}`);
});

test('the age fields are COPIED from the row, never recomputed here', () => {
  // The list, the detail modal and this header must all read the one SQL
  // expression (utils/job-age-sql.js). A clock read or a date subtraction in
  // this builder is how the popup starts disagreeing with the row it opened
  // from — the whole reason those two aliases exist.
  const header = buildJobHeader({ job_id: 1, ageDays: 12, ageSecs: 1080000 });
  assert.equal(header.ageDays, 12);
  assert.equal(header.ageSecs, 1080000);
  const src = fs.readFileSync(path.join(__dirname, '..', 'services/candidate-ranking.service.js'), 'utf8');
  const builder = src.slice(src.indexOf('function buildJobHeader(job, {'), src.indexOf('async function rankCandidatesForJob'));
  assert.match(builder, /ageDays:\s+job\.ageDays\s*\?\?\s*null/, 'ageDays must come straight off the row');
  assert.match(builder, /ageSecs:\s+job\.ageSecs\s*\?\?\s*null/, 'ageSecs must come straight off the row');
  assert.doesNotMatch(builder, /new Date\(|Date\.now\(/, 'the header must not read a clock — the age is SQL\'s answer');
});

test('each manager name reads the source its own list filter compares against', () => {
  /*
   * The failure this prevents is not a crash — it is a panel that confidently
   * names a Project Manager the grid's `projectManagerId=<that user>` filter
   * would not return the job for. Both sides are checked here because both can
   * move; the resolver lives beside the filters in job.service.js precisely so
   * this stays one file to read.
   */
  const svc = fs.readFileSync(path.join(__dirname, '..', 'services/job.service.js'), 'utf8');
  const fn = svc.slice(svc.indexOf('async function getJobManagerNames'), svc.indexOf('async function stampJobPrimarySpoc'));
  assert.ok(fn.length > 0 && fn.length < 3000, 'getJobManagerNames must sit directly above stampJobPrimarySpoc');

  // ZONAL: tbl_city.state_user, both here and in the list's zonalManagerId clause.
  assert.match(fn, /zci\.state_user/, 'the zonal name must come off tbl_city.state_user');
  assert.match(svc, /ci\.state_user IN \(/, 'the list filter still keys on tbl_city.state_user');

  // PROJECT: the client's user_type = 1 mapping, picked by the ONE resolver.
  assert.match(svc, /vm\.user_type = 1 AND vm\.user_id IN \(/, 'the list PM filter still keys on user_type = 1');
  assert.match(fn, /resolveClientPrimarySpoc\(/, 'the PM pick must be the shared one');
  assert.doesNotMatch(
    fn, /tbl_vertical_mapping/,
    'a second ordering of the mapping rows is the two-copies-that-disagree bug — reuse resolveClientPrimarySpoc',
  );
});

test('the manager names arrive from the options, not from a tbl_job column', () => {
  // Neither is a column on tbl_job — reading job.project_manager_name would be
  // permanently null and look like a data problem rather than a wiring one.
  const header = buildJobHeader(
    { job_id: 1, project_manager_name: 'FROM THE ROW', zonal_manager_name: 'FROM THE ROW' },
    { projectManagerName: 'Asha Rao', zonalManagerName: 'Vikram Shah' },
  );
  assert.equal(header.project_manager_name, 'Asha Rao');
  assert.equal(header.zonal_manager_name, 'Vikram Shah');
});
