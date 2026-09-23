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
 * 4. THE FIVE TILES SUM TO THE TOTAL, always. That identity is the whole reason
 *    the counts are ONE query: it cannot hold if five numbers come from five
 *    passes over a table that is moving underneath them.
 *
 * 5. THE DATE TABS FILTER THE TICKET'S CREATION DATE, on the same column the
 *    grid below filters, and All (the default) narrows nothing.
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

/* ── 1b. What the customer answered ──────────────────────────────────────── */

/*
 * "Response received" is not one thing. "Book me an SKU", "move my date" and
 * "cancel it" need different work from different people, so the tile splits
 * three ways — and the split must SUM to the tile, or a customer's answer has
 * gone missing between the number and the rows.
 *
 * `ready` is deliberately the REMAINDER rather than a third positive test: an
 * order that answered can then never match none of the three.
 */
function kindHolds(kind, job) {
  const sql = bq.responseKindSql(kind);
  // The pending-request subquery resolves to 'cancel', 'reschedule', or NULL
  // when the customer asked for nothing. SQL comparisons against NULL are NULL,
  // which is why the predicates COALESCE — reproduce that here.
  const pending = job.pending ?? null;
  const js = sql
    .replace(/COALESCE\(\(SELECT[\s\S]*?'cancel'\), FALSE\)/g, String(pending === 'cancel'))
    .replace(/COALESCE\(\(SELECT[\s\S]*?'reschedule'\), FALSE\)/g, String(pending === 'reschedule'))
    .replace(/\(SELECT[\s\S]*?LIMIT 1\) = 'cancel'/g, pending === null ? 'null' : String(pending === 'cancel'))
    .replace(/\(SELECT[\s\S]*?LIMIT 1\) = 'reschedule'/g, pending === null ? 'null' : String(pending === 'reschedule'))
    .replace(/ IS NULL/g, ' === null')
    .replace(/\bNOT\b/g, '!')
    .replace(/\bAND\b/g, '&&')
    .replace(/\bOR\b/g, '||')
    .replace(/COALESCE\(([^,]+), FALSE\) = FALSE/g, '!($1)')
    .replace(/1=1/g, 'true').replace(/1=0/g, 'false');
  // eslint-disable-next-line no-new-func
  return !!Function(`"use strict"; return (${js});`)();
}

test('an answer is exactly one of ready / reschedule / cancel', () => {
  for (const pending of [null, 'cancel', 'reschedule']) {
    const hit = bq.RESPONSE_KINDS.filter((k) => kindHolds(k, { pending }));
    assert.equal(hit.length, 1, `pending=${pending} matched ${hit.join(', ') || 'nothing'}`);
  }
  assert.ok(kindHolds('ready', { pending: null }), 'no live ask → attach an SKU and book');
  assert.ok(kindHolds('cancel', { pending: 'cancel' }));
  assert.ok(kindHolds('reschedule', { pending: 'reschedule' }));
});

test('each pill is also a grid filter, over the same jobs the tile counts', () => {
  for (const k of bq.RESPONSE_KINDS) {
    const sub = bq.bucketPredicate(`response_${k}`);
    const tile = bq.bucketPredicate('response_received');
    assert.ok(sub, `response_${k} must be a usable filter`);
    assert.ok(sub.startsWith(tile), 'a pill narrows the tile — it never selects from somewhere else');
  }
  assert.equal(bq.bucketPredicate('response_nonsense'), null, 'an unknown kind is never "unfiltered"');
});

test('without the request table every answer counts as ready, never as lost', () => {
  const sub = bq.bucketPredicate('response_ready', { hasRequestTable: false });
  assert.match(sub, /1=1/, 'all answers fall to ready');
  for (const k of ['reschedule', 'cancel']) {
    assert.match(bq.bucketPredicate(`response_${k}`, { hasRequestTable: false }), /1=0/,
      'nobody can have asked for anything, so these are empty rather than wrong');
  }
});

/* ── 1c. How old the ticket is: the Day 0 / 1 / 2 / 3+ pills ─────────────── */

/*
 * THE LAST PILL IS 3-OR-MORE, and that is the whole point of these tests.
 *
 * The design sketch showed "Day 3". On the real book the oldest open
 * unconfirmed order was raised in APRIL — five months out. A plain `= 3` would
 * put every one of those in no pill at all: the pills would stop summing to the
 * tile above them, and the orders that have waited longest, which is precisely
 * what the pills exist to surface, would be the invisible ones.
 */
