'use strict';
/*
 * EXISTING TECHNICIANS KEEP THEIR DATA (owner, 2026-09-25).
 *
 * Report: an existing (Flutter-era) technician using the new app had old
 * records replaced — deleted and re-inserted. The owner's rule, as decided:
 *   - IDENTITY (name, Aadhaar, PAN, DOB, identity documents) is FILL-ONLY from
 *     the app: written only where missing; a masked/invalid Aadhaar or PAN
 *     counts as missing. Corrections are an ops action in the CRM.
 *   - Everything else stays editable, but a save may never delete what the app
 *     did not show him: legacy-keyed skill rows, hidden/inactive options and
 *     legacy tool photos (no tool id stamped) survive.
 *   - Every profile write moves tbl_easyfixer.update_date.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installFakePool, makeFakePool } = require('./helpers/fake-pool');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ─── Skills: the diff that deleted-and-reinserted unchanged skills ────── */

// Deep skill 5 has two visible options (501, 502). The technician holds:
//   · 501 under a LEGACY key (service type 99, parent 7) — still selected;
//   · 502 under the current key — he deselects it;
//   · 777 — an option that is no longer visible (inactive) — never shown.
const EXISTING = [
  { service_type_id: 99, deep_skill_id: 7, option_id: 501 },
  { service_type_id: 10, deep_skill_id: 5, option_id: 502 },
  { service_type_id: 10, deep_skill_id: 5, option_id: 777 },
];
const fake = installFakePool([
  [/FROM tbl_service_catg/, () => [{ service_catg_id: 3 }]],
  [/AS in_this_category/, () => [{ in_this_category: 3, in_any_category: 3 }]],
  [/FROM tbl_efr_deepskill_mapping m\s+WHERE m\.easyfixer_id = \?\s+AND m\.category_id = \?/, () => EXISTING],
  [/FROM tbl_deepskill_options/, () => [{ id: 501 }, { id: 502 }]],
  [/UPDATE tbl_efr_deepskill_mapping\s+SET is_repairing = 1/, () => ({ affectedRows: 0 })],
]);
after(() => fake.restore());
const { applySkills } = require('../services/mobile-deepskill.service');

test('an unchanged legacy skill is neither deleted nor re-inserted; only a visible, deselected option goes', async () => {
  fake.reset();
  const r = await applySkills(42, {
    categoryId: 3,
    serviceTypes: [{ serviceTypeId: 10, deepSkills: [{ deepSkillId: 5, selectedOptions: [501] }] }],
  });
  const inserts = fake.calls.filter((c) => /INSERT INTO tbl_efr_deepskill_mapping/.test(c.sql));
  const deletes = fake.calls.filter((c) => /SET is_repairing = 0/.test(c.sql));
  assert.equal(inserts.length, 0, '501 is already held (legacy key) — no second row');
  assert.equal(deletes.length, 1, 'exactly one soft-delete');
  assert.deepEqual(deletes[0].params.slice(-1), [502], 'and it is 502, the option he deselected');
  assert.ok(!deletes.some((d) => d.params.includes(777)), 'the never-shown option 777 survives');
  assert.ok(!deletes.some((d) => d.params.includes(501)), 'the legacy 501 row survives');
  assert.equal(r.totalMappingsDeleted, 1);
});

test('a skill genuinely new to him is still added', async () => {
  fake.reset();
  await applySkills(42, {
    categoryId: 3,
    serviceTypes: [{ serviceTypeId: 10, deepSkills: [{ deepSkillId: 5, selectedOptions: [501, 502, 503] }] }],
  });
  const inserts = fake.calls.filter((c) => /INSERT INTO tbl_efr_deepskill_mapping/.test(c.sql));
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].params.slice(-1)[0], 503);
});

/* ─── Identity documents: fill-only ─────────────────────────────────────── */

const { upsertEasyfixerDocuments } = require('../services/easyfixer-document.service');

