#!/usr/bin/env node
/**
 * Migration status — is every file in `migrations/` actually applied to the DB
 * this backend is pointed at? Read-only; never runs a migration.
 *
 * WHY THIS EXISTS: `migrations/` is the PENDING set by convention (applied ones
 * are moved to `migrations/executed/`), but nothing enforced that, and nothing
 * compared the folder against reality. Twice in one session a feature looked
 * BROKEN in the UI when the only problem was an unrun seed:
 *   - Job Stage Access was inert (tbl_user_allowed_stages absent);
 *   - the Performance Report's State + User tabs were invisible, because an
 *     action key that does not EXIST is indistinguishable from one that was
 *     revoked, so the fail-closed gate hid them — even from Admin.
 * Both would have been a one-line answer here instead of a bug report.
 *
 * HOW IT DECIDES. It does not execute SQL or keep a ledger; it reads each file,
 * extracts the ARTIFACTS the migration is supposed to leave behind, and asks
 * INFORMATION_SCHEMA / the data tables whether they are there:
 *
 *   CREATE TABLE [IF NOT EXISTS] t          → does table t exist?
 *   ALTER TABLE t ADD COLUMN [IF NOT EXISTS] c → does t.c exist?
 *   CREATE INDEX i ON t                     → does index i exist on t?
 *   INSERT INTO menu_action … 'isXxxView'   → is that action_name present?
 *   ALTER TABLE t CHANGE|RENAME COLUMN o n  → does t.n exist? (rename)
 *   INSERT INTO menu_action … NOT EXISTS 'k' → is that action_name present?
 *   INSERT INTO easyfix_properties … 'k'    → is property_key k present?
 *
 * NOT detected on purpose: MODIFY COLUMN (changes type, not existence — probing
 * the name passes before AND after, a false pass) and DROP COLUMN / DROP TABLE
 * (the honest check is an ABSENCE; mixing presence and absence into one status
 * would obscure both). Those files land in UNKNOWN.
 *
 * ⚠ A migration whose only statements are UPDATE / DELETE (a data fix) leaves
 * no detectable artifact. Those are reported as UNKNOWN — never as applied.
 * Silently passing them would be worse than not checking at all: it would let a
 * genuinely-unapplied data fix look verified.
 *
 * EXIT CODES (this runs inside `npm run verify:all`):
 *   0  everything with a detectable artifact is applied
 *   1  at least one migration is PENDING or PARTIALLY applied
 *   2  the check itself failed (no DB, bad credentials)
 * UNKNOWN files alone never fail the run — they are listed for a human.
 */
const fs = require('fs');
const path = require('path');

/*
 * The DB is loaded LAZILY, and dotenv with it. Requiring ../db at module scope
 * creates the mysql2 pool (with keepAlive), which holds the event loop open —
 * so a test that only wants `artifactsOf` (the pattern-matching half, and the
 * part most likely to regress) could never exit. Now the pure extractor is
 * importable with zero side effects.
 */
function db() {
  require('dotenv').config();
  return require('../db').pool;
}

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

/*
 * Strip comments before pattern-matching. Without this, a migration that
 * DOCUMENTS an artifact in prose ("-- CREATE TABLE foo would…") would be probed
 * for a table it never creates and reported as pending forever.
 */
function stripComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // /* block */
    .replace(/^\s*--.*$/gm, ' ')          // -- line
    .replace(/\s--.*$/gm, ' ');           // trailing -- after code
}

// ── Artifact extraction ──────────────────────────────────────────────
function artifactsOf(rawSql) {
  const sql = stripComments(rawSql);
  const out = [];
  const seen = new Set();
  const add = (a) => {
    const k = JSON.stringify(a);
    if (!seen.has(k)) { seen.add(k); out.push(a); }
  };

  for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([a-z0-9_]+)[`"]?/gi)) {
    add({ kind: 'table', table: m[1] });
  }
  /*
   * ADD COLUMN. The negative lookahead is load-bearing: `ALTER TABLE t ADD
   * INDEX idx_x (…)` otherwise matches this pattern and captures "INDEX" as a
   * column name, which then probes forever as missing.
   */
  for (const m of sql.matchAll(/ALTER\s+TABLE\s+[`"]?([a-z0-9_]+)[`"]?\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?!INDEX\b|KEY\b|UNIQUE\b|PRIMARY\b|CONSTRAINT\b|FOREIGN\b|FULLTEXT\b|SPATIAL\b|CHECK\b)[`"]?([a-z0-9_]+)[`"]?/gi)) {
    add({ kind: 'column', table: m[1], column: m[2] });
  }
  /*
   * Column RENAMES. The artifact is the NEW name — it does not exist until the
   * migration runs, which is exactly what makes it probe-able.
   *
   * ⚠ `MODIFY COLUMN` is deliberately NOT detected. It changes a column's TYPE,
   * not its existence, so probing the name would return "present" both before
   * and after — a FALSE PASS, which is worse than reporting UNKNOWN. Same for
   * DROP COLUMN / DROP TABLE: the honest check there is an absence, and mixing
   * presence and absence assertions into one status would obscure both.
   */
  for (const m of sql.matchAll(/ALTER\s+TABLE\s+[`"]?([a-z0-9_]+)[`"]?\s+CHANGE\s+(?:COLUMN\s+)?[`"]?[a-z0-9_]+[`"]?\s+[`"]?([a-z0-9_]+)[`"]?/gi)) {
    add({ kind: 'column', table: m[1], column: m[2] });
  }
  for (const m of sql.matchAll(/ALTER\s+TABLE\s+[`"]?([a-z0-9_]+)[`"]?\s+RENAME\s+COLUMN\s+[`"]?[a-z0-9_]+[`"]?\s+TO\s+[`"]?([a-z0-9_]+)[`"]?/gi)) {
    add({ kind: 'column', table: m[1], column: m[2] });
  }
  // Indexes added via ALTER (the other half of the pattern above).
  for (const m of sql.matchAll(/ALTER\s+TABLE\s+[`"]?([a-z0-9_]+)[`"]?\s+ADD\s+(?:UNIQUE\s+)?(?:INDEX|KEY)\s+[`"]?([a-z0-9_]+)[`"]?/gi)) {
    add({ kind: 'index', table: m[1], index: m[2] });
  }
  for (const m of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+[`"]?([a-z0-9_]+)[`"]?\s+ON\s+[`"]?([a-z0-9_]+)[`"]?/gi)) {
    add({ kind: 'index', table: m[2], index: m[1] });
  }
  /*
   * Seeded rows are read from the migration's OWN `NOT EXISTS` guard, not from
   * any quoted literal in the file. That distinction matters: these seeds also
   * reference the FAMILY key in a `WHERE EXISTS (… action_name = 'ef-QuickSight')`
   * PRE-CONDITION. Treating that as a created artifact would report the file as
   * only "partial" on a database where the precondition legitimately fails and
   * the migration is a correct no-op.
   */
  for (const m of sql.matchAll(/NOT\s+EXISTS\s*\([^)]*?action_name\s*=\s*'([^']+)'/gis)) {
    add({ kind: 'action', action: m[1] });
  }
  for (const m of sql.matchAll(/NOT\s+EXISTS\s*\([^)]*?property_key\s*=\s*'([^']+)'/gis)) {
    add({ kind: 'property', property: m[1] });
  }
  return out;
}

