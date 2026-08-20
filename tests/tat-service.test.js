/*
 * Characterization tests for services/tat.service.js.
 *
 * These are a line-by-line check against EasyFix_TAT_Final_August2026.xlsx,
 * "Developer Specification v1.0" (sheet: Developer Instructions). Each block
 * names the spec STEP it pins, so the code, the tests and the document can be
 * diffed against one another.
 *
 * Exercises the PURE core (computeForRow / summarise / buildRollups) with rows
 * shaped exactly like the service's own SQL projection — no DB is touched.
 *
 * What matters most, in order of how badly a regression would hurt:
 *   1. OWNERSHIP. Seg3 is the CLIENT's clock and must never enter the EasyFix
 *      score. Folding it in is the one bug that would make this engine lie in
 *      EasyFix's disfavour, which is the entire reason the spec splits them.
 *   2. `Pending` and `N/A` are never passes and never enter a denominator.
 *   3. The Tier → Local/Travel rule, which sets the Seg1 target.
 *
 * Runner: `node --test tests/tat-service.test.js`  ·  `npm run test:tat`
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const tat = require('../services/tat.service');

const H = 3600000;
const T0 = Date.parse('2026-08-01T09:00:00Z');

/* A completed job with every anchor present and every clock comfortably inside
 * its target, so any breach in a test is the thing that test is about.
 * Defaults to NO estimate — the simplest path. */
function row(over = {}) {
  return {
    job_id: 101,
    job_reference_id: 'EF-101',
    job_status: 3,
    is_local_pincode: 1,                            // Local (a tech covers this pincode)
    ticket_created_date_time: new Date(T0),
    checkin_date_time: new Date(T0 + 2 * H),        // Seg1 = 2h
    app_checkout_date_time: new Date(T0 + 6 * H),
    checkout_date_time: new Date(T0 + 6 * H),       // Seg4 = 4h from check-in
    approval_sent_on_date_time: null,
    no_of_req_approval: 0,
    approved_on_date_time: null,
    approval_reject_date_time: null,
    client_name: 'Acme',
    city_name: 'Delhi',
    category_name: 'Electrician Services',
    efr_name: 'Ramesh',
    project_manager: 'Bhawana',
    vertical_name: 'Retail',
    ...over,
  };
}

const seg = (r, n) => r.segments[n - 1];
const { YES, NO, NA, PENDING } = tat.STATUS;

// ─── STEP 1 · Job type from pincode coverage ─────────────────────────

test('STEP 1 · covered pincode is Local; uncovered is Travel', () => {
  assert.equal(tat.resolveJobType({ is_local_pincode: 1 }), 'Local');
  assert.equal(tat.resolveJobType({ is_local_pincode: 0 }), 'Travel');
});

test('STEP 1 · a job with no resolvable pincode is TRAVEL, the more forgiving target', () => {
  // We cannot show it is covered, and guessing Local would invent a breach out
  // of missing address data.
  for (const r of [{}, { is_local_pincode: null }, { is_local_pincode: undefined }, null]) {
    assert.equal(tat.resolveJobType(r), 'Travel');
  }
});

test('STEP 1 · locality sets the Seg1 target and NOTHING else', () => {
  const local = tat.computeForRow(row({ is_local_pincode: 1 }));
  const travel = tat.computeForRow(row({ is_local_pincode: 0 }));
  assert.equal(seg(local, 1).targetHours, tat.SEG1_TARGET_LOCAL);
  assert.equal(seg(travel, 1).targetHours, tat.SEG1_TARGET_TRAVEL);
  assert.equal(seg(local, 4).targetHours, seg(travel, 4).targetHours, 'Seg4 must not vary by job type');
  assert.equal(seg(local, 2).targetHours, seg(travel, 2).targetHours, 'Seg2 must not vary by job type');
});

test('targets match the spec: 24/48 visit, 24 estimate, 24 approval, 48 completion', () => {
  assert.equal(tat.SEG1_TARGET_LOCAL, 24);
  assert.equal(tat.SEG1_TARGET_TRAVEL, 48);
  assert.equal(tat.SEG2_TARGET, 24);
  assert.equal(tat.SEG3_TARGET, 24);
  assert.equal(tat.SEG4_TARGET, 48);
});

