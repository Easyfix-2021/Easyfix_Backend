/*
 * Guard: Manage Materials API selects must CAST status / is_system to numbers.
 *
 * db.js installs a typeCast that turns TINYINT(1) into a JS boolean. The CRM
 * page compares these fields with `=== 1`, so a bare `b.status` reaching the
 * wire as `true` renders every row Inactive and lets the system brand show
 * Edit/Delete. The fake-pool service tests return plain numbers and CANNOT see
 * this — hence a source-level guard over the SELECT lists that feed the API.
 *
 * Scope: material.service.js and brand.service.js (API-facing). The import
 * service only reads is_system for truthiness, which is correct either way.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FILES = ['services/material.service.js', 'services/brand.service.js'];
const FLAG = /(?:^|[\s,(])(?:\w+\.)?(status|is_system)\s*(?:,|$|\s+FROM\b)/im;

function selectLists(src) {
  // Every "SELECT … FROM" span; the select list is what reaches the response.
  return [...src.matchAll(/SELECT\b([\s\S]*?)\bFROM\b/g)].map((m) => m[1]);
}

for (const rel of FILES) {
  test(`${rel}: status / is_system are CAST before reaching the API`, () => {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const lists = selectLists(src);
    assert.ok(lists.length > 0, `found no SELECT in ${rel} — the guard would pass vacuously`);
    const offenders = lists
      .map((list) => list.replace(/CAST\([^)]*\)\s+AS\s+\w+/gi, ''))
      .filter((list) => FLAG.test(list));
    assert.deepEqual(offenders, [], `bare TINYINT flag in a SELECT list of ${rel}`);
  });
}
