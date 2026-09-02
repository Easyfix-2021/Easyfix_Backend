'use strict';
/*
 * dateType=cancelled — the three places that have to agree.
 *
 * A dateType is only usable if all three say yes: the Joi whitelist on
 * listQuery (otherwise the request 400s before any code runs), DATE_TYPE_COLUMN
 * in services/job.service.js (the table), and UI_DATE_TYPE_COLUMN in
 * services/job-export.service.js (the sheet). `cancelled` was added to the two
 * maps and the whitelist together; this pins that they stay together, because
 * the failure mode when they drift is silent — a stale value falls back to
 * created_date_time rather than erroring, so the operator gets a window over
 * the WRONG COLUMN and no signal at all.
 *
 * Non-destructive: fake pool, no real DB.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installFakePool } = require('./helpers/fake-pool');

installFakePool([
  [/SHOW COLUMNS FROM tbl_client LIKE 'vertical_id'/i, [{ Field: 'vertical_id' }]],
  [/SHOW COLUMNS/i, []],
  [/FROM easyfix_properties/i, []],
]);

const { buildExportWhere } = require('../services/job-export.service');
const { listQuery } = require('../validators/job.validator');

const RANGE = { startDate: '2026-08-01', endDate: '2026-08-31' };

test('listQuery ACCEPTS dateType=cancelled — without this the filter 400s', () => {
  const { error } = listQuery.validate({ ...RANGE, dateType: 'cancelled' });
  assert.equal(error, undefined, error && error.message);
});

test('the export aims the window at J.cancel_date_time', () => {
  const { where } = buildExportWhere({ ...RANGE, dateType: 'cancelled' });
  assert.match(where, /J\.cancel_date_time >= DATE\(\?\)/);
  assert.match(where, /J\.cancel_date_time < DATE\(\?\) \+ INTERVAL 1 DAY/);
  assert.ok(!/J\.created_date_time >= DATE\(\?\)/.test(where),
    'falling back to created_date_time is the silent-drift failure this test exists to catch');
});

test('the table names the same column as the sheet, differing only by alias', () => {
  /*
   * DATE_TYPE_COLUMN is module-private and exporting it just to test it would
   * widen job.service's surface for nothing, so this reads the source. Crude on
   * purpose: the invariant IS textual — `j` there, `J` here (MySQL alias case
   * sensitivity follows lower_case_table_names, so the aliases legitimately
   * differ and only the column may not).
   */
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'job.service.js'), 'utf8');
  assert.match(src, /\bcancelled:\s*'j\.cancel_date_time'/,
    "job.service.js DATE_TYPE_COLUMN must map `cancelled` to j.cancel_date_time");
});

test('dateType=cancelled ALONE is still a modifier — no date, no clause', () => {
  const bare = buildExportWhere({}).where;
  assert.equal(buildExportWhere({ dateType: 'cancelled' }).where, bare);
});
