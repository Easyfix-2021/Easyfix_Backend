/*
 * FE↔BE wire-contract parity — the backend half.
 *
 * Mirror of Easyfix_CRM_UI/tests/wire-contract.test.js. Read that file's header
 * for the full rationale; the short version:
 *
 * A handful of STRING LITERALS must be byte-identical in this repo and in
 * Easyfix_CRM_UI, because they land in a shared database column or are matched
 * against a server-side allow-list. Nothing type-checks across a repo boundary,
 * so each one is a silent failure waiting to happen — and two already have:
 *
 *   · the booking bands — tbl_job.time_slot; a differently-spelled band written
 *     by one side is a value the other side does not recognise
 *   · the job sort key  — the FE shipped 'ageSecs' (the projection alias) where
 *     the whitelist key is 'age'. Joi does not ignore an unknown sortBy, it
 *     REJECTS it, so every click on the Age header 400-ed the whole jobs list
 *
 * shared/wire-contract.json holds the agreed values, duplicated byte for byte
 * into both repos. This file asserts THIS repo's constants against THIS repo's
 * copy, plus the cross-repo identity check when the sibling is checked out.
 *
 * Non-destructive: no DB. The fake pool exists only because job.service opens a
 * connection pool at require() time; no query in this file reaches it.
 * Runner: `node --test`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installFakePool } = require('./helpers/fake-pool');

const CONTRACT_PATH = path.resolve(__dirname, '../shared/wire-contract.json');
const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));

const timeSlot = require('../services/time-slot');

installFakePool([]);
const jobSvc = require('../services/job.service');

// ─── booking bands ────────────────────────────────────────────────────────

test('TIME_SLOT_BANDS matches the wire contract exactly, in order', () => {
  assert.deepEqual(
    [...timeSlot.TIME_SLOT_BANDS],
    contract.bookingBands.values.map((b) => b.value),
  );
});

test('the individual BAND_* constants match the contract', () => {
  const [morning, afternoon, evening, afterHours] = contract.bookingBands.values;
  assert.equal(timeSlot.BAND_MORNING, morning.value);
  assert.equal(timeSlot.BAND_AFTERNOON, afternoon.value);
  assert.equal(timeSlot.BAND_EVENING, evening.value);
  assert.equal(timeSlot.BAND_AFTER_HOURS, afterHours.value);
});

test('bandForHour agrees with the contract windows at every hour', () => {
  /*
   * The DERIVATION, not just the strings. Two repos can agree on how to spell
   * '3PM to 7PM' and still disagree about which hours belong to it — and that
   * disagreement is invisible, because both sides emit a perfectly valid band.
   * All 24 hours, so an off-by-one at an inclusive/exclusive edge cannot hide.
   */
  const windowed = contract.bookingBands.values.filter((b) => b.fromHour !== null);
  const afterHours = contract.bookingBands.values.find((b) => b.fromHour === null).value;
  for (let h = 0; h < 24; h++) {
    const want = windowed.find((b) => h >= b.fromHour && h < b.toHour)?.value ?? afterHours;
    assert.equal(timeSlot.bandForHour(h), want, `hour ${h}`);
  }
});

test('every contract band start hour lands back inside its own band', () => {
  // The FE stamps `start` as the appointment time when an operator picks a band
  // chip. If it fell outside, the chip would flip the moment it was clicked.
  for (const b of contract.bookingBands.values) {
    if (b.fromHour === null) continue;
    const h = Number(b.start.split(':')[0]);
    assert.equal(timeSlot.bandForHour(h), b.value, `${b.value} start ${b.start}`);
  }
});

test('the After Hours start hour is genuinely outside every window', () => {
  const afterHours = contract.bookingBands.values.find((b) => b.fromHour === null);
  const h = Number(afterHours.start.split(':')[0]);
  assert.equal(timeSlot.bandForHour(h), afterHours.value, `${afterHours.start} must band to After Hours`);
});

// ─── job sort keys ────────────────────────────────────────────────────────

/*
 * WHERE THE CRM IS FOUND. Same env-var-first resolution as siblingContract()
 * below and as resolveFeFile() in job-search-parity.test.js — EASYFIX_CRM_UI_DIR
 * in CI (the workflow shallow-clones the CRM into RUNNER_TEMP), the sibling
 * checkout on a developer machine. Deliberately the same mechanism and not a
 * second one: three different ways to find the same repo is three things to get
 * wrong.
 */
