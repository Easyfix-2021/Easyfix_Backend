/*
 * Recording length — every place we ask Plivo to record must lift its 60 s cap.
 *
 * THE BUG (job #538806, 2026-09-11). A 236 s conference call produced a 59 s
 * recording; Plivo's recording-ready callback fired ~62 s after the room opened,
 * while the call was still live. <Record maxLength> and the Record API's
 * time_limit both DEFAULT TO 60 s, recordSession does not lift that, and no
 * recording site set either — so every recorded call over a minute was cut at
 * ~60 s. The file Plivo keeps is the short one; nothing downstream can recover it.
 *
 * Two halves, because a new site slips past either one alone:
 *   1. SOURCE SCAN of the real tree — every `<Record` tag in code must carry
 *      maxLength itself (or in the attribute string it interpolates), every
 *      `/Record/` API URL's function must send time_limit. This is the half that
 *      catches a site added later, in a file nobody lists or beside a bounded one.
 *   2. RUNTIME — the known builders really EMIT the bound. A destructured
 *      constant that came back undefined passes the scan and ships
 *      maxLength="undefined" — not the "integer greater than 1" Plivo accepts.
 *
 * Runner: `node scripts/test-no-skips.js tests/recording-max-length.test.js`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const plivo = require('../services/plivo.service');
const conference = require('../services/plivo-conference.service');
const aiCall = require('../services/plivo-ai-call.service');

const ROOT = path.join(__dirname, '..');
const CB = 'https://api.example.com/api/public/plivo/recording-callback?t=abc';

// ─── the scanner ──────────────────────────────────────────────────────────
// Each site is judged by its OWN text, never its neighbourhood. (The first cut
// took a maxLength= anywhere within ±12 lines, so an unbounded <Record> added
// beside a bounded one borrowed that one's bound and passed.)
//   xml — the tag itself, `<Record` to its first `>`. Where it interpolates
//         `${x}` (the bridge's `<Record${recAttrs}/>`), the NEAREST preceding
//         assignment of x — the value in effect at the site — may carry it.
//   api — the URL and the request body are separate statements, so the
//         enclosing top-level statement (the column-0 line at or above the URL,
//         up to the next column-0 line) must send time_limit. ponytail: two
//         Record API calls in ONE function share one verdict; judge the request
//         object if that ever happens.
// Prose lines are blanked first (line numbers kept) so a comment naming
// maxLength= can never satisfy either check.
const isProse = (line) => /^\s*(\*|\/\/|\/\*)/.test(line);

function findSites(src) {
  const lines = src.split('\n').map((l) => (isProse(l) ? '' : l));
  const code = lines.join('\n');
  const sites = [];
  for (const m of code.matchAll(/<Record\b[^>]*/g)) {
    const assigned = [...m[0].matchAll(/\$\{\s*(\w+)\s*\}/g)].map(([, id]) => {
      const all = [...code.slice(0, m.index).matchAll(new RegExp(`\\b${id}\\s*=(?!=)[^;]*`, 'g'))];
      return all.length ? all[all.length - 1][0] : '';
    });
    const line = code.slice(0, m.index).split('\n').length;
    sites.push({ line, kind: 'xml', ok: [m[0], ...assigned].some((t) => /\bmaxLength=/.test(t)) });
  }
  lines.forEach((l, i) => {
    // `/Record/` — the start-recording endpoint. `/Recording/` (the list/fetch
    // API) records nothing and does not match.
    if (!/\/Record\//.test(l)) return;
    let a = i;
    while (a > 0 && !/^\S/.test(lines[a])) a -= 1;
    let b = i + 1;
    while (b < lines.length && !/^\S/.test(lines[b])) b += 1;
    sites.push({ line: i + 1, kind: 'api', ok: /\btime_limit\b/.test(lines.slice(a, b).join('\n')) });
  });
  return sites;
}

// tests/ quotes `<Record` in its own assertions; the rest mirror eslint.config.mjs's
// ignores (generated/runtime dirs, and stt-service's Python venv).
const SKIP = new Set(['node_modules', 'tests', 'uploads', 'logs', 'coverage', 'dist', 'build', 'stt-service']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.[cm]?js$/.test(e.name)) out.push(p);
  }
  return out;
}

