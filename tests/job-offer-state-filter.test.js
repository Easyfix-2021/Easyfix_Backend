/*
 * Unit tests for THE OFFER SUB-STATE — the one canonical definition behind the
 * Pending-for-Scheduling row chip, the `offerState` list filter and (by
 * agreement) the Schedule & Assign modal. See the canonical docblock above
 * offerColumns() in services/job.service.js.
 *
 * THE PRODUCTION BUG THIS PINS (job #521866). The job's ONE offer row was made
 * at 15:39:39 and only stamped EXPIRED at 17:41:24 — the instant an operator
 * opened Schedule & Assign, because listOffers() ran the lazy sweep. Until then
 * the list read EXISTS(offer_status = 0) and rendered "Offered to Tx" while the
 * modal rendered EXPIRED. Neither query was wrong; the two surfaces simply
 * disagreed about what "open" means, and the modal's own side effect moved the
 * data underneath the list.
 *
 * So "open" is now defined ONCE, and CONDITIONALLY on `job.offer_expiry.enabled`
 * (DEFAULT-ON; only the literal 'false' disables):
 *   expiry ON  — offer_status = OFFERED *and* offered_at within OFFER_TTL_MINUTES,
 *                exactly acceptOffer()'s claim gate. Immune to sweep lag.
 *   expiry OFF — offer_status = OFFERED, no time component. The business has said
 *                offers never expire, so nothing may render them as if they had.
 * Both regimes are pinned below; production is currently running with expiry
 * OFF, so the disabled branch is not hypothetical.
 *
 * Four layers are pinned here:
 *
 *  1. The literal → SQL-fragment MAPPING (offerStateClause) and its params.
 *  2. The TRI-STATE SEMANTICS. Rather than restating the rule in the test
 *     (which would only prove the test agrees with itself), `parseFragment()`
 *     below PARSES the SQL the service actually emits and EXECUTES it against an
 *     in-memory offer set. It refuses any predicate it does not recognise, so a
 *     regression that dropped the freshness term, swapped the EXISTS for
 *     MAX(offer_status), or reintroduced a JOIN fails loudly instead of being
 *     quietly followed.
 *  3. CHIP ≡ FILTER. The `offer_state` projection column is parsed with the SAME
 *     interpreter and asserted to classify every offer combination identically
 *     to the three filter fragments. That is what makes "the chip and the filter
 *     cannot disagree" a checked property rather than a comment.
 *  4. list() integration: the bucket pins (status=0 + assigned=false) survive
 *     the filter, COUNT and data queries stay WHERE/param-identical (the
 *     recorded COUNT-join 500), and the filter degrades to a no-op when
 *     tbl_job_offer is absent.
 *
 * NO WALL-CLOCK OR LIVE-CONFIG DEPENDENCY: offer rows are described by an AGE IN
 * MINUTES; the TTL the interpreter compares against is read out of the SQL
 * itself (the bound `?` param, or the inlined literal in the projection); and
 * the expiry regime is passed in explicitly. The tests cannot flake, and they
 * follow OFFER_TTL_MINUTES automatically.
 *
 * Non-destructive: fake pool, no real DB, zero writes. Runner: `node --test`.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');
const { OFFER_STATUS } = require('../services/offer-status');

// Controls what the memoised tbl_job_offer existence probe sees. Flipped by the
// degradation test, which re-requires the service to reset the memo.
const scenario = { jobOfferTableExists: true };
// Live easyfix_properties contents for the current test.
let props = {};

const fake = installFakePool([
  [/SHOW COLUMNS/i, []],
  [/FROM easyfix_properties/i, () =>
    Object.entries(props).map(([property_key, property_value]) => ({ property_key, property_value }))],
  [/FROM tbl_job_customer_request LIMIT 1/i, []],
  [/SELECT 1 FROM tbl_job_offer LIMIT 1/i, () => {
    if (!scenario.jobOfferTableExists) {
      const e = new Error("Table 'easyfix_core.tbl_job_offer' doesn't exist");
      e.code = 'ER_NO_SUCH_TABLE';
      throw e;
    }
    return [{ 1: 1 }];
  }],
  [/SELECT magic_link_delivery_status FROM tbl_job LIMIT 1/i, [{ magic_link_delivery_status: null }]],
  [/^SELECT COUNT\(\*\) AS total/i, [{ total: 0 }]],
]);

const propsSvc = require('../services/properties.service');
const jobSvc = require('../services/job.service');
const { offerStateClause, OFFER_STATE_VALUES, offerColumns, OFFER_TTL_MINUTES } = jobSvc;

/*
 * Drive the REAL properties cache through the fake pool rather than stubbing
 * getProperty: job.service.js destructures getProperty at require time, so a
 * stub on the module object would silently miss.
 */
async function setProps(next) { props = next; await propsSvc.flushCache(); }
const EXPIRY_ON  = true;
const EXPIRY_OFF = false;

beforeEach(() => { fake.reset(); scenario.jobOfferTableExists = true; });

/* ── Layer 1: literal → SQL fragment mapping ─────────────────────────────── */

test('OFFER_STATE_VALUES is exactly the three literals the FE sends', () => {
  assert.deepEqual([...OFFER_STATE_VALUES], ['pending', 'offered', 'expired']);
});

