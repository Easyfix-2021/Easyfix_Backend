'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/*
 * The message-literal audits, and the proof that they work.
 *
 * WHAT THEY GUARD. On 2026-09-01 the employee-code prefix changed from EF to E.
 * The commit parameterised the regex, the padding and the SQL, and left three
 * copies of `must be "EF" followed by exactly 6 digits (e.g. EF000123)` behind.
 * All three shipped. Validation was never wrong — the operator was told to type
 * a code the same regex rejects, which is a loop with no exit, and the suite
 * could not see it because the message tests asserted only the half of the
 * sentence that never drifts.
 *
 * WHY THE CONTROL COMES FIRST, AND IS NOT OPTIONAL. Earlier versions of these
 * checks reported ZERO three separate times, and all three zeros were false: a
 * scope rule that excluded the only case worth catching, a `git log -L /re/,+0`
 * range git rejects as empty (every lookup threw into a catch returning []), and
 * a /g regex carrying lastIndex between files. A checker reporting 0 because it
 * crashed is indistinguishable from one reporting 0 because the code is clean.
 *
 * So this file never asserts the repo is clean without first proving, on a
 * fixture built here, that a planted defect IS found. If someone breaks the
 * audit, these tests fail — rather than quietly passing forever. Do not reorder
 * them so the repo assertion runs alone, and do not delete the fixture because
 * "the real run already passes": that is precisely the reasoning that produced
 * three false cleans.
 */
const AUDIT = path.join(__dirname, '..', 'scripts', 'audit-message-literals.mjs');

// ── the fixture ──────────────────────────────────────────────────────────
/*
 * A throwaway git repo, because the RETIRED check reads history: it asks what a
 * constant USED to hold. Two commits is the minimum that has a "used to".
 */
function buildFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msglit-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');

  // v1 — the prefix is the RETIRED value
  fs.writeFileSync(path.join(dir, 'home.js'),
    "'use strict';\nconst WIDGET_PREFIX = 'EF';\nconst WIDGET_CAP = 500;\nmodule.exports = { WIDGET_PREFIX, WIDGET_CAP };\n");
  git('add', '-A'); git('commit', '-qm', 'v1');

  // v2 — corrected, exactly as the real change was
  fs.writeFileSync(path.join(dir, 'home.js'),
    "'use strict';\nconst WIDGET_PREFIX = 'E';\nconst WIDGET_CAP = 500;\nmodule.exports = { WIDGET_PREFIX, WIDGET_CAP };\n");
  git('add', '-A'); git('commit', '-qm', 'v2');
  return dir;
}

