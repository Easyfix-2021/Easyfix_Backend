'use strict';
/*
 * The ranking's Job Skill Matrix reads ACTIVE service lines only (2026-09-11).
 *
 * Removing a service is a soft delete (job_service_status = 0). The display
 * path (mapJobServices) drops such rows; matrixRequiredSkillIds — the set that
 * becomes skill_signal, sort key 3 of the Top-10 — did not, so after Schedule &
 * Assign's new Edit Services removed a line, the panel lost it and the ranking
 * still weighed its deep skills.
 *
 * The fake pool below plays MySQL honestly: it applies the status predicate to
 * the fixture ONLY IF the SQL actually carries it. So the assertions are about
 * behaviour (which skills come back), not about spelling — and dropping the
 * predicate from the query turns them red.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');
const { ACTIVE_SERVICES_SQL } = require('../services/job-line-total');

const PREDICATE = ACTIVE_SERVICES_SQL('js');
const LINES = [
  { skill: 11, status: 1 },    // active
  { skill: 22, status: 0 },    // REMOVED — must not steer the ranking
  { skill: 33, status: null }, // never set — still active (NULL <> 0 is NULL, hence the IS NULL arm)
];

const fake = installFakePool([
  [/SHOW COLUMNS FROM tbl_service_skill_mapping/i, () => [{ Field: 'service_catg_id' }]],
  [/FROM tbl_job_services js/i, (sql) => LINES
    .filter((l) => !sql.includes(PREDICATE) || l.status === null || l.status !== 0)
    .map((l) => ({ deep_skill_id: l.skill }))],
]);

const { _internals } = require('../services/candidate-ranking.service');

test('a removed service contributes no deep skill; active and never-set lines still do', async () => {
  const set = await _internals.matrixRequiredSkillIds(42);
  const matrixCall = fake.calls.find((c) => /FROM tbl_job_services js/i.test(c.sql));
  assert.ok(matrixCall, 'the matrix query must have run — otherwise the set below proves nothing');
  assert.deepEqual([...set].sort(), [11, 33], 'removed line 22 must be excluded, NULL-status line 33 kept');
  assert.deepEqual(matrixCall.params, [42]);
});
