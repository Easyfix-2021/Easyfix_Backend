/*
 * BE ↔ FE job-search parity.
 *
 * THE BUG THIS EXISTS TO CATCH: the jobs list filters TWICE. The backend's
 * `q` predicate (services/job.service.js list()) selects rows from the whole
 * table, and then the CRM re-filters the returned page in the browser
 * (filterJobRows / JOB_SEARCH_FIELDS in Easyfix_CRM_UI/src/lib/job-tabs.ts).
 *
 * So if the BE searches a column the FE does NOT, the server dutifully returns
 * matching rows and the client immediately hides them — the operator sees "no
 * results" for a search that worked perfectly server-side. It looks like a
 * backend failure, it isn't, and nothing errors. That is precisely how the
 * Client SPOC search stayed invisible for so long.
 *
 * The invariant is ONE-DIRECTIONAL on purpose:
 *   every BE-searched column MUST have a FE counterpart   ← enforced here
 *   the FE may search MORE                                 ← allowed
 * FE-only fields (status label, formatted dates, job type) narrow the rows
 * already on screen. They cannot hide a server match, so they're harmless.
 *
 * Both halves are parsed from SOURCE rather than imported: the FE is a separate
 * repo written in TypeScript, so there is nothing this process can require().
 *
 * WHERE THE CRM IS FOUND. Two layouts, and as of 2026-09-01 CI is no longer one
 * that gets to shrug:
 *
 *   EASYFIX_CRM_UI_DIR   CI. The workflow shallow-clones the CRM into
 *                        RUNNER_TEMP — both repos are public, so this needs no
 *                        token and no secret — and points this variable at it.
 *                        RUNNER_TEMP, not the workspace: inside it, `npm run
 *                        lint` (`eslint .` from the repo root) would lint the
 *                        CRM with this repo's config and walk ~15k files that
 *                        are not ours.
 *   ../Easyfix_CRM_UI    a developer machine, where the two repos are siblings.
 *
 * This path used to be hardcoded to the sibling and commented "not configurable
 * on purpose". That was defensible only while the skip was a developer-machine
 * convenience. In CI only this repo was ever checked out, so the sibling never
 * existed and the two PARITY tests below had never once executed in the run that
 * gates the deploy — committed, green, enforcing nothing. Skipping is now a
 * local convenience only; under CI an absent CRM is a failure, because it can
 * only mean the clone step broke.
 *
 * Runner: `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const BE_FILE = path.join(__dirname, '..', 'services', 'job.service.js');

// Env var FIRST, sibling as the fallback — the same two-root shape as
// resolveAudit() in Easyfix_CRM_UI/tests/message-literals.test.js, which is the
// mirror image of this check pointing the other way across the repo boundary.
const CRM_ROOTS = [
  process.env.EASYFIX_CRM_UI_DIR,
  path.join(__dirname, '..', '..', 'Easyfix_CRM_UI'),
];

function resolveFeFile() {
  for (const root of CRM_ROOTS) {
    if (!root) continue;
    const p = path.join(root, 'src', 'lib', 'job-tabs.ts');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/*
 * Returns the FE file, or null after registering the outcome. GitHub Actions
 * sets CI=true unconditionally, so an absent CRM there can only mean the "Fetch
 * Easyfix_CRM_UI for cross-repo parity" workflow step broke — that is a red
 * build, not a shrug. The t.skip below is unreachable in CI and stays purely for
 * the developer machine.
 */
function resolveFeFileOrFail(t) {
  const fe = resolveFeFile();
  if (fe) return fe;
  if (process.env.CI) {
    assert.fail('Easyfix_CRM_UI is missing in CI. The "Fetch Easyfix_CRM_UI for cross-repo '
      + 'parity" workflow step must clone it into "$RUNNER_TEMP" and set EASYFIX_CRM_UI_DIR. '
      + 'This must never degrade to a silent skip here — that is how a guard ends up '
      + `committed, green, and never run. Looked in: ${CRM_ROOTS.filter(Boolean).join(', ')}`);
  }
  t.skip(`CRM UI not checked out beside this repo (looked in ${CRM_ROOTS.filter(Boolean).join(', ')}) `
    + '— cross-repo parity NOT verified');
  return null;
}

/*
 * BE column → the field name the CRM row carries. The two differ because the BE
 * projects through joins with aliases (ef.efr_name) while the FE sees the
 * flattened row (easyfixer_name). Anything added to the BE clause that isn't in
 * this map fails the test below — deliberately, so a new searchable column
 * forces a conscious decision about the FE side rather than silently half-shipping.
 */
