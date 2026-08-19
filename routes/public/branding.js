const router = require('express').Router();

const logger = require('../../logger');
const { rateLimit } = require('../../middleware/rate-limit');
const { modernOk } = require('../../utils/response');
const svc = require('../../services/branding.service');

/*
 * GET /api/public/branding/active
 *
 * The festival theme the login page wears today.
 *
 * TRULY UNAUTHENTICATED, and unavoidably so: this is read while the LOGIN
 * SCREEN paints, before any token exists. It joins the small set of /public
 * routes that verify no token at all (app-version, pincodes) rather than the
 * majority that self-verify a magic-link JWT.
 *
 * Safe because the response is chrome, not data: a display name, a date window
 * and overlay geometry. No user, no job, no client, no PII, nothing scoped to
 * an identity — and the ornament URL is presigned ONLY for keys under
 * `Branding/` (enforced in services/branding.service.js, which is why this
 * route does not touch S3 itself). Keep it that way; anything identity-bearing
 * added here would be world-readable.
 *
 * Nothing active → `{ variant: null }`. That is a 200, not a 404: "no festival
 * today" is the normal state for most of the year, and the FE branches on the
 * null rather than on an error.
 *
 * ─── render_mode ON THIS RESPONSE IS THE *EFFECTIVE* MODE ───────────────────
 *
 *   'overlay'  draw `ornament_url` OVER the official EasyFix lockup, at
 *              anchor_x / anchor_y / scale. The historic behaviour.
 *   'replace'  draw `ornament_url` ALONE — no lockup beneath it. For a
 *              designer-supplied complete festive lockup.
 *
 * The value here is what the client can safely render RIGHT NOW, not
 * necessarily the value stored on the row. getActiveVariant() downgrades
 * 'replace' to 'overlay' whenever the ornament does not resolve to a URL,
 * because in 'replace' mode that asset is the ONLY brand mark on a page shown
 * to logged-OUT users — a blank header there reads as a broken or spoofed site
 * on the one screen where recognising the brand is how someone decides it is
 * safe to type a password. Failing to a correct logo beats failing to nothing.
 *
 * SO THE CLIENT MUST NOT RE-DERIVE THAT RULE. Render exactly what this field
 * says; a null `ornament_url` under 'overlay' simply means "lockup, no
 * ornament", which is what the page looks like on any ordinary day. The admin
 * API deliberately reports the STORED mode instead, so an operator can still
 * see that they picked 'replace' and never uploaded the art.
 */

// Generous per-IP cap — one call per login-page render, and an office behind a
// single NAT egress IP shares this bucket. It exists to blunt a scraper, not to
// ration legitimate traffic.
const activeRateLimit = rateLimit({
  windowMs: 10 * 60_000,
  max: 300,
  key: (req) => `public-branding:${req.ip}`,
});

router.get('/active', activeRateLimit, async (req, res, next) => {
  try {
    const variant = await svc.getActiveVariant();
    logger.info('Public active theme variant · ' + (variant ? `id=${variant.id} name=${variant.name}` : 'none'));
    /*
     * 60s, deliberately well under the 5-minute presign TTL — a cached response
     * must never outlive the ornament URL inside it. Short enough that pulling
     * a variant takes effect within a minute, which is the point of having a
     * kill switch at all.
     */
    res.setHeader('Cache-Control', 'public, max-age=60');
    return modernOk(res, { variant });
  } catch (e) { next(e); }
});

module.exports = router;
