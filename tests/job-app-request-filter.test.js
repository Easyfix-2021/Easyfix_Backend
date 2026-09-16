'use strict';
/*
 * `appRequest` — the server-side Technician Requests filter (owner, 2026-09-16:
 * "Server-side filter for pending asks").
 *
 * WHAT IT REPLACED. The CRM's Technician Requests section pulled ONE bounded
 * page of 500 pending jobs and narrowed it in the browser, because /admin/jobs
 * projected the two flags but could not filter on them. That held only while
 * the whole pending-to-start queue fitted inside 500 rows; past that the
 * requests on the LATEST appointments fell outside the window and stopped being
 * listed — silently, because a client cannot filter rows it was never sent.
 *
 * THE ONE THING THAT MUST NOT DRIFT is the predicate. The CRM still renders
 * each row's chip through appRequestOf() in src/lib/job-app-request.ts; if the
 * SQL selected a different set than that predicate recognises, rows would
 * arrive with no chip to draw. Both halves are asserted here.
 *
 * Non-destructive: fake pool, no real DB. Runner: `node --test`.
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/SHOW COLUMNS/i, []],
  [/FROM easyfix_properties/i, []],
  [/FROM tbl_job_customer_request LIMIT 1/i, []],
  [/SELECT 1 FROM tbl_job_offer LIMIT 1/i, [{ 1: 1 }]],
  [/SELECT magic_link_delivery_status FROM tbl_job LIMIT 1/i, [{ magic_link_delivery_status: null }]],
  [/^SELECT COUNT\(\*\) AS total/i, [{ total: 0 }]],
]);

const jobSvc = require('../services/job.service');
const { listQuery } = require('../validators/job.validator');

beforeEach(() => { fake.reset(); });

const dataQuery = () => fake.calls.find((c) => /LIMIT \? OFFSET \?/.test(c.sql));
const countQuery = () => fake.calls.find((c) => /^SELECT COUNT\(\*\) AS total/i.test(c.sql));
/*
 * The TOP-LEVEL WHERE. Not `sql.indexOf('WHERE')` — the data query's projection
 * contains correlated subqueries with WHEREs of their own, so the first match is
 * inside one of them and every assertion against it is meaningless. The COUNT
 * query's projection is a bare COUNT(*), so its WHERE is unambiguous; the data
 * query is sliced from its LAST `FROM tbl_job j`, which is the real join.
 */
const countWhere = () => countQuery().sql.slice(countQuery().sql.indexOf('WHERE')).trim();
const dataWhere = () => {
  const sql = dataQuery().sql;
  const join = sql.lastIndexOf('FROM tbl_job j');
  // Cut the ORDER BY / LIMIT tail so the two are comparable as predicates.
  return sql.slice(sql.indexOf('WHERE', join)).split(/\s+ORDER BY/)[0].trim();
};

// ─── The vocabulary ─────────────────────────────────────────────────────

test('the validator and the service share ONE list of values', () => {
  assert.deepEqual([...jobSvc.APP_REQUEST_VALUES], ['any', 'cancel', 'reschedule']);
  for (const v of jobSvc.APP_REQUEST_VALUES) {
    assert.equal(listQuery.validate({ appRequest: v }).error, undefined, `${v} must validate`);
  }
  // '' clears the control without the FE having to strip the key — offerState's rule.
  assert.equal(listQuery.validate({ appRequest: '' }).error, undefined);
  assert.ok(listQuery.validate({ appRequest: 'nonsense' }).error, 'an unknown value is a 400, not a silent no-op');
});

// ─── The predicate ──────────────────────────────────────────────────────

test('it pins job_status = 1 itself — the status test IS the handled test', () => {
  const c = jobSvc.appRequestClause('any');
  assert.match(c.sql, /j\.job_status = \?/);
  assert.deepEqual(c.params, [jobSvc.STATUS.SCHEDULED]);
  /*
   * NOT redundant with the caller's own status=1. A request is pending only
   * while the job sits at 1 — the moment ops actions it the job leaves that
   * status — so omitting the pin would resurrect every ask already answered.
   */
  assert.equal(jobSvc.STATUS.SCHEDULED, 1);
});

test('both flags are read as bit(1), never as a bare truthy value', () => {
  // mysql2 hands a BIT column back as a Buffer and EVERY Buffer is truthy; a
  // bare read would match every row in the table.
  const sql = jobSvc.appRequestClause('any').sql;
  assert.match(sql, /COALESCE\(j\.is_cancelled_by_app, 0\) = 1/);
  assert.match(sql, /COALESCE\(j\.is_rescheduled_by_app, 0\) = 1/);
});

test('each value selects exactly its own ask', () => {
  const any = jobSvc.appRequestClause('any').sql;
  assert.match(any, /OR/, "'any' is either ask");
  assert.ok(any.includes('is_cancelled_by_app') && any.includes('is_rescheduled_by_app'));

  const cancel = jobSvc.appRequestClause('cancel').sql;
  assert.ok(cancel.includes('is_cancelled_by_app'));
  assert.ok(!cancel.includes('is_rescheduled_by_app'), 'a cancel filter must not match reschedules');

  const resched = jobSvc.appRequestClause('reschedule').sql;
  assert.ok(resched.includes('is_rescheduled_by_app'));
  assert.ok(!resched.includes('is_cancelled_by_app'), 'and the reverse');
});

