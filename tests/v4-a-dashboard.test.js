'use strict';
/*
 * V3 Phase 4 (4.2) — the new Home on GET /mobile/dashboard, with the DB faked.
 *
 *   1. Critical · Today · Upcoming (D3), each with Σ his share; GO FIRST (D2);
 *      the escalation banner; yesterday's count and ₹.
 *   2. The whole dashboard's query budget is FIXED — the same for 1 job and 40 —
 *      and the best day is served from the per-technician cache inside the hour.
 *   3. Header facts: lifetime earned, points, work area, skills, working hours
 *      (property, else "10:00-20:00"), the latest review with a short reviewer name.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

let IDENT = { efr_id: 7, efr_name: 'Ravi', current_balance: 100 };
let HOME_ROWS; let SHARES; let FACTS; let CITIES; let SKILLS; let BEST; let REVIEW;
function reset() {
  HOME_ROWS = []; SHARES = {}; FACTS = { earned_lifetime: '41250.50', points: '720', pincodes: '122001, 122002,bad,122003' };
  CITIES = [{ city_name: 'Gurugram', n: 2 }, { city_name: 'Delhi', n: 1 }];
  SKILLS = [{ name: 'Carpentry', n: 5 }, { name: 'Plumbing', n: 1 }];
  BEST = [{ best: 7 }];
  REVIEW = [{ customer_rating: 5, comment: '  ', review_comment: 'Came on time.', insert_date_time: '2026-09-23 19:10:00', customer_name: 'Anita  mehra' }];
}
reset();

const fake = installFakePool([
  [/AS is_escalated/, () => HOME_ROWS],
  [/FROM tbl_job_transaction WHERE fk_job_id IN/, (_s, [ids]) => ids.filter((id) => SHARES[id] != null)
    .map((id) => ({ job_id: id, efr_charge: SHARES[id] }))],
  [/AS earned_lifetime/, () => [FACTS]],
  [/FROM tbl_pincode p JOIN tbl_city/, () => CITIES],
  [/FROM tbl_efr_deepskill_mapping/, () => SKILLS],
  [/MAX\(t\.n\) AS best/, () => BEST],
  [/FROM tbl_easyfixer_rating_by_customer r\s+LEFT JOIN tbl_job/, () => REVIEW],
  [/FROM tbl_easyfixer e/, () => [IDENT]],
]);

const dashboard = require('../services/mobile-dashboard.service');
const jobService = require('../services/job.service');
const performanceService = require('../services/performance.service');
const noticeService = require('../services/notice.service');
const properties = require('../services/properties.service');

const {
  fetchHomeJobs, fetchBestDay, fetchTechFacts, fetchSkills, fetchLatestReview, workingHours,
  bestDayCache, istInstantMs,
} = dashboard._internals;

const NOW = Date.parse('2026-09-24T12:00:00+05:30'); // IST noon
const job = (job_id, job_status, requested, extra = {}) => ({
  job_id, job_status, requested_date_time: requested, checkin_date_time: null, checkout_date_time: null,
  title: 'Wardrobe shutter', area: 'Phase 4', is_escalated: 0, ...extra,
});

const originals = [];
function stub(obj, name, fn) { originals.push([obj, name, obj[name]]); obj[name] = fn; }
before(() => {
  stub(jobService, 'list', async () => ({ rows: [], total: 0 }));
  stub(jobService, 'listOfferedForTech', async () => ({ items: [] }));
  stub(jobService, 'jobOfferTableExists', async () => true);
  stub(performanceService, 'getForTech', async () => ({ grade: 'A', rating: 4.8 }));
  stub(noticeService, 'listActiveForSurface', async () => []);
  stub(noticeService, 'countUnreadForSurface', async () => 0);
});
after(() => { for (const [o, n, f] of originals) o[n] = f; fake.restore(); });
beforeEach(() => { reset(); fake.reset(); bestDayCache.clear(); });

/* ─── 1. The buckets, GO FIRST and the banner ────────────────────────── */