function crmRoot() {
  return process.env.EASYFIX_CRM_UI_DIR || path.resolve(__dirname, '../../Easyfix_CRM_UI');
}

/*
 * Returns the CRM's src/ directory, or null after registering the outcome —
 * the shape of resolveFeFileOrFail() in job-search-parity.test.js. GitHub
 * Actions sets CI=true unconditionally, so an absence there can only mean the
 * "Fetch Easyfix_CRM_UI for cross-repo parity" step broke: a red build, not a
 * shrug. The t.skip is unreachable in CI, and `npm test` runs through
 * scripts/test-no-skips.js, which fails on a skip anyway.
 */
function crmSrcOrFail(t) {
  const src = path.join(crmRoot(), 'src');
  if (fs.existsSync(src)) return src;
  /*
   * FAIL, NEVER SKIP — and no longer only under CI (2026-09-10).
   *
   * This used to fail in CI and skip everywhere else. That made the guard's
   * strength depend on an environment variable nobody sets locally, and the
   * local answer was the useless one: on 2026-09-10 a session working from a
   * tree with no sibling CRM ran this file, got a SKIP, and shipped a jobs-list
   * sort key the backend had never whitelisted. HotFix went red for everyone
   * else, off a run that had reported nothing wrong.
   *
   * `npm test` already refuses a skipped test (scripts/test-no-skips.js), so a
   * skip here was never survivable anyway — it just arrived later, as a generic
   * "N tests SKIPPED" from the wrapper instead of the sentence below. Failing at
   * the guard is the same verdict with the remediation attached.
   */
  assert.fail('Easyfix_CRM_UI was not found, so the FE sort keys could not be parsed and this '
    + 'test verified NOTHING. That must never pass silently — it is how a guard ends up '
    + `committed, green, and never run. Looked in: ${src}`
    + '\n  FIX IT ONE OF TWO WAYS:'
    + '\n    git clone --depth 1 https://github.com/Easyfix-2021/Easyfix_CRM_UI.git ../Easyfix_CRM_UI'
    + '\n    …or point EASYFIX_CRM_UI_DIR at an existing checkout.'
    + '\n  Both repos are public, so the clone needs no token — CI does exactly this.');
  return null;
}

