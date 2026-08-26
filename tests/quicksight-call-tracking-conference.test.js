/*
 * Unit tests — Call Tracking, the CONFERENCE tiles.
 *
 * Four new figures ride on `totals`: partiesReached, conferenceCalls,
 * conferenceBilledSecs, conferenceBilledCalls. They count PEOPLE and ROOMS,
 * beside numbers that count CALLS, which is exactly why they are dangerous —
 * every one of them is a plausible-looking way to inflate a report that ops
 * trusts. What these tests guard, worst-first:
 *
 *   1. THE ACCEPTANCE PROPERTY. calls / connected / totalDurationSecs are
 *      IDENTICAL with and without conference legs in the fixture, and no core
 *      query so much as NAMES tbl_plivo_call_log or tbl_job_conference. This is
 *      the whole reason the new metrics are separate aggregates: join the leg
 *      table into buildScope and one 3-party call becomes three, inflating every
 *      count on the page by numbers that stay plausible while being wrong — and
 *      an INNER join would additionally drop Kaleyra, which has no row in that
 *      table at all.
 *   2. THE INVARIANT. partiesReached >= connected, always. It is what makes the
 *      tile readable beside Connected: equal until a call gains someone. The
 *      fallback (a call with NO legs contributes 1 when it connected) is what
 *      holds it up for Kaleyra and for pre-conference Plivo history, and it
 *      survives only because the leg aggregate is LEFT JOINed.
 *   3. REACHED MEANS REACHED. A leg that rang out or was declined is someone we
 *      tried to reach, not someone who was on the call. Count it and the tile
 *      silently becomes "parties dialled".
 *   4. COVERAGE, HONESTLY. billed_leg_seconds is NULL until the MPCEnd webhook
 *      lands, so the SUM is a floor. It ships with a count of the rooms that
 *      actually contributed one; 2 rooms with 1 billed must read 1, not 2.
 *   5. FAIL-SOFT. A pre-migration environment has neither the conference columns
 *      nor tbl_job_conference. The report still renders, with the new fields at
 *      0 — a report must not 500 over a metric that did not exist last month.
 *
 * No DB: the shared pool singleton is faked BEFORE the service loads. The two
 * conference aggregates are answered by evaluating the SAME fixture the totals
 * query is answered from — one call list, one leg list — so "did the leg fixture
 * move a call count?" is a question the harness can actually be wrong about, and
 * the assertions below pin the hand-computed numbers either way.
 *
 * Runner: `node --test`.
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { installFakePool } = require('./helpers/fake-pool');

/* ───────────────────────── the fixture world ───────────────────────────── */

const S = {
  calls: [],        // tbl_job_caller_info rows in scope
  legs: [],         // tbl_plivo_call_log CONFERENCE legs (conference_id set)
  conferences: [],  // tbl_job_conference rows keyed to those calls
  billingFails: false,
};

/** One scoped call. `duration` > 0 is what CONNECTED means in this report. */
function call(id, duration, over = {}) {
  return { id, duration, ...over };
}

/** One conference leg. Legs are keyed to their call by job_caller_info_id. */
function leg(callId, role, status, over = {}) {
  return {
    job_caller_info_id: callId,
    conference_id: 900 + callId,
    participant_role: role,
    status,
    ...over,
  };
}

/*
 * Answer the TOTALS query from the call list — calls only, never legs. If the
 * service ever grew a leg join in buildScope this evaluator would not follow it,
 * which is the point: the acceptance test below asserts the SQL text too, so a
 * join could not hide behind a harness that ignores it.
 */
function evalTotals() {
  const connected = S.calls.filter((c) => (c.duration || 0) > 0);
  return [{
    calls: S.calls.length,
    connected: connected.length,
    total_duration_secs: S.calls.reduce((a, c) => a + (c.duration || 0), 0),
    avg_duration_secs: connected.length
      ? Math.round(connected.reduce((a, c) => a + c.duration, 0) / connected.length)
      : null,
    unique_jobs: S.calls.length,
    unique_callers: 1,
  }];
}

