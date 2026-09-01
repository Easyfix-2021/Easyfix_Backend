#!/usr/bin/env node
/**
 * Every RBAC city-scope predicate goes through lib/scope.js::cityScopeSql.
 * Static scan, no database, no network.
 *
 * WHY THIS EXISTS. `e.efr_cityId IN (…)` is never true for NULL, so the 2,427
 * technicians with no city belonged to no operator's scope and were invisible
 * to all of them — including the people whose job is to give them one. The fix
 * widens the predicate; the risk is that it only stays fixed where somebody
 * remembered. It was copy-pasted into TEN call sites across five files before
 * anyone noticed, and the copies did not drift apart — they were all wrong
 * together, which is why the counts strip and the list agreed on the wrong
 * answer instead of disagreeing loudly enough to be found.
 *
 * DEFAULT-DENY, AND WHY IT HAD TO BE. The obvious check is to look for the
 * scope shape — an `IN (…)` on a city column built from `ci.ids`. That check
 * is worthless: hoisting the ids into a local first
 *
 *     const ids = scope.cities.ids;
 *     where.push(`e.efr_cityId IN (${ids.map(() => '?').join(',')})`);
 *
 * evades it completely, and the scan comes back clean on precisely the bug it
 * was written to catch. So raw `efr_cityId IN (` is banned outright and the
 * legitimate exceptions carry a marker.
 *
 * THE EXCEPTION THAT PROVES THE RULE. Not every `efr_cityId IN (…)` is RBAC.
 * routes/client/index.js serves a client-facing `?cityIds=` FILTER — the user
 * picking cities for themselves. That one must stay narrow: widening it would
 * show a client technicians nobody scoped to them. A filter and a scope look
 * identical in SQL and differ entirely in meaning, so the author has to say
 * which one they are writing:
 *
 *     // scope-guard: user-supplied filter, not RBAC — must stay narrow
 *
 * WHAT THIS DOES NOT CHECK. Job scoping keys off address city (`ad.city_id`,
 * `A.city_id`) and has the same NULL blind spot, but widening it is a product
 * decision with a much larger blast radius, so it is deliberately out of scope
 * here rather than silently changed. GUARDED_COLUMNS is where it would go.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['services', 'routes', 'lib'];

/* The helper's own home — it is the one place allowed to build the predicate. */
const HELPER_FILE = path.join('lib', 'scope.js');

/*
 * Columns whose IN-list must go through the helper. Technician city only, for
 * now: it is the one where "no city" provably means "a real technician nobody
 * has placed yet" rather than "no row".
 */
const GUARDED_COLUMNS = ['efr_cityId'];

const MARKER = /scope-guard:/;

/*
 * Comments blanked LINE BY LINE, because every finding here is reported by line
 * number and the marker below is looked up by line number.
 *
 * The regex version of this — the one in verify-phantom-columns.js — blanks
 * `/^\s*\/\/.*$/gm`, and `\s` matches a newline. A blank line before a comment
 * is therefore swallowed whole: routes/client/index.js came out 98 lines
 * SHORTER than it went in, so the one real finding was reported at 3281 when it
 * lives at 3369, and markedNear() would have read someone else's lines looking
 * for the marker. A checker that points at the wrong line is worse than none —
 * it sends you to innocent code. That file gets away with it only because it
 * never reports a line number.
 */
function strip(src) {
  let inBlock = false;
  return src.split('\n').map((line) => {
    let out = '';
    for (let i = 0; i < line.length; i += 1) {
      if (inBlock) {
        if (line[i] === '*' && line[i + 1] === '/') { inBlock = false; i += 1; }
        out += ' ';
        continue;
      }
      if (line[i] === '/' && line[i + 1] === '*') { inBlock = true; out += '  '; i += 1; continue; }
      if (line[i] === '/' && line[i + 1] === '/') {
        return MARKER.test(line) ? line : out + ' '.repeat(line.length - i);
      }
      out += line[i];
    }
    return out;
  }).join('\n');
}