function walkSources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSources(p, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

/*
 * THE CONTRACT: every `col` a jobs-list <SortHeader> actually ships as
 * ?sortBy=, parsed out of the CRM. THE RECORD it replaces: contract.jobSortKeys
 * in shared/wire-contract.json, which holds ONE entry.
 *
 * The loop below used to iterate that record, which meant it could only ever
 * re-confirm the single key somebody remembered to write down. A nineteenth
 * column added to the grid with no SORTABLE_COLUMNS entry was not a failure
 * here, it was nothing to check — and the 400 in this file's header comment
 * would ship again, unseen, under a test whose own name promised otherwise.
 *
 * The jobs-table sources are DISCOVERED, not enumerated: the marker is a file
 * that imports JOB_AGE_SORT_KEY and renders <SortHeader>, which is every jobs
 * grid (three today — jobs/page.tsx, my-orders/page.tsx and the shared
 * UnconfirmedJobsTable.tsx that neither page's header list mentions). A
 * hand-written list of those three paths would rebuild exactly this defect one
 * level up: a fourth grid would sort by keys nobody ever checked.
 *
 * Returns { keys: Map<sortKey, sourceFiles[]>, files: string[] }.
 */
function feSortKeys(srcDir) {
  const root = crmRoot();
  const rel = (f) => path.relative(root, f);
  // name → Set of literal values, so a col={IDENT} can be resolved back to the
  // string the browser sends. A Set and not a value: two unrelated files may
  // export the same const name, and that ambiguity must be reported at the one
  // name we actually depend on rather than blowing up on every collision.
  const consts = new Map();
  const headers = [];
  for (const file of walkSources(srcDir)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/export const ([A-Za-z_$][\w$]*)\s*=\s*'([^']*)'/g)) {
      if (!consts.has(m[1])) consts.set(m[1], new Set());
      consts.get(m[1]).add(m[2]);
    }
    if (!src.includes('JOB_AGE_SORT_KEY') || !src.includes('<SortHeader')) continue;
    src.split('\n').forEach((line, i) => {
      // Comment lines out first. These files explain themselves at length and
      // several of those explanations name <SortHeader> in prose — collecting
      // one would trip the unreadable-header assertion below on a line that
      // ships no sort key at all.
      if (/^\s*(?:\/\/|\*|\/\*|\{\/\*)/.test(line)) return;
      if (line.includes('<SortHeader')) headers.push({ file, lineNo: i + 1, line });
    });
  }

  const keys = new Map();
  const files = new Set();
  for (const h of headers) {
    // col="job_id" | col={JOB_AGE_SORT_KEY} | col={'job_id' as SortKey}
    const m = h.line.match(/\bcol=(?:"([^"]+)"|\{\s*(?:'([^']+)'|([A-Za-z_$][\w$]*)))/);
    /*
     * An unreadable header FAILS rather than being passed over. A <SortHeader>
     * whose col this parse cannot see is a sort key travelling to the validator
     * unchecked, which is the precise blind spot the test is here to close —
     * quietly dropping it would restore the bug in a new disguise.
     */
    assert.ok(m, `could not read the col= prop of a <SortHeader> at ${rel(h.file)}:${h.lineNo} `
      + `— has its shape changed?\n  ${h.line.trim()}`);
    let key = m[1] ?? m[2];
    if (key === undefined) {
      const seen = consts.get(m[3]);
      assert.ok(seen, `${rel(h.file)}:${h.lineNo} sorts by the identifier ${m[3]}, which is not `
        + 'an exported string const anywhere under the CRM src/ — the key it resolves to cannot '
        + 'be checked against SORTABLE_COLUMNS.');
      assert.equal(seen.size, 1, `${rel(h.file)}:${h.lineNo} sorts by ${m[3]}, but that name is `
        + `exported with ${seen.size} different values under src/ (${[...seen].join(', ')}) — `
        + 'which one reaches the wire is a guess.');
      [key] = seen;
    }
    if (!keys.has(key)) keys.set(key, []);
    keys.get(key).push(`${rel(h.file)}:${h.lineNo}`);
    files.add(h.file);
  }
  /*
   * A parse that finds nothing must not read as "nothing is wrong". Every
   * discovered source contributes at least one key by construction (each of its
   * <SortHeader> lines either parses or fails above), so zero sources is the
   * only way a caller's loop can go vacuous — and it means the marker moved.
   * Guarded here rather than in one test so that neither direction can report a
   * confident diagnosis ("the contract is stale") off an empty parse.
   */
  assert.ok(files.size > 0,
    'found no jobs-table sources under the CRM src/ — no file both imports JOB_AGE_SORT_KEY '
    + 'and renders <SortHeader>. The marker has moved and this test is checking nothing.');
  return { keys, files: [...files].map(rel) };
}

test('every FE sort key is a key of SORTABLE_COLUMNS', (t) => {
  /*
   * THE 400 THIS EXISTS TO PREVENT. validators/job.validator.js builds its
   * sortBy allow-list from Object.keys(SORTABLE_COLUMNS), so a key the FE sends
   * that is missing here does not degrade to an unsorted list — it fails
   * validation and blanks the grid.
   */
  const srcDir = crmSrcOrFail(t);
  if (!srcDir) return;
  const { keys, files } = feSortKeys(srcDir);
  const have = Object.keys(jobSvc.SORTABLE_COLUMNS);
  for (const [key, where] of keys) {
    assert.ok(have.includes(key),
      `the CRM sorts the jobs list by '${key}' (${where.join(', ')}), but '${key}' is not a key `
      + `of SORTABLE_COLUMNS in services/job.service.js (which has: ${have.join(', ')}). `
      + 'Joi rejects the unknown sortBy and the whole list 400s — add the column to '
      + 'SORTABLE_COLUMNS, or stop sending it from the CRM.');
  }
  // Counted off the CONTRACT, so a shortfall shows up in the passing line too.
  t.diagnostic(`${keys.size} FE sort keys from ${files.length} CRM jobs tables `
    + `(${files.join(', ')}) checked against ${have.length} SORTABLE_COLUMNS keys`);
});