/*
 * Answer the PARTIES aggregate the way the SQL does: legs collapsed per call,
 * LEFT JOINed to the scoped calls, and a call with no legs falling back to its
 * own connected-ness. SUM over zero rows is NULL in SQL, so that is modelled too
 * — the service must turn it into 0, not NaN.
 */
/*
 * The PRE-MIGRATION fallback, which knows nothing about legs: every connected
 * call reached exactly one party. Modelled separately from evalParties() so the
 * degrade path is answered by data that could actually exist in a world with no
 * conference tables — answering it from the leg fixture would make a broken
 * fallback indistinguishable from a working one.
 */
function evalPartiesFallback() {
  return [{ parties_reached: S.calls.filter((c) => (c.duration || 0) > 0).length }];
}

function evalParties() {
  if (!S.calls.length) return [{ parties_reached: null, conference_calls: 0 }];
  let parties = 0;
  let conferences = 0;
  for (const c of S.calls) {
    const legs = S.legs.filter((l) => l.job_caller_info_id === c.id && l.conference_id != null);
    if (!legs.length) {
      parties += (c.duration || 0) > 0 ? 1 : 0;   // the Kaleyra / legacy fallback
      continue;
    }
    const reached = legs.filter(
      (l) => l.participant_role !== 'operator' && ['answered', 'completed'].includes(l.status),
    ).length;
    parties += reached;
    if (reached > 1) conferences += 1;            // MULTI-party only
  }
  return [{ parties_reached: parties, conference_calls: conferences }];
}

/** Answer the BILLING aggregate: sum of the reported figures, plus how many. */
function evalBilling() {
  if (S.billingFails) throw new Error("Table 'easyfix_core.tbl_job_conference' doesn't exist");
  const billed = S.conferences.filter((c) => c.billed_leg_seconds != null);
  return [{
    billed_secs: billed.reduce((a, c) => a + c.billed_leg_seconds, 0),
    billed_calls: billed.length,
  }];
}

/*
 * Route order matters — the fake takes the FIRST match. Each new aggregate is
 * keyed on a column only IT projects, and the totals query on `unique_callers`,
 * so no statement can be handed another's fixture.
 */
const fake = installFakePool([
  [/information_schema\.columns/i, () => [{ 1: 1 }]],   // hasConferenceColumns()
  /*
   * ORDER MATTERS, and the two arms are genuinely different statements.
   *
   * The full aggregate also projects `conference_calls`; the pre-migration
   * fallback cannot, because it has no legs to judge multi-party-ness from. Both
   * select `AS parties_reached`, so a single matcher answers the fallback with
   * leg-derived numbers — precisely the fiction that would let a broken degrade
   * path look correct. The narrower pattern goes first.
   *
   * Keyed on that projected column and NOT on "LEFT JOIN": buildScope's own FROM
   * already contains one, so a join-based discriminator matches both statements
   * and quietly reintroduces the bug this split exists to expose.
   */
  [/AS conference_calls/i, () => evalParties()],
  [/AS parties_reached/i, () => evalPartiesFallback()],
  [/tbl_job_conference/i, () => evalBilling()],
  [/AS unique_callers/i, () => evalTotals()],
]);
after(() => fake.restore());

const service = require('../services/quicksight/quicksight-call-tracking.service');
const plivoLog = require('../services/plivo-call-log.service');

/*
 * hasConferenceColumns() caches its answer for the life of the process (it is a
 * schema probe), so the pre-migration case cannot be simulated by changing what
 * the fake pool returns. The service reads it as a PROPERTY at call time, so
 * swapping the function is the honest seam — same one the conference call-history
 * tests use.
 */
async function withoutConferenceColumns(fn) {
  const real = plivoLog.hasConferenceColumns;
  plivoLog.hasConferenceColumns = async () => false;
  try { return await fn(); } finally { plivoLog.hasConferenceColumns = real; }
}

const WINDOW = { dateFrom: '2026-08-01', dateTo: '2026-08-10' };

