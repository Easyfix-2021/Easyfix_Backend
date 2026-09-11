'use strict';
/*
 * GET /api/mobile/jobs — the technician's Bookings list (2026-09-11).
 *
 * THREE DEFECTS, ONE LIST, measured on Production:
 *
 *   1. Release 0afb837 put `s.delegate_efr_id` in list()'s WHERE while its
 *      migration was still pending, so EVERY GET /api/mobile/jobs answered
 *      500 "Unknown column 's.delegate_efr_id'". The clause is now gated on a
 *      schema probe, and an "absent" answer is re-asked after a short window
 *      because the migration is applied to live servers without a restart.
 *   2. The route dropped `offset`, so load-more got page one back every time;
 *      one device re-requested it 34,348 times in one release.
 *   3. With no `status` the list was every job the technician ever had
 *      (completed and cancelled included). It now defaults to his work in hand,
 *      easyfixer-lifecycle's OPEN_JOB_STATUSES — NOT the dashboard's (1, 2, 20)
 *      counter, which would list 10 / 15 / 21 nowhere in the app.
 *
 * The fake DB models the un-migrated schema the way MySQL does, PER COLUMN: a
 * query naming a delegation column the schema lacks THROWS ER_BAD_FIELD_ERROR.
 * So a broken gate fails here with the production error itself, not merely with
 * a regex mismatch — and a HALF-applied migration (some columns, not all) can be
 * modelled, which an all-or-nothing fake cannot tell apart from either end.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installFakePool } = require('./helpers/fake-pool');

/* The eight columns migrations/2026-09-10-job-share-delegation.sql adds that any
 * query reads (live_job_id is generated and read by nothing here). */
const DELEGATION_COLUMNS = ['delegate_efr_id', 'contact_name', 'contact_number', 'status',
  'responded_on', 'started_on', 'ended_on', 'end_reason'];

// 'present' | 'absent' | [the columns a HALF-applied migration left behind]
let schema = 'present';
let fault = null;         // a NON-absent error code for tbl_job_share_link reads

const PROBE = /FROM tbl_job_share_link LIMIT 1/i;
const sqlError = (code, errno, message) => Object.assign(new Error(message), { code, errno });
const missingColumns = () => DELEGATION_COLUMNS.filter((c) =>
  schema !== 'present' && !(Array.isArray(schema) && schema.includes(c)));
/*
 * One bound value per placeholder, judged by the formatter pool.query really
 * uses (mysql2 → sql-escaper). The fake never binds, so it cannot see a dropped
 * parameter; MySQL can. Counting `?` characters is wrong here: the projection
 * carries a `?` inside a SQL comment ("…magic-link-open rule?"), which the
 * formatter rightly skips. So tag each param and add one spare: every tag must
 * land exactly once (none dropped) and the spare must not (none unbound).
 */
const { format: mysqlFormat } = require('mysql2');
function bindsExactly(sql, params) {
  const tags = params.map((_, i) => `__p${i}__`);
  const out = mysqlFormat(sql, [...tags, '__spare__']);
  return tags.every((t) => out.split(`'${t}'`).length === 2) && !out.includes('__spare__');
}

test('bindsExactly is a real oracle: exact passes, dropped and spare fail, a comment `?` is skipped', () => {
  const sql = 'SELECT /* rule? */ a FROM t WHERE b = ? LIMIT ? OFFSET ?';
  assert.equal(bindsExactly(sql, [7, 20, 0]), true, 'three placeholders, three values');
  assert.equal(bindsExactly(sql, [7, 20]), false, 'a value dropped leaves a placeholder unbound');
  assert.equal(bindsExactly(sql, [7, 8, 20, 0]), false, 'a value too many is never consumed');
});

const fake = installFakePool([
  [/tbl_job_share_link/i, (sql) => {
    if (fault) throw sqlError(fault, undefined, `connect ${fault}`);
    // \b on both sides: `s.status` names the share column, `j.job_status` does not.
    const named = missingColumns().find((c) => new RegExp(`\\b${c}\\b`).test(sql));
    if (named) throw sqlError('ER_BAD_FIELD_ERROR', 1054, `Unknown column '${named}' in 'field list'`);
    return /SELECT COUNT\(\*\) AS total/i.test(sql) ? [{ total: 0 }] : [];
  }],
  [/SELECT COUNT\(\*\) AS total/i, () => [{ total: 0 }]],
]);

