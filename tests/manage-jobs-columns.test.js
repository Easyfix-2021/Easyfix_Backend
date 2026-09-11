'use strict';
/*
 * The Manage Jobs view projection — `view=manage` on GET /admin/jobs.
 *
 * ─── WHAT THIS IS FOR (2026-09-10) ─────────────────────────────────────────
 *
 * The /jobs grid was rebuilt to the 20 columns the legacy CRM's Manage Jobs
 * screen carried (EasyFix_CRM manageJob.vm:778-797, rows bound by jobList.vm).
 * Eleven were already projected; the rest arrive through an OPT-IN fragment.
 *
 * ─── WHAT IS ASSERTED, AND WHY THESE ───────────────────────────────────────
 *
 * Three things can go wrong here, and none of them shows up as an error:
 *
 *   1. COST LEAKING TO THE OTHER ELEVEN CALLERS. list() serves the client
 *      portal, mobile, the exports and QuickSight. Three extra joins and eight
 *      scalar subqueries on all of them would be a silent regression, so the
 *      fragment must be empty unless asked for.
 *   2. FAN-OUT. tbl_job_offer has a row per (job, technician) and
 *      tbl_easyfixer_rating_by_customer's job_id is not unique, so joining
 *      either directly multiplies every job by its offer count — a list that
 *      returns the right rows, several times each.
 *   3. ROW-SHAPE DRIFT between deploys. tbl_job_offer is column-probed; if the
 *      un-migrated branch emits a different set of aliases the FE renders
 *      blanks on one deploy and values on another.
 *
 * Plus two delegation pins: the bucket labels must come from the export
 * service's port rather than a second copy, and the latest-comment ORDER BY
 * must be the one job-comment.service.js already uses — otherwise this cell and
 * the job's own comment thread can disagree about which comment is newest.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'services/job.service.js'), 'utf8');

/*
 * Evaluate one of the module's pure SQL-fragment builders in isolation.
 *
 * The module-scope constants a fragment interpolates have to be injected, or
 * the sandbox throws ReferenceError — which is how this helper failed the
 * moment manageJoin started reading JOB_OPEN_REASON_PICK. Read out of the
 * source rather than retyped, so the value under test is the shipped one.
 */
const MODULE_CONSTS = {
  JOB_OPEN_REASON_PICK: (SRC.match(/const JOB_OPEN_REASON_PICK = `([\s\S]*?)`;/) || [])[1],
};

function fragment(name, ...args) {
  const m = SRC.match(new RegExp(`function ${name}\\(([^)]*)\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} must exist in services/job.service.js`);
  const params = m[1].split(',').map((p) => p.trim().split('=')[0].trim()).filter(Boolean);
  const body = m[0].replace(new RegExp(`^function ${name}\\([^)]*\\) \\{`), '').replace(/\n\}$/, '');
  const constNames = Object.keys(MODULE_CONSTS);
  for (const c of constNames) {
    assert.ok(MODULE_CONSTS[c], `${c} must be readable from the source — the sandbox needs it`);
  }
  // eslint-disable-next-line no-new-func
  return new Function(...constNames, ...params, body)(
    ...constNames.map((c) => MODULE_CONSTS[c]), ...args);
}

const aliases = (sql) => (sql.match(/AS ([a-z_]+)/g) || []).map((a) => a.slice(3));

/* ─── 1. no cost for the other callers ─────────────────────────────────── */

test('the fragment is EMPTY unless the view is asked for', () => {
  assert.equal(fragment('manageColumns', false, true), '',
    'list() has a dozen callers; none of them should pay for this view');
  assert.equal(fragment('manageJoin', false), '');
});

/* ─── 2. the shape cannot drift between deploys ─────────────────────────── */

test('the row shape is IDENTICAL whether tbl_job_offer is migrated in or not', () => {
  /*
   * Same invariant offerColumns documents for itself. A NULL-aliased branch
   * that omitted a column would render blanks on one deploy and values on
   * another, with nothing in either payload to say which happened.
   */
  const on = aliases(fragment('manageColumns', true, true));
  const off = aliases(fragment('manageColumns', true, false));
  assert.deepEqual(off, on,
    `aliases diverge between the two branches:\n  with:    ${on.join(',')}\n  without: ${off.join(',')}`);
  assert.ok(on.length >= 10, `expected at least 10 aliased columns, got ${on.length}`);
});

