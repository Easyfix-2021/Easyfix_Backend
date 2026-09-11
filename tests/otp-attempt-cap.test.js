/*
 * THE OTP GUESS CAP — services/otp-attempts.service.js.
 *
 * At most 5 attempts per user within 30 minutes; after that verification is
 * refused until the window ends, and then it resets BY ITSELF. Owner's words:
 * "max 5 times in 30 mins … so that the user does not get blocked in any case".
 * The state lives on the user's otp_details row: failed_attempts counts, and
 * updated_on (an existing column nothing else writes) holds when the window
 * opened.
 *
 * WHAT IS PINNED HERE, and why each one matters:
 *
 *   1. FAIL OPEN while the column is missing. Failing closed would lock every
 *      user of every login surface out the moment code outran the migration.
 *   2. THE PROBE heals itself both ways: an absent column is re-checked within
 *      a minute, and a column that VANISHES (the QA refresh restores the DB) is
 *      forgotten on the first "unknown column" error instead of failing forever.
 *   3. AN ATTEMPT IS CLAIMED BEFORE THE COMPARE, in ONE atomic UPDATE whose WHERE
 *      refuses a full window. Check-then-compare-then-count let a burst of
 *      parallel guesses all pass the check; the parameters' order matters too —
 *      the time arithmetic runs in MySQL, so a swapped one silently turns
 *      "30 minutes" into "never" or "always".
 *   4. retryAfterMinutes ROUNDS UP and is never 0 — "try again in 0 minutes"
 *      while still refusing is the message that makes users think it is broken.
 *   5. EVERY place a stored code is compared goes through a cap, checked per
 *      site against the source's real structure (parsed, not pattern-matched):
 *      the claim, a refusal that RETURNS before the compare, the read after a
 *      miss, the clear after success — all inside the same verify function.
 *      That covers the otp_details verifies (SQL claim) and the two codes with
 *      no otp_details row — the profile/bank OTP and the closing PIN — which
 *      use an in-memory window and must not await between claim and compare.
 *   6. RESEND DOES NOT RESET. No claim or clear may live in a function that does
 *      not itself compare a code — that is where a send path's reset would go.
 *
 * The SQL itself (IF logic, DATE_ADD, the IST Date round-trip through a
 * dateStrings pool) cannot run in a fake pool; it was verified against the QA
 * MySQL when written — see the commit message.
 *
 * Runner: `node --test` (see npm test).
 */

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { installFakePool } = require('./helpers/fake-pool');

const ROOT = path.join(__dirname, '..');
const BOTH = ['failed_attempts', 'updated_on'];

/* Mutable per-test: what the probe, the claim and the window read should answer. */
const scenario = { columns: BOTH, claimed: true, used: 0, inWindow: 1, secsLeft: 1200, failWrites: null };
const reset = () => Object.assign(scenario,
  { columns: BOTH, claimed: true, used: 0, inWindow: 1, secsLeft: 1200, failWrites: null });

