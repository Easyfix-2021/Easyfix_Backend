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

test('every FE sort key is a key of SORTABLE_COLUMNS', () => {
  /*
   * THE 400 THIS EXISTS TO PREVENT. validators/job.validator.js builds its
   * sortBy allow-list from Object.keys(SORTABLE_COLUMNS), so a key the FE sends
   * that is missing here does not degrade to an unsorted list — it fails
   * validation and blanks the grid.
   */
  const keys = Object.keys(jobSvc.SORTABLE_COLUMNS);
  for (const [name, key] of Object.entries(contract.jobSortKeys)) {
    if (name === '$doc') continue;
    assert.ok(
      keys.includes(key),
      `contract jobSortKeys.${name} = '${key}' is not a key of SORTABLE_COLUMNS (have: ${keys.join(', ')})`,
    );
  }
});

test("the job-age sort key maps to the SECONDS expression, not the day count", () => {
  /*
   * Sorting on the floored day value would tie every job created on the same
   * day and collapse the entire sub-day population into one bucket, so the
   * order inside a day would be arbitrary — a sort that looks like it works.
   */
  const expr = jobSvc.SORTABLE_COLUMNS[contract.jobSortKeys.jobAge];
  assert.ok(expr, 'the age key must resolve to an expression');
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
    if (process.env.CI) {
      assert.fail('Easyfix_CRM_UI is missing in CI. The "Fetch Easyfix_CRM_UI for cross-repo '
        + 'parity" workflow step must clone it into "$RUNNER_TEMP" and set EASYFIX_CRM_UI_DIR '
        + '— cross-repo parity must never degrade to a silent skip in the run that gates the '
        + 'deploy.');
    }
    t.skip('Easyfix_CRM_UI not found beside this repo — cross-repo parity NOT verified');
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