test('every column the grid renders is projected', () => {
  // The denominator for the 20-column grid: the nine fields that are NOT
  // already on the default LIST projection. A missing one renders an em-dash
  // forever with no error anywhere — the exact failure this pins.
  const sql = fragment('manageColumns', true, true);
  /*
   * Asserts the ROW KEY, not the syntax. mysql2 names a column by its alias
   * when there is one and by the column name when there is not, so
   * `ad.pin_code` and `ut.type AS due_to_type` both satisfy the contract the FE
   * reads — matching only `AS <col>` would have failed on the four that need no
   * alias, which is what the first version of this test did.
   */
  for (const col of [
    'pin_code', 'efr_manager_id', 'efr_team_count', 'easyfix_spoc', 'customer_rating',
    'due_to_type', 'last_comment', 'contact_approval',
    'offer_total', 'offer_pending', 'offer_accepted', 'offer_rejected', 'offer_expired',
    // The bucket-derivation inputs that are also read directly by the grid.
    'sub_job_id', 'requested_time',
  ]) {
    assert.match(sql, new RegExp(`(AS ${col}\\b|\\b[a-z]+\\.${col}\\b)`),
      `${col} must reach the row, either aliased or as a qualified column`);
  }
});

test('every input the two bucket derivations read is projected', () => {
  /*
   * Derived from the HELPERS rather than a hand-typed list: whatever
   * jobCurrentStatus and its six sub-helpers read off the row is exactly what
   * this projection has to supply. A hand-written list would go stale the first
   * time a helper grew a field, and the label would silently degrade to a
   * wrong sub-state rather than an error.
   */
  const exportSrc = fs.readFileSync(path.join(ROOT, 'services/job-export.service.js'), 'utf8');
  const helpers = ['jobCurrentStatus', 'pendingToScheduleBucketStatus', 'pendingToStartBucketStatus',
    'unconfirmedBucketStatus', 'auditAndCompleteBucketStatus', 'billingBucketStatus'];
  const needed = new Set();
  for (const h of helpers) {
    const m = exportSrc.match(new RegExp(`function ${h}\\(r\\) \\{[\\s\\S]*?\\n\\}`));
    assert.ok(m, `${h} must exist in the export service`);
    for (const f of m[0].matchAll(/\br\.([a-z_0-9]+)/g)) needed.add(f[1]);
  }
  assert.ok(needed.size >= 20, `expected the helpers to read 20+ fields, found ${needed.size}`);

  const manage = fragment('manageColumns', true, true);
  const listCols = SRC.slice(SRC.indexOf('const LIST_COLUMNS'), SRC.indexOf('const LIST_JOIN'));
  const available = manage + listCols + fragment('manageJoin', true);
  const missing = [...needed].filter((f) => !available.includes(f));
  assert.deepEqual(missing, [],
    `the bucket derivation reads fields the projection does not supply: ${missing.join(', ')}`);
});

/* ─── 3. nothing may fan the list out ──────────────────────────────────── */

test('the one-to-many tables are reached by SUBQUERY, never by join', () => {
  const join = fragment('manageJoin', true);
  for (const t of ['tbl_job_offer', 'tbl_job_comment', 'tbl_easyfixer_rating_by_customer']) {
    assert.doesNotMatch(join, new RegExp(`JOIN ${t}\\b`),
      `${t} has more than one row per job — joining it multiplies every job by its row count`);
  }
  // And the three it DOES join are many-to-one on j.
  for (const t of ['tbl_user uo', 'tbl_client_contacts contact', 'user_type ut']) {
    assert.match(join, new RegExp(`JOIN ${t}\\b`), `${t} must be joined`);
  }
});