// ─── STEP 2 · Seg1 Visit ─────────────────────────────────────────────

test('STEP 2 · Seg1 runs ticket-created → check-in', () => {
  const r = tat.computeForRow(row({ checkin_date_time: new Date(T0 + 10 * H) }));
  assert.equal(seg(r, 1).hours, 10);
  assert.equal(seg(r, 1).status, YES);
});

test('STEP 2 · a null check-in is Pending, never a pass', () => {
  const r = tat.computeForRow(row({ checkin_date_time: null }));
  assert.equal(seg(r, 1).status, PENDING);
  assert.equal(seg(r, 1).hours, null);
  assert.notEqual(seg(r, 1).status, YES);
});

test('STEP 2 · exactly on target is YES (<=, not <)', () => {
  const r = tat.computeForRow(row({ checkin_date_time: new Date(T0 + 24 * H) }));
  assert.equal(seg(r, 1).status, YES);
});

test('STEP 2 · a Travel job gets 48h, so 30h passes where a Local job fails', () => {
  const late = { checkin_date_time: new Date(T0 + 30 * H), checkout_date_time: new Date(T0 + 32 * H) };
  assert.equal(seg(tat.computeForRow(row({ ...late, is_local_pincode: 1 })), 1).status, NO);
  assert.equal(seg(tat.computeForRow(row({ ...late, is_local_pincode: 0 })), 1).status, YES);
});

// ─── STEP 3 · Seg2 Estimate ──────────────────────────────────────────

test('STEP 3 · no estimate sent → Seg2 is N/A', () => {
  const r = tat.computeForRow(row());
  assert.equal(r.isEstimateSent, false);
  assert.equal(seg(r, 2).status, NA);
});

test('STEP 3 · Seg2 measures from CHECK-IN, not from the ticket', () => {
  // Ticket → estimate is 30h, but check-in → estimate is only 28h. The spec is
  // explicit that the visit is the anchor; using the ticket would breach here.
  const r = tat.computeForRow(row({
    checkin_date_time: new Date(T0 + 2 * H),
    approval_sent_on_date_time: new Date(T0 + 20 * H),
    approved_on_date_time: new Date(T0 + 24 * H),
    checkout_date_time: new Date(T0 + 30 * H),
  }));
  assert.equal(seg(r, 2).hours, 18, 'check-in(2h) → estimate(20h) = 18h');
  assert.equal(seg(r, 2).status, YES);
});

test('STEP 3 · Seg2 breaches past 24h from check-in', () => {
  const r = tat.computeForRow(row({
    checkin_date_time: new Date(T0 + 2 * H),
    approval_sent_on_date_time: new Date(T0 + 30 * H),   // 28h after check-in
    approved_on_date_time: new Date(T0 + 34 * H),
    checkout_date_time: new Date(T0 + 40 * H),
  }));
  assert.equal(seg(r, 2).status, NO);
  assert.equal(seg(r, 2).hours, 28);
  assert.equal(seg(r, 2).overrunHours, 4);
});

test('STEP 3 · an estimate with no check-in to measure from is Pending', () => {
  const r = tat.computeForRow(row({
    checkin_date_time: null,
    approval_sent_on_date_time: new Date(T0 + 20 * H),
  }));
  assert.equal(seg(r, 2).status, PENDING);
});

test('is_estimate_sent is inferred from the approval stamp OR the counter', () => {
  assert.equal(tat.isEstimateSent(row()), false);
  assert.equal(tat.isEstimateSent(row({ approval_sent_on_date_time: new Date(T0) })), true);
  assert.equal(tat.isEstimateSent(row({ no_of_req_approval: 1 })), true);
});

// ─── STEP 4 · Seg3 Approval (CLIENT OWNED) ───────────────────────────

test('STEP 4 · no estimate → Seg3 is N/A', () => {
  assert.equal(seg(tat.computeForRow(row()), 3).status, NA);
});

test('STEP 4 · estimate sent but no client response → Pending', () => {
  const r = tat.computeForRow(row({ approval_sent_on_date_time: new Date(T0 + 5 * H) }));
  assert.equal(seg(r, 3).status, PENDING);
});