const CLAIM = /UPDATE otp_details\s+SET failed_attempts = IF\(/;
const CLEAR = /UPDATE otp_details SET failed_attempts = 0, updated_on = NULL/;

const routes = [
  [/INFORMATION_SCHEMA\.COLUMNS/, () => scenario.columns.map((c) => ({ COLUMN_NAME: c }))],
  [/SELECT failed_attempts,/, () => [{ failed_attempts: scenario.used, in_window: scenario.inWindow, secs_left: scenario.secsLeft }]],
  [CLAIM, () => {
    if (scenario.failWrites) throw scenario.failWrites;
    return { affectedRows: scenario.claimed ? 1 : 0 };
  }],
  [CLEAR, () => ({ affectedRows: 1 })],
];

let fake;
let svc;
const realNow = Date.now;

before(() => {
  fake = installFakePool(routes);
  svc = require('../services/otp-attempts.service');
});

beforeEach(() => {
  Date.now = realNow;
  reset();
  fake.calls.length = 0;
  svc._resetProbeCache();
});

const count = (re) => fake.calls.filter((c) => re.test(c.sql)).length;
const probes = () => count(/INFORMATION_SCHEMA\.COLUMNS/);
const writes = () => count(/UPDATE otp_details/);

// ─── 1. FAIL OPEN ─────────────────────────────────────────────────────────
for (const [label, cols] of [['failed_attempts missing', ['updated_on']], ['both missing', []]]) {
  test(`with ${label} the cap is inert — no lockout, no write`, async () => {
    scenario.columns = cols;
    scenario.used = 99; scenario.claimed = false;   // would lock, if the cap were active
    assert.equal((await svc.claimAttempt(7)).locked, false, 'a missing column must never lock anyone out');
    assert.equal((await svc.lockState(7)).locked, false);
    await svc.clearAttempts(7);                     // must not throw
    assert.equal(probes(), 1, 'positive control: the probe did run and answer "absent"');
    assert.equal(writes(), 0, 'nothing may be written while the cap is inactive');
  });
}

// ─── 2. THE PROBE ─────────────────────────────────────────────────────────
test('present columns are probed once for the life of the process', async () => {
  await svc.lockState(1); await svc.claimAttempt(2); await svc.lockState(3);
  assert.equal(probes(), 1);
});

test('an absent column is re-probed after a minute — the cap switches itself on', async () => {
  let clock = 1_000_000;
  Date.now = () => clock;
  scenario.columns = ['updated_on'];                // QA before the migration
  scenario.used = svc.OTP_MAX_ATTEMPTS; scenario.claimed = false;
  assert.equal((await svc.claimAttempt(7)).locked, false, 'before: fail open');
  assert.equal((await svc.claimAttempt(7)).locked, false, 'inside the recheck window: still cached absent');
  assert.equal(probes(), 1, 'an absent answer is not re-asked on every login');
  scenario.columns = BOTH;                          // the migration runs
  clock += svc.ABSENT_RECHECK_MS + 1;
  assert.equal((await svc.claimAttempt(7)).locked, true, 'after the recheck window the cap takes effect unaided');
});

test('a column that VANISHES is forgotten on the first "unknown column" error', async () => {
  // qa-db-refresh restores QA from a replica. A cached "present" must not turn
  // into a permanent warning per login — the next call re-probes.
  await svc.lockState(7);
  assert.equal(probes(), 1);
  scenario.columns = ['updated_on'];
  scenario.failWrites = Object.assign(new Error("Unknown column 'failed_attempts' in 'field list'"),
    { code: 'ER_BAD_FIELD_ERROR', errno: 1054 });
  assert.equal((await svc.claimAttempt(7)).locked, false, 'the error itself fails open');
  await svc.lockState(7);
  assert.equal(probes(), 2, 'the next call re-probed instead of trusting the stale "present"');
});

// ─── 3. THE CLAIM ─────────────────────────────────────────────────────────
test('an attempt is claimed in ONE atomic UPDATE that refuses a full window', async () => {
  const t0 = Date.now();
  assert.equal((await svc.claimAttempt(7)).locked, false);
  const up = fake.calls.find((c) => CLAIM.test(c.sql));
  assert.ok(up, 'expected the claim');
  assert.match(up.sql, /failed_attempts = IF\(updated_on IS NULL OR updated_on < \?, 1, failed_attempts \+ 1\)/,
    'an expired or unopened window restarts at 1; otherwise increment IN SQL — never a JS-computed value');
  assert.match(up.sql, /updated_on\s+= IF\(updated_on IS NULL OR updated_on < \?, \?, updated_on\)/);
  assert.match(up.sql, /WHERE id = \?\s+AND \(updated_on IS NULL OR updated_on < \? OR failed_attempts < \?\)/,
    'the check and the count must be the SAME statement, or parallel guesses all pass the check');
  assert.ok(up.sql.indexOf('failed_attempts = IF') < up.sql.indexOf('updated_on      = IF'),
    'the count must be assigned BEFORE the window — MySQL evaluates left to right, so both IFs then see the OLD window');
  assert.doesNotMatch(up.sql, /NOW\(\)/, 'the session time_zone is SYSTEM, not IST — every time is a Date param');
  const [cutoff1, cutoff2, now, id, cutoff3, max] = up.params;
  assert.equal(id, 7);
  assert.equal(max, svc.OTP_MAX_ATTEMPTS);
  for (const d of [cutoff1, cutoff2, now, cutoff3]) assert.ok(d instanceof Date);
  assert.equal(cutoff1.getTime(), cutoff2.getTime(), 'both IFs must test the SAME cutoff');
  assert.equal(cutoff3.getTime(), cutoff1.getTime(), 'the WHERE must test the same cutoff as the SET');
  assert.equal(now.getTime() - cutoff1.getTime(), svc.OTP_ATTEMPT_WINDOW_MINUTES * 60 * 1000,
    'the cutoff is exactly one window before now');
  assert.ok(now.getTime() >= t0, 'now is the current time, not a stale value');
});

test('a claim the WHERE refuses is a lock, with the minutes to show', async () => {
  scenario.claimed = false; scenario.used = svc.OTP_MAX_ATTEMPTS; scenario.secsLeft = 600;
  assert.deepEqual(await svc.claimAttempt(7), { locked: true, attemptsRemaining: 0, retryAfterMinutes: 10 });
});

test('a refused claim on a row that has gone reads as unlocked, not locked', async () => {
  scenario.claimed = false; scenario.inWindow = 0;
  assert.equal((await svc.claimAttempt(7)).locked, false);
});

test('success closes the window: count to 0, updated_on back to NULL', async () => {
  await svc.clearAttempts(7);
  const clr = fake.calls.find((c) => CLEAR.test(c.sql));
  assert.ok(clr, 'expected the clear');
  assert.deepEqual(clr.params, [7]);
});

test('a claim that fails to write does NOT fail the verify', async () => {
  scenario.failWrites = new Error('deadlock');
  assert.equal((await svc.claimAttempt(7)).locked, false, 'must swallow, not throw');
});

// ─── 4. THE STATE, AS THE USER WILL SEE IT ────────────────────────────────
test('under the limit: not locked, and says how many attempts are left', async () => {
  scenario.used = 3;
  assert.deepEqual(await svc.lockState(7), { locked: false, attemptsRemaining: 2, retryAfterMinutes: null });
});

test('at the limit: locked, with minutes rounded UP and never zero', async () => {
  scenario.used = svc.OTP_MAX_ATTEMPTS;
  scenario.secsLeft = 61;          // 1m01s left → must say 2, not 1
  assert.equal((await svc.lockState(7)).retryAfterMinutes, 2);
  scenario.secsLeft = 5;           // 5s left → must say 1, not 0
  assert.equal((await svc.lockState(7)).retryAfterMinutes, 1);
  scenario.secsLeft = -3;          // clock skew past the end → still 1, never 0 or negative
  assert.equal((await svc.lockState(7)).retryAfterMinutes, 1);
});

test('a window that has CLOSED counts as zero, whatever the column holds', async () => {
  // The lock lifts on its own. It also covers the counts the first design left
  // on Production rows: updated_on is NULL there, so they read as no window.
  scenario.used = 5; scenario.inWindow = 0;
  const st = await svc.lockState(7);
  assert.equal(st.locked, false);
  assert.equal(st.attemptsRemaining, svc.OTP_MAX_ATTEMPTS);
});

// ─── 5 + 6. EVERY VERIFY SITE, BY STRUCTURE ───────────────────────────────
/*
 * Parsed with espree (ESLint's parser, already installed for `npm run lint`)
 * so each check is scoped to the function that actually does the verify. A
 * text window between neighbouring compares let a claim or clear drift into a
 * send path and still pass.
 */
const espree = require(require.resolve('espree', { paths: [require.resolve('eslint')] }));

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return jsFiles(p);
    return d.name.endsWith('.js') ? [p] : [];
  });
}
function walk(node, parent, visit) {
  if (!node || typeof node.type !== 'string') return;
  node.parent = parent;
  visit(node);
  for (const [k, v] of Object.entries(node)) {
    if (k === 'parent') continue;
    if (Array.isArray(v)) v.forEach((c) => walk(c, node, visit));
    else if (v && typeof v.type === 'string') walk(v, node, visit);
  }
}
const isFn = (n) => /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(n.type);
const enclosingFn = (n) => { let p = n.parent; while (p && !isFn(p)) p = p.parent; return p; };
const inside = (inner, outer) => inner.range[0] >= outer.range[0] && inner.range[1] <= outer.range[1];
const isCall = (n, [obj, fn]) => !!n && n.type === 'CallExpression' && n.callee.type === 'MemberExpression'
  && n.callee.object.type === 'Identifier' && n.callee.object.name === obj
  && n.callee.property.name === fn;