test('every value in OFFER_STATE_VALUES maps to a real clause (no silent gap)', () => {
  for (const expiry of [EXPIRY_ON, EXPIRY_OFF]) {
    for (const v of OFFER_STATE_VALUES) {
      const c = offerStateClause(v, expiry);
      assert.ok(c && typeof c.sql === 'string' && c.sql.length > 0, `${v} must produce SQL`);
      assert.ok(Array.isArray(c.params), `${v} must produce a params array`);
      // Placeholder count must match the params it supplies, or the whole list
      // query's param alignment shifts and every later filter binds the wrong value.
      assert.equal(
        (c.sql.match(/\?/g) || []).length, c.params.length,
        `${v} (expiry=${expiry}): placeholder count must equal params length`,
      );
    }
  }
});

test('absent / empty / unknown offerState produces NO clause', () => {
  for (const v of [undefined, null, '', 'bogus', 'PENDING', 0, 20]) {
    assert.equal(offerStateClause(v, EXPIRY_ON), null, `${JSON.stringify(v)} must not filter`);
  }
});

test('expiry ON: every fragment binds the TTL from OFFER_TTL_MINUTES, never a second hardcoded 30', () => {
  // The whole fix is that the list, the expiry sweep and acceptOffer()'s gate
  // share ONE TTL. A literal here would let them drift apart again.
  for (const v of ['offered', 'expired', 'pending']) {
    const c = offerStateClause(v, EXPIRY_ON);
    assert.ok(
      c.params.includes(OFFER_TTL_MINUTES),
      `${v}: must bind OFFER_TTL_MINUTES (${OFFER_TTL_MINUTES})`,
    );
    assert.match(c.sql, /NOW\(\) - INTERVAL \? MINUTE/, `${v}: open-ness must be time-derived`);
  }
});

test('expiry OFF: NO time component appears anywhere — offers are meant to stay open', () => {
  for (const v of OFFER_STATE_VALUES) {
    const c = offerStateClause(v, EXPIRY_OFF);
    assert.doesNotMatch(c.sql, /INTERVAL/i, `${v}: must not compare against a TTL when expiry is off`);
    assert.doesNotMatch(c.sql, /offered_at/, `${v}: must not read offered_at when expiry is off`);
    assert.ok(!c.params.includes(OFFER_TTL_MINUTES), `${v}: must not bind the TTL when expiry is off`);
  }
});

