/*
 * Plivo month spend (services/plivo-spend.service.js) — summed from the Call and
 * Transcription LIST APIs because Plivo has no usage-summary endpoint.
 *
 * The fake lists below follow the live API's behaviour measured 2026-09-17:
 * newest first, 20 per page, an out-of-range offset returns [], Call honours
 * end_time__gte, Transcription ignores time filters (so the walk must stop on
 * add_time itself). Field names are the live ones: call_uuid/total_amount/
 * end_time and transcription_id/transcription_cost/add_time.
 *
 * Runner: `node --test` (see npm test).
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const plivo = require('../services/plivo.service');
const spend = require('../services/plivo-spend.service');

const NOW = Date.UTC(2026, 8, 17, 9, 0, 0);            // 17 Sep 2026 14:30 IST
const MONTH_START = Date.UTC(2026, 7, 31, 18, 30, 0);  // 1 Sep 2026 00:00 IST
const plivoTs = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00:00');

let calls; let transcriptions; let requested; let failOn;

function page(list, path) {
  const offset = Number(/offset=(\d+)/.exec(path)[1]);
  return list.slice(offset, offset + 20);
}

beforeEach(() => {
  spend._reset();
  requested = [];
  failOn = null;
  // 200 calls this month, $0.01 each, newest first — long enough that a full
  // walk needs TWO waves, so an incremental refresh is distinguishable from it.
  calls = Array.from({ length: 200 }, (_, i) => ({ call_uuid: `c${i}`, total_amount: '0.01000', end_time: plivoTs(NOW - (i + 1) * 60_000) }));
  // 30 transcriptions this month ($0.0095) then 30 from August that must not count.
  transcriptions = [
    ...Array.from({ length: 30 }, (_, i) => ({ transcription_id: `t${i}`, transcription_cost: '0.00950', add_time: plivoTs(NOW - (i + 1) * 60_000) })),
    ...Array.from({ length: 30 }, (_, i) => ({ transcription_id: `old${i}`, transcription_cost: '0.00950', add_time: plivoTs(MONTH_START - (i + 1) * 60_000) })),
  ];
  plivo.listPage = async (path) => {
    requested.push(path);
    if (failOn && failOn(path)) throw new Error('Plivo list http=429');
    if (path.startsWith('/Call/')) {
      assert.match(path, /end_time__gte=2026-08-31%2018%3A30%3A00/, 'calls must be filtered from the IST month start');
      return page(calls, path);
    }
    return page(transcriptions, path);
  };
});

test('istMonth: 00:30 IST on the 1st is already the new month, starting 18:30 UTC the day before', () => {
  const m = spend.istMonth(Date.UTC(2026, 7, 31, 19, 0, 0));
  assert.equal(m.month, '2026-09');
  assert.equal(m.startMs, MONTH_START);
  assert.equal(m.sinceParam, '2026-08-31 18:30:00');
  assert.equal(spend.istMonth(Date.UTC(2026, 7, 31, 18, 0, 0)).month, '2026-08');
});

test('a cold refresh sums every call and only THIS month\'s transcriptions', async () => {
  await spend.refresh(NOW);
  const s = spend.getMonthSpend(NOW);
  assert.deepEqual(s.calls, { usd: 2, count: 200, ready: true, estimate: false, estimateReasons: [] });
  assert.deepEqual(s.transcriptions, { usd: 0.285, count: 30, ready: true, estimate: false, estimateReasons: [] });
  assert.equal(s.month, '2026-09');
  assert.equal(s.error, null);
});

test('getMonthSpend never waits: the first read says refreshing and not ready', async () => {
  const s = spend.getMonthSpend(NOW);
  assert.equal(s.refreshing, true);
  assert.equal(s.calls.ready, false);
  assert.equal(s.calls.count, 0);
  assert.equal(s.calls.estimate, true, 'a count still in progress must never read as the actual cost');
  assert.match(s.calls.estimateReasons[0], /Still counting/);
  await spend.refresh(NOW); // let the kicked walk finish inside this test
});

test('after a full walk, a refresh reads only the first wave and picks up prepended items', async () => {
  await spend.refresh(NOW);
  calls.unshift({ call_uuid: 'new1', total_amount: '0.02000', end_time: plivoTs(NOW) });
  requested = [];
  await spend.refresh(NOW + 1000);
  const s = spend.getMonthSpend(NOW + 1000);
  assert.equal(s.calls.count, 201);
  assert.equal(s.calls.usd, 2.02);
  assert.equal(requested.filter((p) => p.startsWith('/Call/')).length, 6, 'one wave, not the whole list');
});

test('a failed page reports the error, and the next refresh walks the whole list again', async () => {
  failOn = (p) => p.startsWith('/Call/') && p.includes('offset=20&');
  await spend.refresh(NOW);
  let s = spend.getMonthSpend(NOW);
  assert.match(s.error, /429/);
  assert.equal(s.calls.ready, false);
  assert.equal(s.calls.estimate, true);
  assert.equal(s.calls.estimateReasons.length, 2, 'unfinished AND failed — both reasons shown');
  assert.equal(s.transcriptions.ready, true, 'the sibling walk still completes');
  assert.equal(s.transcriptions.estimate, true, 'a failed refresh makes every figure an estimate');
  assert.equal(s.refreshing, false, 'inside the retry cooldown, no new walk is kicked');

  failOn = null;
  await spend.refresh(NOW + 120_000);
  s = spend.getMonthSpend(NOW + 120_000);
  assert.equal(s.error, null);
  assert.deepEqual(s.calls, { usd: 2, count: 200, ready: true, estimate: false, estimateReasons: [] });
});
