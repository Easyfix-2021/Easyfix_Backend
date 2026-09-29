/*
 * Every test HTTP server binds 127.0.0.1 — the host the tests then fetch.
 *
 * `app.listen(0)` binds the WILDCARD address. On macOS the OS will hand that
 * bind a port another process already holds on 127.0.0.1, and a request to
 * 127.0.0.1:<port> then reaches THAT process, not ours. Reproduced 2026-09-28:
 * a wildcard bind on a squatted port succeeded and the fetch was answered by
 * the squatter; the same bind on '127.0.0.1' was refused (EADDRINUSE), so with
 * port 0 the OS simply picks a free one. It surfaced as 7 failures in
 * material-client-request.test.js carrying a stranger's
 * `authentication_error` body, and passed on the rerun.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const WILDCARD = /\.listen\(0\s*(?:\)|,\s*(?!['"\s]))/;

test('no test server binds the wildcard address', () => {
  const dir = __dirname;
  let servers = 0;
  const offenders = [];
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    if (name === path.basename(__filename)) continue;
    fs.readFileSync(path.join(dir, name), 'utf8').split('\n').forEach((line, i) => {
      if (!line.includes('.listen(0')) return;
      servers += 1;
      if (WILDCARD.test(line)) offenders.push(`${name}:${i + 1}  ${line.trim()}`);
    });
  }
  // A scan that finds no servers must not read as "all bound correctly".
  assert.ok(servers > 50, `found only ${servers} .listen(0 sites under tests/ — has the pattern moved?`);
  assert.deepStrictEqual(offenders, [],
    `bind the host you fetch — .listen(0, '127.0.0.1', cb):\n  ${offenders.join('\n  ')}`);
});