test('no clause interpolates a value — every code is a bound placeholder', () => {
  for (const expiry of [EXPIRY_ON, EXPIRY_OFF]) {
    for (const v of OFFER_STATE_VALUES) {
      const { sql } = offerStateClause(v, expiry);
      assert.doesNotMatch(
        sql, /offer_status\s*(=|IN)\s*\(?\s*\d/,
        `${v}: offer_status must be compared against ? , never an inlined literal`,
      );
      assert.doesNotMatch(sql, /INTERVAL\s+\d/, `${v}: the TTL must be bound too, never inlined`);
    }
  }
});

test('clauses reference only the j alias — they cannot perturb the COUNT joins', () => {
  // The COUNT query builds its joins by sniffing the WHERE for cu./ad./cl./ci./
  // ef./ow. A fragment that leaked one of those aliases without the matching
  // join is the recorded "COUNT query 500" bug.
  for (const expiry of [EXPIRY_ON, EXPIRY_OFF]) {
    for (const v of OFFER_STATE_VALUES) {
      const { sql } = offerStateClause(v, expiry);
      for (const alias of ['cu', 'ad', 'cl', 'ci', 'ef', 'ow']) {
        assert.doesNotMatch(
          sql, new RegExp(`\\b${alias}\\.`),
          `${v}: must not reference the ${alias} alias`,
        );
      }
      assert.doesNotMatch(sql, /\bJOIN\b/i, `${v}: must be EXISTS-based, never a JOIN (row fan-out)`);
    }
  }
});

/* ── The interpreter: parse the emitted SQL, then run it ─────────────────── */

/*
 * The ONLY shape the offer-state builders are allowed to emit is a conjunction
 * of `[NOT ]EXISTS (SELECT 1 FROM tbl_job_offer <a> WHERE <body>)` terms, where
 * <body> is an AND/OR expression over this CLOSED set of atoms:
 *
 *   <a>.job_id = j.job_id                                  correlate to the job
 *   <a>.fk_easyfixter_id IS NOT NULL                       NULL-fk guard
 *   EXISTS (… tbl_easyfixer <a>e … <a>e.efr_id = …)        technician-resolvable
 *   <a>.job_offer_id = (SELECT MAX(<a>m.job_offer_id) …)   latest row per tech
 *   <a>.offer_status = <code>                              status
 *   <a>.offered_at >= NOW() - INTERVAL <ttl> MINUTE        FRESH  (still claimable)
 *   <a>.offered_at <  NOW() - INTERVAL <ttl> MINUTE        STALE  (cron just hasn't caught up)
 *   <a>.offered_at IS NULL                                 malformed row ⇒ not fresh
 *
 * Anything else — a MAX(offer_status), a COUNT comparison, a JOIN, an OR
 * smuggled in at the top level — leaves unconsumed text and throws.
 *
 * <code> / <ttl> are read as either a bound `?` (the WHERE fragments, consumed
 * left-to-right from params) or an inlined integer (the projection fragments),
 * so ONE interpreter checks both renderings.
 */

// Index of the ')' matching the '(' at `open`.
function matchParen(sql, open) {
  let depth = 0;
  for (let i = open; i < sql.length; i += 1) {
    if (sql[i] === '(') depth += 1;
    else if (sql[i] === ')') { depth -= 1; if (depth === 0) return i; }
  }
  throw new Error('unbalanced parentheses in: ' + sql);
}

/*
 * Split a fragment into top-level EXISTS terms. Scanning left to right and
 * consuming each EXISTS's whole balanced group means the NESTED EXISTS (the
 * technician probe) stays inside its parent body, where it belongs.
 */
function splitTerms(sql) {
  const terms = [];
  let scaffolding = '';
  let i = 0;
  while (i < sql.length) {
    const m = /^(NOT\s+)?EXISTS\s*\(/i.exec(sql.slice(i));
    if (m) {
      const open = i + m[0].length - 1;
      const close = matchParen(sql, open);
      terms.push({ negated: !!m[1], body: sql.slice(open + 1, close) });
      i = close + 1;
    } else {
      scaffolding += sql[i];
      i += 1;
    }
  }
  return { terms, scaffolding };
}

/*
 * Compile one EXISTS body into a predicate over a single offer row. Returns
 * { alias, test(row, ctx) }. `cursor` supplies params for `?` atoms in
 * left-to-right order across the WHOLE fragment.
 */
function compileBody(body, cursor) {
  const head = /^\s*SELECT 1 FROM tbl_job_offer (\w+) WHERE ([\s\S]+)$/i.exec(body);
  assert.ok(head, 'unrecognised EXISTS body: ' + body);
  const a = head[1];
  const expr = head[2];

  const NUM = '(\\?|\\d+)';
  // Longest / most specific first so a shorter atom cannot eat part of a longer.
  const atoms = [
    [new RegExp(`${a}\\.job_offer_id = \\(SELECT MAX\\(${a}m\\.job_offer_id\\) FROM tbl_job_offer ${a}m WHERE ${a}m\\.job_id = ${a}\\.job_id AND ${a}m\\.fk_easyfixter_id = ${a}\\.fk_easyfixter_id\\)`),
      () => (row, ctx) => ctx.isLatestForTech(row)],
    [new RegExp(`EXISTS \\(SELECT 1 FROM tbl_easyfixer ${a}e WHERE ${a}e\\.efr_id = ${a}\\.fk_easyfixter_id\\)`),
      () => (row, ctx) => ctx.technicianExists(row.techId)],
    [new RegExp(`${a}\\.job_id = j\\.job_id`),
      () => () => true],                                       // rows are already this job's
    [new RegExp(`${a}\\.fk_easyfixter_id IS NOT NULL`),
      () => (row) => row.techId !== null],
    /*
     * IN (?, ?) — the 'dead' predicate since 2026-08-03, when REJECTED joined
     * EXPIRED. Listed BEFORE the `= ?` atom: the combined regex is alternated in
     * order, so a shorter atom placed first would match `offer_status ` and eat
     * half of this one. Both placeholders are taken in left-to-right order, which
     * is what keeps the interpreter's param cursor aligned with the real bindings.
     */
    [new RegExp(`${a}\\.offer_status IN \\(${NUM}, ${NUM}\\)`),
      (m) => {
        const a1 = cursor.take(m[1]);
        const a2 = cursor.take(m[2]);
        return (row) => row.status === a1 || row.status === a2;
      }],
    [new RegExp(`${a}\\.offer_status = ${NUM}`),
      (m) => { const code = cursor.take(m[1]); return (row) => row.status === code; }],
    [new RegExp(`${a}\\.offered_at >= NOW\\(\\) - INTERVAL ${NUM} MINUTE`),
      (m) => { const ttl = cursor.take(m[1]); return (row) => row.ageMinutes !== null && row.ageMinutes <= ttl; }],
    [new RegExp(`${a}\\.offered_at < NOW\\(\\) - INTERVAL ${NUM} MINUTE`),
      (m) => { const ttl = cursor.take(m[1]); return (row) => row.ageMinutes !== null && row.ageMinutes > ttl; }],
    [new RegExp(`${a}\\.offered_at IS NULL`),
      () => (row) => row.ageMinutes === null],
  ];
  // One pass, left to right, so `?` params are consumed in placeholder order.
  const combined = new RegExp(atoms.map(([re]) => `(?:${re.source})`).join('|'), 'g');
  const preds = [];
  const tokenised = expr.replace(combined, (hit) => {
    for (const [re, make] of atoms) {
      const m = new RegExp(`^(?:${re.source})$`).exec(hit);
      if (m) { preds.push(make(m)); return `A[${preds.length - 1}]`; }
    }
    throw new Error('atom dispatch failed for: ' + hit);
  });

  // Whatever is left must be pure boolean scaffolding. An unrecognised
  // predicate (MAX(offer_status), a COUNT compare, a JOIN) survives here and
  // fails the assertion instead of being silently tolerated.
  const js = tokenised.replace(/\bAND\b/g, '&&').replace(/\bOR\b/g, '||');
  assert.doesNotMatch(js, /\?/, `unbound placeholder left in: ${expr}`);
  assert.match(
    js, /^[\sA-Za-z0-9_&|()[\]]+$/,
    `unrecognised SQL inside the EXISTS body: ${expr}`,
  );
  assert.doesNotMatch(
    js.replace(/A\[\d+\]/g, ''), /[A-Za-z_]/,
    `unrecognised identifier left after tokenising: ${expr}`,
  );
  // eslint-disable-next-line no-new-func -- controlled, test-only: the string is
  // A[n] tokens + && / || / parens, already asserted above.
  const fn = new Function('A', `return (${js});`);
  return { alias: a, test: (row, ctx) => fn(preds.map((p) => p(row, ctx))) };
}

// Compile a whole fragment into a predicate over a job's offer rows.
function parseFragment({ sql, params = [] }) {
  let pi = 0;
  const cursor = {
    take(tok) {
      if (tok === '?') { assert.ok(pi < params.length, 'ran out of params: ' + sql); return params[pi++]; }
      return Number(tok);
    },
  };
  const { terms, scaffolding } = splitTerms(sql);
  assert.ok(terms.length > 0, 'unrecognised SQL shape: ' + sql);
  const compiled = terms.map((t) => ({ negated: t.negated, body: compileBody(t.body, cursor) }));
  assert.equal(pi, params.length, 'not every param was bound: ' + sql);
  // Between/around the top-level terms only conjunction scaffolding may appear.
  // An OR here would change the meaning without changing the terms.
  assert.equal(
    scaffolding.replace(/\bAND\b/g, '').replace(/[()\s]/g, ''), '',
    'unexpected SQL beyond AND-ed EXISTS terms: ' + sql,
  );
  return (rows) => {
    const ctx = {
      technicianExists: (id) => rows.some((r) => r.techId === id && r.techExists),
      isLatestForTech: (row) => !rows.some((r) => r.techId === row.techId && r.id > row.id),
    };
    return compiled.every(({ negated, body }) => {
      const hit = rows.some((row) => body.test(row, ctx));
      return negated ? !hit : hit;
    });
  };
}

/* ── Layer 2: tri-state semantics, by EXECUTING the emitted SQL ──────────── */

const { OFFERED, ACCEPTED, REJECTED, EXPIRED } = OFFER_STATUS;
const FRESH = 5;                          // minutes old — well inside the TTL
const STALE = OFFER_TTL_MINUTES + 90;     // #521866: expired in fact, not yet in the DB

/*
 * Build an offer row. Defaults are the happy path (real technician, fresh), so
 * each test only states the axis it is about.
 *   status      tbl_job_offer.offer_status
 *   ageMinutes  minutes since offered_at; null models a NULL offered_at
 *   techId      fk_easyfixter_id; null models the NULL-fk trap
 *   techExists  false models a dangling fk (tbl_easyfixer row gone)
 */
let nextId = 1;
function offer(status, { ageMinutes = FRESH, techId = 100, techExists = true, id = nextId++ } = {}) {
  return { id, status, ageMinutes, techId, techExists };
}

// Classify a job (given its offer rows) by running all three filter fragments.
function statesFor(rows, expiry = EXPIRY_ON) {
  return OFFER_STATE_VALUES.filter((v) => parseFragment(offerStateClause(v, expiry))(rows));
}
// Exactly one state, or the ACCEPTED carve-out (which matches none).
function stateOf(rows, expiry = EXPIRY_ON) {
  const s = statesFor(rows, expiry);
  assert.ok(s.length <= 1, `${JSON.stringify(rows)} matched >1 state: ${JSON.stringify(s)}`);
  return s[0] ?? 'none';
}

test('THE REPORTED BUG (expiry ON): a lone OPEN row older than the TTL is EXPIRED, not "Offered to Tx"', () => {
  // Job #521866's row shape: one row, offer_status = 0, offered ~2 hours ago,
  // nothing had swept it. Under the normal (expiry-enabled) configuration that
  // offer cannot be accepted any more, so the chip must stop advertising it.
  assert.equal(stateOf([offer(OFFERED, { ageMinutes: STALE })], EXPIRY_ON), 'expired');
});

test('EXPIRY OFF: that SAME row stays "Offered" — the business said offers never expire', () => {
  // This is production's current configuration (job.offer_expiry.enabled =
  // 'false'). Nothing may retire the offer, so nothing may render it retired.
  assert.equal(stateOf([offer(OFFERED, { ageMinutes: STALE })], EXPIRY_OFF), 'offered');
  assert.equal(stateOf([offer(OFFERED, { ageMinutes: STALE * 100 })], EXPIRY_OFF), 'offered');
});

test('an OPEN row INSIDE the TTL is offered in BOTH regimes', () => {
  assert.equal(stateOf([offer(OFFERED, { ageMinutes: FRESH })], EXPIRY_ON), 'offered');
  assert.equal(stateOf([offer(OFFERED, { ageMinutes: FRESH })], EXPIRY_OFF), 'offered');
});

test('expiry ON: the TTL boundary matches acceptOffer()s gate exactly (>=, so ON the boundary is open)', () => {
  // acceptOffer() claims with `offered_at >= NOW() - INTERVAL ttl MINUTE`, and
  // expireStaleOffers() sweeps with `<`. The chip must never promise an offer
  // the accept path would refuse, nor refuse one it would still honour.
  assert.equal(stateOf([offer(OFFERED, { ageMinutes: OFFER_TTL_MINUTES })], EXPIRY_ON), 'offered');
  assert.equal(stateOf([offer(OFFERED, { ageMinutes: OFFER_TTL_MINUTES + 1 })], EXPIRY_ON), 'expired');
});

test('an already-swept row (status EXPIRED) is expired in BOTH regimes, whatever its age', () => {
  // Turning expiry off does not un-expire what an earlier enabled regime swept.
  for (const expiry of [EXPIRY_ON, EXPIRY_OFF]) {
    assert.equal(stateOf([offer(EXPIRED, { ageMinutes: FRESH })], expiry), 'expired');
    assert.equal(stateOf([offer(EXPIRED, { ageMinutes: STALE })], expiry), 'expired');
  }
});

test('a job with NO offer rows is pending in BOTH regimes', () => {
  assert.equal(stateOf([], EXPIRY_ON), 'pending');
  assert.equal(stateOf([], EXPIRY_OFF), 'pending');
});

/*
 * REVERSED 2026-08-03 (owner's rule). This used to assert 'pending' on the
 * theory that a declined offer returns the job to the pool. It does — but the
 * CHIP has to distinguish "nobody has been asked yet" from "everyone we asked
 * said no", and collapsing them hid the second. REJECTED is now DEAD, so
 * 'pending' means literally no offer has ever been made.
 */
test('a job whose only offer was REJECTED reads Expired/Rejected in BOTH regimes', () => {
  assert.equal(stateOf([offer(REJECTED)], EXPIRY_ON), 'expired');
  assert.equal(stateOf([offer(REJECTED)], EXPIRY_OFF), 'expired');
});

test('a mix of REJECTED and EXPIRED, none open, is still Expired/Rejected', () => {
  const rows = [offer(REJECTED, { techId: 1 }), offer(EXPIRED, { techId: 2 })];
  assert.equal(stateOf(rows, EXPIRY_ON), 'expired');
  assert.equal(stateOf(rows, EXPIRY_OFF), 'expired');
});

test('REJECTED does NOT beat a live offer — one open row still wins', () => {
  const rows = [offer(REJECTED, { techId: 1 }), offer(OFFERED, { techId: 2, ageMinutes: FRESH })];
  assert.equal(stateOf(rows, EXPIRY_ON), 'offered');
});

test('THE TRAP: 3 dead offers + 1 genuinely-open one is offered, NOT expired', () => {
  const rows = [
    offer(EXPIRED, { techId: 1 }),
    offer(EXPIRED, { techId: 2 }),
    offer(OFFERED, { techId: 3, ageMinutes: STALE }),   // dead in fact, status still 0
    offer(OFFERED, { techId: 4, ageMinutes: FRESH }),   // the one live offer
  ];
  assert.equal(stateOf(rows, EXPIRY_ON), 'offered');
  assert.ok(!statesFor(rows, EXPIRY_ON).includes('expired'), '"all expired" is not "none open"');
});

test('one live offer wins regardless of how many dead siblings surround it, in any order', () => {
  const live = () => offer(OFFERED, { techId: 9, ageMinutes: FRESH });
  const dead = (t) => offer(EXPIRED, { techId: t });
  for (const expiry of [EXPIRY_ON, EXPIRY_OFF]) {
    assert.equal(stateOf([live(), dead(1), dead(2)], expiry), 'offered');
    assert.equal(stateOf([dead(1), dead(2), live()], expiry), 'offered');
  }
});

test('an OPEN row with a NULL fk_easyfixter_id must NOT make the job offered', () => {
  // Recorded NULL-fk trap in tbl_job_offer. The modal INNER JOINs tbl_easyfixer
  // so it never shows such a row; the list must not count it either. Defensive
  // hygiene, in force under both regimes.
  assert.equal(stateOf([offer(OFFERED, { techId: null })], EXPIRY_ON), 'pending');
  assert.equal(stateOf([offer(OFFERED, { techId: null })], EXPIRY_OFF), 'pending');
});

test('an OPEN row pointing at a technician that no longer exists must NOT make the job offered', () => {
  assert.equal(stateOf([offer(OFFERED, { techExists: false })], EXPIRY_ON), 'pending');
  assert.equal(stateOf([offer(OFFERED, { techExists: false })], EXPIRY_OFF), 'pending');
});

test('expiry ON: an OPEN row with a NULL offered_at is not "fresh" — it cannot be claimed', () => {
  assert.equal(stateOf([offer(OFFERED, { ageMinutes: null })], EXPIRY_ON), 'expired');
  // With expiry off there is no freshness question at all: it is simply open.
  assert.equal(stateOf([offer(OFFERED, { ageMinutes: null })], EXPIRY_OFF), 'offered');
});

test('LATEST ROW PER TECHNICIAN: a stray older OPEN row cannot resurrect a newer dead one', () => {
  // The "one row per (job, tech)" invariant is NOT enforced by a constraint.
  // listOffers() collapses to MAX(job_offer_id); the list must agree or the two
  // surfaces contradict each other again.
  const rows = [
    offer(OFFERED, { techId: 7, ageMinutes: FRESH, id: 10 }),  // older, still open
    offer(EXPIRED, { techId: 7, ageMinutes: FRESH, id: 11 }),  // newer — the truth
  ];
  assert.equal(stateOf(rows, EXPIRY_ON), 'expired');
  assert.equal(stateOf(rows, EXPIRY_OFF), 'expired');
});

test('LATEST ROW PER TECHNICIAN: a newer live re-offer beats the tech s older dead row', () => {
  const rows = [
    offer(EXPIRED, { techId: 7, id: 20 }),
    offer(OFFERED, { techId: 7, ageMinutes: FRESH, id: 21 }),
  ];
  assert.equal(stateOf(rows, EXPIRY_ON), 'offered');
  assert.equal(stateOf(rows, EXPIRY_OFF), 'offered');
});

test('an ACCEPTED offer is never reported as expired (documented anomaly carve-out)', () => {
  // Accepting sets fk_easyfixter_id, which evicts the job from the
  // Pending-for-Scheduling bucket — so this should be unreachable there. If it
  // ever IS reachable, the job drops out of every filter rather than being
  // mislabelled a dead offer.
  for (const expiry of [EXPIRY_ON, EXPIRY_OFF]) {
    for (const rows of [
      [offer(ACCEPTED)],
      [offer(ACCEPTED, { techId: 1 }), offer(EXPIRED, { techId: 2 })],
      [offer(ACCEPTED, { techId: 1 }), offer(REJECTED, { techId: 2 }), offer(EXPIRED, { techId: 3 })],
    ]) {
      assert.deepEqual(statesFor(rows, expiry), [], `${JSON.stringify(rows)} must match no filter`);
    }
  }
});

// Every combination of (status × freshness × resolvability), one row per tech.
function allCombos() {
  const out = [[]];
  const variants = [];
  for (const status of [OFFERED, ACCEPTED, REJECTED, EXPIRED]) {
    for (const ageMinutes of [FRESH, STALE, null]) {
      for (const [techId, techExists] of [[1, true], [null, true], [2, false]]) {
        variants.push({ status, ageMinutes, techId, techExists });
      }
    }
  }
  for (const a of variants) {
    out.push([offer(a.status, a)]);
    for (const b of variants) {
      out.push([offer(a.status, { ...a, techId: a.techId === null ? null : 10 }),
                offer(b.status, { ...b, techId: b.techId === null ? null : 20 })]);
    }
  }
  return out;
}

test('the three states are mutually exclusive over every offer combination, in BOTH regimes', () => {
  for (const expiry of [EXPIRY_ON, EXPIRY_OFF]) {
    for (const rows of allCombos()) {
      assert.ok(
        statesFor(rows, expiry).length <= 1,
        `${JSON.stringify(rows)} landed in >1 state: ${JSON.stringify(statesFor(rows, expiry))}`,
      );
    }
  }
});

test('the three states are EXHAUSTIVE except for the ACCEPTED anomaly (they partition the bucket)', () => {
  for (const expiry of [EXPIRY_ON, EXPIRY_OFF]) {
    for (const rows of allCombos()) {
      if (statesFor(rows, expiry).length === 1) continue;
      // The only permitted hole: a resolvable, latest ACCEPTED row.
      const acceptedLatest = rows.some((r) => r.status === ACCEPTED && r.techId !== null && r.techExists
        && !rows.some((o) => o.techId === r.techId && o.id > r.id));
      assert.ok(acceptedLatest, `${JSON.stringify(rows)} fell through every state`);
    }
  }
});

/* ── Layer 3: the chip (offer_state projection) ≡ the filter ─────────────── */

/*
 * Pull the `offer_state` CASE out of the LIST projection and compile each WHEN
 * with the SAME interpreter. The projection inlines its constants (it carries no
 * params), so this also proves the two renderings of the one definition agree.
 */
function projectionStateFn(expiry) {
  const cols = offerColumns(true, expiry);
  const m = /\(CASE\s+([\s\S]+?)\s+END\) AS offer_state/.exec(cols);
  assert.ok(m, 'offerColumns must project an offer_state CASE, got: ' + cols);
  const branches = [];
  const whenRe = /WHEN\s+([\s\S]+?)\s+THEN\s+'(\w+)'/g;
  let hit;
  while ((hit = whenRe.exec(m[1])) !== null) {
    branches.push({ test: parseFragment({ sql: hit[1], params: [] }), label: hit[2] });
  }
  const els = /ELSE\s+'(\w+)'\s*$/.exec(m[1]);
  assert.ok(branches.length > 0 && els, 'offer_state CASE must be WHEN…THEN… ELSE …');
  return (rows) => (branches.find((b) => b.test(rows))?.label ?? els[1]);
}

test('offerColumns projects offer_state, TIME-derived when expiry is on and not when it is off', () => {
  const on = offerColumns(true, EXPIRY_ON);
  assert.match(on, /AS offer_state/, 'the FE renders this instead of re-deriving the rule');
  assert.match(on, new RegExp(`INTERVAL ${OFFER_TTL_MINUTES} MINUTE`), 'the TTL must be inlined from OFFER_TTL_MINUTES');
  assert.doesNotMatch(on, /MAX\(\w+\.offer_status\)/, 'never derive open-ness from MAX(offer_status)');
  const off = offerColumns(true, EXPIRY_OFF);
  assert.match(off, /AS offer_state/);
  assert.doesNotMatch(off, /INTERVAL/i, 'expiry off ⇒ no TTL anywhere in the projection');
  assert.doesNotMatch(off, /offered_at/, 'expiry off ⇒ the projection must not read offered_at');
});

test('CHIP ≡ FILTER: offer_state classifies every combination exactly as the filters do, in BOTH regimes', () => {
  for (const expiry of [EXPIRY_ON, EXPIRY_OFF]) {
    const chip = projectionStateFn(expiry);
    for (const rows of allCombos()) {
      assert.equal(
        chip(rows), stateOf(rows, expiry),
        `chip/filter disagree (expiry=${expiry}) for ${JSON.stringify(rows)} — bug #521866's whole class`,
      );
    }
  }
});

test('CHIP: the reported row renders per regime — Expired when expiry is on, Offered when it is off', () => {
  const on = projectionStateFn(EXPIRY_ON);
  assert.equal(on([offer(OFFERED, { ageMinutes: STALE })]), 'expired');
  assert.equal(on([offer(OFFERED, { ageMinutes: FRESH })]), 'offered');
  // REJECTED is DEAD since 2026-08-03 — and the CHIP tracking the FILTER here
  // without a second edit is the point of the shared builder: one definition,
  // so the two can never disagree about a row again.
  assert.equal(on([offer(REJECTED)]), 'expired');
  assert.equal(on([]), 'pending');            // 'pending' now means: never offered
  const off = projectionStateFn(EXPIRY_OFF);
  assert.equal(off([offer(OFFERED, { ageMinutes: STALE })]), 'offered');
  assert.equal(off([offer(EXPIRED)]), 'expired');
  assert.equal(off([offer(REJECTED)]), 'expired');
  assert.equal(off([]), 'pending');
});

test('the NULL-alias branch mirrors the real projection column-for-column', () => {
  const names = (s) => (s.match(/AS (\w+)/g) || []).map((x) => x.slice(3));
  assert.deepEqual(names(offerColumns(false, EXPIRY_ON)), names(offerColumns(true, EXPIRY_ON)));
  assert.deepEqual(names(offerColumns(false, EXPIRY_OFF)), names(offerColumns(true, EXPIRY_OFF)));
});

test('the count columns share the state definition (a count can never contradict the chip)', () => {
  for (const expiry of [EXPIRY_ON, EXPIRY_OFF]) {
    const cols = offerColumns(true, expiry);
    for (const col of ['offered_count', 'total_offer_count', 'expired_offer_count']) {
      const re = new RegExp(`SELECT COUNT\\(\\*\\) FROM tbl_job_offer (\\w+) WHERE ([\\s\\S]+?)\\) AS ${col}`);
      const m = re.exec(cols);
      assert.ok(m, `${col} must be a correlated COUNT subquery`);
      // Every count carries BOTH defensive guards, so it counts the same rows
      // the Schedule & Assign modal lists.
      assert.match(m[2], new RegExp(`${m[1]}\\.fk_easyfixter_id IS NOT NULL`), `${col}: NULL-fk guard`);
      assert.match(m[2], new RegExp(`MAX\\(${m[1]}m\\.job_offer_id\\)`), `${col}: latest-row-per-tech guard`);
    }
  }
  // With expiry on, the open/dead counts carry the same TTL term as the chip.
  const on = offerColumns(true, EXPIRY_ON);
  assert.match(on, /WHERE [\s\S]*?INTERVAL \d+ MINUTE\) AS offered_count/);
  assert.match(on, /INTERVAL \d+ MINUTE\)\)\)\) AS expired_offer_count/);
});

