/*
 * Unit tests for scripts/migration-status.js `artifactsOf` — the pattern-matching
 * half of the migration-status check, and the only half that can regress
 * silently.
 *
 * The DB probes can't be tested here (they need a live DB, and the whole point
 * of the script is to compare against one). But a WRONG artifact is the real
 * hazard: extract nothing and a pending migration passes; extract a phantom and
 * an applied one is reported pending forever. Both failure modes are pure string
 * work, so they're pinned here.
 *
 * The script requires ../db lazily precisely so this file can import it without
 * opening a pool (which would keep the test process alive).
 *
 * Runner: `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { artifactsOf } = require('../scripts/migration-status');

const kinds = (sql) => artifactsOf(sql).map((a) => a.kind);
const find = (sql, kind) => artifactsOf(sql).filter((a) => a.kind === kind);

test('CREATE TABLE (with or without IF NOT EXISTS) yields a table artifact', () => {
  assert.deepEqual(artifactsOf('CREATE TABLE IF NOT EXISTS tbl_foo (id INT);'), [{ kind: 'table', table: 'tbl_foo' }]);
  assert.deepEqual(artifactsOf('create table tbl_bar (id INT);'), [{ kind: 'table', table: 'tbl_bar' }]);
});

test('ADD COLUMN yields a column artifact', () => {
  assert.deepEqual(
    find('ALTER TABLE tbl_job_offer ADD COLUMN offered_by_user_id INT NULL;', 'column'),
    [{ kind: 'column', table: 'tbl_job_offer', column: 'offered_by_user_id' }],
  );
  // COLUMN keyword optional, IF NOT EXISTS optional.
  assert.deepEqual(
    find('ALTER TABLE t ADD IF NOT EXISTS c VARCHAR(10);', 'column'),
    [{ kind: 'column', table: 't', column: 'c' }],
  );
});

/*
 * THE regression that shipped in the first draft: `ADD INDEX` matched the
 * ADD-COLUMN pattern and captured "INDEX" as a column name, which then probes as
 * permanently missing — so an applied migration would have been reported pending
 * forever.
 */
test('ADD INDEX / KEY is an INDEX artifact, never a column named "INDEX"', () => {
  const sql = 'ALTER TABLE tbl_job_offer ADD INDEX idx_offered_by (offered_by_user_id);';
  assert.deepEqual(find(sql, 'index'), [{ kind: 'index', table: 'tbl_job_offer', index: 'idx_offered_by' }]);
  assert.equal(find(sql, 'column').length, 0, 'must not read INDEX as a column name');
  // The other constraint-ish spellings must not become columns either.
  for (const kw of ['UNIQUE KEY uk_x (a)', 'PRIMARY KEY (a)', 'CONSTRAINT fk_x FOREIGN KEY (a) REFERENCES b(c)']) {
    assert.equal(find(`ALTER TABLE t ADD ${kw};`, 'column').length, 0, kw);
  }
});

test('CREATE INDEX … ON t yields an index artifact', () => {
  assert.deepEqual(
    find('CREATE UNIQUE INDEX idx_a ON tbl_b (col);', 'index'),
    [{ kind: 'index', table: 'tbl_b', index: 'idx_a' }],
  );
});

/*
 * Seeded rows come from the migration's own NOT EXISTS guard. The QuickSight
 * seeds ALSO reference the family key 'ef-QuickSight' in a `WHERE EXISTS`
 * PRE-CONDITION — reading that as a created artifact would report the file as
 * only "partial" on a DB where the precondition legitimately fails.
 */
test('menu_action seeds read the NOT EXISTS guard, not the EXISTS precondition', () => {
  const sql = `
    INSERT INTO menu_action (menu_id, action_name)
    SELECT (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' LIMIT 1), 'isQuickSightFooView'
     WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
       AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightFooView');`;
  assert.deepEqual(find(sql, 'action'), [{ kind: 'action', action: 'isQuickSightFooView' }]);
});

test('easyfix_properties seeds read the NOT EXISTS guard', () => {
  const sql = `
    INSERT INTO easyfix_properties (property_key, property_value)
    SELECT 'job.offer.loud_alert.enabled', 'false'
     WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'job.offer.loud_alert.enabled');`;
  assert.deepEqual(find(sql, 'property'), [{ kind: 'property', property: 'job.offer.loud_alert.enabled' }]);
});

test('DDL mentioned only in a COMMENT is not an artifact', () => {
  // A migration that DOCUMENTS a table it doesn't create must not be probed for
  // it — otherwise it reads as pending forever.
  assert.deepEqual(artifactsOf('-- CREATE TABLE tbl_never (id INT);\nUPDATE t SET a = 1;'), []);
  assert.deepEqual(artifactsOf('/* CREATE TABLE tbl_never (id INT); */\nUPDATE t SET a = 1;'), []);
});

test('a data-only migration yields NO artifacts (reported UNKNOWN, never applied)', () => {
  assert.deepEqual(artifactsOf('UPDATE tbl_easyfixer SET efr_status = 0 WHERE efr_id = 1;'), []);
  assert.deepEqual(artifactsOf('DELETE FROM tbl_service_skill_mapping WHERE id > 0;'), []);
});

test('artifacts are de-duplicated', () => {
  const sql = 'CREATE TABLE IF NOT EXISTS t (id INT); CREATE TABLE IF NOT EXISTS t (id INT);';
  assert.equal(find(sql, 'table').length, 1);
});

/*
 * Corpus check: every real migration currently in the folder either yields at
 * least one artifact or is a genuine data-only file. This is what catches "a new
 * migration shape appeared that the extractor silently ignores" — the failure
 * mode where the whole check quietly stops protecting anything.
 */
test('every real migration is classified (artifact) or is data-only (UPDATE/DELETE)', () => {
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
  assert.ok(files.length > 0, 'expected migrations to exist');
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    if (artifactsOf(sql).length > 0) continue;
    /*
     * No artifact → the file must contain none of the shapes we CLAIM to detect.
     * Deliberately narrower than "any DDL": MODIFY COLUMN and DROP are excluded
     * from the extractor on purpose (see its header — probing them would give a
     * false pass or need an absence assertion), so a MODIFY-only migration
     * legitimately lands in UNKNOWN and must not fail this test.
     */
    const supported = new RegExp(
      '(CREATE\\s+TABLE'
      + '|ALTER\\s+TABLE\\s+[a-z0-9_`"]+\\s+ADD'
      + '|ALTER\\s+TABLE\\s+[a-z0-9_`"]+\\s+(CHANGE|RENAME\\s+COLUMN)'
      + '|CREATE\\s+(UNIQUE\\s+)?INDEX'
      + '|INSERT\\s+INTO\\s+(menu_action|easyfix_properties))', 'i',
    );
    const hasSupportedShape = supported.test(
      sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*--.*$/gm, ' '),
    );
    assert.equal(hasSupportedShape, false, `${f} contains a shape the extractor claims to support but produced no artifact — blind spot`);
  }
});

test('kinds are limited to the five probe-able types', () => {
  const dir = path.join(__dirname, '..', 'migrations');
  const allowed = new Set(['table', 'column', 'index', 'action', 'property']);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
    for (const k of kinds(fs.readFileSync(path.join(dir, f), 'utf8'))) {
      assert.ok(allowed.has(k), `${f}: unexpected artifact kind ${k}`);
    }
  }
});
