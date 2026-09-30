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
 *   GROUP_CONCAT-guarded ADD INDEX i        → does ANY index on t pass that guard?
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
 * ── executed/ IS SCANNED TOO, AND THAT IS THE POINT (2026-09-10) ────────
 * This script used to read ONLY `migrations/`. That made it structurally
 * blind to the failure it is most needed for: a file moved to
 * `migrations/executed/` before EVERY environment had applied it. The
 * convention says executed/ means "applied everywhere", so a file there is
 * never probed again — and the environment that missed it reports GREEN
 * forever. That is exactly how QA sat without
 * 2026-09-10-crm-issue-reporter-v2.sql while the check said everything was
 * fine and the issue-reporter endpoints 500'd.
 *
 * So executed/ files are probed as well, under a DIFFERENT question:
 *   migrations/  — "has this been applied YET?"      absent ⇒ PENDING
 *   executed/    — "is this environment MISSING one   absent ⇒ DRIFT
 *                   everybody believes is done?"
 * Drift is the louder finding of the two: pending is work not started,
 * drift is a belief that is false.
 *
 * TRANSIENT ARTIFACTS ARE EXCLUDED, BY MECHANISM AND NOT BY ALLOWLIST. A
 * migration that CREATEs a scratch table and DROPs it again in the same file
 * (executed/2026-08-25-location-dedupe-and-upsert.sql builds `location_keep`
 * at line 91 and drops it at line 131) leaves no artifact by design, and
 * probing for one reports permanent drift on a file that is perfectly
 * applied. `dropsOf()` reads the file's own DROP statements, so the file
 * itself declares what is temporary.
 *
 * MEASURED BEFORE SHIPPING, because a checker that flags nearly everything
 * needs redesigning rather than an allowlist: against QA, 208 executed files
 * → 155 applied, 41 data-only, 12 flagged (~7%). One of the 12 was the real
 * defect this was written for.
 *
 * EXIT CODES (this runs inside `npm run verify:all`):
 *   0  everything with a detectable artifact is applied
 *   1  at least one migration is PENDING or PARTIALLY applied, OR an
 *      executed/ migration is MISSING from this environment (drift)
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
const EXECUTED_DIR = path.join(MIGRATIONS_DIR, 'executed');

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

/*
 * GROUP_CONCAT-GUARDED ADD INDEX (2026-09-29). The index migrations of Aug 2026
 * wrap each ADD in a guard that skips it when an EQUIVALENT index exists:
 *
 *   SET @has_x = (… HAVING GROUP_CONCAT(column_name ORDER BY seq_in_index)
 *                   IN ('a,b', 'a,b,c') OR … LIKE 'a,b,c,%' …);
 *   SET @ddl_x = IF(@has_x = 0, 'ALTER TABLE t ADD INDEX idx_x (a, b, c)', 'SELECT 1');
 *
 * So the NAME is not the artifact — whatever the guard accepts is. QA's
 * tbl_job_transaction already carries unique_job_id (fk_job_id), the guard in
 * executed/2026-08-17-phe-team-read-indexes.sql correctly never creates
 * idx_job_tx_job, and a name probe reported permanent drift for it.
 *
 * The guard is MIRRORED, not approximated: its `=` / `IN (…)` literals become
 * exact column lists and its `LIKE 'p,%'` literals become column prefixes, so
 * the checker says "present" exactly when re-running the file is a no-op. Any
 * HAVING term it cannot mirror (AND, NON_UNIQUE, another LIKE shape) drops the
 * artifact back to the name probe rather than guessing wider.
 *
 * Returns Map<"table.index", { exact, prefixes }>. The guard is tied to its ADD
 * through the variable the IF reads, not by proximity. UNIQUE ADDs are not
 * matched: a non-unique index on the same columns does not deliver the
 * constraint. Plain CREATE INDEX / unguarded ADD keep the name probe.
 */
