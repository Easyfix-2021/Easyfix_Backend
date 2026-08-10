/*
 * Unit tests for middleware/body-size-limit.js — the pre-parse Content-Length
 * guard mounted on /api/admin.
 *
 * The two branches worth pinning are the ones a refactor gets wrong:
 *
 *   1. MEDIA-TYPE MATCHING. The guard must fire on `application/json` and on
 *      `application/json; charset=utf-8`, and must NOT fire on multipart —
 *      /api/admin/jobs/upload posts multi-MB xlsx as multipart/form-data and
 *      capping it here would break bulk upload outright. Anyone "simplifying"
 *      the parameter-stripping into an `includes()` check would start guarding
 *      `application/json-patch+json` too, and anyone widening it to catch
 *      `+json` suffixes would start rejecting bodies express.json() never sees.
 *
 *   2. CHUNKED PASS-THROUGH. A request with no Content-Length cannot be
 *      measured from headers and must fall through to the global
 *      express.json({limit:'10mb'}), which counts bytes as it reads. A
 *      "tighten this up" change that rejects unmeasurable bodies would break
 *      legitimate streaming clients while gaining nothing.
 *
 * Runner: Node's built-in `node --test`. Pure (no DB, no HTTP) — the middleware
 * reads one header and calls modernError, so a fake req/res is sufficient and
 * keeps the boundary honest.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bodySizeLimit } = require('../middleware/body-size-limit');

const MB = 1024 * 1024;

/** Minimal req/res doubles matching what the middleware actually touches. */
function run(headers, options) {
  const req = { headers };
  const captured = { status: null, body: null, nextCalled: false };
  const res = {
    locals: {},
    status(code) {
      captured.status = code;
      return this;
    },
    json(payload) {
      captured.body = payload;
      return this;
    },
  };
  bodySizeLimit(options)(req, res, () => {
    captured.nextCalled = true;
  });
  captured.logHint = res.locals.logHint;
  return captured;
}

const guard = { maxBytes: 2 * MB, label: '/api/admin' };
const over = String(3 * MB);

// ─── Media-type scope ────────────────────────────────────────────────────────

test('guards a bare application/json body over the cap', () => {
  const r = run({ 'content-type': 'application/json', 'content-length': over }, guard);
  assert.equal(r.nextCalled, false);
  assert.equal(r.status, 413);
});

test('guards application/json with parameters — charset must not defeat it', () => {
  for (const type of [
    'application/json; charset=utf-8',
    'application/json;charset=UTF-8',
    'application/json ; charset=utf-8',
  ]) {
    const r = run({ 'content-type': type, 'content-length': over }, guard);
    assert.equal(r.status, 413, `expected ${type} to be guarded`);
  }
});

test('media type is matched case-insensitively and whitespace-tolerantly', () => {
  for (const type of ['APPLICATION/JSON', 'Application/Json', '  application/json  ']) {
    const r = run({ 'content-type': type, 'content-length': over }, guard);
    assert.equal(r.status, 413, `expected ${type} to be guarded`);
  }
});

test('MULTIPART PASSES THROUGH — bulk xlsx upload must not be capped here', () => {
  const r = run(
    { 'content-type': 'multipart/form-data; boundary=----x', 'content-length': String(9 * MB) },
    guard,
  );
  assert.equal(r.nextCalled, true);
  assert.equal(r.status, null);
});

test('urlencoded and other types pass through', () => {
  for (const type of ['application/x-www-form-urlencoded', 'text/plain', 'application/octet-stream']) {
    const r = run({ 'content-type': type, 'content-length': over }, guard);
    assert.equal(r.nextCalled, true, `expected ${type} to pass`);
  }
});

test('a missing content-type passes through', () => {
  const r = run({ 'content-length': over }, guard);
  assert.equal(r.nextCalled, true);
});

test('JSON-ish media types are NOT guarded — the match is exact, matching express.json()', () => {
  // These never reach express.json() with its default type, so guarding them
  // would refuse bodies nothing downstream would have buffered anyway.
  for (const type of ['application/json-patch+json', 'application/ld+json', 'text/json']) {
    const r = run({ 'content-type': type, 'content-length': over }, guard);
    assert.equal(r.nextCalled, true, `expected ${type} to pass through`);
  }
});

