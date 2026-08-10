/*
 * Content-Length guard for JSON bodies — a cheap, pre-parse size cap.
 *
 * WHY THIS EXISTS: `/api/admin` is the ONE tier with no rate limit (deliberately
 * — see the Phase 14 note in server.js; capping it would self-DoS a staff
 * data-entry spree). Every other tier is bounded by requests-per-minute, so the
 * bytes one caller can make this process buffer are bounded too. Admin is not.
 * With the global express.json() limit at 10 MB, a single authenticated staff
 * token — or a leaked one — can make the process allocate 10 MB per in-flight
 * request with nothing throttling the rate. This middleware puts a much lower
 * ceiling on the admin tier specifically, without touching the global limit that
 * the public website-booking photo payload depends on.
 *
 * CHEAP ON PURPOSE: it reads ONE header and does no I/O. Mount it BEFORE the
 * body parsers and an oversized body is refused before a single byte is
 * buffered — that is the whole point, and it is why this is a header check and
 * not a stream-counting transform.
 *
 * ─── SCOPE: application/json ONLY ────────────────────────────────────────────
 *
 * The media type is compared exactly, after stripping parameters, so
 * `application/json; charset=utf-8` matches and nothing else does. This is the
 * same media type express.json() itself claims by default, so the guard and the
 * parser it fronts cover exactly the same request population.
 *
 * MULTIPART AND URLENCODED PASS THROUGH UNTOUCHED, and that is load-bearing:
 * `/api/admin/jobs/upload` takes an xlsx as multipart/form-data, as do the
 * pincode / zone / rate-card / user bulk uploads. Those are legitimately
 * multi-MB, they never reach express.json(), and they carry their own multer
 * `limits.fileSize`. Capping them here would break bulk upload outright.
 *
 * ─── NO CONTENT-LENGTH ⇒ PASS ────────────────────────────────────────────────
 *
 * A chunked request (Transfer-Encoding: chunked, no Content-Length) cannot be
 * measured from headers, so it is NOT rejected on that basis — refusing every
 * unmeasurable request would break any legitimate streaming client for no gain.
 * Such a body is still bounded: it falls through to the global
 * express.json({ limit: '10mb' }) in server.js, which counts bytes as it reads
 * and aborts with `entity.too.large` at the global ceiling. So the worst case
 * for an unmeasurable admin body is the global limit, not "unbounded".
 *
 * A hostile caller can of course lie in Content-Length; that is fine. Understate
 * it and body-parser catches the mismatch at the global limit anyway; overstate
 * it and this guard rejects them, which is the outcome we want.
 *
 * Usage:
 *   const { bodySizeLimit } = require('./middleware/body-size-limit');
 *   app.use('/api/admin', bodySizeLimit({ maxBytes: 2 * 1024 * 1024 }));
 */

const { modernError } = require('../utils/response');

function bodySizeLimit({ maxBytes = 2 * 1024 * 1024, label = 'This endpoint' } = {}) {
  const maxMb = (maxBytes / (1024 * 1024)).toFixed(maxBytes % (1024 * 1024) === 0 ? 0 : 1);

  return (req, res, next) => {
    // Media type only — drop ';charset=utf-8' and any other parameter.
    const mediaType = String(req.headers['content-type'] || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (mediaType !== 'application/json') return next();

    // Unmeasurable (chunked) — see the header note. The global parser bounds it.
    const raw = req.headers['content-length'];
    if (raw === undefined || raw === '') return next();

    const declared = Number(raw);
    if (!Number.isFinite(declared) || declared <= maxBytes) return next();

    return modernError(
      res,
      413,
      `${label} accepts at most ${maxMb} MB of JSON — this request declared `
      + `${(declared / (1024 * 1024)).toFixed(2)} MB. Split the payload into smaller batches.`,
    );
  };
}

module.exports = { bodySizeLimit };