// The route half mounts the real router; auth / capability / idempotency are
// not under test, so they are pass-throughs (same seam as mobile-close-pin).
for (const [mod, exports] of [
  ['../middleware/tech-auth', (req, _res, next) => { req.tech = { efr_id: 7 }; next(); }],
  ['../middleware/require-tech-lifecycle-capability', {
    requireTechCapability: () => (_req, _res, next) => next(),
    requireTechJobMutationCapability: (_req, _res, next) => next(),
  }],
  ['../middleware/idempotency', () => (_req, _res, next) => next()],
]) {
  const id = require.resolve(mod);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const { OPEN_JOB_STATUSES } = require('../services/easyfixer-lifecycle.service');

const dataCall = () => fake.calls.find((c) => /LIMIT \? OFFSET \?/.test(c.sql));
const countCall = () => fake.calls.find((c) => /SELECT COUNT\(\*\) AS total/i.test(c.sql));
const probeCount = () => fake.calls.filter((c) => PROBE.test(c.sql)).length;
// Everything after the LAST `WHERE`, minus ORDER BY. For a query whose WHERE
// holds no subquery that is the whole top-level WHERE; if a subquery appears it
// returns that subquery's tail instead, which fails an exact compare (closed).
const lastWhere = (sql) => sql.slice(sql.lastIndexOf('WHERE') + 5).replace(/ORDER BY[\s\S]*$/, '').trim();

/* The probe's memo is module state, so each scenario gets a FRESH module rather
 * than a test-only reset export. The router keeps the instance it loaded. */
function fresh(...mods) {
  for (const m of mods) delete require.cache[require.resolve(m)];
  return require(mods[mods.length - 1]);
}
const freshList = () => fresh('../services/job.service').list;
const freshDelegation = () => fresh('../services/job.service', '../services/job-share-delegation.service');

beforeEach(() => { schema = 'present'; fault = null; fake.reset(); });

/* ─── 1. The delegation clause survives an un-migrated DB ─────────────── */

const MOBILE_ARGS = { easyfixerId: 7, delegatedToEfrId: 7, limit: 20, offset: 0 };

test('columns ABSENT → the plain assigned-to clause in rows AND total, never a 500', async () => {
  schema = 'absent';
  await freshList()(MOBILE_ARGS);   // rejects with the production error if ungated
  assert.equal(probeCount(), 1, 'the probe must have been asked — else "absent" was never measured');
  for (const [name, call, params] of [['data', dataCall(), [7, 20, 0]], ['COUNT', countCall(), [7]]]) {
    assert.ok(call, `the ${name} query must have run — an absent call makes the next lines vacuous`);
    assert.doesNotMatch(call.sql, /delegate_efr_id/, `${name}: no delegation column pre-migration`);
    // EXACTLY the pre-delegation clause. A fragment match also passes a widened
    // `(j.fk_easyfixter_id = ? OR j.fk_easyfixter_id IS NULL)` — every unassigned
    // job shown to every technician, on the path QA and Production run today.
    assert.equal(lastWhere(call.sql), 'j.fk_easyfixter_id = ?', `${name}: exactly the assigned-to clause`);
    assert.deepEqual(call.params, params, `${name}: bound to the technician only`);
    assert.ok(bindsExactly(call.sql, call.params), `${name}: one bound value per placeholder, as mysql2 binds them`);
  }
});

test('columns PRESENT → the delegated-to-me EXISTS in rows AND total, bound owner-then-delegate', async () => {
  // DIFFERENT owner and delegate ids. The route passes the same technician as
  // both, so with one id a dropped, duplicated or swapped parameter binds the
  // same number and the SQL still reads right — only the params can tell.
  await freshList()({ ...MOBILE_ARGS, delegatedToEfrId: 8 });
  for (const [name, call, params] of [['data', dataCall(), [7, 8, 20, 0]], ['COUNT', countCall(), [7, 8]]]) {
    assert.ok(call, `the ${name} query must have run`);
    assert.match(call.sql, /j\.fk_easyfixter_id = \? OR EXISTS \([\s\S]*s\.delegate_efr_id = \?/,
      `${name}: a delegate must see the job he was asked to do`);
    assert.deepEqual(call.params, params, `${name}: owner, then delegate, then paging — in placeholder order`);
    assert.ok(bindsExactly(call.sql, call.params), `${name}: one bound value per placeholder, as mysql2 binds them`);
  }
});

test('a HALF-applied migration reads as absent to every reader, not only to list()', async () => {
  // The migration adds its columns one ALTER at a time. A run that stopped after
  // the first few leaves delegate_efr_id and status — everything list() reads —
  // without the six SHARE_SELECT also reads. A probe narrowed to list()'s two
  // columns would call that "present", and every share read (GET /jobs/:id/share
  // fires on each open order) would 500 with the production error.
  schema = ['delegate_efr_id', 'status'];
  // Positive control: the fake really is half-migrated — a share-only column
  // errors, a list() column does not. Otherwise "no 500" below proves nothing.
  const { pool } = require('../db');
  await assert.rejects(pool.query('SELECT s.contact_name FROM tbl_job_share_link s'), { code: 'ER_BAD_FIELD_ERROR' });
  await pool.query('SELECT s.delegate_efr_id, s.status FROM tbl_job_share_link s');
  fake.reset();

  const delegation = freshDelegation();
  const { list } = require('../services/job.service');   // the instance delegation reads through
  const shareSelects = () => fake.calls.filter((c) => /FROM tbl_job_share_link s\b/.test(c.sql)).length;

  assert.equal(await delegation.getShareForViewer(4321, 7), null, 'GET /jobs/:id/share → { share: null }, not a 500');
  assert.equal(await delegation.resolveLock(4321, 7), null, 'the lock falls through');
  assert.equal(shareSelects(), 0, 'SHARE_SELECT must not run against a half-migrated table');
  await list(MOBILE_ARGS);
  assert.doesNotMatch(dataCall().sql, /delegate_efr_id/, 'list() agrees: delegation is not there yet');
  assert.equal(probeCount(), 1, 'one probe answered for both readers');
});

test('"absent" is re-asked within 60s of a live migration; "present" is kept for good', async (t) => {
  let now = 1_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const list = freshList();
  const run = async () => {
    fake.reset();
    await list(MOBILE_ARGS);
    return { probed: probeCount(), delegated: /delegate_efr_id/.test(dataCall().sql) };
  };

  schema = 'absent';
  assert.deepEqual(await run(), { probed: 1, delegated: false }, 'first ask: absent');

  schema = 'present';                       // the migration lands, no restart
  now += 1_000;
  assert.deepEqual(await run(), { probed: 0, delegated: false },
    'inside the window the answer is cached — no probe per request on the hot path');

  now += 59_000;                            // 60s after the first ask
  assert.deepEqual(await run(), { probed: 1, delegated: true },
    'after the window the probe is asked again and delegation switches on');

  now += 24 * 3600 * 1000;
  assert.deepEqual(await run(), { probed: 0, delegated: true },
    '"present" is permanent — a column does not un-exist, so it is never re-asked');
});

test('a probe FAULT (not an absent-answer) is not cached at all', async () => {
  const list = freshList();
  fault = 'ETIMEDOUT';
  await list(MOBILE_ARGS);
  assert.doesNotMatch(dataCall().sql, /delegate_efr_id/, 'a blip reads as absent for THIS call');
  fault = null;
  fake.reset();
  await list(MOBILE_ARGS);
  assert.equal(probeCount(), 1, 'the very next call asks again');
  assert.match(dataCall().sql, /s\.delegate_efr_id = \?/);
});

/* ─── 2. Every other delegation reader, pre-migration ─────────────────── */

test('columns ABSENT → share reads answer "not shared" instead of 500ing', async () => {
  schema = 'absent';
  const delegation = freshDelegation();
  const shareSelects = () => fake.calls.filter((c) => /FROM tbl_job_share_link s\b/.test(c.sql)).length;

  assert.equal(await delegation.getShareForViewer(4321, 7), null, 'GET /jobs/:id/share → { share: null }');
  assert.equal(await delegation.resolveLock(4321, 7), null, 'the lock falls through, no warn per request');
  await assert.rejects(delegation.acceptShare(4321, 7), { status: 404 }, 'accept → 404, not 500');
  assert.equal(shareSelects(), 0, 'SHARE_SELECT must not run against absent columns');

  // Positive control: the locator above really matches SHARE_SELECT.
  schema = 'present';
  const migrated = freshDelegation();
  fake.reset();
  await migrated.getShareForViewer(4321, 7);
  assert.equal(shareSelects(), 1, 'post-migration the share IS read');
});

test('the TTL sweep skips a table that lacks its delegation columns, and still throws a real fault', async () => {
  const delegation = freshDelegation();
  schema = 'absent';
  assert.deepEqual(await delegation.expireStaleShares(), { eligible: 0, expired: 0, skipped: true });
  schema = 'present';
  fault = 'ETIMEDOUT';
  await assert.rejects(delegation.expireStaleShares(), { code: 'ETIMEDOUT' },
    'only an absent-answer is swallowed; a connection fault must still surface');
});

/* ─── 3. The route: offset and the default status set ────────────────── */

let server;
let baseUrl;
before(async () => {
  const app = express();
  app.use('/mobile', require('../routes/mobile/index'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  fake.restore();
});

async function getJobs(qs) {
  fake.reset();
  const r = await fetch(`${baseUrl}/mobile/jobs${qs}`);
  assert.equal(r.status, 200, `GET /mobile/jobs${qs} → ${r.status} ${await r.clone().text()}`);
  const data = dataCall();
  const count = countCall();
  assert.ok(data && count, 'both queries must have run');
  return { data, count };
}

test('offset reaches the query; anything that is not a non-negative integer is 0', async () => {
  for (const [qs, want] of [
    ['?limit=20&offset=20', 20],
    ['?offset=40', 40],
    ['', 0],
    ['?offset=abc', 0],
    ['?offset=-20', 0],
    ['?offset=1.5', 0],
    ['?offset=1e400', 0],
  ]) {
    const { data } = await getJobs(qs);
    assert.equal(data.params.at(-1), want, `${qs || '(none)'} → OFFSET ${want}`);
  }
});

test('NO status → the technician\'s work in hand (OPEN_JOB_STATUSES), in rows AND total', async () => {
  const want = [...OPEN_JOB_STATUSES];
  const inList = new RegExp(`j\\.job_status IN \\(${want.map(() => '\\?').join(',')}\\)`);
  const { data, count } = await getJobs('?limit=20&offset=0');
  for (const [name, call] of [['data', data], ['COUNT', count]]) {
    const bound = call.params.slice(0, want.length);
    assert.deepEqual(bound, want, `${name}: bound to OPEN_JOB_STATUSES`);
    assert.match(call.sql, inList, `${name}: one placeholder per status`);
    // Jobs is the app's only list with no status. 10 (revisit owed), 15
    // (estimate pending, tech on site) and 21 (on hold) are still his, and no
    // other list asks for them; terminal codes are not Bookings.
    for (const s of [10, 15, 21]) assert.ok(bound.includes(s), `${name}: status ${s} must be listed`);
    for (const s of [3, 5, 6]) assert.ok(!bound.includes(s), `${name}: status ${s} is terminal`);
    assert.doesNotMatch(call.sql, /j\.job_status = \?/);
  }
});

test('an explicit status behaves exactly as before: `= ?`, and no IN', async () => {
  for (const status of [3, 0]) {
    const { data, count } = await getJobs(`?status=${status}&limit=20`);
    for (const [name, call] of [['data', data], ['COUNT', count]]) {
      assert.match(call.sql, /j\.job_status = \?/, `${name}: status=${status}`);
      assert.doesNotMatch(call.sql, /j\.job_status IN/, `${name}: status=${status} must not widen`);
      assert.equal(call.params[0], status);
    }
  }
});
