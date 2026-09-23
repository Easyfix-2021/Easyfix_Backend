/*
 * Booking queue — the five tiles on My Orders -> Unconfirmed (new tab).
 *
 * WHAT THESE PROTECT.
 *
 * 1. EVERY OPEN JOB IS IN EXACTLY ONE TILE. The tiles are a precedence chain,
 *    not five independent filters, and SQL has no if-chain — each bucket has to
 *    exclude the ones above it by hand. Miss one exclusion and a job appears
 *    twice: the tiles stop summing to the tab total, and ops cannot tell 100
 *    orders from 95. The truth table below runs every combination of the four
 *    facts a bucket is decided by and asserts exactly one bucket claims it.
 *
 * 2. A CLIENT WITH NO PROPERTY ROW IS "NO LINK NEEDED". The cron only sends
 *    when the value is exactly 'true', so a missing row means no link will ever
 *    arrive. A bucket that filed those under "waiting for link" would promise a
 *    message nobody is going to send.
 *
 * 3. THE PERIOD IS IST CALENDAR DAYS. magic_link_sent_at is written as a JS
 *    Date against a +05:30 pool, so a link sent at 02:00 IST belongs to that
 *    IST day — computing the window in UTC would file it under yesterday.
 *
 * 4. links.sent = response_received + no_response + delivery_failed, ALWAYS.
 *    That identity is the whole reason the counts are one query: it cannot hold
 *    if the three numbers come from three passes over a moving table.
 *
 * No DB, no network. Runner: `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeFakePool } = require('./helpers/fake-pool');

const bq = require('../services/booking-queue.service');

/* ── 1. The precedence chain ─────────────────────────────────────────────── */

/*
 * A tiny evaluator for the generated SQL. It does NOT re-implement the rule —
 * it substitutes each job's facts into the predicate string and lets JS decide,
 * so what is asserted is the text actually sent to MySQL. The four EXISTS /
 * column tests are the only vocabulary the predicates use.
 */