/*
 * The structural marker: a compare of a STORED code against the submitted one.
 * Two shapes exist — `Number(row.otp | row.profile_update_otp) !== …` (the OTP
 * verifies) and `jobPin !== submittedPin` (the closing PIN, routes/mobile).
 * tech-auth's second, in-lock compare (`current.otp`) is deliberately not
 * matched — it fires on a concurrent re-issue, not a guess.
 */
const storedVsSubmitted = (n) => n.type === 'BinaryExpression' && (
  (n.left.type === 'CallExpression' && n.left.callee.name === 'Number'
    && n.left.arguments[0] && n.left.arguments[0].type === 'MemberExpression'
    && n.left.arguments[0].object.name === 'row'
    && /^(otp|profile_update_otp)$/.test(n.left.arguments[0].property.name))
  || (n.left.type === 'Identifier' && n.left.name === 'jobPin'
    && n.right.type === 'Identifier' && n.right.name === 'submittedPin'));
// A refusing verify: `if (stored !== submitted) { … }`.
const isCompare = (n) => storedVsSubmitted(n) && n.operator === '!==';
// A verdict-only check: check-in's `jobPin === submittedPin` answers pinMatched
// and never refuses. It spends the same budget, so it is a verify site too.
const isVerdict = (n) => storedVsSubmitted(n) && n.operator === '===';
/*
 * How each store is capped. otp_details codes go through the SQL claim
 * (services/otp-attempts.service.js). The two codes with no otp_details row —
 * the profile/bank OTP on tbl_easyfixer, the closing PIN on tbl_job — use an
 * in-memory attemptWindow (middleware/rate-limit.js), whose claim is atomic
 * only if NO await separates it from the compare.
 */
