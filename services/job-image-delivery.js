/*
 * Resolve a stored tbl_job_image value into something a BROWSER can fetch.
 *
 * Extracted from routes/admin/jobs.js on 2026-09-10 so that two routes share
 * ONE definition of "where does this image actually live":
 *
 *   GET /admin/jobs/images/:imageId/file  → redirects or streams
 *   GET /admin/jobs/images/:imageId/url   → returns the URL as JSON
 *
 * The second exists so the CRM can stop putting the session JWT in the image
 * URL. An <img src> carries no Authorization header, so the file route accepts
 * `?token=<jwt>` — which puts a live session token into browser history, the
 * Referer header, and every proxy and access log in between. Fetching a JSON
 * url first (where the header works) and rendering a plain <img> at the
 * returned URL removes that entirely, and keeps <img>'s no-CORS behaviour:
 * a fetch() of an S3 presigned URL would need a bucket CORS policy that a
 * plain <img> does not.
 *
 * Kinds returned:
 *   { kind: 's3',       url }   presigned, short TTL, object confirmed present
 *   { kind: 'legacy',   url }   https URL on an ALLOWLISTED host, HEAD-verified
 *   { kind: 'local',    path }  a file on this host — caller must stream it
 *   { kind: 'base-url', url }   absolute FILE_BASE_URL (prod Nginx)
 *   { kind: 'none',     reason} nothing resolvable
 */
const fs = require('fs');
const path = require('path');
const s3Storage = require('../utils/s3-storage');

const LEGACY_HOSTS = () => (process.env.LEGACY_FILE_HOSTS || 'core.easyfix.in')
  .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

/*
 * What a tbl_job_image row may legitimately hold. video/ added 2026-09-30:
 * the legacy uploader stores customer .mp4 clips in the same table and the
 * same upload_jobs dir (job 545900), and an image-only allowlist refused a
 * file the host was serving with 200. The HTML error page is still refused.
 */
const isMediaType = (ctype) => ctype.startsWith('image/') || ctype.startsWith('video/') || ctype.startsWith('application/pdf');

/*
 * Is there really an image at this legacy URL?
 *
 * A redirect that cannot fail is not a resolution. When the file is absent the
 * legacy host answers with a ~236-byte text/html error page; the CRM fetches
 * these as <img> no-cors subresources, so Chrome's Opaque Response Blocking
 * refuses the HTML and reports net::ERR_BLOCKED_BY_ORB with no status and zero
 * bytes — an opaque browser error where the operator should have seen our own
 * "Image not found" state.
 *
 * REFUSES ONLY ON POSITIVE EVIDENCE: a HEAD that times out or errors still
 * says "usable", so a transient fault cannot hide a file that is really there.
 */
async function legacyUrlHasImage(url) {
  try {
    const head = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(Number(process.env.LEGACY_FILE_HEAD_TIMEOUT_MS || 2500)),
    });
    const ctype = String(head.headers.get('content-type') || '').toLowerCase();
    if (!head.ok || (ctype && !isMediaType(ctype))) {
      return { usable: false, why: `status ${head.status}, content-type ${ctype || 'none'}` };
    }
    return { usable: true, why: 'ok' };
  } catch (err) {
    return { usable: true, why: `unverified (${err && err.name ? err.name : 'error'})` };
  }
}

/*
 * STRICT variant, for PROBING candidate paths rather than validating a stored one.
 *
 * The defaults are deliberately opposite. legacyUrlHasImage() above answers
 * "usable" when it cannot tell, because refusing a stored URL on a network blip
 * would hide a file that is really there. Here we are guessing at directories,
 * so an unverifiable answer must NOT be accepted — otherwise a timeout on the
 * first candidate sends the browser to a URL nobody confirmed, and for a job
 * whose file lives in the second directory that is a redirect to a 404.
 */
async function probeHasFile(url) {
  try {
    const head = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(Number(process.env.LEGACY_FILE_HEAD_TIMEOUT_MS || 2500)),
    });
    if (!head.ok) return false;
    const ctype = String(head.headers.get('content-type') || '').toLowerCase();
    return isMediaType(ctype);
  } catch {
    return false;
  }
}

/*
 * Where a BARE FILENAME lives on the legacy file host.
 *
 * Images sit under <base>/upload_jobs/, feedback PDFs under
 * <base>/feedback_jobs/ — measured 2026-09-10 on job 530707, whose seven rows
 * split across BOTH: six .jpg in upload_jobs and feedback530707.pdf in
 * feedback_jobs. One hardcoded directory would have restored six tiles and
 * left the seventh broken, which is the kind of fix that looks complete.
 *
 * `feedback*` is tried first for names that look like one — a hint that saves a
 * round trip, never a rule: both directories are always tried.
 */
function legacyDirsFor(name) {
  const dirs = (process.env.LEGACY_FILE_DIRS || 'upload_jobs,feedback_jobs')
    .split(',').map((d) => d.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean);
  if (/^feedback/i.test(name)) return dirs.slice().sort((a, b) => (a.includes('feedback') ? -1 : b.includes('feedback') ? 1 : 0));
  return dirs;
}