test('the scanner flags a bare site and passes a bounded one (control of the detector)', () => {
  const bare = findSites([
    "const x = '<Record recordSession=\"true\" fileFormat=\"mp3\"/>';",
    'const u = `${BASE}/Call/${id}/Record/`; const body = { file_format: \'mp3\' };',
  ].join('\n'));
  assert.deepEqual(bare.map((s) => [s.kind, s.ok]), [['xml', false], ['api', false]]);

  const bounded = findSites([
    "const x = '<Record recordSession=\"true\" maxLength=\"86400\"/>';",
    'const u = `${BASE}/Call/${id}/Record/`; const body = { time_limit: 86400 };',
  ].join('\n'));
  assert.deepEqual(bounded.map((s) => [s.kind, s.ok]), [['xml', true], ['api', true]]);

  const proseOnly = findSites(['// maxLength="86400" time_limit', "const x = '<Record recordSession=\"true\"/>';"].join('\n'));
  assert.deepEqual(proseOnly.map((s) => s.ok), [false], 'a comment must never satisfy the check');

  // A bare site never borrows a NEIGHBOUR's bound — the reviewer's mutation.
  const neighbours = findSites([
    "const a = '<Record recordSession=\"true\" maxLength=\"86400\"/>';",
    "const b = '<Record recordSession=\"true\" fileFormat=\"mp3\"/>';",
  ].join('\n'));
  assert.deepEqual(neighbours.map((s) => s.ok), [true, false], 'a bare <Record> beside a bounded one');

  // Interpolated attributes: judged by the assignment in effect at the site.
  const interp = findSites([
    "let recAttrs = ' recordSession=\"true\"' + ` maxLength=\"${MAX}\"`;",
    'const a = `<Record${recAttrs}/>`;',
    "recAttrs = ' recordSession=\"true\"';",
    'const b = `<Record${recAttrs}/>`;',
  ].join('\n'));
  assert.deepEqual(interp.map((s) => s.ok), [true, false], 'interpolated attrs: nearest assignment decides');

  // Record API: judged by its own function, not an adjacent one's body — above
  // (a one-liner) or below.
  const api = findSites([
    'const c = (id) => post(`${B}/Call/${id}/Record/`, {});',
    'async function a(id) {',
    '  const body = { file_format: \'mp3\', time_limit: 86400 };',
    '  return post(`${B}/Call/${id}/Record/`, body);',
    '}',
    'async function b(id) {',
    '  return post(`${B}/Call/${id}/Record/`, { file_format: \'mp3\' });',
    '}',
  ].join('\n'));
  assert.deepEqual(api.map((s) => s.ok), [false, true, false], 'a bare Record API call beside a bounded one');
});

test('EVERY recording site in the codebase sets a length', (t) => {
  const sites = [];
  const files = walk(ROOT);
  for (const f of files) {
    for (const s of findSites(fs.readFileSync(f, 'utf8'))) sites.push({ ...s, file: path.relative(ROOT, f) });
  }
  t.diagnostic(`${sites.length} recording sites across ${files.length} files: `
    + sites.map((s) => `${s.file}:${s.line} (${s.kind})`).join(', '));

  // Locate before judging: a scan that walked the wrong root finds nothing and
  // would otherwise pass in silence.
  const has = (file, kind) => sites.some((s) => s.file === file && s.kind === kind);
  assert.ok(has(path.join('services', 'plivo.service.js'), 'xml'), 'bridge <Record> not found — the scanner is broken');
  assert.ok(has(path.join('services', 'plivo-conference.service.js'), 'xml'), 'MPC <Record> not found — the scanner is broken');
  assert.ok(has(path.join('services', 'plivo-ai-call.service.js'), 'api'), 'AI Record API not found — the scanner is broken');

  const bad = sites.filter((s) => !s.ok);
  assert.deepEqual(bad.map((s) => `${s.file}:${s.line} (${s.kind})`), [],
    'Plivo stops a recording at 60 s unless <Record> sets maxLength / the Record API sets time_limit — use plivo.RECORD_MAX_SEC');
});

// ─── runtime: what actually goes to Plivo ─────────────────────────────────
const recordEls = (xml) => xml.match(/<Record\b[^>]*>/g) || [];

test("the bound is Plivo's documented maximum (24 h), not its 60 s default", () => {
  // 86400 = Plivo's documented recording ceiling. Lower re-truncates long
  // calls; higher is outside what Plivo documents — pin it both ways.
  assert.equal(plivo.RECORD_MAX_SEC, 86400);
});

test('bridge <Record> emits maxLength in every recorded shape', () => {
  for (const opts of [
    { record: true },
    { record: true, recordingCallbackUrl: CB },
    { record: true, recordingCallbackUrl: CB, streamWssUrl: 'wss://api.example.com/teleprompter-stream?t=x' },
  ]) {
    const els = recordEls(plivo.buildAnswerXml('919810000000', opts));
    assert.equal(els.length, 1, JSON.stringify(opts));
    assert.match(els[0], /\bmaxLength="86400"/, JSON.stringify(opts));
  }
});

test('MPC <Record> emits maxLength', () => {
  const els = recordEls(conference.operatorAnswerXml('efxconf1234abcd', { confId: 7, recordingCallbackUrl: CB }));
  assert.equal(els.length, 1);
  assert.match(els[0], /\bmaxLength="86400"/);
});

test('AI-call Record API sends time_limit', async () => {
  const saved = { fetch: global.fetch, id: process.env.PLIVO_AUTH_ID, tok: process.env.PLIVO_AUTH_TOKEN };
  process.env.PLIVO_AUTH_ID = 'MATESTAUTHID';
  process.env.PLIVO_AUTH_TOKEN = 'test-token';
  let sent = null;
  global.fetch = async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return { status: 202, text: async () => '' }; };
  try {
    const r = await aiCall.startRecording('cu-1');
    assert.equal(r.ok, true);
  } finally {
    global.fetch = saved.fetch;
    if (saved.id === undefined) delete process.env.PLIVO_AUTH_ID; else process.env.PLIVO_AUTH_ID = saved.id;
    if (saved.tok === undefined) delete process.env.PLIVO_AUTH_TOKEN; else process.env.PLIVO_AUTH_TOKEN = saved.tok;
  }
  assert.ok(sent, 'startRecording never reached fetch');
  assert.match(sent.url, /\/Call\/cu-1\/Record\/$/);
  assert.equal(sent.body.time_limit, 86400);
});
