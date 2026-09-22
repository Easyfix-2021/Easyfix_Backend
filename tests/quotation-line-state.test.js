/*
 * services/quotation-line-state.js — the single owner of quotation_details
 * line-state derivation. Material Request Flow v2 (2026-09-21). See
 * docs/superpowers/specs/2026-09-21-material-request-flow-v2-design.md
 * ("State model").
 *
 * Covers:
 *   1. quotationLineState() — the six states, from the SAME predicate table
 *      the design specifies, plus the mutual-exclusivity edge (an
 *      approval_pending line that has also been client-actioned reads as
 *      client_approved/client_rejected, never approval_pending).
 *   2. statePredicateSql / quotationLineStateSql — structural SQL shape
 *      assertions (CAST guards present, one CASE, six arms).
 *   3. openLineSql / TECH_EDITABLE_STATES — the material_count / tech-lock
 *      sets are exactly the states the design names.
 *   4. GUARD — no second copy of the six state-label literals appears
 *      together outside this file (services/ or routes/), so a future
 *      change can't reintroduce a duplicate CASE.
 *
 * Runner: `node --test --test-force-exit tests/quotation-line-state.test.js`.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const qls = require('../services/quotation-line-state');

// ─── 1. JS state derivation ────────────────────────────────────────────

test('draft: sent_on IS NULL', () => {
  assert.equal(qls.quotationLineState({ sent_on: null, action_on: null, status: null, client_status: null }), 'draft');
});

test('review_pending: sent_on set, action_on NULL', () => {
  assert.equal(qls.quotationLineState({ sent_on: new Date(), action_on: null, status: 1, client_status: null }), 'review_pending');
});

test('rejected: action_on set, status = 0', () => {
  assert.equal(qls.quotationLineState({ sent_on: new Date(), action_on: new Date(), status: 0, client_status: null }), 'rejected');
});

test('approval_pending: action_on set, status = 1, client_status NULL', () => {
  assert.equal(qls.quotationLineState({ sent_on: new Date(), action_on: new Date(), status: 1, client_status: null }), 'approval_pending');
});

test('client_approved: client_status = 1 (even though the line still reads action_on/status = approval_pending-shaped)', () => {
  assert.equal(qls.quotationLineState({ sent_on: new Date(), action_on: new Date(), status: 1, client_status: 1 }), 'client_approved');
});

test('client_rejected: client_status = 0', () => {
  assert.equal(qls.quotationLineState({ sent_on: new Date(), action_on: new Date(), status: 1, client_status: 0 }), 'client_rejected');
});

test('a client_status of 0 wins even on a CRM-rejected-shaped row (defensive — should never occur in practice)', () => {
  assert.equal(qls.quotationLineState({ sent_on: new Date(), action_on: new Date(), status: 0, client_status: 0 }), 'client_rejected');
});

// ─── 2. SQL shape ───────────────────────────────────────────────────────

test('statePredicateSql: rejected/approval_pending CAST status; client arms do not', () => {
  assert.match(qls.statePredicateSql('qd', qls.STATE.REJECTED), /CAST\(qd\.status AS UNSIGNED\)/);
  assert.match(qls.statePredicateSql('qd', qls.STATE.APPROVAL_PENDING), /CAST\(qd\.status AS UNSIGNED\)/);
  assert.match(qls.statePredicateSql('qd', qls.STATE.APPROVAL_PENDING), /qd\.client_status IS NULL/);
});

test('statePredicateSql: unknown state throws (fails loud, not silently "always false")', () => {
  assert.throws(() => qls.statePredicateSql('qd', 'not_a_real_state'));
});

test('quotationLineStateSql: exactly one CASE, one ELSE draft, and all six state labels present', () => {
  const sql = qls.quotationLineStateSql('qd');
  assert.equal((sql.match(/CASE/g) || []).length, 1);
  assert.match(sql, /ELSE 'draft'/);
  for (const state of Object.values(qls.STATE)) {
    assert.match(sql, new RegExp(`'${state}'`), `state label "${state}" must appear in the CASE`);
  }
});

// ─── 3. material_count / tech-lock sets ─────────────────────────────────

test('OPEN_STATES is exactly draft + review_pending + approval_pending (the material_count set)', () => {
  assert.deepEqual([...qls.OPEN_STATES].sort(), ['approval_pending', 'draft', 'review_pending'].sort());
});

// AMENDMENT (owner decision, 2026-09-22): once sent, a line is locked to the
// technician — "Save" is for drafts; anything more is a NEW quotation. So
// TECH_EDITABLE_STATES shrank from [draft, review_pending] to [draft] only.
test('TECH_EDITABLE_STATES is exactly [draft] (2026-09-22: review_pending is no longer tech-editable)', () => {
  assert.deepEqual([...qls.TECH_EDITABLE_STATES], ['draft']);
  assert.equal(qls.isTechEditable('review_pending'), false, 'review_pending must not be tech-editable — once sent, a line is locked to the technician');
  assert.equal(qls.isTechEditable('approval_pending'), false, 'approval_pending must not be tech-editable — the client already has it');
});

test('isTechEditable is true only for draft', () => {
  for (const state of Object.values(qls.STATE)) {
    assert.equal(qls.isTechEditable(state), qls.TECH_EDITABLE_STATES.includes(state));
  }
});

// ─── nextSentOn — one-timestamp-per-send, strictly later (2026-09-22) ───

test('nextSentOn: no prior sent_on on the job -> uses `now` as-is', () => {
  const now = new Date('2026-09-22T10:00:00Z');
  assert.equal(qls.nextSentOn(now, null).getTime(), now.getTime());
});

test('nextSentOn: `now` already strictly after the last sent_on -> uses `now` as-is', () => {
  const lastSentOn = new Date('2026-09-22T10:00:00Z');
  const now = new Date('2026-09-22T10:05:00Z');
  assert.equal(qls.nextSentOn(now, lastSentOn).getTime(), now.getTime());
});

test('nextSentOn: `now` in the SAME second as the last sent_on -> bumped to lastSentOn + 1s, never equal', () => {
  const lastSentOn = new Date('2026-09-22T10:00:00.000Z');
  const now = new Date('2026-09-22T10:00:00.900Z'); // same whole second, later ms
  const result = qls.nextSentOn(now, lastSentOn);
  assert.equal(result.getTime(), lastSentOn.getTime() + 1000);
  assert.ok(result.getTime() > lastSentOn.getTime(), 'must be strictly later — two sends must never share a quotation');
});

test('nextSentOn: `now` BEFORE the last sent_on (clock skew) -> still bumped past it, never regresses', () => {
  const lastSentOn = new Date('2026-09-22T10:00:05Z');
  const now = new Date('2026-09-22T10:00:00Z');
  const result = qls.nextSentOn(now, lastSentOn);
  assert.equal(result.getTime(), lastSentOn.getTime() + 1000);
});

// ─── quotationNumbers — 1..n by ascending distinct sent_on, null for draft ─

test('quotationNumbers: two distinct sends number 1 and 2; a draft (null sent_on) numbers null', () => {
  const firstSend = new Date('2026-09-22T09:00:00Z');
  const secondSend = new Date('2026-09-22T10:00:00Z');
  // Order deliberately NOT sorted — numbering is by sent_on value, not row order.
  const out = qls.quotationNumbers([secondSend, null, firstSend, secondSend]);
  assert.deepEqual(out, [2, null, 1, 2]);
});

test('quotationNumbers: all drafts -> all null', () => {
  assert.deepEqual(qls.quotationNumbers([null, null]), [null, null]);
});

test('quotationNumbers: a string and a Date for the SAME instant collapse to one quotation number', () => {
  const d = new Date('2026-09-22T09:00:00Z');
  const out = qls.quotationNumbers([d, d.toISOString()]);
  assert.deepEqual(out, [1, 1]);
});

test('openLineSql ORs exactly the three OPEN_STATES predicates', () => {
  const sql = qls.openLineSql('x');
  assert.equal((sql.match(/\bOR\b/g) || []).length, 2, 'three predicates joined by OR needs exactly two ORs');
});

// ─── 4. GUARD — no duplicate copy of the state enum elsewhere ───────────

test('GUARD: no other file under services/ or routes/ carries all six state labels together (a second hand-rolled CASE)', () => {
  const labels = Object.values(qls.STATE); // ['draft','review_pending','rejected','approval_pending','client_approved','client_rejected']
  const root = path.join(__dirname, '..');
  const dirs = ['services', 'routes'];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      if (full === path.join(root, 'services', 'quotation-line-state.js')) continue;
      const src = fs.readFileSync(full, 'utf8');
      const hasAll = labels.every((l) => src.includes(`'${l}'`));
      if (hasAll) offenders.push(path.relative(root, full));
    }
  };
  for (const d of dirs) walk(path.join(root, d));
  assert.deepEqual(offenders, [], `these files carry every state label — a duplicate CASE, not a consumer: ${offenders.join(', ')}`);
});

/*
 * MUTATION CHECK (performed manually during implementation, not left in the
 * suite): temporarily added a second copy of all six state labels inside
 * services/job.service.js (a throwaway `const DUPE = ['draft','review_pending',
 * 'rejected','approval_pending','client_approved','client_rejected'];`) and
 * re-ran this file — the GUARD test went red, correctly naming
 * services/job.service.js as the offender. Reverted immediately after
 * confirming the failure; job.service.js's real content never carries all six
 * together (it only ever references material_state's OWN four labels via
 * job_status, never the line-state set).
 */
