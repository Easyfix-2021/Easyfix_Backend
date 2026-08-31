#!/usr/bin/env node
/**
 * Every column our SQL names, checked against the live INFORMATION_SCHEMA.
 * Read-only.
 *
 * WHY THIS EXISTS ALONGSIDE scripts/schema-verify.js. That file checks a
 * HAND-MAINTAINED list of tables and columns, so it only protects what somebody
 * remembered to add — and on 2026-08-27 two phantom-column bugs shipped past it
 * because the columns were never listed:
 *
 *   Supply Gap        selected six tbl_user columns from tbl_easyfixer and
 *                     500'd the report on every environment.
 *   Technician ratings selected `id` from a table whose key is `table_id`. That
 *                     one was CAUGHT and swallowed, so every technician's
 *                     Ratings screen returned an empty list — permanently, with
 *                     one warn line and no error anywhere.
 *
 * This derives the list from the SQL ITSELF, so a query cannot name a column
 * without being checked. Nothing to remember, nothing to keep in sync.
 *
 * TWO SHAPES, because they fail differently:
 *   alias.column   — resolved per QUERY, never per file. Aliases collide across
 *                    queries in one file (TC is tbl_client here and tbl_city
 *                    there), and a file-wide map invents phantom findings.
 *   bare column    — only for a query reading exactly ONE table with no alias.
 *                    This is the Supply Gap shape and the alias pass is blind
 *                    to it.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

const ROOT = path.join(__dirname, '..');

const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/^\s*\/\/.*$/gm, '');

/*
 * Words that can follow a table name and are NOT an alias.
 *
 * Getting this list wrong is not cosmetic. The first version of this script
 * omitted WHERE, so `FROM tbl_easyfixer WHERE …` read "WHERE" as the alias,
 * concluded the query was alias-scoped, and skipped it — coming back clean on
 * the very bug it was written to find. It is only a checker if it fails on that
 * input, which tests/phantom-column-verifier.test.js pins.
 */
const NOT_AN_ALIAS = new Set([
  'on', 'using', 'where', 'group', 'order', 'limit', 'set', 'values', 'union',
  'left', 'right', 'inner', 'outer', 'join', 'having', 'for', 'as', 'and', 'or',
  'offset', 'straight_join', 'natural', 'cross', 'lateral',
]);

const SELECT_KEYWORDS = new Set([
  'select', 'distinct', 'from', 'as', 'and', 'or', 'not', 'null', 'is', 'in',
  'where', 'order', 'by', 'group', 'limit', 'all', 'case', 'when', 'then',
  'else', 'end', 'asc', 'desc', 'true', 'false',
]);

/*
 * ${...} interpolations are BLANKED before scanning.
 *
 * What is inside them is JavaScript, not literal SQL, and it is conditional by
 * construction — the drift-tolerant pattern this codebase uses for optional
 * columns looks like:
 *
 *   ${hasCityNameCol ? 'e.city_name' : 'c.city_name AS city_name'}
 *
 * Reading that as literal SQL reports `e.city_name` as a phantom on a
 * deployment that does not have it, which is precisely the case the code
 * already handles. Flagging a working guard is how a checker gets allowlisted
 * into uselessness.
 *
 * THE COST, stated plainly: a WHERE fragment assembled in a JS string and
 * interpolated later is invisible here. That is real — client-tech-mapping's
 * `clauses.push('e.city_id = ?')` was a genuine phantom this scan could not
 * see, and it was found by reading. This checks literal SQL; it does not
 * replace reading the code.
 */