test('STEP 4 · approved inside 24h → YES; past 24h → NO', () => {
  const base = { checkin_date_time: new Date(T0 + 2 * H), approval_sent_on_date_time: new Date(T0 + 4 * H) };
  const fast = tat.computeForRow(row({ ...base, approved_on_date_time: new Date(T0 + 20 * H), checkout_date_time: new Date(T0 + 30 * H) }));
  assert.equal(seg(fast, 3).hours, 16);
  assert.equal(seg(fast, 3).status, YES);

  const slow = tat.computeForRow(row({ ...base, approved_on_date_time: new Date(T0 + 40 * H), checkout_date_time: new Date(T0 + 50 * H) }));
  assert.equal(seg(slow, 3).hours, 36);
  assert.equal(seg(slow, 3).status, NO);
});

test('STEP 4 · a rejection is NO however fast it came', () => {
  const r = tat.computeForRow(row({
    approval_sent_on_date_time: new Date(T0 + 4 * H),
    approval_reject_date_time: new Date(T0 + 5 * H),   // 1h — still NO
  }));
  assert.equal(seg(r, 3).status, NO);
  assert.match(seg(r, 3).note, /rejected/i);
});

test('Seg3 is owned by the Client and every other segment by EasyFix', () => {
  const r = tat.computeForRow(row());
  assert.equal(seg(r, 3).owner, tat.OWNER.CLIENT);
  for (const n of [1, 2, 4]) assert.equal(seg(r, n).owner, tat.OWNER.EASYFIX);
});

// ─── STEP 5 · Seg4 Completion ────────────────────────────────────────

test('STEP 5 · with an approval, Seg4 runs approval → checkout', () => {
  const r = tat.computeForRow(row({
    checkin_date_time: new Date(T0 + 2 * H),
    approval_sent_on_date_time: new Date(T0 + 4 * H),
    approved_on_date_time: new Date(T0 + 10 * H),
    checkout_date_time: new Date(T0 + 30 * H),          // 20h after approval
  }));
  assert.equal(seg(r, 4).hours, 20);
  assert.equal(seg(r, 4).status, YES);
  assert.match(seg(r, 4).note, /approval/i);
});

test('STEP 5 · with NO approval, Seg4 runs check-in → checkout', () => {
  const r = tat.computeForRow(row({
    checkin_date_time: new Date(T0 + 2 * H),
    checkout_date_time: new Date(T0 + 40 * H),          // 38h after check-in
  }));
  assert.equal(seg(r, 4).hours, 38);
  assert.equal(seg(r, 4).status, YES);
  assert.match(seg(r, 4).note, /visit/i);
});

test('STEP 5 · Seg4 breaches past 48h', () => {
  const r = tat.computeForRow(row({
    checkin_date_time: new Date(T0 + 2 * H),
    checkout_date_time: new Date(T0 + 60 * H),          // 58h
  }));
  assert.equal(seg(r, 4).status, NO);
  assert.equal(seg(r, 4).overrunHours, 10);
});

test('STEP 5 · a stop overlapping Seg4 is deducted', () => {
  const r = tat.computeForRow(row({
    checkin_date_time: new Date(T0 + 2 * H),
    checkout_date_time: new Date(T0 + 60 * H),          // gross 58h vs 48 → would be NO
    stops: [{ stop_start: new Date(T0 + 10 * H), stop_end: new Date(T0 + 30 * H) }], // 20h paused
  }));
  assert.equal(seg(r, 4).hours, 38, '58h gross minus 20h paused');
  assert.equal(seg(r, 4).status, YES, 'the deduction turns a breach into a pass');
  assert.match(seg(r, 4).note, /20h of stop-clock time deducted/);
});

test('STEP 5 · only the OVERLAP with the Seg4 window is deducted', () => {
  // A stop that opened long before the Seg4 clock started must not deduct time
  // the clock was never running for — that could drive net below zero and hand
  // a genuinely slow job a pass.
  const r = tat.computeForRow(row({
    checkin_date_time: new Date(T0 + 20 * H),           // Seg4 starts here
    checkout_date_time: new Date(T0 + 80 * H),          // gross 60h
    stops: [{ stop_start: new Date(T0), stop_end: new Date(T0 + 30 * H) }], // only 10h overlap
  }));
  assert.equal(seg(r, 4).hours, 50, '60h gross minus the 10h that actually overlapped');
});

