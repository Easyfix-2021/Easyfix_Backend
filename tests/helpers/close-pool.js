'use strict';

/*
 * Root teardown: close the DB pool so the runner can exit on its own.
 *
 * ─── WHAT THIS REPLACES ────────────────────────────────────────────────────
 *
 * scripts/test-no-skips.js used to pass `--test-force-exit`, because without it
 * the suite hung forever. That flag calls process.exit() once the tests the
 * runner KNOWS about have finished, so under load the last file's remaining
 * results never land — a TRUNCATED run that reports `fail 0, skipped 0` and a
 * total that is only wrong if you already know what it should be.
 *
 * It was not theoretical. Three runs of one commit (ea2705a) counted 2651,
 * 2661 and 2693 tests. Locally the same suite gave 2688, 2693, 2693. Every one
 * of those said zero failures.
 *
 * ─── WHY THE POOL, MEASURED ────────────────────────────────────────────────
 *
 * `process.getActiveResourcesInfo()` after a bare require:
 *
 *   baseline                     []
 *   after require('../../db')    ["Timeout"]
 *   after requiring services     ["Timeout"]   (services add nothing)
 *
 * mysql2's createPool arms an internal reaper for `idleTimeout`, and that timer
 * alone holds the loop open. It is created at REQUIRE time — no connection is
 * ever made — so every test file that touches a service inherits it, whether or
 * not it talks to a database. pool.end() clears it.
 *
 * A few files (tests/mobile-*.test.js) already did this by hand. Doing it here
 * covers the rest without editing a hundred files, and new files get it for
 * free — which matters, because forgetting it produces a hang, and the fix for
 * a hang is exactly the flag that caused the truncation.
 *
 * Loaded via `--require` from the wrapper, so it applies to every test file's
 * child process. Root `after` hooks run last, after each file's own hooks, so a
 * file that closes the pool itself still works: the second end() is a no-op we
 * swallow.
 */

const path = require('node:path');
const { after } = require('node:test');

/*
 * Every module that owns a connection pool, with its own closer. There are TWO
 * — the primary and the read replica — and a scan of all 220 test files showed
 * exactly which files still hung once only the primary was closed:
 * tests/db-read-pool.test.js was one of them, because it requires db-read.js
 * and that arms a SECOND mysql2 timer nothing was clearing.
 *
 * Adding a third pool means adding a line here. The symptom of forgetting is a
 * hang, and the tempting cure for a hang is putting --test-force-exit back —
 * which silently reinstates the truncation this whole file exists to remove.
 */
const POOL_MODULES = [
  ['db.js', 'closePool'],
  ['db-read.js', 'closeReadPool'],
];

/*
 * ─── WHY THIS DOES NOT `require` db.js ─────────────────────────────────────
 *
 * `--require` loads this file into the RUNNER PARENT as well as into every
 * test-file child. The parent has no test context, so its root `after` never
 * runs. A version of this file that required db.js at the top therefore armed
 * mysql2's timer in a process that could never clear it — and the parent hung
 * forever, exactly the failure it was written to remove. Measured: the child
 * logged its after hook and exited; the parent did not.
 *
 * So read the module CACHE instead. If this process never loaded db.js — the
 * parent, and any test file that touches no service — there is no pool and
 * nothing to close. Requiring it here would CREATE the very handle being
 * cleaned up.
 */
/*
 * ─── PARENT PROCESS: REGISTER NOTHING ──────────────────────────────────────
 *
 * `--require` loads this file into the runner PARENT as well as every test-file
 * child. Calling after() in the parent makes it emit a test run of its own —
 * an empty one — so the output ends with a SECOND summary reading
 * `tests 0 · pass 0`. scripts/test-no-skips.js parses the last summary it sees,
 * read 0, and failed the build against MIN_TESTS while all 2693 tests had in
 * fact passed. Measured: parent has no NODE_TEST_CONTEXT, children are
 * "child-v8".
 *
 * The parent also has no pool to close — it never loads a service — so there is
 * nothing lost by staying out of it entirely.
 */
if (!process.env.NODE_TEST_CONTEXT) return;

after(async () => {
  for (const [file, closerName] of POOL_MODULES) {
    const cached = require.cache[path.join(__dirname, '..', '..', file)];
    const close = cached && cached.exports && cached.exports[closerName];
    if (typeof close !== 'function') continue;
    try {
      await close();
    } catch (_) {
      // Already closed by a file's own hook (tests/mobile-*.test.js do this),
      // or never opened. Either way the timer is gone, which is all this
      // achieves.
    }
  }
});
