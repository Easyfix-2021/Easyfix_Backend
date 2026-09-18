/*
 * INTERNAL JOB NOTES — GET/POST /api/admin/jobs/:id/notes, through the REAL
 * router, over tbl_job_notes: the legacy Java CRM's free-text ops notepad,
 * re-opened for this stack after two years with no reader.
 *
 * WHAT IS ACTUALLY AT RISK
 *   This is a WRITE into a table THIS REPO DID NOT DESIGN and whose 3,303
 *   existing rows set the conventions. Two of its columns hold values, not
 *   ids, and getting either wrong is silent — the note saves, the list renders,
 *   and the data is subtly not what the legacy rows are:
 *     note_created_by  a DISPLAY NAME. 3,303 of 3,303 existing rows are
 *                      non-numeric and match tbl_user.user_name. Writing a
 *                      user_id here would make one column mean two things and
 *                      force every reader to guess which.
 *     job_stage        a bucket LABEL ("Pending for scheduling", …), not a
 *                      status code. All 8 distinct values present are outputs
 *                      of job-export.service.js's homeJobStatus — the legacy
 *                      CRM's own naming function, ported. A ninth spelling
 *                      invented here would never group with the other 3,303.
 *
 *   The stage is also a SNAPSHOT: it records where the job sat when the note
 *   was written, which is most of why an old note still reads sensibly. A
 *   reader that recomputed it from the job's current status would rewrite
 *   history every time the job moved.
 *
 * READ AND ADD ONLY is the contract (owner's call) and the only one the table
 * can honestly support: no updated_at, no status column, no author id to check
 * an edit against. PATCH and DELETE must not exist, and that is asserted.
 *
 * The REAL router is mounted, so the guard chain under test is the shipped one;
 * only what routes/admin/index.js would attach is injected. NO DB — the
 * fake-pool seam answers the reads and RECORDS the INSERT.
 *
 * Runner: `node --test` (see npm test).
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installFakePool } = require('./helpers/fake-pool');

const scenario = {
  job: null,
  noteRows: [],
  scoped: true,
  // Has migrations/2026-09-17-job-notes-pin.sql run? The service caches a YES
  // for the process, so every test that needs NO sits above the pin tests.
  pinColumns: false,
  pinAffected: 1,
};

const fake = installFakePool([
  [/SHOW COLUMNS FROM tbl_job_notes/i, () => (scenario.pinColumns ? [{ Field: 'is_pinned' }] : [])],
  [/UPDATE tbl_job_notes/i, () => ({ affectedRows: scenario.pinAffected })],
  [/FROM tbl_job_notes/i, () => scenario.noteRows],
  [/INSERT INTO tbl_job_notes/i, () => ({ insertId: 991, affectedRows: 1 })],
]);

const job = require('../services/job.service');
const jobNotes = require('../services/job-notes.service');

// scopedJob calls job.getById; stub it so the guard is real but the DB is not.
const realGetById = job.getById;
job.getById = async (id) => (scenario.scoped
  ? { job_id: Number(id), fk_client_id: 5, city_id: 11, vertical_id: 3, ...scenario.job }
  : null);

const jobsRouter = require('../routes/admin/jobs');
let server;
let baseUrl;

const ACTOR = { user_id: 77, user_name: 'Sonam Patel', permissions: { menuIds: [], actionPermissions: [] } };

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { ...ACTOR };
    req.userRole = { role_name: 'Admin' };
    const all = { mode: 'all', ids: [], placeholders: '' };
    req.scope = { clients: all, cities: all, states: all, verticals: all };
    req.allowedStages = null;
    next();
  });
  app.use('/jobs', jobsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { res.status(500).json({ error: String(err && err.message) }); });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  job.getById = realGetById;
  fake.restore();
});

beforeEach(() => {
  fake.calls.length = 0;
  scenario.job = { job_status: 0, fk_easyfixter_id: null, sub_job_id: null };
  scenario.noteRows = [];
  scenario.scoped = true;
  scenario.pinAffected = 1;
});

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const insert = () => fake.calls.find((c) => /INSERT INTO tbl_job_notes/i.test(c.sql));
const select = () => fake.calls.find((c) => /FROM tbl_job_notes/i.test(c.sql) && !/SHOW COLUMNS/i.test(c.sql));
const pinUpdate = () => fake.calls.find((c) => /UPDATE tbl_job_notes/i.test(c.sql));

/* ── GET ─────────────────────────────────────────────────────────────────── */