test('STEP 5 · an OPEN stop is clamped to checkout, not left running forever', () => {
  const r = tat.computeForRow(row({
    checkin_date_time: new Date(T0 + 2 * H),
    checkout_date_time: new Date(T0 + 60 * H),
    stops: [{ stop_start: new Date(T0 + 40 * H), stop_end: null }],   // 20h to checkout
  }));
  assert.equal(seg(r, 4).hours, 38);
});

test('STEP 5 · net can never go negative', () => {
  const r = tat.computeForRow(row({
    checkin_date_time: new Date(T0 + 2 * H),
    checkout_date_time: new Date(T0 + 10 * H),
    stops: [{ stop_start: new Date(T0), stop_end: new Date(T0 + 500 * H) }],
  }));
  assert.ok(seg(r, 4).hours >= 0, 'a clamped-at-zero value, never a negative elapsed');
});

test('STEP 5 · a job with NO stops is unaffected — gross equals net', () => {
  const r = tat.computeForRow(row({
    checkin_date_time: new Date(T0 + 2 * H),
    checkout_date_time: new Date(T0 + 40 * H),
  }));
  assert.equal(seg(r, 4).hours, 38);
  assert.doesNotMatch(seg(r, 4).note, /deducted/);
});

// ─── STEP 6 · EF Score ───────────────────────────────────────────────

test('STEP 6 · the EF score covers Seg1, Seg2 and Seg4 ONLY', () => {
  // Seg3 is a NO (client took 36h). It must not touch the EF score.
  const r = tat.computeForRow(row({
    checkin_date_time: new Date(T0 + 2 * H),
    approval_sent_on_date_time: new Date(T0 + 4 * H),
    approved_on_date_time: new Date(T0 + 40 * H),
    checkout_date_time: new Date(T0 + 60 * H),
  }));
  assert.equal(seg(r, 3).status, NO, 'precondition: the client missed their window');
  assert.equal(r.efTotal, 3, 'three EasyFix segments were evaluable');
  assert.equal(r.efMet, 3, 'all three EasyFix segments passed');
  assert.equal(r.efScore, '3/3');
  assert.equal(r.performance, 'Excellent',
    'EasyFix must NOT be downgraded by a client delay — this is the whole point of the split');
  assert.equal(r.clientScore, '0/1');
});

test('STEP 6 · N/A and Pending are excluded from the EF denominator', () => {
  // No estimate → Seg2 N/A. No check-in → Seg1 Pending. Only Seg4 is evaluable.
  const r = tat.computeForRow(row({
    checkin_date_time: null,
    approved_on_date_time: new Date(T0 + 2 * H),
    checkout_date_time: new Date(T0 + 10 * H),
  }));
  assert.equal(seg(r, 1).status, PENDING);
  assert.equal(seg(r, 2).status, NA);
  assert.equal(r.efTotal, 1, 'only Seg4 counted');
  assert.equal(r.efScore, '1/1');
});

test('STEP 6 · a job with nothing evaluable scores Pending, not 0/0 or 100%', () => {
  const r = tat.computeForRow(row({
    checkin_date_time: null,
    checkout_date_time: null,
    app_checkout_date_time: null,
  }));
  assert.equal(r.efScore, PENDING);
  assert.equal(r.efPct, null);
  assert.equal(r.performance, 'Pending');
});

// ─── STEP 7 · Client Score ───────────────────────────────────────────

