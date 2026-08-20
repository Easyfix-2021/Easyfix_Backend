const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const phe = require('../services/mobile-phe.service');
const team = require('../services/mobile-team.service');

const originals = {
  getOverview: phe.getOverview,
  getInQa: phe.getInQa,
  getMonthJobs: phe.getMonthJobs,
  getJobDetail: phe.getJobDetail,
  getMissed: phe.getMissed,
  getWithdrawals: phe.getWithdrawals,
  getMyTeam: team.getMyTeam,
  getTeamProfile: team.getTeamProfile,
  listMembers: team.listMembers,
  getMemberDetail: team.getMemberDetail,
  getMemberJobs: team.getMemberJobs,
};

const received = [];
let server;
let baseUrl;

before(async () => {
  phe.getOverview = async (...args) => { received.push(['overview', ...args]); return { ok: 'overview' }; };
  phe.getInQa = async (...args) => { received.push(['inQa', ...args]); return { ok: 'inQa' }; };
  phe.getMonthJobs = async (...args) => { received.push(['monthJobs', ...args]); return { ok: 'monthJobs' }; };
  phe.getJobDetail = async (...args) => { received.push(['jobDetail', ...args]); return { ok: 'jobDetail' }; };
  phe.getMissed = async (...args) => { received.push(['missed', ...args]); return { ok: 'missed' }; };
  phe.getWithdrawals = async (...args) => { received.push(['withdrawals', ...args]); return { ok: 'withdrawals' }; };
  team.getMyTeam = async (...args) => { received.push(['legacyTeam', ...args]); return []; };
  team.getTeamProfile = async (...args) => { received.push(['teamProfile', ...args]); return { ok: 'teamProfile' }; };
  team.listMembers = async (...args) => { received.push(['members', ...args]); return { ok: 'members' }; };
  team.getMemberDetail = async (...args) => { received.push(['memberDetail', ...args]); return { ok: 'memberDetail' }; };
  team.getMemberJobs = async (...args) => { received.push(['memberJobs', ...args]); return { ok: 'memberJobs' }; };

  // Require routers only after stubbing their service objects.
  // eslint-disable-next-line global-require
  const pheRouter = require('../routes/mobile/phe');
  // eslint-disable-next-line global-require
  const teamRouter = require('../routes/mobile/team');
  const app = express();
  app.use((req, _res, next) => { req.tech = { efr_id: 77 }; next(); });
  app.use('/phe', pheRouter);
  app.use('/team', teamRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  Object.assign(phe, {
    getOverview: originals.getOverview,
    getInQa: originals.getInQa,
    getMonthJobs: originals.getMonthJobs,
    getJobDetail: originals.getJobDetail,
    getMissed: originals.getMissed,
    getWithdrawals: originals.getWithdrawals,
  });
  Object.assign(team, {
    getMyTeam: originals.getMyTeam,
    getTeamProfile: originals.getTeamProfile,
    listMembers: originals.listMembers,
    getMemberDetail: originals.getMemberDetail,
    getMemberJobs: originals.getMemberJobs,
  });
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: await response.json() };
}

test('PHE routes always pass the implicit authenticated technician id', async () => {
  received.length = 0;
  assert.equal((await get('/phe/overview?before=2026-09&limit=6')).status, 200);
  assert.equal((await get('/phe/in-qa?page=1&limit=20')).status, 200);
  assert.equal((await get('/phe/months/2026-08/jobs?page=2&limit=10')).status, 200);
  assert.equal((await get('/phe/jobs/88213')).status, 200);
  assert.equal((await get('/phe/missed')).status, 200);
  assert.equal((await get('/phe/withdrawals?page=1&limit=20')).status, 200);
  assert.deepEqual(received.map((entry) => entry[1]), [77, 77, 77, 77, 77, 77]);
  assert.equal(received.find((entry) => entry[0] === 'jobDetail')[2], 88213);
});

test('PHE validation rejects unbounded pages, invalid months and non-30-day missed windows', async () => {
  assert.equal((await get('/phe/overview?limit=13')).status, 400);
  assert.equal((await get('/phe/months/2026-13/jobs')).status, 400);
  assert.equal((await get('/phe/months/2026-08/jobs?limit=51')).status, 400);
  assert.equal((await get('/phe/missed?days=365')).status, 400);
});

test('new Team routes are additive and direct-member calls are auth scoped', async () => {
  received.length = 0;
  assert.equal((await get('/team')).status, 200, 'legacy route remains reachable');
  assert.equal((await get('/team/profile?month=2026-08')).status, 200);
  assert.equal((await get('/team/members?month=2026-08&page=1&limit=20')).status, 200);
  assert.equal((await get('/team/members/21?month=2026-08')).status, 200);
  assert.equal((await get('/team/members/21/jobs?month=2026-08&page=1&limit=20')).status, 200);
  assert.deepEqual(received.map((entry) => entry[1]), [77, 77, 77, 77, 77]);
  const memberCall = received.find((entry) => entry[0] === 'memberDetail');
  assert.equal(memberCall[2], 21);
});

test('Team validation bounds pagination and ids', async () => {
  assert.equal((await get('/team/members?limit=51')).status, 400);
  assert.equal((await get('/team/members/21/jobs?limit=51')).status, 400);
  assert.equal((await get('/team/members/0')).status, 400);
  assert.equal((await get('/team/profile?month=August')).status, 400);
});