function sqlLiterals(src) {
  return [...src.matchAll(/`([^`]*)`/g)]
    .map((m) => m[1].replace(/\$\{[^}]*\}/g, ' '))
    .filter((b) => /\bSELECT\b/i.test(b));
}

function aliasMap(body) {
  const m = new Map();
  const re = /\b(?:FROM|JOIN)\s+`?([a-z_][a-z0-9_]*)`?\s+(?:AS\s+)?([A-Za-z][A-Za-z0-9_]*)/gi;
  for (const x of body.matchAll(re)) {
    if (NOT_AN_ALIAS.has(x[2].toLowerCase())) continue;
    m.set(x[2], x[1].toLowerCase());
  }
  return m;
}

/* Aliases that name a SUBQUERY — their "columns" are projections, not base columns. */
function derivedAliases(body) {
  return new Set([...body.matchAll(/\)\s*(?:AS\s+)?([A-Za-z][A-Za-z0-9_]*)/gi)].map((m) => m[1]));
}

function scanFile(rel, src, cols) {
  const out = [];
  for (const body of sqlLiterals(strip(src))) {
    const map = aliasMap(body);
    const derived = derivedAliases(body);

    // ── alias.column ────────────────────────────────────────────────
    for (const ref of body.matchAll(/\b([A-Za-z][A-Za-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/g)) {
      const [, alias, col] = ref;
      if (derived.has(alias)) continue;
      const table = map.get(alias);
      if (!table || !cols.has(table)) continue;
      if (!cols.get(table).has(col.toLowerCase())) {
        out.push({ rel, kind: 'alias', ref: `${alias}.${col}`, table, col });
      }
    }

    // ── bare column, single unaliased table ─────────────────────────
    const tables = [...body.matchAll(/\b(?:FROM|JOIN)\s+`?([a-z_][a-z0-9_]*)`?/gi)].map((m) => m[1].toLowerCase());
    const uniq = [...new Set(tables)];
    if (uniq.length !== 1) continue;
    const table = uniq[0];
    if (!cols.has(table)) continue;
    if ([...map.values()].includes(table)) continue;    // aliased: handled above
    if (/\bFROM\s*\(/i.test(body)) continue;            // FROM a subquery
    const sel = body.slice(body.search(/\bSELECT\b/i) + 6, body.search(/\bFROM\b/i));
    if (!sel.trim() || sel.includes('(') || sel.includes('*') || sel.includes('$')) continue;
    for (const part of sel.split(',')) {
      const n = part.replace(/\s+AS\s+[A-Za-z_][\w]*\s*$/i, '').trim().replace(/`/g, '');
      if (!/^[a-z_][a-z0-9_]*$/i.test(n) || SELECT_KEYWORDS.has(n.toLowerCase())) continue;
      if (!cols.get(table).has(n.toLowerCase())) {
        out.push({ rel, kind: 'bare', ref: `${table}.${n}`, table, col: n });
      }
    }
  }
  return out;
}

async function liveColumns() {
  const [rows] = await pool.query(
    'SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.columns WHERE TABLE_SCHEMA = DATABASE()');
  const m = new Map();
  for (const r of rows) {
    const t = r.t.toLowerCase();
    if (!m.has(t)) m.set(t, new Set());
    m.get(t).add(r.c.toLowerCase());
  }
  return m;
}

function sourceFiles() {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js')) files.push(full);
    }
  };
  for (const r of ['services', 'routes']) walk(path.join(ROOT, r));
  return files;
}

async function verifyPhantomColumns() {
  const cols = await liveColumns();
  const findings = [];
  const files = sourceFiles();
  for (const f of files) {
    findings.push(...scanFile(path.relative(ROOT, f), fs.readFileSync(f, 'utf8'), cols));
  }
  return { findings, filesScanned: files.length };
}

async function cliMain() {
  const { findings, filesScanned } = await verifyPhantomColumns();
  console.log(`Scanned ${filesScanned} files under services/ and routes/`);
  if (!findings.length) {
    console.log('✓ No phantom columns — every column our SQL names exists.');
    return;
  }
  const seen = new Set();
  const unique = findings.filter((f) => {
    const k = `${f.rel}|${f.ref}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  console.log(`✗ ${unique.length} PHANTOM COLUMN REFERENCE(S) — these 500 the moment the query runs:`);
  for (const f of unique) console.log(`  ${f.rel}  ${f.ref}  (${f.kind})`);
  process.exitCode = 1;
}

module.exports = { verifyPhantomColumns, scanFile, aliasMap, NOT_AN_ALIAS };

if (require.main === module) {
  cliMain().catch((e) => { console.error('FAIL', e.message); process.exit(2); }).finally(() => pool.end());
}
