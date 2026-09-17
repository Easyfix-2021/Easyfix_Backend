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

/*
 * One function's SOURCE BODY, declaration to its closing brace at column 0.
 * The source-level assertions below are about what a specific function's SQL
 * says; slicing "from this declaration to the next one" would drag in the next
 * function's docblock and make an assertion pass (or fail) on prose written
 * about a different function.
 */
function bodyOf(src, declaration) {
  const start = src.indexOf(declaration);
  assert.notEqual(start, -1, `${declaration} not found — was it renamed?`);
  const end = src.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `${declaration} has no closing brace at column 0`);
  return src.slice(start, end + 3);
}

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
  /*
   * The EFFECTIVE payment answer (2026-09-16), beside — never instead of — the
   * three paid_by-only fields above. See buildJobHeader for why those three
   * read "Not Set" on a job this same request treats as customer-paid.
   */
  'payment_label',
  /*
   * The TIMELINE (2026-09-16), in the order the events happen. The three dates
   * are tbl_job columns already in getByIdCore's j.*; the three names are not
   * (two user ids to resolve, and an acceptance that lives on tbl_job_offer),
   * so they arrive as options and render null from the builder alone.
   */
  'ticket_created_date_time', 'original_scheduling_date_time', 'first_scheduled_by_name',
  'accepted_date_time', 'accepted_efr_name',
  'checkin_date_time', 'checkin_by_name',
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
   * The RESOLVED fields are the part of the header the BUILDER cannot supply on
   * its own — each is looked up per call site and passed in. So the drift the
   * rest of this file guards has one more door per resolver: a call site that
   * forgets one still returns a complete-looking header, with silently null
   * rows. Both sites must call both resolvers.
   */
  for (const resolver of ['getJobManagerNames', 'getJobTimelineActors', 'getJobConsoleExtras']) {
    const resolves = src.split(`jobService.${resolver}(`).length - 1;
    assert.equal(resolves, 2, `both header paths must call ${resolver}, found ${resolves}`);
  }
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
  const fn = bodyOf(svc, 'async function getJobManagerNames');

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

test('both zonal/project arms reach tbl_user through a LEFT JOIN', () => {
  // Every other reader of these two columns in the repo LEFT JOINs
  // (job-export's stateUser, pincode.service's zm, lookup.service). As a
  // one-column scalar subquery an inner join returns the same NULL — which is
  // exactly why this has to be pinned rather than trusted to stay right: the
  // day the subquery selects a second column, the inner form drops the ROW.
  const svc = fs.readFileSync(path.join(__dirname, '..', 'services/job.service.js'), 'utf8');
  const fn = bodyOf(svc, 'async function getJobManagerNames');
  assert.match(fn, /LEFT JOIN tbl_user zmu ON zmu\.user_id = zci\.state_user/);
  assert.doesNotMatch(fn, /[^T] JOIN tbl_user/, 'no inner join to tbl_user may come back');
});

/* ── Payment: the effective answer, alongside the paid_by-only one ───────── */

test('payment_label follows customerPays(), which payment_mode alone cannot', () => {
  const label = (job) => buildJobHeader({ job_id: 1, ...job }).payment_label;
  // paid_by = 2 is the obvious arm…
  assert.equal(label({ paid_by: 2 }), 'Paid By Customer');
  // …and collected_by = 1 is the one the paid_by-only fields miss. On QA only
  // 3,449 of 82,371 collected_by = 1 jobs also carry paid_by = 2, so this is
  // the COMMON shape, and it is the one that used to read "Not Set" beside a
  // candidate list the same request had already narrowed on cash balance.
  assert.equal(label({ collected_by: 1 }), 'Paid By Customer');
  assert.equal(label({ paid_by: null, collected_by: '1' }), 'Paid By Customer', 'a string 1 is still 1');
  // Neither signal ⇒ fall back to the plain paid_by reading, verbatim.
  assert.equal(label({ paid_by: 1, collected_by: 3 }), 'Client');
  assert.equal(label({ paid_by: 3 }), 'Easyfix');
  assert.equal(label({}), 'Not Set');
});

test('payment_label is ADDITIVE — the three paid_by fields keep their values', () => {
  // The CRM decides which to render; nothing already reading the old three may
  // shift underneath it. This is the collected_by-only job, where they differ.
  const header = buildJobHeader({ job_id: 1, collected_by: 1 });
  assert.equal(header.payment_label, 'Paid By Customer');
  assert.equal(header.payment_mode, 'Not Set', 'payment_mode still reads paid_by alone');
  assert.equal(header.paid_by_label, 'Not Set');
  assert.equal(header.paid_by, null);
  assert.equal(header.collected_by, 1);
});

