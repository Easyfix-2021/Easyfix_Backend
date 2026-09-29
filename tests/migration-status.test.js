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
const { artifactsOf, dropsOf, isTransient } = require('../scripts/migration-status');

/* The filter the executed/ scan applies: an artifact the file itself removes. */
const survives = (sql) => {
  const drops = dropsOf(sql);
  return artifactsOf(sql).filter((a) => !isTransient(a, drops));
};

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

// ─── TRANSIENT ARTIFACTS (the executed/ scan's false-positive guard) ──────
/*
 * WHY THIS EXISTS. executed/ files are now probed too, so a migration that
 * builds a scratch table and drops it in the same file would report DRIFT
 * forever — the artifact is absent because the migration ITSELF removed it,
 * which is the opposite of "this environment is missing the migration".
 *
 * The filter reads the file's own DROP statements, so a file declares what is
 * temporary; there is no allowlist to keep in step.
 */

test('a table created and dropped in the SAME file is transient', () => {
  const sql = `
    DROP TABLE IF EXISTS location_keep;
    CREATE TABLE location_keep (id INT NOT NULL, PRIMARY KEY (id)) ENGINE=MyISAM;
    DROP TABLE IF EXISTS location_keep;
  `;
  // The extractor still SEES it — the filter is a separate, visible decision.
  assert.deepEqual(artifactsOf(sql).map((a) => a.table), ['location_keep']);
  assert.deepEqual(survives(sql), [], 'a scratch table must not be probed');
});

test('a table the file does NOT drop still survives the filter', () => {
  // The positive control for the test above: without this, a filter that
  // discarded EVERY table would pass the transient case and be undetectable.
  const sql = 'CREATE TABLE IF NOT EXISTS tbl_keeper (id INT);';
  assert.deepEqual(survives(sql).map((a) => a.table), ['tbl_keeper']);
});

test('DROP INDEX ... ON t cancels only that index, not the table', () => {
  const sql = `
    CREATE TABLE IF NOT EXISTS tbl_thing (id INT);
    CREATE INDEX idx_tmp ON tbl_thing (id);
    DROP INDEX idx_tmp ON tbl_thing;
  `;
  const kept = survives(sql);
  assert.ok(kept.some((a) => a.kind === 'table' && a.table === 'tbl_thing'),
    'the table outlives the scratch index and must still be probed');
  assert.ok(!kept.some((a) => a.kind === 'index' && a.index === 'idx_tmp'),
    'the dropped index must not be probed');
});

test('a DROP inside a COMMENT does not cancel anything', () => {
  // dropsOf strips comments first. Without that, prose describing a rollback
  // ("-- to undo: DROP TABLE tbl_real;") would silence a real probe — the same
  // class of bug the extractor's own comment-stripping guards against.
  const sql = `
    -- to roll back: DROP TABLE tbl_real;
    CREATE TABLE IF NOT EXISTS tbl_real (id INT);
  `;
  assert.deepEqual(survives(sql).map((a) => a.table), ['tbl_real']);
});

test('the transient filter is not swallowing the executed corpus', () => {
  /*
   * DENOMINATOR CHECK. A filter that quietly discarded most artifacts would
   * make the executed/ scan pass by having nothing left to probe — silence
   * that looks exactly like success. Measured when written: 380 artifacts
   * across 208 files, of which 2 are transient.
   */
  const dir = path.join(__dirname, '..', 'migrations', 'executed');
  let total = 0;
  let dropped = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    const all = artifactsOf(sql);
    total += all.length;
    dropped += all.length - survives(sql).length;
  }
  assert.ok(total > 100, `expected a real corpus; found only ${total} artifacts`);
  assert.ok(dropped < total * 0.05,
    `the transient filter discarded ${dropped} of ${total} artifacts — that is a redesign signal, not a filter`);
});

// ─── LEFT-PREFIX-GUARDED ADD INDEX (probe against a fake information_schema) ──
/*
 * executed/2026-08-17-phe-team-read-indexes.sql skips `ADD INDEX idx_job_tx_job
 * (fk_job_id)` when ANY index already leads with fk_job_id. QA has unique_job_id
 * (fk_job_id), so the name probe reported drift that could never clear. The
 * probe must accept an equivalent index — and must still say ABSENT when none
 * exists, or it has merely been switched off.
 *
 * `../db` is required lazily by the script, so seeding require.cache here swaps
 * the pool for a fake that answers from STATISTICS rows, grouped like MySQL.
 */
