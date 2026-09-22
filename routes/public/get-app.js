/*
 * GET /get-app/:code? — ONE install link for a technician referral invite.
 *
 * A shared invite used to carry the SHARER's store link, so an iPhone user
 * forwarding to an Android friend sent an App Store URL (and vice versa). This
 * link is platform-neutral: it reads the opener's User-Agent and 302s to the
 * right store.
 *
 *   Android       → Play Store, with `referrer=ref%3D<code>` so the installed
 *                   app prefills the code (see the app's referralShare.ts).
 *   iPhone / iPad → App Store. iOS hands a fresh install nothing, so the code
 *                   still travels as plain text in the message itself.
 *   Anything else → a tiny page with both store buttons and the code. Covers
 *                   desktops, link-preview bots, and iPadOS, which sends a
 *                   Mac User-Agent that is indistinguishable server-side.
 *
 * Mounted at the Express ROOT (server.js), like /book, so the link stays short
 * in a WhatsApp message. No auth by design: the code is a public referral code
 * the technician is deliberately handing out, not a credential. A malformed
 * code is dropped rather than rejected — the link must still get someone to
 * the app.
 */

const router = require('express').Router();

const { storeUrlFor } = require('./app-version');

// Same shape the backend issues and the app accepts.
const CODE_REGEX = /^EF[A-Z0-9]{4,20}$/;

/** Play's referrer convention: one URL-encoded `key=value` blob. Mirrors the app. */
function withPlayReferrer(storeUrl, code) {
  if (!code) return storeUrl;
  const separator = storeUrl.includes('?') ? '&' : '?';
  return `${storeUrl}${separator}referrer=${encodeURIComponent(`ref=${code}`)}`;
}

function platformOf(userAgent) {
  const ua = String(userAgent || '');
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  return null;
}

// `code` is regex-validated before it reaches this, so interpolation is safe.
function chooserHtml(playUrl, appStoreUrl, code) {
  const btn = 'display:block;margin:12px 0;padding:14px;border-radius:10px;background:#111827;color:#fff;text-decoration:none;font-weight:600';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Get EasyFix</title>
  </head>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;background:#f6f7f9;color:#1f2937;min-height:100vh;display:flex;align-items:center;justify-content:center">
    <div style="background:#fff;border-radius:12px;padding:32px 28px;max-width:360px;margin:24px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.08)">
      <h1 style="font-size:20px;margin:0 0 8px">Get the EasyFix App</h1>
      ${code ? `<p style="margin:0 0 16px">Referral code: <strong>${code}</strong></p>` : ''}
      <a style="${btn}" href="${playUrl}">Get It on Google Play</a>
      <a style="${btn}" href="${appStoreUrl}">Download on the App Store</a>
    </div>
  </body>
</html>`;
}

router.get('/get-app/:code?', (req, res) => {
  const raw = String(req.params.code || '').trim().toUpperCase();
  const code = CODE_REGEX.test(raw) ? raw : '';
  const playUrl = withPlayReferrer(storeUrlFor('android'), code);
  const appStoreUrl = storeUrlFor('ios');

  // The answer depends on the device, so no shared cache may store one variant.
  res.set('Cache-Control', 'no-store');
  res.set('Vary', 'User-Agent');

  const platform = platformOf(req.get('user-agent'));
  if (platform === 'android') return res.redirect(302, playUrl);
  if (platform === 'ios') return res.redirect(302, appStoreUrl);
  return res.type('html').send(chooserHtml(playUrl, appStoreUrl, code));
});

module.exports = router;
module.exports.platformOf = platformOf;
module.exports.withPlayReferrer = withPlayReferrer;
