/*
 * Shared "is this a real address" validation + dedupe, extracted out of
 * routes/admin/jobs.js's sendEstimateEmail() so
 * services/material-client-request.service.js does not carry a second copy
 * of the same regex/Set/skip-log dance. Each caller still decides its OWN
 * recipient-composition policy (union vs. fallback, owner included or not);
 * only the "trim, validate, dedupe, remember what was rejected" part is
 * common, so that is all this module owns.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * @param {{value: string, source: string}[]} candidates
 * @returns {{recipients: string[], skipped: {value: string, source: string}[]}}
 */
function collectValidEmails(candidates) {
  const recipients = new Set();
  const skipped = [];
  for (const { value: raw, source } of candidates || []) {
    const v = String(raw || '').trim();
    if (!v) continue;
    if (EMAIL_RE.test(v)) recipients.add(v);
    else skipped.push({ value: v, source });
  }
  return { recipients: [...recipients], skipped };
}

module.exports = { EMAIL_RE, collectValidEmails };