function dayRows() {
  SHARES = { 101: 800, 102: 600, 103: 700, 104: 500, 105: 1200, 106: 90, 107: 70, 108: 400, 109: 300 };
  return [
    job(101, 1, '2026-09-22 10:00:00'),                               // 2 days late → critical
    job(102, 1, '2026-09-24 15:00:00', { is_escalated: 1, title: 'Cabinet fix', area: 'Palam Vihar' }), // escalated → critical
    job(103, 1, '2026-09-24 17:00:00'),                               // later today → today
    job(104, 2, '2026-10-10 10:00:00', { checkin_date_time: '2026-09-24 09:00:00' }), // started today → today
    job(105, 1, '2026-09-27 10:00:00'),                               // in 3 days → upcoming
    job(106, 1, '2026-10-05 10:00:00'),                               // 11 days out → none
    job(107, 10, '2026-09-20 10:00:00'),                              // revisit, begun → none
    job(108, 3, null, { checkout_date_time: '2026-09-23 18:00:00' }), // finished yesterday
    job(109, 1, '2026-09-24 11:00:00'),                               // an hour ago → critical
  ];
}

test('Critical · Today · Upcoming partition his jobs by D3, each with Σ his share', async () => {
  HOME_ROWS = dayRows();
  const { home, yesterday } = await fetchHomeJobs(7, NOW);
  assert.deepEqual(home.critical, { count: 3, share: 800 + 600 + 300 });
  assert.deepEqual(home.today, { count: 2, share: 700 + 500 }, 'a job started today is today\'s, whatever its booking');
  assert.deepEqual(home.upcoming, { count: 1, share: 1200 });
  assert.equal(home.comingUpThisWeek, 1);
  assert.deepEqual(yesterday, { jobs: 1, earned: 400 });
});

test('GO FIRST: escalated first, then the most overdue; the banner is that job only when escalated', async () => {
  HOME_ROWS = dayRows();
  let r = await fetchHomeJobs(7, NOW);
  assert.equal(r.home.goFirstJobId, 102, 'the escalated job beats two older overdue ones');
  assert.deepEqual(r.escalation, { jobId: 102, title: 'Cabinet fix', area: 'Palam Vihar' });
  HOME_ROWS = dayRows().map((x) => ({ ...x, is_escalated: 0 }));
  r = await fetchHomeJobs(7, NOW);
  assert.equal(r.home.goFirstJobId, 101, 'no escalation → most overdue');
  assert.equal(r.escalation, null);
  HOME_ROWS = [job(104, 2, '2026-09-24 09:00:00', { checkin_date_time: '2026-09-24 09:05:00', is_escalated: 1 })];
  r = await fetchHomeJobs(7, NOW);
  assert.equal(r.home.goFirstJobId, null, 'a job he is already on is not a "go first"');
  assert.equal(r.escalation, null);
});

test('an IST wall-clock DATETIME string is read as +05:30, whatever the server zone', () => {
  assert.equal(istInstantMs('2026-09-24 12:00:00'), NOW);
  assert.equal(istInstantMs('2026-09-24T12:00'), NOW);
  assert.equal(istInstantMs(null), null);
});

test('home jobs cost TWO queries for one job and for forty — never per row', async () => {
  for (const n of [1, 40]) {
    fake.reset();
    HOME_ROWS = Array.from({ length: n }, (_, i) => job(1000 + i, 1, '2026-09-24 18:00:00'));
    SHARES = Object.fromEntries(HOME_ROWS.map((x) => [x.job_id, 100]));
    const { home } = await fetchHomeJobs(7, NOW);
    assert.equal(home.today.count, n, 'positive control: every job was bucketed');
    assert.equal(fake.calls.length, 2, `${n} job(s): home read + shares`);
  }
});

/* ─── 2. The whole dashboard's budget, and the best-day cache ────────── */

const dbCalls = () => fake.calls.filter((c) => !/easyfix_properties/.test(c.sql));

test('GET /dashboard\'s query budget is fixed; inside the hour the best day costs nothing', async () => {
  const counts = [];
  for (const n of [1, 40]) {
    bestDayCache.clear();
    fake.reset();
    HOME_ROWS = Array.from({ length: n }, (_, i) => job(2000 + i, 1, '2026-09-24 18:00:00'));
    SHARES = Object.fromEntries(HOME_ROWS.map((x) => [x.job_id, 100]));
    const d = await dashboard.getDashboard(7);
    assert.equal(d.home.today.count + d.home.critical.count, n, 'positive control: the jobs reached Home');
    counts.push(dbCalls().length);
  }
  assert.equal(counts[0], counts[1], `the budget must not grow with his jobs: ${counts.join(' vs ')}`);
  assert.equal(counts[0], 10, 'identity, attendance, date counts, facts, cities, skills, home, shares, best day, review');
  fake.reset();
  const d = await dashboard.getDashboard(7);
  assert.equal(dbCalls().length, 9, 'second load: best day from the cache');
  assert.equal(d.yesterday.bestDay, 7);
});