/* ── The expiry property gate — chip regime AND the write side door ──────── */

test('offerExpiryEnabled is DEFAULT-ON: only the literal "false" disables it', async () => {
  for (const [value, expected] of [
    [undefined, true], ['true', true], ['TRUE', true], ['1', true], ['', true], ['yes', true],
    ['false', false], ['FALSE', false], ['False', false],
  ]) {
    await setProps(value === undefined ? {} : { 'job.offer_expiry.enabled': value });
    assert.equal(
      jobSvc.offerExpiryEnabled(), expected,
      `${JSON.stringify(value)} must resolve to ${expected} (matches server/scheduler.js + the seed migration)`,
    );
  }
  await setProps({});
});

test('SIDE DOOR CLOSED: expireStaleOffers issues NO UPDATE when expiry is disabled', async () => {
  // listOffers() sweeps unconditionally on every modal open. With the business
  // switch off that write must not happen at all — a feature turned off in
  // properties must not still mutate data when someone opens a modal.
  await setProps({ 'job.offer_expiry.enabled': 'false' });
  fake.reset();
  const res = await jobSvc.expireStaleOffers();
  assert.deepEqual(res, { skipped: true, expired: 0, reason: 'offer_expiry_disabled' });
  assert.equal(
    fake.calls.filter((c) => /UPDATE tbl_job_offer/i.test(c.sql)).length, 0,
    'no UPDATE may reach the DB while offer expiry is disabled',
  );
  // Job-scoped (the listOffers path) is gated identically.
  fake.reset();
  await jobSvc.expireStaleOffers(30, 521866);
  assert.equal(fake.calls.filter((c) => /UPDATE tbl_job_offer/i.test(c.sql)).length, 0);
  await setProps({});
});