test('STEP 7 · the client score is 1/1, 0/1, N/A or Pending — never merged in', () => {
  assert.equal(tat.computeForRow(row()).clientScore, NA);
  assert.equal(tat.computeForRow(row({ approval_sent_on_date_time: new Date(T0 + 4 * H) })).clientScore, PENDING);
  assert.equal(tat.computeForRow(row({
    checkin_date_time: new Date(T0 + 2 * H),
    approval_sent_on_date_time: new Date(T0 + 4 * H),
    approved_on_date_time: new Date(T0 + 10 * H),
    checkout_date_time: new Date(T0 + 20 * H),
  })).clientScore, '1/1');
  assert.equal(tat.computeForRow(row({
    approval_sent_on_date_time: new Date(T0 + 4 * H),
    approval_reject_date_time: new Date(T0 + 6 * H),
  })).clientScore, '0/1');
});

// ─── STEP 8 · Performance label ──────────────────────────────────────

test('STEP 8 · labels match the workbook\'s own sample data, ratio for ratio', () => {
  // Verified against all 1,452 scored rows of EasyFix_TAT_Final_August2026.xlsx:
  //   3/3, 2/2, 1/1 → Excellent · 2/3, 1/2 → Partial · 1/3, 0/2, 0/1 → Poor
  const perf = (over) => tat.computeForRow(row(over)).performance;

  // 3/3 = 100% → Excellent
  assert.equal(perf({
    checkin_date_time: new Date(T0 + 2 * H),
    approval_sent_on_date_time: new Date(T0 + 4 * H),
    approved_on_date_time: new Date(T0 + 8 * H),
    checkout_date_time: new Date(T0 + 20 * H),
  }), 'Excellent');

  // 2/3 = 66.7% → Partial. NOT Good: 2/3 falls a third of a point SHORT of the
  // 67% bar, and the workbook labels all 16 of its own 2/3 rows Partial.
  assert.equal(perf({
    checkin_date_time: new Date(T0 + 2 * H),
    approval_sent_on_date_time: new Date(T0 + 40 * H),   // Seg2 38h → NO
    approved_on_date_time: new Date(T0 + 44 * H),
    checkout_date_time: new Date(T0 + 60 * H),           // Seg4 16h → YES
  }), 'Partial');

  // 1/2 = 50% → Partial. NOTE the shape: to get exactly two evaluable EF
  // segments we need NO estimate (Seg2 → N/A) with a present check-in. Nulling
  // the check-in instead would ALSO strand Seg2 on Pending, because Seg2
  // measures FROM check-in — that yields 0/1, not 1/2.
  assert.equal(perf({
    checkin_date_time: new Date(T0 + 2 * H),             // Seg1 2h → YES
    checkout_date_time: new Date(T0 + 200 * H),          // Seg4 198h → NO
  }), 'Partial');

  // 1/3 = 33.3% → Poor
  assert.equal(perf({
    checkin_date_time: new Date(T0 + 30 * H),            // Seg1 30h → NO
    approval_sent_on_date_time: new Date(T0 + 70 * H),   // Seg2 40h → NO
    approved_on_date_time: new Date(T0 + 74 * H),
    checkout_date_time: new Date(T0 + 90 * H),           // Seg4 16h → YES
  }), 'Poor');
});

test('STEP 8 · "Good" is UNREACHABLE on a single job — it only exists in rollups', () => {
  /*
   * A job has at most THREE EasyFix segments, so the only possible ratios are
   * 0, 1/3, 1/2, 2/3 and 1. The Good band is [0.67, 1.0) — and 2/3 = 0.6667
   * misses its floor. Nothing lands in it.
   *
   * This is not a bug in the engine: the workbook's own 1,452 rows contain
   * ZERO Good labels, so the spec's data agrees. Good becomes reachable only
   * on a GROUP score (e.g. 7/10 = 70%). Pinned so that if someone "fixes" the
   * threshold to 0.66 to make Good appear, this fails and the conversation
   * happens instead.
   */
  const RATIOS = [[0, 3], [1, 3], [1, 2], [2, 3], [3, 3]];
  for (const [met, total] of RATIOS) {
    const pctMet = total ? met / total : null;
    const label = pctMet === 1 ? 'Excellent'
      : pctMet >= 0.67 ? 'Good'
        : pctMet >= 0.34 ? 'Partial' : 'Poor';
    assert.notEqual(label, 'Good', `${met}/${total} must not reach Good at job level`);
  }
});

// ─── §4 · Rollups and aggregation ────────────────────────────────────

