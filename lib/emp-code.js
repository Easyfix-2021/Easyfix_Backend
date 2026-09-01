'use strict';

/*
 * Employee code — the ONE definition of the format.
 *
 * The owner asked for a shared implementation specifically to cut duplication
 * and defect risk, so the REGEX, the PADDING and the PARSE each exist exactly
 * once, here. Anything that needs to validate, render, read or allocate an
 * employee code requires this module; nothing re-derives the shape. A second
 * copy of the regex or of `padStart(6, '0')` anywhere in the repo is a bug by
 * definition — tests/emp-code.test.js fails the build if one appears.
 *
 * THE PREFIX IS A PARAMETER, NOT A LITERAL (2026-09-01). It was briefly written
 * as a hardcoded 'EF' in eight places here, and the real codes turned out to be
 * E200244 — one letter, not two. Everything below is now derived from
 * EMP_CODE_PREFIX, including the SQL, so changing the scheme is a one-line edit
 * rather than a hunt. Change it in src/lib/emp-code.ts in the CRM in the same
 * commit: the frontend renders the prefix as a fixed affix and posts only the
 * digits, so the two must agree on what gets prepended.
 *
 * WHY THAT MATTERS MORE THAN USUAL HERE: the format is the ONLY thing standing
 * between two concurrent creates and a duplicate code. tbl_user has no UNIQUE
 * index on user_code and we are forbidden from adding one (it is LEGACY and
 * shared by five services), so nothing downstream will catch a collision. A
 * second copy of the regex that drifted by one character — `\d{5}`, a missing
 * anchor, a case-insensitive flag — would silently widen or narrow the set of
 * rows nextEmpCode() takes its MAX over, and the next allocation would hand out
 * a code that already exists.
 */

/*
 * Anchored, case-SENSITIVE, and deliberately NOT /g.
 *
 * No /g flag: a global regex carries `lastIndex` across calls, so a shared
 * module-level one would make `.test()` stateful and return false for every
 * other caller. There is nothing to iterate here anyway.
 */
const EMP_CODE_PREFIX = 'E';
const EMP_CODE_DIGITS = 6;

/*
 * Asserted, not assumed. The prefix is interpolated into a MySQL REGEXP below,
 * so a value carrying a regex metacharacter would silently change which rows
 * nextEmpCode takes its MAX over — and this module's whole job is that the set
 * is exactly right. Letters only, checked at load, so a bad edit fails at boot
 * rather than at the next allocation.
 */
if (!/^[A-Z]+$/.test(EMP_CODE_PREFIX)) {
  throw new Error(`EMP_CODE_PREFIX must be capital letters only, got ${JSON.stringify(EMP_CODE_PREFIX)}`);
}

const EMP_CODE_RE = new RegExp(`^${EMP_CODE_PREFIX}\\d{${EMP_CODE_DIGITS}}$`);

/** Highest allocatable sequence — six digits, so E999999. */
const MAX_EMP_SEQ = 10 ** EMP_CODE_DIGITS - 1;

/** MySQL named lock guarding generate-then-INSERT. See createUser(). */
const EMP_CODE_LOCK = 'easyfix_emp_code';

/**
 * 'E200244' -> 200244. Anything that is not exactly this format -> null.
 *
 * Returns null rather than throwing because the overwhelmingly common caller is
 * "is this legacy value one of ours?", asked of columns that are NULL for every
 * production row today and carry pre-EasyFix junk ('U501') on some others.
 */
function parseEmpCode(code) {
  if (typeof code !== 'string' || !EMP_CODE_RE.test(code)) return null;
  // Safe: the regex has already proven everything after the prefix is digits.
  return Number(code.slice(EMP_CODE_PREFIX.length));
}

/**
 * 200244 -> 'E200244'. Throws above E999999 (and on anything that is not a
 * non-negative integer).
 *
 * Throwing on overflow is the point: the failure it prevents is silently
 * emitting 'E1000000' — seven digits, which parseEmpCode then rejects, so the
 * very next allocation would take its MAX over a set that no longer contains
 * the highest code and re-issue one already in use. A loud throw at the moment
 * the space runs out is recoverable (widen the format); a quiet one is not.
 *
 * 0 is accepted so that format∘parse is the identity across the whole regex
 * domain — 'E000000' matches EMP_CODE_RE, so it must round-trip. Allocation
 * never produces it: nextEmpCode() starts at 1.
 */