test('GET returns the job\'s notes, newest first, with the five stored fields', async () => {
  scenario.noteRows = [
    { id: 9, notes: 'newer', job_stage: 'Pending to start', note_created_on: '2026-09-16 10:00:00', note_created_by: 'Prem Rai' },
    { id: 4, notes: 'older', job_stage: 'Pending for scheduling', note_created_on: '2026-09-15 10:00:00', note_created_by: 'Renu Yadav' },
  ];
  const r = await call('GET', '/jobs/42/notes');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.map((n) => n.id), [9, 4]);
  assert.deepEqual(Object.keys(r.body.data[0]).sort(),
    ['id', 'job_stage', 'note_created_by', 'note_created_on', 'notes'].sort());
  assert.deepEqual(select().params, [42], 'scoped to the one job');
});

test('the ORDER survives a tie — created_on then id, never id alone', async () => {
  /*
   * id alone breaks the moment a backfill or import lands out of order;
   * created_on alone ties on the two notes a fast operator writes in the same
   * second. Both, in that order — the same rule the comment thread uses.
   */
  await call('GET', '/jobs/42/notes');
  assert.match(select().sql, /ORDER BY note_created_on DESC,\s*id DESC/);
});

test('a job outside the caller\'s scope 404s before any note is read', async () => {
  scenario.scoped = false;
  const r = await call('GET', '/jobs/42/notes');
  assert.equal(r.status, 404);
  assert.equal(select(), undefined, 'scopedJob must run first — notes are job data');
});

/* ── POST ────────────────────────────────────────────────────────────────── */

test('POST inserts one row and echoes it back at 201', async () => {
  const r = await call('POST', '/jobs/42/notes', { notes: '  waiting on client approval  ' });
  assert.equal(r.status, 201);
  const ins = insert();
  assert.ok(ins, 'a row must be written');
  const [jobId, notes, stage, createdOn, author] = ins.params;
  assert.equal(jobId, 42);
  assert.equal(notes, 'waiting on client approval', 'trimmed, so no leading/trailing noise is stored');
  assert.equal(author, 'Sonam Patel');
  assert.ok(createdOn instanceof Date, 'server time, not a SQL NOW() the pool timezone would not match');
  assert.equal(stage, 'Pending for scheduling');
  assert.deepEqual(r.body.data, {
    id: 991, notes: 'waiting on client approval', job_stage: 'Pending for scheduling',
    note_created_on: createdOn.toISOString(), note_created_by: 'Sonam Patel',
  });
});

test('the AUTHOR is the acting user\'s DISPLAY NAME, and cannot be supplied', async () => {
  /*
   * The column holds names (3,303 of 3,303 rows), so a name is what goes in —
   * matching the legacy convention beats improving it in a column we do not
   * own. And the name comes from the token, never the body: this table has no
   * author id to cross-check a claimed byline against.
   */
  await call('POST', '/jobs/42/notes', {
    notes: 'x', note_created_by: 'Someone Else', commented_by: 1, job_stage: 'Completed',
  });
  const [, , stage, , author] = insert().params;
  assert.equal(author, 'Sonam Patel', 'a body-supplied byline must be ignored');
  assert.notEqual(stage, 'Completed', 'and a body-supplied stage must not override the snapshot');
  assert.equal(typeof author, 'string');
  assert.doesNotMatch(String(author), /^\d+$/, 'never a user_id — the column is names');
});