test('the wire contract records no sort key the CRM has stopped sending', (t) => {
  /*
   * The other direction: the RECORD against the CONTRACT. contract.jobSortKeys
   * is a note of the keys that once burned us, and a note nobody re-reads rots
   * — rename the column on the FE and the entry here still resolves against
   * SORTABLE_COLUMNS, still passes, and still describes a click no operator can
   * make. Distinct from the failure above: nothing is broken in production, the
   * contract file is simply lying.
   */
  const srcDir = crmSrcOrFail(t);
  if (!srcDir) return;
  const { keys } = feSortKeys(srcDir);
  for (const [name, key] of Object.entries(contract.jobSortKeys)) {
    if (name === '$doc') continue;
    assert.ok(keys.has(key),
      `shared/wire-contract.json records jobSortKeys.${name} = '${key}', but no jobs-list `
      + `<SortHeader> in Easyfix_CRM_UI sends it (the CRM sends: ${[...keys.keys()].join(', ')}). `
      + 'Either the FE renamed the column and BOTH copies of the contract are stale, or the '
      + 'entry never described a real click.');
  }
});

test("the job-age sort key maps to the SECONDS expression, not the day count", () => {
  /*
   * Sorting on the floored day value would tie every job created on the same
   * day and collapse the entire sub-day population into one bucket, so the
   * order inside a day would be arbitrary — a sort that looks like it works.
   */
  const entry = jobSvc.SORTABLE_COLUMNS[contract.jobSortKeys.jobAge];
  assert.ok(entry, 'the age key must resolve to an expression');
  // The age expression binds the app clock at call time, so it is a function.
  const expr = typeof entry === 'function' ? entry() : entry;
  assert.equal(typeof expr, 'string');
  assert.doesNotMatch(expr, /=>|function/, 'the evaluated SQL, not the function source');
  assert.equal(/TIMESTAMPDIFF\s*\(\s*SECOND/i.test(String(expr)), true,
    `expected a SECOND-granularity expression, got: ${expr}`);
});

// ─── cross-repo identity ──────────────────────────────────────────────────

/*
 * Env var FIRST, sibling checkout as the fallback:
 *   EASYFIX_CRM_UI_DIR   CI. The workflow shallow-clones the CRM into
 *                        RUNNER_TEMP (both repos are public — no token, no
 *                        secret) and points this at it. RUNNER_TEMP and not the
 *                        workspace, because `npm run lint` is `eslint .` from
 *                        the repo root and would otherwise lint the CRM with
 *                        this repo's config.
 *   ../Easyfix_CRM_UI    a developer machine, where the repos are siblings.
 *
 * `||` rather than the try-each-root loop in job-search-parity.test.js: this
 * function is the byte-mirror of siblingContract() in
 * Easyfix_CRM_UI/tests/wire-contract.test.js pointing the other way, and the
 * two are kept identical in shape. It also fails closed — a mistyped
 * EASYFIX_CRM_UI_DIR reports "missing" instead of quietly reverting to the
 * local layout and verifying a repo nobody asked about.
 */
function siblingContract() {
  const root = process.env.EASYFIX_CRM_UI_DIR
    || path.resolve(__dirname, '../../Easyfix_CRM_UI');
  const file = path.join(root, 'shared', 'wire-contract.json');
  return fs.existsSync(file) ? file : null;
}

test('the CRM_UI copy of the contract is byte-identical', (t) => {
  const sibling = siblingContract();
  if (!sibling) {
    /*
     * SKIPPED, NOT PASSED — and only ever locally. This used to skip in CI too,
     * because only this repo was checked out there, which meant cross-repo
     * parity had never once been verified by the thing that gates the deploy.
     * CI now clones Easyfix_CRM_UI into RUNNER_TEMP and sets EASYFIX_CRM_UI_DIR
     * (see the "Fetch Easyfix_CRM_UI for cross-repo parity" step), so an absence
     * HERE can only mean that step broke — a failure, not a shrug.
     */
    // FAIL, NEVER SKIP — see the note on crmSrcOrFail above for why this is no
    // longer conditional on CI.
    assert.fail('Easyfix_CRM_UI was not found, so cross-repo parity was NOT verified.'
      + '\n  FIX IT ONE OF TWO WAYS:'
      + '\n    git clone --depth 1 https://github.com/Easyfix-2021/Easyfix_CRM_UI.git ../Easyfix_CRM_UI'
      + '\n    …or point EASYFIX_CRM_UI_DIR at an existing checkout.'
      + '\n  Both repos are public, so the clone needs no token — CI does exactly this.');
    return;
  }
  const mine = fs.readFileSync(CONTRACT_PATH);
  const theirs = fs.readFileSync(sibling);
  assert.equal(
    theirs.equals(mine),
    true,
    `shared/wire-contract.json differs between the repos.\n  this repo: ${CONTRACT_PATH}\n  crm_ui:    ${sibling}\nEdit BOTH copies in the same change.`,
  );
});