const BE_TO_FE = {
  'j.job_id': 'job_id',
  'j.job_reference_id': 'job_reference_id',
  'j.client_ref_id': 'client_ref_id',
  'cu.customer_name': 'customer_name',
  'cu.customer_mob_no': 'customer_mob_no',
  'cl.client_name': 'client_name',
  'ci.city_name': 'city_name',
  'ef.efr_name': 'easyfixer_name',
  'ow.user_name': 'owner_name',
  'j.client_spoc_name': 'client_spoc_name',
  'j.client_spoc': 'client_spoc',
};

// Pull the `q` predicate out of list() and return the columns it LIKE-matches.
function beSearchColumns() {
  const src = fs.readFileSync(BE_FILE, 'utf8');
  const line = src.split('\n').find((l) => /clauses\.push\(.*CAST\(j\.job_id AS CHAR\) LIKE/.test(l));
  assert.ok(line, 'could not locate the `q` search clause in job.service.js — has it been renamed?');
  // Matches both `alias.col LIKE ?` and `CAST(alias.col AS CHAR) LIKE ?`.
  return [...line.matchAll(/([a-z]{1,3}\.[a-z_]+)(?:\s+AS\s+CHAR\))?\s+LIKE\s+\?/gi)].map((m) => m[1]);
}

// Pull the accessor field names out of JOB_SEARCH_FIELDS.
function feSearchFields(feFile) {
  const src = fs.readFileSync(feFile, 'utf8');
  return new Set([...src.matchAll(/get:\s*\(j\)\s*=>\s*j\.([a-z_]+)/gi)].map((m) => m[1]));
}

test('the BE search clause binds exactly one param per LIKE', () => {
  const src = fs.readFileSync(BE_FILE, 'utf8');
  const lines = src.split('\n');
  const i = lines.findIndex((l) => /clauses\.push\(.*CAST\(j\.job_id AS CHAR\) LIKE/.test(l));
  assert.ok(i >= 0);
  const placeholders = (lines[i].match(/LIKE \?/g) || []).length;
  const bound = (lines[i + 1].match(/%\$\{q\}%/g) || []).length;
  // A mismatch shifts EVERY later param by one — the query then filters on the
  // wrong values instead of failing loudly, so it must be asserted.
  assert.equal(bound, placeholders,
    `the params.push() binds ${bound} values for ${placeholders} placeholders`);
});

test('every BE-searched column is a known column with a FE counterpart mapping', () => {
  for (const col of beSearchColumns()) {
    assert.ok(BE_TO_FE[col],
      `BE searches "${col}" but it has no entry in BE_TO_FE. Add the matching field to `
      + 'JOB_SEARCH_FIELDS in Easyfix_CRM_UI/src/lib/job-tabs.ts, then map it here — otherwise '
      + 'the client-side filter will hide rows the server correctly returned.');
  }
});

test('PARITY: the CRM client-side filter covers every column the BE searches', (t) => {
  const feFile = resolveFeFileOrFail(t);
  if (!feFile) return;
  const fe = feSearchFields(feFile);
  assert.ok(fe.size > 0, 'parsed zero fields from JOB_SEARCH_FIELDS — has its shape changed?');
  const missing = beSearchColumns()
    .map((c) => BE_TO_FE[c])
    .filter((f) => f && !fe.has(f));
  assert.deepEqual(missing, [],
    `the BE searches these but the CRM filter does not: ${missing.join(', ')}. `
    + 'The server would return matching rows and the browser would hide them — a search '
    + 'that silently returns nothing. Add them to JOB_SEARCH_FIELDS in job-tabs.ts.');
});

/*
 * The SPOC pair is split across two tests ON PURPOSE. It used to be one test
 * that asserted the BE half, THEN skipped, so on a skip the summary reported
 * "skipped" for a test that had in fact enforced half its body — the worst of
 * both readings. Two tests: the BE half always runs and is always reported as
 * having run; the cross-repo half is the only part that can be skipped.
 */
test('client SPOC is searchable on the BE side', () => {
  const be = beSearchColumns();
  assert.ok(be.includes('j.client_spoc_name'), 'BE must search the SPOC name');
  assert.ok(be.includes('j.client_spoc'), 'BE must search the SPOC mobile');
});

test('PARITY: client SPOC specifically is searchable on the CRM side too', (t) => {
  const feFile = resolveFeFileOrFail(t);
  if (!feFile) return;
  const fe = feSearchFields(feFile);
  assert.ok(fe.has('client_spoc_name'), 'CRM filter must match the SPOC name');
  assert.ok(fe.has('client_spoc'), 'CRM filter must match the SPOC mobile');
});