const SQL = { claim: ['otpAttempts', 'claimAttempt'], read: ['otpAttempts', 'lockState'],
  clear: ['otpAttempts', 'clearAttempts'], lockMark: /OTP_ATTEMPTS_EXCEEDED/, inMemory: false };
const API_BY_FILE = {
  'services/easyfixer-profile-otp.service.js': { claim: ['profileOtpAttempts', 'claim'], read: ['profileOtpAttempts', 'state'],
    clear: ['profileOtpAttempts', 'clear'], lockMark: /OTP_ATTEMPTS_EXCEEDED/, inMemory: true },
  'routes/mobile/index.js': { claim: ['checkoutPinAttempts', 'claim'], read: ['checkoutPinAttempts', 'state'],
    clear: ['checkoutPinAttempts', 'clear'], lockMark: /pinLocked/, inMemory: true },
};
const apiFor = (file) => API_BY_FILE[file] || SQL;

const scan = { files: 0, sites: [], verdicts: [], calls: [], legacy: [] };
for (const f of [...jsFiles(path.join(ROOT, 'services')), ...jsFiles(path.join(ROOT, 'routes'))]) {
  const rel = path.relative(ROOT, f);
  const ast = espree.parse(fs.readFileSync(f, 'utf8'), { ecmaVersion: 'latest', sourceType: 'script', range: true, loc: true });
  scan.files += 1;
  walk(ast, null, (n) => {
    if (isCompare(n)) scan.sites.push({ file: rel, node: n, fn: enclosingFn(n) });
    if (isVerdict(n)) scan.verdicts.push({ file: rel, node: n, fn: enclosingFn(n) });
    for (const api of [SQL, ...Object.values(API_BY_FILE)]) {
      if (isCall(n, api.claim)) scan.calls.push({ file: rel, kind: 'claim', node: n, fn: enclosingFn(n) });
      if (isCall(n, api.clear)) scan.calls.push({ file: rel, kind: 'clear', node: n, fn: enclosingFn(n) });
    }
    if (isCall(n, ['otpAttempts', 'recordFailedAttempt'])) scan.legacy.push({ file: rel, node: n });
  });
}
const where = (s) => `${s.file}:${s.node.loc.start.line}`;
function collect(root, pred) { const out = []; walk(root, root.parent, (n) => { if (pred(n)) out.push(n); }); return out; }

test('the parse saw the codebase — positive control on the locator', () => {
  assert.ok(scan.files > 100, `expected the services and routes, parsed ${scan.files} files`);
  const bySql = scan.sites.filter((s) => !API_BY_FILE[s.file]).length;
  assert.ok(bySql >= 6, `expected at least 6 otp_details compare sites, found ${bySql}`);
  for (const file of Object.keys(API_BY_FILE)) {
    assert.equal(scan.sites.filter((s) => s.file === file).length, 1, `${file}: expected exactly its one compare site`);
  }
});