async function resolve(storedRaw, { logger } = {}) {
  const stored = String(storedRaw || '').trim();
  if (!stored) return { kind: 'none', reason: 'empty stored value' };

  // (1) S3 — the stored key, plus the two legacy prefixes older rows used.
  if (s3Storage.isEnabled()) {
    const candidates = [stored];
    if (!stored.startsWith('Job_Images/') && !stored.startsWith('JobSupportings/')) {
      candidates.push(`JobSupportings/${path.basename(stored)}`);
      candidates.push(`Job_Images/${path.basename(stored)}`);
    }
    for (const key of candidates) {
      try {
        if (await s3Storage.exists(key)) {
          return { kind: 's3', url: await s3Storage.getPresignedUrl(key) };
        }
      } catch (e) {
        if (logger) logger.warn({ key, err: e && e.message }, 's3 lookup failed — falling through to local');
        break;
      }
    }
  }

  // (2) Local disk — writeBuffer-fallback uploads and pre-S3 legacy files.
  const roots = [
    process.env.UPLOAD_JOB_FILES,
    process.env.UPLOAD_ROOT_PATH,
    './uploads/upload_jobs',
    './uploads',
  ].filter(Boolean);
  const relForms = [stored, path.basename(stored)];
  for (const root of roots) {
    const absRoot = path.resolve(root);
    for (const rel of relForms) {
      const candidate = path.resolve(absRoot, rel.replace(/^\/+/, ''));
      // Path-traversal guard: candidate MUST sit inside absRoot.
      if (!candidate.startsWith(absRoot + path.sep) && candidate !== absRoot) continue;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return { kind: 'local', path: candidate };
      }
    }
  }

  // (3) The stored value is ITSELF an absolute URL on a host we own.
  if (/^https?:\/\//i.test(stored)) {
    let parsed = null;
    try { parsed = new URL(stored); } catch { parsed = null; }
    if (parsed && LEGACY_HOSTS().includes(parsed.hostname.toLowerCase())) {
      // https-upgraded: rows store http://, the CRM is https, and a browser
      // blocks an http image on an https page. The host 301s anyway.
      parsed.protocol = 'https:';
      const verdict = await legacyUrlHasImage(parsed.toString());
      if (verdict.usable) return { kind: 'legacy', url: parsed.toString(), verdict: verdict.why };
      return { kind: 'none', reason: `legacy host has no image (${verdict.why})` };
    }
    // Host-allowlisted: this URL comes from a database column. Redirecting to
    // an arbitrary host would be an open redirect.
    return { kind: 'none', reason: `absolute URL on a non-allowlisted host${parsed ? ' ' + parsed.hostname : ''}` };
  }

  // (4) Absolute FILE_BASE_URL (prod Nginx). Never a relative base — that
  // would bounce back to this backend, which has no handler.
  const fileBase = process.env.FILE_BASE_URL || '';
  if (/^https?:\/\//i.test(fileBase)) {
    const base = fileBase.replace(/\/+$/, '');
    const url = stored.includes('/')
      ? `${base}/${stored.replace(/^\/+/, '')}`
      : `${base}/upload_jobs/${stored}`;
    return { kind: 'base-url', url };
  }

  /*
   * (5) BARE FILENAME still served by the legacy file host.
   *
   * The gap that made job 530707 show seven "Image not found" tiles while every
   * file was present and returning 200. Rows written by the legacy uploader
   * store a plain name — `530707_checkin_20260822144344.jpg` — not a URL, so
   * branch (3) never fires; and production sets FILE_BASE_URL to the RELATIVE
   * `/easydoc`, so branch (4) correctly refuses it (redirecting there would
   * bounce back to this backend, which serves no static files). Nothing looked
   * on the host where the file actually was.
   *
   * LAST, not earlier: an absolute FILE_BASE_URL is a CONFIGURED location and
   * must win over probing directories. Placing this before (4) broke two
   * existing tests, correctly — configuration beats inference.
   *
   * Each candidate is PROBED before use, so this can only ever redirect to a
   * URL confirmed to hold an image or a PDF.
   */
  if (!stored.includes('/') && LEGACY_HOSTS().length) {
    const base = String(process.env.FILE_BASE_URL || '/easydoc').replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+|\/+$/g, '') || 'easydoc';
    for (const host of LEGACY_HOSTS()) {
      for (const dir of legacyDirsFor(stored)) {
        const url = `https://${host}/${base}/${dir}/${encodeURIComponent(stored)}`;
        // eslint-disable-next-line no-await-in-loop
        if (await probeHasFile(url)) {
          return { kind: 'legacy', url, verdict: `bare filename found in ${dir}` };
        }
      }
    }
    if (logger) logger.warn({ stored }, 'bare filename not found in any legacy directory');
  }

  return { kind: 'none', reason: 'not in S3, no local file, no absolute FILE_BASE_URL' };
}

/*
 * A job-keyed legacy DOCUMENT at a known directory + name — the Jobsheet
 * (feedback_jobs/feedback<jobId>.pdf) and the Estimate
 * (estimateapproval/Estimate_Approval_<jobId>.pdf). No DB row names these;
 * only the legacy Java system writes them, to the legacy file host. The portal
 * used to join a RELATIVE /easydoc path onto its own host, which serves none of
 * it (2026-09-30). Returns an https URL confirmed by probeHasFile, or null.
 */
async function resolveLegacyFile(dir, name) {
  const base = String(process.env.FILE_BASE_URL || '/easydoc').replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+|\/+$/g, '') || 'easydoc';
  for (const host of LEGACY_HOSTS()) {
    const url = `https://${host}/${base}/${dir}/${encodeURIComponent(name)}`;
    // eslint-disable-next-line no-await-in-loop
    if (await probeHasFile(url)) return url;
  }
  return null;
}

module.exports = { resolve, resolveLegacyFile, legacyUrlHasImage, probeHasFile, legacyDirsFor,  };
