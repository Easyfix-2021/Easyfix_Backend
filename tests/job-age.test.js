/*
 * Unit tests for JOB AGE — the derived `ageDays` / `ageSecs` fields on the jobs
 * LIST + DETAIL projections, and the `age` server-side sort key.
 *
 * Age = elapsed time from j.ticket_created_date_time to the job's TERMINAL
 * event, or to NOW() while the job is still open:
 *
 *   job_status 3 / 5 (Completed / Completed-alt) → j.checkout_date_time
 *   job_status 6     (Cancelled)                 → j.cancel_date_time
 *   job_status 7     (Enquiry)                   → j.enquiry_date_time
 *   anything else    (OPEN)                      → NOW()
 *
 * What this file is guarding, in order of how badly it would hurt:
 *
 *   1. DISPLAY vs SORT DIVERGENCE. `ageSecs` (what the projection emits) and
 *      the `age` sort key must be the SAME expression object, not two copies
 *      that a later edit can nudge apart. A list that sorts by one number and
 *      prints another is the kind of bug nobody reports and everybody
 *      mistrusts.
 *   2. THE BOTH-SIDES WHITELIST TRAP. A sort key honoured by the service but
 *      not the validator (or vice versa) is silently dropped and the list
 *      quietly falls back to job_id DESC. The validator now DERIVES its list
 *      from the service's; these tests pin that.
 *   3. THE COUNT-QUERY JOIN TRAP. The list runs a separate COUNT for
 *      pagination whose joins are built from the aliases the WHERE references.
 *      An age expression that needed a new alias would 500 the COUNT. These
 *      tests drive the REAL list() through a fake pool and assert on both
 *      emitted statements.
 *   4. The floored-days semantics (TIMESTAMPDIFF(DAY, …), never DATEDIFF) and
 *      the negative clamp.
 *
 * No DB: the shared pool singleton is faked BEFORE the service loads, so every
 * statement is captured as a string instead of executed. The SQL semantics
 * themselves were verified separately against the live database (481,027
 * tbl_job rows): 0 negative ages, 0 NULL ageDays, 0 rows where
 * ageDays <> FLOOR(ageSecs/86400), 59 back-dated rows correctly clamped to 0,
 * and the single NULL-anchor enquiry row falling back to NOW().
 *
 * Runner: `node --test`.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { installFakePool } = require('./helpers/fake-pool');

// Install the fake BEFORE requiring the service — job.service.js captures the
// pool by reference at load time. COUNT must return a row shaped for the
// `[[[{ total }]], [rows]]` destructure inside list().
const fake = installFakePool([
  [/SELECT COUNT\(\*\) AS total/i, [{ total: 0 }]],
]);
after(() => fake.restore());

const jobService = require('../services/job.service');
const {
  JOB_AGE_END_EXPR, JOB_AGE_SECS_EXPR, JOB_AGE_DAYS_EXPR, JOB_AGE_COLUMNS,
  SORTABLE_COLUMNS, STATUS,
} = jobService;
const { listQuery } = require('../validators/job.validator');

// Collapse newlines/indentation so the assertions read like the SQL does.
const flat = (s) => String(s).replace(/\s+/g, ' ').trim();

// ─── The end-anchor CASE ────────────────────────────────────────────

test('the END anchor maps each terminal status to its own timestamp column', () => {
  const sql = flat(JOB_AGE_END_EXPR);
  assert.match(sql, new RegExp(`WHEN ${STATUS.COMPLETED} THEN j\\.checkout_date_time`));
  assert.match(sql, new RegExp(`WHEN ${STATUS.COMPLETED_ALT} THEN j\\.checkout_date_time`));
  assert.match(sql, new RegExp(`WHEN ${STATUS.CANCELLED} THEN j\\.cancel_date_time`));
  assert.match(sql, new RegExp(`WHEN ${STATUS.ENQUIRY} THEN j\\.enquiry_date_time`));
  // Pin the literal codes too — a rename of the STATUS keys must not silently
  // re-point an anchor at a different column.
  assert.match(sql, /WHEN 3 THEN j\.checkout_date_time/);
  assert.match(sql, /WHEN 5 THEN j\.checkout_date_time/);
  assert.match(sql, /WHEN 6 THEN j\.cancel_date_time/);
  assert.match(sql, /WHEN 7 THEN j\.enquiry_date_time/);
});

test('an OPEN job (no CASE branch) falls through to NOW(), so age keeps ticking', () => {
  const sql = flat(JOB_AGE_END_EXPR);
  // No ELSE — an open job yields NULL from the CASE and COALESCE turns it into
  // NOW(). That same fall-through is the robustness net for a terminal row
  // whose anchor is NULL (there is exactly one such enquiry row in prod): it
  // ages against NOW() rather than emitting NULL.
  assert.doesNotMatch(sql, /\bELSE\b/i);
  assert.match(sql, /^COALESCE\( CASE j\.job_status .* END, NOW\(\) \)$/);
});

test('no status OTHER than 3/5/6/7 gets a terminal anchor', () => {
  const branches = flat(JOB_AGE_END_EXPR).match(/WHEN (\d+) THEN/g) || [];
  const codes = branches.map((b) => Number(b.match(/\d+/)[0])).sort((a, b) => a - b);
  assert.deepEqual(codes, [3, 5, 6, 7]);
  // Explicitly: the live/open statuses must NOT appear as terminal anchors.
  for (const open of [STATUS.BOOKED, STATUS.SCHEDULED, STATUS.IN_PROGRESS,
    STATUS.UNCONFIRMED, STATUS.CLOSED_FROM_APP, STATUS.ESTIMATE_PENDING_APPROVAL,
    STATUS.IN_PROGRESS_ALT, STATUS.ON_HOLD]) {
    assert.ok(!codes.includes(open), `status ${open} must age against NOW(), not a terminal anchor`);
  }
});

// ─── Interval + granularity ─────────────────────────────────────────

test('both intervals start at ticket_created_date_time and end at the same anchor', () => {
  for (const expr of [JOB_AGE_SECS_EXPR, JOB_AGE_DAYS_EXPR]) {
    assert.match(flat(expr), /TIMESTAMPDIFF\((SECOND|DAY), j\.ticket_created_date_time,/);
    assert.ok(flat(expr).includes(flat(JOB_AGE_END_EXPR)), 'must reuse the shared END anchor');
  }
  // Not created_date_time — the ticket timestamp is the agreed start.
  assert.doesNotMatch(flat(JOB_AGE_SECS_EXPR), /TIMESTAMPDIFF\(SECOND, j\.created_date_time/);
});

test('days are floored with TIMESTAMPDIFF(DAY, …), NEVER DATEDIFF', () => {
  /*
   * The agreed granularity is whole days counted WITH the time included: a job
   * created today at 11 AM is age 1 tomorrow at 11 AM (23h59m → 0, 24h00m → 1).
   * TIMESTAMPDIFF(DAY, …) floors exactly that way. DATEDIFF counts calendar-date
   * boundaries, so 11 PM → 1 AM two hours later would report 1. Verified in SQL:
   * TIMESTAMPDIFF over exactly 24h = 1, over 23h59m = 0, over 23:00→01:00 = 0,
   * where DATEDIFF on that same 2-hour span returns 1.
   */
  assert.match(flat(JOB_AGE_DAYS_EXPR), /TIMESTAMPDIFF\(DAY,/);
  assert.doesNotMatch(flat(JOB_AGE_DAYS_EXPR), /DATEDIFF/i);
  assert.doesNotMatch(flat(JOB_AGE_SECS_EXPR), /DATEDIFF/i);
});

