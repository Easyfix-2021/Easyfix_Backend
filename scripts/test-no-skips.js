#!/usr/bin/env node
/**
 * `npm test`, with a skipped test treated as a FAILURE.
 *
 * ─── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * `node --test` EXITS 0 WHEN TESTS ARE SKIPPED. Measured, not recalled — a
 * two-test probe (1 pass, 1 `t.skip`) exits 0 under every built-in reporter
 * (tap, spec, dot, junit, lcov), and there is no `--fail-on-skip` flag. So a
 * skip is invisible to any exit-code gate, which is how three cross-repo parity
 * tests sat in this suite committed, green, and never once executed in the run
 * that gates the deploy: they read files out of Easyfix_CRM_UI, CI checked out
 * only this repo, and every CI run therefore reported them as skipped inside a
 * green tick that nobody reads. A skipped test is a guard that is not running.
 *
 * The repair for those three is the CRM clone step in the workflows plus the
 * `process.env.CI` hard-fail in the tests themselves; that makes skipped==0
 * true by construction. THIS wrapper is the ratchet: it is what catches the
 * NEXT `t.skip` somebody adds, and it is what would have caught those three.
 *
 * ─── WHY A WRAPPER AND NOT SOMETHING CLEVERER ──────────────────────────────
 *
 * Every other gate in this repo is `node scripts/<name>.js` (build-check,
 * schema-verify, env-verify, migration-status, verify-phantom-columns,
 * verify-scope-predicates, offline-reliability-sync), and three of those
 * already spawn children — this is the house style, not a new idea.
 *
 * Rejected: piping to grep. npm runs scripts under `sh`, which on the Ubuntu
 * runner is dash, and dash has no `set -o pipefail` — the pipe would mask the
 * runner's own exit code, so a genuinely FAILING suite would go green. That
 * exact "pipe masks exit code" bug has already bitten this codebase once.
 *
 * Rejected: a custom reporter setting process.exitCode. It runs inside the
 * runner's process, so its final flush raced `--test-force-exit`'s timed
 * process.exit(). That flag is gone now (see below), but the objection stands
 * on its own: clever, and someone decodes it at 3am.
 *
 * ─── THE PARSE, AND WHY IT MATCHES TWO FORMATS ─────────────────────────────
 *
 * Node picks its default reporter BY VERSION, and this is the trap. Same probe
 * suite, same non-TTY pipe:
 *
 *   Node v22.16.0  →  tap:   `ok 2 - name # SKIP reason`  /  `# skipped 2`
 *   Node v24.3.0   →  spec:  `﹣ name (0.06ms) # reason`   /  `ℹ skipped 2`
 *
 * The workflows pin `node-version: 20` and this machine has 22 and 24, so local
 * and CI are on different majors and Node 20 could not be measured here. Rather
 * than assume one format — or pin `--test-reporter` and change what every CI log
 * looks like — both sigils are matched. That is strictly less work than being
 * wrong on the runner.
 *
 * A missing summary line is a FAILURE, not a pass: a checker that cannot see
 * anything must not report clean.
 *
 * Usage (from package.json):  node scripts/test-no-skips.js tests/*.test.js
 * The wrapper supplies --test and the close-pool preload; pass only the files.
 */
/*
 * ─── THE FLOOR, AND THE RUN THAT MADE IT NECESSARY ─────────────────────────
 *
 * On 2026-09-04 a run reported `tests 2691 · pass 2691 · fail 0 · skipped 0`
 * and exited 0. The suite has 2693. Two tests had not run — and they were the
 * LAST TWO DECLARED in job-export-filters.test.js (lines 753 and 761 of 766),
 * with the other 46 present. That is a truncated tail, not a missing file.
 *
 * The cause was the `--test-force-exit` this wrapper used to pass: it exited
 * the runner once the tests it KNEW about were done, and under load the last
 * file's remaining results never landed.
 *
 * FIXED 2026-09-04. The flag is gone. It could not simply be dropped — without
 * it the suite hung — so the hang was traced instead of worked around:
 * `process.getActiveResourcesInfo()` showed that requiring db.js ALONE arms
 * mysql2's idleTimeout reaper, and that single Timeout was the only thing
 * holding the loop open (services added nothing). tests/helpers/close-pool.js
 * now closes the pool in a root `after` hook, preloaded via --require into
 * every test file's child process, so the runner exits on its own and every
 * result lands.
 *
 * MIN_TESTS stays. The floor is what CAUGHT this, and it is the only thing
 * that would notice if the truncation ever returned by another route.
 *
 * Nothing else could see it. Every counter was internally consistent with the
 * truncation: zero failed, zero skipped, and a total that is only wrong if you
 * already know what it should be. Six consecutive re-runs then gave 2693, so
 * this is rare — which makes it worse, not better. A gate that silently drops
 * tests occasionally is one that will drop the wrong two eventually.
 *
 * So the wrapper is told what it should be. MIN_TESTS is a RATCHET, in the same
 * spirit as the skip check: adding tests never touches it, because the total
 * only rises. It has to be lowered by hand when tests are deliberately deleted,
 * and that is the point — a suite that shrinks should say so out loud.
 */