/* ── Timeline ────────────────────────────────────────────────────────────── */

const TIMELINE_DATES = ['ticket_created_date_time', 'original_scheduling_date_time', 'checkin_date_time'];

test('the timeline DATES are tbl_job columns, copied straight off the row', () => {
  const row = { job_id: 1 };
  for (const k of TIMELINE_DATES) row[k] = `VALUE:${k}`;
  const header = buildJobHeader(row);
  for (const k of TIMELINE_DATES) assert.equal(header[k], `VALUE:${k}`, `${k} must come off the row`);
});

test('the timeline NAMES arrive from the resolver, never from the row', () => {
  /*
   * None of these three is a tbl_job column: two are user ids that have to be
   * resolved, and acceptance lives on tbl_job_offer entirely. Reading them off
   * the row would be permanently null and look like missing DATA rather than
   * missing WIRING — the distinction this whole file exists to keep visible.
   */
  const header = buildJobHeader(
    {
      job_id: 1,
      first_scheduled_by_name: 'FROM THE ROW',
      checkin_by_name: 'FROM THE ROW',
      accepted_efr_name: 'FROM THE ROW',
      accepted_date_time: 'FROM THE ROW',
    },
    {
      firstScheduledByName: 'Meera Nair',
      checkinByName: 'Rohit Sen',
      acceptedDateTime: '2026-09-16 10:15:00',
      acceptedEfrName: 'Imran Qureshi',
    },
  );
  assert.equal(header.first_scheduled_by_name, 'Meera Nair');
  assert.equal(header.checkin_by_name, 'Rohit Sen');
  assert.equal(header.accepted_date_time, '2026-09-16 10:15:00');
  assert.equal(header.accepted_efr_name, 'Imran Qureshi');
});

test('an unaccepted job — every job this console opens — reports null acceptance', () => {
  // Accepting sets fk_easyfixter_id, which evicts the job from the unassigned
  // bucket the console works, so null here is the NORMAL answer, not a failure.
  const header = buildJobHeader({ job_id: 1 });
  assert.equal(header.accepted_date_time, null);
  assert.equal(header.accepted_efr_name, null);
});

test('the acceptance is read off the ACCEPTED offer row, and listOffers still excludes it', () => {
  const svc = fs.readFileSync(path.join(__dirname, '..', 'services/job.service.js'), 'utf8');
  const fn = bodyOf(svc, 'async function getJobTimelineActors');
  assert.match(fn, /responded_at FROM tbl_job_offer/, 'accepted_date_time is the offer row\'s responded_at');
  assert.match(fn, /LEFT JOIN tbl_easyfixer aef ON aef\.efr_id = ao2\.fk_easyfixter_id/, 'the name comes off the offeree');
  assert.match(fn, /ORDER BY ao\.job_offer_id DESC LIMIT 1/, 'never a bare LIMIT 1 over a set that may not be unique');
  /*
   * The Schedule & Assign modal's own offer list must stay as it is: its job is
   * showing who has NOT taken the job, so an accepted offeree appearing there
   * would be a regression, not a feature. Reading the accepted row HERE is the
   * whole reason that list did not have to change.
   */
  const listOffers = svc.slice(svc.indexOf('async function listOffers'));
  const statuses = /offer_status IN \(([^)]*)\)/.exec(listOffers);
  assert.ok(statuses, 'listOffers must still pin the statuses it surfaces');
  assert.doesNotMatch(statuses[1], /ACCEPTED/, 'listOffers must keep excluding accepted offers');
});

/* ── Services: the one-unit price and the line total, named apart ───────── */

/*
 * tbl_job_services.total_charge is the price of ONE unit despite its name;
 * total_cost is unit × quantity. The card rendered total_charge as the line's
 * charge, so a qty-2 ₹1,000 line (job 482657 on QA) read ₹1,000 here and
 * ₹2,000 in Edit Services for the same row.
 */
// Both real callers always hand buildJobHeader a skill map; mirror that.
const NO_SKILLS = { jobSkillsByService: new Map() };

const FUR_LINE = {
  job_service_id: 652574, job_service_status: 1, service_name: 'FUR - Large / Installation',
  service_catg_name: 'Carpentry Services', service_type_name: 'Modular Packed Furniture',
  quantity: 2, total_charge: 1000, total_cost: 2000,
};

test('each service carries unit_price (one unit) and line_total (unit × quantity)', () => {
  const [svc] = buildJobHeader({ job_id: 482657, services: [FUR_LINE] }, NO_SKILLS).services;
  assert.equal(svc.unit_price, 1000, 'unit_price is total_charge — the price of one unit');
  assert.equal(svc.line_total, 2000, 'line_total is total_cost — what the line bills');
});