// ─── Content-Length handling ─────────────────────────────────────────────────

test('CHUNKED PASSES THROUGH — an unmeasurable body is bounded by the global parser', () => {
  const r = run({ 'content-type': 'application/json' }, guard);
  assert.equal(r.nextCalled, true);
  assert.equal(r.status, null);
});

test('an empty content-length passes through', () => {
  const r = run({ 'content-type': 'application/json', 'content-length': '' }, guard);
  assert.equal(r.nextCalled, true);
});

test('a non-numeric content-length passes through rather than 413ing', () => {
  for (const raw of ['abc', 'NaN', '1,048,576']) {
    const r = run({ 'content-type': 'application/json', 'content-length': raw }, guard);
    assert.equal(r.nextCalled, true, `expected "${raw}" to pass`);
  }
});

test('a negative content-length passes through', () => {
  const r = run({ 'content-type': 'application/json', 'content-length': '-1' }, guard);
  assert.equal(r.nextCalled, true);
});

// ─── The boundary ────────────────────────────────────────────────────────────

test('exactly at the cap is ALLOWED; one byte over is refused', () => {
  const atCap = run({ 'content-type': 'application/json', 'content-length': String(2 * MB) }, guard);
  assert.equal(atCap.nextCalled, true, 'a body exactly at the cap must pass');

  const overCap = run({ 'content-type': 'application/json', 'content-length': String(2 * MB + 1) }, guard);
  assert.equal(overCap.nextCalled, false);
  assert.equal(overCap.status, 413);
});

test('a small body is untouched', () => {
  const r = run({ 'content-type': 'application/json', 'content-length': '512' }, guard);
  assert.equal(r.nextCalled, true);
  assert.equal(r.status, null);
});

// ─── Response contract ───────────────────────────────────────────────────────

test('rejection uses the modern envelope and stamps the log hint', () => {
  const r = run({ 'content-type': 'application/json', 'content-length': over }, guard);
  assert.equal(r.status, 413);
  assert.equal(r.body.success, false);
  assert.equal(typeof r.body.error, 'string');
  assert.equal(r.body.details, undefined);
  // http-log.js reads res.locals.logHint so the one-line log says WHAT failed.
  assert.ok(r.logHint && r.logHint.length > 0, 'expected a logHint to be stamped');
});

test('the message names the label, the cap and the declared size', () => {
  const r = run({ 'content-type': 'application/json', 'content-length': over }, guard);
  assert.match(r.body.error, /^\/api\/admin accepts at most 2 MB of JSON/);
  assert.match(r.body.error, /declared 3\.00 MB/);
});

test('the cap renders without a decimal when whole, and with one when not', () => {
  const whole = run(
    { 'content-type': 'application/json', 'content-length': String(9 * MB) },
    { maxBytes: 2 * MB, label: 'x' },
  );
  assert.match(whole.body.error, /at most 2 MB/);

  const fractional = run(
    { 'content-type': 'application/json', 'content-length': String(9 * MB) },
    { maxBytes: 1.5 * MB, label: 'x' },
  );
  assert.match(fractional.body.error, /at most 1\.5 MB/);
});

test('defaults apply when constructed with no options', () => {
  // Default cap is 2 MB and the default label is generic.
  const r = run({ 'content-type': 'application/json', 'content-length': String(3 * MB) }, undefined);
  assert.equal(r.status, 413);
  assert.match(r.body.error, /^This endpoint accepts at most 2 MB of JSON/);

  const under = run({ 'content-type': 'application/json', 'content-length': String(1 * MB) }, undefined);
  assert.equal(under.nextCalled, true);
});

test('the factory returns a fresh middleware each call and holds no state', () => {
  const mw = bodySizeLimit(guard);
  assert.equal(typeof mw, 'function');
  assert.equal(mw.length, 3, 'must be a standard (req, res, next) middleware');

  // Repeated rejections must behave identically — no accumulated counters.
  const first = run({ 'content-type': 'application/json', 'content-length': over }, guard);
  const second = run({ 'content-type': 'application/json', 'content-length': over }, guard);
  assert.deepEqual(first.body, second.body);
});