test('§4 · MET % is YES / (YES + NO) — N/A and Pending never enter the denominator', () => {
  const scored = [
    tat.computeForRow(row({ job_id: 1 })),                                       // Seg1 YES
    tat.computeForRow(row({ job_id: 2, checkin_date_time: new Date(T0 + 30 * H), checkout_date_time: new Date(T0 + 34 * H) })), // Seg1 NO
    tat.computeForRow(row({ job_id: 3, checkin_date_time: null })),              // Seg1 Pending
  ];
  const s = tat.summarise(scored);
  const visit = s.segments[0];
  assert.equal(visit.yes, 1);
  assert.equal(visit.noCount, 1);
  assert.equal(visit.pending, 1);
  assert.equal(visit.metPct, 50, '1 of 2 EVALUATED — the Pending row is excluded');
  assert.equal(visit.coveragePct, 66.7, '2 of 3 applicable segments were evaluable');
  // No estimates anywhere → Seg2 and Seg3 are all N/A with no rate.
  assert.equal(s.segments[1].na, 3);
  assert.equal(s.segments[1].metPct, null);
});

test('§4 · the group EF score sums met and total across jobs, not an average of averages', () => {
  const scored = [
    tat.computeForRow(row({ job_id: 1 })),                                     // 2/2
    tat.computeForRow(row({ job_id: 2, checkin_date_time: new Date(T0 + 30 * H), checkout_date_time: new Date(T0 + 34 * H) })), // 1/2
  ];
  const s = tat.summarise(scored);
  assert.equal(s.efMet, 3);
  assert.equal(s.efTotal, 4);
  assert.equal(s.efScorePct, 75);
});

test('§4 · the client score rolls up separately from the EF score', () => {
  const scored = [
    tat.computeForRow(row({
      job_id: 1, checkin_date_time: new Date(T0 + 2 * H),
      approval_sent_on_date_time: new Date(T0 + 4 * H),
      approved_on_date_time: new Date(T0 + 40 * H),   // client NO
      checkout_date_time: new Date(T0 + 60 * H),
    })),
  ];
  const s = tat.summarise(scored);
  assert.equal(s.efScorePct, 100, 'EasyFix met everything it owned');
  assert.equal(s.clientScorePct, 0, 'the client missed their window');
});

test('§4 · label distribution is counted per group', () => {
  const s = tat.summarise([tat.computeForRow(row()), tat.computeForRow(row({ checkin_date_time: null, checkout_date_time: null, app_checkout_date_time: null }))]);
  assert.equal(s.labels.Excellent, 1);
  assert.equal(s.labels.Pending, 1);
});

test('§4 · rollups cover all seven spec dimensions', () => {
  const s = tat.summarise([tat.computeForRow(row())]);
  for (const dim of ['client', 'city', 'category', 'technician', 'projectManager', 'vertical', 'jobType']) {
    assert.ok(Array.isArray(s.rollups[dim]), `missing the ${dim} rollup`);
  }
  assert.equal(s.rollups.client[0].name, 'Acme');
  assert.equal(s.rollups.jobType[0].name, 'Local');
});

test('§4 · rollups sort worst-first, and an UNSCORED group sorts last', () => {
  const scored = [
    tat.computeForRow(row({ job_id: 1, client_name: 'Good Co' })),
    tat.computeForRow(row({
      job_id: 2, client_name: 'Bad Co',
      checkin_date_time: new Date(T0 + 30 * H), checkout_date_time: new Date(T0 + 100 * H),
    })),
    tat.computeForRow(row({
      job_id: 3, client_name: 'Unknown Co',
      checkin_date_time: null, checkout_date_time: null, app_checkout_date_time: null,
    })),
  ];
  const names = tat.summarise(scored).rollups.client.map((r) => r.name);
  assert.equal(names[0], 'Bad Co', 'the worst score surfaces first');
  assert.equal(names[names.length - 1], 'Unknown Co',
    'a group with nothing evaluable must not masquerade as the worst offender');
});

test('§4 · a null dimension value groups as Unspecified rather than being dropped', () => {
  const s = tat.summarise([tat.computeForRow(row({ city_name: null }))]);
  assert.equal(s.rollups.city[0].name, 'Unspecified');
  assert.equal(s.rollups.city[0].jobs, 1);
});

