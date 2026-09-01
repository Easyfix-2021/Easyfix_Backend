#!/usr/bin/env node
/*
 * audit-message-literals — two checks over the same idea: a value should be
 * named in ONE place, and prose should not quietly hold a second copy of it.
 *
 * WHY THIS EXISTS. On 2026-09-01 the employee-code prefix was corrected from EF
 * to E. The commit parameterised the regex, the padding, the SUBSTRING offset
 * and the SQL — and left three copies of the sentence `must be "EF" followed by
 * exactly 6 digits (e.g. EF000123)` in place, all of which shipped to
 * Production. Validation was never wrong. The operator was simply told to type a
 * code the very same regex rejects, which is a loop with no way out, and no test
 * could see it: the Joi test asserted only the half of the sentence that never
 * drifts, and the two service tests asserted a status code and nothing else.
 *
 *   RETIRED  a value a constant USED to hold, still named in prose.
 *            Wrong today. This is the EF class.
 *   LATENT   a message spelling out a value a constant currently owns.
 *            Right today, wrong the day the constant moves.
 *
 *   node scripts/audit-message-literals.mjs [root]      # both, exit 1 on findings
 *   node scripts/audit-message-literals.mjs --latent    # one at a time
 *
 * READ THIS BEFORE TRUSTING A CLEAN RUN. Earlier versions of both checks
 * reported zero findings three separate times and every zero was false — a scope
 * rule that excluded the only case worth catching, a `git log -L /re/,+0` range
 * git rejects as empty (so every lookup threw into a catch that returned []),
 * and a /g regex carrying lastIndex between files. A checker reporting 0 because
 * it crashed is indistinguishable from one reporting 0 because the code is
 * clean. tests/message-literals.test.js therefore plants a defect and asserts
 * these fire BEFORE it asserts the repo is clean; keep it that way.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SKIP = new Set(['node_modules', '.git', 'uploads', 'logs', 'coverage', 'dist', 'build',
  'stt-service', '.next', '.test-build']);

/*
 * A value is only worth chasing if it reads like an identifier. Ordinary English
 * is not: a message saying "recording" is prose even when some constant holds
 * 'recording'. The first version of the LATENT check had no such list and
 * drowned — its loudest finding was "app" matching inside "approved".
 */
const PROSE = new Set(['app', 'recording', 'transcript', 'email', 'sms', 'whatsapp', 'error',
  'status', 'active', 'all', 'none', 'true', 'false', 'admin', 'user', 'client', 'mobile', 'name',
  'code', 'date', 'time', 'open', 'closed', 'pending', 'approved', 'completed', 'cancelled',
  'image', 'video', 'file', 'link', 'text', 'phone', 'city', 'state', 'job', 'order']);

/*
 * Prose that ANNOUNCES itself as history is correct, not stale, and must pass.
 *
 * An allowlist of files was the obvious alternative and is the wrong shape: it
 * grows a line for every honest comment, and each addition looks identical in a
 * diff to someone silencing a real finding. This enforces the property instead —
 * name a retired value and say that it is retired — so every correct comment is
 * admitted automatically and a careless one is rejected by default. It is the
 * same reasoning the field-crypto boundary guard settled on.
 */
const HISTORICAL = /\b(was|were|used to|previously|formerly|superseded|retired|deprecated|legacy|old|until|before|briefly|no longer|renamed|replaced|instead of|not\b.*\bany ?more)\b|→|->|\d{4}-\d{2}-\d{2}/i;

