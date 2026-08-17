const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

function monthParts(month) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(month || ''));
  if (!match) {
    const error = new Error('month must use YYYY-MM');
    error.status = 400;
    throw error;
  }
  return { year: Number(match[1]), month: Number(match[2]) };
}

function shiftMonth(month, delta) {
  const p = monthParts(month);
  const d = new Date(Date.UTC(p.year, p.month - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthBounds(month) {
  monthParts(month);
  return { start: `${month}-01`, end: `${shiftMonth(month, 1)}-01` };
}

function currentIstMonth(now = new Date()) {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

function todayIst(now = new Date()) {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  return shifted.toISOString().slice(0, 10);
}

function shiftYmd(ymd, days) {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function monthLabel(month) {
  const p = monthParts(month);
  return new Intl.DateTimeFormat('en-IN', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(Date.UTC(p.year, p.month - 1, 1)));
}

/**
 * Turn a DATETIME string read out of MySQL into a real instant.
 *
 * ─── Why this exists ─────────────────────────────────────────────────────
 *
 * The pool runs `dateStrings: true` with session timezone `+05:30`, so every
 * DATETIME comes back as an IST WALL-CLOCK string — "2026-08-17 14:30:00"
 * means half past two in India, with no offset attached.
 *
 * `new Date("2026-08-17 14:30:00")` parses that in the PROCESS's timezone.
 * On a developer's laptop set to Asia/Kolkata that is accidentally correct,
 * which is exactly why this is easy to miss: the containers have no TZ set,
 * so they run UTC, and the same string resolves 5 hours 30 minutes LATER
 * than intended. Anything comparing such a value against `Date.now()` — an
 * OTP expiry, a token TTL, a "has this passed yet" check — silently grants
 * an extra 5½ hours in production and behaves perfectly in dev.
 *
 * Appending the offset makes the string self-describing, so the parse no
 * longer depends on where the code happens to run.
 *
 * Returns null for null/empty input, and for anything unparseable, so a
 * malformed column value fails CLOSED at the caller (treated as expired)
 * rather than becoming an Invalid Date whose comparisons are all false —
 * which would read as "not expired" and never let the value lapse.
 */
function istStringToDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const s = String(value).trim();
  // Already carries a zone (ISO with Z or ±hh:mm) — trust it as-is.
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const asIs = new Date(s);
    return Number.isNaN(asIs.getTime()) ? null : asIs;
  }
  const d = new Date(`${s.replace(' ', 'T')}+05:30`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Has an IST wall-clock DATETIME string already passed?
 *
 * Unparseable or missing → TRUE (expired). A TTL you cannot read is not a
 * TTL you should honour.
 */
function istIsPast(value, now = Date.now()) {
  const d = istStringToDate(value);
  return d === null || d.getTime() < now;
}

module.exports = {
  currentIstMonth,
  istIsPast,
  istStringToDate,
  monthBounds,
  monthLabel,
  monthParts,
  shiftMonth,
  shiftYmd,
  todayIst,
};