test('an empty result set yields nulls, not NaN or a fake 100%', () => {
  const s = tat.summarise([]);
  assert.equal(s.jobsAnalysed, 0);
  assert.equal(s.efScorePct, null);
  assert.equal(s.clientScorePct, null);
  for (const sg of s.segments) assert.equal(sg.metPct, null);
});

// ─── Policy payload + caveats ────────────────────────────────────────

test('policy() ships the rules the engine actually applies', () => {
  const p = tat.policy();
  assert.equal(p.targets.seg1Local, 24);
  assert.equal(p.targets.seg1Travel, 48);
  assert.match(p.localityRule, /technician/i);
  assert.equal(p.seg3EscalationHours, 48);
  assert.equal(p.stopClockAvailable, true);
  assert.equal(p.rollupDimensions.length, 7);
  assert.equal(p.segments.filter((s) => s.owner === tat.OWNER.EASYFIX).length, 3);
  assert.equal(p.segments.filter((s) => s.owner === tat.OWNER.CLIENT).length, 1);
});

test('every runtime caveat has an open decision that owns it', () => {
  // A caveat with no decision behind it is a caveat nobody owns — which is how
  // a temporary assumption quietly becomes permanent.
  const ids = new Set(tat.policy().openDecisions.map((d) => d.id));
  for (const id of ['checkin-writer', 'is-estimate-sent-column', 'stop-clock-writers']) {
    assert.ok(ids.has(id), `the ${id} caveat must be tracked as an open decision`);
  }
});

test('open decisions are fully populated and uniquely keyed', () => {
  const d = tat.policy().openDecisions;
  assert.ok(d.length >= 6);
  for (const item of d) {
    assert.ok(item.id && item.question && item.today && item.impact && item.owner,
      `open decision "${item.id}" is missing a field the UI renders`);
    assert.ok(['assumed', 'blocked', 'gap'].includes(item.status));
  }
  assert.equal(new Set(d.map((x) => x.id)).size, d.length, 'ids must be unique');
});

test('only statuses 3 and 5 count as completed', () => {
  assert.deepEqual(tat.COMPLETED_STATUSES, [3, 5]);
});

// ─── Stop reasons (spec §5) ──────────────────────────────────────────
//
// These are a FROZEN set, not a DB dropdown. The first attempt seeded them into
// action_taken_reason and failed on `Unknown column 'reason'` — that table's
// columns are (id, action_type, action_desc, user_type, status, is_new), and its
// `action_type` is a bare integer bucket whose free values cannot be known
// without a live SELECT. Constants remove the whole problem.

test('§5 · the three stop triggers are frozen and fully specified', () => {
  const p = tat.policy();
  assert.equal(p.stopReasons.length, 3);
  assert.deepEqual(p.stopReasons.map((r) => r.code).sort(),
    ['ENTRY_PERMISSION', 'MATERIAL', 'OEM_PART']);
  for (const r of p.stopReasons) {
    assert.ok(r.code && r.label && r.owner, `stop reason ${r.code} is missing a field`);
    assert.ok(p.stopOwners.includes(r.owner), `${r.code} defaults to an owner that is not offered`);
  }
});

test('§5 · owners include OEM/Vendor — the member user_type does not have', () => {
  // This is precisely why stop_owned_by is its own column rather than an FK to
  // the platform's user_type vocabulary (EasyFix / Customer / Client /
  // Technician), and why separating vendor-caused delay from ours is possible.
  assert.deepEqual(tat.policy().stopOwners, ['EasyFix', 'Client', 'OEM/Vendor']);
});

// ─── Visit decomposition ─────────────────────────────────────────────
//
// Seg1's MET% cannot distinguish "we were slow" from "the customer booked for
// next week". These split the interval into the customer's chosen wait and our
// punctuality. Neither is scored — both are context for reading a Visit NO.