const MIN_TESTS = 2693;

const { spawn } = require('node:child_process');

const child = spawn(
  process.execPath,
  // `--require` loads tests/helpers/close-pool.js into EVERY test file's child
  // process, where a root `after` hook closes the DB pool. That is what lets
  // the runner exit on its own — see that file for the measurement showing
  // mysql2's idleTimeout reaper is the only handle holding the loop open.
  //
  // `--test-force-exit` USED TO BE HERE and is deliberately gone. It exited the
  // runner once the tests it knew about had finished, so under load the last
  // file's results never landed: a truncated run reporting `fail 0, skipped 0`
  // and a total nobody would question. Three runs of ea2705a counted 2651, 2661
  // and 2693. Putting the flag back reintroduces exactly that, and MIN_TESTS
  // below is the only thing that would notice.
  ['--test', '--require', require.resolve('../tests/helpers/close-pool.js'), ...process.argv.slice(2)],
  // stdout piped so it can be parsed, stderr inherited. Output is written
  // through as it arrives rather than buffered, so a 20-second 2593-test run
  // still scrolls live in the Actions log.
  { stdio: ['inherit', 'pipe', 'inherit'] },
);

const skippedTests = [];
const todoTests = [];
let skippedCount = null;
let todoCount = null;
let testCount = null;
let partial = '';

