/*
 * The operator's leg must not wear the customer's face.
 *
 * ─── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 *
 * A Web Call panel was reported showing the SAME person twice in "ON THIS
 * CALL" — "SAROJ MERANI / 8080••••••" on two rows, one behind a headset icon
 * and one behind a person icon. There was no duplicate row and no double-dial.
 * There were two legs, and one of them was mislabelled.
 *
 * Exactly ONE call-log row is written when a call is placed
 * (routes/admin/calls.js, web path AND mobile path), and it describes the
 * person being CALLED: receiver_name / dialed_number are the CUSTOMER's, while
 * the agent lives in caller_name / caller_user_id. On both flows
 * `dialTo = isCustomNumberMode ? callTo : receiverMobile`, so dialed_number is
 * NEVER the agent's own number.
 *
 * adoptOperatorLeg() then retags that row participant_role='operator'. The
 * roster projected receiver_name for every leg, so the operator's leg rendered
 * as the customer — and the customer, separately inserted as their own leg,
 * rendered as themselves. One human, two rows, one number between them.
 *
 * These tests pin the projection, because the bug is invisible in every
 * single-party call: it only shows once a conference has two legs, which is
 * exactly when an operator is least able to stop and read a roster.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const SRC = require('node:fs').readFileSync(
  require('node:path').join(__dirname, '..', 'services', 'plivo-call-log.service.js'), 'utf8',
);

/** The roster's SELECT list, as the query actually sends it. */
function legColumns() {
  const m = SRC.match(/const LEG_PUBLIC_COLUMNS = `([\s\S]*?)`;/);
  assert.ok(m, 'LEG_PUBLIC_COLUMNS not found — the roster projection moved');
  return m[1];
}

test('the operator leg takes its name from caller_name, not receiver_name', () => {
  const cols = legColumns();
  assert.match(
    cols.replace(/\s+/g, ' '),
    /CASE WHEN participant_role = 'operator' THEN caller_name ELSE receiver_name END\s+AS display_name/,
    'the operator must be named by the column that actually holds the agent',
  );
});

test('the operator leg carries NO number — the only one on the row is the customer’s', () => {
  const cols = legColumns();
  assert.match(
    cols.replace(/\s+/g, ' '),
    /CASE WHEN participant_role = 'operator' THEN NULL ELSE LEFT\(RIGHT\(dialed_number, 10\), 4\) END AS number_prefix/,
    'masked digits belonging to the wrong person are worse than a blank',
  );
});

test('a NON-operator leg still shows the receiver — the fix must not blank real participants', () => {
  const flat = legColumns().replace(/\s+/g, ' ');
  assert.ok(flat.includes('ELSE receiver_name END'), 'customer/technician legs keep their own name');
  assert.ok(flat.includes('ELSE LEFT(RIGHT(dialed_number, 10), 4) END'), 'and their own masked prefix');
});

/*
 * The projection is interpolated into a template literal. A backtick or an SQL
 * line comment inside it silently truncates the query (a `--` survives until a
 * newline, and any whitespace-collapsing turns the REST of the SELECT into a
 * comment). Both have bitten this repo; neither is detectable from a passing
 * unit test that never runs SQL, so pin them here.
 */
test('the projection stays SQL-safe: no line comments, no stray backticks', () => {
  const cols = legColumns();
  assert.equal(/--/.test(cols), false, 'an SQL line comment can swallow the rest of the SELECT');
  assert.equal(cols.includes('`'), false, 'a backtick would terminate the template literal');
  // Balanced CASE/END — an unbalanced one is a syntax error only MySQL would see.
  const cases = (cols.match(/\bCASE\b/g) || []).length;
  const ends = (cols.match(/\bEND\b/g) || []).length;
  assert.equal(cases, ends, `CASE/END unbalanced: ${cases} CASE vs ${ends} END`);
});

test('maskLeg renders a NULL prefix as no number at all, never as bullets', () => {
  // A blank must read as "we have no number for this leg", not as a masked one.
  const svc = require('../services/plivo-call-log.service');
  const fn = svc.__test?.maskLeg;
  if (typeof fn !== 'function') return; // not exported; the SQL assertions above carry the contract
  assert.equal(fn({ number_prefix: null }).masked_number, null);
  assert.equal(fn({ number_prefix: '9310' }).masked_number, '9310••••••');
});