test('expireStaleOffers still sweeps normally when expiry is enabled', async () => {
  await setProps({ 'job.offer_expiry.enabled': 'true' });
  fake.reset();
  await jobSvc.expireStaleOffers(OFFER_TTL_MINUTES, 521866);
  const upd = fake.calls.find((c) => /UPDATE tbl_job_offer/i.test(c.sql));
  assert.ok(upd, 'the sweep must run when the business switch is on');
  assert.match(upd.sql, /offered_at < NOW\(\) - INTERVAL \? MINUTE/, 'same TTL comparison as always');
  assert.deepEqual(upd.params, [OFFER_TTL_MINUTES, 521866]);
  await setProps({});
});

test('list() resolves the regime from the property and applies it to chip AND filter together', async () => {
  await setProps({ 'job.offer_expiry.enabled': 'false' });
  fake.reset();
  await jobSvc.list({ status: 0, assigned: false, offerState: 'offered', limit: 10, offset: 0 });
  const data = fake.calls.find((c) => /LIMIT \? OFFSET \?/.test(c.sql));
  assert.doesNotMatch(data.sql, /INTERVAL \d+ MINUTE/, 'projection must drop the TTL when expiry is off');
  assert.doesNotMatch(data.sql, /INTERVAL \? MINUTE/, 'filter must drop the TTL when expiry is off');
  const count = fake.calls.find((c) => /^SELECT COUNT\(\*\) AS total/i.test(c.sql));
  assert.deepEqual(count.params, [0, OFFER_STATUS.OFFERED], 'no TTL param is bound when expiry is off');
  await setProps({});
});