test('decomposition splits ticket→check-in into the customer\'s wait and ours', () => {
  const r = tat.computeForRow(row({
    ticket_created_date_time: new Date(T0),
    original_appointment_date_time: new Date(T0 + 72 * H),   // customer chose 3 days out
    checkin_date_time: new Date(T0 + 73 * H),                // we arrived 1h after the slot
    checkout_date_time: new Date(T0 + 78 * H),
  }));
  assert.equal(seg(r, 1).hours, 73, 'the raw Visit clock is 73h — a breach');
  assert.equal(seg(r, 1).status, NO);
  assert.equal(r.bookingLeadHours, 72, '72 of those 73 hours were the customer\'s own choice');
  assert.equal(r.punctualityHours, 1, 'we were 1h late against the promise');
});

test('arriving EARLY is a negative punctuality, not a clamped zero', () => {
  const r = tat.computeForRow(row({
    ticket_created_date_time: new Date(T0),
    original_appointment_date_time: new Date(T0 + 48 * H),
    checkin_date_time: new Date(T0 + 46 * H),     // 2h early
    checkout_date_time: new Date(T0 + 50 * H),
  }));
  assert.equal(r.punctualityHours, -2, 'early must read as early — clamping would hide good performance');
});

test('original_appointment wins over requested — a reschedule cannot flatter punctuality', () => {
  // requested_date_time moves on every reschedule; original_appointment is the
  // FIRST promise and is deliberately frozen. Measuring against the moved date
  // would let us reschedule our way to perfect punctuality.
  const r = tat.computeForRow(row({
    ticket_created_date_time: new Date(T0),
    original_appointment_date_time: new Date(T0 + 24 * H),   // what we promised
    requested_date_time: new Date(T0 + 96 * H),              // where we moved it
    checkin_date_time: new Date(T0 + 30 * H),
    checkout_date_time: new Date(T0 + 34 * H),
  }));
  assert.equal(r.punctualityHours, 6, 'measured against the ORIGINAL promise, so 6h late');
});

test('a midnight-sentinel appointment yields NULL, not a full-day breach', () => {
  // Date-only bookings store 'YYYY-MM-DD 00:00:00' with the real hour in
  // requested_time. Comparing against midnight would score every such job as
  // late by the whole working day.
  const midnight = Date.parse('2026-08-04T00:00:00Z');
  const r = tat.computeForRow(row({
    ticket_created_date_time: new Date(T0),
    original_appointment_date_time: new Date(midnight),
    checkin_date_time: new Date(midnight + 11 * H),
    checkout_date_time: new Date(midnight + 15 * H),
  }));
  assert.equal(r.appointmentIsDateOnly, true, 'the sentinel must be flagged, not silently used');
  assert.equal(r.punctualityHours, null, 'no punctuality invented out of a placeholder');
  assert.equal(r.bookingLeadHours, null);
});

test('a job with no appointment at all decomposes to nulls', () => {
  const r = tat.computeForRow(row({ original_appointment_date_time: null, requested_date_time: null }));
  assert.equal(r.bookingLeadHours, null);
  assert.equal(r.punctualityHours, null);
  assert.equal(r.appointmentIsDateOnly, false);
});

test('the roll-up averages only MEASURABLE jobs, and counts early arrivals as on time', () => {
  const mk = (over) => tat.computeForRow(row({
    ticket_created_date_time: new Date(T0), checkout_date_time: new Date(T0 + 120 * H), ...over,
  }));
  const s = tat.summarise([
    mk({ original_appointment_date_time: new Date(T0 + 48 * H), checkin_date_time: new Date(T0 + 46 * H) }), // 2h early
    mk({ original_appointment_date_time: new Date(T0 + 24 * H), checkin_date_time: new Date(T0 + 30 * H) }), // 6h late
    mk({ original_appointment_date_time: null, requested_date_time: null }),                                  // unmeasurable
  ]);
  assert.equal(s.punctualityMeasurable, 2, 'the appointment-less job is excluded, not counted as 0');
  assert.equal(s.avgPunctualityHours, 2, '(-2 + 6) / 2');
  assert.equal(s.avgBookingLeadHours, 36, '(48 + 24) / 2');
  assert.equal(s.arrivedOnTimePct, 50, 'the early arrival counts as on time; the 6h-late one does not');
});