test('the best-day cache is keyed by technician and expires after an hour', async () => {
  assert.equal(await fetchBestDay(7, NOW), 7);
  BEST = [{ best: 3 }];
  assert.equal(await fetchBestDay(7, NOW + 59 * 60_000), 7, 'cached');
  assert.equal(await fetchBestDay(8, NOW), 3, 'another technician never reads 7\'s entry');
  assert.equal(await fetchBestDay(7, NOW + 61 * 60_000), 3, 'expired → re-read');
  const q = fake.calls.find((c) => /MAX\(t\.n\) AS best/.test(c.sql));
  assert.deepEqual(q.params, [7, '2026-06-26 00:00:00'], '90 IST days back, scoped to his efr_id');
});

test('the header\'s home location is his home PIN\'s locality, joined in — never the PIN, never a new query', async () => {
  IDENT = { efr_id: 7, efr_name: 'Ravi', current_balance: 100, home_location: '  DLF Phase 3 ', city_name: 'Gurugram' };
  fake.reset();
  const d = await dashboard.getDashboard(7);
  assert.equal(d.technician.homeLocation, 'DLF Phase 3');
  const q = fake.calls.find((c) => /FROM tbl_easyfixer e/.test(c.sql));
  assert.match(q.sql, /LEFT JOIN tbl_pincode hp ON hp\.pincode = e\.efr_pin_no/, 'a LEFT join: no home PIN still loads Home');
  IDENT = { efr_id: 7, efr_name: 'Ravi', current_balance: 100, home_location: null };
  assert.equal((await dashboard.getDashboard(7)).technician.homeLocation, null, 'unknown stays null, never ""');
  IDENT = { efr_id: 7, efr_name: 'Ravi', current_balance: 100 };
});

/* ─── 3. Header facts ────────────────────────────────────────────────── */

test('earned, points, work area and skills', async () => {
  const f = await fetchTechFacts(7);
  assert.deepEqual(f, {
    earnedLifetime: 41251, points: 720,
    workArea: { cities: ['Gurugram', 'Delhi'], pinCount: 3 },
  });
  const cityQ = fake.calls.find((c) => /FROM tbl_pincode p/.test(c.sql));
  assert.deepEqual(cityQ.params, [['122001', '122002', '122003']], 'only well-formed PINs are looked up');
  fake.reset();
  FACTS = { earned_lifetime: 0, points: 0, pincodes: null };
  assert.deepEqual((await fetchTechFacts(7)).workArea, { cities: [], pinCount: 0 });
  assert.equal(fake.calls.length, 1, 'no PINs → no city lookup');
  assert.deepEqual(await fetchSkills(7), { primary: 'Carpentry', count: 2 });
});

test('working hours: the company property, else 10:00-20:00; working today = attendance present', () => {
  const orig = properties.getProperty;
  try {
    properties.getProperty = (k) => (k === 'technician.working_hours.default' ? '08:30-18:00' : undefined);
    assert.deepEqual(workingHours({ morning_slot: 1 }), { start: '08:30', end: '18:00', workingToday: true });
    for (const bad of [undefined, '', '9-5', '25:00-20:00']) {
      properties.getProperty = () => bad;
      assert.deepEqual(workingHours({ morning_slot: 1 }), { start: '10:00', end: '20:00', workingToday: true }, String(bad));
    }
    assert.equal(workingHours({ morning_slot: 0 }).workingToday, false);
    assert.equal(workingHours({ morning_slot: 1, is_leave_marked: 1 }).workingToday, false);
    assert.equal(workingHours(null).workingToday, false);
  } finally { properties.getProperty = orig; }
});

test('the latest review: rating, the words, a short reviewer name and when', async () => {
  assert.deepEqual(await fetchLatestReview(7), {
    rating: 5, text: 'Came on time.', reviewer: 'Anita M.', at: '2026-09-23 19:10:00',
  });
  REVIEW = [];
  assert.equal(await fetchLatestReview(7), null);
});