function formatEmpCode(seq) {
  /*
   * NUMBER ONLY — no Number() coercion, deliberately. `Number(null)`,
   * `Number('')`, `Number(false)` and `Number([])` are all 0, so a coercing
   * version quietly turns a missing value into the perfectly-valid-looking
   * 'E000000' instead of failing. The only caller that matters (nextEmpCode)
   * always has a real number, so nothing is lost by refusing the rest.
   */
  const n = seq;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
    throw new Error(`employee code sequence must be a non-negative integer, got ${JSON.stringify(seq)}`);
  }
  if (n > MAX_EMP_SEQ) {
    throw new Error(`employee code space exhausted — ${n} exceeds ${MAX_EMP_SEQ} (${EMP_CODE_PREFIX}${MAX_EMP_SEQ}); widen the format before allocating more`);
  }
  return EMP_CODE_PREFIX + String(n).padStart(EMP_CODE_DIGITS, '0');
}

/**
 * The next free code, as a string. MUST be called on a connection already
 * holding GET_LOCK(EMP_CODE_LOCK) — see the call site in
 * services/user.service.js#createUser for why, and for the release contract.
 *
 * `conn` is a mysql2 connection or pool; it is passed in rather than imported
 * so the allocation reads on the SAME session that will do the INSERT. Reading
 * from the pool instead would take a different connection, which does not hold
 * the lock and can see a different snapshot.
 *
 * Cold start: on a host where no row matches the format yet, MAX() over an
 * empty set is SQL NULL, `Number(null) || 0` is 0, and the first code issued is
 * E000001. That is deliberate per the owner — ops seed the real codes manually
 * first, and this only ever runs ahead of them on a fresh/QA database.
 */
async function nextEmpCode(conn) {
  /*
   * REGEXP, not LIKE: a LIKE with underscores would match letters too and CAST that to
   * 0, which is harmless, but it would also match nothing useful that REGEXP
   * misses. The pattern mirrors EMP_CODE_RE — note MySQL's REGEXP is
   * case-INSENSITIVE on a non-binary column, so it matches a hypothetical
   * lowercase 'ef000123' that EMP_CODE_RE would reject. That asymmetry is
   * deliberately in the SAFE direction: it can only make the MAX larger, i.e.
   * skip a sequence number, never re-issue one.
   */
  const [[row]] = await conn.query(
    `SELECT MAX(CAST(SUBSTRING(user_code, ${EMP_CODE_PREFIX.length + 1}) AS UNSIGNED)) AS max_seq
       FROM tbl_user
      WHERE user_code REGEXP '^${EMP_CODE_PREFIX}[0-9]{${EMP_CODE_DIGITS}}$'`
  );
  return formatEmpCode((Number(row && row.max_seq) || 0) + 1);
}

/*
 * The operator-facing sentence for a malformed code — DERIVED, like everything
 * else here, and for a sharper reason than tidiness.
 *
 * It was three hardcoded copies reading `"EF" followed by exactly 6 digits
 * (e.g. EF000123)`, and they survived the 2026-09-01 EF -> E correction because
 * that commit centralised the REGEX and stopped there. The result shipped: the
 * regex rejected the operator's typo correctly, then the message told them to
 * type EF000123 — a value the same regex rejects. A wrong error message is not
 * cosmetic here; it is a loop the operator cannot escape, and it is invisible to
 * every test that asserts only that a 400 happened.
 *
 * A fragment rather than a whole sentence because the two layers name the field
 * differently — Joi says "Employee Code" (the label on the form), the service
 * says "user_code" (the payload key the API contract uses). Both are right for
 * their audience, and only the format half was ever duplicated.
 */
const EMP_CODE_FORMAT_HINT =
  `must be "${EMP_CODE_PREFIX}" followed by exactly ${EMP_CODE_DIGITS} digits (e.g. ${formatEmpCode(123)})`;

module.exports = {
  EMP_CODE_PREFIX, EMP_CODE_DIGITS, EMP_CODE_RE, MAX_EMP_SEQ, EMP_CODE_LOCK,
  EMP_CODE_FORMAT_HINT,
  parseEmpCode, formatEmpCode, nextEmpCode,
};