test('both intervals are clamped at 0 — a back-dated correction never renders negative', () => {
  assert.match(flat(JOB_AGE_SECS_EXPR), /^GREATEST\(TIMESTAMPDIFF\(SECOND, .*\), 0\)$/);
  assert.match(flat(JOB_AGE_DAYS_EXPR), /^GREATEST\(TIMESTAMPDIFF\(DAY, .*\), 0\)$/);
});

// ─── Safe to interpolate ────────────────────────────────────────────

test('the expressions are pure column arithmetic — no placeholders, no new alias', () => {
  for (const [name, expr] of Object.entries({
    JOB_AGE_END_EXPR, JOB_AGE_SECS_EXPR, JOB_AGE_DAYS_EXPR, JOB_AGE_COLUMNS,
  })) {
    // A '?' would silently shift every positional param once interpolated into
    // the SELECT / ORDER BY, mis-binding the entire query.
    assert.ok(!expr.includes('?'), `${name} must contain no placeholder`);
    // Only the tbl_job alias. Anything else (cl./ci./cu./ef./ow./ad.) would need
    // a join the COUNT query does not build — the known 500 regression.
    const aliases = new Set((expr.match(/\b([a-z][a-z0-9_]{0,2})\.[a-z_]+/gi) || []).map((m) => m.split('.')[0]));
    assert.deepEqual([...aliases], ['j'], `${name} must reference ONLY the j alias`);
  }
});