function holds(sql, job) {
  // Replace each EXISTS(...) with its truth value. Paren-BALANCED, not a lazy
  // regex: the opt-in subquery contains REPLACE(...) calls, so `[\s\S]*?\)`
  // stops at the first inner bracket and leaves a broken expression behind.
  let js = sql;
  for (;;) {
    const at = js.indexOf('EXISTS (');
    if (at === -1) break;
    let depth = 0, i = js.indexOf('(', at);
    const from = i;
    for (; i < js.length; i += 1) {
      if (js[i] === '(') depth += 1;
      else if (js[i] === ')') { depth -= 1; if (depth === 0) break; }
    }
    const inner = js.slice(from, i + 1);
    const value = inner.includes('tbl_job_customer_request') ? !!job.hasRequest : !!job.optedIn;
    js = js.slice(0, at) + String(value) + js.slice(i + 1);
  }
  js = js
    .replace(/j\.customer_submitted_at IS NOT NULL/g, String(!!job.submitted))
    // The whole NULL-guarded expression collapses to one boolean — see the
    // NULL-safety test below for why the guard is there.
    .replace(
      /\(j\.magic_link_delivery_status IS NOT NULL\s*AND j\.magic_link_delivery_status IN \('failed', 'undelivered'\)\)/g,
      String(!!job.failed),
    )
    .replace(/j\.magic_link_sent_at IS NOT NULL/g, String(!!job.sent))
    .replace(/\bNOT\b/g, '!')
    .replace(/\bAND\b/g, '&&')
    .replace(/\bOR\b/g, '||');
  assert.doesNotMatch(js, /[a-z_]{3,}\./i, `substitution left SQL behind: ${js}`);
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${js});`)();
}

test('every combination of facts lands in EXACTLY ONE tile', () => {
  const bools = [false, true];
  let checked = 0;
  for (const optedIn of bools) {
    for (const sent of bools) {
      for (const submitted of bools) {
        for (const failed of bools) {
          for (const hasRequest of bools) {
            const job = { optedIn, sent, submitted, failed, hasRequest };
            const hit = bq.BUCKETS.filter((b) => holds(bq.bucketPredicate(b), job));
            assert.equal(hit.length, 1,
              `${JSON.stringify(job)} matched ${hit.length} tiles (${hit.join(', ') || 'none'}) — must be exactly 1`);
            checked += 1;
          }
        }
      }
    }
  }
  assert.equal(checked, 32, 'the whole truth table was walked');
});

test('the tile each kind of job lands in', () => {
  const where = (job) => bq.BUCKETS.find((b) => holds(bq.bucketPredicate(b), job));

  assert.equal(where({ optedIn: false }), 'no_link_needed',
    'client setting false or missing → the team calls, no link is ever sent');
  assert.equal(where({ optedIn: false, sent: true, submitted: true }), 'no_link_needed',
    'not opted in wins outright — nothing about a link can move it');

  assert.equal(where({ optedIn: true }), 'new', 'opted in, nothing sent yet → waiting for the hourly link');
  assert.equal(where({ optedIn: true, sent: true }), 'no_response', 'sent, silence');
  assert.equal(where({ optedIn: true, sent: true, submitted: true }), 'response_received', 'filled the form');
  assert.equal(where({ optedIn: true, sent: true, hasRequest: true }), 'response_received',
    'asked to cancel or reschedule — an answer, not a confirmation');
  assert.equal(where({ optedIn: true, sent: true, failed: true }), 'delivery_failed', 'WhatsApp could not deliver');
  assert.equal(where({ optedIn: true, sent: true, failed: true, submitted: true }), 'response_received',
    'an answer beats an earlier failure report — it is the newer fact');
});

test('an instant failure is NOT left in "new" — that was the whole bug', () => {
  // markInstantFailure stamps sent_at AND delivery_status, so the job leaves
  // the waiting tile and lands where someone will call it.
  const job = { optedIn: true, sent: true, failed: true };
  assert.equal(bq.BUCKETS.find((b) => holds(bq.bucketPredicate(b), job)), 'delivery_failed');
});

/*
 * THE NULL BUG, pinned.
 *
 * `magic_link_delivery_status` is NULL on every job that never got a delivery
 * report — which is most of them. `NULL IN ('failed','undelivered')` is NULL,
 * `NOT NULL` is NULL, and a WHERE that is NULL excludes the row. So before the
 * IS NOT NULL guard, 146 of the 149 open unconfirmed orders on QA matched NO
 * bucket: every tile read 0 and the page looked calm rather than broken.
 *
 * The truth table above cannot catch this — it substitutes JS booleans, and JS
 * has no third value. This test reads the generated SQL instead.
 */
test('the delivery-status test is NULL-safe — a job with no report is FALSE, not NULL', () => {
  for (const b of bq.BUCKETS) {
    const sql = bq.bucketPredicate(b);
    const uses = /magic_link_delivery_status IN/.test(sql);
    if (!uses) continue;
    assert.match(
      sql,
      /magic_link_delivery_status IS NOT NULL\s*\n?\s*AND [a-z]\.magic_link_delivery_status IN/,
      `${b}: a bare IN on a nullable column makes NOT(...) evaluate to NULL, and the row falls out of every bucket`,
    );
  }
});

test('the three link tiles still partition a NULL-status job between them', () => {
  // SQL semantics, not JS: an unguarded IN would return null here and the job
  // would match nothing. `failed: false` is the post-guard behaviour.
  const job = { optedIn: true, sent: true, failed: false };
  const hit = bq.BUCKETS.filter((b) => holds(bq.bucketPredicate(b), job));
  assert.deepEqual(hit, ['no_response'], 'sent, no answer, no failure report → No response');
});

test('unknown bucket names never mean "unfiltered"', () => {
  assert.equal(bq.bucketPredicate('nonsense'), null);
  assert.equal(bq.bucketPredicate(''), null);
  assert.equal(bq.bucketPredicate(undefined), null);
});

test('without tbl_job_customer_request the answer test degrades, it does not break', () => {
  const sql = bq.bucketPredicate('response_received', { hasRequestTable: false });
  assert.doesNotMatch(sql, /tbl_job_customer_request/);
  assert.match(sql, /customer_submitted_at IS NOT NULL/, 'the form answer still counts');
});

/* ── 2. The period window, in IST ────────────────────────────────────────── */

const IST = (s) => new Date(new Date(`${s}+05:30`).toISOString());

test('today covers the IST calendar day, not the UTC one', () => {
  // 02:00 IST on the 23rd is still 20:30 UTC on the 22nd.
  const now = IST('2026-09-23T02:00:00');
  const { start, end } = bq.periodRange('today', now);
  assert.equal(start.toISOString(), IST('2026-09-23T00:00:00').toISOString());
  assert.equal(end.toISOString(), IST('2026-09-24T00:00:00').toISOString());
  assert.ok(now >= start && now < end, 'a link sent at 02:00 IST counts as TODAY');
});

test('yesterday is the previous IST day, and the two windows do not overlap', () => {
  const now = IST('2026-09-23T14:00:00');
  const y = bq.periodRange('yesterday', now);
  const t = bq.periodRange('today', now);
  assert.equal(y.start.toISOString(), IST('2026-09-22T00:00:00').toISOString());
  assert.equal(y.end.toISOString(), t.start.toISOString(), 'yesterday ends exactly where today begins');
});

test('last7 is seven calendar days ending today, today included', () => {
  const now = IST('2026-09-23T14:00:00');
  const { start, end } = bq.periodRange('last7', now);
  assert.equal(start.toISOString(), IST('2026-09-17T00:00:00').toISOString());
  assert.equal(end.toISOString(), IST('2026-09-24T00:00:00').toISOString());
  assert.equal((end - start) / 86400000, 7);
});

test('an unknown period falls back to today rather than an empty window', () => {
  const now = IST('2026-09-23T14:00:00');
  assert.deepEqual(bq.periodRange('garbage', now), bq.periodRange('today', now));
});

test('istToday reads the IST date even when UTC is still on yesterday', () => {
  assert.equal(bq.istToday(IST('2026-09-23T01:00:00')), '2026-09-23');
});

/* ── 3. counts(): the shape the tiles render ─────────────────────────────── */

function countsPool(sentRow, waitRow) {
  return makeFakePool([
    [/FROM tbl_job j[\s\S]*magic_link_sent_at >= \?/, [sentRow]],
    [/FROM tbl_job j[\s\S]*job_status = 9/, [waitRow]],
  ]);
}
const SENT_ROW = {
  sent: 100, responded: 25, failed: 5, no_response: 70,
  responded_open: 7, failed_open: 4, no_response_open: 58,
};
const WAIT_ROW = { new_today: 12, new_old: 3, no_link_today: 8, no_link_old: 14,
  open_responded: 7, open_no_response: 58, open_failed: 4 };

test('links.sent always equals the three outcomes added together', async () => {
  const out = await bq.counts({ db: countsPool(SENT_ROW, WAIT_ROW).pool });
  const { sent, response_received: r, no_response: n, delivery_failed: f } = out.links;
  assert.equal(r + n + f, sent, '25 + 70 + 5 must be the 100 links we sent');
  assert.deepEqual(out.open, { response_received: 7, no_response: 58, delivery_failed: 4 });
  assert.deepEqual(out.waiting.new, { today: 12, old: 3 });
  assert.deepEqual(out.waiting.no_link_needed, { today: 8, old: 14 });
});

/*
 * THE COUNT THAT WENT MISSING, pinned.
 *
 * `open` was once a subset of the PERIOD cohort — "of the links sent today,
 * how many still wait". On the QA book that read 0 on every tile while 133 open
 * orders sat in No response from links sent weeks earlier: the page described
 * 13 of 149 orders and looked finished. An order does not stop needing a call
 * because its link is old, and the grid lists every open order in the bucket.
 *
 * So `open` is now the WHOLE queue and must be free of the date window, while
 * `period_open` keeps the subset that "closed" is derived from.
 */
test('open is the whole queue, NOT a slice of the period', async () => {
  const quietDay = { sent: 0, responded: 0, failed: 0, no_response: 0,
    responded_open: 0, failed_open: 0, no_response_open: 0 };
  const board = { ...WAIT_ROW, open_responded: 3, open_no_response: 133, open_failed: 0 };
  const out = await bq.counts({ db: countsPool(quietDay, board).pool });

  assert.equal(out.links.sent, 0, 'no links went out in the period');
  assert.equal(out.open.no_response, 133,
    '133 open orders still need calling — a quiet period must not hide them');
  assert.deepEqual(out.period_open, { response_received: 0, no_response: 0, delivery_failed: 0 });
});

test('the tiles add up to every open order — none belongs to nothing', async () => {
  const board = { new_today: 0, new_old: 13, no_link_today: 0, no_link_old: 0,
    open_responded: 3, open_no_response: 133, open_failed: 0 };
  const out = await bq.counts({ db: countsPool({ sent: 0 }, board).pool });
  const total = out.open.response_received + out.open.no_response + out.open.delivery_failed
    + out.waiting.new.today + out.waiting.new.old
    + out.waiting.no_link_needed.today + out.waiting.no_link_needed.old;
  assert.equal(total, 149, 'the five tiles must sum to the tab total (measured on QA: 149)');
});

test('the period subset never exceeds the period funnel', async () => {
  const out = await bq.counts({ db: countsPool(SENT_ROW, WAIT_ROW).pool });
  for (const k of ['response_received', 'no_response', 'delivery_failed']) {
    assert.ok(out.period_open[k] <= out.links[k], `${k}: the still-open slice is part of what happened`);
  }
});

test('an empty book reads as zeros, never NULL or NaN', async () => {
  const out = await bq.counts({ db: countsPool({ sent: 0 }, {}).pool });
  assert.deepEqual(out.links, { sent: 0, response_received: 0, no_response: 0, delivery_failed: 0 });
  assert.deepEqual(out.waiting.new, { today: 0, old: 0 });
  for (const v of Object.values(out.open)) assert.equal(Number.isFinite(v), true);
});

test('the caller\'s row filter and owner scope reach BOTH queries', async () => {
  const fake = countsPool(SENT_ROW, WAIT_ROW);
  await bq.counts({
    db: fake.pool, ownerId: 77,
    scopeSql: 'j.fk_client_id IN (?)', scopeParams: [42],
    scopeJoins: 'LEFT JOIN tbl_address ad ON ad.address_id = j.fk_address_id',
  });
  assert.equal(fake.calls.length, 2, 'two passes, not one per tile');
  for (const c of fake.calls) {
    assert.match(c.sql, /fk_client_id IN \(\?\)/, 'RBAC filter applied');
    assert.match(c.sql, /LEFT JOIN tbl_address ad/, 'and the join it needs');
    assert.match(c.sql, /j\.job_owner = \?/, 'My Orders is owner-scoped outside the admin group');
    assert.ok(c.params.includes(42) && c.params.includes(77), 'both bound');
  }
});

test('the period window is bound as parameters, never inlined', async () => {
  const fake = countsPool(SENT_ROW, WAIT_ROW);
  const now = IST('2026-09-23T14:00:00');
  await bq.counts({ db: fake.pool, period: 'yesterday', now });
  const q = fake.calls.find((c) => /magic_link_sent_at >= \?/.test(c.sql));
  assert.ok(q, 'the links pass ran');
  assert.ok(q.params[0] instanceof Date && q.params[1] instanceof Date, 'bound as Dates for the +05:30 pool');
  assert.equal(q.params[0].toISOString(), IST('2026-09-22T00:00:00').toISOString());
});

test('the tile list the FE renders is the one the buckets are defined by', () => {
  assert.deepEqual(
    [...bq.BUCKET_META.map((m) => m.key)].sort(),
    [...bq.BUCKETS].sort(),
    'a tile with no predicate (or a predicate with no tile) is a silently missing bucket',
  );
});