test('the STAGE is a snapshot of the job, in the legacy vocabulary', async () => {
  // Each case is a real value present in the 3,303 existing rows. A status that
  // produced a new spelling would never group with them.
  const cases = [
    [{ job_status: 0, fk_easyfixter_id: null }, 'Pending for scheduling'],
    [{ job_status: 1 }, 'Pending to start'],
    [{ job_status: 2 }, 'Pending to close on app'],
    [{ job_status: 10 }, 'Audit & complete'],
    [{ job_status: 3 }, 'Completed'],
    [{ job_status: 6 }, 'Failed Orders'],
    [{ job_status: 9 }, 'Unconfirmed'],
    [{ job_status: 21 }, 'Orders in Follow UP'],
  ];
  for (const [jobRow, expected] of cases) {
    fake.calls.length = 0;
    scenario.job = { sub_job_id: null, fk_easyfixter_id: null, ...jobRow };
    await call('POST', '/jobs/42/notes', { notes: 'n' });
    assert.equal(insert().params[2], expected, `status ${jobRow.job_status} → "${expected}"`);
  }
});

test('the stage label comes from homeJobStatus, not a second copy of the map', async () => {
  // One vocabulary, shared with the jobs list and the XLSX export. A private
  // map here would drift on the first relabel and nothing would report it.
  const { homeJobStatus } = require('../services/job-export.service');
  for (const status of [0, 1, 2, 3, 5, 6, 7, 9, 10, 15, 20, 21]) {
    const jobRow = { job_status: status, fk_easyfixter_id: null, sub_job_id: null };
    assert.equal(jobNotes.stageLabelFor(jobRow), homeJobStatus(status, null, null) || '',
      `status ${status} must read through the shared label map`);
  }
});

test('an empty or whitespace-only note is a 400, not a blank line in the log', async () => {
  for (const notes of ['', '   ', '\n\t ']) {
    fake.calls.length = 0;
    const r = await call('POST', '/jobs/42/notes', { notes });
    assert.equal(r.status, 400, `${JSON.stringify(notes)} must be refused`);
    assert.equal(insert(), undefined, 'and nothing may be written');
  }
  const missing = await call('POST', '/jobs/42/notes', {});
  assert.equal(missing.status, 400);
});

test('an over-long note is refused at the edge', async () => {
  const r = await call('POST', '/jobs/42/notes', { notes: 'x'.repeat(2001) });
  assert.equal(r.status, 400);
  assert.equal(insert(), undefined);
  // The cap itself is honoured, not just the overflow.
  fake.calls.length = 0;
  const ok = await call('POST', '/jobs/42/notes', { notes: 'x'.repeat(2000) });
  assert.equal(ok.status, 201);
});

test('POST on an out-of-scope job 404s and writes nothing', async () => {
  scenario.scoped = false;
  const r = await call('POST', '/jobs/42/notes', { notes: 'x' });
  assert.equal(r.status, 404);
  assert.equal(insert(), undefined);
});

/* ── The contract: read and add only ─────────────────────────────────────── */

test('there is NO edit and NO delete — the table cannot honestly support either', async () => {
  /*
   * No updated_at, no status column, no author id. An edit would be
   * unattributable and undetectable; a delete would leave no tombstone. The
   * owner's decision, and the schema's.
   */
  for (const method of ['PATCH', 'PUT', 'DELETE']) {
    const r = await call(method, '/jobs/42/notes', { notes: 'x' });
    assert.notEqual(r.status, 200, `${method} /notes must not be routed`);
    assert.notEqual(r.status, 201, `${method} /notes must not be routed`);
  }
  const routes = jobsRouter.stack.filter((l) => l.route && /\/notes$/.test(l.route.path));
  assert.deepEqual(
    routes.map((l) => Object.keys(l.route.methods).join(',')).sort(), ['get', 'post'],
    'exactly two note routes may exist on this router',
  );
  // The pin route changes where a note SITS, never what it says — it takes a
  // boolean and nothing else, so it cannot become an edit by another name.
  const pinRoutes = jobsRouter.stack.filter((l) => l.route && /\/notes\/:noteId\/pin$/.test(l.route.path));
  assert.deepEqual(pinRoutes.map((l) => Object.keys(l.route.methods).join(',')), ['patch']);
});

