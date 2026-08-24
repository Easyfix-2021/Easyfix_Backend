/*
 * The typed-name ⇄ Aadhaar-name comparison (utils/name-match.js).
 *
 * Pure module, so this runs with no network, no DB and no Sophy key. The cases
 * below are the real ways an Aadhaar card disagrees with what a technician
 * types — reordering, a dropped middle name, an honorific, punctuation — plus
 * the one case that must NEVER pass: two different people.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { matchNames } = require('../utils/name-match');

test('identical names match exactly', () => {
  const out = matchNames('Ramesh Kumar', 'Ramesh Kumar');
  assert.equal(out.matched, true);
  assert.equal(out.score, 1);
  assert.equal(out.expected, 'Ramesh Kumar');
  assert.equal(out.found, 'Ramesh Kumar');
});

test('given name and surname reordered on the card still match', () => {
  const out = matchNames('Ramesh Kumar', 'Kumar Ramesh');
  assert.equal(out.matched, true);
  assert.equal(out.score, 1);
});

test('an extra middle name on one side still matches', () => {
  assert.equal(matchNames('Ramesh Kumar', 'Ramesh Chandra Kumar').matched, true);
  assert.equal(matchNames('Ramesh Chandra Kumar', 'Ramesh Kumar').matched, true);
});

test('an honorific on one side is ignored', () => {
  assert.equal(matchNames('Mr. Ramesh Kumar', 'Ramesh Kumar').matched, true);
  assert.equal(matchNames('Sunita Devi', 'Smt Sunita Devi').matched, true);
  assert.equal(matchNames('Md Salim Ansari', 'Salim Ansari').matched, true);
});

test('case, punctuation and diacritic differences are ignored', () => {
  assert.equal(matchNames('  RAMESH   KUMAR ', 'ramesh kumar').matched, true);
  assert.equal(matchNames("D'Souza, Maria", 'maria dsouza').matched, true);
  assert.equal(matchNames('Rámesh Kumár', 'Ramesh Kumar').matched, true);
});

test('two different people do NOT match and score low', () => {
  const out = matchNames('Ramesh Kumar', 'Suresh Verma');
  assert.equal(out.matched, false);
  assert.ok(out.score < 0.5, `expected a low score, got ${out.score}`);

  const sharedSurname = matchNames('Ramesh Kumar', 'Suresh Kumar');
  assert.equal(sharedSurname.matched, false, 'a shared surname alone is not a match');
  assert.ok(sharedSurname.score <= 0.5);
});

test('a single-token name never matches a different single-token name by prefix', () => {
  assert.equal(matchNames('Ram', 'Ramesh').matched, false);
  assert.equal(matchNames('Ramesh', 'Ram').matched, false);
  assert.equal(matchNames('Anu', 'Anupama').matched, false);
  // …but the SAME single-token name is still an exact match.
  assert.equal(matchNames('Ramesh', 'ramesh').matched, true);
});

test('one shared token is not enough when the other side has more', () => {
  const out = matchNames('Ramesh', 'Ramesh Kumar');
  assert.equal(out.matched, false);
  assert.equal(out.score, 0.5);
});

test('an initial may stand in for a given name, and never steals a full token', () => {
  assert.equal(matchNames('R Kumar', 'Ramesh Kumar').matched, true);
  // 'r' must not consume 'ramesh' and strand the real 'ramesh' token.
  const out = matchNames('R Ramesh', 'Ramesh Kumar');
  assert.equal(out.matched, false);
  assert.equal(out.score, 0.5);
});

test('a missing extracted name can never be a match', () => {
  const out = matchNames('Ramesh Kumar', null);
  assert.deepEqual(out, { matched: false, score: 0, expected: 'Ramesh Kumar', found: null });
});

/*
 * Below: the adversarial half. An initial fits EVERYONE — "R K" is Rajesh
 * Khanna, Ravi Kapoor and Rekha Kaur alike — so initials are unverified
 * evidence and must never carry a PASS on their own. A false pass here tells a
 * technician their identity document is confirmed when nothing was confirmed;
 * a false fail only asks for a clearer photo.
 */

test('an all-initials name never matches a full name', () => {
  const out = matchNames('Rajesh Khanna', 'R K');
  assert.equal(out.matched, false, 'initials alone are not evidence of identity');
  assert.ok(out.score < 0.85, `expected a sub-threshold score, got ${out.score}`);

  // …in either direction: the typed side can be the initials too.
  assert.equal(matchNames('R K', 'Rajesh Khanna').matched, false);
  assert.equal(matchNames('A B', 'Anil Bhatt').matched, false);
});

test('one initials string can never confirm two different people', () => {
  const first = matchNames('A B', 'Anil Bhatt');
  const second = matchNames('A B', 'Amit Bose');
  assert.equal(first.matched, false);
  assert.equal(second.matched, false);

  // Same with a real surname carrying the only verbatim evidence: two
  // unverified initials must not out-vote the one token we actually checked.
  assert.equal(matchNames('A B Kumar', 'Amit Bose Kumar').matched, false);
  assert.equal(matchNames('A B Kumar', 'Anil Bhatt Kumar').matched, false);
});

test('an initial matching an initial is still not verified evidence', () => {
  // 'r' === 'r' is token equality, but it verifies nothing: 'R Kumar' and
  // 'R Khanna' are different people and 'R K' must confirm neither.
  assert.equal(matchNames('R K', 'R Kumar').matched, false);
  assert.equal(matchNames('R K', 'R Khanna').matched, false);
});

test('a single-token name never matches a different single-token name sharing a first letter', () => {
  assert.equal(matchNames('Ravi', 'Rajesh').matched, false);
  assert.equal(matchNames('R', 'Rajesh').matched, false);
  assert.equal(matchNames('Rajesh', 'R').matched, false);
  assert.ok(matchNames('R', 'Rajesh').score < 0.85);
});

test('an empty or whitespace-only side can never match', () => {
  for (const blank of ['', '   ', '\t\n', '.', null, undefined]) {
    assert.equal(matchNames('Ramesh Kumar', blank).matched, false, `found=${JSON.stringify(blank)}`);
    assert.equal(matchNames(blank, 'Ramesh Kumar').matched, false, `expected=${JSON.stringify(blank)}`);
  }
  // Two blanks are not "identical names".
  assert.equal(matchNames('   ', '   ').matched, false);
});

test('a fuller name on the card still matches when every typed token is verbatim', () => {
  // Kept deliberately: Aadhaar routinely carries a father's/extra surname the
  // technician does not type. Every token of the shorter side is verbatim
  // present, so this is corroboration, not guesswork.
  assert.equal(matchNames('Ramesh Kumar', 'Ramesh Kumar Singh').matched, true);
});
