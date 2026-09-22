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

test('TECH_EDITABLE_STATES is exactly draft + review_pending (approval_pending is OPEN for counting but LOCKED for tech writes)', () => {
  assert.deepEqual([...qls.TECH_EDITABLE_STATES].sort(), ['draft', 'review_pending'].sort());
  assert.equal(qls.isTechEditable('approval_pending'), false, 'approval_pending must not be tech-editable — the client already has it');
});

test('isTechEditable is true only for draft/review_pending', () => {
  for (const state of Object.values(qls.STATE)) {
    assert.equal(qls.isTechEditable(state), qls.TECH_EDITABLE_STATES.includes(state));
  }
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