test('Rating reuses the escalation row rather than joining that table twice', () => {
  // tbl_easyfixer_rating_by_customer's job_id is NOT unique, which is why
  // escalationJoin resolves it through MAX(table_id). Joining it a second time
  // for the rating would both fan out and pick a different row.
  assert.match(SRC, /const wantsEscalation = wantsManage \|\| filtersEscalated;/,
    'the manage view must force the escalation JOIN on');
  assert.match(fragment('manageColumns', true, true), /esc\.customer_rating/,
    'and read the rating off that same alias');
  /*
   * ⚠ The JOIN, and only the join. This test's first version asserted
   * `wantsEscalation = wantsManage || …` and stopped there — it pinned the
   * line that shipped the regression, because that same flag ALSO gated the
   * escalated-only WHERE. Manage Jobs listed escalated jobs only (97.3% of
   * the book hidden on QA) and this file stayed green. The filter must key on
   * the caller's own request, never on the view.
   */
  assert.match(SRC, /  if \(filtersEscalated\) \{\n    clauses\.push\(`EXISTS \(/,
    'the is_escalated WHERE must be gated on the caller asking for it');
  assert.doesNotMatch(SRC, /  if \(wantsEscalation\) \{\n    clauses\.push/,
    'gating the WHERE on the join flag filters every Manage Jobs request to escalated jobs');
});

/* ─── delegation: no second copy of anything ───────────────────────────── */

test('the bucket labels come from the export service, not a second port', () => {
  /*
   * getHomeJobStatusbyStatusId is 13 labels; getJobCurrentStatusNew is ~30
   * across six helpers reading 24 fields. Two ports of that would drift the
   * first time either changed — and the XLSX sheet renders the other one, so
   * the drift would show up as the grid and the sheet disagreeing about a job's
   * state, which is the reconciliation operators actually do.
   */
  assert.match(SRC, /require\('\.\/job-export\.service'\)/,
    'the labels must be derived by the export service\'s own helpers');
  assert.match(SRC, /r\.bucket = homeJobStatus\(r\.job_status, r\.fk_easyfixter_id, r\.sub_job_id\)/);
  assert.match(SRC, /r\.bucket_status = jobCurrentStatus\(r\)/);
  const exportSrc = fs.readFileSync(path.join(ROOT, 'services/job-export.service.js'), 'utf8');
  assert.match(exportSrc, /^\s*homeJobStatus, jobCurrentStatus,$/m,
    'and they must be exported for that to be possible');
});

test('the label derivation is FAIL-SOFT — a label may not 500 the jobs list', () => {
  // A bucket label is decoration. A throw inside the mapping loop would take
  // the whole grid down, which is strictly worse than a blank cell.
  const block = SRC.match(/if \(wantsManage && rows\.length\) \{[\s\S]*?\n  \}/);
  assert.ok(block, 'the derivation block must exist');
  assert.match(block[0], /try \{/, 'it must be wrapped');
  assert.match(block[0], /catch \(e\) \{[\s\S]*?logger\.warn/, 'and log rather than throw');
  assert.match(block[0], /r\.bucket = null; r\.bucket_status = null;/,
    'on failure the columns render blank');
});

test('the latest comment uses the SAME ordering as the comment thread', () => {
  /*
   * Byte-identical to job-comment.service.js' own listing. Id order alone is
   * not enough: addComment lets created_on default while two raw INSERTs pass
   * NOW() explicitly, so id order and time order are not guaranteed to agree —
   * and a Remark cell that disagreed with the top row of the job's own comment
   * thread would be indistinguishable from stale data.
   */
  const ORDER = 'ORDER BY jc.created_on DESC, jc.comment_id DESC';
  assert.match(fragment('manageColumns', true, true), new RegExp(ORDER));
  const commentSrc = fs.readFileSync(path.join(ROOT, 'services/job-comment.service.js'), 'utf8');
  assert.match(commentSrc, /ORDER BY c\.created_on DESC, c\.comment_id DESC/,
    'the thread listing must still order the same way — if this changed, the cell must follow');
});

test('Remark is the latest COMMENT, never j.remarks', () => {
  /*
   * Of four tbl_job_comment INSERT statements in this repo only addComment
   * mirrors into tbl_job.remarks, and it soft-fails when it does; the still-live
   * Java CRM adds six more that never mirror. The column is also
   * composeRemarks()' serialisation format and the dueTo LIKE filter's target.
   */
  const sql = fragment('manageColumns', true, true);
  assert.match(sql, /FROM tbl_job_comment jc/, 'it must read the comment table');
  assert.doesNotMatch(sql, /AS last_comment[\s\S]*?j\.remarks/,
    'j.remarks cannot stand in for the latest comment');
});

/* ─── the wire: both sides must accept what the grid sends ─────────────── */

test('the validator accepts view=manage and nothing else', () => {
  const { listQuery } = require(path.join(ROOT, 'validators/job.validator'));
  assert.equal(listQuery.validate({ view: 'manage' }).error, undefined);
  assert.ok(listQuery.validate({ view: 'everything' }).error,
    'an unknown view must be rejected, not silently stripped into a blank grid');
});

test('the two newly-rendered sortable columns are whitelisted', () => {
  // The grid puts sort controls on Ticket Created and Category. An
  // unwhitelisted key does not degrade — the validator derives its valid() list
  // from this map, so the request 400s and the grid renders empty.
  const { SORTABLE_COLUMNS } = require(path.join(ROOT, 'services/job.service'));
  assert.equal(SORTABLE_COLUMNS.ticket_created_date_time, 'j.ticket_created_date_time');
  assert.equal(SORTABLE_COLUMNS.service_category, 'sc.service_catg_name');
  assert.ok(SORTABLE_COLUMNS.age, 'and Age, the default sort, must still be there');
});

/* ─── the dueTo FILTER and the Open Due to COLUMN are one axis ──────────── */

test('the filter and the column read the SAME reason pick', () => {
  /*
   * They were two different rules until 2026-09-10. The column read
   * user_type.type through a reason FK; the filter matched PROSE in j.remarks
   * ("Due To: Client", or a loose "due to client"). An operator filtered one
   * population and read another — and not marginally: measured on the shared
   * database (481,048 jobs) the filter matched 17 rows across all four parties
   * while the column's axis resolved for 269,206.
   *
   * One interpolated constant with two readers is what makes them agree by
   * construction rather than by review.
   */
  assert.match(SRC, /const JOB_OPEN_REASON_PICK = `/, 'the pick must be one constant');
  const readers = [...SRC.matchAll(/\$\{JOB_OPEN_REASON_PICK\}/g)];
  assert.equal(readers.length, 2,
    `the pick has ${readers.length} readers; expected exactly 2 — the column's join and the filter`);
  /*
   * Against the SOURCE, not the evaluated fragment: fragment() injects the
   * constant, so the returned SQL carries the expanded IF(...) rather than the
   * ${...} reference. Asserting on the evaluated string would have been
   * checking my own sandbox, not the code.
   */
  assert.match(SRC, /LEFT JOIN action_taken_reason atr ON atr\.id = \$\{JOB_OPEN_REASON_PICK\}/,
    'the column must read it');
  const dueToBlock = SRC.slice(SRC.indexOf('  if (dueTo) {'));
  assert.match(dueToBlock.slice(0, dueToBlock.indexOf('\n  }')), /\$\{JOB_OPEN_REASON_PICK\}/,
    'and so must the filter');
});

test('the filter no longer matches PROSE', () => {
  // The structured "[… Pending Due To: X …]" prefix was dropped from the
  // writer on 2026-06-04, so that arm could only ever match rows older than
  // that — six of them. Its loose sibling matched "due to customer issue" for
  // dueTo=customer.
  const dueToBlock = SRC.slice(SRC.indexOf('  if (dueTo) {'));
  const block = dueToBlock.slice(0, dueToBlock.indexOf('\n  }'));
  assert.doesNotMatch(block, /j\.remarks LIKE/,
    'j.remarks is a mirror, a serialisation format and a filter index at once — not an axis');
  assert.doesNotMatch(block, /Due To: /, 'the structured-tag arm must be gone');
});

test('the filter is an EXISTS, so the COUNT query cannot 500', () => {
  /*
   * The COUNT query's joins are built by SNIFFING the WHERE string for table
   * aliases, and there is no branch for atr./ut. — a bare join alias in the
   * WHERE would take the endpoint down. The two other filters over off-alias
   * tables (rating, isEscalated) are self-contained EXISTS for exactly this
   * reason.
   */
  const dueToBlock = SRC.slice(SRC.indexOf('  if (dueTo) {'));
  const block = dueToBlock.slice(0, dueToBlock.indexOf('\n  }'));
  assert.match(block, /EXISTS \(/, 'it must be a subquery');
  // Its own aliases must be suffixed so they cannot collide with the
  // projection's atr/ut when both are present on a view=manage request.
  assert.match(block, /action_taken_reason atr_f/);
  assert.match(block, /user_type ut_f/);
});

test('the party map covers the validator vocabulary exactly', () => {
  /*
   * Denominator, both ways. A value the validator accepts but the map lacks
   * silently applies NO filter — the grid returns everything and looks like the
   * filter is broken. A value in the map the validator rejects is dead code.
   *
   * user_type also holds two rows the filter deliberately cannot reach
   * ("InretnalUser", "Easyfixer"); the four here are the parties ops use.
   */
  /*
   * Read from the validator's own `.valid(...)` literal rather than Joi's
   * describe() shape, which differs across Joi versions and would make this
   * assertion pass or fail for reasons unrelated to the vocabulary.
   */
  const vSrc = fs.readFileSync(path.join(ROOT, 'validators/job.validator.js'), 'utf8');
  const validLine = vSrc.match(/dueTo:\s*Joi\.string\(\)\.valid\(([^)]*)\)/);
  assert.ok(validLine, 'the dueTo validator must still declare its vocabulary inline');
  const allowed = [...validLine[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  const mapMatch = SRC.match(/const DUE_TO_TYPE = \{([^}]+)\}/);
  assert.ok(mapMatch, 'the party map must still be an inline literal');
  const mapped = mapMatch[1]
    .split(',').map((e) => e.split(':')[0].trim()).filter(Boolean).sort();
  assert.equal(allowed.length, 4, `expected the four parties, parsed ${allowed.join(',')}`);
  assert.deepEqual(mapped, allowed,
    `map keys ${mapped.join(',')} vs validator ${allowed.join(',')}`);
  // And the DB's own spelling, which is "Easyfix" — not the "EasyFix" the old
  // title-casing produced. Correct only by MySQL's case-insensitive collation,
  // which is one server config away from matching nothing.
  assert.match(SRC, /easyfix: 'Easyfix'/,
    'the mapped value must be the spelling user_type actually stores');
});