function ageHolds(day, ageDays) {
  const sql = bq.dayPredicate(day);
  const js = sql
    .replace(/DATEDIFF\('\d{4}-\d{2}-\d{2}', DATE\(j\.ticket_created_date_time\)\)/g,
      ageDays === null ? 'null' : String(ageDays))
    .replace(/ IS NULL/g, ' === null')
    .replace(/\bOR\b/g, '||')
    .replace(/(\d+|null) >= 3/g, (m, v) => String(v !== 'null' && Number(v) >= 3))
    .replace(/(\d+|null) = (\d+)/g, (m, a, b) => String(a !== 'null' && Number(a) === Number(b)));
  // eslint-disable-next-line no-new-func
  return !!Function(`"use strict"; return (${js});`)();
}

test('every age lands in exactly one pill, and old orders land in 3+', () => {
  for (const age of [0, 1, 2, 3, 4, 17, 150, null]) {
    const hit = bq.DAY_BUCKETS.filter((d) => ageHolds(d, age));
    assert.equal(hit.length, 1, `age ${age} matched ${hit.join(', ') || 'nothing'}`);
  }
  assert.ok(ageHolds('0', 0), 'raised today');
  assert.ok(ageHolds('1', 1), 'yesterday');
  assert.ok(ageHolds('2', 2));
  assert.ok(ageHolds('3plus', 3), 'exactly three days is 3+, not a gap');
  assert.ok(ageHolds('3plus', 150), 'April on a September book still has a pill');
  assert.ok(ageHolds('3plus', null),
    'a NULL ticket date would otherwise fall out of every pill and stop the sum');
});

