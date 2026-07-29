/*
 * Unit tests for lib/job-stages.js — the pure Job Stage Access helpers.
 *
 * Locks the pinned stage/status contract + the visibility/transition rules so a
 * refactor can't silently loosen the server-side enforcement.
 *
 * Runner: Node's built-in `node --test`. Pure (no DB) — no fake-pool needed.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  STAGE_KEYS,
  NO_ACCESS_KEY,
  stageOfStatus,
  stageVisibleStatuses,
  parseAllowedRows,
  parseAllowedInput,
  transitionAllowed,
  stageVisible,
} = require('../lib/job-stages');

test('STAGE_KEYS is the pinned set of 9 keys', () => {
  assert.deepEqual([...STAGE_KEYS].sort(), [
    'audit-complete', 'cancelled', 'estimate-pending', 'onhold',
    'pending-close', 'pending-feedback', 'pending-scheduling',
    'pending-start', 'unconfirmed',
  ]);
});

test('stageOfStatus maps statuses to their single stage; unknowns → null', () => {
  assert.equal(stageOfStatus(9), 'unconfirmed');
  assert.equal(stageOfStatus(0), 'pending-scheduling');
  assert.equal(stageOfStatus(1), 'pending-start');
  assert.equal(stageOfStatus(2), 'pending-close');
  assert.equal(stageOfStatus(20), 'pending-close');
  assert.equal(stageOfStatus(3), 'audit-complete');
  assert.equal(stageOfStatus(5), 'audit-complete');
  assert.equal(stageOfStatus(10), 'pending-feedback');
  assert.equal(stageOfStatus(21), 'onhold');
  assert.equal(stageOfStatus(15), 'estimate-pending');
  assert.equal(stageOfStatus(6), 'cancelled');
  assert.equal(stageOfStatus(7), null);   // ENQUIRY belongs to no stage
  assert.equal(stageOfStatus(null), null);
});

test('stageVisibleStatuses unions visible statuses across keys', () => {
  assert.deepEqual([...stageVisibleStatuses(['pending-close'])].sort((a, b) => a - b), [2, 20]);
  assert.deepEqual(
    [...stageVisibleStatuses(['unconfirmed', 'audit-complete'])].sort((a, b) => a - b),
    [3, 5, 9],
  );
  assert.equal(stageVisibleStatuses([]).size, 0);
  assert.equal(stageVisibleStatuses(['not-a-stage']).size, 0);
});

test('parseAllowedRows: empty → mode all; rows → mode list (deduped, filtered)', () => {
  assert.deepEqual(parseAllowedRows([]), { mode: 'all', stages: [] });
  assert.deepEqual(parseAllowedRows(null), { mode: 'all', stages: [] });
  // object rows (from SELECT stage_key)
  assert.deepEqual(
    parseAllowedRows([{ stage_key: 'pending-close' }, { stage_key: 'onhold' }]),
    { mode: 'list', stages: ['pending-close', 'onhold'] },
  );
  // string rows + dedupe + drop unknowns
  assert.deepEqual(
    parseAllowedRows(['onhold', 'onhold', 'bogus', 'cancelled']),
    { mode: 'list', stages: ['onhold', 'cancelled'] },
  );
  // all-invalid collapses to unrestricted
  assert.deepEqual(parseAllowedRows(['nope']), { mode: 'all', stages: [] });
});

/*
 * The no-access sentinel. "Zero rows" must keep meaning UNRESTRICTED (nobody is
 * locked out when the table lands), so an explicit "grant nothing" is stored as
 * a row carrying NO_ACCESS_KEY. Without this the two collapse and a saved empty
 * pick reads back as All — the bug this pair of tests pins shut.
 */
test('parseAllowedRows: the sentinel row is explicit NO ACCESS, not unrestricted', () => {
  assert.deepEqual(
    parseAllowedRows([{ stage_key: NO_ACCESS_KEY }]),
    { mode: 'list', stages: [] },
    'a sentinel row must NOT read back as mode all',
  );
  // Defensive: if it ever coexists with real grants, the real grants win and
  // the sentinel is stripped from `stages`.
  assert.deepEqual(
    parseAllowedRows([{ stage_key: NO_ACCESS_KEY }, { stage_key: 'onhold' }]),
    { mode: 'list', stages: ['onhold'] },
  );
});

