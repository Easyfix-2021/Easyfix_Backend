'use strict';
/*
 * Job chat, the desk's side (V3 3.4 follow-up):
 *   (a) list() with no `after` opens on the NEWEST 100, still oldest-first.
 *   (b) GET /ops-desk/chats lists jobs whose LATEST line is the technician's.
 *   (c) a fresh desk line pushes the job's technician exactly once; a tx line,
 *       a clientMsgId replay and a push failure change nothing for the POST.
 *
 * (b) is SQL the fake pool cannot execute (CI is Node 20, no node:sqlite), so
 * it pins the statement's load-bearing shape — latest id per job, joined back
 * and filtered to tx — plus the row scope, the cap and the response contract.
 *
 * MUTATIONS RUN (each turned this file red, then was restored):
 *   M1 list(): the after=0 branch removed (old ASC read) → (a) failed.
 *   M2 awaitingChats: `AND c.sender_kind = 'tx'` dropped → (b) failed.
 *   M3 post(): push condition widened to every fresh line → (c) tx case failed.
 *   M4 post(): push moved above the ER_DUP_ENTRY catch return → (c) replay failed.
 *   M5 post(): push awaited without a catch → (c) failure case failed (500).
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

let CHAT = [];
const JOB = { job_id: 42, fk_easyfixter_id: 901 };
const dup = () => Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
const AWAITING_ROW = {
  job_id: 42, job_status: 2, job_reference_id: 'EF42', fk_client_id: 5, fk_easyfixter_id: 901,
  client_name: 'Acme', locality: 'Indiranagar', efr_name: 'Ravi', service_catg_name: 'AC',
  chat_id: 17, chat_efr_id: 901, chat_body: 'Customer not home', chat_sent_on: '2026-09-28 10:00:00', sender_name: 'Ravi',
};

const fake = installFakePool([
  [/SHOW COLUMNS FROM tbl_client/, () => [{ Field: 'vertical_id' }]],
  [/INSERT INTO tbl_job_chat/, (_s, [job_id, sender_kind, efr_id, user_id, body, client_msg_id, sent_on]) => {
    if (client_msg_id && CHAT.some((c) => c.job_id === job_id && c.client_msg_id === client_msg_id)) throw dup();
    const row = { id: CHAT.length + 1, job_id, sender_kind, efr_id, user_id, body, client_msg_id, sent_on };
    CHAT.push(row); return { insertId: row.id };
  }],
  [/FROM tbl_job_chat WHERE id = \?/, (_s, [id]) => CHAT.filter((c) => c.id === id)],
  [/FROM tbl_job_chat WHERE job_id = \? AND client_msg_id = \?/, (_s, [j, m]) => CHAT.filter((c) => c.job_id === j && c.client_msg_id === m)],
  [/FROM tbl_job_chat\s+WHERE job_id = \? AND id > \?/, (_s, [j, a, lim]) => CHAT.filter((c) => c.job_id === j && c.id > a).slice(0, lim)],
  [/FROM tbl_job_chat\s+WHERE job_id = \?\s+ORDER BY id DESC/, (_s, [j, lim]) => CHAT.filter((c) => c.job_id === j).sort((x, y) => y.id - x.id).slice(0, lim)],
  [/SELECT fk_easyfixter_id FROM tbl_job WHERE job_id = \?/, (_s, [j]) => (j === JOB.job_id ? [JOB] : [])],
  // scopedJob → job.getById
  [/WHERE\s+j\.job_id\s*=\s*\?\s*LIMIT\s+1/i, (_s, [j]) => (Number(j) === JOB.job_id ? [{ ...JOB, fk_client_id: 5, city_id: 11, job_status: 2 }] : [])],
  [/SELECT COUNT\(\*\) AS n\s+FROM \(SELECT job_id, MAX\(id\)/, () => [{ n: 3 }]],
  [/FROM \(SELECT job_id, MAX\(id\)/, () => [AWAITING_ROW]],
]);

const pushDelivery = require('../services/push-delivery.service');
const chat = require('../services/job-chat.service');

// deliverToEfr is read off the module object at call time, so this stub is what post() reaches.
const realDeliver = pushDelivery.deliverToEfr;
let PUSHES = [];
let pushImpl = async () => ({ delivered: true });
pushDelivery.deliverToEfr = async (efrId, message, opts) => { PUSHES.push({ efrId, message, opts }); return pushImpl(); };

// post() does not await the push; every step of it is a fake-pool microtask.
const settle = () => new Promise((r) => setTimeout(r, 5));

const state = { actions: ['isJobAppRequestResolve'], scope: undefined };
let server;
let base;
before(async () => {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { user_id: 77, permissions: { menuIds: [], actionPermissions: state.actions } };
    req.userRole = { role_name: 'Admin' };
    req.scope = state.scope;
    req.allowedStages = null;
    next();
  });
  app.use('/', require('../routes/admin/ops-desk'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err && err.message) }));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { if (server) server.close(); pushDelivery.deliverToEfr = realDeliver; fake.restore(); });

beforeEach(() => {
  CHAT = []; PUSHES = []; pushImpl = async () => ({ delivered: true });
  state.actions = ['isJobAppRequestResolve']; state.scope = undefined;
  fake.reset();
});

const get = async (path) => { const r = await fetch(base + path); return { status: r.status, body: await r.json() }; };

/* ─── (a) newest window ─────────────────────────────────────────────── */