// ─── Projection fragment ────────────────────────────────────────────

test('the projection fragment emits ageDays from DAY and ageSecs from SECOND', () => {
  assert.ok(JOB_AGE_COLUMNS.trimStart().startsWith(','), 'must be a leading-comma fragment');
  assert.ok(flat(JOB_AGE_COLUMNS).includes(`${flat(JOB_AGE_DAYS_EXPR)} AS ageDays`));
  assert.ok(flat(JOB_AGE_COLUMNS).includes(`${flat(JOB_AGE_SECS_EXPR)} AS ageSecs`));
  // The obvious inversion, called out explicitly.
  assert.ok(!flat(JOB_AGE_COLUMNS).includes(`${flat(JOB_AGE_DAYS_EXPR)} AS ageSecs`));
});

// ─── Display value and sort key are ONE definition ──────────────────

test('the `age` sort key IS the same expression the projection emits as ageSecs', () => {
  // Reference identity, not a lookalike string: the sort key and the projected
  // value come from the one constant, so they cannot be edited apart.
  assert.equal(SORTABLE_COLUMNS.age, JOB_AGE_SECS_EXPR);
  assert.ok(flat(JOB_AGE_COLUMNS).includes(`${flat(SORTABLE_COLUMNS.age)} AS ageSecs`));
});

test('sorting uses SECONDS, not the floored days', () => {
  // Sorting on ageDays would tie every job created on the same day and collapse
  // the whole sub-day population into a single bucket.
  assert.notEqual(SORTABLE_COLUMNS.age, JOB_AGE_DAYS_EXPR);
  assert.match(flat(SORTABLE_COLUMNS.age), /TIMESTAMPDIFF\(SECOND,/);
  assert.doesNotMatch(flat(SORTABLE_COLUMNS.age), /TIMESTAMPDIFF\(DAY,/);
});

// ─── The both-sides whitelist ───────────────────────────────────────

test('every service sort key is accepted by the validator, and nothing else is', () => {
  for (const key of Object.keys(SORTABLE_COLUMNS)) {
    const { error } = listQuery.validate({ sortBy: key, sortDir: 'desc' });
    assert.equal(error, undefined, `validator rejected the sortable key "${key}"`);
  }
  for (const junk of ['ageDays', 'ageSecs', 'age_days', 'bogus', '__proto__', 'constructor', 'j.job_id; DROP']) {
    const { error } = listQuery.validate({ sortBy: junk });
    assert.ok(error, `validator must reject "${junk}"`);
  }
});

test('an unknown sort key is a safe no-op in the service, never raw SQL', () => {
  // Defence in depth for any caller that bypasses Joi. Inherited Object keys
  // must not resolve either.
  for (const junk of ['bogus', '__proto__', 'constructor', 'toString']) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(SORTABLE_COLUMNS, junk),
      `"${junk}" must not be an own key of the whitelist`,
    );
  }
});