// ── Probes (all read-only) ───────────────────────────────────────────
async function tableExists(table) {
  const [[r]] = await db().query(
    `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [table],
  );
  return Number(r.n) > 0;
}
async function columnExists(table, column) {
  const [[r]] = await db().query(
    `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, column],
  );
  return Number(r.n) > 0;
}
async function indexExists(table, index) {
  const [[r]] = await db().query(
    `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`, [table, index],
  );
  return Number(r.n) > 0;
}
async function actionExists(action) {
  const [[r]] = await db().query(
    'SELECT COUNT(*) AS n FROM menu_action WHERE action_name = ?', [action],
  );
  return Number(r.n) > 0;
}
async function propertyExists(key) {
  const [[r]] = await db().query(
    'SELECT COUNT(*) AS n FROM easyfix_properties WHERE property_key = ?', [key],
  );
  return Number(r.n) > 0;
}

async function probe(a) {
  switch (a.kind) {
    case 'table':    return { ...a, present: await tableExists(a.table), label: a.table };
    case 'column':   return { ...a, present: await columnExists(a.table, a.column), label: `${a.table}.${a.column}` };
    case 'index':    return { ...a, present: await indexExists(a.table, a.index), label: `${a.table}:${a.index}` };
    case 'action':   return { ...a, present: await actionExists(a.action), label: `action ${a.action}` };
    case 'property': return { ...a, present: await propertyExists(a.property), label: `property ${a.property}` };
    default:         return { ...a, present: null, label: JSON.stringify(a) };
  }
}

async function checkMigrations() {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const results = [];
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const artifacts = artifactsOf(sql);
    if (artifacts.length === 0) {
      results.push({ file, status: 'unknown', artifacts: [] });
      continue;
    }
    const probed = [];
    for (const a of artifacts) probed.push(await probe(a));
    const present = probed.filter((p) => p.present).length;
    const status = present === probed.length ? 'applied' : present === 0 ? 'pending' : 'partial';
    results.push({ file, status, artifacts: probed });
  }
  return results;
}

async function cliMain() {
  const results = await checkMigrations();
  const by = (s) => results.filter((r) => r.status === s);

  console.log(`\nMigration status — ${results.length} file(s) in migrations/ (the PENDING set by convention)\n`);

  for (const r of by('applied')) {
    console.log(`✓ APPLIED  ${r.file}`);
  }
  for (const r of by('partial')) {
    console.log(`⚠ PARTIAL  ${r.file}`);
    for (const a of r.artifacts) console.log(`             ${a.present ? '✓' : '✗'} ${a.label}`);
  }
  for (const r of by('pending')) {
    console.log(`✗ PENDING  ${r.file}`);
    for (const a of r.artifacts) console.log(`             ✗ ${a.label}`);
  }
  for (const r of by('unknown')) {
    console.log(`? UNKNOWN  ${r.file}  (data-only migration — no artifact to probe; verify by hand)`);
  }

  const broken = by('pending').length + by('partial').length;
  console.log('');
  if (by('partial').length) {
    console.log('⚠ PARTIAL means some statements landed and others did not — re-run the file (they are'
      + ' IF NOT EXISTS / NOT EXISTS-guarded, so re-running is a no-op for what already applied).');
  }
  if (broken > 0) {
    console.log(`✗ ${broken} migration(s) not fully applied. Apply with:`);
    console.log('    mysql -h "$DB_HOST" -u "$DB_USER" -p "$DB_NAME" < migrations/<file>.sql');
    console.log('  Then move the file to migrations/executed/ to keep the convention honest.');
    process.exitCode = 1;
  } else {
    console.log('✓ Every migration with a detectable artifact is applied.');
  }
  if (by('unknown').length) {
    console.log(`ℹ ${by('unknown').length} data-only migration(s) could not be verified automatically (listed above).`);
  }
  await db().end();
}

module.exports = { checkMigrations, artifactsOf };

// CLI only when invoked directly (mirrors scripts/schema-verify.js).
if (require.main === module) {
  cliMain().catch((e) => { console.error('FAIL', e.message); process.exit(2); });
}