test('total_charge is kept exactly as it was', () => {
  // Additive: every consumer already reading total_charge keeps its value.
  const [svc] = buildJobHeader({ job_id: 482657, services: [FUR_LINE] }, NO_SKILLS).services;
  assert.equal(svc.total_charge, 1000);
  assert.equal(svc.quantity, 2);
});

test('line_total is the STORED column, never unit_price × quantity recomputed', () => {
  // total_charge is an integer column (Math.round of the unit price) while
  // total_cost keeps four decimals, so the product drifts from what billing
  // reads on any non-integer rate. A ₹137.5 unit × 3 stores total_charge 138
  // and total_cost 412.5 — 138 × 3 = 414 would be wrong by ₹1.50.
  const [svc] = buildJobHeader({
    job_id: 1,
    services: [{ ...FUR_LINE, quantity: 3, total_charge: 138, total_cost: 412.5 }],
  }, NO_SKILLS).services;
  assert.equal(svc.line_total, 412.5);
  assert.notEqual(svc.line_total, svc.unit_price * svc.quantity);
});

test('an absent price is null on both, never undefined or a computed zero', () => {
  const [svc] = buildJobHeader({
    job_id: 1, services: [{ job_service_id: 9, job_service_status: 1, quantity: 1 }],
  }, NO_SKILLS).services;
  assert.equal(svc.unit_price, null);
  assert.equal(svc.line_total, null);
  assert.ok('unit_price' in svc && 'line_total' in svc, 'both keys ship even when empty');
});

test('the detail query SELECTs total_cost, or line_total could never be filled', () => {
  // mapJobServices is an allowlist over getById's services rows; a column the
  // query does not select arrives as undefined and renders as a blank cell.
  const svc = fs.readFileSync(path.join(__dirname, '..', 'services/job.service.js'), 'utf8');
  const getById = bodyOf(svc, 'async function getById(jobId)');
  assert.match(getById, /js\.total_charge,\s*js\.total_cost/, 'getById must project js.total_cost');
});

// ─── The assigned technician's track record (2026-09-17) ─────────────────

test('the header ships the technician track record, null without a resolver', () => {
  const bare = buildJobHeader({ job_id: 1 });
  for (const k of ['efr_completed_7d', 'efr_open_jobs', 'efr_avg_rating']) {
    assert.ok(k in bare, `${k} must always be a key on the header`);
    assert.equal(bare[k], null, `${k} is null when the resolver did not supply it`);
  }
  const full = buildJobHeader({ job_id: 1 }, {
    consoleExtras: { efrCompleted7d: 11, efrOpenJobs: 3, efrAvgRating: 4.25 },
  });
  assert.deepEqual([full.efr_completed_7d, full.efr_open_jobs, full.efr_avg_rating], [11, 3, 4.25]);
});

test('the track-record SQL is the agreed definition — and the rating matches Manage Easyfixers', () => {
  /*
   * Ops' definitions: completed = status 3/5 with a check-out in the last 7
   * days (rolling); open = status 1, 2, 20; rating = AVG over ratings WITH a
   * comment, ROUND(…, 2) — exactly Manage Easyfixers' Avg Rating, which the
   * CRM also shows with toFixed(1). A drifted rounding reads 4.2 here and 4.3
   * there for the same technician.
   */
  const svc = fs.readFileSync(path.join(__dirname, '..', 'services/job.service.js'), 'utf8');
  const fn = bodyOf(svc, 'async function getJobConsoleExtras');
  assert.match(fn, /tj\.job_status IN \(3, 5\)\s+AND tj\.checkout_date_time >= \?\)/);
  assert.match(fn, /new Date\(Date\.now\(\) - 7 \* 24 \* 60 \* 60 \* 1000\)/, 'the 7-day cut-off is a bound JS Date, never SQL NOW()');
  assert.match(fn, /oj\.job_status IN \(1, 2, 20\)/);
  assert.match(fn, /ROUND\(AVG\(rr\.customer_rating\), 2\)[\s\S]*?rr\.comment IS NOT NULL/);
  const efr = fs.readFileSync(path.join(__dirname, '..', 'services/easyfixer.service.js'), 'utf8');
  assert.match(efr, /ROUND\(rt\.rating, 2\)/, 'control: Manage Easyfixers rounds its average to 2 places');
  assert.match(efr, /AVG\(customer_rating\) AS rating[\s\S]*?comment IS NOT NULL/, 'control: and counts only commented ratings');
});

test('both header paths pass the assigned technician to the extras resolver', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services/candidate-ranking.service.js'), 'utf8');
  assert.equal(src.split('efrId: job.fk_easyfixter_id,').length - 1, 2,
    'the ranked and search/console headers must both resolve the track record');
});