test('every compare CLAIMS first, REFUSES a lock by returning, reads after a miss, clears after success', () => {
  for (const s of scan.sites) {
    const at = where(s);
    const api = apiFor(s.file);
    assert.ok(s.fn, `${at}: compare outside any function`);
    // (a) the claim, before the compare, in the same function
    const claim = collect(s.fn, (n) => n.type === 'VariableDeclarator' && n.init
      && (isCall(n.init, api.claim) || (n.init.type === 'AwaitExpression' && isCall(n.init.argument, api.claim)))
      && n.range[1] < s.node.range[0]);
    assert.equal(claim.length, 1, `${at}: expected exactly one \`const x = ${api.claim.join('.')}(...)\` before the compare`);
    const v = claim[0].id.name;
    // (a') in memory, nothing may await between the claim and the compare
    if (api.inMemory) {
      const gap = collect(s.fn, (n) => n.type === 'AwaitExpression' && n.range[0] > claim[0].range[1] && n.range[1] < s.node.range[0]);
      assert.equal(gap.length, 0, `${at}: an await between the in-memory claim and the compare lets parallel guesses overshoot`);
    }
    // (b) `if (x.locked) … return` between the claim and the compare
    const refusal = collect(s.fn, (n) => n.type === 'IfStatement'
      && n.test.type === 'MemberExpression' && n.test.object.name === v && n.test.property.name === 'locked'
      && n.range[0] > claim[0].range[1] && n.range[1] < s.node.range[0]
      && (n.consequent.type === 'ReturnStatement'
        || (n.consequent.type === 'BlockStatement' && n.consequent.body.some((b) => b.type === 'ReturnStatement'))));
    assert.equal(refusal.length, 1,
      `${at}: a locked claim must be REFUSED — \`if (${v}.locked) return …\` — before the code is compared`);
    // (c) the miss branch reads the state and says what is left
    let ifNode = s.node.parent; while (ifNode && ifNode.type !== 'IfStatement') ifNode = ifNode.parent;
    assert.ok(ifNode && inside(s.node, ifNode.test), `${at}: the compare must be an if's condition`);
    const miss = ifNode.consequent;
    assert.equal(collect(miss, (n) => isCall(n, api.read)).length, 1, `${at}: a miss must read ${api.read.join('.')} for what to say`);
    const words = JSON.stringify(collect(miss, (n) => n.type === 'Literal' || n.type === 'Identifier').map((n) => n.value || n.name));
    assert.match(words, api.lockMark, `${at}: the 5th miss must say when the lock lifts`);
    assert.match(words, /attemptsRemaining/, `${at}: a miss must say how many attempts are left`);
    // (d) success clears, after the miss branch, in the same function
    const clear = collect(s.fn, (n) => isCall(n, api.clear) && n.range[0] > ifNode.range[1]);
    assert.equal(clear.length, 1, `${at}: success must clear the window exactly once`);
  }
});

test('a verdict-only PIN check claims first too, with no await before the compare', () => {
  // check-in's pinMatched: without a claim it was an unlimited oracle for the close.
  assert.ok(scan.verdicts.length >= 1, 'positive control: the check-in verdict was found');
  for (const s of scan.verdicts) {
    const at = where(s);
    const api = apiFor(s.file);
    const claims = collect(s.fn, (n) => isCall(n, api.claim) && n.range[1] < s.node.range[0]);
    assert.equal(claims.length, 1, `${at}: a verdict must be claimed against ${api.claim.join('.')} first`);
    const gap = collect(s.fn, (n) => n.type === 'AwaitExpression' && n.range[0] > claims[0].range[1] && n.range[1] < s.node.range[0]);
    assert.equal(gap.length, 0, `${at}: nothing may await between the claim and the compare`);
  }
});

test('no claim or clear outside a verify — so neither a Resend nor anything else resets the count', () => {
  const verifyFns = [...scan.sites, ...scan.verdicts].map((s) => s.fn);
  const stray = scan.calls.filter((c) => !verifyFns.some((f) => inside(c.node, f)));
  assert.deepEqual(stray.map((c) => `${c.file}:${c.node.loc.start.line} ${c.kind}`), [],
    'a claim or clear in a function that compares no code is a reset outside a verify');
  assert.equal(scan.legacy.length, 0,
    'recordFailedAttempt is gone — counting after the compare is the race the claim replaced');
});
