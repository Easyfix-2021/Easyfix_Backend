const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/*
 * Every `?` a mobile query sends must have a bind behind it.
 *
 * WHY THIS FILE EXISTS. `GET /api/mobile/training-videos` 500'd in PRODUCTION
 * on 2026-08-31: "You have an error in your SQL syntax ... near '?)".
 * `visibleVideoIdsSql()` interpolates TWO placeholders — one for the mandatory
 * half, one for the assigned half — and the route bound the technician ONCE.
 * mysql2's `pool.query` interpolates client-side, so the surplus `?` stayed in
 * the statement verbatim and MySQL rejected the whole thing. Every
 * technician's training list was empty for as long as that was deployed.
 *
 * The arity was ALREADY pinned — lms-schema-probe.test.js asserts the BUILDER
 * returns two. Nothing checked the CALLER, and the caller is where the count
 * was wrong. The second bind was not even missing from the codebase: it had
 * been pasted onto `/jobs/rejected`, which takes one, where a surplus bind is
 * silently ignored. One route was over-bound and the other under-bound by the
 * same edit, and only the under-bound one could fail.
 *
 * STATIC on purpose. Requiring `routes/mobile/index` pulls in the whole app and
 * never returns in a test process, and the runtime version needed a DB for the
 * schema probe. Reading the source needs neither, and covers every caller
 * rather than the two routes someone remembered to exercise.
 *
 * The builders' arity is DERIVED from their own source, not written down here.
 * A hand-kept number is the thing that was already wrong once.
 */

const ROOT = path.join(__dirname, '..');
const routeSrc = fs.readFileSync(path.join(ROOT, 'routes/mobile/index.js'), 'utf8');
const lmsSrc = fs.readFileSync(path.join(ROOT, 'services/lms.service.js'), 'utf8');

/*
 * `?` that MySQL will see. Everything inside `${...}` is JavaScript — a ternary
 * there (`videoGlobal ? 'x' : '1=0'`) is not a placeholder, and counting it was
 * the first wrong answer I got by hand.
 */
function placeholders(sql) {
  return (sql.replace(/\$\{[^}]*\}/g, '').match(/\?/g) || []).length;
}

/** The `?` count a builder contributes, read out of the builder itself. */
function builderArity(name, seen = new Set()) {
  if (seen.has(name)) return 0;
  seen.add(name);
  const start = lmsSrc.indexOf(`async function ${name}()`);
  assert.notEqual(start, -1, `${name} not found — rename it here too`);
  const body = lmsSrc.slice(start, lmsSrc.indexOf('\n}', start));
  let total = placeholders(body);
  // A builder that embeds another inherits its placeholders.
  for (const m of body.matchAll(/\$\{await (\w+)\(\)\}/g)) {
    total += builderArity(m[1], seen);
  }
  return total;
}

test('mandatory/visible builders contribute the arity their callers assume', () => {
  assert.equal(builderArity('mandatoryVideoIdsSql'), 1, 'the mandatory half binds the technician once');
  assert.equal(builderArity('visibleVideoIdsSql'), 2, 'the visible set binds them twice — this is the count that was wrong');
});

/*
 * `pool.query(`…`, <arg>)` — the template and whatever argument follows it.
 *
 * The argument is read by BALANCING brackets rather than by regex. A regex that
 * simply looked for the next `[...]` walked straight past a query whose binds
 * are a variable and matched a later query's array, inventing a mismatch that
 * was not there. Getting this wrong makes the guard cry wolf, and a guard that
 * cries wolf gets deleted.
 */
function queryCalls(src) {
  const out = [];
  const opener = /pool\.query\(\s*`/g;
  let m;
  while ((m = opener.exec(src)) !== null) {
    const sqlStart = m.index + m[0].length;
    const sqlEnd = src.indexOf('`', sqlStart);
    if (sqlEnd === -1) break;
    let i = src.indexOf(',', sqlEnd);
    if (i === -1) continue;
    i += 1;
    let depth = 0;
    let arg = '';
    for (; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' && depth === 0) break;
      else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
      arg += ch;
    }
    out.push({ sql: src.slice(sqlStart, sqlEnd), arg: arg.trim() });
  }
  return out;
}

test('every pool.query in routes/mobile/index.js binds what it interpolates', () => {
  const calls = queryCalls(routeSrc);
  assert.ok(calls.length > 5, `expected many queries, parsed ${calls.length} — the parser has drifted`);

  const failures = [];
  let checked = 0;
  for (const { sql, arg: bindsRaw } of calls) {
    /*
     * Only ARRAY LITERALS can be counted here. A query whose binds are a
     * variable builds its placeholder list at runtime too (`IN (${ph})`), so
     * both sides are unknowable statically — skipping is honest, guessing is
     * how a guard starts lying.
     */
    if (!bindsRaw.startsWith('[')) continue;
    checked += 1;
    let expected = placeholders(sql);
    // Add the arity of any SQL builder this query splices in.
    for (const m of sql.matchAll(/\$\{await (\w+)\(\)\}/g)) expected += builderArity(m[1]);

    // Bind arrays here are flat lists of simple expressions; a spread means the
    // length is only known at runtime, so it is not this guard's business.
    const binds = bindsRaw.replace(/\/\/[^\n]*/g, '').slice(1, -1).trim();
    if (binds.includes('...')) continue;
    const actual = binds === '' ? 0 : binds.split(',').filter((p) => p.trim() !== '').length;

    if (actual !== expected) {
      failures.push(`${expected} placeholder(s) but ${actual} bind(s):\n${sql.trim().split('\n')[0]}…`);
    }
  }
  assert.ok(checked > 5, `only ${checked} queries were countable — the guard has quietly stopped covering anything`);
  assert.deepEqual(failures, [],
    `A missing bind leaves a literal ? and MySQL rejects the statement.\n\n${failures.join('\n\n')}`);
});