const DECL = /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]{2,})\s*=\s*(?:'([^']*)'|"([^"]*)"|(\d{3,}))\s*;/gm;
const MSG = /(?:mkErr\s*\(\s*\d+\s*,|throw new Error\s*\(|modernError\s*\([^,]*,\s*\d+\s*,|legacyError\s*\([^,]*,|setError\s*\(|showToast\s*\(\s*\{[^}]*message\s*:)\s*(`[^`]*`|'[^']*'|"[^"]*")/g;
const JOI = /['"](?:string|number|any|array|date|boolean|object)\.[a-zA-Z.]+['"]\s*:\s*(`[^`]*`|'[^']*'|"[^"]*")/g;
const IMPORT = /(?:require\(\s*['"]([^'"]+)['"]\s*\)|from\s*['"]([^'"]+)['"])/g;

function collect(root) {
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(js|mjs|ts|tsx)$/.test(e.name)) files.push(f);
    }
  }(root));
  return new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
}

/*
 * EVERY constant, unfiltered. The two checks want different things and filtering
 * here served neither.
 *
 * It originally dropped any value under two characters, to stop the LATENT check
 * hunting for "E" in prose. That silently disqualified EMP_CODE_PREFIX = 'E' —
 * the exact constant this whole audit exists for — because a one-character
 * CURRENT value meant its history was never even looked up. Three repos came
 * back clean and the number meant nothing; the planted fixture in
 * tests/message-literals.test.js caught it on the first run.
 *
 * For RETIRED the length that matters is the OLD value's, since that is what is
 * searched for. For LATENT it is the current one. Each filters its own.
 */
function constantsIn(text) {
  const m = new Map();
  for (const d of text.matchAll(DECL)) m.set(d[1], String(d[2] ?? d[3] ?? d[4]));
  return m;
}

// Worth searching prose for: long enough to be an identifier, not an English word.
const searchable = (v) => String(v).length >= 2 && !PROSE.has(String(v).toLowerCase());

function messagesIn(text) {
  const out = [];
  const lines = text.split('\n');
  for (const re of [MSG, JOI]) {
    re.lastIndex = 0;                       // never share lastIndex across files
    for (const m of text.matchAll(re)) {
      const line = text.slice(0, m.index).split('\n').length;
      out.push({ line, quoted: m[1], raw: (lines[line - 1] || '').trim() });
    }
  }
  return out;
}

// Delimited, so 'EF' does not match inside FFEF4444 and 10 does not match a word.
const names = (hay, needle) =>
  new RegExp(`(?<![A-Za-z0-9_])${String(needle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`).test(hay);

function resolveSpec(spec, fromFile, root, text) {
  let base;
  if (spec.startsWith('@/')) base = path.join(root, 'src', spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  for (const c of [base, `${base}.js`, `${base}.mjs`, `${base}.ts`, `${base}.tsx`,
    path.join(base, 'index.js'), path.join(base, 'index.ts')]) if (text.has(c)) return c;
  return null;
}

// Does `file` (contents `gt`) import the module `target`? Module-scope
// visibility is what makes both checks precise; see each caller for why.
function importsFrom(file, gt, target, root, text) {
  for (const im of gt.matchAll(IMPORT)) {
    if (resolveSpec(im[1] || im[2], file, root, text) === target) return true;
  }
  return false;
}

/* ── RETIRED ─────────────────────────────────────────────────────────────── */
const git = (root, args) => execFileSync('git', args,
  { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] });

/*
 * Is the declaration present in the file AS COMMITTED at HEAD? Answered from git
 * itself rather than from an error message — see pastValues for why that is the
 * whole point. `HEAD:./rel` resolves relative to cwd, exactly as -L's `:rel` does.
 *
 * A file that is not committed at all is equally "no history", so a failure to
 * read it is `false` — but ONLY because the caller has already established that
 * git works here. Do not call this without that check.
 */
function declaredAtHead(root, rel, name) {
  let head;
  try { head = git(root, ['show', `HEAD:./${rel}`]); } catch { return false; }
  return new RegExp(`const\\s+${name}\\s*=`).test(head);
}

function pastValues(root, rel, name) {
  // `,+1` — NOT `,+0`, which git rejects as an empty range. That typo made every
  // lookup throw and the whole audit silently report clean.
  let out;
  try {
    out = git(root, ['log', '--format=', '-L', `/const ${name}\\s*=/,+1:${rel}`]);
  } catch (e) {
    /*
     * git fails here for two completely different reasons, and conflating them
     * is how this audit breaks in both directions:
     *
     *   an ANSWER   the declaration is not in the file at HEAD — the constant is
     *               new and uncommitted, so it genuinely HAS no past values.
     *   a FAILURE   anything else. An earlier version caught every error and
     *               returned [], so a broken invocation reported the repo clean.
     *
     * This used to be told apart by matching the text "regexec() failed to
     * match". THAT STRING IS NOT GIT'S. git prints whatever regerror(3) hands
     * it, and regerror is libc- and locale-dependent: BSD libc says "regexec()
     * failed to match", glibc says "No match". So the branch only ever fired on
     * macOS; on the Ubuntu CI runner every uncommitted constant turned into a
     * bogus "history lookup failed" finding, which is what reddened the deploy
     * on 2026-09-01 — green on the developer's machine, red in CI, same commit.
     *
     * So ask git the QUESTION the message stood for instead of reading the
     * message. Two probes, and only on the error path:
     *   1. is git usable here at all? If not this is a real failure, and the
     *      ORIGINAL error is surfaced rather than quietly answered "no history".
     *   2. is the declaration committed? If not, [] is the correct answer.
     */
    try { git(root, ['rev-parse', '--verify', 'HEAD']); } catch { throw e; }
    if (!declaredAtHead(root, rel, name)) return [];
    throw e;
  }
  const vals = new Set();
  const re = new RegExp(`^\\+\\s*(?:export\\s+)?const\\s+${name}\\s*=\\s*(?:'([^']*)'|"([^"]*)"|(\\d+))`, 'gm');
  for (const m of out.matchAll(re)) vals.add(String(m[1] ?? m[2] ?? m[3]));
  return [...vals];
}

/*
 * Only COMMENTS and user-facing STRINGS. Scanning every line made the check
 * useless: EXPORT_ROW_CAP's retired 5000 matched `const MAX_ROWS = 5000;` in
 * five unrelated modules, which is another constant, not prose about this one.
 */
const isProse = (line) => /^\s*(\/\/|\*|\/\*)/.test(line) || /['"`]/.test(line);

export function retired(root) {
  const text = collect(root);
  const findings = [];
  /*
   * SEARCHED ONLY WHERE THE CONSTANT IS VISIBLE — the same module-scope rule the
   * LATENT check uses, and for the same reason it was needed there.
   *
   * Repo-wide, this produced 281 findings on one constant: a `VERSION` in
   * docs/openapi-autogen.js that once read 'v1' matched every mention of
   * /integration/v1/* across the codebase. Those comments are about a URL
   * namespace and have no relationship to that constant at all. A short generic
   * token will always collide somewhere in a repo this size, so relatedness has
   * to come from the module graph rather than from the string.
   *
   * It still catches the case this exists for: the CRM's manage-users page
   * imports from @/lib/emp-code, so that module's retired 'EF' is in scope for
   * its comments — which is exactly where two stale ones were found.
   */
  for (const [f, t] of text) {
    const rel = path.relative(root, f);
    for (const [name, current] of constantsIn(t)) {
      let past;
      try { past = pastValues(root, rel, name); } catch (e) {
        // A failed history lookup is NOT "no history" — that conflation is what
        // made this report clean while doing nothing. Surface it.
        findings.push({ where: rel, name, error: `history lookup failed: ${e.message.split('\n')[0]}` });
        continue;
      }
      /*
       * VERSION TAGS ARE EXCLUDED. A retired 'v1' is discussed by name in every
       * module that has ever had a v1 of anything, and the token collides across
       * unrelated domains — field-crypto's envelope v1, FCM's v1 API and the
       * /integration/v1 URL namespace all appear as the bare word. It produced
       * 17 of the 19 surviving findings here and not one was about the constant.
       * A prefix like 'EF' is still caught: it is not a version tag.
       */
      // Filtered on the OLD value — it is the string being searched for.
      const stale = past.filter((v) => v !== current
        && searchable(v)
        && /^[A-Za-z0-9_.:/-]{2,24}$/.test(v)
        && !/^v\d+$/i.test(v));
      if (!stale.length) continue;
      for (const [g, gt] of text) {
        if (g !== f && !importsFrom(g, gt, f, root, text)) continue;
      const glines = gt.split('\n');
      glines.forEach((line, i) => {
        for (const old of stale) {
          if (!isProse(line) || !names(line, old)) continue;
          /*
           * The marker is looked for in the surrounding lines, not just this
           * one, because PROSE WRAPS. Two correct comments in
           * whatsapp-conversation.service.js were reported stale on exactly
           * this: "It used to be" ended one line and the retired template name
           * began the next, so a per-line test saw the name with no marker.
           */
          if (HISTORICAL.test(glines.slice(Math.max(0, i - 2), i + 2).join(' '))) continue;
          findings.push({ where: `${path.relative(root, g)}:${i + 1}`, name, old, current, line: line.trim().slice(0, 130) });
        }
      });
      }
    }
  }
  return findings;
}

/* ── LATENT ──────────────────────────────────────────────────────────────── */
/*
 * Visibility is MODULE-wide, not NAME-wide. Asking "is this constant imported
 * here?" cannot find the case worth finding, because a file that hardcodes a
 * value is by definition not importing the constant for it — positive-controlled
 * against the real EF bug, that rule did not fire. Asking "does this file import
 * anything from the module that owns the value" finds it.
 */

export function latent(root) {
  const text = collect(root);
  const consts = new Map([...text].map(([f, t]) => [f, constantsIn(t)]));
  const findings = [];
  for (const [f, t] of text) {
    const visible = new Map();
    for (const [n, v] of consts.get(f)) visible.set(n, { value: v, home: null });
    for (const im of t.matchAll(IMPORT)) {
      const target = resolveSpec(im[1] || im[2], f, root, text);
      if (!target) continue;
      for (const [n, v] of consts.get(target)) {
        if (!visible.has(n)) visible.set(n, { value: v, home: path.relative(root, target) });
      }
    }
    if (!visible.size) continue;
    for (const msg of messagesIn(t)) {
      for (const [name, { value, home }] of visible) {
        if (!searchable(value)) continue;   // filtered on the CURRENT value here
        if (new RegExp(`\\$\\{[^}]*\\b${name}\\b`).test(msg.quoted)) continue;   // derived already
        if (!names(msg.quoted, value)) continue;
        findings.push({ where: `${path.relative(root, f)}:${msg.line}`, name, value, home, line: msg.raw.slice(0, 130) });
      }
    }
  }
  return findings;
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const args = process.argv.slice(2);
  const root = path.resolve(args.find((a) => !a.startsWith('--')) ?? process.cwd());
  const only = args.find((a) => a.startsWith('--'));
  let bad = 0;
  if (only !== '--latent') {
    const r = retired(root);
    console.log(`RETIRED — a constant's former value still named in prose: ${r.length}`);
    for (const x of r) console.log(x.error ? `  ${x.where}  ${x.name}: ${x.error}`
      : `  ${x.where}  ${x.name}: ${JSON.stringify(x.old)} -> ${JSON.stringify(x.current)}\n      ${x.line}`);
    bad += r.length;
  }
  if (only !== '--retired') {
    const l = latent(root);
    console.log(`LATENT — a message spelling out a constant it could interpolate: ${l.length}`);
    for (const x of l) console.log(`  ${x.where}  ${x.name} = ${JSON.stringify(x.value)}`
      + (x.home ? `  [owned by ${x.home}]` : '  [same file]') + `\n      ${x.line}`);
    bad += l.length;
  }
  process.exit(bad ? 1 : 0);
}