const flat = (s) => String(s).replace(/\s+/g, ' ').trim();
const sqlWith = (re) => flat((fake.calls.find((c) => re.test(c.sql)) || {}).sql || '');
const sqlsWith = (re) => fake.calls.filter((c) => re.test(c.sql));

/*
 * THE MIXED FIXTURE — one of every kind of call this report has to survive.
 *
 *   1001  Kaleyra, connected, NO legs at all      → 1 party  (the fallback)
 *   1002  Plivo 1:1 (an MPC with one participant) → 1 party  (== connected)
 *   1003  Plivo 3-party conference                → 2 parties (a conference)
 *   1004  Plivo, rang out: nobody joined          → 0 parties (and 0 connected)
 *
 * Hand-computed: calls 4 · connected 3 · talk 675s · partiesReached 4 ·
 * conferenceCalls 1.
 */
function mixedFixture() {
  S.calls = [
    call(1001, 180, { provider: 'kaleyra' }),
    call(1002, 95),
    call(1003, 400),
    call(1004, 0),
  ];
  S.legs = [
    leg(1002, 'operator', 'answered'),
    leg(1002, 'customer', 'answered'),

    leg(1003, 'operator', 'answered'),
    leg(1003, 'customer', 'answered'),
    leg(1003, 'technician', 'completed'),

    leg(1004, 'operator', 'answered'),
    leg(1004, 'customer', 'no_answer'),
  ];
}

beforeEach(() => {
  fake.reset();
  S.calls = [];
  S.legs = [];
  S.conferences = [];
  S.billingFails = false;
});

/* ═══════════ 1. PARTIES REACHED — the invariant and the number ═══════════ */

test('partiesReached counts PEOPLE across a mixed fixture, and never falls below connected', async () => {
  mixedFixture();

  const { totals } = await service.getCallTracking(WINDOW);

  assert.equal(totals.calls, 4);
  assert.equal(totals.connected, 3);
  // 1 (Kaleyra fallback) + 1 (1:1) + 2 (3-party) + 0 (rang out).
  assert.equal(totals.partiesReached, 4);
  // THE INVARIANT. A 1:1 call equals connected; only a conference exceeds it.
  assert.ok(
    totals.partiesReached >= totals.connected,
    `partiesReached (${totals.partiesReached}) must never be below connected (${totals.connected})`,
  );
  // The 3-party call, and only it. A 1:1 call is technically an MPC and is
  // deliberately NOT a conference for reporting purposes.
  assert.equal(totals.conferenceCalls, 1);
});