/* ── Layer 4: list() integration ─────────────────────────────────────────── */

const dataQuery  = () => fake.calls.find((c) => /LIMIT \? OFFSET \?/.test(c.sql));
const countQuery = () => fake.calls.find((c) => /^SELECT COUNT\(\*\) AS total/i.test(c.sql));
/*
 * The COUNT query is `SELECT COUNT(*) … <joins> <where>` with no projection
 * subqueries, so its FIRST 'WHERE' is the top-level one — unlike the data
 * query, whose projection is full of correlated subqueries. We therefore read
 * the canonical WHERE off the COUNT query and assert the data query CONTAINS
 * that exact text, which is a stronger equality check than re-parsing both.
 */
const topLevelWhere = () => countQuery().sql.slice(countQuery().sql.indexOf('WHERE')).trim();
// `jos…` is used ONLY by the filter; the LIST projection's offer subqueries use
// jo…jo8. So this alias is an exact probe for "the filter fired".
const FILTER_ALIAS = /tbl_job_offer jos\b/;

const OFFERED_PARAMS  = [OFFER_STATUS.OFFERED, OFFER_TTL_MINUTES];
const ACCEPTED_PARAMS = [OFFER_STATUS.ACCEPTED];
/*
 * DEAD binds FOUR params since 2026-08-03: the IN (EXPIRED, REJECTED) pair, then
 * the stale-open arm's OFFERED + TTL. REJECTED joined the predicate when the
 * owner ruled that "everyone we asked said no" must read as Expired/Rejected
 * rather than collapsing into Pending to Scheduling.
 */