/*
 * The marker counts if it appears on the offending line, or anywhere in the
 * unbroken comment block directly above it.
 *
 * A fixed lookback of N lines does not survive contact with real code: the
 * exception worth marking is exactly the one that needs a paragraph to justify,
 * and the paragraph pushes the marker out of range. The first version allowed
 * two lines, and the very first real exception — the client-portal city filter
 * — needed four. Walking the comment block means the justification can be as
 * long as it needs to be, and the marker still cannot drift onto unrelated
 * code, because any statement between the two ends the walk.
 */
const COMMENT_OR_BLANK = /^\s*(?:\/\/|\*|\/\*)|^\s*$/;

function markedNear(lines, i) {
  if (MARKER.test(lines[i])) return true;
  for (let k = i - 1; k >= 0; k -= 1) {
    if (!COMMENT_OR_BLANK.test(lines[k])) return false;
    if (MARKER.test(lines[k])) return true;
  }
  return false;
}

function scanFile(rel, src) {
  const findings = [];
  const raw = src.split('\n');
  const lines = strip(src).split('\n');
  const re = new RegExp(`\\b(?:${GUARDED_COLUMNS.join('|')})\\s+IN\\s*\\(`, 'i');
  lines.forEach((line, i) => {
    /* Reset-free test: `re` carries no /g, so lastIndex cannot leak across lines. */
    if (!re.test(line)) return;
    if (/cityScopeSql/.test(line)) return;
    if (markedNear(raw, i)) return;
    findings.push({ file: rel, line: i + 1, text: raw[i].trim() });
  });
  return findings;
}

function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.js')) out.push(rel);
    }
  };
  for (const d of SCAN_DIRS) if (fs.existsSync(path.join(ROOT, d))) walk(d);
  return out;
}

/*
 * The helper is checked by CALLING it, not by reading it. A regex over its body
 * passes just as happily on a helper someone has quietly gutted back to a plain
 * IN-list, which is the exact regression this file exists to prevent.
 */
function helperFindings() {
  const { cityScopeSql } = require(path.join(ROOT, 'lib', 'scope'));
  const sql = cityScopeSql('e.efr_cityId', 'e.efr_id', [1, 2]);
  const out = [];
  if (!/IS NULL/.test(sql)) {
    out.push({ file: HELPER_FILE, line: 0, text: `cityScopeSql no longer admits city-less rows: ${sql}` });
  }
  if (!/e\.efr_id IS NOT NULL/.test(sql)) {
    out.push({ file: HELPER_FILE, line: 0, text: `cityScopeSql no longer anchors on the technician row: ${sql}` });
  }
  if ((sql.match(/\?/g) || []).length !== 2) {
    out.push({ file: HELPER_FILE, line: 0, text: `cityScopeSql changed its placeholder arity: ${sql}` });
  }
  return out;
}

function verifyScopePredicates() {
  const findings = [];
  const files = sourceFiles();
  for (const rel of files) {
    if (rel === HELPER_FILE) continue;
    findings.push(...scanFile(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8')));
  }
  findings.push(...helperFindings());
  return { findings, scanned: files.length };
}

function cliMain() {
  const { findings, scanned } = verifyScopePredicates();
  console.log(`Scanned ${scanned} files under ${SCAN_DIRS.join('/, ')}/`);
  if (!findings.length) {
    console.log('✓ Every RBAC city-scope predicate goes through lib/scope.js::cityScopeSql.');
    return 0;
  }
  console.error(`\n✗ ${findings.length} hand-rolled city-scope predicate(s):\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}`);
    console.error(`    ${f.text}`);
  }
  console.error(`
Each of these excludes technicians whose city is NULL, hiding real rows from
every scoped operator. Use cityScopeSql(cityCol, presentCol, ids) from
lib/scope.js — it keeps the same placeholder count, so params are unchanged.

If this really is a user-supplied FILTER and not an RBAC scope, say so on the
line above and it will be left alone:

    // scope-guard: user-supplied filter, not RBAC — must stay narrow
`);
  return 1;
}

if (require.main === module) process.exit(cliMain());

module.exports = { verifyScopePredicates, scanFile, helperFindings, markedNear, GUARDED_COLUMNS };
