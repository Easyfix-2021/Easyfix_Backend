const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * A schema probe may cache its ANSWER. It may never cache its FAILURE.
 *
 * Caching the answer is right: a column that exists does not vanish under a
 * running container. Caching the failure the same way turns a two-second
 * information_schema blip into a degraded mode lasting until someone restarts
 * the process — and because the catch usually swallowed the error, nothing in
 * the logs said so.
 *
 * A survey of all 23 probes in this backend found 18 that froze the answer and
 * 20 that answered "absent" on failure. Three of the pairings were live and
 * silently harmful and were fixed first; these are the ten hot-path ones.
 *
 * The single-call direction is UNCHANGED and deliberately still "absent" —
 * that is correct for these sites, which guard optional writes and
 * pre-migration fallbacks. Only the permanence is gone.
 */

const ROOT = path.join(__dirname, '..');

// ── The rule, over every probe in the codebase ───────────────────────

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\/\/[^\n]*/g, '');

/* Extract each `catch (...) { … }` body by brace depth. */
function catchBodies(src) {
  const out = [];
  const re = /\bcatch\s*(\([^)]*\))?\s*\{/g;
  for (const m of src.matchAll(re)) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    out.push(src.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

function probeFiles() {
  const files = [];
  for (const dir of ['services', 'utils']) {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.js')) files.push(full);
      }
    };
    walk(path.join(ROOT, dir));
  }
  return files.filter((f) => /information_schema/i.test(fs.readFileSync(f, 'utf8')));
}

test('no probe records an answer inside a catch', () => {
  /*
   * The tell is an ASSIGNMENT of true/false in a catch block: that is the
   * failure being written into the memo the guard above reads. Clearing a slot
   * (`= null`) is the opposite and is allowed — it is how a memoised promise
   * un-freezes itself.
   */
  const RECORDS_A_VERDICT = /[\w.[\]'"]+\s*=\s*(?:true|false)\s*;/;
  const offenders = [];
  for (const file of probeFiles()) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    for (const body of catchBodies(src)) {
      const hit = body.search(RECORDS_A_VERDICT);
      if (hit === -1) continue;
      /*
       * ONE legitimate exception, and it is not a loophole: a TRY-THE-QUERY
       * probe learns "it is not there" FROM the error, so for that probe the
       * error is the answer and caching it is correct — not caching it would
       * re-probe on every hot-path call forever.
       *
       * The rule is therefore not "never record in a catch" but "record only
       * once you have established the error IS an answer". isAbsentAnswer()
       * must be consulted BEFORE the assignment; a catch that assigns first
       * and asks afterwards has already frozen the wrong thing.
       */
      const asked = body.indexOf('isAbsentAnswer(');
      if (asked !== -1 && asked < hit) continue;
      /*
       * A RETHROW ahead of the assignment establishes the same thing by hand:
       * `if (e.errno !== 1146) throw e;` lets exactly one error code through and
       * re-raises everything else, so whatever reaches the assignment IS an
       * answer. Accepted because the invariant is what matters, not the
       * spelling — and that form is often NARROWER than isAbsentAnswer(), which
       * is the safer direction: client.service's contacts probe tolerates only
       * a missing TABLE, so broadening it to ER_BAD_FIELD_ERROR would swallow a
       * genuine column typo in the join it guards.
       */
      const rethrown = body.indexOf('throw ');
      if (rethrown !== -1 && rethrown < hit) continue;
      offenders.push(`${path.relative(ROOT, file)} — catch records a verdict `
        + `without asking isAbsentAnswer() first: `
        + body.trim().split('\n').find((l) => RECORDS_A_VERDICT.test(l)).trim());
    }
  }
  assert.deepEqual(offenders, [],
    'a catch that writes its verdict into the memo freezes a transient failure '
    + 'for the life of the process — return the fallback instead, so the next '
    + 'call re-probes');
});

test('the guard actually looks at the files it claims to', () => {
  const files = probeFiles().map((f) => path.relative(ROOT, f));
  for (const expected of [
    'services/address.service.js', 'services/job-comment.service.js',
    'services/job.service.js', 'services/plivo-call-log.service.js',
    'services/pincode-geocode.service.js', 'utils/aadhaar-uniqueness.js',
    'services/client.service.js', 'services/client-documents.service.js',
    'services/mobile-job-lifecycle.service.js', 'services/lms.service.js',
  ]) {
    assert.ok(files.includes(expected), `${expected} must be in the scanned set`);
  }
  assert.ok(files.length >= 12, `expected the sweep to find the probe files, saw ${files.length}`);
});

// ── Behaviour, for the four probes that are exported ─────────────────

const scenario = { fail: true };
const fake = installFakePool([
  [/information_schema/i, () => {
    if (scenario.fail) throw new Error('information_schema unreachable');
    return [{ n: 1, 1: 1, COLUMN_NAME: 'x' }];
  }],
]);
const db = require('../db');
const addressSvc = require('../services/address.service');
const plivoSvc = require('../services/plivo-call-log.service');
const geoSvc = require('../services/pincode-geocode.service');
const aadhaar = require('../utils/aadhaar-uniqueness');

after(() => fake.restore());

const CASES = [
  ['address.hasAddressInstructionColumn', () => addressSvc.hasAddressInstructionColumn(db.pool)],
  ['plivo.hasConferenceColumns', () => plivoSvc.hasConferenceColumns()],
  ['pincode-geocode.hasProvenanceColumn', () => geoSvc.hasProvenanceColumn()],
  ['aadhaar.hasActiveAadhaarColumn', () => aadhaar.hasActiveAadhaarColumn(db.pool)],
];

for (const [name, call] of CASES) {
  test(`${name}: a failed probe is not remembered`, async () => {
    scenario.fail = true;
    const first = await call();
    assert.equal(first, false, 'the single-call answer stays "absent" — unchanged');

    // The database recovers. The very next call must ask again, not serve the
    // frozen false. This is the whole fix.
    scenario.fail = false;
    const second = await call();
    assert.equal(second, true,
      'the failure was cached — one blip would have disabled this feature until '
      + 'the container restarted');
  });
}