test('identity documents are fill-only: a stored image is kept, a blank one is filled', async () => {
  const stored = makeFakePool([[/SELECT efr_doc_id, efr_document_name/, () => [{ efr_doc_id: 9, efr_document_name: 'legacy.jpg' }]]]);
  await upsertEasyfixerDocuments(stored.pool, 42, [[13, 'MobileUploads/new']], { fillOnly: true });
  assert.ok(!stored.calls.some((c) => /UPDATE tbl_easyfixer_document|INSERT INTO tbl_easyfixer_document/.test(c.sql)),
    'the stored Aadhaar image must not be replaced');

  const blank = makeFakePool([[/SELECT efr_doc_id, efr_document_name/, () => [{ efr_doc_id: 9, efr_document_name: '  ' }]]]);
  await upsertEasyfixerDocuments(blank.pool, 42, [[13, 'MobileUploads/new']], { fillOnly: true });
  assert.ok(blank.calls.some((c) => /UPDATE tbl_easyfixer_document SET efr_document_name/.test(c.sql)), 'a blank one is filled');

  const editable = makeFakePool([[/SELECT efr_doc_id, efr_document_name/, () => [{ efr_doc_id: 9, efr_document_name: 'old.jpg' }]]]);
  await upsertEasyfixerDocuments(editable.pool, 42, [[7, 'MobileUploads/new']]);
  assert.ok(editable.calls.some((c) => /UPDATE tbl_easyfixer_document SET efr_document_name/.test(c.sql)),
    'non-identity documents (education, insurance…) stay replaceable');
});

/* ─── The SQL of every identity writer: fill-only, and update_date moves ── */

/** Every `<col> = …` assignment for `col` inside UPDATE tbl_easyfixer statements. */
function assignments(src, col) {
  const out = [];
  for (const m of src.matchAll(/UPDATE tbl_easyfixer\b[\s\S]*?WHERE/g)) {
    for (const a of m[0].matchAll(new RegExp(`\\b${col}\\s*=\\s*([^\\n]+)`, 'g'))) out.push(a[1].trim());
  }
  return out;
}

const WRITERS = {
  'services/mobile-identity.service.js': ['efr_name', 'adhaar_card_number', 'pan_card_number', 'efr_first_name', 'efr_last_name', 'date_of_birth'],
  'services/mobile-registration.service.js': ['efr_name', 'efr_first_name', 'efr_last_name'],
  'services/mobile-profile-extra.service.js': ['efr_name'],
  'routes/mobile/index.js': ['efr_first_name', 'efr_last_name', 'date_of_birth'],
};

test('identity columns are never assigned `COALESCE(?, col)` (overwrite) on the app\'s writers', () => {
  let checked = 0;
  for (const [file, cols] of Object.entries(WRITERS)) {
    const src = read(file);
    for (const col of cols) {
      const found = assignments(src, col);
      assert.ok(found.length > 0, `${file}: found no assignment of ${col} — the matcher lost its subject`);
      for (const rhs of found) {
        checked += 1;
        assert.ok(!/^\?\s*,?$/.test(rhs) && !/^COALESCE\(\?\s*,/.test(rhs),
          `${file}: ${col} = ${rhs} overwrites a stored identity value`);
      }
    }
  }
  assert.ok(checked >= 13, `checked ${checked} identity assignments`);
});

test('a masked Aadhaar and an invalid PAN count as missing (the app can complete them)', () => {
  const src = read('services/mobile-identity.service.js');
  assert.match(src, /adhaar_card_number REGEXP '\^\[0-9\]\{12\}\$'/);
  assert.match(src, /UPPER\(pan_card_number\) REGEXP '\^\[A-Z\]\{5\}\[0-9\]\{4\}\[A-Z\]\$'/);
});

test('every one of those writers moves update_date', () => {
  for (const file of Object.keys(WRITERS)) {
    assert.ok(assignments(read(file), 'update_date').length > 0, `${file} does not touch update_date`);
  }
});

/* ─── Tool photos: a legacy (unstamped) photo is never deleted ──────────── */

test('the tool-photo deletes only touch photos stamped with a tool id', () => {
  const src = read('routes/mobile/index.js');
  const deletes = Array.from(src.matchAll(/DELETE FROM tbl_easyfixer_document[\s\S]*?efr_doc_type_id = 8[^`']*/g), (m) => m[0]);
  assert.equal(deletes.length, 2, 'positive control: both tool-photo deletes found');
  for (const d of deletes) {
    assert.match(d, /efr_doc_text IS NOT NULL/, 'an unstamped (legacy) tool photo must survive');
    assert.doesNotMatch(d, /efr_doc_text IS NULL OR/, 'the old predicate deleted legacy photos');
  }
});