const DEAD_PARAMS     = [OFFER_STATUS.EXPIRED, OFFER_STATUS.REJECTED, OFFER_STATUS.OFFERED, OFFER_TTL_MINUTES];

test('offerState NARROWS the bucket — status=0 + assigned=false survive intact', async () => {
  await jobSvc.list({ status: 0, assigned: false, offerState: 'offered', limit: 10, offset: 0 });
  const where = topLevelWhere();
  // Exact composition: the pins first, the sub-state AND-ed on after. Nothing
  // here can widen the bucket — an AND-ed EXISTS can only remove rows.
  assert.match(
    where,
    /^WHERE j\.job_status = \? AND j\.fk_easyfixter_id IS NULL AND \(EXISTS \(SELECT 1 FROM tbl_job_offer jos /,
  );
  const data = dataQuery();
  assert.ok(data.sql.includes(where), 'the data query must carry the same WHERE');
  assert.deepEqual(countQuery().params, [0, ...OFFERED_PARAMS]);
});

test('COUNT and data queries share the SAME where + params (COUNT-join parity)', async () => {
  await jobSvc.list({ status: 0, assigned: false, offerState: 'expired', limit: 10, offset: 0 });
  const count = countQuery(); const data = dataQuery();
  assert.ok(count && data, 'both queries must have run');
  assert.ok(data.sql.includes(topLevelWhere()), 'COUNT and data must filter identically');
  // The data query appends limit + offset; everything before must match.
  assert.deepEqual(data.params.slice(0, count.params.length), count.params);
  assert.deepEqual(data.params.slice(count.params.length), [10, 0]);
  assert.deepEqual(count.params, [0, ...OFFERED_PARAMS, ...ACCEPTED_PARAMS, ...DEAD_PARAMS]);
  // No new outer alias ⇒ COUNT still counts over tbl_job alone for this filter
  // set. This is the recorded "COUNT query lacked the main query's joins" 500.
  assert.doesNotMatch(count.sql, /LEFT JOIN/i);
});

test('offerState composes with the OTHER filters without disturbing their params', async () => {
  // cityId forces the ad. alias into the WHERE, so the COUNT query must add the
  // address join — proving the offer filter didn't break alias detection.
  await jobSvc.list({ status: 0, assigned: false, offerState: 'pending', cityId: '7,9', limit: 10, offset: 0 });
  const count = countQuery();
  assert.match(count.sql, /LEFT JOIN tbl_address/i, 'cityId must still pull in the address join');
  assert.deepEqual(
    count.params,
    [0, ...OFFERED_PARAMS, ...ACCEPTED_PARAMS, ...DEAD_PARAMS, 7, 9],
    'the offer params must sit before cityId, in fragment order',
  );
  assert.ok(dataQuery().sql.includes(topLevelWhere()));
});

test('no offerState ⇒ the bucket is returned unfiltered (no filter clause emitted)', async () => {
  await jobSvc.list({ status: 0, assigned: false, limit: 10, offset: 0 });
  assert.doesNotMatch(topLevelWhere(), FILTER_ALIAS, 'absent offerState must add no clause');
  assert.match(topLevelWhere(), /j\.fk_easyfixter_id IS NULL/);
});

test('an unknown offerState value adds no clause (defence in depth behind Joi)', async () => {
  for (const bad of ['bogus', '', null]) {
    fake.reset();
    await jobSvc.list({ status: 0, assigned: false, offerState: bad, limit: 10, offset: 0 });
    assert.doesNotMatch(topLevelWhere(), FILTER_ALIAS, `${JSON.stringify(bad)} must not filter`);
  }
});

test('the filter degrades to a no-op when tbl_job_offer does not exist', async () => {
  // The probe is memoised per process, so re-require the service with a fresh
  // module registry entry to re-run it against the absent-table scenario.
  scenario.jobOfferTableExists = false;
  delete require.cache[require.resolve('../services/job.service')];
  const freshSvc = require('../services/job.service');
  fake.reset();
  await freshSvc.list({ status: 0, assigned: false, offerState: 'expired', limit: 10, offset: 0 });
  assert.ok(dataQuery(), 'the list must still run (not 500)');
  const where = topLevelWhere();
  assert.doesNotMatch(where, FILTER_ALIAS, 'no offer filter may be emitted when the table is absent');
  assert.match(where, /j\.fk_easyfixter_id IS NULL/, 'the bucket itself must still be returned');
  assert.deepEqual(countQuery().params, [0], 'no orphan params may be bound');
  assert.match(dataQuery().sql, /NULL AS offer_state/, 'the FE must still get the column, as NULL');
  // Restore the module registry so any later require in this process is normal.
  delete require.cache[require.resolve('../services/job.service')];
  require('../services/job.service');
});