test('the fallback holds the invariant up for a provider with no legs at all', async () => {
  // Kaleyra writes nothing to tbl_plivo_call_log. Under an INNER join every one
  // of these calls would contribute nothing and the tile would read 0 beside 2
  // connected calls — a whole provider missing from a report about calls.
  S.calls = [call(2001, 240), call(2002, 60), call(2003, 0)];
  S.legs = [];

  const { totals } = await service.getCallTracking(WINDOW);

  assert.equal(totals.connected, 2);
  assert.equal(totals.partiesReached, 2, 'a legless connected call is one party reached');
  assert.ok(totals.partiesReached >= totals.connected);
  assert.equal(totals.conferenceCalls, 0);

  // …and the join direction that makes it true, in the statement itself.
  const sql = sqlWith(/AS parties_reached/i);
  assert.match(sql, /LEFT JOIN \( SELECT job_caller_info_id AS call_id/i,
    'an INNER join here would drop every Kaleyra call from the tile');
  // The fallback arm, in two pieces because the statement carries an explanatory
  // `--` comment between them (harmless in MySQL, where it ends at the newline;
  // it only shows up here because flat() collapses the statement to one line).
  assert.match(sql, /SUM\(CASE WHEN lg\.call_id IS NULL/i);
  assert.match(sql, /THEN CASE WHEN COALESCE\(jci\.duration, 0\) > 0 THEN 1 ELSE 0 END ELSE lg\.reached END\) AS parties_reached/i);
});

test('a leg that never joined the room is NOT a party reached', async () => {
  // The operator and the customer are on the call; the technician's leg rang
  // and was never answered. Two people were dialled, ONE was reached.
  S.calls = [call(3001, 300)];
  S.legs = [
    leg(3001, 'operator', 'answered'),
    leg(3001, 'customer', 'answered'),
    leg(3001, 'technician', 'ringing'),
  ];

  const { totals } = await service.getCallTracking(WINDOW);

  assert.equal(totals.partiesReached, 1, 'reaching someone means they were on the call');
  assert.notEqual(totals.partiesReached, 2, 'that would be "parties dialled", a different tile');
  // …and with only one party reached it is not a multi-party call either.
  assert.equal(totals.conferenceCalls, 0);

  const sql = sqlWith(/AS parties_reached/i);
  assert.match(sql, /participant_role <> 'operator' AND status IN \('answered', 'completed'\)/i);
});

test('the operator is never counted — our own side of the call is not a party reached', async () => {
  // A conference the operator entered and nobody else joined: the room existed,
  // nobody was reached. Counting the operator leg would add one to EVERY call.
  S.calls = [call(3101, 0)];
  S.legs = [leg(3101, 'operator', 'answered')];

  const { totals } = await service.getCallTracking(WINDOW);
  assert.equal(totals.partiesReached, 0);
  assert.equal(totals.conferenceCalls, 0);
});

test('a pre-conference Plivo row cannot score a connected call as nobody reached', async () => {
  // Rows written before conferencing shipped have NO conference_id and NO role.
  // They must be invisible to the leg aggregate so the call takes the fallback;
  // letting them through would give legs=1, reached=0 — a connected call
  // reported as reaching nobody.
  S.calls = [call(3201, 150)];
  S.legs = [{ job_caller_info_id: 3201, conference_id: null, participant_role: null, status: 'answered' }];

  const { totals } = await service.getCallTracking(WINDOW);
  assert.equal(totals.partiesReached, 1);
  assert.ok(totals.partiesReached >= totals.connected);

  assert.match(sqlWith(/AS parties_reached/i), /WHERE conference_id IS NOT NULL/i);
});

test('the parties aggregate is scoped by exactly the same filters as the totals it sits beside', async () => {
  mixedFixture();
  await service.getCallTracking({
    ...WINDOW, clientId: [11, 12], provider: 'plivo', partyRole: 'Customer', callerId: [7],
  });

  const totalsQ = fake.calls.find((c) => /AS unique_callers/i.test(c.sql));
  const partiesQ = fake.calls.find((c) => /AS parties_reached/i.test(c.sql));
  const billingQ = fake.calls.find((c) => /tbl_job_conference/i.test(c.sql));
  assert.ok(totalsQ && partiesQ && billingQ);

  // Same window, same client / caller / party filters, same order — a tile
  // scoped differently from the tile next to it is how a KPI band starts lying.
  assert.deepEqual(partiesQ.params, totalsQ.params);
  assert.deepEqual(billingQ.params, totalsQ.params);
  // The provider clause carries no placeholder, so prove it reached all three.
  for (const q of [totalsQ, partiesQ, billingQ]) {
    assert.match(flat(q.sql), /jci\.provider = 'plivo'/);
  }
});

/* ═══════════ 2. CONFERENCE COST — the sum, and its coverage ═══════════ */

test('conferenceBilledSecs ships with honest coverage: 2 rooms, 1 billed, reads 1', async () => {
  S.calls = [call(4001, 300), call(4002, 200)];
  S.conferences = [
    { job_caller_info_id: 4001, billed_leg_seconds: 240 },
    // MPCEnd has not arrived (or was lost): NULL, not zero.
    { job_caller_info_id: 4002, billed_leg_seconds: null },
  ];

  const { totals } = await service.getCallTracking(WINDOW);

  assert.equal(totals.conferenceBilledSecs, 240);
  assert.equal(totals.conferenceBilledCalls, 1,
    'the coverage count must report the rooms that CONTRIBUTED, not the rooms that exist');
  assert.notEqual(totals.conferenceBilledCalls, 2);

  // COUNT(col) skips NULLs — that IS the coverage figure, and it must be taken
  // over the same set as the SUM beside it.
  const sql = sqlWith(/tbl_job_conference/i);
  assert.match(sql, /COALESCE\(SUM\(conf\.billed_leg_seconds\), 0\) AS billed_secs/i);
  assert.match(sql, /COUNT\(conf\.billed_leg_seconds\) AS billed_calls/i);
  // Rooms are selected, calls are not counted — no leg table anywhere near it.
  assert.doesNotMatch(sql, /tbl_plivo_call_log/i);
});

test('no rooms in scope reads as a zero sum with zero coverage, never null', async () => {
  S.calls = [call(4101, 120)];
  S.conferences = [];

  const { totals } = await service.getCallTracking(WINDOW);
  assert.equal(totals.conferenceBilledSecs, 0);
  assert.equal(totals.conferenceBilledCalls, 0);
});

/* ═══════════ 3. THE ACCEPTANCE TEST — nothing existing moved ═══════════ */

test('ACCEPTANCE — calls / connected / talk time are IDENTICAL with and without conference legs', async () => {
  /*
   * The same four calls, run twice: once with the legs of a 3-party conference
   * and a 1:1 MPC present, once with the leg table empty. If any of the new
   * material had been joined into buildScope, the first run's counts would be
   * inflated by the extra legs (a 3-party call read as three calls) — the exact
   * failure this whole design exists to prevent, and one that stays plausible
   * on screen while being wrong.
   */
  mixedFixture();
  const withLegs = await service.getCallTracking(WINDOW);

  fake.reset();
  S.legs = [];
  const withoutLegs = await service.getCallTracking(WINDOW);

  for (const k of ['calls', 'connected', 'totalDurationSecs', 'avgDurationSecs', 'uniqueJobs', 'uniqueCallers', 'connectRate']) {
    assert.equal(withLegs.totals[k], withoutLegs.totals[k], `totals.${k} moved when legs appeared`);
  }
  assert.equal(withLegs.totals.calls, 4);
  assert.equal(withLegs.totals.connected, 3);
  assert.equal(withLegs.totals.totalDurationSecs, 675);

  // The legs DID change the thing they are allowed to change, so the run above
  // is not vacuous: without them every call falls back to its own connectedness.
  assert.equal(withLegs.totals.partiesReached, 4);
  assert.equal(withoutLegs.totals.partiesReached, 3);
  assert.equal(withLegs.totals.conferenceCalls, 1);
  assert.equal(withoutLegs.totals.conferenceCalls, 0);
});

test('ACCEPTANCE — no core query so much as NAMES the leg or room tables', async () => {
  mixedFixture();
  await service.getCallTracking(WINDOW);

  /*
   * The structural half of the acceptance property, and the one that survives a
   * harness bug: buildScope must stay tbl_job_caller_info-only. A join added to
   * it would show up here even if the fixtures happened to agree.
   */
  const core = [
    [/AS unique_callers/i, 'totals'],
    [/MAX\(c\.client_name\)/i, 'byJob'],
    [/AS active_days/i, 'byUserCombined'],
    [/AS day, COUNT\(\*\) AS calls/i, 'byDay'],
    [/AS direction/i, 'byOther'],
  ];
  for (const [re, name] of core) {
    for (const q of sqlsWith(re)) {
      assert.doesNotMatch(q.sql, /tbl_plivo_call_log/i, `${name} must not join the leg table`);
      assert.doesNotMatch(q.sql, /tbl_job_conference/i, `${name} must not join the room table`);
    }
  }

  // Exactly ONE extra query per new metric — the tiles are not worth an N+1.
  assert.equal(sqlsWith(/AS parties_reached/i).length, 1);
  assert.equal(sqlsWith(/tbl_job_conference/i).length, 1);
});

test('the conference figures are TILES ONLY — no per-row copies appeared', async () => {
  mixedFixture();
  const { byJob, byUser, byUserCombined, byDay, byOther } = await service.getCallTracking(WINDOW);

  // Deliberate omission (see the service header): a per-row version of a
  // window-level figure multiplies the ways two numbers on one screen disagree.
  const NEW_KEYS = ['partiesReached', 'conferenceCalls', 'conferenceBilledSecs', 'conferenceBilledCalls'];
  for (const rows of [byJob, byUser, byUserCombined, byDay, byOther]) {
    for (const row of rows) {
      for (const k of NEW_KEYS) {
        assert.equal(Object.hasOwn(row, k), false, `${k} must not appear at row grain`);
      }
    }
  }
});

/* ═══════════ 4. FAIL-SOFT — the report renders regardless ═══════════ */

test('a pre-migration environment degrades Parties Reached to CONNECTED, never to zero', async () => {
  /*
   * No conference columns on tbl_plivo_call_log, and no tbl_job_conference at
   * all. Both loaders must degrade without taking the report down — but they
   * degrade to DIFFERENT things, and that difference is the point of this test.
   *
   * Billing genuinely cannot be answered without the room table, so it is 0.
   * Parties Reached CAN be: the "no legs → one party if it connected" branch
   * needs no conference table whatsoever, and it is exactly right for a
   * pre-conference world. Zeroing it would print "Parties Reached 0" beside
   * "Connected 3" — two tiles on one screen contradicting each other, which
   * reads as a broken metric rather than an absent feature and costs the whole
   * page its credibility.
   */
  mixedFixture();
  S.billingFails = true;

  const data = await withoutConferenceColumns(() => service.getCallTracking(WINDOW));

  assert.equal(data.totals.partiesReached, data.totals.connected,
    'with no leg data, every connected call is one party reached — the invariant still holds');
  assert.equal(data.totals.partiesReached, 3);
  assert.equal(data.totals.conferenceCalls, 0, 'no legs means no call can be shown to have gained anyone');
  assert.equal(data.totals.conferenceBilledSecs, 0, 'billing has no fallback — the rooms table IS the source');
  assert.equal(data.totals.conferenceBilledCalls, 0);
  assert.equal(data.totals.conferenceRooms, 0);

  // Everything the report could always answer, it still answers.
  assert.equal(data.totals.calls, 4);
  assert.equal(data.totals.connected, 3);
  assert.ok(Array.isArray(data.byDay) && data.byDay.length > 0);

  // The probe short-circuits: the LEG query, guaranteed to fail, is never issued.
  assert.equal(sqlsWith(/AS conference_calls/i).length, 0);
});

test('each new query fails soft on its OWN — a missing room table does not zero the parties tile', async () => {
  mixedFixture();
  S.billingFails = true;

  const { totals } = await service.getCallTracking(WINDOW);

  assert.equal(totals.partiesReached, 4, 'the two metrics are independent queries and degrade independently');
  assert.equal(totals.conferenceCalls, 1);
  assert.equal(totals.conferenceBilledSecs, 0);
  assert.equal(totals.conferenceBilledCalls, 0);
});

test('all four fields are always NUMBERS — the em-dash convention belongs to averages, not counts', async () => {
  // Nothing in scope at all: SQL returns NULL for the SUM, and the report must
  // still emit 0. null renders as '—' ("we cannot divide"), which is a claim
  // about an average, not about a count.
  S.calls = [];
  S.conferences = [];

  const { totals } = await service.getCallTracking(WINDOW);
  for (const k of ['partiesReached', 'conferenceCalls', 'conferenceBilledSecs', 'conferenceBilledCalls']) {
    assert.equal(typeof totals[k], 'number', `${k} must never be null`);
    assert.ok(!Number.isNaN(totals[k]));
    assert.equal(totals[k], 0);
  }
  // …while the average that genuinely cannot be computed stays null.
  assert.equal(totals.avgDurationSecs, null);
});
