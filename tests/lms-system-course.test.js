const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');
const { readMigration } = require('./helpers/migration-file');

/*
 * "INTRODUCTION TO EASYFIX" — the system course (owner, 2026-09-29).
 * Default, undeletable, always mandatory, videos only, at least one video, and
 * the one definition of what EVERY technician must watch.
 */

let course = null; // what getCourseById's SELECT returns
let columns = [];  // what the schema probe reports
const fake = installFakePool([
  [/FROM information_schema\.columns/i, () => columns],
  [/FROM courses WHERE id = \?/i, () => (course ? [course] : [])],
  [/SELECT kind, ref_id FROM lms_content/i, []],
  [/FROM training_videos\s+WHERE id IN/i, (_sql, ids) => ids.map((id) => ({ id }))],
  [/^\s*INSERT INTO lms_content/i, { insertId: 1 }],
  [/^\s*UPDATE (courses|lms_content)/i, { affectedRows: 1 }],
  [/^\s*DELETE FROM easyfixer_courses/i, { affectedRows: 1 }],
]);
after(() => fake.restore());

const lms = require('../services/lms.service');

const ALL = [
  { t: 'courses', c: 'is_mandatory' },
  { t: 'training_videos', c: 'is_global' },
  { t: 'lms_assessment', c: 'created_by' },
  { t: 'courses', c: 'is_system' },
];
const SYSTEM = { id: 9, name: 'Introduction to Easyfix', status: 1, is_mandatory: 1, is_system: 1 };
const ORDINARY = { id: 4, name: 'Technician Induction', status: 1, is_mandatory: 0, is_system: 0 };

beforeEach(() => {
  columns = ALL;
  course = SYSTEM;
  lms.invalidateLmsSchemaCache();
  fake.reset();
});

const code = (status, c) => (e) => {
  assert.equal(e.status, status);
  if (c) assert.equal(e.details?.code, c);
  return true;
};
const writes = () => fake.calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)/i.test(c.sql));

test('the system course cannot be retired, deleted, made optional, or unassigned', async () => {
  await assert.rejects(lms.retireCourse(9), code(409, 'SYSTEM_COURSE'));
  await assert.rejects(lms.updateCourse(9, { status: false }), code(409, 'SYSTEM_COURSE'));
  await assert.rejects(lms.updateCourse(9, { is_mandatory: false }), code(409, 'SYSTEM_COURSE'));
  await assert.rejects(lms.unassignCourse(9, 42), code(409, 'SYSTEM_COURSE'));
  assert.deepEqual(writes(), [], 'a refused change must write nothing');
});

test('its name and description stay editable', async () => {
  await lms.updateCourse(9, { name: 'Introduction to EasyFix', description: 'Start here' });
  assert.equal(writes().length, 1);
  assert.match(writes()[0].sql, /UPDATE courses SET name = \?, description = \?/);
});

test('saving it with no videos, or with anything but videos, is refused', async () => {
  await assert.rejects(lms.setCourseContent(9, []), code(400));
  await assert.rejects(lms.setCourseContent(9, [{ kind: 'video', ref_id: 4 }, { kind: 'document', ref_id: 2 }]), code(400));
  assert.deepEqual(writes(), []);
  await lms.setCourseContent(9, [{ kind: 'video', ref_id: 4 }]);
  assert.ok(writes().some((w) => /INSERT INTO lms_content/.test(w.sql)), 'one video is a valid save');
});

test('an ordinary course is untouched by the guards', async () => {
  course = ORDINARY;
  await lms.retireCourse(4);
  await lms.setCourseContent(4, []);
  await lms.setCourseContent(4, [{ kind: 'document', ref_id: 2 }]).catch(() => {}); // doc ref check is not this test's concern
  await lms.unassignCourse(4, 42);
  assert.ok(writes().some((w) => /UPDATE courses SET status = 0/.test(w.sql)));
  assert.ok(writes().some((w) => /DELETE FROM easyfixer_courses/.test(w.sql)));
});

test('every technician must watch the system course videos; is_global only before it exists', async () => {
  const sql = await lms.globalVideoIdsSql();
  assert.doesNotMatch(sql, /\?/, 'no placeholder — callers bind positionally around it');
  assert.match(sql, /tv\.is_global = 1\s+AND NOT EXISTS \(SELECT 1 FROM courses sc WHERE sc\.is_system = 1 AND sc\.status = 1\)/);
  assert.match(sql, /WHERE sc\.is_system = 1 AND sc\.status = 1 AND slc\.kind = 'video' AND slc\.status = 1/);
  assert.doesNotMatch(sql, /easyfixer_courses/, 'the system course gates whether or not it was assigned');
  const mandatory = await lms.mandatoryVideoIdsSql();
  assert.ok(mandatory.includes(sql.trim()), 'the onboarding gate uses exactly this set');

  // Before the migration: no column → the legacy catalogue, and nothing names is_system.
  columns = ALL.filter((c) => c.c !== 'is_system');
  lms.invalidateLmsSchemaCache();
  const legacy = await lms.globalVideoIdsSql();
  assert.doesNotMatch(legacy, /is_system/);
  assert.match(legacy, /tv\.is_global = 1\s+AND NOT EXISTS \(SELECT 1 FROM courses sc WHERE 1=0\)/);
  assert.match(legacy, /WHERE 1=0 AND slc\.kind = 'video'/);
});

test('the migration: one statement per line, re-runnable data steps, seeded from today\'s mandatory videos', () => {
  const sql = readMigration('2026-09-29-02-intro-course.sql');
  const statements = sql.split('\n').filter((l) => l.trim() && !l.trim().startsWith('--'));
  assert.ok(statements.every((l) => l.trim().endsWith(';')), 'one statement per line');
  assert.match(sql, /^ALTER TABLE courses ADD COLUMN is_system TINYINT NOT NULL DEFAULT 0;$/m);
  assert.match(sql, /'Introduction to Easyfix'.*, 1, 1, 1, NULL, 0,.*WHERE NOT EXISTS \(SELECT 1 FROM courses WHERE is_system = 1\);/);
  assert.match(sql, /JOIN training_videos tv ON tv\.is_global = 1 WHERE c\.is_system = 1 AND NOT EXISTS/);
  assert.match(sql, /INSERT INTO easyfixer_courses .* WHERE e\.efr_status = 1 AND NOT EXISTS/);
  assert.match(sql, /SET ec\.completion_date = \(SELECT MAX\(w\.update_date\)/);
  assert.doesNotMatch(sql, /NOW\(\)/, 'IST wall-clock, never the server clock');
});
