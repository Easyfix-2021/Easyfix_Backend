const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { migrationPath, readMigration } = require('./helpers/migration-file');

/*
 * A migration moves from migrations/ to migrations/executed/ the day it is
 * applied. A test that names one of those directories AND a specific .sql file
 * therefore breaks on a pure file move — no behaviour changed, but CI goes red
 * and a deploy fails. That has now happened twice (2026-08-26, 2026-09-01), the
 * second time on a test the first fix did not reach because the fix was
 * copy-pasted rather than shared.
 *
 * So the resolution lives in tests/helpers/migration-file.js, and this guard
 * makes hand-rolling it again a build failure rather than a future outage.
 *
 * The predicate is deliberately narrow: it flags naming a MIGRATION DIRECTORY
 * and a SPECIFIC .sql FILE together. Tests that scan the whole directory
 * (migration-status, the QuickSight key parity corpus) name no file and are
 * unaffected — they are not brittle to a move, which is the actual defect.
 */

const TESTS_DIR = __dirname;
const HELPER = path.join('helpers', 'migration-file.js');

// path.join(..., 'migrations', ..., '<name>.sql')  /  '.../migrations/<name>.sql'
const HAND_ROLLED = /(['"])migrations\1\s*,[^)\n]*\.sql|migrations\/(?:executed\/)?[\w.-]+\.sql['"]/;

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

function scanFiles() {
  const out = [];
  for (const entry of fs.readdirSync(TESTS_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.js')) out.push(entry.name);
  }
  return out;
}

test('no test resolves a named migration file by hand — they all use the helper', () => {
  const files = scanFiles();
  assert.ok(files.length > 50, 'the scan should see the whole tests directory');

  const violations = [];
  for (const rel of files) {
    if (rel === path.basename(__filename)) continue; // this file quotes the pattern
    const lines = stripComments(fs.readFileSync(path.join(TESTS_DIR, rel), 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (HAND_ROLLED.test(line)) violations.push(`${rel}:${i + 1}  ${line.trim()}`);
    });
  }

  assert.deepEqual(violations, [],
    'these pin a migration to one directory and break when it is applied — '
    + "use require('./helpers/migration-file') instead");
});

test('the detector actually fires on the shape that broke the build', () => {
  // The exact line from tests/phe-under-audit-migration.test.js before the fix.
  assert.ok(HAND_ROLLED.test(
    "  path.join(__dirname, '..', 'migrations', '2026-08-20-phe-under-audit-read-index.sql'),"));
  // …and on the executed/ half, so "fixing" it by pinning the other directory fails too.
  assert.ok(HAND_ROLLED.test(
    "  path.join(__dirname, '..', 'migrations', 'executed', '2026-08-20-x.sql'),"));
  assert.ok(HAND_ROLLED.test("const p = 'migrations/2026-08-20-x.sql';"));

  // A directory scan names no file: not brittle, not flagged.
  assert.ok(!HAND_ROLLED.test("  const dir = path.join(ROOT, 'migrations');"));
  assert.ok(!HAND_ROLLED.test("  readMigration('2026-08-20-phe-under-audit-read-index.sql');"));
});

test('the helper resolves a migration from EITHER directory', () => {
  // One that has been applied and moved, and one still pending today.
  assert.ok(fs.existsSync(migrationPath('2026-08-20-phe-under-audit-read-index.sql')));
  assert.ok(fs.existsSync(migrationPath('2026-08-18-rewards-earn-lookback-property.sql')));
  assert.match(readMigration('2026-08-20-phe-under-audit-read-index.sql'), /information_schema/i);
});

test('a genuinely missing migration is an ERROR, never a silent empty string', () => {
  assert.throws(() => migrationPath('2020-01-01-never-existed.sql'), /not found in migrations/);
});