test('a pill narrows its own tile — never selects from somewhere else', () => {
  for (const b of bq.BUCKETS) {
    const plain = bq.bucketPredicate(b);
    for (const d of bq.DAY_BUCKETS) {
      const withDay = bq.bucketPredicate(b, { day: d });
      assert.ok(withDay.startsWith(plain), `${b} + Day ${d} must be the tile AND the age`);
      assert.match(withDay, /DATEDIFF\('\d{4}-\d{2}-\d{2}'/,
        "today's IST date is computed in JS and inlined — CURDATE() would resolve in MySQL's UTC session and be a day out all night");
    }
  }
});

test('a malformed date is refused rather than concatenated into SQL', () => {
  assert.throws(() => bq.ageDaysSql('j', "2026-09-23'; DROP TABLE tbl_job; --"), /bad IST date/,
    'the value is not input today, and the guard is what keeps it that way tomorrow');
  assert.throws(() => bq.ageDaysSql('j', '23-09-2026'), /bad IST date/);
});

test('an unknown pill is empty, never unfiltered', () => {
  assert.equal(bq.dayPredicate('7'), null);
  assert.equal(bq.bucketPredicate('no_response', { day: 'yesterday' }), null,
    'a filter the page cannot express must not quietly widen to the whole bucket');
});

test('each tile\'s four pills sum to the tile', async () => {
  const row = { ...QA_ROW };
  // No response: 134 = 1 + 2 + 3 + 128
  Object.assign(row, {
    d_no_response_0: 1, d_no_response_1: 2, d_no_response_2: 3, d_no_response_3plus: 128,
    d_new_0: 0, d_new_1: 0, d_new_2: 0, d_new_3plus: 12,
  });
  const out = await bq.counts({ db: countsPool(row).pool });
  const d = out.days.no_response;
  assert.equal(d[0] + d[1] + d[2] + d['3plus'], out.open.no_response,
    'an order past day 3 falling out of every pill is the failure this catches');
  const n = out.days.new;
  assert.equal(n[0] + n[1] + n[2] + n['3plus'], out.open.new);
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

test('all, and anything unrecognised, means NO window', () => {
  const now = IST('2026-09-23T14:00:00');
  assert.deepEqual(bq.periodRange('all', now), { start: null, end: null });
  assert.deepEqual(bq.periodRange('garbage', now), { start: null, end: null },
    'an unknown tab shows the whole desk — never an empty screen that looks like "nothing to do"');
});

test('istToday reads the IST date even when UTC is still on yesterday', () => {
  assert.equal(bq.istToday(IST('2026-09-23T01:00:00')), '2026-09-23');
});

/* ── 3. counts(): the shape the tiles render ─────────────────────────────── */

function countsPool(row) {
  return makeFakePool([[/FROM tbl_job j/, [row]]]);
}
/* The QA book on 2026-09-23, which is what the numbers below are measured from. */
const QA_ROW = {
  total: 149, b_new: 12, b_no_link: 0, b_responded: 3, b_failed: 0, b_no_response: 134,
  r_ready: 0, r_reschedule: 2, r_cancel: 1,
  new_today: 0, new_old: 12, no_link_today: 0, no_link_old: 0, links_sent: 137,
};

test('every open order is in exactly one tile — the five sum to the total', async () => {
  const out = await bq.counts({ db: countsPool(QA_ROW).pool });
  const o = out.open;
  const sum = o.new + o.no_link_needed + o.response_received + o.no_response + o.delivery_failed;
  assert.equal(sum, out.total, 'a bucket quietly claiming nobody is the failure this catches');
  assert.equal(sum, 149, 'measured on QA');
});

test('the answer split sums to the Response-received tile', async () => {
  const out = await bq.counts({ db: countsPool(QA_ROW).pool });
  const b = out.response_breakdown;
  assert.deepEqual(b, { ready: 0, reschedule: 2, cancel: 1 }, 'measured on QA');
  assert.equal(b.ready + b.reschedule + b.cancel, out.open.response_received);
});

test('an empty book reads as zeros, never NULL or NaN', async () => {
  const out = await bq.counts({ db: countsPool({ total: 0 }).pool });
  assert.equal(out.total, 0);
  for (const v of Object.values(out.open)) assert.equal(v, 0);
  for (const v of Object.values(out.response_breakdown)) assert.equal(Number.isFinite(v), true);
  assert.equal(out.links_sent, 0);
});

/*
 * THE DATE TABS FILTER THE TICKET'S CREATION DATE (ops, 2026-09-23), and the
 * grid below sends the list's dateType=ticket over the SAME window. So the
 * count must read `ticket_created_date_time` and nothing else: COALESCE'ing it
 * onto created_date_time — which an earlier cut did — would count rows the grid
 * then refuses to list, and the tile would disagree with its own rows.
 */
test('the window is the ticket date, bounded the way the list bounds it', async () => {
  const fake = countsPool(QA_ROW);
  const now = IST('2026-09-23T14:00:00');
  await bq.counts({ db: fake.pool, period: 'yesterday', now });
  const q = fake.calls[0];
  assert.match(q.sql, /DATE\(j\.ticket_created_date_time\) >= DATE\(\?\)/);
  assert.match(q.sql, /DATE\(j\.ticket_created_date_time\) < DATE\(\?\)/);
  assert.doesNotMatch(q.sql, /COALESCE\(j\.ticket_created_date_time/,
    'the grid filters on this column alone — counting a fallback would list fewer rows than the tile claims');
  // Bound as Dates for the +05:30 pool, and they are yesterday's IST bounds.
  const dates = q.params.filter((p) => p instanceof Date);
  assert.equal(dates.length, 2);
  assert.equal(dates[0].toISOString(), IST('2026-09-22T00:00:00').toISOString());
  assert.equal(dates[1].toISOString(), IST('2026-09-23T00:00:00').toISOString());
});

test('ALL is the default and applies NO date filter', async () => {
  const fake = countsPool(QA_ROW);
  const out = await bq.counts({ db: fake.pool });
  assert.equal(out.period, 'all', 'the page opens on the whole desk, not on today');
  assert.doesNotMatch(fake.calls[0].sql, /ticket_created_date_time\) >=/,
    'All must not narrow anything — 149 open orders would otherwise read as 0');
  assert.equal(out.period_start, null);
});

test('the caller\'s row filter and owner scope reach the count', async () => {
  const fake = countsPool(QA_ROW);
  await bq.counts({
    db: fake.pool, ownerId: 77,
    scopeSql: 'j.fk_client_id IN (?)', scopeParams: [42],
    scopeJoins: 'LEFT JOIN tbl_address ad ON ad.address_id = j.fk_address_id',
  });
  const q = fake.calls[0];
  assert.equal(fake.calls.length, 1, 'one pass, not one per tile');
  assert.match(q.sql, /fk_client_id IN \(\?\)/, 'RBAC filter applied');
  assert.match(q.sql, /LEFT JOIN tbl_address ad/, 'and the join it needs');
  assert.match(q.sql, /j\.job_owner = \?/, 'My Orders is owner-scoped outside the admin group');
  assert.ok(q.params.includes(42) && q.params.includes(77));
});

test('the tile list the FE renders is the one the buckets are defined by', () => {
  assert.deepEqual(
    [...bq.BUCKET_META.map((m) => m.key)].sort(),
    [...bq.BUCKETS].sort(),
    'a tile with no predicate (or a predicate with no tile) is a silently missing bucket',
  );
});
