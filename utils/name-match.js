/*
 * name-match.js — PURE person-name comparison. No I/O, no DB, no network, so it
 * is unit-testable on its own (tests/aadhaar-name-match.test.js).
 *
 * Built for "does the name the technician TYPED agree with the name an OCR/AI
 * step READ off an identity document?". Identity documents reorder given name
 * and surname, drop or add a middle name, print an initial instead of a full
 * given name, and carry honorifics — so a raw string compare is useless here.
 * We compare TOKEN SETS instead.
 *
 * NEVER log the inputs or the outputs of this module — both sides are PII.
 *
 * Scoring:
 *   score = (exact + min(initials, exact)) / max(2, min(tokensA, tokensB))
 *
 * Two guards, both load-bearing:
 *
 *   `max(2, …)` stops a single shared token from being a pass: "Ramesh" vs
 *   "Ramesh Kumar" scores 0.5, not 1.0.
 *
 *   `min(initials, exact)` stops UNVERIFIED evidence from carrying a match. An
 *   initial fits everybody — "R K" is Rajesh Khanna, Ravi Kapoor and Rekha Kaur
 *   alike — so an initial only counts once a FULL token has already
 *   corroborated the name. "R Kumar" vs "Ramesh Kumar" still scores 1.0
 *   (surname verbatim + initial), but "R K" vs "Rajesh Khanna" scores 0. This
 *   is a name gate on an identity document: a false pass confirms a name we
 *   have no evidence for, a false fail just asks for a clearer photo.
 *
 * Two names that normalise to the SAME token multiset are an exact match
 * (score 1) even when that is one token — "Ramesh" vs "Ramesh" is the same name.
 *
 * Token equality is EXACT for tokens of 2+ characters, so "Ram" never matches
 * "Ramesh" by prefix. The single exception is a one-character token, which is
 * an initial ("R Kumar" vs "Ramesh Kumar") and may match by first letter — but
 * only ever as SUPPORTING evidence. A one-character token that happens to equal
 * a one-character token on the other side is still just an initial, so "R K"
 * corroborates neither "R Kumar" nor "R Khanna".
 */

// Dropped only when LEADING (and never when it is the whole name) — 'md' /
// 'mohd' / 'shri' are titles at the front of a name and given names elsewhere.
const HONORIFICS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'mstr', 'master', 'shri', 'sri', 'smt', 'smti',
  'dr', 'doctor', 'prof', 'late', 'md', 'mohd',
]);

const MATCH_THRESHOLD = 0.85;

// lowercase → strip diacritics → punctuation to space → collapse → tokens,
// then drop leading honorifics. Non-Latin scripts survive (a Devanagari name
// still compares against another Devanagari name).
function nameTokens(raw) {
  const tokens = String(raw == null ? '' : raw)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  while (tokens.length > 1 && HONORIFICS.has(tokens[0])) tokens.shift();
  return tokens;
}

// Exact for real tokens; a single character is an initial and matches by letter.
function sameToken(a, b) {
  if (a === b) return true;
  if (a.length === 1) return b.startsWith(a);
  if (b.length === 1) return a.startsWith(b);
  return false;
}

// Two passes so an initial never steals the token an exact match needed:
// ['r','ramesh'] vs ['ramesh','kumar'] must not let 'r' consume 'ramesh'.
//
// The two kinds of hit are counted SEPARATELY and never pooled: `exact` is a
// verbatim multi-character token (real evidence), `initials` is a first-letter
// hit (fits every name with that letter). A one-character token paired in the
// equality pass is an initial too — 'r' === 'r' verifies nothing.
function overlap(a, b) {
  const used = new Array(b.length).fill(false);
  const leftovers = [];
  let exact = 0;
  let initials = 0;
  for (const t of a) {
    const i = b.findIndex((u, idx) => !used[idx] && u === t);
    if (i >= 0) {
      used[i] = true;
      if (t.length > 1) exact += 1; else initials += 1;
    } else leftovers.push(t);
  }
  for (const t of leftovers) {
    const i = b.findIndex((u, idx) => !used[idx] && sameToken(t, u));
    if (i >= 0) { used[i] = true; initials += 1; }
  }
  return { exact, initials };
}

/*
 * matchNames(expected, found) → { matched, score, expected, found }
 *   expected — what the person typed;  found — what the document said.
 * `expected` / `found` are echoed back trimmed (the caller renders them);
 * `found` stays null when nothing was extracted, and a null `found` can never
 * be a match.
 */
function matchNames(expected, found) {
  const expectedOut = String(expected == null ? '' : expected).trim();
  const foundOut = found == null ? null : String(found).trim();
  const a = nameTokens(expectedOut);
  const b = nameTokens(foundOut);
  if (!a.length || !b.length) {
    return { matched: false, score: 0, expected: expectedOut, found: foundOut };
  }
  const identical = a.slice().sort().join(' ') === b.slice().sort().join(' ');
  const { exact, initials } = overlap(a, b);
  // An initial counts only once a full token has already corroborated the name,
  // so initials can support a match but never carry one on their own.
  const hits = exact + Math.min(initials, exact);
  const raw = identical
    ? 1
    : Math.min(1, hits / Math.max(2, Math.min(a.length, b.length)));
  return {
    matched: identical || raw >= MATCH_THRESHOLD,
    score: Math.round(raw * 100) / 100,
    expected: expectedOut,
    found: foundOut,
  };
}

module.exports = { matchNames, nameTokens, MATCH_THRESHOLD };