test('list with no `after` returns the NEWEST 100, ascending; `after` still pages forward', async () => {
  for (let i = 1; i <= 130; i += 1) {
    CHAT.push({ id: i, job_id: 42, sender_kind: i % 2 ? 'tx' : 'desk', efr_id: 901, user_id: null, body: `m${i}`, client_msg_id: null, sent_on: 'x' });
  }
  const first = await chat.list(42);
  assert.equal(first.length, 100);
  assert.equal(first[0].id, 31, 'opens on the newest 100, not the first 100');
  assert.equal(first[99].id, 130);
  assert.deepEqual(first.map((m) => m.id), [...first.map((m) => m.id)].sort((x, y) => x - y), 'still oldest-first');
  assert.equal((await chat.list(42, { after: 0 }))[0].id, 31, 'after=0 is the same as absent');
  const since = await chat.list(42, { after: 125 });
  assert.deepEqual(since.map((m) => m.id), [126, 127, 128, 129, 130]);
});

/* ─── (b) awaiting reply ────────────────────────────────────────────── */

test('GET /ops-desk/chats: latest line per job, tx only, newest first, scoped, capped, counted', async () => {
  state.scope = { clients: { mode: 'allow', ids: [5] } };
  const r = await get('/ops-desk/chats?limit=10');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data, {
    items: [{
      jobId: 42, reference: 'EF42', title: 'AC', clientName: 'Acme', locality: 'Indiranagar',
      technician: { efrId: 901, name: 'Ravi' }, jobStatus: 2,
      lastMessage: { id: 17, efrId: 901, senderName: 'Ravi', body: 'Customer not home', sentOn: '2026-09-28 10:00:00' },
    }],
    total: 3,
  });

  const [list] = fake.calls.filter((c) => /FROM \(SELECT job_id, MAX\(id\)/.test(c.sql) && !/COUNT\(\*\)/.test(c.sql));
  const sql = list.sql.replace(/\s+/g, ' ');
  assert.match(sql, /\(SELECT job_id, MAX\(id\) AS last_id FROM tbl_job_chat GROUP BY job_id\) lc/, 'one latest id per job');
  assert.match(sql, /JOIN tbl_job_chat c ON c\.id = lc\.last_id AND c\.sender_kind = 'tx'/, 'kept only when that latest line is the technician\'s');
  assert.match(sql, /ORDER BY c\.id DESC LIMIT \?/, 'newest first');
  assert.match(sql, /j\.fk_client_id IN \(\?\)/, 'the desk row scope applies');
  assert.deepEqual(list.params, [[5], 10]);
  const [count] = fake.calls.filter((c) => /SELECT COUNT\(\*\) AS n\s+FROM \(SELECT job_id, MAX\(id\)/.test(c.sql));
  assert.ok(count, 'total is counted over the same set');
  assert.deepEqual(count.params, [[5]]);

  state.actions = [];
  assert.equal((await get('/ops-desk/chats')).status, 403, 'gated on isJobAppRequestResolve');
});

/* ─── (c) desk reply pushes the technician ──────────────────────────── */

test('a desk line pushes the job\'s technician once, with the job_chat payload', async () => {
  const long = 'x'.repeat(200);
  const row = await chat.post(42, { senderKind: 'desk', userId: 77, body: long });
  await settle();
  assert.equal(row.senderKind, 'desk');
  assert.equal(PUSHES.length, 1);
  const [p] = PUSHES;
  assert.equal(p.efrId, 901);
  assert.equal(p.message.title, 'EasyFix · Job 42');
  assert.deepEqual(p.message.data, { type: 'job_chat', jobId: '42' });
  assert.equal(p.message.body.length, 120, 'body truncated to 120');
  assert.ok(p.message.body.endsWith('…'));
  await chat.post(42, { senderKind: 'desk', userId: 77, body: 'short' });
  await settle();
  assert.equal(PUSHES[1].message.body, 'short');
});

test('no push for a technician line, a replayed desk line, or a job with no technician', async () => {
  await chat.post(42, { senderKind: 'tx', efrId: 901, body: 'Customer not home', clientMsgId: 'm-1' });
  await settle();
  assert.equal(PUSHES.length, 0, 'tx line');

  await chat.post(42, { senderKind: 'desk', userId: 77, body: 'Wait 10', clientMsgId: 'd-1' });
  await settle();
  assert.equal(PUSHES.length, 1);
  const replay = await chat.post(42, { senderKind: 'desk', userId: 77, body: 'Wait 10', clientMsgId: 'd-1' });
  await settle();
  assert.equal(replay.id, 2, 'the replay returns the row that landed');
  assert.equal(PUSHES.length, 1, 'replay pushes nothing');

  await chat.post(99, { senderKind: 'desk', userId: 77, body: 'Anyone?' });
  await settle();
  assert.equal(PUSHES.length, 1, 'unassigned job');
});

test('a push failure never fails the desk POST', async () => {
  pushImpl = async () => { throw new Error('FCM down'); };
  const r = await fetch(`${base}/jobs/42/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'On it' }),
  });
  const body = await r.json();
  await settle();
  assert.equal(r.status, 200, JSON.stringify(body));
  assert.equal(body.data.body, 'On it');
  assert.equal(PUSHES.length, 1, 'the push was attempted, and threw');
  assert.equal(CHAT.length, 1, 'the line stands');
});
