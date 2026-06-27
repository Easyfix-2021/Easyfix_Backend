/*
 * /book/:code — public short-link redirect.
 *
 * Mount: at the Express ROOT (server.js: `app.use('/', ...)`), NOT under
 * /api/public. The whole point of a "short URL" is short — burying it
 * under /api/public/... would defeat the byte-saving the WhatsApp
 * template needs. Express's path-prefix matching means /book/:code does
 * not collide with /api/* because /api/* is mounted on its own
 * dedicated routers above; the 404 handler stays last.
 *
 * Why `/book/` (vs a generic `/s/`):
 *   • Self-describing in WhatsApp link previews — the customer reads
 *     "qa.crm.easyfix.in/book/aB7xK2pQ" and intuits "this is a booking
 *     link", not random shortened spam.
 *   • Same byte budget as `/s/` from the template's perspective once
 *     the body variable {{3}} is interpolated — 3 extra chars are
 *     trivial against the ~214 chars saved vs the full JWT URL.
 *
 * Security:
 *   • No auth. By design — these links are sent to customers via
 *     WhatsApp and must work in a plain browser tab.
 *   • The short_code itself is the unguessable secret (62^8 keyspace
 *     ≈ 2.18 × 10^14). The redirect target is whatever the long URL
 *     points at; if the long URL is itself a signed JWT URL
 *     (magic-link case), the destination still enforces token auth.
 *   • Strict :code regex ([A-Za-z0-9]{4,16}) — short-circuits any
 *     funky path content (URL-encoded payloads, traversal sequences)
 *     to a flat 404.
 *
 * Behaviour:
 *   1. Validate code → 404 plain HTML if it doesn't match the regex.
 *   2. resolveCode() → 404 plain HTML if no row.
 *   3. Row exists + expired → 410 GONE with friendly expired page.
 *   4. Row exists + live    → 302 to long_url, fire-and-forget
 *                             click counter.
 */

const router = require('express').Router();

const { pool } = require('../../db');
const urlShortener = require('../../services/url-shortener.service');
const logger = require('../../logger');

const CODE_REGEX = /^[A-Za-z0-9]{4,16}$/;

/**
 * Minimal inline HTML — the project doesn't use a view engine and the
 * spec asks for plain `res.send('<html>...</html>')`. Centralised here
 * so both the 404 and 410 surfaces share the same shell + styling.
 */
function pageHtml(title, message) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
             margin: 0; padding: 0; background: #f6f7f9; color: #1f2937;
             min-height: 100vh; display: flex; align-items: center; justify-content: center; }
      .card { background: #fff; border-radius: 12px; padding: 32px 28px; max-width: 420px;
              margin: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); text-align: center; }
      h1 { font-size: 20px; margin: 0 0 12px 0; color: #111827; }
      p  { font-size: 15px; line-height: 1.5; margin: 0; color: #4b5563; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${title}</h1>
      <p>${message}</p>
    </div>
  </body>
</html>`;
}

router.get('/book/:code', async (req, res) => {
  const code = req.params.code || '';
  logger.info('Short link redirect · code=' + code);

  if (!CODE_REGEX.test(code)) {
    logger.info('Short link failed regex · code=' + code);
    return res
      .status(404)
      .type('html')
      .send(pageHtml('Link not found', 'This short link is not valid. Please check the URL and try again.'));
  }

  let row;
  try {
    row = await urlShortener.resolveCode(code, pool);
  } catch (err) {
    logger.warn({ code, err: err && err.message }, 'url-shortener: resolveCode threw — returning 404');
    return res
      .status(404)
      .type('html')
      .send(pageHtml('Link not found', 'This short link is not valid. Please check the URL and try again.'));
  }

  if (!row) {
    logger.info('Short link not found · code=' + code);
    return res
      .status(404)
      .type('html')
      .send(pageHtml('Link not found', 'This short link is not valid. Please check the URL and try again.'));
  }

  if (row.expired) {
    logger.info('Short link expired · code=' + code);
    return res
      .status(410)
      .type('html')
      .send(pageHtml(
        'This link has expired',
        'Please contact EasyFix support if you need to update any details.',
      ));
  }

  // Fire-and-forget click bump — the customer's browser must not wait.
  urlShortener.recordClick(code, pool);

  logger.info('Redirecting short link · code=' + code);
  return res.redirect(302, row.longUrl);
});

module.exports = router;