test('a note write never touches tbl_job_comment — audit and notepad stay apart', async () => {
  // tbl_job_comment is the audited lifecycle trail, mirrored onto
  // tbl_job.remarks and carrying an action's reason FK. A note is an operator
  // writing to the next operator; folding one into the other would either
  // pollute the audit or force a reason code onto a sentence that has none.
  await call('POST', '/jobs/42/notes', { notes: 'just a note' });
  assert.equal(fake.calls.filter((c) => /tbl_job_comment/i.test(c.sql)).length, 0);
  assert.equal(fake.calls.filter((c) => /UPDATE tbl_job\b/i.test(c.sql)).length, 0,
    'and tbl_job.remarks must not move');
});

/* ── Pinning — migrations/2026-09-17-job-notes-pin.sql ──────────────────────
 * Order matters below: the column probe caches a YES, so the "not migrated"
 * case runs first. */

test('before the migration, pinning answers 409 and the list is unchanged', async () => {
  scenario.pinColumns = false;
  const r = await call('PATCH', '/jobs/42/notes/9/pin', { pinned: true });
  assert.equal(r.status, 409);
  assert.equal(pinUpdate(), undefined, 'nothing may be written to columns that do not exist');
  fake.calls.length = 0;
  await call('GET', '/jobs/42/notes');
  assert.doesNotMatch(select().sql, /is_pinned/, 'the un-migrated read must not name the new columns');
});

test('after the migration, pinned notes list first, then newest', async () => {
  scenario.pinColumns = true;
  scenario.noteRows = [
    { id: 4, notes: 'pinned', job_stage: 'Pending for scheduling', note_created_on: '2026-09-15 10:00:00', note_created_by: 'Renu Yadav', is_pinned: Buffer.from([1]), pinned_on: '2026-09-16 11:00:00', pinned_by_name: 'Sonam Patel' },
    { id: 9, notes: 'newer', job_stage: 'Pending to start', note_created_on: '2026-09-16 10:00:00', note_created_by: 'Prem Rai', is_pinned: 0, pinned_on: null, pinned_by_name: null },
  ];
  const r = await call('GET', '/jobs/42/notes');
  assert.equal(r.status, 200);
  assert.match(select().sql, /ORDER BY n\.is_pinned DESC,\s*n\.note_created_on DESC,\s*n\.id DESC/);
  assert.deepEqual(r.body.data.map((n) => [n.id, n.is_pinned]), [[4, 1], [9, 0]], 'is_pinned ships as 0/1, never a Buffer');
  assert.equal(r.body.data[0].pinned_by_name, 'Sonam Patel');
});

test('PATCH pins a note, attributed to the acting user', async () => {
  scenario.pinColumns = true;
  const r = await call('PATCH', '/jobs/42/notes/9/pin', { pinned: true });
  assert.equal(r.status, 200);
  const [flag, on, by, noteId, jobId] = pinUpdate().params;
  assert.equal(flag, 1);
  assert.ok(on instanceof Date);
  assert.equal(by, 77, 'the pinner is the token user, by id');
  assert.equal(Number(noteId), 9);
  assert.equal(Number(jobId), 42);
  assert.match(pinUpdate().sql, /WHERE id = \? AND job_id = \?/, 'scoped to the job, not just the note id');
  // A pin moves a note; it never rewrites one.
  assert.doesNotMatch(pinUpdate().sql, /\bnotes\s*=|note_created_by\s*=|job_stage\s*=/);
});

test('PATCH unpins and clears who/when', async () => {
  scenario.pinColumns = true;
  const r = await call('PATCH', '/jobs/42/notes/9/pin', { pinned: false });
  assert.equal(r.status, 200);
  assert.deepEqual(pinUpdate().params.slice(0, 3), [0, null, null]);
});

test('a note id from another job 404s', async () => {
  scenario.pinColumns = true;
  scenario.pinAffected = 0;
  const r = await call('PATCH', '/jobs/42/notes/12345/pin', { pinned: true });
  assert.equal(r.status, 404);
});

test('pinning on an out-of-scope job 404s before any write', async () => {
  scenario.pinColumns = true;
  scenario.scoped = false;
  const r = await call('PATCH', '/jobs/42/notes/9/pin', { pinned: true });
  assert.equal(r.status, 404);
  assert.equal(pinUpdate(), undefined);
});