const { probe } = require('../scripts/migration-status');

let statistics = [];
require.cache[require.resolve('../db')] = {
  exports: {
    pool: {
      async query(sql, [table, index]) {
        assert.match(sql, /INFORMATION_SCHEMA\.STATISTICS/, 'expected a STATISTICS probe');
        const byIndex = new Map();
        for (const r of statistics.filter((s) => s.table === table).sort((a, b) => a.seq - b.seq)) {
          byIndex.set(r.index, [...(byIndex.get(r.index) || []), r.column]);
        }
        if (/GROUP BY INDEX_NAME/i.test(sql)) {
          return [[...byIndex].map(([name, cols]) => ({ name, cols: cols.join(',') }))];
        }
        return [[{ n: statistics.filter((s) => s.table === table && s.index === index).length }]];
      },
    },
  },
};

const { readMigration } = require('./helpers/migration-file');

const PHE = readMigration('2026-08-17-phe-team-read-indexes.sql');
const jobTx = () => artifactsOf(PHE).find((a) => a.index === 'idx_job_tx_job');
const stat = (table, index, ...cols) => cols.map((column, i) => ({ table, index, column, seq: i + 1 }));

test('the real guarded ADD carries its column prefix; unguarded ADD / CREATE INDEX do not', () => {
  // Locating the subject: without this, every probe test below could pass on nothing.
  assert.deepEqual(jobTx(), { kind: 'index', table: 'tbl_job_transaction', index: 'idx_job_tx_job', columns: 'fk_job_id' });
  const guardedCount = artifactsOf(PHE).filter((a) => a.kind === 'index' && a.columns).length;
  assert.equal(guardedCount, 8, 'every ADD in that file is prefix-guarded');
  assert.equal(find('ALTER TABLE t ADD INDEX idx_a (a);', 'index')[0].columns, undefined);
  assert.equal(find('CREATE INDEX idx_a ON t (a);', 'index')[0].columns, undefined);
});

test('a guarded UNIQUE ADD keeps the name probe (a non-unique twin is not the constraint)', () => {
  const sql = `
    SET @has_u = (SELECT COUNT(*) FROM (SELECT index_name FROM information_schema.statistics
      WHERE table_name = 't' GROUP BY index_name
      HAVING GROUP_CONCAT(column_name ORDER BY seq_in_index) LIKE 'a,b,%') x);
    SET @ddl_u = IF(@has_u = 0, 'ALTER TABLE t ADD UNIQUE INDEX uq_ab (a, b)', 'SELECT 1');`;
  assert.equal(find(sql, 'index')[0].columns, undefined);
});

test('QA shape: unique_job_id (fk_job_id) satisfies idx_job_tx_job', async () => {
  statistics = [...stat('tbl_job_transaction', 'PRIMARY', 'id'), ...stat('tbl_job_transaction', 'unique_job_id', 'fk_job_id')];
  assert.equal((await probe(jobTx())).present, true);
});

test('a longer index leading with fk_job_id also satisfies it', async () => {
  statistics = stat('tbl_job_transaction', 'idx_other', 'fk_job_id', 'created_at');
  assert.equal((await probe(jobTx())).present, true);
});

test('POSITIVE CONTROL: no equivalent index → ABSENT', async () => {
  const cases = {
    'no index at all': [],
    'fk_job_id not leading': stat('tbl_job_transaction', 'idx_x', 'created_at', 'fk_job_id'),
    'string prefix is not a column prefix': stat('tbl_job_transaction', 'idx_x', 'fk_job_idx'),
    'same columns, wrong table': stat('tbl_job', 'unique_job_id', 'fk_job_id'),
  };
  for (const [label, rows] of Object.entries(cases)) {
    statistics = rows;
    assert.equal((await probe(jobTx())).present, false, label);
  }
});

test('plain CREATE INDEX stays name-based: an equivalent index under another name is ABSENT', async () => {
  const [a] = find('CREATE INDEX idx_a ON tbl_job_transaction (fk_job_id);', 'index');
  statistics = stat('tbl_job_transaction', 'unique_job_id', 'fk_job_id');
  assert.equal((await probe(a)).present, false);
  statistics = stat('tbl_job_transaction', 'idx_a', 'fk_job_id');
  assert.equal((await probe(a)).present, true);
});