function run(dir, flag) {
  const r = execFileSync(process.execPath, [AUDIT, dir, ...(flag ? [flag] : [])],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return r;
}
function runAllowingFindings(dir, flag) {
  try { return run(dir, flag); } catch (e) { return `${e.stdout || ''}${e.stderr || ''}`; }
}

// ── 1. the control: a planted defect MUST be found ───────────────────────

test('RETIRED fires on a stale reference across a module boundary', () => {
  const dir = buildFixture();
  /*
   * The consumer imports something ELSE from the home module — not the prefix.
   * That is the exact shape of the real bug and the reason a name-scoped rule
   * could not see it: a file that hardcodes a value is by definition not
   * importing the constant for it.
   */
  fs.writeFileSync(path.join(dir, 'consumer.js'),
    "'use strict';\nconst { WIDGET_CAP } = require('./home');\n"
    + "// The id must be EF followed by six digits.\n"
    + "module.exports = { WIDGET_CAP };\n");

  const out = runAllowingFindings(dir, '--retired');
  assert.match(out, /consumer\.js:3/, 'the stale comment must be located');
  assert.match(out, /WIDGET_PREFIX/, 'and attributed to the constant that moved');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('LATENT fires when a message spells out a constant from a module it imports', () => {
  const dir = buildFixture();
  fs.writeFileSync(path.join(dir, 'consumer.js'),
    "'use strict';\nconst { WIDGET_CAP } = require('./home');\n"
    + "function f() { throw new Error('at most 500 widgets'); }\n"
    + "module.exports = { f, WIDGET_CAP };\n");

  const out = runAllowingFindings(dir, '--latent');
  assert.match(out, /consumer\.js:3/);
  assert.match(out, /WIDGET_CAP/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 2. precision: correct code must NOT be reported ──────────────────────
/*
 * A control that only proves the checker fires is half a control. One that
 * cries wolf gets allowlisted into uselessness, which is the same outcome as
 * not having it — so the cases the audit must stay quiet about are pinned too.
 */
test('RETIRED stays quiet on prose that declares itself historical', () => {
  const dir = buildFixture();
  fs.writeFileSync(path.join(dir, 'consumer.js'),
    "'use strict';\nconst { WIDGET_CAP } = require('./home');\n"
    + "// The prefix used to be\n// EF, and is not that any more.\n"
    + "module.exports = { WIDGET_CAP };\n");

  const out = run(dir, '--retired');   // throws if it exits non-zero
  assert.match(out, /: 0$/m, 'a marked historical note is correct prose, not a finding');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the historical marker is read across a wrapped comment block, not one line', () => {
  const dir = buildFixture();
  /*
   * Two correct comments in whatsapp-conversation.service.js were reported stale
   * on exactly this: the marker ended one line and the retired name began the
   * next. Prose wraps; a per-line test is wrong.
   */
  fs.writeFileSync(path.join(dir, 'consumer.js'),
    "'use strict';\nconst { WIDGET_CAP } = require('./home');\n"
    + "/*\n * It used to be the two-letter form\n * (prefix EF) before the correction.\n */\n"
    + "module.exports = { WIDGET_CAP };\n");

  assert.match(run(dir, '--retired'), /: 0$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unrelated module does not inherit the constant — scope is the module graph', () => {
  const dir = buildFixture();
  // imports nothing from home.js, so home.js's retired value is not its business
  fs.writeFileSync(path.join(dir, 'stranger.js'),
    "'use strict';\n// EF is a perfectly ordinary thing to say here.\nmodule.exports = {};\n");

  assert.match(run(dir, '--retired'), /: 0$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a constant with no committed history is "no past values", not an error', () => {
  const dir = buildFixture();
  /*
   * git log -L answers "regexec() failed to match" when the declaration is not
   * in the file at HEAD — i.e. the constant is new and uncommitted. That is an
   * ANSWER. It surfaced for real against another session's in-flight work, and
   * conflating it with a failure would either spam findings or, if swallowed,
   * hide every genuine lookup failure behind an empty result.
   */
  fs.appendFileSync(path.join(dir, 'home.js'), "const BRAND_NEW = 'ZZTOP';\n");
  assert.match(run(dir, '--retired'), /: 0$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a genuine lookup failure is still a FINDING, never a silent "no history"', () => {
  /*
   * The other half of the branch above — and the half that has already failed
   * once: an earlier version caught EVERY git error and returned [], so a broken
   * invocation reported the repo clean.
   *
   * It matters more since 2026-09-01, when the two cases stopped being told
   * apart by the text of git's error. That text is not git's to begin with: git
   * prints whatever regerror(3) hands it, and regerror is libc-dependent — BSD
   * says "regexec() failed to match", glibc says "No match". The check was
   * therefore macOS-only and reddened CI on Ubuntu. The split is now made by
   * asking git whether the declaration is committed, so this control pins that
   * the rewrite did not buy platform-independence by swallowing real failures.
   *
   * A directory that is not a git repo makes every lookup fail for real.
   */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msglit-nogit-'));  // deliberately NOT git init
  fs.writeFileSync(path.join(dir, 'a.js'),
    "'use strict';\nconst SOME_PREFIX = 'QQ';\nmodule.exports = { SOME_PREFIX };\n");

  const out = runAllowingFindings(dir, '--retired');
  assert.match(out, /history lookup failed/, 'a broken lookup must surface, not read as clean');
  assert.doesNotMatch(out, /: 0$/m, 'and must never be reported as zero findings');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 3. only now, the repo itself ─────────────────────────────────────────

test('this repo names no retired value and hardcodes no owned one', () => {
  const root = path.join(__dirname, '..');
  let out;
  try {
    out = run(root);
  } catch (e) {
    assert.fail(`the audit reported findings:\n${e.stdout || ''}${e.stderr || ''}`);
  }
  assert.match(out, /RETIRED[^\n]*: 0/);
  assert.match(out, /LATENT[^\n]*: 0/);
});