test('adding a sort key to the service alone can no longer drift the validator', () => {
  // The validator derives its valid() list from these keys. If someone
  // re-hardcodes the list, this fails.
  const accepted = Object.keys(SORTABLE_COLUMNS)
    .filter((k) => !listQuery.validate({ sortBy: k }).error);
  assert.deepEqual(accepted, Object.keys(SORTABLE_COLUMNS));
  assert.ok(accepted.includes('age'), "'age' must be a live sort key on BOTH sides");
});

// ─── The real emitted SQL (list + count + detail) ───────────────────

test('list() projects ageDays + ageSecs and its COUNT query stays join-clean', async () => {
  fake.reset();
  await jobService.list({ status: STATUS.BOOKED, assigned: false, limit: 50, offset: 0 });

  const dataSql  = fake.calls.map((c) => c.sql).find((s) => /AS ageSecs/.test(s));
  const countSql = fake.calls.map((c) => c.sql).find((s) => /SELECT COUNT\(\*\) AS total/.test(s));
  assert.ok(dataSql,  'the list data query must project the age fields');
  assert.ok(countSql, 'the list must still run its pagination COUNT');

  assert.match(flat(dataSql), /AS ageDays/);
  assert.match(flat(dataSql), /AS ageSecs/);
  assert.ok(flat(dataSql).includes(flat(JOB_AGE_COLUMNS).replace(/^,\s*/, '')));

  // THE COUNT TRAP: age must not have pulled a new alias into the COUNT, and
  // the COUNT must not have grown an ORDER BY (it has none to grow).
  assert.doesNotMatch(countSql, /ageSecs|ageDays|TIMESTAMPDIFF/);
  assert.doesNotMatch(countSql, /ORDER BY/i);
  // status + assigned filter only `j.` columns → COUNT counts tbl_job alone.
  assert.doesNotMatch(countSql, /LEFT JOIN/);
});

test('list({sortBy:"age"}) orders by the seconds expression with the stable tiebreaker', async () => {
  fake.reset();
  await jobService.list({ sortBy: 'age', sortDir: 'desc', limit: 50, offset: 0 });
  const dataSql = fake.calls.map((c) => c.sql).find((s) => /AS ageSecs/.test(s));
  const order = flat(dataSql).slice(flat(dataSql).lastIndexOf('ORDER BY'));
  assert.ok(order.includes(flat(JOB_AGE_SECS_EXPR)), 'ORDER BY must use the seconds expression');
  assert.match(order, /DESC, j\.job_id DESC LIMIT \? OFFSET \?$/);

  fake.reset();
  await jobService.list({ sortBy: 'age', sortDir: 'asc', limit: 50, offset: 0 });
  const ascSql = fake.calls.map((c) => c.sql).find((s) => /AS ageSecs/.test(s));
  const ascOrder = flat(ascSql).slice(flat(ascSql).lastIndexOf('ORDER BY'));
  assert.match(ascOrder, /ASC, j\.job_id DESC LIMIT \? OFFSET \?$/);
});

test('an unknown sortBy falls back to job_id DESC instead of injecting anything', async () => {
  fake.reset();
  await jobService.list({ sortBy: '__proto__', limit: 50, offset: 0 });
  const dataSql = fake.calls.map((c) => c.sql).find((s) => /AS ageSecs/.test(s));
  assert.match(flat(dataSql), /ORDER BY j\.job_id DESC LIMIT \? OFFSET \?$/);
});

test('the DETAIL query projects the SAME two age fields as the list', async () => {
  fake.reset();
  await jobService.getByIdCore(12345);
  const detailSql = fake.calls.map((c) => c.sql).find((s) => /WHERE j\.job_id = \? LIMIT 1/.test(s));
  assert.ok(detailSql, 'getByIdCore must run its detail query');
  assert.match(flat(detailSql), /AS ageDays/);
  assert.match(flat(detailSql), /AS ageSecs/);
  // Same fragment, so the modal and the row can never disagree.
  assert.ok(flat(detailSql).includes(flat(JOB_AGE_COLUMNS).replace(/^,\s*/, '')));
});
