'use strict';

/*
 * Resolve a migration by NAME, from either directory it can legitimately live in.
 *
 * A migration sits in migrations/ while it is pending and moves to
 * migrations/executed/ once it has been applied everywhere
 * (see feedback: "executed/ is frozen, migrations/ is pending"). A test that
 * pins one location therefore fails on the day its migration ships — which is
 * exactly backwards, since an APPLIED migration is the one whose contents
 * matter most.
 *
 * This has now broken CI twice from the same cause: 2026-08-26 (phe-team read
 * indexes) and 2026-09-01 (phe under-audit read index), each time on the commit
 * that moved the file rather than on the commit that changed any behaviour. The
 * first fix was copied by hand into a second test and missed a third, so the
 * resolution lives here ONCE and every migration-reading test uses it. The
 * guard in tests/migration-file-helper.test.js fails the build if a new test
 * hand-rolls the path again.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

/** Absolute path to `filename`, wherever it currently lives. Throws if absent. */
function migrationPath(filename) {
  const candidates = [
    path.join(ROOT, 'migrations', filename),
    path.join(ROOT, 'migrations', 'executed', filename),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      `migration ${filename} not found in migrations/ or migrations/executed/ — `
      + 'it was renamed or deleted, which is a real finding, not a path bug',
    );
  }
  return found;
}

/** The migration's SQL, from either directory. */
function readMigration(filename) {
  return fs.readFileSync(migrationPath(filename), 'utf8');
}

module.exports = { migrationPath, readMigration };
