'use strict';
/*
 * view=manage selects COLUMNS. It must never narrow the ROWS.
 *
 * ─── THE REGRESSION (2026-09-10 → 2026-09-11) ──────────────────────────────
 *
 * The Manage Jobs view needed the escalation row for its Rating and Escalted By
 * columns, so list() switched `wantsEscalation` on for view=manage. That flag
 * had a second reader nobody checked: it also gated
 *     EXISTS (… tbl_easyfixer_rating_by_customer … is_escalated = 1)
 * in the WHERE. Every Manage Jobs request was filtered to escalated jobs only —
 * 12,910 of 481,048 on QA, ~15,000 on Production — and the total agreed with
 * the rows because COUNT shares the same clauses, so nothing looked wrong
 * except that most of the book had disappeared.
 *
 * The source-shape test beside this one PINNED the bad line (it asserted the
 * flag was forced on and stopped there). So this one runs list() and reads
 * the SQL it actually emits — both the data query and the COUNT — in both
 * directions: the view alone must not filter, and the caller's own
 * isEscalated must still filter. Without the second direction a fix that
 * simply deleted the filter would pass.
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/SELECT COUNT\(\*\) AS total/i, () => [{ total: 3 }]],
  [/FROM tbl_job j/i, () => [{ job_id: 1, job_status: 5, fk_easyfixter_id: null, sub_job_id: null }]],
]);

const jobSvc = require('../services/job.service');

beforeEach(() => fake.reset());

const ESCALATED_ONLY = /is_escalated = 1/;
const dataSql = () => (fake.calls.find((c) => /FROM tbl_job j/i.test(c.sql) && /LIMIT \? OFFSET \?/.test(c.sql)) || {}).sql || '';
const countSql = () => (fake.calls.find((c) => /SELECT COUNT\(\*\) AS total/i.test(c.sql)) || {}).sql || '';

test('view=manage alone does NOT filter to escalated jobs — rows or total', async () => {
  await jobSvc.list({ view: 'manage', limit: 10, offset: 0 });
  assert.ok(dataSql(), 'the data query must have run — an empty string would make the next line vacuous');
  assert.ok(countSql(), 'and so must the COUNT');
  assert.doesNotMatch(dataSql(), ESCALATED_ONLY,
    'the grid must list every job, not only escalated ones');
  assert.doesNotMatch(countSql(), ESCALATED_ONLY,
    'and the total must count them all — the regression hid 97.3% of the book');
});

test('…while still JOINING the escalation row its Rating column needs', async () => {
  // The other half of the split. Fixing the filter by dropping the join would
  // blank the Rating and Escalted By columns instead.
  await jobSvc.list({ view: 'manage', limit: 10, offset: 0 });
  assert.match(dataSql(), /LEFT JOIN tbl_easyfixer_rating_by_customer esc/,
    'the Rating column reads esc.customer_rating');
});

test('an explicit isEscalated filter still filters', async () => {
  // The positive control. A "fix" that deleted the WHERE entirely would pass
  // both tests above and break the client portal's /tickets/escalated tab.
  for (const view of [undefined, 'manage']) {
    fake.reset();
    await jobSvc.list({ view, isEscalated: 1, limit: 10, offset: 0 });
    assert.match(dataSql(), ESCALATED_ONLY, `view=${view}: the caller asked for escalated jobs`);
    assert.match(countSql(), ESCALATED_ONLY, `view=${view}: and the total must agree`);
  }
});

test('a plain list (no view, no filter) is unchanged', async () => {
  await jobSvc.list({ limit: 10, offset: 0 });
  assert.doesNotMatch(dataSql(), ESCALATED_ONLY);
  assert.doesNotMatch(dataSql(), /tbl_easyfixer_rating_by_customer esc/,
    'and pays for no escalation join');
});
