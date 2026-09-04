#!/usr/bin/env node
/*
 * check-migration-columns — would this migration's INSERTs actually run?
 *
 * WHY THIS EXISTS. migrations/2026-09-04-seed-client-request-reasons.sql failed
 * on its first run with "Field 'is_new' doesn't have a default value". The file
 * had CARRIED A COMMENT WARNING ABOUT EXACTLY THAT, inherited from the seed it
 * was modelled on — "if this DB's action_taken_reason has any additional NOT
 * NULL column without a default (e.g. is_new / created_on), add it to each
 * INSERT" — and it still shipped, because a warning in prose is not a check.
 *
 * The failure is invisible until the moment the migration runs, which on
 * Production is the worst possible time to discover it.
 *
 * WHAT IT CHECKS. For every INSERT in a migration, every column on the target
 * table that is NOT NULL, has no DEFAULT, and is not AUTO_INCREMENT must be
 * named in the INSERT's column list. That is precisely the set MySQL will
 * reject, and it is knowable only from the SCHEMA — no amount of reading the
 * SQL text can tell you whether `is_new` has a default.
 *
 * So this needs a live connection, which makes it a pre-deploy check rather
 * than a CI gate. It runs against whatever DB_* the environment points at; run
 * it against the database you are about to migrate, not a different one — a
 * column can be nullable on QA and NOT NULL on Production.
 *
 *   npm run check:migrations              # every file in migrations/
 *   node scripts/check-migration-columns.mjs migrations/foo.sql
 *
 * Exit 1 on any INSERT that would fail. Exit 2 if the DB is unreachable —
 * DELIBERATELY not 0: "I could not check" must never read as "it is fine",
 * which is the whole class of bug this repo keeps finding.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import 'dotenv/config';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DIR = path.join(ROOT, 'migrations');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const files = args.length
  ? args.map((a) => path.resolve(a))
  : fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort().map((f) => path.join(DIR, f));

if (!files.length) {
  console.log('no migrations to check');
  process.exit(0);
}

/*
 * Parse `INSERT INTO tbl (a, b, c)`. Backticks optional, whitespace and
 * newlines free-form. An INSERT without a column list is reported separately:
 * it is legal SQL but positional, so it breaks the moment a column is added,
 * and this check cannot verify it either.
 */
const INSERT = /INSERT\s+(?:IGNORE\s+)?INTO\s+`?([A-Za-z0-9_]+)`?\s*(\(([^)]*)\))?/gi;

function insertsIn(sql) {
  const out = [];
  for (const m of sql.matchAll(INSERT)) {
    out.push({
      table: m[1],
      cols: m[3] ? m[3].split(',').map((c) => c.trim().replace(/`/g, '').toLowerCase()).filter(Boolean) : null,
      at: sql.slice(0, m.index).split('\n').length,
    });
  }
  return out;
}

const { default: mysql } = await import('mysql2/promise');
let conn;
try {
  conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectTimeout: 10000,
  });
} catch (e) {
  console.error(`cannot reach the database, so nothing was checked: ${e.message}`);
  console.error('exiting 2 — an unchecked migration must not look like a clean one.');
  process.exit(2);
}

const cache = new Map();
async function requiredColumns(table) {
  if (cache.has(table)) return cache.get(table);
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [process.env.DB_NAME, table],
  );
  if (!rows.length) { cache.set(table, null); return null; }   // table not here
  const need = rows
    .filter((r) => r.IS_NULLABLE === 'NO'
      && r.COLUMN_DEFAULT === null
      && !/auto_increment/i.test(r.EXTRA || '')
      // A generated column is computed, never supplied.
      && !/GENERATED/i.test(r.EXTRA || ''))
    .map((r) => String(r.COLUMN_NAME).toLowerCase());
  cache.set(table, need);
  return need;
}

let problems = 0;
let checked = 0;
for (const file of files) {
  const sql = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  for (const ins of insertsIn(sql)) {
    const need = await requiredColumns(ins.table);
    if (need === null) {
      console.log(`  ?  ${rel}:${ins.at} — table \`${ins.table}\` is not in ${process.env.DB_NAME}; skipped`);
      continue;
    }
    if (!ins.cols) {
      console.log(`  !  ${rel}:${ins.at} — INSERT INTO \`${ins.table}\` has no column list, so it is positional and cannot be checked`);
      problems += 1;
      continue;
    }
    checked += 1;
    const missing = need.filter((c) => !ins.cols.includes(c));
    if (missing.length) {
      problems += 1;
      console.error(`  ✗  ${rel}:${ins.at} — INSERT INTO \`${ins.table}\` omits NOT NULL column(s) with no default: ${missing.join(', ')}`);
      console.error(`     MySQL will reject this statement: "Field '${missing[0]}' doesn't have a default value"`);
    }
  }
}

await conn.end();
console.log(`\n${checked} INSERT(s) checked against ${process.env.DB_NAME}. ${problems ? `${problems} problem(s).` : 'All supply every required column.'}`);
process.exit(problems ? 1 : 0);