function guardAccepts(body, table) {
  const having = /\bHAVING\b([\s\S]*)/i.exec(body);
  if (!having || !new RegExp(`table_name\\s*=\\s*'${table}'`, 'i').test(body)) return null;
  const exact = [];
  const prefixes = [];
  let rest = having[1];
  for (const m of having[1].matchAll(/GROUP_CONCAT\(\s*column_name\s+ORDER\s+BY\s+seq_in_index\s*\)\s*(=|IN|LIKE)\s*(\([^)]*\)|'[^']*')/gi)) {
    const lits = [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1].toLowerCase());
    if (m[1].toUpperCase() !== 'LIKE') exact.push(...lits);
    else if (/^[^%]+,%$/.test(lits[0])) prefixes.push(lits[0].slice(0, -2));
    else return null;
    rest = rest.replace(m[0], ' ');
  }
  // What is left must be only the ORs joining mirrored terms and the subquery's closing `) alias )`.
  if (!exact.length && !prefixes.length) return null;
  if (!/^(?:\s|\bOR\b)*$/i.test(rest.replace(/\)\s*\w+\s*\)\s*$/, ''))) return null;
  return { exact, prefixes };
}

function guardedIndexes(sql) {
  const out = new Map();
  for (const m of sql.matchAll(/SET\s+@\w+\s*=\s*IF\(\s*@(\w+)\s*=\s*0\s*,\s*'([^']*)'/gi)) {
    const add = /ALTER\s+TABLE\s+[`"]?([a-z0-9_]+)[`"]?\s+ADD\s+(?:INDEX|KEY)\s+[`"]?([a-z0-9_]+)[`"]?\s*\(/i.exec(m[2]);
    if (!add) continue;
    const guard = new RegExp(`SET\\s+@${m[1]}\\s*=\\s*\\(([^;]*)`, 'i').exec(sql);
    const accepts = guard && guardAccepts(guard[1], add[1]);
    if (accepts) out.set(`${add[1]}.${add[2]}`.toLowerCase(), accepts);
  }
  return out;
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
  const guarded = guardedIndexes(sql);
  for (const m of sql.matchAll(/ALTER\s+TABLE\s+[`"]?([a-z0-9_]+)[`"]?\s+ADD\s+(?:UNIQUE\s+)?(?:INDEX|KEY)\s+[`"]?([a-z0-9_]+)[`"]?/gi)) {
    const accepts = guarded.get(`${m[1]}.${m[2]}`.toLowerCase());
    add(accepts ? { kind: 'index', table: m[1], index: m[2], accepts } : { kind: 'index', table: m[1], index: m[2] });
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
/*
 * Any index on `table` the migration's guard would accept: its column list is
 * one of `exact`, or starts with one of `prefixes` plus a comma. Compared in
 * JS, not with SQL LIKE: `_` is a LIKE wildcard and every column here has one.
 */
async function equivalentIndexExists(table, { exact, prefixes }) {
  const [rows] = await db().query(
    `SELECT INDEX_NAME AS name, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
       FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      GROUP BY INDEX_NAME`, [table],
  );
  return rows.some((r) => {
    const cols = String(r.cols).toLowerCase();
    return exact.includes(cols) || prefixes.some((p) => cols.startsWith(`${p},`));
  });
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
    case 'index':
      if (a.accepts) {
        const accepted = [...a.accepts.exact, ...a.accepts.prefixes.map((p) => `${p},…`)].join(' | ');
        return { ...a, present: await equivalentIndexExists(a.table, a.accepts), label: `${a.table}:${a.index} (or any index on ${accepted})` };
      }
      return { ...a, present: await indexExists(a.table, a.index), label: `${a.table}:${a.index}` };
    case 'action':   return { ...a, present: await actionExists(a.action), label: `action ${a.action}` };
    case 'property': return { ...a, present: await propertyExists(a.property), label: `property ${a.property}` };
    default:         return { ...a, present: null, label: JSON.stringify(a) };
  }
}

/*
 * The artifacts a file DROPS. Used to exclude scratch objects a migration
 * creates and removes within itself — probing those reports permanent drift on
 * a file that applied perfectly.
 *
 * Deliberately narrow: only DROP TABLE and DROP INDEX, the two shapes that can
 * cancel an artifact `artifactsOf` extracts. It is NOT a general "was this
 * later removed" check — a DROP in a LATER migration is real drift information
 * and must keep reporting, because the artifact genuinely is not there and a
 * reader deserves to see why.
 */
function dropsOf(sql) {
  const clean = stripComments(sql);
  const out = { tables: new Set(), indexes: new Set() };
  for (const m of clean.matchAll(/\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?`?([A-Za-z0-9_]+)`?/gi)) {
    out.tables.add(m[1].toLowerCase());
  }
  for (const m of clean.matchAll(/\bDROP\s+INDEX\s+`?([A-Za-z0-9_]+)`?\s+ON\s+`?([A-Za-z0-9_]+)`?/gi)) {
    out.indexes.add(`${m[2].toLowerCase()}.${m[1].toLowerCase()}`);
  }
  return out;
}

/** True when the file itself removes this artifact — i.e. it was scratch. */
function isTransient(artifact, drops) {
  if (artifact.kind === 'table') return drops.tables.has(String(artifact.table).toLowerCase());
  if (artifact.kind === 'column') return drops.tables.has(String(artifact.table).toLowerCase());
  if (artifact.kind === 'index') {
    return drops.tables.has(String(artifact.table).toLowerCase())
      || drops.indexes.has(`${String(artifact.table).toLowerCase()}.${String(artifact.index).toLowerCase()}`);
  }
  return false;
}

/*
 * Probe every .sql in one directory. Shared by both scans so the two answers
 * are produced by ONE piece of code — the pending set and the executed set
 * differing only in what an absent artifact MEANS, never in how it is detected.
 */
async function checkDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const results = [];
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const drops = dropsOf(sql);
    const artifacts = artifactsOf(sql).filter((a) => !isTransient(a, drops));
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

async function checkMigrations() {
  return checkDir(MIGRATIONS_DIR);
}

/*
 * The executed/ set. Same probing, opposite meaning: these are supposed to be
 * applied EVERYWHERE, so anything absent here is this environment silently
 * lacking a migration the repo considers finished.
 */
async function checkExecuted() {
  return checkDir(EXECUTED_DIR);
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
    console.log('✓ Every migration in migrations/ with a detectable artifact is applied.');
  }
  if (by('unknown').length) {
    console.log(`ℹ ${by('unknown').length} data-only migration(s) could not be verified automatically (listed above).`);
  }

  /*
   * ── The executed/ set ────────────────────────────────────────────────
   *
   * Reported as a COUNT when clean and a LIST when not. Printing 155 "✓
   * APPLIED" lines would bury the two that matter — the whole reason this
   * scan exists is that a missing executed migration is currently invisible,
   * and a wall of green is the next best way to keep it that way.
   *
   * The DENOMINATOR is always printed beside the finding: "3 of 208" is a
   * statement about coverage, "3 drifted" is not.
   */
  const ex = await checkExecuted();
  const exBy = (st) => ex.filter((r) => r.status === st);
  const drifted = [...exBy('pending'), ...exBy('partial')];

  console.log('');
  console.log(`── migrations/executed/ — ${ex.length} file(s), the set this repo believes is applied EVERYWHERE`);
  console.log(`   ${exBy('applied').length} verified present · ${exBy('unknown').length} data-only (no artifact to probe) `
    + `· ${drifted.length} MISSING HERE`);

  if (drifted.length) {
    console.log('');
    console.log(`✗ DRIFT — ${drifted.length} of ${ex.length} executed migration(s) are NOT applied to this database.`);
    console.log('  These sit in migrations/executed/, which means the repo considers them done');
    console.log('  everywhere. This environment does not have them, and nothing else would say so.');
    for (const r of drifted) {
      console.log(`    ${r.status === 'partial' ? '⚠ PARTIAL' : '✗ ABSENT '}  ${r.file}`);
      for (const a of r.artifacts) if (!a.present) console.log(`                 ✗ ${a.label}`);
    }
    console.log('');
    console.log('  Apply with:');
    console.log('    mysql -h "$DB_HOST" -u "$DB_USER" -p "$DB_NAME" < migrations/executed/<file>.sql');
    console.log('  Every migration in this repo is IF NOT EXISTS / NOT EXISTS-guarded, so re-running');
    console.log('  one that IS applied is a no-op — when in doubt, run it.');
    process.exitCode = 1;
  }

  await db().end();
}

module.exports = { checkMigrations, checkExecuted, artifactsOf, dropsOf, isTransient, probe };

// CLI only when invoked directly (mirrors scripts/schema-verify.js).
if (require.main === module) {
  cliMain().catch((e) => { console.error('FAIL', e.message); process.exit(2); });
}