test('parseAllowedInput: null = ALL, [] = NO ACCESS, list = restricted', () => {
  // null / undefined / non-array → unrestricted (stored as zero rows)
  assert.deepEqual(parseAllowedInput(null), { mode: 'all', stages: [] });
  assert.deepEqual(parseAllowedInput(undefined), { mode: 'all', stages: [] });
  assert.deepEqual(parseAllowedInput('nope'), { mode: 'all', stages: [] });
  // EMPTY ARRAY is the operator saying "grant nothing" — the opposite of null.
  assert.deepEqual(parseAllowedInput([]), { mode: 'list', stages: [] });
  // Normal restricted grant, deduped + garbage-filtered.
  assert.deepEqual(
    parseAllowedInput(['onhold', 'onhold', 'bogus', 'cancelled']),
    { mode: 'list', stages: ['onhold', 'cancelled'] },
  );
  // The sentinel is storage-only — it can never be granted over the wire.
  assert.deepEqual(parseAllowedInput([NO_ACCESS_KEY]), { mode: 'list', stages: [] });
});

test('NO ACCESS grant sees nothing and may transition nothing', () => {
  const none = { mode: 'list', stages: [] };
  assert.equal(stageVisibleStatuses(none.stages).size, 0);
  assert.equal(stageVisible(none, 9), false);
  assert.equal(stageVisible(none, 1), false);
  assert.equal(transitionAllowed(none, 9, 0), false);
  assert.equal(transitionAllowed(none, 2, 3), false);
  // …and is NOT confused with the unrestricted object.
  assert.equal(transitionAllowed({ mode: 'all', stages: [] }, 9, 0), true);
});

test('transitionAllowed: mode all is always permitted', () => {
  const all = { mode: 'all', stages: [] };
  assert.equal(transitionAllowed(all, 9, 6), true);
  assert.equal(transitionAllowed(undefined, 0, 1), true);
});

/*
 * The rule is SOURCE-anchored: own the stage the job is in NOW, and the move
 * must be one that stage declares in `targets`. A target-anchored reading looks
 * equivalent but breaks the canonical grant — see the next test.
 */
test('transitionAllowed: restricted user may only move OUT OF a stage they own', () => {
  const allowed = { mode: 'list', stages: ['pending-close'] };
  // Source 2/20 IS pending-close (owned) and the target is declared → allowed.
  assert.equal(transitionAllowed(allowed, 2, 3), true);   // complete
  assert.equal(transitionAllowed(allowed, 2, 6), true);   // cancel
  assert.equal(transitionAllowed(allowed, 20, 21), true); // hold
  // Source 1 is pending-start — NOT their stage, so they cannot act on it at
  // all, even though the target (2) lands inside pending-close.
  assert.equal(transitionAllowed(allowed, 1, 2), false);
  assert.equal(transitionAllowed(allowed, 1, 20), false);
  // Target not declared by the owned stage → blocked.
  assert.equal(transitionAllowed(allowed, 2, 7), false);
});

test('transitionAllowed: the canonical Booking grant can confirm 9 → 0', () => {
  // "Booking" (unconfirmed) users must be able to hand a job off to scheduling.
  // The TARGET stage (pending-scheduling) is deliberately NOT theirs — only the
  // SOURCE is — so a target-anchored check would wrongly 403 this.
  const booking = { mode: 'list', stages: ['unconfirmed'] };
  assert.equal(transitionAllowed(booking, 9, 0), true);  // confirm
  assert.equal(transitionAllowed(booking, 9, 6), true);  // cancel
  // …but they cannot touch a job in anyone else's stage.
  assert.equal(transitionAllowed(booking, 1, 2), false); // check-in
  assert.equal(transitionAllowed(booking, 2, 3), false); // complete
});

test('transitionAllowed: same-stage no-op permitted within an owned stage', () => {
  const allowed = { mode: 'list', stages: ['pending-close', 'audit-complete'] };
  assert.equal(transitionAllowed(allowed, 2, 20), true); // pending-close internal
  assert.equal(transitionAllowed(allowed, 3, 5), true);  // audit-complete internal
  // A within-stage move in a stage they do NOT own is still blocked.
  const other = { mode: 'list', stages: ['audit-complete'] };
  assert.equal(transitionAllowed(other, 2, 20), false);
});

test('stageVisible: current stage must be allowed (used by reschedule)', () => {
  const allowed = { mode: 'list', stages: ['pending-start'] };
  assert.equal(stageVisible(allowed, 1), true);    // pending-start
  assert.equal(stageVisible(allowed, 2), false);   // pending-close — not allowed
  assert.equal(stageVisible(allowed, 7), false);   // no stage
  assert.equal(stageVisible({ mode: 'all', stages: [] }, 2), true);
});