test('an unknown value builds no clause at all', () => {
  for (const v of [undefined, null, '', 'any ', 'ANY', 'delete']) {
    assert.equal(jobSvc.appRequestClause(v), null, `${JSON.stringify(v)} must not build a clause`);
  }
});

// ─── It reaches the query, on BOTH paths ────────────────────────────────

test('the clause lands in the WHERE of the data query AND the count query', async () => {
  await jobSvc.list({ status: 1, appRequest: 'any', limit: 10, offset: 0 });
  assert.ok(dataQuery() && countQuery(), 'positive control: both queries must have been issued');
  assert.match(dataWhere(), /is_cancelled_by_app/);
  assert.match(countWhere(), /is_cancelled_by_app/);
  // Both interpolate the SAME clauses array, so the count and the page can
  // never describe different sets — that is what makes the chip honest.
  assert.equal(dataWhere(), countWhere());
  /*
   * The status pin appears TWICE — once from the caller's own status=1 and
   * once from the clause itself — and that is deliberate, not a bug: the
   * filter has to stand alone for a caller that pins nothing.
   */
  assert.match(countWhere(), /j\.job_status = \? AND \(j\.job_status = \?/);
});

test('it adds NO join — the count query stays single-table', async () => {
  await jobSvc.list({ status: 1, appRequest: 'any', limit: 10, offset: 0 });
  const c = countQuery().sql;
  /*
   * Every column is on `j`, so the COUNT path's alias-sniffing picks up
   * nothing new. This is the whole reason the filter is cheap where offerState
   * needed an EXISTS: its data lives in another table.
   */
  assert.match(c, /FROM tbl_job j/);
  for (const alias of ['tbl_customer', 'tbl_address', 'tbl_city', 'tbl_client', 'tbl_easyfixer']) {
    assert.ok(!c.includes(alias), `COUNT must not gain a ${alias} join for this filter`);
  }
});

test('absent, it changes nothing', async () => {
  await jobSvc.list({ status: 1, limit: 10, offset: 0 });
  assert.doesNotMatch(countWhere(), /is_cancelled_by_app|is_rescheduled_by_app/);
});

test('it NARROWS — the caller\'s other pins survive alongside it', async () => {
  await jobSvc.list({ status: 1, appRequest: 'cancel', clientId: 42, limit: 10, offset: 0 });
  const w = countWhere();
  assert.match(w, /is_cancelled_by_app/);
  assert.match(w, /fk_client_id/, 'a filter that replaced the caller\'s pins would widen the set');
});

// ─── Cross-repo: the SQL and the client predicate must agree ────────────

test('the SQL reproduces the CRM predicate that renders the chip', () => {
  /*
   * FAIL, never skip. The CRM still calls appRequestOf() per row to draw the
   * chip. If these two ever disagree the server returns rows the client has no
   * label for — blank cells, with nothing anywhere reporting an error.
   */
  const crm = process.env.EASYFIX_CRM_UI_DIR
    || path.resolve(__dirname, '../../Easyfix_CRM_UI');
  const file = path.join(crm, 'src', 'lib', 'job-app-request.ts');
  assert.ok(fs.existsSync(file),
    `Easyfix_CRM_UI checkout not found — set EASYFIX_CRM_UI_DIR or clone it beside this repo (looked for ${file})`);
  const ts = fs.readFileSync(file, 'utf8');

  assert.match(ts, /export const PENDING_TO_START_STATUS = 1;/,
    'the client gates on status 1 — so must the SQL');
  assert.equal(jobSvc.STATUS.SCHEDULED, 1, 'and they must be the same 1');
  // The client checks the two flags in this order; the SQL ORs the same two.
  assert.match(ts, /flagOn\(row\.is_cancelled_by_app\)/);
  assert.match(ts, /flagOn\(row\.is_rescheduled_by_app\)/);
  const sql = jobSvc.appRequestClause('any').sql;
  assert.ok(sql.includes('is_cancelled_by_app') && sql.includes('is_rescheduled_by_app'));
});

/*
 * NO TEST HERE FOR THE CRM'S OWN FETCH SHAPE — deliberately, and it was tried.
 *
 * A draft asserted that PendingToStartView sends `appRequest` and no longer
 * filters client-side. That is the CRM's INTERNAL shape, it is already pinned
 * by that repo's tests/pending-to-start-sections.test.js, and asserting it
 * from here is a deploy-order deadlock: this repo's CI clones Easyfix_CRM_UI at
 * `--depth 1` of its DEFAULT branch, which is Production. The assertion would
 * therefore have gone red on every backend CI run until the CRM's change
 * reached Production — for a fact this repo does not own.
 *
 * What a cross-repo test may assert is the CONTRACT: the predicate above,
 * which both sides implement and which has been stable in
 * src/lib/job-app-request.ts since long before either branch moved.
 */
