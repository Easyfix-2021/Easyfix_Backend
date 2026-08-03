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
 * When that repo isn't checked out beside this one, the cross-repo assertions
 * are skipped and the BE-side invariants still run.
 *
 * Runner: `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const BE_FILE = path.join(__dirname, '..', 'services', 'job.service.js');
// Sibling checkout. Not configurable on purpose — if the layout changes, the
// skip message below tells you exactly what to fix.
const FE_FILE = path.join(
  __dirname, '..', '..', 'Easyfix_CRM_UI', 'src', 'lib', 'job-tabs.ts',
);

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
function feSearchFields() {
  const src = fs.readFileSync(FE_FILE, 'utf8');
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
  if (!fs.existsSync(FE_FILE)) {
    t.skip(`CRM UI not checked out beside this repo (looked for ${FE_FILE}) — cross-repo parity not verified`);
    return;
  }
  const fe = feSearchFields();
  assert.ok(fe.size > 0, 'parsed zero fields from JOB_SEARCH_FIELDS — has its shape changed?');
  const missing = beSearchColumns()
    .map((c) => BE_TO_FE[c])
    .filter((f) => f && !fe.has(f));
  assert.deepEqual(missing, [],
    `the BE searches these but the CRM filter does not: ${missing.join(', ')}. `
    + 'The server would return matching rows and the browser would hide them — a search '
    + 'that silently returns nothing. Add them to JOB_SEARCH_FIELDS in job-tabs.ts.');
});

test('PARITY: client SPOC specifically is searchable on both sides', (t) => {
  const be = beSearchColumns();
  assert.ok(be.includes('j.client_spoc_name'), 'BE must search the SPOC name');
  assert.ok(be.includes('j.client_spoc'), 'BE must search the SPOC mobile');
  if (!fs.existsSync(FE_FILE)) { t.skip('CRM UI not checked out beside this repo'); return; }
  const fe = feSearchFields();
  assert.ok(fe.has('client_spoc_name'), 'CRM filter must match the SPOC name');
  assert.ok(fe.has('client_spoc'), 'CRM filter must match the SPOC mobile');
});
