'use strict';

/*
 * GET /api/public/verify-technician/:token — the page behind the I-Card QR.
 *
 * TRULY UNAUTHENTICATED. A customer at their front door scans the technician's
 * card with the stock camera app, so the response must be a human-readable HTML
 * PAGE — JSON would be useless to the person who needs the answer. There is no
 * view engine in this project; the inline template-literal + res.send() shape
 * below is the same one routes/public/email-verify.js uses.
 *
 * ALWAYS HTTP 200, even for a bad token. A browser shown a 4xx renders its own
 * error chrome, and the scanner learns nothing. Every outcome is a designed
 * page instead — and a forged token and an unknown technician render the SAME
 * page, so this endpoint cannot be used to test which tokens are real.
 *
 * The verdict is read from the database at scan time, so a technician who was
 * deactivated or blacklisted after their card was rendered shows as NOT
 * AUTHORISED on the card they are holding.
 */

const router = require('express').Router();
const logger = require('../../logger');
const { rateLimit } = require('../../middleware/rate-limit');
const verification = require('../../services/technician-verification.service');

/*
 * Public and unauthenticated, so it is scrapeable by construction. The token is
 * unguessable, which makes enumeration useless, but a leaked card should not
 * become a free lookup service either. Keyed on IP because there is no identity
 * here to key on. Generous enough that a customer re-scanning, or a household
 * behind one NAT, never sees a limit.
 */
const scanLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  key: (req) => `verify-tech:${req.ip}`,
});

/*
 * Escape EVERY interpolated value. email-verify.js interpolates without
 * escaping and is safe only because its values are hardcoded constants; these
 * come from tbl_easyfixer, where a name is operator-entered free text. An
 * unescaped name is stored XSS on a public page.
 */
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const SHELL = (title, bodyHtml) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} · EasyFix</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:#F4F5F7; color:#171B1F;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif; }
  .card { max-width:420px; margin:24px auto; background:#fff; border-radius:16px;
          padding:24px; box-shadow:0 2px 14px rgba(0,0,0,.08); }
  .brand { font-weight:700; font-size:14px; letter-spacing:.08em; color:#C42430;
           text-transform:uppercase; margin-bottom:18px; }
  .verdict { border-radius:12px; padding:14px 16px; font-weight:700; font-size:17px; }
  .ok   { background:#E7F5EC; color:#166534; }
  .bad  { background:#FDECEC; color:#991B1B; }
  .name { font-size:24px; font-weight:700; margin:20px 0 2px; }
  .muted{ color:#5B6470; font-size:14px; margin:0 0 16px; }
  dl { display:grid; grid-template-columns:auto 1fr; gap:8px 16px; margin:16px 0 0; font-size:15px; }
  dt { color:#5B6470; } dd { margin:0; font-weight:600; }
  .foot { margin-top:22px; padding-top:14px; border-top:1px solid #E5E7EB;
          color:#5B6470; font-size:12px; line-height:1.5; }
</style></head>
<body><div class="card"><div class="brand">EasyFix Verification</div>
${bodyHtml}
<p class="foot">Checked against EasyFix records just now. If this does not match the
person in front of you, do not proceed &mdash; contact EasyFix support.</p>
</div></body></html>`;

const UNVERIFIED = SHELL('Not Verified', `
  <div class="verdict bad">Could Not Be Verified</div>
  <p class="muted" style="margin-top:16px">This code is not a valid EasyFix technician ID.
  It may have been mistyped, damaged, or it did not come from an EasyFix card.</p>`);

function row(label, value) {
  return value ? `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>` : '';
}

function page(result) {
  if (!result.found) return UNVERIFIED;

  const idLabel = `EF-${result.efrId}`;
  if (!result.authorized) {
    /*
     * Deliberately does NOT say WHY — not blacklisted, not suspended, not the
     * reason text. The scanner needs one bit ("do not proceed"); anything more
     * publishes an internal employment decision about a named person.
     */
    return SHELL('Not Authorised', `
      <div class="verdict bad">Not Authorised</div>
      <p class="muted" style="margin-top:16px">This ID belongs to EasyFix records, but the
      holder is <strong>not currently authorised</strong> to carry out EasyFix work.
      Please do not proceed, and report this to EasyFix support.</p>
      <dl>${row('EasyFix ID', idLabel)}</dl>`);
  }

  return SHELL('Verified', `
    <div class="verdict ok">Verified &amp; Currently Active</div>
    <p class="name">${esc(result.name || 'EasyFix Technician')}</p>
    <p class="muted">Authorised EasyFix technician</p>
    <dl>
      ${row('EasyFix ID', idLabel)}
      ${row('City', result.city)}
      ${row('Services', result.categories.join(', '))}
    </dl>`);
}

router.get('/:token', scanLimiter, async (req, res) => {
  try {
    const result = await verification.verifyByToken(req.params.token);
    // No-store: the verdict is only true for the instant it was read.
    res.set('Cache-Control', 'no-store, max-age=0');
    res.type('html').status(200).send(page(result));
  } catch (e) {
    // Never leak internals to a stranger's browser; render the neutral page.
    logger.warn('Technician verification failed · ' + e.message);
    res.set('Cache-Control', 'no-store, max-age=0');
    res.type('html').status(200).send(UNVERIFIED);
  }
});

module.exports = router;