// The whole stream is scanned line by line rather than a trailing buffer: with
// ~2600 tests the skip lines are thousands of lines above the summary, so a
// tail-only parse would report the count and none of the names.
function scan(line) {
  // tap: `ok 4 - name # SKIP reason`   ·   spec: `﹣ name (0.06ms) # reason`
  // The raw line is kept verbatim rather than picking the name out of it — the
  // line already carries the skip REASON, which is the actionable half.
  if (/^ok \d+ - .* # SKIP\b/.test(line) || /^\s*﹣ /.test(line)) skippedTests.push(line.trim());
  // `test.todo()` is the same defect wearing a different word: a guard that is
  // not running. tap: `ok 2 - name # TODO`  ·  spec: `✔ name (0.05ms) # TODO`.
  if (/\s# TODO\b/.test(line)) todoTests.push(line.trim());
  // tap: `# skipped 2`   ·   spec: `ℹ skipped 2`. Anchored at column 0 so a
  // nested TAP subtest summary (indented) cannot overwrite the real total.
  const m = /^(?:#|ℹ) skipped (\d+)\s*$/.exec(line);
  if (m) skippedCount = Number(m[1]);
  const t = /^(?:#|ℹ) todo (\d+)\s*$/.exec(line);
  if (t) todoCount = Number(t[1]);
  // tap: `# tests 2693`  ·  spec: `ℹ tests 2693`. Same column-0 anchor as the
  // others, so a nested subtest summary cannot overwrite the real total.
  const n = /^(?:#|ℹ) tests (\d+)\s*$/.exec(line);
  if (n) testCount = Number(n[1]);
}

child.stdout.on('data', (buf) => {
  process.stdout.write(buf);
  const lines = (partial + buf).split('\n');
  partial = lines.pop();
  for (const line of lines) scan(line);
});

child.on('close', (code, signal) => {
  if (partial) scan(partial);
  // 'close' fires only after the stdio streams have closed, so every data
  // event has already been scanned by this point.
  if (signal) {
    console.error(`\ntest runner was killed by ${signal}`);
    process.exit(1);
  }
  // A real test failure is reported by the runner and passed straight through —
  // this wrapper never masks it, and never adds noise on top of it.
  if (code !== 0) process.exit(code);
  if (skippedCount === null || todoCount === null || testCount === null) {
    console.error('\ncould not find the "tests"/"skipped"/"todo" summary lines in the test output.'
      + '\nThe runner exited 0, but this wrapper cannot confirm zero skips, so it fails'
      + '\nrather than reporting a clean it did not verify. Has the reporter format changed?');
    process.exit(1);
  }

  /*
   * THE COUNTER IS NOT ENOUGH — measured 2026-09-02, and this is the whole
   * reason the checks below are not just `skippedCount > 0`.
   *
   *   describe.skip('name', () => { test('never runs', ...) })
   *     ﹣ name (0.24ms) # SKIP
   *     ℹ tests 0 · ℹ suites 1 · ℹ skipped 0        <- the counter says ZERO
   *
   * Node counts a skipped SUITE's inner tests not at all, so an entirely
   * disabled file reported `skipped 0` and this wrapper exited 0 — the exact
   * defect it exists to prevent, living inside it. The `# SKIP` line was already
   * being collected and was then thrown away by an early `if (count === 0)`.
   *
   *   test.todo('a guard nobody wrote yet')
   *     ✔ a guard nobody wrote yet (0.05ms) # TODO
   *     ℹ skipped 0 · ℹ todo 1                      <- passes a skip-only gate
   *
   * A todo is a guard that is not running under a friendlier name, so it fails
   * here too. Both are reported separately, because the fix differs: a skip
   * usually means an unmet precondition, a todo means unwritten work.
   */
  const problems = [];
  if (testCount < MIN_TESTS) {
    problems.push([`only ${testCount} test(s) ran; this suite has at least ${MIN_TESTS}.`,
      'Nothing failed and nothing was skipped, which is exactly what a TRUNCATED run looks',
      'like: the counters only count what the runner saw finish.',
      '',
      'DO NOT JUST RE-RUN. That used to be the advice, because --test-force-exit made',
      'this intermittent. That flag is gone (2026-09-04) and three consecutive runs now',
      `give ${MIN_TESTS} every time, so a short count here is REPRODUCIBLE and means`,
      'something real. Re-rolling until it passes only hides it — and cost two failed',
      'deploys the day this was written.',
      '',
      'Three causes, in the order worth checking —',
      '  · tests were deliberately deleted. Then lower MIN_TESTS in this file, in the same',
      '    commit that removes them, so the suite never quietly shrinks again.',
      '  · a test file no longer exits on its own, so the runner never collected its',
      '    results. Find it with: for f in tests/*.test.js; do node --test "$f"; done',
      '    and watch for one that does not return. The usual cause is a module that owns',
      '    a pool or timer and is dropped from require.cache (see tests/db-read-pool.test.js)',
      '    or never closed (see tests/helpers/close-pool.js).',
      '  · something re-introduced --test-force-exit, or another flag that exits early.',
      '',
      'Note this wrapper is meant for the whole suite; a deliberate subset run will trip it.',
    ].join('\n'));
  }
  if (skippedCount > 0 || skippedTests.length > 0) {
    problems.push([`${Math.max(skippedCount, skippedTests.length)} test(s) or suite(s) SKIPPED.`,
      'A skipped test is a guard that is not running, so this is a failure. Either make',
      'it able to run here, or delete it — for the cross-repo parity tests that means the',
      'workflow must clone the sibling repo and set its directory env var.',
      ...skippedTests.map((l) => `  ${l}`)].join('\n'));
  }
  if (todoCount > 0 || todoTests.length > 0) {
    problems.push([`${Math.max(todoCount, todoTests.length)} test(s) marked TODO.`,
      'A todo test never runs and never fails, so it protects nothing. Write it or drop it.',
      ...todoTests.map((l) => `  ${l}`)].join('\n'));
  }
  if (problems.length === 0) return;
  console.error(`\n${problems.join('\n\n')}\n`);
  process.exit(1);
});
