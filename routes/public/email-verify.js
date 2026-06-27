/*
 * /api/public/email-verify/:token — UNAUTHENTICATED email-verification landing.
 *
 * This is the target the technician's mail client opens directly in a browser,
 * so it carries NO auth (mounted ahead of any guard — see routes/public/index.js).
 * The :token segment IS the authority: verifyToken() consumes a single-use,
 * unexpired token and flips is_email_verified on the token's OWN tbl_easyfixer
 * row. A leaked/replayed token only ever touches the one technician it was
 * minted for, and only once.
 *
 * Response is a self-contained HTML page (NOT the modern JSON envelope) so the
 * browser renders a friendly confirmation rather than raw JSON. Always 200 —
 * success and expired/invalid both render a page; the wording differs.
 */

const router = require('express').Router();

const emailVerify = require('../../services/mobile-email-verify.service');
const logger = require('../../logger');

function page({ ok }) {
  const title = ok ? 'Email Verified' : 'Link Expired or Invalid';
  const icon = ok ? '✅' : '⚠️'; // ✅ / ⚠️
  const heading = ok ? 'Email verified' : 'Link expired or invalid';
  const message = ok
    ? 'You can return to the EasyFix app — your email is now verified.'
    : 'This verification link has expired or has already been used. Open the EasyFix app and request a new verification email.';
  const accent = ok ? '#16a34a' : '#d97706';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — EasyFix</title>
</head>
<body style="margin:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:420px;margin:64px auto;padding:0 16px;">
    <div style="background:#ffffff;border-radius:12px;padding:32px 24px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
      <div style="font-size:48px;line-height:1;margin-bottom:16px;">${icon}</div>
      <h1 style="margin:0 0 8px;font-size:20px;color:${accent};">${heading}</h1>
      <p style="margin:0;font-size:14px;color:#4b5563;line-height:1.5;">${message}</p>
    </div>
  </div>
</body>
</html>`;
}

router.get('/:token', async (req, res) => {
  logger.info('Public email-verify landing opened');
  try {
    const result = await emailVerify.verifyToken(req.params.token);
    logger.info('Email-verify token consumed · ok=' + (!!result.ok));
    res.status(200).send(page({ ok: !!result.ok }));
  } catch (err) {
    // Never leak internals to the browser — render the friendly failure page.
    logger.error({ err: err && err.message }, 'email-verify: public verify failed');
    res.status(200).send(page({ ok: false }));
  }
});

module.exports = router;
